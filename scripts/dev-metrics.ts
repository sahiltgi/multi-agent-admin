// Dev metrics (spec dev-metrics): AI-assisted commits, reverts, local hook blocks and AI_LOG rules,
// written to docs/dev-metrics.md by `npm run dev-metrics`. The exported functions are pure and do
// no I/O; main() reads git, the hook log and AI_LOG.md. The output holds counts, dates and the HEAD
// short sha only: no names, emails, subjects, bodies, trailer values or raw hook-log fields.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import { z } from 'zod';

// ---- git (rules 3–8) ----

/** No author or committer name or email is ever asked for (rule 3). */
export const GIT_LOG_ARGS: readonly string[] = [
  'log',
  '--no-merges', // D-4
  '--format=%H%x1f%h%x1f%aI%x1f%s%x1f%b%x1f%(trailers:key=Co-authored-by,valueonly)%x1e',
  'HEAD',
];

const IsoDateTime = z.iso.datetime({ offset: true });

const GitCommit = z.object({
  hash: z.string().regex(/^[0-9a-f]{40}$/),
  shortHash: z.string().regex(/^[0-9a-f]{7,40}$/),
  date: IsoDateTime, // %aI, the author date (D-4)
  subject: z.string(),
  body: z.string(),
  coAuthorTrailers: z.string(), // only checked for being non-empty (rule 5)
});
export type GitCommit = z.infer<typeof GitCommit>;

/** Rule 4: machine output, so a record that doesn't fit throws rather than being guessed at. */
export function parseGitLog(raw: string): GitCommit[] {
  const records = raw
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim() !== '');
  return records.map((record, i) => {
    const fields = record.split('\x1f');
    if (fields.length !== 6) {
      throw new Error(`git log record ${String(i + 1)} has ${String(fields.length)} fields, not 6`);
    }
    const [hash, shortHash, date, subject, body, coAuthorTrailers] = fields;
    const parsed = GitCommit.safeParse({ hash, shortHash, date, subject, body, coAuthorTrailers });
    if (!parsed.success) throw new Error(`git log record ${String(i + 1)} is not valid`);
    return parsed.data;
  });
}

// ---- weeks (rule 15) ----

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar YYYY-MM-DD as epoch ms, or null. */
function calendarDate(s: string): number | null {
  const m = BARE_DATE.exec(s);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d
    ? ms
    : null;
}

function instant(s: string): number {
  const bare = calendarDate(s);
  if (bare !== null) return bare;
  if (BARE_DATE.test(s) || !IsoDateTime.safeParse(s).success) {
    throw new Error('not an ISO date or datetime');
  }
  return Date.parse(s);
}

const DAY_MS = 86_400_000;

/** `YYYY-Www` in UTC: the ISO week of the instant (its Thursday decides the year). */
export function isoWeek(isoDateOrDateTime: string): string {
  const d = new Date(instant(isoDateOrDateTime));
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(day.getTime() + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}

const utcDay = (iso: string): string => new Date(instant(iso)).toISOString().slice(0, 10);

// ---- .claude/logs/blocked.jsonl (rules 9–11) ----

// Matches what block() in .claude/hooks/lib.mjs writes: event, tool, target and session_id are
// `?? null` (a Stop event has no tool). Only ts, hook and event are ever read (rule 11).
const BlockedLine = z.looseObject({
  ts: IsoDateTime,
  hook: z.string().min(1), // any hook name (D-4)
  event: z.enum(['PreToolUse', 'PostToolUse', 'Stop']).nullable(),
  tool: z.string().nullable(),
  reason: z.string(),
  target: z.string().nullable(),
  session_id: z.string().nullable(),
});

export type BlockedLogSummary =
  | { status: 'missing' }
  | {
      status: 'present';
      total: number;
      malformed: number;
      byHook: Record<string, number>;
      byEvent: Record<string, number>;
      firstTs: string | null;
      lastTs: string | null;
      weeks: Record<string, number>;
    };

/** Map-backed, so a hostile key such as `constructor` or `__proto__` is plain data. */
const bump = (m: Map<string, number>, key: string): void => {
  m.set(key, (m.get(key) ?? 0) + 1);
};

/** `null` means the file is missing. Only counts and the first and last `ts` are kept (rule 11). */
export function parseBlockedLog(raw: string | null): BlockedLogSummary {
  if (raw === null) return { status: 'missing' };
  let total = 0;
  let malformed = 0;
  const byHook = new Map<string, number>();
  const byEvent = new Map<string, number>();
  const weeks = new Map<string, number>();
  let first: { ts: string; at: number } | null = null;
  let last: { ts: string; at: number } | null = null;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const parsed = BlockedLine.safeParse(json);
    if (!parsed.success) {
      malformed += 1;
      continue;
    }
    const { ts, hook, event } = parsed.data; // target, reason, session_id and tool are never kept
    const at = Date.parse(ts);
    total += 1;
    bump(byHook, hook);
    bump(byEvent, event ?? 'unknown');
    bump(weeks, isoWeek(ts));
    if (first === null || at < first.at) first = { ts, at };
    if (last === null || at > last.at) last = { ts, at };
  }
  return {
    status: 'present',
    total,
    malformed,
    byHook: Object.fromEntries(byHook),
    byEvent: Object.fromEntries(byEvent),
    firstTs: first?.ts ?? null,
    lastTs: last?.ts ?? null,
    weeks: Object.fromEntries(weeks),
  };
}

