// Spec eval-runner, AT-2 to AT-8 (rules 2 to 8): input validation, secrets, thresholds file,
// production stack, drivers, isolation and the actor check. Fake model, temp dirs, fetch throws.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
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

function setup(files: Files = {}, thresholds: string | null = VALID_THRESHOLDS): Setup {
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
  outcome.run?.cases.find((c) => c.agent === agent && c.id === id);

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
      expect(outcome.run).toBeNull();
      expect(outcome.resultsPath).toBeNull();
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
      expect(JSON.stringify(outcome.run)).not.toContain(CANARY);
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

    it('AT-4: thresholdsHash equals the SHA-256 of the file bytes', async () => {
      const { outcome } = await runWith(VALID_THRESHOLDS);
      expect([0, 1]).toContain(outcome.exitCode);
      expect(outcome.run?.thresholdsHash).toBe(
        createHash('sha256').update(Buffer.from(VALID_THRESHOLDS)).digest('hex'),
      );
    });

    it('AT-4: leave.tags { prohibited: 1 } parses', async () => {
      const { outcome } = await runWith(
        thresholdsWith('    categories: {}\n    tags:\n      prohibited: 1\n'),
      );
      expect(outcome.exitCode).not.toBe(2);
      expect(outcome.run).not.toBeNull();
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
