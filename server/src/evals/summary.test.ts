// specs/eval-runner.md AT-20 and the bucket parts of AT-21 (rules 13, 20, 21; D-1, D-3, D-8).
// summarize is pure, so these tests build CaseResult values directly.
import { describe, expect, it } from 'vitest';
import { CaseResult, Thresholds } from './schemas.js';
import { summarize } from './summary.js';

type Agent = 'orchestrator' | 'leave' | 'policy_qa' | 'onboarding';
type Category = 'routing' | 'extraction' | 'verdict' | 'citation' | 'injection';
type Status = 'passed' | 'failed' | 'error' | 'skipped' | 'unscorable';

let seq = 0;
function mk(
  status: Status,
  over: { agent?: Agent; category?: Category; reviewed?: boolean | null; tags?: string[] } = {},
): CaseResult {
  seq += 1;
  return CaseResult.parse({
    agent: over.agent ?? 'leave',
    id: `EV-${String(seq)}`,
    category: over.category ?? 'verdict',
    status,
    reviewed: over.reviewed === undefined ? null : over.reviewed,
    tags: over.tags ?? [],
    asOf: null,
    skipReason: status === 'skipped' ? 'blocked' : null,
    skipDetail: status === 'skipped' ? 'blocked:synthetic' : null,
    unscorableKeys: status === 'unscorable' ? ['surpriseKey'] : [],
    errorCode: status === 'error' ? 'run_failed' : null,
    checks: [],
    latencyMs: null,
    tokens: { input: 0, output: 0 }, // rule 24 (v2)
    costUsd: 0,
  });
}
const many = (n: number, status: Status, over: Parameters<typeof mk>[1] = {}): CaseResult[] =>
  Array.from({ length: n }, () => mk(status, over));

function thresholds(leave: Record<string, unknown> = {}, other: Record<string, unknown> = {}) {
  const base = { categories: {}, ...other };
  return Thresholds.parse({
    version: 1,
    agents: {
      orchestrator: base,
      leave: { categories: {}, ...leave },
      policy_qa: base,
      onboarding: base,
    },
  });
}

describe('eval-runner AT-20: summaries', () => {
  it('AT-20: 3 passed, 1 failed, 1 errored and 2 skipped give total 7, skipped 2 and passRate 0.6', () => {
    const cases = [
      ...many(3, 'passed'),
      ...many(1, 'failed'),
      ...many(1, 'error'),
      ...many(2, 'skipped'),
    ];
    const { agents } = summarize(cases, thresholds());
    const b = agents.leave.categories.verdict;
    expect(b).toBeDefined();
    expect(b?.total).toBe(7);
    expect(b?.passed).toBe(3);
    expect(b?.failed).toBe(1);
    expect(b?.errored).toBe(1);
    expect(b?.skipped).toBe(2);
    expect(b?.passRate).toBeCloseTo(0.6, 10);
    expect(agents.leave.overall.passRate).toBeCloseTo(0.6, 10);
  });

  it('AT-20: unscorable cases count in the denominator', () => {
    const { agents } = summarize([...many(1, 'passed'), ...many(1, 'unscorable')], thresholds());
    const b = agents.leave.categories.verdict;
    expect(b?.unscorable).toBe(1);
    expect(b?.passRate).toBeCloseTo(0.5, 10);
  });

  it('AT-20: a category whose cases are all skipped has a null passRate', () => {
    const { agents } = summarize(many(3, 'skipped', { category: 'citation' }), thresholds());
    const b = agents.leave.categories.citation;
    expect(b?.total).toBe(3);
    expect(b?.skipped).toBe(3);
    expect(b?.passRate).toBeNull();
  });

  it('AT-20: reviewed:false cases count only in unreviewed; a missing flag counts as reviewed', () => {
    const cases = [
      mk('passed', { reviewed: true }),
      mk('passed', { reviewed: null }),
      mk('failed', { reviewed: false }),
    ];
    const { agents } = summarize(cases, thresholds());
    expect(agents.leave.overall.total).toBe(2);
    expect(agents.leave.overall.passRate).toBe(1);
    expect(agents.leave.categories.verdict?.total).toBe(2);
    expect(agents.leave.unreviewed.total).toBe(1);
    expect(agents.leave.unreviewed.failed).toBe(1);
    expect(agents.leave.unreviewed.threshold).toBeNull();
    expect(agents.leave.unreviewed.meetsThreshold).toBeNull();
  });

  it('AT-20: tag buckets exist only for tags that have a threshold', () => {
    const cases = [
      mk('passed', { tags: ['prohibited', 'other_tag'] }),
      mk('failed', { tags: ['prohibited'] }),
    ];
    const { agents } = summarize(cases, thresholds({ tags: { prohibited: 0.5 } }));
    expect(Object.keys(agents.leave.tags)).toEqual(['prohibited']);
    expect(agents.leave.tags.prohibited?.total).toBe(2);
    expect(agents.leave.tags.prohibited?.passRate).toBeCloseTo(0.5, 10);
  });

  it('AT-20: cases are bucketed per agent', () => {
    const cases = [mk('passed', { agent: 'orchestrator', category: 'routing' }), mk('failed')];
    const { agents } = summarize(cases, thresholds());
    expect(agents.orchestrator.overall.total).toBe(1);
    expect(agents.orchestrator.overall.passRate).toBe(1);
    expect(agents.leave.overall.total).toBe(1);
    expect(agents.leave.overall.passRate).toBe(0);
    expect(agents.policy_qa.overall.total).toBe(0);
    expect(agents.policy_qa.overall.passRate).toBeNull();
  });
});