// ---- AI_LOG.md (rules 12–14) ----

export interface AiLogEntry {
  date: string | null; // YYYY-MM-DD, or null when the cell isn't a valid calendar date
  addedRule: boolean;
}

/** Cells of one table row; an escaped `\|` stays inside its cell. */
function cells(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

const isRow = (line: string | undefined): line is string =>
  line?.trimStart().startsWith('|') === true;

/** A `| --- | :-: |` row. One character class, so the check stays linear. */
const isSeparator = (line: string | undefined): boolean => {
  const t = line?.trim() ?? '';
  return t.startsWith('|') && t.includes('-') && /^[\s|:-]+$/.test(t);
};

const AI_LOG_COLUMNS = ['Date', 'Fix or rule added'] as const;

/** Rule 12: the first table whose header has both columns; columns are found by name. */
export function parseAiLog(markdown: string): AiLogEntry[] {
  const lines = markdown.split('\n');
  const headerOf = (i: number): string[] => cells(lines[i] ?? '').map((c) => c.toLowerCase());
  const has = (i: number, name: string): boolean => headerOf(i).includes(name.toLowerCase());
  const tables = lines.flatMap((l, i) => (isRow(l) && isSeparator(lines[i + 1]) ? [i] : []));
  const headerAt = tables.find((i) => AI_LOG_COLUMNS.every((name) => has(i, name)));
  if (headerAt === undefined) {
    const first = tables[0];
    const missing =
      first === undefined ? [...AI_LOG_COLUMNS] : AI_LOG_COLUMNS.filter((n) => !has(first, n));
    throw new Error(`AI_LOG.md has no table with a "${missing.join('" and "')}" column`);
  }
  const header = headerOf(headerAt);
  const dateCol = header.indexOf('date');
  const fixCol = header.indexOf('fix or rule added');
  const entries: AiLogEntry[] = [];
  for (let i = headerAt + 2; isRow(lines[i]); i += 1) {
    const row = cells(lines[i] ?? '');
    const date = row[dateCol] ?? '';
    entries.push({
      date: calendarDate(date) === null ? null : date,
      addedRule: (row[fixCol] ?? '').includes('Rule:'),
    });
  }
  return entries;
}

// ---- metrics (rules 5–7, 14, 16) ----

export interface WeekRow {
  week: string;
  commits: number;
  aiAssisted: number;
  reverts: number;
  hookBlocks: number | null; // null when the log is missing
  rulesAdded: number;
}

export interface Metrics {
  headShortSha: string;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  commits: number;
  aiAssisted: number;
  reverts: number;
  revertsOfAiAssisted: number;
  blocked: BlockedLogSummary;
  aiLogEntries: number;
  aiLogRulesAdded: number;
  aiLogUndated: number;
  weeks: WeekRow[];
}

const CONVENTIONAL_REVERT = /^revert(\(.+\))?!?: /; // D-4
const REVERTS_SHA = /This reverts commit ([0-9a-f]{7,40})/g;

const isAiAssisted = (c: GitCommit): boolean => c.coAuthorTrailers.trim() !== '';

function revertedShas(c: GitCommit): string[] {
  return [...c.body.matchAll(REVERTS_SHA)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

const isRevert = (c: GitCommit): boolean =>
  c.subject.startsWith('Revert ') || // rule 6: /^Revert /, case-sensitive
  CONVENTIONAL_REVERT.test(c.subject) ||
  revertedShas(c).length > 0;

export function computeMetrics(input: {
  commits: readonly GitCommit[];
  headShortSha: string;
  blocked: BlockedLogSummary;
  aiLog: readonly AiLogEntry[];
}): Metrics {
  const { commits, blocked, aiLog } = input;
  const aiHashes = commits.filter(isAiAssisted).map((c) => c.hash);
  const rows = new Map<string, WeekRow>();
  const row = (week: string): WeekRow => {
    let r = rows.get(week);
    if (r === undefined) {
      r = {
        week,
        commits: 0,
        aiAssisted: 0,
        reverts: 0,
        hookBlocks: blocked.status === 'missing' ? null : 0,
        rulesAdded: 0,
      };
      rows.set(week, r);
    }
    return r;
  };

  let aiAssisted = 0;
  let reverts = 0;
  let revertsOfAiAssisted = 0;
  const days: string[] = [];
  for (const c of commits) {
    const r = row(isoWeek(c.date));
    days.push(utcDay(c.date));
    r.commits += 1;
    if (isAiAssisted(c)) {
      aiAssisted += 1;
      r.aiAssisted += 1;
    }
    if (isRevert(c)) {
      reverts += 1;
      r.reverts += 1;
      const ofAi = revertedShas(c).some((sha) => aiHashes.some((h) => h.startsWith(sha)));
      if (ofAi) revertsOfAiAssisted += 1;
    }
  }
  if (blocked.status === 'present') {
    for (const [week, n] of Object.entries(blocked.weeks)) {
      const r = row(week);
      r.hookBlocks = (r.hookBlocks ?? 0) + n;
    }
  }
  let aiLogUndated = 0;
  for (const e of aiLog) {
    if (e.date === null) {
      aiLogUndated += 1; // counted, but in no week (rule 14)
      continue;
    }
    if (e.addedRule) row(isoWeek(e.date)).rulesAdded += 1;
  }

  days.sort();
  const weeks = [...rows.values()]
    .filter((r) => r.commits + r.aiAssisted + r.reverts + (r.hookBlocks ?? 0) + r.rulesAdded > 0)
    .sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
  return {
    headShortSha: input.headShortSha,
    firstCommitDate: days[0] ?? null,
    lastCommitDate: days[days.length - 1] ?? null,
    commits: commits.length,
    aiAssisted,
    reverts,
    revertsOfAiAssisted,
    blocked,
    aiLogEntries: aiLog.length,
    aiLogRulesAdded: aiLog.filter((e) => e.addedRule).length,
    aiLogUndated,
    weeks,
  };
}

// ---- rendering (rules 8, 17, 18) ----

/** The hooks in .claude/hooks/, always listed, in this order (rule 17). */
const KNOWN_HOOKS = ['guard-bash', 'guard-files', 'post-edit-check', 'stop-check'] as const;
/** Hook names come from a local log, so anything unusual is shown as `(other)`, never verbatim. */
const SAFE_HOOK = /^[a-z0-9][a-z0-9-]{0,39}$/;

function hookRows(byHook: Record<string, number>): [string, number][] {
  const counts = new Map<string, number>(KNOWN_HOOKS.map((h) => [h, 0]));
  for (const [hook, n] of Object.entries(byHook)) {
    const name = SAFE_HOOK.test(hook) ? hook : '(other)';
    counts.set(name, (counts.get(name) ?? 0) + n);
  }
  const known: readonly string[] = KNOWN_HOOKS;
  const extra = [...counts.keys()].filter((h) => !known.includes(h)).sort();
  return [...KNOWN_HOOKS, ...extra].map((h) => [h, counts.get(h) ?? 0]);
}

const table = (header: string[], rows: string[][]): string =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const n = (x: number): string => String(x);

export function renderMarkdown(metrics: Metrics, opts: { generatedOn: string }): string {
  const m = metrics;
  const range =
    m.firstCommitDate === null || m.lastCommitDate === null
      ? 'n/a'
      : `${m.firstCommitDate} to ${m.lastCommitDate}, HEAD ${m.headShortSha}`;
  const share =
    m.commits === 0
      ? '0 (n/a)'
      : `${n(m.aiAssisted)} (${((m.aiAssisted / m.commits) * 100).toFixed(1)}%)`;
  const hookCell =
    m.blocked.status === 'missing'
      ? 'no local log'
      : `${n(m.blocked.total)} (malformed lines: ${n(m.blocked.malformed)})`;

  const summary: string[][] = [
    ['Commits', n(m.commits)],
    ['AI-assisted', share],
    ['Reverts', `${n(m.reverts)} (${n(m.revertsOfAiAssisted)} of AI-assisted commits)`],
    ['Hook blocks (local log)', hookCell],
    ['AI_LOG entries', n(m.aiLogEntries)],
    ['AI_LOG entries that added a rule', n(m.aiLogRulesAdded)],
  ];
  if (m.aiLogUndated > 0) summary.push(['AI_LOG entries without a valid date', n(m.aiLogUndated)]);

  const weekly = m.weeks.map((w) => [
    w.week,
    n(w.commits),
    n(w.aiAssisted),
    n(w.reverts),
    w.hookBlocks === null ? 'n/a' : n(w.hookBlocks),
    n(w.rulesAdded),
  ]);

  const hooks =
    m.blocked.status === 'missing'
      ? 'No local log at .claude/logs/blocked.jsonl.'
      : [
          table(
            ['Hook', 'Blocks'],
            hookRows(m.blocked.byHook).map(([h, c]) => [h, n(c)]),
          ),
          '',
          // Dates only: times of day would show when someone works.
          `First block: ${m.blocked.firstTs === null ? 'n/a' : utcDay(m.blocked.firstTs)}. Last block: ${m.blocked.lastTs === null ? 'n/a' : utcDay(m.blocked.lastTs)}.`,
        ].join('\n');

  return [
    '# Dev metrics',
    '',
    'Generated by `npm run dev-metrics`. Do not edit by hand.',
    '',
    `Generated on ${opts.generatedOn}.`,
    '',
    `Commit range (non-merge commits reachable from HEAD): ${range}`,
    '',
    '## Summary',
    '',
    'AI-assisted means a `Co-authored-by` trailer. Reverts include conventional `revert:` commits.',
    '',
    table(['Metric', 'Value'], summary),
    '',
    '## By ISO week (UTC)',
    '',
    weekly.length === 0
      ? 'No activity.'
      : table(['Week', 'Commits', 'AI-assisted', 'Reverts', 'Hook blocks', 'Rules added'], weekly),
    '',
    '## Hook blocks by hook',
    '',
    hooks,
    '',
    'Hook blocks come only from the local, gitignored `.claude/logs/blocked.jsonl` of the machine that generated this file, so they differ between machines.',
    '',
  ].join('\n');
}

/** Rule 18: Prettier's markdown formatting, so `npm run format:check` passes on the file. */
export async function formatMarkdown(md: string, options: prettier.Options): Promise<string> {
  return prettier.format(md, { ...options, parser: 'markdown' });
}

// ---- main (rules 3, 9, 12, 18) ----

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs one step; a failure prints a fixed line naming the step, never file or log contents. */
function step<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new Error(`dev-metrics: ${name} failed`);
  }
}

function readBlockedLog(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null; // rule 9
    throw err;
  }
}

