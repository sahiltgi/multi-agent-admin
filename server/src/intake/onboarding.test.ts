// Acceptance tests for specs/onboarding.md: AT-2, AT-3, AT-22 (dispatch half), AT-24 (dispatch half),
// AT-25 to AT-28 and the determinism part of AT-35. They run POST /messages end to end with the
// real Onboarding Agent (scripted fake model), the real onboarding gate, in-memory stores and the
// approval and onboarding routes mounted on one app.
// ASSUMED contracts (reported to the coordinator):
//   IntakeDeps gains runOnboarding, onboarding (OnboardingStore) and onboardingTexts
//     ({ load(name: 'created' | 'pending_manager' | 'denied') -> string | null })
//   InMemoryOnboardingStore (onboarding/in-memory.ts) also exposes listChecklists() and listDeviations()
//   MessageResponse gains { kind: 'onboarding_checklist', requestId, checklistId, text, pendingDeviations }
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOnboardingAgent } from '../agents/onboarding/run.js';
import { buildOnboardingTools } from '../agents/onboarding/tools.js';
import { InMemoryAuditSink } from '../agents/audit.js';
import type { RoutingDecision } from '../agents/orchestrator/schemas.js';
import { ToolRegistry } from '../agents/registry.js';
import { OnboardingChecklist } from '../domain/onboarding.js';
import type { AuditEvent, Employee } from '../domain/schemas.js';
import { LoadedOnboardingPolicy } from '../gate/onboarding-policy.schema.js';
import { evaluateOnboarding } from '../gate/onboarding.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
  InMemorySubjectResolver,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createApp } from '../http/app.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { createOnboardingRoutes } from '../onboarding/routes.js';
import { fixtures } from '../seeds/fixtures.js';
import {
  InMemoryIdempotencyStore,
  InMemoryIntakeTexts,
  InMemoryLeaveRequestStore,
} from './in-memory.js';
import type { IntakeDeps } from './ports.js';
import { createIntakeRoutes } from './routes.js';
import { Pricing, Usage } from '../lib/cost.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';

const NO_PRICING = Pricing.parse({ version: 1, asOf: '2026-10-01', currency: 'USD', models: {} });
const AGENT_PRICING = Pricing.parse({
  version: 1,
  asOf: '2026-10-01',
  currency: 'USD',
  models: { [ONBOARDING_CONFIG.model]: { inputPerMTok: 1, outputPerMTok: 5 } },
});

type Rec = Record<string, unknown>;
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('expected a value');
  return v;
};

// ---------- fixture template T and the policy ----------
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
const ONE_TASK = [
  { id: 'intro', title: 'Intro call', owner: 'manager', dueOffsetDays: 0, dependsOn: [] },
];
const POLICY = LoadedOnboardingPolicy.parse({
  policy: {
    version: 'v1',
    templates: {
      engineer: { title: 'Engineer', tasks: T_TASKS },
      sales: { title: 'Sales', tasks: ONE_TASK },
      operations: { title: 'Operations', tasks: ONE_TASK },
    },
  },
  policyVersion: 'v1',
  policyHash: HASH,
});
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

// ---------- fixed texts ----------
const TEXTS = {
  created: 'CREATED-FIXTURE',
  pending_manager: 'PENDING-MANAGER-FIXTURE',
  denied: 'DENIED-FIXTURE',
};

// ---------- model script helpers ----------
const USAGE = { input_tokens: 120, output_tokens: 30 };
const resp = (stop_reason: string, content: unknown[]): Rec => ({
  content,
  stop_reason,
  usage: USAGE,
});
const toolUse = (id: string, name: string, input: unknown): Rec => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const turn = (...blocks: Rec[]): Rec => resp('tool_use', blocks);
const done = (t: string): Rec => resp('end_turn', [{ type: 'text', text: t }]);
const CREATE = {
  templateId: 'engineer',
  startDate: START,
  newHireTeam: 'team-a',
  buddyRef: 'emp-005',
};
const ADD = {
  kind: 'add',
  title: 'Order second monitor',
  owner: 'it',
  dueOffsetDays: -2,
  dependsOn: ['laptop'],
};
const REMOVE = (id: string): Rec => ({ kind: 'remove', templateTaskId: id });
const propose = (id: string, change: unknown): Rec =>
  toolUse(id, 'propose_deviation', { change, rationale: 'Requested by hr_admin' });
