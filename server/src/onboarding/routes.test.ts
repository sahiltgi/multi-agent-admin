// Acceptance tests for specs/onboarding.md: AT-29 to AT-33 (approve or reject a deviation,
// task completion, and the read route). Records are seeded straight into the in-memory stores, so
// these tests do not depend on dispatch. The dispatch half of AT-2 lives in intake/onboarding.test.ts.
// ASSUMED contracts (reported to the coordinator):
//   ./in-memory.ts  InMemoryOnboardingStore(checklists?, deviations?) with the OnboardingStore methods
//   ./routes.ts     createOnboardingRoutes({ directory, onboarding, audit, clock, idGen })
//   ./schemas.ts    ChecklistView
//   http/approvals  ApprovalApiDeps gains `onboarding`; InMemorySubjectResolver takes the store as a
//                   third constructor argument; ActionBody.seen.verdict accepts 'MANAGER' and 'AUTO'
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import type { ApprovalItem, AuditEvent } from '../domain/schemas.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
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
const START = '2026-12-01';

const T_TASKS = [
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
];
const DUE: Record<string, string> = {
  laptop: '2026-11-28',
  accounts: '2026-11-30',
  desk: '2026-11-30',
  welcome: '2026-12-01',
  'buddy-intro': '2026-12-02',
  'first-review': '2026-12-08',
};
const templateTasks = (): Rec[] =>
  T_TASKS.map((t) => ({
    id: t.id,
    title: t.title,
    owner: t.owner,
    ...(t.owner === 'manager' ? { ownerEmployeeId: 'emp-002' } : {}),
    ...(t.owner === 'buddy' ? { ownerEmployeeId: 'emp-005' } : {}),
    source: 'template',
    dueOffsetDays: t.dueOffsetDays,
    dueDate: DUE[t.id],
    dependsOn: t.dependsOn,
    done: false,
  }));

const rule = (ruleId: string, passed: boolean): Rec => ({
  ruleId,
  passed,
  expected: 'synthetic expected',
  actual: 'synthetic actual',
  message: 'Synthetic message.',
});
const GATE: Rec = {
  verdict: 'MANAGER',
  ruleResults: [
    rule('checklist_matches_template', true),
    rule('no_tasks_added', false),
    rule('no_tasks_removed', true),
  ],
  reason: 'Deviations need manager approval.',
  policyVersion: 'v1',
  policyHash: HASH,
};

const checklist = (over: Rec = {}): Rec => ({
  id: 'chk-001',
  requestId: 'req-001',
  newJoinerId: 'nj-001',
  templateId: 'engineer',
  templateVersion: 'v1',
  policyHash: HASH,
  startDate: START,
  newHireTeam: 'team-a',
  managerEmployeeId: 'emp-002',
  buddyEmployeeId: 'emp-005',
  createdBy: 'emp-001',
  tasks: templateTasks(),
  removedTemplateTaskIds: [],
  gateResult: { ...GATE, verdict: 'AUTO' },
  version: 0,
  createdAt: NOW,
  ...over,
});

const ADD = {
  kind: 'add',
  title: 'Order second monitor',
  owner: 'it',
  dueOffsetDays: -2,
  dependsOn: ['laptop'],
};
const deviation = (id: string, change: Rec, over: Rec = {}): Rec => ({
  id,
  checklistId: 'chk-001',
  requestId: 'req-001',
  change,
  rationale: 'Requested by hr_admin',
  status: 'pending',
  gateResult: GATE,
  proposedBy: 'emp-001',
  createdAt: NOW,
  ...over,
});
const item = (id: string, subjectId: string): ApprovalItem => ({
  id,
  kind: 'onboarding_deviation',
  subjectId,
  assigneeRole: 'manager',
  assigneeId: 'emp-002',
  flagged: false,
  status: 'open',
  createdAt: NOW,
});

