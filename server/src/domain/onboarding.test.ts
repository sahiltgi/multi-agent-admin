// Acceptance tests for specs/onboarding.md: AT-6, AT-7, AT-34 and the applyDeviation part of AT-30.
// Module under test: server/src/domain/onboarding.ts (not written yet). Fixture template T is
// synthetic test data from the spec; it is not the real v1 content.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OnboardingChecklistModel } from '../models/index.js';
import {
  DeviationConflictError,
  addCalendarDays,
  applyDeviation,
  buildTemplateChecklistTasks,
  OnboardingChecklist,
  OnboardingDeviation,
} from './onboarding.js';
import { ENTITY_SCHEMAS } from './schemas.js';

type Rec = Record<string, unknown>;

const HASH = 'a'.repeat(64);
const START = '2026-12-01';

const TEMPLATE_T = {
  title: 'Engineer',
  tasks: [
    { id: 'laptop', title: 'Prepare laptop', owner: 'it', dueOffsetDays: -3, dependsOn: [] },
    {
      id: 'accounts',
      title: 'Create accounts',
      owner: 'it',
      dueOffsetDays: -1,
      dependsOn: ['laptop'],
    },
    { id: 'desk', title: 'Assign desk', owner: 'admin', dueOffsetDays: -1, dependsOn: [] },
    { id: 'welcome', title: 'Welcome meeting', owner: 'manager', dueOffsetDays: 0, dependsOn: [] },
    {
      id: 'buddy-intro',
      title: 'Buddy introduction',
      owner: 'buddy',
      dueOffsetDays: 1,
      dependsOn: ['welcome'],
    },
    {
      id: 'first-review',
      title: 'First-week check-in',
      owner: 'manager',
      dueOffsetDays: 7,
      dependsOn: ['accounts', 'welcome'],
    },
  ],
} as const;

const DUE: Record<string, string> = {
  laptop: '2026-11-28',
  accounts: '2026-11-30',
  desk: '2026-11-30',
  welcome: '2026-12-01',
  'buddy-intro': '2026-12-02',
  'first-review': '2026-12-08',
};

/** The fixture table as ChecklistTask values (spec AT-3, AT-6). */
function expectedTasks(buddy: string | null): Rec[] {
  return TEMPLATE_T.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    owner: t.owner,
    ...(t.owner === 'manager' ? { ownerEmployeeId: 'emp-002' } : {}),
    ...(t.owner === 'buddy' && buddy !== null ? { ownerEmployeeId: buddy } : {}),
    source: 'template',
    dueOffsetDays: t.dueOffsetDays,
    dueDate: DUE[t.id],
    dependsOn: [...t.dependsOn],
    done: false,
  }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const RULE = (ruleId: string, passed: boolean): Rec => ({
  ruleId,
  passed,
  expected: 'synthetic expected',
  actual: 'synthetic actual',
  message: 'Synthetic message.',
});
const GATE_MANAGER: Rec = {
  verdict: 'MANAGER',
  ruleResults: [
    RULE('checklist_matches_template', true),
    RULE('no_tasks_added', true),
    RULE('no_tasks_removed', false),
  ],
  reason: 'Deviations need manager approval.',
  policyVersion: 'v1',
  policyHash: HASH,
};

function checklist(over: Rec = {}): Rec {
  return {
    id: 'chk-001',
    requestId: 'req-001',
    newJoinerId: 'nj-001',
    templateId: 'engineer',
    templateVersion: 'v1',
    policyHash: HASH,
    startDate: START,
    newHireTeam: 'team-a',
    managerEmployeeId: 'emp-002',
    buddyEmployeeId: 'emp-005',
    createdBy: 'emp-001',
    tasks: expectedTasks('emp-005'),
    removedTemplateTaskIds: [],
    gateResult: GATE_MANAGER,
    version: 0,
    createdAt: '2026-10-21T09:00:00Z',
    ...over,
  };
}

function sourceOf(rel: string): string {
  const file = fileURLToPath(new URL(rel, import.meta.url));
  expect(existsSync(file), `${rel} must exist`).toBe(true);
  return readFileSync(file, 'utf8');
}

describe('onboarding AT-6: buildTemplateChecklistTasks', () => {
  const assignees = { managerEmployeeId: 'emp-002', buddyEmployeeId: 'emp-005' };

  it('AT-6: pure and deterministic on deep-frozen inputs, equal to the fixture table', () => {
    const template = deepFreeze(structuredClone(TEMPLATE_T));
    const frozenAssignees = deepFreeze({ ...assignees });
    const a = buildTemplateChecklistTasks(template, START, frozenAssignees);
    const b = buildTemplateChecklistTasks(template, START, frozenAssignees);
    expect(a).toEqual(b);
    expect(a).toEqual(expectedTasks('emp-005'));
    expect(a.map((t) => t.id)).toEqual(TEMPLATE_T.tasks.map((t) => t.id)); // YAML order
    for (const t of a) {
      expect(t.source).toBe('template');
      expect(t.done).toBe(false);
      expect(t).not.toHaveProperty('completedBy');
      expect(t).not.toHaveProperty('completedAt');
    }
    const byId = new Map(a.map((t) => [t.id, t]));
    expect(byId.get('laptop')).not.toHaveProperty('ownerEmployeeId');
    expect(byId.get('desk')).not.toHaveProperty('ownerEmployeeId');
  });

  it('AT-6: with no buddy, buddy-intro has no ownerEmployeeId', () => {
    const tasks = buildTemplateChecklistTasks(TEMPLATE_T, START, {
      managerEmployeeId: 'emp-002',
      buddyEmployeeId: null,
    });
    const intro = tasks.find((t) => t.id === 'buddy-intro');
    expect(intro).toBeDefined();
    expect(intro).not.toHaveProperty('ownerEmployeeId');
    expect(tasks).toEqual(expectedTasks(null));
  });

  it('AT-6: the module reads no clock, randomness or fs', () => {
    const src = sourceOf('./onboarding.ts');
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(\s*\)/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
  });
});

