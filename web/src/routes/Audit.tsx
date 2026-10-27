// /audit (spec audit-view, rules 19–25; extends web-shell rule 15): three tabs. Trace loads
// GET /audit/:requestId/timeline on Load; Evals and How this was built each fetch once, the first
// time they are selected. All three tabs' data lives here, so switching tabs keeps it. Keyed by
// persona in the parent, which keeps the last loaded id and the selected tab: a switch aborts every
// call, drops all data and refetches only the selected tab (rule 24).
import type { BuildNotesResponse, EvalHistoryResponse, TraceTimelineResponse } from '@hr/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { getBuildNotes, getEvalHistory, getTimeline, type ApiResult } from '../api/client.js';
import { AiLogTable } from '../components/audit/AiLogTable.js';
import { AuditTabs, type AuditTab } from '../components/audit/AuditTabs.js';
import { DocBlocks } from '../components/audit/DocBlocks.js';
import { EvalHistory } from '../components/audit/EvalHistory.js';
import { Timeline } from '../components/audit/Timeline.js';
import { Empty, ErrorState, Loading } from '../components/states.js';
import { usePersona } from '../persona/context.js';
import { TEXT } from '../texts.js';

interface LoadRequest {
  id: string;
}

type Fetcher<T> = (opts: { employeeId: string; signal: AbortSignal }) => Promise<ApiResult<T>>;

/** One call per mount once `wanted` turns true; aborted on unmount (a persona switch). */
function useOnce<T>(wanted: boolean, employeeId: string, fetcher: Fetcher<T>): ApiResult<T> | null {
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  useEffect(() => {
    if (!wanted) return;
    const ac = new AbortController();
    void fetcher({ employeeId, signal: ac.signal }).then((r) => {
      if (r.ok || r.kind !== 'aborted') setResult(r);
    });
    return () => {
      ac.abort();
    };
  }, [wanted, employeeId, fetcher]);
  return result;
}

function States<T>({
  result,
  children,
}: {
  result: ApiResult<T> | null;
  children: (data: T) => ReactNode;
}) {
  if (result === null) return <Loading />;
  if (!result.ok) return <ErrorState failure={result} />;
  return <>{children(result.data)}</>;
}

function BuildNotes({ data }: { data: BuildNotesResponse }) {
  const { devMetrics } = data;
  return (
    <>
      {devMetrics.status === 'ok' ? (
        <DocBlocks blocks={devMetrics.blocks} />
      ) : devMetrics.status === 'missing' ? (
        <Empty text={TEXT.devMetricsMissing} />
      ) : (
        <Empty text={TEXT.docUnreadable} />
      )}
      <AiLogTable state={data.aiLog} />
    </>
  );
}

export function Audit({
  lastRequestId,
  onLoad,
  tab,
  onTab,
}: {
  lastRequestId: string | null;
  onLoad: (requestId: string) => void;
  tab: AuditTab;
  onTab: (tab: AuditTab) => void;
}) {
  const { persona } = usePersona();
  const employeeId = persona.employeeId;
  // The tabs selected at least once since mount: each fetches on its first selection (rule 19).
  const [seen, setSeen] = useState<ReadonlySet<AuditTab>>(() => new Set([tab]));

  const [input, setInput] = useState(lastRequestId ?? '');
  const [request, setRequest] = useState<LoadRequest | null>(
    tab === 'trace' && lastRequestId !== null ? { id: lastRequestId } : null,
  );
  const [trace, setTrace] = useState<{
    for: LoadRequest;
    r: ApiResult<TraceTimelineResponse>;
  } | null>(null);

  useEffect(() => {
    if (request === null) return;
    const ac = new AbortController();
    void getTimeline(request.id, { employeeId, signal: ac.signal }).then((r) => {
      if (r.ok || r.kind !== 'aborted') setTrace({ for: request, r });
    });
    return () => {
      ac.abort();
    };
  }, [employeeId, request]);

  const evals = useOnce<EvalHistoryResponse>(seen.has('evals'), employeeId, getEvalHistory);
  const notes = useOnce<BuildNotesResponse>(seen.has('build'), employeeId, getBuildNotes);

  function select(next: AuditTab): void {
    onTab(next);
    if (seen.has(next)) return;
    setSeen(new Set([...seen, next]));
    // After a persona switch, Trace re-sends the last loaded id the first time it is selected.
    if (next === 'trace' && request === null && lastRequestId !== null) {
      setRequest({ id: lastRequestId });
    }
  }

  const trimmed = input.trim();
  const current = trace !== null && trace.for === request ? trace.r : null;

  function tracePanel(): ReactNode {
    return (
      <>
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
        ) : (
          <States result={current}>{(data) => <Timeline data={data} />}</States>
        )}
      </>
    );
  }

  return (
    <section>
      <h1 className="page-title">Audit trail</h1>
      <AuditTabs
        tab={tab}
        onTab={select}
        renderPanel={(t) =>
          t === 'trace' ? (
            tracePanel()
          ) : t === 'evals' ? (
            <States result={evals}>{(data) => <EvalHistory data={data} />}</States>
          ) : (
            <States result={notes}>{(data) => <BuildNotes data={data} />}</States>
          )
        }
      />
    </section>
  );
}
