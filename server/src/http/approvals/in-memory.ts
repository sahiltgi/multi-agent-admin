// In-memory port implementations for tests and local runs (spec approval-queue, rule 16).
// Every read and write clones, so callers never share state with the store.
import type { InMemoryAuditSink } from '../../agents/audit.js';
import type { OnboardingDirectory, OnboardingStore } from '../../domain/onboarding.js';
import type { PolicyQuestionStore } from '../../domain/qa.js';
import type {
  ApprovalItem,
  ApprovalStatus,
  AuditEvent,
  Employee,
  LeaveRequest,
  Team,
} from '../../domain/schemas.js';
import {
  resolveEscalation,
  resolveOnboardingDeviation,
  type ApprovalStore,
  type AuditReader,
  type EmployeeDirectory,
  type ResolvedSubject,
  type SubjectResolver,
} from './ports.js';

export class InMemoryEmployeeDirectory implements EmployeeDirectory, OnboardingDirectory {
  private readonly byId: Map<string, Employee>;
  private readonly teamsById: Map<string, Team>;

  /** `teams` serves the Onboarding Agent's team lookup (spec onboarding OQ-7). */
  constructor(employees: readonly Employee[], teams: readonly Team[] = []) {
    this.byId = new Map(employees.map((e) => [e.id, structuredClone(e)]));
    this.teamsById = new Map(teams.map((t) => [t.id, structuredClone(t)]));
  }

  getById(id: string): Promise<Employee | null> {
    const e = this.byId.get(id);
    return Promise.resolve(e === undefined ? null : structuredClone(e));
  }

  getTeamById(id: string): Promise<Team | null> {
    const t = this.teamsById.get(id);
    return Promise.resolve(t === undefined ? null : structuredClone(t));
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly byId: Map<string, ApprovalItem>;

  constructor(items: readonly ApprovalItem[]) {
    this.byId = new Map(items.map((i) => [i.id, structuredClone(i)]));
  }

  list(): Promise<ApprovalItem[]> {
    return Promise.resolve([...this.byId.values()].map((i) => structuredClone(i)));
  }

  get(id: string): Promise<ApprovalItem | null> {
    const i = this.byId.get(id);
    return Promise.resolve(i === undefined ? null : structuredClone(i));
  }

  // The compare and the write run in one synchronous step, so concurrent callers can't both win.
  saveIfStatus(item: ApprovalItem, expectedStatus: ApprovalStatus): Promise<boolean> {
    const current = this.byId.get(item.id);
    if (current?.status !== expectedStatus) return Promise.resolve(false);
    this.byId.set(item.id, structuredClone(item));
    return Promise.resolve(true);
  }

  /** Adds a new item; false if the id exists, never overwrites (request-intake D-2). */
  insert(item: ApprovalItem): Promise<boolean> {
    if (this.byId.has(item.id)) return Promise.resolve(false);
    this.byId.set(item.id, structuredClone(item));
    return Promise.resolve(true);
  }

  /** Compensation only: undoes an insert whose later writes failed (request-intake D-13). */
  remove(id: string): Promise<void> {
    this.byId.delete(id);
    return Promise.resolve();
  }
}

export class InMemorySubjectResolver implements SubjectResolver {
  private readonly byId: Map<string, LeaveRequest>;

  constructor(
    leaves: readonly LeaveRequest[],
    private readonly questions: PolicyQuestionStore,
    private readonly onboarding: OnboardingStore | null = null,
  ) {
    this.byId = new Map(leaves.map((l) => [l.id, structuredClone(l)]));
  }

  resolve(item: ApprovalItem): Promise<ResolvedSubject | null> {
    if (item.kind === 'escalation') return resolveEscalation(item, this.questions);
    if (item.kind === 'onboarding_deviation') {
      // spec onboarding OQ-10: no store means the deviation can't be resolved (fail closed).
      return this.onboarding === null
        ? Promise.resolve(null)
        : resolveOnboardingDeviation(item, this.onboarding);
    }
    const leave = this.byId.get(item.subjectId); // only leave_request items reach here
    if (leave === undefined) return Promise.resolve(null);
    return Promise.resolve({
      ownerEmployeeId: leave.employeeId,
      leave: structuredClone(leave),
      gateResult: leave.gateResult === undefined ? null : structuredClone(leave.gateResult),
      policyQuestion: null,
    });
  }

  ownerOfRequest(requestId: string): Promise<string | null> {
    return Promise.resolve(this.byId.get(requestId)?.employeeId ?? null);
  }

  isLeaveRequest(requestId: string): Promise<boolean> {
    return Promise.resolve(this.byId.has(requestId));
  }
}

export class InMemoryAuditReader implements AuditReader {
  constructor(private readonly sink: InMemoryAuditSink) {}

  listByTrace(traceId: string): Promise<AuditEvent[]> {
    return Promise.resolve(
      this.sink.events.filter((e) => e.traceId === traceId).map((e) => structuredClone(e)),
    );
  }
}
