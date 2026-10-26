// specs/eval-runner.md AT-28 (rule 24; D-20, D-21): tokens and cost per case and per agent.
// The pure part tests priceEvents(events, pricing) from the new module ./cost.js; the runner part
// runs a leave case through runEvals with a scripted fake model and a temp pricing.yaml.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import { priceEvents } from '../lib/cost.js';
import { loadBootFiles } from '../server/boot.js';
import { runEvals, type EvalOutcome } from './run.js';
import { Pricing } from './schemas.js';

// Pass-through spy: the real priceEvents runs unless a test makes it throw once.
vi.mock('../lib/cost.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cost.js')>();
  return { ...actual, priceEvents: vi.fn(actual.priceEvents) };
});

// spec agent-metrics AT-4: observe the pricing path the runner hands to loadBootFiles.
vi.mock('../server/boot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/boot.js')>();
  return { ...actual, loadBootFiles: vi.fn(actual.loadBootFiles) };
});

type Rec = Record<string, unknown>;
const AGENTS = ['orchestrator', 'leave', 'policy_qa', 'onboarding'] as const;

// ---------- pure: priceEvents ----------

const modelCall = (model: string, tokens: { input: number; output: number } | null): Rec => ({
  eventType: 'agent_step',
  payload: { kind: 'model_call', model, tokens },
});

const PRICES = Pricing.parse({
  version: 1,
  asOf: '2026-10-22',
  currency: 'USD',
  models: {
    [ORCHESTRATOR_CONFIG.model]: { inputPerMTok: 1, outputPerMTok: 5 },
    [POLICY_QA_CONFIG.model]: { inputPerMTok: 3, outputPerMTok: 15 },
  },
});

describe('eval-runner AT-28: priceEvents (pure)', () => {
  it('AT-28: model_call events sum into tokens and cost (150/30 at 3/15 is 0.0009)', () => {
    const pricing = Pricing.parse({
      version: 1,
      asOf: '2026-10-22',
      currency: 'USD',
      models: { [LEAVE_CONFIG.model]: { inputPerMTok: 3, outputPerMTok: 15 } },
    });
    const r = priceEvents(
      [
        modelCall(LEAVE_CONFIG.model, { input: 100, output: 20 }),
        modelCall(LEAVE_CONFIG.model, { input: 50, output: 10 }),
      ],
      pricing,
    );
    expect(r.tokens).toEqual({ input: 150, output: 30 });
    expect(Math.abs(r.costUsd - 0.0009)).toBeLessThan(1e-12);
  });

  it('AT-28: each event is priced at its own model, so orchestrator and policy_qa events price differently (D-21)', () => {
    const r = priceEvents(
      [
        modelCall(ORCHESTRATOR_CONFIG.model, { input: 100, output: 10 }),
        modelCall(POLICY_QA_CONFIG.model, { input: 200, output: 20 }),
      ],
      PRICES,
    );
    expect(r.tokens).toEqual({ input: 300, output: 30 });
    expect(Math.abs(r.costUsd - (100 * 1 + 10 * 5 + 200 * 3 + 20 * 15) / 1e6)).toBeLessThan(1e-12);
    expect(Math.abs(r.costUsd - 0.00105)).toBeLessThan(1e-12);
  });

  it('AT-28: an event with null tokens, and events that are not model calls, add 0', () => {
    const r = priceEvents(
      [
        modelCall(POLICY_QA_CONFIG.model, null),
        modelCall(POLICY_QA_CONFIG.model, { input: 10, output: 2 }),
        { eventType: 'agent_step', payload: { kind: 'tool_call', tool: 'x', tokens: null } },
        { eventType: 'gate_result', payload: {} },
      ],
      PRICES,
    );
    expect(r.tokens).toEqual({ input: 10, output: 2 });
  });

  it('AT-28: the Q&A agent qa_model_call events count too, priced at their own model', () => {
    const r = priceEvents(
      [
        modelCall(ORCHESTRATOR_CONFIG.model, { input: 100, output: 10 }),
        {
          eventType: 'agent_step',
          payload: {
            kind: 'qa_model_call',
            model: POLICY_QA_CONFIG.model,
            tokens: { input: 200, output: 20, cacheRead: null, cacheCreation: null },
          },
        },
      ],
      PRICES,
    );
    expect(r.tokens).toEqual({ input: 300, output: 30 });
    expect(Math.abs(r.costUsd - 0.00105)).toBeLessThan(1e-12);
  });

  it('AT-28: no events give 0/0 tokens and cost 0', () => {
    expect(priceEvents([], PRICES)).toEqual({ tokens: { input: 0, output: 0 }, costUsd: 0 });
  });

  it('AT-28: a model_call whose model has no pricing entry throws, never priced at 0', () => {
    expect(() =>
      priceEvents([modelCall('claude-unpriced-0', { input: 1, output: 1 })], PRICES),
    ).toThrow();
  });

  it('AT-28: a price of 0 gives cost 0 with the tokens still counted', () => {
    const zero = Pricing.parse({
      version: 1,
      asOf: '2026-10-22',
      currency: 'USD',
      models: { [LEAVE_CONFIG.model]: { inputPerMTok: 0, outputPerMTok: 0 } },
    });
    const r = priceEvents([modelCall(LEAVE_CONFIG.model, { input: 5, output: 5 })], zero);
    expect(r).toEqual({ tokens: { input: 5, output: 5 }, costUsd: 0 });
  });
});

