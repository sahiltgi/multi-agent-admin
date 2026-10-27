// Spec e2e-demo, rules 2 and 3 (AT-1 to AT-8). Replay model: key normalisation, lookup, no network.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, ModelResponse } from '../agents/schemas.js';
import { Recording, ReplayMissError, createReplayModel, replayKey } from './replay-model.js';

const OPTS = (signal: AbortSignal = new AbortController().signal) => ({ signal, timeout: 1000 });

function makeRequest(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'model-a',
    system: 'You are a test agent.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Leave from 2026-11-23 please' }] }],
    max_tokens: 100,
    output_config: { effort: 'low' },
    ...over,
  };
}

function withIds(uuid: string, iso: string): ModelRequest {
  return makeRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: `Sent at ${iso}` }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `request ${uuid}` }],
      },
    ],
  });
}

const RESPONSE: ModelResponse = {
  content: [{ type: 'text', text: 'synthetic answer' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 4 },
};

function recordingFor(req: ModelRequest, key = replayKey(req)): Record<string, unknown> {
  return {
    key,
    agentHint: { model: req.model, systemSha256: 'a'.repeat(64) },
    response: RESPONSE,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-replay-'));
  vi.stubGlobal('fetch', () => {
    throw new Error('network is forbidden in replay tests');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('replayKey', () => {
  it('AT-1: requests differing only in a UUID and an ISO datetime share one sha256 key', () => {
    const a = replayKey(
      withIds('3f2b8c1e-1111-4222-8333-444455556666', '2026-11-09T09:00:01.250Z'),
    );
    const b = replayKey(
      withIds('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '2026-11-09T09:07:44+00:00'),
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('AT-2: a plain date, the model or the system prompt changes the key', () => {
    const text = (d: string) =>
      makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: d }] }] });
    expect(replayKey(text('2026-11-23'))).not.toBe(replayKey(text('2026-11-24')));
    expect(replayKey(makeRequest({ model: 'model-b' }))).not.toBe(replayKey(makeRequest()));
    expect(replayKey(makeRequest({ system: 'Other system.' }))).not.toBe(replayKey(makeRequest()));
  });

  it('AT-3: key order does not matter, the key is stable and the input is not mutated', () => {
    const req = withIds('3f2b8c1e-1111-4222-8333-444455556666', '2026-11-09T09:00:01Z');
    const snapshot = structuredClone(req);
    const reordered = JSON.parse(
      JSON.stringify({
        output_config: req.output_config,
        max_tokens: req.max_tokens,
        messages: req.messages.map((m) => ({ content: m.content, role: m.role })),
        system: req.system,
        model: req.model,
      }),
    ) as ModelRequest;
    expect(replayKey(reordered)).toBe(replayKey(req));
    expect(replayKey(req)).toBe(replayKey(req));
    expect(req).toEqual(snapshot);
  });
});

describe('createReplayModel', () => {
  it('AT-4: returns a fresh copy of the recorded response on every call', async () => {
    const req = makeRequest();
    writeFileSync(join(dir, `${replayKey(req)}.json`), JSON.stringify(recordingFor(req)));
    const model = createReplayModel(dir);
    const first = (await model.create(req, OPTS())) as ModelResponse;
    const second = (await model.create(req, OPTS())) as ModelResponse;
    expect(first).toEqual(RESPONSE);
    expect(second).toEqual(RESPONSE);
    expect(second).not.toBe(first);
    first.content.push({ type: 'text' });
    expect(second).toEqual(RESPONSE);
  });

  it('AT-5: a missing recording rejects with ReplayMissError naming the key, never the request text', async () => {
    const req = makeRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'CANARY-USER-TEXT' }] }],
    });
    const err: unknown = await createReplayModel(dir)
      .create(req, OPTS())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayMissError);
    const message = (err as Error).message;
    expect(message).toContain(replayKey(req));
    expect(message).toContain('run npm run e2e:record');
    expect(message).not.toContain('CANARY-USER-TEXT');
  });

  it('AT-6: a malformed recording rejects with a non-miss error that names the file', async () => {
    const req = makeRequest();
    const key = replayKey(req);
    const file = join(dir, `${key}.json`);
    const noStop = { content: RESPONSE.content, usage: RESPONSE.usage };
    const cases: Record<string, string> = {
      'not JSON': '{{{ nope',
      'extra request key': JSON.stringify({ ...recordingFor(req), request: { model: 'x' } }),
      'response without stop_reason': JSON.stringify({ ...recordingFor(req), response: noStop }),
      'key differs from file name': JSON.stringify(recordingFor(req, 'b'.repeat(64))),
    };
    for (const [label, body] of Object.entries(cases)) {
      writeFileSync(file, body);
      const err: unknown = await createReplayModel(dir)
        .create(req, OPTS())
        .catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(Error);
      expect(err, label).not.toBeInstanceOf(ReplayMissError);
      expect((err as Error).message, label).toContain(key);
    }
  });

  it('AT-7: an already aborted signal rejects and reads no file', async () => {
    const readFile = vi.fn((): Promise<string | null> => Promise.resolve(null));
    const controller = new AbortController();
    controller.abort();
    await expect(
      createReplayModel(dir, { readFile }).create(makeRequest(), OPTS(controller.signal)),
    ).rejects.toBeInstanceOf(Error);
    expect(readFile).toHaveBeenCalledTimes(0);
  });

  it('AT-5: a null from the injected readFile means the file is missing', async () => {
    const readFile = vi.fn((): Promise<string | null> => Promise.resolve(null));
    await expect(
      createReplayModel(dir, { readFile }).create(makeRequest(), OPTS()),
    ).rejects.toBeInstanceOf(ReplayMissError);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

describe('committed recordings', () => {
  it('AT-8: every file in e2e/recordings parses with Recording and is named <key>.json', () => {
    const recordings = fileURLToPath(new URL('../../../e2e/recordings', import.meta.url));
    if (!existsSync(recordings)) return; // a missing directory passes
    for (const name of readdirSync(recordings).filter((n) => n.endsWith('.json'))) {
      const parsed = Recording.parse(JSON.parse(readFileSync(join(recordings, name), 'utf8')));
      expect(name).toBe(`${parsed.key}.json`);
    }
  });
});
