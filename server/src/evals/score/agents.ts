// Per-agent scorers (spec eval-runner, rule 18; D-11, D-12, D-13). Pure: each key present in
// `expected` becomes one or more checks against observed facts. Verdicts are only ever read from
// gate output that observe.ts collected; model text is never a verdict (rule 16).
import type { LeaveEvalCase } from '../../agents/leave/schemas.js';
import type { OrchestratorEvalCase } from '../../agents/orchestrator/schemas.js';
import type { QaEvalCase } from '../../agents/policy_qa/schemas.js';
import type { Check } from '../schemas.js';
import { check, equal, own, sameList, sorted, token, tokenRecord, tokens } from './checks.js';
import type { LeaveFacts, OnboardingFacts, OrchestratorFacts, QaFacts } from './facts.js';

export interface Scored {
  checks: Check[];
  /** Expected keys with no scorer (onboarding only): the case is unscorable. */
  unscorableKeys: string[];
}

export function scoreOrchestrator(
  expected: OrchestratorEvalCase['expected'],
  facts: OrchestratorFacts,
): Scored {
  return {
    checks: [
      equal('label', expected.label, facts.label),
      equal('injectionFlagged', expected.injectionFlagged, facts.injectionFlagged),
    ],
    unscorableKeys: [],
  };
}

/** D-11: exactly one submission; type and dates equal; no half day; reason presence only. */
function extractedChecks(
  expected: NonNullable<LeaveEvalCase['expected']['extracted']>,
  submissions: readonly LeaveFacts['submissions'][number][],
): Check[] {
  const only = submissions.length === 1 ? submissions[0] : undefined;
  if (only === undefined) {
    return [check('extracted.submissions', false, 1, submissions.length)];
  }
  const checks = [
    equal('extracted.leaveType', expected.leaveType, only.leaveType),
    equal('extracted.startDate', expected.startDate, only.startDate),
    equal('extracted.endDate', expected.endDate, only.endDate),
    check('extracted.halfDay', !only.halfDay, false, only.halfDay),
  ];
  if (expected.reason !== undefined) {
    // Presence only, on both sides: the reason text is never stored (D-11).
    checks.push(check('extracted.reason', only.reasonPresent, true, only.reasonPresent));
  }
  return checks;
}

export function scoreLeave(expected: LeaveEvalCase['expected'], facts: LeaveFacts): Scored {
  const checks: Check[] = [];
  if (expected.resultKind !== undefined) {
    checks.push(equal('resultKind', expected.resultKind, facts.resultKind));
  }
  if (expected.maxSubmissions !== undefined) {
    checks.push(
      check(
        'maxSubmissions',
        facts.gateResults <= expected.maxSubmissions,
        expected.maxSubmissions,
        facts.gateResults,
      ),
    );
  }
  if (expected.extracted !== undefined) {
    checks.push(...extractedChecks(expected.extracted, facts.submissions));
  }
  if (expected.verdict !== undefined) {
    checks.push(equal('verdict', expected.verdict, facts.verdict));
  }
  if (expected.injectionFlagged !== undefined) {
    checks.push(equal('injectionFlagged', expected.injectionFlagged, facts.injectionSuspected));
  }
  return { checks, unscorableKeys: [] };
}

export function scorePolicyQa(expected: QaEvalCase['expected'], facts: QaFacts): Scored {
  const checks: Check[] = [];
  if (expected.outcome !== undefined)
    checks.push(equal('outcome', expected.outcome, facts.outcome));
  if (expected.verdict !== undefined)
    checks.push(equal('verdict', expected.verdict, facts.verdict));
  if (expected.sectionIds !== undefined) {
    // D-12: "contains", in any order.
    const want = tokens(expected.sectionIds);
    checks.push(
      check(
        'sectionIds',
        want.every((id) => facts.sectionIds.includes(id)),
        want,
        facts.sectionIds,
      ),
    );
  }
  if (expected.topics !== undefined) {
    const want = sorted(tokens(expected.topics));
    const got = sorted(facts.topics);
    checks.push(check('topics', sameList(want, got), want, got));
  }
  if (expected.injectionFlagged !== undefined) {
    checks.push(equal('injectionFlagged', expected.injectionFlagged, facts.injectionFlagged));
  }
  return { checks, unscorableKeys: [] };
}

