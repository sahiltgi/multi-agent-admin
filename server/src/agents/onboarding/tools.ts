// The three Onboarding Agent tools (spec onboarding, rules 10–14). Handlers only read and compute:
// none writes a checklist, deviation, item or any other record (agent-runtime D-18). Identity
// comes only from ctx.actor; the new joiner's manager comes only from the team directory.
import type { z } from 'zod';
import { buildTemplateChecklistTasks, type OnboardingDirectory } from '../../domain/onboarding.js';
import type { LoadedOnboardingPolicy } from '../../gate/onboarding-policy.schema.js';
import type { ToolDefinition } from '../registry.js';
import type { RuntimeDeps } from '../runtime.js';
import type { OnboardingToolDescriptions } from '../tool-descriptions.js';
import {
  CreateChecklistInput,
  CreateChecklistOutput,
  GetTemplateInput,
  GetTemplateOutput,
  ProposeDeviationInput,
  ProposeDeviationOutput,
} from './schemas.js';
import type { OnboardingAgentTextLoader } from './texts.js';

export interface OnboardingAgentDeps {
  runtime: RuntimeDeps;
  directory: OnboardingDirectory;
  policy: LoadedOnboardingPolicy; // loaded once at boot, passed to the gate unchanged
  /** The pure gate (`evaluateOnboarding`), injected so tests can stub it; its return is parsed. */
  evaluateOnboarding: (input: unknown, policy: unknown) => unknown;
  toIsoDate: (nowIso: string) => string; // UTC calendar date
  texts: OnboardingAgentTextLoader;
  toolDescriptions: OnboardingToolDescriptions; // from prompts/onboarding/tools/
}

/** A registry-ready tool whose handler input is re-parsed with its own schema (no cast). */
export type OnboardingTool = ToolDefinition<z.ZodType, z.ZodType>;

function erase<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDefinition<I, O>,
): OnboardingTool {
  return { ...def, handler: (input, ctx) => def.handler(def.inputSchema.parse(input), ctx) };
}

export function buildOnboardingTools(deps: OnboardingAgentDeps): OnboardingTool[] {
  const { directory, policy, toolDescriptions } = deps;
  return [
    erase({
      name: 'get_template',
      description: toolDescriptions.get_template,
      inputSchema: GetTemplateInput,
      outputSchema: GetTemplateOutput,
      handler: (input) => {
        const template = policy.policy.templates[input.templateId];
        return Promise.resolve({
          templateId: input.templateId,
          title: template.title,
          tasks: template.tasks,
        });
      },
    }),
    erase({
      name: 'create_checklist',
      description: toolDescriptions.create_checklist,
      inputSchema: CreateChecklistInput,
      outputSchema: CreateChecklistOutput,
      handler: async (input) => {
        // Thrown errors reach the model only as the runtime's generic is_error text.
        const team = await directory.getTeamById(input.newHireTeam);
        if (team === null) throw new Error('Unknown team');
        let buddyEmployeeId: string | null = null;
        if (input.buddyRef !== null) {
          const buddy = await directory.getById(input.buddyRef);
          // OQ-7: the buddy is a member of the new joiner's team and not its manager.
          if (buddy?.teamId !== team.id || buddy.id === team.managerId) {
            throw new Error('Invalid buddy');
          }
          buddyEmployeeId = buddy.id;
        }
        const assignees = { managerEmployeeId: team.managerId, buddyEmployeeId };
        const template = policy.policy.templates[input.templateId];
        return {
          templateId: input.templateId,
          startDate: input.startDate,
          newHireTeam: team.id,
          assignees,
          tasks: buildTemplateChecklistTasks(template, input.startDate, assignees),
          policyVersion: policy.policyVersion,
          policyHash: policy.policyHash,
        };
      },
    }),
    erase({
      name: 'propose_deviation',
      description: toolDescriptions.propose_deviation,
      inputSchema: ProposeDeviationInput,
      outputSchema: ProposeDeviationOutput,
      // Rule 14: records a proposal only. Approval happens through a manager's approve action.
      handler: (input) =>
        Promise.resolve({ accepted: true, change: input.change, rationale: input.rationale }),
    }),
  ];
}
