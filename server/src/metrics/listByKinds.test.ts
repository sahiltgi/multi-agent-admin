// specs/agent-metrics.md AT-18 (rule 15): the AuditSummaryReader.listByKinds contract. The suite is
// exported so the Mongo integration test runs the same cases against MongoAuditStore (as
// onboardingApiStoreContract does); importing this file there also registers the in-memory run.
import { describe, expect, it } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import { AuditEvent } from '../domain/schemas.js';
import { InMemoryAuditReader } from '../http/approvals/in-memory.js';
import type { AuditSummaryReader } from './ports.js';

type Rec = Record<string, unknown>;

function hasStorageKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasStorageKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([k, v]) => k === '_id' || k === '__v' || hasStorageKeys(v));
  }
  return false;
}

const T = (n: number): string => `2026-10-${String(10 + n).padStart(2, '0')}T12:00:00.000Z`;

function ev(id: string, at: string, payload: Rec): AuditEvent {
  return AuditEvent.parse({
    id,
    traceId: typeof payload.requestId === 'string' ? payload.requestId : 'req-x',
    at,
    actor: { kind: 'system', id: 'intake' },
    eventType: 'agent_step',
    payload,
  });
}

/** Events in insertion order; ids are suffixed so a shared database can't collide across runs. */
export function summaryEvents(suffix: string): AuditEvent[] {
  const id = (n: string) => `${n}-${suffix}`;
  return [
    ev(id('e1'), T(1), { kind: 'intake_outcome', requestId: 'req-1' }),
    ev(id('e2'), T(2), { kind: 'chat_turn', requestId: 'req-2' }),
    ev(id('e3'), T(2), { kind: 'intake_outcome', requestId: 'req-3' }), // same `at` as e2
    ev(id('e4'), T(3), { kind: 'model_call', requestId: 'req-4' }),
    ev(id('e5'), T(4), { kind: 'onboarding_created', requestId: 'req-5' }),
    ev(id('e6'), T(5), { kind: 'chat_turn', requestId: 'req-6' }),
    ev(id('e7'), T(9), { kind: 'chat_turn', requestId: 'req-7' }), // after the window
  ];
}

export function auditSummaryReaderContract(
  label: string,
  make: (events: AuditEvent[]) => Promise<AuditSummaryReader>,
): void {
  describe(`agent-metrics AT-18: ${label} AuditSummaryReader contract`, () => {
    // Fixed: each factory starts from an empty store (the Mongo one clears the collection).
    const suffix = 'c1';
    const names = (events: AuditEvent[]): string[] =>
      events.map((e) => e.id.replace(`-${suffix}`, ''));

    it('AT-18: returns only the asked kinds inside the inclusive bounds, at ascending, ties in insertion order', async () => {
      const reader = await make(summaryEvents(suffix));
      const got = await reader.listByKinds(['intake_outcome', 'chat_turn'], T(1), T(5));
      expect(names(got)).toEqual(['e1', 'e2', 'e3', 'e6']); // e2 before e3 at the same `at`
    });

    it('AT-18: both bounds are inclusive and one millisecond outside is excluded', async () => {
      const reader = await make(summaryEvents(suffix));
      const exact = await reader.listByKinds(['chat_turn'], T(2), T(2));
      expect(names(exact)).toEqual(['e2']);
      const justAfter = await reader.listByKinds(['chat_turn'], '2026-10-12T12:00:00.001Z', T(5));
      expect(names(justAfter)).toEqual(['e6']);
      const justBefore = await reader.listByKinds(['chat_turn'], T(1), '2026-10-12T11:59:59.999Z');
      expect(names(justBefore)).toEqual([]);
    });

    it('AT-18: each result parses as AuditEvent and has no _id or __v', async () => {
      const reader = await make(summaryEvents(suffix));
      const got = await reader.listByKinds(['intake_outcome', 'chat_turn'], T(0), T(9));
      expect(got.length).toBeGreaterThan(0);
      expect(hasStorageKeys(got)).toBe(false);
      for (const e of got) expect(AuditEvent.parse(e)).toEqual(e);
    });

    it('AT-18: empty kinds give an empty list', async () => {
      const reader = await make(summaryEvents(suffix));
      expect(await reader.listByKinds([], T(0), T(9))).toEqual([]);
    });

    it('AT-18: mutating a returned event does not change a later read', async () => {
      const reader = await make(summaryEvents(suffix));
      const first = await reader.listByKinds(['intake_outcome'], T(0), T(9));
      const head = first[0];
      if (head === undefined) throw new Error('expected an event');
      (head.payload as Rec).kind = 'tampered';
      head.id = 'tampered';
      const second = await reader.listByKinds(['intake_outcome'], T(0), T(9));
      expect(names(second)).toEqual(['e1', 'e3']);
      expect((second[0]?.payload as Rec).kind).toBe('intake_outcome');
    });
  });
}

auditSummaryReaderContract('in-memory', (events) => {
  const sink = new InMemoryAuditSink();
  for (const e of events) sink.events.push(e);
  return Promise.resolve(new InMemoryAuditReader(sink) as unknown as AuditSummaryReader);
});
