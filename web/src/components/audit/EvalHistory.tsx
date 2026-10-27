// Eval pass rate over time (spec audit-view, rule 22): one table per series, rows in the server's
// order. The browser computes no pass rate, average, trend or threshold result; it only formats.
import type { EvalHistoryResponse } from '@hr/shared';
import { TEXT } from '../../texts.js';
import { Empty } from '../states.js';

/** The eval runner's rate format (eval-runner rule 21): `92.3%`, or the given text for null. */
function formatRate(rate: number | null, missing: string): string {
  return rate === null ? missing : `${(rate * 100).toFixed(1)}%`;
}

const COLUMNS = [
  TEXT.colStarted,
  TEXT.colModel,
  TEXT.colPassRate,
  TEXT.colPassedScored,
  TEXT.colThreshold,
  TEXT.colThresholdsMet,
];

export function EvalHistory({ data }: { data: EvalHistoryResponse }) {
  return (
    <>
      {data.skippedFiles > 0 ? (
        <p className="muted">{`${String(data.skippedFiles)} ${TEXT.evalsSkipped}`}</p>
      ) : null}
      {data.series.length === 0 ? (
        <Empty text={TEXT.evalsEmpty} />
      ) : (
        data.series.map((s) => (
          <section key={`${s.agent} ${s.promptVersion}`} className="eval-series">
            <h2 className="section-title">{`${s.agent} · ${s.promptVersion}`}</h2>
            <table className="ledger-table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.points.map((p) => (
                  <tr key={p.file}>
                    <td className="mono">{p.startedAt}</td>
                    <td className="mono">{p.model}</td>
                    <td className="mono">{formatRate(p.passRate, TEXT.rateMissing)}</td>
                    <td className="mono">{`${String(p.passed)} / ${String(p.scored)}`}</td>
                    <td className="mono">{formatRate(p.threshold, TEXT.thresholdMissing)}</td>
                    <td>{p.thresholdsMet ? TEXT.yes : TEXT.no}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </>
  );
}
