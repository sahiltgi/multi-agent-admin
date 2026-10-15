// Shape check for evals/agent-runtime/cases.jsonl (spec agent-runtime, "Eval cases").
// The cases are data until the agents and an eval runner exist; this keeps them well-formed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Role } from '../domain/schemas.js';
import { AgentId } from './schemas.js';

const path = fileURLToPath(new URL('../../../evals/agent-runtime/cases.jsonl', import.meta.url));

const RuntimeEvalCase = z
  .object({
    id: z.string().regex(/^rt-\d{3}$/),
    ev: z.string().regex(/^EV-\d+$/), // the spec's eval id
    category: z.enum(['routing', 'extraction', 'verdict', 'citation', 'injection']),
    agent: AgentId,
    actor: z.object({ employeeId: z.string().regex(/^emp-\d{3}$/), role: Role }).strict(),
    userText: z.string().min(1),
    documents: z
      .array(z.object({ docId: z.string().min(1), text: z.string() }).strict())
      .optional(),
    config: z.record(z.string(), z.unknown()).optional(), // AgentConfig overrides, e.g. maxTurns
    env: z.record(z.string(), z.string().startsWith('TEST-')).optional(), // synthetic canaries only
    faults: z.record(z.string(), z.unknown()).optional(), // fault injection for tool handlers
    expected: z.record(z.string(), z.unknown()),
    rules: z.array(z.number().int().min(1).max(22)).min(1),
    tags: z.array(z.string()),
    notes: z.string(),
  })
  .strict();

function cases(): z.infer<typeof RuntimeEvalCase>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => RuntimeEvalCase.parse(JSON.parse(l)));
}

describe('agent-runtime eval cases', () => {
  it('evals: holds EV-1 to EV-17 once each, in order, with matching rt ids', () => {
    const all = cases();
    expect(all.map((c) => c.ev)).toEqual(
      Array.from({ length: 17 }, (_, i) => `EV-${String(i + 1)}`),
    );
    for (const [i, c] of all.entries()) {
      expect(c.id).toBe(`rt-${String(i + 1).padStart(3, '0')}`);
    }
  });

  it('evals: every case is marked blocked until the agents and a runner exist', () => {
    for (const c of cases()) {
      expect(c.tags).toContain('blocked:agent-missing');
      expect(c.tags).toContain('blocked:no-runner');
    }
  });

  it('evals: synthetic data only (example or test email domains)', () => {
    const text = readFileSync(path, 'utf8');
    for (const m of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
      expect(m).toMatch(/\.(example|test)$/);
    }
  });
});
