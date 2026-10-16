// Fixed reply texts for request intake (spec request-intake, D-14): the file loader and the real files.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IntakeTextName } from './ports.js';
import { createFileIntakeTexts } from './texts.js';

const realRoot = fileURLToPath(new URL('../../../prompts/intake/messages', import.meta.url));
const NAMES: IntakeTextName[] = ['not_available', 'escalated', 'returned', 'hr_admin_self'];

async function root(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'intake-texts-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

describe('intake fixed texts (D-14)', () => {
  it('D-14: a present file is returned trimmed', async () => {
    const texts = createFileIntakeTexts(await root({ 'escalated.txt': '  Please contact HR.\n' }));
    expect(await texts.load('escalated')).toBe('Please contact HR.');
  });

  it('D-14: a missing file loads as null', async () => {
    const texts = createFileIntakeTexts(await root());
    expect(await texts.load('returned')).toBeNull();
  });

  it('D-14: a whitespace-only file loads as null', async () => {
    const texts = createFileIntakeTexts(await root({ 'hr_admin_self.txt': ' \n\t\n' }));
    expect(await texts.load('hr_admin_self')).toBeNull();
  });

  it('D-14: a read error other than ENOENT rejects', async () => {
    const dir = await root();
    await mkdir(join(dir, 'not_available.txt'));
    await expect(createFileIntakeTexts(dir).load('not_available')).rejects.toThrow();
  });

  it('D-14: every real text file exists, is not blank and uses no decision language', async () => {
    const texts = createFileIntakeTexts(realRoot);
    for (const name of NAMES) {
      const text = await texts.load(name);
      expect(text, name).not.toBeNull();
      expect(text, name).not.toMatch(/approv|reject|denied|granted|verdict|ROUTE_TO|ESCALATE_TO/i);
    }
  });
});
