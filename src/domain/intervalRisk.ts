// ============================================================
// 区间删失测量 · 风险阈值影响估计
// ------------------------------------------------------------
// 仪器只报告“低于检出限 / 某区间内的舍入值”时，真实测值是一个
// 可行区间而不是一个点。本模块提供两条估计同一批对象“超过阈值
// （默认裂缝宽度 10 mm）比例”的路径：
//
//   1) 区间逻辑（无分布假设）：
//      每条记录表示为 [lower, upper]，按区间是否必然/可能越限，
//      给出越限比例的硬上下界 [kMin/N, kMax/N]。保证覆盖、假设最少，
//      但边界可能较宽。
//
//   2) 区间删失分布拟合（依赖形状 + 同批同机制）：
//      用区间删失极大似然拟合对数正态，得到更窄的越限概率点估计。
//      样本太少或检测方法发生变化（机制不一致）时，发布闸门只允许
//      发布边界，拟合结果不得作为实测单点结论发布。
//
// 另含不同“报告规则”（置零 / 按检出限 / 按定量限 / 中点 / 上下端点）
// 下的敏感性。所有单点替代都显式标记为“插补情景”，绝不冒充实测。
// ============================================================

// ---------------- 类型 ----------------

export type RiskMethodId = 'crack_gauge' | 'ultrasonic' | 'visual' | 'ground_penetrating_radar';

export const RISK_METHOD_LABELS: Record<string, string> = {
  crack_gauge: '裂缝测宽仪法',
  ultrasonic: '超声波检测法',
  visual: '目视 / 标尺估读法',
  ground_penetrating_radar: '地质雷达法',
};

/** 测量账中的仪器台账：检出限 / 定量限 / 舍入误差 / 检测方法 */
export interface InstrumentLedger {
  instrumentId: string;
  name: string;
  methodId: RiskMethodId;
  /** 仪器检出限 LOD（mm）：低于此值仪器只给“<LOD” */
  lodMm: number;
  /** 定量限 LOQ（mm）：低于此值可检出但不宜定量 */
  loqMm: number;
  /** 标称舍入步长（mm） */
  roundingIncrementMm: number;
  /** 综合舍入 / 判读误差半宽（mm），点测值据此扩成可行区间 */
  roundingHalfWidthMm: number;
  calibration: string;
  note?: string;
}

export type CensorKind = 'point' | 'left' | 'interval';

/** 测量账中的一条原始记录（不改写原始报告措辞） */
export interface RiskMeasurement {
  id: string;
  objectId: string;
  kind: CensorKind;
  /** 原始报告文本，如 “12.4” / “<2” / “9（粗舍入）” */
  reported: string;
  methodId: RiskMethodId;
  instrumentId: string;
  at?: string;
  note?: string;
  /** kind=point：点测值 */
  valueMm?: number;
  /** kind=left：报告 “<limitMm”，通常等于仪器 LOD */
  limitMm?: number;
  /** kind=interval：显式可行区间 [lowerMm, upperMm]（区间删失 / 粗舍入带） */
  lowerMm?: number;
  upperMm?: number;
  /** 覆盖仪器默认舍入半宽（例如某条粗舍入记录单独给定误差带） */
  roundingHalfWidthMm?: number;
}

export interface RiskBatch {
  batchId: string;
  /** 报告批次号（结果版本据此关联报告批次） */
  reportBatchCode: string;
  name: string;
  projectId: string;
  collectedOn: string;
  /** 风险阈值，裂缝宽度默认 10 mm（严格“超过”） */
  thresholdMm: number;
  records: RiskMeasurement[];
}

export interface FeasibleInterval {
  lower: number;
  upper: number;
  censorType: 'exact' | 'left_censored' | 'interval_censored';
  basis: string;
}

export type ExceedClass = 'must_exceed' | 'cannot_exceed' | 'ambiguous';

export interface ResolvedMeasurement {
  record: RiskMeasurement;
  interval: FeasibleInterval;
  exceedClass: ExceedClass;
  /** 该记录在阈值处是否存在“越限”的可行赋值（用于上界） */
  canExceed: boolean;
  /** 该记录是否在所有可行赋值下都越限（用于下界） */
  mustExceed: boolean;
  lodMm: number | null;
  loqMm: number | null;
}

export interface BoundStats {
  n: number;
  thresholdMm: number;
  /** 必然越限条数（下界分子） */
  lowerCount: number;
  /** 最多可能越限条数（上界分子）= 必然 + 不确定 */
  upperCount: number;
  mustCount: number;
  cannotCount: number;
  ambiguousCount: number;
  /** 越限比例硬下界 / 硬上界 */
  lowerProportion: number;
  upperProportion: number;
  lowerPct: number;
  upperPct: number;
  /** 区间宽度（百分点） */
  widthPctPoints: number;
}

export type ReportRuleId = 'zero' | 'lod' | 'half_lod' | 'loq' | 'midpoint' | 'lower' | 'upper';

export interface ReportRuleDef {
  id: ReportRuleId;
  label: string;
  short: string;
  description: string;
  /** 是否为保守端点规则（best/worst case） */
  endpoint?: 'lower' | 'upper';
}

