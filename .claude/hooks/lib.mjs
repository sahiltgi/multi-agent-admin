// Shared helpers for the Claude Code hooks in this folder.
// Hook contract: JSON on stdin; exit 0 = proceed, exit 2 = block (stderr goes back to Claude).
import { appendFileSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** @typedef {Record<string, unknown>} HookInput */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a string property from an unknown value, or undefined if it is missing or not a string.
 * @param {unknown} obj
 * @param {string} key
 * @returns {string | undefined}
 */
export function getString(obj, key) {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads stdin and parses it as a JSON object. Returns null when it is not one.
 * @returns {HookInput | null}
 */
export function readInput() {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(readFileSync(0, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Repo root: $CLAUDE_PROJECT_DIR, else the session cwd, else this process's cwd.
 * @param {HookInput | null} input
 * @returns {string}
 */
export function projectRoot(input) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return getString(input, 'cwd') ?? process.cwd();
}

/**
 * Path of `file` relative to `root` with forward slashes, or null when it is outside `root`.
 * @param {string} root
 * @param {string} file
 * @returns {string | null}
 */
export function relPath(root, file) {
  const rel = relative(resolve(root), resolve(root, file));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Last `lines` lines of `text`, so long tool output stays readable.
 * @param {string} text
 * @param {number} lines
 * @returns {string}
 */
export function tail(text, lines) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * Appends one JSON line to the block log, writes `reason` to stderr and exits 2.
 * Logging is best effort: a log failure never turns a block into an allow.
 * @param {{ hook: string, reason: string, input: HookInput | null, target: string | undefined }} details
 * @returns {never}
 */
export function block({ hook, reason, input, target }) {
  const logFile =
    process.env.HOOK_BLOCK_LOG ?? join(projectRoot(input), '.claude', 'logs', 'blocked.jsonl');
  const entry = {
    ts: new Date().toISOString(),
    hook,
    event: getString(input, 'hook_event_name') ?? null,
    tool: getString(input, 'tool_name') ?? null,
    reason,
    target: target === undefined ? null : target.slice(0, 500),
    session_id: getString(input, 'session_id') ?? null,
  };
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // Best effort only.
  }
  // writeSync so the message is flushed before exit.
  writeSync(2, `${reason}\n`);
  process.exit(2);
}
