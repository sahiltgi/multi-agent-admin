// Kept apart from anthropic-client.test.ts: the module mock below would otherwise apply to AT-5/AT-6.
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicClient } from './anthropic-client.js';

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function FakeAnthropic(options: unknown) {
    captured.options.push(options);
    return { messages: { create: vi.fn() } };
  }),
}));

describe('anthropic-client options', () => {
  it('anthropic-client: builds the SDK client with logLevel off and a pinned baseURL, so env vars cannot log bodies or redirect the key', () => {
    createAnthropicClient({ ANTHROPIC_API_KEY: 'TEST-KEY-CANARY-0000' });
    expect(captured.options).toEqual([
      { apiKey: 'TEST-KEY-CANARY-0000', logLevel: 'off', baseURL: 'https://api.anthropic.com' },
    ]);
  });
});
