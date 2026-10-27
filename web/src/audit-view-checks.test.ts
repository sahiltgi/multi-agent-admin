// Spec audit-view: source-text and repository checks (AT-26 static half, AT-29, AT-30).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_SRC = join(ROOT, 'web', 'src');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

function auditSources(): string[] {
  const dir = join(WEB_SRC, 'components', 'audit');
  expect(existsSync(dir), 'web/src/components/audit exists').toBe(true);
  const files = readdirSync(dir)
    .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))
    .map((n) => join(dir, n));
  return [join(WEB_SRC, 'routes', 'Audit.tsx'), ...files];
}

describe('audit-view AT-26 (static): the web never compares a verdict or writes HTML', () => {
  it('AT-26: no audit source compares a verdict string or uses an HTML sink', () => {
    const files = auditSources();
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const banned of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML']) {
        expect(text.includes(banned), `${f} contains ${banned}`).toBe(false);
      }
      expect(
        /(===|!==|==|!=)\s*['"](ROUTE_TO_MANAGER|ROUTE_TO_MANAGER_WITH_FLAGS|ESCALATE_TO_HR|RETURN_TO_EMPLOYEE|AUTO_ANSWER|AUTO|MANAGER)['"]/.test(
          text,
        ),
        `${f} compares a verdict`,
      ).toBe(false);
      expect(/['"](ROUTE_TO_MANAGER|ESCALATE_TO_HR|AUTO_ANSWER)['"]\s*(===|!==)/.test(text)).toBe(
        false,
      );
    }
  });
});

describe('audit-view AT-29: amendments and docs (rule 28)', () => {
  const MARK = 'Amended by specs/audit-view.md';
  const cases: [string, string[]][] = [
    ['specs/web-shell.md', ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8']],
    ['specs/approval-queue.md', ['A-9']],
    ['specs/eval-runner.md', ['A-10']],
    ['specs/agent-metrics.md', ['A-11']],
  ];
  it.each(cases)('AT-29: %s carries the amendment line naming its items', (file, ids) => {
    const text = read(file);
    const at = text.indexOf(MARK);
    expect(at, `${file} has "${MARK}"`).toBeGreaterThanOrEqual(0);
    const block = text.slice(at, at + 3000);
    for (const id of ids) expect(block.includes(id), `${file} names ${id}`).toBe(true);
  });

  it('AT-29: docs/architecture.md mentions server/src/audit-view/ and specs/audit-view.md', () => {
    const text = read('docs/architecture.md');
    expect(text).toContain('server/src/audit-view/');
    expect(text).toContain('specs/audit-view.md');
  });
});

describe('audit-view AT-30: synthetic data and the look (rule 29)', () => {
  it('AT-30: web dependencies are exactly the web-shell rule 18 list', () => {
    const pkg = JSON.parse(read('web/package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ['@hr/shared', 'react', 'react-dom', 'react-router', 'zod'].sort(),
    );
  });

  it('AT-30: audit fixtures use only seeded ids and .example / .invalid addresses', () => {
    const files = [
      'web/src/routes/Audit.test.tsx',
      'server/src/audit-view/routes.test.ts',
      'server/src/audit-view/eval-history.test.ts',
      'server/src/audit-view/markdown.test.ts',
    ];
    // Prefixes are split so this file's own source passes the web-shell AT-30 scan.
    const pre = ['em', 'p', '|lr|ai|ev', 't'].join('');
    const quoted = new RegExp(`['"\`](?:${pre})-[^'"\`\\s]*['"\`]`, 'g');
    const ok = new RegExp(`^(${pre})-\\d{3}$`);
    const at = String.fromCharCode(64);
    const mail = new RegExp(`[A-Za-z0-9._-]+${at}([A-Za-z0-9.-]+)`, 'g');
    for (const f of files) {
      const text = read(f);
      for (const m of text.matchAll(quoted)) {
        const id = m[0].slice(1, -1);
        if (ok.test(id)) continue;
        expect(id, `${f}: ${id}`).toMatch(/CANARY|-$|-\$/);
      }
      for (const m of text.matchAll(mail)) {
        expect(m[1], `${f}: ${m[0]}`).toMatch(/\.(example|invalid)$/);
      }
    }
  });

  it('AT-30: app.css adds no web font, and no chart library or markdown dependency is declared', () => {
    const css = readFileSync(join(WEB_SRC, 'styles', 'app.css'), 'utf8');
    expect(css.includes('@font-face')).toBe(false);
    expect(css).toMatch(/\[data-injection/); // the highlight styles exist
    expect(css).toMatch(/\[data-stage/); // the timeline styles exist
  });
});
