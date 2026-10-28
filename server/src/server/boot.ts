// Boot-time prompt files (spec mongo-persistence, rule 10 step 4; D-6). Every prompt, tool
// description and fixed text is checked once at startup, so a missing or blank file stops the
// server before it serves. Errors name the file path only, never its contents. The Policy Q&A
// handbook and sensitive-topics policy are loaded here too (spec policy-qa, rule 26), and so is
// evals/pricing.yaml for the per-request cost totals (spec agent-metrics, rule 3).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { GEMINI_MODEL_MAP } from '../agents/gemini-models.js';
import type { Provider } from '../agents/model-provider.js';
import type { AgentConfig } from '../agents/schemas.js';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import { createFileQaTexts, QA_TEXTS, type QaTextLoader } from '../agents/policy_qa/texts.js';
import { handbookBody, handbookSections } from '../domain/handbook.js';
import { ONBOARDING_CONFIG, ONBOARDING_NOTES_CONFIG } from '../agents/onboarding/config.js';
import { Pricing } from '../lib/cost.js';
import {
  createOnboardingTextLoader,
  OnboardingAgentTextKey,
  type OnboardingAgentTextLoader,
} from '../agents/onboarding/texts.js';
import type { LoadedOnboardingPolicy } from '../gate/onboarding-policy.schema.js';
import type { LoadedQaPolicy } from '../gate/qa-policy.schema.js';
import { loadOnboardingPolicy, loadQaPolicy } from '../policies/load.js';
import { LEAVE_CONFIG } from '../agents/leave/config.js';
import { createFileTextLoader, LeaveTextKey, type FixedTextLoader } from '../agents/leave/texts.js';
import { ORCHESTRATOR_CONFIG } from '../agents/orchestrator/config.js';
import {
  createFileMessageLoader,
  type FixedMessageLoader,
} from '../agents/orchestrator/messages.js';
import { FixedMessageKey } from '../agents/orchestrator/schemas.js';
import { createFilePromptLoader, promptFiles, type PromptLoader } from '../agents/prompts.js';
import {
  loadLeaveToolDescriptions,
  loadOnboardingToolDescriptions,
  loadToolDescriptions,
  LeaveToolDescriptions,
  OnboardingToolDescriptions,
  type ToolDescriptions,
} from '../agents/tool-descriptions.js';
import type { ChatTextLoader } from '../chat/ports.js';
import { ChatTextKey } from '../chat/schemas.js';
import { createFileChatTexts } from '../chat/texts.js';
import type {
  IntakeTextLoader,
  IntakeTextName,
  OnboardingTextLoader,
  OnboardingTextName,
} from '../intake/ports.js';
import { createFileIntakeTexts, createFileOnboardingTexts } from '../intake/texts.js';

/** The fields the pricing check reads; POLICY_QA_CONFIG has no tool loop, so isn't a full AgentConfig. */
export type PricedAgent = Pick<AgentConfig, 'agentId' | 'model'>;

export interface BootFiles {
  descriptions: ToolDescriptions;
  leaveToolDescriptions: LeaveToolDescriptions;
  prompts: PromptLoader;
  orchestratorMessages: FixedMessageLoader;
  leaveTexts: FixedTextLoader;
  intakeTexts: IntakeTextLoader;
  chatTexts: ChatTextLoader; // chat-endpoint rule 25
  qaTexts: QaTextLoader; // spec policy-qa, DD-21
  handbook: { body: string; hash: string }; // the document data and its SHA-256 (rule 1)
  qaPolicy: LoadedQaPolicy; // policies/qa/v1.yaml (rule 3)
  // spec onboarding, rule 27
  onboardingPolicy: LoadedOnboardingPolicy; // policies/onboarding/v1.yaml
  onboardingToolDescriptions: OnboardingToolDescriptions;
  onboardingAgentTexts: OnboardingAgentTextLoader; // the agent's fixed questions
  onboardingTexts: OnboardingTextLoader; // dispatch's fixed replies
  pricing: Pricing; // evals/pricing.yaml (spec agent-metrics, rule 3); coverage is checked in start.ts
  // spec audit-view, rules 11 and 16: fixed paths, read per request by the audit view, never at boot.
  auditViewPaths: { evalResultsDir: string; devMetricsPath: string; aiLogPath: string };
}

