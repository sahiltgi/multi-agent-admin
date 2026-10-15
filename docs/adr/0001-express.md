# ADR-0001: Express 5 for the API

Status: Accepted · 2026-10-14

## Context

AGENTS.md requires Zod at every HTTP boundary. We want request and response types derived from those schemas, not written twice. The team is small and the time budget is short.

## Decision

Use Express 5 with our own Zod validation middleware. Each route declares Zod schemas for params, query, body and response. The middleware parses the request before the handler runs, and the response is parsed before it is sent. Handler types come from `z.infer` on those schemas.

## Consequences

- Invalid requests are rejected with a 400 before handler code runs. Responses are checked against their schema.
- Express 5 forwards rejected promises from async handlers to the error middleware, so handlers need no try/catch wrappers.
- Separate routers and middleware keep the auth (`x-demo-user` to RBAC), agent and audit modules apart.
- Express does not infer handler types from schemas by itself, so we need a small typed route helper. It is added when the first server spec lands, not before.
