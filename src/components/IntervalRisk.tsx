import { useEffect, useMemo, useState } from 'react';
import {
  RISK_BATCHES,
  RISK_LEDGER,
  RISK_METHOD_LABELS,
  analyzeBatch,
  publishRiskVersion,
  type BatchAnalysis,
  type FitGate,
  type ResolvedMeasurement,
  type RiskResultVersion,
} from '../domain/intervalRisk';
import { kvGet, kvSet } from '../db/idb';
import { canonicalStringify, uid } from '../domain/hash';
import { sha256HexSync } from '../domain/sha256';
import { useStore } from '../state/store';
import { Badge, Btn, Card, Stat } from './ui';

// 结果版本持久化在既有 kv store，无需数据库迁移
const VERSIONS_KEY = 'riskResultVersions.v1';

function fingerprintOf(payload: unknown): string {
  return sha256HexSync(canonicalStringify(payload)).slice(0, 12);
}

function versionFingerprintInput(
  batchId: string,
  version: number,
  methodId: string,
  analysis: BatchAnalysis,
) {
  return {
    feature: 'interval-censored-risk',
    batchId,
    version,
    methodId,
    thresholdMm: analysis.bounds.thresholdMm,
    n: analysis.bounds.n,
    lowerCount: analysis.bounds.lowerCount,
    upperCount: analysis.bounds.upperCount,
    scope: analysis.gate.fitAllowed && analysis.fit ? 'bounds_plus_fit' : 'bounds_only',
    fitP: analysis.fit ? analysis.fit.exceedProbability : null,
  };
}

function buildVersion(
  batchId: string,
  releaseMethodId: string,
  previousMethodId: string | null,
  version: number,
  versionId: string,
  atIso: string,
  publishedBy: string,
  note?: string,
): RiskResultVersion {
  const batch = RISK_BATCHES.find((b) => b.batchId === batchId)!;
  const analysis = analyzeBatch(batch, RISK_LEDGER, { releaseMethodId, previousMethodId });
  const fingerprint = fingerprintOf(
    versionFingerprintInput(batchId, version, releaseMethodId, analysis),
  );
  return publishRiskVersion({
    analysis,
    releaseMethodId,
    previousMethodId,
    version,
    versionId,
    atIso,
    publishedBy,
    fingerprint,
    note,
  });
}