export const REPORT_RULES: ReportRuleDef[] = [
  {
    id: 'zero',
    label: '置零法',
    short: '未检出=0',
    description: '把所有“<LOD”按 0 计。会系统性低估低值，进而可能低估超限比例。',
  },
  {
    id: 'lod',
    label: '检出限替代法',
    short: '<LOD → LOD',
    description: '把“<LOD”一律按检出限 LOD 计。方向保守，但会系统性抬高这批低值。',
  },
  {
    id: 'half_lod',
    label: 'LOD/2 替代法',
    short: '<LOD → LOD/2',
    description: '常见折中替代；仍是单点插补，依赖“低值近似居中”的隐含假设。',
  },
  {
    id: 'loq',
    label: '定量限替代法',
    short: '<LOD → LOQ',
    description: '更保守的单点替代；LOQ 通常高于 LOD，容易进一步高估。',
  },
  {
    id: 'midpoint',
    label: '区间中点法',
    short: '区间 → (L+U)/2',
    description: '对区间删失 / 舍入带取中点；中点恰好等于阈值时按严格“超过”不计。',
  },
  {
    id: 'lower',
    label: '最好情形（区间下界）',
    short: '全部取 L',
    description: '每条取可行区间下界，得到无分布假设的越限比例下界。',
    endpoint: 'lower',
  },
  {
    id: 'upper',
    label: '最坏情形（区间上界）',
    short: '全部取 U',
    description: '每条取可行区间上界，得到无分布假设的越限比例上界。',
    endpoint: 'upper',
  },
];

export interface RuleSensitivityRow {
  rule: ReportRuleDef;
  exceedCount: number;
  proportion: number;
  pct: number;
  /** 该规则结果相对硬边界的位置 */
  relation: 'at_lower' | 'inside' | 'at_upper' | 'outside';
  /** 4 条 <2 记录在本规则下被插补成的值（用于展示机制差异） */
  leftImputedValues: number[];
  /** 3 条舍入 / 区间记录在本规则下被插补成的值 */
  roundedImputedValues: number[];
  /** 显式声明：这是插补情景，不是实测 */
  imputation: true;
}

export interface SweepPoint {
  thresholdMm: number;
  zeroPct: number;
  lodPct: number;
  lowerPct: number;
  upperPct: number;
}

export interface FitResult {
  distribution: 'lognormal_interval_censored';
  mu: number;
  sigma: number;
  logLikelihood: number;
  iterations: number;
  n: number;
  thresholdMm: number;
  /** 模型估计的 P(X > threshold) */
  exceedProbability: number;
  exceedPct: number;
  /** 近似 95% 置信区间（delta 法，依赖渐近与分布假设；可能略越过硬边界） */
  ci95: { lowPct: number; highPct: number } | null;
  /** 拟合点估计是否落在无分布硬边界内（容差内） */
  withinHardBounds: boolean;
  hardLowerPct: number;
  hardUpperPct: number;
  assumptions: string[];
}

export type GateReasonCode =
  | 'sample_too_small'
  | 'mixed_methods'
  | 'release_method_mismatch'
  | 'method_changed_since_previous_version'
  | 'fit_outside_hard_bounds';

export interface GateReason {
  code: GateReasonCode;
  blocking: boolean;
  message: string;
}

export interface FitGate {
  /** 是否允许把分布拟合点估计作为结论发布 */
  fitAllowed: boolean;
  sampleSize: number;
  minSampleSize: number;
  distinctMethodIds: string[];
  primaryMethodId: RiskMethodId | null;
  reasons: GateReason[];
  /** 无论闸门如何，硬边界始终可发布 */
  boundsAlwaysPublishable: true;
}

export type PublicationScope = 'bounds_only' | 'bounds_plus_fit';

/** 结果版本：关联报告批次 + 检测方法，固化当时的边界 / 拟合 / 闸门 */
export interface RiskResultVersion {
  versionId: string;
  version: number;
  batchId: string;
  reportBatchCode: string;
  batchName: string;
  projectId: string;
  thresholdMm: number;
  /** 本结果版本对外署名所依据的检测方法 */
  methodId: string;
  methodLabel: string;
  /** 批次记录中实际出现过的检测方法 */
  measuredMethodIds: string[];
  createdAt: string;
  publishedBy: string;
  sampleSize: number;
  bounds: BoundStats;
  ruleRows: RuleSensitivityRow[];
  fit: FitResult | null;
  gate: FitGate;
  scope: PublicationScope;
  headline: string;
  /** 版本指纹（规范化内容的短哈希前缀，供审计比对） */
  fingerprint: string;
  note?: string;
}

// ---------------- 常量 ----------------

/** 风险阈值：裂缝宽度超过 10 mm（严格 >） */
export const CRACK_DEFECT_THRESHOLD_MM = 10;

/**
 * 允许发布区间删失分布拟合的最小样本量（策略常量）。
 * 低于此值认为不足以支撑两参数 + 删失机制的分布外推，只发布硬边界。
 */
export const MIN_FIT_SAMPLE_SIZE = 20;

/** 拟合点估计与硬边界之间的数值容差（比例绝对量） */
const BOUND_TOLERANCE = 1e-6;

// ---------------- 区间求值器 ----------------

export function buildLedgerMap(ledger: InstrumentLedger[]): Map<string, InstrumentLedger> {
  return new Map(ledger.map((i) => [i.instrumentId, i]));
}

