// Request and response schemas for the approval queue API (spec approval-queue, "Inputs and
// outputs"). Domain schemas are reused, not redefined.
import { z } from 'zod';
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

export const ApprovalItemView = z
  .object({
    item: ApprovalItem,
    subject: LeaveSubjectView.nullable(), // null when the subject can't be resolved (rule 5)
    gateResult: LeaveGateResult.nullable(), // the subject's stored gateResult, copied unchanged
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
export const ActionBody = z
  .object({
    action: ApprovalDecision.shape.action,
    comment: z.string().trim().max(MAX_COMMENT_CHARS).optional(),
    seen: z
      .object({ verdict: LeaveGateResult.shape.verdict, policyHash: z.string().min(1) })
      .strict(),
  })
  .strict();
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
    gateResultSeen: LeaveGateResult, // not redacted: redaction can mask digits in policyHash
  })
  .strict();
export type HumanActionPayload = z.infer<typeof HumanActionPayload>;
