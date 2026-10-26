// Spec employee-chat: AT-20 (rule 15, amendment line and docs) and AT-21 (rule 16, new files).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('employee-chat amendments and hygiene', () => {
  it('AT-20: specs/web-shell.md carries the amendment line naming A-1 to A-10', () => {
    const text = read('specs/web-shell.md');
    const at = text.indexOf('Amended by specs/employee-chat.md (2026-10-26)');
    expect(at).toBeGreaterThanOrEqual(0);
    const line = text.slice(at).split('\n')[0] ?? '';
    const block = text.slice(at, at + 3000);
    for (let n = 1; n <= 10; n += 1) {
      expect(`${line}\n${block}`.includes(`A-${String(n)}`), `A-${String(n)}`).toBe(true);
    }
  });

  it('AT-20: docs/architecture.md names the spec and the handbook module', () => {
    const text = read('docs/architecture.md');
    expect(text).toContain('specs/employee-chat.md');
    expect(text).toContain('server/src/handbook/');
  });

  it('AT-21: the new web components and the handbook route exist and use no HTML sink', () => {
    const files = [
      'web/src/components/StatusPill.tsx',
      'web/src/components/CitationChips.tsx',
      'web/src/components/HandbookSection.tsx',
      'web/src/components/MyRequests.tsx',
      'server/src/handbook/routes.ts',
      'server/src/handbook/schemas.ts',
    ];
    for (const f of files) expect(existsSync(join(ROOT, f)), f).toBe(true);
    for (const f of files.filter((x) => x.startsWith('web/'))) {
      const text = read(f);
      for (const banned of [
        'dangerouslySetInnerHTML',
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
      ]) {
        expect(text.includes(banned), `${f} ${banned}`).toBe(false);
      }
      expect(/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text), `${f} email`).toBe(false);
    }
  });
});
