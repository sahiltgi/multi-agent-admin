// specs/chat-endpoint.md AT-31: buildApp mounts POST /chat and GET /conversations/:id next to the
// intake routes, sharing the stores; a leave created through /chat reaches the approval queue and
// /my-requests. Stubbed agents, in-memory ports. The graceMs and loadBootFiles halves of AT-31 are
// in src/index.test.ts and src/server/boot.test.ts.
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import type { ModelClient } from '../agents/schemas.js';
import type { AuditEvent } from '../domain/schemas.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
} from '../http/approvals/in-memory.js';
import { InMemoryIdempotencyStore, InMemoryLeaveRequestStore } from '../intake/in-memory.js';
import { loadLeavePolicy } from '../policies/load.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import { buildApp, type ServerParts, type ServerStores } from './app.js';
import { loadBootFiles } from './boot.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const NOW = '2026-10-16T09:00:00Z';
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

const card = (requestId: string) => ({
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
    { ruleId: 'required_fields', passed: true, expected: 'a', actual: 'b', message: 'ok.' },
  ],
  reason: 'Synthetic gate reason',
  policyVersion: 'v1',
  policyHash: '0123456789abcdef'.repeat(4),
  summary: 'Synthetic summary sentence.',
  summarySource: 'model',
  model: 'synthetic-model',
  promptVersion: 'v2',
});

async function world() {
  const { InMemoryConversationStore } = await import('../chat/in-memory.js');
  const sink = new InMemoryAuditSink();
  const reader = new InMemoryAuditReader(sink);
  const stores = {
    directory: new InMemoryEmployeeDirectory(fixtures.employees),
    approvals: new InMemoryApprovalStore([]),
    leaveRequests: new InMemoryLeaveRequestStore([]),
    audit: {
      write: (e: AuditEvent) => sink.write(e),
      listByTrace: (t: string) => reader.listByTrace(t),
    },
    idempotency: new InMemoryIdempotencyStore(),
    conversations: new InMemoryConversationStore(),
    leaveData: {
      getBalances: () => Promise.resolve([]),
      getHolidays: () => Promise.resolve([]),
      getTeamDayCounts: () => Promise.resolve([]),
      getTeamSize: () => Promise.resolve(1),
    },
    onboarding: new InMemoryOnboardingStore(), // onboarding OQ-14
  } as unknown as ServerStores;
  const classify = vi.fn((input: { requestId: string }) =>
    Promise.resolve({
      requestId: input.requestId,
      model: 'm',
      promptVersion: 'v1',
      source: 'model',
      fallbackReason: null,
      label: 'leave',
      targetAgent: 'leave',
    }),
  );
  let n = 0;
  const runLeave = vi.fn((input: { requestId: string }) => {
    n += 1;
    return Promise.resolve(
      n === 1
        ? {
            kind: 'needs_details',
            requestId: input.requestId,
            question: 'Which dates would you like to take off?',
            questionSource: 'model',
            injectionSuspected: false,
          }
        : { kind: 'card', card: card(input.requestId), injectionSuspected: false },
    );
  });
  let ids = 0;
  const parts = {
    policy: loadLeavePolicy(join(REPO_ROOT, 'policies', 'leave', 'v1.yaml')),
    boot: await loadBootFiles(join(REPO_ROOT, 'prompts')),
    stores,
    model: { create: vi.fn() } as unknown as ModelClient,
    clock: { nowMs: () => Date.parse(NOW), nowIso: () => NOW },
    scheduler: { setTimeout: () => () => undefined },
    idGen: () => `lr-${String((ids += 1)).padStart(3, '0')}`,
    agents: { classify, runLeave },
  } as unknown as ServerParts;
  const app = buildApp(parts);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((r) =>
    server.once('listening', () => {
      r();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const call = async (user: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${String(addr.port)}${path}`, {
      method,
      headers: {
        'x-demo-user': user,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  return { app, call };
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean | undefined> };
}
function routeTable(app: ReturnType<typeof buildApp>): string[] {
  const router = (app as unknown as { router: { stack: RouteLayer[] } }).router;
  const out: string[] = [];
  for (const layer of router.stack) {
    if (layer.route === undefined) continue;
    for (const [m, on] of Object.entries(layer.route.methods))
      if (on === true) out.push(`${m.toUpperCase()} ${layer.route.path}`);
  }
  return out.sort();
}

describe('buildApp with chat', () => {
  it('AT-31: the route table is exactly the four approval-queue routes, /messages, /my-requests, /chat, /conversations/:id and the four onboarding routes (onboarding-api OQ-1)', async () => {
    const { app } = await world();
    expect(routeTable(app)).toEqual(
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

  it('AT-31: a leave created through POST /chat appears in GET /approvals for the manager and GET /my-requests for the employee', async () => {
    const { call } = await world();
    const first = await call('emp-004', 'POST', '/chat', {
      message: 'I need annual leave next month',
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('question');
    const second = await call('emp-004', 'POST', '/chat', {
      conversationId: first.body.conversationId,
      message: 'From 2026-11-16 to 2026-11-17',
    });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('leave_submitted');
    const id = String(second.body.requestId);
    const queue = await call('emp-002', 'GET', '/approvals');
    expect(queue.text).toContain(id);
    const mine = await call('emp-004', 'GET', '/my-requests');
    expect(mine.text).toContain(id);
  });
});
