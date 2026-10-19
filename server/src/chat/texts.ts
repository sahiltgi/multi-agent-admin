// File-backed fixed texts for chat (spec chat-endpoint rule 21). Reads <rootDir>/<key>.txt, where
// rootDir is prompts/chat/messages. A missing or blank file is "not found", and the turn fails
// closed: no model text is ever substituted.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatTextLoader } from './ports.js';
import { ChatTextKey } from './schemas.js';

export function createFileChatTexts(rootDir: string): ChatTextLoader {
  return {
    async load(key) {
      // key is a closed Zod enum, so no path traversal.
      try {
        const text = await readFile(join(rootDir, `${ChatTextKey.parse(key)}.txt`), 'utf8');
        return text.trim() === '' ? { found: false } : { found: true, text: text.trim() };
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { found: false };
        throw err;
      }
    },
  };
}
