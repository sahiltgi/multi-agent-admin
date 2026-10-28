// Tasks grouped by owner (spec onboarding-ui, rules 10 and 11). One region per `view.progress`
// entry, in the server's order; the status comes from the server's own `taskStatus`, never a copy.
import { taskStatus } from '@hr/shared';
import type { ChecklistView } from '@hr/shared';
import { usePersona } from '../../persona/context.js';
import { TEXT } from '../../texts.js';
import { StatusPill } from '../StatusPill.js';
import { canMarkDone } from './canMarkDone.js';

type Owner = ChecklistView['progress'][number]['owner'];

const OWNER_LABEL: Readonly<Record<Owner, string>> = {
  it: 'IT',
  admin: 'Admin',
  manager: 'Manager',
  buddy: 'Buddy',
};

export function OwnerGroups({
  view,
  busy,
  onMarkDone,
}: {
  view: ChecklistView;
  busy: boolean;
  onMarkDone: (taskId: string) => void;
}) {
  const { persona } = usePersona();
  return (
    <div className="owner-groups">
      {view.progress.map((p) => {
        const label = OWNER_LABEL[p.owner];
        const tasks = view.checklist.tasks.filter((t) => t.owner === p.owner);
        return (
          <section key={p.owner} className="owner-group" aria-label={label}>
            <header className="owner-head">
              <h3 className="section-title">{label}</h3>
              <span className="mono">{`${String(p.done)} ${TEXT.progressOf} ${String(p.total)} ${TEXT.progressDone}`}</span>
              {p.blocked > 0 ? (
                <span className="mono">{`${String(p.blocked)} ${TEXT.blockedCount}`}</span>
              ) : null}
            </header>
            {tasks.length === 0 ? (
              <p className="muted">{TEXT.groupEmpty}</p>
            ) : (
              <ul className="plain-list">
                {tasks.map((t) => (
                  <li key={t.id} className="task-row">
                    <span>{t.title}</span>
                    {t.ownerEmployeeId === undefined ? null : (
                      <span className="mono">{t.ownerEmployeeId}</span>
                    )}
                    <span className="muted">{TEXT.labelDue}</span>
                    <span className="mono">{t.dueDate}</span>
                    <StatusPill status={taskStatus(t)} />
                    {t.blocked === undefined ? null : (
                      <span>
                        {TEXT.labelBlockedReason} {t.blocked.reason}
                      </span>
                    )}
                    {canMarkDone(t, view.checklist, persona) ? (
                      <button
                        type="button"
                        className="action"
                        disabled={busy}
                        onClick={() => {
                          onMarkDone(t.id);
                        }}
                      >
                        {TEXT.markDone}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
