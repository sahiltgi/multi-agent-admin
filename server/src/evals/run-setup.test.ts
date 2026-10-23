// Spec eval-runner, AT-2 to AT-8 (rules 2 to 8): input validation, secrets, thresholds file,
// production stack, drivers, isolation and the actor check. Fake model, temp dirs, fetch throws.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import { runLeaveAgent } from '../agents/leave/run.js';
import { classifyMessage } from '../agents/orchestrator/classify.js';
import type { ModelClient, ModelRequest } from '../agents/schemas.js';
import { loadLeavePolicy } from '../policies/load.js';
import { buildApp } from '../server/app.js';
import { runEvals, type EvalDeps, type EvalOutcome } from './run.js';

// Pass-through spies: the real code still runs, the tests only observe the calls.
vi.mock('../agents/orchestrator/classify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/orchestrator/classify.js')>();
  return { ...actual, classifyMessage: vi.fn(actual.classifyMessage) };
});
vi.mock('../agents/leave/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agents/leave/run.js')>();
  return { ...actual, runLeaveAgent: vi.fn(actual.runLeaveAgent) };
});
const appRequests: { url: string; demoUser: string | undefined }[] = [];
vi.mock('../server/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/app.js')>();
  const record = (req: unknown): void => {
    const r = req as { url?: string; originalUrl?: string; headers?: Record<string, unknown> };
    const demo = r.headers?.['x-demo-user'];
    appRequests.push({
      url: r.originalUrl ?? r.url ?? '',
      demoUser: typeof demo === 'string' ? demo : undefined,
    });
  };
  const watch = (app: object): object =>
    new Proxy(app, {
      apply: (target, thisArg, args: unknown[]) => {
        record(args[0]);
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
      get: (target, prop, receiver) => {
        if (prop === 'handle') {
          return (req: unknown, ...rest: unknown[]) => {
            record(req);
            return (target as { handle: (...a: unknown[]) => unknown }).handle(req, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  return {
    ...actual,
    buildApp: vi.fn((...args: Parameters<typeof actual.buildApp>) => {
      const built = actual.buildApp(...args) as unknown;
      return built instanceof Promise
        ? built.then((a: object) => watch(a))
        : watch(built as object);
    }),
  };
});

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CANARY = 'TEST-canary-key-0001';
const AGENTS = ['orchestrator', 'leave', 'policy_qa', 'onboarding'] as const;
type Agent = (typeof AGENTS)[number];

// ---- case line builders (synthetic data, seeded emp-0NN ids) ----
const line = (o: unknown): string => JSON.stringify(o);
const orchCase = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  category: 'routing',
  actor: { employeeId: 'emp-004', role: 'employee' },
  userText: 'I would like annual leave from 2026-11-16 to 2026-11-18, please.',
  expected: { label: 'leave', injectionFlagged: false },
  tags: [],
  ...extra,
});
const leaveCase = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  category: 'verdict',
  actor: { employeeId: 'emp-004', role: 'employee' },
  userText: 'Annual leave from 2026-11-05 to 2026-11-06 please.',
  expected: { resultKind: 'card' },
  tags: [],
  ...extra,
});
const qaCase = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  category: 'citation',
  actor: { employeeId: 'emp-004', role: 'employee' },
  endpoint: 'chat',
  userText: 'What is the deadline for expense claims?',
  expected: { outcome: 'policy_answer' },
  tags: [],
  notes: 'synthetic note',
  ...extra,
});
const onbCase = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  category: 'verdict',
  actor: { employeeId: 'emp-001', role: 'hr_admin' },
  endpoint: 'chat',
  userText: 'Create a checklist for a new engineer on team-b starting 2027-01-11.',
  expected: { outcome: 'checklist' },
  tags: [],
  notes: 'synthetic note',
  ...extra,
});

// Cases that never reach a model: a skip tag per agent (rules 11 and 12).
const skippedOrch = (id = 'orch-001') => orchCase(id, { tags: ['instrumented'] });
const skippedLeave = (id = 'EV-1') => leaveCase(id, { tags: ['instrumented'] });
const skippedQa = (id = 'EV-1') => qaCase(id, { tags: ['blocked:no-runner'] });
const skippedOnb = (id = 'EV-1') => onbCase(id, { tags: ['blocked:no-runner'] });

