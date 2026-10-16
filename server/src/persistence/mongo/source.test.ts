// AT-2 (specs/mongo-persistence.md, rule 1): the adapter sources stay clock-, random- and env-free.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ADAPTER_DIR = fileURLToPath(new URL('.', import.meta.url));
const HTTP_DIR = fileURLToPath(new URL('../../http/', import.meta.url));

function adapterSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...adapterSources(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('mongo adapter sources', () => {
  it('AT-2: the adapter module exists with its entry point and adapter classes', () => {
    expect(existsSync(ADAPTER_DIR)).toBe(true);
    const files = adapterSources(ADAPTER_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => f.slice(ADAPTER_DIR.length))).toContain('index.ts');
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const name of [
      'MongoEmployeeDirectory',
      'MongoApprovalStore',
      'MongoLeaveRequestStore',
      'MongoAuditStore',
      'MongoIdempotencyStore',
      'MongoLeaveDataPort',
      'connectMongo',
    ]) {
      expect(all, name).toContain(name);
    }
  });

  it('AT-2: no adapter file is under server/src/http/', () => {
    expect(ADAPTER_DIR.startsWith(HTTP_DIR)).toBe(false);
    for (const f of adapterSources(ADAPTER_DIR)) {
      expect(f.startsWith(HTTP_DIR), f).toBe(false);
    }
  });

  it('AT-2: no adapter file reads a clock, randomness or the environment', () => {
    const files = adapterSources(ADAPTER_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, `${f} Date.now`).not.toContain('Date.now');
      expect(text, `${f} new Date()`).not.toMatch(/new\s+Date\(\s*\)/);
      expect(text, `${f} Math.random`).not.toContain('Math.random');
      expect(text, `${f} process.env`).not.toContain('process.env');
    }
  });
});
