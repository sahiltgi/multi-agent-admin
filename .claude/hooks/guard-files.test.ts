import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readLog, runHook, tempDir } from './run-hook.js';

let root: string;
let log: string;

beforeEach(() => {
  root = tempDir('files');
  log = join(root, 'blocked.jsonl');
});

function edit(filePath: string, toolName = 'Edit') {
  const tool_input =
    toolName === 'NotebookEdit' ? { notebook_path: filePath } : { file_path: filePath };
  return runHook(
    'guard-files.mjs',
    { session_id: 'test-session', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input },
    { CLAUDE_PROJECT_DIR: root, HOOK_BLOCK_LOG: log },
  );
}

function write(rel: string, content = 'x\n') {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(...args: string[]) {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, stdio: 'ignore' },
  );
}

/** A git repo with one committed policy file and a clean working tree. */
function initRepo() {
  git('init', '-q');
  write('policies/leave.yaml', 'version: 1\n');
  write('server/src/gate/leave.ts', 'export {};\n');
  write('evals/leave.json', '[]\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
}

describe('guard-files: human-only paths', () => {
  it.each([
    '.env',
    '.env.example',
    'server/.env.local',
    '.github/workflows/ci.yml',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/guard-bash.mjs',
  ])('blocks %s', (rel) => {
    const result = edit(join(root, rel), 'Write');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('requires a human');
    expect(readLog(log)).toMatchObject([{ hook: 'guard-files', tool: 'Write', target: rel }]);
  });

  it('blocks relative paths too', () => {
    expect(edit('.env').status).toBe(2);
  });

  it.each(['server/src/index.ts', 'docs/brief.md', '.claude/rules/gate.md', 'environment.ts'])(
    'allows %s',
    (rel) => {
      expect(edit(join(root, rel)).status).toBe(0);
      expect(readLog(log)).toHaveLength(0);
    },
  );

  it('allows files outside the project', () => {
    expect(edit('/somewhere/else/.env.sample').status).toBe(0);
  });

  it('checks NotebookEdit paths', () => {
    expect(edit(join(root, '.claude/hooks/x.ipynb'), 'NotebookEdit').status).toBe(2);
  });

  it('fails closed on malformed stdin', () => {
    const result = runHook('guard-files.mjs', '{', {
      CLAUDE_PROJECT_DIR: root,
      HOOK_BLOCK_LOG: log,
    });
    expect(result.status).toBe(2);
  });
});

describe('guard-files: policies need tests or evals first', () => {
  const policy = () => join(root, 'policies/leave.yaml');

  it('blocks when the project is not a git repository', () => {
    const result = edit(policy());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a git repository');
    expect(result.stderr).toContain('Update tests first');
  });

  it('blocks when nothing under server/src/gate tests or evals/ changed', () => {
    initRepo();
    const result = edit(policy());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Update tests first');
    expect(readLog(log)).toMatchObject([{ target: 'policies/leave.yaml' }]);
  });

  it('blocks when only non-test gate code changed', () => {
    initRepo();
    write('server/src/gate/leave.ts', 'export const changed = true;\n');
    expect(edit(policy()).status).toBe(2);
  });

  it('allows when a new gate test is untracked', () => {
    initRepo();
    write('server/src/gate/leave.test.ts');
    expect(edit(policy()).status).toBe(0);
  });

  it('allows when a gate test is staged', () => {
    initRepo();
    write('server/src/gate/rules/balance.test.ts');
    git('add', '.');
    expect(edit(policy()).status).toBe(0);
  });

  it('allows when an eval changed', () => {
    initRepo();
    write('evals/leave.json', '[{"case":1}]\n');
    expect(edit(policy()).status).toBe(0);
  });

  it('also covers .yml and nested policy files', () => {
    initRepo();
    expect(edit(join(root, 'policies/leave/annual.yml')).status).toBe(2);
  });
});
