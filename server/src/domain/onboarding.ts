// Onboarding domain (spec onboarding, rules 2, 14, 23, 26): the pure checklist builder, deviation
// schemas and applyDeviation, plus the store and directory ports. No I/O, clock or randomness:
// callers pass dates in. The checklist and gate-result schemas live in ./schemas.ts (so
// ENTITY_SCHEMAS can hold them without an import cycle) and are re-exported here.
import { z } from 'zod';
import {
  ChecklistTask,
  DueOffsetDays,
  Id,
  IsoDate,
  IsoDateTime,
  OnboardingChecklist,
  OnboardingGateResult,
  TaskOwner,
  TemplateTaskId,
  type Employee,
  type Team,
} from './schemas.js';

export {
  ChecklistTask,
  DueOffsetDays,
  MAX_OFFSET_DAYS,
  MIN_OFFSET_DAYS,
  OnboardingChecklist,
  OnboardingGateResult,
  OnboardingRuleId,
  OnboardingRuleResult,
  OnboardingVerdict,
  TEMPLATE_IDS,
  TemplateId,
  TemplateTaskId,
  hasDependencyCycle,
  unknownDependencies,
} from './schemas.js';

// ---- Deviation proposals (rule 14) ----
export const AddTaskChange = z
  .object({
    kind: z.literal('add'),
    title: z.string().trim().min(1).max(120),
    owner: TaskOwner,
    dueOffsetDays: DueOffsetDays,
    dependsOn: z.array(TemplateTaskId).max(10),
  })
  .strict();
export type AddTaskChange = z.infer<typeof AddTaskChange>;

export const RemoveTaskChange = z
  .object({ kind: z.literal('remove'), templateTaskId: TemplateTaskId })
  .strict();
export type RemoveTaskChange = z.infer<typeof RemoveTaskChange>;

export const DeviationChange = z.discriminatedUnion('kind', [AddTaskChange, RemoveTaskChange]);
export type DeviationChange = z.infer<typeof DeviationChange>;

export const MAX_DEVIATIONS_PER_RUN = 10;

// ---- Deviation record: storage-only, outside ENTITY_SCHEMAS and MODELS (rule 21; OQ-6) ----
export const DeviationStatus = z.enum(['pending', 'applied', 'rejected']);
export type DeviationStatus = z.infer<typeof DeviationStatus>;

export const OnboardingDeviation = z
  .object({
    id: Id, // the approval item's subjectId
    checklistId: Id,
    requestId: Id,
    change: DeviationChange,
    rationale: z.string().trim().min(1).max(300), // model text: data, shown to the manager only
    status: DeviationStatus,
    gateResult: OnboardingGateResult, // the snapshot the manager confirms
    proposedBy: Id,
    createdAt: IsoDateTime,
  })
  .strict();
export type OnboardingDeviation = z.infer<typeof OnboardingDeviation>;

// ---- Ports ----
export interface OnboardingStore {
  /** false if the id exists. */
  insertChecklist(c: OnboardingChecklist): Promise<boolean>;
  getChecklist(id: string): Promise<OnboardingChecklist | null>;
  /** Writes only if the stored version is still `expectedVersion`. */
  saveChecklistIfVersion(c: OnboardingChecklist, expectedVersion: number): Promise<boolean>;
  /** Compensation only (rule 22). */
  removeChecklist(id: string): Promise<void>;
  /** false if the id exists. */
  insertDeviation(d: OnboardingDeviation): Promise<boolean>;
  getDeviation(id: string): Promise<OnboardingDeviation | null>;
  /** Writes only if the stored status is still `expected`. */
  saveDeviationIfStatus(d: OnboardingDeviation, expected: DeviationStatus): Promise<boolean>;
  /** Compensation only (rule 22). */
  removeDeviation(id: string): Promise<void>;
  /** A checklist's deviations, in insertion order. */
  listDeviationsByChecklist(checklistId: string): Promise<OnboardingDeviation[]>;
}

/** Directory reads the onboarding agent and routes need. */
export interface OnboardingDirectory {
  getById(id: string): Promise<Employee | null>;
  getTeamById(id: string): Promise<Team | null>;
}

