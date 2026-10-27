// Server-built document blocks rendered as plain React elements (spec audit-view, rule 23; amends
// web-shell rule 10 only as A-4 says). Document text is always a text child: nothing renders HTML
// or markdown, and no href, src or img is built from it.
import type { BuildNotesResponse } from '@hr/shared';

type DocState = BuildNotesResponse['devMetrics'];
export type Block = Extract<DocState, { status: 'ok' }>['blocks'][number];
export type Inline = Extract<Block, { kind: 'paragraph' }>['inlines'][number];

export function Inlines({ inlines }: { inlines: readonly Inline[] }) {
  return (
    <>
      {inlines.map((x, i) =>
        x.kind === 'code' ? <code key={i}>{x.text}</code> : <span key={i}>{x.text}</span>,
      )}
    </>
  );
}

export function DocTable({
  header,
  rows,
}: {
  header: readonly (readonly Inline[])[];
  rows: readonly (readonly (readonly Inline[])[])[];
}) {
  return (
    <table className="ledger-table">
      <thead>
        <tr>
          {header.map((cell, i) => (
            <th key={i} scope="col">
              <Inlines inlines={cell} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, i) => (
              <td key={i}>
                <Inlines inlines={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DocBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const content = <Inlines inlines={block.inlines} />;
      if (block.level === 1) return <h2 className="section-title">{content}</h2>;
      if (block.level === 2) return <h3>{content}</h3>;
      return <h4>{content}</h4>;
    }
    case 'paragraph':
      return (
        <p className="pre">
          <Inlines inlines={block.inlines} />
        </p>
      );
    case 'list':
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines inlines={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return <DocTable header={block.header} rows={block.rows} />;
  }
}

export function DocBlocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <div className="doc">
      {blocks.map((b, i) => (
        <DocBlock key={i} block={b} />
      ))}
    </div>
  );
}
