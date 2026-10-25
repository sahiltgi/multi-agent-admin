// specs/agent-metrics.md AT-14 to AT-17 and the route half of AT-26 (rules 12 to 14, 16, 23).
import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import type { AuditEvent } from '../domain/schemas.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemorySubjectResolver,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createApp } from '../http/app.js';
import { errorBody } from '../http/errors.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import { AgentMetricsResponse } from './schemas.js';
import { createMetricsRoutes } from './routes.js';

const NOW = '2026-10-25T12:00:00.000Z';

function makeWorld(events: AuditEvent[] = []) {
  const sink = new InMemoryAuditSink();
  const onboarding = new InMemoryOnboardingStore([], []);
  const directory = new InMemoryEmployeeDirectory(fixtures.employees, fixtures.teams);
  const deps = {
    directory,
    approvals: new InMemoryApprovalStore([]),
    subjects: new InMemorySubjectResolver(
      [],
      {
        insert: () => Promise.resolve(true),
        get: () => Promise.resolve(null),
        remove: () => Promise.resolve(),
      },
      onboarding,
    ),
    audit: sink,
    auditReader: new InMemoryAuditReader(sink),
    clock: { nowIso: () => NOW },
    idGen: () => 'x-1',
    onboarding,
  } as unknown as ApprovalApiDeps;
  const listByKinds = vi.fn(() => Promise.resolve(events));
  const routes = createMetricsRoutes({ summaries: { listByKinds }, clock: { nowIso: () => NOW } });
  return { deps, routes, listByKinds };
}
type World = ReturnType<typeof makeWorld>;

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function get(w: World, user: string | undefined, query = '') {
  const server = createApp(w.deps, w.routes).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const headers: Record<string, string> = {};
  if (user !== undefined) headers['x-demo-user'] = user;
  const r = await fetch(`http://127.0.0.1:${String(addr.port)}/metrics/agents${query}`, {
    headers,
  });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: r.status, text, body };
}

const METRICS_DIR = import.meta.dirname;
const sources = () =>
  readdirSync(METRICS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ f, src: readFileSync(join(METRICS_DIR, f), 'utf8') }));

describe('agent-metrics AT-14: module shape', () => {
  it('AT-14: the module has the six files, is mounted by buildApp, and imports no gate or model client', () => {
    const names = sources().map((s) => s.f);
    for (const f of ['schemas.ts', 'ports.ts', 'usage.ts', 'aggregate.ts', 'routes.ts']) {
      expect(names).toContain(f);
    }
    const app = readFileSync(join(METRICS_DIR, '..', 'server', 'app.ts'), 'utf8');
    expect(app).toContain('createMetricsRoutes');
    for (const { f, src } of sources()) {
      expect(src, f).not.toMatch(/from\s+'[^']*\/gate\//);
      expect(src, f).not.toMatch(/Date\.now/);
      expect(src, f).not.toMatch(/new Date\(\)/);
      expect(src, f).not.toMatch(/Math\.random/);
      expect(src, f).not.toMatch(/process\.env/);
      const agentImports = [...src.matchAll(/^import[^;]*from\s+'([^']*\/agents\/[^']*)'/gm)];
      for (const m of agentImports) {
        expect(m[0], f).toMatch(/RouteLabel|ROUTE_LABELS/);
        expect(m[0], f).not.toMatch(/ModelClient/);
      }
    }
  });
});

describe('agent-metrics AT-15: RBAC', () => {
  it('AT-15: employee and manager get 403 with the forbidden body and no reader call', async () => {
    for (const user of ['emp-004', 'emp-002']) {
      const w = makeWorld();
      const res = await get(w, user);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(errorBody('forbidden'));
      expect(w.listByKinds).toHaveBeenCalledTimes(0);
    }
  });

  it('AT-15: no header is 401; hr_admin is 200 and parses as AgentMetricsResponse', async () => {
    const w = makeWorld();
    expect((await get(w, undefined)).status).toBe(401);
    const res = await get(w, 'emp-001');
    expect(res.status).toBe(200);
    expect(AgentMetricsResponse.safeParse(res.body).success).toBe(true);
  });

  it('AT-15: parsing comes before the role check (employee with ?from=bad is 400)', async () => {
    const w = makeWorld();
    const res = await get(w, 'emp-004', '?from=bad');
    expect(res.status).toBe(400);
    expect(w.listByKinds).toHaveBeenCalledTimes(0);
  });
});

