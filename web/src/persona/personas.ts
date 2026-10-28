// The fixed demo personas (spec web-shell, D-1). Fictional display labels over seeded ids: only
// `employeeId` goes on the wire, and the server resolves the role from its directory (ADR-0005).
import type { Role } from '@hr/shared';
import type { PersonaKey } from './storage.js';

export type RouteKey = 'chat' | 'queue' | 'onboarding' | 'audit';

export interface Persona {
  label: string;
  employeeId: string;
  roleLabel: Role;
  nav: readonly RouteKey[]; // UX only (rule 5); the server enforces every permission
}

export const PERSONAS = {
  asha: { label: 'Asha · employee', employeeId: 'emp-003', roleLabel: 'employee', nav: ['chat'] },
  ravi: {
    label: 'Ravi · manager',
    employeeId: 'emp-002',
    roleLabel: 'manager',
    nav: ['chat', 'queue', 'onboarding'], // spec onboarding-ui, rule 1
  },
  meera: {
    label: 'Meera · HR',
    employeeId: 'emp-001',
    roleLabel: 'hr_admin',
    nav: ['chat', 'queue', 'onboarding', 'audit'],
  },
} as const satisfies Record<PersonaKey, Persona>;

export const PERSONA_ORDER: readonly PersonaKey[] = ['asha', 'ravi', 'meera'];

export const DEFAULT_PERSONA: PersonaKey = 'asha';
