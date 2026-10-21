// Shared dispatcher for POST /messages and POST /chat (spec chat-endpoint rule 10; request-intake
// rules 6–13, D-5 to D-18). decide() runs the orchestrator and/or the Leave Agent and returns a
// typed outcome; it writes nothing but the agents' own audit events. writeRecords() is the D-13
// write sequence. Every verdict-derived value is copied from the card, which copied it from the
// gate. Nothing here approves or rejects (HARD RULE 1), and model text never picks a branch.
import { z } from 'zod';
import { LeaveAgentResult, type RecommendationCard } from '../agents/leave/schemas.js';
import { PolicyQaResult, type QaFailureReason } from '../agents/policy_qa/schemas.js';
import {
  ClarifyingQuestion,
  OrchestratorFailure,
  RoutingDecision,
  type RouteLabel,
} from '../agents/orchestrator/schemas.js';
import { PolicyQuestion, type PolicyQuestion as PolicyQuestionT } from '../domain/qa.js';
import {
  ApprovalItem,
  LeaveRequest,
  type ApprovalItem as ApprovalItemT,
  type LeaveRequest as LeaveRequestT,
} from '../domain/schemas.js';
import type { Actor } from '../http/identity.js';
import type { IntakeDeps } from './ports.js';
import type { DispatchEscalation, FailedRule, IntakePayload, MyRequestView } from './schemas.js';

/** The record and gate fields shared by IntakePayload and the chat-turn payload. */
export type RecordParts = Pick<
  IntakePayload,
  | 'leaveRequestId'
  | 'approvalItemId'
  | 'assigneeRole'
  | 'assigneeId'
  | 'flagged'
  | 'verdict'
  | 'policyVersion'
  | 'policyHash'
  | 'qaVerdict'
  | 'policyQuestionId'
>;

export const NO_RECORD: RecordParts = {
  leaveRequestId: null,
  approvalItemId: null,
  assigneeRole: null,
  assigneeId: null,
  flagged: null,
  verdict: null,
  policyVersion: null,
  policyHash: null,
  qaVerdict: null,
  policyQuestionId: null,
};

/** Runs one compensating removal; a failure there must not stop the next one (D-13). */
export async function undo(step: () => Promise<void>): Promise<void> {
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

export function toView(leave: LeaveRequestT, item: ApprovalItemT | null): MyRequestView {
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
    // 'resolve' only ever closes an escalation item (domain ApprovalItem refine), never a leave item.
    decision:
      decision === undefined || decision.action === 'resolve'
        ? null
        : {
            action: decision.action,
            ...(decision.comment === undefined ? {} : { comment: decision.comment }),
            at: decision.at,
          },
    createdAt: leave.createdAt,
  };
}

/** What the agents did in this message, for the caller's audit payload. */
export interface Routing {
  label: RouteLabel | null; // null when classify didn't run or failed
  routingSource: 'model' | 'fallback' | null;
  leaveResult: LeaveAgentResult['kind'] | null; // the Leave run's result kind, if one ran
  injectionSuspected: boolean; // audit only (request-intake rule 16)
}

export type Outcome =
  | {
      kind: 'reply';
      label: 'prohibited' | 'out_of_scope' | 'onboarding' | 'leave';
      text: string;
      gate: RecordParts;
    }
  /** The Q&A gate said AUTO_ANSWER: the answer and section ids, copied (spec policy-qa, rule 20). */
  | { kind: 'policy_answer'; text: string; sectionIds: string[]; gate: RecordParts }
  /** A Q&A escalation: both records built and parsed, not yet written (rules 21, 22). */
  | {
      kind: 'policy_escalate';
      question: PolicyQuestionT;
      item: ApprovalItemT;
      text: string;
      escalation: DispatchEscalation;
      records: RecordParts;
    }
  | {
      kind: 'question';
      label: 'unclear' | 'leave';
      text: string;
      escalation: DispatchEscalation | null;
    }
  | { kind: 'leave_returned'; text: string; failedRules: FailedRule[]; gate: RecordParts }
  | {
      kind: 'submit';
      leave: LeaveRequestT;
      item: ApprovalItemT;
      card: RecommendationCard;
      failedRules: FailedRule[];
      records: RecordParts;
    }
  /** Escalation path (request-intake rule 13, D-5); text is null when its file is missing. */
  | { kind: 'escalate'; escalation: DispatchEscalation; text: string | null }
  /** A continuation run handed the message back (chat-endpoint rule 14). */
  | { kind: 'hand_back' }
  /** An agent's API call failed and the caller asked for retries (chat-endpoint rule 17). */
  | { kind: 'model_unavailable' }
  /** The orchestrator could not audit: write nothing further (agent-runtime D-14). */
  | { kind: 'audit_failed' }
  /** An agent port threw. */
  | { kind: 'agent_error' }
  /** A record built by code failed to parse: a code bug, so nothing is written (rule 12). */
  | { kind: 'parse_error' };