/** 把一条原始测量记录求值为可行区间 */
export function resolveInterval(m: RiskMeasurement, instrument?: InstrumentLedger): FeasibleInterval {
  const physicalFloor = 0; // 裂缝宽度 / 污染浓度非负

  if (m.kind === 'point') {
    const x = m.valueMm ?? Number.NaN;
    const h = m.roundingHalfWidthMm ?? instrument?.roundingHalfWidthMm ?? 0;
    return {
      lower: Math.max(physicalFloor, x - h),
      upper: x + h,
      censorType: 'exact',
      basis:
        h > 0
          ? `点测 ${x}，按 ${instrument?.name ?? '仪器'} 舍入/判读半宽 ±${h} mm 展开为 [${round6(x - h)}, ${round6(x + h)}]`
          : `点测 ${x}，视为精确值`,
    };
  }

  if (m.kind === 'left') {
    const lim = m.limitMm ?? instrument?.lodMm ?? Number.NaN;
    return {
      lower: physicalFloor,
      upper: lim,
      censorType: 'left_censored',
      basis: `仪器只报告 “<${lim} mm”（检出限 LOD=${instrument?.lodMm ?? lim}，LOQ=${
        instrument?.loqMm ?? '—'
      }），真实值可行域 [0, ${lim}]`,
    };
  }

  // interval
  const l = m.lowerMm ?? Number.NaN;
  const u = m.upperMm ?? Number.NaN;
  return {
    lower: Math.max(physicalFloor, l),
    upper: u,
    censorType: 'interval_censored',
    basis: `粗舍入 / 区间删失，原始记录仅能确定落在 [${l}, ${u}] mm`,
  };
}

/** 解析整批：区间 + 阈值三分类 + LOD/LOQ */
export function resolveBatch(batch: RiskBatch, ledger: InstrumentLedger[]): ResolvedMeasurement[] {
  const map = buildLedgerMap(ledger);
  return batch.records.map((record) => {
    const inst = map.get(record.instrumentId);
    const interval = resolveInterval(record, inst);
    const t = batch.thresholdMm;
    // 严格“超过” t（> t）。闭区间可行域下：
    //  - 所有赋值都越限  <=> lower > t
    //  - 存在越限赋值    <=> upper > t
    const mustExceed = interval.lower > t;
    const canExceed = interval.upper > t;
    let exceedClass: ExceedClass;
    if (mustExceed) exceedClass = 'must_exceed';
    else if (!canExceed) exceedClass = 'cannot_exceed';
    else exceedClass = 'ambiguous';

    return {
      record,
      interval,
      exceedClass,
      mustExceed,
      canExceed,
      lodMm: inst?.lodMm ?? (record.kind === 'left' ? record.limitMm ?? null : null),
      loqMm: inst?.loqMm ?? null,
    };
  });
}

// ---------------- 阈值统计器：硬上下界 ----------------

export function computeHardBounds(resolved: ResolvedMeasurement[], thresholdMm: number): BoundStats {
  const n = resolved.length;
  const mustCount = resolved.filter((r) => r.exceedClass === 'must_exceed').length;
  const cannotCount = resolved.filter((r) => r.exceedClass === 'cannot_exceed').length;
  const ambiguousCount = resolved.filter((r) => r.exceedClass === 'ambiguous').length;

  const lowerCount = mustCount;
  const upperCount = mustCount + ambiguousCount;
  const lowerProportion = n === 0 ? 0 : lowerCount / n;
  const upperProportion = n === 0 ? 0 : upperCount / n;

  return {
    n,
    thresholdMm,
    lowerCount,
    upperCount,
    mustCount,
    cannotCount,
    ambiguousCount,
    lowerProportion,
    upperProportion,
    lowerPct: 100 * lowerProportion,
    upperPct: 100 * upperProportion,
    widthPctPoints: 100 * (upperProportion - lowerProportion),
  };
}

// ---------------- 报告规则敏感性 ----------------

/** 按某条报告规则把一条记录插补成单点 */
export function imputeValue(r: ResolvedMeasurement, rule: ReportRuleId): number {
  const { interval } = r;
  switch (rule) {
    case 'lower':
      return interval.lower;
    case 'upper':
      return interval.upper;
    case 'midpoint':
      return (interval.lower + interval.upper) / 2;
    case 'zero':
      // 置零只对左删失明确成立；对点 / 区间用中点（点的中点即其本身）
      return interval.censorType === 'left_censored' ? 0 : (interval.lower + interval.upper) / 2;
    case 'lod': {
      if (interval.censorType === 'left_censored') return r.lodMm ?? interval.upper;
      return (interval.lower + interval.upper) / 2;
    }
    case 'half_lod': {
      if (interval.censorType === 'left_censored') return (r.lodMm ?? interval.upper) / 2;
      return (interval.lower + interval.upper) / 2;
    }
    case 'loq': {
      if (interval.censorType === 'left_censored') return r.loqMm ?? r.lodMm ?? interval.upper;
      return (interval.lower + interval.upper) / 2;
    }
  }
}

