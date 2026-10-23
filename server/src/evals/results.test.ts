// specs/eval-runner.md AT-19, AT-22 and the exit-code and stdout parts of AT-21 (rules 19, 21, 22;
// D-18, D-22, D-24). Everything runs through runEvals with a scripted fake model, temp dirs and a
// throwing fetch.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import { runEvals, type EvalDeps, type EvalOutcome } from './run.js';
import { EvalRun } from './schemas.js';

// ---------- helpers (all inside this file) ----------

type Rec = Record<string, unknown>;
type AgentName = 'orchestrator' | 'leave' | 'policy_qa' | 'onboarding';
const AGENT_LIST: readonly AgentName[] = ['orchestrator', 'leave', 'policy_qa', 'onboarding'];
const VERSION: Record<AgentName, string> = {
  orchestrator: ORCHESTRATOR_CONFIG.promptVersion,
  leave: LEAVE_CONFIG.promptVersion,
  policy_qa: POLICY_QA_CONFIG.promptVersion,
  onboarding: ONBOARDING_CONFIG.promptVersion,
};
const fileName = (date: string, agent: AgentName, suffix = ''): string =>
  `${date}-${agent}-${VERSION[agent]}${suffix}.json`;

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
const QUESTION: Rec = resp('end_turn', [{ type: 'text', text: 'Which dates would you like?' }]);

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
// The fake asks a question, so a leave case expecting a card fails and one expecting
// needs_details passes.
const leaveCase = (id: string, expected: Rec, userText = 'Annual leave please.'): Rec => ({
  id,
  category: 'verdict',
  actor: ACTOR,
  userText,
  expected,
  tags: [],
});

const PRICING = JSON.stringify({
  version: 1,
  asOf: '2026-10-22',
  currency: 'USD',
  models: Object.fromEntries(
    [
      ...new Set([
        ORCHESTRATOR_CONFIG.model,
        LEAVE_CONFIG.model,
        POLICY_QA_CONFIG.model,
        ONBOARDING_CONFIG.model,
      ]),
    ].map((m) => [m, { inputPerMTok: 3, outputPerMTok: 15 }]),
  ),
});

const dirs: string[] = [];
interface MakeDir {
  orchestrator?: Rec[];
  leave?: Rec[];
  thresholds?: Partial<Record<AgentName, Rec>>;
  thresholdsOverride?: string;
}
function makeDir(o: MakeDir = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'evals-results-'));
  dirs.push(dir);
  const lines: Record<AgentName, Rec[]> = {
    orchestrator: [...(o.orchestrator ?? []), FILLER.orchestrator],
    leave: [...(o.leave ?? []), FILLER.leave],
    policy_qa: [FILLER.policy_qa],
    onboarding: [FILLER.onboarding],
  };
  for (const agent of AGENT_LIST) {
    mkdirSync(join(dir, agent), { recursive: true });
    writeFileSync(
      join(dir, agent, 'cases.jsonl'),
      lines[agent].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }
  mkdirSync(join(dir, 'results'), { recursive: true });
  writeFileSync(join(dir, 'pricing.yaml'), PRICING);
  const none = { categories: {} };
  writeFileSync(
    join(dir, 'thresholds.yaml'),
    o.thresholdsOverride ??
      JSON.stringify({
        version: 1,
        agents: Object.fromEntries(AGENT_LIST.map((a) => [a, o.thresholds?.[a] ?? none])),
      }),
  );
  return dir;
}

interface Ran {
  outcome: EvalOutcome;
  model: ReturnType<typeof scriptedModel>;
  out: string[];
  err: string[];
  dir: string;
}
async function runWith(
  dir: string,
  script: Rec[],
  over: Partial<EvalDeps> = {},
  agent?: AgentName,
): Promise<Ran> {
  const model = scriptedModel(script);
  const out: string[] = [];
  const err: string[] = [];
  const outcome = await runEvals(
    {
      env: { ANTHROPIC_API_KEY: 'TEST-key-0001' },
      evalsDir: dir,
      model: model,
      realClock: { nowMs: () => 0, nowIso: () => '2026-10-22T10:00:00.000Z' },
      scheduler: { setTimeout: () => () => undefined },
      gitCommit: null,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      ...over,
    },
    agent,
  );
  return { outcome, model, out, err, dir };
}