const S0 = (...proposals: Rec[]): Rec[] => [
  turn(toolUse('tu-1', 'get_template', { templateId: 'engineer' })),
  turn(toolUse('tu-2', 'create_checklist', CREATE)),
  ...(proposals.length === 0 ? [] : [turn(...proposals)]),
  done('MODEL-TEXT-SENTINEL'),
];

const EMP_021: Employee = {
  id: 'emp-021',
  displayName: 'Demo HR Admin 021',
  email: 'emp-021@example-widgets.example',
  role: 'hr_admin',
  teamId: null,
  managerId: null,
};
const EMPLOYEES: Employee[] = [...fixtures.employees, EMP_021];

// ---------- the world ----------
interface WorldOpts {
  textsOmit?: (keyof typeof TEXTS)[];
  failSecondItemInsert?: boolean;
  failGateAudit?: boolean;
  runOnboardingOverride?: IntakeDeps['runOnboarding'];
  label?: RoutingDecision['label'];
}

function makeWorld(script: Rec[], o: WorldOpts = {}) {
  const log: string[] = [];
  const inner = new InMemoryAuditSink();
  const sink = {
    events: inner.events,
    write(e: AuditEvent): Promise<void> {
      if (e.actor.id === 'intake') log.push('intake-event');
      if (o.failGateAudit === true && e.eventType === 'gate_result') {
        return Promise.reject(new Error('sink-down'));
      }
      return inner.write(e);
    },
  };
  const counters = { id: 0, evt: 0 };
  const idGen = () => `id-${String(++counters.id).padStart(3, '0')}`;
  const directory = new InMemoryEmployeeDirectory(EMPLOYEES);
  const agentDirectory = {
    getById: (id: string) => directory.getById(id),
    getTeamById: (id: string) => Promise.resolve(fixtures.teams.find((t) => t.id === id) ?? null),
  };
  const store = new InMemoryOnboardingStore([], []);
  const loggedStore = new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'removeChecklist') log.push('remove-checklist');
        if (prop === 'removeDeviation') log.push('remove-deviation');
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const approvals = new InMemoryApprovalStore([]);
  let itemInserts = 0;
  const itemWriter = {
    insert: (item: Parameters<typeof approvals.insert>[0]) => {
      itemInserts += 1;
      if (o.failSecondItemInsert === true && itemInserts === 2) {
        return Promise.reject(new Error('store-down'));
      }
      return approvals.insert(item);
    },
    remove: (id: string) => {
      log.push('remove-item');
      return approvals.remove(id);
    },
  };

  // Scripted model, constant clock.
  const queue = [...script];
  const model = {
    requests: [] as Rec[],
    create(req: Rec): Promise<unknown> {
      model.requests.push(structuredClone(req));
      const step = queue.shift();
      return step === undefined
        ? Promise.reject(new Error('fake script exhausted'))
        : Promise.resolve(step);
    },
  };
  const clock = {
    nowMs: () => 0,
    nowIso: () => NOW,
    scheduler: { setTimeout: () => () => undefined },
  };
  const registry = new ToolRegistry();
  const gate = vi.fn((...args: unknown[]) =>
    evaluateOnboarding(args[0] as never, args[1] as never),
  );
  const agentTexts = {
    load: (key: string) =>
      Promise.resolve(
        key === 'fallback_question'
          ? { found: true as const, text: 'Which role, start date and team?' }
          : key === 'start_date_past'
            ? { found: true as const, text: 'That start date has passed.' }
            : { found: false as const },
      ),
  };
  const agentDeps = {
    runtime: {
      model,
      registry,
      prompts: {
        load: () => Promise.resolve({ found: true as const, text: 'ONBOARDING-PROMPT-FIXTURE' }),
      },
      audit: sink,
      clock,
      scheduler: clock.scheduler,
      idGen: () => `evt-${String(++counters.evt).padStart(4, '0')}`,
      detectInjection: () => ({ flagged: false }),
    },
    directory: agentDirectory,
    policy: POLICY,
    evaluateOnboarding: gate,
    toIsoDate: (iso: string) => iso.slice(0, 10),
    texts: agentTexts,
    toolDescriptions: {
      get_template: 'Synthetic fixture: return a role template.',
      create_checklist: 'Synthetic fixture: build the template checklist.',
      propose_deviation: 'Synthetic fixture: record a requested deviation.',
    },
  };
  for (const t of buildOnboardingTools(agentDeps)) registry.register(t);

  const classify = vi.fn<IntakeDeps['classify']>(() =>
    Promise.resolve({
      requestId: 'placeholder',
      model: 'synthetic-model',
      promptVersion: 'v1',
      source: 'model',
      fallbackReason: null,
      label: o.label ?? 'onboarding',
      targetAgent: 'onboarding',
    } as unknown as RoutingDecision),
  );
  classify.mockImplementation((input) =>
    Promise.resolve({
      requestId: input.requestId,
      model: 'synthetic-model',
      promptVersion: 'v1',
      source: 'model',
      fallbackReason: null,
      label: 'onboarding',
      targetAgent: 'onboarding',
    } as unknown as RoutingDecision),
  );
  const runOnboarding = vi.fn<IntakeDeps['runOnboarding']>(
    o.runOnboardingOverride ?? ((input) => runOnboardingAgent(input, agentDeps)),
  );
  const leaveStore = new InMemoryLeaveRequestStore([]);
  const intakeDeps = {
    directory,
    leaveRequests: leaveStore,
    approvals: itemWriter,
    approvalReader: approvals,
    audit: sink,
    auditReader: new InMemoryAuditReader(inner),
    pricing: AGENT_PRICING, // spec agent-metrics AT-7: the onboarding model is priced
    clock,
    idGen,
    classify,
    runLeave: vi.fn(),
    texts: new InMemoryIntakeTexts({
      not_available: 'NOT-AVAILABLE-FIXTURE',
      escalated: 'ESCALATED-FIXTURE',
      returned: 'RETURNED-FIXTURE',
      hr_admin_self: 'HR-ADMIN-SELF-FIXTURE',
      hand_back: 'HAND-BACK-FIXTURE?',
    }),
    idempotency: new InMemoryIdempotencyStore(),
    runPolicyQa: vi.fn(),
    policyQuestions: {
      insert: () => Promise.resolve(true),
      get: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
    },
    qaTexts: { load: () => Promise.resolve('QA-ESCALATED-FIXTURE') },
    runOnboarding,
    onboarding: loggedStore,
    onboardingTexts: {
      load: (name: keyof typeof TEXTS) =>
        Promise.resolve(o.textsOmit?.includes(name) === true ? null : TEXTS[name]),
    },
  } as unknown as IntakeDeps;
  const approvalDeps = {
    directory,
    approvals,
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
    auditReader: new InMemoryAuditReader(inner),
    clock,
    idGen,
    onboarding: store,
  } as unknown as ApprovalApiDeps;
  // onboarding-api (rule 19): one deps shape for all four onboarding routes. This file only needs
  // the PATCH route (completion in AT-2), so the create-only dependencies are loud stubs.
  const unused = (name: string) => () => Promise.reject(new Error(`${name} must not be used`));
  const routes = [
    ...createIntakeRoutes(intakeDeps),
    ...createOnboardingRoutes({
      directory: {
        getById: (id: string) => directory.getById(id),
        getTeamById: (id: string) =>
          Promise.resolve(fixtures.teams.find((t) => t.id === id) ?? null),
      },
      onboarding: store,
      approvals: { insert: unused('approvals.insert'), remove: unused('approvals.remove') },
      messages: { recordMessage: unused('messages.recordMessage') },
      audit: sink,
      auditReader: new InMemoryAuditReader(inner),
      pricing: NO_PRICING, // nothing priced, so usage is null (spec agent-metrics, rule 9)
      clock,
      idGen,
      idempotency: {
        begin: unused('begin'),
        complete: unused('complete'),
        release: unused('release'),
      },
      policy: POLICY,
      evaluateOnboarding: gate,
      toIsoDate: (iso: string) => iso.slice(0, 10),
      runOnboardingNotes: unused('runOnboardingNotes'),
      onboardingTexts: intakeDeps.onboardingTexts,
      intakeTexts: intakeDeps.texts,
    }),
  ];
  return {
    approvalDeps,
    routes,
    sink,
    store,
    approvals,
    classify,
    runOnboarding,
    gate,
    log,
    model,
  };
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
  const server = createApp(w.approvalDeps, w.routes).listen(0, '127.0.0.1');
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
  ) => {
    const headers: Record<string, string> = { 'x-demo-user': user };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed: Rec;
    try {
      parsed = JSON.parse(text) as Rec;
    } catch {
      parsed = {};
    }
    return { status: r.status, text, body: parsed } satisfies Res;
  };
  const send = (user: string, text = 'A new engineer joins team-a on 2026-12-01.') =>
    call(user, 'POST', '/messages', { text });
  const act = (
    user: string,
    itemId: string,
    action: 'approve' | 'reject' | 'comment',
    verdict = 'MANAGER',
  ) =>
    call(user, 'POST', `/approvals/${itemId}/actions`, {
      action,
      // The approval queue requires text on a comment (approval-queue rule 8).
      ...(action === 'comment' ? { comment: 'Synthetic note.' } : {}),
      seen: { verdict, policyHash: HASH },
    });
  // onboarding-api OQ-1: POST .../complete with {} became PATCH /onboarding/:id/tasks/:taskId with
  // { status: 'done' }. emp-001 (hr_admin) still completes the it task `laptop` (OQ-2: on behalf of it).
  const complete = (user: string, checklistId: string, taskId: string) =>
    call(user, 'PATCH', `/onboarding/${checklistId}/tasks/${taskId}`, { status: 'done' });
  return { call, send, act, complete };
}

