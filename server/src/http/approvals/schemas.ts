// Request and response schemas for the approval queue API (spec approval-queue, "Inputs and
// outputs"). Domain schemas are reused, not redefined.
import { z } from 'zod';
import { OnboardingDeviation } from '../../domain/onboarding.js';
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
  OnboardingGateResult,
  OnboardingVerdict,
  Role,
} from '../../domain/schemas.js';

export { Actor } from '../identity.js';

const empty = z.object({}).strict();
export const EmptyParams = empty;
export const EmptyQuery = empty;
export const EmptyBody = empty;

const leave = LeaveRequest.shape;

/** A leave item's gate result, or an onboarding deviation's (spec onboarding OQ-10). */
export const ItemGateResult = z.union([LeaveGateResult, OnboardingGateResult]);
export type ItemGateResult = z.infer<typeof ItemGateResult>;

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

/**
 * The proposed change an onboarding_deviation item decides (spec onboarding, rules 21, 23), so
 * the manager sees exactly what an approve would apply. The rationale is model text: data only.
 */
export const DeviationView = z
  .object({
    deviationId: Id,
    checklistId: Id,
    change: OnboardingDeviation.shape.change,
    rationale: OnboardingDeviation.shape.rationale,
    status: OnboardingDeviation.shape.status,
    proposedBy: Id, // an id only; no displayName or email
  })
  .strict();
export type DeviationView = z.infer<typeof DeviationView>;

export const ApprovalItemView = z
  .object({
    item: ApprovalItem,
    subject: LeaveSubjectView.nullable(), // null when the subject can't be resolved (rule 5)
    gateResult: ItemGateResult.nullable(), // the subject's stored gateResult, copied unchanged
    question: PolicyQuestionView.nullable(), // null unless kind 'escalation'
    deviation: DeviationView.nullable(), // null unless kind 'onboarding_deviation'
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
        .object({
          verdict: z.union([LeaveGateResult.shape.verdict, OnboardingVerdict]),
          policyHash: z.string().min(1),
        })
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
    gateResultSeen: ItemGateResult.nullable(),
  })
  .strict()
  .refine((p) => (p.gateResultSeen === null) === (p.action === 'resolve'), {
    path: ['gateResultSeen'],
    error: 'gateResultSeen is null exactly for a resolve action',
  });
export type HumanActionPayload = z.infer<typeof HumanActionPayload>;