const resultFiles = (dir: string): string[] => readdirSync(join(dir, 'results')).sort();
const readRun = (dir: string, name: string): EvalRun =>
  EvalRun.parse(JSON.parse(readFileSync(join(dir, 'results', name), 'utf8')));
const runOf = (o: EvalOutcome, agent: AgentName): EvalRun => {
  const r = o.runs.find((x) => x.agent === agent);
  if (r === undefined) throw new Error(`no run for ${agent}`);
  return r;
};

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected a value');
  return v;
}

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

// ---------- AT-19 (rule 19; D-18, D-24) ----------

describe('eval-runner AT-19: results files', () => {
  const LATE = '2026-10-22T23:59:00.000Z';
  const late: Partial<EvalDeps> = { realClock: { nowMs: () => 0, nowIso: () => LATE } };

  it('AT-19: a leave run started at 2026-10-22T23:59:00Z writes <date>-leave-<promptVersion>.json that parses as EvalRun v2', async () => {
    const dir = makeDir({ leave: [leaveCase('EV-1', { resultKind: 'needs_details' })] });
    const r = await runWith(dir, [QUESTION], late, 'leave');
    const name = fileName('2026-10-22', 'leave');
    expect(name).toMatch(/^2026-10-22-leave-v\d+\.json$/);
    expect(r.outcome.resultsPaths).toEqual([join(dir, 'results', name)]);
    expect(resultFiles(dir)).toEqual([name]);
    const parsed = readRun(dir, name);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.agent).toBe('leave');
    expect(parsed.summary.agent).toBe('leave');
    expect(parsed.cases.every((c) => c.agent === 'leave')).toBe(true);
    expect(parsed.cases.some((c) => c.id === 'EV-1')).toBe(true);
  });

  it('AT-19: an existing file is never overwritten; the new one gets a -2 suffix and the first is byte-identical', async () => {
    const dir = makeDir({ leave: [leaveCase('EV-1', { resultKind: 'needs_details' })] });
    const first = join(dir, 'results', fileName('2026-10-22', 'leave'));
    writeFileSync(first, 'SENTINEL-BYTES\n');
    const r = await runWith(dir, [QUESTION], late, 'leave');
    const second = fileName('2026-10-22', 'leave', '-2');
    expect(r.outcome.resultsPaths).toEqual([join(dir, 'results', second)]);
    expect(resultFiles(dir)).toEqual([second, fileName('2026-10-22', 'leave')].sort());
    expect(readFileSync(first, 'utf8')).toBe('SENTINEL-BYTES\n');
    readRun(dir, second);
  });

  it('AT-19: a full run writes exactly four files, one per agent, each holding only its own cases', async () => {
    const dir = makeDir({
      orchestrator: [orch(1, 'leave')],
      leave: [leaveCase('EV-1', { resultKind: 'needs_details' })],
    });
    const r = await runWith(dir, [...route('leave'), QUESTION], late);
    expect(resultFiles(dir)).toEqual(AGENT_LIST.map((a) => fileName('2026-10-22', a)).sort());
    expect(r.outcome.resultsPaths).toHaveLength(4);
    for (const agent of AGENT_LIST) {
      const parsed = readRun(dir, fileName('2026-10-22', agent));
      expect(parsed.agent).toBe(agent);
      expect(parsed.summary.agent).toBe(agent);
      expect(parsed.cases.length).toBeGreaterThan(0);
      expect(parsed.cases.every((c) => c.agent === agent)).toBe(true);
      expect(parsed.summary.model).toBe(
        {
          orchestrator: ORCHESTRATOR_CONFIG,
          leave: LEAVE_CONFIG,
          policy_qa: POLICY_QA_CONFIG,
          onboarding: ONBOARDING_CONFIG,
        }[agent].model,
      );
      expect(parsed.summary.promptVersion).toBe(VERSION[agent]);
    }
    const starts = new Set(
      AGENT_LIST.map((a) => readRun(dir, fileName('2026-10-22', a)).startedAt),
    );
    expect(starts.size).toBe(1);
  });

  it('AT-19: the date in every file name is the UTC start date, even when the run ends the next day', async () => {
    const dir = makeDir();
    let tick = 0;
    const times = ['2026-12-31T23:59:30.000Z', '2027-01-01T00:00:10.000Z'];
    const realClock = {
      nowMs: () => 0,
      nowIso: () => times[Math.min(tick++, times.length - 1)] ?? '',
    };
    await runWith(dir, [], { realClock });
    expect(resultFiles(dir)).toEqual(AGENT_LIST.map((a) => fileName('2026-12-31', a)).sort());
  });

  it('AT-19: -2 suffixes are chosen separately for each file', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'results', fileName('2026-10-22', 'leave')), 'OLD\n');
    await runWith(dir, [], late);
    expect(resultFiles(dir)).toEqual(
      [
        fileName('2026-10-22', 'orchestrator'),
        fileName('2026-10-22', 'leave'),
        fileName('2026-10-22', 'leave', '-2'),
        fileName('2026-10-22', 'policy_qa'),
        fileName('2026-10-22', 'onboarding'),
      ].sort(),
    );
  });

  it('AT-19: a -- leave run after a full run on the same date writes only <date>-leave-<v>-2.json', async () => {
    const dir = makeDir();
    await runWith(dir, [], late);
    const before = resultFiles(dir);
    expect(before).toHaveLength(4);
    await runWith(dir, [], late, 'leave');
    expect(resultFiles(dir)).toEqual([...before, fileName('2026-10-22', 'leave', '-2')].sort());
  });

  it('AT-19: no results file or stdout holds case text, an email or a name', async () => {
    const dir = makeDir({ orchestrator: [orch(1, 'leave', 'Contact sam.roe@hr.test about it')] });
    const r = await runWith(dir, route('leave'), late);
    for (const f of resultFiles(dir)) {
      const file = readFileSync(join(dir, 'results', f), 'utf8');
      expect(file, f).not.toContain('sam.roe');
      expect(file, f).not.toContain('hr.test');
      expect(file, f).not.toContain('Contact');
    }
    expect([...r.out, ...r.err].join('\n')).not.toContain('sam.roe');
  });

  it('AT-19: an exit-2 run leaves the results directory unchanged', async () => {
    const dir = makeDir({ orchestrator: [orch(1, 'leave')] });
    writeFileSync(join(dir, 'results', '2026-10-21.json'), 'OLD\n');
    const before = resultFiles(dir);
    rmSync(join(dir, 'thresholds.yaml'));
    const r = await runWith(dir, route('leave'), late);
    expect(r.outcome.exitCode).toBe(2);
    expect(r.outcome.runs).toEqual([]);
    expect(r.outcome.resultsPaths).toEqual([]);
    expect(r.model.calls).toBe(0);
    expect(resultFiles(dir)).toEqual(before);
  });

  it('AT-19: the model, prompt version, thresholds hash and pricing hash are recorded per file', async () => {
    const dir = makeDir({ orchestrator: [orch(1, 'leave')] });
    const r = await runWith(dir, route('leave'), late);
    expect(r.outcome.runs).toHaveLength(4);
    for (const run of r.outcome.runs) {
      expect(run.summary.model.length).toBeGreaterThan(0);
      expect(run.summary.promptVersion).toBe(VERSION[run.agent]);
      expect(run.thresholdsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(run.pricingHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('AT-19: when the write of the second file fails, the first is kept, its path is printed, no failure text is shown and the run exits 2 (D-24)', async () => {
    const dir = makeDir({ orchestrator: [orch(1, 'leave')] });
    const written = new Map<string, string>();
    let calls = 0;
    // Seam: EvalDeps.writeFile creates one results file exclusively (flag wx semantics).
    const writeFile = (path: PathLike, text: string): void => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('DISK-FAILURE-CANARY'), { code: 'EIO' });
      }
      writeFileSync(path, text, { flag: 'wx' });
      written.set(String(path), text);
    };
    const r = await runWith(dir, route('leave'), { writeFile });

    const firstName = fileName('2026-10-22', 'orchestrator');
    expect(r.outcome.exitCode).toBe(2);
    expect(resultFiles(dir)).toEqual([firstName]);
    const firstPath = join(dir, 'results', firstName);
    expect(readFileSync(firstPath, 'utf8')).toBe(written.get(firstPath));
    expect(r.out.join('\n')).toContain(firstPath);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).not.toContain('DISK-FAILURE-CANARY');
    expect(r.err.length).toBeGreaterThan(0);
  });
});

