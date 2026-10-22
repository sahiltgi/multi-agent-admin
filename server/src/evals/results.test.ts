// specs/eval-runner.md AT-19, AT-22 and the exit-code and stdout parts of AT-21 (rules 19, 21, 22).
// Everything runs through runEvals with a scripted fake model, temp dirs and a throwing fetch.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvals, type EvalDeps, type EvalOutcome } from './run.js';
import { EvalRun } from './schemas.js';

// ---------- helpers (all inside this file) ----------

type Rec = Record<string, unknown>;
type AgentName = 'orchestrator' | 'leave' | 'policy_qa' | 'onboarding';

const USAGE = { input_tokens: 120, output_tokens: 30 };
const resp = (stop_reason: string, content: unknown[]): Rec => ({
  content,
  stop_reason,
  usage: USAGE,
});
const route = (label: string): Rec[] => [
  resp('tool_use', [{ type: 'tool_use', id: 'tu-1', name: 'route', input: { label } }]),
  resp('end_turn', [{ type: 'text', text: 'done' }]),
];

function scriptedModel(script: Rec[]) {
  const requests: Rec[] = [];
  let n = 0;
  return {
    requests,
    get calls(): number {
      return n;
    },
    create(req: Rec): Promise<unknown> {
      requests.push(structuredClone(req));
      const step = script[n];
      n += 1;
      if (step === undefined) return Promise.reject(new Error('fake script exhausted'));
      return Promise.resolve(step);
    },
  };
}

const ACTOR = { employeeId: 'emp-004', role: 'employee' };
const FILLER: Record<AgentName, Rec> = {
  orchestrator: {
    id: 'orch-900',
    category: 'routing',
    actor: ACTOR,
    userText: 'Filler line.',
    expected: { label: 'leave', injectionFlagged: false },
    tags: ['chained'],
  },
  leave: {
    id: 'EV-900',
    category: 'routing',
    actor: ACTOR,
    userText: 'Filler line.',
    expected: { resultKind: 'card' },
    tags: ['chained'],
  },
  policy_qa: {
    id: 'EV-900',
    category: 'routing',
    actor: ACTOR,
    endpoint: 'messages',
    userText: 'Filler line.',
    expected: { outcome: 'reply' },
    tags: ['blocked:filler'],
    notes: 'filler',
  },
  onboarding: {
    id: 'EV-900',
    category: 'routing',
    actor: ACTOR,
    endpoint: 'messages',
    userText: 'Filler line.',
    expected: { outcome: 'denied' },
    tags: ['chained'],
    notes: 'filler',
  },
};

const orch = (n: number, label: string, userText = 'I want annual leave in November.'): Rec => ({
  id: `orch-${String(n).padStart(3, '0')}`,
  category: 'routing',
  actor: ACTOR,
  userText,
  expected: { label, injectionFlagged: false },
  tags: [],
});

const dirs: string[] = [];
function makeDir(
  orchestrator: Rec[],
  orchestratorThresholds: Rec = { categories: {} },
  thresholdsOverride?: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'evals-results-'));
  dirs.push(dir);
  const lines: Record<AgentName, Rec[]> = {
    orchestrator: [...orchestrator, FILLER.orchestrator],
    leave: [FILLER.leave],
    policy_qa: [FILLER.policy_qa],
    onboarding: [FILLER.onboarding],
  };
  for (const agent of Object.keys(lines) as AgentName[]) {
    mkdirSync(join(dir, agent), { recursive: true });
    writeFileSync(
      join(dir, agent, 'cases.jsonl'),
      lines[agent].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }
  mkdirSync(join(dir, 'results'), { recursive: true });
  const none = { categories: {} };
  if (thresholdsOverride !== undefined) {
    writeFileSync(join(dir, 'thresholds.yaml'), thresholdsOverride);
  } else {
    writeFileSync(
      join(dir, 'thresholds.yaml'),
      JSON.stringify({
        version: 1,
        agents: {
          orchestrator: orchestratorThresholds,
          leave: none,
          policy_qa: none,
          onboarding: none,
        },
      }),
    );
  }
  return dir;
}

