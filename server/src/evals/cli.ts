// Entry point for `npm run evals` (spec eval-runner, rule 1). `.env` is loaded by Node's
// --env-file-if-exists flag. Takes one optional agent name (D-17); importing this module never
// starts a run.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAnthropicClient } from '../agents/anthropic-client.js';
import type { ModelClient } from '../agents/schemas.js';
import { systemClock, timerScheduler } from '../server/runtime.js';
import { runEvals, type EvalDeps } from './run.js';
import { EVAL_AGENTS, EvalArgs } from './schemas.js';

export async function main(args: readonly string[], deps: EvalDeps): Promise<number> {
  // Parsed before the key check; the argument is never echoed (rule 1).
  const parsed = EvalArgs.safeParse(args);
  if (!parsed.success) {
    deps.stderr(
      `evals: usage: npm run evals [-- <agent>], where <agent> is one of ${EVAL_AGENTS.join(', ')}.`,
    );
    return 2;
  }
  return (await runEvals(deps, parsed.data[0])).exitCode;
}

function gitCommit(cwd: string): string | null {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const sha = res.status === 0 ? res.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function productionDeps(): EvalDeps {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  let client: ModelClient | undefined;
  // Created on first use: runEvals checks the key before any model call.
  const model: ModelClient = {
    create: (req, opts) => (client ??= createAnthropicClient(process.env)).create(req, opts),
  };
  return {
    env: process.env,
    evalsDir: join(repo, 'evals'),
    model,
    realClock: systemClock,
    scheduler: timerScheduler,
    gitCommit: gitCommit(repo),
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2), productionDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('evals: the run failed unexpectedly.');
      process.exitCode = 2;
    },
  );
}
