// Stop hook: typecheck and the full test suite must pass before Claude finishes.
// Exit 2 makes Claude keep working. stop_hook_active means Claude is already continuing
// because of this hook, so let it stop rather than loop forever.
import { spawnSync } from 'node:child_process';
import { block, projectRoot, readInput, tail } from './lib.mjs';

const HOOK = 'stop-check';

/** @type {string[][]} */
const CHECKS = [['run', 'typecheck'], ['test']];

function main() {
  const input = readInput();
  if (input === null) {
    process.stderr.write('stop-check: could not parse the hook input\n');
    process.exit(1);
  }
  if (input.stop_hook_active === true) return;
  const root = projectRoot(input);

  for (const args of CHECKS) {
    const command = `npm ${args.join(' ')}`;
    const res = spawnSync('npm', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    if (res.status !== 0) {
      const output = res.error === undefined ? `${res.stdout}\n${res.stderr}` : res.error.message;
      return block({
        hook: HOOK,
        reason: `\`${command}\` failed. Fix it before finishing:\n${tail(output, 60)}`,
        input,
        target: command,
      });
    }
  }
}

main();