describe('agent-metrics AT-16: window defaults and normalisation', () => {
  it('AT-16: no query reads the last 30 days and echoes both ends', async () => {
    const w = makeWorld();
    const res = await get(w, 'emp-001');
    expect(w.listByKinds).toHaveBeenCalledTimes(1);
    const args = w.listByKinds.mock.calls[0] as unknown as [string[], string, string];
    expect(args[1]).toBe('2026-09-25T12:00:00.000Z');
    expect(args[2]).toBe(NOW);
    expect(res.body).toMatchObject({ from: '2026-09-25T12:00:00.000Z', to: NOW });
  });

  it('AT-16: only to gives from = to minus 30 days', async () => {
    const w = makeWorld();
    const res = await get(w, 'emp-001', '?to=2026-10-10T00:00:00Z');
    expect(res.body).toMatchObject({
      from: '2026-09-10T00:00:00.000Z',
      to: '2026-10-10T00:00:00.000Z',
    });
  });

  it('AT-16: an offset from is normalised to UTC', async () => {
    const w = makeWorld();
    const res = await get(w, 'emp-001', `?from=${encodeURIComponent('2026-10-01T05:30:00+05:30')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: '2026-10-01T00:00:00.000Z' });
  });
});

describe('agent-metrics AT-17: invalid windows', () => {
  const windowInvalid = [{ path: ['query', 'from'], code: 'window_invalid' }];

  it('AT-17: from after to, and a future from alone, are window_invalid with no reader call', async () => {
    for (const q of [
      '?from=2026-10-10T00:00:00Z&to=2026-10-01T00:00:00Z',
      '?from=2026-11-01T00:00:00Z',
    ]) {
      const w = makeWorld();
      const res = await get(w, 'emp-001', q);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(errorBody('invalid_request', windowInvalid));
      expect(w.listByKinds).toHaveBeenCalledTimes(0);
      expect(res.text).not.toContain('2026-11-01');
      expect(res.text).not.toContain('2026-10-10');
    }
  });

  it('AT-17: malformed values and unknown keys are 400 with no echo and no reader call', async () => {
    const queries = [
      '?from=2026-10-01',
      '?from=yesterday',
      '?from=',
      '?from=2026-10-01T00:00:00Z&from=2026-10-02T00:00:00Z',
      '?from[$gt]=',
      '?agent=leave',
      '?role=hr_admin',
    ];
    for (const q of queries) {
      const w = makeWorld();
      const res = await get(w, 'emp-001', q);
      expect(res.status, q).toBe(400);
      expect(res.text, q).not.toContain('yesterday');
      expect(res.text, q).not.toContain('2026-10-01');
      expect(res.text, q).not.toContain('$gt');
      expect(w.listByKinds, q).toHaveBeenCalledTimes(0);
    }
  });

  it('AT-17: a bound that normalises past year 9999 is window_invalid with no reader call', async () => {
    const w = makeWorld();
    const res = await get(w, 'emp-001', `?to=${encodeURIComponent('9999-12-31T23:00:00-05:00')}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errorBody('invalid_request', windowInvalid));
    expect(w.listByKinds).toHaveBeenCalledTimes(0);
  });

  it('AT-17: from == to is allowed', async () => {
    const w = makeWorld();
    const t = encodeURIComponent('2026-10-10T00:00:00Z');
    const res = await get(w, 'emp-001', `?from=${t}&to=${t}`);
    expect(res.status).toBe(200);
  });
});

describe('agent-metrics AT-26 (route): a malformed stored event fails closed', () => {
  it('AT-26: an event with outcome approved gives 500 internal_error', async () => {
    const bad = {
      id: 'evt-1',
      traceId: 'req-1',
      at: '2026-10-20T10:00:00.000Z',
      actor: { kind: 'system', id: 'intake' },
      eventType: 'agent_step',
      payload: { kind: 'intake_outcome', requestId: 'req-1', label: 'leave', outcome: 'approved' },
    } as unknown as AuditEvent;
    const w = makeWorld([bad]);
    const res = await get(w, 'emp-001');
    expect(res.status).toBe(500);
    expect(res.body).toEqual(errorBody('internal_error'));
  });
});
