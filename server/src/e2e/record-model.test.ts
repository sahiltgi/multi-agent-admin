// Spec e2e-demo, rule 5 (AT-9, AT-10) and rules 2 and 5 together (AT-11). The recorder writes
// { key, agentHint, response } only, never request text.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelClient, ModelRequest, ModelResponse } from '../agents/schemas.js';
import { createRecordingModel } from './record-model.js';
import { createReplayModel, replayKey } from './replay-model.js';

const OPTS = { signal: new AbortController().signal, timeout: 1000 };

const RESPONSE: ModelResponse = {
  content: [{ type: 'text', text: 'synthetic answer' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 4 },
};

function requestWith(text: string, system: string): ModelRequest {
  return {
    model: 'model-a',
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    max_tokens: 100,
    output_config: { effort: 'low' },
  };
}

function fakeInner(result: () => Promise<unknown>): ModelClient & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    create(req) {
      calls.push(req);
      return result();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network is forbidden in recorder tests');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createRecordingModel', () => {
  it('AT-9: returns the inner response by reference and writes only key, agentHint, response', async () => {
    const written: { path: string; text: string }[] = [];
    const writeFile = (path: string, text: string): Promise<void> => {
      written.push({ path, text });
      return Promise.resolve();
    };
    const inner = fakeInner(() => Promise.resolve(RESPONSE));
    const req = requestWith('CANARY-REQUEST-TEXT', 'CANARY-SYSTEM');
    const out = await createRecordingModel(inner, '/rec', { writeFile }).create(req, OPTS);

    expect(out).toBe(RESPONSE);
    expect(inner.calls).toEqual([req]);
    expect(written).toHaveLength(1);
    const first = written[0];
    expect(first?.path).toContain(`${replayKey(req)}.json`);
    const file = JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(['agentHint', 'key', 'response']);
    expect(file.key).toBe(replayKey(req));
    const hint = file.agentHint as { model: string; systemSha256: string };
    expect(hint.model).toBe('model-a');
    expect(hint.systemSha256).toBe(createHash('sha256').update('CANARY-SYSTEM').digest('hex'));
    expect(first?.text).not.toContain('CANARY-REQUEST-TEXT');
    expect(first?.text).not.toContain('CANARY-SYSTEM');
  });

  it('AT-10: an inner error or an invalid response writes nothing and passes through unchanged', async () => {
    const writeFile = vi.fn((): Promise<void> => Promise.resolve());
    const boom = new Error('synthetic model failure');
    const failing = fakeInner(() => Promise.reject(boom));
    await expect(
      createRecordingModel(failing, '/rec', { writeFile }).create(requestWith('t', 's'), OPTS),
    ).rejects.toBe(boom);

    const bad = { content: 'x' };
    const invalid = fakeInner(() => Promise.resolve(bad));
    const out = await createRecordingModel(invalid, '/rec', { writeFile }).create(
      requestWith('t', 's'),
      OPTS,
    );
    expect(out).toBe(bad);
    expect(writeFile).toHaveBeenCalledTimes(0);
  });

  it('AT-11: a recording made for R is replayed for R with fresh UUIDs and datetimes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-record-'));
    const make = (uuid: string, iso: string): ModelRequest =>
      requestWith(`case ${uuid} sent ${iso} for 2026-11-23`, 'Agent system prompt.');
    const recorded = make('3f2b8c1e-1111-4222-8333-444455556666', '2026-11-09T09:00:01.250Z');
    const inner = fakeInner(() => Promise.resolve(RESPONSE));
    await createRecordingModel(inner, dir).create(recorded, OPTS);
    expect(readdirSync(dir)).toEqual([`${replayKey(recorded)}.json`]);

    const replayed = make('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '2026-11-09T09:30:59.900Z');
    const out = await createReplayModel(dir).create(replayed, OPTS);
    expect(out).toEqual(RESPONSE);
  });
});
