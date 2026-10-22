// Results file and summary lines (spec eval-runner, rules 19, 21; D-14). The file is created
// exclusively and never overwrites an earlier run; stdout carries counts, ids and the path only.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bucket, EvalRun } from './schemas.js';

/** Writes `<date>.json`, or `<date>-2.json`, `-3`… when the name is taken. Returns the path. */
export function writeResults(evalsDir: string, date: string, run: EvalRun): string {
  const dir = join(evalsDir, 'results');
  // A link could send the results outside evals/ (rule 19).
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new Error('evals/results must be a directory, not a link');
  }
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(run, null, 2)}\n`;
  for (let n = 1; ; n += 1) {
    const path = join(dir, n === 1 ? `${date}.json` : `${date}-${String(n)}.json`);
    try {
      writeFileSync(path, text, { flag: 'wx' });
      return path;
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
    }
  }
}

function bucketLine(agent: string, name: string, b: Bucket): string {
  const scored = b.passed + b.failed + b.errored + b.unscorable;
  const rate = b.passRate === null ? 'n/a' : b.passRate.toFixed(3);
  const threshold = b.threshold === null ? 'none' : String(b.threshold);
  const met = b.meetsThreshold === null ? '-' : b.meetsThreshold ? 'met' : 'MISSED';
  return `evals: ${agent} ${name}: ${String(b.passed)}/${String(scored)} passed, ${String(b.skipped)} skipped, rate ${rate}, threshold ${threshold}, ${met}`;
}

export function summaryLines(run: EvalRun, resultsPath: string): string[] {
  const lines: string[] = [];
  for (const a of run.agents) {
    lines.push(bucketLine(a.agent, 'overall', a.overall));
    for (const [name, b] of Object.entries(a.categories)) lines.push(bucketLine(a.agent, name, b));
    for (const [name, b] of Object.entries(a.tags))
      lines.push(bucketLine(a.agent, `tag ${name}`, b));
    if (a.unreviewed.total > 0) lines.push(bucketLine(a.agent, 'unreviewed', a.unreviewed));
  }
  const notPassed = run.cases
    .filter((c) => c.status !== 'passed' && c.status !== 'skipped')
    .map((c) => `${c.agent}/${c.id} (${c.status})`);
  lines.push(`evals: not passed: ${notPassed.length === 0 ? 'none' : notPassed.join(', ')}`);
  lines.push(`evals: thresholds ${run.thresholdsMet ? 'met' : 'missed'}`);
  lines.push(`evals: results written to ${resultsPath}`);
  return lines;
}
