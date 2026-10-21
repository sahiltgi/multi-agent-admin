// AT-5 (specs/approval-queue.md, rule 3): invalid responses and thrown errors never leak.
// createApp(deps, extraRoutes?) mounts extra RouteDefinitions behind the same identity and
// error middleware; the approval routes stay the default.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryAuditSink } from '../agents/audit.js';
import { fixtures } from '../seeds/fixtures.js';
import { createApp } from './app.js';
import { ErrorBody } from './errors.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemorySubjectResolver,
} from './approvals/in-memory.js';
import type { ApprovalApiDeps } from './approvals/ports.js';
import { ListApprovalsResponse } from './approvals/schemas.js';
import { defineRoute } from './route.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

function deps(): ApprovalApiDeps {
  const sink = new InMemoryAuditSink();
  let n = 0;
  return {
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
    idGen: () => `ae-${String(++n)}`,
  };
}

const empty = z.object({}).strict();

const leakRoute = defineRoute({
  method: 'get',
  path: '/test/leak',
  params: empty,
  query: empty,
  body: empty,
  response: ListApprovalsResponse,
  // The cast is deliberate: this route must return an invalid response to test rule 3.
  handler: () =>
    Promise.resolve({
      items: [{ unexpected: 'leak-xyz' }],
    } as unknown as ListApprovalsResponse),
});

const boomRoute = defineRoute({
  method: 'get',
  path: '/test/boom',
  params: empty,
  query: empty,
  body: empty,
  response: ListApprovalsResponse,
  handler: () => Promise.reject(new Error('secret-detail')),
});

async function get(path: string): Promise<{ status: number; text: string; body: unknown }> {
  const server = createApp(deps(), [leakRoute, boomRoute]).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const r = await fetch(`http://127.0.0.1:${String(addr.port)}${path}`, {
    headers: { 'x-demo-user': 'emp-001' },
  });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as unknown };
}

describe('route helper', () => {
  it('AT-5: a response that fails its schema is 500 internal_error and is not sent', async () => {
    const res = await get('/test/leak');
    expect(res.status).toBe(500);
    expect(ErrorBody.parse(res.body).error.code).toBe('internal_error');
    expect(res.text).not.toContain('leak-xyz');
  });

  it('AT-5: a thrown error is 500 internal_error with no message and no stack trace', async () => {
    const res = await get('/test/boom');
    expect(res.status).toBe(500);
    expect(ErrorBody.parse(res.body).error.code).toBe('internal_error');
    expect(res.text).not.toContain('secret-detail');
    expect(res.text).not.toMatch(/\bat\s.+:\d+:\d+/);
    expect(res.text).not.toContain('stack');
  });
});
