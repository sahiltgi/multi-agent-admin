// specs/chat-endpoint.md AT-19 (hand_back tool and config), AT-20 (run precedence, direct) and
// AT-21 (model_unavailable for classifyMessage and runLeaveAgent). Chat half of AT-20 is in
// server/src/chat/routes.test.ts. Self-contained harness; synthetic data only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink, type AuditSink } from '../audit.js';
import { classifyMessage } from '../orchestrator/classify.js';
import { createRouteTool } from '../orchestrator/route-tool.js';
import { ToolRegistry } from '../registry.js';
import { LoadedLeavePolicy } from '../../gate/leave-policy.schema.js';
import { LEAVE_CONFIG } from './config.js';
import { runLeaveAgent, type LeaveAgentDeps } from './run.js';
import { buildLeaveTools } from './tools.js';

type Rec = Record<string, unknown>;
interface Opts {
  signal: AbortSignal;
  timeout: number;
}
type Step = Rec | ((req: Rec, opts: Opts) => Promise<unknown>);
const resp = (stop_reason: string, content: unknown[]): Rec => ({
  content,
  stop_reason,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const text = (t: string): Rec => ({ type: 'text', text: t });
const tu = (id: string, name: string, input: unknown): Rec => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const turn = (...b: Rec[]): Rec => resp('tool_use', b);
const done = (t: string): Rec => resp('end_turn', [text(t)]);
const hangStep: Step = (_r, o) =>
  new Promise((res) => {
    o.signal.addEventListener('abort', () => {
      res(done('late'));
    });
  });
const DESC = 'HAND-BACK-DESCRIPTION-FIXTURE';
const EXTRACT = { leaveType: 'annual', startDate: '2026-11-16', endDate: '2026-11-20' };
const G = {
  verdict: 'ROUTE_TO_MANAGER',
  ruleResults: [
    { ruleId: 'dates_valid', passed: true, expected: 'a', actual: 'b', message: 'ok.' },
  ],
  reason: 'Synthetic gate reason',
  policyVersion: 'v1',
  policyHash: '0123456789abcdef'.repeat(4),
};
const POLICY = LoadedLeavePolicy.parse({
  policy: {
    version: 'v1',
    effectiveFrom: '2026-10-01',
    leaveTypes: ['annual', 'sick', 'casual', 'unpaid', 'bereavement', 'parental'],
    minNoticeWorkingDays: {
      annual: 5,
      sick: 0,
      casual: 1,
      unpaid: 10,
      bereavement: 0,
      parental: 20,
    },
    requiredFields: {
      annual: ['startDate', 'endDate'],
      sick: ['startDate', 'endDate'],
      casual: ['startDate', 'endDate'],
      unpaid: ['startDate', 'endDate', 'reason'],
      bereavement: ['startDate', 'endDate'],
      parental: ['startDate', 'endDate'],
    },
    alwaysEscalate: ['unpaid', 'bereavement', 'parental'],
    blackoutWindows: [{ id: 'bw-test', start: '2026-12-07', end: '2026-12-11', label: 'Close' }],
    maxTeamOverlapPercent: 30,
    escalateAboveConsecutiveWorkingDays: 10,
  },
  policyVersion: 'v1',
  policyHash: 'a'.repeat(64),
});

function setup(
  script: Step[],
  o: {
    repeat?: boolean;
    wrapSink?: (s: InMemoryAuditSink) => AuditSink;
    wrapHandBack?: boolean;
  } = {},
) {
  const requests: Rec[] = [];
  let n = 0;
  const model = {
    requests,
    create(req: Rec, opts: Opts): Promise<unknown> {
      requests.push(structuredClone(req));
      const idx = o.repeat === true ? Math.min(n, script.length - 1) : n;
      n += 1;
      const step = script[idx];
      if (step === undefined) return Promise.reject(new Error('script exhausted'));
      return typeof step === 'function' ? step(req, opts) : Promise.resolve(step);
    },
  };
  let now = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  let tid = 0;
  const clock = {
    nowMs: () => now,
    nowIso: () => new Date(Date.UTC(2026, 9, 16, 9) + now).toISOString(),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].filter(([, x]) => x.due <= now)) {
        timers.delete(id);
        t.fn();
      }
    },
    scheduler: {
      setTimeout(fn: () => void, ms: number) {
        const id = tid++;
        timers.set(id, { due: now + ms, fn });
        return () => {
          timers.delete(id);
        };
      },
    },
  };
  const sink = new InMemoryAuditSink();
  const registry = new ToolRegistry();
  registry.register(createRouteTool('Synthetic route.'));
  let ids = 0;
  const port = {
    getBalances: vi.fn(() =>
      Promise.resolve([
        {
          employeeId: 'emp-004',
          leaveType: 'annual',
          period: '2026-27',
          entitledDays: 20,
          usedDays: 0,
        },
      ]),
    ),
    getHolidays: vi.fn(() => Promise.resolve([])),
    getTeamDayCounts: vi.fn(() => Promise.resolve([])),
    getTeamSize: vi.fn(() => Promise.resolve(5)),
  };
  const gate = vi.fn(() => G);
  const runtime = {
    model,
    registry,
    prompts: { load: () => Promise.resolve({ found: true as const, text: 'PROMPT-FIXTURE' }) },
    audit: o.wrapSink === undefined ? sink : o.wrapSink(sink),
    clock,
    scheduler: clock.scheduler,
    idGen: () => `evt-${String((ids += 1))}`,
    detectInjection: () => ({ flagged: false }),
  };
  const deps = {
    runtime,
    data: port,
    policy: POLICY,
    evaluateLeave: gate,
    toIsoDate: (s: string) => s.slice(0, 10),
    texts: {
      load: (k: string) =>
        Promise.resolve({
          found: true as const,
          text:
            k === 'fallback_question'
              ? 'Which leave type and dates do you need?'
              : 'Gate: {verdict}.',
        }),
    },
    toolDescriptions: {
      get_my_balance: 'b',
      get_holidays: 'h',
      get_team_calendar: 't',
      submit_to_gate: 's',
      hand_back: DESC,
    },
  } as unknown as LeaveAgentDeps;
  const handBackHandler = vi.fn();
  for (const t of buildLeaveTools(deps)) {
    registry.register(
      t.name === 'hand_back' && o.wrapHandBack === true
        ? {
            ...t,
            handler: (i, c) => {
              handBackHandler();
              return t.handler(i, c);
            },
          }
        : t,
    );
  }
  const run = () =>
    runLeaveAgent(
      {
        requestId: 'req-1',
        agentId: 'leave',
        actor: { employeeId: 'emp-004', role: 'employee' },
        userText: 'Leave please',
        documents: [],
      },
      deps,
    );
  const classify = () =>
    classifyMessage(
      {
        requestId: 'req-1',
        agentId: 'orchestrator',
        actor: { employeeId: 'emp-004', role: 'employee' },
        userText: 'Leave please',
        documents: [],
      },
      {
        ...runtime,
        messages: {
          load: (k: string) =>
            Promise.resolve({
              found: true as const,
              text:
                k === 'fallback_question' ? 'What would you like help with today?' : 'fixed text',
            }),
        },
      },
    );
  return { model, clock, sink, run, classify, port, gate, handBackHandler };
}
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
};
const asRec = (r: unknown): Rec => r as Rec;
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected a value');
  return v;
}
const lastResults = (req: Rec): Rec[] => must((req.messages as Rec[]).at(-1)).content as Rec[];

