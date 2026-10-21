// Onboarding policy schema (spec onboarding, rule 1). Validates policies/onboarding/v1.yaml; any
// change here or to the YAML must change tests or evals in the same commit (HARD RULE 5).
import { z } from 'zod';
import {
  DueOffsetDays,
  TaskOwner,
  TemplateTaskId,
  hasDependencyCycle,
  unknownDependencies,
} from '../domain/schemas.js';

export const TemplateTask = z
  .object({
    id: TemplateTaskId,
    title: z.string().trim().min(1).max(120),
    owner: TaskOwner,
    dueOffsetDays: DueOffsetDays, // calendar days from the start date (OQ-8)
    dependsOn: z.array(TemplateTaskId).refine((l) => new Set(l).size === l.length, {
      error: 'duplicate dependency',
    }),
  })
  .strict();
export type TemplateTask = z.infer<typeof TemplateTask>;

export const RoleTemplate = z
  .object({ title: z.string().trim().min(1).max(60), tasks: z.array(TemplateTask).min(1) })
  .strict()
  .superRefine((t, ctx) => {
    const ids = t.tasks.map((x) => x.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'task ids must be unique' });
    }
    if (unknownDependencies(t.tasks).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'every dependsOn must name a task in the same template',
      });
    }
    // A self-dependency is the shortest cycle.
    if (hasDependencyCycle(t.tasks)) {
      ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'dependencies must not cycle' });
    }
  });
export type RoleTemplate = z.infer<typeof RoleTemplate>;

export const OnboardingPolicyV1 = z
  .object({
    version: z.literal('v1'),
    templates: z
      .object({ engineer: RoleTemplate, sales: RoleTemplate, operations: RoleTemplate })
      .strict(), // exactly the three templates
  })
  .strict();
export type OnboardingPolicyV1 = z.infer<typeof OnboardingPolicyV1>;

export const LoadedOnboardingPolicy = z
  .object({
    policy: OnboardingPolicyV1,
    policyVersion: z.string().min(1),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((l) => l.policyVersion === l.policy.version, {
    path: ['policyVersion'],
    error: 'policyVersion must equal policy.version',
  });
export type LoadedOnboardingPolicy = z.infer<typeof LoadedOnboardingPolicy>;
