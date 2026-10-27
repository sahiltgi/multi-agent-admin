// Acceptance tests for specs/onboarding-api.md: AT-3 (who can read), AT-14 (read half: the name is
// shown only to hr_admin and the checklist manager), AT-15 (GET /onboarding paging, filters and the
// re-check) and AT-16 (blocked progress and task fields). In-memory stores, a fake clock, synthetic
// users and the placeholder name "Test Joiner A".
// ASSUMED contracts (reported to the coordinator):
//   ./routes.ts     createOnboardingRoutes(OnboardingRouteDeps), as in tasks.test.ts
//   ./schemas.ts    ChecklistView (+ newJoiner), ListOnboardingResponse, ChecklistSummary
//   ./in-memory.ts  InMemoryOnboardingStore also has insertProfile / getProfile / removeProfile and
//                   listChecklists(filter: ChecklistListFilter) (no-argument call keeps returning all)
//   ../domain/onboarding.ts  taskStatus(task) -> 'open' | 'blocked' | 'done'
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import { buildTemplateChecklistTasks, taskStatus } from '../domain/onboarding.js';
import type { AuditEvent } from '../domain/schemas.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemoryHolidayReader,
  InMemorySubjectResolver,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createApp } from '../http/app.js';
import { ErrorBody } from '../http/errors.js';
import { fixtures } from '../seeds/fixtures.js';
import { InMemoryOnboardingStore } from './in-memory.js';
import { createOnboardingRoutes, type OnboardingRouteDeps } from './routes.js';
import { ChecklistView } from './schemas.js';

type Rec = Record<string, unknown>;

const NOW = '2026-10-21T09:00:00Z';
const HASH = 'a'.repeat(64);

const T_ENGINEER = {
  tasks: [
    { id: 'laptop', title: 'Prepare laptop', owner: 'it', dueOffsetDays: -3, dependsOn: [] },
    {
      id: 'accounts',
      title: 'Create accounts',
      owner: 'it',
      dueOffsetDays: -1,
      dependsOn: ['laptop'],
    },
    { id: 'desk', title: 'Assign desk', owner: 'admin', dueOffsetDays: -1, dependsOn: [] },
    { id: 'welcome', title: 'Welcome meeting', owner: 'manager', dueOffsetDays: 0, dependsOn: [] },
    {
      id: 'buddy-intro',
      title: 'Buddy introduction',
      owner: 'buddy',
      dueOffsetDays: 1,
      dependsOn: ['welcome'],
    },
    {
      id: 'first-review',
      title: 'First-week check-in',
      owner: 'manager',
      dueOffsetDays: 7,
      dependsOn: ['accounts', 'welcome'],
    },
  ],
} as const;
const T_SALES = {
  tasks: [{ id: 'intro', title: 'Intro call', owner: 'manager', dueOffsetDays: 0, dependsOn: [] }],
} as const;

const rule = (ruleId: string, passed: boolean): Rec => ({
  ruleId,
  passed,
  expected: 'synthetic expected',
  actual: 'synthetic actual',
  message: 'Synthetic message.',
});
const GATE: Rec = {
  verdict: 'AUTO',
  ruleResults: [
    rule('checklist_matches_template', true),
    rule('no_tasks_added', true),
    rule('no_tasks_removed', true),
  ],
  reason: 'Checklist matches the template.',
  policyVersion: 'v1',
  policyHash: HASH,
};