async function main(): Promise<void> {
  const commits = step('reading git log', () =>
    parseGitLog(
      // stderr is captured, never passed through: only the fixed step line is printed (rule 18).
      execFileSync('git', GIT_LOG_ARGS, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ),
  );
  const blocked = step('reading .claude/logs/blocked.jsonl', () =>
    parseBlockedLog(readBlockedLog(join(REPO_ROOT, '.claude', 'logs', 'blocked.jsonl'))),
  );
  const aiLog = step('reading AI_LOG.md', () =>
    parseAiLog(readFileSync(join(REPO_ROOT, 'AI_LOG.md'), 'utf8')),
  );
  const metrics = computeMetrics({
    commits,
    headShortSha: commits[0]?.shortHash ?? '',
    blocked,
    aiLog,
  });
  const out = join(REPO_ROOT, 'docs', 'dev-metrics.md');
  const options = (await prettier.resolveConfig(out)) ?? {};
  const md = await formatMarkdown(
    renderMarkdown(metrics, { generatedOn: new Date().toISOString().slice(0, 10) }),
    options,
  );
  step('writing docs/dev-metrics.md', () => {
    writeFileSync(out, md);
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    const message =
      err instanceof Error && err.message.startsWith('dev-metrics:')
        ? err.message
        : 'dev-metrics: failed';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
