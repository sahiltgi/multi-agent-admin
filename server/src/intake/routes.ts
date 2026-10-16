// POST /messages and GET /my-requests (spec request-intake, rules 1–18; Decisions D-1 to D-20).
// Code dispatches on the orchestrator's label through a fixed table and turns a Leave Agent card
// into a pending LeaveRequest plus one open ApprovalItem. Every verdict-derived value is copied
// from the card, which copied it from the gate. Nothing here approves or rejects (HARD RULE 1).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LeaveAgentResult, type RecommendationCard } from '../agents/leave/schemas.js';
import { OrchestratorFailure, RoutingDecision } from '../agents/orchestrator/schemas.js';
import {
  ApprovalItem,
  AuditEvent,
  LeaveRequest,
  type ApprovalItem as ApprovalItemT,
  type LeaveRequest as LeaveRequestT,
} from '../domain/schemas.js';
import { HttpError } from '../http/errors.js';
import type { Actor } from '../http/identity.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import type { IntakeDeps, IntakeTextName } from './ports.js';
import {
  EmptyBody,
  EmptyParams,
  IntakePayload,
  MessageBody,
  MessageResponse,
  MyRequestsResponse,
  type FailedRule,
  type MyRequestView,
} from './schemas.js';

type PayloadParts = Omit<IntakePayload, 'kind' | 'requestId' | 'actorRole'>;
type RecordParts = Pick<
  PayloadParts,
  | 'leaveRequestId'
  | 'approvalItemId'
  | 'assigneeRole'
  | 'assigneeId'
  | 'flagged'
  | 'verdict'
  | 'policyVersion'
  | 'policyHash'
>;

const NO_RECORD: RecordParts = {
  leaveRequestId: null,
  approvalItemId: null,
  assigneeRole: null,
  assigneeId: null,
  flagged: null,
  verdict: null,
  policyVersion: null,
  policyHash: null,
};

const internalError = (): HttpError => new HttpError('internal_error');

const AgentDecision = z.union([RoutingDecision, OrchestratorFailure]);

/** Runs one compensating removal; a failure there must not stop the next one (D-13). */
async function undo(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch {
    // The response is already a 500.
  }
}

/** The gate values a card carries, for the audit payload. Copied, never evaluated. */
const cardGate = (card: RecommendationCard): RecordParts => ({
  ...NO_RECORD,
  verdict: card.verdict,
  policyVersion: card.policyVersion,
  policyHash: card.policyHash,
});

const failedRulesOf = (card: RecommendationCard): FailedRule[] =>
  card.ruleResults.filter((r) => !r.passed).map((r) => ({ ruleId: r.ruleId, message: r.message }));

function toView(leave: LeaveRequestT, item: ApprovalItemT | null): MyRequestView {
  const decision = item?.decision;
  return {
    requestId: leave.id,
    leaveType: leave.leaveType,
    startDate: leave.startDate,
    endDate: leave.endDate,
    ...(leave.startHalf === undefined ? {} : { startHalf: leave.startHalf }),
    ...(leave.endHalf === undefined ? {} : { endHalf: leave.endHalf }),
    status: leave.status,
    approvalStatus: item?.status ?? null,
    // Never byEmployeeId: no other employee's id reaches the requester (rule 17, D-16).
    decision:
      decision === undefined
        ? null
        : {
            action: decision.action,
            ...(decision.comment === undefined ? {} : { comment: decision.comment }),
            at: decision.at,
          },
    createdAt: leave.createdAt,
  };
}

