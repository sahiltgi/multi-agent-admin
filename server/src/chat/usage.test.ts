// specs/agent-metrics.md AT-9 (internal_error and conflict usage) and AT-10 (hand-back sums both
// traces) for POST /chat. Compact copy of the chat/routes.test.ts harness: the real classifyMessage
// and runLeaveAgent run over one scripted fake ModelClient (every call reports 10/5 tokens), so the
// expected usage is model calls x 10/5 at one uniform test price. AT-9 conversation_full is not
// covered here (it needs a conversation seeded to MAX_TURNS).
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../agents/audit.js';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { runLeaveAgent, type LeaveAgentDeps } from '../agents/leave/run.js';
import { buildLeaveTools } from '../agents/leave/tools.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { classifyMessage } from '../agents/orchestrator/classify.js';
import { createRouteTool } from '../agents/orchestrator/route-tool.js';
import { ToolRegistry } from '../agents/registry.js';
import type { RuntimeDeps } from '../agents/runtime.js';
import type { AuditEvent } from '../domain/schemas.js';
import {
  InMemoryApprovalStore,
  InMemoryAuditReader,
  InMemoryEmployeeDirectory,
} from '../http/approvals/in-memory.js';
import type { ApprovalApiDeps } from '../http/approvals/ports.js';
import { createApp } from '../http/app.js';
import {
  InMemoryIdempotencyStore,
  InMemoryIntakeTexts,
  InMemoryLeaveRequestStore,
} from '../intake/in-memory.js';
import type { IntakeDeps } from '../intake/ports.js';
import { createIntakeRoutes } from '../intake/routes.js';
import { Pricing } from '../lib/cost.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { fixtures } from '../seeds/fixtures.js';
import { InMemoryConversationStore } from './in-memory.js';
import { Conversation, MAX_TURNS } from './schemas.js';
import type { ConversationStore } from './ports.js';
import { createChatRoutes } from './routes.js';

type Rec = Record<string, unknown>;
type Step = Rec;