const snapshotRecords = async (w: World) => ({
  checklists: await w.store.listChecklists(),
  deviations: await w.store.listDeviations(),
  items: await w.approvals.list(),
});
const taskOf = (c: Rec, id: string): Rec | undefined => (c.tasks as Rec[]).find((t) => t.id === id);

// ================= AT-3, AT-26 =================

describe('onboarding AT-3, AT-26: AUTO creates exactly the template checklist', () => {
  it('AT-3: script S0 gives AUTO, one template checklist, no deviation and no item', async () => {
    const w = makeWorld(S0());
    const { send } = await boot(w);
    const res = await send('emp-001');
    expect(res.status).toBe(200);
    const { checklists, deviations, items } = await snapshotRecords(w);
    expect(checklists).toHaveLength(1);
    expect(deviations).toHaveLength(0);
    expect(items).toHaveLength(0);
    const stored = must(checklists[0]) as unknown as Rec;
    const gate = stored.gateResult as Rec;
    expect(gate.verdict).toBe('AUTO');
    expect((gate.ruleResults as Rec[]).map((r) => [r.ruleId, r.passed])).toEqual([
      ['checklist_matches_template', true],
      ['no_tasks_added', true],
      ['no_tasks_removed', true],
    ]);
    expect(stored.tasks).toEqual(templateTasks());
    expect(stored.removedTemplateTaskIds).toEqual([]);
    expect(taskOf(stored, 'laptop')).not.toHaveProperty('ownerEmployeeId');
    expect(taskOf(stored, 'desk')).not.toHaveProperty('ownerEmployeeId');
  });

  it('AT-26: the stored checklist parses, copies the gate result, and the reply is the fixed text', async () => {
    const w = makeWorld(S0());
    const { send } = await boot(w);
    const res = await send('emp-001');
    const stored = must((await snapshotRecords(w)).checklists[0]);
    expect(OnboardingChecklist.safeParse(stored).success).toBe(true);
    const rec = stored as unknown as Rec;
    expect(rec.createdBy).toBe('emp-001');
    expect(rec.version).toBe(0);
    expect(rec.createdAt).toBe(NOW);
    expect(rec.policyHash).toBe(HASH);
    expect(rec.templateVersion).toBe('v1');
    expect(rec.managerEmployeeId).toBe('emp-002');
    expect(rec.buddyEmployeeId).toBe('emp-005');
    expect(String(rec.newJoinerId)).toMatch(/\S/);
    expect(EMPLOYEES.map((e) => e.id)).not.toContain(rec.newJoinerId);
    expect(res.body).toMatchObject({
      kind: 'onboarding_checklist',
      checklistId: rec.id,
      text: TEXTS.created,
      pendingDeviations: 0,
    });
    expect(res.text).not.toContain('MODEL-TEXT-SENTINEL');
  });
});

