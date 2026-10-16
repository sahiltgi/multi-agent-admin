// Ports for request intake (spec request-intake, D-2, D-11, D-14). Routes depend only on these;
// in-memory implementations sit in ./in-memory.ts. MongoDB adapters come with mongo-persistence.
import type { AuditSink } from '../agents/audit.js';
import type { LeaveAgentResult, LeaveInput } from '../agents/leave/schemas.js';
import type {
  OrchestratorFailure,
  OrchestratorInput,
  RoutingDecision,
} from '../agents/orchestrator/schemas.js';
import type { ApprovalItem, LeaveRequest } from '../domain/schemas.js';
import type { ApprovalStore, EmployeeDirectory } from '../http/approvals/ports.js';

export interface LeaveRequestStore {
  /** Adds a new request; false if the id exists, never overwrites. */
  insert(request: LeaveRequest): Promise<boolean>;
  /** Compensation only: undoes an insert whose later writes failed (D-13). */
  remove(id: string): Promise<void>;
  listByEmployee(employeeId: string): Promise<LeaveRequest[]>;
  /** Records who sent a message, so its trace resolves even with no LeaveRequest (D-9). */
  recordMessage(requestId: string, employeeId: string): Promise<void>;
}

export interface ApprovalItemWriter {
  /** Adds a new item; false if the id exists, never overwrites. */
  insert(item: ApprovalItem): Promise<boolean>;
  /** Compensation only (D-13). */
  remove(id: string): Promise<void>;
}

export type IntakeTextName = 'not_available' | 'escalated' | 'returned' | 'hr_admin_self';

export interface IntakeTextLoader {
  /** The fixed text, or null when it is missing or blank (fail closed, D-14). */
  load(name: IntakeTextName): Promise<string | null>;
}

export type IdempotencyBegin =
  { kind: 'new' } | { kind: 'replay'; status: number; body: unknown } | { kind: 'conflict' };

export interface IdempotencyStore {
  /** Claims (employeeId, key) for a message; textHash is a hash, never the text (D-11). */
  begin(
    employeeId: string,
    key: string,
    textHash: string,
    nowIso: string,
  ): Promise<IdempotencyBegin>;
  complete(employeeId: string, key: string, status: number, body: unknown): Promise<void>;
  release(employeeId: string, key: string): Promise<void>;
}

export interface IntakeDeps {
  directory: EmployeeDirectory;
  leaveRequests: LeaveRequestStore;
  approvals: ApprovalItemWriter;
  approvalReader: ApprovalStore;
  audit: AuditSink;
  clock: { nowIso(): string };
  idGen: () => string;
  classify: (input: OrchestratorInput) => Promise<RoutingDecision | OrchestratorFailure>;
  runLeave: (input: LeaveInput) => Promise<LeaveAgentResult>;
  texts: IntakeTextLoader;
  idempotency: IdempotencyStore;
}
