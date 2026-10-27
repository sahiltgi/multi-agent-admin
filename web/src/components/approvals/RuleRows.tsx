// One row per gate rule result, rendered verbatim (spec approval-queue-ui, rule 5). The glyph is
// the only thing derived from `passed`; `expected`, `actual` and the gate's reason are never shown.
import { TEXT } from '../../texts.js';

interface Row {
  ruleId: string;
  passed: boolean;
  message: string;
}

export function RuleRows({ rows }: { rows: readonly Row[] }) {
  return (
    <ul className="rule-rows">
      {rows.map((r, i) => (
        <li key={`${String(i)}-${r.ruleId}`} className="rule-row">
          <span className="rule-glyph" data-passed={r.passed ? 'true' : 'false'}>
            <span aria-hidden="true">{r.passed ? '✓' : '✗'}</span>
            <span className="visually-hidden">{r.passed ? TEXT.rulePassed : TEXT.ruleFailed}</span>
          </span>
          <span className="mono">{r.ruleId}</span>
          <span className="pre">{r.message}</span>
        </li>
      ))}
    </ul>
  );
}
