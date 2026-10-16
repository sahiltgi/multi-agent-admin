// Exact response bodies for request intake (spec request-intake, D-6, D-7, D-14, D-15, D-16, rule 10).
// Added after code review: these pin the employee-facing views field by field.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import type { RecommendationCard } from '../agents/leave/schemas.js';
import type { ApprovalItem, LeaveRequest } from '../domain/schemas.js';
import { createApp } from '../http/app.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
} from '../http/approvals/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import {
  InMemoryIdempotencyStore,
  InMemoryIntakeTexts,
  InMemoryLeaveRequestStore,
} from './in-memory.js';
import type { IdempotencyStore, IntakeDeps, IntakeTextName } from './ports.js';
import { createIntakeRoutes } from './routes.js';
import { MessageResponse } from './schemas.js';

const NOW = '2026-10-16T09:00:00Z';
const POLICY_HASH = '0123456789abcdef'.repeat(4);
const TEXTS: Record<IntakeTextName, string> = {
  not_available: 'NOT-AVAILABLE-FIXTURE',
  escalated: 'ESCALATED-FIXTURE',
  returned: 'RETURNED-FIXTURE',
  hr_admin_self: 'HR-ADMIN-SELF-FIXTURE',
};

function card(verdict: RecommendationCard['verdict'], employeeId = 'emp-004'): RecommendationCard {
  return {
    requestId: 'lr-001',
    employeeId,
    request: { employeeId, leaveType: 'annual', startDate: '2026-11-16', endDate: '2026-11-17' },
    today: '2026-10-16',
    verdict,
    ruleResults: [
      {
        ruleId: 'balance_sufficient',
        passed: true,
        expected: 'Balance covers the request',
        actual: 'Balance covers the request',
        message: 'Balance is sufficient.',
      },
      {
        ruleId: 'team_overlap',
        passed: false,
        expected: 'At most 30% of the team away',
        actual: '40% of the team away',
        message: 'Too many team members are away on these dates.',
      },
    ],
    reason: 'Synthetic gate reason',
    policyVersion: 'v1',
    policyHash: POLICY_HASH,
    summary: 'Synthetic summary sentence.',
    summarySource: 'model',
    model: 'test-model',
    promptVersion: 'v1',
  };
}

function leave(id: string, createdAt: string): LeaveRequest {
  return {
    id,
    employeeId: 'emp-004',
    leaveType: 'annual',
    startDate: '2026-12-01',
    endDate: '2026-12-02',
    reason: 'Synthetic private reason',
    status: 'pending_approval',
    summary: 'Synthetic stored summary.',
    summarySource: 'model',
    createdAt,
  };
}