const VALID_THRESHOLDS = `version: 1
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

// evals/pricing.yaml (rule 25). JSON is valid YAML. Every shipped model is priced unless a test
// narrows the list.
const ALL_MODELS = [
  ...new Set([
    ORCHESTRATOR_CONFIG.model,
    LEAVE_CONFIG.model,
    POLICY_QA_CONFIG.model,
    ONBOARDING_CONFIG.model,
  ]),
];
const pricingFor = (models: readonly string[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    asOf: '2026-10-22',
    currency: 'USD',
    models: Object.fromEntries(models.map((m) => [m, { inputPerMTok: 3, outputPerMTok: 15 }])),
    ...over,
  });
const VALID_PRICING = pricingFor(ALL_MODELS);
const sha256 = (text: string): string =>
  createHash('sha256').update(Buffer.from(text)).digest('hex');

const thresholdsWith = (leaveBlock: string, omit?: Agent): string => {
  const block = (name: Agent): string =>
    name === 'leave' ? `  leave:\n${leaveBlock}` : `  ${name}:\n    categories: {}\n`;
  return `version: 1\nagents:\n${AGENTS.filter((a) => a !== omit)
    .map(block)
    .join('')}`;
};

type Files = Partial<Record<Agent, string | null>>; // null = file is missing

interface Setup {
  evalsDir: string;
  resultsDir: string;
}

function setup(
  files: Files = {},
  thresholds: string | null = VALID_THRESHOLDS,
  pricing: string | null = VALID_PRICING,
): Setup {
  const evalsDir = mkdtempSync(join(tmpdir(), 'evals-setup-'));
  const defaults: Record<Agent, string> = {
    orchestrator: line(skippedOrch()) + '\n',
    leave: line(skippedLeave()) + '\n',
    policy_qa: line(skippedQa()) + '\n',
    onboarding: line(skippedOnb()) + '\n',
  };
  for (const agent of AGENTS) {
    const content = files[agent] === undefined ? defaults[agent] : files[agent];
    if (content === null) continue;
    mkdirSync(join(evalsDir, agent), { recursive: true });
    writeFileSync(join(evalsDir, agent, 'cases.jsonl'), content);
  }
  if (thresholds !== null) writeFileSync(join(evalsDir, 'thresholds.yaml'), thresholds);
  if (pricing !== null) writeFileSync(join(evalsDir, 'pricing.yaml'), pricing);
  const resultsDir = join(evalsDir, 'results');
  mkdirSync(resultsDir, { recursive: true });
  return { evalsDir, resultsDir };
}

const resultFiles = (s: Setup): string[] => readdirSync(s.resultsDir);
const allResultsText = (s: Setup): string =>
  resultFiles(s)
    .map((f) => readFileSync(join(s.resultsDir, f), 'utf8'))
    .join('\n');

// ---- fake model ----
const endTurn = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});
const submitToGate = (input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use', id: 'toolu_01', name: 'submit_to_gate', input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 1, output_tokens: 1 },
});
const hasTool = (req: ModelRequest, name: string): boolean =>
  (req.tools ?? []).some((t) => t.name === name);

type Script = (req: ModelRequest, callNo: number) => unknown;

function fakeModel(script?: Script): { model: ModelClient; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const model: ModelClient = {
    create: (req) => {
      calls.push(req);
      try {
        return Promise.resolve(script ? script(req, calls.length) : endTurn('Which dates?'));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error('script failed'));
      }
    },
  };
  return { model, calls };
}

interface Harness {
  deps: EvalDeps;
  out: () => string;
  caseEnds: {
    agent: string;
    id: string;
    auditEvents: readonly unknown[];
    firstId: string | null;
  }[];
}

function harness(
  s: Setup,
  model: ModelClient,
  env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: CANARY },
): Harness {
  const lines: string[] = [];
  const caseEnds: Harness['caseEnds'] = [];
  const deps: EvalDeps = {
    env,
    evalsDir: s.evalsDir,
    model,
    realClock: {
      nowMs: () => Date.parse('2026-10-22T12:00:00.000Z'),
      nowIso: () => '2026-10-22T12:00:00.000Z',
    },
    scheduler: { setTimeout: () => () => undefined },
    gitCommit: null,
    stdout: (l) => lines.push(l),
    stderr: (l) => lines.push(l),
    onCaseEnd: (c) => caseEnds.push(c),
  };
  return { deps, out: () => lines.join('\n'), caseEnds };
}

const resultOf = (outcome: EvalOutcome, agent: string, id: string) =>
  outcome.runs.flatMap((r) => r.cases).find((c) => c.agent === agent && c.id === id);

describe('eval runner setup (AT-2 to AT-8)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error('fetch must not be called in tests');
    });
    vi.stubGlobal('fetch', fetchSpy);
    appRequests.length = 0;
    vi.mocked(classifyMessage).mockClear();
    vi.mocked(runLeaveAgent).mockClear();
    vi.mocked(buildApp).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---- AT-2 (rule 2) ----
  describe('AT-2: case sources', () => {
    async function expectSetupError(
      files: Files,
      mustName: RegExp,
      lineNo: number | null,
      secret: string | null,
    ): Promise<void> {
      const s = setup(files);
      const { model, calls } = fakeModel();
      const h = harness(s, model);
      const outcome = await runEvals(h.deps);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.runs).toEqual([]);
      expect(outcome.resultsPaths).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(resultFiles(s)).toHaveLength(0);
      expect(h.out()).toMatch(mustName);
      if (lineNo !== null) expect(h.out()).toMatch(new RegExp(`\\b${String(lineNo)}\\b`));
      if (secret !== null) expect(h.out()).not.toContain(secret);
    }

    it('AT-2: a second line that is not JSON exits 2 naming the file and line, not the text', async () => {
      await expectSetupError(
        { orchestrator: line(skippedOrch('orch-001')) + '\nLINE-CANARY-BAD {not json\n' },
        /orchestrator/,
        2,
        'LINE-CANARY-BAD',
      );
    });

    it('AT-2: a policy_qa line with reviewed "yes" exits 2 naming the file and line, not the text', async () => {
      await expectSetupError(
        {
          policy_qa:
            line(qaCase('EV-1', { userText: 'LINE-CANARY-QA question?', reviewed: 'yes' })) + '\n',
        },
        /policy_qa/,
        1,
        'LINE-CANARY-QA',
      );
    });

    it('AT-2: a leave file holding EV-3 twice exits 2 naming the file and line', async () => {
      await expectSetupError(
        {
          leave:
            line(skippedLeave('EV-3')) +
            '\n' +
            line({ ...skippedLeave('EV-3'), userText: 'LINE-CANARY-DUP please.' }) +
            '\n',
        },
        /leave/,
        2,
        'LINE-CANARY-DUP',
      );
    });

    it('AT-2: an empty onboarding file exits 2 naming the file', async () => {
      await expectSetupError({ onboarding: '' }, /onboarding/, null, null);
    });

    it('AT-2: a missing orchestrator file exits 2 naming the file', async () => {
      await expectSetupError({ orchestrator: null }, /orchestrator/, null, null);
    });
  });

  // ---- AT-3 (rule 3) ----
  describe('AT-3: secrets', () => {
    it('AT-3: no ANTHROPIC_API_KEY exits 2 before reading any case, naming the variable', async () => {
      // The orchestrator file is invalid: a case-read error would name it, a key error must not.
      const s = setup({ orchestrator: 'LINE-CANARY-BAD {not json\n' });
      const { model, calls } = fakeModel();
      const h = harness(s, model, {});
      const outcome = await runEvals(h.deps);
      expect(outcome.exitCode).toBe(2);
      expect(calls).toHaveLength(0);
      expect(h.out()).toContain('ANTHROPIC_API_KEY');
      expect(h.out()).not.toContain('cases.jsonl');
      expect(resultFiles(s)).toHaveLength(0);
    });

    it('AT-3: an SDK error that echoes the key is reported only as an error code, never the key', async () => {
      const s = setup({ leave: line(leaveCase('EV-1')) + '\n' });
      const { model } = fakeModel(() => {
        throw new Error(`401 invalid x-api-key: ${CANARY}`);
      });
      const h = harness(s, model);
      const outcome = await runEvals(h.deps);
      const result = resultOf(outcome, 'leave', 'EV-1');
      expect(result?.status).toBe('error');
      expect(['model_unavailable', 'run_failed']).toContain(result?.errorCode);
      expect(h.out()).not.toContain(CANARY);
      expect(allResultsText(s)).not.toContain(CANARY);
      expect(JSON.stringify(outcome.runs)).not.toContain(CANARY);
    });
  });

  // ---- AT-4 (rules 4, 21) ----
  describe('AT-4: thresholds file', () => {
    async function runWith(thresholds: string | null): Promise<{
      outcome: EvalOutcome;
      calls: ModelRequest[];
      s: Setup;
    }> {
      const s = setup({}, thresholds);
      const { model, calls } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps);
      return { outcome, calls, s };
    }

    it('AT-4: no thresholds file exits 2 with no model call and no results file', async () => {
      const { outcome, calls, s } = await runWith(null);
      expect(outcome.exitCode).toBe(2);
      expect(calls).toHaveLength(0);
      expect(resultFiles(s)).toHaveLength(0);
    });

    it('AT-4: leave.categories.verdict of 1.01 exits 2', async () => {
      const { outcome, calls, s } = await runWith(
        thresholdsWith('    categories:\n      verdict: 1.01\n'),
      );
      expect(outcome.exitCode).toBe(2);
      expect(calls).toHaveLength(0);
      expect(resultFiles(s)).toHaveLength(0);
    });

    it('AT-4: a thresholds file missing policy_qa exits 2', async () => {
      const { outcome, s } = await runWith(thresholdsWith('    categories: {}\n', 'policy_qa'));
      expect(outcome.exitCode).toBe(2);
      expect(resultFiles(s)).toHaveLength(0);
    });

    it('AT-4: a thresholds file that is not valid YAML exits 2', async () => {
      const { outcome, s } = await runWith('version: 1\nagents: [unclosed\n');
      expect(outcome.exitCode).toBe(2);
      expect(resultFiles(s)).toHaveLength(0);
    });

    it('AT-4: thresholdsHash in every results file equals the SHA-256 of the file bytes', async () => {
      const { outcome, s } = await runWith(VALID_THRESHOLDS);
      expect([0, 1]).toContain(outcome.exitCode);
      const files = resultFiles(s);
      expect(files).toHaveLength(4);
      expect(outcome.runs).toHaveLength(4);
      for (const f of files) {
        const parsed = JSON.parse(readFileSync(join(s.resultsDir, f), 'utf8')) as {
          thresholdsHash?: unknown;
        };
        expect(parsed.thresholdsHash, f).toBe(sha256(VALID_THRESHOLDS));
      }
      for (const r of outcome.runs) expect(r.thresholdsHash).toBe(sha256(VALID_THRESHOLDS));
    });

    it('AT-4: an escalation block under orchestrator fails the schema and exits 2', async () => {
      const yaml = VALID_THRESHOLDS.replace(
        '  orchestrator:\n    categories: {}\n',
        '  orchestrator:\n    categories: {}\n    escalation:\n      recall: 0.9\n',
      );
      expect(yaml).not.toBe(VALID_THRESHOLDS);
      const { outcome, calls, s } = await runWith(yaml);
      expect(outcome.exitCode).toBe(2);
      expect(calls).toHaveLength(0);
      expect(resultFiles(s)).toHaveLength(0);
    });

    it('AT-4: an escalation block under leave parses', async () => {
      const { outcome } = await runWith(
        thresholdsWith('    categories: {}\n    escalation:\n      precision: 0.5\n'),
      );
      expect(outcome.exitCode).not.toBe(2);
    });

    it('AT-4: leave.tags { prohibited: 1 } parses', async () => {
      const { outcome } = await runWith(
        thresholdsWith('    categories: {}\n    tags:\n      prohibited: 1\n'),
      );
      expect(outcome.exitCode).not.toBe(2);
      expect(outcome.runs.length).toBeGreaterThan(0);
    });

    it('AT-4: a tag key "Bad Tag" exits 2', async () => {
      const { outcome, s } = await runWith(
        thresholdsWith('    categories: {}\n    tags:\n      "Bad Tag": 1\n'),
      );
      expect(outcome.exitCode).toBe(2);
      expect(resultFiles(s)).toHaveLength(0);
    });
  });

  // ---- AT-5 (rule 5) ----
  describe('AT-5: production stack', () => {
    it('AT-5: a leave case sends LEAVE_CONFIG.model, the versioned system prompt and the real policy hash', async () => {
      const s = setup({ leave: line(leaveCase('EV-1', { asOf: '2026-11-02' })) + '\n' });
      const { model, calls } = fakeModel((req, n) =>
        hasTool(req, 'submit_to_gate') && n >= 1 && req.messages.length === 1
          ? submitToGate({ leaveType: 'annual', startDate: '2026-11-05', endDate: '2026-11-06' })
          : endTurn('Submitted for review.'),
      );
      const h = harness(s, model);
      await runEvals(h.deps);

      const leaveCalls = calls.filter((c) => hasTool(c, 'submit_to_gate'));
      expect(leaveCalls.length).toBeGreaterThan(0);
      const prompt = readFileSync(
        join(REPO, 'prompts', 'leave', `${LEAVE_CONFIG.promptVersion}.md`),
        'utf8',
      );
      for (const c of leaveCalls) {
        expect(c.model).toBe(LEAVE_CONFIG.model);
        expect(c.system).toBe(prompt);
      }

      const policy = loadLeavePolicy(join(REPO, 'policies', 'leave', 'v1.yaml'));
      const leaveEnd = h.caseEnds.find((c) => c.agent === 'leave');
      const gateEvents = (leaveEnd?.auditEvents ?? []).filter(
        (e) => (e as { eventType?: string }).eventType === 'gate_result',
      );
      expect(gateEvents).toHaveLength(1);
      expect(JSON.stringify(gateEvents[0])).toContain(policy.policyHash);
    });

    it('AT-5: server/src/evals sources import nothing under server/src/gate/ and hold no system: string literal', () => {
      const dir = join(REPO, 'server', 'src', 'evals');
      expect(existsSync(dir)).toBe(true);
      const sources = (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8') }));
      expect(sources.length).toBeGreaterThan(0);
      for (const { f, text } of sources) {
        expect(text, `${f} imports the gate`).not.toMatch(/from\s+['"][^'"]*\/gate\//);
        expect(text, `${f} has a system: literal`).not.toMatch(/\bsystem\s*:\s*['"`]/);
      }
    });
  });

  // ---- AT-6 (rule 6) ----
  describe('AT-6: drivers', () => {
    it('AT-6: an orchestrator case calls classifyMessage once with the case actor and userText', async () => {
      const s = setup({ orchestrator: line(orchCase('orch-001')) + '\n' });
      const { model } = fakeModel();
      await runEvals(harness(s, model).deps);
      expect(classifyMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(classifyMessage).mock.calls[0]?.[0]).toMatchObject({
        actor: { employeeId: 'emp-004', role: 'employee' },
        userText: 'I would like annual leave from 2026-11-16 to 2026-11-18, please.',
      });
    });

    it('AT-6: a leave case calls runLeaveAgent once', async () => {
      const s = setup({ leave: line(leaveCase('EV-1')) + '\n' });
      const { model } = fakeModel();
      await runEvals(harness(s, model).deps);
      expect(runLeaveAgent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runLeaveAgent).mock.calls[0]?.[0]).toMatchObject({
        actor: { employeeId: 'emp-004', role: 'employee' },
        userText: 'Annual leave from 2026-11-05 to 2026-11-06 please.',
      });
    });

    it('AT-6: a policy_qa chat case makes exactly one in-process request to the chat route and opens no listener', async () => {
      const listen = vi.spyOn(net.Server.prototype, 'listen');
      const s = setup({ policy_qa: line(qaCase('EV-1', { endpoint: 'chat' })) + '\n' });
      const { model } = fakeModel();
      await runEvals(harness(s, model).deps);
      expect(appRequests).toHaveLength(1);
      expect(appRequests[0]?.url).toMatch(/chat/);
      expect(appRequests[0]?.demoUser).toBe('emp-004');
      expect(listen).not.toHaveBeenCalled();
    });
  });

  // ---- AT-7 (rule 7) ----
  it('AT-7: the second case sees no record or event from the first, and both start at the same id', async () => {
    const s = setup({
      leave: line(leaveCase('EV-1')) + '\n' + line(leaveCase('EV-2')) + '\n',
    });
    let submitted = false;
    const { model } = fakeModel((req) => {
      if (hasTool(req, 'submit_to_gate') && !submitted) {
        submitted = true;
        return submitToGate({
          leaveType: 'annual',
          startDate: '2026-12-14',
          endDate: '2026-12-16',
        });
      }
      return endTurn('Which dates would you like?');
    });
    const h = harness(s, model);
    await runEvals(h.deps);

    const [first, second] = h.caseEnds.filter((c) => c.agent === 'leave');
    expect(first?.id).toBe('EV-1');
    expect(second?.id).toBe('EV-2');
    const types = (c: typeof first): string[] =>
      (c?.auditEvents ?? []).map((e) => (e as { eventType: string }).eventType);
    expect(types(first)).toContain('gate_result');
    expect(types(first)).toContain('tool_call');
    expect(types(second)).not.toContain('gate_result');
    expect(types(second)).not.toContain('tool_call');
    expect(first?.firstId).not.toBeNull();
    expect(second?.firstId).toBe(first?.firstId);
  });

  // ---- AT-26 (rules 4, 23) ----
  describe('AT-26: the orchestrator has no escalation', () => {
    it('AT-26: the orchestrator summary has escalation null and stdout has no escalation row for it', async () => {
      const s = setup();
      const { model } = fakeModel();
      const h = harness(s, model);
      const outcome = await runEvals(h.deps);
      const orch = outcome.runs.find((r) => r.agent === 'orchestrator');
      expect(orch?.summary.escalation).toBeNull();
      for (const agent of ['leave', 'policy_qa', 'onboarding'] as const) {
        expect(outcome.runs.find((r) => r.agent === agent)?.summary.escalation).not.toBeNull();
      }
      const rows = h.out().split('\n');
      expect(rows.some((l) => /escalation_(precision|recall)/.test(l))).toBe(true);
      expect(
        rows.filter((l) => l.includes('orchestrator') && l.includes('escalation')),
        'orchestrator escalation rows',
      ).toEqual([]);
    });

    it('AT-26: orchestrator.escalation { recall: 0.9 } exits 2 with zero model calls and no results file', async () => {
      const yaml = VALID_THRESHOLDS.replace(
        '  orchestrator:\n    categories: {}\n',
        '  orchestrator:\n    categories: {}\n    escalation:\n      recall: 0.9\n',
      );
      expect(yaml).not.toBe(VALID_THRESHOLDS);
      const s = setup({}, yaml);
      const { model, calls } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps);
      expect(outcome.exitCode).toBe(2);
      expect(calls).toHaveLength(0);
      expect(resultFiles(s)).toHaveLength(0);
    });
  });

  // ---- AT-29 (rule 25; D-20, D-21) ----
  describe('AT-29: pricing file', () => {
    async function expectPricingError(
      pricing: string | null,
      agent?: 'orchestrator' | 'leave' | 'policy_qa' | 'onboarding',
      files: Files = {},
    ): Promise<string> {
      const s = setup(files, VALID_THRESHOLDS, pricing);
      const { model, calls } = fakeModel();
      const h = harness(s, model);
      const outcome = await runEvals(h.deps, agent);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.runs).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(resultFiles(s)).toHaveLength(0);
      return h.out();
    }

    it('AT-29: no pricing.yaml exits 2 with zero model calls and no results file, naming the file', async () => {
      expect(await expectPricingError(null)).toContain('pricing.yaml');
    });

    it('AT-29: a pricing file that is not valid YAML exits 2', async () => {
      await expectPricingError('version: 1\nmodels: [unclosed\n');
    });

    it('AT-29: inputPerMTok of -1 exits 2', async () => {
      const bad = JSON.stringify({
        version: 1,
        asOf: '2026-10-22',
        currency: 'USD',
        models: Object.fromEntries(
          ALL_MODELS.map((m) => [m, { inputPerMTok: -1, outputPerMTok: 15 }]),
        ),
      });
      await expectPricingError(bad);
    });

    it('AT-29: currency EUR, a missing asOf and an extra key each exit 2', async () => {
      await expectPricingError(pricingFor(ALL_MODELS, { currency: 'EUR' }));
      await expectPricingError(pricingFor(ALL_MODELS, { asOf: undefined }));
      await expectPricingError(pricingFor(ALL_MODELS, { discount: 0.1 }));
    });

    it('AT-29: a price of 0 is allowed', async () => {
      const zero = JSON.stringify({
        version: 1,
        asOf: '2026-10-22',
        currency: 'USD',
        models: Object.fromEntries(
          ALL_MODELS.map((m) => [m, { inputPerMTok: 0, outputPerMTok: 0 }]),
        ),
      });
      const s = setup({}, VALID_THRESHOLDS, zero);
      const { model } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps);
      expect(outcome.exitCode).not.toBe(2);
    });

    it('AT-29: no entry for LEAVE_CONFIG.model exits 2 for a full run and for -- leave, naming file, agent and model', async () => {
      const onlyOrchestrator = pricingFor([ORCHESTRATOR_CONFIG.model]);
      for (const agent of [undefined, 'leave'] as const) {
        const out = await expectPricingError(onlyOrchestrator, agent);
        expect(out).toContain('pricing.yaml');
        expect(out).toContain('leave');
        expect(out).toContain(LEAVE_CONFIG.model);
      }
    });

    it('AT-29: -- orchestrator runs with only ORCHESTRATOR_CONFIG.model priced', async () => {
      const s = setup({}, VALID_THRESHOLDS, pricingFor([ORCHESTRATOR_CONFIG.model]));
      const { model } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps, 'orchestrator');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.runs.map((r) => r.agent)).toEqual(['orchestrator']);
      expect(resultFiles(s)).toHaveLength(1);
    });

    it('AT-29: -- policy_qa with only POLICY_QA_CONFIG.model priced exits 2 because the orchestrator model is also required', async () => {
      const out = await expectPricingError(pricingFor([POLICY_QA_CONFIG.model]), 'policy_qa');
      expect(out).toContain('pricing.yaml');
      expect(out).toContain(ORCHESTRATOR_CONFIG.model);
    });

    it('AT-29: extra entries for models that are not shipped are ignored', async () => {
      const s = setup({}, VALID_THRESHOLDS, pricingFor([...ALL_MODELS, 'claude-unshipped-0']));
      const { model } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps);
      expect(outcome.exitCode).not.toBe(2);
    });

    it('AT-29: pricingHash in every results file equals the SHA-256 of the pricing bytes', async () => {
      const s = setup();
      const { model } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps);
      expect([0, 1]).toContain(outcome.exitCode);
      const files = resultFiles(s);
      expect(files).toHaveLength(4);
      for (const f of files) {
        const parsed = JSON.parse(readFileSync(join(s.resultsDir, f), 'utf8')) as {
          pricingHash?: unknown;
        };
        expect(parsed.pricingHash, f).toBe(sha256(VALID_PRICING));
      }
    });

    it('AT-29: setup order is key, thresholds, pricing, then case files', async () => {
      // A malformed orchestrator file must not be reported when pricing is already missing.
      const out = await expectPricingError(null, undefined, {
        orchestrator: 'LINE-CANARY-BAD {not json\n',
      });
      expect(out).toContain('pricing.yaml');
      expect(out).not.toContain('cases.jsonl');

      // A missing key is reported before a missing pricing file.
      const s = setup({}, VALID_THRESHOLDS, null);
      const { model } = fakeModel();
      const h = harness(s, model, {});
      const outcome = await runEvals(h.deps);
      expect(outcome.exitCode).toBe(2);
      expect(h.out()).toContain('ANTHROPIC_API_KEY');
      expect(h.out()).not.toContain('pricing.yaml');

      // Missing thresholds are reported before a missing pricing file.
      const s2 = setup({}, null, null);
      const h2 = harness(s2, fakeModel().model);
      await runEvals(h2.deps);
      expect(h2.out()).toContain('thresholds.yaml');
      expect(h2.out()).not.toContain('pricing.yaml');
    });
  });

  // ---- AT-30 (rules 1, 2, 25; D-17) ----
  describe('AT-30: agent filter isolation', () => {
    it('AT-30: -- policy_qa succeeds with the other case files absent or malformed, and writes one policy_qa file', async () => {
      const s = setup(
        {
          orchestrator: 'LINE-CANARY-BAD {not json\n',
          leave: null,
          onboarding: '',
          policy_qa: line(skippedQa('EV-1')) + '\n',
        },
        VALID_THRESHOLDS,
        pricingFor([POLICY_QA_CONFIG.model, ORCHESTRATOR_CONFIG.model]),
      );
      const { model, calls } = fakeModel();
      const h = harness(s, model);
      const outcome = await runEvals(h.deps, 'policy_qa');
      expect(outcome.exitCode).toBe(0);
      expect(calls).toHaveLength(0);
      expect(outcome.runs).toHaveLength(1);
      expect(outcome.runs[0]?.agent).toBe('policy_qa');
      expect(resultFiles(s)).toEqual([
        `2026-10-22-policy_qa-${POLICY_QA_CONFIG.promptVersion}.json`,
      ]);
      expect(h.out()).not.toContain('LINE-CANARY-BAD');
      expect(h.out()).not.toContain('cases.jsonl');
    });

    it('AT-30: -- leave never opens another agent case file', async () => {
      const s = setup({ leave: line(skippedLeave('EV-1')) + '\n' });
      // Replace the other case files with directories: opening one as a file would throw.
      for (const agent of ['orchestrator', 'policy_qa', 'onboarding'] as const) {
        rmSync(join(s.evalsDir, agent, 'cases.jsonl'));
        mkdirSync(join(s.evalsDir, agent, 'cases.jsonl'));
      }
      const { model } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps, 'leave');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.runs.map((r) => r.agent)).toEqual(['leave']);
      expect(outcome.runs[0]?.cases.every((c) => c.agent === 'leave')).toBe(true);
    });
  });

  // ---- AT-8 (rule 8) ----
  describe('AT-8: actor check', () => {
    it('AT-8: emp-004 labelled hr_admin is error / actor_mismatch with no model call', async () => {
      const s = setup({
        leave:
          line(leaveCase('EV-1', { actor: { employeeId: 'emp-004', role: 'hr_admin' } })) + '\n',
      });
      const { model, calls } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps);
      const result = resultOf(outcome, 'leave', 'EV-1');
      expect(result?.status).toBe('error');
      expect(result?.errorCode).toBe('actor_mismatch');
      expect(calls).toHaveLength(0);
    });

    it('AT-8: emp-999 (not seeded) is error / actor_mismatch with no model call', async () => {
      const s = setup({
        leave:
          line(leaveCase('EV-1', { actor: { employeeId: 'emp-999', role: 'employee' } })) + '\n',
      });
      const { model, calls } = fakeModel();
      const outcome = await runEvals(harness(s, model).deps);
      const result = resultOf(outcome, 'leave', 'EV-1');
      expect(result?.status).toBe('error');
      expect(result?.errorCode).toBe('actor_mismatch');
      expect(calls).toHaveLength(0);
    });
  });
});
