// Spec eval-runner, AT-1 (rule 1): the npm script and the CLI entry's argument handling.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelClient } from '../agents/schemas.js';
import { main } from './cli.js';
import type { EvalDeps } from './run.js';

const PACKAGE_JSON = fileURLToPath(new URL('../../../package.json', import.meta.url));

function makeDeps(): { deps: EvalDeps; modelCalls: unknown[]; lines: string[] } {
  const modelCalls: unknown[] = [];
  const lines: string[] = [];
  const model: ModelClient = {
    create: (req) => {
      modelCalls.push(req);
      return Promise.reject(new Error('the model must not be called'));
    },
  };
  const deps: EvalDeps = {
    env: { ANTHROPIC_API_KEY: 'TEST-key-0001' },
    evalsDir: mkdtempSync(join(tmpdir(), 'evals-cli-')),
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

  it('AT-1: an extra argument "leave" exits 2 and makes no model call', async () => {
    const { deps, modelCalls } = makeDeps();
    const code = await main(['leave'], deps);
    expect(code).toBe(2);
    expect(modelCalls).toHaveLength(0);
  });
});