export function createIntakeRoutes(deps: IntakeDeps): RouteDefinition[] {
  /** One message, from request id to response (rules 6–16). */
  async function handleMessage(actor: Actor, text: string): Promise<MessageResponse> {
    const requestId = deps.idGen();
    await deps.leaveRequests.recordMessage(requestId, actor.employeeId); // D-9
    const routing: Pick<PayloadParts, 'label' | 'routingSource' | 'injectionSuspected'> = {
      label: null,
      routingSource: null,
      injectionSuspected: false,
    };

    const buildEvent = (parts: Omit<PayloadParts, keyof typeof routing>): AuditEvent =>
      AuditEvent.parse({
        id: deps.idGen(),
        traceId: requestId,
        at: deps.clock.nowIso(),
        actor: { kind: 'system', id: 'intake' }, // D-4
        eventType: 'agent_step',
        payload: IntakePayload.parse({
          kind: 'intake_outcome',
          requestId,
          actorRole: actor.role,
          ...routing,
          ...parts,
        }),
      });

    /** Writes the one intake event, then answers. A sink failure is a 500 (D-20). */
    const finish = async (
      response: MessageResponse,
      parts: Omit<PayloadParts, keyof typeof routing>,
    ): Promise<MessageResponse> => {
      // Validated before the event is written, so nothing can fail after it commits.
      const checked = MessageResponse.parse(response);
      try {
        await deps.audit.write(buildEvent(parts));
      } catch {
        throw internalError();
      }
      return checked;
    };

    /** Best effort, on paths that already end in a 500. */
    const tryAudit = async (escalation: string): Promise<void> => {
      try {
        await deps.audit.write(buildEvent({ ...NO_RECORD, outcome: 'escalated', escalation }));
      } catch {
        // The response is a 500 either way.
      }
    };

    /** Escalation path (rule 13, D-5): a fixed text, nothing persisted, no verdict. */
    const escalate = async (escalation: string): Promise<MessageResponse> => {
      const fixed = await deps.texts.load('escalated');
      if (fixed === null) {
        await tryAudit(escalation);
        throw internalError();
      }
      return finish(
        { kind: 'escalated', requestId, text: fixed },
        { ...NO_RECORD, outcome: 'escalated', escalation },
      );
    };

    const agentError = async (): Promise<never> => {
      await tryAudit('agent_error');
      throw internalError();
    };

    /** A fixed text, or the escalation path when the file is missing (D-14). */
    const fixedText = (name: IntakeTextName): Promise<string | null> => deps.texts.load(name);

    // ---- orchestrator, once (rule 7) ----
    let rawDecision: unknown;
    try {
      rawDecision = await deps.classify({
        requestId,
        agentId: 'orchestrator',
        actor,
        userText: text,
        documents: [],
      });
    } catch {
      return agentError();
    }
    // Port output is parsed, never trusted: anything else is escalated (rule 7, HARD RULE 6).
    const parsedDecision = AgentDecision.safeParse(rawDecision);
    if (!parsedDecision.success) return escalate('invalid_agent_output');
    const decision = parsedDecision.data;
    if (decision.requestId !== requestId) return escalate('request_id_mismatch'); // rule 6
    if ('outcome' in decision) {
      // The orchestrator could not audit: write nothing further (agent-runtime D-14).
      if (decision.code === 'audit_failed') throw internalError();
      return escalate(decision.code);
    }
    routing.label = decision.label;
    routing.routingSource = decision.source;

    switch (decision.label) {
      case 'policy_qa':
      case 'onboarding': {
        const fixed = await fixedText('not_available');
        if (fixed === null) return escalate('text_missing');
        return finish(
          { kind: 'reply', requestId, label: decision.label, text: fixed },
          { ...NO_RECORD, outcome: 'reply', escalation: null },
        );
      }
      case 'prohibited':
      case 'out_of_scope':
        return finish(
          { kind: 'reply', requestId, label: decision.label, text: decision.reply },
          { ...NO_RECORD, outcome: 'reply', escalation: null },
        );
      case 'unclear':
        return finish(
          { kind: 'question', requestId, label: 'unclear', text: decision.clarifyingQuestion },
          { ...NO_RECORD, outcome: 'question', escalation: null },
        );
      case 'leave':
        break;
    }

    // ---- Leave Agent, once (rule 8) ----
    let rawResult: unknown;
    try {
      rawResult = await deps.runLeave({
        requestId,
        agentId: 'leave',
        actor,
        userText: text,
        documents: [],
      });
    } catch {
      return agentError();
    }
    const parsedResult = LeaveAgentResult.safeParse(rawResult);
    if (!parsedResult.success) return escalate('invalid_agent_output');
    const result = parsedResult.data;
    const resultRequestId = result.kind === 'card' ? result.card.requestId : result.requestId;
    if (resultRequestId !== requestId) return escalate('request_id_mismatch'); // rule 6
    // Audit only: the flag never changes the records, the assignee or the response (rule 16).
    routing.injectionSuspected = result.injectionSuspected;
    if (result.kind === 'needs_details') {
      return finish(
        { kind: 'question', requestId, label: 'leave', text: result.question },
        { ...NO_RECORD, outcome: 'question', escalation: null },
      );
    }
    if (result.kind === 'escalated') return escalate(result.reason);

    const { card } = result;
    const failedRules = failedRulesOf(card);
    if (
      card.requestId !== requestId ||
      card.employeeId !== actor.employeeId ||
      card.request.employeeId !== actor.employeeId
    ) {
      return escalate('card_mismatch'); // rule 10
    }
    if (card.verdict === 'RETURN_TO_EMPLOYEE') {
      // D-6: the employee is asked to fix it; nothing is persisted.
      const fixed = await fixedText('returned');
      if (fixed === null) return escalate('text_missing');
      return finish(
        { kind: 'leave_returned', requestId, text: fixed, failedRules },
        { ...cardGate(card), outcome: 'leave_returned', escalation: null },
      );
    }
    if (actor.role === 'hr_admin') {
      // D-7: nobody else could act on an hr_admin's own leave, so nothing is persisted.
      const fixed = await fixedText('hr_admin_self');
      if (fixed === null) return escalate('text_missing');
      return finish(
        { kind: 'reply', requestId, label: 'leave', text: fixed },
        { ...cardGate(card), outcome: 'reply', escalation: null },
      );
    }

    // ---- build and parse every record before the first write (rules 10–12) ----
    const now = deps.clock.nowIso();
    const requestFields: Record<string, unknown> = { ...card.request };
    delete requestFields.employeeId;
    const leave = LeaveRequest.safeParse({
      ...requestFields,
      id: requestId,
      employeeId: actor.employeeId,
      status: 'pending_approval',
      gateResult: {
        verdict: card.verdict,
        ruleResults: card.ruleResults,
        reason: card.reason,
        policyVersion: card.policyVersion,
        policyHash: card.policyHash,
      },
      summary: card.summary,
      summarySource: card.summarySource,
      createdAt: now,
    });
    if (!leave.success) return escalate('card_invalid');

    // D-18: an employee goes to their manager when the directory says that person is one.
    let assignee: { assigneeRole: 'manager' | 'hr_admin'; assigneeId?: string } = {
      assigneeRole: 'hr_admin',
    };
    if (card.verdict !== 'ESCALATE_TO_HR' && actor.role === 'employee') {
      const requester = await deps.directory.getById(actor.employeeId);
      const managerId = requester?.managerId ?? null;
      const manager = managerId === null ? null : await deps.directory.getById(managerId);
      if (manager?.role === 'manager' && manager.id !== actor.employeeId) {
        assignee = { assigneeRole: 'manager', assigneeId: manager.id };
      }
    }
    const flagged = card.verdict === 'ROUTE_TO_MANAGER_WITH_FLAGS';
    const item = ApprovalItem.safeParse({
      id: deps.idGen(),
      kind: 'leave_request',
      subjectId: requestId,
      ...assignee,
      flagged,
      status: 'open',
      createdAt: now,
    });
    if (!item.success) throw internalError(); // a code bug: nothing is written (rule 12)

    const recordParts: Omit<PayloadParts, keyof typeof routing> = {
      ...cardGate(card),
      leaveRequestId: requestId,
      approvalItemId: item.data.id,
      assigneeRole: assignee.assigneeRole,
      assigneeId: assignee.assigneeId ?? null,
      flagged,
      outcome: 'leave_submitted',
      escalation: null,
    };
    let event: AuditEvent;
    try {
      event = buildEvent(recordParts);
    } catch {
      throw internalError();
    }
    // Validated before the first write, so nothing can fail after the records commit.
    const response = MessageResponse.parse({
      kind: 'leave_submitted',
      requestId,
      request: toView(leave.data, item.data),
      verdict: card.verdict,
      failedRules,
    });

    // ---- writes: request, item, event; compensate in reverse on failure (D-13) ----
    if (!(await deps.leaveRequests.insert(leave.data))) throw internalError();
    // A rejected insert counts the same as a refused one.
    const itemWritten = await deps.approvals.insert(item.data).catch(() => false);
    if (!itemWritten) {
      await undo(() => deps.leaveRequests.remove(requestId));
      await tryAudit('store_error');
      throw internalError();
    }
    try {
      await deps.audit.write(event);
    } catch {
      // Each removal runs even if the one before it fails, so no record outlives its event.
      await undo(() => deps.approvals.remove(item.data.id));
      await undo(() => deps.leaveRequests.remove(requestId));
      throw internalError();
    }
    return response;
  }

  const postMessage = defineRoute({
    method: 'post',
    path: '/messages',
    params: EmptyParams,
    query: EmptyParams,
    body: MessageBody,
    response: MessageResponse,
    handler: async ({ actor, body }) => {
      const key = body.idempotencyKey;
      if (key === undefined) return handleMessage(actor, body.text);
      // D-11: only a hash of the text is kept, never the text.
      const textHash = createHash('sha256').update(body.text).digest('hex');
      const claim = await deps.idempotency.begin(
        actor.employeeId,
        key,
        textHash,
        deps.clock.nowIso(),
      );
      if (claim.kind === 'conflict') throw new HttpError('idempotency_conflict');
      if (claim.kind === 'replay') return MessageResponse.parse(claim.body);
      try {
        // Parsed before it is stored, so a response the route would reject is never replayed.
        // handleMessage validates every response before it writes anything.
        const out = await handleMessage(actor, body.text);
        // The writes are committed: a failed completion keeps the key claimed, so a retry gets
        // 409 and can never create a duplicate request (rule 14).
        await deps.idempotency.complete(actor.employeeId, key, 200, out).catch(() => undefined);
        return out;
      } catch (err) {
        await deps.idempotency.release(actor.employeeId, key); // a 500 is never replayed
        throw err;
      }
    },
  });

  const myRequests = defineRoute({
    method: 'get',
    path: '/my-requests',
    params: EmptyParams,
    query: EmptyParams, // no parameter can name another employee (rule 5)
    body: EmptyBody,
    response: MyRequestsResponse,
    handler: async ({ actor }) => {
      const leaves = await deps.leaveRequests.listByEmployee(actor.employeeId);
      const items = await deps.approvalReader.list();
      const requests = leaves
        .map((l) =>
          toView(l, items.find((i) => i.kind === 'leave_request' && i.subjectId === l.id) ?? null),
        )
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.requestId.localeCompare(b.requestId)
            : b.createdAt.localeCompare(a.createdAt),
        );
      return { requests };
    },
  });

  return [postMessage, myRequests];
}
