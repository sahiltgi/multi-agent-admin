// Onboarding Policy Gate (spec onboarding, rules 3–9). Pure: no I/O, no clock, no randomness, no
// LLM. AUTO only when the checklist is exactly the template and nothing was proposed (brief §5).
// Messages carry counts, template ids and template task ids only, never model text (rule 8).
import { z } from 'zod';
import {
  ChecklistTask,
  DeviationChange,
  buildTemplateChecklistTasks,
  deepEqual,
} from '../domain/onboarding.js';
import {
  Id,
  IsoDate,
  TemplateId,
  type OnboardingGateResult,
  type OnboardingRuleId,
  type OnboardingRuleResult,
  type OnboardingVerdict,
} from '../domain/schemas.js';
import { LoadedOnboardingPolicy } from './onboarding-policy.schema.js';

export const OnboardingGateInput = z
  .object({
    templateId: TemplateId,
    startDate: IsoDate,
    assignees: z.object({ managerEmployeeId: Id, buddyEmployeeId: Id.nullable() }).strict(),
    checklistTasks: z.array(ChecklistTask), // the create_checklist output's tasks, unchanged
    deviations: z.array(DeviationChange), // every proposal, in call order
  })
  .strict(); // no today, confidence, verdict, role or rationale key
export type OnboardingGateInput = z.infer<typeof OnboardingGateInput>;

/** Thrown only for an invalid `policy`, which comes from the boot-time loader, not user data. */
export class OnboardingGateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingGateInputError';
  }
}

const EXPECTED: Record<OnboardingRuleId, string> = {
  checklist_matches_template: 'The checklist equals the role template.',
  no_tasks_added: 'No task added outside the template.',
  no_tasks_removed: 'No template task removed.',
};
const VERDICT_SENTENCE: Record<OnboardingVerdict, string> = {
  AUTO: 'Checklist matches the template.',
  MANAGER: 'Deviations need manager approval.',
};

const result = (
  ruleId: OnboardingRuleId,
  passed: boolean,
  actual: string,
  message: string,
): OnboardingRuleResult => ({ ruleId, passed, expected: EXPECTED[ruleId], actual, message });

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

function checklistMatches(input: OnboardingGateInput, policy: LoadedOnboardingPolicy) {
  const template = policy.policy.templates[input.templateId];
  const reference = buildTemplateChecklistTasks(template, input.startDate, input.assignees);
  if (deepEqual(input.checklistTasks, reference)) {
    return result(
      'checklist_matches_template',
      true,
      `Matches template ${input.templateId}.`,
      'The checklist matches the template.',
    );
  }
  return result(
    'checklist_matches_template',
    false,
    `Differs from template ${input.templateId}.`,
    'The checklist does not match the template.',
  );
}

function noneAdded(deviations: readonly DeviationChange[]) {
  const adds = deviations.filter((d) => d.kind === 'add').length;
  if (adds === 0) return result('no_tasks_added', true, 'No task added.', 'No task was added.');
  const text = `${plural(adds, 'task', 'tasks')} added`;
  return result('no_tasks_added', false, text, `${text} outside the template.`);
}

function noneRemoved(deviations: readonly DeviationChange[]) {
  const ids = deviations.flatMap((d) => (d.kind === 'remove' ? [d.templateTaskId] : []));
  if (ids.length === 0) {
    return result('no_tasks_removed', true, 'No task removed.', 'No template task was removed.');
  }
  // Template task ids match TemplateTaskId, so they are policy-shaped, never free text.
  const text = `${plural(ids.length, 'task', 'tasks')} removed: ${ids.join(', ')}`;
  return result('no_tasks_removed', false, text, `${text}.`);
}

function finish(
  ruleResults: [OnboardingRuleResult, OnboardingRuleResult, OnboardingRuleResult],
  policy: LoadedOnboardingPolicy,
): OnboardingGateResult {
  const verdict: OnboardingVerdict = ruleResults.every((r) => r.passed) ? 'AUTO' : 'MANAGER';
  const failed = ruleResults.filter((r) => !r.passed).map((r) => r.message);
  return {
    verdict,
    ruleResults,
    reason: [VERDICT_SENTENCE[verdict], ...failed].join(' '),
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
  };
}

const notChecked = (ruleId: OnboardingRuleId): OnboardingRuleResult =>
  result(ruleId, false, 'not checked', 'Not checked because the input was invalid');

/**
 * AUTO or MANAGER from three rules, always all evaluated, in a fixed order (rule 4). Malformed
 * input gives MANAGER with every rule "not checked" and never throws (rule 9).
 */
export function evaluateOnboarding(input: unknown, policy: unknown): OnboardingGateResult {
  const loaded = LoadedOnboardingPolicy.safeParse(policy);
  if (!loaded.success) {
    throw new OnboardingGateInputError('policy is not a valid LoadedOnboardingPolicy');
  }
  const parsed = OnboardingGateInput.safeParse(input);
  if (!parsed.success) {
    return finish(
      [
        notChecked('checklist_matches_template'),
        notChecked('no_tasks_added'),
        notChecked('no_tasks_removed'),
      ],
      loaded.data,
    );
  }
  return finish(
    [
      checklistMatches(parsed.data, loaded.data),
      noneAdded(parsed.data.deviations),
      noneRemoved(parsed.data.deviations),
    ],
    loaded.data,
  );
}
