// The checklist view and list summary (spec onboarding-api, rules 10, 11). Counts come from code;
// the name is looked up only for hr_admin and the checklist manager (OQ-5).
import type { OnboardingChecklist, OnboardingStore } from '../domain/onboarding.js';
import { TaskOwner } from '../domain/schemas.js';
import type { Actor } from '../http/identity.js';
import { canSeeName } from './access.js';
import { ChecklistSummary, ChecklistView, type OwnerProgress } from './schemas.js';

/** One entry per owner, in the fixed order it, admin, manager, buddy. */
export function progressOf(c: OnboardingChecklist): OwnerProgress[] {
  return TaskOwner.options.map((owner) => {
    const tasks = c.tasks.filter((t) => t.owner === owner);
    return {
      owner,
      total: tasks.length,
      done: tasks.filter((t) => t.done).length,
      blocked: tasks.filter((t) => t.blocked !== undefined).length,
    };
  });
}

export async function viewOf(
  store: Pick<OnboardingStore, 'listDeviationsByChecklist' | 'getProfile'>,
  actor: Actor,
  c: OnboardingChecklist,
): Promise<ChecklistView> {
  const deviations = await store.listDeviationsByChecklist(c.id);
  const profile = canSeeName(actor, c) ? await store.getProfile(c.newJoinerId) : null;
  return ChecklistView.parse({
    checklist: c,
    progress: progressOf(c),
    pendingDeviationIds: deviations.filter((d) => d.status === 'pending').map((d) => d.id),
    newJoiner: profile === null ? null : { displayName: profile.displayName },
  });
}

export async function summaryOf(
  store: Pick<OnboardingStore, 'listDeviationsByChecklist'>,
  c: OnboardingChecklist,
): Promise<ChecklistSummary> {
  const deviations = await store.listDeviationsByChecklist(c.id);
  return ChecklistSummary.parse({
    checklistId: c.id,
    templateId: c.templateId,
    startDate: c.startDate,
    newHireTeam: c.newHireTeam,
    managerEmployeeId: c.managerEmployeeId,
    buddyEmployeeId: c.buddyEmployeeId,
    progress: progressOf(c),
    pendingDeviations: deviations.filter((d) => d.status === 'pending').length,
    createdAt: c.createdAt,
  });
}
