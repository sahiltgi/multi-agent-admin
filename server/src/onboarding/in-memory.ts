// In-memory OnboardingStore for tests and local runs (spec onboarding, rules 21–25). Every read and
// write clones, so callers never share state with the store. Seed records are parsed on the way in.
import {
  OnboardingChecklist,
  OnboardingDeviation,
  type DeviationStatus,
  type OnboardingStore,
} from '../domain/onboarding.js';

export class InMemoryOnboardingStore implements OnboardingStore {
  private readonly checklists = new Map<string, OnboardingChecklist>();
  private readonly deviations = new Map<string, OnboardingDeviation>();

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

  /** Tests: every checklist, in insertion order. */
  listChecklists(): Promise<OnboardingChecklist[]> {
    return Promise.resolve([...this.checklists.values()].map((c) => structuredClone(c)));
  }

  /** Tests: every deviation, in insertion order. */
  listDeviations(): Promise<OnboardingDeviation[]> {
    return Promise.resolve([...this.deviations.values()].map((d) => structuredClone(d)));
  }
}
