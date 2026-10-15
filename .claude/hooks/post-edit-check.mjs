// PostToolUse hook for file edits: Prettier, ESLint, then the related Vitest tests for the
// changed file. Exit 2 shows the failure to Claude (the edit itself has already happened).
// A shared deadline keeps the whole run near 20s; a step that runs out of time doesn't block.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { block, getString, projectRoot, readInput, relPath, tail } from './lib.mjs';

const HOOK = 'post-edit-check';
const DEADLINE_MS = 20_000;
const LINTABLE = /\.(?:[cm]?[jt]s|tsx)$/;
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_DIRS = /(?:^|\/)(?:node_modules|dist|coverage)\//;

const started = Date.now();

/**
 * Runs a local binary from node_modules/.bin with whatever time is left.
 * @param {string} root
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ status: 'ok' | 'failed' | 'skipped', output: string }}
 */
function step(root, bin, args) {
  const remaining = DEADLINE_MS - (Date.now() - started);
  if (remaining <= 0) return { status: 'skipped', output: `${bin}: out of time, skipped` };
  const res = spawnSync(join(root, 'node_modules', '.bin', bin), args, {
    cwd: root,
    encoding: 'utf8',
    timeout: remaining,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (res.error !== undefined) {
    return { status: 'skipped', output: `${bin}: ${res.error.message}` };
  }
  if (res.status === 0) return { status: 'ok', output: '' };
  return { status: 'failed', output: `${res.stdout}\n${res.stderr}` };
}

function main() {
  const input = readInput();
  if (input === null) {
    process.stderr.write('post-edit-check: could not parse the hook input\n');
    process.exit(1);
  }
  const file = getString(input.tool_input, 'file_path');
  if (file === undefined) return;
  const root = projectRoot(input);
  const rel = relPath(root, file);
  if (rel === null || SKIPPED_DIRS.test(rel) || !existsSync(join(root, rel))) return;

  /** @type {[string, string[]][]} */
  const steps = [['prettier', ['--write', '--ignore-unknown', rel]]];
  if (LINTABLE.test(rel)) {
    steps.push(['eslint', ['--fix', '--max-warnings', '0', '--no-warn-ignored', rel]]);
    steps.push(
      TEST_FILE.test(rel)
        ? ['vitest', ['run', rel]]
        : ['vitest', ['related', '--run', '--passWithNoTests', rel]],
    );
  }

  for (const [bin, args] of steps) {
    const result = step(root, bin, args);
    if (result.status === 'skipped') process.stderr.write(`${result.output}\n`);
    if (result.status === 'failed') {
      return block({
        hook: HOOK,
        reason: `${bin} failed on ${rel}. Fix it before moving on:\n${tail(result.output, 60)}`,
        input,
        target: rel,
      });
    }
  }
}

main();
