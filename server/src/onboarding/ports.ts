// Dependencies of the onboarding API routes (spec onboarding-api, rule 19). Everything is injected:
// no clock, randomness, env or gate import here, so the routes are deterministic under test.
import type { AuditSink } from '../agents/audit.js';
import type { ChecklistTask } from '../domain/schemas.js';
import type {
  buildTemplateChecklistTasks,
  OnboardingDirectory,
  OnboardingStore,
} from '../domain/onboarding.js';
import type { TemplateId } from '../domain/schemas.js';
import type {
  ApprovalItemWriter,
  IdempotencyStore,
  IntakeTextLoader,
  LeaveRequestStore,
  OnboardingTextLoader,
} from '../intake/ports.js';
import type { AuditReader } from '../http/approvals/ports.js';
import type { Pricing } from '../lib/cost.js';

/**
 * The boot-time onboarding policy, typed structurally so onboarding/ never imports gate/
 * (onboarding rule 26). It is passed to the gate unchanged.
 */
export interface OnboardingPolicyView {
  readonly policy: {
    readonly templates: Readonly<
      Record<TemplateId, Parameters<typeof buildTemplateChecklistTasks>[0]>
    >;
  };
}

export interface OnboardingRouteDeps {
  directory: OnboardingDirectory;
  onboarding: OnboardingStore;
  approvals: ApprovalItemWriter;
  /** Records requestId -> creator, so the creator can read the trace (request-intake D-9). */
  messages: Pick<LeaveRequestStore, 'recordMessage'>;
  audit: Pick<AuditSink, 'write'>;
  clock: { nowIso(): string };
  idGen: () => string;
  idempotency: IdempotencyStore;
  policy: OnboardingPolicyView;
  /** The pure gate (`evaluateOnboarding`), injected; its return is parsed, never trusted. */
  evaluateOnboarding: (input: unknown, policy: unknown) => unknown;
  toIsoDate: (nowIso: string) => string; // UTC calendar date
  /** The notes-mode Onboarding Agent with its deps bound; its result is parsed, never trusted. */
  runOnboardingNotes: (
    input: unknown,
    checklistTasks: readonly ChecklistTask[],
  ) => Promise<unknown>;
  onboardingTexts: OnboardingTextLoader;
  intakeTexts: Pick<IntakeTextLoader, 'load'>;
  /** Reads the request's own model-call events back for its `usage` (spec agent-metrics, rule 7). */
  auditReader: AuditReader;
  pricing: Pricing; // the boot-time evals/pricing.yaml
}
