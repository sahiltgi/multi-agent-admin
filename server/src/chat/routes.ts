// POST /chat and GET /conversations/:id (spec chat-endpoint, rules 1–24; D-1 to D-7). A
// conversation belongs to one user. With no active task the orchestrator classifies the message;
// with an active Leave task the Leave Agent continues from a code-rendered draft. Dispatch and
// record writes are shared with POST /messages (rule 10). Every verdict-derived value is copied
// from the card, which copied it from the gate. Nothing here approves or rejects (HARD RULE 1).
import { MAX_USER_TEXT_CHARS } from '../agents/schemas.js';
import { AuditEvent } from '../domain/schemas.js';
import { HttpError } from '../http/errors.js';
import type { Usage } from '../lib/cost.js';
import { requestUsage } from '../metrics/usage.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import {
  createDispatcher,
  NO_RECORD,
  toView,
  undo,
  type Outcome,
  type RecordParts,
  type Routing,
} from '../intake/dispatch.js';
import { EmptyBody, EmptyParams, type DispatchEscalation } from '../intake/schemas.js';
import { renderDraft } from './draft.js';
import type { ChatDeps } from './ports.js';
import {
  ChatBody,
  ChatResponse,
  ChatTextKey,
  ChatTurnPayload,
  Conversation,
  ConversationParams,
  ConversationQuery,
  ConversationView,
  LeaveDraft,
  MAX_TURNS,
  type ChatCard,
  type ChatEscalationCode,
  type ChatStatus,
} from './schemas.js';

type TurnOutcome = ChatTurnPayload['outcome'];
type TurnEscalation = ChatEscalationCode | DispatchEscalation;

/** What a turn decided, before anything is written. */
interface TurnResult {
  status: ChatStatus;
  reply: string;
  card?: ChatCard;
  escalation: TurnEscalation | null;
  draftAfter: LeaveDraft | null; // the task state the conversation keeps
  records: RecordParts;
  submit?: Extract<Outcome, { kind: 'submit' }>;
  policyEscalation?: Extract<Outcome, { kind: 'policy_escalate' }>; // spec policy-qa, rule 22
  onboarding?: Extract<Outcome, { kind: 'onboarding' }>; // spec onboarding, rule 22
}

const internalError = (): HttpError => new HttpError('internal_error');

