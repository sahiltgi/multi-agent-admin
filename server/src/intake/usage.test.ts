// specs/agent-metrics.md AT-6, AT-7, AT-8, AT-12, AT-13 (rules 5 to 9, 11) for POST /messages and
// GET /audit/:requestId. Fake classify and runLeave write model_call events straight to the sink,
// with traceId = the request id (the first idGen value, lr-001), as the real agents do (rule 6).
// AT-9 and AT-10 (chat) and AT-11 (onboarding) are not in this file: see the report.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import type { RecommendationCard } from '../agents/leave/schemas.js';
import type { RoutingDecision } from '../agents/orchestrator/schemas.js';
import { AuditEvent } from '../domain/schemas.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createApp } from '../http/app.js';
import { Pricing } from '../lib/cost.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import {
  InMemoryIdempotencyStore,
  InMemoryIntakeTexts,
  InMemoryLeaveRequestStore,
} from './in-memory.js';
import type { IntakeDeps } from './ports.js';
import { createIntakeRoutes } from './routes.js';
import { IntakePayload } from './schemas.js';

const NOW = '2026-10-16T09:00:00Z';
const HASH = '0123456789abcdef'.repeat(4);
const TEST_PRICING = Pricing.parse({
  version: 1,
  asOf: '2026-10-01',
  currency: 'USD',
  models: {
    'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 },
    'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15 },
  },
});

const card = (verdict: RecommendationCard['verdict']): RecommendationCard => ({
  requestId: 'lr-001',
  employeeId: 'emp-004',
  request: {
    employeeId: 'emp-004',
    leaveType: 'annual',
    startDate: '2026-11-16',
    endDate: '2026-11-17',
  },
  today: '2026-10-16',
  verdict,
  ruleResults: [
    {
      ruleId: 'required_fields',
      passed: true,
      expected: 'all required fields present',
      actual: 'all present',
      message: 'Required fields are present.',
    },
  ],
  reason: 'Synthetic gate reason',
  policyVersion: 'v1',
  policyHash: HASH,
  summary: 'Synthetic summary sentence.',
  summarySource: 'model',
  model: 'synthetic-model',
  promptVersion: 'v1',
});
const route = (label: 'leave' | 'out_of_scope'): RoutingDecision =>
  label === 'leave'
    ? {
        requestId: 'lr-001',
        model: 'claude-haiku-5-5',
        promptVersion: 'v1',
        source: 'model',
        fallbackReason: null,
        label,
        targetAgent: 'leave',
      }
    : {
        requestId: 'lr-001',
        model: 'claude-haiku-5-5',
        promptVersion: 'v1',
        source: 'model',
        fallbackReason: null,
        label,
        reply: 'OUT-OF-SCOPE-FIXTURE',
      };

function makeWorld(
  opts: {
    readerRejects?: boolean;
    failItemInsert?: boolean;
    failSummaryWrite?: boolean;
    noEscalatedText?: boolean;
  } = {},
) {
  const sink = new InMemoryAuditSink();
  const leaveStore = new InMemoryLeaveRequestStore([]);
  const approvals = new InMemoryApprovalStore([]);
  const directory = new InMemoryEmployeeDirectory(fixtures.employees);
  const state = { counter: 0 };
  const idGen = () => `lr-${String(++state.counter).padStart(3, '0')}`;
  const modelCall = (agent: string, model: string, input: number, output: number) =>
    sink.write(
      AuditEvent.parse({
        id: `mc-${String(++state.counter)}`,
        traceId: 'lr-001',
        at: NOW,
        actor: { kind: 'agent', id: agent },
        eventType: 'agent_step',
        payload: {
          kind: 'model_call',
          requestId: 'lr-001',
          agent,
          model,
          tokens: { input, output },
        },
      }),
    );
  const classify = vi.fn<IntakeDeps['classify']>();
  const runLeave = vi.fn<IntakeDeps['runLeave']>();
  const reader = new InMemoryAuditReader(sink);
  const approvalDeps: ApprovalApiDeps = {
    directory,
    approvals,
    subjects: leaveStore,
    audit: sink,
    auditReader: reader,
    clock: { nowIso: () => NOW },
    idGen,
    onboarding: new InMemoryOnboardingStore(),
  };
  const intakeDeps = {
    directory,
    leaveRequests: leaveStore,
    approvals: opts.failItemInsert
      ? {
          insert: () => Promise.reject(new Error('store-down')),
          remove: (id: string) => approvals.remove(id),
        }
      : approvals,
    approvalReader: approvals,
    audit: opts.failSummaryWrite
      ? {
          write: (e: AuditEvent) =>
            e.payload.kind === 'intake_outcome'
              ? Promise.reject(new Error('sink-down'))
              : sink.write(e),
        }
      : sink,
    auditReader: opts.readerRejects
      ? { listByTrace: () => Promise.reject(new Error('mongo-down')) }
      : reader,
    pricing: TEST_PRICING,
    clock: { nowIso: () => NOW },
    idGen,
    classify,
    runLeave,
    texts: new InMemoryIntakeTexts({
      not_available: 'NOT-AVAILABLE-FIXTURE',
      ...(opts.noEscalatedText === true ? {} : { escalated: 'ESCALATED-FIXTURE' }),
      returned: 'RETURNED-FIXTURE',
      hr_admin_self: 'HR-ADMIN-SELF-FIXTURE',
    }),
    idempotency: new InMemoryIdempotencyStore(),
    runPolicyQa: () => Promise.reject(new Error('not used')),
    policyQuestions: {
      insert: () => Promise.resolve(true),
      get: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
    },
    qaTexts: { load: () => Promise.resolve('QA-ESCALATED-FIXTURE') },
    runOnboarding: () => Promise.reject(new Error('not used')),
    onboarding: new InMemoryOnboardingStore(),
    onboardingTexts: { load: () => Promise.resolve('DENIED-FIXTURE') },
  } as unknown as IntakeDeps;
  return { approvalDeps, intakeDeps, sink, classify, runLeave, modelCall, leaveStore, approvals };
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
  const server = createApp(w.approvalDeps, createIntakeRoutes(w.intakeDeps)).listen(0, '127.0.0.1');
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
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave null
    }
    return { status: r.status, text, body: parsed as Record<string, unknown> | null };
  };
  return { call, post: (user: string, text: string) => call(user, 'POST', '/messages', { text }) };
}