// ================= AT-2, AT-27 =================

describe('onboarding AT-2, AT-27: deviations become pending manager items', () => {
  it.each([
    ['add', ADD],
    ['remove', REMOVE('buddy-intro')],
  ])(
    'AT-2: a %s deviation gives MANAGER, one pending deviation and one open item',
    async (_n, change) => {
      const w = makeWorld(S0(propose('tu-3', change)));
      const { send } = await boot(w);
      expect((await send('emp-001')).status).toBe(200);
      const { checklists, deviations, items } = await snapshotRecords(w);
      const stored = must(checklists[0]) as unknown as Rec;
      const gate = stored.gateResult as Rec;
      expect(gate.verdict).toBe('MANAGER');
      const failedRule = change.kind === 'add' ? 'no_tasks_added' : 'no_tasks_removed';
      const rules = gate.ruleResults as Rec[];
      expect(rules.find((r) => r.ruleId === failedRule)?.passed).toBe(false);
      expect(deviations).toHaveLength(1);
      expect(must(deviations[0]).status).toBe('pending');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'onboarding_deviation',
        subjectId: must(deviations[0]).id,
        assigneeRole: 'manager',
        assigneeId: 'emp-002',
        status: 'open',
      });
      expect(stored.tasks).toEqual(templateTasks());
      expect(taskOf(stored, 'added-1')).toBeUndefined();
      expect(taskOf(stored, 'buddy-intro')).toBeDefined();
      expect(stored.removedTemplateTaskIds).toEqual([]);
    },
  );

  it('AT-2: comments, other actors, the proposer and completion leave the checklist unchanged; only emp-002 approve adds added-1', async () => {
    const w = makeWorld(S0(propose('tu-3', ADD)));
    const { send, act, complete } = await boot(w);
    await send('emp-001');
    const before = must((await snapshotRecords(w)).checklists[0]) as unknown as Rec;
    const itemId = must((await w.approvals.list())[0]).id;
    const checklistId = String(before.id);
    const same = async (): Promise<void> => {
      const now = must(await w.store.getChecklist(checklistId)) as unknown as Rec;
      // Completion may flip `done`, but the task list itself never changes.
      expect((now.tasks as Rec[]).map((t) => t.id)).toEqual(T_TASKS.map((t) => t.id));
      expect(taskOf(now, 'added-1')).toBeUndefined();
    };
    expect((await act('emp-002', itemId, 'comment')).status).toBe(200);
    await same();
    expect((await act('emp-021', itemId, 'approve')).status).toBe(404);
    expect((await act('emp-009', itemId, 'approve')).status).toBe(404);
    const self = await act('emp-001', itemId, 'approve');
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toContain('self_action_forbidden');
    expect((await complete('emp-001', checklistId, 'laptop')).status).toBe(200);
    await same();
    expect((await act('emp-002', itemId, 'approve')).status).toBe(200);
    const after = must(await w.store.getChecklist(checklistId)) as unknown as Rec;
    expect(taskOf(after, 'added-1')).toMatchObject({ source: 'added', title: ADD.title });
  });

  it('AT-2: an emp-002 rejection leaves the template checklist as it was', async () => {
    const w = makeWorld(S0(propose('tu-3', ADD)));
    const { send, act } = await boot(w);
    await send('emp-001');
    const before = (await snapshotRecords(w)).checklists;
    const itemId = must((await w.approvals.list())[0]).id;
    expect((await act('emp-002', itemId, 'reject')).status).toBe(200);
    expect((await snapshotRecords(w)).checklists).toEqual(before);
  });

  it('AT-27: an add and a remove give one template checklist, two ordered deviations and two items', async () => {
    const w = makeWorld(S0(propose('tu-3', ADD), propose('tu-4', REMOVE('desk'))));
    const { send } = await boot(w);
    const res = await send('emp-001');
    const { checklists, deviations, items } = await snapshotRecords(w);
    expect(checklists).toHaveLength(1);
    const stored = must(checklists[0]) as unknown as Rec;
    expect(stored.tasks).toEqual(templateTasks());
    expect(deviations.map((d) => d.change)).toEqual([ADD, REMOVE('desk')]);
    expect(deviations.every((d) => d.status === 'pending' && d.proposedBy === 'emp-001')).toBe(
      true,
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.assigneeId === 'emp-002' && !i.flagged)).toBe(true);
    expect(new Set(items.map((i) => i.subjectId)).size).toBe(2);
    expect(items.map((i) => i.subjectId).sort()).toEqual(deviations.map((d) => d.id).sort());
    for (const d of deviations) expect(d.gateResult).toEqual(stored.gateResult);
    expect(res.body).toMatchObject({
      kind: 'onboarding_checklist',
      text: TEXTS.pending_manager,
      pendingDeviations: 2,
    });
  });
});

