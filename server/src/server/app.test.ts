// AT-9, AT-14 and the HTTP/sink half of AT-18 for specs/mongo-persistence.md.
// buildApp is pure wiring (D-18): in-memory ports, a fake ModelClient and stubbed agents.
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import type { RecommendationCard } from '../agents/leave/schemas.js';
import type { RoutingDecision } from '../agents/orchestrator/schemas.js';
import type { ModelClient } from '../agents/schemas.js';
import type { AuditEvent } from '../domain/schemas.js';
import { ErrorBody } from '../http/errors.js';
import {
  InMemoryApprovalStore,
  InMemoryEmployeeDirectory,
  InMemoryAuditReader,
} from '../http/approvals/in-memory.js';
import {
  InMemoryIdempotencyStore,
  InMemoryLeaveRequestStore,
  InMemoryPolicyQuestionStore,
} from '../intake/in-memory.js';
import { loadLeavePolicy } from '../policies/load.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import { buildApp, type ServerParts, type ServerStores } from './app.js';
import { loadBootFiles } from './boot.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const NOW = '2026-10-16T09:00:00Z';
const KEY = 'TEST-KEY-CANARY-0000';
const POLICY_HASH = '0123456789abcdef'.repeat(4);

let boot: ServerParts['boot'];
beforeAll(async () => {
  boot = await loadBootFiles(join(REPO_ROOT, 'prompts'));
});

type Agents = NonNullable<ServerParts['agents']>;

function card(requestId: string): RecommendationCard {
  return {
    requestId,
    employeeId: 'emp-004',
    request: {
      employeeId: 'emp-004',
      leaveType: 'annual',
      startDate: '2026-11-16',
      endDate: '2026-11-17',
    },
    today: '2026-10-16',
    verdict: 'ROUTE_TO_MANAGER',
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
    policyHash: POLICY_HASH,
    summary: 'Synthetic summary sentence.',
    summarySource: 'model',
    model: 'synthetic-model',
    promptVersion: 'v1',
  };
}

const LEAVE_DECISION: RoutingDecision = {
  requestId: 'lr-001',
  model: 'synthetic-model',
  promptVersion: 'v1',
  source: 'model',
  fallbackReason: null,
  label: 'leave',
  targetAgent: 'leave',
};

interface World {
  parts: ServerParts;
  sink: InMemoryAuditSink;
  leaveRequests: InMemoryLeaveRequestStore;
  approvals: InMemoryApprovalStore;
  create: ReturnType<typeof vi.fn<ModelClient['create']>>;
  classify: ReturnType<typeof vi.fn<Agents['classify']>>;
  runLeave: ReturnType<typeof vi.fn<Agents['runLeave']>>;
}

