// specs/agent-metrics.md AT-11 (usage on onboarding_created / onboarding_create_escalated) and the
// onboarding half of AT-13 (usage hidden from non-hr_admin readers of GET /audit/:requestId).
// The notes agent is a fake that records a model_call on the request trace, as the real one does
// (rule 6). ASSUMPTION: a proposals result with no deviations is a valid OnboardingNotesResult
// `{ kind: 'proposals', requestId, deviations: [] }`. needs_details is not driven here: a rejecting
// notes run (the agent_error escalation) is the easiest escalated create path.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import { AuditEvent } from '../domain/schemas.js';
import { LoadedOnboardingPolicy } from '../gate/onboarding-policy.schema.js';
import { evaluateOnboarding } from '../gate/onboarding.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemoryHolidayReader,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createApp } from '../http/app.js';
import {
  InMemoryIdempotencyStore,
  InMemoryIntakeTexts,
  InMemoryLeaveRequestStore,
} from '../intake/in-memory.js';
import { Pricing } from '../lib/cost.js';
import { fixtures } from '../seeds/fixtures.js';
import { InMemoryOnboardingStore } from './in-memory.js';
import { createOnboardingRoutes } from './routes.js';

type Rec = Record<string, unknown>;
const NOW = '2026-10-21T09:00:00Z';
const NOTES_MODEL = 'claude-sonnet-5-5';
const PRICING = Pricing.parse({
  version: 1,
  asOf: '2026-10-01',
  currency: 'USD',
  models: { [NOTES_MODEL]: { inputPerMTok: 3, outputPerMTok: 15 } },
});
const ONE_TASK = [
  { id: 'intro', title: 'Intro call', owner: 'manager', dueOffsetDays: 0, dependsOn: [] },
];
const POLICY = LoadedOnboardingPolicy.parse({
  policy: {
    version: 'v1',
    templates: {
      engineer: { title: 'Engineer', tasks: ONE_TASK },
      sales: { title: 'Sales', tasks: ONE_TASK },
      operations: { title: 'Operations', tasks: ONE_TASK },
    },
  },
  policyVersion: 'v1',
  policyHash: 'a'.repeat(64),
});
const BODY: Rec = {
  newJoinerName: 'Test Joiner A',
  templateId: 'engineer',
  startDate: '2026-12-01',
  newHireTeam: 'team-a',
  managerEmployeeId: 'emp-002',
  buddyEmployeeId: 'emp-005',
};
const NOTES = 'Please add an IT task to set up a second monitor.';

interface Opts {
  notes?: 'proposals' | 'reject' | 'needs_details';
}

