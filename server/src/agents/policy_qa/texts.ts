// The Policy Q&A fixed texts (spec policy-qa, rule 21; DD-21, DD-23). Read from
// prompts/policy_qa/messages/<name>.txt and trimmed; a blank or missing file loads as null, so
// callers fail closed. Other read errors propagate.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type QaTextName = 'escalated';
export const QA_TEXTS: readonly QaTextName[] = ['escalated'];

export interface QaTextLoader {
  load(name: QaTextName): Promise<string | null>;
}

export function createFileQaTexts(rootDir: string): QaTextLoader {
  return {
    async load(name) {
      if (!QA_TEXTS.includes(name)) return null;
      try {
        const text = (await readFile(join(rootDir, `${name}.txt`), 'utf8')).trim();
        return text === '' ? null : text;
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}
