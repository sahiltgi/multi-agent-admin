// Static files for the Onboarding Agent (spec onboarding, rules 11, 15, 27; eval cases EV-1 to
// EV-40). The prompt, tool descriptions and fixed texts are committed; the eval file parses.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadOnboardingPolicy } from '../../policies/load.js';
import { ClarifyingQuestion } from '../orchestrator/schemas.js';
import { OnboardingEvalCase } from './schemas.js';

const root = (rel: string): string => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(root(rel), 'utf8');

describe('onboarding static files', () => {
  it('onboarding evals: cases.jsonl parses as OnboardingEvalCase with ids exactly EV-1 to EV-40', () => {
    const file = root('evals/onboarding/cases.jsonl');
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    const ids = lines.map((line) => OnboardingEvalCase.parse(JSON.parse(line)).id);
    const expected = Array.from({ length: 40 }, (_, i) => `EV-${String(i + 1)}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...expected].sort());
    const text = readFileSync(file, 'utf8');
    for (const id of text.match(/emp-\d+/g) ?? []) expect(id).toMatch(/^emp-\d{3}$/);
    for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? [])
      expect(email).toMatch(/\.(example|test)$/);
  });

  it('onboarding evals: every expected template and template task id exists in the v1 templates', () => {
    const templates = new Map(
      Object.entries(loadOnboardingPolicy(root('policies/onboarding/v1.yaml')).policy.templates),
    );
    const Expected = z.looseObject({
      createChecklist: z.looseObject({ templateId: z.string() }).optional(),
      deviationChanges: z
        .array(z.looseObject({ templateTaskId: z.string().optional() }))
        .optional(),
    });
    const lines = read('evals/onboarding/cases.jsonl')
      .split('\n')
      .filter((l) => l.trim() !== '');
    for (const line of lines) {
      const c = OnboardingEvalCase.parse(JSON.parse(line));
      const e = Expected.parse(c.expected);
      if (e.createChecklist === undefined) continue;
      const template = templates.get(e.createChecklist.templateId);
      expect(template, `${c.id}: ${e.createChecklist.templateId}`).toBeDefined();
      const taskIds = new Set(template?.tasks.map((t) => t.id));
      for (const change of e.deviationChanges ?? []) {
        if (change.templateTaskId !== undefined)
          expect(taskIds.has(change.templateTaskId), `${c.id}: ${change.templateTaskId}`).toBe(
            true,
          );
      }
    }
  });

  it('onboarding-api evals: cases.jsonl parses as OnboardingEvalCase with ids exactly EV-1 to EV-25', () => {
    const file = root('evals/onboarding-api/cases.jsonl');
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    const cases = lines.map((line) => OnboardingEvalCase.parse(JSON.parse(line)));
    const expected = Array.from({ length: 25 }, (_, i) => `EV-${String(i + 1)}`);
    expect(cases.map((c) => c.id)).toEqual(expected);
    expect(cases.every((c) => c.endpoint === 'onboarding')).toBe(true);
    // agents.md: notes-mode behaviour needs extraction and injection cases, not only unit tests.
    for (const category of ['extraction', 'verdict', 'injection'] as const) {
      expect(
        cases.some((c) => c.category === category),
        category,
      ).toBe(true);
    }
    const text = readFileSync(file, 'utf8');
    for (const id of text.match(/emp-\d+/g) ?? []) expect(id).toMatch(/^emp-\d{3}$/);
    for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? [])
      expect(email).toMatch(/\.(example|test)$/);
  });

  it('onboarding-api prompts: notes_context.md gives the model exactly the no_changes sentence the agent checks', () => {
    const sentence = read('prompts/onboarding/messages/no_changes.txt').trim();
    expect(sentence).not.toBe('');
    const lines = read('prompts/onboarding/notes_context.md')
      .split('\n')
      .map((l) => l.trim());
    expect(lines).toContain(sentence);
  });

  it('onboarding prompts: the prompt and tool descriptions are committed and non-blank', () => {
    for (const rel of [
      'prompts/onboarding/v1.md',
      'prompts/onboarding/tools/get_template.md',
      'prompts/onboarding/tools/create_checklist.md',
      'prompts/onboarding/tools/propose_deviation.md',
    ]) {
      expect(read(rel).trim(), rel).not.toBe('');
    }
  });

  it('onboarding texts: the two agent questions are valid clarifying questions', () => {
    for (const key of ['fallback_question', 'start_date_past']) {
      const text = read(`prompts/onboarding/messages/${key}.txt`);
      expect(ClarifyingQuestion.safeParse(text).success, key).toBe(true);
    }
  });

  it('onboarding texts: no fixed reply claims an approval', () => {
    for (const key of ['created', 'pending_manager', 'denied', 'escalated']) {
      const text = read(`prompts/onboarding/messages/${key}.txt`);
      expect(text.trim(), key).not.toBe('');
      expect(text, key).not.toMatch(/\bapproved\b/i);
    }
  });
});
