// Fixed-message loader (spec orchestrator, rules 9 to 11, 18; D-5, D-6). Reads
// <rootDir>/<key>.txt, where rootDir is prompts/orchestrator/messages. Text is returned byte for
// byte; a missing or whitespace-only file is "not found", and the orchestrator fails closed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FixedMessageKey } from './schemas.js';

export type FixedMessageLoadResult = { found: true; text: string } | { found: false };

export interface FixedMessageLoader {
  load(key: FixedMessageKey): Promise<FixedMessageLoadResult>;
}

export function createFileMessageLoader(rootDir: string): FixedMessageLoader {
  return {
    async load(key) {
      // key is a closed Zod enum, so no path traversal.
      try {
        const text = await readFile(join(rootDir, `${key}.txt`), 'utf8');
        return text.trim() === '' ? { found: false } : { found: true, text };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { found: false };
        throw err;
      }
    },
  };
}
