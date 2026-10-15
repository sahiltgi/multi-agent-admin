// Model-facing tool descriptions (spec orchestrator, D-15). They are prompts, so they live in
// <promptsRoot>/<agentId>/tools/<tool>.md and are never inline. A missing or blank file throws.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const ToolDescriptions = z.object({ route: z.string().trim().min(1) }).strict();
export type ToolDescriptions = z.infer<typeof ToolDescriptions>;

export async function loadToolDescriptions(promptsRoot: string): Promise<ToolDescriptions> {
  const route = await readFile(join(promptsRoot, 'orchestrator', 'tools', 'route.md'), 'utf8');
  return ToolDescriptions.parse({ route });
}

// ---- Leave Agent tools (spec leave-agent, D-21): <promptsRoot>/leave/tools/<tool>.md ----
const Description = z.string().trim().min(1);
export const LeaveToolDescriptions = z
  .object({
    get_my_balance: Description,
    get_holidays: Description,
    get_team_calendar: Description,
    submit_to_gate: Description,
  })
  .strict();
export type LeaveToolDescriptions = z.infer<typeof LeaveToolDescriptions>;

export async function loadLeaveToolDescriptions(
  promptsRoot: string,
): Promise<LeaveToolDescriptions> {
  const names = Object.keys(LeaveToolDescriptions.shape) as (keyof LeaveToolDescriptions)[];
  const texts = await Promise.all(
    names.map((name) => readFile(join(promptsRoot, 'leave', 'tools', `${name}.md`), 'utf8')),
  );
  return LeaveToolDescriptions.parse(Object.fromEntries(names.map((n, i) => [n, texts[i]])));
}
