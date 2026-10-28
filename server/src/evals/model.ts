// Per-case model watcher (spec eval-runner, rules 3, 15; D-8). The agents fold model failures into
// their own results, so the runner records the first rejection itself and classifies it. It never
// keeps the error message, which can echo request headers. There is no retry.
import { isModelUnavailable } from '../agents/anthropic-client.js';
import type { ModelClient } from '../agents/schemas.js';
import type { ErrorCode } from './schemas.js';

export interface WatchedModel {
  client: ModelClient;
  /** The first rejection's class, or null when every call succeeded. */
  failure: () => ErrorCode | null;
  /** Every tool name offered to the model during the case. */
  toolNames: () => string[];
}

const classify = (err: unknown): ErrorCode =>
  isModelUnavailable(err) ? 'model_unavailable' : 'run_failed';

export function watchModel(inner: ModelClient): WatchedModel {
  let failure: ErrorCode | null = null;
  const tools = new Set<string>();
  const client: ModelClient = {
    async create(req, opts) {
      for (const t of req.tools ?? []) tools.add(t.name);
      try {
        return await inner.create(req, opts);
      } catch (err) {
        failure ??= classify(err);
        throw err;
      }
    },
    // The model actually called is recorded, not the config id (spec gemini-fallback, rule 8).
    ...(inner.resolveModel === undefined ? {} : { resolveModel: inner.resolveModel }),
  };
  return { client, failure: () => failure, toolNames: () => [...tools] };
}
