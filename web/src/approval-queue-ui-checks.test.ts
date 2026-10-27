// Spec approval-queue-ui: source-text and repository checks (AT-4 scan, AT-21, AT-22 styles).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_SRC = join(ROOT, 'web', 'src');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

function queueSources(): string[] {
  const dir = join(WEB_SRC, 'components', 'approvals');
  expect(existsSync(dir), 'web/src/components/approvals exists').toBe(true);
  const files = readdirSync(dir)
    .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))
    .map((n) => join(dir, n));
  return [join(WEB_SRC, 'routes', 'Queue.tsx'), ...files];
}

describe('approval-queue-ui: the browser never counts days', () => {
  it('AT-4: Queue.tsx and the approvals components use no date, holiday or working-regexp logic', () => {
    const files = queueSources();
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const banned of ['getDay', 'getUTCDay', 'Date.parse', 'new Date(', '.actual']) {
        expect(text.includes(banned), `${f} contains ${banned}`).toBe(false);
      }
      expect(/holiday/i.test(text), `${f} mentions holiday`).toBe(false);
      expect(
        /\/[^/\n]*working[^/\n]*\/[gimsuy]*/.test(text.replace(/\/\/.*$/gm, '')),
        `${f} regexp`,
      ).toBe(false);
      expect(/new\s+RegExp\s*\([^)]*working/i.test(text), `${f} new RegExp`).toBe(false);
    }
  });
});

describe('approval-queue-ui: amendments and docs (rule 21)', () => {
  const MARK = 'Amended by specs/approval-queue-ui.md';
  const cases: [string, string[]][] = [
    ['specs/web-shell.md', ['W-1', 'W-2', 'W-3', 'W-4', 'W-5', 'W-6', 'W-7', 'W-8']],
    ['specs/employee-chat.md', ['E-1']],
    ['specs/approval-queue.md', ['Q-1', 'Q-2', 'Q-3']],
    ['specs/leave-gate.md', ['L-1']],
  ];
  it.each(cases)('AT-21: %s carries the amendment line naming its items', (file, ids) => {
    const text = read(file);
    const at = text.indexOf(MARK);
    expect(at, `${file} has "${MARK}"`).toBeGreaterThanOrEqual(0);
    const block = text.slice(at, at + 3000);
    for (const id of ids) expect(block.includes(id), `${file} names ${id}`).toBe(true);
  });

  it('AT-21: docs/architecture.md web/src line mentions specs/approval-queue-ui.md', () => {
    const line = read('docs/architecture.md')
      .split('\n')
      .find((l) => l.includes('web/src/'));
    expect(line?.includes('specs/approval-queue-ui.md')).toBe(true);
  });
});

describe('approval-queue-ui: the look (rule 22)', () => {
  it('AT-22: new components exist, use no HTML sink, and app.css adds no web font or shadow on cards', () => {
    const files = queueSources();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const banned of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML']) {
        expect(text.includes(banned), `${f} ${banned}`).toBe(false);
      }
    }
    const css = readFileSync(join(WEB_SRC, 'styles', 'app.css'), 'utf8');
    expect(css.includes('@font-face')).toBe(false);
    expect(/article[^{]*\{[^}]*box-shadow\s*:\s*(?!none)/.test(css)).toBe(false);
    expect(/\.card[^{]*\{[^}]*box-shadow\s*:\s*(?!none)/.test(css)).toBe(false);
  });
});
