// /queue (spec approval-queue-ui, rules 1, 2 and 14–16; amends web-shell rule 14). Cards render
// `GET /approvals` as returned, and a human's action goes to `POST /approvals/:itemId/actions`.
// The parent keys this route by persona, so a switch remounts it: cards, drafts and messages go,
// and the unmount aborts every call in flight, so a late response is never rendered (rule 16).
import type { ActionBody, ListApprovalsResponse } from '@hr/shared';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getApprovals, postAction, type ApiFailure, type ApiResult } from '../api/client.js';
import { DeviationCard } from '../components/approvals/DeviationCard.js';
import { EscalationCard } from '../components/approvals/EscalationCard.js';
import { LeaveCard } from '../components/approvals/LeaveCard.js';
import { QueueTabs } from '../components/approvals/QueueTabs.js';
import type { CardProps, TabKey, View } from '../components/approvals/types.js';
import { ErrorState, Loading } from '../components/states.js';
import { usePersona } from '../persona/context.js';
import { TEXT } from '../texts.js';

type ActionState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done' } // shows TEXT.actionRecorded
  | { kind: 'failed'; failure: ApiFailure };

/** 409 codes after which the card is stale: refetch once, never resubmit (rule 15). */
const STALE_CODES: ReadonlySet<string> = new Set([
  'gate_result_changed',
  'gate_result_missing',
  'already_decided',
]);

function card(kind: View['item']['kind'], props: CardProps): ReactNode {
  switch (kind) {
    case 'leave_request':
      return <LeaveCard key={props.view.item.id} {...props} />;
    case 'escalation':
      return <EscalationCard key={props.view.item.id} {...props} />;
    case 'onboarding_deviation':
      return <DeviationCard key={props.view.item.id} {...props} />;
  }
}

export function Queue() {
  const { persona } = usePersona();
  const employeeId = persona.employeeId;
  const [result, setResult] = useState<ApiResult<ListApprovalsResponse> | null>(null);
  const [tab, setTab] = useState<TabKey>('leave');
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [action, setAction] = useState<ActionState>({ kind: 'idle' });
  // The list call and the action call in flight, so a new list call aborts the old one and the
  // unmount aborts both (rules 1, 14 and 16).
  const calls = useRef<{ list: AbortController | null; post: AbortController | null }>({
    list: null,
    post: null,
  });

  const load = useCallback(() => {
    const inFlight = calls.current;
    inFlight.list?.abort();
    const ac = new AbortController();
    inFlight.list = ac;
    void getApprovals({ employeeId, signal: ac.signal }).then((r) => {
      if (r.ok || r.kind !== 'aborted') setResult(r);
    });
  }, [employeeId]);

  useEffect(() => {
    const inFlight = calls.current;
    load();
    return () => {
      inFlight.list?.abort();
      inFlight.post?.abort();
    };
  }, [load]);

  function act(itemId: string, body: ActionBody): void {
    const inFlight = calls.current;
    if (inFlight.post !== null) return; // one action at a time (rule 14)
    const ac = new AbortController();
    inFlight.post = ac;
    setAction({ kind: 'sending' });
    void postAction(itemId, body, { employeeId, signal: ac.signal }).then((r) => {
      if (!r.ok && r.kind === 'aborted') return; // superseded by a persona switch (rule 16)
      inFlight.post = null;
      if (r.ok) {
        setDrafts((d) => {
          const next = new Map(d);
          next.delete(itemId);
          return next;
        });
        setAction({ kind: 'done' });
        load();
        return;
      }
      setAction({ kind: 'failed', failure: r });
      if (r.kind === 'http' && r.status === 409 && STALE_CODES.has(r.error.code)) load();
    });
  }

  function renderCard(view: View): ReactNode {
    const id = view.item.id;
    return card(view.item.kind, {
      view,
      draft: drafts.get(id) ?? '',
      busy: action.kind === 'sending',
      onDraft: (text) => {
        setDrafts((d) => new Map(d).set(id, text));
      },
      onAction: (body) => {
        act(id, body);
      },
    });
  }

  return (
    <section>
      <h1 className="page-title">Approval queue</h1>
      {action.kind === 'done' ? (
        <p role="status" className="state">
          {TEXT.actionRecorded}
        </p>
      ) : action.kind === 'failed' ? (
        <ErrorState failure={action.failure} />
      ) : null}
      {result === null ? (
        <Loading />
      ) : !result.ok ? (
        <ErrorState failure={result} />
      ) : (
        <QueueTabs items={result.data.items} tab={tab} onTab={setTab} renderCard={renderCard} />
      )}
    </section>
  );
}
