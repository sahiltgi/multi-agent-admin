// Approval queue routes (spec approval-queue, rules 5–14). The API records human decisions next
// to a gate result that already exists; it never computes or changes a verdict (HARD RULE 1).
import {
  ApprovalItem,
  AuditEvent,
  type ApprovalStatus,
  type LeaveRequest,
} from '../../domain/schemas.js';
import { redactText } from '../../lib/redact.js';
import { HttpError } from '../errors.js';
import type { Actor } from '../identity.js';
import { defineRoute, type RouteDefinition } from '../route.js';
import type { ApprovalApiDeps, ResolvedSubject } from './ports.js';
import { actDenial, canReadTrace, canSee, type ItemContext } from './rbac.js';
import {
  ActionBody,
  ActionResponse,
  EmptyBody,
  EmptyParams,
  GetApprovalResponse,
  HumanActionPayload,
  ItemParams,
  ListApprovalsQuery,
  ListApprovalsResponse,
  TraceParams,
  TraceResponse,
  type ApprovalItemView,
  type LeaveSubjectView,
} from './schemas.js';

interface Loaded {
  ctx: ItemContext;
  resolved: ResolvedSubject | null;
}

async function load(deps: ApprovalApiDeps, item: ApprovalItem): Promise<Loaded> {
  const resolved = await deps.subjects.resolve(item);
  const owner = resolved === null ? null : await deps.directory.getById(resolved.ownerEmployeeId);
  return { ctx: { item, owner }, resolved };
}

function subjectView(leave: LeaveRequest): LeaveSubjectView {
  return {
    requestId: leave.id,
    employeeId: leave.employeeId,
    leaveType: leave.leaveType,
    startDate: leave.startDate,
    endDate: leave.endDate,
    ...(leave.startHalf === undefined ? {} : { startHalf: leave.startHalf }),
    ...(leave.endHalf === undefined ? {} : { endHalf: leave.endHalf }),
    status: leave.status,
  };
}

function viewOf(actor: Actor, { ctx, resolved }: Loaded): ApprovalItemView {
  return {
    item: ctx.item,
    subject: resolved?.leave == null ? null : subjectView(resolved.leave),
    gateResult: resolved?.gateResult ?? null,
    canAct: actDenial(actor, ctx) === null,
  };
}

/** The visible item, or 404 for one that is missing or out of scope (OQ-1). */
async function loadVisible(deps: ApprovalApiDeps, actor: Actor, itemId: string): Promise<Loaded> {
  const item = await deps.approvals.get(itemId);
  if (item === null) throw new HttpError('not_found');
  const loaded = await load(deps, item);
  if (!canSee(actor, loaded.ctx)) throw new HttpError('not_found');
  return loaded;
}

function byCreatedAtThenId(a: ApprovalItemView, b: ApprovalItemView): number {
  const t = Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt);
  if (t !== 0) return t;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

const STATUS_AFTER: Record<'approve' | 'reject', ApprovalStatus> = {
  approve: 'approved',
  reject: 'rejected',
};

