// Current demo persona (spec web-shell, rules 2–4). Always resolves: a missing or bad stored value
// falls back to Asha, so no request is ever sent without `x-demo-user`.
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { PersonaContext, type PersonaState } from './context.js';
import { DEFAULT_PERSONA, PERSONAS } from './personas.js';
import { readStoredPersona, writeStoredPersona, type PersonaKey } from './storage.js';

export function PersonaProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<PersonaKey>(() => readStoredPersona() ?? DEFAULT_PERSONA);
  const setPersona = useCallback((next: PersonaKey) => {
    writeStoredPersona(next);
    setKey(next);
  }, []);
  const value = useMemo<PersonaState>(
    () => ({ key, persona: PERSONAS[key], setPersona }),
    [key, setPersona],
  );
  return <PersonaContext value={value}>{children}</PersonaContext>;
}
