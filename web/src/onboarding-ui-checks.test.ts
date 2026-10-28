// Spec onboarding-ui: source-text and repository checks (AT-4 and AT-13 scans, AT-10 import,
// AT-16 last bullet, AT-18 static half, AT-19 amendments, AT-20 synthetic data).
// AT-17 (no non-test server/ policies/ prompts/ evals/ change) is a review check on the PR diff.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_SRC = join(ROOT, 'web', 'src');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const rel = (p: string): string => relative(ROOT, p).split('\\').join('/');

function walk(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p, pattern);
    return pattern.test(name) ? [p] : [];
  });
}
const isTest = (p: string): boolean => /\.test\.tsx?$/.test(p);

/** Onboarding.tsx plus every non-test file under components/onboarding/. */
function onboardingSources(): string[] {
  const route = join(WEB_SRC, 'routes', 'Onboarding.tsx');
  const dir = join(WEB_SRC, 'components', 'onboarding');
  expect(existsSync(route), 'web/src/routes/Onboarding.tsx exists').toBe(true);
  expect(existsSync(dir), 'web/src/components/onboarding exists').toBe(true);
  const files = walk(dir, /\.tsx?$/).filter((p) => !isTest(p));
  expect(files.length).toBeGreaterThan(1);
  return [route, ...files];
}