export type DispatchMode =
  { kind: 'classify'; text: string } | { kind: 'continue_leave'; userText: string };

export interface DispatchOptions {
  /** /chat: an API failure is a retry. /messages keeps request-intake behaviour (rule 16). */
  retryOnModelUnavailable: boolean;
}

export type WriteResult =
  { ok: true; undo: () => Promise<void> } | { ok: false; failed: 'request' | 'item' };

export interface Dispatcher {
  decide(
    actor: Actor,
    requestId: string,
    mode: DispatchMode,
    opts: DispatchOptions,
  ): Promise<{ outcome: Outcome; routing: Routing }>;
  writeRecords(leave: LeaveRequestT, item: ApprovalItemT): Promise<WriteResult>;
  /** PolicyQuestion, then item; a failed item removes the question (spec policy-qa, rule 22). */
  writePolicyEscalation(question: PolicyQuestionT, item: ApprovalItemT): Promise<WriteResult>;
}

const AgentDecision = z.union([RoutingDecision, OrchestratorFailure]);

export function createDispatcher(deps: IntakeDeps): Dispatcher {
  async function decide(
    actor: Actor,
    requestId: string,
    mode: DispatchMode,
    opts: DispatchOptions,
  ): Promise<{ outcome: Outcome; routing: Routing }> {
    const routing: Routing = {
      label: null,
      routingSource: null,
      leaveResult: null,
      injectionSuspected: false,
    };
    const out = (outcome: Outcome) => ({ outcome, routing });
    const escalate = async (escalation: DispatchEscalation) =>
      out({ kind: 'escalate', escalation, text: await deps.texts.load('escalated') });

    // ---- orchestrator, at most once (rule 7); skipped for a continuation (chat rule 12) ----
    let userText: string;
    if (mode.kind === 'classify') {
      let rawDecision: unknown;
      try {
        rawDecision = await deps.classify({
          requestId,
          agentId: 'orchestrator',
          actor,
          userText: mode.text,
          documents: [],
        });
      } catch {
        return out({ kind: 'agent_error' });
      }
      // Port output is parsed, never trusted: anything else is escalated (rule 7, HARD RULE 6).
      const parsedDecision = AgentDecision.safeParse(rawDecision);
      if (!parsedDecision.success) return escalate('invalid_agent_output');
      const decision = parsedDecision.data;
      if (decision.requestId !== requestId) return escalate('request_id_mismatch'); // rule 6
      if ('outcome' in decision) {
        if (decision.code === 'audit_failed') return out({ kind: 'audit_failed' });
        return escalate(decision.code);
      }
      routing.label = decision.label;
      routing.routingSource = decision.source;
      if (opts.retryOnModelUnavailable && decision.fallbackReason === 'model_unavailable') {
        return out({ kind: 'model_unavailable' });
      }

      switch (decision.label) {
        case 'policy_qa':
          return out(await policyQa(actor, requestId, mode.text, opts, routing));
        case 'onboarding': {
          const fixed = await deps.texts.load('not_available');
          if (fixed === null) return escalate('text_missing');
          return out({ kind: 'reply', label: decision.label, text: fixed, gate: NO_RECORD });
        }
        case 'prohibited':
        case 'out_of_scope':
          return out({
            kind: 'reply',
            label: decision.label,
            text: decision.reply,
            gate: NO_RECORD,
          });
        case 'unclear':
          return out({
            kind: 'question',
            label: 'unclear',
            text: decision.clarifyingQuestion,
            escalation: null,
          });
        case 'leave':
          break;
      }
      userText = mode.text;
    } else {
      userText = mode.userText;
    }

    // ---- Leave Agent, once (rule 8) ----
    let rawResult: unknown;
    try {
      rawResult = await deps.runLeave({
        requestId,
        agentId: 'leave',
        actor,
        userText,
        documents: [],
      });
    } catch {
      return out({ kind: 'agent_error' });
    }
    const parsedResult = LeaveAgentResult.safeParse(rawResult);
    if (!parsedResult.success) return escalate('invalid_agent_output');
    const result = parsedResult.data;
    const resultRequestId = result.kind === 'card' ? result.card.requestId : result.requestId;
    if (resultRequestId !== requestId) return escalate('request_id_mismatch'); // rule 6
    // Audit only: the flag never changes the records, the assignee or the response (rule 16).
    routing.injectionSuspected = result.injectionSuspected;
    routing.leaveResult = result.kind;

    if (result.kind === 'needs_details') {
      return out({ kind: 'question', label: 'leave', text: result.question, escalation: null });
    }
    if (result.kind === 'hand_back') {
      if (mode.kind === 'continue_leave') return out({ kind: 'hand_back' });
      // chat-endpoint D-1: a fresh run that hands back is low confidence. One fixed question;
      // classify never runs again, no task opens and nothing is written.
      const question = await deps.texts.load('hand_back');
      if (question === null || !ClarifyingQuestion.safeParse(question).success) {
        return escalate('text_missing');
      }
      return out({
        kind: 'question',
        label: 'unclear',
        text: question,
        escalation: 'hand_back_fresh',
      });
    }
    if (result.kind === 'escalated') {
      if (opts.retryOnModelUnavailable && result.reason === 'model_unavailable') {
        return out({ kind: 'model_unavailable' });
      }
      return escalate(result.reason);
    }

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
      const fixed = await deps.texts.load('returned');
      if (fixed === null) return escalate('text_missing');
      return out({ kind: 'leave_returned', text: fixed, failedRules, gate: cardGate(card) });
    }
    if (actor.role === 'hr_admin') {
      // D-7: nobody else could act on an hr_admin's own leave, so nothing is persisted.
      const fixed = await deps.texts.load('hr_admin_self');
      if (fixed === null) return escalate('text_missing');
      return out({ kind: 'reply', label: 'leave', text: fixed, gate: cardGate(card) });
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
    if (!item.success) return out({ kind: 'parse_error' });

    return out({
      kind: 'submit',
      leave: leave.data,
      item: item.data,
      card,
      failedRules,
      records: {
        ...cardGate(card),
        leaveRequestId: requestId,
        approvalItemId: item.data.id,
        assigneeRole: assignee.assigneeRole,
        assigneeId: assignee.assigneeId ?? null,
        flagged,
      },
    });
  }

  /**
   * The Policy Q&A Agent, once (spec policy-qa, rules 19-21). Its verdict is copied from the
   * gate output it carries; nothing here reads model text to pick a branch.
   */
  async function policyQa(
    actor: Actor,
    requestId: string,
    question: string,
    opts: DispatchOptions,
    routing: Routing,
  ): Promise<Outcome> {
    const escalated = async (escalation: DispatchEscalation): Promise<Outcome> => ({
      kind: 'escalate',
      escalation,
      text: await deps.texts.load('escalated'),
    });
    let raw: unknown;
    try {
      raw = await deps.runPolicyQa({ requestId, actor, question });
    } catch {
      return { kind: 'agent_error' };
    }
    const parsed = PolicyQaResult.safeParse(raw);
    if (!parsed.success) return escalated('invalid_agent_output');
    const result = parsed.data;
    if (result.requestId !== requestId) return escalated('request_id_mismatch'); // rule 6
    routing.injectionSuspected = result.injectionSuspected; // audit only

    let failure: Exclude<QaFailureReason, 'audit_failed' | 'model_unavailable'> | null = null;
    if (result.kind === 'failed') {
      if (result.reason === 'audit_failed') return { kind: 'audit_failed' };
      if (result.reason === 'model_unavailable') {
        // DD-17: an outage is a retry on /chat and the intake escalation text on /messages,
        // with no HR item, so an API outage doesn't flood the queue.
        return opts.retryOnModelUnavailable
          ? { kind: 'model_unavailable' }
          : escalated('model_unavailable');
      }
      failure = result.reason;
    }
    const gate = result.kind === 'gated' ? result.gate : null;
    const gateParts: RecordParts = {
      ...NO_RECORD,
      qaVerdict: gate?.verdict ?? null,
      policyVersion: result.provenance.policyVersion,
      policyHash: result.provenance.policyHash,
    };
    if (result.kind === 'gated' && result.gate.verdict === 'AUTO_ANSWER') {
      return {
        kind: 'policy_answer',
        text: result.answerText,
        sectionIds: result.gate.sectionIds,
        gate: gateParts,
      };
    }

    // ---- escalation: build and parse both records before any write (rule 22) ----
    const text = await deps.qaTexts.load('escalated');
    if (text === null) return { kind: 'escalate', escalation: 'text_missing', text: null };
    const createdAt = deps.clock.nowIso();
    const record = PolicyQuestion.safeParse({
      id: requestId,
      employeeId: actor.employeeId, // never from the body or the text
      question,
      draftAnswer: result.answerText,
      escalation: failure ?? 'gate',
      gateResult: gate,
      policyVersion: result.provenance.policyVersion,
      policyHash: result.provenance.policyHash,
      handbookHash: result.provenance.handbookHash,
      createdAt,
    });
    const item = ApprovalItem.safeParse({
      id: deps.idGen(),
      kind: 'escalation',
      subjectId: requestId,
      assigneeRole: 'hr_admin', // the "own" grant never applies to escalation items (rule 23)
      flagged: false,
      status: 'open',
      createdAt,
    });
    if (!record.success || !item.success) return { kind: 'parse_error' };
    const escalation: DispatchEscalation = failure ?? 'qa_gate';
    return {
      kind: 'policy_escalate',
      question: record.data,
      item: item.data,
      text,
      escalation,
      records: {
        ...gateParts,
        approvalItemId: item.data.id,
        assigneeRole: 'hr_admin',
        flagged: false,
        policyQuestionId: record.data.id,
      },
    };
  }

  /** PolicyQuestion, then item; a failed item removes the question. A throwing first insert propagates. */
  async function writePolicyEscalation(
    question: PolicyQuestionT,
    item: ApprovalItemT,
  ): Promise<WriteResult> {
    if (!(await deps.policyQuestions.insert(question))) return { ok: false, failed: 'request' };
    const itemWritten = await deps.approvals.insert(item).catch(() => false);
    if (!itemWritten) {
      await undo(() => deps.policyQuestions.remove(question.id));
      return { ok: false, failed: 'item' };
    }
    return {
      ok: true,
      undo: async () => {
        await undo(() => deps.approvals.remove(item.id));
        await undo(() => deps.policyQuestions.remove(question.id));
      },
    };
  }

  /** Request, then item; a failed item removes the request (D-13). A throwing request insert propagates. */
  async function writeRecords(leave: LeaveRequestT, item: ApprovalItemT): Promise<WriteResult> {
    if (!(await deps.leaveRequests.insert(leave))) return { ok: false, failed: 'request' };
    // A rejected insert counts the same as a refused one.
    const itemWritten = await deps.approvals.insert(item).catch(() => false);
    if (!itemWritten) {
      await undo(() => deps.leaveRequests.remove(leave.id));
      return { ok: false, failed: 'item' };
    }
    return {
      ok: true,
      // Each removal runs even if the one before it fails, so no record outlives its event.
      undo: async () => {
        await undo(() => deps.approvals.remove(item.id));
        await undo(() => deps.leaveRequests.remove(leave.id));
      },
    };
  }

  return { decide, writeRecords, writePolicyEscalation };
}