describe('hand_back tool and config', () => {
  it('AT-19: the leave config allowlists five tools including hand_back and uses prompt v2', () => {
    expect(LEAVE_CONFIG.promptVersion).toBe('v2');
    expect(LEAVE_CONFIG.allowlist).toHaveLength(5);
    expect(new Set(LEAVE_CONFIG.allowlist)).toEqual(
      new Set([
        'get_my_balance',
        'get_holidays',
        'get_team_calendar',
        'submit_to_gate',
        'hand_back',
      ]),
    );
  });

  it('AT-19: the request offers five strict tools; hand_back has no properties and the fixture description', async () => {
    const t = setup([done('Which dates would you like to take off?')]);
    await t.run();
    const tools = must(t.model.requests[0]).tools as Rec[];
    expect(tools.map((x) => x.name).sort()).toEqual([
      'get_holidays',
      'get_my_balance',
      'get_team_calendar',
      'hand_back',
      'submit_to_gate',
    ]);
    for (const x of tools) expect(x.strict).toBe(true);
    const hb = must(tools.find((x) => x.name === 'hand_back'));
    expect(Object.keys(asRec(asRec(hb.input_schema).properties ?? {}))).toHaveLength(0);
    expect(asRec(hb.input_schema).additionalProperties).toBe(false);
    expect(hb.description).toBe(DESC);
  });

  it('AT-19: a hand_back call with an argument is an is_error result and the handler does not run', async () => {
    const t = setup(
      [
        turn(tu('tu-1', 'hand_back', { reason: 'x' })),
        done('Which dates would you like to take off?'),
      ],
      { wrapHandBack: true },
    );
    await t.run();
    expect(lastResults(must(t.model.requests[1]))[0]?.is_error).toBe(true);
    expect(t.handBackHandler).not.toHaveBeenCalled();
  });

  it('AT-19: a valid call returns { handedBack: true } and touches neither the data port nor the gate', async () => {
    const t = setup([turn(tu('tu-1', 'hand_back', {})), done('Handing back.')]);
    const result = asRec(await t.run());
    expect(JSON.parse(String(lastResults(must(t.model.requests[1]))[0]?.content))).toEqual({
      handedBack: true,
    });
    expect(result.kind).toBe('hand_back');
    for (const p of Object.values(t.port)) expect(p).not.toHaveBeenCalled();
    expect(t.gate).not.toHaveBeenCalled();
  });

  it('AT-19: the hand_back handler source imports no data port, gate, fs or mongoose and reads no clock', () => {
    const src = readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8');
    const at = src.indexOf("name: 'hand_back'");
    expect(at).toBeGreaterThan(-1);
    const rest = src.slice(at);
    const block = rest.slice(
      0,
      !rest.includes('\n    erase(', 1) ? undefined : rest.indexOf('\n    erase(', 1),
    );
    for (const bad of [
      'data.',
      'evaluateLeave',
      'Date.now',
      'clock',
      'readFile',
      'mongoose',
      'deps.',
    ]) {
      expect(block, bad).not.toContain(bad);
    }
  });
});

