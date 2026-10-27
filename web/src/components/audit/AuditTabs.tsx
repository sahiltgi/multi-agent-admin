// The three /audit tabs (spec audit-view, rule 19). Not hidden by role (web-shell rule 5): the
// server enforces access, and a 403 shows as the tab's error state.
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { TEXT } from '../../texts.js';

export type AuditTab = 'trace' | 'evals' | 'build';

const TABS: readonly { key: AuditTab; label: string }[] = [
  { key: 'trace', label: TEXT.tabTrace },
  { key: 'evals', label: TEXT.tabEvals },
  { key: 'build', label: TEXT.tabBuild },
];

interface Props {
  tab: AuditTab;
  onTab: (tab: AuditTab) => void;
  renderPanel: (tab: AuditTab) => ReactNode;
}

export function AuditTabs({ tab, onTab, renderPanel }: Props) {
  const baseId = useId();
  const refs = useRef<Partial<Record<AuditTab, HTMLButtonElement | null>>>({});

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
      <div role="tablist" aria-label={TEXT.auditSections} className="queue-tabs">
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
          {t.key === tab ? renderPanel(t.key) : null}
        </div>
      ))}
    </>
  );
}