const ONBOARDING_KEYS = new Set([
  'outcome',
  'verdict',
  'createChecklist',
  'deviations',
  'deviationChanges',
  'items',
  'injectionFlagged',
  'label',
  'text',
  'agentRuns',
  'records',
  'compensationTool',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ kind, owner | templateTaskId }` as `kind:owner` or `kind:templateTaskId`. */
function changeKey(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const kind = token(v.kind);
  const target = token(v.owner) ?? token(v.templateTaskId);
  return kind === null || target === null ? null : `${kind}:${target}`;
}

function itemKey(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const kind = token(v.kind);
  const assignee = token(v.assigneeId);
  return kind === null || assignee === null ? null : `${kind}:${assignee}`;
}

function listCheck(
  field: string,
  expected: unknown,
  actual: string[],
  toKey: (v: unknown) => string | null,
  ordered: boolean,
): Check {
  // A number is a count (e.g. "items": 2).
  if (typeof expected === 'number') {
    return check(field, actual.length === expected, expected, actual.length);
  }
  const keys = Array.isArray(expected) ? expected.map(toKey) : [null];
  if (keys.some((k) => k === null)) return check(field, false, null, actual);
  const want = keys as string[];
  const [a, b] = ordered ? [want, actual] : [sorted(want), sorted(actual)];
  return check(field, sameList(a, b), want, actual);
}

function createChecklistCheck(expected: unknown, actual: OnboardingFacts['createChecklist']) {
  const want = tokenRecord(expected);
  if (want === null) return check('createChecklist', false, null, actual);
  const got = actual ?? {};
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  const passed = actual !== null && [...keys].every((k) => own(want, k) === own(got, k));
  return check('createChecklist', passed, want, actual);
}

/** D-13: only the keys above have scorers; any other key makes the case unscorable. */
export function scoreOnboarding(
  expectedKeys: readonly string[],
  expected: Record<string, unknown>,
  facts: OnboardingFacts,
): Scored {
  const unscorableKeys = expectedKeys
    .filter((k) => !ONBOARDING_KEYS.has(k))
    .map((k) => token(k) ?? 'invalid_key');
  const checks: Check[] = [];
  const has = (k: string): boolean => expectedKeys.includes(k) && Object.hasOwn(expected, k);
  if (has('outcome')) checks.push(equal('outcome', expected.outcome, facts.outcome));
  if (has('verdict')) checks.push(equal('verdict', expected.verdict, facts.verdict));
  if (has('createChecklist')) {
    checks.push(createChecklistCheck(expected.createChecklist, facts.createChecklist));
  }
  if (has('deviations')) checks.push(equal('deviations', expected.deviations, facts.deviations));
  if (has('deviationChanges')) {
    checks.push(
      listCheck(
        'deviationChanges',
        expected.deviationChanges,
        facts.deviationChanges,
        changeKey,
        true,
      ),
    );
  }
  if (has('items')) checks.push(listCheck('items', expected.items, facts.items, itemKey, false));
  if (has('injectionFlagged')) {
    checks.push(equal('injectionFlagged', expected.injectionFlagged, facts.injectionFlagged));
  }
  if (has('label')) checks.push(equal('label', expected.label, facts.label));
  if (has('text')) checks.push(equal('text', expected.text, facts.text));
  if (has('agentRuns')) checks.push(equal('agentRuns', expected.agentRuns, facts.agentRuns));
  if (has('records')) checks.push(equal('records', expected.records, facts.records));
  if (has('compensationTool')) {
    checks.push(equal('compensationTool', expected.compensationTool, facts.compensationTool));
  }
  return { checks, unscorableKeys };
}