const intakeEvents = (w: World) => w.sink.events.filter((e) => e.actor.id === 'intake');
const payloadOf = (w: World): Record<string, unknown> => {
  const e = intakeEvents(w)[0];
  if (e === undefined) throw new Error('no intake event was written');
  return e.payload;
};
const usageOf = (w: World) => payloadOf(w).usage;

describe('agent-metrics: usage on the intake_outcome event', () => {
  it('AT-6: a leave_submitted request records usage 600/60 and $0.0024, and still parses as IntakePayload', async () => {
    const w = makeWorld();
    w.classify.mockImplementation(async () => {
      await w.modelCall('orchestrator', 'claude-haiku-5-5', 100, 10);
      return route('leave');
    });
    w.runLeave.mockImplementation(async () => {
      await w.modelCall('leave', 'claude-sonnet-5-5', 200, 20);
      await w.modelCall('leave', 'claude-sonnet-5-5', 300, 30);
      return { kind: 'card', card: card('ROUTE_TO_MANAGER'), injectionSuspected: false };
    });
    const { post } = await boot(w);
    const res = await post('emp-004', 'Annual leave 16 to 17 November please');
    expect(res.status).toBe(200);
    expect(res.body?.kind).toBe('leave_submitted');
    const payload = payloadOf(w);
    expect(IntakePayload.safeParse(payload).success).toBe(true);
    const u = usageOf(w) as { tokens: unknown; costUsd: number };
    expect(u.tokens).toEqual({ input: 600, output: 60 });
    expect(Math.abs(u.costUsd - 0.0024)).toBeLessThan(1e-12);
    expect(payload.internalError).toBeUndefined();
  });

  it('AT-7: an out_of_scope reply with no agent calls has a Usage of 0/0 and $0', async () => {
    const w = makeWorld();
    w.classify.mockResolvedValue(route('out_of_scope'));
    const { post } = await boot(w);
    expect((await post('emp-004', 'What is the weather?')).status).toBe(200);
    expect(usageOf(w)).toEqual({ tokens: { input: 0, output: 0 }, costUsd: 0 });
  });

  it('AT-8: a Leave port that throws gives a 500 and an agent_error event with usage and internalError', async () => {
    const w = makeWorld();
    w.classify.mockImplementation(async () => {
      await w.modelCall('orchestrator', 'claude-haiku-5-5', 100, 10);
      return route('leave');
    });
    w.runLeave.mockRejectedValue(new Error('leave-port-down'));
    const { post } = await boot(w);
    const res = await post('emp-004', 'Annual leave please');
    expect(res.status).toBe(500);
    const payload = payloadOf(w);
    expect(payload.escalation).toBe('agent_error');
    expect(payload.internalError).toBe(true);
    const u = payload.usage as { tokens: unknown; costUsd: number };
    expect(u.tokens).toEqual({ input: 100, output: 10 });
    expect(Math.abs(u.costUsd - 0.00015)).toBeLessThan(1e-12);
  });

  it('AT-8: a missing escalated text gives a 500 whose tryAudit event has internalError and usage', async () => {
    const w = makeWorld({ noEscalatedText: true });
    w.classify.mockImplementation(async () => {
      await w.modelCall('orchestrator', 'claude-haiku-5-5', 100, 10);
      return { not: 'a routing decision' } as unknown as RoutingDecision; // escalates
    });
    const { post } = await boot(w);
    expect((await post('emp-004', 'Annual leave please')).status).toBe(500);
    const payload = payloadOf(w);
    expect(payload.outcome).toBe('escalated');
    expect(payload.escalation).toBe('invalid_agent_output');
    expect(payload.internalError).toBe(true);
    expect((payload.usage as { tokens: unknown }).tokens).toEqual({ input: 100, output: 10 });
  });

  it('AT-8: events written by finish carry no internalError key', async () => {
    const w = makeWorld();
    w.classify.mockResolvedValue(route('out_of_scope'));
    const { post } = await boot(w);
    await post('emp-004', 'Hello there');
    const payload = payloadOf(w);
    expect('internalError' in payload).toBe(false);
  });

  it('AT-12: a failing trace read leaves the response and records unchanged, with usage null', async () => {
    const w = makeWorld({ readerRejects: true });
    w.classify.mockImplementation(async () => {
      await w.modelCall('orchestrator', 'claude-haiku-5-5', 100, 10);
      return route('leave');
    });
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('ROUTE_TO_MANAGER'),
      injectionSuspected: false,
    });
    const { post } = await boot(w);
    const res = await post('emp-004', 'Annual leave please');
    expect(res.status).toBe(200);
    expect(res.body?.kind).toBe('leave_submitted');
    expect(usageOf(w)).toBeNull();
    // Rule 9: the records are written exactly as without the feature.
    expect(await w.leaveStore.listByEmployee('emp-004')).toHaveLength(1);
    expect(await w.approvals.list()).toHaveLength(1);
  });

  it('AT-6: the response is byte-identical whether usage is priced or the read-back fails', async () => {
    const respond = async (readerRejects: boolean): Promise<string> => {
      const w = makeWorld({ readerRejects });
      w.classify.mockImplementation(async () => {
        await w.modelCall('orchestrator', 'claude-haiku-5-5', 100, 10);
        return route('leave');
      });
      w.runLeave.mockResolvedValue({
        kind: 'card',
        card: card('ROUTE_TO_MANAGER'),
        injectionSuspected: false,
      });
      const { post } = await boot(w);
      const res = await post('emp-004', 'Annual leave please');
      expect(res.status).toBe(200);
      return res.text;
    };
    const priced = await respond(false);
    expect(priced).not.toContain('usage');
    expect(priced).toBe(await respond(true));
  });

  it('AT-12: a model_call for model-x gives usage null and still a 200', async () => {
    const w = makeWorld();
    w.classify.mockImplementation(async () => {
      await w.modelCall('orchestrator', 'model-x', 100, 10);
      return route('out_of_scope');
    });
    const { post } = await boot(w);
    expect((await post('emp-004', 'Hello')).status).toBe(200);
    expect(usageOf(w)).toBeNull();
  });
});

