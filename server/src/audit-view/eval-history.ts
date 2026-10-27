// Eval pass rate over time (spec audit-view, rules 12–14). Pure: each results file is parsed as
// an EvalRun and only its summary is used. Nothing is computed beyond the runner's own "Scored"
// sum (eval-runner rule 21); a null pass rate stays null.
import { EvalRun } from '../evals/schemas.js';
import type { FileRead } from './ports.js';
import {
  EvalAgentName,
  EvalPoint,
  RESULT_FILE_RE,
  SafeToken,
  type EvalHistoryResponse,
  type EvalSeries,
} from './schemas.js';

interface Parsed {
  agent: EvalAgentName;
  promptVersion: string;
  point: EvalPoint;
}

function parseFile(name: string, read: FileRead): Parsed | null {
  if (read.status !== 'ok') return null;
  const nameAgent = RESULT_FILE_RE.exec(name)?.[1];
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return null;
  }
  const run = EvalRun.safeParse(json);
  if (!run.success || run.data.agent !== nameAgent) return null;
  const { summary } = run.data;
  const o = summary.overall;
  const point = EvalPoint.safeParse({
    file: name,
    startedAt: run.data.startedAt,
    model: summary.model,
    policyVersion: summary.policyVersion,
    passRate: o.passRate,
    passed: o.passed,
    scored: o.passed + o.failed + o.errored + o.unscorable,
    threshold: o.threshold,
    thresholdsMet: run.data.thresholdsMet,
  });
  // EvalRun allows any non-empty promptVersion; the series key must be a SafeToken, or the whole
  // response would fail its schema. Such a file is skipped and counted (rule 12, OQ-5).
  const promptVersion = SafeToken.safeParse(summary.promptVersion);
  return point.success && promptVersion.success
    ? { agent: run.data.agent, promptVersion: promptVersion.data, point: point.data }
    : null;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function toEvalHistory(
  files: readonly { name: string; read: FileRead }[],
): EvalHistoryResponse {
  const groups = new Map<string, EvalSeries>();
  let skippedFiles = 0;
  for (const { name, read } of files) {
    const p = parseFile(name, read);
    if (p === null) {
      skippedFiles += 1;
      continue;
    }
    const key = JSON.stringify([p.agent, p.promptVersion]);
    const series = groups.get(key);
    if (series === undefined) {
      groups.set(key, { agent: p.agent, promptVersion: p.promptVersion, points: [p.point] });
    } else {
      series.points.push(p.point);
    }
  }
  const agentOrder = EvalAgentName.options;
  const series = [...groups.values()].sort(
    (a, b) =>
      agentOrder.indexOf(a.agent) - agentOrder.indexOf(b.agent) ||
      byCodeUnit(a.promptVersion, b.promptVersion),
  );
  for (const s of series) {
    s.points.sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || byCodeUnit(a.file, b.file),
    );
  }
  return { series, skippedFiles };
}