export function computeRuleSensitivity(
  resolved: ResolvedMeasurement[],
  bounds: BoundStats,
): RuleSensitivityRow[] {
  const leftRecords = resolved.filter((r) => r.record.kind === 'left');
  const roundedRecords = resolved.filter((r) => r.record.kind === 'interval');

  return REPORT_RULES.map((rule) => {
    let exceedCount = 0;
    for (const r of resolved) {
      const v = imputeValue(r, rule.id);
      if (v > bounds.thresholdMm) exceedCount += 1; // 严格超过
    }
    const proportion = bounds.n === 0 ? 0 : exceedCount / bounds.n;
    const p = proportion + BOUND_TOLERANCE;
    let relation: RuleSensitivityRow['relation'];
    if (Math.abs(proportion - bounds.lowerProportion) < 1e-9) relation = 'at_lower';
    else if (Math.abs(proportion - bounds.upperProportion) < 1e-9) relation = 'at_upper';
    else if (p >= bounds.lowerProportion && proportion <= bounds.upperProportion + BOUND_TOLERANCE)
      relation = 'inside';
    else relation = 'outside';

    return {
      rule,
      exceedCount,
      proportion,
      pct: 100 * proportion,
      relation,
      leftImputedValues: leftRecords.map((r) => round6(imputeValue(r, rule.id))),
      roundedImputedValues: roundedRecords.map((r) => round6(imputeValue(r, rule.id))),
      imputation: true,
    };
  });
}

/** 阈值扫描：展示“置零低估 / LOD 高估”在低阈值处的机制差异 */
export function thresholdSweep(
  resolved: ResolvedMeasurement[],
  thresholdsMm: number[] = [0.5, 1, 1.5, 2, 3, 5, 10],
): SweepPoint[] {
  return thresholdsMm.map((thresholdMm) => {
    let zero = 0;
    let lod = 0;
    let lower = 0;
    let upper = 0;
    for (const r of resolved) {
      if (imputeValue(r, 'zero') > thresholdMm) zero += 1;
      if (imputeValue(r, 'lod') > thresholdMm) lod += 1;
      if (r.interval.lower > thresholdMm) lower += 1;
      if (r.interval.upper > thresholdMm) upper += 1;
    }
    const n = resolved.length || 1;
    return {
      thresholdMm,
      zeroPct: (100 * zero) / n,
      lodPct: (100 * lod) / n,
      lowerPct: (100 * lower) / n,
      upperPct: (100 * upper) / n,
    };
  });
}

// ---------------- 发布闸门：样本量 + 方法一致性 ----------------

export function evaluateFitGate(
  records: RiskMeasurement[],
  opts: { releaseMethodId?: string; previousMethodId?: string | null; minSampleSize?: number } = {},
): FitGate {
  const minSampleSize = opts.minSampleSize ?? MIN_FIT_SAMPLE_SIZE;
  const sampleSize = records.length;
  const distinctMethodIds = Array.from(new Set(records.map((r) => r.methodId)));
  const primaryMethodId = distinctMethodIds.length === 1 ? (distinctMethodIds[0] as RiskMethodId) : null;

  const reasons: GateReason[] = [];

  if (sampleSize < minSampleSize) {
    reasons.push({
      code: 'sample_too_small',
      blocking: true,
      message: `同批有效样本 n=${sampleSize} < 最小可拟合样本 ${minSampleSize}：样本太少，不足以支撑区间删失分布外推，只发布无分布边界。`,
    });
  }

  if (distinctMethodIds.length > 1) {
    reasons.push({
      code: 'mixed_methods',
      blocking: true,
      message: `同一报告批次混用了 ${distinctMethodIds.length} 种检测方法（${distinctMethodIds
        .map((id) => RISK_METHOD_LABELS[id] ?? id)
        .join('、')}）：删失机制与误差带不一致，不能当作同分布样本拟合，只发布边界。`,
    });
  }

  if (
    opts.releaseMethodId &&
    primaryMethodId &&
    opts.releaseMethodId !== primaryMethodId
  ) {
    reasons.push({
      code: 'release_method_mismatch',
      blocking: true,
      message: `发布署名方法「${RISK_METHOD_LABELS[opts.releaseMethodId] ?? opts.releaseMethodId}」与批次实测方法「${
        RISK_METHOD_LABELS[primaryMethodId] ?? primaryMethodId
      }」不一致：方法已变更 / 错配，分布拟合的同批机制假设不成立，只发布边界。`,
    });
  }

  if (
    opts.previousMethodId &&
    opts.releaseMethodId &&
    opts.previousMethodId !== opts.releaseMethodId
  ) {
    reasons.push({
      code: 'method_changed_since_previous_version',
      blocking: true,
      message: `相对上一结果版本，检测方法由「${
        RISK_METHOD_LABELS[opts.previousMethodId] ?? opts.previousMethodId
      }」变更为「${
        RISK_METHOD_LABELS[opts.releaseMethodId] ?? opts.releaseMethodId
      }」：跨方法的拟合概率不可直接比较或合并，本版本只发布边界。`,
    });
  }

  return {
    fitAllowed: reasons.filter((r) => r.blocking).length === 0,
    sampleSize,
    minSampleSize,
    distinctMethodIds,
    primaryMethodId,
    reasons,
    boundsAlwaysPublishable: true,
  };
}

