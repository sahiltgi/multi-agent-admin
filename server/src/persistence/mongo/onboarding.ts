// OnboardingStore on MongoDB (spec onboarding, rules 21–25; mongo-persistence amendment, OQ-14;
// onboarding-api rules 7, 11, 20).
// Matches ids with $eq only, so a crafted id can never become a query operator. Conditional
// writes replace a document only while its version or status is still the expected one.
import {
  NewJoinerProfile,
  OnboardingChecklist,
  OnboardingDeviation,
  type ChecklistListFilter,
  type DeviationStatus,
  type OnboardingStore,
} from '../../domain/onboarding.js';
import { MODELS } from '../../models/index.js';
import { NewJoinerProfileModel, OnboardingDeviationModel } from './models.js';
import { isDuplicateKey, literal, NO_STORAGE_KEYS, parseAllStored, parseStored } from './read.js';

const CHECKLISTS = 'onboardingChecklists';
const DEVIATIONS = 'onboardingDeviations';
const PROFILES = 'newJoinerProfiles';

/** The Mongo query for a ChecklistListFilter (onboarding-api rule 11); every value is a literal. */
function listQuery(f: ChecklistListFilter): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  if (f.visibleTo.kind === 'employee') {
    const me = literal(f.visibleTo.employeeId);
    and.push({ $or: [{ managerEmployeeId: me }, { 'tasks.ownerEmployeeId': me }] });
  }
  if (f.templateId !== undefined) and.push({ templateId: literal(f.templateId) });
  if (f.startDateFrom !== undefined) and.push({ startDate: { $gte: f.startDateFrom } });
  if (f.startDateTo !== undefined) and.push({ startDate: { $lte: f.startDateTo } });
  if (f.after !== undefined) {
    const { startDate, id } = f.after;
    and.push({
      $or: [{ startDate: { $gt: startDate } }, { startDate: literal(startDate), id: { $gt: id } }],
    });
  }
  return and.length === 0 ? {} : { $and: and };
}

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

  /** startDate asc, then id asc, at most `limit` (onboarding-api rule 11). */
  async listChecklists(filter: ChecklistListFilter): Promise<OnboardingChecklist[]> {
    const docs = await MODELS.OnboardingChecklist.find(listQuery(filter), NO_STORAGE_KEYS)
      .sort({ startDate: 1, id: 1 })
      .limit(filter.limit)
      .lean()
      .exec();
    return parseAllStored(OnboardingChecklist, CHECKLISTS, docs);
  }

  /** Adds a new profile; false if the newJoinerId exists (unique index), never overwrites. */
  async insertProfile(p: NewJoinerProfile): Promise<boolean> {
    try {
      await NewJoinerProfileModel.create(NewJoinerProfile.parse(p));
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async getProfile(newJoinerId: string): Promise<NewJoinerProfile | null> {
    const doc = await NewJoinerProfileModel.findOne(
      { newJoinerId: literal(newJoinerId) },
      NO_STORAGE_KEYS,
    )
      .lean()
      .exec();
    return doc === null ? null : parseStored(NewJoinerProfile, PROFILES, doc);
  }

  /** Compensation only (onboarding-api rule 7). */
  async removeProfile(newJoinerId: string): Promise<void> {
    await NewJoinerProfileModel.deleteOne({ newJoinerId: literal(newJoinerId) }).exec();
  }
}
