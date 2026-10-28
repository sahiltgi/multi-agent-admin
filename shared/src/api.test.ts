// Spec web-shell: AT-25 (facade is exact and re-export-only) and AT-27 (browser-safe import graph).
// The walker below is test code: the spec lists no non-test file for it.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as api from './api.js';
import * as approvals from '../../server/src/http/approvals/schemas.js';
import * as agents from '../../server/src/agents/schemas.js';
import * as chat from '../../server/src/chat/schemas.js';
import * as domain from '../../server/src/domain/schemas.js';
import * as qa from '../../server/src/domain/qa.js';
import * as errors from '../../server/src/http/errors.js';
import * as intake from '../../server/src/intake/schemas.js';
import * as handbookSchemas from '../../server/src/handbook/schemas.js';
// Amended by specs/audit-view.md (A-8): three more facade names from this module.
import * as auditView from '../../server/src/audit-view/schemas.js';
// Amended by specs/onboarding-ui.md (S-6): seven more facade names from these modules.
import * as onboardingApi from '../../server/src/onboarding/schemas.js';
import * as onboardingDomain from '../../server/src/domain/onboarding.js';

const ROOT = resolve(import.meta.dirname, '../..');
const API_TS = join(ROOT, 'shared', 'src', 'api.ts');

const EXPECTED_KEYS = [
  'ActionBody',
  'ActionResponse',
  'ApprovalItemView',
  'ApprovalKind',
  'ApprovalStatus',
  'BuildNotesResponse',
  'ChatBody',
  'ChatResponse',
  'ChecklistView',
  'ConversationView',
  'CreateOnboardingBody',
  'CreateOnboardingResponse',
  'ErrorBody',
  'ErrorCode',
  'EvalHistoryResponse',
  'HandbookSectionResponse',
  'LeaveVerdict',
  'ListApprovalsResponse',
  'ListOnboardingResponse',
  'MAX_COMMENT_CHARS',
  'MAX_USER_TEXT_CHARS',
  'MyRequestsResponse',
  'OnboardingVerdict',
  'QaVerdict',
  'Role',
  'SectionId',
  'TaskStatusBody',
  'TemplateId',
  'TraceResponse',
  'TraceTimelineResponse',
  'taskStatus',
];

function stripComments(src: string): string {
  return strip(src, false);
}

/** Small scanner: drops comments, and optionally the contents of string literals. */
function strip(src: string, dropStrings: boolean): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    const n = src.charAt(i + 1);
    if (c === '/' && n === '/') {
      while (i < src.length && src.charAt(i) !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) i += 1;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src.charAt(j) !== c) j += src.charAt(j) === '\\' ? 2 : 1;
      out += dropStrings ? c + c : src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

interface WalkResult {
  visited: Set<string>;
  violations: string[];
}

function allTypeSpecifiers(clause: string): boolean {
  const inner = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!inner) return false;
  const parts = (inner[1] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return parts.length > 0 && parts.every((p) => /^type\s/.test(p));
}