function makeWorld(
  opts: { failAudit?: boolean; realAgents?: boolean; modelError?: Error } = {},
): World {
  const sink = new InMemoryAuditSink();
  const reader = new InMemoryAuditReader(sink);
  const leaveRequests = new InMemoryLeaveRequestStore([]);
  const approvals = new InMemoryApprovalStore([]);
  const audit: ServerStores['audit'] = {
    write: (e: AuditEvent) =>
      opts.failAudit === true ? Promise.reject(new Error('audit store down')) : sink.write(e),
    listByTrace: (traceId: string) => reader.listByTrace(traceId),
    listByKinds: (kinds, from, to) => reader.listByKinds(kinds, from, to),
  };
  const stores: ServerStores = {
    directory: new InMemoryEmployeeDirectory(fixtures.employees),
    approvals,
    leaveRequests,
    audit,
    idempotency: new InMemoryIdempotencyStore(),
    conversations: {
      get: () => Promise.resolve(null),
      insert: () => Promise.resolve(true),
      saveIfVersion: () => Promise.resolve(true),
      remove: () => Promise.resolve(),
    },
    leaveData: {
      getBalances: () => Promise.resolve([]),
      getHolidays: () => Promise.resolve([]),
      getTeamDayCounts: () => Promise.resolve([]),
      getTeamSize: () => Promise.resolve(1),
    },
    policyQuestions: new InMemoryPolicyQuestionStore(), // policy-qa amendment
    onboarding: new InMemoryOnboardingStore(), // onboarding OQ-14
  };
  const create = vi.fn<ModelClient['create']>();
  if (opts.modelError !== undefined) create.mockRejectedValue(opts.modelError);
  const classify = vi.fn<Agents['classify']>();
  const runLeave = vi.fn<Agents['runLeave']>();
  const counter = { n: 0 };
  const parts: ServerParts = {
    policy: loadLeavePolicy(join(REPO_ROOT, 'policies', 'leave', 'v1.yaml')),
    boot,
    stores,
    model: { create },
    clock: { nowMs: () => Date.parse(NOW), nowIso: () => NOW },
    scheduler: { setTimeout: () => () => undefined },
    idGen: () => `lr-${String((counter.n += 1)).padStart(3, '0')}`,
    ...(opts.realAgents === true ? {} : { agents: { classify, runLeave } }),
  };
  return { parts, sink, leaveRequests, approvals, create, classify, runLeave };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

interface Res {
  status: number;
  text: string;
  body: unknown;
}

async function start(world: World) {
  const server = buildApp(world.parts).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${String(addr.port)}`;
  return async (
    user: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Res> => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'x-demo-user': user,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: r.status, text, body: parsed };
  };
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean | undefined> };
}

function routeTable(app: ReturnType<typeof buildApp>): string[] {
  const router = (app as unknown as { router: { stack: RouteLayer[] } }).router;
  const out: string[] = [];
  for (const layer of router.stack) {
    if (layer.route === undefined) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on === true) out.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out.sort();
}

describe('buildApp', () => {
  it('AT-9: a failing audit write on a leave card gives 500 and leaves no request or item', async () => {
    const w = makeWorld({ failAudit: true });
    w.classify.mockResolvedValue(LEAVE_DECISION);
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('lr-001'),
      injectionSuspected: false,
    });
    const call = await start(w);
    const res = await call('emp-004', 'POST', '/messages', {
      text: 'Annual leave 2026-11-16 to 2026-11-17',
    });
    expect(res.status).toBe(500);
    expect(ErrorBody.parse(res.body).error.code).toBe('internal_error');
    expect(res.text).not.toContain('audit store down');
    expect(await w.leaveRequests.listByEmployee('emp-004')).toEqual([]);
    expect(await w.approvals.list()).toEqual([]);
    expect(w.sink.events).toHaveLength(0);
  });

  it('AT-14: the route table is the four approval-queue routes plus POST /messages, GET /my-requests, POST /chat, GET /conversations/:id (chat-endpoint amendment) and the four onboarding routes (onboarding-api OQ-1)', () => {
    const w = makeWorld();
    expect(routeTable(buildApp(w.parts))).toEqual(
      [
        'GET /approvals',
        'GET /approvals/:itemId',
        'POST /approvals/:itemId/actions',
        'GET /audit/:requestId',
        'POST /messages',
        'GET /my-requests',
        'POST /chat',
        'GET /conversations/:id',
        // onboarding-api OQ-1: the two old onboarding routes are replaced by these four.
        'POST /onboarding',
        'GET /onboarding',
        'GET /onboarding/:checklistId',
        'PATCH /onboarding/:checklistId/tasks/:taskId',
        'GET /metrics/agents', // spec agent-metrics, rule 12
        'GET /handbook/sections/:id', // spec employee-chat, rule 14
      ].sort(),
    );
  });

  it('AT-14: a request created by POST /messages shows in GET /approvals for its manager and in GET /audit/<id>', async () => {
    const w = makeWorld();
    w.classify.mockResolvedValue(LEAVE_DECISION);
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('lr-001'),
      injectionSuspected: false,
    });
    const call = await start(w);
    const created = await call('emp-004', 'POST', '/messages', {
      text: 'Annual leave 2026-11-16 to 2026-11-17',
    });
    expect(created.status).toBe(200);
    expect(w.create).not.toHaveBeenCalled();

    const queue = await call('emp-002', 'GET', '/approvals');
    expect(queue.status).toBe(200);
    expect(queue.text).toContain('lr-001');
    const items = (queue.body as { items: { item: { subjectId: string } }[] }).items;
    expect(items.map((i) => i.item.subjectId)).toEqual(['lr-001']);

    const trace = await call('emp-002', 'GET', '/audit/lr-001');
    expect(trace.status).toBe(200);
    expect(trace.text).toContain('intake_outcome');

    const mine = await call('emp-004', 'GET', '/my-requests');
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('lr-001');
  });

  it('AT-18: a model error holding the API key reaches no HTTP body and no audit event', async () => {
    const w = makeWorld({ realAgents: true, modelError: new Error(`invalid x-api-key ${KEY}`) });
    const call = await start(w);
    const res = await call('emp-004', 'POST', '/messages', {
      text: 'Annual leave 2026-11-16 to 2026-11-17',
    });
    expect(res.status).toBe(200); // the orchestrator falls back; no model text or key reaches the body
    expect(w.create).toHaveBeenCalled();
    expect(res.text).not.toContain(KEY);
    expect(JSON.stringify(w.sink.events)).not.toContain(KEY);
  });
});
