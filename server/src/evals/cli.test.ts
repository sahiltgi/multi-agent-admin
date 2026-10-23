// Spec eval-runner, AT-1 (rule 1; D-17): the npm script and the CLI entry's argument handling.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import type { ModelClient, ModelRequest } from '../agents/schemas.js';
import { main } from './cli.js';
import type { EvalDeps } from './run.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../../package.json', import.meta.url));
const AGENTS = ['orchestrator', 'leave', 'policy_qa', 'onboarding'] as const;

const ACTOR = { employeeId: 'emp-004', role: 'employee' };
const leaveCase = (id: string): object => ({
  id,
  category: 'verdict',
  actor: ACTOR,
  userText: 'Annual leave from 2026-11-05 to 2026-11-06 please.',
  expected: { resultKind: 'needs_details' },
  tags: [],
});
// A case that never reaches a model, so every file is valid without model calls.
const skipped = (agent: (typeof AGENTS)[number]): object => ({
  id: agent === 'orchestrator' ? 'orch-001' : 'EV-1',
  category: 'routing',
  actor: ACTOR,
  userText: 'Synthetic filler.',
  expected: agent === 'orchestrator' ? { label: 'leave', injectionFlagged: false } : {},
  ...(agent === 'policy_qa' || agent === 'onboarding' ? { endpoint: 'chat', notes: 'n' } : {}),
  tags: ['chained'],
});

