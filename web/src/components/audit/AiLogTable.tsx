// The latest AI_LOG entries (spec audit-view, rules 18 and 23): the server's rows in file order,
// rendered as text. The missing, unreadable and no-table states show fixed texts.
import type { BuildNotesResponse } from '@hr/shared';
import { TEXT } from '../../texts.js';
import { Empty } from '../states.js';
import { DocTable } from './DocBlocks.js';

export function AiLogTable({ state }: { state: BuildNotesResponse['aiLog'] }) {
  return (
    <section className="ai-log">
      <h2 className="section-title">{TEXT.aiLogHeading}</h2>
      {state.status === 'ok' ? (
        <DocTable header={state.header} rows={state.rows} />
      ) : state.status === 'missing' ? (
        <Empty text={TEXT.aiLogMissing} />
      ) : state.status === 'unreadable' ? (
        <Empty text={TEXT.docUnreadable} />
      ) : (
        <Empty text={TEXT.aiLogNoTable} />
      )}
    </section>
  );
}
