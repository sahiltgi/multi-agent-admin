# Seed data

This folder is **synthetic only**. Every name, email address, id and company name here is fictional and must stay that way. Never add real people, real email addresses or real HR records (AGENTS.md, spec [domain-schemas](../../../specs/domain-schemas.md) rule 17).

- `fixtures.ts`: deterministic fixture data (no randomness, no clock, no faker).
- `invariants.ts`: checks the fixtures against the seed rules before anything is written.
- `seed.ts`: validates the env and every fixture, then replaces the seeded collections.
- `cli.ts`: entry point for `npm run seed`, which reads `MONGODB_URI` from `.env`.

Run `npm run seed` with the compose MongoDB up. It deletes and reinserts teams, employees, leave balances, holidays and leave requests, and refuses to run when `NODE_ENV=production`.
