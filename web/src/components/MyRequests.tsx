// "My requests" (spec employee-chat, rules 7–9). Rows are GET /my-requests as returned, in server
// order. `status` and `decision` are never rendered; the pill is the raw approvalStatus (OQ-1 (i)).
import type { MyRequestsResponse } from '@hr/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getMyRequests, type ApiFailure } from '../api/client.js';
import { TEXT } from '../texts.js';
import { Empty, ErrorState, Loading } from './states.js';
import { StatusPill } from './StatusPill.js';

export type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: MyRequestsResponse }
  | { kind: 'error'; failure: ApiFailure };

/** Fetches on mount; each refresh aborts the one in flight, and unmount aborts too. No polling. */
// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its list; Chat owns it so a leave_submitted turn can refresh it.
export function useMyRequests(employeeId: string): { state: ListState; refresh: () => void } {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const acRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    void getMyRequests({ employeeId, signal: ac.signal }).then((r) => {
      if (ac.signal.aborted || (!r.ok && r.kind === 'aborted')) return;
      setState(r.ok ? { kind: 'ready', data: r.data } : { kind: 'error', failure: r });
    });
  }, [employeeId]);

  const refresh = useCallback(() => {
    setState({ kind: 'loading' });
    load();
  }, [load]);

  // The initial state is already 'loading', so mount only starts the call.
  useEffect(() => {
    load();
    return () => {
      acRef.current?.abort();
    };
  }, [load]);

  return { state, refresh };
}

export function MyRequests({ state }: { state: ListState }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="my-requests">
      <h2 id={headingId} className="section-title">
        {TEXT.myRequests}
      </h2>
      {state.kind === 'loading' && <Loading />}
      {state.kind === 'error' && <ErrorState failure={state.failure} />}
      {state.kind === 'ready' &&
        (state.data.requests.length === 0 ? (
          <Empty text={TEXT.myRequestsEmpty} />
        ) : (
          <ol className="rows">
            {state.data.requests.map((r) => (
              <li key={r.requestId} className="row">
                <span className="mono">{r.requestId}</span>
                <span>{r.leaveType}</span>
                <span className="mono">{r.startDate}</span>
                {r.startHalf !== undefined && <span className="mono">{r.startHalf}</span>}
                <span className="mono">{r.endDate}</span>
                {r.endHalf !== undefined && <span className="mono">{r.endHalf}</span>}
                <span className="mono">{r.createdAt}</span>
                {r.approvalStatus === null ? (
                  <span className="muted">{TEXT.noApprovalItem}</span>
                ) : (
                  <StatusPill status={r.approvalStatus} />
                )}
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
