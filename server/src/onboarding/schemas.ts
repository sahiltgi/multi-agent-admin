// Onboarding API schemas (spec onboarding, rules 24, 25; spec onboarding-api, rules 1–18). Every
// body, query and response is .strict(). Views carry ids only, except `newJoiner.displayName` for
// hr_admin and the checklist manager (onboarding-api OQ-5); summaries and audit payloads never do.
import { z } from 'zod';
import { OnboardingEscalation } from '../agents/onboarding/schemas.js';
import { BlockReason, NewJoinerName, TaskStatus } from '../domain/onboarding.js';
import {
  Id,
  IsoDate,
  IsoDateTime,
  OnboardingChecklist,
  OnboardingVerdict,
  Role,
  TaskOwner,
  TemplateId,
} from '../domain/schemas.js';
import { IDEMPOTENCY_KEY } from '../intake/schemas.js';
import { Usage } from '../lib/cost.js';

export const ChecklistParams = z.object({ checklistId: Id }).strict();
export const TaskParams = z.object({ checklistId: Id, taskId: Id }).strict();
export const NoParams = z.object({}).strict();
export const EmptyQuery = z.object({}).strict();
export const EmptyBody = z.object({}).strict();

// ---- POST /onboarding (onboarding-api rules 2–9) ----
export const CreateOnboardingBody = z
  .object({
    newJoinerName: NewJoinerName, // PII: never sent to a model, never audited (rule 9)
    templateId: TemplateId, // the request's "role"; never named `role` (approval-queue rule 1)
    startDate: IsoDate, // not before today by the injected clock (rule 3)
    newHireTeam: z.string().regex(/^team-[a-z0-9]+$/), // resolved against the directory (OQ-7)
    managerEmployeeId: z.string().regex(/^emp-\d{3}$/), // must equal Team.managerId (OQ-7)
    buddyEmployeeId: z
      .string()
      .regex(/^emp-\d{3}$/)
      .nullable(), // null = no buddy yet; must be present
    notes: z.string().max(2000).optional(), // untrusted data; blank after trim counts as absent
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional(), // request-intake D-11 (rule 8)
  })
  .strict();
export type CreateOnboardingBody = z.infer<typeof CreateOnboardingBody>;

export const CreateEscalation = z.enum([
  'agent_escalated', // the notes agent returned escalated (detail in agentReason)
  'needs_details', // the notes agent asked a question or gave no recognised outcome
  'invalid_agent_output', // the agent result failed its schema
  'request_id_mismatch',
  'agent_error', // the agent port threw
]);
export type CreateEscalation = z.infer<typeof CreateEscalation>;

export const CreateOnboardingResponse = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('checklist_created'),
      requestId: Id,
      checklistId: Id,
      verdict: OnboardingVerdict, // copied from the gate, never from a model
      pendingDeviationIds: z.array(Id),
      text: z.string().min(1), // fixed created.txt or pending_manager.txt
    })
    .strict(),
  z
    .object({
      kind: z.literal('escalated'),
      requestId: Id,
      reason: CreateEscalation,
      agentReason: OnboardingEscalation.nullable(), // set only for 'agent_escalated'
      text: z.string().min(1), // the intake escalated text (onboarding ID-6)
    })
    .strict(),
]); // no name, notes, rationale, model text or gate prose in either arm
export type CreateOnboardingResponse = z.infer<typeof CreateOnboardingResponse>;

// ---- PATCH /onboarding/:checklistId/tasks/:taskId (rule 12) ----
export const TaskStatusBody = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done') }).strict(),
  z.object({ status: z.literal('blocked'), reason: BlockReason }).strict(),
  z.object({ status: z.literal('open') }).strict(), // reopens a blocked task only
]);
export type TaskStatusBody = z.infer<typeof TaskStatusBody>;

// ---- Views (rules 10, 11) ----
export const OwnerProgress = z
  .object({
    owner: TaskOwner,
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(), // onboarding-api OQ-3
  })
  .strict();
