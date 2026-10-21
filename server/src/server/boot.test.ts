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

  it.each([
    ['chat', 'messages', 'retry.txt'],
    ['chat', 'messages', 'submitted.txt'],
    ['chat', 'messages', 'draft_too_long.txt'],
    ['chat', 'messages', 'draft_template.txt'],
    ['intake', 'messages', 'hand_back.txt'],
    ['leave', 'tools', 'hand_back.md'],
    ['leave', 'v2.md'],
  ])('AT-31: a missing %s boot file rejects naming its path (chat-endpoint)', async (...parts) => {
    const root = copyOfPrompts();
    const file = join(root, ...parts);
    rmSync(file, { force: true });
    await expect(loadBootFiles(root)).rejects.toThrow(file);
  });

  // policy-qa AT-42 (rule 26). ASSUMED signature: loadBootFiles(promptsRoot, { handbookPath, qaPolicyPath }),
  // defaulting to the committed repo files. Reported to the coordinator as an open contract.
  describe('policy-qa boot files', () => {
    const REPO = join(PROMPTS_ROOT, '..');
    const HANDBOOK = join(REPO, 'handbook', 'handbook.md');
    const QA_POLICY = join(REPO, 'policies', 'qa', 'v1.yaml');
    const paths = (o: { handbookPath?: string; qaPolicyPath?: string } = {}) => ({
      handbookPath: HANDBOOK,
      qaPolicyPath: QA_POLICY,
      ...o,
    });
    const tmpFile = (name: string, content: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'boot-qa-'));
      temps.push(dir);
      const f = join(dir, name);
      writeFileSync(f, content);
      return f;
    };

    it('AT-42: resolves with the committed handbook, policy, prompt and escalation text', async () => {
      await expect(loadBootFiles(PROMPTS_ROOT, paths())).resolves.toBeDefined();
    });

    it.each([
      ['policy_qa', 'v1.md'],
      ['policy_qa', 'messages', 'escalated.txt'],
    ])('AT-42: a missing prompts/%s boot file rejects naming its path', async (...parts) => {
      const root = copyOfPrompts();
      const file = join(root, ...parts);
      rmSync(file, { force: true });
      await expect(loadBootFiles(root, paths())).rejects.toThrow(file);
    });

    it('AT-42: a missing handbook or QA policy rejects naming that path', async () => {
      const gone = join(tmpdir(), 'boot-qa-does-not-exist', 'x');
      await expect(loadBootFiles(PROMPTS_ROOT, paths({ handbookPath: gone }))).rejects.toThrow(
        gone,
      );
      await expect(loadBootFiles(PROMPTS_ROOT, paths({ qaPolicyPath: gone }))).rejects.toThrow(
        gone,
      );
    });

    it('AT-42: a handbook without frontmatter or with an emoji rejects naming its path only', async () => {
      const noFm = tmpFile('handbook.md', '# T\n\n### HB-1.1 A\n\nText here.\n');
      await expect(loadBootFiles(PROMPTS_ROOT, paths({ handbookPath: noFm }))).rejects.toThrow(
        noFm,
      );
      const emoji = tmpFile(
        'handbook.md',
        '---\ntitle: T\n---\n# T\n\n### HB-1.1 A\n\nText \u{1F600} here.\n',
      );
      const err = await loadBootFiles(PROMPTS_ROOT, paths({ handbookPath: emoji })).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain(emoji);
      expect(err?.message).not.toContain('\u{1F600}');
    });
  });

  it('D-6: a prompts root that does not exist rejects', async () => {
    const missing = join(tmpdir(), 'boot-prompts-does-not-exist-0000');
    await expect(loadBootFiles(missing)).rejects.toThrow();
  });
});
