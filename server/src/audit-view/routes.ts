// The audit view routes (spec audit-view, rules 1, 10, 15): read-only, and none writes a record,
// file or audit event. The timeline reads exactly what GET /audit/:requestId reads; the other two
// are hr_admin only, with the role checked after parsing and before any reader call.
import { EmptyBody, EmptyParams, TraceParams } from '../http/approvals/schemas.js';
import { readVisibleTrace } from '../http/approvals/trace.js';
import { HttpError } from '../http/errors.js';
import type { Actor } from '../http/identity.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { toEvalHistory } from './eval-history.js';
import { latestTableRows, parseMarkdownBlocks } from './markdown.js';
import type { AuditViewDeps, FileRead } from './ports.js';
import {
  AI_LOG_ROWS,
  BuildNotesResponse,
  EvalHistoryResponse,
  TraceTimelineResponse,
  type AiLogState,
  type DocState,
} from './schemas.js';
import { toTimeline } from './timeline.js';

function requireHr(actor: Actor): void {
  if (actor.role !== 'hr_admin') throw new HttpError('forbidden');
}

/** A reader failure other than missing or unreadable is a 500 without its message. */
async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new HttpError('internal_error');
  }
}

function devMetricsState(file: FileRead): DocState {
  return file.status === 'ok' ? { status: 'ok', blocks: parseMarkdownBlocks(file.text) } : file;
}

function aiLogState(file: FileRead): AiLogState {
  return file.status === 'ok' ? latestTableRows(file.text, AI_LOG_ROWS) : file;
}

export function createAuditViewRoutes(deps: AuditViewDeps): RouteDefinition[] {
  const timeline = defineRoute({
    method: 'get',
    path: '/audit/:requestId/timeline',
    params: TraceParams,
    query: EmptyParams,
    body: EmptyBody,
    response: TraceTimelineResponse,
    handler: async ({ actor, params }) => {
      const events = await readVisibleTrace(deps.trace, actor, params.requestId);
      return {
        requestId: params.requestId,
        ...toTimeline(events, { readerIsHr: actor.role === 'hr_admin' }),
      };
    },
  });

  const evalHistory = defineRoute({
    method: 'get',
    path: '/evals/history',
    params: EmptyParams,
    query: EmptyParams,
    body: EmptyBody,
    response: EvalHistoryResponse,
    handler: async ({ actor }) => {
      requireHr(actor);
      return toEvalHistory(await read(() => deps.evalResults.list()));
    },
  });

  const buildNotes = defineRoute({
    method: 'get',
    path: '/build-notes',
    params: EmptyParams,
    query: EmptyParams,
    body: EmptyBody,
    response: BuildNotesResponse,
    handler: async ({ actor }) => {
      requireHr(actor);
      const [devMetrics, aiLog] = await Promise.all([
        read(() => deps.docs.devMetrics()),
        read(() => deps.docs.aiLog()),
      ]);
      return { devMetrics: devMetricsState(devMetrics), aiLog: aiLogState(aiLog) };
    },
  });

  return [timeline, evalHistory, buildNotes];
}
