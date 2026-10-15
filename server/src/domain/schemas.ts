// Domain schemas: the single source of truth for every entity (spec domain-schemas, rule 1).
// Types come from z.infer. Mongoose models in ../models/ describe storage only.
import { z } from 'zod';
import { isRealCalendarDate } from './calendar.js';

// ---- primitives ----
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDate, { error: 'must be a real calendar date' });
export type IsoDate = z.infer<typeof IsoDate>;

/** Always supplied by the caller; schemas never read the clock. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Stable synthetic ids, e.g. 'emp-001', 'team-a'. */
export const Id = z.string().trim().min(1);
export type Id = z.infer<typeof Id>;

export const Role = z.enum(['employee', 'manager', 'hr_admin']);
export type Role = z.infer<typeof Role>;

export const LEAVE_TYPES = [
  'annual',
  'sick',
  'casual',
  'unpaid',
  'bereavement',
  'parental',
] as const;
export const LeaveType = z.enum(LEAVE_TYPES);
export type LeaveType = z.infer<typeof LeaveType>;

/** `YYYY-YY` with consecutive years; '2026-27' runs 2026-04-01 to 2027-03-31 inclusive. */
export const LeavePeriod = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((p) => (Number(p.slice(0, 4)) + 1) % 100 === Number(p.slice(5)), {
    error: 'must name consecutive years, e.g. 2026-27',
  });
export type LeavePeriod = z.infer<typeof LeavePeriod>;

/** Whole or half days. */
export const DayAmount = z.number().nonnegative().multipleOf(0.5);
export type DayAmount = z.infer<typeof DayAmount>;

// ---- Employee ----
// No compensation, termination or employment-status field exists (HARD RULE 2).
export const Employee = z
  .object({
    id: Id,
    displayName: z.string().trim().min(1),
    email: z.email(),
    role: Role,
    teamId: Id.nullable(),
    managerId: Id.nullable(),
  })
  .strict();
export type Employee = z.infer<typeof Employee>;

// ---- Team ----
export const Team = z.object({ id: Id, name: z.string().trim().min(1), managerId: Id }).strict();
export type Team = z.infer<typeof Team>;

// ---- LeaveBalance ----
// Used is never compared with entitled here: that is the gate's balance check.
export const LeaveBalance = z
  .object({
    employeeId: Id,
    leaveType: LeaveType,
    period: LeavePeriod,
    entitledDays: DayAmount,
    usedDays: DayAmount,
  })
  .strict();
export type LeaveBalance = z.infer<typeof LeaveBalance>;

// ---- Gate result attached to a LeaveRequest (brief §4, ADR-0004) ----
// There is deliberately no "approved" verdict.
export const LeaveVerdict = z.enum([
  'RETURN_TO_EMPLOYEE',
  'ESCALATE_TO_HR',
  'ROUTE_TO_MANAGER_WITH_FLAGS',
  'ROUTE_TO_MANAGER',
]);
export type LeaveVerdict = z.infer<typeof LeaveVerdict>;

export const RuleResult = z
  .object({ ruleId: Id, passed: z.boolean(), reason: z.string().min(1) })
  .strict();
export type RuleResult = z.infer<typeof RuleResult>;

export const LeaveGateResult = z
  .object({
    verdict: LeaveVerdict,
    ruleResults: z.array(RuleResult),
    reason: z.string().min(1),
    policyVersion: z.string().min(1),
    policyHash: z.string().min(1),
  })
  .strict();
export type LeaveGateResult = z.infer<typeof LeaveGateResult>;

// ---- LeaveRequest ----
export const LEAVE_REQUEST_STATUSES = [
  'pending_approval',
  'returned',
  'approved',
  'rejected',
  'cancelled',
] as const;
export const LeaveRequestStatus = z.enum(LEAVE_REQUEST_STATUSES);
export type LeaveRequestStatus = z.infer<typeof LeaveRequestStatus>;

export const LeaveRequest = z
  .object({
    id: Id,
    employeeId: Id,
    leaveType: LeaveType,
    startDate: IsoDate,
    endDate: IsoDate,
    startHalf: z.literal('pm').optional(), // leave starts at noon on startDate
    endHalf: z.literal('am').optional(), // leave ends at noon on endDate
    reason: z.string().optional(), // free text from the user: data, never instructions
    status: LeaveRequestStatus,
    gateResult: LeaveGateResult.optional(), // copied from the gate by code, never written by a model
    createdAt: IsoDateTime,
  })
  .strict()
  .refine((r) => r.endDate >= r.startDate, {
    path: ['endDate'],
    error: 'endDate must not be before startDate',
  })
  .refine(
    (r) => r.startDate !== r.endDate || r.startHalf === undefined || r.endHalf === undefined,
    { path: ['endHalf'], error: 'a single-day request may set only one half day' },
  );