function walkImports(entry: string): WalkResult {
  const visited = new Set<string>();
  const violations: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    if (!existsSync(file)) {
      violations.push(`${file}: unresolved file`);
      continue;
    }
    const source = readFileSync(file, 'utf8');
    const text = stripComments(source);
    const specifiers: string[] = [];
    const named =
      /\b(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s*from\s*['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(named)) {
      if (m[2] !== undefined) continue; // import type / export type: erased
      if (allTypeSpecifiers(m[3] ?? '')) continue;
      specifiers.push(m[4] ?? '');
    }
    for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specifiers.push(m[1] ?? '');
    if (/\bimport\s*\(/.test(text)) violations.push(`${file}: dynamic import(`);
    if (/\bprocess\b/.test(strip(source, true))) violations.push(`${file}: process`);
    for (const s of specifiers) {
      if (s.startsWith('.')) {
        const target = resolve(dirname(file), s.replace(/\.js$/, '.ts'));
        queue.push(target);
      } else if (s.startsWith('node:')) {
        violations.push(`${file}: ${s}`);
      } else if (s !== 'zod') {
        violations.push(`${file}: ${s}`);
      }
    }
  }
  return { visited, violations };
}

describe('facade exports (rule 16)', () => {
  it('AT-25: exports exactly the listed names, each identical to the server export', () => {
    expect(Object.keys(api).sort()).toEqual(EXPECTED_KEYS);
    expect('LeaveRequestStatus' in api).toBe(false);
    const sources: Record<string, Record<string, unknown>> = {
      ChatBody: chat,
      ChatResponse: chat,
      ConversationView: chat,
      ActionBody: approvals,
      ActionResponse: approvals,
      MAX_COMMENT_CHARS: approvals,
      ApprovalItemView: approvals,
      ListApprovalsResponse: approvals,
      TraceResponse: approvals,
      ErrorBody: errors,
      ErrorCode: errors,
      MAX_USER_TEXT_CHARS: agents,
      ApprovalKind: domain,
      ApprovalStatus: domain,
      LeaveVerdict: domain,
      OnboardingVerdict: domain,
      Role: domain,
      QaVerdict: qa,
      MyRequestsResponse: intake,
      SectionId: qa,
      HandbookSectionResponse: handbookSchemas,
      BuildNotesResponse: auditView,
      EvalHistoryResponse: auditView,
      TraceTimelineResponse: auditView,
      ChecklistView: onboardingApi,
      CreateOnboardingBody: onboardingApi,
      CreateOnboardingResponse: onboardingApi,
      ListOnboardingResponse: onboardingApi,
      TaskStatusBody: onboardingApi,
      TemplateId: domain,
      taskStatus: onboardingDomain,
    };
    const facade: Record<string, unknown> = { ...api };
    for (const name of EXPECTED_KEYS) {
      expect(sources[name], `${name} has a server source`).toBeDefined();
      expect(facade[name]).toBe(sources[name]?.[name]);
      expect(facade[name], `${name} is exported`).toBeDefined();
    }
  });

  it('AT-25: api.ts holds only export-from statements and comments', () => {
    const text = stripComments(readFileSync(API_TS, 'utf8'));
    const rest = text
      .replace(/export\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '')
      .trim();
    expect(rest).toBe('');
    expect(/\bz\./.test(text)).toBe(false);
    expect(/\bconst\b/.test(text)).toBe(false);
    expect(/^\s*(export\s+)?type\s+\w+\s*=/m.test(text)).toBe(false);
    expect(/\binterface\b/.test(text)).toBe(false);
  });
});

function webCode(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : webCode(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('employee-chat facade (rule 12)', () => {
  it('AT-17: exports the exact A-6 list, identical to the server objects, and re-export only', () => {
    // Amended by approval-queue-ui W-7 / E-1: the list is EXPECTED_KEYS.
    expect(Object.keys(api).sort()).toEqual(EXPECTED_KEYS);
    expect(api.MyRequestsResponse).toBe(intake.MyRequestsResponse);
    expect(api.SectionId).toBe(qa.SectionId);
    expect(api.HandbookSectionResponse).toBe(handbookSchemas.HandbookSectionResponse);
    const text = stripComments(readFileSync(API_TS, 'utf8'));
    const rest = text
      .replace(/export\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '')
      .trim();
    expect(rest).toBe('');
  });

  it('AT-17: no non-test web file redeclares MyRequestsResponse or SectionId, or builds an HB- RegExp', () => {
    const files = webCode(join(ROOT, 'web', 'src'));
    expect(files.length).toBeGreaterThan(0);
    const declaration = /\b(?:const|let|var|type|interface)\s+(?:MyRequestsResponse|SectionId)\b/;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(declaration.test(text), `${f} redeclares a contract name`).toBe(false);
      expect(
        /\/[^/\n]*HB-[^/\n]*\/[gimsuy]*/.test(stripComments(text)),
        `${f} RegExp literal`,
      ).toBe(false);
      expect(/new\s+RegExp\s*\([^)]*HB-/.test(text), `${f} new RegExp`).toBe(false);
    }
  });
});

describe('approval-queue-ui facade (rule 20)', () => {
  it('AT-20: exports the W-7 list, the new names are the server objects, no view schemas leak', () => {
    expect(Object.keys(api).sort()).toEqual(EXPECTED_KEYS);
    expect(api.ActionBody).toBe(approvals.ActionBody);
    expect(api.ActionResponse).toBe(approvals.ActionResponse);
    expect(api.MAX_COMMENT_CHARS).toBe(approvals.MAX_COMMENT_CHARS);
    const facade: Record<string, unknown> = { ...api };
    for (const name of [
      'LeaveSubjectView',
      'PolicyQuestionView',
      'DeviationView',
      'ItemGateResult',
    ]) {
      expect(name in facade).toBe(false);
    }
  });

  it('AT-20: no non-test web file declares ActionBody, ActionResponse or MAX_COMMENT_CHARS, or writes 1000', () => {
    const declaration =
      /\b(?:const|let|var|type|interface|function|class|enum)\s+(?:ActionBody|ActionResponse|MAX_COMMENT_CHARS)\b/;
    const files = webCode(join(ROOT, 'web', 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(declaration.test(text), `${f} redeclares a facade name`).toBe(false);
      expect(/\b1000\b|\b1_000\b/.test(text), `${f} has the literal 1000`).toBe(false);
    }
  });
});

describe('browser-safe import graph (rule 17)', () => {
  it('AT-27: the real graph from shared/src/api.ts has no violation and covers the server schemas', () => {
    expect(existsSync(API_TS)).toBe(true);
    const { visited, violations } = walkImports(API_TS);
    expect(violations).toEqual([]);
    const seen = [...visited].map((f) => relative(ROOT, f).split('\\').join('/'));
    for (const must of [
      'server/src/chat/schemas.ts',
      'server/src/http/approvals/schemas.ts',
      'server/src/http/errors.ts',
      'server/src/agents/schemas.ts',
      'server/src/domain/schemas.ts',
      'server/src/domain/qa.ts',
      'server/src/lib/cost.ts',
      'server/src/intake/schemas.ts',
      'server/src/domain/handbook.ts',
      'server/src/handbook/schemas.ts',
      'server/src/audit-view/schemas.ts', // specs/audit-view.md A-8
      // Amended by specs/onboarding-ui.md (S-6, rule 16): the walker also visits these.
      'server/src/onboarding/schemas.ts',
      'server/src/domain/onboarding.ts',
      'server/src/agents/onboarding/schemas.ts',
      'server/src/agents/orchestrator/schemas.ts',
    ]) {
      expect(seen).toContain(must);
    }
  });

  it('AT-18: (employee-chat) the walker visits the new schemas, never routes.ts, and handbook helpers are not exported', () => {
    const { visited, violations } = walkImports(API_TS);
    expect(violations).toEqual([]);
    const seen = [...visited].map((f) => relative(ROOT, f).split('\\').join('/'));
    for (const f of [
      'server/src/intake/schemas.ts',
      'server/src/domain/qa.ts',
      'server/src/domain/handbook.ts',
      'server/src/handbook/schemas.ts',
    ]) {
      expect(seen).toContain(f);
    }
    expect(seen).not.toContain('server/src/handbook/routes.ts');
    const keys = Object.keys(api);
    expect(keys).not.toContain('handbookSections');
    expect(keys).not.toContain('handbookBody');
  });

  it('AT-27: temporary fixtures that import node, express, mongoose, use process or import() are reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walker-'));
    mkdirSync(dir, { recursive: true });
    const fixtures: [string, string, string][] = [
      [
        'node.ts',
        `import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n`,
        'node:fs',
      ],
      ['express.ts', `import express from 'express';\nexport const b = express;\n`, 'express'],
      ['mongoose.ts', `import mongoose from 'mongoose';\nexport const c = mongoose;\n`, 'mongoose'],
      ['proc.ts', `export const d = process.env.X;\n`, 'process'],
      ['dyn.ts', `export const e = () => import('./x.js');\n`, 'import('],
    ];
    for (const [name, body, expected] of fixtures) {
      const file = join(dir, name);
      writeFileSync(file, body);
      const { violations } = walkImports(file);
      expect(violations.length, name).toBeGreaterThan(0);
      expect(
        violations.some((v) => v.includes(expected)),
        name,
      ).toBe(true);
    }
  });

  it('AT-27: type-only imports and zod are not violations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walker-'));
    const file = join(dir, 'types.ts');
    writeFileSync(
      file,
      `import type { X } from 'express';\nimport { type Y } from 'mongoose';\nimport { z } from 'zod';\nexport type { X };\nexport const s = z.string();\nexport type T = Y;\n`,
    );
    expect(walkImports(file).violations).toEqual([]);
  });
});