// ---------------- 区间删失对数正态 MLE ----------------
// Y = ln X ~ N(mu, sigma)。每条区间 [l,u] 的似然贡献为
//   Φ((ln u - mu)/sigma) - Φ((ln l - mu)/sigma)，l=0 时左项为 0。
// 点测值已按仪器舍入半宽展开为小区间，因此可与删失记录统一处理。

/** Abramowitz–Stegun 近似 erf */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

interface SimpleInterval {
  lower: number;
  upper: number;
}

function intervalLikelihoodProb(iv: SimpleInterval, mu: number, sigma: number): number {
  const zUpper = (Math.log(iv.upper) - mu) / sigma;
  const cdfUpper = normCdf(zUpper);
  const cdfLower = iv.lower > 0 ? normCdf((Math.log(iv.lower) - mu) / sigma) : 0;
  // 极窄 / 数值下溢时给一个正下限，避免 log(0)
  return Math.max(cdfUpper - cdfLower, 1e-12);
}

function negativeLogLikelihood(intervals: SimpleInterval[], mu: number, eta: number): number {
  // eta = ln sigma，做无约束优化
  const sigma = Math.exp(eta);
  let nll = 0;
  for (const iv of intervals) {
    const p = intervalLikelihoodProb(iv, mu, sigma);
    nll -= Math.log(p);
  }
  return nll;
}

/** 坐标模式搜索（确定性，无随机数）：从起点找局部最优 */
function patternMinimize(
  fn: (p: number[]) => number,
  start: number[],
  initialSteps: number[],
): { params: number[]; value: number; iterations: number } {
  let params = start.slice();
  let value = fn(params);
  let steps = initialSteps.slice();
  let iterations = 0;

  for (let iter = 0; iter < 400; iter += 1) {
    iterations = iter + 1;
    let moved = false;
    for (let dim = 0; dim < params.length; dim += 1) {
      let bestValue = value;
      let bestParams: number[] | null = null;
      for (const dir of [1, -1]) {
        const candidate = params.slice();
        candidate[dim] += dir * steps[dim];
        const v = fn(candidate);
        if (v < bestValue - 1e-10) {
          bestValue = v;
          bestParams = candidate;
        }
      }
      if (bestParams) {
        params = bestParams;
        value = bestValue;
        moved = true;
      }
    }
    if (!moved) {
      steps = steps.map((s) => s * 0.5);
      if (Math.max(...steps) < 1e-7) break;
    }
  }
  return { params, value, iterations };
}

/**
 * 拟合区间删失对数正态分布。
 * 调用方应先用 evaluateFitGate 判定是否允许发布；本函数只负责数值估计。
 */
export function fitIntervalCensoredLognormal(
  resolved: ResolvedMeasurement[],
  thresholdMm: number,
  bounds: BoundStats,
): FitResult {
  const intervals: SimpleInterval[] = resolved.map((r) => ({
    lower: r.interval.lower,
    upper: Math.max(r.interval.upper, r.interval.lower + 1e-6),
  }));

  // 用所有区间中点（左删失取 LOD/2）构造稳健初值
  const initLogs: number[] = resolved.map((r) => {
    const mid =
      r.interval.censorType === 'left_censored'
        ? Math.max(r.lodMm ?? r.interval.upper, 1e-3) / 2
        : (r.interval.lower + r.interval.upper) / 2;
    return Math.log(Math.max(mid, 1e-3));
  });
  const meanLog = initLogs.reduce((a, b) => a + b, 0) / Math.max(1, initLogs.length);
  const variance =
    initLogs.reduce((a, x) => a + (x - meanLog) ** 2, 0) / Math.max(1, initLogs.length - 1);
  const initSigma = Math.min(1.2, Math.max(0.25, Math.sqrt(Math.max(variance, 0.05))));

  // 多起点，避免删失导致的平坦似然困住坐标搜索
  const starts: number[][] = [
    [meanLog, Math.log(initSigma)],
    [meanLog - 0.35, Math.log(initSigma)],
    [meanLog + 0.35, Math.log(initSigma)],
    [meanLog, Math.log(Math.max(0.3, initSigma * 0.6))],
    [meanLog, Math.log(Math.min(1.4, initSigma * 1.5))],
  ];

  let best: { params: number[]; value: number; iterations: number } | null = null;
  for (const s of starts) {
    const out = patternMinimize((p) => negativeLogLikelihood(intervals, p[0], p[1]), s, [0.25, 0.2]);
    if (!best || out.value < best.value) best = out;
  }

  const mu = best!.params[0];
  const eta = best!.params[1];
  const sigma = Math.exp(eta);
  const logLikelihood = -best!.value;

  const zThresh = (Math.log(thresholdMm) - mu) / sigma;
  const exceedProbability = 1 - normCdf(zThresh);

  // 近似标准误：数值 Hessian + delta 法（θ=(mu, eta=ln sigma)）
  const ci95 = approximateCi95(intervals, mu, eta, zThresh, exceedProbability);

  const withinHardBounds =
    exceedProbability + BOUND_TOLERANCE >= bounds.lowerProportion &&
    exceedProbability - BOUND_TOLERANCE <= bounds.upperProportion;

  return {
    distribution: 'lognormal_interval_censored',
    mu: round6(mu),
    sigma: round6(sigma),
    logLikelihood: round6(logLikelihood),
    iterations: best!.iterations,
    n: resolved.length,
    thresholdMm,
    exceedProbability,
    exceedPct: 100 * exceedProbability,
    ci95,
    withinHardBounds,
    hardLowerPct: bounds.lowerPct,
    hardUpperPct: bounds.upperPct,
    assumptions: [
      '同一报告批次来自同一总体、同一抽样 / 检测机制（方法一致）',
      '裂缝宽度服从对数正态分布（形状假设；Weibull / Gamma 会给不同尾部）',
      '删失区间条件独立、检出限已知且与真实值无关',
      '样本量足以辨识 μ、σ 两个参数',
    ],
  };
}

