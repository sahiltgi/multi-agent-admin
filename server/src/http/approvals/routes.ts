// Approval queue routes (spec approval-queue, rules 5–14). The API records human decisions next
// to a gate result that already exists; it never computes or changes a verdict (HARD RULE 1).
import {
  DeviationConflictError,
  OnboardingChecklist,
  OnboardingDeviation,
  applyDeviation,
} from '../../domain/onboarding.js';
import type { PolicyQuestion } from '../../domain/qa.js';
import {
  ApprovalItem,
  AuditEvent,
  type ApprovalStatus,
  type LeaveRequest,
} from '../../domain/schemas.js';
import { redactText } from '../../lib/redact.js';
import { SUMMARY_KINDS } from '../../metrics/ports.js';
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
  type DeviationView,
  type LeaveSubjectView,
  type PolicyQuestionView,
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

function questionView(q: PolicyQuestion): PolicyQuestionView {
  return {
    questionId: q.id,
    employeeId: q.employeeId,
    question: q.question,
    draftAnswer: q.draftAnswer,
    escalation: q.escalation,
    gateResult: q.gateResult,
    policyVersion: q.policyVersion,
    policyHash: q.policyHash,
    handbookHash: q.handbookHash,
    createdAt: q.createdAt,
  };
}

function deviationView(d: OnboardingDeviation): DeviationView {
  return {
    deviationId: d.id,
    checklistId: d.checklistId,
    change: d.change,
    rationale: d.rationale,
    status: d.status,
    proposedBy: d.proposedBy,
  };
}

