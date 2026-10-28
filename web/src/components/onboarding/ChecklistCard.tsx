// One checklist (spec onboarding-ui, rules 8, 9 and 12). The summary fields, one progress bar, the
// "pending approval" marker and a disclosure for the tasks. Once a view is loaded, the fields come
// from it, so the card shows the most recent server object. The card owns its GETs and aborts
// them on unmount; the route owns the PATCH, so one action runs at a time.
import type { ChecklistView, ListOnboardingResponse } from '@hr/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getChecklist, type ApiFailure, type ApiResult } from '../../api/client.js';
import { usePersona } from '../../persona/context.js';
import { TEXT } from '../../texts.js';
import { ErrorState, Loading } from '../states.js';
import { OwnerGroups } from './OwnerGroups.js';

type Summary = ListOnboardingResponse['checklists'][number];

interface Head {
  templateId: string;
  startDate: string;
  newHireTeam: string;
  managerEmployeeId: string;
  buddyEmployeeId: string | null;
  progress: Summary['progress'];
  pending: number;
}

type Body =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'view'; view: ChecklistView }
  | { kind: 'failed'; failure: ApiFailure };

type Notice = { kind: 'none' } | { kind: 'updated' } | { kind: 'failed'; failure: ApiFailure };

function headOfSummary(s: Summary): Head {
  return { ...s, pending: s.pendingDeviations };
}

function headOfView(v: ChecklistView): Head {
  const c = v.checklist;
  return {
    templateId: c.templateId,
    startDate: c.startDate,
    newHireTeam: c.newHireTeam,
    managerEmployeeId: c.managerEmployeeId,
    buddyEmployeeId: c.buddyEmployeeId,
    progress: v.progress,
    pending: v.pendingDeviationIds.length,
  };
}

function total(progress: Head['progress'], key: 'done' | 'total' | 'blocked'): number {
  return progress.reduce((n, p) => n + p[key], 0);
}

