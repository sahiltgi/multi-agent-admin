// Orchestrator schemas (spec orchestrator, "Inputs and outputs" + Decisions). Decisions win over
// the sketch: no clarifyingQuestion or confidence in route() input (D-2, D-3), the route handler
// echoes the label (D-9), and a missing fixed message fails closed (D-6).
import { z } from 'zod';
import { Id, Role } from '../../domain/schemas.js';
import { PromptVersion, RunInput } from '../schemas.js';

// ---- label (rule 1; case-sensitive, never coerced) ----
export const ROUTE_LABELS = [
  'leave',
  'policy_qa',
  'onboarding',
  'prohibited',
  'out_of_scope',
  'unclear',
] as const;
export const RouteLabel = z.enum(ROUTE_LABELS);
export type RouteLabel = z.infer<typeof RouteLabel>;

// ---- clarifying question: the fallback-question file only (D-13) ----
export const MAX_QUESTION_CHARS = 200;
const isExactlyOneQuestion = (s: string): boolean =>
  s.indexOf('?') === s.length - 1 && s.split('?').length === 2;
// The checks run on the trimmed text, but the value is kept as is so the decision stays
// byte-identical to the file (D-2).
export const ClarifyingQuestion = z.string().refine(
  (s) => {
    const t = s.trim();
    return t.length >= 1 && t.length <= MAX_QUESTION_CHARS && isExactlyOneQuestion(t);
  },
  { message: 'Must be one question of 1 to 200 characters ending in ?' },
);

// ---- route() tool input and output (rules 4, 5; D-2, D-3, D-9) ----
export const RouteInput = z.object({ label: RouteLabel }).strict();
export type RouteInput = z.infer<typeof RouteInput>;

export const RouteOutput = z.object({ accepted: z.literal(true), label: RouteLabel }).strict();
export type RouteOutput = z.infer<typeof RouteOutput>;

// ---- input to classifyMessage (D-14: documents go only to the chosen sub-agent) ----
export const OrchestratorInput = RunInput.refine((r) => r.agentId === 'orchestrator', {
  message: 'agentId must be orchestrator',
}).refine((r) => r.documents.length === 0, { message: 'The orchestrator takes no documents' });
export type OrchestratorInput = z.input<typeof OrchestratorInput>;

// ---- fixed texts (D-5) ----
export const FixedMessageKey = z.enum(['prohibited', 'out_of_scope', 'fallback_question']);
export type FixedMessageKey = z.infer<typeof FixedMessageKey>;

// ---- output: built by code from RunResult, never by the model (rules 6 to 13) ----
export const FallbackReason = z.enum([
  'run_not_completed',
  'no_route_call',
  'multiple_route_calls',
]);
export type FallbackReason = z.infer<typeof FallbackReason>;

const DecisionBase = {
  requestId: Id,
  model: z.string().min(1),
  promptVersion: PromptVersion,
  source: z.enum(['model', 'fallback']),
  fallbackReason: FallbackReason.nullable(),
};

// No arm has a verdict, approved or decision key, and every arm is strict (rule 13).
export const RoutingDecision = z
  .discriminatedUnion('label', [
    z
      .object({ ...DecisionBase, label: z.literal('leave'), targetAgent: z.literal('leave') })
      .strict(),
    z
      .object({
        ...DecisionBase,
        label: z.literal('policy_qa'),
        targetAgent: z.literal('policy_qa'),
      })
      .strict(),
    z
      .object({
        ...DecisionBase,
        label: z.literal('onboarding'),
        targetAgent: z.literal('onboarding'),
      })
      .strict(),
    z
      .object({ ...DecisionBase, label: z.literal('prohibited'), reply: z.string().min(1) })
      .strict(),
    z
      .object({ ...DecisionBase, label: z.literal('out_of_scope'), reply: z.string().min(1) })
      .strict(),
    z
      .object({
        ...DecisionBase,
        label: z.literal('unclear'),
        clarifyingQuestion: ClarifyingQuestion,
      })
      .strict(),
  ])
  .refine((d) => (d.source === 'fallback') === (d.fallbackReason !== null), {
    message: 'fallbackReason is set exactly when source is fallback',
  })
  .refine((d) => d.source === 'model' || d.label === 'unclear', {
    message: 'A fallback is always unclear',
  });
export type RoutingDecision = z.infer<typeof RoutingDecision>;

// Fail-closed results (D-6): a needed fixed-message file is missing, empty or unreadable, or the
// audit sink failed, in which case nothing further is written.
const FailureBase = {
  requestId: Id,
  outcome: z.literal('error'),
  escalate: z.literal(true),
};
export const OrchestratorFailure = z.discriminatedUnion('code', [
  z
    .object({ ...FailureBase, code: z.literal('fixed_message_missing'), key: FixedMessageKey })
    .strict(),
  z.object({ ...FailureBase, code: z.literal('audit_failed') }).strict(),
]);
export type OrchestratorFailure = z.infer<typeof OrchestratorFailure>;

// ---- eval case line: evals/orchestrator/cases.jsonl (rule 19) ----
export const OrchestratorEvalCase = z
  .object({
    id: z.string().regex(/^orch-\d{3}$/),
    category: z.enum(['routing', 'injection']),
    actor: z.object({ employeeId: Id, role: Role }).strict(),
    userText: z.string().trim().min(1),
    expected: z.object({ label: RouteLabel, injectionFlagged: z.boolean() }).strict(),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
    notes: z.string().optional(),
  })
  .strict();
export type OrchestratorEvalCase = z.infer<typeof OrchestratorEvalCase>;
