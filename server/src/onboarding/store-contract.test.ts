// Acceptance tests for specs/onboarding-api.md AT-23 (rule 20): the shared OnboardingStore contract
// for listChecklists(filter), insertProfile, getProfile and removeProfile. The function is exported and
// run here for InMemoryOnboardingStore; adapters.integration.test.ts runs it for MongoOnboardingStore
// (its factory must return an EMPTY checklist and profile collection on every call).
// ASSUMED: OnboardingStore.listChecklists(filter: ChecklistListFilter) -> startDate asc, id asc, at most
// filter.limit rows; insertProfile -> false on a duplicate newJoinerId; getProfile -> null when absent;
// removeProfile deletes one.
import { describe, expect, it } from 'vitest';
import {
  buildTemplateChecklistTasks,
  OnboardingChecklist,
  type OnboardingStore,
} from '../domain/onboarding.js';
import { InMemoryOnboardingStore } from './in-memory.js';

const NOW = '2026-10-21T09:00:00Z';
const HASH = 'a'.repeat(64);
const T = {
  tasks: [
    { id: 'laptop', title: 'Prepare laptop', owner: 'it', dueOffsetDays: -3, dependsOn: [] },
    { id: 'welcome', title: 'Welcome meeting', owner: 'manager', dueOffsetDays: 0, dependsOn: [] },
    {
      id: 'buddy-intro',
      title: 'Buddy introduction',
      owner: 'buddy',
      dueOffsetDays: 1,
      dependsOn: ['welcome'],
    },
  ],
} as const;

interface Mk {
  startDate: string;
  templateId?: 'engineer' | 'sales';
  manager?: string;
  buddy?: string | null;
}
function mk(id: string, o: Mk): OnboardingChecklist {
  const rule = (ruleId: 'checklist_matches_template' | 'no_tasks_added' | 'no_tasks_removed') => ({
    ruleId,
    passed: true,
    expected: 'Synthetic expected',
    actual: 'Synthetic actual',
    message: 'Synthetic message.',
  });
  const manager = o.manager ?? 'emp-002';
  const buddy = o.buddy === undefined ? null : o.buddy;
  return {
    id,
    requestId: `req-${id}`,
    newJoinerId: `nj-${id}`,
    templateId: o.templateId ?? 'engineer',
    templateVersion: 'v1',
    policyHash: HASH,
    startDate: o.startDate,
    newHireTeam: 'team-a',
    managerEmployeeId: manager,
    buddyEmployeeId: buddy,
    createdBy: 'emp-001',
    tasks: buildTemplateChecklistTasks(T, o.startDate, {
      managerEmployeeId: manager,
      buddyEmployeeId: buddy,
    }),
    removedTemplateTaskIds: [],
    gateResult: {
      verdict: 'AUTO',
      ruleResults: [
        rule('checklist_matches_template'),
        rule('no_tasks_added'),
        rule('no_tasks_removed'),
      ],
      reason: 'Checklist matches the template.',
      policyVersion: 'v1',
      policyHash: HASH,
    },
    version: 0,
    createdAt: NOW,
  };
}

function hasStorageKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasStorageKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([k, v]) => k === '_id' || k === '__v' || hasStorageKeys(v));
  }
  return false;
}

// Inserted out of order on purpose.
const FIXTURE = (): OnboardingChecklist[] => [
  mk('c-d', { startDate: '2026-12-08' }),
  mk('c-b', { startDate: '2026-12-01', buddy: 'emp-005' }),
  mk('c-c', { startDate: '2026-12-07', templateId: 'sales', manager: 'emp-009' }),
  mk('c-a', { startDate: '2026-12-01' }),
];
const ALL = { kind: 'all' } as const;

async function seeded(make: () => Promise<OnboardingStore>): Promise<OnboardingStore> {
  const store = await make();
  for (const c of FIXTURE()) expect(await store.insertChecklist(c)).toBe(true);
  return store;
}
const ids = (rows: OnboardingChecklist[]): string[] => rows.map((r) => r.id);

