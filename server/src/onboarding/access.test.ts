// Acceptance tests for specs/onboarding-api.md: AT-5 (route table, old paths gone, 401 before any store
// read, 'patch' in defineRoute, no gate imports) and AT-22 (handler sources have no clock, randomness
// or env). ASSUMED contracts: createOnboardingRoutes(OnboardingRouteDeps) as in tasks.test.ts;
// defineRoute / RouteDefinition accept method 'patch'; createApp mounts it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryAuditSink } from '../agents/audit.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemorySubjectResolver,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createApp } from '../http/app.js';
import { defineRoute } from '../http/route.js';
import { fixtures } from '../seeds/fixtures.js';
import { InMemoryOnboardingStore } from './in-memory.js';
import { createOnboardingRoutes, type OnboardingRouteDeps } from './routes.js';

const NOW = '2026-10-21T09:00:00Z';

function makeApp() {
  const sink = new InMemoryAuditSink();
  const store = new InMemoryOnboardingStore();
  const storeCalls: string[] = [];
  const onboarding = new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        storeCalls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const directory = new InMemoryEmployeeDirectory(fixtures.employees, fixtures.teams);
  const clock = { nowIso: () => NOW };
  const idGen = () => 'id-1';
  const unused = (name: string) => () => Promise.reject(new Error(`${name} must not be used`));
  const routes = createOnboardingRoutes({
    directory,
    onboarding,
    approvals: { insert: unused('insert'), remove: unused('remove') },
    messages: { recordMessage: unused('recordMessage') },
    audit: sink,
    clock,
    idGen,
    idempotency: {
      begin: unused('begin'),
      complete: unused('complete'),
      release: unused('release'),
    },
    policy: undefined,
    evaluateOnboarding: () => {
      throw new Error('unused');
    },
    toIsoDate: (iso: string) => iso.slice(0, 10),
    runOnboardingNotes: unused('runOnboardingNotes'),
    onboardingTexts: { load: () => Promise.resolve(null) },
    intakeTexts: { load: () => Promise.resolve(null) },
  } as unknown as OnboardingRouteDeps);
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
      store,
    ),
    audit: sink,
    auditReader: new InMemoryAuditReader(sink),
    clock,
    idGen,
    onboarding,
  } as unknown as ApprovalApiDeps;
  return { app: createApp(deps, routes), storeCalls };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});
async function send(method: string, path: string, user?: string, body?: unknown) {
  const { app, storeCalls } = makeApp();
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((r) =>
    server.once('listening', () => {
      r();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const headers: Record<string, string> = {};
  if (user !== undefined) headers['x-demo-user'] = user;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${String(addr.port)}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, storeCalls };
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean | undefined> };
}

describe('onboarding-api AT-5: the four routes and nothing else', () => {
  it('AT-5: the onboarding route table is exactly POST, GET list, GET one and PATCH task', () => {
    const router = (makeApp().app as unknown as { router: { stack: RouteLayer[] } }).router;
    const out: string[] = [];
    for (const layer of router.stack) {
      if (!layer.route?.path.startsWith('/onboarding')) continue;
      for (const [m, on] of Object.entries(layer.route.methods)) {
        if (on === true) out.push(`${m.toUpperCase()} ${layer.route.path}`);
      }
    }
    expect(out.sort()).toEqual(
      [
        'GET /onboarding',
        'GET /onboarding/:checklistId',
        'PATCH /onboarding/:checklistId/tasks/:taskId',
        'POST /onboarding',
      ].sort(),
    );
  });

  it.each([
    ['GET', '/onboarding/checklists/chk-a'],
    ['GET', '/onboarding/checklists'],
    ['POST', '/onboarding/checklists/chk-a/tasks/laptop/complete'],
    ['PUT', '/onboarding'],
    ['DELETE', '/onboarding'],
    ['PUT', '/onboarding/chk-a'],
    ['DELETE', '/onboarding/chk-a'],
    ['PUT', '/onboarding/chk-a/tasks/laptop'],
    ['DELETE', '/onboarding/chk-a/tasks/laptop'],
  ])('AT-5: %s %s is 404', async (method, path) => {
    const body = method === 'POST' || method === 'PUT' ? {} : undefined;
    expect((await send(method, path, 'emp-001', body)).status).toBe(404);
  });

  it('AT-5: a PATCH without x-demo-user (or with an unknown user) is 401 before any store read', async () => {
    const none = await send('PATCH', '/onboarding/chk-a/tasks/laptop', undefined, {
      status: 'done',
    });
    expect(none.status).toBe(401);
    expect(none.storeCalls).toEqual([]);
    const unknown = await send('PATCH', '/onboarding/chk-a/tasks/laptop', 'emp-999', {
      status: 'done',
    });
    expect(unknown.status).toBe(401);
    expect(unknown.storeCalls).toEqual([]);
  });

  it("AT-5: defineRoute accepts method 'patch'", () => {
    const route = defineRoute({
      method: 'patch',
      path: '/x/:id',
      params: z.object({ id: z.string() }).strict(),
      query: z.object({}).strict(),
      body: z.object({}).strict(),
      response: z.object({}).strict(),
      handler: () => Promise.resolve({}),
    });
    expect(route.method).toBe('patch');
  });
});

const SRC = join(import.meta.dirname, '..');
function sources(dir: string, recursive: boolean): string[] {
  expect(existsSync(dir), `${dir} must exist`).toBe(true);
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && recursive) out.push(...sources(p, true));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('onboarding-api AT-5, AT-22: source hygiene', () => {
  it('AT-5: no file under onboarding/ or http/ imports from gate/', () => {
    const files = [...sources(join(SRC, 'onboarding'), true), ...sources(join(SRC, 'http'), true)];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from\s+['"][^'"]*\/gate\//);
    }
  });

  it('AT-22: the handler sources have no Date.now, argument-less new Date(), Math.random or process.env', () => {
    const files = sources(join(SRC, 'onboarding'), false);
    expect(files.map((f) => f.split('/').pop())).toEqual(
      expect.arrayContaining(['routes.ts', 'schemas.ts', 'in-memory.ts']),
    );
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/Date\.now/);
      expect(src, f).not.toMatch(/new Date\(\s*\)/);
      expect(src, f).not.toMatch(/Math\.random/);
      expect(src, f).not.toMatch(/process\.env/);
    }
  });
});
