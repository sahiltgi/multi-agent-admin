// Onboarding checklist routes (spec onboarding, rules 24, 25). Humans mark tasks done here; no
// agent can. Reads are RBAC-checked and 404 hides a checklist the actor may not see. The task list
// itself never changes here: only a manager's approve of a deviation does that (rule 23).
import type { AuditSink } from '../agents/audit.js';
import type {
  OnboardingChecklist,
  OnboardingDirectory,
  OnboardingStore,
} from '../domain/onboarding.js';
import {
  AuditEvent,
  OnboardingChecklist as ChecklistSchema,
  TaskOwner,
} from '../domain/schemas.js';
import { HttpError } from '../http/errors.js';
import type { Actor } from '../http/identity.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import {
  ChecklistParams,
  ChecklistView,
  CompleteBody,
  EmptyQuery,
  TaskCompletedPayload,
  TaskParams,
} from './schemas.js';

export interface OnboardingRouteDeps {
  directory: Pick<OnboardingDirectory, 'getById'>;
  onboarding: OnboardingStore;
  audit: Pick<AuditSink, 'write'>;
  clock: { nowIso(): string };
  idGen: () => string;
}

/** Rule 25 (OQ-2): hr_admin, the checklist's manager, and anyone named as a task owner. */
function canRead(actor: Actor, c: OnboardingChecklist): boolean {
  if (actor.role === 'hr_admin') return true;
  if (c.managerEmployeeId === actor.employeeId) return true;
  return c.tasks.some((t) => t.ownerEmployeeId === actor.employeeId);
}

/** Rule 24 (OQ-2): hr_admin any task; the checklist manager its manager tasks; a named owner theirs. */
function canComplete(
  actor: Actor,
  c: OnboardingChecklist,
  task: OnboardingChecklist['tasks'][number],
) {
  if (actor.role === 'hr_admin') return true;
  if (task.owner === 'manager' && c.managerEmployeeId === actor.employeeId) return true;
  return task.ownerEmployeeId === actor.employeeId;
}

export function createOnboardingRoutes(deps: OnboardingRouteDeps): RouteDefinition[] {
  async function loadReadable(actor: Actor, checklistId: string): Promise<OnboardingChecklist> {
    const checklist = await deps.onboarding.getChecklist(checklistId);
    // A denied read looks the same as an unknown checklist.
    if (checklist === null || !canRead(actor, checklist)) throw new HttpError('not_found');
    return checklist;
  }

  async function viewOf(checklist: OnboardingChecklist): Promise<ChecklistView> {
    const deviations = await deps.onboarding.listDeviationsByChecklist(checklist.id);
    return ChecklistView.parse({
      checklist,
      progress: TaskOwner.options.map((owner) => {
        const tasks = checklist.tasks.filter((t) => t.owner === owner);
        return { owner, total: tasks.length, done: tasks.filter((t) => t.done).length };
      }),
      pendingDeviationIds: deviations.filter((d) => d.status === 'pending').map((d) => d.id),
    });
  }

  const read = defineRoute({
    method: 'get',
    path: '/onboarding/checklists/:checklistId',
    params: ChecklistParams,
    query: EmptyQuery,
    body: CompleteBody,
    response: ChecklistView,
    handler: async ({ actor, params }) => viewOf(await loadReadable(actor, params.checklistId)),
  });

  const complete = defineRoute({
    method: 'post',
    path: '/onboarding/checklists/:checklistId/tasks/:taskId/complete',
    params: TaskParams,
    query: EmptyQuery,
    body: CompleteBody,
    response: ChecklistView,
    handler: async ({ actor, params }) => {
      const checklist = await loadReadable(actor, params.checklistId);
      const task = checklist.tasks.find((t) => t.id === params.taskId);
      if (task === undefined) throw new HttpError('not_found');
      if (!canComplete(actor, checklist, task)) throw new HttpError('forbidden');
      if (task.done) throw new HttpError('already_done');
      // OQ-5: every dependency must be done first.
      const doneIds = new Set(checklist.tasks.filter((t) => t.done).map((t) => t.id));
      if (task.dependsOn.some((d) => !doneIds.has(d))) {
        throw new HttpError('dependencies_incomplete');
      }

      // Both records are built and parsed before any write, so a parse failure changes nothing.
      const at = deps.clock.nowIso();
      const next = ChecklistSchema.parse({
        ...checklist,
        tasks: checklist.tasks.map((t) =>
          t.id === task.id
            ? { ...t, done: true, completedBy: actor.employeeId, completedAt: at }
            : t,
        ),
        version: checklist.version + 1,
      });
      const event = AuditEvent.parse({
        id: deps.idGen(),
        traceId: checklist.requestId,
        at,
        actor: { kind: 'human', id: actor.employeeId },
        eventType: 'human_action',
        payload: TaskCompletedPayload.parse({
          kind: 'onboarding_task_completed',
          checklistId: checklist.id,
          taskId: task.id,
          owner: task.owner,
          actorRole: actor.role,
        }),
      });
      if (!(await deps.onboarding.saveChecklistIfVersion(next, checklist.version))) {
        throw new HttpError('action_not_allowed'); // another change saved first
      }
      try {
        await deps.audit.write(event);
      } catch {
        // Never leave a completion applied and unaudited: restore (version bumped again), then 500.
        await deps.onboarding
          .saveChecklistIfVersion({ ...checklist, version: checklist.version + 2 }, next.version)
          .catch(() => false);
        throw new HttpError('internal_error');
      }
      return viewOf(next);
    },
  });

  return [read, complete];
}
