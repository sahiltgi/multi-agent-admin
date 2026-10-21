// Storage-only records for the three non-entity collections (spec mongo-persistence, rules 5 and 6;
// D-10, D-16). They live here, outside ENTITY_SCHEMAS and MODELS, which keep exactly 8 keys.
import { Schema, model } from 'mongoose';
import { z } from 'zod';
import { Id, IsoDateTime } from '../../domain/schemas.js';
import { IDEMPOTENCY_KEY } from '../../intake/schemas.js';

const TOP_LEVEL = { id: false, strict: 'throw', timestamps: false } as const;

// ---- MessageOwner: who sent a message, so its trace resolves with no LeaveRequest (rule 5) ----
export const MessageOwner = z.object({ requestId: Id, employeeId: Id }).strict();
export type MessageOwner = z.infer<typeof MessageOwner>;

const messageOwnerSchema = new Schema<MessageOwner>(
  {
    requestId: { type: String, required: true, unique: true },
    employeeId: { type: String, required: true },
  },
  { ...TOP_LEVEL, collection: 'messageOwners' },
);
export const MessageOwnerModel = model<MessageOwner>('MessageOwner', messageOwnerSchema);

// ---- IdempotencyRecord: a hash of the text, never the text (rule 6, D-16) ----
export const IdempotencyDone = z.object({ status: z.number().int(), body: z.unknown() }).strict();

export const IdempotencyRecord = z
  .object({
    employeeId: Id,
    key: z.string().regex(IDEMPOTENCY_KEY),
    textHash: z.string().regex(/^[a-f0-9]{64}$/),
    claimedAt: IsoDateTime, // the caller's nowIso
    expiresAt: z.date(), // claimedAt + 24 h; read only by the TTL reaper, never for liveness
    done: IdempotencyDone.nullable(), // null while the first request is in flight
  })
  .strict();
export type IdempotencyRecord = z.infer<typeof IdempotencyRecord>;

const idempotencyRecordSchema = new Schema<IdempotencyRecord>(
  {
    employeeId: { type: String, required: true },
    key: { type: String, required: true },
    textHash: { type: String, required: true },
    claimedAt: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    done: { type: Schema.Types.Mixed, default: null },
  },
  { ...TOP_LEVEL, collection: 'idempotencyRecords', minimize: false },
);
idempotencyRecordSchema.index({ employeeId: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // D-16
export const IdempotencyRecordModel = model<IdempotencyRecord>(
  'IdempotencyRecord',
  idempotencyRecordSchema,
);

// ---- Conversation (spec chat-endpoint rule 7; mongo-persistence D-10 amendment) ----
// The Zod schema lives in chat/schemas.ts and is applied on every write and read; nested turns and
// the draft are stored as given, so Mongoose never coerces them.
interface StoredConversation {
  id: string;
  userId: string;
  turns: unknown[];
  activeAgent: string | null;
  draft: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const conversationSchema = new Schema<StoredConversation>(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    turns: { type: [Schema.Types.Mixed], required: true },
    activeAgent: { type: String, default: null },
    draft: { type: Schema.Types.Mixed, default: null },
    version: { type: Number, required: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { ...TOP_LEVEL, collection: 'conversations', minimize: false },
);
conversationSchema.index({ id: 1, userId: 1 });
export const ConversationModel = model<StoredConversation>('Conversation', conversationSchema);

// ---- PolicyQuestion (spec policy-qa, rule 21; DD-20) ----
// The Zod schema lives in domain/qa.ts and is applied on every write and read; the gate result is
// stored as given, so Mongoose never coerces it.
interface StoredPolicyQuestion {
  id: string;
  employeeId: string;
  question: string;
  draftAnswer: string | null;
  escalation: string;
  gateResult: unknown;
  policyVersion: string;
  policyHash: string;
  handbookHash: string;
  createdAt: string;
}

const policyQuestionSchema = new Schema<StoredPolicyQuestion>(
  {
    id: { type: String, required: true, unique: true },
    employeeId: { type: String, required: true },
    question: { type: String, required: true },
    draftAnswer: { type: String, default: null },
    escalation: { type: String, required: true },
    gateResult: { type: Schema.Types.Mixed, default: null },
    policyVersion: { type: String, required: true },
    policyHash: { type: String, required: true },
    handbookHash: { type: String, required: true },
    createdAt: { type: String, required: true },
  },
  { ...TOP_LEVEL, collection: 'policyQuestions', minimize: false },
);
export const PolicyQuestionModel = model<StoredPolicyQuestion>(
  'PolicyQuestion',
  policyQuestionSchema,
);
