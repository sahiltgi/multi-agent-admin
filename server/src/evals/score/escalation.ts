// Escalation precision and recall (spec eval-runner, rule 23; D-19). Pure: reads the `verdict`
// check that rule 18 already built from the gate's own result, so no model text is involved.
import type {
  CaseResult,
  EscalationSummary,
  EscalationThresholds,
  EvalAgent,
  RateMetric,
} from '../schemas.js';

/** The gate verdict counted as an escalation. The orchestrator has no gate. */
const POSITIVE: Partial<Record<EvalAgent, EscalationSummary['positive']>> = {
  leave: 'ESCALATE_TO_HR',
  policy_qa: 'ESCALATE_TO_HR',
  onboarding: 'MANAGER',
};

function metric(num: number, den: number, threshold: number | undefined): RateMetric {
  const value = den === 0 ? null : num / den;
  return {
    value,
    threshold: threshold ?? null,
    // >= meets; a threshold on a null value fails closed (rule 21).
    meetsThreshold: threshold === undefined ? null : value !== null && value >= threshold,
  };
}

/** Null for an agent without a gate. Counts reviewed cases that ran and carry a verdict check. */
export function escalationSummary(
  agent: EvalAgent,
  cases: readonly CaseResult[],
  thresholds: EscalationThresholds | undefined,
): EscalationSummary | null {
  const positive = POSITIVE[agent];
  if (positive === undefined) return null;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const c of cases) {
    if (c.agent !== agent || c.reviewed === false) continue;
    if (c.status === 'skipped' || c.status === 'error') continue;
    const check = c.checks.find((k) => k.field === 'verdict');
    if (check === undefined) continue;
    // A gate that never ran (actual null) is actual negative.
    const expected = check.expected === positive;
    const actual = check.actual === positive;
    if (expected && actual) tp += 1;
    else if (actual) fp += 1;
    else if (expected) fn += 1;
    else tn += 1;
  }
  return {
    positive,
    tp,
    fp,
    fn,
    tn,
    precision: metric(tp, tp + fp, thresholds?.precision),
    recall: metric(tp, tp + fn, thresholds?.recall),
  };
}