function makeWorld(o: Opts = {}) {
  const sink = new InMemoryAuditSink();
  const counter = { n: 0 };
  const idGen = () => `id-${String(++counter.n).padStart(3, '0')}`;
  const store = new InMemoryOnboardingStore([], []);
  const directory = new InMemoryEmployeeDirectory(fixtures.employees, fixtures.teams);
  const approvalStore = new InMemoryApprovalStore([]);
  const leaveStore = new InMemoryLeaveRequestStore([]);
  const reader = new InMemoryAuditReader(sink);
  const recordCall = (requestId: string, input: number, output: number) =>
    sink.write(
      AuditEvent.parse({
        id: `mc-${String(++counter.n)}`,
        traceId: requestId,
        at: NOW,
        actor: { kind: 'agent', id: 'onboarding_notes' },
        eventType: 'agent_step',
        payload: {
          kind: 'model_call',
          requestId,
          agent: 'onboarding_notes',
          model: NOTES_MODEL,
          tokens: { input, output },
        },
      }),
    );
  const runOnboardingNotes = async (input: Rec): Promise<unknown> => {
    const requestId = String(input.requestId);
    await recordCall(requestId, 150, 15);
    if (o.notes === 'reject') throw new Error('notes-agent-down');
    if (o.notes === 'needs_details') {
      return { kind: 'needs_details', requestId, injectionSuspected: false };
    }
    return { kind: 'proposals', requestId, deviations: [], injectionSuspected: false };
  };
  const routes = createOnboardingRoutes({
    directory,
    onboarding: store,
    approvals: approvalStore,
    messages: leaveStore,
    audit: sink,
    auditReader: reader,
    pricing: PRICING,
    clock: { nowIso: () => NOW },
    idGen,
    idempotency: new InMemoryIdempotencyStore(),
    policy: POLICY,
    evaluateOnboarding,
    toIsoDate: (iso: string) => iso.slice(0, 10),
    runOnboardingNotes,
    onboardingTexts: {
      load: (n: string) =>
        Promise.resolve(
          (
            {
              created: 'CREATED-FIXTURE',
              pending_manager: 'PENDING-FIXTURE',
              denied: 'DENIED',
            } as Rec
          )[n] ?? null,
        ),
    },
    intakeTexts: new InMemoryIntakeTexts({ escalated: 'ESCALATED-FIXTURE' }),
  } as never);
  const approvalDeps = {
    directory,
    approvals: approvalStore,
    subjects: leaveStore,
    audit: sink,
    auditReader: reader,
    clock: { nowIso: () => NOW },
    idGen,
    onboarding: store,
    holidays: new InMemoryHolidayReader([]), // approval-queue-ui Q-1
  } as unknown as ApprovalApiDeps;
  return { sink, routes, approvalDeps };
}
type World = ReturnType<typeof makeWorld>;

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function boot(w: World) {
  const server = createApp(w.approvalDeps, w.routes).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${String(addr.port)}`;
  const call = async (user: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'x-demo-user': user };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed: Rec = {};
    try {
      parsed = JSON.parse(text) as Rec;
    } catch {
      // leave empty
    }
    return { status: r.status, text, body: parsed };
  };
  return { call, post: (user: string, body: unknown) => call(user, 'POST', '/onboarding', body) };
}

const summaryOf = (w: World, kind: string): Rec => {
  const e = w.sink.events.find((x) => (x.payload as Rec).kind === kind);
  if (e === undefined) throw new Error(`no ${kind} event was written`);
  return e.payload;
};
const usageOf = (p: Rec): { tokens: unknown; costUsd: number } => {
  expect(p.usage).toBeTruthy();
  return p.usage as { tokens: unknown; costUsd: number };
};

describe('agent-metrics AT-11: usage on onboarding summary events', () => {
  it('AT-11: with notes, onboarding_created carries usage 150/15 and $0.000675', async () => {
    const w = makeWorld({ notes: 'proposals' });
    const { post } = await boot(w);
    expect((await post('emp-001', { ...BODY, notes: NOTES })).status).toBe(200);
    const u = usageOf(summaryOf(w, 'onboarding_created'));
    expect(u.tokens).toEqual({ input: 150, output: 15 });
    expect(Math.abs(u.costUsd - 0.000675)).toBeLessThan(1e-12);
  });

  it('AT-11: the same body without notes has usage 0/0 and $0', async () => {
    const w = makeWorld();
    const { post } = await boot(w);
    expect((await post('emp-001', BODY)).status).toBe(200);
    expect(usageOf(summaryOf(w, 'onboarding_created'))).toEqual({
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    });
  });

  it('AT-11: needs_details gives onboarding_create_escalated carrying the run usage', async () => {
    const w = makeWorld({ notes: 'needs_details' });
    const { post } = await boot(w);
    const res = await post('emp-001', { ...BODY, notes: NOTES });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('escalated');
    const u = usageOf(summaryOf(w, 'onboarding_create_escalated'));
    expect(u.tokens).toEqual({ input: 150, output: 15 });
    expect(Math.abs(u.costUsd - 0.000675)).toBeLessThan(1e-12);
  });
});

describe('agent-metrics AT-13 (onboarding): usage is hidden from the assigned manager', () => {
  it('AT-13: hr_admin sees usage on the trace, the creating manager emp-002 does not', async () => {
    const w = makeWorld({ notes: 'proposals' });
    const { post, call } = await boot(w);
    const byHr = await post('emp-001', { ...BODY, notes: NOTES });
    expect(byHr.status).toBe(200);
    const hr = await call('emp-001', 'GET', `/audit/${String(byHr.body.requestId)}`);
    expect(hr.status).toBe(200);
    expect(hr.text).toContain('"usage":{');
    // Spec AT-13: the creating manager reads their own create trace (onboarding-api D-9).
    const byMgr = await post('emp-002', { ...BODY, notes: NOTES });
    expect(byMgr.status).toBe(200);
    const mgr = await call('emp-002', 'GET', `/audit/${String(byMgr.body.requestId)}`);
    expect(mgr.status).toBe(200);
    expect(mgr.text).toContain('onboarding_created');
    expect(mgr.text).not.toContain('"usage"');
  });
});
