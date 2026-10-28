// /onboarding (spec onboarding-ui, rules 1–7, 11 and 12). Add a new joiner and see the active
// checklists. The parent keys this route by persona, so a switch remounts it: the draft, result and
// cards go, and the unmount aborts every call in flight, so a late response is never rendered
// (rule 3). Verdicts are copied from the server; deviations are decided only in /queue.
import { CreateOnboardingBody } from '@hr/shared';
import type { ChecklistView, CreateOnboardingResponse, ListOnboardingResponse } from '@hr/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getOnboardingList,
  patchTaskDone,
  postOnboarding,
  type ApiFailure,
  type ApiResult,
} from '../api/client.js';
import { ChecklistCard } from '../components/onboarding/ChecklistCard.js';
import { CreatedResult, EscalatedResult } from '../components/onboarding/CreateResult.js';
import { JoinerForm, type FieldName, type FormDraft } from '../components/onboarding/JoinerForm.js';
import { Empty, ErrorState, Loading } from '../components/states.js';
import { usePersona } from '../persona/context.js';
import { TEXT } from '../texts.js';

type Summary = ListOnboardingResponse['checklists'][number];
type Busy = 'idle' | 'creating' | 'ticking';
type ListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; summaries: Summary[]; capped: boolean }
  | { kind: 'failed'; failure: ApiFailure };
type Created = Extract<CreateOnboardingResponse, { kind: 'checklist_created' }>;
type Escalated = Extract<CreateOnboardingResponse, { kind: 'escalated' }>;
type FormAlert = { kind: 'none' } | { kind: 'invalid' } | { kind: 'failed'; failure: ApiFailure };

const MAX_PAGES = 10; // rule 7: at most ten list requests per load

const EMPTY_DRAFT: FormDraft = {
  newJoinerName: '',
  templateId: '',
  startDate: '',
  newHireTeam: '',
  managerEmployeeId: '',
  buddyEmployeeId: '',
  notes: '',
};

/** Rule 4: trimmed ids, an empty buddy as null, blank notes left out; the schema checks the rest. */
function toBody(d: FormDraft): unknown {
  const buddy = d.buddyEmployeeId.trim();
  return {
    newJoinerName: d.newJoinerName.trim(),
    templateId: d.templateId,
    startDate: d.startDate,
    newHireTeam: d.newHireTeam.trim(),
    managerEmployeeId: d.managerEmployeeId.trim(),
    buddyEmployeeId: buddy === '' ? null : buddy,
    ...(d.notes.trim() === '' ? {} : { notes: d.notes }),
  };
}

/** Rule 7: active while some task isn't done or a deviation is pending. Server counts only. */
function isActive(s: Summary): boolean {
  const done = s.progress.reduce((n, p) => n + p.done, 0);
  const total = s.progress.reduce((n, p) => n + p.total, 0);
  return done < total || s.pendingDeviations > 0;
}

/** Rule 5: the fields a server 400 names, read from issue paths only, never values. */
function serverInvalid(failure: ApiFailure): Set<string> {
  if (failure.kind !== 'http') return new Set();
  const names = (failure.error.issues ?? [])
    .filter((i) => i.path[0] === 'body' && typeof i.path[1] === 'string')
    .map((i) => String(i.path[1]));
  return new Set(names);
}

