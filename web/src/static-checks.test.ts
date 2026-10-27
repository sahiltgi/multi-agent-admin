// Spec web-shell: repository and source-text checks (AT-18, AT-26, AT-28, AT-29, AT-30).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_SRC = join(ROOT, 'web', 'src');
const SHARED_SRC = join(ROOT, 'shared', 'src');

const FACADE_NAMES = [
  'ActionBody',
  'ActionResponse',
  'MAX_COMMENT_CHARS',
  'ChatBody',
  'ChatResponse',
  'ConversationView',
  'ApprovalItemView',
  'ListApprovalsResponse',
  'TraceResponse',
  'ErrorBody',
  'ErrorCode',
  'MAX_USER_TEXT_CHARS',
  'ApprovalKind',
  'ApprovalStatus',
  'LeaveVerdict',
  'OnboardingVerdict',
  'Role',
  'QaVerdict',
];

function walk(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p, pattern);
    return pattern.test(name) ? [p] : [];
  });
}
const isTest = (p: string): boolean => /\.test\.tsx?$/.test(p);
const code = (dir: string): string[] => walk(dir, /\.(ts|tsx)$/).filter((p) => !isTest(p));
const rel = (p: string): string => relative(ROOT, p).split('\\').join('/');
const read = (p: string): string => readFileSync(p, 'utf8');
const readRoot = (p: string): string => read(join(ROOT, p));

