// Acceptance tests for specs/onboarding.md AT-35 (rule 27): boot files and injected determinism.
// The determinism of two identical dispatches and the fixture checks are in intake/onboarding.test.ts.
// ASSUMED contracts (reported to the coordinator):
//   loadBootFiles(promptsRoot, { handbookPath, qaPolicyPath, onboardingPolicyPath }) loads the
//   onboarding policy, prompts/onboarding/v1.md, prompts/onboarding/tools/<tool>.md and
//   prompts/onboarding/messages/<name>.txt, and returns the policy as `onboardingPolicy`.
import { existsSync, readdirSync, readFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBootFiles } from './boot.js';

const PROMPTS_ROOT = join(import.meta.dirname, '..', '..', '..', 'prompts');
const REPO = join(PROMPTS_ROOT, '..');
const paths = (o: Record<string, string> = {}) => ({
  handbookPath: join(REPO, 'handbook', 'handbook.md'),
  qaPolicyPath: join(REPO, 'policies', 'qa', 'v1.yaml'),
  onboardingPolicyPath: join(REPO, 'policies', 'onboarding', 'v1.yaml'),
  ...o,
});

const temps: string[] = [];
function copyOfPrompts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boot-onboarding-'));
  temps.push(dir);
  cpSync(PROMPTS_ROOT, dir, { recursive: true });
  return dir;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MESSAGES = [
  'created',
  'pending_manager',
  'denied',
  'escalated',
  'fallback_question',
  'start_date_past',
] as const;
const TOOLS = ['get_template', 'create_checklist', 'propose_deviation'] as const;

describe('onboarding AT-35: boot files', () => {
  it('AT-35: the committed files load and the onboarding policy is returned', async () => {
    const boot = (await loadBootFiles(PROMPTS_ROOT, paths())) as unknown as Record<string, unknown>;
    expect(boot.onboardingPolicy).toMatchObject({ policyVersion: 'v1' });
  });

  it('AT-35: a missing onboarding policy rejects naming that path only', async () => {
    const gone = join(tmpdir(), 'boot-onboarding-does-not-exist', 'v1.yaml');
    await expect(
      loadBootFiles(PROMPTS_ROOT, paths({ onboardingPolicyPath: gone }) as never),
    ).rejects.toThrow(gone);
  });

  it.each([
    ['v1.md'],
    ...TOOLS.map((t) => ['tools', `${t}.md`]),
    ...MESSAGES.map((m) => ['messages', `${m}.txt`]),
  ])('AT-35: a missing prompts/onboarding/%s file rejects naming its path', async (...parts) => {
    const root = copyOfPrompts();
    const file = join(root, 'onboarding', ...parts);
    expect(existsSync(file), `${file} must be committed`).toBe(true);
    rmSync(file, { force: true });
    await expect(loadBootFiles(root, paths() as never)).rejects.toThrow(file);
  });
});

describe('onboarding AT-35: no clock, randomness or env in agent, dispatch and route sources', () => {
  const server = fileURLToPath(new URL('..', import.meta.url));
  const listSources = (dir: string): string[] => {
    expect(existsSync(dir), `${dir} must exist`).toBe(true);
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(dir, f));
  };

  it('AT-35: sources are free of Date.now, argument-less new Date(), Math.random and process.env', () => {
    const files = [
      ...listSources(join(server, 'agents', 'onboarding')),
      ...listSources(join(server, 'onboarding')),
      join(server, 'intake', 'dispatch.ts'),
    ];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/Date\.now/);
      expect(src, f).not.toMatch(/new Date\(\s*\)/);
      expect(src, f).not.toMatch(/Math\.random/);
      expect(src, f).not.toMatch(/process\.env/);
    }
    const names = files.map((f) => f.split('/').slice(-2).join('/'));
    expect(names).toEqual(expect.arrayContaining(['onboarding/run.ts', 'onboarding/tools.ts']));
    expect(names).toEqual(expect.arrayContaining(['onboarding/routes.ts']));
  });
});
