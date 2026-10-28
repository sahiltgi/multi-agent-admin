// Spec onboarding-ui: AT-11 (rule 11), the unit half. canMarkDone is a pure UX mirror of
// onboarding-api rule 13: the server still decides every permission.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChecklistView } from '@hr/shared';
import { canMarkDone } from './canMarkDone.js';

const NOW = '2026-11-20T09:00:00Z';
const HASH = 'a'.repeat(64);

type Owner = 'it' | 'admin' | 'manager' | 'buddy';
function task(
  owner: Owner,
  over: { ownerEmployeeId?: string; done?: boolean; blocked?: boolean } = {},
) {
  return {
    id: 't-1',
    title: 'A task',
    owner,
    ...(over.ownerEmployeeId === undefined ? {} : { ownerEmployeeId: over.ownerEmployeeId }),
    source: 'template' as const,
    dueOffsetDays: -2,
    dueDate: '2026-11-27',
    dependsOn: [],
    done: over.done ?? false,
    ...(over.done === true ? { completedBy: 'emp-001', completedAt: NOW } : {}),
    ...(over.blocked === true
      ? { blocked: { reason: 'Waiting on vendor', blockedBy: 'emp-001', blockedAt: NOW } }
      : {}),
  };
}
// Parsed with the facade's own schema, so the fixture is a valid checklist and typed as one.
function checklist() {
  return ChecklistView.shape.checklist.parse({
    id: 'cl-001',
    requestId: 'rq-001',
    newJoinerId: 'nj-001',
    templateId: 'engineer' as const,
    templateVersion: 'v1',
    policyHash: HASH,
    startDate: '2026-11-30',
    newHireTeam: 'team-b',
    managerEmployeeId: 'emp-009',
    buddyEmployeeId: 'emp-010',
    createdBy: 'emp-001',
    tasks: [task('it')],
    removedTemplateTaskIds: [],
    gateResult: {
      verdict: 'AUTO' as const,
      ruleResults: ['checklist_matches_template', 'no_tasks_added', 'no_tasks_removed'].map(
        (ruleId) => ({ ruleId, passed: true, expected: 'x', actual: 'x', message: 'ok' }),
      ),
      reason: 'ok',
      policyVersion: 'ob-v1',
      policyHash: HASH,
    },
    version: 0,
    createdAt: NOW,
  });
}
const MEERA = { employeeId: 'emp-001', roleLabel: 'hr_admin' } as const;
const RAVI = { employeeId: 'emp-002', roleLabel: 'manager' } as const;
const ASHA = { employeeId: 'emp-003', roleLabel: 'employee' } as const;
const MGR9 = { employeeId: 'emp-009', roleLabel: 'manager' } as const;
const BUDDY10 = { employeeId: 'emp-010', roleLabel: 'employee' } as const;

// canMarkDone's parameter types come from the facade; the fixtures above are valid views of them.
const run = (t: ReturnType<typeof task>, p: { employeeId: string; roleLabel: string }): boolean =>
  canMarkDone(t, checklist(), p as Parameters<typeof canMarkDone>[2]);

describe('canMarkDone (onboarding-ui rule 11)', () => {
  it('AT-11: a manager task is markable only by the checklist manager', () => {
    expect(run(task('manager', { ownerEmployeeId: 'emp-009' }), MGR9)).toBe(true);
    expect(run(task('manager', { ownerEmployeeId: 'emp-009' }), MEERA)).toBe(false);
    expect(run(task('manager', { ownerEmployeeId: 'emp-009' }), RAVI)).toBe(false);
    expect(run(task('manager'), MGR9)).toBe(true);
  });

  it('AT-11: a buddy task with a named buddy is markable only by that buddy, never by hr_admin', () => {
    expect(run(task('buddy', { ownerEmployeeId: 'emp-010' }), BUDDY10)).toBe(true);
    expect(run(task('buddy', { ownerEmployeeId: 'emp-010' }), MEERA)).toBe(false);
    expect(run(task('buddy', { ownerEmployeeId: 'emp-010' }), ASHA)).toBe(false);
  });

  it('AT-11: a buddy task with no named buddy is markable only by hr_admin', () => {
    expect(run(task('buddy'), MEERA)).toBe(true);
    expect(run(task('buddy'), RAVI)).toBe(false);
    expect(run(task('buddy'), ASHA)).toBe(false);
  });

  it('AT-11: it and admin tasks are markable only by hr_admin', () => {
    for (const owner of ['it', 'admin'] as const) {
      expect(run(task(owner), MEERA)).toBe(true);
      expect(run(task(owner), RAVI)).toBe(false);
      expect(run(task(owner), MGR9)).toBe(false);
      expect(run(task(owner), ASHA)).toBe(false);
    }
  });

  it('AT-11: a blocked task still counts as markable and a done task never is', () => {
    expect(run(task('it', { blocked: true }), MEERA)).toBe(true);
    for (const owner of ['it', 'admin'] as const) {
      expect(run(task(owner, { done: true }), MEERA)).toBe(false);
    }
    expect(run(task('manager', { done: true }), MGR9)).toBe(false);
    expect(run(task('buddy', { ownerEmployeeId: 'emp-010', done: true }), BUDDY10)).toBe(false);
  });

  it('AT-11: the source holds no Date, fetch or localStorage', () => {
    const file = join(import.meta.dirname, 'canMarkDone.ts');
    expect(existsSync(file), 'canMarkDone.ts exists').toBe(true);
    const text = readFileSync(file, 'utf8')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const banned of ['Date', 'fetch', 'localStorage']) {
      expect(text.includes(banned), `contains ${banned}`).toBe(false);
    }
  });
});