/** Temp evals dir: thresholds, pricing for every shipped model, and the case files given. */
function makeEvalsDir(files: Partial<Record<(typeof AGENTS)[number], object[]>>): string {
  const evalsDir = mkdtempSync(join(tmpdir(), 'evals-cli-'));
  for (const agent of AGENTS) {
    const lines = files[agent];
    if (lines === undefined) continue;
    mkdirSync(join(evalsDir, agent), { recursive: true });
    writeFileSync(
      join(evalsDir, agent, 'cases.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }
  writeFileSync(
    join(evalsDir, 'thresholds.yaml'),
    JSON.stringify({
      version: 1,
      agents: Object.fromEntries(AGENTS.map((a) => [a, { categories: {} }])),
    }),
  );
  const models = new Set([
    ORCHESTRATOR_CONFIG.model,
    LEAVE_CONFIG.model,
    POLICY_QA_CONFIG.model,
    ONBOARDING_CONFIG.model,
  ]);
  writeFileSync(
    join(evalsDir, 'pricing.yaml'),
    JSON.stringify({
      version: 1,
      asOf: '2026-10-22',
      currency: 'USD',
      models: Object.fromEntries(
        [...models].map((m) => [m, { inputPerMTok: 3, outputPerMTok: 15 }]),
      ),
    }),
  );
  mkdirSync(join(evalsDir, 'results'), { recursive: true });
  return evalsDir;
}

function makeDeps(evalsDir: string): {
  deps: EvalDeps;
  modelCalls: ModelRequest[];
  lines: string[];
} {
  const modelCalls: ModelRequest[] = [];
  const lines: string[] = [];
  const model: ModelClient = {
    create: (req) => {
      modelCalls.push(req);
      return Promise.resolve({
        content: [{ type: 'text', text: 'Which dates would you like to take off?' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  };
  const deps: EvalDeps = {
    env: { ANTHROPIC_API_KEY: 'TEST-key-0001' },
    evalsDir,
    model,
    realClock: {
      nowMs: () => Date.parse('2026-10-22T12:00:00.000Z'),
      nowIso: () => '2026-10-22T12:00:00.000Z',
    },
    scheduler: { setTimeout: () => () => undefined },
    gitCommit: null,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  };
  return { deps, modelCalls, lines };
}

const resultFiles = (evalsDir: string): string[] => readdirSync(join(evalsDir, 'results'));

describe('eval runner CLI (AT-1)', () => {
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

  it('AT-1: the evals script runs server/src/evals/cli.ts with --env-file-if-exists=.env and is no longer the placeholder', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts.evals;
    expect(script).toBeDefined();
    expect(script).toContain('server/src/evals/cli.ts');
    expect(script).toContain('--env-file-if-exists=.env');
    expect(script).not.toContain('placeholder');
  });

  it('AT-1: the agent argument "leave" runs only leave cases and only leave model requests', async () => {
    // Only the leave file exists: any read of another agent file would exit 2 (rule 2).
    const evalsDir = makeEvalsDir({ leave: [leaveCase('EV-1'), leaveCase('EV-2')] });
    const { deps, modelCalls } = makeDeps(evalsDir);
    const code = await main(['leave'], deps);
    expect(code).toBe(0);

    const files = resultFiles(evalsDir);
    expect(files).toEqual([`2026-10-22-leave-${LEAVE_CONFIG.promptVersion}.json`]);
    const run = JSON.parse(readFileSync(join(evalsDir, 'results', files[0] ?? ''), 'utf8')) as {
      agent: string;
      cases: { agent: string }[];
    };
    expect(run.agent).toBe('leave');
    expect(run.cases).toHaveLength(2);
    expect(run.cases.every((c) => c.agent === 'leave')).toBe(true);

    expect(modelCalls).toHaveLength(2);
    for (const req of modelCalls) {
      expect(req.model).toBe(LEAVE_CONFIG.model);
      expect((req.tools ?? []).some((t) => t.name === 'submit_to_gate')).toBe(true);
    }
  });

  it('AT-1: no argument runs all four agents', async () => {
    const evalsDir = makeEvalsDir({
      orchestrator: [skipped('orchestrator')],
      leave: [leaveCase('EV-1')],
      policy_qa: [skipped('policy_qa')],
      onboarding: [skipped('onboarding')],
    });
    const { deps } = makeDeps(evalsDir);
    const code = await main([], deps);
    expect([0, 1]).toContain(code);
    expect(resultFiles(evalsDir)).toHaveLength(4);
  });

  it.each([['bogus'], ['LEAVE'], [''], ['--leave'], ['__proto__'], ['../leave']])(
    'AT-1: the unknown argument %j exits 2 with zero model calls, no results file and no echo',
    async (arg) => {
      const evalsDir = makeEvalsDir({
        orchestrator: [skipped('orchestrator')],
        leave: [leaveCase('EV-1')],
        policy_qa: [skipped('policy_qa')],
        onboarding: [skipped('onboarding')],
      });
      const { deps, modelCalls, lines } = makeDeps(evalsDir);
      const code = await main([arg], deps);
      expect(code).toBe(2);
      expect(modelCalls).toHaveLength(0);
      expect(resultFiles(evalsDir)).toHaveLength(0);
      const out = lines.join('\n');
      for (const name of AGENTS) expect(out).toContain(name);
      if (arg.length > 2) expect(out).not.toContain(arg);
    },
  );

  it('AT-1: "leave policy_qa" exits 2 with zero model calls and no results file', async () => {
    const evalsDir = makeEvalsDir({
      orchestrator: [skipped('orchestrator')],
      leave: [leaveCase('EV-1')],
      policy_qa: [skipped('policy_qa')],
      onboarding: [skipped('onboarding')],
    });
    const { deps, modelCalls } = makeDeps(evalsDir);
    const code = await main(['leave', 'policy_qa'], deps);
    expect(code).toBe(2);
    expect(modelCalls).toHaveLength(0);
    expect(resultFiles(evalsDir)).toHaveLength(0);
  });

  it('AT-1: "leave leave" exits 2 with zero model calls and no results file', async () => {
    const evalsDir = makeEvalsDir({ leave: [leaveCase('EV-1')] });
    const { deps, modelCalls } = makeDeps(evalsDir);
    const code = await main(['leave', 'leave'], deps);
    expect(code).toBe(2);
    expect(modelCalls).toHaveLength(0);
    expect(resultFiles(evalsDir)).toHaveLength(0);
  });

  it('AT-30: a -- leave run is judged only on leave thresholds, never on another agent threshold', async () => {
    const evalsDir = makeEvalsDir({ leave: [leaveCase('EV-1')] });
    // The orchestrator never runs, so its overall 1 (nothing scored) must not fail the run.
    writeFileSync(
      join(evalsDir, 'thresholds.yaml'),
      JSON.stringify({
        version: 1,
        agents: {
          orchestrator: { overall: 1, categories: {} },
          leave: { overall: 1, categories: {} },
          policy_qa: { overall: 1, categories: {} },
          onboarding: { overall: 1, categories: {} },
        },
      }),
    );
    const { deps } = makeDeps(evalsDir);
    const code = await main(['leave'], deps);
    expect(code).toBe(0);
    expect(resultFiles(evalsDir)).toEqual([`2026-10-22-leave-${LEAVE_CONFIG.promptVersion}.json`]);
  });

  it('AT-1: a bad argument exits 2 before the key is checked', async () => {
    const evalsDir = makeEvalsDir({ leave: [leaveCase('EV-1')] });
    const { deps, lines } = makeDeps(evalsDir);
    const code = await main(['bogus'], { ...deps, env: {} });
    expect(code).toBe(2);
    expect(lines.join('\n')).not.toContain('ANTHROPIC_API_KEY');
  });
});
