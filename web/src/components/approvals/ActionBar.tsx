// The comment field and buttons of one card (spec approval-queue-ui, rules 10–12). Which controls
// render is UX only; the server enforces RBAC and the flagged-approve-needs-comment rule too.
import { ActionBody, MAX_COMMENT_CHARS } from '@hr/shared';
import { useId } from 'react';
import { TEXT } from '../../texts.js';
import type { CardProps } from './types.js';

type Decision = 'approve' | 'reject' | 'comment';

export function ActionBar({ view, draft, busy, onDraft, onAction }: CardProps) {
  const fieldId = useId();
  const hintId = useId();
  const { item, gateResult } = view;
  if (!view.canAct) return <p className="muted">{TEXT.viewOnly}</p>;

  const open = item.status === 'open';
  const isEscalation = item.kind === 'escalation';
  // Rule 10: an escalation is resolved only while open; the others need the gate result for `seen`.
  if (isEscalation ? !open : gateResult === null) return null;

  const trimmed = draft.trim();
  const empty = trimmed === '';
  const tooLong = trimmed.length > MAX_COMMENT_CHARS;
  const blocked = busy || tooLong;
  const comment = empty ? {} : { comment: trimmed };

  function decide(action: Decision): void {
    if (gateResult === null) return;
    const seen = { verdict: gateResult.verdict, policyHash: gateResult.policyHash };
    onAction(ActionBody.parse({ action, ...comment, seen }));
  }

  function button(label: string, disabled: boolean, onClick: () => void, describedBy?: string) {
    return (
      <button
        type="button"
        className="action"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={onClick}
      >
        {label}
      </button>
    );
  }

  const showApprove = !isEscalation && open;
  const needsComment = showApprove && item.flagged; // the server's boolean only (rule 11)

  return (
    <div className="action-bar">
      <label htmlFor={fieldId}>{TEXT.commentField}</label>
      <textarea
        id={fieldId}
        value={draft}
        rows={2}
        onChange={(e) => {
          onDraft(e.target.value);
        }}
      />
      {needsComment ? (
        <p id={hintId} className="muted">
          {TEXT.flaggedHint}
        </p>
      ) : null}
      <div className="action-buttons">
        {isEscalation ? (
          button(TEXT.resolve, blocked || empty, () => {
            onAction(ActionBody.parse({ action: 'resolve', ...comment }));
          })
        ) : (
          <>
            {showApprove
              ? button(
                  TEXT.approve,
                  blocked || (needsComment && empty),
                  () => {
                    decide('approve');
                  },
                  needsComment ? hintId : undefined,
                )
              : null}
            {showApprove
              ? button(TEXT.reject, blocked, () => {
                  decide('reject');
                })
              : null}
            {button(TEXT.comment, blocked || empty, () => {
              decide('comment');
            })}
          </>
        )}
      </div>
    </div>
  );
}
