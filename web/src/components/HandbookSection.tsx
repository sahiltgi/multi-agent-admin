// Inline handbook section panel (spec employee-chat, rules 4, 5; OQ-7 answer). The section text is
// one plain React text child: headings, markup and instructions in it show literally.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getHandbookSection, type ApiFailure } from '../api/client.js';
import { TEXT } from '../texts.js';
import { ErrorState, Loading } from './states.js';

export type SectionState =
  | { kind: 'closed' }
  | { kind: 'loading'; id: string }
  | { kind: 'open'; id: string; text: string }
  | { kind: 'error'; id: string; failure: ApiFailure };

/** One section at a time. A new open or a close aborts the load in flight; unmount aborts too. */
// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its panel; Chat owns the state so the chips can reflect it.
export function useHandbookSection(employeeId: string): {
  state: SectionState;
  open: (sectionId: string) => void;
  close: () => void;
} {
  const [state, setState] = useState<SectionState>({ kind: 'closed' });
  const acRef = useRef<AbortController | null>(null);
  const activeRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      acRef.current?.abort();
    },
    [],
  );

  const close = useCallback(() => {
    acRef.current?.abort();
    acRef.current = null;
    activeRef.current = null;
    setState({ kind: 'closed' });
  }, []);

  const open = useCallback(
    (sectionId: string) => {
      if (activeRef.current === sectionId) return; // no toggle and no second load
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      activeRef.current = sectionId;
      setState({ kind: 'loading', id: sectionId });
      void getHandbookSection(sectionId, { employeeId, signal: ac.signal }).then((r) => {
        if (ac.signal.aborted || (!r.ok && r.kind === 'aborted')) return;
        setState(
          r.ok
            ? { kind: 'open', id: sectionId, text: r.data.text }
            : { kind: 'error', id: sectionId, failure: r },
        );
      });
    },
    [employeeId],
  );

  return { state, open, close };
}

export function HandbookSection({
  state,
  regionId,
  onClose,
}: {
  state: Exclude<SectionState, { kind: 'closed' }>;
  regionId: string;
  onClose: () => void;
}) {
  return (
    <section id={regionId} aria-label={state.id} className="section-panel">
      {state.kind === 'loading' && <Loading />}
      {state.kind === 'error' && <ErrorState failure={state.failure} />}
      {state.kind === 'open' && <p className="section-text">{state.text}</p>}
      <button type="button" onClick={onClose}>
        {TEXT.close}
      </button>
    </section>
  );
}
