// Spec gemini-fallback: AT-16, AT-17, AT-28, AT-29 (signals, HTTP errors, 15 RPM pacing).
// Fake clock, stubbed fetch and sleep: no network and no real sleeping. Canary key only.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { isModelUnavailable } from './anthropic-client.js';
import { GeminiApiError, GeminiProtocolError, createGeminiClient } from './gemini-client.js';
import type { ModelRequest } from './schemas.js';

const KEY = 'gm-CANARY-0001';
const MODEL = 'gemini-3.5-flash-lite';

type Rec = Record<string, unknown>;
const ok = (): Response =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );

const req = (system = 'PROMPT-V1', over: Rec = {}): ModelRequest => ({
  model: MODEL,
  system,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  max_tokens: 512,
  output_config: { effort: 'low' },
  ...over,
});

interface Seen {
  at: number;
  system: string;
  signal: AbortSignal | undefined;
}

type SleepMode = 'advance' | 'hang';
function make(
  o: {
    fetchImpl?: (init: RequestInit | undefined) => Promise<Response>;
    sleepMode?: SleepMode;
  } = {},
) {
  const state = { now: 0 };
  const seen: Seen[] = [];
  const sleeps: { ms: number; signal: AbortSignal }[] = [];
  const fetchStub = vi.fn((_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { messages: { content: unknown }[] };
    seen.push({
      at: state.now,
      system: String(body.messages[0]?.content),
      signal: init?.signal ?? undefined,
    });
    return o.fetchImpl ? o.fetchImpl(init) : Promise.resolve(ok());
  });
  const sleep = vi.fn((ms: number, signal: AbortSignal) => {
    sleeps.push({ ms, signal });
    if (o.sleepMode === 'hang') {
      return new Promise<void>((_res, rej) => {
        signal.addEventListener('abort', () => {
          rej(new Error('aborted'));
        });
      });
    }
    state.now += ms;
    return Promise.resolve();
  });
  const make1 = () =>
    createGeminiClient(
      { GEMINI_API_KEY: KEY },
      { fetch: fetchStub as unknown as typeof fetch, nowMs: () => state.now, sleep },
    );
  return { client: make1(), make1, state, seen, sleeps, fetchStub, sleep };
}

const opts = (signal = new AbortController().signal, timeout = 30_000) => ({ signal, timeout });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

function expectApiError(err: unknown, status: number | null, unavailable: boolean): void {
  expect(err).toBeInstanceOf(GeminiApiError);
  expect((err as GeminiApiError).status).toBe(status);
  expect((err as GeminiApiError).unavailable).toBe(unavailable);
  // AT-23: the key never reaches an error.
  for (const text of [(err as Error).message, String(err), JSON.stringify(err)]) {
    expect(text).not.toContain(KEY);
  }
}

const hangUntilAbort = (init: RequestInit | undefined): Promise<Response> =>
  new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => {
      rej(new DOMException('aborted', 'AbortError'));
    });
  });

// AT-23: no console call ever carries the key.
let logSpies: MockInstance[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('global fetch must not be called');
    }),
  );
  logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  for (const spy of logSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AT-16: signal and timeout', () => {
  it('AT-16: an already aborted signal rejects unavailable, takes no slot, calls nothing', async () => {
    const m = make();
    const c = new AbortController();
    c.abort();
    const err = await rejection(m.client.create(req(), opts(c.signal)));
    expectApiError(err, null, true);
    expect(isModelUnavailable(err)).toBe(true);
    expect(m.sleep).not.toHaveBeenCalled();
    expect(m.fetchStub).not.toHaveBeenCalled();
    await m.client.create(req(), opts());
    expect(m.sleep).not.toHaveBeenCalled();
    expect(m.fetchStub).toHaveBeenCalledTimes(1);
  });

  it('AT-16: an abort mid-call rejects unavailable and the fetch signal is aborted', async () => {
    const m = make({ fetchImpl: hangUntilAbort });
    const c = new AbortController();
    const p = rejection(m.client.create(req(), opts(c.signal)));
    await vi.waitFor(() => {
      expect(m.fetchStub).toHaveBeenCalledTimes(1);
    });
    c.abort();
    expectApiError(await p, null, true);
    expect(m.seen[0]?.signal?.aborted).toBe(true);
  });

  it('AT-16: opts.timeout of 5 ms rejects unavailable and aborts the fetch signal', async () => {
    const m = make({ fetchImpl: hangUntilAbort });
    const err = await rejection(m.client.create(req(), opts(undefined, 5)));
    expectApiError(err, null, true);
    expect(isModelUnavailable(err)).toBe(true);
    expect(m.seen[0]?.signal?.aborted).toBe(true);
  });
});

