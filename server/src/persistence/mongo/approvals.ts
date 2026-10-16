// ApprovalStore and intake's ApprovalItemWriter on MongoDB (spec mongo-persistence, rule 3;
// request-intake D-2). The status check and the write are one single-document operation.
import { ApprovalItem, type ApprovalStatus } from '../../domain/schemas.js';
import type { ApprovalStore } from '../../http/approvals/ports.js';
import type { ApprovalItemWriter } from '../../intake/ports.js';
import { MODELS } from '../../models/index.js';
import { isDuplicateKey, literal, NO_STORAGE_KEYS, parseAllStored, parseStored } from './read.js';

const COLLECTION = 'approvalItems';

export class MongoApprovalStore implements ApprovalStore, ApprovalItemWriter {
  async list(): Promise<ApprovalItem[]> {
    const docs = await MODELS.ApprovalItem.find({}, NO_STORAGE_KEYS).lean().exec();
    return parseAllStored(ApprovalItem, COLLECTION, docs);
  }

  async get(id: string): Promise<ApprovalItem | null> {
    const doc = await MODELS.ApprovalItem.findOne({ id: literal(id) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    return doc === null ? null : parseStored(ApprovalItem, COLLECTION, doc);
  }

  /** One atomic replace filtered on id and status, so two callers can't both win (rule 3). */
  async saveIfStatus(item: ApprovalItem, expectedStatus: ApprovalStatus): Promise<boolean> {
    const next = ApprovalItem.parse(item);
    const res = await MODELS.ApprovalItem.replaceOne(
      { id: literal(next.id), status: literal(expectedStatus) },
      next,
    ).exec();
    return res.matchedCount === 1;
  }

  /** Adds a new item; false if the id exists (unique index), never overwrites. */
  async insert(item: ApprovalItem): Promise<boolean> {
    try {
      await MODELS.ApprovalItem.create(ApprovalItem.parse(item));
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  /** Compensation only (request-intake D-13). */
  async remove(id: string): Promise<void> {
    await MODELS.ApprovalItem.deleteOne({ id: literal(id) }).exec();
  }
}