function approximateCi95(
  intervals: SimpleInterval[],
  mu: number,
  eta: number,
  zThresh: number,
  pExceed: number,
): { lowPct: number; highPct: number } | null {
  const h = 1e-2;
  const nll = (a: number, b: number) => negativeLogLikelihood(intervals, a, b);
  const h11 = (nll(mu + h, eta) - 2 * nll(mu, eta) + nll(mu - h, eta)) / h ** 2;
  const h22 = (nll(mu, eta + h) - 2 * nll(mu, eta) + nll(mu, eta - h)) / h ** 2;
  const h12 =
    (nll(mu + h, eta + h) - nll(mu + h, eta - h) - nll(mu - h, eta + h) + nll(mu - h, eta - h)) /
    (4 * h ** 2);

  const det = h11 * h22 - h12 * h12;
  if (!(det > 1e-8) || !Number.isFinite(det)) return null;
  // Hessian 逆 = 协方差
  const covMu = h22 / det;
  const covEta = h11 / det;
  const covMuEta = -h12 / det;
  if (covMu <= 0 || covEta <= 0) return null;

  // p = 1 - Φ(z)，z = (ln T - μ) e^{-η}；φ 为标准正态密度
  const phi = normPdf(zThresh);
  // g = dp/d(mu), dp/d(eta)
  const gMu = phi / Math.exp(eta);
  const gEta = phi * zThresh;
  const variance = gMu * gMu * covMu + 2 * gMu * gEta * covMuEta + gEta * gEta * covEta;
  if (!(variance > 0) || !Number.isFinite(variance)) return null;
  const se = Math.sqrt(variance);
  const low = Math.max(0, pExceed - 1.96 * se);
  const high = Math.min(1, pExceed + 1.96 * se);
  return { lowPct: 100 * low, highPct: 100 * high };
}

// ---------------- 整批分析 ----------------

export interface BatchAnalysis {
  batch: RiskBatch;
  resolved: ResolvedMeasurement[];
  bounds: BoundStats;
  ruleRows: RuleSensitivityRow[];
  sweep: SweepPoint[];
  gate: FitGate;
  /** 仅当闸门允许时才计算并返回拟合，避免在小样本 / 方法变更场景输出“可用点估计” */
  fit: FitResult | null;
}

export function analyzeBatch(
  batch: RiskBatch,
  ledger: InstrumentLedger[],
  opts: { releaseMethodId?: string; previousMethodId?: string | null } = {},
): BatchAnalysis {
  const resolved = resolveBatch(batch, ledger);
  const bounds = computeHardBounds(resolved, batch.thresholdMm);
  const ruleRows = computeRuleSensitivity(resolved, bounds);
  const sweep = thresholdSweep(resolved);
  const gate = evaluateFitGate(batch.records, {
    releaseMethodId: opts.releaseMethodId,
    previousMethodId: opts.previousMethodId,
  });

  let fit: FitResult | null = null;
  if (gate.fitAllowed) {
    const candidate = fitIntervalCensoredLognormal(resolved, batch.thresholdMm, bounds);
    if (candidate.withinHardBounds) {
      fit = candidate;
    } else {
      // 模型与无分布硬边界冲突：不放行点估计，追加阻断理由
      gate.fitAllowed = false;
      gate.reasons.push({
        code: 'fit_outside_hard_bounds',
        blocking: true,
        message: `对数正态拟合的越限概率 ${candidate.exceedPct.toFixed(
          1,
        )}% 落在硬边界 [${bounds.lowerPct.toFixed(1)}%, ${bounds.upperPct.toFixed(
          1,
        )}%] 之外：分布形状假设与数据识别区间冲突，本版本只发布边界。`,
      });
    }
  }

  return { batch, resolved, bounds, ruleRows, sweep, gate, fit };
}

// ---------------- 结果版本发布 ----------------

export interface PublishVersionInput {
  analysis: BatchAnalysis;
  releaseMethodId: string;
  previousMethodId?: string | null;
  version: number;
  versionId: string;
  atIso: string;
  publishedBy: string;
  fingerprint: string;
  note?: string;
}