interface Ran {
  outcome: EvalOutcome;
  model: ReturnType<typeof scriptedModel>;
  out: string[];
  err: string[];
  dir: string;
}
async function runWith(dir: string, script: Rec[], over: Partial<EvalDeps> = {}): Promise<Ran> {
  const model = scriptedModel(script);
  const out: string[] = [];
  const err: string[] = [];
  const outcome = await runEvals({
    env: { ANTHROPIC_API_KEY: 'TEST-key-0001' },
    evalsDir: dir,
    model: model,
    realClock: { nowMs: () => 0, nowIso: () => '2026-10-22T10:00:00.000Z' },
    scheduler: { setTimeout: () => () => undefined },
    gitCommit: null,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...over,
  });
  return { outcome, model, out, err, dir };
}

const resultFiles = (dir: string): string[] => readdirSync(join(dir, 'results')).sort();

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // AT-22: the key is unset and fetch throws; neither may matter to any test here.
  delete process.env.ANTHROPIC_API_KEY;
  fetchMock = vi.fn(() => {
    throw new Error('network');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------- AT-19 (rule 19) ----------

describe('eval-runner AT-19: results file', () => {
  const LATE = '2026-10-22T23:59:00.000Z';
  const late: Partial<EvalDeps> = { realClock: { nowMs: () => 0, nowIso: () => LATE } };

  it('AT-19: a run started at 2026-10-22T23:59:00Z writes results/2026-10-22.json that parses as EvalRun', async () => {
    const dir = makeDir([orch(1, 'leave')]);
    const r = await runWith(dir, route('leave'), late);
    expect(r.outcome.resultsPath).toBe(join(dir, 'results', '2026-10-22.json'));
    expect(resultFiles(dir)).toEqual(['2026-10-22.json']);
    const parsed = EvalRun.parse(
      JSON.parse(readFileSync(join(dir, 'results', '2026-10-22.json'), 'utf8')),
    );
    expect(parsed.agents).toHaveLength(4);
    expect(parsed.cases.some((c) => c.agent === 'orchestrator' && c.id === 'orch-001')).toBe(true);
  });

  it('AT-19: an existing file is never overwritten; the new one is <date>-2.json', async () => {
    const dir = makeDir([orch(1, 'leave')]);
    const first = join(dir, 'results', '2026-10-22.json');
    writeFileSync(first, 'SENTINEL-BYTES\n');
    const r = await runWith(dir, route('leave'), late);
    expect(r.outcome.resultsPath).toBe(join(dir, 'results', '2026-10-22-2.json'));
    expect(resultFiles(dir)).toEqual(['2026-10-22-2.json', '2026-10-22.json']);
    expect(readFileSync(first, 'utf8')).toBe('SENTINEL-BYTES\n');
    EvalRun.parse(JSON.parse(readFileSync(join(dir, 'results', '2026-10-22-2.json'), 'utf8')));
  });

  it('AT-19: the results file and stdout hold no case text, email or name', async () => {
    const dir = makeDir([orch(1, 'leave', 'Contact sam.roe@hr.test about it')]);
    const r = await runWith(dir, route('leave'), late);
    const file = readFileSync(must(r.outcome.resultsPath), 'utf8');
    expect(file).not.toContain('sam.roe');
    expect(file).not.toContain('hr.test');
    expect(file).not.toContain('Contact');
    expect([...r.out, ...r.err].join('\n')).not.toContain('sam.roe');
  });

  it('AT-19: an exit-2 run leaves the results directory unchanged', async () => {
    const dir = makeDir([orch(1, 'leave')]);
    writeFileSync(join(dir, 'results', '2026-10-21.json'), 'OLD\n');
    const before = resultFiles(dir);
    rmSync(join(dir, 'thresholds.yaml'));
    const r = await runWith(dir, route('leave'), late);
    expect(r.outcome.exitCode).toBe(2);
    expect(r.outcome.run).toBeNull();
    expect(r.outcome.resultsPath).toBeNull();
    expect(r.model.calls).toBe(0);
    expect(resultFiles(dir)).toEqual(before);
  });

  it('AT-19: the model, prompt version and thresholds hash are recorded per run', async () => {
    const dir = makeDir([orch(1, 'leave')]);
    const r = await runWith(dir, route('leave'), late);
    const run = must(r.outcome.run);
    for (const a of run.agents) {
      expect(a.model.length).toBeGreaterThan(0);
      expect(a.promptVersion.length).toBeGreaterThan(0);
    }
    expect(run.thresholdsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dir, 'results', '2026-10-22.json'))).toBe(true);
  });
});

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected a value');
  return v;
}

