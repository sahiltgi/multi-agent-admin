// GET /handbook/sections/:id (spec employee-chat, rule 14; OQ-2 answer (a)). Read-only, any
// authenticated role. It serves the handbook body loaded at boot, the same text the Q&A gate checks
// citations against, and does no file read, store write, model call or audit event per request.
import { handbookSections } from '../domain/handbook.js';
import { HttpError } from '../http/errors.js';
import { EmptyBody } from '../http/approvals/schemas.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { HandbookSectionParams, HandbookSectionQuery, HandbookSectionResponse } from './schemas.js';

export interface HandbookRouteDeps {
  handbook: { body: string };
}

export function createHandbookRoutes(deps: HandbookRouteDeps): RouteDefinition[] {
  const { body } = deps.handbook;
  const texts = new Map(handbookSections(body).map((s) => [s.id, body.slice(s.start, s.end)]));

  const section = defineRoute({
    method: 'get',
    path: '/handbook/sections/:id',
    params: HandbookSectionParams,
    query: HandbookSectionQuery,
    body: EmptyBody,
    response: HandbookSectionResponse,
    handler: ({ params }) => {
      const text = texts.get(params.id);
      if (text === undefined) return Promise.reject(new HttpError('not_found'));
      return Promise.resolve({ id: params.id, text });
    },
  });

  return [section];
}