// ---------- AT-21 (rule 21; D-18, D-22): exit code and stdout ----------

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
  const orchThresholds = (t: Rec): MakeDir => ({
    orchestrator: FIVE,
    thresholds: { orchestrator: t },
  });

  it('AT-21: a pass rate exactly equal to the threshold meets it and exits 0', async () => {
    const dir = makeDir(orchThresholds({ overall: 0.6, categories: {} }));
    const r = await runWith(dir, fiveScript());
    const o = runOf(r.outcome, 'orchestrator');
    expect(o.summary.overall.passRate).toBeCloseTo(0.6, 10);
    expect(o.summary.overall.meetsThreshold).toBe(true);
    expect(o.thresholdsMet).toBe(true);
    expect(r.outcome.exitCode).toBe(0);
  });

  it('AT-21: a pass rate below the threshold exits 1 and every results file still exists', async () => {
    const dir = makeDir(orchThresholds({ overall: 0.61, categories: {} }));
    const r = await runWith(dir, fiveScript());
    expect(r.outcome.exitCode).toBe(1);
    expect(runOf(r.outcome, 'orchestrator').thresholdsMet).toBe(false);
    for (const p of r.outcome.resultsPaths)
      expect(readFileSync(p, 'utf8').length).toBeGreaterThan(0);
    expect(resultFiles(dir)).toHaveLength(4);
  });

  it('AT-21: a category with a threshold and a null passRate has meetsThreshold false and exits 1', async () => {
    const dir = makeDir(orchThresholds({ overall: 0.5, categories: { injection: 1 } }));
    const r = await runWith(dir, fiveScript());
    const bucket = runOf(r.outcome, 'orchestrator').summary.categories.injection;
    expect(bucket?.passRate).toBeNull();
    expect(bucket?.meetsThreshold).toBe(false);
    expect(r.outcome.exitCode).toBe(1);
  });

  it('AT-21: a full run where leave misses a threshold and the others meet theirs exits 1 with four files', async () => {
    const dir = makeDir({
      orchestrator: [orch(1, 'leave')],
      // Expects a card, the fake asks a question: the case fails and leave misses overall 1.
      leave: [leaveCase('EV-1', { resultKind: 'card' })],
      thresholds: {
        orchestrator: { overall: 1, categories: {} },
        leave: { overall: 1, categories: {} },
      },
    });
    const r = await runWith(dir, [...route('leave'), QUESTION]);
    expect(r.outcome.exitCode).toBe(1);
    expect(resultFiles(dir)).toHaveLength(4);
    const met = Object.fromEntries(
      AGENT_LIST.map((a) => [a, readRun(dir, fileName('2026-10-22', a)).thresholdsMet]),
    );
    expect(met).toEqual({ orchestrator: true, leave: false, policy_qa: true, onboarding: true });
  });

  it('AT-21: stdout holds the results paths and each failed (agent, id), and no userText', async () => {
    const dir = makeDir(orchThresholds({ overall: 0.5, categories: {} }));
    const r = await runWith(dir, fiveScript());
    const stdout = r.out.join('\n');
    for (const p of r.outcome.resultsPaths) expect(stdout).toContain(p);
    expect(r.outcome.resultsPaths).toHaveLength(4);
    expect(stdout).toContain('orch-004');
    expect(stdout).toContain('orch-005');
    expect(stdout).not.toContain('USERTEXT-CANARY');
    expect(stdout).not.toContain('I want annual leave');
  });

  describe('the summary table', () => {
    const cells = (l: string): string[] => l.split('|').map((c) => c.trim());
    const rowOf = (out: string[], agent: string, metric: string): string[] | undefined =>
      out.map(cells).find((c) => c[0] === agent && c[1] === metric);

    it('AT-21: stdout has the header columns and a row per (agent, metric) with percentages, n/a and dashes', async () => {
      const dir = makeDir(orchThresholds({ overall: 0.6, categories: { injection: 1 } }));
      const r = await runWith(dir, fiveScript());
      const header = r.out.map(cells).find((c) => c[0] === 'Agent');
      expect(header).toEqual(['Agent', 'Metric', 'Scored', 'Passed', 'Rate', 'Threshold', 'Met']);

      // routing: 5 scored, 3 passed, no threshold on this category.
      expect(rowOf(r.out, 'orchestrator', 'routing')).toEqual([
        'orchestrator',
        'routing',
        '5',
        '3',
        '60.0%',
        '-',
        '-',
      ]);
      // injection has a threshold and no scored case: n/a, fails closed.
      expect(rowOf(r.out, 'orchestrator', 'injection')).toEqual([
        'orchestrator',
        'injection',
        '0',
        '0',
        'n/a',
        '100.0%',
        'no',
      ]);
      expect(rowOf(r.out, 'orchestrator', 'overall')).toEqual([
        'orchestrator',
        'overall',
        '5',
        '3',
        '60.0%',
        '60.0%',
        'yes',
      ]);
    });

    it('AT-21: gate agents get escalation_precision and escalation_recall rows, the orchestrator does not', async () => {
      const dir = makeDir(orchThresholds({ categories: {} }));
      const r = await runWith(dir, fiveScript());
      for (const agent of ['leave', 'policy_qa', 'onboarding']) {
        // No positive case at all: both rates are null, so Scored = 0 and Rate = n/a.
        expect(rowOf(r.out, agent, 'escalation_precision')).toEqual([
          agent,
          'escalation_precision',
          '0',
          '0',
          'n/a',
          '-',
          '-',
        ]);
        expect(rowOf(r.out, agent, 'escalation_recall')?.[4]).toBe('n/a');
      }
      expect(rowOf(r.out, 'orchestrator', 'escalation_precision')).toBeUndefined();
      expect(rowOf(r.out, 'orchestrator', 'escalation_recall')).toBeUndefined();
    });

    it('AT-21: every agent that ran gets a tokens and cost line, and a -- leave run prints only leave rows', async () => {
      const dir = makeDir({ leave: [leaveCase('EV-1', { resultKind: 'needs_details' })] });
      const r = await runWith(dir, [QUESTION], {}, 'leave');
      const stdout = r.out.join('\n');
      expect(stdout).toMatch(/leave: tokens 120\/30, cost \$0\.0008/);
      expect(stdout).not.toMatch(/orchestrator: tokens/);
      expect(r.out.map(cells).some((c) => c[0] === 'orchestrator')).toBe(false);
      expect(r.out.map(cells).some((c) => c[0] === 'leave' && c[1] === 'overall')).toBe(true);
    });

    it('AT-21: a thresholded tag gets a tag:<name> row', async () => {
      const dir = makeDir({
        orchestrator: [{ ...orch(1, 'leave'), tags: ['prohibited'] }],
        thresholds: { orchestrator: { categories: {}, tags: { prohibited: 1 } } },
      });
      const r = await runWith(dir, route('leave'));
      const row = rowOf(r.out, 'orchestrator', 'tag:prohibited');
      expect(row).toEqual(['orchestrator', 'tag:prohibited', '1', '1', '100.0%', '100.0%', 'yes']);
    });
  });
});

