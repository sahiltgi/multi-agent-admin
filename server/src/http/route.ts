// Typed route helper (ADR-0001; spec approval-queue, rule 3). Each route declares strict Zod
// schemas for params, query, body and response. Requests are parsed before the handler runs,
// and the handler's result is parsed before it is sent. Handler types come from the schemas.
import type { z } from 'zod';
import { HttpError, toIssues, type ErrorIssue } from './errors.js';
import type { Actor } from './identity.js';

export interface RouteRequest<P, Q, B> {
  actor: Actor;
  params: P;
  query: Q;
  body: B;
}

export interface RouteSpec<P, Q, B, R> {
  method: 'get' | 'post';
  path: string;
  params: z.ZodType<P>;
  query: z.ZodType<Q>;
  body: z.ZodType<B>;
  response: z.ZodType<R>;
  handler: (req: RouteRequest<P, Q, B>) => Promise<R>;
}

/** What the app mounts: raw request parts in, a response value that passed its schema out. */
export interface RouteDefinition {
  method: 'get' | 'post';
  path: string;
  handle(raw: RouteRequest<unknown, unknown, unknown>): Promise<unknown>;
}

/** Thrown when a handler's result fails its response schema; the client only sees a 500. */
export class ResponseSchemaError extends Error {
  constructor(readonly path: string) {
    super(`response for ${path} failed its schema`);
    this.name = 'ResponseSchemaError';
  }
}

export function defineRoute<P, Q, B, R>(spec: RouteSpec<P, Q, B, R>): RouteDefinition {
  return {
    method: spec.method,
    path: spec.path,
    async handle(raw) {
      const issues: ErrorIssue[] = [];
      const params = spec.params.safeParse(raw.params);
      const query = spec.query.safeParse(raw.query);
      const body = spec.body.safeParse(raw.body);
      for (const [where, result] of [
        ['params', params],
        ['query', query],
        ['body', body],
      ] as const) {
        if (!result.success) {
          for (const issue of toIssues(result.error)) {
            issues.push({ path: [where, ...issue.path], code: issue.code });
          }
        }
      }
      if (!params.success || !query.success || !body.success) {
        throw new HttpError('invalid_request', issues);
      }
      const result = await spec.handler({
        actor: raw.actor,
        params: params.data,
        query: query.data,
        body: body.data,
      });
      const parsed = spec.response.safeParse(result);
      if (!parsed.success) throw new ResponseSchemaError(spec.path);
      return parsed.data;
    },
  };
}
