# ADR-0002: MongoDB with Mongoose

Status: Accepted · 2026-10-08

## Context

Most of our data is document-shaped and varies by type: audit traces (nested agent steps and tool calls), onboarding checklists, and leave requests with gate results attached. It has to run locally with one command and synthetic seed data.

## Decision

Use MongoDB 8 via `docker-compose.yml` locally, with Mongoose models in `server/`. Zod stays the boundary check. Mongoose schemas only describe storage.

## Consequences

- A trace or checklist is stored as one document, with no join tables.
- The single-node compose setup has no replica set, so there are no multi-document transactions. Design writes so they don't need them.
- The Policy Gate never touches the database (HARD RULE 4). Callers load data and pass it in.
- Credentials come only from `.env`. Compose refuses to start without them.
