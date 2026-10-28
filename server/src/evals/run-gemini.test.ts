// Spec gemini-fallback: AT-4 (eval key check), AT-7 (eval pricing on resolved ids) and the eval part
// of AT-23. Same style as run-setup.test.ts: fake model, temp dirs, fetch throws. Synthetic data.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelClient, ModelRequest } from '../agents/schemas.js';
import { runEvals, type EvalDeps } from './run.js';

const GM = 'gm-CANARY-0001';
const GEMINI = 'gemini-3.5-flash-lite';
const line = (o: unknown): string => JSON.stringify(o);

const THRESHOLDS = `version: 1
agents:
  orchestrator:
    categories: {}
  leave:
    categories: {}
  policy_qa:
    categories: {}
  onboarding:
    categories: {}
`;
const pricingFor = (models: string[]): string =>
  JSON.stringify({
    version: 1,
    asOf: '2026-10-28',
    currency: 'USD',
    models: Object.fromEntries(models.map((m) => [m, { inputPerMTok: 0, outputPerMTok: 0 }])),
  });

const orch = (id: string, tags: string[] = []) => ({
  id,
  category: 'routing',
  actor: { employeeId: 'emp-004', role: 'employee' },
  userText: 'I would like annual leave from 2026-11-16 to 2026-11-18, please.',
  expected: { label: 'leave', injectionFlagged: false },
  tags,
});
const leave = (id: string) => ({
  id,
  category: 'verdict',
  actor: { employeeId: 'emp-004', role: 'employee' },
  userText: 'Annual leave from 2026-11-05 to 2026-11-06 please.',
  expected: { resultKind: 'card' },
  tags: ['instrumented'],
});
const qa = (id: string) => ({
  id,
  category: 'citation',
  actor: { employeeId: 'emp-004', role: 'employee' },
  endpoint: 'chat',
  userText: 'What is the deadline for expense claims?',
  expected: { outcome: 'policy_answer' },
  tags: ['blocked:no-runner'],
  notes: 'synthetic note',
});
const onb = (id: string) => ({
  id,
  category: 'verdict',
  actor: { employeeId: 'emp-001', role: 'hr_admin' },
  endpoint: 'chat',
  userText: 'Create a checklist for a new engineer on team-b starting 2027-01-11.',
  expected: { outcome: 'checklist' },
  tags: ['blocked:no-runner'],
  notes: 'synthetic note',
});

function setup(pricing: string, orchTags: string[] = ['instrumented']) {
  const evalsDir = mkdtempSync(join(tmpdir(), 'evals-gemini-'));
  const files = {
    orchestrator: line(orch('orch-001', orchTags)),
    leave: line(leave('EV-1')),
    policy_qa: line(qa('EV-1')),
    onboarding: line(onb('EV-1')),
  };
  for (const [agent, content] of Object.entries(files)) {
    mkdirSync(join(evalsDir, agent), { recursive: true });
    writeFileSync(join(evalsDir, agent, 'cases.jsonl'), content + '\n');
  }
  writeFileSync(join(evalsDir, 'thresholds.yaml'), THRESHOLDS);
  writeFileSync(join(evalsDir, 'pricing.yaml'), pricing);
  const resultsDir = join(evalsDir, 'results');
  mkdirSync(resultsDir, { recursive: true });
  return { evalsDir, resultsDir };
}

