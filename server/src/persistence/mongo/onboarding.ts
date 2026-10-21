// OnboardingStore on MongoDB (spec onboarding, rules 21–25; mongo-persistence amendment, OQ-14).
// Matches ids with $eq only, so a crafted id can never become a query operator. Conditional
// writes replace a document only while its version or status is still the expected one.
import {
  OnboardingChecklist,
  OnboardingDeviation,
  type DeviationStatus,
  type OnboardingStore,
} from '../../domain/onboarding.js';
import { MODELS } from '../../models/index.js';
import { OnboardingDeviationModel } from './models.js';
import { isDuplicateKey, literal, NO_STORAGE_KEYS, parseAllStored, parseStored } from './read.js';

const CHECKLISTS = 'onboardingChecklists';
const DEVIATIONS = 'onboardingDeviations';

export class MongoOnboardingStore implements OnboardingStore {
  /** Adds a new checklist; false if the id exists (unique index), never overwrites. */
  async insertChecklist(c: OnboardingChecklist): Promise<boolean> {
    try {
      await MODELS.OnboardingChecklist.create(OnboardingChecklist.parse(c));
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async getChecklist(id: string): Promise<OnboardingChecklist | null> {
    const doc = await MODELS.OnboardingChecklist.findOne({ id: literal(id) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    return doc === null ? null : parseStored(OnboardingChecklist, CHECKLISTS, doc);
  }

  async saveChecklistIfVersion(c: OnboardingChecklist, expectedVersion: number): Promise<boolean> {
    const parsed = OnboardingChecklist.parse(c);
    const replaced = await MODELS.OnboardingChecklist.findOneAndReplace(
      { id: literal(parsed.id), version: { $eq: expectedVersion } },
      parsed,
    )
      .lean()
      .exec();
    return replaced !== null;
  }

  /** Compensation only (rule 22). */
  async removeChecklist(id: string): Promise<void> {
    await MODELS.OnboardingChecklist.deleteOne({ id: literal(id) }).exec();
  }

  /** Adds a new deviation; false if the id exists (unique index), never overwrites. */
  async insertDeviation(d: OnboardingDeviation): Promise<boolean> {
    try {
      await OnboardingDeviationModel.create(OnboardingDeviation.parse(d));
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async getDeviation(id: string): Promise<OnboardingDeviation | null> {
    const doc = await OnboardingDeviationModel.findOne({ id: literal(id) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    return doc === null ? null : parseStored(OnboardingDeviation, DEVIATIONS, doc);
  }

  async saveDeviationIfStatus(d: OnboardingDeviation, expected: DeviationStatus): Promise<boolean> {
    const parsed = OnboardingDeviation.parse(d);
    const replaced = await OnboardingDeviationModel.findOneAndReplace(
      { id: literal(parsed.id), status: literal(expected) },
      parsed,
    )
      .lean()
      .exec();
    return replaced !== null;
  }

  /** Compensation only (rule 22). */
  async removeDeviation(id: string): Promise<void> {
    await OnboardingDeviationModel.deleteOne({ id: literal(id) }).exec();
  }

  /** A checklist's deviations in insertion order (_id is monotonic per process). */
  async listDeviationsByChecklist(checklistId: string): Promise<OnboardingDeviation[]> {
    const docs = await OnboardingDeviationModel.find(
      { checklistId: literal(checklistId) },
      NO_STORAGE_KEYS,
    )
      .sort({ _id: 1 })
      .lean()
      .exec();
    return parseAllStored(OnboardingDeviation, DEVIATIONS, docs);
  }
}