export function publishRiskVersion(input: PublishVersionInput): RiskResultVersion {
  const { analysis, releaseMethodId } = input;
  const { batch, bounds, ruleRows, gate, fit } = analysis;
  const scope: PublicationScope = gate.fitAllowed && fit ? 'bounds_plus_fit' : 'bounds_only';

  const methodLabel = RISK_METHOD_LABELS[releaseMethodId] ?? releaseMethodId;
  const headline =
    scope === 'bounds_plus_fit' && fit
      ? `批次 ${batch.reportBatchCode}：超过 ${batch.thresholdMm} mm 的比例硬边界 ${bounds.lowerPct.toFixed(
          1,
        )}%–${bounds.upperPct.toFixed(1)}%（${bounds.lowerCount}–${bounds.upperCount}/${bounds.n}）；` +
        `区间删失对数正态拟合 ${fit.exceedPct.toFixed(1)}%（落在边界内）。方法：${methodLabel}。`
      : `批次 ${batch.reportBatchCode}：仅发布无分布硬边界 ${bounds.lowerPct.toFixed(1)}%–${bounds.upperPct.toFixed(
          1,
        )}%（${bounds.lowerCount}–${bounds.upperCount}/${bounds.n}）；` +
        `因${gate.reasons
          .filter((r) => r.blocking)
          .map((r) =>
            r.code === 'sample_too_small'
              ? '样本太少'
              : r.code === 'mixed_methods'
                ? '方法混用'
                : r.code === 'method_changed_since_previous_version'
                  ? '方法相对上版变更'
                  : r.code === 'release_method_mismatch'
                    ? '发布方法与实测方法不一致'
                    : '拟合越界',
          )
          .join('、')}，不发布单点拟合 / 插补结论。方法：${methodLabel}。`;

  return {
    versionId: input.versionId,
    version: input.version,
    batchId: batch.batchId,
    reportBatchCode: batch.reportBatchCode,
    batchName: batch.name,
    projectId: batch.projectId,
    thresholdMm: batch.thresholdMm,
    methodId: releaseMethodId,
    methodLabel,
    measuredMethodIds: gate.distinctMethodIds,
    createdAt: input.atIso,
    publishedBy: input.publishedBy,
    sampleSize: bounds.n,
    bounds,
    ruleRows,
    fit,
    gate,
    scope,
    headline,
    fingerprint: input.fingerprint,
    note: input.note,
  };
}

// ---------------- 种子样例 ----------------
// 题目给定样例：20 个点测值 + 4 个 “<2 mm” + 3 个介于 8 至 12 mm 的粗舍入值。
// 20 个点测值中 14 个明确低于阈值、6 个明确高于阈值（远离 10，舍入带不跨阈值）。
// 按“假设最少、保证覆盖”的区间逻辑，3 个粗舍入值只知道介于 8–12mm，即可行域
// 都取 [8,12]：它们都跨 10mm 阈值，因而全部“不确定”（没有一个必然 >10，
// 但每一个都可能 >10）。严格 “>10” 下硬边界为 kMin=6、kMax=9（共 27），
// 即 22.2%–33.3%。区间中点恰为 10，中点 / 置零 / LOD 等单点规则在严格“超过”
// 下都落在下界 6/27——恰好警示单点替代会把不确定信息虚假地确定化。

export const RISK_LEDGER: InstrumentLedger[] = [
  {
    instrumentId: 'CG-D01',
    name: '数显裂缝测宽仪',
    methodId: 'crack_gauge',
    lodMm: 0.1,
    loqMm: 0.3,
    roundingIncrementMm: 0.1,
    roundingHalfWidthMm: 0.05,
    calibration: '校准证 JL-2026-031（有效期至 2027-03）',
    note: '承担 20 个精确点测值',
  },
  {
    instrumentId: 'CG-M02',
    name: '机械裂缝对比卡（粗读数）',
    methodId: 'crack_gauge',
    lodMm: 2.0,
    loqMm: 4.0,
    roundingIncrementMm: 4.0,
    roundingHalfWidthMm: 2.0,
    calibration: '比对记录 BD-2026-1102',
    note: '低灵敏度 / 粗判读成档：产出 “<2” 与约 10mm 处 ±2mm（8–12）粗舍入带',
  },
  {
    instrumentId: 'UT-21',
    name: '超声波检测仪',
    methodId: 'ultrasonic',
    lodMm: 3.0,
    loqMm: 5.0,
    roundingIncrementMm: 1.0,
    roundingHalfWidthMm: 0.5,
    calibration: '校准证 UT-2026-077',
    note: '方法变更演示批次使用',
  },
];

const POINT_VALUES: number[] = [
  // 14 个明确 < 10（距阈值最近 9.8，加 ±0.05 后上沿 9.85，不跨阈值）
  1.1, 2.4, 3.3, 4.2, 5.0, 5.8, 6.6, 7.4, 8.0, 8.5, 8.9, 9.2, 9.5, 9.8,
  // 6 个明确 > 10（距阈值最近 10.4，减 ±0.05 后下沿 10.35，不跨阈值）
  10.4, 11.1, 12.3, 13.6, 15.2, 18.0,
];

