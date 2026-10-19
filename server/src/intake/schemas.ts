// Request intake schemas (spec request-intake, rules 2–5, 15; Decisions D-4 to D-16).
// Every route body and response is .strict(). No arm carries a model summary, injectionSuspected,
// an approval or a decision field: verdicts are copied from the gate only (HARD RULE 1).
import { z } from 'zod';
import { MAX_USER_TEXT_CHARS } from '../agents/schemas.js';
import { EscalationReason } from '../agents/leave/schemas.js';
import { ClarifyingQuestion, RouteLabel } from '../agents/orchestrator/schemas.js';
import {
  ApprovalStatus,
  Id,
  IsoDateTime,
  LeaveRequestStatus,
  LeaveType,
  LeaveVerdict,
  Role,
} from '../domain/schemas.js';

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
      label: z.enum(['prohibited', 'out_of_scope', 'policy_qa', 'onboarding', 'leave']),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('question'),
      requestId: Id,
      label: z.enum(['unclear', 'leave']),
      text: ClarifyingQuestion, // the orchestrator's or the Leave Agent's validated question
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
]);
export type DispatchEscalation = z.infer<typeof DispatchEscalation>;

// ---- intake audit payload (rule 15, D-4) ----
export const INTAKE_OUTCOMES = [
  'reply',
  'question',
  'leave_submitted',
  'leave_returned',
  'escalated',
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
    injectionSuspected: z.boolean(),
  })
  .strict(); // no user text, reply text or reason
export type IntakePayload = z.infer<typeof IntakePayload>;