// ---------- AT-21 (rule 21): exit code and stdout ----------

describe('eval-runner AT-21: exit code and stdout', () => {
  // Five orchestrator cases, three labelled as the fake routes them: pass rate 3/5 = 0.6.
  const FIVE = [
    orch(1, 'leave'),
    orch(2, 'leave'),
    orch(3, 'leave'),
    orch(4, 'policy_qa', 'USERTEXT-CANARY-ONE'),
    orch(5, 'policy_qa', 'USERTEXT-CANARY-TWO'),
  ];
  const fiveScript = (): Rec[] => FIVE.flatMap(() => route('leave'));

  it('AT-21: a pass rate exactly equal to the threshold meets it and exits 0', async () => {
    const dir = makeDir(FIVE, { overall: 0.6, categories: {} });
    const r = await runWith(dir, fiveScript());
    const o = must(r.outcome.run).agents.find((a) => a.agent === 'orchestrator');
    expect(o?.overall.passRate).toBeCloseTo(0.6, 10);
    expect(o?.overall.meetsThreshold).toBe(true);
    expect(r.outcome.exitCode).toBe(0);
  });

  it('AT-21: a pass rate below the threshold exits 1 and the results file still exists', async () => {
    const dir = makeDir(FIVE, { overall: 0.61, categories: {} });
    const r = await runWith(dir, fiveScript());
    expect(r.outcome.exitCode).toBe(1);
    expect(must(r.outcome.run).thresholdsMet).toBe(false);
    expect(existsSync(must(r.outcome.resultsPath))).toBe(true);
    expect(resultFiles(dir)).toHaveLength(1);
  });

  it('AT-21: a category with a threshold and a null passRate has meetsThreshold false and exits 1', async () => {
    const dir = makeDir(FIVE, { overall: 0.5, categories: { injection: 1 } });
    const r = await runWith(dir, fiveScript());
    const bucket = must(r.outcome.run).agents.find((a) => a.agent === 'orchestrator')?.categories
      .injection;
    expect(bucket?.passRate).toBeNull();
    expect(bucket?.meetsThreshold).toBe(false);
    expect(r.outcome.exitCode).toBe(1);
  });

  it('AT-21: stdout holds the results path and each failed (agent, id), and no userText', async () => {
    const dir = makeDir(FIVE, { overall: 0.5, categories: {} });
    const r = await runWith(dir, fiveScript());
    const stdout = r.out.join('\n');
    expect(stdout).toContain(must(r.outcome.resultsPath));
    expect(stdout).toContain('orch-004');
    expect(stdout).toContain('orch-005');
    expect(stdout).not.toContain('USERTEXT-CANARY');
    expect(stdout).not.toContain('I want annual leave');
    expect(stdout).toMatch(/orchestrator/);
  });
});

// ---------- AT-22 (rule 22) ----------

describe('eval-runner AT-22: tests never call the model', () => {
  it('AT-22: two runs with the same inputs are deep-equal apart from times and latency', async () => {
    const cases = [orch(1, 'leave'), orch(2, 'policy_qa')];
    const script = (): Rec[] => cases.flatMap(() => route('leave'));
    const a = await runWith(makeDir(cases, { overall: 0.4, categories: {} }), script());
    const b = await runWith(makeDir(cases, { overall: 0.4, categories: {} }), script());
    const strip = (run: EvalRun): unknown => ({
      ...run,
      startedAt: null,
      finishedAt: null,
      cases: run.cases.map((c) => ({ ...c, latencyMs: null })),
    });
    expect(strip(must(a.outcome.run))).toEqual(strip(must(b.outcome.run)));
    expect(a.outcome.exitCode).toBe(b.outcome.exitCode);
  });

  it('AT-22: with ANTHROPIC_API_KEY unset in the process, a run with an injected env never calls fetch', async () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    const dir = makeDir([orch(1, 'leave')]);
    const r = await runWith(dir, route('leave'));
    expect(r.outcome.exitCode === 0 || r.outcome.exitCode === 1).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
