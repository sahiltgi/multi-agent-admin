// Red team (docs/red-team.md) RED-15, RED-22 and RED-23: raw HTTP attacks on createApp's
// identity, body-parser and error middleware. Bodies are sent as raw strings, so malformed and
// oversized inputs reach the parser unchanged.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryAuditSink } from '../agents/audit.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import { createApp } from './app.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemorySubjectResolver,
} from './approvals/in-memory.js';
import type { ApprovalApiDeps } from './approvals/ports.js';
import { ErrorBody } from './errors.js';
import { defineRoute } from './route.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

function world() {
  const sink = new InMemoryAuditSink();
  const deps: ApprovalApiDeps = {
    directory: new InMemoryEmployeeDirectory(fixtures.employees),
    approvals: new InMemoryApprovalStore([]),
    subjects: new InMemorySubjectResolver([], {
      insert: () => Promise.resolve(true),
      get: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
    }),
    audit: sink,
    auditReader: new InMemoryAuditReader(sink),
    clock: { nowIso: () => '2026-10-15T10:00:00Z' },
    idGen: () => 'ae-1',
    onboarding: new InMemoryOnboardingStore(),
    holidays: { getHolidays: () => Promise.resolve([]) },
  };
  return { deps, sink };
}

// A route with the same strict body shape as POST /messages; it counts the calls that reach it.
const empty = z.object({}).strict();
function echoRoute(hits: { n: number }) {
  return defineRoute({
    method: 'post',
    path: '/test/echo',
    params: empty,
    query: empty,
    body: z.object({ text: z.string().min(1).max(4000) }).strict(),
    response: z.object({ length: z.number() }).strict(),
    handler: ({ body }) => {
      hits.n += 1;
      return Promise.resolve({ length: body.text.length });
    },
  });
}

async function boot() {
  const w = world();
  const hits = { n: 0 };
  const server = createApp(w.deps, [echoRoute(hits)]).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${String(addr.port)}/test/echo`;
  const raw = async (body: string, headers: Record<string, string>) => {
    const r = await fetch(url, { method: 'POST', headers, body });
    const text = await r.text();
    return { status: r.status, text };
  };
  return { ...w, hits, raw };
}

const JSON_AS = (user: string) => ({ 'x-demo-user': user, 'content-type': 'application/json' });

function expectRejected(res: { status: number; text: string }, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(JSON.parse(res.text)).error.code).toBe(code);
}

describe('red team: raw HTTP bodies', () => {
  it('RED-22: a body over the 16kb limit is 400 invalid_request and never reaches the route', async () => {
    const t = await boot();
    const secret = 'synthetic-marker-in-oversized-body';
    const res = await t.raw(
      JSON.stringify({ text: `${secret} ${'x'.repeat(20_000)}` }),
      JSON_AS('emp-004'),
    );
    expectRejected(res, 400, 'invalid_request');
    expect(res.text).not.toContain(secret);
    expect(t.hits.n).toBe(0);
    expect(t.sink.events).toHaveLength(0);
  });

  it('RED-22: an oversized body without identity is 401 before the body is parsed', async () => {
    const t = await boot();
    const res = await t.raw(JSON.stringify({ text: 'x'.repeat(20_000) }), {
      'content-type': 'application/json',
    });
    expectRejected(res, 401, 'unauthenticated');
    expect(t.hits.n).toBe(0);
  });

  it('RED-23: malformed JSON is 400 invalid_request without the parser message', async () => {
    const t = await boot();
    const res = await t.raw('{"text": "leave pls",', JSON_AS('emp-004'));
    expectRejected(res, 400, 'invalid_request');
    expect(res.text).not.toMatch(/Unexpected|position|JSON\.parse|at /);
    expect(t.hits.n).toBe(0);
  });

  it('RED-23: text/plain, array, operator and __proto__ bodies are 400 at the strict schema', async () => {
    const t = await boot();
    const cases: { body: string; headers: Record<string, string> }[] = [
      { body: 'text=leave', headers: { 'x-demo-user': 'emp-004', 'content-type': 'text/plain' } },
      { body: '[{"text":"leave"}]', headers: JSON_AS('emp-004') },
      { body: '{"text":{"$gt":""}}', headers: JSON_AS('emp-004') },
      { body: '{"text":"hi","__proto__":{"role":"hr_admin"}}', headers: JSON_AS('emp-004') },
      {
        body: '{"text":"hi","role":"hr_admin","employeeId":"emp-001"}',
        headers: JSON_AS('emp-004'),
      },
    ];
    for (const c of cases) {
      const res = await t.raw(c.body, c.headers);
      expectRejected(res, 400, 'invalid_request');
      expect(res.text, c.body).not.toContain('hr_admin');
      expect(res.text, c.body).not.toContain('$gt');
    }
    expect(t.hits.n).toBe(0);
    expect(t.sink.events).toHaveLength(0);
  });

  it('RED-15: unknown, injected and doubled identity headers are 401', async () => {
    const t = await boot();
    const ok = JSON.stringify({ text: 'hi' });
    for (const user of ['emp-999', "emp-004' OR '1'='1", 'emp-004, emp-001', 'emp-004\temp-001']) {
      const res = await t.raw(ok, JSON_AS(user));
      expectRejected(res, 401, 'unauthenticated');
    }
    expect(t.hits.n).toBe(0);
    const accepted = await t.raw(ok, JSON_AS('emp-004'));
    expect(accepted.status).toBe(200);
    expect(t.hits.n).toBe(1);
  });
});