function viewOf(actor: Actor, { ctx, resolved }: Loaded): ApprovalItemView {
  return {
    item: ctx.item,
    subject: resolved?.leave == null ? null : subjectView(resolved.leave),
    gateResult: resolved?.gateResult ?? null,
    question:
      ctx.item.kind === 'escalation' && resolved?.policyQuestion != null
        ? questionView(resolved.policyQuestion)
        : null,
    deviation:
      ctx.item.kind === 'onboarding_deviation' && resolved?.onboarding !== undefined
        ? deviationView(resolved.onboarding.deviation)
        : null,
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

/** Request-summary payloads whose `usage` only hr_admin sees (spec agent-metrics, rule 11). */
const USAGE_KINDS: ReadonlySet<unknown> = new Set(SUMMARY_KINDS);

/**
 * spec policy-qa DD-24 (rule 23): what a reader who isn't hr_admin gets from a trace. Keyed on
 * event content, so it holds even when no PolicyQuestion was kept. The Q&A gate result (verdict,
 * topic names) and HR's actions on escalation items are dropped, and the per-turn qaVerdict is
 * masked. A summary event's `usage` is dropped (spec agent-metrics, rule 11). Leave gate results
 * and leave decisions are unchanged.
 */
function askerView(e: AuditEvent): AuditEvent[] {
  const p = e.payload;
  if (p.kind === 'qa_gate_result') return [];
  if (e.eventType === 'human_action' && p.itemKind === 'escalation') return [];
  let payload = p;
  if (USAGE_KINDS.has(p.kind) && 'usage' in payload) {
    payload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'usage'));
  }
  if ((p.kind === 'intake_outcome' || p.kind === 'chat_turn') && 'qaVerdict' in p) {
    payload = { ...payload, qaVerdict: null };
  }
  return [payload === p ? e : { ...e, payload }];
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

/** spec onboarding, rule 23: what an approve or reject does to the deviation and its checklist. */
interface DeviationPlan {
  deviation: OnboardingDeviation;
  nextDeviation: OnboardingDeviation;
  /** Set only for an approve: the checklist as read, and with the deviation applied. */
  checklist: OnboardingChecklist | null;
  nextChecklist: OnboardingChecklist | null;
}

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
      if (body.action === 'resolve') return resolveItem(actor, item, body.comment);
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
        // A deviation's decision joins the onboarding request's trace (spec onboarding, rule 18).
        traceId: resolved?.onboarding?.deviation.requestId ?? item.subjectId,
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
      // spec onboarding, rule 23: a deviation changes with its item, never on its own. Planned
      // (and any conflict refused) before the first write.
      const plan =
        decides && item.kind === 'onboarding_deviation'
          ? await planDeviation(resolved, body.action === 'approve')
          : null;

      if (decides && !(await deps.approvals.saveIfStatus(saved, 'open'))) {
        throw new HttpError('already_decided');
      }
      const restoreItem = async (): Promise<void> => {
        if (decides) await deps.approvals.saveIfStatus(item, statusAfter).catch(() => false);
      };
      const restoreDeviation = plan === null ? null : await applyPlan(plan, restoreItem);

      try {
        await deps.audit.write(event);
      } catch {
        // Never leave a decision applied and unaudited (rule 12, OQ-7): restore, then 500.
        await restoreDeviation?.();
        await restoreItem();
        throw new HttpError('internal_error');
      }
      return { item: saved, auditEventId: event.id };
    },
  });

  async function planDeviation(
    resolved: ResolvedSubject | null,
    approve: boolean,
  ): Promise<DeviationPlan> {
    const subject = resolved?.onboarding;
    if (subject === undefined) throw new HttpError('not_found'); // the resolver failed closed
    const { deviation } = subject;
    if (deviation.status !== 'pending') throw new HttpError('already_decided');
    const nextDeviation = OnboardingDeviation.parse({
      ...deviation,
      status: approve ? 'applied' : 'rejected',
    });
    if (!approve) return { deviation, nextDeviation, checklist: null, nextChecklist: null };
    // The current checklist: a completion may have saved a newer version since it was resolved.
    const checklist = await deps.onboarding.getChecklist(deviation.checklistId);
    if (checklist === null) throw new HttpError('not_found');
    let applied: OnboardingChecklist;
    try {
      applied = applyDeviation(checklist, deviation);
    } catch (err) {
      if (err instanceof DeviationConflictError) throw new HttpError('action_not_allowed');
      throw err;
    }
    const nextChecklist = OnboardingChecklist.parse({ ...applied, version: checklist.version + 1 });
    return { deviation, nextDeviation, checklist, nextChecklist };
  }

  /**
   * Checklist (approve only), then deviation, each conditional. A lost race restores what was
   * written and refuses. Returns the undo for a later audit failure.
   */
  async function applyPlan(
    plan: DeviationPlan,
    restoreItem: () => Promise<void>,
  ): Promise<() => Promise<void>> {
    const { checklist, nextChecklist } = plan;
    // A version bumped again on restore, so no reader sees the same version twice (chat D-5).
    const restoreChecklist = async (): Promise<void> => {
      if (checklist === null) return;
      await deps.onboarding
        .saveChecklistIfVersion(
          { ...checklist, version: checklist.version + 2 },
          checklist.version + 1,
        )
        .catch(() => false);
    };
    if (checklist !== null && nextChecklist !== null) {
      const saved = await deps.onboarding
        .saveChecklistIfVersion(nextChecklist, checklist.version)
        .catch(() => false);
      if (!saved) {
        await restoreItem();
        throw new HttpError('action_not_allowed');
      }
    }
    const savedDeviation = await deps.onboarding
      .saveDeviationIfStatus(plan.nextDeviation, 'pending')
      .catch(() => false);
    if (!savedDeviation) {
      await restoreChecklist();
      await restoreItem();
      throw new HttpError('already_decided');
    }
    return async () => {
      await deps.onboarding
        .saveDeviationIfStatus(plan.deviation, plan.nextDeviation.status)
        .catch(() => false);
      await restoreChecklist();
    };
  }

  /**
   * spec policy-qa, rule 28 (after approval-queue rule 6 steps 1-6): only an open escalation
   * item, with a comment. It closes the item; it approves nothing and edits no employee record.
   */
  async function resolveItem(
    actor: Actor,
    item: ApprovalItem,
    rawComment: string | undefined,
  ): Promise<{ item: ApprovalItem; auditEventId: string }> {
    if (item.kind !== 'escalation') throw new HttpError('action_not_allowed');
    // Comments are data, never instructions; stored and audited redacted (rules 8, 12, 15).
    const comment =
      rawComment === undefined || rawComment === '' ? undefined : redactText(rawComment);
    if (comment === undefined) throw new HttpError('comment_required');
    if (item.status !== 'open') throw new HttpError('already_decided');

    const at = deps.clock.nowIso();
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
        action: 'resolve',
        actorRole: actor.role,
        comment,
        statusBefore: 'open',
        statusAfter: 'resolved',
        gateResultSeen: null,
      }),
    });
    const saved = ApprovalItem.parse({
      ...item,
      status: 'resolved',
      decision: { action: 'resolve', byEmployeeId: actor.employeeId, comment, at },
    });
    if (!(await deps.approvals.saveIfStatus(saved, 'open'))) {
      throw new HttpError('already_decided');
    }
    try {
      await deps.audit.write(event);
    } catch {
      // Never leave a resolve applied and unaudited (approval-queue rule 12): restore, then 500.
      await deps.approvals.saveIfStatus(item, 'resolved').catch(() => false);
      throw new HttpError('internal_error');
    }
    return { item: saved, auditEventId: event.id };
  }

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
      const events = (await deps.auditReader.listByTrace(params.requestId))
        .map((e) => AuditEvent.parse(e))
        .flatMap((e) => (actor.role === 'hr_admin' ? [e] : askerView(e)));
      // Array sort is stable, so events at the same instant keep insertion order.
      events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return { requestId: params.requestId, events };
    },
  });

  return [list, get, act, trace];
}
