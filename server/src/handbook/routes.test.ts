// Spec employee-chat: AT-19 (rule 14), GET /handbook/sections/:id.
// Factory name chosen for the code step: createHandbookRoutes({ handbook: { body } }) returns
// RouteDefinition[] (like createApprovalRoutes) and is passed to createApp's extraRoutes.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import { handbookSections } from '../domain/handbook.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import { createApp } from '../http/app.js';
import { ErrorBody } from '../http/errors.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemorySubjectResolver,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createHandbookRoutes } from './routes.js';
import { HandbookSectionResponse } from './schemas.js';

// Synthetic handbook body with three sections.
const B =
  '## Leave\n\n### HB-1.1 Annual leave\nEmployees get 25 days.\n\n### HB-1.2 Sick leave\nEmployees get 10 sick days per year.\n\n## Conduct\n\n### HB-2.1 Conduct\nBe kind.\n';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

function setup() {
  const sink = new InMemoryAuditSink();
  const approvals = new InMemoryApprovalStore([]);
  let n = 0;
  const deps: ApprovalApiDeps = {
    directory: new InMemoryEmployeeDirectory(fixtures.employees),
    approvals,
    subjects: new InMemorySubjectResolver([], {
      insert: () => Promise.resolve(true),
      get: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
    }),
    audit: sink,
    auditReader: new InMemoryAuditReader(sink),
    clock: { nowIso: () => '2026-10-15T10:00:00Z' },
    idGen: () => `ae-${String(++n)}`,
    onboarding: new InMemoryOnboardingStore(),
  };
  const server = createApp(deps, createHandbookRoutes({ handbook: { body: B } })).listen(
    0,
    '127.0.0.1',
  );
  servers.push(server);
  return { server, sink, approvals };
}

async function get(
  path: string,
  user: string | null,
): Promise<{ status: number; body: unknown; sinkCount: number; itemCount: number }> {
  const { server, sink, approvals } = setup();
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const r = await fetch(`http://127.0.0.1:${String(addr.port)}${path}`, {
    headers: user === null ? {} : { 'x-demo-user': user },
  });
  const body: unknown = await r.json();
  // Read-only: the audit sink and the approvals store stay empty after every call.
  return {
    status: r.status,
    body,
    sinkCount: sink.events.length,
    itemCount: (await approvals.list()).length,
  };
}

describe('GET /handbook/sections/:id', () => {
  it('AT-19: every seeded persona gets the exact section slice as a strict response', async () => {
    const s = handbookSections(B).find((x) => x.id === 'HB-1.2');
    if (s === undefined) throw new Error('fixture section missing');
    for (const user of ['emp-001', 'emp-002', 'emp-003']) {
      const res = await get('/handbook/sections/HB-1.2', user);
      expect(res.status).toBe(200);
      const parsed = HandbookSectionResponse.parse(res.body);
      expect(parsed).toEqual({ id: 'HB-1.2', text: B.slice(s.start, s.end) });
      expect(res.sinkCount).toBe(0);
      expect(res.itemCount).toBe(0);
    }
  });

  it('AT-19: no x-demo-user is 401 unauthenticated', async () => {
    const res = await get('/handbook/sections/HB-1.2', null);
    expect(res.status).toBe(401);
    expect(ErrorBody.parse(res.body).error.code).toBe('unauthenticated');
    expect(res.sinkCount).toBe(0);
    expect(res.itemCount).toBe(0);
  });

  it('AT-19: invalid ids are 400 invalid_request and an unknown id is 404 not_found', async () => {
    for (const path of [
      '/handbook/sections/HB-1',
      `/handbook/sections/${encodeURIComponent('HB-1.2?x=1')}`,
      `/handbook/sections/${encodeURIComponent('../approvals')}`,
    ]) {
      const res = await get(path, 'emp-003');
      expect(res.status, path).toBe(400);
      expect(ErrorBody.parse(res.body).error.code).toBe('invalid_request');
      expect(res.sinkCount).toBe(0);
      expect(res.itemCount).toBe(0);
    }
    const q = await get('/handbook/sections/HB-1.2?as=emp-001', 'emp-003');
    expect(q.status).toBe(400);
    expect(ErrorBody.parse(q.body).error.code).toBe('invalid_request');
    expect(q.sinkCount).toBe(0);
    expect(q.itemCount).toBe(0);
    const missing = await get('/handbook/sections/HB-9.9', 'emp-003');
    expect(missing.status).toBe(404);
    expect(ErrorBody.parse(missing.body).error.code).toBe('not_found');
    expect(missing.sinkCount).toBe(0);
    expect(missing.itemCount).toBe(0);
  });
});
