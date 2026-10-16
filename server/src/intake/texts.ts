// File-backed fixed texts for intake (spec request-intake, D-14). Reads <rootDir>/<name>.txt.
// A missing or blank file loads as null, and intake fails closed: no model text is substituted.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntakeTextLoader, IntakeTextName } from './ports.js';

export function createFileIntakeTexts(rootDir: string): IntakeTextLoader {
  return {
    async load(name: IntakeTextName) {
      try {
        const text = await readFile(join(rootDir, `${name}.txt`), 'utf8');
        return text.trim() === '' ? null : text.trim();
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}
