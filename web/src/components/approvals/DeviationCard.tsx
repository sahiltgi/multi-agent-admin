// An onboarding deviation (spec approval-queue-ui, rule 8): exactly what an approve would apply.
// The rationale and task title are model text: plain text, never instructions (HARD RULE 3).
import { TEXT } from '../../texts.js';
import { ActionBar } from './ActionBar.js';
import { CardHead, GateFields } from './CardParts.js';
import type { CardProps, View } from './types.js';

function Change({ change }: { change: NonNullable<View['deviation']>['change'] }) {
  if (change.kind === 'remove') {
    return (
      <>
        <span className="mono">{change.kind}</span>{' '}
        <span className="mono">{change.templateTaskId}</span>
      </>
    );
  }
  return (
    <>
      <span className="mono">{change.kind}</span> <span className="pre">{change.title}</span> ·{' '}
      <span className="mono">{change.owner}</span> ·{' '}
      <span className="mono">{String(change.dueOffsetDays)}</span>
      {change.dependsOn.length === 0 ? null : (
        <ul className="plain-list">
          {change.dependsOn.map((id, i) => (
            <li key={`${String(i)}-${id}`} className="mono">
              {id}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DeviationCard(props: CardProps) {
  const { item, deviation, gateResult } = props.view;
  return (
    <article className="card" aria-label={item.id}>
      <CardHead id={item.id} verdict={gateResult?.verdict ?? null} status={item.status} />
      {deviation === null ? (
        <p className="muted">{TEXT.noDeviation}</p>
      ) : (
        <dl className="fields">
          <dt>{TEXT.labelChange}</dt>
          <dd>
            <Change change={deviation.change} />
          </dd>
          <dt>{TEXT.labelRationale}</dt>
          <dd className="pre">{deviation.rationale}</dd>
          <dt>{TEXT.labelDeviationStatus}</dt>
          <dd className="mono">{deviation.status}</dd>
          <dt>{TEXT.labelProposedBy}</dt>
          <dd className="mono">{deviation.proposedBy}</dd>
          <dt>{TEXT.labelChecklist}</dt>
          <dd className="mono">{deviation.checklistId}</dd>
        </dl>
      )}
      <GateFields gate={gateResult} />
      <ActionBar {...props} />
    </article>
  );
}
