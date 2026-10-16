// Boot-time prompt files (spec mongo-persistence, rule 10 step 4; D-6). Every prompt, tool
// description and fixed text is checked once at startup, so a missing or blank file stops the
// server before it serves. Errors name the file path only, never its contents.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  loadToolDescriptions,
  LeaveToolDescriptions,
  type ToolDescriptions,
} from '../agents/tool-descriptions.js';
import type { IntakeTextLoader, IntakeTextName } from '../intake/ports.js';
import { createFileIntakeTexts } from '../intake/texts.js';

export interface BootFiles {
  descriptions: ToolDescriptions;
  leaveToolDescriptions: LeaveToolDescriptions;
  prompts: PromptLoader;
  orchestratorMessages: FixedMessageLoader;
  leaveTexts: FixedTextLoader;
  intakeTexts: IntakeTextLoader;
}

const INTAKE_TEXTS = [
  'not_available',
  'escalated',
  'returned',
  'hr_admin_self',
] as const satisfies readonly IntakeTextName[];

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

export async function loadBootFiles(promptsRoot: string): Promise<BootFiles> {
  const required = [
    ...[ORCHESTRATOR_CONFIG, LEAVE_CONFIG].map((c) =>
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
  ];
  for (const path of required) await requireText(path);

  return {
    descriptions: await loadToolDescriptions(promptsRoot),
    leaveToolDescriptions: await loadLeaveToolDescriptions(promptsRoot),
    prompts: createFilePromptLoader(promptsRoot),
    orchestratorMessages: createFileMessageLoader(join(promptsRoot, 'orchestrator', 'messages')),
    leaveTexts: createFileTextLoader(join(promptsRoot, 'leave', 'messages')),
    intakeTexts: createFileIntakeTexts(join(promptsRoot, 'intake', 'messages')),
  };
}
