// Pieces every approval card shares (spec approval-queue-ui, rules 3, 6–8): the head line and the
// gate fields. Strings are shown exactly as the server sent them.
import { StatusPill } from '../StatusPill.js';
import { VerdictBadge } from '../VerdictBadge.js';
import { TEXT } from '../../texts.js';
import { RuleRows } from './RuleRows.js';

/** The item id first, then the verdict badge (only when there is a gate result), then the status. */
export function CardHead({
  id,
  verdict,
  status,
}: {
  id: string;
  verdict: string | null;
  status: string;
}) {
  return (
    <header className="card-head">
      <span className="mono">{id}</span>
      {verdict === null ? null : <VerdictBadge verdict={verdict} />}
      <StatusPill status={status} />
    </header>
  );
}

interface Gate {
  policyVersion: string;
  ruleResults: readonly { ruleId: string; passed: boolean; message: string }[];
}

/** `Rules` and `Policy`, or the fixed `No gate result`. */
export function GateFields({ gate }: { gate: Gate | null }) {
  if (gate === null) return <p className="muted">{TEXT.noGateResult}</p>;
  return (
    <dl className="fields">
      <dt>{TEXT.labelRules}</dt>
      <dd>
        <RuleRows rows={gate.ruleResults} />
      </dd>
      <dt>{TEXT.labelPolicy}</dt>
      <dd className="mono">{gate.policyVersion}</dd>
    </dl>
  );
}
