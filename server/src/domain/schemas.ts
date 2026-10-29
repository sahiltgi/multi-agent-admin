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

// The gate's own rule-result shape, so a gate result is stored exactly as the gate returned it
// (request-intake D-1).
export const RuleResult = z
  .object({
    ruleId: Id,
    passed: z.boolean(),
    expected: z.string().min(1),
    actual: z.string().min(1),
    message: z.string().min(1),
  })
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
    // The card's summary sentence (request-intake D-8). Model text: shown only as a summary.
    summary: z.string().trim().min(1).optional(),
    summarySource: z.enum(['model', 'fallback']).optional(),
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

// 'resolved' closes an escalation item without a decision on any leave (spec policy-qa, rule 28).
export const APPROVAL_STATUSES = ['open', 'approved', 'rejected', 'resolved'] as const;
export const ApprovalStatus = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalDecision = z
  .object({
    action: z.enum(['approve', 'reject', 'comment', 'resolve']),
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
  )
  // A resolve decision iff status 'resolved'; only escalation items, always with a comment
  // (spec policy-qa, rule 28; AT-51).
  .refine(
    (i) =>
      (i.decision?.action === 'resolve') === (i.status === 'resolved') &&
      (i.status !== 'resolved' ||
        (i.kind === 'escalation' &&
          i.decision?.comment !== undefined &&
          i.decision.comment !== '')),
    { path: ['decision'], error: 'a resolved item needs a resolve decision with a comment' },
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

// Role templates and offsets (spec onboarding, rules 1, 2; OQ-8). Defined here, not in
// domain/onboarding.ts, so ENTITY_SCHEMAS can hold the amended checklist without an import cycle.
export const TEMPLATE_IDS = ['engineer', 'sales', 'operations'] as const;
export const TemplateId = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof TemplateId>;

export const TemplateTaskId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/); // e.g. 'buddy-intro'
export type TemplateTaskId = z.infer<typeof TemplateTaskId>;

export const MIN_OFFSET_DAYS = -30;
export const MAX_OFFSET_DAYS = 90;
/** Whole calendar days from the start date (OQ-8). */
export const DueOffsetDays = z.number().int().min(MIN_OFFSET_DAYS).max(MAX_OFFSET_DAYS);

/** A free-text block reason: data, shown to checklist readers, redacted in the audit (onboarding-api rule 12). */
export const BlockReason = z.string().trim().min(1).max(200);

/** Why and by whom a task is blocked (spec onboarding-api, rule 15; OQ-3). */
export const TaskBlock = z
  .object({ reason: BlockReason, blockedBy: Id, blockedAt: IsoDateTime })
  .strict();
export type TaskBlock = z.infer<typeof TaskBlock>;

export const ChecklistTask = z
  .object({
    id: Id, // the template task id, or 'added-<n>' for an approved addition
    title: z.string().trim().min(1).max(120),
    owner: TaskOwner,
    ownerEmployeeId: Id.optional(),
    source: z.enum(['template', 'added']),
    dueOffsetDays: DueOffsetDays,
    dueDate: IsoDate, // computed by code, never by the model
    dependsOn: z.array(Id),
    done: z.boolean(),
    completedBy: Id.optional(), // set by the completion route only
    completedAt: IsoDateTime.optional(),
    blocked: TaskBlock.optional(), // set and cleared by the status route only (onboarding-api OQ-3)
  })
  .strict()
  .refine((t) => t.done === (t.completedBy !== undefined && t.completedAt !== undefined), {
    path: ['done'],
    error: 'done must be set exactly when completedBy and completedAt are',
  })
  .refine((t) => !(t.done && t.blocked !== undefined), {
    path: ['blocked'],
    error: 'a done task is never blocked',
  });
export type ChecklistTask = z.infer<typeof ChecklistTask>;

// ---- Onboarding gate result (spec onboarding, rules 3–9) ----
// Here rather than in gate/, so http/ and onboarding/ never import /gate/ (policy-qa DD-23).
export const OnboardingRuleId = z.enum([
  'checklist_matches_template',
  'no_tasks_added',
  'no_tasks_removed',
]);
export type OnboardingRuleId = z.infer<typeof OnboardingRuleId>;

export const OnboardingRuleResult = RuleResult.extend({ ruleId: OnboardingRuleId }).strict();
export type OnboardingRuleResult = z.infer<typeof OnboardingRuleResult>;

export const OnboardingVerdict = z.enum(['AUTO', 'MANAGER']);
export type OnboardingVerdict = z.infer<typeof OnboardingVerdict>;

export const OnboardingGateResult = z
  .object({
    verdict: OnboardingVerdict,
    ruleResults: z.tuple([OnboardingRuleResult, OnboardingRuleResult, OnboardingRuleResult]),
    reason: z.string().min(1),
    policyVersion: z.string().min(1),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type OnboardingGateResult = z.infer<typeof OnboardingGateResult>;

/** Dependency ids that name no task in `tasks`. */
export function unknownDependencies(
  tasks: readonly { id: string; dependsOn: readonly string[] }[],
): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.flatMap((t) => t.dependsOn.filter((d) => !ids.has(d)));
}

/** True when the dependency graph has a cycle (self-dependencies included). */
export function hasDependencyCycle(
  tasks: readonly { id: string; dependsOn: readonly string[] }[],
): boolean {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const seen = state.get(id);
    if (seen === 'visiting') return true;
    if (seen === 'done') return false;
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) if (visit(d)) return true;
    state.set(id, 'done');
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

export const OnboardingChecklist = z
  .object({
    id: Id,
    requestId: Id, // the turn that created it; also the trace id
    newJoinerId: Id, // minted by idGen, never a directory id (OQ-9)
    templateId: TemplateId,
    templateVersion: z.string().min(1),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    startDate: IsoDate,
    newHireTeam: Id,
    managerEmployeeId: Id, // Team.managerId of newHireTeam, resolved by code
    buddyEmployeeId: Id.nullable(),
    createdBy: Id,
    tasks: z.array(ChecklistTask).min(1),
    removedTemplateTaskIds: z.array(Id),
    gateResult: OnboardingGateResult, // copied from the gate at creation
    version: z.number().int().nonnegative(), // optimistic concurrency for approve and complete
    createdAt: IsoDateTime,
  })
  .strict()
  .refine((c) => new Set(c.tasks.map((t) => t.id)).size === c.tasks.length, {
    path: ['tasks'],
    error: 'task ids must be unique',
  })
  .refine((c) => unknownDependencies(c.tasks).length === 0, {
    path: ['tasks'],
    error: 'every dependsOn must name a task on the checklist',
  })
  .refine((c) => !hasDependencyCycle(c.tasks), {
    path: ['tasks'],
    error: 'task dependencies must not form a cycle',
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

// Model API keys (spec gemini-fallback, rules 1, 3; D-1). '' (as copied from .env.example) counts as
// missing; values are used verbatim, never trimmed.
export const OptionalKey = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);
/** Names only, never values. */
export const NO_MODEL_KEY_MESSAGE =
  'Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env (see .env.example).';

// The running server's env (spec mongo-persistence, rule 9; D-5, D-18; gemini-fallback, rule 3).
// ServerEnv above stays the policy step's schema. Values are never printed: errors name the
// variable only.
export const ServerRuntimeEnv = ServerEnv.extend({
  NODE_ENV: z.string().trim().toLowerCase().optional(), // 'production', in any case, is refused (rule 11)
  MONGODB_URI: SeedEnv.shape.MONGODB_URI,
  PORT: z
    .string()
    .regex(/^\d{1,5}$/)
    .default('3000') // D-5
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  // At least one is required (gemini-fallback, rule 3, amending D-6); Anthropic wins when both are set.
  ANTHROPIC_API_KEY: OptionalKey,
  GEMINI_API_KEY: OptionalKey,
}).superRefine((env, ctx) => {
  if (env.ANTHROPIC_API_KEY === undefined && env.GEMINI_API_KEY === undefined) {
    ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: NO_MODEL_KEY_MESSAGE });
  }
});
export type ServerRuntimeEnv = z.infer<typeof ServerRuntimeEnv>;

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