export interface QaBootPaths {
  handbookPath: string;
  qaPolicyPath: string;
  /** Defaults to policies/onboarding/v1.yaml next to the prompts directory. */
  onboardingPolicyPath?: string;
  /** Defaults to evals/pricing.yaml next to the prompts directory (spec agent-metrics, rule 3). */
  pricingPath?: string;
  /** spec audit-view: default to evals/results, docs/dev-metrics.md and AI_LOG.md next to prompts. */
  evalResultsDir?: string;
  devMetricsPath?: string;
  aiLogPath?: string;
}

/** The committed handbook and QA policy, next to the prompts directory. */
export function defaultQaBootPaths(promptsRoot: string): QaBootPaths {
  return {
    handbookPath: join(promptsRoot, '..', 'handbook', 'handbook.md'),
    qaPolicyPath: join(promptsRoot, '..', 'policies', 'qa', 'v1.yaml'),
  };
}

const INTAKE_TEXTS = [
  'not_available',
  'escalated',
  'returned',
  'hr_admin_self',
  'hand_back',
] as const satisfies readonly IntakeTextName[];

// spec onboarding, rule 27: dispatch's replies plus the agent's two questions. escalated.txt is a
// required onboarding message file; onboarding escalations reply with the intake escalated text.
const ONBOARDING_TEXTS = [
  'created',
  'pending_manager',
  'denied',
] as const satisfies readonly OnboardingTextName[];
const ONBOARDING_MESSAGES = [...ONBOARDING_TEXTS, 'escalated', ...OnboardingAgentTextKey.options];

/** Every agent the server runs, so startup can refuse an unpriced model (spec agent-metrics, rule 4). */
export const SHIPPED_AGENT_CONFIGS: readonly PricedAgent[] = [
  ORCHESTRATOR_CONFIG,
  LEAVE_CONFIG,
  POLICY_QA_CONFIG,
  ONBOARDING_CONFIG,
  ONBOARDING_NOTES_CONFIG,
];

/** Pure: each config with no Gemini mapping when Gemini runs, in config order (spec gemini-fallback, rule 6). */
export function unmappedModels(
  provider: Provider,
  configs: readonly PricedAgent[],
): { agentId: string; model: string }[] {
  if (provider === 'anthropic') return [];
  return configs
    .filter((c) => !Object.hasOwn(GEMINI_MODEL_MAP, c.model))
    .map((c) => ({ agentId: c.agentId, model: c.model }));
}

/** Pure: each config whose model has no pricing entry, in config order. */
export function unpricedModels(
  pricing: Pricing,
  configs: readonly PricedAgent[],
): { agentId: string; model: string }[] {
  return configs
    .filter((c) => !Object.hasOwn(pricing.models, c.model))
    .map((c) => ({ agentId: c.agentId, model: c.model }));
}

