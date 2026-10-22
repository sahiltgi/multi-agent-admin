// GET /onboarding/:checklistId and GET /onboarding (spec onboarding-api, rules 10, 11; OQ-8). A
// checklist the actor can't read looks exactly like an unknown one, and the list shows exactly what
// the single read would: the store filters, and the route checks every row again.
import type { ChecklistListFilter, OnboardingChecklist } from '../domain/onboarding.js';
import { HttpError } from '../http/errors.js';
import type { Actor } from '../http/identity.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { canRead } from './access.js';
import type { OnboardingRouteDeps } from './ports.js';
import {
  ChecklistParams,
  ChecklistView,
  EmptyBody,
  EmptyQuery,
  ListCursor,
  ListOnboardingQuery,
  ListOnboardingResponse,
  NoParams,
} from './schemas.js';
import { summaryOf, viewOf } from './views.js';

const DEFAULT_LIMIT = 20;

/** Loads a checklist the actor may read; anything else is the same 404 as an unknown id. */
export async function loadReadable(
  deps: Pick<OnboardingRouteDeps, 'onboarding'>,
  actor: Actor,
  checklistId: string,
): Promise<OnboardingChecklist> {
  const checklist = await deps.onboarding.getChecklist(checklistId);
  if (checklist === null || !canRead(actor, checklist)) throw new HttpError('not_found');
  return checklist;
}

/** Opaque, server-issued: base64url JSON of the last row's (startDate, id). */
function encodeCursor(c: OnboardingChecklist): string {
  return Buffer.from(JSON.stringify({ startDate: c.startDate, id: c.id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): ListCursor {
  try {
    const parsed = ListCursor.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through: not JSON
  }
  throw new HttpError('invalid_request', [{ path: ['query', 'cursor'], code: 'invalid_cursor' }]);
}

export function createReadRoutes(deps: OnboardingRouteDeps): RouteDefinition[] {
  const list = defineRoute({
    method: 'get',
    path: '/onboarding',
    params: NoParams,
    query: ListOnboardingQuery,
    body: EmptyBody,
    response: ListOnboardingResponse,
    handler: async ({ actor, query }) => {
      const { startDateFrom, startDateTo } = query;
      if (startDateFrom !== undefined && startDateTo !== undefined && startDateFrom > startDateTo) {
        throw new HttpError('invalid_request', [
          { path: ['query', 'startDateFrom'], code: 'range_inverted' },
        ]);
      }
      const limit = query.limit ?? DEFAULT_LIMIT;
      const filter: ChecklistListFilter = {
        visibleTo:
          actor.role === 'hr_admin'
            ? { kind: 'all' }
            : { kind: 'employee', employeeId: actor.employeeId },
        ...(query.templateId === undefined ? {} : { templateId: query.templateId }),
        ...(startDateFrom === undefined ? {} : { startDateFrom }),
        ...(startDateTo === undefined ? {} : { startDateTo }),
        ...(query.cursor === undefined ? {} : { after: decodeCursor(query.cursor) }),
        limit: limit + 1, // one extra row tells whether there is a next page
      };
      const rows = await deps.onboarding.listChecklists(filter);
      // A row the actor can't read is a store bug: fail closed and never show it.
      if (rows.some((c) => !canRead(actor, c))) throw new HttpError('internal_error');
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        checklists: await Promise.all(page.map((c) => summaryOf(deps.onboarding, c))),
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
      };
    },
  });

  const read = defineRoute({
    method: 'get',
    path: '/onboarding/:checklistId',
    params: ChecklistParams,
    query: EmptyQuery,
    body: EmptyBody,
    response: ChecklistView,
    handler: async ({ actor, params }) =>
      viewOf(deps.onboarding, actor, await loadReadable(deps, actor, params.checklistId)),
  });

  return [list, read];
}