// ---- Pure helpers ----
interface TemplateTaskLike {
  readonly id: string;
  readonly title: string;
  readonly owner: TaskOwner;
  readonly dueOffsetDays: number;
  readonly dependsOn: readonly string[];
}
interface TemplateLike {
  readonly tasks: readonly TemplateTaskLike[];
}
export interface Assignees {
  readonly managerEmployeeId: string;
  readonly buddyEmployeeId: string | null;
}

const DAY_MS = 86_400_000;

/** UTC calendar arithmetic: no weekend or holiday shift (OQ-8). */
export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const at = new Date(0);
  at.setUTCFullYear(y, m - 1, d); // setUTCFullYear keeps years 0-99 literal
  const shifted = new Date(at.getTime() + days * DAY_MS);
  const yyyy = String(shifted.getUTCFullYear()).padStart(4, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ownerEmployeeIdFor(owner: TaskOwner, assignees: Assignees): string | null {
  if (owner === 'manager') return assignees.managerEmployeeId;
  if (owner === 'buddy') return assignees.buddyEmployeeId;
  return null;
}

/** One ChecklistTask per template task, in template order (rule 2). Never mutates its inputs. */
export function buildTemplateChecklistTasks(
  template: TemplateLike,
  startDate: IsoDate,
  assignees: Assignees,
): ChecklistTask[] {
  return template.tasks.map((t) => {
    const ownerEmployeeId = ownerEmployeeIdFor(t.owner, assignees);
    return {
      id: t.id,
      title: t.title,
      owner: t.owner,
      ...(ownerEmployeeId === null ? {} : { ownerEmployeeId }),
      source: 'template' as const,
      dueOffsetDays: t.dueOffsetDays,
      dueDate: addCalendarDays(startDate, t.dueOffsetDays),
      dependsOn: [...t.dependsOn],
      done: false,
    };
  });
}

/** Trimmed, lowercased, every run of whitespace collapsed to one space (rule 14). */
export function normaliseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Structural equality over JSON-like values; key order doesn't matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]));
}

/** The checklist can't take this deviation as it stands (rule 23). */
export class DeviationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviationConflictError';
  }
}

/**
 * The checklist with one approved deviation applied (rule 23). Pure: returns a new checklist with
 * `version` unchanged (the caller bumps it when saving). Throws DeviationConflictError before
 * building anything when the change doesn't fit the current checklist.
 */
export function applyDeviation(
  checklist: OnboardingChecklist,
  deviation: OnboardingDeviation,
): OnboardingChecklist {
  const { change } = deviation;
  const ids = new Set(checklist.tasks.map((t) => t.id));
  if (change.kind === 'remove') {
    const target = checklist.tasks.find((t) => t.id === change.templateTaskId);
    if (target?.source !== 'template') {
      throw new DeviationConflictError('The task to remove is not on the checklist.');
    }
    if (checklist.tasks.some((t) => t.dependsOn.includes(change.templateTaskId))) {
      throw new DeviationConflictError('Another task depends on the task to remove.');
    }
    return {
      ...checklist,
      tasks: checklist.tasks.filter((t) => t.id !== change.templateTaskId),
      removedTemplateTaskIds: [...checklist.removedTemplateTaskIds, change.templateTaskId],
    };
  }
  if (change.dependsOn.some((d) => !ids.has(d))) {
    throw new DeviationConflictError(
      'The new task depends on a task that is not on the checklist.',
    );
  }
  const added = checklist.tasks.filter((t) => t.source === 'added').length;
  const id = `added-${String(added + 1)}`;
  if (ids.has(id)) throw new DeviationConflictError('The new task id is already taken.');
  const task: ChecklistTask = {
    id,
    title: change.title,
    owner: change.owner,
    ...(change.owner === 'manager' ? { ownerEmployeeId: checklist.managerEmployeeId } : {}),
    ...(change.owner === 'buddy' && checklist.buddyEmployeeId !== null
      ? { ownerEmployeeId: checklist.buddyEmployeeId }
      : {}),
    source: 'added',
    dueOffsetDays: change.dueOffsetDays,
    dueDate: addCalendarDays(checklist.startDate, change.dueOffsetDays),
    dependsOn: [...change.dependsOn],
    done: false,
  };
  return { ...checklist, tasks: [...checklist.tasks, task] };
}
