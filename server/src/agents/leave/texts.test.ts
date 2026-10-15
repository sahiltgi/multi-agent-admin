import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClarifyingQuestion } from '../orchestrator/schemas.js';
import { createFileTextLoader } from './texts.js';

const realRoot = fileURLToPath(new URL('../../../../prompts/leave/messages', import.meta.url));

async function root(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'leave-texts-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

describe('leave fixed texts', () => {
  it('D-4: a present file is returned byte for byte, trailing newline kept', async () => {
    const body = '  Which dates do you need?\n';
    const loader = createFileTextLoader(await root({ 'fallback_question.txt': body }));
    expect(await loader.load('fallback_question')).toEqual({ found: true, text: body });
  });

  it('D-4: a missing file is not found', async () => {
    const loader = createFileTextLoader(await root());
    expect(await loader.load('summary_template')).toEqual({ found: false });
  });

  it('D-4: a whitespace-only file is not found', async () => {
    const loader = createFileTextLoader(await root({ 'summary_template.txt': ' \n\t\n' }));
    expect(await loader.load('summary_template')).toEqual({ found: false });
  });

  it('D-4: a read error other than ENOENT rejects', async () => {
    const dir = await root();
    await mkdir(join(dir, 'fallback_question.txt'));
    const loader = createFileTextLoader(dir);
    await expect(loader.load('fallback_question')).rejects.toThrow();
  });

  it('D-4: the real fallback_question.txt loads and is a valid ClarifyingQuestion', async () => {
    const res = await createFileTextLoader(realRoot).load('fallback_question');
    expect(res.found).toBe(true);
    if (res.found) expect(ClarifyingQuestion.safeParse(res.text).success).toBe(true);
  });

  it('D-4: the real summary_template.txt loads and has both placeholders', async () => {
    const res = await createFileTextLoader(realRoot).load('summary_template');
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.text).toContain('{verdict}');
      expect(res.text).toContain('{failedRules}');
    }
  });
});
