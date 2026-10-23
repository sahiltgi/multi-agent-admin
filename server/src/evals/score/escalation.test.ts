// specs/eval-runner.md AT-23, AT-24 (pure part), AT-25, AT-27 (rule 23; D-19). The escalation
// function is pure: it takes CaseResult values and builds no world, model or file.
import { describe, expect, it } from 'vitest';
import { CaseResult, type EvalAgent } from '../schemas.js';
import { escalationSummary } from './escalation.js';

type Status = 'passed' | 'failed' | 'error' | 'skipped' | 'unscorable';
type Verdict = string | null;

let seq = 0;
function mk(
  status: Status,
  over: {
    agent?: EvalAgent;
    reviewed?: boolean | null;
    verdict?: readonly [Verdict, Verdict]; // [expected, actual]; absent = no verdict check
  } = {},
): CaseResult {
  seq += 1;
  const verdict = over.verdict;
  return CaseResult.parse({
    agent: over.agent ?? 'leave',
    id: `EV-${String(seq)}`,
    category: 'verdict',
    status,
    reviewed: over.reviewed === undefined ? null : over.reviewed,
    tags: [],
    asOf: null,
    skipReason: status === 'skipped' ? 'blocked' : null,
    skipDetail: status === 'skipped' ? 'blocked:synthetic' : null,
    unscorableKeys: status === 'unscorable' ? ['surpriseKey'] : [],
    errorCode: status === 'error' ? 'model_unavailable' : null,
    // Skipped and error cases carry the check too: only their status may exclude them (AT-27).
    checks:
      verdict === undefined
        ? []
        : [
            {
              field: 'verdict',
              passed: verdict[0] === verdict[1],
              expected: verdict[0],
              actual: verdict[1],
            },
          ],
    latencyMs: null,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
  });
}

const leave = (expected: Verdict, actual: Verdict, over: Parameters<typeof mk>[1] = {}) =>
  mk(expected === actual ? 'passed' : 'failed', {
    ...over,
    agent: 'leave',
    verdict: [expected, actual],
  });

describe('eval-runner AT-23: escalation precision and recall', () => {
  const FIVE = [
    leave('ESCALATE_TO_HR', 'ESCALATE_TO_HR'),
    leave('ESCALATE_TO_HR', 'ROUTE_TO_MANAGER'),
    leave('ROUTE_TO_MANAGER', 'ESCALATE_TO_HR'),
    leave('ROUTE_TO_MANAGER', 'ROUTE_TO_MANAGER'),
    leave('ESCALATE_TO_HR', null),
  ];

  it('AT-23: five leave cases give TP=1, FP=1, FN=2, TN=1, precision 0.5, recall 1/3', () => {
    const e = escalationSummary('leave', FIVE, {});
    expect(e).not.toBeNull();
    expect(e?.positive).toBe('ESCALATE_TO_HR');
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([1, 1, 2, 1]);
    expect(e?.precision.value).toBeCloseTo(0.5, 12);
    expect(e?.recall.value).toBeCloseTo(1 / 3, 12);
  });

  it('AT-23: with no thresholds, meetsThreshold is null for both metrics', () => {
    const e = escalationSummary('leave', FIVE, {});
    expect(e?.precision).toMatchObject({ threshold: null, meetsThreshold: null });
    expect(e?.recall).toMatchObject({ threshold: null, meetsThreshold: null });
  });

  it('AT-23: a threshold is met when value >= threshold (equal counts) and missed below it', () => {
    const met = escalationSummary('leave', FIVE, { precision: 0.5, recall: 0.3 });
    expect(met?.precision).toMatchObject({ threshold: 0.5, meetsThreshold: true });
    expect(met?.recall).toMatchObject({ threshold: 0.3, meetsThreshold: true });
    const missed = escalationSummary('leave', FIVE, { precision: 0.51, recall: 0.34 });
    expect(missed?.precision.meetsThreshold).toBe(false);
    expect(missed?.recall.meetsThreshold).toBe(false);
  });

  it('AT-23: an expected verdict null is expected negative and a null actual is actual negative', () => {
    const e = escalationSummary(
      'leave',
      [leave(null, null), leave(null, 'ESCALATE_TO_HR'), leave('ESCALATE_TO_HR', null)],
      {},
    );
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([0, 1, 1, 1]);
  });

  it('AT-23: other leave verdicts are all negative', () => {
    const e = escalationSummary(
      'leave',
      [
        leave('ROUTE_TO_MANAGER_WITH_FLAGS', 'RETURN_TO_EMPLOYEE'),
        leave('RETURN_TO_EMPLOYEE', 'ROUTE_TO_MANAGER_WITH_FLAGS'),
      ],
      {},
    );
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([0, 0, 0, 2]);
  });

  it('AT-23: policy_qa counts ESCALATE_TO_HR as positive and AUTO_ANSWER as negative', () => {
    const qa = (expected: Verdict, actual: Verdict) =>
      mk(expected === actual ? 'passed' : 'failed', {
        agent: 'policy_qa',
        verdict: [expected, actual],
      });
    const e = escalationSummary(
      'policy_qa',
      [
        qa('ESCALATE_TO_HR', 'ESCALATE_TO_HR'),
        qa('ESCALATE_TO_HR', null), // the Q&A gate never ran: false negative
        qa('AUTO_ANSWER', 'AUTO_ANSWER'),
      ],
      {},
    );
    expect(e?.positive).toBe('ESCALATE_TO_HR');
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([1, 0, 1, 1]);
  });

  it('AT-23: the orchestrator has no gate, so its escalation is null', () => {
    const c = mk('passed', {
      agent: 'orchestrator',
      verdict: ['ESCALATE_TO_HR', 'ESCALATE_TO_HR'],
    });
    expect(escalationSummary('orchestrator', [c], {})).toBeNull();
  });

  it('AT-23: only the given agent cases count', () => {
    const e = escalationSummary(
      'leave',
      [
        leave('ESCALATE_TO_HR', 'ESCALATE_TO_HR'),
        mk('passed', { agent: 'policy_qa', verdict: ['ESCALATE_TO_HR', 'ESCALATE_TO_HR'] }),
      ],
      {},
    );
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([1, 0, 0, 0]);
  });

  it('AT-23: a case with no verdict check is outside the population, an unscorable one with a verdict check is inside', () => {
    const e = escalationSummary(
      'leave',
      [
        mk('passed', { agent: 'leave' }), // no verdict check
        mk('unscorable', { agent: 'leave', verdict: ['ESCALATE_TO_HR', 'ESCALATE_TO_HR'] }),
      ],
      {},
    );
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([1, 0, 0, 0]);
  });
});

