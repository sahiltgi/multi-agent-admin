// Spec web-shell: the fixed persona map (D-1, rules 3, 5, 20) and the PersonaKey boundary.
import { describe, expect, it } from 'vitest';
import { PERSONAS } from './persona/personas.js';
import { DEFAULT_PERSONA } from './persona/personas.js';
import { PERSONA_STORAGE_KEY, PersonaKey } from './persona/storage.js';

describe('persona map', () => {
  it('AT-5: PersonaKey accepts exactly asha, ravi and meera and the key is hr-demo.persona', () => {
    expect(PERSONA_STORAGE_KEY).toBe('hr-demo.persona');
    for (const ok of ['asha', 'ravi', 'meera']) expect(PersonaKey.safeParse(ok).success).toBe(true);
    for (const bad of [
      'RAVI',
      'emp-002',
      'hr_admin',
      '__proto__',
      '{"key":"meera"}',
      '<script>',
      '',
      null,
      undefined,
    ]) {
      expect(PersonaKey.safeParse(bad).success).toBe(false);
    }
    expect(DEFAULT_PERSONA).toBe('asha');
  });

  it('AT-10: nav comes from the map: Asha Chat, Ravi Chat and Queue, Meera all three', () => {
    expect(PERSONAS.asha.nav).toEqual(['chat']);
    expect(PERSONAS.ravi.nav).toEqual(['chat', 'queue']);
    expect(PERSONAS.meera.nav).toEqual(['chat', 'queue', 'audit']);
  });

  it('AT-30: persona ids are exactly the seeded ids and labels are display only', () => {
    expect(Object.keys(PERSONAS).sort()).toEqual(['asha', 'meera', 'ravi']);
    expect([PERSONAS.asha.employeeId, PERSONAS.ravi.employeeId, PERSONAS.meera.employeeId]).toEqual(
      ['emp-003', 'emp-002', 'emp-001'],
    );
    expect(PERSONAS.asha.label).toBe('Asha · employee');
    expect(PERSONAS.ravi.label).toBe('Ravi · manager');
    expect(PERSONAS.meera.label).toBe('Meera · HR');
    expect(PERSONAS.meera.roleLabel).toBe('hr_admin');
  });
});
