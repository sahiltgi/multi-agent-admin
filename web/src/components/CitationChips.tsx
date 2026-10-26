// Citation chips (spec employee-chat, rules 3, 4). One button per card.sectionIds entry, in the order
// returned: never parsed from the reply, de-duplicated, sorted or renamed.
export function CitationChips({
  sectionIds,
  activeId,
  controlsId,
  onOpen,
}: {
  sectionIds: readonly string[];
  activeId: string | null; // the section open or loading in the panel
  controlsId: string;
  onOpen: (sectionId: string) => void;
}) {
  return (
    <p className="chips">
      {sectionIds.map((id, i) => (
        <button
          key={`${String(i)}-${id}`}
          type="button"
          className="chip mono"
          aria-expanded={id === activeId}
          aria-controls={id === activeId ? controlsId : undefined}
          onClick={() => {
            onOpen(id);
          }}
        >
          {id}
        </button>
      ))}
    </p>
  );
}
