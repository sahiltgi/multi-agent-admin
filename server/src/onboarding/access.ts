// Who may read a checklist and who may change a task's status (spec onboarding rule 25; spec
// onboarding-api rules 10, 11, 13; OQ-2). Pure functions over already-loaded data.
import {
  visibleToEmployee,
  type ChecklistTask,
  type OnboardingChecklist,
} from '../domain/onboarding.js';
import type { TaskOwner } from '../domain/schemas.js';
import type { Actor } from '../http/identity.js';

/** hr_admin, the checklist's manager, and anyone named as a task owner. */
export function canRead(actor: Actor, c: OnboardingChecklist): boolean {
  return actor.role === 'hr_admin' || visibleToEmployee(c, actor.employeeId);
}

/** Only hr_admin and the checklist manager see the new joiner's name (onboarding-api OQ-5). */
export function canSeeName(actor: Actor, c: OnboardingChecklist): boolean {
  return actor.role === 'hr_admin' || c.managerEmployeeId === actor.employeeId;
}

export type StatusPermission = { allowed: false } | { allowed: true; onBehalfOf: TaskOwner | null };

/**
 * OQ-2: the checklist manager changes manager tasks and a named buddy changes theirs. hr_admin acts
 * on behalf of the mocked it and admin owners, and of a buddy task with no buddy named, but never
 * on a manager task or a named buddy's task.
 */
export function statusPermission(
  actor: Actor,
  c: OnboardingChecklist,
  task: ChecklistTask,
): StatusPermission {
  const deny: StatusPermission = { allowed: false };
  const asHrFor = (owner: TaskOwner): StatusPermission =>
    actor.role === 'hr_admin' ? { allowed: true, onBehalfOf: owner } : deny;
  switch (task.owner) {
    case 'manager':
      return c.managerEmployeeId === actor.employeeId ? { allowed: true, onBehalfOf: null } : deny;
    case 'buddy':
      if (task.ownerEmployeeId === undefined) return asHrFor('buddy');
      return task.ownerEmployeeId === actor.employeeId ? { allowed: true, onBehalfOf: null } : deny;
    case 'it':
    case 'admin':
      return asHrFor(task.owner);
  }
}