describe('eval-runner AT-24: zero denominators (pure part)', () => {
  it('AT-24: expected and actual all ROUTE_TO_MANAGER give null precision and recall', () => {
    const e = escalationSummary(
      'leave',
      [
        leave('ROUTE_TO_MANAGER', 'ROUTE_TO_MANAGER'),
        leave('ROUTE_TO_MANAGER', 'ROUTE_TO_MANAGER'),
      ],
      {},
    );
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([0, 0, 0, 2]);
    expect(e?.precision.value).toBeNull();
    expect(e?.recall.value).toBeNull();
  });

  it('AT-24: a threshold on a null value fails closed', () => {
    const e = escalationSummary('leave', [leave('ROUTE_TO_MANAGER', 'ROUTE_TO_MANAGER')], {
      recall: 0.8,
    });
    expect(e?.recall).toMatchObject({ value: null, threshold: 0.8, meetsThreshold: false });
    expect(e?.precision.meetsThreshold).toBeNull();
  });

  it('AT-24: no cases at all give null rates', () => {
    const e = escalationSummary('leave', [], {});
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([0, 0, 0, 0]);
    expect(e?.precision.value).toBeNull();
    expect(e?.recall.value).toBeNull();
  });
});

describe('eval-runner AT-25: onboarding escalation', () => {
  it('AT-25: MANAGER/MANAGER, MANAGER/AUTO and AUTO/AUTO give TP=1, FN=1, TN=1, precision 1, recall 0.5', () => {
    const ob = (expected: Verdict, actual: Verdict) =>
      mk(expected === actual ? 'passed' : 'failed', {
        agent: 'onboarding',
        verdict: [expected, actual],
      });
    const e = escalationSummary(
      'onboarding',
      [ob('MANAGER', 'MANAGER'), ob('MANAGER', 'AUTO'), ob('AUTO', 'AUTO')],
      {},
    );
    expect(e?.positive).toBe('MANAGER');
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([1, 0, 1, 1]);
    expect(e?.precision.value).toBe(1);
    expect(e?.recall.value).toBe(0.5);
  });
});

describe('eval-runner AT-27: the population', () => {
  it('AT-27: only the reviewed case that ran is counted', () => {
    const both: readonly [Verdict, Verdict] = ['ESCALATE_TO_HR', 'ESCALATE_TO_HR'];
    const cases = [
      mk('passed', { reviewed: false, verdict: both }),
      mk('skipped', { verdict: both }),
      mk('error', { verdict: both }),
      mk('passed', { reviewed: true, verdict: both }),
    ];
    const e = escalationSummary('leave', cases, {});
    expect([e?.tp, e?.fp, e?.fn, e?.tn]).toEqual([1, 0, 0, 0]);
  });

  it('AT-27: a missing reviewed flag counts as reviewed', () => {
    const e = escalationSummary(
      'leave',
      [mk('passed', { reviewed: null, verdict: ['ESCALATE_TO_HR', 'ESCALATE_TO_HR'] })],
      {},
    );
    expect(e?.tp).toBe(1);
  });

  it('AT-27: an error case that expected ESCALATE_TO_HR does not lower recall', () => {
    const e = escalationSummary(
      'leave',
      [
        leave('ESCALATE_TO_HR', 'ESCALATE_TO_HR'),
        mk('error', { verdict: ['ESCALATE_TO_HR', null] }),
      ],
      {},
    );
    expect(e?.recall.value).toBe(1);
  });
});
