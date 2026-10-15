// PreToolUse hook for file edits: blocks writes to secrets, CI and Claude Code config, and
// blocks policy edits until gate tests or evals have changed (HARD RULE 5, brief §9).
import { spawnSync } from 'node:child_process';
import { block, getString, projectRoot, readInput, relPath } from './lib.mjs';

const HOOK = 'guard-files';

/** @type {{ matches: (path: string) => boolean, what: string }[]} */
const HUMAN_ONLY = [
  { matches: (p) => /(?:^|\/)\.env[^/]*$/.test(p), what: 'environment files can hold secrets' },
  { matches: (p) => p.startsWith('.github/workflows/'), what: 'CI workflows' },
  {
    matches: (p) => p === '.claude/settings.json' || p === '.claude/settings.local.json',
    what: 'Claude Code settings define the guardrails',
  },
  {
    matches: (p) => p.startsWith('.claude/hooks/'),
    what: 'Claude Code hooks enforce the guardrails',
  },
];

const POLICY_FILE = /^policies\/.+\.ya?ml$/;
const TESTS_FIRST =
  'Update tests first: change server/src/gate/**/*.test.ts or add cases under evals/, then edit the policy (HARD RULE 5).';

/**
 * True when a gate test or an eval has changed in the working tree (staged, unstaged or untracked).
 * Returns null when git cannot answer, for example outside a git repository.
 * @param {string} root
 * @returns {boolean | null}
 */
function testsOrEvalsChanged(root) {
  const res = spawnSync(
    'git',
    ['status', '--porcelain=v1', '-uall', '--', 'server/src/gate', 'evals'],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.error !== undefined || res.status !== 0) return null;
  return res.stdout
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).split(' -> ').at(-1)?.replace(/^"|"$/g, '') ?? '')
    .some(
      (p) => p.startsWith('evals/') || (p.startsWith('server/src/gate/') && p.endsWith('.test.ts')),
    );
}

function main() {
  const input = readInput();
  if (input === null) {
    return block({
      hook: HOOK,
      reason: 'guard-files: could not parse the hook input, so the edit is blocked to be safe.',
      input,
      target: undefined,
    });
  }
  const file =
    getString(input.tool_input, 'file_path') ?? getString(input.tool_input, 'notebook_path');
  if (file === undefined) return;
  const root = projectRoot(input);
  const rel = relPath(root, file);
  if (rel === null) return;

  const rule = HUMAN_ONLY.find((r) => r.matches(rel));
  if (rule !== undefined) {
    return block({
      hook: HOOK,
      reason: `Blocked: editing ${rel} requires a human (${rule.what}). Ask the user to make this change.`,
      input,
      target: rel,
    });
  }

  if (POLICY_FILE.test(rel)) {
    const changed = testsOrEvalsChanged(root);
    if (changed === null) {
      return block({
        hook: HOOK,
        reason: `Blocked: ${rel} is a policy file and git can't show what changed (not a git repository?). ${TESTS_FIRST}`,
        input,
        target: rel,
      });
    }
    if (!changed) {
      return block({ hook: HOOK, reason: `Blocked: ${rel}. ${TESTS_FIRST}`, input, target: rel });
    }
  }
}

main();
