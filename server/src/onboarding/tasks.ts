// PATCH /onboarding/:checklistId/tasks/:taskId (spec onboarding-api, rules 12–16; OQ-2, OQ-3). A
// human marks one task done or blocked, or reopens a blocked one. The task list itself never changes
// here: only an approved deviation does that (onboarding rule 23).
import { taskStatus, type ChecklistTask, type TaskStatus } from '../domain/onboarding.js';
import { AuditEvent, OnboardingChecklist as ChecklistSchema } from '../domain/schemas.js';
import { HttpError } from '../http/errors.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { redactText } from '../lib/redact.js';
import { statusPermission } from './access.js';
import type { OnboardingRouteDeps } from './ports.js';
import { loadReadable } from './read.js';
import {
  ChecklistView,
  EmptyQuery,
  TaskParams,
  TaskStatusBody,
  TaskStatusChangedPayload,
} from './schemas.js';
import { viewOf } from './views.js';

/** Rule 14: the transition table. Returns the error for a refused move, or null. */
function refusal(
  from: TaskStatus,
  to: TaskStatus,
  task: ChecklistTask,
  doneIds: ReadonlySet<string>,
): HttpError | null {
  if (from === 'done') return new HttpError('already_done');
  if (from === to) return new HttpError('invalid_transition'); // open->open, blocked->blocked
  if (to === 'done' && task.dependsOn.some((d) => !doneIds.has(d))) {
    return new HttpError('dependencies_incomplete'); // a blocked dependency is not done
  }
  return null;
}

/** The task after the move; `blocked` is dropped on reopen and on done. */
function moved(task: ChecklistTask, body: TaskStatusBody, by: string, at: string): ChecklistTask {
  const rest: ChecklistTask = { ...task };
  delete rest.blocked;
  switch (body.status) {
    case 'done':
      return { ...rest, done: true, completedBy: by, completedAt: at };
    case 'blocked':
      return { ...rest, blocked: { reason: body.reason, blockedBy: by, blockedAt: at } };
    case 'open':
      return rest;
  }
}

export function createTaskStatusRoute(deps: OnboardingRouteDeps): RouteDefinition {
  return defineRoute({
    method: 'patch',
    path: '/onboarding/:checklistId/tasks/:taskId',
    params: TaskParams,
    query: EmptyQuery,
    body: TaskStatusBody,
    response: ChecklistView,
    handler: async ({ actor, params, body }) => {
      // Rule 13 order: 404 (unreadable or unknown task), then 403, then the transition table.
      const checklist = await loadReadable(deps, actor, params.checklistId);
      const task = checklist.tasks.find((t) => t.id === params.taskId);
      if (task === undefined) throw new HttpError('not_found');
      const permission = statusPermission(actor, checklist, task);
      if (!permission.allowed) throw new HttpError('forbidden');
      const from = taskStatus(task);
      const doneIds = new Set(checklist.tasks.filter((t) => t.done).map((t) => t.id));
      const refused = refusal(from, body.status, task, doneIds);
      if (refused !== null) throw refused;

      // Both records are built and parsed before any write, so a parse failure changes nothing.
      const at = deps.clock.nowIso();
      const next = ChecklistSchema.parse({
        ...checklist,
        tasks: checklist.tasks.map((t) =>
          t.id === task.id ? moved(t, body, actor.employeeId, at) : t,
        ),
        version: checklist.version + 1,
      });
      const event = AuditEvent.parse({
        id: deps.idGen(),
        traceId: checklist.requestId,
        at,
        actor: { kind: 'human', id: actor.employeeId },
        eventType: 'human_action',
        payload: TaskStatusChangedPayload.parse({
          kind: 'onboarding_task_status_changed',
          checklistId: checklist.id,
          taskId: task.id,
          owner: task.owner,
          from,
          to: body.status,
          actorRole: actor.role,
          onBehalfOf: permission.onBehalfOf,
          // Rule 12: the reason is data; the audit copy is redacted, the stored copy is as given.
          reason: body.status === 'blocked' ? redactText(body.reason) : null,
        }),
      });
      if (!(await deps.onboarding.saveChecklistIfVersion(next, checklist.version))) {
        throw new HttpError('action_not_allowed'); // another change saved first (onboarding ID-2)
      }
      try {
        await deps.audit.write(event);
      } catch {
        // Never leave a change applied and unaudited: restore (version bumped again), then 500.
        await deps.onboarding
          .saveChecklistIfVersion({ ...checklist, version: checklist.version + 2 }, next.version)
          .catch(() => false);
        throw new HttpError('internal_error');
      }
      return viewOf(deps.onboarding, actor, next);
    },
  });
}
