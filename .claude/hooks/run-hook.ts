// Test helper: runs a hook script with JSON on stdin, the way Claude Code does.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A fresh empty directory under the OS temp dir. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `hook-${prefix}-`));
}

/**
 * Runs `script` with `input` on stdin (strings are sent as-is, anything else as JSON).
 * The child env drops any inherited CLAUDE_PROJECT_DIR / HOOK_BLOCK_LOG, because the suite
 * may itself run inside a Claude Code session; each test sets its own values in `env`.
 */
export function runHook(script: string, input: unknown, env: Record<string, string>): HookResult {
  const base = { ...process.env };
  delete base.CLAUDE_PROJECT_DIR;
  delete base.HOOK_BLOCK_LOG;
  const res = spawnSync(process.execPath, [join(import.meta.dirname, script)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Parsed lines of a block log; [] when the log doesn't exist. */
export function readLog(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}
