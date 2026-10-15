import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFileMessageLoader } from './messages.js';
import { ClarifyingQuestion } from './schemas.js';

const msgPath = (key: string): string =>
  fileURLToPath(new URL(`../../../../prompts/orchestrator/messages/${key}.txt`, import.meta.url));
const KEYS = ['prohibited', 'out_of_scope', 'fallback_question'] as const;

describe('fixed messages', () => {
  it('AT-25: each fixed-message file is non-empty and has only .example or .test emails', () => {
    for (const key of KEYS) {
      const text = readFileSync(msgPath(key), 'utf8');
      expect(text.trim().length).toBeGreaterThan(0);
      for (const m of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
        expect(m).toMatch(/\.(example|test)$/);
      }
    }
  });

  it('AT-25: the fallback question passes ClarifyingQuestion', () => {
    const text = readFileSync(msgPath('fallback_question'), 'utf8');
    expect(ClarifyingQuestion.safeParse(text).success).toBe(true);
  });

  it('AT-25: the prohibited message points to HR', () => {
    expect(readFileSync(msgPath('prohibited'), 'utf8')).toMatch(/\bHR\b/);
  });

  it('AT-13: the file loader returns file text byte for byte, and not-found for a missing key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-msgs-'));
    const text = 'FIXTURE  text\nwith trailing newline\n';
    await writeFile(join(root, 'prohibited.txt'), text);
    const loader = createFileMessageLoader(root);
    expect(await loader.load('prohibited')).toEqual({ found: true, text });
    expect(await loader.load('out_of_scope')).toEqual({ found: false });
  });

  it('AT-14: the file loader treats a whitespace-only file as not found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-msgs-'));
    await writeFile(join(root, 'prohibited.txt'), '  \n\t\n');
    expect(await createFileMessageLoader(root).load('prohibited')).toEqual({ found: false });
  });

  it('AT-14: the file loader rethrows errors other than a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-msgs-'));
    await mkdir(join(root, 'prohibited.txt')); // a directory: readFile fails with EISDIR
    await expect(createFileMessageLoader(root).load('prohibited')).rejects.toThrow();
  });
});
