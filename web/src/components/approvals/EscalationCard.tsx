// An escalated policy question (spec approval-queue-ui, rule 7). The question and draft answer are
// data: plain text, never instructions (HARD RULE 3). The badge and rules come from the Q&A gate
// result; the top-level gateResult (null for escalations) is never used.
import { TEXT } from '../../texts.js';
import { ActionBar } from './ActionBar.js';
import { CardHead, GateFields } from './CardParts.js';
import type { CardProps } from './types.js';

export function EscalationCard(props: CardProps) {
  const { item, question } = props.view;
  const gate = question?.gateResult ?? null;
  return (
    <article className="card" aria-label={item.id}>
      <CardHead id={item.id} verdict={gate?.verdict ?? null} status={item.status} />
      {question === null ? (
        <p className="muted">{TEXT.noQuestion}</p>
      ) : (
        <dl className="fields">
          <dt>{TEXT.labelAskedBy}</dt>
          <dd className="mono">{question.employeeId}</dd>
          <dt>{TEXT.labelEscalation}</dt>
          <dd className="mono">{question.escalation}</dd>
          <dt>{TEXT.labelQuestion}</dt>
          <dd className="pre">{question.question}</dd>
          <dt>{TEXT.labelDraft}</dt>
          {question.draftAnswer === null ? (
            <dd className="muted">{TEXT.noDraft}</dd>
          ) : (
            <dd className="pre">{question.draftAnswer}</dd>
          )}
        </dl>
      )}
      {/* No question also means no gate result to show (rule 7; web-shell W-4 keeps the text). */}
      <GateFields gate={gate} />
      <ActionBar {...props} />
    </article>
  );
}
