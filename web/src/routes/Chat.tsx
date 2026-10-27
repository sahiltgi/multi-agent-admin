// /chat (spec web-shell, rules 11 and 13; spec employee-chat, rules 1–10). Turns and the
// conversationId live in memory only, for this persona: the parent keys the route by persona, so a
// switch or reload starts afresh, and every hook below aborts its call in flight on unmount.
import type { ChatResponse } from '@hr/shared';
import { MAX_USER_TEXT_CHARS } from '@hr/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { postChat, type ApiFailure } from '../api/client.js';
import { CitationChips } from '../components/CitationChips.js';
import { HandbookSection, useHandbookSection } from '../components/HandbookSection.js';
import { MyRequests, useMyRequests } from '../components/MyRequests.js';
import { Empty, ErrorState, Loading } from '../components/states.js';
import { StatusPill } from '../components/StatusPill.js';
import { VerdictBadge } from '../components/VerdictBadge.js';
import { usePersona } from '../persona/context.js';
import { TEXT } from '../texts.js';

interface Turn {
  message: string;
  response: ChatResponse;
}

export function Chat() {
  const { persona } = usePersona();
  const employeeId = persona.employeeId;
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const myRequests = useMyRequests(employeeId);
  const section = useHandbookSection(employeeId);
  const sectionRegionId = useId();
  const activeSectionId = section.state.kind === 'closed' ? null : section.state.id;

  // One controller per mount; unmounting (a persona switch) aborts an in-flight send (rule 4).
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    return () => {
      ac.abort();
    };
  }, []);

  const trimmed = input.trim();
  const canSend = !pending && trimmed.length > 0 && trimmed.length <= MAX_USER_TEXT_CHARS;

  async function send(): Promise<void> {
    const ac = abortRef.current;
    if (!canSend || ac === null) return;
    setPending(true);
    setFailure(null);
    const message = trimmed;
    const r = await postChat(conversationId === null ? { message } : { message, conversationId }, {
      employeeId,
      signal: ac.signal,
    });
    if (!r.ok && r.kind === 'aborted') return;
    setPending(false);
    if (r.ok) {
      setTurns((t) => [...t, { message, response: r.data }]);
      setConversationId(r.data.conversationId);
      setInput('');
      // employee-chat rule 9: the one refresh trigger is this exact server status.
      if (r.data.status === 'leave_submitted') myRequests.refresh();
    } else {
      setFailure(r); // the input and the conversationId stay
    }
  }

  return (
    <>
      <section>
        <h1 className="page-title">Chat</h1>
        {turns.length === 0 ? (
          <Empty text={TEXT.chatIdle} />
        ) : (
          <ol className="turns">
            {turns.map((t) => (
              <li key={t.response.requestId} className="turn">
                <p className="turn-sent">{t.message}</p>
                <p className="turn-reply">{t.response.reply}</p>
                <p className="turn-meta">
                  {t.response.card?.kind === 'submitted' && (
                    <VerdictBadge verdict={t.response.card.verdict} />
                  )}
                  <StatusPill status={t.response.status} />
                </p>
                {t.response.card?.kind === 'policy_answer' && (
                  <CitationChips
                    sectionIds={t.response.card.sectionIds}
                    activeId={activeSectionId}
                    controlsId={sectionRegionId}
                    onOpen={section.open}
                  />
                )}
              </li>
            ))}
          </ol>
        )}
        {section.state.kind !== 'closed' && (
          <HandbookSection
            state={section.state}
            regionId={sectionRegionId}
            onClose={section.close}
          />
        )}
        {pending && <Loading />}
        {failure !== null && <ErrorState failure={failure} />}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            type="text"
            aria-label="Message"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
            }}
          />
          <button type="submit" className="primary" disabled={!canSend}>
            Send
          </button>
        </form>
      </section>
      <MyRequests state={myRequests.state} />
    </>
  );
}
