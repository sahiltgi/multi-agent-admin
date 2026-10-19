// MongoDB connection, indexes and the store set (spec mongo-persistence, rules 3–7 and 10;
// D-3, D-4, D-8). Errors may carry the URI; the caller scrubs them before printing (rule 14).
import mongoose, { type Model } from 'mongoose';
import type { AuditSink } from '../../agents/audit.js';
import type { ConversationStore } from '../../chat/ports.js';
import type { LeaveDataPort } from '../../agents/leave/port.js';
import type {
  ApprovalStore,
  AuditReader,
  EmployeeDirectory,
  SubjectResolver,
} from '../../http/approvals/ports.js';
import type {
  ApprovalItemWriter,
  IdempotencyStore,
  LeaveRequestStore,
} from '../../intake/ports.js';
import { MODELS } from '../../models/index.js';
import { MongoApprovalStore } from './approvals.js';
import { MongoAuditStore } from './audit.js';
import { MongoConversationStore } from './conversations.js';
import { MongoEmployeeDirectory } from './directory.js';
import { MongoIdempotencyStore } from './idempotency.js';
import { MongoLeaveDataPort } from './leave-data.js';
import { MongoLeaveRequestStore } from './leave-requests.js';
import { ConversationModel, IdempotencyRecordModel, MessageOwnerModel } from './models.js';

export interface ServerStores {
  directory: EmployeeDirectory;
  approvals: ApprovalStore & ApprovalItemWriter;
  leaveRequests: LeaveRequestStore & SubjectResolver;
  audit: AuditSink & AuditReader;
  idempotency: IdempotencyStore;
  leaveData: LeaveDataPort;
  conversations: ConversationStore; // chat-endpoint rule 25
}

export interface MongoHandle {
  stores: ServerStores;
  /** Intake-created requests with no approval item, left by a crash mid-write (D-3). */
  countOrphans(): Promise<number>;
  close(): Promise<void>;
}

// D-8: fail fast instead of queueing when MongoDB is unreachable; no app-level retry loop.
const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 5_000,
  socketTimeoutMS: 10_000,
  bufferCommands: false,
  autoIndex: false, // indexes are built once below, with syncIndexes (D-4)
} as const;

const ALL_MODELS: readonly Model<never>[] = [
  ...Object.values(MODELS),
  MessageOwnerModel,
  IdempotencyRecordModel,
  ConversationModel,
] as unknown as readonly Model<never>[];

// The unique indexes rules 3–7 rely on. Startup refuses to serve without them (D-4).
const REQUIRED_UNIQUE: readonly { model: Model<never>; key: string }[] = [
  { model: MODELS.ApprovalItem as unknown as Model<never>, key: 'id' },
  { model: MODELS.LeaveRequest as unknown as Model<never>, key: 'id' },
  { model: MODELS.AuditEvent as unknown as Model<never>, key: 'id' },
  { model: MODELS.Employee as unknown as Model<never>, key: 'id' },
  { model: MessageOwnerModel as unknown as Model<never>, key: 'requestId' },
  { model: IdempotencyRecordModel as unknown as Model<never>, key: 'employeeId,key' },
  { model: ConversationModel as unknown as Model<never>, key: 'id' },
];

async function assertUniqueIndexes(): Promise<void> {
  for (const { model, key } of REQUIRED_UNIQUE) {
    const indexes = (await model.listIndexes()) as {
      key: Record<string, unknown>;
      unique?: boolean;
    }[];
    const found = indexes.some((ix) => ix.unique === true && Object.keys(ix.key).join(',') === key);
    if (!found) throw new Error(`missing unique index on ${model.collection.name} (${key})`);
  }
}

function stores(): ServerStores {
  return {
    directory: new MongoEmployeeDirectory(),
    approvals: new MongoApprovalStore(),
    leaveRequests: new MongoLeaveRequestStore(),
    audit: new MongoAuditStore(),
    idempotency: new MongoIdempotencyStore(),
    leaveData: new MongoLeaveDataPort(),
    conversations: new MongoConversationStore(),
  };
}

async function countOrphans(): Promise<number> {
  const rows = await MessageOwnerModel.aggregate<{ n: number }>([
    {
      $lookup: { from: 'leaveRequests', localField: 'requestId', foreignField: 'id', as: 'leave' },
    },
    { $match: { 'leave.0': { $exists: true } } },
    {
      $lookup: {
        from: 'approvalItems',
        localField: 'requestId',
        foreignField: 'subjectId',
        as: 'items',
      },
    },
    { $match: { 'items.0': { $exists: false } } },
    { $count: 'n' },
  ]).exec();
  return rows[0]?.n ?? 0;
}

/** Connects, builds every index (D-4), checks the unique ones, and returns the stores. */
export async function connectMongo(uri: string): Promise<MongoHandle> {
  await mongoose.connect(uri, CONNECT_OPTIONS);
  try {
    for (const model of ALL_MODELS) await model.syncIndexes();
    await assertUniqueIndexes();
  } catch (err) {
    await mongoose.disconnect();
    throw err;
  }
  return {
    stores: stores(),
    countOrphans,
    close: () => mongoose.disconnect(),
  };
}
