// specs/audit-view.md AT-27 (server half, rule 26), AT-28 (rule 27) and the AT-1 / A-9 extraction
// of readVisibleTrace. Source-text checks over the non-test files of server/src/audit-view/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvalAgent } from '../evals/schemas.js';
import * as trace from '../http/approvals/trace.js';
import { EvalAgentName } from './schemas.js';

const DIR = import.meta.dirname;
const SERVER_SRC = join(DIR, '..');
const sources = () =>
  readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ f, src: readFileSync(join(DIR, f), 'utf8') }));
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('audit-view AT-27: server half', () => {
  it('AT-27: EvalAgentName.options deep-equals EvalAgent.options', () => {
    expect(EvalAgentName.options).toEqual(EvalAgent.options);
  });

  it('AT-27: schemas.ts imports only zod, domain/schemas, domain/qa and lib/cost', () => {
    const src = stripComments(readFileSync(join(DIR, 'schemas.ts'), 'utf8'));
    const specs = [...src.matchAll(/\bfrom\s*'([^']+)'/g)].map((m) => m[1]);
    const allowed = new Set(['zod', '../domain/schemas.js', '../domain/qa.js', '../lib/cost.js']);
    for (const s of specs)
      expect(allowed.has(s ?? ''), `schemas.ts imports ${String(s)}`).toBe(true);
  });
});

describe('audit-view AT-28: read-only, deterministic server code', () => {
  it('AT-28: the module has its files and none uses a clock, randomness or process.env', () => {
    const names = sources().map((s) => s.f);
    for (const f of [
      'schemas.ts',
      'timeline.ts',
      'eval-history.ts',
      'markdown.ts',
      'ports.ts',
      'fs-readers.ts',
      'in-memory.ts',
      'routes.ts',
    ]) {
      expect(names).toContain(f);
    }
    for (const { f, src } of sources()) {
      const code = stripComments(src);
      expect(code, f).not.toMatch(/Date\.now/);
      expect(code, f).not.toMatch(/new Date\(\)/);
      expect(code, f).not.toMatch(/Math\.random/);
      expect(code, f).not.toMatch(/process\.env/);
    }
  });

  it('AT-28: only fs-readers.ts imports node:fs or node:path', () => {
    for (const { f, src } of sources()) {
      const imports = [...stripComments(src).matchAll(/\bfrom\s*'(node:(?:fs|path)[^']*)'/g)];
      if (f === 'fs-readers.ts') expect(imports.length, f).toBeGreaterThan(0);
      else expect(imports, f).toEqual([]);
    }
  });

  it('AT-28: nothing imports the gate or a model client; only eval-history.ts imports evals/schemas.ts', () => {
    for (const { f, src } of sources()) {
      const code = stripComments(src);
      expect(code, f).not.toMatch(/from\s+'[^']*\/gate\//);
      expect(code, f).not.toMatch(/anthropic-client|ModelClient/);
      const evalImports = [...code.matchAll(/from\s+'([^']*\/evals\/[^']*)'/g)].map((m) => m[1]);
      if (f === 'eval-history.ts') expect(evalImports).toEqual(['../evals/schemas.js']);
      else expect(evalImports, f).toEqual([]);
    }
  });

  it('AT-28: server/src/http/ imports nothing from agents/ except agents/audit.ts', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory()
          ? walk(join(dir, d.name))
          : d.name.endsWith('.ts') && !d.name.endsWith('.test.ts')
            ? [join(dir, d.name)]
            : [],
      );
    for (const file of walk(join(SERVER_SRC, 'http'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/from\s+'([^']*\/agents\/[^']*)'/g)) {
        expect(m[1], file).toMatch(/\/agents\/audit\.js$/);
      }
    }
  });

  it('AT-28: the routes are mounted by the app', () => {
    const app = readFileSync(join(SERVER_SRC, 'server', 'app.ts'), 'utf8');
    expect(app).toContain('createAuditViewRoutes');
  });
});

describe('audit-view A-9: readVisibleTrace moves to http/approvals/trace.ts', () => {
  it('AT-1: trace.ts exports readVisibleTrace, and routes.ts no longer defines askerView', () => {
    expect(typeof trace.readVisibleTrace).toBe('function');
    expect(existsSync(join(SERVER_SRC, 'http', 'approvals', 'trace.ts'))).toBe(true);
    const routes = readFileSync(join(SERVER_SRC, 'http', 'approvals', 'routes.ts'), 'utf8');
    expect(routes).not.toMatch(/function\s+askerView/);
    expect(routes).toContain('readVisibleTrace');
  });
});
