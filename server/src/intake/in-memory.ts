// In-memory port implementations for intake tests and local runs (spec request-intake, D-2, D-11).
// Every read and write clones, so callers never share state with the store.
import type { ApprovalItem, LeaveRequest } from '../domain/schemas.js';
import type { ResolvedSubject, SubjectResolver } from '../http/approvals/ports.js';
import type {
  IdempotencyBegin,
  IdempotencyStore,
  IntakeTextLoader,
  IntakeTextName,
  LeaveRequestStore,
} from './ports.js';

/**
 * Backs both intake (LeaveRequestStore) and the approval queue (SubjectResolver), so requests
 * created here reach GET /approvals and GET /audit/:requestId when one instance serves both.
 */
export class InMemoryLeaveRequestStore implements LeaveRequestStore, SubjectResolver {
  private readonly byId = new Map<string, LeaveRequest>();
  private readonly messageOwners = new Map<string, string>();

  constructor(leaves: readonly LeaveRequest[] = []) {
    for (const l of leaves) this.byId.set(l.id, structuredClone(l));
  }

  insert(request: LeaveRequest): Promise<boolean> {
    if (this.byId.has(request.id)) return Promise.resolve(false);
    this.byId.set(request.id, structuredClone(request));
    return Promise.resolve(true);
  }

  remove(id: string): Promise<void> {
    this.byId.delete(id);
    return Promise.resolve();
  }

  listByEmployee(employeeId: string): Promise<LeaveRequest[]> {
    const own = [...this.byId.values()].filter((l) => l.employeeId === employeeId);
    return Promise.resolve(own.map((l) => structuredClone(l)));
  }

  // Fails closed on a reused id, so one message can never join another employee's trace (D-9).
  recordMessage(requestId: string, employeeId: string): Promise<void> {
    if (this.byId.has(requestId) || this.messageOwners.has(requestId)) {
      return Promise.reject(new Error('request id already in use'));
    }
    this.messageOwners.set(requestId, employeeId);
    return Promise.resolve();
  }

  resolve(item: ApprovalItem): Promise<ResolvedSubject | null> {
    const leave = item.kind === 'leave_request' ? this.byId.get(item.subjectId) : undefined;
    if (leave === undefined) return Promise.resolve(null);
    return Promise.resolve({
      ownerEmployeeId: leave.employeeId,
      leave: structuredClone(leave),
      gateResult: leave.gateResult === undefined ? null : structuredClone(leave.gateResult),
    });
  }

  isLeaveRequest(requestId: string): Promise<boolean> {
    return Promise.resolve(this.byId.has(requestId));
  }

  ownerOfRequest(requestId: string): Promise<string | null> {
    return Promise.resolve(
      this.byId.get(requestId)?.employeeId ?? this.messageOwners.get(requestId) ?? null,
    );
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface IdempotencyEntry {
  textHash: string;
  atMs: number;
  done: { status: number; body: unknown } | null; // null while the first request is in flight
}

/** Keys are scoped per employee and live 24 hours by the caller's clock (D-11). */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  private static slot(employeeId: string, key: string): string {
    return JSON.stringify([employeeId, key]);
  }

  // The check and the claim run in one synchronous step, so concurrent callers can't both win.
  begin(
    employeeId: string,
    key: string,
    textHash: string,
    nowIso: string,
  ): Promise<IdempotencyBegin> {
    const slot = InMemoryIdempotencyStore.slot(employeeId, key);
    const nowMs = Date.parse(nowIso);
    const entry = this.entries.get(slot);
    if (entry !== undefined && nowMs - entry.atMs < DAY_MS) {
      if (entry.textHash !== textHash || entry.done === null) {
        return Promise.resolve({ kind: 'conflict' });
      }
      return Promise.resolve({
        kind: 'replay',
        status: entry.done.status,
        body: structuredClone(entry.done.body),
      });
    }
    this.entries.set(slot, { textHash, atMs: nowMs, done: null });
    return Promise.resolve({ kind: 'new' });
  }

  complete(employeeId: string, key: string, status: number, body: unknown): Promise<void> {
    const entry = this.entries.get(InMemoryIdempotencyStore.slot(employeeId, key));
    if (entry !== undefined) entry.done = { status, body: structuredClone(body) };
    return Promise.resolve();
  }

  release(employeeId: string, key: string): Promise<void> {
    this.entries.delete(InMemoryIdempotencyStore.slot(employeeId, key));
    return Promise.resolve();
  }
}

/** Fixed texts held in memory; a missing or blank text loads as null (D-14). */
export class InMemoryIntakeTexts implements IntakeTextLoader {
  constructor(private readonly texts: Partial<Record<IntakeTextName, string>>) {}

  load(name: IntakeTextName): Promise<string | null> {
    const text = this.texts[name];
    return Promise.resolve(text === undefined || text.trim() === '' ? null : text);
  }
}
