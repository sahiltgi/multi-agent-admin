// Onboarding route schemas (spec onboarding, rules 24, 25). Every body and response is .strict().
// Views carry ids only: no displayName, email or new joiner name (OQ-9).
import { z } from 'zod';
import { Id, OnboardingChecklist, TaskOwner } from '../domain/schemas.js';

export const ChecklistParams = z.object({ checklistId: Id }).strict();
export const TaskParams = z.object({ checklistId: Id, taskId: Id }).strict();
export const EmptyQuery = z.object({}).strict();
/** Rule 24: no key can be supplied, so completedBy, completedAt and done come from code only. */
export const CompleteBody = z.object({}).strict();

export const OwnerProgress = z
  .object({
    owner: TaskOwner,
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  })
  .strict();
export type OwnerProgress = z.infer<typeof OwnerProgress>;

export const ChecklistView = z
  .object({
    checklist: OnboardingChecklist, // as stored, parsed again
    progress: z.array(OwnerProgress).length(4), // fixed order: it, admin, manager, buddy
    pendingDeviationIds: z.array(Id),
  })
  .strict();
export type ChecklistView = z.infer<typeof ChecklistView>;

/** eventType 'human_action', actor { kind: 'human' }: one task marked done (rule 24). */
export const TaskCompletedPayload = z
  .object({
    kind: z.literal('onboarding_task_completed'),
    checklistId: Id,
    taskId: Id,
    owner: TaskOwner,
    actorRole: z.enum(['employee', 'manager', 'hr_admin']),
  })
  .strict();
