// Boot-time prompt files (spec mongo-persistence, rule 10 step 4; D-6). Every prompt, tool
// description and fixed text is checked once at startup, so a missing or blank file stops the
// server before it serves. Errors name the file path only, never its contents. The Policy Q&A
// handbook and sensitive-topics policy are loaded here too (spec policy-qa, rule 26).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { POLICY_QA_CONFIG } from '../agents/policy_qa/config.js';
import { createFileQaTexts, QA_TEXTS, type QaTextLoader } from '../agents/policy_qa/texts.js';
import { handbookBody, handbookSections } from '../domain/handbook.js';
import { ONBOARDING_CONFIG } from '../agents/onboarding/config.js';
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
import { createFilePromptLoader, type PromptLoader } from '../agents/prompts.js';
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
}

export interface QaBootPaths {
  handbookPath: string;
  qaPolicyPath: string;
  /** Defaults to policies/onboarding/v1.yaml next to the prompts directory. */
  onboardingPolicyPath?: string;
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
  ];
  for (const path of required) await requireText(path);
  const handbook = await loadHandbook(qaPaths.handbookPath);
  // PolicyLoadError names the path, kind and keys, never values from the file.
  const qaPolicy = loadQaPolicy(qaPaths.qaPolicyPath);
  const onboardingPolicy = loadOnboardingPolicy(
    qaPaths.onboardingPolicyPath ?? join(promptsRoot, '..', 'policies', 'onboarding', 'v1.yaml'),
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
  };
}