/** Parsed pricing; rejects naming the path only, never a price (spec agent-metrics, rule 3). */
async function loadPricing(path: string): Promise<Pricing> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`boot file missing or unreadable: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new Error(`boot file is not valid YAML: ${path}`);
  }
  const pricing = Pricing.safeParse(parsed);
  if (!pricing.success) throw new Error(`boot file does not match the pricing schema: ${path}`);
  return pricing.data;
}

/** Rejects naming the path when a file is missing, unreadable or blank. */
async function requireText(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`boot file missing or unreadable: ${path}`);
  }
  if (text.trim() === '') throw new Error(`boot file is blank: ${path}`);
}

/** The frontmatter-free body and its hash; rejects naming the path only (spec policy-qa, rule 1). */
async function loadHandbook(path: string): Promise<{ body: string; hash: string }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`boot file missing or unreadable: ${path}`);
  }
  let body: string;
  try {
    body = handbookBody(raw);
    handbookSections(body); // duplicate ids or no sections fail here, not per question
  } catch {
    throw new Error(`boot file is not a valid handbook: ${path}`);
  }
  return { body, hash: createHash('sha256').update(body, 'utf8').digest('hex') };
}

export async function loadBootFiles(
  promptsRoot: string,
  qaPaths: QaBootPaths = defaultQaBootPaths(promptsRoot),
): Promise<BootFiles> {
  const required = [
    ...[ORCHESTRATOR_CONFIG, LEAVE_CONFIG, POLICY_QA_CONFIG, ONBOARDING_CONFIG].map((c) =>
      join(promptsRoot, c.agentId, `${c.promptVersion}.md`),
    ),
    join(promptsRoot, 'orchestrator', 'tools', 'route.md'),
    ...Object.keys(LeaveToolDescriptions.shape).map((t) =>
      join(promptsRoot, 'leave', 'tools', `${t}.md`),
    ),
    ...FixedMessageKey.options.map((k) =>
      join(promptsRoot, 'orchestrator', 'messages', `${k}.txt`),
    ),
    ...LeaveTextKey.options.map((k) => join(promptsRoot, 'leave', 'messages', `${k}.txt`)),
    ...INTAKE_TEXTS.map((n) => join(promptsRoot, 'intake', 'messages', `${n}.txt`)),
    ...ChatTextKey.options.map((k) => join(promptsRoot, 'chat', 'messages', `${k}.txt`)),
    ...QA_TEXTS.map((n) => join(promptsRoot, 'policy_qa', 'messages', `${n}.txt`)),
    ...Object.keys(OnboardingToolDescriptions.shape).map((t) =>
      join(promptsRoot, 'onboarding', 'tools', `${t}.md`),
    ),
    ...ONBOARDING_MESSAGES.map((n) => join(promptsRoot, 'onboarding', 'messages', `${n}.txt`)),
    // spec onboarding-api, rule 4: the notes-mode prompt and its data-block description.
    ...promptFiles(
      promptsRoot,
      ONBOARDING_NOTES_CONFIG.agentId,
      ONBOARDING_NOTES_CONFIG.promptVersion,
    ),
  ];
  for (const path of required) await requireText(path);
  const handbook = await loadHandbook(qaPaths.handbookPath);
  // PolicyLoadError names the path, kind and keys, never values from the file.
  const qaPolicy = loadQaPolicy(qaPaths.qaPolicyPath);
  const onboardingPolicy = loadOnboardingPolicy(
    qaPaths.onboardingPolicyPath ?? join(promptsRoot, '..', 'policies', 'onboarding', 'v1.yaml'),
  );
  const pricing = await loadPricing(
    qaPaths.pricingPath ?? join(promptsRoot, '..', 'evals', 'pricing.yaml'),
  );

  return {
    descriptions: await loadToolDescriptions(promptsRoot),
    leaveToolDescriptions: await loadLeaveToolDescriptions(promptsRoot),
    prompts: createFilePromptLoader(promptsRoot),
    orchestratorMessages: createFileMessageLoader(join(promptsRoot, 'orchestrator', 'messages')),
    leaveTexts: createFileTextLoader(join(promptsRoot, 'leave', 'messages')),
    intakeTexts: createFileIntakeTexts(join(promptsRoot, 'intake', 'messages')),
    chatTexts: createFileChatTexts(join(promptsRoot, 'chat', 'messages')),
    qaTexts: createFileQaTexts(join(promptsRoot, 'policy_qa', 'messages')),
    handbook,
    qaPolicy,
    onboardingPolicy,
    onboardingToolDescriptions: await loadOnboardingToolDescriptions(promptsRoot),
    onboardingAgentTexts: createOnboardingTextLoader(join(promptsRoot, 'onboarding', 'messages')),
    onboardingTexts: createFileOnboardingTexts(join(promptsRoot, 'onboarding', 'messages')),
    pricing,
    auditViewPaths: {
      evalResultsDir: qaPaths.evalResultsDir ?? join(promptsRoot, '..', 'evals', 'results'),
      devMetricsPath: qaPaths.devMetricsPath ?? join(promptsRoot, '..', 'docs', 'dev-metrics.md'),
      aiLogPath: qaPaths.aiLogPath ?? join(promptsRoot, '..', 'AI_LOG.md'),
    },
  };
}
