// Onboarding Agent fixed-text loader (spec onboarding, rule 15). Reads <rootDir>/<key>.txt, where
// rootDir is prompts/onboarding/messages. Text is returned byte for byte; a missing or
// whitespace-only file is "not found", and the agent fails closed instead of using model text.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const OnboardingAgentTextKey = z.enum(['fallback_question', 'start_date_past']);
export type OnboardingAgentTextKey = z.infer<typeof OnboardingAgentTextKey>;

export type OnboardingTextLoadResult = { found: true; text: string } | { found: false };

export interface OnboardingAgentTextLoader {
  load(key: OnboardingAgentTextKey): Promise<OnboardingTextLoadResult>;
}

export function createOnboardingTextLoader(rootDir: string): OnboardingAgentTextLoader {
  return {
    async load(key) {
      // key is a closed Zod enum, so no path traversal.
      try {
        const file = join(rootDir, `${OnboardingAgentTextKey.parse(key)}.txt`);
        const text = await readFile(file, 'utf8');
        return text.trim() === '' ? { found: false } : { found: true, text };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { found: false };
        throw err;
      }
    },
  };
}