describe('agent-metrics AT-8 / AT-12: store failure and sink failure', () => {
  const submitting = (w: World) => {
    w.classify.mockImplementation(async () => {
      await w.modelCall('orchestrator', 'claude-haiku-5-5', 100, 10);
      return route('leave');
    });
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('ROUTE_TO_MANAGER'),
      injectionSuspected: false,
    });
  };

  it('AT-8: a record write failing at the approval item gives a store_error event with usage and internalError', async () => {
    const w = makeWorld({ failItemInsert: true });
    submitting(w);
    const { post } = await boot(w);
    expect((await post('emp-004', 'Annual leave please')).status).toBe(500);
    const payload = payloadOf(w);
    expect(payload.escalation).toBe('store_error');
    expect(payload.internalError).toBe(true);
    const u = payload.usage as { tokens: unknown; costUsd: number };
    expect(u.tokens).toEqual({ input: 100, output: 10 });
    expect(Math.abs(u.costUsd - 0.00015)).toBeLessThan(1e-12);
  });

  it('AT-12: the summary sink rejecting is still a 500 and the records are compensated', async () => {
    const w = makeWorld({ failSummaryWrite: true });
    submitting(w);
    const { post } = await boot(w);
    expect((await post('emp-004', 'Annual leave please')).status).toBe(500);
    expect(await w.leaveStore.listByEmployee('emp-004')).toEqual([]);
    expect(await w.approvals.list()).toEqual([]);
  });
});

describe('agent-metrics AT-13: usage is visible to hr_admin only on GET /audit/:requestId', () => {
  async function seeded() {
    const w = makeWorld();
    w.classify.mockImplementation(async () => {
      await w.modelCall('orchestrator', 'claude-haiku-5-5', 100, 10);
      return route('leave');
    });
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('ROUTE_TO_MANAGER'),
      injectionSuspected: false,
    });
    const b = await boot(w);
    expect((await b.post('emp-004', 'Annual leave please')).status).toBe(200);
    return b;
  }

  it('AT-13: hr_admin sees usage on the intake_outcome payload', async () => {
    const { call } = await seeded();
    const res = await call('emp-001', 'GET', '/audit/lr-001');
    expect(res.status).toBe(200);
    expect(res.text).toContain('"usage":{');
  });

  it('AT-13: the owner and the team manager see no usage key', async () => {
    const { call } = await seeded();
    for (const user of ['emp-004', 'emp-002']) {
      const res = await call(user, 'GET', '/audit/lr-001');
      expect(res.status, user).toBe(200);
      expect(res.text, user).toContain('intake_outcome');
      expect(res.text, user).not.toContain('"usage"');
    }
  });

  it('AT-13: the owner still sees qaVerdict null', async () => {
    const { call } = await seeded();
    const res = await call('emp-004', 'GET', '/audit/lr-001');
    expect(res.text).toContain('"qaVerdict":null');
  });
});
