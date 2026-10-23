// Results files and the stdout summary (spec eval-runner, rules 19, 21; D-14, D-18, D-22, D-24).
// Each file is created exclusively and never overwrites an earlier run; stdout carries counts,
// rates, ids and paths only, never case text.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bucket, EvalRun, RateMetric } from './schemas.js';

/** Creates one file exclusively; throws an error with code EEXIST when the path is taken. */
export type WriteFile = (path: string, text: string) => void;

export const writeExclusive: WriteFile = (path, text) => {
  writeFileSync(path, text, { flag: 'wx' });
};

/** Writes `<base>.json`, or `<base>-2.json`, `-3`… when the name is taken. Returns the path. */
export function writeResults(
  evalsDir: string,
  base: string,
  run: EvalRun,
  writeFile: WriteFile,
): string {
  const dir = join(evalsDir, 'results');
  // A link could send the results outside evals/ (rule 19).
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error('evals/results must be a directory, not a link');
  }
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(run, null, 2)}\n`;
  for (let n = 1; ; n += 1) {
    const path = join(dir, n === 1 ? `${base}.json` : `${base}-${String(n)}.json`);
    try {
      writeFile(path, text);
      return path;
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
    }
  }
}

type Row = readonly [string, string, string, string, string, string, string];
const HEADER: Row = ['Agent', 'Metric', 'Scored', 'Passed', 'Rate', 'Threshold', 'Met'];

const pct = (v: number | null, none: string): string =>
  v === null ? none : `${(v * 100).toFixed(1)}%`;
const met = (m: boolean | null): string => (m === null ? '-' : m ? 'yes' : 'no');

function bucketRow(agent: string, metric: string, b: Bucket): Row {
  const scored = b.passed + b.failed + b.errored + b.unscorable;
  return [
    agent,
    metric,
    String(scored),
    String(b.passed),
    pct(b.passRate, 'n/a'),
    pct(b.threshold, '-'),
    met(b.meetsThreshold),
  ];
}

function rateRow(
  agent: string,
  metric: string,
  scored: number,
  passed: number,
  m: RateMetric,
): Row {
  return [
    agent,
    metric,
    String(scored),
    String(passed),
    pct(m.value, 'n/a'),
    pct(m.threshold, '-'),
    met(m.meetsThreshold),
  ];
}

function rowsOf(run: EvalRun): Row[] {
  const { agent, summary: s } = run;
  const rows = Object.entries(s.categories).map(([name, b]) => bucketRow(agent, name, b));
  for (const [name, b] of Object.entries(s.tags)) rows.push(bucketRow(agent, `tag:${name}`, b));
  const e = s.escalation;
  if (e !== null) {
    rows.push(rateRow(agent, 'escalation_precision', e.tp + e.fp, e.tp, e.precision));
    rows.push(rateRow(agent, 'escalation_recall', e.tp + e.fn, e.tp, e.recall));
  }
  rows.push(bucketRow(agent, 'overall', s.overall));
  return rows;
}

/** The fixed-width table, then tokens and cost per agent, failed (agent, id) keys and paths. */
export function summaryLines(runs: readonly EvalRun[], paths: readonly string[]): string[] {
  const rows = [HEADER, ...runs.flatMap(rowsOf)];
  const widths = HEADER.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  const lines = rows.map((r) =>
    r
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join(' | ')
      .trimEnd(),
  );
  for (const run of runs) {
    const { tokens, costUsd } = run.summary;
    lines.push(
      `${run.agent}: tokens ${String(tokens.input)}/${String(tokens.output)}, cost $${costUsd.toFixed(4)}`,
    );
  }
  const notPassed = runs
    .flatMap((r) => r.cases)
    .filter((c) => c.status !== 'passed' && c.status !== 'skipped')
    .map((c) => `${c.agent}/${c.id} (${c.status})`);
  lines.push(`evals: not passed: ${notPassed.length === 0 ? 'none' : notPassed.join(', ')}`);
  lines.push(`evals: thresholds ${runs.every((r) => r.thresholdsMet) ? 'met' : 'missed'}`);
  for (const p of paths) lines.push(`evals: results written to ${p}`);
  return lines;
}
