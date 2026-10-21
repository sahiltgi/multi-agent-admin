// Ports for the approval queue API (spec approval-queue, rule 16). Routes depend only on these;
// in-memory implementations sit next to them in ./in-memory.ts. MongoDB adapters come later.
import type { AuditSink } from '../../agents/audit.js';
import type { PolicyQuestion, PolicyQuestionStore } from '../../domain/qa.js';
import type {
  ApprovalItem,
  ApprovalStatus,
  AuditEvent,
  Employee,
  LeaveGateResult,
  LeaveRequest,
} from '../../domain/schemas.js';

export interface EmployeeDirectory {
  getById(id: string): Promise<Employee | null>;
}

export interface ApprovalStore {
  list(): Promise<ApprovalItem[]>;
  get(id: string): Promise<ApprovalItem | null>;
  /** Writes only if the stored status is still `expectedStatus`; returns false otherwise (rule 9). */
  saveIfStatus(item: ApprovalItem, expectedStatus: ApprovalStatus): Promise<boolean>;
}

export interface ResolvedSubject {
  ownerEmployeeId: string;
  leave: LeaveRequest | null;
  gateResult: LeaveGateResult | null;
  /** Set only for kind 'escalation' (spec policy-qa, rule 23); leave and gateResult are null then. */
  policyQuestion: PolicyQuestion | null;
}

export interface SubjectResolver {
  /**
   * leave_request items resolve to their LeaveRequest, escalation items to their PolicyQuestion
   * (spec policy-qa, rule 23). Anything else, or a missing subject, gives null and fails closed.
   */
  resolve(item: ApprovalItem): Promise<ResolvedSubject | null>;
  /** The owner of a trace's request (rule 14); null if the request is unknown. */
  ownerOfRequest(requestId: string): Promise<string | null>;
  /** True when the trace belongs to a LeaveRequest, not only a message (request-intake D-9). */
  isLeaveRequest(requestId: string): Promise<boolean>;
}

export interface AuditReader {
  /** Events of one trace, in insertion order. */
  listByTrace(traceId: string): Promise<AuditEvent[]>;
}

export interface ApprovalApiDeps {
  directory: EmployeeDirectory;
  approvals: ApprovalStore;
  subjects: SubjectResolver;
  audit: AuditSink;
  auditReader: AuditReader;
  clock: { nowIso(): string };
  idGen: () => string;
}

/**
 * The escalation half of SubjectResolver.resolve (spec policy-qa, rule 23): an escalation item
 * resolves to its PolicyQuestion, or null (fail closed) when none exists.
 */
export async function resolveEscalation(
  item: ApprovalItem,
  questions: PolicyQuestionStore,
): Promise<ResolvedSubject | null> {
  const question = await questions.get(item.subjectId);
  if (question === null) return null;
  return {
    ownerEmployeeId: question.employeeId,
    leave: null,
    gateResult: null,
    policyQuestion: question,
  };
}
