import { describe, expect, it } from 'vitest';
import {
  RISK_BATCHES,
  RISK_LEDGER,
  analyzeBatch,
  computeHardBounds,
  evaluateFitGate,
  fitIntervalCensoredLognormal,
  resolveBatch,
  thresholdSweep,
} from './intervalRisk';

const main = RISK_BATCHES.find((b) => b.batchId === 'B-MAIN')!;
const small = RISK_BATCHES.find((b) => b.batchId === 'B-SMALL')!;
const mixed = RISK_BATCHES.find((b) => b.batchId === 'B-METHOD')!;

describe('区间求值器与无分布硬边界（样例：20 点测 + 4 个 <2 + 3 个 8–12 舍入）', () => {
  it('样本总数为 27，构成与题目一致', () => {
    expect(main.records).toHaveLength(27);
    expect(main.records.filter((r) => r.kind === 'point')).toHaveLength(20);
    expect(main.records.filter((r) => r.kind === 'left')).toHaveLength(4);
    expect(main.records.filter((r) => r.kind === 'interval')).toHaveLength(3);
  });

  it('每条记录都被表示为可行区间，且下界≤上界', () => {
    const resolved = resolveBatch(main, RISK_LEDGER);
    for (const r of resolved) {
      expect(r.interval.lower).toBeLessThanOrEqual(r.interval.upper);
      expect(r.interval.lower).toBeGreaterThanOrEqual(0);
      expect(r.interval.basis.length).toBeGreaterThan(0);
    }
  });

  it('4 个 “<2mm” 可行域为 [0,2]，在 10mm 阈值下全部不可能越限', () => {
    const resolved = resolveBatch(main, RISK_LEDGER);
    const left = resolved.filter((r) => r.record.kind === 'left');
    expect(left).toHaveLength(4);
    for (const r of left) {
      expect(r.interval.lower).toBe(0);
      expect(r.interval.upper).toBe(2);
      expect(r.exceedClass).toBe('cannot_exceed');
    }
  });

  it('3 个粗舍入记录按题目最少假设取可行域 [8,12]，全部跨 10mm 阈值 → 不确定', () => {
    const resolved = resolveBatch(main, RISK_LEDGER);
    const rounded = resolved.filter((r) => r.record.kind === 'interval');
    expect(rounded).toHaveLength(3);
    for (const r of rounded) {
      expect(r.interval.lower).toBe(8);
      expect(r.interval.upper).toBe(12);
      expect(r.exceedClass).toBe('ambiguous');
    }
  });

  it('严格 “>T” 边界语义：端点恰好等于阈值不算必然越限，也不算确定不越限', () => {
    const edgeBatch = {
      batchId: 'EDGE',
      reportBatchCode: 'EDGE',
      name: '边界语义',
      projectId: 'P',
      collectedOn: '2026-11-25',
      thresholdMm: 10,
      records: [
        // 精确落在 10：lower=upper=10，upper>10 为假 → 不可能越限（严格 >）
        { id: 'e1', objectId: 'E1', kind: 'point' as const, reported: '10', valueMm: 10, roundingHalfWidthMm: 0, methodId: 'crack_gauge' as const, instrumentId: 'CG-D01' },
        // [10,12]：lower=10 不满足 lower>10（不必然），upper>10（可能）→ 不确定
        { id: 'e2', objectId: 'E2', kind: 'interval' as const, reported: '10–12', lowerMm: 10, upperMm: 12, methodId: 'crack_gauge' as const, instrumentId: 'CG-M02' },
        // (10,12] 的可执行等价：下界略大于 10 → 必然越限
        { id: 'e3', objectId: 'E3', kind: 'interval' as const, reported: '>10–12', lowerMm: 10.0001, upperMm: 12, methodId: 'crack_gauge' as const, instrumentId: 'CG-M02' },
      ],
    };
    const resolved = resolveBatch(edgeBatch, RISK_LEDGER);
    expect(resolved.map((r) => r.exceedClass)).toEqual([
      'cannot_exceed',
      'ambiguous',
      'must_exceed',
    ]);
  });

  it('硬边界可手工核验：6 条必然越限，最多 9 条，即 6/27–9/27 = 22.2%–33.3%', () => {
    const resolved = resolveBatch(main, RISK_LEDGER);
    const b = computeHardBounds(resolved, 10);
    expect(b.n).toBe(27);
    expect(b.mustCount).toBe(6);
    expect(b.ambiguousCount).toBe(3);
    expect(b.cannotCount).toBe(18);
    expect(b.lowerCount).toBe(6);
    expect(b.upperCount).toBe(9);
    expect(b.lowerProportion).toBeCloseTo(6 / 27, 10);
    expect(b.upperProportion).toBeCloseTo(9 / 27, 10);
    expect(b.lowerPct).toBeCloseTo(22.2222, 3);
    expect(b.upperPct).toBeCloseTo(33.3333, 3);
  });

  it('最好/最坏端点规则的计数恰好等于硬下界/硬上界', () => {
    const a = analyzeBatch(main, RISK_LEDGER, { releaseMethodId: 'crack_gauge' });
    const lower = a.ruleRows.find((r) => r.rule.id === 'lower')!;
    const upper = a.ruleRows.find((r) => r.rule.id === 'upper')!;
    expect(lower.exceedCount).toBe(a.bounds.lowerCount);
    expect(upper.exceedCount).toBe(a.bounds.upperCount);
    expect(lower.relation).toBe('at_lower');
    expect(upper.relation).toBe('at_upper');
  });
});

