// Request and response schemas for the approval queue API (spec approval-queue, "Inputs and
// outputs"). Domain schemas are reused, not redefined.
import { z } from 'zod';
import { PolicyQuestion, QaGateResult } from '../../domain/qa.js';
import {
  ApprovalDecision,
  ApprovalItem,
  ApprovalKind,
  ApprovalStatus,
  AuditEvent,
  Id,
  LeaveGateResult,
  LeaveRequest,
  Role,
} from '../../domain/schemas.js';

export { Actor } from '../identity.js';

const empty = z.object({}).strict();
export const EmptyParams = empty;
export const EmptyQuery = empty;
export const EmptyBody = empty;

const leave = LeaveRequest.shape;

// No `reason`: the leave reason is not shown in queue views (OQ-9).
export const LeaveSubjectView = z
  .object({
    requestId: Id,
    employeeId: Id,
    leaveType: leave.leaveType,
    startDate: leave.startDate,
    endDate: leave.endDate,
    startHalf: leave.startHalf,
    endHalf: leave.endHalf,
    status: leave.status,
  })
  .strict();
export type LeaveSubjectView = z.infer<typeof LeaveSubjectView>;

/** An escalated policy question, shown to hr_admin only (spec policy-qa, rule 23; DD-20). */
export const PolicyQuestionView = z
  .object({
    questionId: Id,
    employeeId: Id, // the asker; no displayName or email
    question: z.string(), // raw, as stored: HR needs it to reply
    draftAnswer: z.string().nullable(),
    escalation: PolicyQuestion.shape.escalation,
    gateResult: QaGateResult.nullable(),
    policyVersion: z.string(),
    policyHash: z.string(),
    handbookHash: z.string(),
    createdAt: PolicyQuestion.shape.createdAt,
  })
  .strict();
export type PolicyQuestionView = z.infer<typeof PolicyQuestionView>;

export const ApprovalItemView = z
  .object({
    item: ApprovalItem,
    subject: LeaveSubjectView.nullable(), // null when the subject can't be resolved (rule 5)
    gateResult: LeaveGateResult.nullable(), // the subject's stored gateResult, copied unchanged
    question: PolicyQuestionView.nullable(), // null unless kind 'escalation'
    canAct: z.boolean(),
  })
  .strict();
export type ApprovalItemView = z.infer<typeof ApprovalItemView>;

// GET /approvals
export const ListApprovalsQuery = z.object({ status: ApprovalStatus.optional() }).strict();
export const ListApprovalsResponse = z.object({ items: z.array(ApprovalItemView) }).strict();
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponse>;

// GET /approvals/:itemId
export const ItemParams = z.object({ itemId: Id }).strict();
export const GetApprovalResponse = ApprovalItemView;

// POST /approvals/:itemId/actions
export const MAX_COMMENT_CHARS = 1000; // OQ-9
export const ActionBody = z.discriminatedUnion('action', [
  z
    .object({
      action: z.enum(['approve', 'reject', 'comment']),
      comment: z.string().trim().max(MAX_COMMENT_CHARS).optional(),
      seen: z
        .object({ verdict: LeaveGateResult.shape.verdict, policyHash: z.string().min(1) })
        .strict(),
    })
    .strict(),
  // Closes an escalation item; no gate result to have seen (spec policy-qa, rule 28).
  z
    .object({
      action: z.literal('resolve'),
      comment: z.string().trim().max(MAX_COMMENT_CHARS).optional(),
    })
    .strict(),
]);
export type ActionBody = z.infer<typeof ActionBody>;
export const ActionResponse = z.object({ item: ApprovalItem, auditEventId: Id }).strict();
export type ActionResponse = z.infer<typeof ActionResponse>;

// GET /audit/:requestId
export const TraceParams = z.object({ requestId: Id }).strict();
export const TraceResponse = z.object({ requestId: Id, events: z.array(AuditEvent) }).strict();
export type TraceResponse = z.infer<typeof TraceResponse>;

// Payload of the human_action audit event (rule 12).
export const HumanActionPayload = z
  .object({
    itemId: Id,
    itemKind: ApprovalKind,
    action: ApprovalDecision.shape.action,
    actorRole: Role,
    comment: z.string().nullable(), // redactText()ed; null when absent
    statusBefore: ApprovalStatus,
    statusAfter: ApprovalStatus,
    // not redacted: redaction can mask digits in policyHash. null for resolve (spec policy-qa).
    gateResultSeen: LeaveGateResult.nullable(),
  })
  .strict()
  .refine((p) => (p.gateResultSeen === null) === (p.action === 'resolve'), {
    path: ['gateResultSeen'],
    error: 'gateResultSeen is null exactly for a resolve action',
  });
export type HumanActionPayload = z.infer<typeof HumanActionPayload>;
