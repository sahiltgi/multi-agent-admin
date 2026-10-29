// Spec gemini-fallback: AT-8 for the onboarding notes run (rule 8): the request and the recorded
// model are the model actually called. Fake client with a literal resolveModel; fetch throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditSink } from '../audit.js';
import { ToolRegistry } from '../registry.js';
import type { ModelClient } from '../schemas.js';
import { runOnboardingNotesAgent } from './notes.js';
import { buildOnboardingTools, type OnboardingAgentDeps } from './tools.js';

const TASKS = [
  {
    id: 'task-1',
    title: 'Set up laptop',
    owner: 'it',
    source: 'template',
    dueOffsetDays: 0,
    dueDate: '2027-01-11',
    dependsOn: [],
    done: false,
  },
];

async function run(withResolve: boolean) {
  const models: unknown[] = [];
  const model: ModelClient = {
    create: (req) => {
      models.push(req.model);
      return Promise.resolve({
        content: [{ type: 'text', text: 'Which tasks should change?' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    },
    ...(withResolve
      ? {
          resolveModel: (id: string) =>
            id === 'claude-sonnet-5-5' || id === 'claude-haiku-5-5'
              ? 'gemini-3.5-flash-lite'
              : 'unmapped',
        }
      : {}),
  };
  const sink = new InMemoryAuditSink();
  let n = 0;
  const registry = new ToolRegistry();
  for (const t of buildOnboardingTools({
    toolDescriptions: {
      get_template: 'Synthetic get_template description.',
      create_checklist: 'Synthetic create_checklist description.',
      propose_deviation: 'Synthetic propose_deviation description.',
    },
  } as unknown as OnboardingAgentDeps)) {
    // Only toolDescriptions is read while building; no handler runs in these tests.
    if (t.name !== 'create_checklist') registry.register(t);
  }
  const deps = {
    runtime: {
      model,
      registry,
      prompts: { load: () => Promise.resolve({ found: true as const, text: 'NOTES data only.' }) },
      audit: sink,
      clock: { nowMs: () => 0, nowIso: () => '2026-10-28T10:00:00.000Z' },
      scheduler: { setTimeout: () => () => undefined },
      idGen: () => `evt-${String((n += 1))}`,
      detectInjection: () => ({ flagged: false }),
    },
    texts: { load: () => Promise.resolve({ found: true as const, text: 'No changes needed.' }) },
  } as unknown as OnboardingAgentDeps;
  await runOnboardingNotesAgent(
    {
      requestId: 'req-1',
      actor: { employeeId: 'emp-001', role: 'hr_admin' },
      templateId: 'engineer',
      notes: 'Please add a security briefing.',
    },
    TASKS,
    deps,
  );
  const payloads = sink.events.map((e) => e.payload);
  return { models, payloads };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('fetch must not be called');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AT-8: the onboarding notes run records the model actually called', () => {
  it('AT-8: with resolveModel the request and every recorded model carry the Gemini id', async () => {
    const { models, payloads } = await run(true);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(m).toBe('gemini-3.5-flash-lite');
    const withModel = payloads.filter((p) => p.model !== undefined);
    expect(withModel.some((p) => p.kind === 'onboarding_notes_outcome')).toBe(true);
    for (const p of withModel) expect(p.model).toBe('gemini-3.5-flash-lite');
  });

  it('AT-8: without resolveModel the config id is recorded', async () => {
    const { models, payloads } = await run(false);
    for (const m of models) expect(m).toBe('claude-sonnet-5-5');
    const outcome = payloads.find((p) => p.kind === 'onboarding_notes_outcome');
    expect(outcome?.model).toBe('claude-sonnet-5-5');
  });
});
