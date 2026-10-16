// D-6 (specs/mongo-persistence.md): every boot-time prompt and fixed text is checked at startup;
// a missing or blank file rejects with a message naming the file path only.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBootFiles } from './boot.js';

const PROMPTS_ROOT = join(import.meta.dirname, '..', '..', '..', 'prompts');
const TEXTS = ['not_available', 'escalated', 'returned', 'hr_admin_self'] as const;

const temps: string[] = [];
function copyOfPrompts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boot-prompts-'));
  temps.push(dir);
  cpSync(PROMPTS_ROOT, dir, { recursive: true });
  return dir;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadBootFiles', () => {
  it('D-6: resolves on the repo prompts directory', async () => {
    await expect(loadBootFiles(PROMPTS_ROOT)).resolves.toBeDefined();
  });

  it.each(TEXTS)('D-6: a missing %s fixed text rejects naming its path', async (name) => {
    const root = copyOfPrompts();
    const file = join(root, 'intake', 'messages', `${name}.txt`);
    rmSync(file);
    await expect(loadBootFiles(root)).rejects.toThrow(file);
  });

  it.each(TEXTS)('D-6: a blank %s fixed text rejects naming its path', async (name) => {
    const root = copyOfPrompts();
    const file = join(root, 'intake', 'messages', `${name}.txt`);
    writeFileSync(file, '  \n\t\n');
    await expect(loadBootFiles(root)).rejects.toThrow(file);
  });

  it('D-6: a prompts root that does not exist rejects', async () => {
    const missing = join(tmpdir(), 'boot-prompts-does-not-exist-0000');
    await expect(loadBootFiles(missing)).rejects.toThrow();
  });
});