describe('run precedence (AT-20)', () => {
  const conflict = async (script: Step[], wrapSink?: (s: InMemoryAuditSink) => AuditSink) => {
    const r = asRec(await setup(script, wrapSink === undefined ? {} : { wrapSink }).run());
    expect(r).toMatchObject({ kind: 'escalated', reason: 'hand_back_conflict' });
    expect(r).not.toHaveProperty('card');
  };
  it('AT-20: (a) submit and hand_back in one turn escalate as hand_back_conflict', async () => {
    await conflict([
      turn(tu('a', 'submit_to_gate', EXTRACT), tu('b', 'hand_back', {})),
      done('ok'),
    ]);
  });
  it('AT-20: (b) submit and hand_back across two turns escalate as hand_back_conflict', async () => {
    await conflict([
      turn(tu('a', 'submit_to_gate', EXTRACT)),
      turn(tu('b', 'hand_back', {})),
      done('ok'),
    ]);
  });
  it('AT-20: (c) a submission whose gate_result write failed, then hand_back, fails closed', async () => {
    const wrap = (s: InMemoryAuditSink): AuditSink => ({
      write: (e) =>
        e.eventType === 'gate_result' ? Promise.reject(new Error('sink-down')) : s.write(e),
    });
    await conflict(
      [turn(tu('a', 'submit_to_gate', EXTRACT)), turn(tu('b', 'hand_back', {})), done('ok')],
      wrap,
    );
  });
  it('AT-20: (d) hand_back then a hanging call is escalated as model_unavailable', async () => {
    const t = setup([turn(tu('a', 'hand_back', {})), hangStep]);
    const p = t.run();
    await flush();
    t.clock.advance(60_000);
    expect(asRec(await p)).toMatchObject({ kind: 'escalated', reason: 'model_unavailable' });
  });
  it('AT-20: hand_back alone gives { kind: hand_back } and a leave_outcome with outcome hand_back', async () => {
    const t = setup([turn(tu('a', 'hand_back', {})), done('ok')]);
    expect(asRec(await t.run())).toMatchObject({
      kind: 'hand_back',
      requestId: 'req-1',
      injectionSuspected: false,
    });
    const outcome = t.sink.events
      .map((e) => e.payload as Rec)
      .find((p) => p.kind === 'leave_outcome');
    expect(outcome?.outcome).toBe('hand_back');
  });
});

