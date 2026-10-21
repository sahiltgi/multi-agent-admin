// File-backed fixed texts for intake (spec request-intake, D-14). Reads <rootDir>/<name>.txt.
// A missing or blank file loads as null, and intake fails closed: no model text is substituted.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  IntakeTextLoader,
  IntakeTextName,
  OnboardingTextLoader,
  OnboardingTextName,
} from './ports.js';

/** `name` is always a closed union member, so no path traversal. */
async function readFixedText(rootDir: string, name: string): Promise<string | null> {
  try {
    const text = await readFile(join(rootDir, `${name}.txt`), 'utf8');
    return text.trim() === '' ? null : text.trim();
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export function createFileIntakeTexts(rootDir: string): IntakeTextLoader {
  return { load: (name: IntakeTextName) => readFixedText(rootDir, name) };
}

/** prompts/onboarding/messages: the fixed onboarding replies (spec onboarding, rules 19–21). */
export function createFileOnboardingTexts(rootDir: string): OnboardingTextLoader {
  return { load: (name: OnboardingTextName) => readFixedText(rootDir, name) };
}
