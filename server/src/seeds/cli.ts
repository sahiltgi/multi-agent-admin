// Entry point for `npm run seed`. `.env` is loaded by Node's --env-file-if-exists flag.
import mongoose from 'mongoose';
import { MODELS } from '../models/index.js';
import {
  ConversationModel,
  IdempotencyRecordModel,
  MessageOwnerModel,
  OnboardingDeviationModel,
  PolicyQuestionModel,
} from '../persistence/mongo/models.js';
import { fixtures } from './fixtures.js';
import {
  runSeed,
  type SeedClearedCollection,
  type SeedCollection,
  type SeedWriter,
} from './seed.js';

const MODEL_FOR = {
  teams: MODELS.Team,
  employees: MODELS.Employee,
  leaveBalances: MODELS.LeaveBalance,
  holidays: MODELS.Holiday,
  leaveRequests: MODELS.LeaveRequest,
} as const satisfies Record<SeedCollection, unknown>;

// Audit events are never cleared: AuditEventModel is append-only (spec mongo-persistence, D-15).
const CLEARED_MODEL = {
  approvalItems: MODELS.ApprovalItem,
  messageOwners: MessageOwnerModel,
  idempotencyRecords: IdempotencyRecordModel,
  conversations: ConversationModel,
  policyQuestions: PolicyQuestionModel,
  onboardingChecklists: MODELS.OnboardingChecklist, // spec onboarding (OQ-14)
  onboardingDeviations: OnboardingDeviationModel,
} as const satisfies Record<SeedClearedCollection, unknown>;

/** The model methods the seed needs. Docs were Zod-parsed by runSeed before they get here. */
interface SeedModel {
  createIndexes(): Promise<unknown>;
  deleteMany(filter: Record<string, never>): { exec(): Promise<unknown> };
  insertMany(docs: unknown[], options: { ordered: boolean }): Promise<unknown>;
}

const writer: SeedWriter = {
  async connect(uri) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
  },
  async clear(collection) {
    const model: Pick<SeedModel, 'deleteMany'> = CLEARED_MODEL[collection];
    await model.deleteMany({}).exec();
  },
  async replaceAll(collection, docs) {
    const model: SeedModel = MODEL_FOR[collection];
    await model.createIndexes();
    await model.deleteMany({}).exec();
    await model.insertMany([...docs], { ordered: true });
  },
  async disconnect() {
    await mongoose.disconnect();
  },
};

process.exitCode = await runSeed({
  env: process.env,
  fixtures,
  writer,
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
});
