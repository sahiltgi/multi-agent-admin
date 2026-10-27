// The two queue tabs (spec approval-queue-ui, rule 2). Items are split only by the server's
// `item.kind`, never by verdict, flag, assignee, canAct or role, and keep the server's order.
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Empty } from '../states.js';
import { TEXT } from '../../texts.js';
import type { TabKey, View } from './types.js';

const TAB_OF_KIND: Readonly<Record<View['item']['kind'], TabKey>> = {
  leave_request: 'leave',
  escalation: 'hr',
  onboarding_deviation: 'hr',
};

const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'leave', label: TEXT.tabLeave },
  { key: 'hr', label: TEXT.tabHr },
];

interface Props {
  items: readonly View[];
  tab: TabKey;
  onTab: (tab: TabKey) => void;
  renderCard: (view: View) => ReactNode;
}

export function QueueTabs({ items, tab, onTab, renderCard }: Props) {
  const baseId = useId();
  const refs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});
  const shown = items.filter((v) => TAB_OF_KIND[v.item.kind] === tab);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.key === tab);
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(at + step + TABS.length) % TABS.length];
    if (next === undefined) return;
    onTab(next.key);
    refs.current[next.key]?.focus();
  }

  return (
    <>
      <div role="tablist" aria-label={TEXT.queueSections} className="queue-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t.key}`}
            className="queue-tab"
            aria-selected={t.key === tab}
            aria-controls={`${baseId}-panel-${t.key}`}
            tabIndex={t.key === tab ? 0 : -1}
            onClick={() => {
              onTab(t.key);
            }}
            onKeyDown={onKeyDown}
          >
            {t.label}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`${baseId}-panel-${t.key}`}
          aria-labelledby={`${baseId}-tab-${t.key}`}
          hidden={t.key !== tab}
        >
          {t.key !== tab ? null : shown.length === 0 ? (
            <Empty text={TEXT.queueEmpty} />
          ) : (
            <div className="cards">{shown.map(renderCard)}</div>
          )}
        </div>
      ))}
    </>
  );
}