interface Opts {
  templateId?: 'engineer' | 'sales';
  startDate?: string;
  team?: string;
  manager?: string;
  buddy?: string | null;
  patchTasks?: (tasks: Rec[]) => Rec[];
}
function checklist(id: string, o: Opts = {}): Rec {
  const templateId = o.templateId ?? 'engineer';
  const startDate = o.startDate ?? '2026-12-01';
  const manager = o.manager ?? 'emp-002';
  const buddy = o.buddy === undefined ? null : o.buddy;
  const built: Rec[] = buildTemplateChecklistTasks(
    templateId === 'engineer' ? T_ENGINEER : T_SALES,
    startDate,
    { managerEmployeeId: manager, buddyEmployeeId: buddy },
  ).map((t) => ({ ...t }));
  return {
    id,
    requestId: `req-${id}`,
    newJoinerId: `nj-${id}`,
    templateId,
    templateVersion: 'v1',
    policyHash: HASH,
    startDate,
    newHireTeam: o.team ?? 'team-a',
    managerEmployeeId: manager,
    buddyEmployeeId: buddy,
    createdBy: 'emp-001',
    tasks: o.patchTasks === undefined ? built : o.patchTasks(built),
    removedTemplateTaskIds: [],
    gateResult: GATE,
    version: 0,
    createdAt: NOW,
  };
}
// The three list-test checklists of the spec.
const CHK_A = (): Rec => checklist('chk-a', { buddy: 'emp-005' });
const CHK_B = (): Rec => checklist('chk-b', { startDate: '2026-12-08' });
const CHK_C = (): Rec =>
  checklist('chk-c', {
    templateId: 'sales',
    startDate: '2026-12-07',
    team: 'team-b',
    manager: 'emp-009',
  });

const EMP_021 = {
  id: 'emp-021',
  displayName: 'Demo HR Admin 021',
  email: 'emp-021@example-widgets.example',
  role: 'hr_admin' as const,
  teamId: null,
  managerId: null,
};

