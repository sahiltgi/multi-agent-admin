import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ToolDescriptions,
  loadLeaveToolDescriptions,
  loadToolDescriptions,
} from './tool-descriptions.js';

const LEAVE_TOOL_NAMES = [
  'get_my_balance',
  'get_holidays',
  'get_team_calendar',
  'submit_to_gate',
] as const;

async function leaveTempRoot(overrides: Record<string, string | null> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'leave-tool-desc-'));
  await mkdir(join(root, 'leave', 'tools'), { recursive: true });
  for (const name of LEAVE_TOOL_NAMES) {
    const body =
      overrides[name] === undefined ? `  Synthetic ${name} description.\n\n` : overrides[name];
    if (body !== null) await writeFile(join(root, 'leave', 'tools', `${name}.md`), body);
  }
  return root;
}

const realRoot = fileURLToPath(new URL('../../../prompts', import.meta.url));

async function tempRoot(routeText: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tool-desc-'));
  if (routeText !== null) {
    await mkdir(join(root, 'orchestrator', 'tools'), { recursive: true });
    await writeFile(join(root, 'orchestrator', 'tools', 'route.md'), routeText);
  }
  return root;
}

describe('tool descriptions', () => {
  it('AT-30: loadToolDescriptions returns the trimmed route.md text', async () => {
    const root = await tempRoot('  \nSynthetic route description.\n\n');
    const d = await loadToolDescriptions(root);
    expect(d).toEqual({ route: 'Synthetic route description.' });
    expect(ToolDescriptions.safeParse(d).success).toBe(true);
  });

  it('AT-30: a missing route.md rejects', async () => {
    await expect(loadToolDescriptions(await tempRoot(null))).rejects.toThrow();
  });

  it('AT-30: a whitespace-only route.md rejects', async () => {
    await expect(loadToolDescriptions(await tempRoot(' \n\t\n'))).rejects.toThrow();
  });

  it('AT-30: ToolDescriptions is strict and requires a non-blank route', () => {
    expect(ToolDescriptions.safeParse({ route: 'x' }).success).toBe(true);
    expect(ToolDescriptions.safeParse({ route: '  ' }).success).toBe(false);
    expect(ToolDescriptions.safeParse({ route: 'x', other: 'y' }).success).toBe(false);
  });

  it('AT-30: the real prompts/orchestrator/tools/route.md is non-empty with only .example or .test emails', async () => {
    const text = readFileSync(join(realRoot, 'orchestrator', 'tools', 'route.md'), 'utf8');
    expect(text.trim().length).toBeGreaterThan(0);
    for (const m of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
      expect(m).toMatch(/\.(example|test)$/);
    }
    const d = await loadToolDescriptions(realRoot);
    expect(d.route).toBe(text.trim());
  });

  it('D-21: loadLeaveToolDescriptions returns the trimmed text for each of the four tools', async () => {
    const d = await loadLeaveToolDescriptions(await leaveTempRoot());
    expect(d).toEqual({
      get_my_balance: 'Synthetic get_my_balance description.',
      get_holidays: 'Synthetic get_holidays description.',
      get_team_calendar: 'Synthetic get_team_calendar description.',
      submit_to_gate: 'Synthetic submit_to_gate description.',
    });
  });

  it('D-21: a missing leave tool file rejects', async () => {
    for (const name of LEAVE_TOOL_NAMES) {
      await expect(
        loadLeaveToolDescriptions(await leaveTempRoot({ [name]: null })),
      ).rejects.toThrow();
    }
  });

  it('D-21: a whitespace-only leave tool file rejects', async () => {
    for (const name of LEAVE_TOOL_NAMES) {
      await expect(
        loadLeaveToolDescriptions(await leaveTempRoot({ [name]: ' \n\t\n' })),
      ).rejects.toThrow();
    }
  });

  it('D-21: the real prompts/leave/tools/*.md files are non-empty with only .example or .test emails', async () => {
    for (const name of LEAVE_TOOL_NAMES) {
      const text = readFileSync(join(realRoot, 'leave', 'tools', `${name}.md`), 'utf8');
      expect(text.trim().length, name).toBeGreaterThan(0);
      for (const m of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
        expect(m).toMatch(/\.(example|test)$/);
      }
    }
    const d = await loadLeaveToolDescriptions(realRoot);
    for (const name of LEAVE_TOOL_NAMES) {
      expect(d[name]).toBe(
        readFileSync(join(realRoot, 'leave', 'tools', `${name}.md`), 'utf8').trim(),
      );
    }
  });
});
