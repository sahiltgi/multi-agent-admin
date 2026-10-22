// Reads the four case files and thresholds.yaml (spec eval-runner, rules 2, 4). Every failure is a
// SetupError whose message names only the file and line number, never line text or Zod issues.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LeaveEvalCase } from '../agents/leave/schemas.js';
import { OnboardingEvalCase } from '../agents/onboarding/schemas.js';
import { OrchestratorEvalCase } from '../agents/orchestrator/schemas.js';
import { QaEvalCase } from '../agents/policy_qa/schemas.js';
import type { Role } from '../domain/schemas.js';
import { CASE_SOURCES, Thresholds, type EvalAgent, type EvalCategory } from './schemas.js';

/** A setup failure: the run exits 2 and writes no results. The message is safe to print. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

interface CaseCommon {
  id: string;
  category: EvalCategory;
  actor: { employeeId: string; role: Role };
  userText: string;
  tags: string[];
  reviewed: boolean | null;
  asOf: string | null;
  instrumented: boolean;
  endpoint: 'messages' | 'chat' | 'approvals' | 'onboarding' | null;
}

export type LoadedCase =
  | (CaseCommon & { agent: 'orchestrator'; expected: OrchestratorEvalCase['expected'] })
  | (CaseCommon & { agent: 'leave'; expected: LeaveEvalCase['expected'] })
  | (CaseCommon & { agent: 'policy_qa'; expected: QaEvalCase['expected'] })
  | (CaseCommon & {
      agent: 'onboarding';
      expected: Record<string, unknown>;
      /** Keys as written; z.record drops `__proto__`, so they come from the raw line. */
      expectedKeys: string[];
    });

export interface LoadedThresholds {
  thresholds: Thresholds;
  hash: string; // SHA-256 of the file bytes
}

export function readThresholds(evalsDir: string): LoadedThresholds {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(evalsDir, 'thresholds.yaml'));
  } catch {
    throw new SetupError('evals/thresholds.yaml is missing.');
  }
  let raw: unknown;
  try {
    raw = parseYaml(bytes.toString('utf8'));
  } catch {
    throw new SetupError('evals/thresholds.yaml is not valid YAML.');
  }
  const parsed = Thresholds.safeParse(raw);
  if (!parsed.success) {
    throw new SetupError('evals/thresholds.yaml does not match the thresholds schema.');
  }
  return { thresholds: parsed.data, hash: createHash('sha256').update(bytes).digest('hex') };
}

function rawKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const expected = (raw as { expected?: unknown }).expected;
  return typeof expected === 'object' && expected !== null ? Object.keys(expected) : [];
}

/** The case on this line, or null when it fails its agent's schema. */
function parseCase(agent: EvalAgent, raw: unknown): LoadedCase | null {
  const common = (c: {
    id: string;
    category: EvalCategory;
    actor: { employeeId: string; role: Role };
    userText: string;
    tags: string[];
    reviewed?: boolean | undefined;
  }) => ({
    id: c.id,
    category: c.category,
    actor: c.actor,
    userText: c.userText,
    tags: c.tags,
    reviewed: c.reviewed ?? null,
    instrumented: c.tags.includes('instrumented'),
  });
  switch (agent) {
    case 'orchestrator': {
      const p = OrchestratorEvalCase.safeParse(raw);
      if (!p.success) return null;
      return { ...common(p.data), agent, asOf: null, endpoint: null, expected: p.data.expected };
    }
    case 'leave': {
      const p = LeaveEvalCase.safeParse(raw);
      if (!p.success) return null;
      return {
        ...common(p.data),
        agent,
        asOf: p.data.asOf ?? null,
        endpoint: null,
        expected: p.data.expected,
      };
    }
    case 'policy_qa': {
      const p = QaEvalCase.safeParse(raw);
      if (!p.success) return null;
      const base = common(p.data);
      return {
        ...base,
        agent,
        asOf: null,
        endpoint: p.data.endpoint,
        instrumented: base.instrumented || p.data.instrumented !== undefined,
        expected: p.data.expected,
      };
    }
    case 'onboarding': {
      const p = OnboardingEvalCase.safeParse(raw);
      if (!p.success) return null;
      return {
        ...common(p.data),
        agent,
        asOf: p.data.asOf ?? null,
        endpoint: p.data.endpoint,
        expected: p.data.expected,
        expectedKeys: rawKeys(raw),
      };
    }
  }
}

/** Every case of the four files, in CASE_SOURCES order then file order. */
export function readCases(evalsDir: string): LoadedCase[] {
  const out: LoadedCase[] = [];
  for (const source of CASE_SOURCES) {
    const name = `evals/${source.file}`;
    let text: string;
    try {
      text = readFileSync(join(evalsDir, source.file), 'utf8');
    } catch {
      throw new SetupError(`${name} is missing.`);
    }
    const seen = new Set<string>();
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (line.trim() === '') continue;
      const lineNo = String(i + 1);
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new SetupError(`${name} line ${lineNo} is not valid JSON.`);
      }
      const parsed = parseCase(source.agent, raw);
      if (parsed === null) {
        throw new SetupError(`${name} line ${lineNo} does not match its eval case schema.`);
      }
      if (seen.has(parsed.id)) {
        throw new SetupError(`${name} line ${lineNo} repeats an id used on an earlier line.`);
      }
      seen.add(parsed.id);
      out.push(parsed);
    }
    if (seen.size === 0) throw new SetupError(`${name} is empty.`);
  }
  return out;
}