// ---------- runner ----------

const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
const submitTurn = (u: ReturnType<typeof usage>): Rec => ({
  content: [
    {
      type: 'tool_use',
      id: 'tu-1',
      name: 'submit_to_gate',
      input: { leaveType: 'annual', startDate: '2026-11-05', endDate: '2026-11-06' },
    },
  ],
  stop_reason: 'tool_use',
  usage: u,
});
const finalTurn = (u: ReturnType<typeof usage>): Rec => ({
  content: [{ type: 'text', text: 'I have submitted your request for review.' }],
  stop_reason: 'end_turn',
  usage: u,
});

const ACTOR = { employeeId: 'emp-004', role: 'employee' };
const leaveCase = (id: string, over: Rec = {}): Rec => ({
  id,
  category: 'verdict',
  actor: ACTOR,
  asOf: '2026-11-02',
  userText: 'Annual leave from 2026-11-05 to 2026-11-06 please.',
  expected: { resultKind: 'card' },
  tags: [],
  ...over,
});
const FILLERS: Record<string, Rec> = {
  orchestrator: {
    id: 'orch-900',
    category: 'routing',
    actor: ACTOR,
    userText: 'Filler.',
    expected: { label: 'leave', injectionFlagged: false },
    tags: ['chained'],
  },
  policy_qa: {
    id: 'EV-900',
    category: 'citation',
    actor: ACTOR,
    endpoint: 'chat',
    userText: 'Filler.',
    expected: { outcome: 'policy_answer' },
    tags: ['blocked:filler'],
    notes: 'n',
  },
  onboarding: {
    id: 'EV-900',
    category: 'verdict',
    actor: { employeeId: 'emp-001', role: 'hr_admin' },
    endpoint: 'chat',
    userText: 'Filler.',
    expected: { outcome: 'checklist' },
    tags: ['chained'],
    notes: 'n',
  },
};

