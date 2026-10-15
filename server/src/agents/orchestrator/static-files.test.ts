import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (p: string): string => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const prompt = (): string => readFileSync(root('prompts/orchestrator/v1.md'), 'utf8');
const SOURCES = ['classify.ts', 'config.ts', 'messages.ts', 'route-tool.ts', 'schemas.ts'];
const src = (f: string): string => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

describe('orchestrator static files', () => {
  it('AT-17: the prompt states that any prohibited part makes the message prohibited', () => {
    expect(prompt()).toMatch(/any part[^.]*prohibited|prohibited[^.]*any part/i);
  });

  it('AT-17: the prompt states two legitimate intents are unclear (D-7)', () => {
    expect(prompt()).toMatch(
      /(two|more than one|multiple)[^.]*unclear|unclear[^.]*(two|more than one|multiple)/i,
    );
  });

  it('AT-23: the prompt names all six labels and route, has no real-looking email', () => {
    const p = prompt();
    expect(p.trim().length).toBeGreaterThan(0);
    for (const l of ['leave', 'policy_qa', 'onboarding', 'prohibited', 'out_of_scope', 'unclear']) {
      expect(p).toContain(l);
    }
    expect(p).toContain('route');
    for (const m of p.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
      expect(m).toMatch(/\.(example|test)$/);
    }
  });

  it('AT-23: the prompt treats tagged content as data and does not copy the prohibited message', () => {
    const p = prompt();
    expect(p).toMatch(/untrusted_data/);
    expect(p).toMatch(/data/i);
    const prohibited = readFileSync(root('prompts/orchestrator/messages/prohibited.txt'), 'utf8');
    expect(p).not.toContain(prohibited.trim());
  });

  it('AT-23: the prompt does not copy eval inputs (D-12)', () => {
    const p = prompt();
    const lines = readFileSync(root('evals/orchestrator/cases.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    for (const l of lines) {
      const c = JSON.parse(l) as { userText: string };
      expect(p).not.toContain(c.userText);
    }
  });

  it('AT-24: no orchestrator source passes an inline string as system', () => {
    for (const f of SOURCES) {
      const s = src(f);
      expect(s).not.toMatch(/\bsystem\s*:\s*['"`]/);
      for (const lit of s.match(/(['"`])(?:(?!\1)[^\\\n]|\\.){120,}\1/g) ?? []) {
        throw new Error(`${f}: long inline string literal: ${lit.slice(0, 40)}`);
      }
    }
  });

  it('AT-18: classify.ts and its transitive relative imports never reach the gate', () => {
    const start = fileURLToPath(new URL('./classify.ts', import.meta.url));
    const gateDir = root('server/src/gate/');
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      const s = readFileSync(file, 'utf8');
      for (const m of s.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? '';
        expect(spec).not.toMatch(/gate/i);
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
        if (existsSync(target)) queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(1);
    for (const f of seen) expect(f.startsWith(gateDir)).toBe(false);
    expect(src('classify.ts')).not.toMatch(/\bsubmit_to_gate\b/);
  });

  it('AT-30: route-tool.ts has no inline description string literal', () => {
    expect(src('route-tool.ts')).not.toMatch(/description\s*:\s*['"`]/);
  });
});
