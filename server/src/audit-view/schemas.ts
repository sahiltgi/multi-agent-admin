// Response schemas of the audit view routes (spec audit-view, "Inputs and outputs"). Re-exported
// by @hr/shared, so this module imports only zod and zod-only modules (rule 26). Nothing here is
// a payload schema: each route projects stored data into these allowlisted shapes.
import { z } from 'zod';
import {
  ApprovalStatus,
  AuditEvent,
  Id,
  IsoDateTime,
  LeaveVerdict,
  OnboardingVerdict,
  Role,
} from '../domain/schemas.js';
import { QaVerdict } from '../domain/qa.js';
import { TokenCount, Usage } from '../lib/cost.js';

export const INPUT_PREVIEW_CHARS = 200;
export const EXCERPT_CHARS = 200; // the writers' own bound (runtime.ts, policy_qa/run.ts)
export const AI_LOG_ROWS = 10; // OQ-8
export const RESULT_FILE_RE =
  /^\d{4}-\d{2}-\d{2}-(orchestrator|leave|policy_qa|onboarding)-[A-Za-z0-9._-]{1,64}\.json$/;

/** A code-written token: payload kind, agent id, model id, prompt version, tool name, outcome. */
export const SafeToken = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

// ---- GET /audit/:requestId/timeline ----
export const TimelineStage = z.enum(['orchestrator', 'agent', 'tool', 'gate', 'human', 'system']);
export type TimelineStage = z.infer<typeof TimelineStage>;

const ShownRule = z
  .object({ ruleId: z.string(), passed: z.boolean(), message: z.string() })
  .strict();
export const GateView = z.discriminatedUnion('family', [
  z
    .object({
      family: z.literal('leave'),
      verdict: LeaveVerdict,
      policyVersion: z.string().min(1),
      ruleResults: z.array(ShownRule),
    })
    .strict(),
  z
    .object({
      family: z.literal('qa'),
      verdict: QaVerdict,
      policyVersion: z.string().min(1),
      ruleResults: z.array(ShownRule),
    })
    .strict(),
  z
    .object({
      family: z.literal('onboarding'),
      verdict: OnboardingVerdict,
      policyVersion: z.string().min(1),
      ruleResults: z.array(ShownRule),
    })
    .strict(),
]);
export type GateView = z.infer<typeof GateView>;

export const InjectionView = z
  .object({
    flagged: z.boolean(), // eventType === 'injection_flagged'
    suspected: z.boolean(), // payload.injectionSuspected === true
    source: z.enum(['user', 'document', 'tool']).nullable(),
    excerpt: z.string().max(EXCERPT_CHARS).nullable(), // re-redacted (rule 7)
  })
  .strict();
export type InjectionView = z.infer<typeof InjectionView>;

export const InputPreview = z
  .object({ text: z.string().max(INPUT_PREVIEW_CHARS), truncated: z.boolean() })
  .strict();
export type InputPreview = z.infer<typeof InputPreview>;

export const HumanView = z
  .object({
    action: z.enum(['approve', 'reject', 'comment', 'resolve']),
    actorRole: Role,
    statusBefore: ApprovalStatus,
    statusAfter: ApprovalStatus,
  })
  .strict();
export type HumanView = z.infer<typeof HumanView>;

export const TimelineStep = z
  .object({
    eventId: Id,
    at: IsoDateTime, // exactly as stored
    eventType: AuditEvent.shape.eventType,
    actor: AuditEvent.shape.actor,
    stage: TimelineStage, // rule 3
    kind: SafeToken.nullable(), // payload.kind
    agent: SafeToken.nullable(),
    model: SafeToken.nullable(),
    promptVersion: SafeToken.nullable(),
    tool: SafeToken.nullable(),
    outcome: SafeToken.nullable(),
    isError: z.boolean().nullable(),
    tokens: TokenCount.nullable(), // rule 4: input/output only
    latencyMs: z.number().int().nonnegative().nullable(), // rule 4: measured kinds only
    input: InputPreview.nullable(), // rule 6
    injection: InjectionView,
    gate: GateView.nullable(), // rule 8: gate_result events only
    human: HumanView.nullable(), // rule 9: human_action events only
  })
  .strict();