describe('不同报告规则的敏感性', () => {
  it('在 10mm 阈值处置零与按 LOD 计数相同（LOD=2 远低于阈值），但插补值不同；中点恰为阈值 → 落在下界', () => {
    const a = analyzeBatch(main, RISK_LEDGER, { releaseMethodId: 'crack_gauge' });
    const zero = a.ruleRows.find((r) => r.rule.id === 'zero')!;
    const lod = a.ruleRows.find((r) => r.rule.id === 'lod')!;
    const halfLod = a.ruleRows.find((r) => r.rule.id === 'half_lod')!;
    const loq = a.ruleRows.find((r) => r.rule.id === 'loq')!;
    const mid = a.ruleRows.find((r) => r.rule.id === 'midpoint')!;

    // 4 条 <2 在各规则下被插补成不同值：0 / 2 / 1 / 4
    expect(zero.leftImputedValues).toEqual([0, 0, 0, 0]);
    expect(lod.leftImputedValues).toEqual([2, 2, 2, 2]);
    expect(halfLod.leftImputedValues).toEqual([1, 1, 1, 1]);
    expect(loq.leftImputedValues).toEqual([4, 4, 4, 4]);

    // 3 条 [8,12] 的中点 / 面值都是 10
    for (const row of [zero, lod, halfLod, loq, mid]) {
      expect(row.roundedImputedValues).toEqual([10, 10, 10]);
    }

    // 10mm 阈值下 0/1/2/4 都不越限；中点 10 按严格“超过”也不越限，
    // 故所有常用单点规则都只数到 6 个确定高点 = 硬下界——这正是单点插补
    // 把“3 条可能越限”的不确定信息虚假确定化的警示。最坏端点才得到 9。
    expect(zero.exceedCount).toBe(6);
    expect(lod.exceedCount).toBe(6);
    expect(mid.exceedCount).toBe(6);
    expect(mid.relation).toBe('at_lower');

    const upper = a.ruleRows.find((r) => r.rule.id === 'upper')!;
    expect(upper.exceedCount).toBe(9);
    expect(upper.relation).toBe('at_upper');
  });

  it('低阈值处可展示“置零低估、按 LOD 高估”的机制差异：T=1 时 LOD 比置零多 4 条', () => {
    const resolved = resolveBatch(main, RISK_LEDGER);
    const sweep = thresholdSweep(resolved, [1]);
    const p = sweep[0];
    // 4 条 <2：置零=0 不越过 1；按 LOD=2 越过 1，恰好相差 4/27
    expect(p.lodPct - p.zeroPct).toBeCloseTo((4 / 27) * 100, 6);
  });
});