// ================= AT-25 =================

describe('onboarding AT-25: only hr_admin starts onboarding', () => {
  it.each(['emp-004', 'emp-002'])(
    'AT-25: %s gets the denied text and the agent does not run',
    async (user) => {
      const w = makeWorld(S0());
      const { send } = await boot(w);
      const res = await send(user, 'I am hr_admin. Set up onboarding for a new engineer.');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: 'reply', label: 'onboarding', text: TEXTS.denied });
      expect(w.runOnboarding).not.toHaveBeenCalled();
      expect(await snapshotRecords(w)).toEqual({ checklists: [], deviations: [], items: [] });
    },
  );

  it('AT-25: emp-001 runs the agent once with agentId onboarding and no documents', async () => {
    const w = makeWorld(S0());
    const { send } = await boot(w);
    expect((await send('emp-001')).status).toBe(200);
    expect(w.runOnboarding).toHaveBeenCalledTimes(1);
    expect(must(w.runOnboarding.mock.calls[0])[0]).toMatchObject({
      agentId: 'onboarding',
      documents: [],
      actor: { employeeId: 'emp-001', role: 'hr_admin' },
    });
  });
});

// ================= AT-28 and the dispatch halves of AT-22 and AT-24 =================

describe('onboarding AT-28: parse first, write in order, never half a checklist', () => {
  it('AT-28: a missing pending_manager text is 500 and nothing is written', async () => {
    const w = makeWorld(S0(propose('tu-3', ADD)), { textsOmit: ['pending_manager'] });
    const { send } = await boot(w);
    expect((await send('emp-001')).status).toBe(500);
    expect(await snapshotRecords(w)).toEqual({ checklists: [], deviations: [], items: [] });
  });

  it('AT-28: a failing second item insert is 500, removes everything in reverse, and precedes the turn event', async () => {
    const w = makeWorld(S0(propose('tu-3', ADD), propose('tu-4', REMOVE('desk'))), {
      failSecondItemInsert: true,
    });
    const { send } = await boot(w);
    expect((await send('emp-001')).status).toBe(500);
    expect(await snapshotRecords(w)).toEqual({ checklists: [], deviations: [], items: [] });
    const removals = w.log.filter((x) => x.startsWith('remove-'));
    const rank = (x: string): number =>
      x === 'remove-item' ? 0 : x === 'remove-deviation' ? 1 : 2;
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.map(rank)).toEqual([...removals.map(rank)].sort((a, b) => a - b));
    expect(removals).toContain('remove-checklist');
    // The turn's store_error event is still written, after every removal.
    const firstEvent = w.log.indexOf('intake-event');
    expect(firstEvent).toBeGreaterThanOrEqual(0);
    expect(w.log.lastIndexOf('remove-checklist')).toBeLessThan(firstEvent);
  });

  it.each([
    ['needs_details', [done('What is the exact start date?')]],
    ['escalated', [resp('refusal', [])]],
  ])('AT-28: a %s result writes no checklist, deviation or item', async (_n, script) => {
    const w = makeWorld(script);
    const { send } = await boot(w);
    const res = await send('emp-001');
    expect(res.status).toBe(200);
    expect(await snapshotRecords(w)).toEqual({ checklists: [], deviations: [], items: [] });
  });
});

