// Chat schemas (spec chat-endpoint, "Inputs and outputs"; rules 3, 6, 7, 21, 22; D-4, D-6, D-7).
// Every route body and response is .strict(). No response carries the draft, the card summary,
// model text other than a validated reply, injectionSuspected or audit data. The Conversation
// document is storage-only and sits outside ENTITY_SCHEMAS (domain-schemas AT-1).
import { z } from 'zod';
import { ClarifyingQuestion, RouteLabel } from '../agents/orchestrator/schemas.js';
import { MAX_USER_TEXT_CHARS } from '../agents/schemas.js';
import { QaVerdict, SectionId } from '../domain/qa.js';
import { Id, IsoDateTime, LeaveVerdict, Role } from '../domain/schemas.js';
import { DispatchEscalation, FailedRule, MyRequestView } from '../intake/schemas.js';

// ---- POST /chat body (rule 3) ----
export const ChatBody = z
  .object({
    conversationId: Id.optional(), // absent = start a new conversation (rule 8)
    message: z.string().trim().min(1).max(MAX_USER_TEXT_CHARS),
  })
  .strict(); // no idempotencyKey (D-4), employeeId, role, activeAgent, draft, approved, ...
export type ChatBody = z.infer<typeof ChatBody>;

// ---- status and card (rule 21) ----
export const ChatStatus = z.enum([
  'reply',
  'question',
  'leave_submitted',
  'leave_returned',
  'escalated',
  'retry', // model_unavailable only (rule 17)
  'answered', // a gate-approved policy answer (spec policy-qa, rule 20)
  'escalated_to_hr', // a policy question passed to HR, with a PolicyQuestion and item (rule 21)
]);
export type ChatStatus = z.infer<typeof ChatStatus>;

export const ChatCard = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('submitted'),
      request: MyRequestView,
      verdict: LeaveVerdict, // copied from the card, which copied the gate
      failedRules: z.array(FailedRule),
    })
    .strict(),
  z.object({ kind: z.literal('returned'), failedRules: z.array(FailedRule) }).strict(),
  // spec policy-qa, rule 20: the section ids are copied from the Q&A gate output
  z.object({ kind: z.literal('policy_answer'), sectionIds: z.array(SectionId).min(1) }).strict(),
]); // never the RecommendationCard: no summary, policyHash, model or promptVersion
export type ChatCard = z.infer<typeof ChatCard>;

const CARD_KIND_FOR_STATUS: Partial<Record<ChatStatus, ChatCard['kind']>> = {
  leave_submitted: 'submitted',
  leave_returned: 'returned',
  answered: 'policy_answer',
};

/** A card is present iff the status maps to a card kind, and it is of that kind. */
function cardMatchesStatus(r: { status: ChatStatus; card?: ChatCard | undefined }): boolean {
  const expected = CARD_KIND_FOR_STATUS[r.status];
  return expected === undefined ? r.card === undefined : r.card?.kind === expected;
}

export const ChatResponse = z
  .object({
    reply: z.string().min(1),
    card: ChatCard.optional(),
    status: ChatStatus,
    requestId: Id, // this turn's id (rule 9)
    conversationId: Id,
  })
  .strict()
  .refine(cardMatchesStatus, { path: ['card'], error: 'card does not match status' });
export type ChatResponse = z.infer<typeof ChatResponse>;

// ---- GET /conversations/:id (rule 6) ----
export const ConversationParams = z.object({ id: Id }).strict();
export const ConversationQuery = z.object({}).strict();

export const ConversationTurnView = z
  .object({
    requestId: Id,
    at: IsoDateTime,
    userText: z.string(), // the trimmed message as the user sent it
    reply: z.string().min(1), // exactly the reply returned for that turn
    status: ChatStatus,
    card: ChatCard.optional(), // snapshot; live status comes from GET /my-requests
  })
  .strict()
  .refine(cardMatchesStatus, { path: ['card'], error: 'card does not match status' });
export type ConversationTurnView = z.infer<typeof ConversationTurnView>;

