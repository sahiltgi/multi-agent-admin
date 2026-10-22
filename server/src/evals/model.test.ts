// watchModel (spec eval-runner, rules 3, 15): records the first rejection as an error code only,
// passes every call through, and remembers the tool names offered to the model.
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { ModelClient, ModelRequest } from '../agents/schemas.js';
import { watchModel } from './model.js';

const REQ = {
  model: 'claude-test',
  max_tokens: 10,
  system: 'synthetic',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'submit_to_gate', description: 'x', input_schema: { type: 'object' } }],
} as unknown as ModelRequest;
const OPTS = { signal: new AbortController().signal, timeout: 1000 };

const failing = (err: Error): ModelClient => ({ create: () => Promise.reject(err) });

describe('watchModel', () => {
  it('classifies a status-less SDK timeout as model_unavailable', async () => {
    const w = watchModel(failing(new APIConnectionTimeoutError()));
    await expect(w.client.create(REQ, OPTS)).rejects.toBeInstanceOf(Error);
    expect(w.failure()).toBe('model_unavailable');
  });

  it('classifies any other rejection as run_failed and keeps no message', async () => {
    const w = watchModel(failing(new Error('401 invalid x-api-key: TEST-canary-0002')));
    await expect(w.client.create(REQ, OPTS)).rejects.toThrow();
    expect(w.failure()).toBe('run_failed');
    expect(JSON.stringify(w.failure())).not.toContain('TEST-canary');
  });

  it('keeps the first failure and records offered tool names', async () => {
    let n = 0;
    const inner: ModelClient = {
      create: () => {
        n += 1;
        return n === 1
          ? Promise.reject(Object.assign(new Error('overloaded'), { status: 529 }))
          : Promise.reject(new Error('later'));
      },
    };
    const w = watchModel(inner);
    await w.client.create(REQ, OPTS).catch(() => undefined);
    await w.client.create(REQ, OPTS).catch(() => undefined);
    expect(w.failure()).toBe('model_unavailable');
    expect(w.toolNames()).toEqual(['submit_to_gate']);
  });

  it('passes successful responses through with no failure', async () => {
    const w = watchModel({ create: () => Promise.resolve({ ok: true }) });
    await expect(w.client.create(REQ, OPTS)).resolves.toEqual({ ok: true });
    expect(w.failure()).toBeNull();
  });
});