describe('onboarding-ui: no clock, key or approval code in the page (AT-4, AT-13)', () => {
  it('AT-4: the route and its components use no Date, weekday, idempotencyKey or random id', () => {
    for (const f of onboardingSources()) {
      const text = readFileSync(f, 'utf8');
      for (const banned of [
        'Date.now',
        'new Date(',
        'getDay',
        'idempotencyKey',
        'crypto.randomUUID',
      ]) {
        expect(text.includes(banned), `${rel(f)} contains ${banned}`).toBe(false);
      }
    }
  });

  it('AT-13: no onboarding source imports ActionBody, calls postAction, names /approvals or compares a verdict', () => {
    for (const f of onboardingSources()) {
      const text = readFileSync(f, 'utf8');
      for (const banned of [
        'postAction',
        'ActionBody',
        '/approvals',
        "=== 'AUTO'",
        "=== 'MANAGER'",
      ]) {
        expect(text.includes(banned), `${rel(f)} contains ${banned}`).toBe(false);
      }
    }
  });

  it('AT-10: the owner groups take the task status from taskStatus in @hr/shared', () => {
    const texts = onboardingSources().map((f) => readFileSync(f, 'utf8'));
    const users = texts.filter((t) => /\btaskStatus\b/.test(t));
    expect(users.length).toBeGreaterThan(0);
    expect(users.some((t) => /taskStatus[^;]*from\s*['"]@hr\/shared['"]/s.test(t))).toBe(true);
    for (const t of texts) {
      expect(/function\s+taskStatus\b|const\s+taskStatus\b/.test(t)).toBe(false);
    }
  });
});

describe('onboarding-ui: facade names are not redeclared (AT-16, last bullet)', () => {
  it('AT-16: no non-test web file declares a new facade name or imports a server path', () => {
    const names = [
      'ChecklistView',
      'CreateOnboardingBody',
      'CreateOnboardingResponse',
      'ListOnboardingResponse',
      'TaskStatusBody',
      'TemplateId',
      'taskStatus',
    ];
    const declaration = new RegExp(
      `\\b(?:const|let|var|type|interface|function|class|enum)\\s+(?:${names.join('|')})\\b`,
    );
    const files = walk(WEB_SRC, /\.tsx?$/).filter((p) => !isTest(p));
    expect(files.map(rel)).toContain('web/src/routes/Onboarding.tsx');
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(declaration.test(text), `${rel(f)} redeclares a facade name`).toBe(false);
      expect(/from\s*['"][^'"]*server\//.test(text), `${rel(f)} imports server/`).toBe(false);
    }
  });
});

describe('onboarding-ui: the look (AT-18, static half)', () => {
  it('AT-18: onboarding sources use no HTML sink, and no web font or new dependency appears', () => {
    for (const f of onboardingSources()) {
      const text = readFileSync(f, 'utf8');
      for (const banned of [
        'dangerouslySetInnerHTML',
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
      ]) {
        expect(text.includes(banned), `${rel(f)} ${banned}`).toBe(false);
      }
    }
    const css = read('web/src/styles/app.css');
    expect(css.includes('@font-face')).toBe(false);
    expect(/article[^{]*\{[^}]*box-shadow\s*:\s*(?!none)/.test(css)).toBe(false);
    expect(css.includes('progress'), 'app.css styles the progress bar').toBe(true);
    const pkg = JSON.parse(read('web/package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ['@hr/shared', 'react', 'react-dom', 'react-router', 'zod'].sort(),
    );
  });

  it('AT-18: the web imports zod nowhere in the onboarding sources', () => {
    for (const f of onboardingSources()) {
      expect(/from\s*['"]zod['"]/.test(readFileSync(f, 'utf8')), rel(f)).toBe(false);
    }
  });
});

describe('onboarding-ui: amendments and docs (AT-19, rule 20)', () => {
  const MARK = 'Amended by specs/onboarding-ui.md';
  const range = (prefix: string, n: number): string[] =>
    Array.from({ length: n }, (_v, i) => `${prefix}-${String(i + 1)}`);
  const cases: [string, string[]][] = [
    ['specs/e2e-demo.md', range('E', 7)],
    ['specs/web-shell.md', range('S', 8)],
    ['specs/employee-chat.md', ['S-6']],
    ['specs/approval-queue-ui.md', ['S-6']],
    ['specs/audit-view.md', ['S-6']],
  ];
  it.each(cases)('AT-19: %s carries the amendment line naming its items', (file, itemIds) => {
    const text = read(file);
    const at = text.indexOf(MARK);
    expect(at, `${file} has "${MARK}"`).toBeGreaterThanOrEqual(0);
    const block = text.slice(at, at + 3000);
    for (const id of itemIds) expect(block.includes(id), `${file} names ${id}`).toBe(true);
  });

  it('AT-19: docs/architecture.md web/src line mentions specs/onboarding-ui.md', () => {
    const line = read('docs/architecture.md')
      .split('\n')
      .find((l) => l.includes('web/src/'));
    expect(line?.includes('specs/onboarding-ui.md')).toBe(true);
  });
});

describe('onboarding-ui: synthetic data only (AT-20, rule 21)', () => {
  // Prefix and at-sign are built, so this file's own source passes its scan.
  const pre = ['em', 'p-'].join('');
  const at = String.fromCharCode(64);
  const files = [
    ...walk(WEB_SRC, /\.(ts|tsx)$/),
    ...walk(join(ROOT, 'shared', 'src'), /\.(ts|tsx)$/),
    ...walk(join(ROOT, 'e2e'), /\.(ts|tsx)$/),
  ];

  it('AT-20: no email-like text and every seeded id is three digits', () => {
    expect(files.map(rel)).toContain('web/src/routes/Onboarding.tsx');
    const email = new RegExp(`[\\w.+-]+${at}[\\w-]+\\.[\\w.-]+`);
    const idLike = new RegExp(`${pre}[\\w-]*`, 'g');
    const idOk = new RegExp(`^${pre}\\d{3}$`);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(email.test(text), `${rel(f)} has an email-like string`).toBe(false);
      for (const m of text.matchAll(idLike))
        expect(idOk.test(m[0]), `${rel(f)} has id ${m[0]}`).toBe(true);
    }
  });

  it('AT-20: the only joiner names are the three placeholders', () => {
    const allowed = new Set(['Test Joiner A', 'Test Joiner B', 'Demo Joiner Kestrel']);
    const named = /\b(?:newJoinerName|displayName)\b\s*[:=]\s*['"]([^'"]+)['"]/g;
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(named)) {
        expect(allowed.has(m[1] ?? ''), `${rel(f)} names ${m[1] ?? ''}`).toBe(true);
      }
    }
  });
});
