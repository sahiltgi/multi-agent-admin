// Acceptance tests for specs/onboarding-api.md, the schema half: AT-19 (the optional `blocked` field and
// what must NOT change), AT-23 (NewJoinerProfile placement, ErrorCode), and the request/response
// schemas of the four routes (rules 3, 4, 9, 11, 12). Pure schema tests; synthetic data only.
// ASSUMED contracts (reported to the coordinator):
//   domain/schemas.ts     ChecklistTask gains `blocked: TaskBlock.optional()` (+ refine: not done and blocked),
//                         exports TaskBlock, TaskStatus
//   domain/onboarding.ts  re-exports them, and exports taskStatus(task), NewJoinerName, NewJoinerProfile,
//                         type ChecklistListFilter
//   onboarding/schemas.ts CreateOnboardingBody, CreateOnboardingResponse, TaskStatusBody,
//                         ListOnboardingQuery, ListOnboardingResponse, ChecklistSummary, OwnerProgress,
//                         ChecklistView (+ newJoiner)
//   http/errors.ts        ErrorCode gains 'invalid_transition' (409, "This task can't move to that status.")
import { describe, expect, it } from 'vitest';
import { ErrorBody, ErrorCode, errorBody } from '../http/errors.js';
import { MODELS } from '../models/index.js';
import {
  ChecklistView,
  CreateOnboardingBody,
  CreateOnboardingResponse,
  ListOnboardingQuery,
  ListOnboardingResponse,
  OwnerProgress,
  TaskStatusBody,
} from '../onboarding/schemas.js';
import {
  applyDeviation,
  buildTemplateChecklistTasks,
  ChecklistTask,
  NewJoinerProfile,
  taskStatus,
  type OnboardingChecklist,
  type OnboardingDeviation,
} from './onboarding.js';
import { ENTITY_SCHEMAS } from './schemas.js';

type Rec = Record<string, unknown>;
const NOW = '2026-10-21T09:00:00Z';
const HASH = 'a'.repeat(64);

