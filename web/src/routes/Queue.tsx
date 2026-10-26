// /queue (spec web-shell, rule 14): GET /approvals as returned, read-only. The parent keys this
// route by persona, so a switch remounts it: old rows go and the unmount aborts the old call.
import type { ApprovalItemView, ListApprovalsResponse } from '@hr/shared';
import { useEffect, useState } from 'react';
import { getApprovals, type ApiResult } from '../api/client.js';
import { Empty, ErrorState, Loading } from '../components/states.js';
import { VerdictBadge } from '../components/VerdictBadge.js';
import { usePersona } from '../persona/context.js';
import { TEXT } from '../texts.js';

/** The gate result to show: the item's own, else an escalation's Q&A gate result (OQ-2). Never computed. */
function shownGate(v: ApprovalItemView): { verdict: string; policyVersion: string } | null {
  if (v.gateResult !== null) return v.gateResult;
  if (v.item.kind === 'escalation' && v.question?.gateResult) return v.question.gateResult;
  return null;
}

function Row({ view }: { view: ApprovalItemView }) {
  const gate = shownGate(view);
  return (
    <li className="row">
      <span className="mono">{view.item.id}</span>
      <span>{view.item.kind}</span>
      <span className="mono">{view.item.status}</span>
      {gate === null ? (
        <span className="muted">{TEXT.noGateResult}</span>
      ) : (
        <>
          <VerdictBadge verdict={gate.verdict} />
          <span className="mono">{gate.policyVersion}</span>
        </>
      )}
      <span className="mono">{view.item.subjectId}</span>
    </li>
  );
}

export function Queue() {
  const { persona } = usePersona();
  const employeeId = persona.employeeId;
  const [result, setResult] = useState<ApiResult<ListApprovalsResponse> | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void getApprovals({ employeeId, signal: ac.signal }).then((r) => {
      if (r.ok || r.kind !== 'aborted') setResult(r);
    });
    return () => {
      ac.abort();
    };
  }, [employeeId]);

  return (
    <section>
      <h1 className="page-title">Approval queue</h1>
      {result === null ? (
        <Loading />
      ) : !result.ok ? (
        <ErrorState failure={result} />
      ) : result.data.items.length === 0 ? (
        <Empty text={TEXT.queueEmpty} />
      ) : (
        <ul className="rows">
          {result.data.items.map((v) => (
            <Row key={v.item.id} view={v} />
          ))}
        </ul>
      )}
    </section>
  );
}