export type LeaveRequest = z.infer<typeof LeaveRequest>;

// ---- Holiday ----
export const Holiday = z
  .object({ date: IsoDate, name: z.string().trim().min(1), period: LeavePeriod })
  .strict();
export type Holiday = z.infer<typeof Holiday>;

// ---- ApprovalItem ----
export const APPROVAL_KINDS = ['leave_request', 'onboarding_deviation', 'escalation'] as const;
export const ApprovalKind = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const APPROVAL_STATUSES = ['open', 'approved', 'rejected'] as const;
export const ApprovalStatus = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalDecision = z
  .object({
    action: z.enum(['approve', 'reject', 'comment']),
    byEmployeeId: Id,
    comment: z.string().trim().optional(),
    at: IsoDateTime,
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ApprovalItem = z
  .object({
    id: Id,
    kind: ApprovalKind,
    subjectId: Id,
    assigneeRole: z.enum(['manager', 'hr_admin']), // an employee is never an assignee
    assigneeId: Id.optional(),
    flagged: z.boolean(), // copied from the gate verdict by code
    status: ApprovalStatus,
    decision: ApprovalDecision.optional(),
    createdAt: IsoDateTime,
  })
  .strict()
  .refine(
    (i) =>
      !i.flagged ||
      i.decision?.action !== 'approve' ||
      (i.decision.comment !== undefined && i.decision.comment !== ''),
    { path: ['decision', 'comment'], error: 'approving a flagged item needs a comment' },
  );
export type ApprovalItem = z.infer<typeof ApprovalItem>;

// ---- AuditEvent ----
export const AuditEvent = z
  .object({
    id: Id,
    traceId: Id,
    at: IsoDateTime,
    actor: z
      .object({ kind: z.enum(['agent', 'tool', 'gate', 'human', 'system']), id: Id })
      .strict(),
    eventType: z.enum([
      'agent_step',
      'tool_call',
      'tool_call_denied',
      'gate_result',
      'human_action',
      'injection_flagged',
    ]),
    payload: z.record(z.string(), z.unknown()), // already PII-redacted by the writer
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEvent>;

// ---- OnboardingChecklist ----
export const TaskOwner = z.enum(['it', 'admin', 'manager', 'buddy']);
export type TaskOwner = z.infer<typeof TaskOwner>;

export const ChecklistTask = z
  .object({
    id: Id,
    title: z.string().trim().min(1),
    owner: TaskOwner,
    ownerEmployeeId: Id.optional(),
    source: z.enum(['template', 'added']),
    done: z.boolean(),
  })
  .strict();
export type ChecklistTask = z.infer<typeof ChecklistTask>;

export const OnboardingChecklist = z
  .object({
    id: Id,
    newJoinerId: Id,
    templateId: Id,
    templateVersion: z.string().min(1),
    tasks: z.array(ChecklistTask).min(1),
    removedTemplateTaskIds: z.array(Id),
    createdAt: IsoDateTime,
  })
  .strict()
  .refine((c) => new Set(c.tasks.map((t) => t.id)).size === c.tasks.length, {
    path: ['tasks'],
    error: 'task ids must be unique',
  });
export type OnboardingChecklist = z.infer<typeof OnboardingChecklist>;

export const ENTITY_SCHEMAS = {
  Employee,
  Team,
  LeaveBalance,
  LeaveRequest,
  Holiday,
  ApprovalItem,
  AuditEvent,
  OnboardingChecklist,
} as const;

// ---- Seed env (boundary: env vars) ----
// Not strict: process.env holds many unrelated variables. The URI value is never printed.
export const SeedEnv = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/),
  NODE_ENV: z.string().optional(),
});
export type SeedEnv = z.infer<typeof SeedEnv>;

// ---- Server env (boundary: env vars) ----
// Not strict, like SeedEnv. LEAVE_POLICY_PATH overrides the default policies/leave/v1.yaml
// (spec leave-policy D-4); its stem must still match the policy version.
export const ServerEnv = z.object({
  LEAVE_POLICY_PATH: z.string().min(1).optional(), // used verbatim, never trimmed
});
export type ServerEnv = z.infer<typeof ServerEnv>;

// ---- Seed output: counts only, never names, emails or the connection URI ----
export const SeedSummary = z
  .object({
    teams: z.number().int(),
    employees: z.number().int(),
    leaveBalances: z.number().int(),
    holidays: z.number().int(),
    leaveRequests: z.number().int(),
  })
  .strict();
export type SeedSummary = z.infer<typeof SeedSummary>;
