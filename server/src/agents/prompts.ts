// File-backed PromptLoader (spec agent-runtime, rule 2; D-10). Reads
// <rootDir>/<agentId>/<promptVersion>.md. A missing file is "not found"; the runtime fails closed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentId, PromptVersion } from './schemas.js';

export type PromptLoadResult = { found: true; text: string } | { found: false };

export interface PromptLoader {
  load(agentId: AgentId, promptVersion: PromptVersion): Promise<PromptLoadResult>;
}

export function createFilePromptLoader(rootDir: string): PromptLoader {
  return {
    async load(agentId, promptVersion) {
      // agentId and promptVersion are Zod-validated (enum and /^v[1-9]\d*$/), so no path traversal.
      try {
        const text = await readFile(join(rootDir, agentId, `${promptVersion}.md`), 'utf8');
        return { found: true, text };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { found: false };
        throw err;
      }
    },
  };
}
