// isModelUnavailable (spec eval-runner, rule 15): the SDK's connection, timeout and abort errors
// carry no status and a generic name, so they are recognised by class, not by text.
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { isModelUnavailable } from './anthropic-client.js';

describe('isModelUnavailable', () => {
  it.each([
    ['a connection error with no status', new APIConnectionError({ message: 'socket hang up' })],
    ['a connection timeout', new APIConnectionTimeoutError()],
    ['a user abort', new APIUserAbortError()],
    ['a 429 rate limit', new APIError(429, undefined, 'rate limited', undefined)],
    ['a 529 overload', new APIError(529, undefined, 'overloaded', undefined)],
    ['a 500 server error', new APIError(500, undefined, 'server error', undefined)],
    ['a 408 request timeout', new APIError(408, undefined, 'timeout', undefined)],
    ['a plain error carrying status 529', Object.assign(new Error('overloaded'), { status: 529 })],
    ['an AbortSignal abort', new DOMException('aborted', 'AbortError')],
    ['a timeout signal', new DOMException('timed out', 'TimeoutError')],
  ])('is true for %s', (_, err) => {
    expect(isModelUnavailable(err)).toBe(true);
  });

  it.each([
    ['a 400 bad request', new APIError(400, undefined, 'bad', undefined)],
    [
      'a 401 with the key in its message',
      new APIError(401, undefined, 'invalid x-api-key: TEST-k', undefined),
    ],
    ['a 409 conflict', new APIError(409, undefined, 'conflict', undefined)],
    ['a plain error', new Error('fake script exhausted')],
    ['a non-error value', 'boom'],
  ])('is false for %s', (_, err) => {
    expect(isModelUnavailable(err)).toBe(false);
  });
});
