// Persona switcher (spec web-shell, rules 1 and 19): a segmented control with radio-group
// semantics. Native radios give arrow-key selection and a single tab stop.
import { usePersona } from '../persona/context.js';
import { PERSONA_ORDER, PERSONAS } from '../persona/personas.js';

export function PersonaSwitcher() {
  const { key, setPersona } = usePersona();
  return (
    <div role="radiogroup" aria-label="Demo user" className="switcher">
      {PERSONA_ORDER.map((k) => (
        <label key={k} className="switcher-option">
          <input
            type="radio"
            name="demo-user"
            value={k}
            checked={k === key}
            onChange={() => {
              setPersona(k);
            }}
          />
          <span>{PERSONAS[k].label}</span>
        </label>
      ))}
    </div>
  );
}