const EMP_021 = {
  id: 'emp-021',
  displayName: 'Demo HR Admin 021',
  email: 'emp-021@example-widgets.example',
  role: 'hr_admin' as const,
  teamId: null,
  managerId: null,
};

interface WorldOpts {
  checklists?: Rec[];
  deviations?: Rec[];
  items?: ApprovalItem[];
}
function makeWorld(o: WorldOpts = {}) {
  const sink = new InMemoryAuditSink();
  const state = { failWrites: false, counter: 0 };
  const onboarding = new InMemoryOnboardingStore(
    o.checklists ?? [checklist()],
    o.deviations ?? [deviation('dev-001', ADD)],
  );
  const approvals = new InMemoryApprovalStore(o.items ?? [item('ai-001', 'dev-001')]);
  // onboarding-api: the routes now also resolve teams (POST /onboarding), so the directory has them.
  const directory = new InMemoryEmployeeDirectory([...fixtures.employees, EMP_021], fixtures.teams);
  const audit = {
    write: (e: AuditEvent): Promise<void> =>
      state.failWrites ? Promise.reject(new Error('sink-down')) : sink.write(e),
  };
  const clock = { nowIso: () => NOW };
  const idGen = () => `ae-${String(++state.counter).padStart(3, '0')}`;
  const deps = {
    directory,
    approvals,
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
  } as unknown as ApprovalApiDeps;
  // onboarding-api (rule 19): one deps shape for all four routes. The read and PATCH tests below
  // never reach the create-only dependencies, so those are stubs that fail loudly if they are used.
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
    evaluateOnboarding: () => {
      throw new Error('evaluateOnboarding must not be used');
    },
    toIsoDate: (iso: string) => iso.slice(0, 10),
    runOnboardingNotes: unused('runOnboardingNotes'),
    onboardingTexts: { load: () => Promise.resolve(null) },
    intakeTexts: { load: () => Promise.resolve(null) },
  } as unknown as OnboardingRouteDeps);
  return { deps, routes, sink, state, onboarding, approvals };
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
  body: unknown;
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
  const call = async (
    user: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<Res> => {
    const headers: Record<string, string> = { 'x-demo-user': user };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, {
      method,
      headers,
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
  const act = (
    user: string,
    itemId: string,
    action: 'approve' | 'reject' | 'comment',
    verdict = 'MANAGER',
  ) =>
    call(user, 'POST', `/approvals/${itemId}/actions`, {
      action,
      seen: { verdict, policyHash: HASH },
    });
  // onboarding-api OQ-1: POST .../complete with {} became PATCH /onboarding/:id/tasks/:taskId with
  // { status: 'done' }; GET /onboarding/checklists/:id became GET /onboarding/:id.
  const complete = (
    user: string,
    taskId: string,
    body: unknown = { status: 'done' },
    checklistId = 'chk-001',
  ) => call(user, 'PATCH', `/onboarding/${checklistId}/tasks/${taskId}`, body);
  const read = (user: string, checklistId = 'chk-001') =>
    call(user, 'GET', `/onboarding/${checklistId}`);
  return { call, act, complete, read };
}

function expectError(res: Res, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(res.body).error.code).toBe(code);
}
const humanEvents = (w: World, kind?: string) =>
  w.sink.events.filter(
    (e) =>
      e.eventType === 'human_action' && (kind === undefined || (e.payload as Rec).kind === kind),
  );
const taskOf = (c: Rec | null, id: string): Rec | undefined => {
  if (c === null) throw new Error('expected a checklist');
  return (c.tasks as Rec[]).find((t) => t.id === id);
};
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

// ================= AT-29 =================

describe('onboarding AT-29: a deviation lands only through the manager approve', () => {
  it('AT-29: approving an add appends added-1, bumps the version and closes the deviation and the item', async () => {
    const w = makeWorld();
    const { act } = await boot(w);
    const res = await act('emp-002', 'ai-001', 'approve');
    expect(res.status).toBe(200);
    const stored = await w.onboarding.getChecklist('chk-001');
    const added = taskOf(stored, 'added-1');
    expect(added).toMatchObject({
      id: 'added-1',
      title: 'Order second monitor',
      owner: 'it',
      source: 'added',
      dueOffsetDays: -2,
      dueDate: '2026-11-29',
      dependsOn: ['laptop'],
      done: false,
    });
    expect((stored as unknown as Rec).version).toBe(1);
    expect((await w.onboarding.getDeviation('dev-001'))?.status).toBe('applied');
    expect((await w.approvals.get('ai-001'))?.status).toBe('approved');
    expect(humanEvents(w)).toHaveLength(1);
    expectError(await act('emp-002', 'ai-001', 'approve'), 409, 'already_decided');
  });

  it('AT-29: approving a remove deletes buddy-intro and records the removed id', async () => {
    const w = makeWorld({
      deviations: [deviation('dev-001', { kind: 'remove', templateTaskId: 'buddy-intro' })],
    });
    const { act } = await boot(w);
    expect((await act('emp-002', 'ai-001', 'approve')).status).toBe(200);
    const stored = await w.onboarding.getChecklist('chk-001');
    expect(taskOf(stored as never, 'buddy-intro')).toBeUndefined();
    expect((stored as unknown as Rec).removedTemplateTaskIds).toEqual(['buddy-intro']);
  });

  it('AT-29: a rejection leaves the checklist equal to its prior value', async () => {
    const w = makeWorld();
    const before = await w.onboarding.getChecklist('chk-001');
    const { act } = await boot(w);
    expect((await act('emp-002', 'ai-001', 'reject')).status).toBe(200);
    expect(await w.onboarding.getChecklist('chk-001')).toEqual(before);
    expect((await w.onboarding.getDeviation('dev-001'))?.status).toBe('rejected');
    expect((await w.approvals.get('ai-001'))?.status).toBe('rejected');
  });
});

describe('onboarding rule 23: what the manager sees and where the decision is traced', () => {
  it('rule 23: the item view shows the proposed change and rationale, and the decision joins the request trace', async () => {
    const w = makeWorld();
    const { call, act } = await boot(w);
    const view = await call('emp-002', 'GET', '/approvals/ai-001');
    expect(view.status).toBe(200);
    expect((view.body as Rec).deviation).toEqual({
      deviationId: 'dev-001',
      checklistId: 'chk-001',
      change: ADD,
      rationale: 'Requested by hr_admin',
      status: 'pending',
      proposedBy: 'emp-001',
    });
    expect((await act('emp-002', 'ai-001', 'approve')).status).toBe(200);
    const [event] = humanEvents(w);
    expect(event?.traceId).toBe('req-001');
  });
});

describe('onboarding rule 23: failures while applying a deviation change nothing', () => {
  it('rule 23: a failed audit write restores the item, the deviation and the checklist content, then 500', async () => {
    const w = makeWorld();
    const { act } = await boot(w);
    const checklistBefore = await w.onboarding.getChecklist('chk-001');
    const deviationBefore = await w.onboarding.getDeviation('dev-001');
    const itemBefore = await w.approvals.get('ai-001');
    w.state.failWrites = true;
    expectError(await act('emp-002', 'ai-001', 'approve'), 500, 'internal_error');
    const after = await w.onboarding.getChecklist('chk-001');
    // Same content; the version moves on so no reader sees one version twice.
    expect({ ...after, version: 0 }).toEqual(checklistBefore);
    expect(taskOf(after, 'added-1')).toBeUndefined();
    expect(await w.onboarding.getDeviation('dev-001')).toEqual(deviationBefore);
    expect(await w.approvals.get('ai-001')).toEqual(itemBefore);
    // The item can still be decided once the sink is back.
    w.state.failWrites = false;
    expect((await act('emp-002', 'ai-001', 'approve')).status).toBe(200);
    expect(taskOf(await w.onboarding.getChecklist('chk-001'), 'added-1')).toBeDefined();
  });

  it('rule 23: a checklist saved by someone else first is 409 and leaves the item open', async () => {
    const w = makeWorld();
    const { act } = await boot(w);
    const deviationBefore = await w.onboarding.getDeviation('dev-001');
    const itemBefore = await w.approvals.get('ai-001');
    w.onboarding.saveChecklistIfVersion = () => Promise.resolve(false); // lost the version race
    expectError(await act('emp-002', 'ai-001', 'approve'), 409, 'action_not_allowed');
    expect(await w.onboarding.getDeviation('dev-001')).toEqual(deviationBefore);
    expect(await w.approvals.get('ai-001')).toEqual(itemBefore);
    expect(humanEvents(w)).toHaveLength(0);
  });

  it('rule 24: a completion that loses the version race is 409 and writes no event', async () => {
    const w = makeWorld({ deviations: [], items: [] });
    const { complete } = await boot(w);
    w.onboarding.saveChecklistIfVersion = () => Promise.resolve(false);
    expectError(await complete('emp-002', 'welcome'), 409, 'action_not_allowed');
    expect(humanEvents(w)).toHaveLength(0);
  });
});

// ================= AT-30 =================

describe('onboarding AT-30: who cannot approve, and conflicts', () => {
  it('AT-30: other actors are refused with nothing changed, and then only emp-002 can approve', async () => {
    const w = makeWorld();
    const { act } = await boot(w);
    const checklistBefore = await w.onboarding.getChecklist('chk-001');
    const deviationBefore = await w.onboarding.getDeviation('dev-001');
    const itemBefore = await w.approvals.get('ai-001');
    const unchanged = async (): Promise<void> => {
      expect(await w.onboarding.getChecklist('chk-001')).toEqual(checklistBefore);
      expect(await w.onboarding.getDeviation('dev-001')).toEqual(deviationBefore);
      expect(await w.approvals.get('ai-001')).toEqual(itemBefore);
      expect(humanEvents(w)).toHaveLength(0);
    };
    expectError(await act('emp-004', 'ai-001', 'approve'), 404, 'not_found');
    expectError(await act('emp-009', 'ai-001', 'approve'), 404, 'not_found');
    expectError(await act('emp-021', 'ai-001', 'approve'), 404, 'not_found');
    expectError(await act('emp-001', 'ai-001', 'approve'), 403, 'self_action_forbidden');
    expectError(await act('emp-002', 'ai-001', 'approve', 'AUTO'), 409, 'gate_result_changed');
    await unchanged();
    // Control: the item is real, and only the assigned manager's approve adds the task.
    expect((await act('emp-002', 'ai-001', 'approve')).status).toBe(200);
    expect(taskOf((await w.onboarding.getChecklist('chk-001')) as never, 'added-1')).toBeDefined();
  });

  it('AT-30: an approve that would orphan an applied addition gives 409 and changes nothing', async () => {
    const tasks = templateTasks();
    tasks.push({
      id: 'added-1',
      title: 'Order second monitor',
      owner: 'it',
      source: 'added',
      dueOffsetDays: -2,
      dueDate: '2026-11-29',
      dependsOn: ['desk'],
      done: false,
    });
    const w = makeWorld({
      checklists: [checklist({ tasks, version: 1 })],
      deviations: [deviation('dev-002', { kind: 'remove', templateTaskId: 'desk' })],
      items: [item('ai-002', 'dev-002')],
    });
    const { act } = await boot(w);
    const checklistBefore = await w.onboarding.getChecklist('chk-001');
    const deviationBefore = await w.onboarding.getDeviation('dev-002');
    const itemBefore = await w.approvals.get('ai-002');
    const res = await act('emp-002', 'ai-002', 'approve');
    expect(res.status).toBe(409);
    expect(await w.onboarding.getChecklist('chk-001')).toEqual(checklistBefore);
    expect(await w.onboarding.getDeviation('dev-002')).toEqual(deviationBefore);
    expect(await w.approvals.get('ai-002')).toEqual(itemBefore);
    expect(humanEvents(w)).toHaveLength(0);
  });
});

// ================= AT-31, AT-32 =================

describe('onboarding AT-31: task completion', () => {
  const noDeviation = { deviations: [], items: [] };

  it('AT-31: the checklist manager completes welcome, and the buddy completes buddy-intro after it', async () => {
    const w = makeWorld(noDeviation);
    const { complete } = await boot(w);
    expect((await complete('emp-002', 'welcome')).status).toBe(200);
    const welcome = taskOf(await w.onboarding.getChecklist('chk-001'), 'welcome');
    expect(welcome).toMatchObject({ done: true, completedBy: 'emp-002', completedAt: NOW });
    // onboarding-api OQ-9: onboarding_task_completed became onboarding_task_status_changed, with
    // from / to / onBehalfOf / reason.
    const events = humanEvents(w, 'onboarding_task_status_changed');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      kind: 'onboarding_task_status_changed',
      checklistId: 'chk-001',
      taskId: 'welcome',
      owner: 'manager',
      from: 'open',
      to: 'done',
      actorRole: 'manager',
      onBehalfOf: null,
      reason: null,
    });
    expect(humanEvents(w, 'onboarding_task_completed')).toHaveLength(0);
    expect((await complete('emp-005', 'buddy-intro')).status).toBe(200);
  });

  it('AT-31: a buddy cannot complete an it task (403), an unrelated employee gets 404', async () => {
    const w = makeWorld(noDeviation);
    const { complete, read } = await boot(w);
    expect((await read('emp-001')).status).toBe(200); // control: the route exists
    expectError(await complete('emp-005', 'laptop'), 403, 'forbidden');
    expectError(await complete('emp-004', 'laptop'), 404, 'not_found');
    expect(taskOf((await w.onboarding.getChecklist('chk-001')) as never, 'laptop')?.done).toBe(
      false,
    );
  });

  // NEW (onboarding-api OQ-2, not a migration): hr_admin no longer completes manager tasks or a
  // named buddy's tasks; it still completes it and admin tasks, on behalf of the owner.
  it('AT-31: hr_admin gets 403 on a manager task and on a named buddy task, and nothing changes', async () => {
    const w = makeWorld(noDeviation);
    const { complete } = await boot(w);
    const before = await w.onboarding.getChecklist('chk-001');
    expectError(await complete('emp-001', 'welcome'), 403, 'forbidden');
    expectError(await complete('emp-001', 'buddy-intro'), 403, 'forbidden');
    expect(await w.onboarding.getChecklist('chk-001')).toEqual(before);
    expect(humanEvents(w)).toHaveLength(0);
  });

  it('AT-31: hr_admin completes an it task on behalf of it, recorded in the event', async () => {
    const w = makeWorld(noDeviation);
    const { complete } = await boot(w);
    expect((await complete('emp-001', 'laptop')).status).toBe(200);
    expect(taskOf(await w.onboarding.getChecklist('chk-001'), 'laptop')).toMatchObject({
      done: true,
      completedBy: 'emp-001',
    });
    expect(humanEvents(w, 'onboarding_task_status_changed')[0]?.payload).toMatchObject({
      owner: 'it',
      actorRole: 'hr_admin',
      onBehalfOf: 'it',
    });
  });

  it('AT-31: a task with an undone dependency is 409 dependencies_incomplete', async () => {
    const w = makeWorld(noDeviation);
    const { complete } = await boot(w);
    expectError(await complete('emp-001', 'accounts'), 409, 'dependencies_incomplete');
    expect(taskOf((await w.onboarding.getChecklist('chk-001')) as never, 'accounts')?.done).toBe(
      false,
    );
  });

  it('AT-31: completing a done task again is 409 already_done', async () => {
    const w = makeWorld(noDeviation);
    const { complete } = await boot(w);
    expect((await complete('emp-002', 'welcome')).status).toBe(200);
    expectError(await complete('emp-002', 'welcome'), 409, 'already_done');
  });

  it('AT-31: a sink that rejects the event leaves the task undone and gives 500', async () => {
    const w = makeWorld(noDeviation);
    const { complete } = await boot(w);
    w.state.failWrites = true;
    expectError(await complete('emp-002', 'welcome'), 500, 'internal_error');
    const stored = await w.onboarding.getChecklist('chk-001');
    expect(taskOf(stored as never, 'welcome')?.done).toBe(false);
    expect(taskOf(stored as never, 'welcome')).not.toHaveProperty('completedBy');
  });
});