export type TimelineStep = z.infer<typeof TimelineStep>;

export const RequestTotal = z.discriminatedUnion('status', [
  z.object({ status: z.literal('hidden') }).strict(), // reader isn't hr_admin
  z.object({ status: z.literal('none') }).strict(), // no summary event, or a legacy one without `usage`
  z.object({ status: z.literal('unpriced') }).strict(), // summary usage: null
  z.object({ status: z.literal('priced'), usage: Usage }).strict(),
]);
export type RequestTotal = z.infer<typeof RequestTotal>;

export const TraceTimelineResponse = z
  .object({
    requestId: Id,
    steps: z.array(TimelineStep), // same events, same order as GET /audit/:requestId for this reader
    injectionCount: z.number().int().nonnegative(), // steps with injection.flagged
    requestTotal: RequestTotal,
  })
  .strict();
export type TraceTimelineResponse = z.infer<typeof TraceTimelineResponse>;

// ---- GET /evals/history ----
export const EvalAgentName = z.enum(['orchestrator', 'leave', 'policy_qa', 'onboarding']); // a test asserts it equals EvalAgent.options
export type EvalAgentName = z.infer<typeof EvalAgentName>;
const Rate = z.number().min(0).max(1);
export const EvalPoint = z
  .object({
    file: z.string().regex(RESULT_FILE_RE), // rule 11
    startedAt: IsoDateTime,
    model: SafeToken,
    policyVersion: z.string().max(64).nullable(),
    passRate: Rate.nullable(), // summary.overall.passRate, copied
    passed: z.number().int().nonnegative(), // summary.overall.passed
    scored: z.number().int().nonnegative(), // passed + failed + errored + unscorable (eval-runner rule 21 "Scored")
    threshold: Rate.nullable(), // summary.overall.threshold
    thresholdsMet: z.boolean(), // EvalRun.thresholdsMet, copied
  })
  .strict();
export type EvalPoint = z.infer<typeof EvalPoint>;
export const EvalSeries = z
  .object({ agent: EvalAgentName, promptVersion: SafeToken, points: z.array(EvalPoint).min(1) })
  .strict();
export type EvalSeries = z.infer<typeof EvalSeries>;
export const EvalHistoryResponse = z
  .object({ series: z.array(EvalSeries), skippedFiles: z.number().int().nonnegative() })
  .strict();
export type EvalHistoryResponse = z.infer<typeof EvalHistoryResponse>;

// ---- GET /build-notes ----
export const INLINE_CHARS = 2000;
export const MAX_DOC_BLOCKS = 500;
export const Inline = z
  .object({ kind: z.enum(['text', 'code']), text: z.string().max(INLINE_CHARS) })
  .strict();
export type Inline = z.infer<typeof Inline>;
export const DocBlock = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('heading'),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      inlines: z.array(Inline),
    })
    .strict(),
  z.object({ kind: z.literal('paragraph'), inlines: z.array(Inline) }).strict(),
  z.object({ kind: z.literal('list'), items: z.array(z.array(Inline)) }).strict(),
  z
    .object({
      kind: z.literal('table'),
      header: z.array(z.array(Inline)),
      rows: z.array(z.array(z.array(Inline))),
    })
    .strict(),
]);
export type DocBlock = z.infer<typeof DocBlock>;
export const DocState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), blocks: z.array(DocBlock).max(MAX_DOC_BLOCKS) }).strict(),
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('unreadable') }).strict(),
]);
export type DocState = z.infer<typeof DocState>;
export const AiLogState = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      header: z.array(z.array(Inline)),
      rows: z.array(z.array(z.array(Inline))).max(AI_LOG_ROWS),
      totalRows: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('unreadable') }).strict(),
  z.object({ status: z.literal('no_table') }).strict(),
]);
export type AiLogState = z.infer<typeof AiLogState>;
export const BuildNotesResponse = z.object({ devMetrics: DocState, aiLog: AiLogState }).strict();
export type BuildNotesResponse = z.infer<typeof BuildNotesResponse>;