function buildSeedVersions(): RiskResultVersion[] {
  return [
    buildVersion('B-MAIN', 'crack_gauge', null, 1, 'RRV-SEED-MAIN-V1', '2026-11-25T09:20:00.000Z', '平台交付管理员'),
    buildVersion('B-SMALL', 'crack_gauge', null, 1, 'RRV-SEED-SMALL-V1', '2026-11-20T16:00:00.000Z', '检测工程师 · 李敏'),
    buildVersion('B-METHOD', 'crack_gauge', null, 1, 'RRV-SEED-METHOD-V1', '2026-11-18T15:10:00.000Z', '检测工程师 · 李敏'),
  ];
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const METHOD_OPTIONS = Object.entries(RISK_METHOD_LABELS);

export default function IntervalRisk() {
  const store = useStore();
  const [batchId, setBatchId] = useState(RISK_BATCHES[0].batchId);
  const [releaseMethodId, setReleaseMethodId] = useState<string>('crack_gauge');
  const [versions, setVersions] = useState<RiskResultVersion[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await kvGet<RiskResultVersion[]>(VERSIONS_KEY);
      if (cancelled) return;
      if (stored === undefined) {
        const seed = buildSeedVersions();
        await kvSet(VERSIONS_KEY, seed);
        setVersions(seed);
      } else {
        setVersions(stored);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const batch = RISK_BATCHES.find((b) => b.batchId === batchId)!;
  const batchVersions = useMemo(
    () => (versions ?? []).filter((v) => v.batchId === batchId).sort((a, b) => b.version - a.version),
    [versions, batchId],
  );
  const latest = batchVersions[0] ?? null;
  const previousMethodId = latest?.methodId ?? null;

  const analysis = useMemo(
    () => analyzeBatch(batch, RISK_LEDGER, { releaseMethodId, previousMethodId }),
    [batch, releaseMethodId, previousMethodId],
  );

  function selectBatch(id: string) {
    setBatchId(id);
    const b = RISK_BATCHES.find((x) => x.batchId === id)!;
    const distinct = Array.from(new Set(b.records.map((r) => r.methodId)));
    setReleaseMethodId(distinct.length === 1 ? distinct[0] : distinct[0] ?? 'crack_gauge');
  }

  async function handlePublish() {
    if (!versions) return;
    const version = (latest?.version ?? 0) + 1;
    const ver = buildVersion(
      batchId,
      releaseMethodId,
      previousMethodId,
      version,
      uid('RRV'),
      new Date().toISOString(),
      store.account?.displayName ?? '演示检测工程师',
    );
    const next = [ver, ...versions];
    setVersions(next);
    await kvSet(VERSIONS_KEY, next);
    store.notify(
      ver.scope === 'bounds_plus_fit' ? 'ok' : 'info',
      ver.scope === 'bounds_plus_fit'
        ? `已发布 ${ver.reportBatchCode} v${version}：硬边界 + 拟合点估计。`
        : `已发布 ${ver.reportBatchCode} v${version}：仅无分布边界，不发布单点拟合 / 插补。`,
    );
  }

  async function handleResetVersions() {
    const seed = buildSeedVersions();
    setVersions(seed);
    await kvSet(VERSIONS_KEY, seed);
    store.notify('info', '区间风险结果版本已恢复为三份播种 v1。');
  }

  return (
    <div>
      <div className="banner banner-info">
        <span className="bi">📏</span>
        <div>
          仪器只给出“低于检出限”或“某区间内的舍入值”时，真实测值是<b>可行区间</b>而非单点：置零会低估、按检出限计会高估。
          本页用<b>同一份 {analysis.bounds.n} 个检测对象</b>给出两条估计：① 纯区间逻辑的越限比例<b>硬上下界</b>（假设最少、保证覆盖）；
          ② 区间删失对数正态拟合的越限概率（更窄，但依赖分布形状与同批同方法机制）。
          <b> 样本太少或方法变更时只发布边界，任何单点替代都仅标为敏感性情景，不冒充实测。</b>
        </div>
      </div>

      {/* 批次选择 */}
      <div className="risk-batch-tabs">
        {RISK_BATCHES.map((b) => {
          const n = b.records.length;
          const methods = Array.from(new Set(b.records.map((r) => r.methodId)));
          return (
            <button
              key={b.batchId}
              className={`risk-batch-tab ${b.batchId === batchId ? 'active' : ''}`}
              onClick={() => selectBatch(b.batchId)}
            >
              <div className="bt-code">{b.reportBatchCode}</div>
              <div className="bt-name">{b.name}</div>
              <div className="bt-meta">
                n={n} · 阈值 {b.thresholdMm}mm · {methods.map((m) => RISK_METHOD_LABELS[m] ?? m).join('/')}
              </div>
            </button>
          );
        })}
      </div>

      <HeadlineStats analysis={analysis} />

      <Card
        title="阈值统计器 · 超过 10mm 缺陷比例的无分布硬边界"
        sub="不假设任何分布：每条记录表示为可行区间。下界=必然越限条数/N，上界=所有可能越限条数/N（必然+不确定）。阈值判定为严格“>10mm”，区间端点恰好等于 10 不计为必然越限。"
      >
        <BoundChart analysis={analysis} />
        <CompositionBar analysis={analysis} />
        <HardBoundDerivation analysis={analysis} />
      </Card>

      <div className="grid-2">
        <FitCard analysis={analysis} />
        <SweepCard analysis={analysis} />
      </div>

      <SensitivityCard analysis={analysis} />
      <IntervalTable analysis={analysis} />
      <LedgerCard />

      <PublishCard
        analysis={analysis}
        releaseMethodId={releaseMethodId}
        setReleaseMethodId={setReleaseMethodId}
        nextVersion={(latest?.version ?? 0) + 1}
        canInteract={versions !== null}
        onPublish={handlePublish}
        onReset={handleResetVersions}
      />

      <VersionLedger versions={versions} />
    </div>
  );
}

// ---------------- 顶部统计 ----------------

function HeadlineStats({ analysis }: { analysis: BatchAnalysis }) {
  const { bounds: b } = analysis;
  return (
    <div className="stat-grid">
      <Stat label="同批检测对象 N" value={b.n} hint={`阈值严格 > ${b.thresholdMm} mm`} tone="brand" />
      <Stat label="越限比例 · 硬下界" value={`${b.lowerPct.toFixed(1)}%`} hint={`${b.lowerCount} 条必然越限`} tone="danger" />
      <Stat label="越限比例 · 硬上界" value={`${b.upperPct.toFixed(1)}%`} hint={`${b.upperCount} 条可能越限（含 ${b.ambiguousCount} 不确定）`} tone="warn" />
      <Stat label="边界宽度" value={`${b.widthPctPoints.toFixed(1)} pp`} hint="百分点 · 无分布假设下的不可识别宽度" tone="slate" />
    </div>
  );
}

// ---------------- 硬边界图 ----------------

function niceScaleMax(upperPct: number): number {
  return Math.max(35, Math.ceil((upperPct + 8) / 10) * 10);
}

function BoundChart({ analysis }: { analysis: BatchAnalysis }) {
  const { bounds: b, fit } = analysis;
  const scale = niceScaleMax(b.upperPct);
  const mustW = (b.lowerPct / scale) * 100;
  const ambL = (b.lowerPct / scale) * 100;
  const ambW = (b.widthPctPoints / scale) * 100;
  const ticks = Array.from({ length: scale / 10 + 1 }, (_, i) => i * 10);

  return (
    <div>
      <div className="risk-axis" style={{ marginTop: 26 }}>
        <div className="risk-track">
          <div className="risk-seg must" style={{ width: `${mustW}%` }} title={`必然越限 ${b.lowerPct.toFixed(1)}%`} />
          <div
            className="risk-seg ambig"
            style={{ left: `${ambL}%`, width: `${ambW}%` }}
            title={`不确定区间 +${b.widthPctPoints.toFixed(1)} pp`}
          />
          {fit && (
            <div className="risk-marker fit" style={{ left: `${(fit.exceedPct / scale) * 100}%` }}>
              <span className="rm-tag">拟合 {fit.exceedPct.toFixed(1)}%</span>
            </div>
          )}
        </div>
        <div className="risk-ticks">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${(t / scale) * 100}%` }}>
              {t}%
            </span>
          ))}
        </div>
      </div>
      <div className="risk-legend">
        <span className="lg"><span className="risk-swatch" style={{ background: 'var(--danger)' }} />必然越限（计入下界）</span>
        <span className="lg"><span className="risk-swatch" style={{ background: '#e8a94e' }} />区间跨阈值 · 不确定（只计入上界）</span>
        {fit && (
          <span className="lg"><span className="risk-swatch" style={{ background: 'var(--teal)' }} />区间删失分布拟合点估计（落在硬边界内）</span>
        )}
      </div>
    </div>
  );
}

function CompositionBar({ analysis }: { analysis: BatchAnalysis }) {
  const { bounds: b } = analysis;
  const pct = (n: number) => (b.n ? (100 * n) / b.n : 0);
  return (
    <div>
      <div className="risk-stack" title="必然 / 不确定 / 不可能 三分类构成">
        <div className="rs-must" style={{ width: `${pct(b.mustCount)}%` }} />
        <div className="rs-ambig" style={{ width: `${pct(b.ambiguousCount)}%` }} />
        <div className="rs-cannot" style={{ width: `${pct(b.cannotCount)}%` }} />
      </div>
      <div className="risk-legend">
        <span className="lg">必然 {b.mustCount}</span>
        <span className="lg">不确定 {b.ambiguousCount}</span>
        <span className="lg">不可能 {b.cannotCount}</span>
        <span className="lg muted">合计 {b.n} 个检测对象</span>
      </div>
    </div>
  );
}

function HardBoundDerivation({ analysis }: { analysis: BatchAnalysis }) {
  const { bounds: b, batch } = analysis;
  const points = batch.records.filter((r) => r.kind === 'point').length;
  const left = batch.records.filter((r) => r.kind === 'left').length;
  const intervals = batch.records.filter((r) => r.kind === 'interval').length;
  return (
    <div className="formula-box" style={{ marginTop: 14 }}>
      <div>
        N = {points} 点测 + {left} 左删失“&lt;LOD” + {intervals} 区间/舍入 = <span className="hl">{b.n}</span>
      </div>
      <div>
        k_min = #{'{ lower &gt; T }'} = <span className="hl">{b.lowerCount}</span>　（必然越限）
      </div>
      <div>
        k_max = #{'{ upper &gt; T }'} = {b.mustCount} + {b.ambiguousCount} ={' '}
        <span className="hl">{b.upperCount}</span>　（必然 + 不确定）
      </div>
      <div>
        p(T={b.thresholdMm}mm) ∈ [k_min/N, k_max/N] ={' '}
        <span className="hl">
          [{b.lowerCount}/{b.n}, {b.upperCount}/{b.n}] = [{b.lowerPct.toFixed(1)}%, {b.upperPct.toFixed(1)}%]
        </span>
      </div>
    </div>
  );
}

// ---------------- 分布拟合 ----------------

function FitCard({ analysis }: { analysis: BatchAnalysis }) {
  const { fit, gate, bounds } = analysis;
  return (
    <Card
      title="区间删失分布拟合（对数正态 MLE）"
      sub="把每条 [L,U] 作为区间删失观测，最大化 ∏[Φ((lnU−μ)/σ)−Φ((lnL−μ)/σ)]；点测按舍入半宽展开为小区间，与左删失 / 区间记录统一处理。"
    >
      {fit ? (
        <div>
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            <Stat label="拟合越限概率" value={`${fit.exceedPct.toFixed(1)}%`} tone="teal" hint={`P(X > ${fit.thresholdMm}mm)`} />
            <Stat label="ln 均值 μ" value={fit.mu.toFixed(3)} />
            <Stat label="ln 标准差 σ" value={fit.sigma.toFixed(3)} />
            <Stat label="对数似然 ℓL" value={fit.logLikelihood.toFixed(1)} hint={`确定性模式搜索 · ${fit.iterations} 轮`} />
          </div>
          <div style={{ marginBottom: 10 }}>
            {fit.withinHardBounds ? (
              <Badge tone="ok">✔ 拟合 {fit.exceedPct.toFixed(2)}% 落在硬边界 [{fit.hardLowerPct.toFixed(1)}%, {fit.hardUpperPct.toFixed(1)}%] 内</Badge>
            ) : (
              <Badge tone="danger">拟合越出硬边界，不予发布</Badge>
            )}
            {fit.ci95 && (
              <Badge tone="slate" style={{ marginLeft: 8 }}>
                近似 95% CI {fit.ci95.lowPct.toFixed(1)}%–{fit.ci95.highPct.toFixed(1)}%
              </Badge>
            )}
          </div>
          <p className="small muted" style={{ marginBottom: 8 }}>
            点估计比硬边界更“窄”、更精确，但依赖对数正态尾部形状与同批同方法机制。近似置信区间反映抽样不确定性（n={fit.n}），
            是另一类不确定性，可能宽于、甚至略微越出无分布识别边界，二者不矛盾。
          </p>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)' }}>
            {fit.assumptions.map((a, i) => (
              <li key={i} style={{ marginBottom: 3 }}>{a}</li>
            ))}
          </ul>
        </div>
      ) : (
        <LockedFit gate={gate} lowerPct={bounds.lowerPct} upperPct={bounds.upperPct} />
      )}
    </Card>
  );
}

function LockedFit({ gate, lowerPct, upperPct }: { gate: FitGate; lowerPct: number; upperPct: number }) {
  return (
    <div>
      <div className="banner banner-warn" style={{ marginBottom: 12 }}>
        <span className="bi">🔒</span>
        <div>
          <b>本批次不发布分布拟合点估计，只发布无分布硬边界 {lowerPct.toFixed(1)}%–{upperPct.toFixed(1)}%。</b>
          <br />
          置零 / LOD / LOQ / 中点等单点值仅用于报告规则敏感性演示，<b>不得当作实测值或插补结论发布</b>。
        </div>
      </div>
      <div className="gate-list" style={{ margin: 0 }}>
        {gate.reasons.map((r, i) => (
          <div key={i} className="gate-reason block">⚠ {r.message}</div>
        ))}
      </div>
    </div>
  );
}

// ---------------- 阈值扫描 ----------------

function SweepCard({ analysis }: { analysis: BatchAnalysis }) {
  return (
    <Card title="阈值扫描 · 置零 vs 按检出限的偏差方向" sub="同一批记录在不同风险阈值下的越限比例。低阈值处可清楚看到：置零把 4 条 <2 算作 0（低估），按 LOD=2 则把它们全部算作 2（在 T<2 时高估）。">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>阈值 T (mm)</th>
              <th>置零</th>
              <th>按 LOD</th>
              <th>硬下界</th>
              <th>硬上界</th>
            </tr>
          </thead>
          <tbody>
            {analysis.sweep.map((p) => (
              <tr key={p.thresholdMm} style={p.thresholdMm === 10 ? { background: '#f4f8ff' } : undefined}>
                <td><b>{p.thresholdMm}</b>{p.thresholdMm === 10 && <Badge tone="brand" style={{ marginLeft: 6 }}>本题</Badge>}</td>
                <td className="mono">{p.zeroPct.toFixed(1)}%</td>
                <td className="mono">{p.lodPct.toFixed(1)}%</td>
                <td className="mono tone-danger">{p.lowerPct.toFixed(1)}%</td>
                <td className="mono tone-warn">{p.upperPct.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>
        在 T=1mm 时，按 LOD 比置零恰好多出 4/N（4 条 “&lt;2”），即 {(4 / analysis.bounds.n * 100).toFixed(1)} 个百分点；
        到 T=10mm 时 0 与 2 都远低于阈值，两规则计数收敛一致——此时不确定性主要来自跨 10mm 的舍入记录。
      </p>
    </Card>
  );
}

// ---------------- 报告规则敏感性 ----------------

function relationBadge(rel: string) {
  if (rel === 'at_lower') return <Badge tone="danger">= 硬下界</Badge>;
  if (rel === 'at_upper') return <Badge tone="warn">= 硬上界</Badge>;
  if (rel === 'inside') return <Badge tone="ok">边界内部</Badge>;
  return <Badge tone="danger">越出边界</Badge>;
}

function SensitivityCard({ analysis }: { analysis: BatchAnalysis }) {
  return (
    <Card
      title="不同报告规则下的敏感性（全部为单点插补情景）"
      sub="同一批可行区间，套用不同的“报告/替代规则”会得到不同的确定比例。注意：这些都是插补情景（imputation），不是新的实测信息；只有最好/最坏端点严格等于无分布边界。"
    >
      <div className="banner banner-neutral" style={{ marginBottom: 12 }}>
        <span className="bi">🧪</span>
        <div>下表每一行都把删失 / 区间记录强制变成一个点后再计数，仅用于量化“报告规则选择”带来的敏感性，不能声称这些单点是仪器实测。</div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>报告规则</th>
              <th>4 条 “&lt;2” 被插补为 (mm)</th>
              <th>3 条舍入记录被插补为 (mm)</th>
              <th>越限条数</th>
              <th>比例</th>
              <th>相对硬边界</th>
            </tr>
          </thead>
          <tbody>
            {analysis.ruleRows.map((row) => (
              <tr key={row.rule.id}>
                <td style={{ minWidth: 170 }}>
                  <div style={{ fontWeight: 700 }}>{row.rule.label}</div>
                  <div className="small muted">{row.rule.short}</div>
                </td>
                <td className="mono small">[{row.leftImputedValues.join(', ')}]</td>
                <td className="mono small">[{row.roundedImputedValues.join(', ')}]</td>
                <td><b>{row.exceedCount}</b> / {analysis.bounds.n}</td>
                <td className="mono"><b>{row.pct.toFixed(1)}%</b></td>
                <td>{relationBadge(row.relation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>
        {analysis.ruleRows.find((r) => r.rule.id === 'zero')?.rule.description} {analysis.ruleRows.find((r) => r.rule.id === 'lod')?.rule.description}
      </p>
    </Card>
  );
}

// ---------------- 区间求值明细表 ----------------

const CLASS_LABEL: Record<ResolvedMeasurement['exceedClass'], { text: string; tone: 'danger' | 'warn' | 'ok' }> = {
  must_exceed: { text: '必然越限', tone: 'danger' },
  ambiguous: { text: '不确定 · 跨阈值', tone: 'warn' },
  cannot_exceed: { text: '不可能越限', tone: 'ok' },
};

function IntervalTable({ analysis }: { analysis: BatchAnalysis }) {
  const t = analysis.bounds.thresholdMm;
  const maxAxis = 20; // mm，覆盖最大 18mm 点测值
  return (
    <Card title="区间求值器 · 逐条可行范围与阈值分类" sub="测量账原始措辞不改写；区间由记录类型结合仪器检出限 / 舍入误差求出。右侧轴 0–20mm，竖线为 10mm 阈值。">
      <div className="scroll-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>对象 / 记录</th>
              <th>原始报告</th>
              <th>类型</th>
              <th>方法 / 仪器</th>
              <th>可行区间与阈值轴</th>
              <th>分类</th>
              <th>求值依据</th>
            </tr>
          </thead>
          <tbody>
            {analysis.resolved.map((r) => {
              const cls = CLASS_LABEL[r.exceedClass];
              const left = (r.interval.lower / maxAxis) * 100;
              const width = Math.max(0.6, ((r.interval.upper - r.interval.lower) / maxAxis) * 100);
              return (
                <tr key={r.record.id}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{r.record.objectId}</div>
                    <div className="tiny muted mono">{r.record.id}</div>
                  </td>
                  <td className="mono"><b>{r.record.reported}</b></td>
                  <td className="small">
                    {r.interval.censorType === 'exact' && '点测 / 舍入展开'}
                    {r.interval.censorType === 'left_censored' && `左删失 <${r.record.limitMm}mm`}
                    {r.interval.censorType === 'interval_censored' && '区间 / 粗舍入'}
                  </td>
                  <td className="small">
                    <div>{RISK_METHOD_LABELS[r.record.methodId] ?? r.record.methodId}</div>
                    <div className="tiny muted mono">{r.record.instrumentId}</div>
                  </td>
                  <td className="iv-cell">
                    <div className="small mono" style={{ marginBottom: 2 }}>
                      [{r.interval.lower.toFixed(2)}, {r.interval.upper.toFixed(2)}] mm
                    </div>
                    <div className="iv-range">
                      <div className={`iv-bar ${r.exceedClass}`} style={{ left: `${left}%`, width: `${width}%` }} />
                      <div className="iv-threshold" style={{ left: `${(t / maxAxis) * 100}%` }} />
                    </div>
                  </td>
                  <td><Badge tone={cls.tone}>{cls.text}</Badge></td>
                  <td className="small muted" style={{ minWidth: 220 }}>{r.interval.basis}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------- 仪器台账 ----------------

function LedgerCard() {
  return (
    <Card title="测量账 · 仪器检出限 / 定量限 / 舍入误差 / 检测方法" sub="区间求值与删失似然都引用同一本仪器台账，保证 LOD、LOQ、舍入半宽与方法可追溯。">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>仪器</th>
              <th>检测方法</th>
              <th>检出限 LOD</th>
              <th>定量限 LOQ</th>
              <th>舍入步长</th>
              <th>舍入/判读半宽</th>
              <th>校准 / 备注</th>
            </tr>
          </thead>
          <tbody>
            {RISK_LEDGER.map((i) => (
              <tr key={i.instrumentId}>
                <td>
                  <div style={{ fontWeight: 700 }}>{i.name}</div>
                  <div className="tiny muted mono">{i.instrumentId}</div>
                </td>
                <td><Badge tone="brand">{RISK_METHOD_LABELS[i.methodId] ?? i.methodId}</Badge></td>
                <td className="mono">{i.lodMm} mm</td>
                <td className="mono">{i.loqMm} mm</td>
                <td className="mono">{i.roundingIncrementMm} mm</td>
                <td className="mono">±{i.roundingHalfWidthMm} mm</td>
                <td className="small">
                  <div>{i.calibration}</div>
                  {i.note && <div className="tiny muted">{i.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------- 发布闸门 + 发布动作 ----------------

function PublishCard({
  analysis,
  releaseMethodId,
  setReleaseMethodId,
  nextVersion,
  canInteract,
  onPublish,
  onReset,
}: {
  analysis: BatchAnalysis;
  releaseMethodId: string;
  setReleaseMethodId: (v: string) => void;
  nextVersion: number;
  canInteract: boolean;
  onPublish: () => void;
  onReset: () => void;
}) {
  const { gate } = analysis;
  return (
    <Card
      title="结果版本发布闸门 · 关联报告批次与检测方法"
      sub="每个结果版本固定 报告批次 + 发布所用检测方法 + 阈值 + 当时的边界/拟合/闸门结论，并生成内容指纹。样本不足或方法变化时仍可发布，但 scope=bounds_only、fit=null。"
      extra={
        <Btn variant="ghost" size="sm" onClick={onReset} disabled={!canInteract}>
          恢复播种版本
        </Btn>
      }
    >
      <div className="lattice mb16">
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>报告批次</label>
          <input className="input" value={`${analysis.batch.reportBatchCode} · ${analysis.batch.name}`} disabled />
        </div>
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>本版本采用的检测方法（改变它即模拟方法变更）</label>
          <select className="select" value={releaseMethodId} onChange={(e) => setReleaseMethodId(e.target.value)}>
            {METHOD_OPTIONS.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </div>
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>下一版本号</label>
          <input className="input" value={`v${nextVersion}`} disabled />
        </div>
      </div>

      <div className="small muted" style={{ marginBottom: 8 }}>
        批次实测方法：
        {gate.distinctMethodIds.length === 0 ? (
          '—'
        ) : (
          <span className="role-chips" style={{ display: 'inline-flex', marginLeft: 6 }}>
            {gate.distinctMethodIds.map((m) => (
              <Badge key={m} tone={gate.distinctMethodIds.length > 1 ? 'warn' : 'ok'}>
                {RISK_METHOD_LABELS[m] ?? m}
              </Badge>
            ))}
          </span>
        )}
        <span style={{ marginLeft: 10 }}>样本 n={gate.sampleSize}（拟合门槛 {gate.minSampleSize}）</span>
      </div>

      {gate.fitAllowed ? (
        <div className="gate-ok">✔ 闸门通过：方法一致且样本充足，可一并发布硬边界与区间删失分布拟合点估计。</div>
      ) : (
        <div className="gate-list">
          {gate.reasons.map((r, i) => (
            <div key={i} className="gate-reason block">⚠ {r.message}</div>
          ))}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <Btn variant={gate.fitAllowed ? 'success' : 'warn'} onClick={onPublish} disabled={!canInteract}>
          {gate.fitAllowed ? `发布 v${nextVersion}：边界 + 拟合` : `发布 v${nextVersion}：仅边界（不发布单点）`}
        </Btn>
        <span className="small muted">
          {gate.fitAllowed
            ? '版本将保存 fit 点估计及其假设。'
            : '版本仍会保存完整硬边界与规则敏感性，但 fit=null、scope=bounds_only。'}
        </span>
      </div>
    </Card>
  );
}

// ---------------- 结果版本账 ----------------

function VersionLedger({ versions }: { versions: RiskResultVersion[] | null }) {
  const list = versions ?? [];
  return (
    <Card title="结果版本账" sub="只追加的区间风险结果版本；每条都关联报告批次与检测方法，固化发布范围、边界 / 拟合与指纹，供审计与跨版本方法一致性核查。">
      {versions === null ? (
        <div className="empty">正在从 IndexedDB 读取结果版本…</div>
      ) : list.length === 0 ? (
        <div className="empty">暂无结果版本，点击上方“发布”生成。</div>
      ) : (
        list.map((v) => (
          <div key={v.versionId} className={`ver-card ${v.scope}`}>
            <div className="ver-head">
              <span className="ver-title">{v.reportBatchCode} · v{v.version}</span>
              <Badge tone={v.scope === 'bounds_plus_fit' ? 'ok' : 'warn'}>
                {v.scope === 'bounds_plus_fit' ? '边界 + 拟合' : '仅边界 bounds_only'}
              </Badge>
              <Badge tone="brand">{v.methodLabel}</Badge>
              <Badge tone="slate">n={v.sampleSize}</Badge>
              <span className="ver-meta" style={{ marginLeft: 'auto' }}>
                {fmtTime(v.createdAt)} · {v.publishedBy} · <code className="hash">{v.fingerprint}</code>
              </span>
            </div>
            <div className="ver-headline">{v.headline}</div>
            <div className="small muted" style={{ marginTop: 6 }}>
              硬边界 {v.bounds.lowerCount}/{v.bounds.n}–{v.bounds.upperCount}/{v.bounds.n} ={' '}
              {v.bounds.lowerPct.toFixed(1)}%–{v.bounds.upperPct.toFixed(1)}%
              {v.fit ? `；拟合 ${v.fit.exceedPct.toFixed(2)}%（μ=${v.fit.mu.toFixed(3)}, σ=${v.fit.sigma.toFixed(3)}，落在边界内=${v.fit.withinHardBounds ? '是' : '否'}）` : '；未发布拟合点（fit=null）'}
              {v.measuredMethodIds.length > 1 && `；批次实测方法混用：${v.measuredMethodIds.map((m) => RISK_METHOD_LABELS[m] ?? m).join(' / ')}`}
            </div>
          </div>
        ))
      )}
    </Card>
  );
}
