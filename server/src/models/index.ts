// Mongoose models: storage only (ADR-0002). Each is typed from its Zod schema in
// ../domain/schemas.ts, and the AT-17 parity test keeps the field sets equal.
// Data is Zod-parsed before it reaches a model; these schemas only add storage rules.
import { Schema, model } from 'mongoose';
import {
  ApprovalDecision,
  ApprovalItem,
  ApprovalKind,
  ApprovalStatus,
  AuditEvent,
  ChecklistTask,
  Employee,
  Holiday,
  LeaveBalance,
  LeaveGateResult,
  LeaveRequest,
  LeaveRequestStatus,
  LeaveType,
  LeaveVerdict,
  OnboardingChecklist,
  OnboardingGateResult,
  OnboardingVerdict,
  Role,
  RuleResult,
  Team,
  TaskOwner,
} from '../domain/schemas.js';

// `id: false` turns off Mongoose's `id` virtual, which would collide with our own `id` field.
// `strict: 'throw'` rejects unknown keys, like `.strict()` in Zod (rule 3).
const TOP_LEVEL = { id: false, strict: 'throw', timestamps: false } as const;
const SUBDOCUMENT = { _id: false, id: false, strict: 'throw' } as const;

const requiredString = { type: String, required: true } as const;
const uniqueId = { type: String, required: true, unique: true } as const;
const optionalString = { type: String, required: false } as const;
const nullableString = { type: String, default: null } as const;
const requiredBoolean = { type: Boolean, required: true } as const;
const dayAmount = { type: Number, required: true, min: 0 } as const;

function requiredEnum(values: readonly string[]) {
  return { type: String, required: true, enum: [...values] };
}

const employeeSchema = new Schema<Employee>(
  {
    id: uniqueId,
    displayName: requiredString,
    email: requiredString,
    role: requiredEnum(Role.options),
    teamId: nullableString,
    managerId: nullableString,
  },
  TOP_LEVEL,
);

const teamSchema = new Schema<Team>(
  { id: uniqueId, name: requiredString, managerId: requiredString },
  TOP_LEVEL,
);

const leaveBalanceSchema = new Schema<LeaveBalance>(
  {
    employeeId: requiredString,
    leaveType: requiredEnum(LeaveType.options),
    period: requiredString,
    entitledDays: dayAmount,
    usedDays: dayAmount,
  },
  TOP_LEVEL,
);
leaveBalanceSchema.index({ employeeId: 1, leaveType: 1, period: 1 }, { unique: true });

const ruleResultSchema = new Schema<RuleResult>(
  {
    ruleId: requiredString,
    passed: requiredBoolean,
    expected: requiredString,
    actual: requiredString,
    message: requiredString,
  },
  SUBDOCUMENT,
);

const leaveGateResultSchema = new Schema<LeaveGateResult>(
  {
    verdict: requiredEnum(LeaveVerdict.options),
    ruleResults: { type: [ruleResultSchema], required: true },
    reason: requiredString,
    policyVersion: requiredString,
    policyHash: requiredString,
  },
  SUBDOCUMENT,
);

const leaveRequestSchema = new Schema<LeaveRequest>(
  {
    id: uniqueId,
    employeeId: requiredString,
    leaveType: requiredEnum(LeaveType.options),
    startDate: requiredString,
    endDate: requiredString,
    startHalf: { type: String, required: false, enum: ['pm'] },
    endHalf: { type: String, required: false, enum: ['am'] },
    reason: optionalString,
    status: requiredEnum(LeaveRequestStatus.options),
    gateResult: { type: leaveGateResultSchema, required: false },
    summary: optionalString,
    summarySource: { type: String, required: false, enum: ['model', 'fallback'] },
    createdAt: requiredString,
  },
  TOP_LEVEL,
);

const holidaySchema = new Schema<Holiday>(
  {
    date: { type: String, required: true, unique: true },
    name: requiredString,
    period: requiredString,
  },
  TOP_LEVEL,
);

const approvalDecisionSchema = new Schema<ApprovalDecision>(
  {
    action: requiredEnum(ApprovalDecision.shape.action.options),
    byEmployeeId: requiredString,
    comment: optionalString,
    at: requiredString,
  },
  SUBDOCUMENT,
);

const approvalItemSchema = new Schema<ApprovalItem>(
  {
    id: uniqueId,
    kind: requiredEnum(ApprovalKind.options),
    subjectId: requiredString,
    assigneeRole: requiredEnum(ApprovalItem.shape.assigneeRole.options),
    assigneeId: optionalString,
    flagged: requiredBoolean,
    status: requiredEnum(ApprovalStatus.options),
    decision: { type: approvalDecisionSchema, required: false },
    createdAt: requiredString,
  },
  TOP_LEVEL,
);

