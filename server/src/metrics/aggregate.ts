// Pure aggregation of request-summary audit events (spec agent-metrics, rules 16–23). Verdicts are
// counted as code copied them from the gates' output; nothing here evaluates or decides one.
import { z } from 'zod';
import { RouteLabel } from '../agents/orchestrator/schemas.js';
import { ChatEscalationCode, ChatStatus } from '../chat/schemas.js';
import { QaVerdict } from '../domain/qa.js';
import { Id, LeaveVerdict, OnboardingVerdict, type AuditEvent } from '../domain/schemas.js';
import { DispatchEscalation, INTAKE_OUTCOMES } from '../intake/schemas.js';
import { Usage } from '../lib/cost.js';
import { AgentMetricsResponse, type RouteBucket } from './schemas.js';

// ---- narrow views (rule 16): only the fields used here; an absent optional field is null ----
const shared = {
  requestId: Id,
  verdict: LeaveVerdict.nullish(),
  qaVerdict: QaVerdict.nullish(),
  onboardingVerdict: OnboardingVerdict.nullish(),
  usage: Usage.nullish(),
};
const SummaryView = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('intake_outcome'),
    ...shared,
    label: RouteLabel.nullable(),
    outcome: z.enum(INTAKE_OUTCOMES),
    escalation: z.string().min(1).nullish(), // as IntakePayload: tryAudit adds agent_error, store_error
    internalError: z.literal(true).optional(),
  }),
  z.looseObject({
    kind: z.literal('chat_turn'),
    ...shared,
    mode: z.enum(['classify', 'continue']),
    label: RouteLabel.nullable(),
    outcome: z.enum([...ChatStatus.options, 'conflict', 'internal_error']),
    escalation: z.union([ChatEscalationCode, DispatchEscalation]).nullish(), // as ChatTurnPayload
  }),
  z.looseObject({
    kind: z.literal('onboarding_created'),
    requestId: Id,
    verdict: OnboardingVerdict,
    usage: Usage.nullish(),
  }),
  z.looseObject({
    kind: z.literal('onboarding_create_escalated'),
    requestId: Id,
    usage: Usage.nullish(),
  }),
]);
type SummaryView = z.infer<typeof SummaryView>;

/** The codes only intake tryAudit writes: a 500, not an escalation (rule 21, D-5). */
const INTAKE_500_CODES: ReadonlySet<string> = new Set(['agent_error', 'store_error']);

interface Summary {
  id: string;
  at: string;
  view: SummaryView;
}

/** Rule 17: one summary per requestId, the earliest `at`, then the lowest event id. */
function onePerRequest(events: readonly AuditEvent[]): SummaryView[] {
  const kept = new Map<string, Summary>();
  for (const e of events) {
    const view = SummaryView.parse(e.payload); // a malformed event throws (rule 16)
    const next: Summary = { id: e.id, at: e.at, view };
    const prev = kept.get(view.requestId);
    const earlier =
      prev === undefined ||
      Date.parse(next.at) < Date.parse(prev.at) ||
      (Date.parse(next.at) === Date.parse(prev.at) && next.id < prev.id);
    if (earlier) kept.set(view.requestId, next);
  }
  return [...kept.values()].map((s) => s.view);
}

/** Rule 18: a conversation_full turn ran no agent and counts nowhere. */
function counted(v: SummaryView): boolean {
  return !(
    v.kind === 'chat_turn' &&
    v.outcome === 'conflict' &&
    v.escalation === 'conversation_full'
  );
}

/** Rule 19. */
function routeOf(v: SummaryView): RouteBucket {
  if (v.kind === 'onboarding_created' || v.kind === 'onboarding_create_escalated') {
    return 'onboarding';
  }
  if (v.label !== null) return v.label;
  if (v.kind === 'chat_turn' && v.mode === 'continue') return 'leave';
  return 'none';
}

/** Rule 21: each request counts at most once. */
function escalated(v: SummaryView): boolean {
  switch (v.kind) {
    case 'onboarding_create_escalated':
      return true;
    case 'onboarding_created':
      return false;
    case 'intake_outcome': {
      const is500 =
        v.internalError === true ||
        (typeof v.escalation === 'string' && INTAKE_500_CODES.has(v.escalation));
      const byOutcome = (v.outcome === 'escalated' || v.outcome === 'policy_escalated') && !is500;
      return byOutcome || v.verdict === 'ESCALATE_TO_HR';
    }
    case 'chat_turn':
      return (
        v.outcome === 'escalated' ||
        v.outcome === 'escalated_to_hr' ||
        v.verdict === 'ESCALATE_TO_HR'
      );
  }
}

export function aggregate(
  events: readonly AuditEvent[],
  window: { from: string; to: string },
): AgentMetricsResponse {
  const byRoute: Record<RouteBucket, number> = {
    leave: 0,
    policy_qa: 0,
    onboarding: 0,
    prohibited: 0,
    out_of_scope: 0,
    unclear: 0,
    none: 0,
  };
  const leave: Record<LeaveVerdict, number> = {
    ROUTE_TO_MANAGER: 0,
    ROUTE_TO_MANAGER_WITH_FLAGS: 0,
    ESCALATE_TO_HR: 0,
    RETURN_TO_EMPLOYEE: 0,
  };
  const qa: Record<QaVerdict, number> = { AUTO_ANSWER: 0, ESCALATE_TO_HR: 0 };
  const onboarding: Record<OnboardingVerdict, number> = { AUTO: 0, MANAGER: 0 };
  let requests = 0;
  let escalations = 0;
  let pricedRequests = 0;
  let totalUsd = 0;
  const tokens = { input: 0, output: 0 };

  for (const v of onePerRequest(events).filter(counted)) {
    requests += 1;
    byRoute[routeOf(v)] += 1;
    if (escalated(v)) escalations += 1;

    // Rule 20: three separate distributions, never summed together.
    if (v.kind === 'onboarding_created') {
      onboarding[v.verdict] += 1;
    } else if (v.kind !== 'onboarding_create_escalated') {
      if (v.verdict !== null && v.verdict !== undefined) leave[v.verdict] += 1;
      if (v.qaVerdict !== null && v.qaVerdict !== undefined) qa[v.qaVerdict] += 1;
      if (v.onboardingVerdict !== null && v.onboardingVerdict !== undefined) {
        onboarding[v.onboardingVerdict] += 1;
      }
    }

    // Rule 22: null (failed read-back) and absent (legacy) usage are unpriced.
    if (v.usage !== null && v.usage !== undefined) {
      pricedRequests += 1;
      totalUsd += v.usage.costUsd;
      tokens.input += v.usage.tokens.input;
      tokens.output += v.usage.tokens.output;
    }
  }

  return AgentMetricsResponse.parse({
    from: window.from,
    to: window.to,
    requests,
    byRoute,
    verdicts: { leave, qa, onboarding },
    escalation: { count: escalations, rate: requests === 0 ? null : escalations / requests },
    cost: {
      pricedRequests,
      totalUsd,
      averageUsd: pricedRequests === 0 ? null : totalUsd / pricedRequests,
      tokens,
    },
  });
}