export const ConversationView = z
  .object({
    conversationId: Id,
    turns: z.array(ConversationTurnView), // oldest first
    status: ChatStatus, // the last turn's status
    taskActive: z.boolean(),
  })
  .strict(); // no userId, draft, agent name, version or audit data
export type ConversationView = z.infer<typeof ConversationView>;

// ---- stored conversation (rule 7; D-7) ----
export const MAX_TURNS = 50; // retry turns count; no separate document size limit

export const LeaveDraft = z
  .object({
    messages: z.array(z.string().trim().min(1).max(MAX_USER_TEXT_CHARS)).min(1),
    lastQuestion: ClarifyingQuestion,
  })
  .strict();
export type LeaveDraft = z.infer<typeof LeaveDraft>;

export const ConversationTurn = ConversationTurnView; // same shape stored and shown
export type ConversationTurn = ConversationTurnView;

export const Conversation = z
  .object({
    id: Id,
    userId: Id, // actor.employeeId at creation; never from the body
    turns: z.array(ConversationTurn).min(1).max(MAX_TURNS),
    activeAgent: z.literal('leave').nullable(),
    draft: LeaveDraft.nullable(),
    version: z.number().int().min(0), // +1 on every successful save (rule 20)
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .strict()
  .refine((c) => (c.activeAgent === null) === (c.draft === null), {
    path: ['draft'],
    error: 'activeAgent and draft are both set or both null',
  });
export type Conversation = z.infer<typeof Conversation>;

// ---- fixed texts (rules 13, 17, 21): prompts/chat/messages/<key>.txt ----
export const ChatTextKey = z.enum(['retry', 'submitted', 'draft_too_long', 'draft_template']);
export type ChatTextKey = z.infer<typeof ChatTextKey>;

// ---- chat-turn audit payload (rule 22; D-6) ----
export const ChatEscalationCode = z.enum([
  'agent_error',
  'text_missing',
  'parse_error',
  'store_error',
  'draft_too_long',
  'hand_back_fresh',
  'model_unavailable',
  'conversation_full',
]);
export type ChatEscalationCode = z.infer<typeof ChatEscalationCode>;

export const ChatTurnPayload = z
  .object({
    kind: z.literal('chat_turn'),
    requestId: Id,
    conversationId: Id,
    conversationCreated: z.boolean(),
    mode: z.enum(['classify', 'continue']),
    handedBack: z.boolean(),
    actorRole: Role,
    label: RouteLabel.nullable(),
    routingSource: z.enum(['model', 'fallback']).nullable(),
    leaveResult: z.enum(['card', 'needs_details', 'escalated', 'hand_back']).nullable(),
    outcome: z.enum([...ChatStatus.options, 'conflict', 'internal_error']),
    // Closed (D-10): a ChatEscalationCode or a dispatcher code, never free text.
    escalation: z.union([ChatEscalationCode, DispatchEscalation]).nullable(),
    handedBackFrom: Id.nullable(), // D-10: the continuation run's trace id on a hand-back turn
    taskActiveBefore: z.boolean(),
    taskActiveAfter: z.boolean(),
    draftMessageCount: z.number().int().nonnegative(), // a count only, never text
    leaveRequestId: Id.nullable(),
    approvalItemId: Id.nullable(),
    assigneeRole: z.enum(['manager', 'hr_admin']).nullable(),
    assigneeId: Id.nullable(),
    flagged: z.boolean().nullable(),
    verdict: LeaveVerdict.nullable(), // copied from the card
    policyVersion: z.string().nullable(), // copied from the card
    policyHash: z.string().nullable(), // copied from the card; unredacted (leave-agent D-16)
    qaVerdict: QaVerdict.nullable(), // copied from the Q&A gate (spec policy-qa, rule 25)
    policyQuestionId: Id.nullable(),
    injectionSuspected: z.boolean(), // OR over every agent run in the turn
  })
  .strict(); // no user text, reply, draft, question or reason
export type ChatTurnPayload = z.infer<typeof ChatTurnPayload>;
