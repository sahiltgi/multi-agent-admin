# HR & Admin Agents

A gated multi-agent HR system for leave, policy Q&A and onboarding. Agents do the work, a deterministic Policy Gate produces every verdict, and humans decide.

## Clone to green

Prerequisites:

- Node 24.21: run `nvm use`.
- Docker.
- Run `cp .env.example .env`, then set `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD`.

Then:

```sh
npm ci
docker compose up -d
npm test
```

## Where to find what

| What                               | Where                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| What we're building and why        | [docs/brief.md](docs/brief.md)                                       |
| Components, flow, trust boundary   | [docs/architecture.md](docs/architecture.md)                         |
| Decisions                          | [docs/adr/](docs/adr/)                                               |
| Rules for AI coding tools          | [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), [.claude/](.claude/) |
| AI tool policy, permissions, hooks | [docs/ai-policy.md](docs/ai-policy.md)                               |
| Dev subagents and workflow         | [docs/dev-agents.md](docs/dev-agents.md)                             |
| MCP servers (inventory, decisions) | [docs/mcp-inventory.md](docs/mcp-inventory.md)                       |
| Feature specs                      | [specs/](specs/)                                                     |
| Setup, branches, commits, PRs      | [CONTRIBUTING.md](CONTRIBUTING.md)                                   |
| All npm commands                   | [CONTRIBUTING.md#commands](CONTRIBUTING.md#commands)                 |
| API server                         | [server/src/](server/src/)                                           |
| React UI                           | [web/src/](web/src/)                                                 |
| Daily AI usage log                 | [AI_LOG.md](AI_LOG.md)                                               |
