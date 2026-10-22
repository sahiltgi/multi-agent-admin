// File-backed PromptLoader (spec agent-runtime, rule 2; D-10). Reads
// <rootDir>/<agentId>/<promptVersion>.md (see promptFiles). A missing file is "not found"; the
// runtime fails closed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentId, PromptVersion } from './schemas.js';

export type PromptLoadResult = { found: true; text: string } | { found: false };

export interface PromptLoader {
  load(agentId: AgentId, promptVersion: PromptVersion): Promise<PromptLoadResult>;
}

/**
 * The files that make up one agent's system prompt. The notes-mode Onboarding Agent lives beside the
 * Onboarding Agent: prompts/onboarding/notes-<v>.md, then notes_context.md, which describes the data
 * block code sends it (spec onboarding-api, rule 4).
 */
export function promptFiles(
  rootDir: string,
  agentId: AgentId,
  promptVersion: PromptVersion,
): string[] {
  if (agentId === 'onboarding_notes') {
    return [
      join(rootDir, 'onboarding', `notes-${promptVersion}.md`),
      join(rootDir, 'onboarding', 'notes_context.md'),
    ];
  }
  return [join(rootDir, agentId, `${promptVersion}.md`)];
}

export function createFilePromptLoader(rootDir: string): PromptLoader {
  return {
    async load(agentId, promptVersion) {
      // agentId and promptVersion are Zod-validated (enum and /^v[1-9]\d*$/), so no path traversal.
      try {
        const parts: string[] = [];
        for (const file of promptFiles(rootDir, agentId, promptVersion)) {
          parts.push(await readFile(file, 'utf8'));
        }
        const text = parts.join('\n\n');
        return { found: true, text };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { found: false };
        throw err;
      }
    },
  };
}
