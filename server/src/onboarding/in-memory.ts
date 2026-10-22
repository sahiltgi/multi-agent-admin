// In-memory OnboardingStore for tests and local runs (spec onboarding, rules 21–25; onboarding-api,
// rules 7, 11). Every read and write clones, so callers never share state with the store. Seed
// records are parsed on the way in.
import {
  filterChecklists,
  NewJoinerProfile,
  OnboardingChecklist,
  OnboardingDeviation,
  type ChecklistListFilter,
  type DeviationStatus,
  type OnboardingStore,
} from '../domain/onboarding.js';

export class InMemoryOnboardingStore implements OnboardingStore {
  private readonly checklists = new Map<string, OnboardingChecklist>();
  private readonly deviations = new Map<string, OnboardingDeviation>();
  private readonly profiles = new Map<string, NewJoinerProfile>();

  constructor(checklists: readonly unknown[] = [], deviations: readonly unknown[] = []) {
    for (const c of checklists) {
      const parsed = OnboardingChecklist.parse(c);
      this.checklists.set(parsed.id, parsed);
    }
    for (const d of deviations) {
      const parsed = OnboardingDeviation.parse(d);
      this.deviations.set(parsed.id, parsed);
    }
  }

  insertChecklist(c: OnboardingChecklist): Promise<boolean> {
    if (this.checklists.has(c.id)) return Promise.resolve(false);
    this.checklists.set(c.id, structuredClone(c));
    return Promise.resolve(true);
  }

  getChecklist(id: string): Promise<OnboardingChecklist | null> {
    const c = this.checklists.get(id);
    return Promise.resolve(c === undefined ? null : structuredClone(c));
  }

  saveChecklistIfVersion(c: OnboardingChecklist, expectedVersion: number): Promise<boolean> {
    if (this.checklists.get(c.id)?.version !== expectedVersion) return Promise.resolve(false);
    this.checklists.set(c.id, structuredClone(c));
    return Promise.resolve(true);
  }

  removeChecklist(id: string): Promise<void> {
    this.checklists.delete(id);
    return Promise.resolve();
  }

  insertDeviation(d: OnboardingDeviation): Promise<boolean> {
    if (this.deviations.has(d.id)) return Promise.resolve(false);
    this.deviations.set(d.id, structuredClone(d));
    return Promise.resolve(true);
  }

  getDeviation(id: string): Promise<OnboardingDeviation | null> {
    const d = this.deviations.get(id);
    return Promise.resolve(d === undefined ? null : structuredClone(d));
  }

  saveDeviationIfStatus(d: OnboardingDeviation, expected: DeviationStatus): Promise<boolean> {
    if (this.deviations.get(d.id)?.status !== expected) return Promise.resolve(false);
    this.deviations.set(d.id, structuredClone(d));
    return Promise.resolve(true);
  }

  removeDeviation(id: string): Promise<void> {
    this.deviations.delete(id);
    return Promise.resolve();
  }

  listDeviationsByChecklist(checklistId: string): Promise<OnboardingDeviation[]> {
    return Promise.resolve(
      [...this.deviations.values()]
        .filter((d) => d.checklistId === checklistId)
        .map((d) => structuredClone(d)),
    );
  }

  /**
   * With a filter: the visible page, startDate asc then id asc (onboarding-api rule 11).
   * Without one (tests only): every checklist, in insertion order.
   */
  listChecklists(filter?: ChecklistListFilter): Promise<OnboardingChecklist[]> {
    const all = [...this.checklists.values()];
    const rows = filter === undefined ? all : filterChecklists(all, filter);
    return Promise.resolve(rows.map((c) => structuredClone(c)));
  }

  insertProfile(p: NewJoinerProfile): Promise<boolean> {
    if (this.profiles.has(p.newJoinerId)) return Promise.resolve(false);
    this.profiles.set(p.newJoinerId, structuredClone(NewJoinerProfile.parse(p)));
    return Promise.resolve(true);
  }

  getProfile(newJoinerId: string): Promise<NewJoinerProfile | null> {
    const p = this.profiles.get(newJoinerId);
    return Promise.resolve(p === undefined ? null : structuredClone(p));
  }

  removeProfile(newJoinerId: string): Promise<void> {
    this.profiles.delete(newJoinerId);
    return Promise.resolve();
  }

  /** Tests: every deviation, in insertion order. */
  listDeviations(): Promise<OnboardingDeviation[]> {
    return Promise.resolve([...this.deviations.values()].map((d) => structuredClone(d)));
  }
}