let dir: string;
let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evals-cost-'));
  fetchStub = vi.fn(() => {
    throw new Error('fetch must not be called');
  });
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function writeDir(
  leave: Rec[],
  leaveThreshold: Rec = { categories: {} },
  policyQa: Rec[] = [FILLERS.policy_qa ?? {}],
): void {
  const files: Record<(typeof AGENTS)[number], Rec[]> = {
    orchestrator: [FILLERS.orchestrator ?? {}],
    leave,
    policy_qa: policyQa,
    onboarding: [FILLERS.onboarding ?? {}],
  };
  for (const agent of AGENTS) {
    mkdirSync(join(dir, agent), { recursive: true });
    writeFileSync(
      join(dir, agent, 'cases.jsonl'),
      files[agent].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }
  mkdirSync(join(dir, 'results'), { recursive: true });
  const none = { categories: {} };
  writeFileSync(
    join(dir, 'thresholds.yaml'),
    JSON.stringify({
      version: 1,
      agents: { orchestrator: none, leave: leaveThreshold, policy_qa: none, onboarding: none },
    }),
  );
  const models: Record<string, Rec> = {};
  for (const m of [ORCHESTRATOR_CONFIG.model, POLICY_QA_CONFIG.model, ONBOARDING_CONFIG.model]) {
    models[m] = { inputPerMTok: 1, outputPerMTok: 5 };
  }
  models[LEAVE_CONFIG.model] = { inputPerMTok: 3, outputPerMTok: 15 };
  writeFileSync(
    join(dir, 'pricing.yaml'),
    JSON.stringify({ version: 1, asOf: '2026-10-22', currency: 'USD', models }),
  );
}

async function run(script: (Rec | (() => Promise<unknown>))[]): Promise<EvalOutcome> {
  let n = 0;
  return await runEvals({
    env: { ANTHROPIC_API_KEY: 'TEST-key-0001' },
    evalsDir: dir,
    model: {
      create: () => {
        const step = script[n];
        n += 1;
        if (step === undefined) return Promise.reject(new Error('fake script exhausted'));
        return typeof step === 'function' ? step() : Promise.resolve(step);
      },
    },
    realClock: { nowMs: () => 0, nowIso: () => '2026-10-22T10:00:00.000Z' },
    scheduler: { setTimeout: () => () => undefined },
    gitCommit: null,
    stdout: () => undefined,
    stderr: () => undefined,
  });
}

const leaveRun = (o: EvalOutcome) => {
  const r = o.runs.find((x) => x.agent === 'leave');
  if (r === undefined) throw new Error('no leave run');
  return r;
};

describe('eval-runner AT-28: tokens and cost in a run', () => {
  it('AT-28: a leave case with usage 100/20 then 50/10 has tokens 150/30 and costUsd 0.0009 at 3/15', async () => {
    writeDir([leaveCase('EV-1')]);
    const outcome = await run([submitTurn(usage(100, 20)), finalTurn(usage(50, 10))]);
    const c = leaveRun(outcome).cases.find((x) => x.id === 'EV-1');
    expect(c?.status).toBe('passed');
    expect(c?.tokens).toEqual({ input: 150, output: 30 });
    expect(Math.abs((c?.costUsd ?? 1) - 0.0009)).toBeLessThan(1e-12);
  });

  it('AT-28: skipped and actor_mismatch cases have tokens 0/0 and costUsd 0', async () => {
    writeDir([
      leaveCase('EV-1'),
      leaveCase('EV-2', { tags: ['instrumented'] }),
      leaveCase('EV-3', { actor: { employeeId: 'emp-004', role: 'hr_admin' } }),
    ]);
    const outcome = await run([submitTurn(usage(100, 20)), finalTurn(usage(50, 10))]);
    const cases = leaveRun(outcome).cases;
    for (const id of ['EV-2', 'EV-3']) {
      const c = cases.find((x) => x.id === id);
      expect(c?.tokens, id).toEqual({ input: 0, output: 0 });
      expect(c?.costUsd, id).toBe(0);
    }
    expect(cases.find((x) => x.id === 'EV-3')?.errorCode).toBe('actor_mismatch');
  });

  it('AT-28: the leave summary tokens and costUsd equal the sums over its cases, skipped ones included', async () => {
    writeDir([
      leaveCase('EV-1'),
      leaveCase('EV-2', { reviewed: false }),
      leaveCase('EV-3', { tags: ['instrumented'] }),
    ]);
    const outcome = await run([
      submitTurn(usage(100, 20)),
      finalTurn(usage(50, 10)),
      submitTurn(usage(7, 3)),
      finalTurn(usage(5, 1)),
    ]);
    const leave = leaveRun(outcome);
    const sum = leave.cases.reduce(
      (a, c) => ({ i: a.i + c.tokens.input, o: a.o + c.tokens.output, cost: a.cost + c.costUsd }),
      { i: 0, o: 0, cost: 0 },
    );
    expect(sum.i).toBe(162);
    expect(sum.o).toBe(34);
    expect(leave.summary.tokens).toEqual({ input: sum.i, output: sum.o });
    expect(Math.abs(leave.summary.costUsd - sum.cost)).toBeLessThan(1e-12);
  });

  it('AT-28: a model_unavailable case whose first turn succeeded still counts that turn tokens', async () => {
    writeDir([leaveCase('EV-1')]);
    const overloaded = Object.assign(new Error('overloaded'), { status: 529 });
    const outcome = await run([submitTurn(usage(100, 20)), () => Promise.reject(overloaded)]);
    const c = leaveRun(outcome).cases.find((x) => x.id === 'EV-1');
    expect(c?.status).toBe('error');
    expect(c?.errorCode).toBe('model_unavailable');
    expect(c?.tokens).toEqual({ input: 100, output: 20 });
  });

  it('AT-28: a model_call whose model has no pricing entry makes that case error / run_failed, never passed', async () => {
    writeDir([leaveCase('EV-1'), leaveCase('EV-2')]);
    vi.mocked(priceEvents).mockImplementationOnce(() => {
      throw new Error('no pricing entry');
    });
    const outcome = await run([
      submitTurn(usage(1, 1)),
      finalTurn(usage(1, 1)),
      submitTurn(usage(1, 1)),
      finalTurn(usage(1, 1)),
    ]);
    const cases = leaveRun(outcome).cases;
    const first = cases.find((x) => x.id === 'EV-1');
    expect(first?.status).toBe('error');
    expect(first?.errorCode).toBe('run_failed');
    expect(first?.status).not.toBe('passed');
    expect(cases.find((x) => x.id === 'EV-2')?.status).toBe('passed');
  });

  it('AT-28: a very large cost never changes thresholdsMet or the exit code', async () => {
    writeDir([leaveCase('EV-1')], { overall: 1, categories: {} });
    const outcome = await run([
      submitTurn(usage(1_000_000_000, 1_000_000_000)),
      finalTurn(usage(1_000_000_000, 1_000_000_000)),
    ]);
    const leave = leaveRun(outcome);
    expect(leave.summary.costUsd).toBeGreaterThan(1000);
    expect(leave.thresholdsMet).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });
});

// ---------- spec agent-metrics AT-3, AT-4 ----------

const routeTurn = (label: string, u: ReturnType<typeof usage>): Rec => ({
  content: [{ type: 'tool_use', id: 'tu-r', name: 'route', input: { label } }],
  stop_reason: 'tool_use',
  usage: u,
});
const doneTurn = (u: ReturnType<typeof usage>): Rec => ({
  content: [{ type: 'text', text: 'routed' }],
  stop_reason: 'end_turn',
  usage: u,
});

describe('agent-metrics AT-3, AT-4: the runner and the per-request usage', () => {
  it('AT-4: the runner passes join(evalsDir, pricing.yaml) to loadBootFiles as pricingPath', async () => {
    writeDir([leaveCase('EV-1', { tags: ['instrumented'] })]);
    vi.mocked(loadBootFiles).mockClear();
    await run([]);
    expect(vi.mocked(loadBootFiles)).toHaveBeenCalledTimes(1);
    const paths = vi.mocked(loadBootFiles).mock.calls[0]?.[1];
    expect(paths?.pricingPath).toBe(join(dir, 'pricing.yaml'));
  });

  it('AT-3: a policy_qa case driven through the app counts its model calls once, not the summary usage', async () => {
    // The orchestrator routes the case out of scope: two orchestrator calls (40/4, then 10/1), and
    // the app's chat_turn summary event carries usage 50/5 for the same trace.
    writeDir([leaveCase('EV-1', { tags: ['instrumented'] })], { categories: {} }, [
      {
        id: 'EV-901',
        category: 'citation',
        actor: ACTOR,
        endpoint: 'chat',
        userText: 'How many days of annual leave do I get?',
        expected: { outcome: 'policy_answer' },
        tags: [],
        notes: 'n',
      },
    ]);
    const outcome = await run([routeTurn('out_of_scope', usage(40, 4)), doneTurn(usage(10, 1))]);
    const qa = outcome.runs.find((x) => x.agent === 'policy_qa');
    const c = qa?.cases.find((x) => x.id === 'EV-901');
    expect(c?.tokens).toEqual({ input: 50, output: 5 });
    // orchestrator priced at 1 / 5 per MTok in writeDir
    expect(Math.abs((c?.costUsd ?? 1) - (50 * 1 + 5 * 5) / 1e6)).toBeLessThan(1e-12);
  });
});
