import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readLog, runHook, tempDir } from './run-hook.js';

// Each test uses a stub package.json in a temp dir, so the hook never runs the real suite
// (which would include this file and recurse).
let root: string;
let log: string;

beforeEach(() => {
  root = tempDir('stop');
  log = join(root, 'blocked.jsonl');
});

function stub(scripts: { typecheck: string; test: string }) {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'stub', scripts }));
}

function stop(stopHookActive: boolean) {
  return runHook(
    'stop-check.mjs',
    { session_id: 'test-session', hook_event_name: 'Stop', stop_hook_active: stopHookActive },
    { CLAUDE_PROJECT_DIR: root, HOOK_BLOCK_LOG: log },
  );
}

const pass = 'node -e ""';
const fail = 'node -e "console.log(\'1 test failed\'); process.exit(1)"';

describe('stop-check', () => {
  it('lets Claude stop when stop_hook_active is true, without running checks', () => {
    stub({ typecheck: fail, test: fail });
    expect(stop(true).status).toBe(0);
    expect(readLog(log)).toHaveLength(0);
  });

  it('exits 0 when typecheck and tests pass', () => {
    stub({ typecheck: pass, test: pass });
    expect(stop(false).status).toBe(0);
    expect(readLog(log)).toHaveLength(0);
  });

  it('exits 2 when the tests fail', () => {
    stub({ typecheck: pass, test: fail });
    const result = stop(false);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('`npm test` failed');
    expect(result.stderr).toContain('1 test failed');
    expect(readLog(log)).toMatchObject([{ hook: 'stop-check', event: 'Stop', target: 'npm test' }]);
  });

  it('exits 2 when typecheck fails', () => {
    stub({ typecheck: fail, test: pass });
    const result = stop(false);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('`npm run typecheck` failed');
  });

  it('exits 1 (non-blocking) on malformed stdin', () => {
    const result = runHook('stop-check.mjs', 'nope', {
      CLAUDE_PROJECT_DIR: root,
      HOOK_BLOCK_LOG: log,
    });
    expect(result.status).toBe(1);
  });
});
