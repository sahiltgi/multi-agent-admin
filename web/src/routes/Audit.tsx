// /audit (spec web-shell, rule 15): GET /audit/:requestId as returned. Rows show eventType, `at`
// and the actor; the payload is never rendered. Keyed by persona in the parent, which keeps the last
// loaded id so a switch re-sends it (rule 4).
import type { TraceResponse } from '@hr/shared';
import { useEffect, useState } from 'react';
import { getTrace, type ApiResult } from '../api/client.js';
import { Empty, ErrorState, Loading } from '../components/states.js';
import { usePersona } from '../persona/context.js';
import { TEXT } from '../texts.js';

interface LoadRequest {
  id: string;
}

export function Audit({
  lastRequestId,
  onLoad,
}: {
  lastRequestId: string | null;
  onLoad: (requestId: string) => void;
}) {
  const { persona } = usePersona();
  const employeeId = persona.employeeId;
  const [input, setInput] = useState(lastRequestId ?? '');
  const [request, setRequest] = useState<LoadRequest | null>(
    lastRequestId === null ? null : { id: lastRequestId },
  );
  const [result, setResult] = useState<{
    for: LoadRequest;
    r: ApiResult<TraceResponse>;
  } | null>(null);

  useEffect(() => {
    if (request === null) return;
    const ac = new AbortController();
    void getTrace(request.id, { employeeId, signal: ac.signal }).then((r) => {
      if (r.ok || r.kind !== 'aborted') setResult({ for: request, r });
    });
    return () => {
      ac.abort();
    };
  }, [employeeId, request]);

  const trimmed = input.trim();
  const current = result !== null && result.for === request ? result.r : null;

  return (
    <section>
      <h1 className="page-title">Audit trail</h1>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed === '') return;
          setRequest({ id: trimmed }); // a new object, so loading the same id again refetches
          onLoad(trimmed);
        }}
      >
        <input
          type="text"
          aria-label="Request id"
          className="mono"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
          }}
        />
        <button type="submit" className="primary" disabled={trimmed === ''}>
          Load
        </button>
      </form>
      {request === null ? (
        <Empty text={TEXT.auditIdle} />
      ) : current === null ? (
        <Loading />
      ) : !current.ok ? (
        <ErrorState failure={current} />
      ) : current.data.events.length === 0 ? (
        <Empty text={TEXT.auditEmpty} />
      ) : (
        <ol className="rows">
          {current.data.events.map((e) => (
            <li key={e.id} className="row">
              <span>{e.eventType}</span>
              <span className="mono">{e.at}</span>
              <span className="mono">{e.actor.kind}</span>
              <span className="mono">{e.actor.id}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