// ---------- AT-22 (rule 22; D-18) ----------

describe('eval-runner AT-22: tests never call the model', () => {
  it('AT-22: two runs with the same inputs give deep-equal runs per agent apart from times and latency', async () => {
    const cases = [orch(1, 'leave'), orch(2, 'policy_qa')];
    const leave = [leaveCase('EV-1', { resultKind: 'needs_details' })];
    const script = (): Rec[] => [...cases.flatMap(() => route('leave')), QUESTION];
    const t = { orchestrator: { overall: 0.4, categories: {} } };
    const a = await runWith(makeDir({ orchestrator: cases, leave, thresholds: t }), script());
    const b = await runWith(makeDir({ orchestrator: cases, leave, thresholds: t }), script());
    const strip = (run: EvalRun): unknown => ({
      ...run,
      startedAt: null,
      finishedAt: null,
      cases: run.cases.map((c) => ({ ...c, latencyMs: null })),
    });
    expect(a.outcome.runs).toHaveLength(4);
    expect(b.outcome.runs).toHaveLength(4);
    for (const agent of AGENT_LIST) {
      expect(strip(runOf(a.outcome, agent)), agent).toEqual(strip(runOf(b.outcome, agent)));
    }
    expect(a.outcome.exitCode).toBe(b.outcome.exitCode);
  });

  it('AT-22: with ANTHROPIC_API_KEY unset in the process, a run with an injected env never calls fetch', async () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    const dir = makeDir({ orchestrator: [orch(1, 'leave')] });
    const r = await runWith(dir, route('leave'));
    expect(r.outcome.exitCode === 0 || r.outcome.exitCode === 1).toBe(true);
    expect(must(r.outcome.runs[0])).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