describe('eval-runner AT-21: threshold enforcement in buckets', () => {
  const sixOfTen = (): CaseResult[] => [...many(3, 'passed'), ...many(2, 'failed')];

  it('AT-21: a pass rate exactly equal to its threshold meets it', () => {
    const r = summarize(sixOfTen(), thresholds({ categories: { verdict: 0.6 } }));
    const b = r.agents.leave.categories.verdict;
    expect(b?.threshold).toBe(0.6);
    expect(b?.meetsThreshold).toBe(true);
    expect(r.thresholdsMet).toBe(true);
  });

  it('AT-21: a pass rate below its threshold misses it', () => {
    const r = summarize(sixOfTen(), thresholds({ categories: { verdict: 0.61 } }));
    expect(r.agents.leave.categories.verdict?.meetsThreshold).toBe(false);
    expect(r.thresholdsMet).toBe(false);
  });

  it('AT-21: a category with a threshold and a null passRate fails closed', () => {
    const r = summarize(
      many(2, 'skipped', { category: 'injection' }),
      thresholds({ categories: { injection: 1 } }),
    );
    const b = r.agents.leave.categories.injection;
    expect(b?.passRate).toBeNull();
    expect(b?.meetsThreshold).toBe(false);
    expect(r.thresholdsMet).toBe(false);
  });

  it('AT-21: a category with a threshold and no cases fails closed', () => {
    const r = summarize(sixOfTen(), thresholds({ categories: { injection: 1 } }));
    const b = r.agents.leave.categories.injection;
    expect(b?.total).toBe(0);
    expect(b?.meetsThreshold).toBe(false);
    expect(r.thresholdsMet).toBe(false);
  });

  it('AT-21: a threshold of 0 is met when the passRate is not null, and 1 fails on any failure', () => {
    const zero = summarize(many(2, 'failed'), thresholds({ overall: 0 }));
    expect(zero.agents.leave.overall.meetsThreshold).toBe(true);
    const one = summarize(
      [...many(4, 'passed'), ...many(1, 'unscorable')],
      thresholds({ overall: 1 }),
    );
    expect(one.agents.leave.overall.meetsThreshold).toBe(false);
  });

  it('AT-21: a bucket with no threshold has meetsThreshold null and never blocks thresholdsMet', () => {
    const r = summarize(many(2, 'failed'), thresholds());
    expect(r.agents.leave.overall.threshold).toBeNull();
    expect(r.agents.leave.overall.meetsThreshold).toBeNull();
    expect(r.thresholdsMet).toBe(true);
  });

  it('AT-21: a failing unreviewed case cannot change thresholdsMet', () => {
    const cases = [...many(2, 'passed'), mk('failed', { reviewed: false })];
    const r = summarize(cases, thresholds({ overall: 1 }));
    expect(r.agents.leave.overall.total).toBe(2);
    expect(r.agents.leave.overall.meetsThreshold).toBe(true);
    expect(r.thresholdsMet).toBe(true);
  });
});
