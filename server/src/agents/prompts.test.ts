import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilePromptLoader } from './prompts.js';

describe('prompts: createFilePromptLoader', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prompts-test-'));
    await mkdir(join(dir, 'leave'), { recursive: true });
    await writeFile(join(dir, 'leave', 'v2.md'), 'LEAVE-PROMPT-V2 synthetic text', 'utf8');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prompts: returns found: true with the file text for an existing version', async () => {
    const loader = createFilePromptLoader(dir);
    await expect(loader.load('leave', 'v2')).resolves.toEqual({
      found: true,
      text: 'LEAVE-PROMPT-V2 synthetic text',
    });
  });

  it('prompts: returns found: false for a missing version', async () => {
    const loader = createFilePromptLoader(dir);
    await expect(loader.load('leave', 'v9')).resolves.toEqual({ found: false });
  });
});
