// Request intake schemas (spec request-intake, rules 2–5, 15; Decisions D-4 to D-16).
// Every route body and response is .strict(). No arm carries a model summary, injectionSuspected,
// an approval or a decision field: verdicts are copied from the gate only (HARD RULE 1).
import { z } from 'zod';
import { MAX_USER_TEXT_CHARS } from '../agents/schemas.js';
import { EscalationReason } from '../agents/leave/schemas.js';
import { QaFailureReason } from '../agents/policy_qa/schemas.js';
import { QaVerdict, SectionId } from '../domain/qa.js';
import { ClarifyingQuestion, RouteLabel } from '../agents/orchestrator/schemas.js';
import {
  ApprovalStatus,
  Id,
  IsoDateTime,
  LeaveRequestStatus,
  LeaveType,
  LeaveVerdict,
  OnboardingVerdict,
  Role,
} from '../domain/schemas.js';
import { Usage } from '../lib/cost.js';

// ---- POST /messages body (rule 3, D-11) ----
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const MessageBody = z
  .object({
    text: z.string().trim().min(1).max(MAX_USER_TEXT_CHARS),
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional(),
  })
  .strict();
export type MessageBody = z.infer<typeof MessageBody>;

export const EmptyParams = z.object({}).strict();
export const EmptyBody = z.object({}).strict();

// ---- views (D-15, D-16) ----
export const FailedRule = z.object({ ruleId: Id, message: z.string().min(1) }).strict();
export type FailedRule = z.infer<typeof FailedRule>;

export const MyRequestDecision = z
  .object({
    action: z.enum(['approve', 'reject', 'comment']),
    comment: z.string().optional(),
    at: IsoDateTime,
  })
  .strict(); // never byEmployeeId: no other employee's id reaches the requester (rule 17)

export const MyRequestView = z
  .object({
    requestId: Id,
    leaveType: LeaveType,
    startDate: z.string(),
    endDate: z.string(),
    startHalf: z.literal('pm').optional(),
    endHalf: z.literal('am').optional(),
    status: LeaveRequestStatus,
    approvalStatus: ApprovalStatus.nullable(),
    decision: MyRequestDecision.nullable(),
    createdAt: IsoDateTime,
  })
  .strict();
export type MyRequestView = z.infer<typeof MyRequestView>;

export const MyRequestsResponse = z.object({ requests: z.array(MyRequestView) }).strict();
export type MyRequestsResponse = z.infer<typeof MyRequestsResponse>;

// ---- POST /messages response (rules 7, 8; D-5, D-6, D-7, D-15) ----
export const MessageResponse = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reply'),
      requestId: Id,
      // policy_qa now runs the Policy Q&A Agent (spec policy-qa, rule 19)
      label: z.enum(['prohibited', 'out_of_scope', 'onboarding', 'leave']),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('question'),
      requestId: Id,
      label: z.enum(['unclear', 'leave', 'onboarding']),
      text: ClarifyingQuestion, // the orchestrator's or an agent's validated question
    })
    .strict(),
  z
    .object({
      kind: z.literal('leave_submitted'),
      requestId: Id,
      request: MyRequestView,
      verdict: LeaveVerdict,
      failedRules: z.array(FailedRule),
    })
    .strict(),
  z
    .object({
      kind: z.literal('leave_returned'),
      requestId: Id,
      text: z.string().min(1),
      failedRules: z.array(FailedRule),
    })
    .strict(),
  z.object({ kind: z.literal('escalated'), requestId: Id, text: z.string().min(1) }).strict(),
  // spec policy-qa, rules 20, 21: a gate-approved answer, or the fixed "passed to HR" text
  z
    .object({
      kind: z.literal('policy_answer'),
      requestId: Id,
      text: z.string().min(1),
      sectionIds: z.array(SectionId).min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal('policy_escalated'), requestId: Id, text: z.string().min(1) })
    .strict(),
  // spec onboarding, rules 20, 21: a template checklist, plus any deviations pending a manager
  z
    .object({
      kind: z.literal('onboarding_checklist'),
      requestId: Id,
      checklistId: Id,
      text: z.string().min(1), // fixed text, never model text
      pendingDeviations: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type MessageResponse = z.infer<typeof MessageResponse>;

// ---- dispatcher escalation codes (chat-endpoint D-10): closed, so no free text reaches an audit ----
export const DispatchEscalation = z.enum([
  'invalid_agent_output',
  'request_id_mismatch',
  'text_missing',
  'card_mismatch',
  'card_invalid',
  'hand_back_fresh',
  'fixed_message_missing', // the OrchestratorFailure code that takes the escalation path
  ...EscalationReason.options,
  'qa_gate', // the Q&A gate escalated (spec policy-qa, rule 25)
  // Policy Q&A failures that escalate to HR (rule 19); model_unavailable is already listed
  ...QaFailureReason.exclude(['model_unavailable', 'audit_failed']).options,
  // Onboarding Agent escalations not already listed (spec onboarding, rules 13, 14)
  'multiple_checklists',
  'deviation_without_checklist',
  'invalid_deviation',
]);
export type DispatchEscalation = z.infer<typeof DispatchEscalation>;

// ---- intake audit payload (rule 15, D-4) ----
export const INTAKE_OUTCOMES = [
  'reply',
  'question',
  'leave_submitted',
  'leave_returned',
  'escalated',
  'policy_answer',
  'policy_escalated',
  'onboarding_checklist', // spec onboarding, rules 20, 21
] as const;

export const IntakePayload = z
  .object({
    kind: z.literal('intake_outcome'),
    requestId: Id,
    actorRole: Role,
    label: RouteLabel.nullable(),
    routingSource: z.enum(['model', 'fallback']).nullable(),
    outcome: z.enum(INTAKE_OUTCOMES),
    escalation: z.string().min(1).nullable(),
    leaveRequestId: Id.nullable(),
    approvalItemId: Id.nullable(),
    assigneeRole: z.enum(['manager', 'hr_admin']).nullable(),
    assigneeId: Id.nullable(),
    flagged: z.boolean().nullable(),
    verdict: LeaveVerdict.nullable(), // copied from the card; never from model text
    policyVersion: z.string().nullable(),
    policyHash: z.string().nullable(), // unredacted (leave-agent D-16)
    qaVerdict: QaVerdict.nullable(), // copied from the Q&A gate (spec policy-qa, rule 25)
    policyQuestionId: Id.nullable(),
    // spec onboarding (OQ-14): set only on an onboarding_checklist outcome
    onboardingVerdict: OnboardingVerdict.optional(), // copied from the onboarding gate
    checklistId: Id.optional(),
    pendingDeviations: z.number().int().nonnegative().optional(),
    injectionSuspected: z.boolean(),
    // spec agent-metrics, rule 5: the request's totals, set by code; absent only on older events
    usage: Usage.nullable().optional(),
    internalError: z.literal(true).optional(), // set only by tryAudit: a 500 (agent-metrics D-5)
  })
  .strict(); // no user text, reply text or reason
export type IntakePayload = z.infer<typeof IntakePayload>;
