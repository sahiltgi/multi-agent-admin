// Fixed-text loader (spec leave-agent, rules 7, 11; D-4). Reads <rootDir>/<key>.txt, where rootDir
// is prompts/leave/messages. Text is returned byte for byte; a missing or whitespace-only file is
// "not found", and the agent fails closed instead of using model text.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const LeaveTextKey = z.enum(['fallback_question', 'summary_template']);
export type LeaveTextKey = z.infer<typeof LeaveTextKey>;

export type FixedTextLoadResult = { found: true; text: string } | { found: false };

export interface FixedTextLoader {
  load(key: LeaveTextKey): Promise<FixedTextLoadResult>;
}

export function createFileTextLoader(rootDir: string): FixedTextLoader {
  return {
    async load(key) {
      // key is a closed Zod enum, so no path traversal.
      try {
        const text = await readFile(join(rootDir, `${LeaveTextKey.parse(key)}.txt`), 'utf8');
        return text.trim() === '' ? { found: false } : { found: true, text };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { found: false };
        throw err;
      }
    },
  };
}
