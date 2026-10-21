// PolicyQuestionStore on MongoDB (spec policy-qa, rules 21, 23; DD-20). Matches ids with $eq only,
// so a crafted id can never become a query operator. Storage-only: outside ENTITY_SCHEMAS.
import { PolicyQuestion, type PolicyQuestionStore } from '../../domain/qa.js';
import { PolicyQuestionModel } from './models.js';
import { isDuplicateKey, literal, NO_STORAGE_KEYS, parseStored } from './read.js';

const COLLECTION = 'policyQuestions';

export class MongoPolicyQuestionStore implements PolicyQuestionStore {
  /** Adds a new record; false if the id exists (unique index), never overwrites. */
  async insert(q: PolicyQuestion): Promise<boolean> {
    try {
      await PolicyQuestionModel.create(PolicyQuestion.parse(q));
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async get(id: string): Promise<PolicyQuestion | null> {
    const doc = await PolicyQuestionModel.findOne({ id: literal(id) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    return doc === null ? null : parseStored(PolicyQuestion, COLLECTION, doc);
  }

  /** Compensation only (rule 22). */
  async remove(id: string): Promise<void> {
    await PolicyQuestionModel.deleteOne({ id: literal(id) }).exec();
  }
}