describe('model_unavailable (AT-21)', () => {
  const reject: Step = () => Promise.reject(new Error('synthetic overloaded error'));
  const FB = 'What would you like help with today?';
  it('AT-21: classify gives the unclear fallback with model_unavailable for timeout and model_error', async () => {
    const a = setup([hangStep]);
    const p = a.classify();
    await flush();
    a.clock.advance(30_000);
    const b = setup([reject]);
    for (const d of [await p, await b.classify()]) {
      expect(d).toMatchObject({
        label: 'unclear',
        source: 'fallback',
        fallbackReason: 'model_unavailable',
        clarifyingQuestion: FB,
      });
    }
  });
  it('AT-21: runLeaveAgent escalates as model_unavailable for timeout and model_error', async () => {
    const a = setup([hangStep]);
    const p = a.run();
    await flush();
    a.clock.advance(60_000);
    expect(asRec(await p)).toMatchObject({ kind: 'escalated', reason: 'model_unavailable' });
    expect(asRec(await setup([reject]).run())).toMatchObject({
      kind: 'escalated',
      reason: 'model_unavailable',
    });
  });
  it('AT-21: refusal, max_turns, tool_violation, max_tokens and unexpected_stop_reason stay run_not_completed', async () => {
    const cases: [string, Step[], Step[], boolean][] = [
      ['refusal', [resp('refusal', [text('no')])], [resp('refusal', [])], false],
      [
        'max_turns',
        [turn(tu('t', 'route', { label: 'leave' }))],
        [turn(tu('t', 'get_my_balance', {}))],
        true,
      ],
      [
        'tool_violation',
        [turn(tu('t', 'approve_leave', {}))],
        [turn(tu('t', 'approve_leave', {}))],
        false,
      ],
      ['max_tokens', [resp('max_tokens', [])], [resp('max_tokens', [])], false],
      ['unexpected_stop_reason', [resp('unknown_reason', [])], [resp('unknown_reason', [])], false],
    ];
    for (const [name, orch, leave, repeat] of cases) {
      expect(await setup(orch, { repeat }).classify(), name).toMatchObject({
        source: 'fallback',
        fallbackReason: 'run_not_completed',
      });
      expect(asRec(await setup(leave, { repeat }).run()), name).toMatchObject({
        kind: 'escalated',
        reason: 'run_not_completed',
      });
    }
  });
  it('AT-21: a sink rejecting its first write gives audit_failed from classify and run_not_completed from the Leave Agent', async () => {
    const first = (s: InMemoryAuditSink): AuditSink => {
      let n = 0;
      return {
        write: (e) => ((n += 1) === 1 ? Promise.reject(new Error('sink-down')) : s.write(e)),
      };
    };
    expect(
      await setup([turn(tu('t', 'route', { label: 'leave' })), done('ok')], {
        wrapSink: first,
      }).classify(),
    ).toMatchObject({ outcome: 'error', code: 'audit_failed' });
    expect(asRec(await setup([done('Which dates?')], { wrapSink: first }).run())).toMatchObject({
      kind: 'escalated',
      reason: 'run_not_completed',
    });
  });
});