export type OwnerProgress = z.infer<typeof OwnerProgress>;

export const ChecklistView = z
  .object({
    checklist: OnboardingChecklist, // as stored, parsed again
    progress: z.array(OwnerProgress).length(4), // fixed order: it, admin, manager, buddy
    pendingDeviationIds: z.array(Id),
    /** Non-null only for hr_admin and the checklist manager (onboarding-api OQ-5). */
    newJoiner: z.object({ displayName: NewJoinerName }).strict().nullable(),
  })
  .strict();
export type ChecklistView = z.infer<typeof ChecklistView>;

export const ListOnboardingQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(), // default 20 (OQ-8)
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional(), // opaque, server-issued
    templateId: TemplateId.optional(),
    startDateFrom: IsoDate.optional(), // inclusive
    startDateTo: IsoDate.optional(), // inclusive; From > To is 400
  })
  .strict();
export type ListOnboardingQuery = z.infer<typeof ListOnboardingQuery>;

export const ChecklistSummary = z
  .object({
    checklistId: Id,
    templateId: TemplateId,
    startDate: IsoDate,
    newHireTeam: Id,
    managerEmployeeId: Id,
    buddyEmployeeId: Id.nullable(),
    progress: z.array(OwnerProgress).length(4), // it, admin, manager, buddy
    pendingDeviations: z.number().int().nonnegative(),
    createdAt: IsoDateTime,
  })
  .strict(); // no tasks, no name, no displayName, no email
export type ChecklistSummary = z.infer<typeof ChecklistSummary>;

export const ListOnboardingResponse = z
  .object({ checklists: z.array(ChecklistSummary), nextCursor: z.string().nullable() })
  .strict();
export type ListOnboardingResponse = z.infer<typeof ListOnboardingResponse>;

/** The decoded list cursor: carries no visibility, so it is re-applied on every page. */
export const ListCursor = z.object({ startDate: IsoDate, id: Id }).strict();
export type ListCursor = z.infer<typeof ListCursor>;

// ---- Audit payloads (rule 18) ----
/** eventType 'human_action', actor { kind: 'human' }: a checklist created through the API. */
export const OnboardingCreatedPayload = z
  .object({
    kind: z.literal('onboarding_created'),
    requestId: Id,
    checklistId: Id,
    templateId: TemplateId,
    newHireTeam: Id,
    verdict: OnboardingVerdict,
    pendingDeviations: z.number().int().nonnegative(),
    notesProvided: z.boolean(),
    agentRan: z.boolean(),
    actorRole: Role,
    source: z.literal('api'),
    // spec agent-metrics, rule 5: the request's totals, set by code; absent only on older events
    usage: Usage.nullable().optional(),
  })
  .strict(); // no name, no notes

/** eventType 'agent_step', actor { kind: 'system', id: 'onboarding-api' }: nothing was stored. */
export const OnboardingCreateEscalatedPayload = z
  .object({
    kind: z.literal('onboarding_create_escalated'),
    requestId: Id,
    reason: CreateEscalation,
    agentReason: OnboardingEscalation.nullable(),
    actorRole: Role,
    // spec agent-metrics, rule 5: the request's totals, set by code; absent only on older events
    usage: Usage.nullable().optional(),
  })
  .strict();

/** eventType 'human_action', actor { kind: 'human' }: one task status change (rules 13, 14). */
export const TaskStatusChangedPayload = z
  .object({
    kind: z.literal('onboarding_task_status_changed'),
    checklistId: Id,
    taskId: Id,
    owner: TaskOwner,
    from: TaskStatus,
    to: TaskStatus,
    actorRole: Role,
    onBehalfOf: TaskOwner.nullable(), // set when hr_admin acts for it, admin or an unassigned buddy
    reason: z.string().nullable(), // redactText(reason) when to === 'blocked'; null otherwise
  })
  .strict();
