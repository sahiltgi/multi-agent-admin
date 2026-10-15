// PreToolUse hook for Bash: blocks destructive or check-skipping commands (brief §9).
// Matches command text, so it is a guardrail, not a security boundary. False positives
// such as `echo "rm -rf"` are accepted: the guard fails safe.
import { block, getString, readInput } from './lib.mjs';

const HOOK = 'guard-bash';

const SHELL = String.raw`(?:sudo\s+)?(?:\S*/)?(?:ba|z|da|k)?sh\b`;
const PIPE_TO_SHELL = new RegExp(String.raw`\b(?:curl|wget)\b[^|]*\|\s*${SHELL}`);
const SHELL_ON_DOWNLOAD = /\b(?:ba|z|da|k)?sh\b[^;&|]*(?:<\(|\$\(|`)\s*(?:curl|wget)\b/;
const SQL_DROP = /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|COLLECTION|INDEX|VIEW|USER)\b/i;

/**
 * Arguments after `git … <sub>`, or null when the tokens are not that git subcommand.
 * @param {string[]} tokens
 * @param {string} sub
 * @returns {string[] | null}
 */
function gitArgs(tokens, sub) {
  const git = tokens.findIndex((t) => t === 'git' || t.endsWith('/git'));
  if (git === -1) return null;
  const at = tokens.indexOf(sub, git + 1);
  return at === -1 ? null : tokens.slice(at + 1);
}

/**
 * True for `rm` with both a recursive and a force flag, in any spelling or order.
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isRecursiveForceRm(tokens) {
  const rm = tokens.findIndex((t) => t === 'rm' || t.endsWith('/rm'));
  if (rm === -1) return false;
  let recursive = false;
  let force = false;
  for (const t of tokens.slice(rm + 1)) {
    if (t === '--') break;
    if (t === '--recursive') recursive = true;
    else if (t === '--force') force = true;
    else if (/^-[a-zA-Z]+$/.test(t)) {
      if (/[rR]/.test(t)) recursive = true;
      if (t.includes('f')) force = true;
    }
  }
  return recursive && force;
}

/**
 * Reason one simple command (no pipes) must be blocked, or null.
 * @param {string} part
 * @returns {string | null}
 */
function checkSimpleCommand(part) {
  const tokens = part.trim().split(/\s+/);
  if (isRecursiveForceRm(tokens)) {
    return 'Blocked: `rm` with recursive + force flags can delete large parts of the tree with no undo. Remove specific paths instead, or ask the user to run it.';
  }
  const push = gitArgs(tokens, 'push');
  if (
    push?.some((t) => t.startsWith('--force') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) || /^\+./.test(t))
  ) {
    return 'Blocked: force push rewrites shared history. Push normally, or ask the user to force push.';
  }
  if (gitArgs(tokens, 'reset')?.includes('--hard')) {
    return 'Blocked: `git reset --hard` discards uncommitted work. Use `git stash` or `git restore <path>`, or ask the user.';
  }
  if (gitArgs(tokens, 'commit')?.some((t) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t))) {
    return 'Blocked: `git commit -n` skips commit hooks. Commit without it and fix what the hooks report.';
  }
  return null;
}

/**
 * Reason the command must be blocked, or null when it is allowed.
 * @param {string} command
 * @returns {string | null}
 */
function findViolation(command) {
  if (/(?:^|\s)--no-verify\b/.test(command)) {
    return 'Blocked: `--no-verify` skips git hooks. Run the command without it and fix what the hooks report.';
  }
  if (/\bdropDatabase\b/.test(command) || /\.drop\s*\(/.test(command) || SQL_DROP.test(command)) {
    return 'Blocked: dropping a database, collection or table destroys data. Ask the user to do it by hand.';
  }
  // Split on ; && || and newlines, but not a single |, so `curl … | sh` stays in one chunk.
  for (const chunk of command.split(/\|\||&&|;|\n/)) {
    if (PIPE_TO_SHELL.test(chunk) || SHELL_ON_DOWNLOAD.test(chunk)) {
      return 'Blocked: piping a download into a shell runs unreviewed code. Download the script, read it, then ask the user.';
    }
    for (const part of chunk.split('|')) {
      const reason = checkSimpleCommand(part);
      if (reason !== null) return reason;
    }
  }
  return null;
}

function main() {
  const input = readInput();
  if (input === null) {
    return block({
      hook: HOOK,
      reason: 'guard-bash: could not parse the hook input, so the command is blocked to be safe.',
      input,
      target: undefined,
    });
  }
  const command = getString(input.tool_input, 'command');
  if (command === undefined) return;
  const reason = findViolation(command);
  if (reason !== null) block({ hook: HOOK, reason, input, target: command });
}

main();