export function onboardingApiStoreContract(
  label: string,
  make: () => Promise<OnboardingStore>,
): void {
  describe(`onboarding-api AT-23: ${label} OnboardingStore list and profile contract`, () => {
    it('AT-23: listChecklists orders by startDate then id, and returns clean parsed records', async () => {
      const store = await seeded(make);
      const rows = await store.listChecklists({ visibleTo: ALL, limit: 10 });
      expect(ids(rows)).toEqual(['c-a', 'c-b', 'c-c', 'c-d']);
      expect(hasStorageKeys(rows)).toBe(false);
      for (const r of rows) expect(OnboardingChecklist.parse(r)).toEqual(r);
    });

    it('AT-23: limit caps the rows, and `after` returns strictly later rows in order', async () => {
      const store = await seeded(make);
      expect(ids(await store.listChecklists({ visibleTo: ALL, limit: 2 }))).toEqual(['c-a', 'c-b']);
      expect(
        ids(
          await store.listChecklists({
            visibleTo: ALL,
            after: { startDate: '2026-12-01', id: 'c-a' },
            limit: 10,
          }),
        ),
      ).toEqual(['c-b', 'c-c', 'c-d']);
      expect(
        ids(
          await store.listChecklists({
            visibleTo: ALL,
            after: { startDate: '2026-12-01', id: 'c-b' },
            limit: 1,
          }),
        ),
      ).toEqual(['c-c']);
      expect(
        ids(
          await store.listChecklists({
            visibleTo: ALL,
            after: { startDate: '2026-12-05', id: 'zzz' },
            limit: 10,
          }),
        ),
      ).toEqual(['c-c', 'c-d']);
      expect(
        await store.listChecklists({
          visibleTo: ALL,
          after: { startDate: '2026-12-08', id: 'c-d' },
          limit: 10,
        }),
      ).toEqual([]);
    });

    it('AT-23: templateId and inclusive startDate bounds filter, and combine with paging', async () => {
      const store = await seeded(make);
      expect(
        ids(await store.listChecklists({ visibleTo: ALL, templateId: 'sales', limit: 10 })),
      ).toEqual(['c-c']);
      expect(
        ids(
          await store.listChecklists({
            visibleTo: ALL,
            startDateFrom: '2026-12-01',
            startDateTo: '2026-12-07',
            limit: 10,
          }),
        ),
      ).toEqual(['c-a', 'c-b', 'c-c']);
      expect(
        ids(
          await store.listChecklists({
            visibleTo: ALL,
            startDateFrom: '2026-12-07',
            startDateTo: '2026-12-07',
            limit: 10,
          }),
        ),
      ).toEqual(['c-c']);
      expect(
        ids(
          await store.listChecklists({
            visibleTo: ALL,
            startDateFrom: '2026-12-01',
            limit: 1,
            after: { startDate: '2026-12-01', id: 'c-a' },
          }),
        ),
      ).toEqual(['c-b']);
    });

    it('AT-23: visibleTo employee matches the manager or any task owner, and nobody else', async () => {
      const store = await seeded(make);
      const forEmployee = async (employeeId: string) =>
        ids(await store.listChecklists({ visibleTo: { kind: 'employee', employeeId }, limit: 10 }));
      expect(await forEmployee('emp-002')).toEqual(['c-a', 'c-b', 'c-d']); // manager
      expect(await forEmployee('emp-005')).toEqual(['c-b']); // named buddy only
      expect(await forEmployee('emp-009')).toEqual(['c-c']);
      expect(await forEmployee('emp-004')).toEqual([]);
      expect(await forEmployee('{"$ne":null}')).toEqual([]);
    });

    it('AT-23: profiles: insert never overwrites, get returns the exact record or null, remove deletes', async () => {
      const store = await make();
      const p = {
        newJoinerId: 'nj-p1',
        checklistId: 'c-a',
        displayName: 'Test Joiner A',
        createdAt: NOW,
      };
      expect(await store.insertProfile(p)).toBe(true);
      expect(await store.insertProfile({ ...p, displayName: 'Test Joiner B' })).toBe(false);
      const got = await store.getProfile('nj-p1');
      expect(got).toEqual(p);
      expect(hasStorageKeys(got)).toBe(false);
      expect(await store.getProfile('nj-none')).toBeNull();
      expect(await store.getProfile('{"$ne":null}')).toBeNull();
      await store.removeProfile('nj-p1');
      expect(await store.getProfile('nj-p1')).toBeNull();
      await store.removeProfile('nj-p1'); // removing an absent profile is not an error
    });
  });
}

onboardingApiStoreContract('in-memory', () => Promise.resolve(new InMemoryOnboardingStore()));