// specs/audit-view.md AT-27 (rule 26): three more re-exports, the identical server objects.
describe('audit-view facade (specs/audit-view.md rule 26)', () => {
  it('AT-27: the three audit-view schemas are the identical server objects and the list is exact', () => {
    expect(Object.keys(api).sort()).toEqual(EXPECTED_KEYS);
    expect(api.TraceTimelineResponse).toBe(auditView.TraceTimelineResponse);
    expect(api.EvalHistoryResponse).toBe(auditView.EvalHistoryResponse);
    expect(api.BuildNotesResponse).toBe(auditView.BuildNotesResponse);
  });

  it('AT-27: the walker visits server/src/audit-view/schemas.ts and reports no violation', () => {
    const { visited, violations } = walkImports(API_TS);
    expect(violations).toEqual([]);
    const seen = [...visited].map((f) => relative(ROOT, f).split('\\').join('/'));
    expect(seen).toContain('server/src/audit-view/schemas.ts');
    expect(seen).not.toContain('server/src/evals/schemas.ts');
  });
});

// specs/onboarding-ui.md AT-16 (rule 16): the seven onboarding facade names.
describe('onboarding-ui facade (specs/onboarding-ui.md rule 16)', () => {
  it('AT-16: the list is exact and each new name is the identical server object', () => {
    expect(Object.keys(api).sort()).toEqual(EXPECTED_KEYS);
    expect(api.ChecklistView).toBe(onboardingApi.ChecklistView);
    expect(api.CreateOnboardingBody).toBe(onboardingApi.CreateOnboardingBody);
    expect(api.CreateOnboardingResponse).toBe(onboardingApi.CreateOnboardingResponse);
    expect(api.ListOnboardingResponse).toBe(onboardingApi.ListOnboardingResponse);
    expect(api.TaskStatusBody).toBe(onboardingApi.TaskStatusBody);
    expect(api.TemplateId).toBe(domain.TemplateId);
    expect(api.taskStatus).toBe(onboardingDomain.taskStatus);
  });

  it('AT-16: ChecklistSummary, OwnerProgress and ListOnboardingQuery are not exported', () => {
    const facade: Record<string, unknown> = { ...api };
    for (const name of ['ChecklistSummary', 'OwnerProgress', 'ListOnboardingQuery', 'TaskStatus']) {
      expect(name in facade, name).toBe(false);
    }
  });

  it('AT-16: the walker visits the four rule 16 modules and reports no violation', () => {
    const { visited, violations } = walkImports(API_TS);
    expect(violations).toEqual([]);
    const seen = [...visited].map((f) => relative(ROOT, f).split('\\').join('/'));
    for (const f of [
      'server/src/onboarding/schemas.ts',
      'server/src/domain/onboarding.ts',
      'server/src/agents/onboarding/schemas.ts',
      'server/src/agents/orchestrator/schemas.ts',
    ]) {
      expect(seen).toContain(f);
    }
  });
});