export function createApprovalRoutes(deps: ApprovalApiDeps): RouteDefinition[] {
  const list = defineRoute({
    method: 'get',
    path: '/approvals',
    params: EmptyParams,
    query: ListApprovalsQuery,
    body: EmptyBody,
    response: ListApprovalsResponse,
    handler: async ({ actor, query }) => {
      const views: ApprovalItemView[] = [];
      for (const item of await deps.approvals.list()) {
        const loaded = await load(deps, item);
        if (!canSee(actor, loaded.ctx)) continue;
        if (query.status !== undefined && item.status !== query.status) continue;
        views.push(viewOf(actor, loaded));
      }
      return { items: views.sort(byCreatedAtThenId) };
    },
  });

  const get = defineRoute({
    method: 'get',
    path: '/approvals/:itemId',
    params: ItemParams,
    query: EmptyParams,
    body: EmptyBody,
    response: GetApprovalResponse,
    handler: async ({ actor, params }) =>
      viewOf(actor, await loadVisible(deps, actor, params.itemId)),
  });

  const act = defineRoute({
    method: 'post',
    path: '/approvals/:itemId/actions',
    params: ItemParams,
    query: EmptyParams,
    body: ActionBody,
    response: ActionResponse,
    handler: async ({ actor, params, body }) => {
      // Rule 6, in order: visibility, role, self-action, assignee; then rules 9, 10 and 8.
      const { ctx, resolved } = await loadVisible(deps, actor, params.itemId);
      const denial = actDenial(actor, ctx);
      if (denial !== null) throw new HttpError(denial);
      const { item } = ctx;
      const decides = body.action !== 'comment';
      if (decides && item.status !== 'open') throw new HttpError('already_decided');

      const gate = resolved?.gateResult ?? null;
      if (gate === null) throw new HttpError('gate_result_missing');
      if (body.seen.verdict !== gate.verdict || body.seen.policyHash !== gate.policyHash) {
        throw new HttpError('gate_result_changed');
      }

      // Comments are data, never instructions; stored and audited redacted (rules 8, 12, 15).
      const comment =
        body.comment === undefined || body.comment === '' ? undefined : redactText(body.comment);
      const needsComment = body.action === 'comment' || (body.action === 'approve' && item.flagged);
      if (needsComment && comment === undefined) throw new HttpError('comment_required');

      const at = deps.clock.nowIso();
      const statusAfter = body.action === 'comment' ? item.status : STATUS_AFTER[body.action];
      // Both records are built and parsed before any write, so a parse failure changes nothing.
      const event = AuditEvent.parse({
        id: deps.idGen(),
        traceId: item.subjectId,
        at,
        actor: { kind: 'human', id: actor.employeeId },
        eventType: 'human_action',
        payload: HumanActionPayload.parse({
          itemId: item.id,
          itemKind: item.kind,
          action: body.action,
          actorRole: actor.role,
          comment: comment ?? null,
          statusBefore: item.status,
          statusAfter,
          gateResultSeen: gate,
        }),
      });
      const saved =
        body.action === 'comment'
          ? item
          : ApprovalItem.parse({
              ...item,
              status: statusAfter,
              decision: {
                action: body.action,
                byEmployeeId: actor.employeeId,
                ...(comment === undefined ? {} : { comment }),
                at,
              },
            });
      if (decides && !(await deps.approvals.saveIfStatus(saved, 'open'))) {
        throw new HttpError('already_decided');
      }

      try {
        await deps.audit.write(event);
      } catch {
        // Never leave a decision applied and unaudited (rule 12, OQ-7): restore, then 500.
        if (decides) await deps.approvals.saveIfStatus(item, statusAfter).catch(() => false);
        throw new HttpError('internal_error');
      }
      return { item: saved, auditEventId: event.id };
    },
  });

  const trace = defineRoute({
    method: 'get',
    path: '/audit/:requestId',
    params: TraceParams,
    query: EmptyParams,
    body: EmptyBody,
    response: TraceResponse,
    handler: async ({ actor, params }) => {
      const ownerId = await deps.subjects.ownerOfRequest(params.requestId);
      if (ownerId === null) throw new HttpError('not_found');
      const owner = await deps.directory.getById(ownerId);
      // A denied read looks the same as an unknown request (OQ-1).
      const isLeave = await deps.subjects.isLeaveRequest(params.requestId);
      if (!canReadTrace(actor, owner, isLeave)) throw new HttpError('not_found');
      const events = (await deps.auditReader.listByTrace(params.requestId)).map((e) =>
        AuditEvent.parse(e),
      );
      // Array sort is stable, so events at the same instant keep insertion order.
      events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return { requestId: params.requestId, events };
    },
  });

  return [list, get, act, trace];
}