function mainBatchRecords(): RiskMeasurement[] {
  const records: RiskMeasurement[] = POINT_VALUES.map((v, i) => ({
    id: `M-P${String(i + 1).padStart(2, '0')}`,
    objectId: `CD-${String(i + 1).padStart(3, '0')}`,
    kind: 'point',
    reported: v.toFixed(1),
    valueMm: v,
    methodId: 'crack_gauge',
    instrumentId: 'CG-D01',
  }));

  for (let i = 0; i < 4; i += 1) {
    records.push({
      id: `M-L${i + 1}`,
      objectId: `CD-L${String(i + 1).padStart(2, '0')}`,
      kind: 'left',
      reported: '<2',
      limitMm: 2,
      methodId: 'crack_gauge',
      instrumentId: 'CG-M02',
      note: '低于仪器检出限，未定量',
    });
  }

  // 题目只给出“3 个介于 8 至 12mm 的舍入值”，不额外假设更窄的舍入带：
  // 按最少假设，每条可行域都是整个 [8,12]，均跨过 10mm 阈值。
  for (let i = 0; i < 3; i += 1) {
    records.push({
      id: `M-R${i + 1}`,
      objectId: `CD-R${String(i + 1).padStart(2, '0')}`,
      kind: 'interval',
      reported: '8–12（粗舍入档）',
      lowerMm: 8,
      upperMm: 12,
      methodId: 'crack_gauge',
      instrumentId: 'CG-M02',
      note: '粗舍入值，原始记录仅能确定其介于 8–12mm；按最少假设整体作为可行区间 [8,12]，跨过 10mm 阈值',
    });
  }

  return records;
}

function smallBatchRecords(): RiskMeasurement[] {
  // n=8：用于演示“样本太少 → 只发布边界”
  const vals = [3.2, 5.5, 8.8, 10.6, 12.4];
  const records: RiskMeasurement[] = vals.map((v, i) => ({
    id: `S-P${i + 1}`,
    objectId: `SD-${i + 1}`,
    kind: 'point',
    reported: v.toFixed(1),
    valueMm: v,
    methodId: 'crack_gauge',
    instrumentId: 'CG-D01',
  }));
  records.push({
    id: 'S-L1',
    objectId: 'SD-L1',
    kind: 'left',
    reported: '<2',
    limitMm: 2,
    methodId: 'crack_gauge',
    instrumentId: 'CG-M02',
  });
  records.push({
    id: 'S-L2',
    objectId: 'SD-L2',
    kind: 'left',
    reported: '<2',
    limitMm: 2,
    methodId: 'crack_gauge',
    instrumentId: 'CG-M02',
  });
  records.push({
    id: 'S-R1',
    objectId: 'SD-R1',
    kind: 'interval',
    reported: '10（粗舍入）',
    lowerMm: 9,
    upperMm: 11,
    methodId: 'crack_gauge',
    instrumentId: 'CG-M02',
  });
  return records;
}

function methodChangedBatchRecords(): RiskMeasurement[] {
  // n=22 且样本充足，但同一报告批次混用两种方法 → 方法不一致，只发布边界
  const records: RiskMeasurement[] = [];
  for (let i = 0; i < 16; i += 1) {
    const v = [4.1, 5.6, 6.9, 7.8, 8.4, 9.1, 9.6, 10.2, 10.8, 11.9, 13.1, 14.6, 3.8, 6.2, 8.9, 12.5][i];
    records.push({
      id: `C-G${i + 1}`,
      objectId: `MD-G${i + 1}`,
      kind: 'point',
      reported: v.toFixed(1),
      valueMm: v,
      methodId: 'crack_gauge',
      instrumentId: 'CG-D01',
    });
  }
  for (let i = 0; i < 6; i += 1) {
    if (i < 3) {
      records.push({
        id: `C-U${i + 1}`,
        objectId: `MD-U${i + 1}`,
        kind: 'left',
        reported: '<3',
        limitMm: 3,
        methodId: 'ultrasonic',
        instrumentId: 'UT-21',
        note: '超声波法检出限 3 mm',
      });
    } else {
      const v = [7.5, 9.4, 11.2][i - 3];
      records.push({
        id: `C-U${i + 1}`,
        objectId: `MD-U${i + 1}`,
        kind: 'point',
        reported: v.toFixed(1),
        valueMm: v,
        methodId: 'ultrasonic',
        instrumentId: 'UT-21',
        roundingHalfWidthMm: 0.5,
      });
    }
  }
  return records;
}

export const RISK_BATCHES: RiskBatch[] = [
  {
    batchId: 'B-MAIN',
    reportBatchCode: 'BG-20261125-A',
    name: '主楼二层梁板 · 裂缝抽检批次 A',
    projectId: 'P',
    collectedOn: '2026-11-25',
    thresholdMm: CRACK_DEFECT_THRESHOLD_MM,
    records: mainBatchRecords(),
  },
  {
    batchId: 'B-SMALL',
    reportBatchCode: 'BG-20261120-PILOT',
    name: '地下室外墙 · 小批量试检（样本不足）',
    projectId: 'P',
    collectedOn: '2026-11-20',
    thresholdMm: CRACK_DEFECT_THRESHOLD_MM,
    records: smallBatchRecords(),
  },
  {
    batchId: 'B-METHOD',
    reportBatchCode: 'BG-20261118-MIX',
    name: '三层柱 · 测宽仪与超声波混批（方法变更）',
    projectId: 'P',
    collectedOn: '2026-11-18',
    thresholdMm: CRACK_DEFECT_THRESHOLD_MM,
    records: methodChangedBatchRecords(),
  },
];

// ---------------- 工具 ----------------

export function round6(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

export function formatPct(x: number, digits = 1): string {
  return `${x.toFixed(digits)}%`;
}
