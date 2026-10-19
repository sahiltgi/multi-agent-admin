// POST /messages and GET /my-requests (spec request-intake, rules 1–18; Decisions D-1 to D-20).
// Code dispatches on the orchestrator's label through a fixed table and turns a Leave Agent card
// into a pending LeaveRequest plus one open ApprovalItem. The dispatch itself is shared with
// POST /chat (spec chat-endpoint rule 10; ./dispatch.ts). Every verdict-derived value is copied
// from the card, which copied it from the gate. Nothing here approves or rejects (HARD RULE 1).
import { createHash } from 'node:crypto';
import { AuditEvent } from '../domain/schemas.js';
import { HttpError } from '../http/errors.js';
import type { Actor } from '../http/identity.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { createDispatcher, NO_RECORD, toView, type RecordParts } from './dispatch.js';
import type { IntakeDeps } from './ports.js';
import {
  EmptyBody,
  EmptyParams,
  IntakePayload,
  MessageBody,
  MessageResponse,
  MyRequestsResponse,
} from './schemas.js';

type EventParts = RecordParts & Pick<IntakePayload, 'outcome' | 'escalation'>;

const internalError = (): HttpError => new HttpError('internal_error');

export function createIntakeRoutes(deps: IntakeDeps): RouteDefinition[] {
  const dispatcher = createDispatcher(deps);

  /** One message, from request id to response (rules 6–16). */
  async function handleMessage(actor: Actor, text: string): Promise<MessageResponse> {
    const requestId = deps.idGen();
    await deps.leaveRequests.recordMessage(requestId, actor.employeeId); // D-9
    const { outcome, routing } = await dispatcher.decide(
      actor,
      requestId,
      { kind: 'classify', text },
      { retryOnModelUnavailable: false },
    );

    const buildEvent = (parts: EventParts): AuditEvent =>
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
          label: routing.label,
          routingSource: routing.routingSource,
          injectionSuspected: routing.injectionSuspected,
          ...parts,
        }),
      });

    /** Writes the one intake event, then answers. A sink failure is a 500 (D-20). */
    const finish = async (
      response: MessageResponse,
      parts: EventParts,
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

    switch (outcome.kind) {
      case 'audit_failed': // the orchestrator could not audit: write nothing further
      case 'parse_error': // a code bug: nothing is written (rule 12)
        throw internalError();
      case 'agent_error':
        await tryAudit('agent_error');
        throw internalError();
      case 'escalate':
        // Escalation path (rule 13, D-5): a fixed text, nothing persisted, no verdict.
        if (outcome.text === null) {
          await tryAudit(outcome.escalation);
          throw internalError();
        }
        return finish(
          { kind: 'escalated', requestId, text: outcome.text },
          { ...NO_RECORD, outcome: 'escalated', escalation: outcome.escalation },
        );
      case 'reply':
        return finish(
          { kind: 'reply', requestId, label: outcome.label, text: outcome.text },
          { ...outcome.gate, outcome: 'reply', escalation: null },
        );
      case 'question':
        return finish(
          { kind: 'question', requestId, label: outcome.label, text: outcome.text },
          { ...NO_RECORD, outcome: 'question', escalation: outcome.escalation },
        );
      case 'leave_returned':
        return finish(
          {
            kind: 'leave_returned',
            requestId,
            text: outcome.text,
            failedRules: outcome.failedRules,
          },
          { ...outcome.gate, outcome: 'leave_returned', escalation: null },
        );
      case 'hand_back':
      case 'model_unavailable':
        // Unreachable: /messages never continues a task and never asks for retries.
        throw internalError();
      case 'submit':
        break;
    }

    const { leave, item, card, failedRules, records } = outcome;
    let event: AuditEvent;
    try {
      event = buildEvent({ ...records, outcome: 'leave_submitted', escalation: null });
    } catch {
      throw internalError();
    }
    // Validated before the first write, so nothing can fail after the records commit.
    const response = MessageResponse.parse({
      kind: 'leave_submitted',
      requestId,
      request: toView(leave, item),
      verdict: card.verdict,
      failedRules,
    });

    // ---- writes: request, item, event; compensate in reverse on failure (D-13) ----
    const written = await dispatcher.writeRecords(leave, item);
    if (!written.ok) {
      if (written.failed === 'item') await tryAudit('store_error');
      throw internalError();
    }
    try {
      await deps.audit.write(event);
    } catch {
      await written.undo();
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
