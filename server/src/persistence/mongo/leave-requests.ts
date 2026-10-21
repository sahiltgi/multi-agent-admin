// LeaveRequestStore and SubjectResolver on MongoDB, in one adapter so requests created by intake
// reach the approval queue (spec mongo-persistence, rules 4 and 5; request-intake D-2, D-9).
import type { PolicyQuestionStore } from '../../domain/qa.js';
import { LeaveRequest, type ApprovalItem } from '../../domain/schemas.js';
import {
  resolveEscalation,
  type ResolvedSubject,
  type SubjectResolver,
} from '../../http/approvals/ports.js';
import type { LeaveRequestStore } from '../../intake/ports.js';
import { MODELS } from '../../models/index.js';
import { MessageOwner, MessageOwnerModel } from './models.js';
import { isDuplicateKey, literal, NO_STORAGE_KEYS, parseAllStored, parseStored } from './read.js';

const COLLECTION = 'leaveRequests';

export class MongoLeaveRequestStore implements LeaveRequestStore, SubjectResolver {
  /** `questions` resolves escalation items (spec policy-qa, rule 23); without it they give null. */
  constructor(private readonly questions: PolicyQuestionStore | null = null) {}

  private async byId(id: string): Promise<LeaveRequest | null> {
    const doc = await MODELS.LeaveRequest.findOne({ id: literal(id) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    return doc === null ? null : parseStored(LeaveRequest, COLLECTION, doc);
  }

  /** Adds a new request; false if the id exists (unique index), never overwrites. */
  async insert(request: LeaveRequest): Promise<boolean> {
    try {
      await MODELS.LeaveRequest.create(LeaveRequest.parse(request));
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  /** Compensation only (request-intake D-13). */
  async remove(id: string): Promise<void> {
    await MODELS.LeaveRequest.deleteOne({ id: literal(id) }).exec();
  }

  async listByEmployee(employeeId: string): Promise<LeaveRequest[]> {
    const docs = await MODELS.LeaveRequest.find(
      { employeeId: literal(employeeId) },
      NO_STORAGE_KEYS,
    )
      .lean()
      .exec();
    return parseAllStored(LeaveRequest, COLLECTION, docs);
  }

  /**
   * Fails closed on a reused id (rule 5): an existing LeaveRequest id is refused here, and an
   * existing message owner by the unique index, so of concurrent callers exactly one resolves.
   * The LeaveRequest check and the owner insert are two steps. That's acceptable: intake records
   * the message before it inserts a request with the same id, and production ids are random UUIDs
   * (D-17), so no request can appear with an id between the two steps.
   */
  async recordMessage(requestId: string, employeeId: string): Promise<void> {
    const owner = MessageOwner.parse({ requestId, employeeId });
    const leaveExists = await MODELS.LeaveRequest.exists({ id: literal(owner.requestId) }).exec();
    if (leaveExists !== null) throw new Error('request id already in use');
    try {
      await MessageOwnerModel.create(owner);
    } catch (err) {
      if (isDuplicateKey(err)) throw new Error('request id already in use', { cause: err });
      throw err;
    }
  }

  async resolve(item: ApprovalItem): Promise<ResolvedSubject | null> {
    if (item.kind === 'escalation') {
      return this.questions === null ? null : resolveEscalation(item, this.questions);
    }
    if (item.kind !== 'leave_request') return null; // approval-queue OQ-6: fail closed
    const leave = await this.byId(item.subjectId);
    if (leave === null) return null;
    return {
      ownerEmployeeId: leave.employeeId,
      leave,
      gateResult: leave.gateResult ?? null,
      policyQuestion: null,
    };
  }

  async isLeaveRequest(requestId: string): Promise<boolean> {
    return (await MODELS.LeaveRequest.exists({ id: literal(requestId) }).exec()) !== null;
  }

  /** The leave request's owner, else the message owner's, else null (rule 4). */
  async ownerOfRequest(requestId: string): Promise<string | null> {
    const leave = await this.byId(requestId);
    if (leave !== null) return leave.employeeId;
    const doc = await MessageOwnerModel.findOne({ requestId: literal(requestId) }, NO_STORAGE_KEYS)
      .lean()
      .exec();
    return doc === null ? null : parseStored(MessageOwner, 'messageOwners', doc).employeeId;
  }
}