describe('onboarding AT-7: addCalendarDays', () => {
  it('AT-7: UTC calendar arithmetic across months, years and leap days, with no weekend shift', () => {
    expect(addCalendarDays('2027-01-01', -3)).toBe('2026-12-29');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addCalendarDays('2026-12-01', 0)).toBe('2026-12-01');
    expect(addCalendarDays('2026-12-01', -3)).toBe('2026-11-28'); // a Saturday, unshifted
  });
});

describe('onboarding AT-30 (below the dispatcher): applyDeviation', () => {
  const orphaned = (): Rec => {
    const tasks = expectedTasks('emp-005');
    tasks.push({
      id: 'added-1',
      title: 'Order second monitor',
      owner: 'it',
      source: 'added',
      dueOffsetDays: -2,
      dueDate: '2026-11-29',
      dependsOn: ['desk'],
      done: false,
    });
    return checklist({ tasks, version: 1 });
  };

  it('AT-30: removing a task that an applied addition depends on throws DeviationConflictError and mutates nothing', () => {
    const frozen = deepFreeze(orphaned());
    const before = structuredClone(frozen);
    const deviation = {
      id: 'dev-001',
      checklistId: 'chk-001',
      requestId: 'req-001',
      change: { kind: 'remove', templateTaskId: 'desk' },
      rationale: 'Requested by hr_admin',
      status: 'pending',
      gateResult: GATE_MANAGER,
      proposedBy: 'emp-001',
      createdAt: '2026-10-21T09:00:00Z',
    };
    expect(() => applyDeviation(frozen as never, deviation as never)).toThrow(
      DeviationConflictError,
    );
    expect(frozen).toEqual(before);
  });
});

describe('onboarding AT-34: schemas', () => {
  const taskDone = (over: Rec): Rec => {
    const [first, ...rest] = expectedTasks('emp-005');
    return checklist({ tasks: [{ ...first, ...over }, ...rest] });
  };
  const schema = ENTITY_SCHEMAS.OnboardingChecklist;

  it('AT-34: the amended checklist parses, and done must match the completion fields', () => {
    expect(OnboardingChecklist.safeParse(checklist()).success).toBe(true);
    expect(schema.safeParse(checklist()).success).toBe(true);
    const completed = { done: true, completedBy: 'emp-001', completedAt: '2026-10-21T09:00:00Z' };
    expect(OnboardingChecklist.safeParse(taskDone(completed)).success).toBe(true);
    // done: true without completedBy, and completedBy with done: false
    expect(OnboardingChecklist.safeParse(taskDone({ done: true })).success).toBe(false);
    expect(
      OnboardingChecklist.safeParse(
        taskDone({ completedBy: 'emp-001', completedAt: '2026-10-21T09:00:00Z' }),
      ).success,
    ).toBe(false);
    expect(schema.safeParse(taskDone({ done: true })).success).toBe(false);
  });

  it('AT-34: a dependency on a task that is not on the checklist fails, and so does a cycle', () => {
    const tasks = expectedTasks('emp-005');
    const unknown = tasks.map((t) => (t.id === 'desk' ? { ...t, dependsOn: ['ghost'] } : t));
    expect(OnboardingChecklist.safeParse(checklist({ tasks: unknown })).success).toBe(false);
    expect(schema.safeParse(checklist({ tasks: unknown })).success).toBe(false);
    const cycle = tasks.map((t) => {
      if (t.id === 'laptop') return { ...t, dependsOn: ['accounts'] };
      return t;
    });
    expect(OnboardingChecklist.safeParse(checklist({ tasks: cycle })).success).toBe(false);
    expect(schema.safeParse(checklist({ tasks: cycle })).success).toBe(false);
  });

  it('AT-34: ENTITY_SCHEMAS has 8 keys and does not hold OnboardingDeviation', () => {
    expect(Object.keys(ENTITY_SCHEMAS)).toHaveLength(8);
    expect(Object.keys(ENTITY_SCHEMAS)).not.toContain('OnboardingDeviation');
    expect(typeof OnboardingDeviation.safeParse).toBe('function');
    expect(
      OnboardingDeviation.safeParse({
        id: 'dev-001',
        checklistId: 'chk-001',
        requestId: 'req-001',
        change: { kind: 'remove', templateTaskId: 'desk' },
        rationale: 'Requested by hr_admin',
        status: 'pending',
        gateResult: GATE_MANAGER,
        proposedBy: 'emp-001',
        createdAt: '2026-10-21T09:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('AT-34: the Mongoose OnboardingChecklistModel follows the amended fields', () => {
    for (const path of [
      'requestId',
      'policyHash',
      'startDate',
      'newHireTeam',
      'managerEmployeeId',
      'buddyEmployeeId',
      'createdBy',
      'gateResult',
      'version',
    ]) {
      expect(OnboardingChecklistModel.schema.path(path), path).toBeDefined();
    }
  });

  it('AT-34: nothing under server/src/http or server/src/onboarding imports from gate/', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const dirs = ['http', 'onboarding'].map((d) => join(root, d));
    expect(existsSync(join(root, 'onboarding')), 'server/src/onboarding must exist').toBe(true);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    for (const d of dirs) if (existsSync(d)) walk(d);
    expect(files.some((f) => f.includes('/onboarding/'))).toBe(true);
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"][^'"]*\/gate\//);
    }
  });
});