describe('区间删失分布拟合', () => {
  it('主批次方法一致、n=27，闸门允许拟合，且拟合点估计落在硬边界内', () => {
    const a = analyzeBatch(main, RISK_LEDGER, { releaseMethodId: 'crack_gauge' });
    expect(a.gate.fitAllowed).toBe(true);
    expect(a.fit).not.toBeNull();
    const f = a.fit!;
    // eslint-disable-next-line no-console
    console.log('MAIN FIT', {
      mu: f.mu,
      sigma: f.sigma,
      pct: f.exceedPct,
      bounds: [f.hardLowerPct, f.hardUpperPct],
      ci: f.ci95,
      within: f.withinHardBounds,
    });
    expect(f.withinHardBounds).toBe(true);
    expect(f.exceedProbability).toBeGreaterThanOrEqual(6 / 27 - 1e-6);
    expect(f.exceedProbability).toBeLessThanOrEqual(9 / 27 + 1e-6);
  });

  it('直接调用拟合器也稳定收敛（sigma 为正，似然有限）', () => {
    const resolved = resolveBatch(main, RISK_LEDGER);
    const bounds = computeHardBounds(resolved, 10);
    const f = fitIntervalCensoredLognormal(resolved, 10, bounds);
    expect(f.sigma).toBeGreaterThan(0);
    expect(Number.isFinite(f.logLikelihood)).toBe(true);
  });
});

describe('发布闸门：样本太少 / 方法变化时只发布边界', () => {
  it('小批量 n=8 < 20：sample_too_small，fit=null，边界仍可发布', () => {
    const gate = evaluateFitGate(small.records, { releaseMethodId: 'crack_gauge' });
    expect(gate.fitAllowed).toBe(false);
    expect(gate.reasons.some((r) => r.code === 'sample_too_small')).toBe(true);
    expect(gate.boundsAlwaysPublishable).toBe(true);

    const a = analyzeBatch(small, RISK_LEDGER, { releaseMethodId: 'crack_gauge' });
    expect(a.fit).toBeNull();
    expect(a.bounds.n).toBe(8);
    // 边界本身仍然成立：下界 ≤ 上界
    expect(a.bounds.lowerCount).toBeLessThanOrEqual(a.bounds.upperCount);
  });

  it('混批 n=22 但方法混用：mixed_methods，fit=null（样本量不是阻断原因）', () => {
    const gate = evaluateFitGate(mixed.records, { releaseMethodId: 'crack_gauge' });
    expect(gate.sampleSize).toBe(22);
    expect(gate.reasons.some((r) => r.code === 'sample_too_small')).toBe(false);
    expect(gate.reasons.some((r) => r.code === 'mixed_methods')).toBe(true);
    expect(gate.fitAllowed).toBe(false);
    const a = analyzeBatch(mixed, RISK_LEDGER, { releaseMethodId: 'crack_gauge' });
    expect(a.fit).toBeNull();
  });

  it('发布署名方法与实测方法不一致 / 相对上版变更时阻断拟合', () => {
    const mismatch = evaluateFitGate(main.records, { releaseMethodId: 'ultrasonic' });
    expect(mismatch.fitAllowed).toBe(false);
    expect(mismatch.reasons.some((r) => r.code === 'release_method_mismatch')).toBe(true);

    const changed = evaluateFitGate(main.records, {
      releaseMethodId: 'crack_gauge',
      previousMethodId: 'ultrasonic',
    });
    expect(changed.fitAllowed).toBe(false);
    expect(changed.reasons.some((r) => r.code === 'method_changed_since_previous_version')).toBe(true);
  });

  it('同方法且无上版方法冲突时闸门放行', () => {
    const ok = evaluateFitGate(main.records, {
      releaseMethodId: 'crack_gauge',
      previousMethodId: 'crack_gauge',
    });
    expect(ok.fitAllowed).toBe(true);
    expect(ok.reasons).toHaveLength(0);
  });
});