describe('AT-17: HTTP and network errors', () => {
  it.each([408, 429, 500, 503])('AT-17: status %i is unavailable, not retried', async (status) => {
    const m = make({ fetchImpl: () => Promise.resolve(new Response('{}', { status })) });
    const err = await rejection(m.client.create(req(), opts()));
    expectApiError(err, status, true);
    expect(isModelUnavailable(err)).toBe(true);
    expect(m.fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404])('AT-17: status %i is not unavailable', async (status) => {
    const m = make({ fetchImpl: () => Promise.resolve(new Response('{}', { status })) });
    const err = await rejection(m.client.create(req(), opts()));
    expectApiError(err, status, false);
    expect(isModelUnavailable(err)).toBe(false);
  });

  it('AT-17: a fetch rejection is unavailable with a null status and no cause kept', async () => {
    const m = make({ fetchImpl: () => Promise.reject(new TypeError('fetch failed')) });
    const err = await rejection(m.client.create(req(), opts()));
    expectApiError(err, null, true);
    expect(isModelUnavailable(err)).toBe(true);
    expect((err as Error).cause).toBeUndefined();
  });

  it('AT-17: a 400 body echoing the key and an email never reaches the error', async () => {
    const body = '{"error":{"message":"echo gm-CANARY-0001 alex.doe@corp.example"}}';
    const m = make({ fetchImpl: () => Promise.resolve(new Response(body, { status: 400 })) });
    const err = await rejection(m.client.create(req(), opts()));
    expectApiError(err, 400, false);
    for (const text of [
      (err as Error).message,
      String(err),
      JSON.stringify(err),
      String((err as Error).stack),
    ]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('alex.doe@corp.example');
    }
    expect((err as Error).message).toContain('gemini request failed');
    expect((err as Error).message).toContain('400');
  });
});

describe('AT-28: pacing', () => {
  it('AT-28: first call goes at once; later calls wait for a 4000 ms gap; the exact gap does not wait', async () => {
    const m = make();
    await m.client.create(req('A'), opts());
    expect(m.sleep).not.toHaveBeenCalled();
    expect(m.seen[0]?.at).toBe(0);

    m.state.now = 1000;
    await m.client.create(req('B'), opts());
    expect(m.sleeps).toHaveLength(1);
    expect(m.sleeps[0]?.ms).toBe(3000);
    expect(m.seen[1]?.at).toBe(4000);
    expect(m.seen[1]?.signal).toBe(m.sleeps[0]?.signal);

    m.state.now = 10_000;
    await m.client.create(req('C'), opts());
    expect(m.sleeps).toHaveLength(1);
    m.state.now = 14_000; // exactly lastStart + 4000
    await m.client.create(req('D'), opts());
    expect(m.sleeps).toHaveLength(1);
    m.state.now = 17_999; // 3999 ms after the last start
    await m.client.create(req('E'), opts());
    expect(m.sleeps.map((s) => s.ms)).toEqual([3000, 1]);
  });

  it('AT-28: three calls started together get slots in call order', async () => {
    const m = make();
    m.state.now = 20_000;
    const all = [
      m.client.create(req('first'), opts()),
      m.client.create(req('second'), opts()),
      m.client.create(req('third'), opts()),
    ];
    await Promise.all(all);
    expect(m.sleeps.map((s) => s.ms)).toEqual([4000, 8000]);
    expect(m.seen.map((s) => s.system)).toEqual(['first', 'second', 'third']);
  });

  it('AT-28: a request rejected for unsupported_block takes no slot', async () => {
    const m = make();
    await m.client.create(req('one'), opts());
    const bad = req('bad', { messages: [{ role: 'user', content: [{ type: 'mystery' }] }] });
    const err = await rejection(m.client.create(bad, opts()));
    expect(err).toBeInstanceOf(GeminiProtocolError);
    expect((err as GeminiProtocolError).code).toBe('unsupported_block');
    await m.client.create(req('two'), opts());
    expect(m.sleeps.map((s) => s.ms)).toEqual([4000]);
  });
});

describe('AT-29: abort during the pacing wait', () => {
  it('AT-29: an abort in the wait rejects unavailable with no fetch, and the slot is not released', async () => {
    const m = make({ sleepMode: 'hang' });
    await m.client.create(req('prev'), opts()); // starts at t=0, no sleep
    m.state.now = 1000;
    const c = new AbortController();
    const p = rejection(m.client.create(req('aborted'), opts(c.signal)));
    await vi.waitFor(() => {
      expect(m.sleeps).toHaveLength(1);
    });
    expect(m.sleeps[0]?.ms).toBe(3000);
    c.abort();
    const err = await p;
    expectApiError(err, null, true);
    expect(isModelUnavailable(err)).toBe(true);
    expect(m.fetchStub).toHaveBeenCalledTimes(1);

    m.state.now = 1500;
    const c2 = new AbortController();
    const p2 = rejection(m.client.create(req('next'), opts(c2.signal)));
    await vi.waitFor(() => {
      expect(m.sleeps).toHaveLength(2);
    });
    expect(m.sleeps[1]?.ms).toBe(6500);
    c2.abort();
    await p2;
  });

  it('AT-29: a timeout of 5 ms during the wait rejects unavailable with no fetch', async () => {
    const m = make({ sleepMode: 'hang' });
    await m.client.create(req('prev'), opts());
    m.state.now = 1000;
    const err = await rejection(m.client.create(req('slow'), opts(undefined, 5)));
    expectApiError(err, null, true);
    expect(isModelUnavailable(err)).toBe(true);
    expect(m.fetchStub).toHaveBeenCalledTimes(1);
  });
});