describe('no HTML injection, no markdown dependency (rule 10)', () => {
  it('AT-18: non-test web and shared sources never use HTML-writing APIs', () => {
    const files = [...code(WEB_SRC), ...code(SHARED_SRC)];
    expect(files.map(rel)).toContain('web/src/routes/Chat.tsx');
    for (const f of files) {
      for (const banned of [
        'dangerouslySetInnerHTML',
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
      ]) {
        expect(read(f).includes(banned), `${rel(f)} contains ${banned}`).toBe(false);
      }
    }
  });

  it('AT-18: web dependencies are exactly react, react-dom, react-router, zod and @hr/shared', () => {
    const pkg = JSON.parse(readRoot('web/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ['@hr/shared', 'react', 'react-dom', 'react-router', 'zod'].sort(),
    );
  });
});

describe('web imports contracts only from the facade (rule 16)', () => {
  it('AT-26: no server/ import, zod only in env.ts and storage.ts, no redeclared facade names', () => {
    const files = code(WEB_SRC);
    expect(files.map(rel)).toContain('web/src/routes/Chat.tsx');
    const zodUsers: string[] = [];
    const declaration = new RegExp(
      `\\b(?:const|let|var|type|interface|function|class|enum)\\s+(?:${FACADE_NAMES.join('|')})\\b`,
    );
    for (const f of files) {
      const text = read(f);
      const specifiers = [
        ...[...text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
        ...[...text.matchAll(/\bimport\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
      ];
      for (const s of specifiers)
        expect(s.includes('server/'), `${rel(f)} imports ${s}`).toBe(false);
      if (specifiers.some((s) => s === 'zod' || s.startsWith('zod/'))) zodUsers.push(rel(f));
      expect(declaration.test(text), `${rel(f)} redeclares a facade name`).toBe(false);
    }
    expect(zodUsers.sort()).toEqual(['web/src/api/env.ts', 'web/src/persona/storage.ts']);
  });

  it('AT-26: MAX_USER_TEXT_CHARS comes from @hr/shared and the literal 4000 appears nowhere', () => {
    const files = code(WEB_SRC);
    const users = files.filter((f) => read(f).includes('MAX_USER_TEXT_CHARS'));
    expect(users.map(rel)).toContain('web/src/routes/Chat.tsx');
    for (const f of users) {
      expect(/from\s*['"]@hr\/shared['"]/.test(read(f)), `${rel(f)} must import @hr/shared`).toBe(
        true,
      );
    }
    for (const f of files) expect(/\b4000\b|\b4_000\b/.test(read(f)), rel(f)).toBe(false);
  });
});

describe('approval-queue-ui amendment W-7 to AT-26', () => {
  it('AT-26: MAX_COMMENT_CHARS comes from @hr/shared and the literal 1000 appears in no non-test web file', () => {
    const files = code(WEB_SRC);
    const users = files.filter((f) => read(f).includes('MAX_COMMENT_CHARS'));
    expect(users.map(rel)).toContain('web/src/components/approvals/ActionBar.tsx');
    for (const f of users) {
      expect(/from\s*['"]@hr\/shared['"]/.test(read(f)), `${rel(f)} must import @hr/shared`).toBe(
        true,
      );
    }
    for (const f of files) expect(/\b1000\b|\b1_000\b/.test(read(f)), rel(f)).toBe(false);
  });
});

describe('workspace wiring (rule 18)', () => {
  it('AT-28: workspaces, shared package, tsconfig reference, vitest project and web dev deps', () => {
    const root = JSON.parse(readRoot('package.json')) as { workspaces: string[] };
    expect(root.workspaces).toContain('shared');
    const shared = JSON.parse(readRoot('shared/package.json')) as {
      name: string;
      exports: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(shared.name).toBe('@hr/shared');
    expect(shared.exports['.']).toBe('./src/api.ts');
    expect(Object.keys(shared.dependencies)).toEqual(['zod']);
    expect(/"path"\s*:\s*"(\.\/)?shared"/.test(readRoot('tsconfig.json'))).toBe(true);
    expect(/['"]shared['"]/.test(readRoot('vitest.config.ts'))).toBe(true);
    const web = JSON.parse(readRoot('web/package.json')) as {
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(web.devDependencies)).toContain('@testing-library/react');
    expect(Object.keys(web.devDependencies)).toContain('@testing-library/user-event');
  });

  it('AT-28: docs cite the facade spec and domain-schemas carries the amendment line', () => {
    const line = readRoot('docs/architecture.md')
      .split('\n')
      .find((l) => l.includes('shared/'));
    expect(line?.includes('specs/web-shell.md')).toBe(true);
    expect(readRoot('specs/domain-schemas.md')).toContain(
      'Amended by specs/web-shell.md (2026-10-26)',
    );
  });
});

describe('look and synthetic data (rules 19, 20)', () => {
  it('AT-29: tokens.css defines the tokens, colours and a dark block', () => {
    const path = join(WEB_SRC, 'styles', 'tokens.css');
    expect(existsSync(path)).toBe(true);
    const css = read(path);
    for (const token of [
      '--surface',
      '--ink',
      '--accent',
      '--tone-neutral',
      '--tone-amber',
      '--tone-plum',
      '--tone-grey',
    ]) {
      expect(new RegExp(`${token}\\s*:`).test(css), token).toBe(true);
    }
    expect(/--header-height\s*:\s*56px/.test(css)).toBe(true);
    expect(/--content-max\s*:\s*960px/.test(css)).toBe(true);
    expect(/--gutter-phone\s*:\s*16px/.test(css)).toBe(true);
    for (const colour of ['#FAF8F4', '#1F2328', '#0F6E6E']) {
      expect(css.toUpperCase().includes(colour)).toBe(true);
    }
    const dark = css.indexOf('@media (prefers-color-scheme: dark)');
    expect(dark).toBeGreaterThanOrEqual(0);
    expect(/--surface\s*:\s*#15181C/i.test(css.slice(dark))).toBe(true);
  });

  it('AT-29: no web fonts or remote imports, and a :focus-visible rule uses the accent token', () => {
    const files = walk(WEB_SRC, /\.css$/);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const css = read(f);
      expect(css.includes('@font-face'), rel(f)).toBe(false);
      expect(css.includes('fonts.googleapis'), rel(f)).toBe(false);
      expect(/@import\s+url\(/.test(css), rel(f)).toBe(false);
      expect(/url\([^)]*\.(woff2?|ttf|otf|eot)/i.test(css), rel(f)).toBe(false);
    }
    expect(files.some((f) => /:focus-visible[^{]*\{[^}]*var\(--accent\)/.test(read(f)))).toBe(true);
  });

  it('AT-30: no email-like text and every seeded id in web and shared sources is well formed', () => {
    expect(existsSync(join(SHARED_SRC, 'api.ts'))).toBe(true);
    const files = [...walk(WEB_SRC, /\.(ts|tsx|css)$/), ...walk(SHARED_SRC, /\.(ts|tsx)$/)];
    const email = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    // The prefix is split so this file's own source doesn't match its scan.
    const prefix = ['em', 'p-'].join('');
    const idLike = new RegExp(`${prefix}[\\w-]*`, 'g');
    const idOk = new RegExp(`^${prefix}\\d{3}$`);
    for (const f of files) {
      const text = read(f);
      expect(email.test(text), `${rel(f)} has an email-like string`).toBe(false);
      for (const m of text.matchAll(idLike)) {
        expect(idOk.test(m[0]), `${rel(f)} has id ${m[0]}`).toBe(true);
      }
    }
  });
});