const resp = (stop_reason: string, content: unknown[]): Rec => ({
  content,
  stop_reason,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const text = (t: string): Rec => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: unknown): Rec => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const done = (t: string): Rec => resp('end_turn', [text(t)]);
const sRoute = (label: string): Step[] => [
  resp('tool_use', [toolUse('tu-r', 'route', { label })]),
  done('routed'),
];
const sAsk = (q: string): Step[] => [done(q)];
const sHandBack = (): Step[] => [
  resp('tool_use', [toolUse('tu-h', 'hand_back', {})]),
  done('Handing back.'),
];

const NOW0 = Date.UTC(2026, 9, 16, 9);
const PRICE = { inputPerMTok: 1, outputPerMTok: 5 };
const PRICING = Pricing.parse({
  version: 1,
  asOf: '2026-10-01',
  currency: 'USD',
  models: { [ORCHESTRATOR_CONFIG.model]: PRICE, [LEAVE_CONFIG.model]: PRICE },
});
const costOf = (calls: number): number => (calls * 10 * 1 + calls * 5 * 5) / 1e6;

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

interface WorldOpts {
  leaveThrows?: boolean;
  loseSave?: boolean;
}

async function makeWorld(o: WorldOpts = {}) {
  const queue: Step[] = [];
  const model = {
    calls: 0,
    queue(...steps: Step[][]): void {
      for (const s of steps) queue.push(...s);
    },
    create(): Promise<unknown> {
      model.calls += 1;
      const step = queue.shift();
      return step === undefined
        ? Promise.reject(new Error('fake script exhausted'))
        : Promise.resolve(step);
    },
  };
  const clock = {
    nowMs: () => 0,
    nowIso: () => new Date(NOW0).toISOString(),
    scheduler: { setTimeout: (): (() => void) => () => undefined },
  };
  const counter = { n: 0 };
  const idGen = (): string => `id-${String(++counter.n).padStart(3, '0')}`;
  const sink = new InMemoryAuditSink();
  const leaveStore = new InMemoryLeaveRequestStore([]);
  const approvals = new InMemoryApprovalStore([]);
  const directory = new InMemoryEmployeeDirectory(fixtures.employees);
  const registry = new ToolRegistry();
  registry.register(createRouteTool('Synthetic route description.'));
  const runtime: RuntimeDeps = {
    model,
    registry,
    prompts: {
      load: () => Promise.resolve({ found: true as const, text: 'PROMPT-FIXTURE' }),
    },
    audit: sink,
    clock,
    scheduler: clock.scheduler,
    idGen,
    detectInjection: () => ({ flagged: false }),
  };
  const leaveDeps = {
    runtime,
    data: {
      getBalances: (e: string) =>
        Promise.resolve([
          { employeeId: e, leaveType: 'annual', period: '2026-27', entitledDays: 20, usedDays: 0 },
        ]),
      getHolidays: () => Promise.resolve([]),
      getTeamDayCounts: () => Promise.resolve([]),
      getTeamSize: () => Promise.resolve(5),
    },
    policy: undefined,
    evaluateLeave: () => {
      throw new Error('the gate is not reached in these tests');
    },
    toIsoDate: (iso: string) => iso.slice(0, 10),
    texts: {
      load: () => Promise.resolve({ found: true as const, text: 'Which leave type and dates?' }),
    },
    toolDescriptions: {
      get_my_balance: 'Synthetic balance.',
      get_holidays: 'Synthetic holidays.',
      get_team_calendar: 'Synthetic calendar.',
      submit_to_gate: 'Synthetic submit.',
      hand_back: 'HAND-BACK-DESCRIPTION-FIXTURE',
    },
  } as unknown as LeaveAgentDeps;
  for (const t of buildLeaveTools(leaveDeps)) registry.register(t);

  const classify = vi.fn<IntakeDeps['classify']>((input) =>
    classifyMessage(input, {
      ...runtime,
      messages: {
        load: (k: string) => {
          const t: Record<string, string> = {
            prohibited: 'PROHIBITED-FIXTURE-TEXT',
            out_of_scope: 'OUT-OF-SCOPE-FIXTURE-TEXT',
            fallback_question: 'What would you like help with today?',
          };
          const v = t[k];
          return Promise.resolve(
            v === undefined ? { found: false as const } : { found: true as const, text: v },
          );
        },
      },
    }),
  );
  const runLeave = vi.fn<IntakeDeps['runLeave']>((input) =>
    o.leaveThrows === true
      ? Promise.reject(new Error('leave-port-down'))
      : runLeaveAgent(input, leaveDeps),
  );
  const reader = new InMemoryAuditReader(sink);
  const onboardingStore = new InMemoryOnboardingStore();
  const approvalDeps: ApprovalApiDeps = {
    directory,
    approvals,
    subjects: leaveStore,
    audit: sink,
    auditReader: reader,
    clock,
    idGen,
    onboarding: onboardingStore,
    // Amended by approval-queue-ui Q-1: every ApprovalApiDeps carries a holiday reader.
    holidays: { getHolidays: () => Promise.resolve([]) },
  };
  const intake = {
    directory,
    leaveRequests: leaveStore,
    approvals,
    approvalReader: approvals,
    audit: sink,
    auditReader: reader,
    pricing: PRICING,
    clock,
    idGen,
    classify,
    runLeave,
    texts: new InMemoryIntakeTexts({
      not_available: 'NOT-AVAILABLE-FIXTURE',
      escalated: 'ESCALATED-FIXTURE',
      returned: 'RETURNED-FIXTURE',
      hr_admin_self: 'HR-ADMIN-SELF-FIXTURE',
      hand_back: 'What do you need help with today?',
    }),
    idempotency: new InMemoryIdempotencyStore(),
    runPolicyQa: () => Promise.reject(new Error('not wired')),
    policyQuestions: {
      insert: () => Promise.resolve(true),
      get: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
    },
    qaTexts: { load: () => Promise.resolve('QA-ESCALATED-FIXTURE') },
    runOnboarding: () => Promise.reject(new Error('not wired')),
    onboarding: onboardingStore,
    onboardingTexts: { load: () => Promise.resolve('DENIED-FIXTURE') },
  } as unknown as IntakeDeps;

  const convStore = new InMemoryConversationStore();
  const saves = { n: 0 };
  const conversations: ConversationStore = {
    get: (id, u) => convStore.get(id, u),
    insert: (c) => convStore.insert(c),
    saveIfVersion: (c, v) => {
      saves.n += 1;
      if (o.loseSave === true) return Promise.resolve(false);
      return convStore.saveIfVersion(c, v);
    },
    remove: (id, u) => convStore.remove(id, u),
  };
  const CHAT_TEXTS: Record<string, string> = {
    retry: 'RETRY-FIXTURE',
    submitted: 'SUBMITTED-FIXTURE',
    draft_too_long: 'DRAFT-TOO-LONG-FIXTURE',
    draft_template: 'Earlier:\n{earlier}\nQuestion: {question}\nLatest: {latest}',
  };
  const texts = {
    load: (k: string) => {
      const t = CHAT_TEXTS[k];
      return Promise.resolve(
        t === undefined ? { found: false as const } : { found: true as const, text: t },
      );
    },
  };

  const server = createApp(approvalDeps, [
    ...createIntakeRoutes(intake),
    ...createChatRoutes({ intake, conversations, texts }),
  ]).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((r) =>
    server.once('listening', () => {
      r();
    }),
  );
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const chat = async (user: string, message: string, conversationId?: string) => {
    const r = await fetch(`http://127.0.0.1:${String(addr.port)}/chat`, {
      method: 'POST',
      headers: { 'x-demo-user': user, 'content-type': 'application/json' },
      body: JSON.stringify(
        conversationId === undefined ? { message } : { conversationId, message },
      ),
    });
    const t = await r.text();
    let body: Rec = {};
    try {
      body = JSON.parse(t) as Rec;
    } catch {
      // leave empty
    }
    return { status: r.status, text: t, body };
  };
  return { model, sink, chat, saves, opts: o, convStore };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

const chatPayloads = (w: World): Rec[] =>
  w.sink.events
    .filter((e: AuditEvent) => (e.payload as Rec).kind === 'chat_turn')
    .map((e) => e.payload as Rec);
const lastTurn = (w: World): Rec => {
  const all = chatPayloads(w);
  const p = all[all.length - 1];
  if (p === undefined) throw new Error('no chat_turn event was written');
  return p;
};
const usageOf = (p: Rec): { tokens: { input: number; output: number }; costUsd: number } => {
  expect(p.usage).toBeTruthy(); // fails as an assertion, not a TypeError, before the feature exists
  return p.usage as { tokens: { input: number; output: number }; costUsd: number };
};

describe('agent-metrics AT-9: chat failure paths carry usage', () => {
  it('AT-9: a Leave port that throws gives an internal_error event with the orchestrator usage', async () => {
    const w = await makeWorld({ leaveThrows: true });
    w.model.queue(sRoute('leave'));
    const res = await w.chat('emp-004', 'I need annual leave next month');
    expect(res.status).toBe(500);
    const p = lastTurn(w);
    expect(p.outcome).toBe('internal_error');
    const u = usageOf(p);
    expect(w.model.calls).toBeGreaterThan(0);
    expect(u.tokens).toEqual({ input: w.model.calls * 10, output: w.model.calls * 5 });
    expect(Math.abs(u.costUsd - costOf(w.model.calls))).toBeLessThan(1e-12);
  });

  it('AT-9: a lost save race is a 409 conversation_conflict and the conflict event carries usage', async () => {
    const w = await makeWorld();
    w.model.queue(sRoute('leave'), sAsk('Which dates would you like to take off?'));
    const first = await w.chat('emp-004', 'I need annual leave next month');
    expect(first.status).toBe(200);
    const conversationId = String(first.body.conversationId);
    const before = w.model.calls;
    w.opts.loseSave = true; // the continuation turn's save loses the race
    w.model.queue(sAsk('Which dates, exactly?'));
    const lost = await w.chat('emp-004', 'next week', conversationId);
    expect(lost.status).toBe(409);
    expect((lost.body.error as { code?: string }).code).toBe('conversation_conflict');
    const p = lastTurn(w);
    expect(p.outcome).toBe('conflict');
    expect(p.escalation).toBeNull();
    const u = usageOf(p);
    expect(u.tokens.input).toBe((w.model.calls - before) * 10);
    expect(u.tokens.input).toBeGreaterThan(0);
  });
});

describe('agent-metrics AT-9: a full conversation', () => {
  it('AT-9: a conversation_full conflict event has usage 0/0 and $0, and no agent runs', async () => {
    const w = await makeWorld();
    const at = '2026-10-20T09:00:00.000Z';
    const full = Conversation.parse({
      id: 'conv-full',
      userId: 'emp-004',
      turns: Array.from({ length: MAX_TURNS }, (_, i) => ({
        requestId: `old-${String(i + 1)}`,
        at,
        userText: 'Synthetic earlier message',
        reply: 'Synthetic earlier reply',
        status: 'reply',
      })),
      activeAgent: null,
      draft: null,
      version: 0,
      createdAt: at,
      updatedAt: at,
    });
    expect(await w.convStore.insert(full)).toBe(true);
    const res = await w.chat('emp-004', 'One more question', 'conv-full');
    expect(res.status).toBe(409);
    expect((res.body.error as { code?: string }).code).toBe('conversation_full');
    expect(w.model.calls).toBe(0);
    const p = lastTurn(w);
    expect(p.outcome).toBe('conflict');
    expect(p.escalation).toBe('conversation_full');
    expect(usageOf(p)).toEqual({ tokens: { input: 0, output: 0 }, costUsd: 0 });
  });
});

describe('agent-metrics AT-10: a hand-back turn sums both traces', () => {
  it('AT-10: the chat_turn event has handedBackFrom, a new requestId and usage over both traces', async () => {
    const w = await makeWorld();
    w.model.queue(sRoute('leave'), sAsk('Which dates would you like to take off?'));
    const first = await w.chat('emp-004', 'I need annual leave next month');
    expect(first.status).toBe(200);
    const conversationId = String(first.body.conversationId);
    const before = w.model.calls;
    w.model.queue(sHandBack(), sRoute('out_of_scope'));
    const second = await w.chat('emp-004', 'Actually, what is the weather?', conversationId);
    expect(second.status).toBe(200);
    const p = lastTurn(w);
    expect(typeof p.handedBackFrom).toBe('string');
    expect(p.handedBackFrom).not.toBe(p.requestId);
    const spent = w.model.calls - before;
    const u = usageOf(p);
    expect(u.tokens).toEqual({ input: spent * 10, output: spent * 5 });
    expect(Math.abs(u.costUsd - costOf(spent))).toBeLessThan(1e-12);
    // The continuation run (handedBackFrom) spent tokens that the new turn trace did not.
    const abandoned = w.sink.events.filter((e) => e.traceId === p.handedBackFrom);
    expect(abandoned.length).toBeGreaterThan(0);
  });
});
