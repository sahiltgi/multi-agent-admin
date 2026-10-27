// The trace timeline (spec audit-view, rule 20): the steps in the order returned, never re-sorted,
// grouped or reformatted. The request total is the server's stored usage; nothing is summed here.
import type { TraceTimelineResponse } from '@hr/shared';
import { TEXT } from '../../texts.js';
import { Empty } from '../states.js';
import { TimelineStep } from './TimelineStep.js';

function RequestTotal({ total }: { total: TraceTimelineResponse['requestTotal'] }) {
  switch (total.status) {
    case 'hidden':
      return null;
    case 'none':
      return <p className="muted">{TEXT.requestTotalNone}</p>;
    case 'unpriced':
      return <p className="muted">{TEXT.requestTotalUnpriced}</p>;
    case 'priced': {
      const { tokens, costUsd } = total.usage;
      return (
        <p className="mono">
          {`${TEXT.requestTotal} ${String(tokens.input)} ${TEXT.tokensIn} / ${String(tokens.output)} ${TEXT.tokensOut}, USD ${String(costUsd)}`}
        </p>
      );
    }
  }
}

export function Timeline({ data }: { data: TraceTimelineResponse }) {
  return (
    <>
      <div className="timeline-summary">
        <p>{`${TEXT.injectionCount} ${String(data.injectionCount)}`}</p>
        <RequestTotal total={data.requestTotal} />
      </div>
      {data.steps.length === 0 ? (
        <Empty text={TEXT.auditEmpty} />
      ) : (
        <ol className="timeline">
          {data.steps.map((s) => (
            <TimelineStep key={s.eventId} step={s} />
          ))}
        </ol>
      )}
    </>
  );
}