const T = {
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
const TASKS = buildTemplateChecklistTasks(T, '2026-12-01', {
  managerEmployeeId: 'emp-002',
  buddyEmployeeId: 'emp-005',
});
const laptop = (): Rec => ({ ...TASKS[0] });
const BLOCK = { reason: 'Waiting on vendor', blockedBy: 'emp-001', blockedAt: NOW };

// ================= AT-19 =================

describe('onboarding-api AT-19: ChecklistTask gains an optional blocked field', () => {
  it('AT-19: a task with done: true and a blocked value fails to parse, while the same task without blocked parses', () => {
    const doneTask = { ...laptop(), done: true, completedBy: 'emp-001', completedAt: NOW };
    expect(ChecklistTask.safeParse(doneTask).success).toBe(true);
    expect(ChecklistTask.safeParse({ ...doneTask, blocked: BLOCK }).success).toBe(false);
  });

  it('AT-19: a blocked value on an open task parses; one without a reason (or with extra keys) fails', () => {
    expect(ChecklistTask.safeParse({ ...laptop(), blocked: BLOCK }).success).toBe(true);
    const noReason = { blockedBy: BLOCK.blockedBy, blockedAt: BLOCK.blockedAt };
    expect(ChecklistTask.safeParse({ ...laptop(), blocked: noReason }).success).toBe(false);
    expect(
      ChecklistTask.safeParse({ ...laptop(), blocked: { ...BLOCK, reason: '   ' } }).success,
    ).toBe(false);
    expect(
      ChecklistTask.safeParse({ ...laptop(), blocked: { ...BLOCK, reason: 'x'.repeat(201) } })
        .success,
    ).toBe(false);
    expect(
      ChecklistTask.safeParse({ ...laptop(), blocked: { ...BLOCK, reason: 'x'.repeat(200) } })
        .success,
    ).toBe(true);
    expect(ChecklistTask.safeParse({ ...laptop(), blocked: { ...BLOCK, extra: 1 } }).success).toBe(
      false,
    );
  });

  it('AT-19: fixture T tasks (no blocked key) still parse, and the builder emits no blocked key', () => {
    expect(TASKS).toHaveLength(6);
    for (const t of TASKS) {
      expect(ChecklistTask.safeParse(t).success).toBe(true);
      expect(t).not.toHaveProperty('blocked');
    }
  });

  it('AT-19: applyDeviation of an add emits a task with no blocked key', () => {
    const checklist = {
      id: 'chk-1',
      requestId: 'req-1',
      newJoinerId: 'nj-1',
      templateId: 'engineer',
      templateVersion: 'v1',
      policyHash: HASH,
      startDate: '2026-12-01',
      newHireTeam: 'team-a',
      managerEmployeeId: 'emp-002',
      buddyEmployeeId: 'emp-005',
      createdBy: 'emp-001',
      tasks: TASKS,
      removedTemplateTaskIds: [],
      gateResult: {
        verdict: 'MANAGER',
        ruleResults: [
          {
            ruleId: 'checklist_matches_template',
            passed: true,
            expected: 'e',
            actual: 'a',
            message: 'm',
          },
          { ruleId: 'no_tasks_added', passed: false, expected: 'e', actual: 'a', message: 'm' },
          { ruleId: 'no_tasks_removed', passed: true, expected: 'e', actual: 'a', message: 'm' },
        ],
        reason: 'Deviations need manager approval.',
        policyVersion: 'v1',
        policyHash: HASH,
      },
      version: 0,
      createdAt: NOW,
    } as unknown as OnboardingChecklist;
    const deviation = {
      id: 'dev-1',
      checklistId: 'chk-1',
      requestId: 'req-1',
      change: {
        kind: 'add',
        title: 'Order second monitor',
        owner: 'it',
        dueOffsetDays: -2,
        dependsOn: ['laptop'],
      },
      rationale: 'Requested in notes',
      status: 'pending',
      gateResult: checklist.gateResult,
      proposedBy: 'emp-001',
      createdAt: NOW,
    } as unknown as OnboardingDeviation;
    const next = applyDeviation(checklist, deviation);
    const added = next.tasks.find((t) => t.id === 'added-1');
    expect(added).toBeDefined();
    expect(added).not.toHaveProperty('blocked');
  });

  it('AT-19: ENTITY_SCHEMAS and MODELS keep 8 keys', () => {
    expect(Object.keys(ENTITY_SCHEMAS)).toHaveLength(8);
    expect(Object.keys(MODELS)).toHaveLength(8);
  });

  it('AT-19: the Mongoose OnboardingChecklist model describes the optional blocked sub-document', () => {
    // domain-schemas AT-17 parity: a task with `blocked` must not be stripped by the model.
    const doc = new MODELS.OnboardingChecklist({
      id: 'chk-1',
      requestId: 'req-1',
      newJoinerId: 'nj-1',
      templateId: 'engineer',
      templateVersion: 'v1',
      policyHash: HASH,
      startDate: '2026-12-01',
      newHireTeam: 'team-a',
      managerEmployeeId: 'emp-002',
      buddyEmployeeId: null,
      createdBy: 'emp-001',
      tasks: [{ ...laptop(), blocked: BLOCK }],
      removedTemplateTaskIds: [],
      gateResult: {},
      version: 0,
      createdAt: NOW,
    } as never);
    const first = (doc.toObject() as unknown as { tasks: Rec[] }).tasks[0];
    expect(first?.blocked).toMatchObject({ reason: 'Waiting on vendor', blockedBy: 'emp-001' });
  });
});

describe('onboarding-api AT-19: taskStatus is derived, never stored', () => {
  it('AT-19: done wins, then blocked, else open', () => {
    expect(taskStatus({ ...laptop(), done: true })).toBe('done');
    expect(taskStatus({ ...laptop(), blocked: BLOCK } as never)).toBe('blocked');
    expect(taskStatus(laptop() as never)).toBe('open');
  });
});

// ================= AT-23 =================

describe('onboarding-api AT-23: placement and error code', () => {
  it('AT-23: NewJoinerProfile is a strict storage-only schema outside ENTITY_SCHEMAS and MODELS', () => {
    expect(Object.keys(ENTITY_SCHEMAS)).not.toContain('NewJoinerProfile');
    expect(Object.keys(MODELS)).not.toContain('NewJoinerProfile');
    const profile = {
      newJoinerId: 'nj-1',
      checklistId: 'chk-1',
      displayName: 'Test Joiner A',
      createdAt: NOW,
    };
    expect(NewJoinerProfile.parse(profile)).toEqual(profile);
    expect(NewJoinerProfile.safeParse({ ...profile, email: 'x@y.test' }).success).toBe(false);
    expect(
      NewJoinerProfile.safeParse({ ...profile, displayName: 'tja@corp.example' }).success,
    ).toBe(false);
    expect(NewJoinerProfile.safeParse({ ...profile, displayName: 'Joiner 7' }).success).toBe(false);
    expect(NewJoinerProfile.safeParse({ ...profile, displayName: '<b>Joiner</b>' }).success).toBe(
      false,
    );
    expect(
      NewJoinerProfile.safeParse({ ...profile, displayName: "Test O'Neil-Smith" }).success,
    ).toBe(true);
    expect(NewJoinerProfile.safeParse({ ...profile, displayName: 'A'.repeat(100) }).success).toBe(
      true,
    );
    expect(NewJoinerProfile.safeParse({ ...profile, displayName: 'A'.repeat(101) }).success).toBe(
      false,
    );
  });

  it('AT-23: ErrorCode includes invalid_transition: 409 with the fixed message, and the other codes are unchanged', () => {
    expect(ErrorCode.options).toContain('invalid_transition');
    const body = errorBody('invalid_transition');
    expect(ErrorBody.parse(body).error.message).toBe("This task can't move to that status.");
    for (const code of [
      'already_done',
      'dependencies_incomplete',
      'action_not_allowed',
      'forbidden',
    ]) {
      expect(ErrorCode.options).toContain(code);
    }
  });
});

// ================= request and response schemas =================

describe('onboarding-api rule 12: TaskStatusBody', () => {
  it.each([
    { status: 'done' },
    { status: 'open' },
    { status: 'blocked', reason: 'Waiting on vendor' },
  ])('accepts %j', (body) => {
    expect(TaskStatusBody.safeParse(body).success).toBe(true);
  });
  it.each([
    {},
    { status: 'closed' },
    { status: 'blocked' },
    { status: 'blocked', reason: '   ' },
    { status: 'blocked', reason: 'x'.repeat(201) },
    { status: 'done', completedBy: 'emp-001' },
    { status: 'done', completedAt: '2020-01-01T00:00:00Z' },
    { status: 'done', done: true },
    { status: 'done', blockedBy: 'emp-001' },
    { status: 'open', title: 'x' },
    { status: 'open', reason: 'x' },
    { done: true },
  ])('rejects %j', (body) => {
    expect(TaskStatusBody.safeParse(body).success).toBe(false);
  });
  it('trims a blocked reason and accepts exactly 200 characters after trimming', () => {
    const parsed = TaskStatusBody.parse({ status: 'blocked', reason: `  ${'y'.repeat(200)}  ` });
    expect(parsed).toEqual({ status: 'blocked', reason: 'y'.repeat(200) });
  });
});

describe('onboarding-api rule 3: CreateOnboardingBody', () => {
  const BODY0 = {
    newJoinerName: 'Test Joiner A',
    templateId: 'engineer',
    startDate: '2026-12-01',
    newHireTeam: 'team-a',
    managerEmployeeId: 'emp-002',
    buddyEmployeeId: 'emp-005',
  };
  it('accepts Body0, a null buddy, notes of 2000 characters and a well-formed idempotency key', () => {
    expect(CreateOnboardingBody.safeParse(BODY0).success).toBe(true);
    expect(CreateOnboardingBody.safeParse({ ...BODY0, buddyEmployeeId: null }).success).toBe(true);
    expect(CreateOnboardingBody.safeParse({ ...BODY0, notes: 'n'.repeat(2000) }).success).toBe(
      true,
    );
    expect(CreateOnboardingBody.safeParse({ ...BODY0, idempotencyKey: 'k-1_A' }).success).toBe(
      true,
    );
  });
  it.each([
    ['notes of 2001 characters', { notes: 'n'.repeat(2001) }],
    ['a bad idempotency key', { idempotencyKey: 'has space' }],
    ['a 129-character idempotency key', { idempotencyKey: 'k'.repeat(129) }],
    ['an unknown team shape', { newHireTeam: 'Team A' }],
    ['a malformed manager id', { managerEmployeeId: 'emp-2' }],
    ['a malformed buddy id', { buddyEmployeeId: 'emp-5' }],
    ['a datetime start date', { startDate: '2026-12-01T12:00' }],
    ['a non-existent date', { startDate: '2026-02-30' }],
    ['an unknown template', { templateId: 'designer' }],
    ['a role key', { role: 'hr_admin' }],
    ['an employeeId key', { employeeId: 'emp-004' }],
    ['a createdBy key', { createdBy: 'emp-009' }],
    ['an actorRole key', { actorRole: 'hr_admin' }],
    ['a tasks key', { tasks: [] }],
    ['a verdict key', { verdict: 'AUTO' }],
    ['an approved key', { approved: true }],
    ['a deviations key', { deviations: [] }],
    ['a status key', { status: 'done' }],
  ])('rejects %s', (_n, over) => {
    expect(CreateOnboardingBody.safeParse({ ...BODY0, ...over }).success).toBe(false);
  });
  it('rejects a body with buddyEmployeeId omitted', () => {
    const rest = Object.fromEntries(Object.entries(BODY0).filter(([k]) => k !== 'buddyEmployeeId'));
    expect(CreateOnboardingBody.safeParse(rest).success).toBe(false);
  });
});

describe('onboarding-api rule 8: CreateOnboardingResponse has fixed text and ids only', () => {
  it('accepts both arms and rejects any extra key such as a name, notes or rationale', () => {
    const created = {
      kind: 'checklist_created',
      requestId: 'req-1',
      checklistId: 'chk-1',
      verdict: 'MANAGER',
      pendingDeviationIds: ['dev-1'],
      text: 'PENDING-MANAGER-FIXTURE',
    };
    const escalated = {
      kind: 'escalated',
      requestId: 'req-1',
      reason: 'agent_escalated',
      agentReason: 'model_unavailable',
      text: 'ESCALATED-FIXTURE',
    };
    expect(CreateOnboardingResponse.safeParse(created).success).toBe(true);
    expect(CreateOnboardingResponse.safeParse(escalated).success).toBe(true);
    for (const extra of [
      { newJoinerName: 'x' },
      { notes: 'x' },
      { rationale: 'x' },
      { displayName: 'x' },
    ]) {
      expect(CreateOnboardingResponse.safeParse({ ...created, ...extra }).success).toBe(false);
      expect(CreateOnboardingResponse.safeParse({ ...escalated, ...extra }).success).toBe(false);
    }
    for (const reason of [
      'agent_escalated',
      'needs_details',
      'invalid_agent_output',
      'request_id_mismatch',
      'agent_error',
    ]) {
      expect(
        CreateOnboardingResponse.safeParse({ ...escalated, reason, agentReason: null }).success,
      ).toBe(true);
    }
    expect(CreateOnboardingResponse.safeParse({ ...escalated, reason: 'made_up' }).success).toBe(
      false,
    );
  });
});

describe('onboarding-api rule 11: ListOnboardingQuery and the summaries', () => {
  it('accepts no query, limit 1 and 50 (coerced from strings), filters and equal bounds', () => {
    expect(ListOnboardingQuery.safeParse({}).success).toBe(true);
    expect(ListOnboardingQuery.parse({ limit: '1' }).limit).toBe(1);
    expect(ListOnboardingQuery.parse({ limit: '50' }).limit).toBe(50);
    expect(
      ListOnboardingQuery.safeParse({
        templateId: 'sales',
        startDateFrom: '2026-12-03',
        startDateTo: '2026-12-03',
        cursor: 'abc_DEF-123',
      }).success,
    ).toBe(true);
  });
  it.each([
    { limit: '0' },
    { limit: '51' },
    { limit: 'abc' },
    { limit: '2.5' },
    { cursor: '!!' },
    { cursor: 'a'.repeat(201) },
    { role: 'hr_admin' },
    { templateId: 'designer' },
    { startDateFrom: '2026-13-01' },
  ])('rejects %j', (q) => {
    expect(ListOnboardingQuery.safeParse(q).success).toBe(false);
  });
  it('ListOnboardingResponse is strict and a summary has no tasks, name, displayName or email', () => {
    const summary = {
      checklistId: 'chk-a',
      templateId: 'engineer',
      startDate: '2026-12-01',
      newHireTeam: 'team-a',
      managerEmployeeId: 'emp-002',
      buddyEmployeeId: null,
      progress: ['it', 'admin', 'manager', 'buddy'].map((owner) => ({
        owner,
        total: 1,
        done: 0,
        blocked: 0,
      })),
      pendingDeviations: 0,
      createdAt: NOW,
    };
    expect(
      ListOnboardingResponse.safeParse({ checklists: [summary], nextCursor: null }).success,
    ).toBe(true);
    for (const extra of [
      { tasks: [] },
      { newJoinerName: 'x' },
      { displayName: 'x' },
      { email: 'x@y.test' },
    ]) {
      expect(
        ListOnboardingResponse.safeParse({
          checklists: [{ ...summary, ...extra }],
          nextCursor: null,
        }).success,
      ).toBe(false);
    }
    expect(
      ListOnboardingResponse.safeParse({ checklists: [], nextCursor: null, total: 0 }).success,
    ).toBe(false);
    expect(
      ListOnboardingResponse.safeParse({
        checklists: [{ ...summary, progress: [] }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe('onboarding-api rule 10: OwnerProgress and ChecklistView', () => {
  it('OwnerProgress gains blocked and stays strict', () => {
    expect(OwnerProgress.safeParse({ owner: 'it', total: 2, done: 0, blocked: 1 }).success).toBe(
      true,
    );
    expect(OwnerProgress.safeParse({ owner: 'it', total: 2, done: 0 }).success).toBe(false);
    expect(OwnerProgress.safeParse({ owner: 'it', total: 2, done: 0, blocked: -1 }).success).toBe(
      false,
    );
    expect(
      OwnerProgress.safeParse({ owner: 'it', total: 2, done: 0, blocked: 0, x: 1 }).success,
    ).toBe(false);
  });
  it('ChecklistView has newJoiner: null or { displayName }, strictly', () => {
    const shape = ChecklistView.shape as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual([
      'checklist',
      'newJoiner',
      'pendingDeviationIds',
      'progress',
    ]);
  });
});
