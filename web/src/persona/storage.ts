// Remembered persona (spec web-shell, rule 3). The stored value is a PersonaKey, never an id or
// role. Storage can be missing or throw (private mode, blocked site data), so every access is guarded.
import { z } from 'zod';

export const PersonaKey = z.enum(['asha', 'ravi', 'meera']);
export type PersonaKey = z.infer<typeof PersonaKey>;

export const PERSONA_STORAGE_KEY = 'hr-demo.persona';

/** The stored persona, or null when it is missing, unknown or unreadable. */
export function readStoredPersona(): PersonaKey | null {
  try {
    const parsed = PersonaKey.safeParse(localStorage.getItem(PERSONA_STORAGE_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Best effort: a throwing setItem still lets the session switch. */
export function writeStoredPersona(key: PersonaKey): void {
  try {
    localStorage.setItem(PERSONA_STORAGE_KEY, key);
  } catch {
    // storage unavailable; the persona lives for this session only
  }
}