// onboarding-api OQ-1/OQ-3: the body is now the strict TaskStatusBody. The three original bodies
// stay (they are 400 for a missing status as well); the same keys beside a valid status are added so
// the strictness itself is still what is tested.
describe('onboarding AT-32: the status body accepts no caller-supplied completion fields', () => {
  it.each([
    { completedBy: 'emp-001' },
    { done: true },
    { completedAt: '2020-01-01T00:00:00Z' },
    { status: 'done', completedBy: 'emp-001' },
    { status: 'done', done: true },
    { status: 'done', completedAt: '2020-01-01T00:00:00Z' },
  ])('AT-32: body %j is 400 invalid_request and nothing changes', async (body) => {
    const w = makeWorld({ deviations: [], items: [] });
    const before = await w.onboarding.getChecklist('chk-001');
    const { complete } = await boot(w);
    expectError(await complete('emp-002', 'welcome', body), 400, 'invalid_request');
    expect(await w.onboarding.getChecklist('chk-001')).toEqual(before);
    expect(humanEvents(w)).toHaveLength(0);
  });
});

// ================= AT-33 =================

describe('onboarding AT-33: the read route', () => {
  it('AT-33: per-owner progress in fixed order, readers by role, ids only', async () => {
    const tasks = templateTasks().map((t) =>
      t.id === 'welcome' ? { ...t, done: true, completedBy: 'emp-002', completedAt: NOW } : t,
    );
    const w = makeWorld({
      checklists: [checklist({ tasks })],
      deviations: [],
      items: [],
    });
    const { read } = await boot(w);
    const manager = await read('emp-002');
    expect(manager.status).toBe(200);
    const view = ChecklistView.parse(manager.body);
    // onboarding-api OQ-3: every progress entry gains a `blocked` count.
    expect(view.progress).toEqual([
      { owner: 'it', total: 2, done: 0, blocked: 0 },
      { owner: 'admin', total: 1, done: 0, blocked: 0 },
      { owner: 'manager', total: 2, done: 1, blocked: 0 },
      { owner: 'buddy', total: 1, done: 0, blocked: 0 },
    ]);
    // onboarding-api OQ-5: the view gains `newJoiner`. No profile is seeded here, so it is null;
    // that is also why the displayName key check below still holds. (A missing profile reads as null.)
    expect(view.newJoiner).toBeNull();
    expect(view.pendingDeviationIds).toEqual([]);
    expect((await read('emp-005')).status).toBe(200);
    expect((await read('emp-001')).status).toBe(200);
    expectError(await read('emp-004'), 404, 'not_found');
    expectError(await read('emp-009'), 404, 'not_found');
    const keys = walkKeys(manager.body);
    expect(keys).not.toContain('displayName');
    expect(keys).not.toContain('email');
  });

  it('AT-33: pendingDeviationIds lists only that checklist pending deviations', async () => {
    const w = makeWorld({
      deviations: [
        deviation('dev-001', ADD),
        deviation('dev-002', { kind: 'remove', templateTaskId: 'desk' }, { status: 'rejected' }),
        deviation('dev-003', ADD, { checklistId: 'chk-other' }),
      ],
      items: [],
    });
    const { read } = await boot(w);
    const res = await read('emp-001');
    expect(res.status).toBe(200);
    expect(ChecklistView.parse(res.body).pendingDeviationIds).toEqual(['dev-001']);
  });
});