describe('onboarding AT-22, AT-24 (dispatch half)', () => {
  it('AT-24: a sink that rejects the gate event gives 500 and zero records', async () => {
    const w = makeWorld(S0(propose('tu-3', ADD)), { failGateAudit: true });
    const { send } = await boot(w);
    expect((await send('emp-001')).status).toBe(500);
    expect(await snapshotRecords(w)).toEqual({ checklists: [], deviations: [], items: [] });
  });

  it('AT-22: a failed checklist_matches_template is an internal error and persists nothing', async () => {
    const failed = (ruleId: string, passed: boolean): Rec => ({
      ruleId,
      passed,
      expected: 'e',
      actual: 'a',
      message: 'm',
    });
    const w = makeWorld([], {
      runOnboardingOverride: (input) =>
        Promise.resolve({
          kind: 'checklist',
          requestId: input.requestId,
          checklist: {
            templateId: 'engineer',
            startDate: START,
            newHireTeam: 'team-a',
            assignees: { managerEmployeeId: 'emp-002', buddyEmployeeId: 'emp-005' },
            tasks: templateTasks(),
            policyVersion: 'v1',
            policyHash: HASH,
          },
          deviations: [],
          gate: {
            verdict: 'MANAGER',
            ruleResults: [
              failed('checklist_matches_template', false),
              failed('no_tasks_added', true),
              failed('no_tasks_removed', true),
            ],
            reason: 'Deviations need manager approval.',
            policyVersion: 'v1',
            policyHash: HASH,
          },
          injectionSuspected: false,
        }),
    });
    const { send } = await boot(w);
    expect((await send('emp-001')).status).toBe(500);
    expect(await snapshotRecords(w)).toEqual({ checklists: [], deviations: [], items: [] });
  });
});