function world(opts: {
  leaves?: LeaveRequest[];
  items?: ApprovalItem[];
  texts?: Partial<Record<IntakeTextName, string>>;
  idempotency?: IdempotencyStore;
}) {
  const sink = new InMemoryAuditSink();
  const store = new InMemoryLeaveRequestStore(opts.leaves ?? []);
  const approvals = new InMemoryApprovalStore(opts.items ?? []);
  const directory = new InMemoryEmployeeDirectory(fixtures.employees);
  let n = 0;
  const idGen = () => `lr-${String((n += 1)).padStart(3, '0')}`;
  const classify = vi.fn<IntakeDeps['classify']>();
  const runLeave = vi.fn<IntakeDeps['runLeave']>();
  const deps: IntakeDeps = {
    directory,
    leaveRequests: store,
    approvals,
    approvalReader: approvals,
    audit: sink,
    clock: { nowIso: () => NOW },
    idGen,
    classify,
    runLeave,
    texts: new InMemoryIntakeTexts(opts.texts ?? TEXTS),
    idempotency: opts.idempotency ?? new InMemoryIdempotencyStore(),
  };
  const app = createApp(
    {
      directory,
      approvals,
      subjects: store,
      audit: sink,
      auditReader: new InMemoryAuditReader(sink),
      clock: { nowIso: () => NOW },
      idGen,
    },
    createIntakeRoutes(deps),
  );
  return { app, classify, runLeave, store, approvals };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function call(
  app: ReturnType<typeof world>['app'],
  user: string,
  path: string,
  body?: unknown,
) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const r = await fetch(`http://127.0.0.1:${String(addr.port)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-demo-user': user,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as unknown };
}

const leaveDecision = (requestId: string) =>
  ({
    requestId,
    model: 'test-model',
    promptVersion: 'v1',
    source: 'model',
    fallbackReason: null,
    label: 'leave',
    targetAgent: 'leave',
  }) as const;

describe('request-intake: exact employee views', () => {
  it('D-15: leave_submitted carries the request view, the copied verdict and the failed rules only', async () => {
    const w = world({});
    w.classify.mockImplementation((i) => Promise.resolve(leaveDecision(i.requestId)));
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('ROUTE_TO_MANAGER_WITH_FLAGS'),
      injectionSuspected: true,
    });
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Annual leave please' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'leave_submitted',
      requestId: 'lr-001',
      request: {
        requestId: 'lr-001',
        leaveType: 'annual',
        startDate: '2026-11-16',
        endDate: '2026-11-17',
        status: 'pending_approval',
        approvalStatus: 'open',
        decision: null,
        createdAt: NOW,
      },
      verdict: 'ROUTE_TO_MANAGER_WITH_FLAGS',
      failedRules: [
        { ruleId: 'team_overlap', message: 'Too many team members are away on these dates.' },
      ],
    });
    for (const hidden of ['summary', 'injectionSuspected', 'expected', 'actual', 'policyHash']) {
      expect(res.text).not.toContain(hidden);
    }
  });

  it('D-16: /my-requests shows approval status and decision without byEmployeeId, newest first', async () => {
    const decided: ApprovalItem = {
      id: 'ap-1',
      kind: 'leave_request',
      subjectId: 'lr-201',
      assigneeRole: 'manager',
      assigneeId: 'emp-002',
      flagged: false,
      status: 'approved',
      decision: { action: 'approve', byEmployeeId: 'emp-002', comment: 'Enjoy it', at: NOW },
      createdAt: '2026-10-01T08:00:00Z',
    };
    const w = world({
      leaves: [
        leave('lr-201', '2026-10-01T08:00:00Z'),
        leave('lr-203', '2026-10-03T08:00:00Z'),
        leave('lr-202', '2026-10-03T08:00:00Z'),
      ],
      items: [decided],
    });
    const res = await call(w.app, 'emp-004', '/my-requests');
    expect(res.status).toBe(200);
    const base = {
      leaveType: 'annual',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      status: 'pending_approval',
    };
    expect(res.body).toEqual({
      requests: [
        {
          ...base,
          requestId: 'lr-202',
          approvalStatus: null,
          decision: null,
          createdAt: '2026-10-03T08:00:00Z',
        },
        {
          ...base,
          requestId: 'lr-203',
          approvalStatus: null,
          decision: null,
          createdAt: '2026-10-03T08:00:00Z',
        },
        {
          ...base,
          requestId: 'lr-201',
          approvalStatus: 'approved',
          decision: { action: 'approve', comment: 'Enjoy it', at: NOW },
          createdAt: '2026-10-01T08:00:00Z',
        },
      ],
    });
    for (const hidden of ['byEmployeeId', 'emp-002', 'summary', 'Synthetic private reason']) {
      expect(res.text).not.toContain(hidden);
    }
  });
});

describe('request-intake: card checks and missing texts', () => {
  it('rule 10: a RETURN_TO_EMPLOYEE card for another employee is escalated, not returned', async () => {
    const w = world({});
    w.classify.mockImplementation((i) => Promise.resolve(leaveDecision(i.requestId)));
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('RETURN_TO_EMPLOYEE', 'emp-007'),
      injectionSuspected: false,
    });
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Annual leave please' });
    expect(res.status).toBe(200);
    expect(MessageResponse.parse(res.body)).toEqual({
      kind: 'escalated',
      requestId: 'lr-001',
      text: 'ESCALATED-FIXTURE',
    });
  });

  it('D-14: a missing returned text takes the escalation path', async () => {
    const w = world({ texts: { ...TEXTS, returned: ' ' } });
    w.classify.mockImplementation((i) => Promise.resolve(leaveDecision(i.requestId)));
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('RETURN_TO_EMPLOYEE'),
      injectionSuspected: false,
    });
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Annual leave please' });
    expect(MessageResponse.parse(res.body).kind).toBe('escalated');
  });

  it('D-14: a missing hr_admin_self text takes the escalation path and persists nothing', async () => {
    const w = world({ texts: { ...TEXTS, hr_admin_self: '' } });
    w.classify.mockImplementation((i) => Promise.resolve(leaveDecision(i.requestId)));
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: card('ROUTE_TO_MANAGER', 'emp-001'),
      injectionSuspected: false,
    });
    const res = await call(w.app, 'emp-001', '/messages', { text: 'Annual leave please' });
    expect(MessageResponse.parse(res.body).kind).toBe('escalated');
    expect(await w.store.listByEmployee('emp-001')).toEqual([]);
    expect(await w.approvals.list()).toEqual([]);
  });
});

describe('request-intake: security review hardening', () => {
  it('D-11: a key whose completion fails after the writes is never released, so a retry cannot duplicate', async () => {
    const inner = new InMemoryIdempotencyStore();
    const failing: IdempotencyStore = {
      begin: (...a) => inner.begin(...a),
      complete: () => Promise.reject(new Error('store-down')),
      release: (...a) => inner.release(...a),
    };
    const w = world({ idempotency: failing });
    w.classify.mockImplementation((i) => Promise.resolve(leaveDecision(i.requestId)));
    w.runLeave.mockImplementation((i) =>
      Promise.resolve({
        kind: 'card',
        card: { ...card('ROUTE_TO_MANAGER'), requestId: i.requestId },
        injectionSuspected: false,
      }),
    );
    const body = { text: 'Annual leave please', idempotencyKey: 'key-1' };
    const first = await call(w.app, 'emp-004', '/messages', body);
    expect(first.status).toBe(200);
    const retry = await call(w.app, 'emp-004', '/messages', body);
    expect(retry.status).toBe(409);
    expect(await w.store.listByEmployee('emp-004')).toHaveLength(1);
    expect(await w.approvals.list()).toHaveLength(1);
  });

  it('D-9: a message id that collides with an existing request fails closed and never joins its trace', async () => {
    const other: LeaveRequest = {
      ...leave('lr-001', '2026-10-01T08:00:00Z'),
      employeeId: 'emp-003',
    };
    const w = world({ leaves: [other] });
    w.classify.mockImplementation((i) =>
      Promise.resolve({
        ...leaveDecision(i.requestId),
        label: 'out_of_scope',
        reply: 'X',
      } as never),
    );
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Hello there' });
    expect(res.status).toBe(500);
    expect(w.classify).not.toHaveBeenCalled();
    expect(await w.store.ownerOfRequest('lr-001')).toBe('emp-003');
  });

  it('rule 7: an orchestrator result that fails its schema is escalated and runs no sub-agent', async () => {
    const w = world({});
    w.classify.mockImplementation((i) =>
      Promise.resolve({ ...leaveDecision(i.requestId), label: 'approve_all' } as never),
    );
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Annual leave please' });
    expect(res.status).toBe(200);
    expect(MessageResponse.parse(res.body).kind).toBe('escalated');
    expect(w.runLeave).not.toHaveBeenCalled();
  });

  it('rule 8: a Leave Agent result that fails its schema is escalated and persists nothing', async () => {
    const w = world({});
    w.classify.mockImplementation((i) => Promise.resolve(leaveDecision(i.requestId)));
    w.runLeave.mockResolvedValue({
      kind: 'card',
      card: { ...card('ROUTE_TO_MANAGER'), approved: true },
      injectionSuspected: false,
    } as never);
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Annual leave please' });
    expect(res.status).toBe(200);
    expect(MessageResponse.parse(res.body).kind).toBe('escalated');
    expect(await w.store.listByEmployee('emp-004')).toEqual([]);
    expect(await w.approvals.list()).toEqual([]);
  });
});

describe('request-intake: agent request ids', () => {
  it('rule 6: an orchestrator decision for another request id is escalated', async () => {
    const w = world({});
    w.classify.mockResolvedValue({
      requestId: 'lr-999',
      model: 'test-model',
      promptVersion: 'v1',
      source: 'model',
      fallbackReason: null,
      label: 'out_of_scope',
      reply: 'OUT-OF-SCOPE-FIXTURE',
    });
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Hello there' });
    expect(res.status).toBe(200);
    expect(MessageResponse.parse(res.body).kind).toBe('escalated');
    expect(w.runLeave).not.toHaveBeenCalled();
  });

  it('rule 6: a Leave Agent question for another request id is escalated', async () => {
    const w = world({});
    w.classify.mockImplementation((i) => Promise.resolve(leaveDecision(i.requestId)));
    w.runLeave.mockResolvedValue({
      kind: 'needs_details',
      requestId: 'lr-999',
      question: 'Which dates would you like off?',
      questionSource: 'model',
      injectionSuspected: false,
    });
    const res = await call(w.app, 'emp-004', '/messages', { text: 'Some time off' });
    expect(res.status).toBe(200);
    expect(MessageResponse.parse(res.body).kind).toBe('escalated');
  });
});