function fakeModel(withResolve: boolean) {
  const calls: ModelRequest[] = [];
  const model: ModelClient = {
    create: (req) => {
      calls.push(req);
      return Promise.resolve({
        content: [{ type: 'text', text: 'Which dates?' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 1000 },
      });
    },
    ...(withResolve
      ? {
          resolveModel: (id: string) =>
            id === 'claude-sonnet-5-5' || id === 'claude-haiku-5-5' ? GEMINI : 'unmapped',
        }
      : {}),
  };
  return { model, calls };
}

function harness(
  s: { evalsDir: string },
  model: ModelClient,
  env: Record<string, string | undefined>,
) {
  const lines: string[] = [];
  const caseEnds: { agent: string; id: string; auditEvents: readonly unknown[] }[] = [];
  const deps: EvalDeps = {
    env,
    evalsDir: s.evalsDir,
    model,
    realClock: {
      nowMs: () => Date.parse('2026-10-28T12:00:00.000Z'),
      nowIso: () => '2026-10-28T12:00:00.000Z',
    },
    scheduler: { setTimeout: () => () => undefined },
    gitCommit: null,
    stdout: (l) => lines.push(l),
    stderr: (l) => lines.push(l),
    onCaseEnd: (c) => caseEnds.push(c),
  };
  return { deps, out: () => lines.join('\n'), caseEnds };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('fetch must not be called in tests');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AT-4: eval key check', () => {
  it('AT-4: a Gemini-only env passes the key check', async () => {
    const s = setup(pricingFor([GEMINI]));
    const { model } = fakeModel(true);
    const h = harness(s, model, { GEMINI_API_KEY: GM });
    const outcome = await runEvals(h.deps);
    expect(outcome.exitCode).not.toBe(2);
    expect(h.out()).not.toContain(GM);
  });

  it('AT-4: an empty Anthropic key and no Gemini key exits 2 naming both, with no results file', async () => {
    const s = setup(pricingFor([GEMINI]));
    const { model, calls } = fakeModel(true);
    const h = harness(s, model, { ANTHROPIC_API_KEY: '' });
    const outcome = await runEvals(h.deps);
    expect(outcome.exitCode).toBe(2);
    expect(h.out()).toContain('ANTHROPIC_API_KEY');
    expect(h.out()).toContain('GEMINI_API_KEY');
    expect(calls).toHaveLength(0);
    expect(readdirSync(s.resultsDir)).toHaveLength(0);
  });
});

describe('AT-7: eval pricing on resolved ids', () => {
  it('AT-7: -- orchestrator on Gemini with only the Gemini entry records the Gemini model at zero cost', async () => {
    const s = setup(pricingFor([GEMINI]), []);
    const { model, calls } = fakeModel(true);
    const h = harness(s, model, { ANTHROPIC_API_KEY: '', GEMINI_API_KEY: GM });
    const outcome = await runEvals(h.deps, 'orchestrator');
    expect(outcome.exitCode).not.toBe(2);
    expect(readdirSync(s.resultsDir)).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.model).toBe(GEMINI);

    const file = readdirSync(s.resultsDir)[0] ?? '';
    const parsed = JSON.parse(readFileSync(join(s.resultsDir, file), 'utf8')) as {
      summary: { model: string };
    };
    expect(parsed.summary.model).toBe(GEMINI);
    expect(JSON.stringify(parsed)).toMatch(/"costUsd":\s*0[,}]/);

    const orchEnd = h.caseEnds.find((c) => c.agent === 'orchestrator');
    const modelCalls = (orchEnd?.auditEvents ?? [])
      .map((e) => (e as { payload?: { kind?: string; model?: string } }).payload)
      .filter((p) => p?.kind === 'model_call');
    expect(modelCalls.length).toBeGreaterThan(0);
    for (const p of modelCalls) expect(p?.model).toBe(GEMINI);
    expect(JSON.stringify(parsed)).not.toContain(GM);
  });

  it('AT-7: the same run with only claude-haiku-5-5 priced exits 2 with zero model calls', async () => {
    const s = setup(pricingFor(['claude-haiku-5-5']), []);
    const { model, calls } = fakeModel(true);
    const h = harness(s, model, { GEMINI_API_KEY: GM });
    const outcome = await runEvals(h.deps, 'orchestrator');
    expect(outcome.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    expect(h.out()).toContain(GEMINI);
    expect(readdirSync(s.resultsDir)).toHaveLength(0);
  });
});