function makeWorld(checklists: Rec[], deviations: Rec[] = []) {
  const sink = new InMemoryAuditSink();
  const onboarding = new InMemoryOnboardingStore(checklists, deviations);
  const directory = new InMemoryEmployeeDirectory([...fixtures.employees, EMP_021], fixtures.teams);
  let n = 0;
  const audit = { write: (e: AuditEvent): Promise<void> => sink.write(e) };
  const clock = { nowIso: () => NOW };
  const idGen = () => `ae-${String(++n).padStart(3, '0')}`;
  const notesAgent = vi.fn(() =>
    Promise.reject(new Error('the notes agent must not run on a read')),
  );
  const gate = vi.fn(() => {
    throw new Error('the gate must not run on a read');
  });
  const unused = (name: string) => () => Promise.reject(new Error(`${name} must not be used`));
  const routes = createOnboardingRoutes({
    directory,
    onboarding,
    approvals: { insert: unused('approvals.insert'), remove: unused('approvals.remove') },
    messages: { recordMessage: unused('messages.recordMessage') },
    audit,
    clock,
    idGen,
    idempotency: {
      begin: unused('begin'),
      complete: unused('complete'),
      release: unused('release'),
    },
    policy: undefined,
    evaluateOnboarding: gate,
    toIsoDate: (iso: string) => iso.slice(0, 10),
    runOnboardingNotes: notesAgent,
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
      onboarding,
    ),
    audit,
    auditReader: new InMemoryAuditReader(sink),
    clock,
    idGen,
    onboarding,
    holidays: new InMemoryHolidayReader([]), // approval-queue-ui Q-1
  } as unknown as ApprovalApiDeps;
  return { deps, routes, sink, onboarding };
}
type World = ReturnType<typeof makeWorld>;

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
  body: Rec;
}
async function boot(w: World) {
  const server = createApp(w.deps, w.routes).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.once('listening', () => {
      resolve();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${String(addr.port)}`;
  const get = async (user: string, path: string): Promise<Res> => {
    const r = await fetch(base + path, { headers: { 'x-demo-user': user } });
    const text = await r.text();
    let body: Rec;
    try {
      body = JSON.parse(text) as Rec;
    } catch {
      body = {};
    }
    return { status: r.status, text, body };
  };
  return {
    get,
    read: (user: string, id: string) => get(user, `/onboarding/${id}`),
    list: (user: string, query = '') => get(user, `/onboarding${query === '' ? '' : `?${query}`}`),
  };
}

function expectError(res: Res, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(res.body).error.code).toBe(code);
}
const idsOf = (res: Res): string[] =>
  (res.body.checklists as Rec[]).map((c) => String(c.checklistId));
const walkKeys = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) for (const v of value) walkKeys(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      walkKeys(v, out);
    }
  }
  return out;
};

// ================= AT-3 =================

describe('onboarding-api AT-3: an employee cannot read someone else checklist', () => {
  it('AT-3: emp-004 gets 404 on A, B and C, byte-identical to an unknown id, and an empty list', async () => {
    const w = makeWorld([CHK_A(), CHK_B(), CHK_C()]);
    const { read, list } = await boot(w);
    const unknown = await read('emp-004', 'unknown-id');
    expectError(unknown, 404, 'not_found');
    for (const id of ['chk-a', 'chk-b', 'chk-c']) {
      const res = await read('emp-004', id);
      expect(res.status, id).toBe(404);
      expect(res.text, id).toBe(unknown.text);
    }
    const mine = await list('emp-004');
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ checklists: [], nextCursor: null });
  });

  it('AT-3: emp-009 sees only C, emp-005 only A', async () => {
    const w = makeWorld([CHK_A(), CHK_B(), CHK_C()]);
    const { read, list } = await boot(w);
    expect((await read('emp-009', 'chk-a')).status).toBe(404);
    expect((await read('emp-009', 'chk-b')).status).toBe(404);
    expect(idsOf(await list('emp-009'))).toEqual(['chk-c']);
    expect((await read('emp-005', 'chk-a')).status).toBe(200);
    expect((await read('emp-005', 'chk-b')).status).toBe(404);
    expect((await read('emp-005', 'chk-c')).status).toBe(404);
    expect(idsOf(await list('emp-005'))).toEqual(['chk-a']);
  });

  it('AT-3: for every actor the list equals exactly what the single read allows', async () => {
    const all = ['chk-a', 'chk-b', 'chk-c'];
    const w = makeWorld([CHK_A(), CHK_B(), CHK_C()]);
    const { read, list } = await boot(w);
    for (const actor of ['emp-001', 'emp-002', 'emp-004', 'emp-005', 'emp-009']) {
      const listed = idsOf(await list(actor));
      for (const id of all) {
        const res = await read(actor, id);
        expect(res.status, `${actor} ${id}`).toBe(listed.includes(id) ? 200 : 404);
      }
    }
    expect(idsOf(await list('emp-001'))).toEqual(['chk-a', 'chk-c', 'chk-b']); // startDate asc
    expect(idsOf(await list('emp-002'))).toEqual(['chk-a', 'chk-b']);
  });
});

// ================= AT-14 (read half) =================

describe('onboarding-api AT-14: the joiner name is shown only to hr_admin and the checklist manager', () => {
  const profile = {
    newJoinerId: 'nj-chk-a',
    checklistId: 'chk-a',
    displayName: 'Test Joiner A',
    createdAt: NOW,
  };

  it('AT-14: newJoiner.displayName for emp-001 and emp-002, null for emp-005 and an unreadable user', async () => {
    const w = makeWorld([CHK_A(), CHK_B()]);
    expect(await w.onboarding.insertProfile(profile)).toBe(true);
    const { read } = await boot(w);
    for (const user of ['emp-001', 'emp-002', 'emp-021']) {
      const res = await read(user, 'chk-a');
      expect(res.status, user).toBe(200);
      expect(ChecklistView.parse(res.body).newJoiner, user).toEqual({
        displayName: 'Test Joiner A',
      });
    }
    const buddy = await read('emp-005', 'chk-a');
    expect(buddy.status).toBe(200);
    expect(ChecklistView.parse(buddy.body).newJoiner).toBeNull();
    expect(buddy.text).not.toContain('Test Joiner A');
    // A checklist with no stored profile reads as null, never as an error.
    expect(ChecklistView.parse((await read('emp-001', 'chk-b')).body).newJoiner).toBeNull();
  });

  it('AT-14: no list body, error body or audit event holds the name, and displayName appears only as newJoiner.displayName', async () => {
    const w = makeWorld([CHK_A(), CHK_B()]);
    await w.onboarding.insertProfile(profile);
    const { read, list } = await boot(w);
    const bodies = [
      await list('emp-001'),
      await list('emp-002'),
      await list('emp-005'),
      await read('emp-004', 'chk-a'),
      await read('emp-001', 'unknown-id'),
      await list('emp-001', 'limit=1'),
    ];
    for (const b of bodies) expect(b.text).not.toContain('Test Joiner A');
    const view = await read('emp-001', 'chk-a');
    const keys = walkKeys(view.body);
    expect(keys.filter((k) => k === 'displayName')).toHaveLength(1);
    expect((view.body.newJoiner as Rec).displayName).toBe('Test Joiner A');
    expect(keys).not.toContain('email');
    expect(JSON.stringify(w.sink.events)).not.toContain('Test Joiner A');
  });
});

// ================= AT-15 =================

describe('onboarding-api AT-15: GET /onboarding paging, filters and the re-check', () => {
  // Five checklists visible to emp-001; two share the start date 2026-12-01 (ids x1 and x2).
  const five = (): Rec[] => [
    checklist('x2', { startDate: '2026-12-01' }),
    checklist('x1', { startDate: '2026-12-01' }),
    checklist('y', { startDate: '2026-12-03' }),
    checklist('z', { startDate: '2026-12-07', templateId: 'sales' }),
    checklist('w', { startDate: '2026-12-08' }),
  ];

  it('AT-15: limit=2 pages as [x1, x2], [y, z], [w], and nextCursor is null on the last page', async () => {
    const { list } = await boot(makeWorld(five()));
    const p1 = await list('emp-001', 'limit=2');
    expect(p1.status).toBe(200);
    expect(idsOf(p1)).toEqual(['x1', 'x2']);
    expect(typeof p1.body.nextCursor).toBe('string');
    const p2 = await list('emp-001', `limit=2&cursor=${String(p1.body.nextCursor)}`);
    expect(idsOf(p2)).toEqual(['y', 'z']);
    const p3 = await list('emp-001', `limit=2&cursor=${String(p2.body.nextCursor)}`);
    expect(idsOf(p3)).toEqual(['w']);
    expect(p3.body.nextCursor).toBeNull();
  });

  it('AT-15: a summary carries ids and counts only', async () => {
    const dev = {
      id: 'dev-001',
      checklistId: 'chk-a',
      requestId: 'req-chk-a',
      change: { kind: 'remove', templateTaskId: 'desk' },
      rationale: 'Requested in notes',
      status: 'pending',
      gateResult: { ...GATE, verdict: 'MANAGER' },
      proposedBy: 'emp-001',
      createdAt: NOW,
    };
    const { list } = await boot(makeWorld([CHK_A()], [dev]));
    const res = await list('emp-001');
    expect(res.status).toBe(200);
    expect(res.body.checklists).toEqual([
      {
        checklistId: 'chk-a',
        templateId: 'engineer',
        startDate: '2026-12-01',
        newHireTeam: 'team-a',
        managerEmployeeId: 'emp-002',
        buddyEmployeeId: 'emp-005',
        progress: [
          { owner: 'it', total: 2, done: 0, blocked: 0 },
          { owner: 'admin', total: 1, done: 0, blocked: 0 },
          { owner: 'manager', total: 2, done: 0, blocked: 0 },
          { owner: 'buddy', total: 1, done: 0, blocked: 0 },
        ],
        pendingDeviations: 1,
        createdAt: NOW,
      },
    ]);
    expect(Object.keys(res.body).sort()).toEqual(['checklists', 'nextCursor']);
  });

  it('AT-15: templateId=sales returns only sales checklists', async () => {
    const { list } = await boot(makeWorld(five()));
    expect(idsOf(await list('emp-001', 'templateId=sales'))).toEqual(['z']);
  });

  it('AT-15: startDateFrom and startDateTo are inclusive', async () => {
    const { list } = await boot(makeWorld(five()));
    expect(idsOf(await list('emp-001', 'startDateFrom=2026-12-03&startDateTo=2026-12-07'))).toEqual(
      ['y', 'z'],
    );
    expect(idsOf(await list('emp-001', 'startDateFrom=2026-12-03&startDateTo=2026-12-03'))).toEqual(
      ['y'],
    );
  });

  it.each(['limit=1', 'limit=50'])('AT-15: %s is accepted', async (q) => {
    const { list } = await boot(makeWorld(five()));
    expect((await list('emp-001', q)).status).toBe(200);
  });

  it.each([
    'limit=0',
    'limit=51',
    'limit=abc',
    'limit=2.5',
    'startDateFrom=2026-12-08&startDateTo=2026-12-01',
    'cursor=!!',
    'role=hr_admin',
    'templateId=sales&templateId=engineer',
  ])('AT-15: query %s is 400 invalid_request', async (q) => {
    const { list } = await boot(makeWorld(five()));
    expectError(await list('emp-001', q), 400, 'invalid_request');
  });

  it('AT-15: a cursor from emp-001 used by emp-004 gives an empty list (visibility is re-applied)', async () => {
    const { list } = await boot(makeWorld(five()));
    const p1 = await list('emp-001', 'limit=2');
    const cursor = String(p1.body.nextCursor);
    const stolen = await list('emp-004', `cursor=${cursor}`);
    expect(stolen.status).toBe(200);
    expect(stolen.body).toEqual({ checklists: [], nextCursor: null });
  });

  it('AT-15: a store that returns a checklist the actor cannot read gives 500 and does not show its id', async () => {
    const w = makeWorld([checklist('chk-leak-001')]);
    const { list } = await boot(w);
    const leaked = await w.onboarding.getChecklist('chk-leak-001');
    w.onboarding.listChecklists = () => Promise.resolve(leaked === null ? [] : [leaked]);
    const res = await list('emp-004');
    expectError(res, 500, 'internal_error');
    expect(res.text).not.toContain('chk-leak-001');
  });
});

// ================= AT-16 =================

describe('onboarding-api AT-16: blocked progress and task fields in the view', () => {
  const blocked = { reason: 'Waiting on vendor', blockedBy: 'emp-001', blockedAt: NOW };
  const seeded = (): Rec =>
    checklist('chk-a', {
      buddy: 'emp-005',
      patchTasks: (tasks) =>
        tasks.map((t) =>
          t.id === 'welcome'
            ? { ...t, done: true, completedBy: 'emp-002', completedAt: NOW }
            : t.id === 'laptop'
              ? { ...t, blocked }
              : t,
        ),
    });

  it('AT-16: progress counts blocked per owner in the fixed order', async () => {
    const { read } = await boot(makeWorld([seeded()]));
    const res = await read('emp-002', 'chk-a');
    expect(res.status).toBe(200);
    expect(ChecklistView.parse(res.body).progress).toEqual([
      { owner: 'it', total: 2, done: 0, blocked: 1 },
      { owner: 'admin', total: 1, done: 0, blocked: 0 },
      { owner: 'manager', total: 2, done: 1, blocked: 0 },
      { owner: 'buddy', total: 1, done: 0, blocked: 0 },
    ]);
  });

  it('AT-16: each task shows owner and dueDate from the template, laptop.blocked.reason is stored text, and taskStatus is derived', async () => {
    const { read } = await boot(makeWorld([seeded()]));
    const res = await read('emp-002', 'chk-a');
    const tasks = ChecklistView.parse(res.body).checklist.tasks;
    const by = (id: string) => {
      const t = tasks.find((x) => x.id === id);
      if (t === undefined) throw new Error(`no task ${id}`);
      return t;
    };
    expect(tasks.map((t) => [t.id, t.owner, t.dueDate])).toEqual([
      ['laptop', 'it', '2026-11-28'],
      ['accounts', 'it', '2026-11-30'],
      ['desk', 'admin', '2026-11-30'],
      ['welcome', 'manager', '2026-12-01'],
      ['buddy-intro', 'buddy', '2026-12-02'],
      ['first-review', 'manager', '2026-12-08'],
    ]);
    expect(by('laptop').blocked?.reason).toBe('Waiting on vendor');
    expect(taskStatus(by('welcome'))).toBe('done');
    expect(taskStatus(by('laptop'))).toBe('blocked');
    for (const id of ['accounts', 'desk', 'buddy-intro', 'first-review']) {
      expect(taskStatus(by(id)), id).toBe('open');
    }
    // The status is derived, never a stored or returned field.
    expect(walkKeys(res.body)).not.toContain('status');
  });
});
