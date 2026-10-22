// Spec eval-runner, rule 15: one case's error never stops the run, including a throw while the
// runner observes or scores a case after its model calls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelClient } from '../agents/schemas.js';
import { InMemoryOnboardingStore } from '../onboarding/in-memory.js';
import { runEvals } from './run.js';

const NONE = { categories: {} };
const leave = (id: string) => ({
  id,
  category: 'extraction',
  actor: { employeeId: 'emp-004', role: 'employee' },
  userText: 'Synthetic leave question.',
  expected: { resultKind: 'needs_details' },
  tags: [],
});
const skipped = {
  id: 'orch-900',
  category: 'routing',
  actor: { employeeId: 'emp-004', role: 'employee' },
  userText: 'Filler.',
  expected: { label: 'leave', injectionFlagged: false },
  tags: ['chained'],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evals-errors-'));
  const files: Record<string, unknown[]> = {
    orchestrator: [skipped],
    leave: [leave('EV-1'), leave('EV-2')],
    policy_qa: [
      {
        ...skipped,
        id: 'EV-900',
        endpoint: 'messages',
        expected: {},
        tags: ['blocked:x'],
        notes: 'n',
      },
    ],
    onboarding: [{ ...skipped, id: 'EV-900', endpoint: 'messages', expected: {}, notes: 'n' }],
  };
  for (const [agent, lines] of Object.entries(files)) {
    mkdirSync(join(dir, agent), { recursive: true });
    writeFileSync(
      join(dir, agent, 'cases.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }
  mkdirSync(join(dir, 'results'));
  writeFileSync(
    join(dir, 'thresholds.yaml'),
    JSON.stringify({
      version: 1,
      agents: { orchestrator: NONE, leave: NONE, policy_qa: NONE, onboarding: NONE },
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('fetch must not be called');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('eval runner: errors after the run', () => {
  it('rule 15: a throw while observing a case makes it error / run_failed and the next case still runs', async () => {
    vi.spyOn(InMemoryOnboardingStore.prototype, 'listDeviations').mockRejectedValueOnce(
      new Error('store read failed'),
    );
    const done = {
      content: [{ type: 'text', text: 'Which dates would you like?' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const model: ModelClient = { create: () => Promise.resolve(done) };
    const outcome = await runEvals({
      env: { ANTHROPIC_API_KEY: 'TEST-key-0003' },
      evalsDir: dir,
      model,
      realClock: { nowMs: () => 0, nowIso: () => '2026-10-22T10:00:00.000Z' },
      scheduler: { setTimeout: () => () => undefined },
      gitCommit: null,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const byId = (id: string) => outcome.run?.cases.find((c) => c.agent === 'leave' && c.id === id);
    expect(outcome.exitCode).not.toBe(2);
    expect(byId('EV-1')?.status).toBe('error');
    expect(byId('EV-1')?.errorCode).toBe('run_failed');
    expect(byId('EV-2')?.status).toBe('passed');
  });
});
