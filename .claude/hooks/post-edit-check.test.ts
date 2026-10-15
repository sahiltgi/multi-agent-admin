import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLog, runHook, tempDir } from './run-hook.js';

// These cases run the real Prettier/ESLint/Vitest against the repo, so they are slower.
const repo = resolve(import.meta.dirname, '..', '..');
const fixture = join(repo, 'server', 'src', '__hook_fixture__.ts');
let log: string;

beforeEach(() => {
  log = join(tempDir('post'), 'blocked.jsonl');
});

afterEach(() => {
  rmSync(fixture, { force: true });
});

function postEdit(toolInput: Record<string, unknown>) {
  return runHook(
    'post-edit-check.mjs',
    {
      session_id: 'test-session',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: toolInput,
      tool_response: { success: true },
    },
    { CLAUDE_PROJECT_DIR: repo, HOOK_BLOCK_LOG: log },
  );
}

describe('post-edit-check', () => {
  it('exits 0 when there is no file_path', () => {
    expect(postEdit({}).status).toBe(0);
  });

  it('exits 0 for a file that no longer exists', () => {
    expect(postEdit({ file_path: join(repo, 'server/src/missing.ts') }).status).toBe(0);
  });

  it('exits 0 for a file outside the project', () => {
    expect(postEdit({ file_path: '/somewhere/else/file.ts' }).status).toBe(0);
  });

  it('exits 0 for a clean file', { timeout: 30_000 }, () => {
    const result = postEdit({ file_path: join(repo, 'scripts/test-one.mjs') });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readLog(log)).toHaveLength(0);
  });

  it('exits 2 with the ESLint output for a lint error', { timeout: 30_000 }, () => {
    writeFileSync(fixture, 'export const value: any = 1;\n');
    const result = postEdit({ file_path: fixture });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('eslint failed on server/src/__hook_fixture__.ts');
    expect(result.stderr).toContain('no-explicit-any');
    expect(readLog(log)).toMatchObject([
      { hook: 'post-edit-check', event: 'PostToolUse', target: 'server/src/__hook_fixture__.ts' },
    ]);
  });

  it('exits 1 (non-blocking) on malformed stdin', () => {
    const result = runHook('post-edit-check.mjs', '', {
      CLAUDE_PROJECT_DIR: repo,
      HOOK_BLOCK_LOG: log,
    });
    expect(result.status).toBe(1);
  });
});