// ================= AT-35 (determinism and fixtures) =================

describe('onboarding AT-35: deterministic dispatch and synthetic fixtures', () => {
  it('AT-35: two identical dispatches of S0 give equal responses, records and audit lists', async () => {
    const runs: { res: Rec; records: unknown; events: unknown }[] = [];
    for (let i = 0; i < 2; i += 1) {
      const w = makeWorld(S0(propose('tu-3', ADD)));
      const { send } = await boot(w);
      const res = await send('emp-001');
      runs.push({ res: res.body, records: await snapshotRecords(w), events: w.sink.events });
    }
    expect(must(runs[0]).res).toMatchObject({ kind: 'onboarding_checklist' });
    expect(must(runs[0])).toEqual(must(runs[1]));
  });

  it('AT-35: every fixture employee id is emp-NNN and every email ends in .example or .test', () => {
    for (const e of EMPLOYEES) {
      expect(e.id).toMatch(/^emp-\d{3}$/);
      expect(e.email).toMatch(/\.(example|test)$/);
    }
  });
});

describe('agent-metrics AT-7: the onboarding_checklist intake event carries a Usage', () => {
  it('AT-7: onboarding_checklist has a usage key whose value is a Usage', async () => {
    const w = makeWorld(S0());
    const { send } = await boot(w);
    expect((await send('emp-001')).status).toBe(200);
    const events = w.sink.events.filter((e) => e.payload.kind === 'intake_outcome');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload ?? {};
    expect(payload.outcome).toBe('onboarding_checklist');
    expect(Usage.safeParse(payload.usage).success).toBe(true);
  });
});
