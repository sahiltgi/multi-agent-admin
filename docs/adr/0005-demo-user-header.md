# ADR-0005: `x-demo-user` header as the demo identity

Status: Accepted · 2026-10-15

## Context

The API enforces RBAC on every route (spec approval-queue), so it needs to know who is calling. Real sign-in (SSO, sessions, tokens) is out of scope for the MVP (brief §11). The demo has to switch between an employee, a manager and HR in seconds.

## Decision

This is a deliberate MVP shortcut. The caller names a seeded user in the `x-demo-user` header, for example `x-demo-user: emp-002`.

- **Exact match.** The value must exactly match one seeded employee id: no trimming, no case folding and no repeated header. Anything else gets 401 `unauthenticated` before any store read.
- **Directory only.** The actor's role comes only from the directory record. Role, team or manager claims anywhere else in the request are ignored.
- **Refused in production.** `assertDemoIdentityAllowed(process.env.NODE_ENV)` throws when `NODE_ENV=production`. Whatever starts the HTTP server calls it before `createApp`, matching the seed script's production guard.

## Consequences

- **No authentication.** Anyone who can reach the API can act as any seeded user. Run it only locally or on a private demo host with synthetic data.
- **One place to replace.** Identity is resolved in `server/src/http/identity.ts` and nowhere else, so SSO replaces that module and the routes stay the same.
- **RBAC is exercised for real.** Tests and the demo go through the same RBAC checks a signed-in user would.