export function PendingMarker({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="pending mono">{`${String(n)} ${TEXT.pendingApproval}`}</span>;
}

export function ChecklistCard({
  checklistId,
  summary,
  startOpen,
  busy,
  onTick,
}: {
  checklistId: string;
  summary: Summary | null;
  startOpen: boolean;
  busy: boolean;
  onTick: (checklistId: string, taskId: string) => Promise<ApiResult<ChecklistView>> | null;
}) {
  const { persona } = usePersona();
  const employeeId = persona.employeeId;
  // The latest view ever loaded: the "Just added" card has no summary to fall back on once closed.
  const [latest, setLatest] = useState<ChecklistView | null>(null);
  const [body, setBody] = useState<Body>({ kind: startOpen ? 'loading' : 'closed' });
  const [notice, setNotice] = useState<Notice>({ kind: 'none' });
  const viewCall = useRef<AbortController | null>(null);
  // Bumped by close(): a PATCH answer that arrives after the card closed doesn't reopen it.
  const opened = useRef(0);

  const fetchView = useCallback(() => {
    viewCall.current?.abort();
    const ac = new AbortController();
    viewCall.current = ac;
    void getChecklist(checklistId, { employeeId, signal: ac.signal }).then((r) => {
      if (!r.ok && r.kind === 'aborted') return;
      if (r.ok) {
        setBody({ kind: 'view', view: r.data });
        setLatest(r.data);
      } else {
        setBody({ kind: 'failed', failure: r });
      }
    });
  }, [checklistId, employeeId]);

  const open = useCallback(() => {
    setBody({ kind: 'loading' });
    setNotice({ kind: 'none' });
    fetchView();
  }, [fetchView]);

  // A card that starts open (the "Just added" card) starts in `loading`, so the effect only sends.
  useEffect(() => {
    if (startOpen) fetchView();
    return () => {
      viewCall.current?.abort();
    };
  }, [startOpen, fetchView]);

  function close(): void {
    opened.current += 1;
    viewCall.current?.abort();
    setBody({ kind: 'closed' });
    setNotice({ kind: 'none' });
  }

  // spec onboarding-ui, rule 12: 200 re-renders from the returned view; 409 refreshes once; any
  // other failure only shows. The PATCH is never re-sent.
  function markDone(taskId: string): void {
    const sent = onTick(checklistId, taskId);
    if (sent === null) return;
    const generation = opened.current;
    setNotice({ kind: 'none' });
    void sent.then((r) => {
      if ((!r.ok && r.kind === 'aborted') || generation !== opened.current) return;
      if (r.ok) {
        setBody({ kind: 'view', view: r.data });
        setLatest(r.data);
        setNotice({ kind: 'updated' });
        return;
      }
      setNotice({ kind: 'failed', failure: r });
      if (r.kind === 'http' && r.status === 409) fetchView();
    });
  }

  const isOpen = body.kind !== 'closed';
  const view = body.kind === 'view' ? body.view : null;
  const shown = view ?? (summary === null ? latest : null);
  const head =
    shown !== null ? headOfView(shown) : summary === null ? null : headOfSummary(summary);
  return (
    <article className="card" aria-label={checklistId}>
      <dl className="fields">
        <dt>{TEXT.labelChecklist}</dt>
        <dd className="mono">{checklistId}</dd>
        {head === null ? null : (
          <>
            <dt>{TEXT.labelTemplate}</dt>
            <dd className="mono">{head.templateId}</dd>
            <dt>{TEXT.labelStartDate}</dt>
            <dd className="mono">{head.startDate}</dd>
            <dt>{TEXT.labelTeam}</dt>
            <dd className="mono">{head.newHireTeam}</dd>
            <dt>{TEXT.labelManager}</dt>
            <dd className="mono">{head.managerEmployeeId}</dd>
            <dt>{TEXT.labelBuddy}</dt>
            <dd className="mono">{head.buddyEmployeeId ?? TEXT.noBuddy}</dd>
          </>
        )}
        {view?.newJoiner == null ? null : (
          <>
            <dt>{TEXT.labelNewJoiner}</dt>
            <dd>{view.newJoiner.displayName}</dd>
          </>
        )}
        {head === null ? null : (
          <>
            <dt>{TEXT.labelProgress}</dt>
            <dd className="progress-row">
              <progress value={total(head.progress, 'done')} max={total(head.progress, 'total')} />
              <span className="mono">{`${String(total(head.progress, 'done'))} ${TEXT.progressOf} ${String(total(head.progress, 'total'))} ${TEXT.progressDone}`}</span>
              {total(head.progress, 'blocked') > 0 ? (
                <span className="mono">{`${String(total(head.progress, 'blocked'))} ${TEXT.blockedCount}`}</span>
              ) : null}
            </dd>
          </>
        )}
      </dl>
      {head === null ? null : <PendingMarker n={head.pending} />}
      {view === null || view.pendingDeviationIds.length === 0 ? null : (
        <div className="pending-ids">
          <ul className="plain-list">
            {view.pendingDeviationIds.map((id) => (
              <li key={id} className="mono">
                {id}
              </li>
            ))}
          </ul>
          <p className="muted">{TEXT.pendingHint}</p>
        </div>
      )}
      <button type="button" className="chip" aria-expanded={isOpen} onClick={isOpen ? close : open}>
        {isOpen ? TEXT.hideTasks : TEXT.showTasks}
      </button>
      {notice.kind === 'updated' ? (
        <p role="status" className="state">
          {TEXT.taskUpdated}
        </p>
      ) : notice.kind === 'failed' ? (
        <ErrorState failure={notice.failure} />
      ) : null}
      {body.kind === 'loading' ? (
        <Loading />
      ) : body.kind === 'failed' ? (
        <ErrorState failure={body.failure} />
      ) : view === null ? null : (
        <OwnerGroups view={view} busy={busy} onMarkDone={markDone} />
      )}
    </article>
  );
}
