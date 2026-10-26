import { createContext, useContext } from 'react';
import type { Persona } from './personas.js';
import type { PersonaKey } from './storage.js';

export interface PersonaState {
  key: PersonaKey;
  persona: Persona;
  setPersona: (key: PersonaKey) => void;
}

export const PersonaContext = createContext<PersonaState | null>(null);

export function usePersona(): PersonaState {
  const state = useContext(PersonaContext);
  if (state === null) throw new Error('usePersona needs a PersonaProvider');
  return state;
}