const auditActorSchema = new Schema<AuditEvent['actor']>(
  { kind: requiredEnum(AuditEvent.shape.actor.shape.kind.options), id: requiredString },
  SUBDOCUMENT,
);

const auditEventSchema = new Schema<AuditEvent>(
  {
    id: uniqueId,
    traceId: requiredString,
    at: requiredString,
    actor: { type: auditActorSchema, required: true },
    eventType: requiredEnum(AuditEvent.shape.eventType.options),
    payload: { type: Schema.Types.Mixed, required: true },
  },
  TOP_LEVEL,
);

// Append-only (rule 10): every update, replace and delete is refused. Inserts are the only write.
function refuseAuditChange(): never {
  throw new Error('AuditEvent is append-only: updates and deletes are not allowed');
}
auditEventSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
    'findOneAndReplace',
  ],
  refuseAuditChange,
);
auditEventSchema.pre(
  ['updateOne', 'deleteOne'],
  { document: true, query: false },
  refuseAuditChange,
);
// bulkWrite can carry updates and deletes, so it is refused as a whole.
auditEventSchema.pre('bulkWrite', refuseAuditChange);
auditEventSchema.pre('save', function () {
  if (!this.isNew) refuseAuditChange();
});

const checklistTaskSchema = new Schema<ChecklistTask>(
  {
    id: requiredString,
    title: requiredString,
    owner: requiredEnum(TaskOwner.options),
    ownerEmployeeId: optionalString,
    source: requiredEnum(ChecklistTask.shape.source.options),
    dueOffsetDays: { type: Number, required: true },
    dueDate: requiredString,
    dependsOn: { type: [String], required: true },
    done: requiredBoolean,
    completedBy: optionalString,
    completedAt: optionalString,
  },
  SUBDOCUMENT,
);

// ruleResults is a fixed 3-tuple in Zod; storage keeps it as an array (parsed on read).
type StoredOnboardingGateResult = Omit<OnboardingGateResult, 'ruleResults'> & {
  ruleResults: RuleResult[];
};
const onboardingGateResultSchema = new Schema<StoredOnboardingGateResult>(
  {
    verdict: requiredEnum(OnboardingVerdict.options),
    ruleResults: { type: [ruleResultSchema], required: true },
    reason: requiredString,
    policyVersion: requiredString,
    policyHash: requiredString,
  },
  SUBDOCUMENT,
);

const onboardingChecklistSchema = new Schema<OnboardingChecklist>(
  {
    id: uniqueId,
    requestId: requiredString,
    newJoinerId: requiredString,
    templateId: requiredString,
    templateVersion: requiredString,
    policyHash: requiredString,
    startDate: requiredString,
    newHireTeam: requiredString,
    managerEmployeeId: requiredString,
    buddyEmployeeId: nullableString,
    createdBy: requiredString,
    tasks: { type: [checklistTaskSchema], required: true },
    removedTemplateTaskIds: { type: [String], required: true },
    gateResult: { type: onboardingGateResultSchema, required: true },
    version: { type: Number, required: true, min: 0 },
    createdAt: requiredString,
  },
  TOP_LEVEL,
);

// Collection names are set explicitly so they match the seed's collection names.
export const EmployeeModel = model<Employee>('Employee', employeeSchema, 'employees');
export const TeamModel = model<Team>('Team', teamSchema, 'teams');
export const LeaveBalanceModel = model<LeaveBalance>(
  'LeaveBalance',
  leaveBalanceSchema,
  'leaveBalances',
);
export const LeaveRequestModel = model<LeaveRequest>(
  'LeaveRequest',
  leaveRequestSchema,
  'leaveRequests',
);
export const HolidayModel = model<Holiday>('Holiday', holidaySchema, 'holidays');
export const ApprovalItemModel = model<ApprovalItem>(
  'ApprovalItem',
  approvalItemSchema,
  'approvalItems',
);
export const AuditEventModel = model<AuditEvent>('AuditEvent', auditEventSchema, 'auditEvents');
export const OnboardingChecklistModel = model<OnboardingChecklist>(
  'OnboardingChecklist',
  onboardingChecklistSchema,
  'onboardingChecklists',
);

export const MODELS = {
  Employee: EmployeeModel,
  Team: TeamModel,
  LeaveBalance: LeaveBalanceModel,
  LeaveRequest: LeaveRequestModel,
  Holiday: HolidayModel,
  ApprovalItem: ApprovalItemModel,
  AuditEvent: AuditEventModel,
  OnboardingChecklist: OnboardingChecklistModel,
} as const;