export function Onboarding() {
  const { persona } = usePersona();
  const employeeId = persona.employeeId;
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT);
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [formAlert, setFormAlert] = useState<FormAlert>({ kind: 'none' });
  // Rule 6: the Just added card stays until the next create replaces it; an escalation shows apart.
  const [created, setCreated] = useState<Created | null>(null);
  const [escalated, setEscalated] = useState<Escalated | null>(null);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [busy, setBusy] = useState<Busy>('idle');
  // The list, create and tick calls in flight: a new list load aborts the old one, and the unmount
  // aborts all three (rule 3). A non-null `post` or `tick` means an action is running (rule 12).
  const calls = useRef<{
    list: AbortController | null;
    post: AbortController | null;
    tick: AbortController | null;
  }>({ list: null, post: null, tick: null });

  const loadList = useCallback(() => {
    const inFlight = calls.current;
    inFlight.list?.abort();
    const ac = new AbortController();
    inFlight.list = ac;
    void (async () => {
      const summaries: Summary[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const r: ApiResult<ListOnboardingResponse> = await getOnboardingList(cursor, {
          employeeId,
          signal: ac.signal,
        });
        if (!r.ok) {
          if (r.kind !== 'aborted') setList({ kind: 'failed', failure: r });
          return;
        }
        summaries.push(...r.data.checklists);
        cursor = r.data.nextCursor;
        if (cursor === null) break;
      }
      setList({ kind: 'loaded', summaries: summaries.filter(isActive), capped: cursor !== null });
    })();
  }, [employeeId]);

  useEffect(() => {
    const inFlight = calls.current;
    loadList();
    return () => {
      inFlight.list?.abort();
      inFlight.post?.abort();
      inFlight.tick?.abort();
    };
  }, [loadList]);

  function submit(): void {
    const inFlight = calls.current;
    if (inFlight.post !== null || inFlight.tick !== null) return;
    const parsed = CreateOnboardingBody.safeParse(toBody(draft));
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((i) => String(i.path[0]))));
      setFormAlert({ kind: 'invalid' });
      return;
    }
    setInvalid(new Set());
    setFormAlert({ kind: 'none' });
    setEscalated(null);
    const ac = new AbortController();
    inFlight.post = ac;
    setBusy('creating');
    void postOnboarding(parsed.data, { employeeId, signal: ac.signal }).then((r) => {
      if (!r.ok && r.kind === 'aborted') return; // superseded by a persona switch (rule 3)
      inFlight.post = null;
      setBusy('idle');
      if (!r.ok) {
        setInvalid(serverInvalid(r));
        setFormAlert({ kind: 'failed', failure: r });
        return;
      }
      if (r.data.kind === 'escalated') {
        setEscalated(r.data);
        return;
      }
      setCreated(r.data);
      setDraft(EMPTY_DRAFT);
      loadList();
    });
  }

  // Rule 12: one PATCH per click, never re-sent. The card shows the outcome; null means busy.
  function tick(checklistId: string, taskId: string): Promise<ApiResult<ChecklistView>> | null {
    const inFlight = calls.current;
    if (inFlight.post !== null || inFlight.tick !== null) return null;
    const ac = new AbortController();
    inFlight.tick = ac;
    setBusy('ticking');
    return patchTaskDone(checklistId, taskId, { employeeId, signal: ac.signal }).then((r) => {
      if (!r.ok && r.kind === 'aborted') return r;
      inFlight.tick = null;
      setBusy('idle');
      return r;
    });
  }

  const isBusy = busy !== 'idle';
  return (
    <section>
      <h1 className="page-title">Onboarding</h1>
      <JoinerForm
        draft={draft}
        invalid={invalid}
        busy={isBusy}
        onChange={(name: FieldName, value: string) => {
          setDraft((d) => ({ ...d, [name]: value }));
        }}
        onSubmit={submit}
      />
      {formAlert.kind === 'invalid' ? (
        <div role="alert" className="state state-error">
          {TEXT.formInvalid}
        </div>
      ) : formAlert.kind === 'failed' ? (
        <ErrorState failure={formAlert.failure} />
      ) : null}
      {escalated === null ? null : <EscalatedResult outcome={escalated} />}
      {created === null ? null : (
        <CreatedResult key={created.requestId} outcome={created} busy={isBusy} onTick={tick} />
      )}
      <h2 className="section-title">{TEXT.activeChecklists}</h2>
      {list.kind === 'loading' ? (
        <Loading />
      ) : list.kind === 'failed' ? (
        <ErrorState failure={list.failure} />
      ) : (
        <>
          {list.capped ? <p className="state">{TEXT.checklistsCapped}</p> : null}
          {list.summaries.length === 0 ? (
            <Empty text={TEXT.checklistsEmpty} />
          ) : (
            <div className="cards">
              {list.summaries.map((s) => (
                <ChecklistCard
                  key={s.checklistId}
                  checklistId={s.checklistId}
                  summary={s}
                  startOpen={false}
                  busy={isBusy}
                  onTick={tick}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