export function createChatRoutes(deps: ChatDeps): RouteDefinition[] {
  const { intake, conversations } = deps;
  const dispatcher = createDispatcher(intake);

  /** Every chat text, loaded before any agent runs (rule 21); null if any is missing. */
  async function loadTexts(): Promise<Record<ChatTextKey, string> | null> {
    const entries = await Promise.all(
      ChatTextKey.options.map(async (key) => [key, await deps.texts.load(key)] as const),
    );
    const out: Partial<Record<ChatTextKey, string>> = {};
    for (const [key, res] of entries) {
      if (!res.found || res.text.trim() === '') return null;
      out[key] = res.text;
    }
    return out as Record<ChatTextKey, string>;
  }

  const postChat = defineRoute({
    method: 'post',
    path: '/chat',
    params: EmptyParams,
    query: ConversationQuery,
    body: ChatBody,
    response: ChatResponse,
    handler: async ({ actor, body }) => {
      // ---- ownership: unknown and someone else's are the same 404 (rule 5) ----
      let existing: Conversation | null = null;
      if (body.conversationId !== undefined) {
        existing = await conversations.get(body.conversationId, actor.employeeId);
        if (existing === null) throw new HttpError('not_found');
      }
      const previous = existing; // narrowed copy for closures
      const requestId = intake.idGen(); // rule 9: the request id first
      // D-10: a hand-back re-route takes a fresh id, so the turn's id can change once.
      let turnId = requestId;
      let handedBackFrom: string | null = null;
      const conversationId = previous?.id ?? intake.idGen();
      const created = previous === null;
      const taskBefore = previous?.activeAgent === 'leave' ? previous.draft : null;
      // Rule 22: exactly one chat-turn event per turn, so its id is taken once, before any agent.
      const eventId = intake.idGen();

      const turn = {
        mode: taskBefore === null ? 'classify' : 'continue',
        handedBack: false,
        routing: {
          label: null,
          routingSource: null,
          leaveResult: null,
          injectionSuspected: false,
        } as Routing,
      };

      const buildEvent = (p: {
        outcome: TurnOutcome;
        escalation: TurnEscalation | null;
        taskActiveAfter: boolean;
        records: RecordParts;
        usage: Usage | null;
      }): AuditEvent =>
        AuditEvent.parse({
          id: eventId,
          traceId: turnId,
          at: intake.clock.nowIso(),
          actor: { kind: 'system', id: 'chat' }, // D-6
          eventType: 'agent_step',
          payload: ChatTurnPayload.parse({
            kind: 'chat_turn',
            requestId: turnId,
            conversationId,
            conversationCreated: created,
            mode: turn.mode,
            handedBack: turn.handedBack,
            actorRole: actor.role,
            label: turn.routing.label,
            routingSource: turn.routing.routingSource,
            leaveResult: turn.routing.leaveResult,
            outcome: p.outcome,
            escalation: p.escalation,
            handedBackFrom,
            taskActiveBefore: taskBefore !== null,
            taskActiveAfter: p.taskActiveAfter,
            draftMessageCount: taskBefore?.messages.length ?? 0, // a count only, never text
            ...p.records,
            injectionSuspected: turn.routing.injectionSuspected,
            usage: p.usage,
          }),
        });

      /** spec agent-metrics, rules 7, 10: both traces on a hand-back turn; null on a failed read. */
      // Read once (rule 7): every caller runs after the turn's last agent run, so a later call (a
      // lost-race conflict event after the turn event was built) reuses the first result.
      let usageRead: Promise<Usage | null> | null = null;
      const turnUsage = (): Promise<Usage | null> => {
        usageRead ??= requestUsage(
          intake.auditReader,
          intake.pricing,
          handedBackFrom === null ? [turnId] : [handedBackFrom, turnId],
        );
        return usageRead;
      };

      /** Best effort, on paths that already end in an error response. */
      const tryEvent = async (
        outcome: TurnOutcome,
        escalation: TurnEscalation | null,
      ): Promise<void> => {
        try {
          await intake.audit.write(
            buildEvent({
              outcome,
              escalation,
              taskActiveAfter: taskBefore !== null, // the conversation is unchanged
              records: NO_RECORD,
              usage: await turnUsage(),
            }),
          );
        } catch {
          // The response is an error either way.
        }
      };

      /** A 500 after rule 9: records removed first, then one internal_error event (rule 22). */
      const fail = async (
        escalation: ChatEscalationCode,
        removeRecords?: () => Promise<void>,
      ): Promise<never> => {
        await removeRecords?.();
        await tryEvent('internal_error', escalation);
        throw internalError();
      };

      // ---- turn limit, before anything is recorded (rule 7; D-7) ----
      if (previous !== null && previous.turns.length >= MAX_TURNS) {
        await tryEvent('conflict', 'conversation_full');
        throw new HttpError('conversation_full');
      }
      /** A store or loader that throws after rule 9 still gets its rule 22 event (D-10). */
      const guard = async <T>(step: () => Promise<T>, code: ChatEscalationCode): Promise<T> => {
        try {
          return await step();
        } catch {
          return fail(code);
        }
      };

      // request-intake D-9
      await guard(
        () => intake.leaveRequests.recordMessage(requestId, actor.employeeId),
        'store_error',
      );
      const texts = await guard(loadTexts, 'text_missing');
      if (texts === null) return fail('text_missing');

      // ---- decide (rules 11–14, 17) ----
      const merge = (next: Routing): void => {
        turn.routing = {
          label: next.label,
          routingSource: next.routingSource,
          leaveResult: next.leaveResult ?? turn.routing.leaveResult, // the last Leave run's kind
          injectionSuspected: turn.routing.injectionSuspected || next.injectionSuspected,
        };
      };
      const classify = async (): Promise<Outcome> => {
        // Agent ports are caught inside decide(); what reaches here is a store or loader error.
        const d = await guard(
          () =>
            dispatcher.decide(
              actor,
              turnId,
              { kind: 'classify', text: body.message },
              { retryOnModelUnavailable: true },
            ),
          'store_error',
        );
        merge(d.routing);
        return d.outcome;
      };

      let outcome: Outcome | 'draft_too_long';
      let continuing = false; // true while the outcome belongs to the pre-turn task
      if (taskBefore === null) {
        outcome = await classify();
      } else {
        const rendered = renderDraft(texts.draft_template, taskBefore, body.message);
        if (rendered.length > MAX_USER_TEXT_CHARS) {
          outcome = 'draft_too_long'; // D-2: no agent runs and the task is cleared
        } else {
          const d = await guard(
            () =>
              dispatcher.decide(
                actor,
                requestId,
                { kind: 'continue_leave', userText: rendered },
                { retryOnModelUnavailable: true },
              ),
            'store_error',
          );
          merge(d.routing);
          if (d.outcome.kind === 'hand_back') {
            // Rule 14: clear the task and classify the same message once. D-10: under a fresh
            // id, so a card from the re-route never makes the abandoned draft's trace a leave
            // trace that the manager can read.
            // The abandoned run's injection flag stays in its own trace, never on R2's event.
            turn.handedBack = true;
            turn.routing = { ...turn.routing, injectionSuspected: false };
            handedBackFrom = turnId;
            turnId = intake.idGen();
            const rerouteId = turnId;
            await guard(
              () => intake.leaveRequests.recordMessage(rerouteId, actor.employeeId),
              'store_error',
            );
            outcome = await classify();
          } else {
            outcome = d.outcome;
            continuing = true;
          }
        }
      }

      // ---- map to status, reply and card (rule 21) ----
      let result: TurnResult;
      if (outcome === 'draft_too_long') {
        result = {
          status: 'reply',
          reply: texts.draft_too_long,
          escalation: 'draft_too_long',
          draftAfter: null,
          records: NO_RECORD,
        };
      } else {
        switch (outcome.kind) {
          case 'audit_failed':
            // The orchestrator could not audit: write nothing further (agent-runtime D-14).
            throw internalError();
          case 'agent_error':
            return fail('agent_error');
          case 'parse_error':
          case 'hand_back': // a second hand_back can't reach here; never act on it
            return fail('parse_error');
          case 'model_unavailable':
            // Rule 17: the pre-turn task stays exactly as it was; the message isn't added.
            result = {
              status: 'retry',
              reply: texts.retry,
              escalation: 'model_unavailable',
              draftAfter: taskBefore,
              records: NO_RECORD,
            };
            break;
          case 'escalate':
            if (outcome.text === null) return fail('text_missing');
            result = {
              status: 'escalated',
              reply: outcome.text,
              escalation: outcome.escalation,
              draftAfter: null,
              records: NO_RECORD,
            };
            break;
          case 'reply':
            result = {
              status: 'reply',
              reply: outcome.text,
              escalation: null,
              draftAfter: null,
              records: outcome.gate,
            };
            break;
          case 'question': {
            // A Leave question opens or keeps the task; any other question leaves none.
            const draftAfter =
              outcome.label === 'leave'
                ? {
                    messages: [
                      ...(continuing && taskBefore !== null ? taskBefore.messages : []),
                      body.message,
                    ],
                    lastQuestion: outcome.text,
                  }
                : null;
            result = {
              status: 'question',
              reply: outcome.text,
              escalation: outcome.escalation,
              draftAfter,
              records: NO_RECORD,
            };
            break;
          }
          case 'leave_returned':
            result = {
              status: 'leave_returned',
              reply: outcome.text,
              card: { kind: 'returned', failedRules: outcome.failedRules },
              escalation: null,
              draftAfter: null,
              records: outcome.gate,
            };
            break;
          case 'policy_answer':
            // spec policy-qa, rule 20: the answer and section ids, copied from the gate output.
            result = {
              status: 'answered',
              reply: outcome.text,
              card: { kind: 'policy_answer', sectionIds: outcome.sectionIds },
              escalation: null,
              draftAfter: null,
              records: outcome.gate,
            };
            break;
          case 'policy_escalate':
            // spec policy-qa, rule 21: only the fixed text; never the draft answer.
            result = {
              status: 'escalated_to_hr',
              reply: outcome.text,
              escalation: outcome.escalation,
              draftAfter: null,
              records: outcome.records,
              policyEscalation: outcome,
            };
            break;
          case 'onboarding':
            // spec onboarding, rules 20, 21: the fixed text, plus ids and a count.
            result = {
              status: outcome.deviations.length === 0 ? 'checklist_created' : 'pending_manager',
              reply: outcome.text,
              card: {
                kind: 'onboarding_checklist',
                checklistId: outcome.checklist.id,
                pendingDeviations: outcome.deviations.length,
              },
              escalation: null,
              draftAfter: null,
              records: outcome.records,
              onboarding: outcome,
            };
            break;
          case 'submit':
            result = {
              status: 'leave_submitted',
              reply: texts.submitted,
              card: {
                kind: 'submitted',
                request: toView(outcome.leave, outcome.item),
                verdict: outcome.card.verdict,
                failedRules: outcome.failedRules,
              },
              escalation: null,
              draftAfter: null,
              records: outcome.records,
              submit: outcome,
            };
            break;
        }
      }

      // ---- build and parse everything before the first write (rule 19) ----
      const now = intake.clock.nowIso();
      const response = ChatResponse.safeParse({
        reply: result.reply,
        ...(result.card === undefined ? {} : { card: result.card }),
        status: result.status,
        requestId: turnId,
        conversationId,
      });
      const storedTurn = {
        requestId: turnId,
        at: now,
        userText: body.message,
        reply: result.reply,
        status: result.status,
        ...(result.card === undefined ? {} : { card: result.card }),
      };
      const task = {
        activeAgent: result.draftAfter === null ? null : ('leave' as const),
        draft: result.draftAfter,
      };
      const next = Conversation.safeParse(
        previous === null
          ? {
              id: conversationId,
              userId: actor.employeeId,
              turns: [storedTurn],
              ...task,
              version: 0,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...previous,
              turns: [...previous.turns, storedTurn],
              ...task,
              version: previous.version + 1,
              updatedAt: now,
            },
      );
      if (!response.success || !next.success) return fail('parse_error');
      const usage = await turnUsage();
      let event: AuditEvent;
      try {
        event = buildEvent({
          outcome: result.status,
          escalation: result.escalation,
          taskActiveAfter: task.activeAgent !== null,
          records: result.records,
          usage,
        });
      } catch {
        return fail('parse_error');
      }

      // ---- writes: request, item, conversation, event (rules 19, 20; D-5) ----
      let removeRecords = (): Promise<void> => Promise.resolve();
      if (result.submit !== undefined) {
        const written = await dispatcher
          .writeRecords(result.submit.leave, result.submit.item)
          .catch(() => ({ ok: false as const, failed: 'request' as const }));
        if (!written.ok) return fail('store_error'); // a failed item already removed the request
        removeRecords = written.undo;
      }
      if (result.policyEscalation !== undefined) {
        // spec policy-qa, rule 22: PolicyQuestion, then item, then the conversation and event.
        const written = await dispatcher
          .writePolicyEscalation(result.policyEscalation.question, result.policyEscalation.item)
          .catch(() => ({ ok: false as const, failed: 'request' as const }));
        if (!written.ok) return fail('store_error'); // a failed item already removed the question
        removeRecords = written.undo;
      }
      if (result.onboarding !== undefined) {
        // spec onboarding, rule 22: checklist, deviations, items, then the conversation and event.
        const { checklist, deviations, items } = result.onboarding;
        const written = await dispatcher
          .writeOnboarding(checklist, deviations, items)
          .catch(() => ({ ok: false as const, failed: 'request' as const }));
        if (!written.ok) return fail('store_error'); // a failed write already removed the rest
        removeRecords = written.undo;
      }
      let saved: boolean;
      try {
        saved =
          previous === null
            ? await conversations.insert(next.data)
            : await conversations.saveIfVersion(next.data, previous.version);
      } catch {
        return fail('store_error', removeRecords);
      }
      if (!saved) {
        if (previous === null) return fail('store_error', removeRecords); // id collision
        // Rule 20: another turn saved first. This one leaves no records.
        await removeRecords();
        await tryEvent('conflict', null);
        throw new HttpError('conversation_conflict');
      }
      try {
        await intake.audit.write(event);
      } catch {
        // D-5: no record outlives its event, and the conversation goes back to its pre-turn state.
        await removeRecords();
        await undo(async () => {
          if (previous === null) {
            await conversations.remove(conversationId, actor.employeeId);
          } else {
            await conversations.saveIfVersion(
              { ...previous, version: previous.version + 2, updatedAt: now },
              previous.version + 1,
            );
          }
        });
        throw internalError();
      }
      return response.data;
    },
  });

  const getConversation = defineRoute({
    method: 'get',
    path: '/conversations/:id',
    params: ConversationParams,
    query: ConversationQuery, // an extra query key is a 400 (rule 6)
    body: EmptyBody,
    response: ConversationView,
    handler: async ({ actor, params }) => {
      const conversation = await conversations.get(params.id, actor.employeeId);
      if (conversation === null) throw new HttpError('not_found'); // rule 5
      const last = conversation.turns.at(-1);
      if (last === undefined) throw internalError(); // Conversation requires at least one turn
      return {
        conversationId: conversation.id,
        turns: conversation.turns,
        status: last.status,
        taskActive: conversation.activeAgent !== null,
      };
    },
  });

  return [postChat, getConversation];
}
