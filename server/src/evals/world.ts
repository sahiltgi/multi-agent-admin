// One fresh, seeded world per case (spec eval-runner, rules 7, 9; D-2, D-5): in-memory stores from
// the seed fixtures, its own audit sink, sequential ids that restart per case, and a case clock.
import { InMemoryAuditSink } from '../agents/audit.js';
import { InMemoryLeaveDataPort } from '../agents/leave/in-memory-port.js';
import type { Clock } from '../agents/runtime.js';
import { InMemoryConversationStore } from '../chat/in-memory.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
} from '../http/approvals/in-memory.js';
import {
  InMemoryIdempotencyStore,
  InMemoryLeaveRequestStore,
  InMemoryPolicyQuestionStore,
} from '../intake/in-memory.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import type { ServerStores } from '../server/app.js';

/** The clock start for a case without asOf (D-5). */
export const DEFAULT_AS_OF = '2026-11-02';

/** Starts at asOf 09:00 UTC and advances with real elapsed time, so asOf is the gate's today. */
export function caseClock(realClock: Clock, asOf: string | null): Clock {
  const start = Date.parse(`${asOf ?? DEFAULT_AS_OF}T09:00:00.000Z`);
  const realStart = realClock.nowMs();
  const nowMs = (): number => start + (realClock.nowMs() - realStart);
  return { nowMs, nowIso: () => new Date(nowMs()).toISOString() };
}

export interface CaseWorld {
  clock: Clock;
  idGen: () => string;
  /** The first id this case generated, or null if none (AT-7). */
  firstId: () => string | null;
  sink: InMemoryAuditSink;
  stores: ServerStores;
  approvals: InMemoryApprovalStore;
  onboarding: InMemoryOnboardingStore;
  leaveRequests: InMemoryLeaveRequestStore;
}

export function createCaseWorld(realClock: Clock, asOf: string | null): CaseWorld {
  let n = 0;
  let first: string | null = null;
  const idGen = (): string => {
    n += 1;
    // `eval-` never collides with the seeded lr-001 to lr-005.
    const id = `eval-${String(n).padStart(4, '0')}`;
    first ??= id;
    return id;
  };
  const sink = new InMemoryAuditSink();
  const reader = new InMemoryAuditReader(sink);
  const approvals = new InMemoryApprovalStore([]);
  const policyQuestions = new InMemoryPolicyQuestionStore();
  const leaveRequests = new InMemoryLeaveRequestStore(fixtures.leaveRequests, policyQuestions);
  const onboarding = new InMemoryOnboardingStore();
  const stores: ServerStores = {
    directory: new InMemoryEmployeeDirectory(fixtures.employees, fixtures.teams),
    approvals,
    leaveRequests,
    audit: {
      write: (e) => sink.write(e),
      listByTrace: (t) => reader.listByTrace(t),
    },
    idempotency: new InMemoryIdempotencyStore(),
    // A snapshot of the seed: leave requests a case creates aren't counted as team absence. Safe
    // while chained cases are skipped (rule 14), since no case reads another's requests.
    leaveData: new InMemoryLeaveDataPort(fixtures),
    conversations: new InMemoryConversationStore(),
    policyQuestions,
    onboarding,
  };
  return {
    clock: caseClock(realClock, asOf),
    idGen,
    firstId: () => first,
    sink,
    stores,
    approvals,
    onboarding,
    leaveRequests,
  };
}
