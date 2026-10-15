// Leave Agent schemas (spec leave-agent, "Inputs and outputs" + Decisions). Decisions win over the
// sketch: the extraction is the gate request without employeeId (D-5), rule results use the gate's
// shape (D-14), and summaries and questions are checked before any model text is used (D-7, D-11).
// No .default, coercion or transformation anywhere: a missing field stays missing (rule 6).
import { z } from 'zod';
import {
  Holiday,
  Id,
  IsoDate,
  LeaveBalance,
  LeaveType,
  LeaveVerdict,
  Role,
} from '../../domain/schemas.js';
import {
  LeaveGateRequest,
  LeaveGateResult,
  LeaveRuleResult,
  TeamDayCount,
} from '../../gate/leave.js';
import { ClarifyingQuestion } from '../orchestrator/schemas.js';
import { PromptVersion, RunInput } from '../schemas.js';

// ---- allowlist (rule 1): no approve, reject or other-employee tool exists or may be added ----
export const LEAVE_TOOLS = [
  'get_my_balance',
  'get_holidays',
  'get_team_calendar',
  'submit_to_gate',
] as const;
export type LeaveToolName = (typeof LEAVE_TOOLS)[number];

// ---- date range (rule 4; D-10: inclusive ends, at most 366 days) ----
export const MAX_RANGE_DAYS = 366;
const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000; // explicit arguments, never the clock
};
export const DateRange = z
  .object({ from: IsoDate, to: IsoDate })
  .strict()
  .refine((r) => r.from <= r.to, { path: ['to'], error: 'to must not be before from' })
  .refine((r) => dayNumber(r.to) - dayNumber(r.from) + 1 <= MAX_RANGE_DAYS, {
    path: ['to'],
    error: `a range covers at most ${String(MAX_RANGE_DAYS)} days`,
  });
export type DateRange = z.infer<typeof DateRange>;

// ---- get_my_balance (rule 3): no employeeId key; identity comes from ctx.actor ----
export const GetMyBalanceInput = z.object({ leaveType: LeaveType.optional() }).strict();
export const GetMyBalanceOutput = z.object({ balances: z.array(LeaveBalance) }).strict();

// ---- get_holidays (rule 4) ----
export const GetHolidaysInput = DateRange;
export const GetHolidaysOutput = z.object({ holidays: z.array(Holiday) }).strict();

// ---- get_team_calendar (rule 5): dates and counts only; extra keys are rejected (D-9) ----
export const GetTeamCalendarInput = DateRange;
export const GetTeamCalendarOutput = z.object({ days: z.array(TeamDayCount) }).strict();

// ---- submit_to_gate (rules 6, 8; D-5) ----
export const LeaveExtraction = LeaveGateRequest.omit({ employeeId: true }).strict();
export type LeaveExtraction = z.infer<typeof LeaveExtraction>;
export const SubmitToGateInput = LeaveExtraction;
export const SubmitToGateOutput = z
  .object({ request: LeaveGateRequest, today: IsoDate, gate: LeaveGateResult })
  .strict();
export type SubmitToGateOutput = z.infer<typeof SubmitToGateOutput>;

// ---- model text checks (rule 11; D-7, D-11) ----
export const MAX_SUMMARY_CHARS = 200;
const DECISION_LANGUAGE =
  /approv|reject|denied|granted|accepted|verdict|ROUTE_TO|ESCALATE_TO|RETURN_TO/i;

/** Exactly one '.', '!' or '?', and it is the last character of the trimmed text. */
export function isOneSentence(text: string): boolean {
  const t = text.trim();
  return (t.match(/[.!?]/g) ?? []).length === 1 && /[.!?]$/.test(t);
}

export function hasNoDecisionLanguage(text: string): boolean {
  return !DECISION_LANGUAGE.test(text);
}

/** Applied to model text only; the code-built fallback is trusted (rule 11). */
export const ModelSummary = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SUMMARY_CHARS)
  .refine(isOneSentence, { error: 'must be one sentence' })
  .refine(hasNoDecisionLanguage, { error: 'must not state a decision' });

// ---- recommendation card: built by code, never by the model (rule 10) ----
export const SummarySource = z.enum(['model', 'fallback']);
export const RecommendationCard = z
  .object({
    requestId: Id,
    employeeId: Id,
    request: LeaveGateRequest,
    today: IsoDate,
    verdict: LeaveVerdict,
    ruleResults: z.array(LeaveRuleResult),
    reason: z.string().min(1),
    policyVersion: z.string().min(1),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().trim().min(1),
    summarySource: SummarySource,
    model: z.string().min(1),
    promptVersion: PromptVersion,
  })
  .strict(); // no approved, decision or approvedBy key exists
export type RecommendationCard = z.infer<typeof RecommendationCard>;

// ---- agent result (rules 7, 10, 11, 12): no verdict outside the card ----
export const EscalationReason = z.enum([
  'run_not_completed',
  'multiple_submissions',
  'fallback_text_missing',
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const LeaveAgentResult = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('card'), card: RecommendationCard, injectionSuspected: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal('needs_details'),
      requestId: Id,
      question: ClarifyingQuestion,
      questionSource: SummarySource,
      injectionSuspected: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('escalated'),
      requestId: Id,
      reason: EscalationReason,
      injectionSuspected: z.boolean(),
    })
    .strict(),
]);
export type LeaveAgentResult = z.infer<typeof LeaveAgentResult>;

// ---- leave audit payloads (rule 14; D-1, D-16): no employee free text ----
export const LeaveAuditPayload = z
  .object({
    requestId: Id,
    agent: z.literal('leave'),
    kind: z.enum(['gate_result', 'leave_outcome']),
    outcome: z.enum(['card', 'needs_details', 'escalated']).nullable(),
    gate: LeaveGateResult.nullable(), // stored unredacted (D-16)
    summarySource: SummarySource.nullable(),
    injectionSuspected: z.boolean(),
    model: z.string(),
    promptVersion: PromptVersion,
  })
  .strict();
export type LeaveAuditPayload = z.infer<typeof LeaveAuditPayload>;

// ---- run input ----
export const LeaveInput = RunInput.refine((r) => r.agentId === 'leave', {
  path: ['agentId'],
  error: 'agentId must be leave',
});
export type LeaveInput = z.input<typeof LeaveInput>;

// ---- eval case line: evals/leave/cases.jsonl (D-4) ----
export const LeaveEvalCase = z
  .object({
    id: z.string().regex(/^EV-\d+$/),
    category: z.enum(['routing', 'extraction', 'verdict', 'citation', 'injection']),
    actor: z.object({ employeeId: Id, role: Role }).strict(),
    userText: z.string().trim().min(1),
    expected: z
      .object({
        resultKind: z.enum(['card', 'needs_details', 'escalated']).optional(),
        maxSubmissions: z.number().int().nonnegative().optional(),
        verdict: LeaveVerdict.optional(),
        injectionFlagged: z.boolean().optional(),
      })
      .strict(),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
    notes: z.string().optional(),
  })
  .strict();
export type LeaveEvalCase = z.infer<typeof LeaveEvalCase>;
