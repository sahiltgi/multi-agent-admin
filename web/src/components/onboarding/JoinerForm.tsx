// The new-joiner form (spec onboarding-ui, rules 4 and 5). Controlled by the route, which builds and
// parses the body. A control is marked invalid only by the paths the route passes in.
import { TemplateId } from '@hr/shared';
import { useId } from 'react';
import { TEXT } from '../../texts.js';

export interface FormDraft {
  newJoinerName: string;
  templateId: string; // '' until chosen
  startDate: string; // the date input's value, sent as typed
  newHireTeam: string;
  managerEmployeeId: string;
  buddyEmployeeId: string; // '' -> null
  notes: string; // blank after trim -> key omitted
}
export type FieldName = keyof FormDraft;

export function JoinerForm({
  draft,
  invalid,
  busy,
  onChange,
  onSubmit,
}: {
  draft: FormDraft;
  invalid: ReadonlySet<string>;
  busy: boolean;
  onChange: (name: FieldName, value: string) => void;
  onSubmit: () => void;
}) {
  const id = useId();
  const props = (name: FieldName) => ({
    id: `${id}-${name}`,
    name,
    value: draft[name],
    'aria-invalid': invalid.has(name) ? ('true' as const) : undefined,
    onChange: (e: { target: { value: string } }) => {
      onChange(name, e.target.value);
    },
  });
  const label = (name: FieldName, text: string) => <label htmlFor={`${id}-${name}`}>{text}</label>;

  return (
    <form
      className="joiner-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h2 className="section-title">{TEXT.formHeading}</h2>
      {label('newJoinerName', TEXT.labelJoinerName)}
      <input type="text" autoComplete="off" {...props('newJoinerName')} />
      {label('templateId', TEXT.labelTemplate)}
      <select {...props('templateId')}>
        <option value="">{TEXT.templatePlaceholder}</option>
        {TemplateId.options.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {label('startDate', TEXT.labelStartDate)}
      <input type="date" {...props('startDate')} />
      {label('newHireTeam', TEXT.labelTeamId)}
      <input type="text" className="mono" autoComplete="off" {...props('newHireTeam')} />
      {label('managerEmployeeId', TEXT.labelManagerId)}
      <input type="text" className="mono" autoComplete="off" {...props('managerEmployeeId')} />
      {label('buddyEmployeeId', TEXT.labelBuddyId)}
      <input type="text" className="mono" autoComplete="off" {...props('buddyEmployeeId')} />
      {label('notes', TEXT.labelNotes)}
      <textarea rows={3} {...props('notes')} />
      <button type="submit" className="primary" disabled={busy}>
        {TEXT.addJoiner}
      </button>
    </form>
  );
}
