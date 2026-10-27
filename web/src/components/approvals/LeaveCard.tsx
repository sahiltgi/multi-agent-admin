// A leave recommendation card (spec approval-queue-ui, rules 3–6). Every value is shown exactly as
// returned; working days come from the server and the browser never counts days (rule 4).
import { TEXT } from '../../texts.js';
import { ActionBar } from './ActionBar.js';
import { CardHead, GateFields } from './CardParts.js';
import type { CardProps, View } from './types.js';

function SubjectFields({ subject }: { subject: NonNullable<View['subject']> }) {
  return (
    <dl className="fields">
      <dt>{TEXT.labelEmployee}</dt>
      <dd className="mono">{subject.employeeId}</dd>
      <dt>{TEXT.labelDates}</dt>
      <dd>
        <span className="mono">{subject.startDate}</span>
        {subject.startHalf === undefined ? null : (
          <>
            {' '}
            <span className="mono">{subject.startHalf}</span>
          </>
        )}{' '}
        {TEXT.dateSeparator} <span className="mono">{subject.endDate}</span>
        {subject.endHalf === undefined ? null : (
          <>
            {' '}
            <span className="mono">{subject.endHalf}</span>
          </>
        )}
      </dd>
      <dt>{TEXT.labelType}</dt>
      <dd>{subject.leaveType}</dd>
      <dt>{TEXT.labelWorkingDays}</dt>
      {subject.workingDays === null ? (
        <dd className="muted">{TEXT.workingDaysMissing}</dd>
      ) : (
        <dd className="mono">{String(subject.workingDays)}</dd>
      )}
    </dl>
  );
}

export function LeaveCard(props: CardProps) {
  const { item, subject, gateResult } = props.view;
  return (
    <article className="card" aria-label={item.id}>
      <CardHead id={item.id} verdict={gateResult?.verdict ?? null} status={item.status} />
      {subject === null ? (
        <p className="muted">{TEXT.noLeaveDetails}</p>
      ) : (
        <SubjectFields subject={subject} />
      )}
      <GateFields gate={gateResult} />
      <ActionBar {...props} />
    </article>
  );
}
