# MCP inventory

Every MCP server we've considered for this repo, and our decision on each. [ai-policy.md](ai-policy.md#policy) requires an entry here before any server goes into `.mcp.json`.

## Policy

- **CLI first.** Use `gh`, `mongosh` and `docker`. They already run under the Bash permission rules and hooks in `.claude/settings.json`. Add an MCP server only when the CLI can't do the job safely.
- **Before a server is adopted:**
  - the owner approves it, and it has a row here
  - its version is pinned
  - credentials come from env vars only, never written into `.mcp.json`
  - scopes are read-only wherever possible
- **Two settings stay as they are:** `.mcp.json` is under CODEOWNERS, and `enableAllProjectMcpServers` stays `false`.
- **Owner:** @sahiltgi. **Backup:** TBD (same as ai-policy). **Next review:** 2026-11-01.
- **Current state:** no servers adopted, and `.mcp.json` doesn't exist.

## How approval works in Claude Code

- **Server approval.** `enableAllProjectMcpServers: false` means each contributor approves every `.mcp.json` server separately. Nothing starts on its own.
- **Tool calls.** `.claude/settings.json` has no `mcp__*` allow rules, so every MCP tool call prompts.
  - One gap: a personal `.claude/settings.local.json` could allowlist MCP tools. Don't allowlist write-capable tools there.
- **Hooks and denies don't cover MCP.**
  - `guard-bash` matches only `Bash`, and `guard-files` matches only `Edit|Write|MultiEdit|NotebookEdit`.
  - The `.env` and `secrets/**` deny rules apply to Claude's built-in file tools.
  - So an MCP tool skips all of these checks. Its scopes have to be safe on their own.
- **On adoption, a human edits `.claude/settings.json`** (`guard-files` blocks agents from editing it):
  - add a `deny` rule for each write-capable tool (`mcp__<server>__<tool>`)
  - then check with `/mcp` and one test call that a write tool is denied, or prompts if a deny isn't possible.

## Summary

| Server                         | Purpose                           | Source                                | Pinned version                  | Decision                |
| ------------------------------ | --------------------------------- | ------------------------------------- | ------------------------------- | ----------------------- |
| MongoDB MCP (local, stdio)     | Read-only exploration of dev data | Official (`mongodb-js`)               | `mongodb-mcp-server@3.0.5` (\*) | Reject for now          |
| MongoDB MCP (Atlas-hosted)     | Same, through MongoDB's service   | Official (MongoDB Atlas)              | n/a (rejected)                  | Reject                  |
| GitHub MCP                     | Issues, PRs, Actions              | Official (`github/github-mcp-server`) | n/a (rejected)                  | Reject (use `gh`)       |
| Docker MCP                     | Containers, images, volumes       | Official (Docker MCP Toolkit)         | n/a (rejected)                  | Reject (use `docker`)   |
| Filesystem / Git MCP           | File and git access               | Reference (`modelcontextprotocol`)    | n/a (rejected)                  | Reject (built-in tools) |
| Browser automation, Playwright | Drive `web/` in a browser         | Official (`microsoft/playwright-mcp`) | n/a (deferred)                  | Defer                   |

(\*) The version to use if it's ever adopted. It was the latest stable release when checked on 2026-10-12. It's not installed.

Owner for every row: @sahiltgi.

## MongoDB MCP (local, stdio)

- **Purpose:** let an agent list collections, infer schemas and run read queries against the local dev MongoDB (`docker-compose.yml`).
- **Owner:** @sahiltgi.
- **Source:** official, MongoDB's own package. npm: `mongodb-mcp-server`. Repo: `github.com/mongodb-js/mongodb-mcp-server`.
- **Pinned version:** `3.0.5`, released 2026-10-01. `3.1.0-pre.1` is a pre-release, so don't use it.
  - `npx -y mongodb-mcp-server@3.0.5` pins the package and its own `@mongodb-js/mcp-*` packages, which are pinned exactly at `3.0.5`. Third-party and transitive dependencies (for example `@modelcontextprotocol/node@^2`) still float.
  - For a fully pinned install, use the Docker image pinned by digest, or a devDependency recorded in `package-lock.json`.
- **Credentials:** `MDB_MCP_CONNECTION_STRING`, taken from the environment.
  - `.mcp.json` would reference it as `${MDB_MCP_CONNECTION_STRING}`.
  - Claude Code expands that from the shell that launched it. It does not read `.env`, so each developer exports it, for example with direnv.
  - Never use the root URI (`MONGODB_URI` in `.env.example`).
- **Scopes:** read-only in two layers. The database user is the real guarantee, and the server's flags back it up.
  - Use a dedicated MongoDB user with only the `read` role on the `hr` database.
  - `--readOnly` stops the create/update/delete tools from registering.
  - It also rejects aggregation pipelines with `$out` or `$merge` stages. Checked in the v3.0.5 source: `assertSingleMqlValueIsAllowed` in `@mongodb-js/mcp-tools-mongodb`.
  - Without `--readOnly`, those stages are guarded only by an elicitation prompt, and the server skips that prompt when the client doesn't support elicitation. So `--readOnly` must stay on.
  - The `export` tool is a read tool that writes query results to disk (`~/.mongodb/mongodb-mcp/exports`), so it's disabled.
- **Decision:** reject for now.
  - **Why:** CLI first. `docker compose exec mongo mongosh` already covers exploration.
  - **Nothing to explore yet:** `server/src/` has no database code and there's no seeded dev data.
  - **Supply chain:** adopting means a new package whose third-party dependencies float, plus three human-only setup steps (below).
  - **Revisit when:** the first persistence spec lands and synthetic seed data exists.

Config to use if it's adopted. Copy it in only after the human steps below are done:

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "mongodb-mcp-server@3.0.5", "--readOnly"],
      "env": {
        "MDB_MCP_CONNECTION_STRING": "${MDB_MCP_CONNECTION_STRING}",
        "MDB_MCP_TELEMETRY": "disabled",
        "MDB_MCP_DISABLED_TOOLS": "atlas,atlas-local,assistant,connect,export",
        "MDB_MCP_LOGGERS": "mcp,stderr"
      }
    }
  }
}
```

What each setting does:

- `--readOnly`: only read, connect and metadata tools are registered.
- `MDB_MCP_TELEMETRY=disabled`: telemetry is on by default.
- `MDB_MCP_DISABLED_TOOLS`, by entry:
  - `atlas`: the Atlas cloud tools.
  - `atlas-local`: the tools that list and connect to local Atlas deployments.
  - `connect`: stops the agent switching to another connection string.
  - `export`: stops results being written to disk.
  - `assistant`: `search-knowledge` and `list-knowledge-sources`, which call MongoDB's hosted assistant service.
- `MDB_MCP_LOGGERS=mcp,stderr`: keeps logs off disk. The default `disk` logger writes them to `~/.mongodb/mongodb-mcp/.app-logs`.

Human-only steps before adoption:

1. Create the read-only user, either with a `docker-compose.yml` init script or a documented `mongosh` `db.createUser` step. Docker commands and edits to `docker-compose.yml` prompt for approval.
2. Add `MDB_MCP_CONNECTION_STRING=` with a placeholder value to `.env.example`. `guard-files` blocks agents from editing it.
3. Add `deny` rules to `.claude/settings.json` for the MongoDB write tools (`mcp__mongodb__insert-many`, `update-many`, `delete-many`, `drop-*`, `create-*`, `rename-collection`). `--readOnly` already stops them registering, so these rules are a backstop in case someone removes the flag.

Source for flags, tool names and defaults: the `mongodb-mcp-server` v3.0.5 README, `npm view`, and the published 3.0.5 packages (`mcp-core`, `mcp-tools-mongodb`, `mcp-tools-atlas-local`, `mcp-tools-assistant`), checked 2026-10-12.

## MongoDB MCP (Atlas-hosted)

- **Purpose:** the same as above, through MongoDB's hosted MCP endpoint.
- **Owner:** @sahiltgi.
- **Source:** official (MongoDB Atlas).
- **Pinned version:** n/a. It's a hosted service, so we can't pin it.
- **Credentials:** OAuth through the client, or Atlas service-account credentials (`MDB_MCP_API_CLIENT_ID` and `MDB_MCP_API_CLIENT_SECRET`) through the `mongodb-atlas-mcp-remote` stdio bridge.
- **Scopes:** Atlas project scopes.
- **Decision:** reject.
  - Our database is local Docker, not Atlas.
  - A remote service we can't pin would see our dev data.

## GitHub MCP

- **Purpose:** read and manage issues, PRs and Actions.
- **Owner:** @sahiltgi.
- **Source:** official (`github/github-mcp-server`).
- **Pinned version:** n/a (rejected).
- **Credentials:** a GitHub personal access token.
- **Scopes:** if it were adopted, run it with `--read-only` and a narrow `--toolsets` list (for example `repos,issues,pull_requests`), plus a fine-grained token with read-only repository permissions. Both flags are in the server's README.
- **Decision:** reject. Use `gh`.
  - `gh` uses a token with similar scopes, so a token isn't the difference. The difference is that `gh` calls run through Bash, where the permission rules and `guard-bash` see them. MCP calls skip both.
  - Issue and PR text is untrusted input (HARD RULE 3). A server that streams it into context adds risk and gives nothing `gh` doesn't.

## Docker MCP

- **Purpose:** manage containers, images and volumes.
- **Owner:** @sahiltgi.
- **Source:** official (Docker MCP Toolkit / gateway).
- **Pinned version:** n/a (rejected).
- **Credentials:** access to the local Docker socket.
- **Scopes:** in effect the whole host. Docker has no read-only mode.
- **Decision:** reject. Use `docker`.
  - `docker *` and `docker-compose *` already prompt for approval.
  - An MCP server would skip `guard-bash`, which is what stops `dropDatabase` running through `mongosh` inside the container.

## Filesystem / Git MCP

- **Purpose:** read and write files and run git operations.
- **Owner:** @sahiltgi.
- **Source:** reference servers (`modelcontextprotocol/servers`).
- **Pinned version:** n/a (rejected).
- **Credentials:** none. The server runs as the local user.
- **Scopes:** the configured root directories.
- **Decision:** reject.
  - It duplicates the built-in Read, Edit and Bash tools.
  - It would skip the `.env` and `secrets/**` deny rules and both `guard-files` and `guard-bash`.

## Browser automation (Playwright MCP)

- **Purpose:** open the `web/` dev server in a browser to check UI changes.
- **Owner:** @sahiltgi.
- **Source:** official (`microsoft/playwright-mcp`).
- **Pinned version:** n/a (deferred).
- **Credentials:** none for local pages.
- **Scopes:** restrict it to `localhost` origins if it's adopted.
- **Decision:** defer.
  - **Why:** there are no UI specs yet. Page content is untrusted input (HARD RULE 3).
  - **Revisit when:** a UI spec needs end-to-end checks. Compare it with plain Playwright tests run from `npm test` first.

## User-scoped plugins and connectors

Claude Code sessions can also load plugins and MCP connectors set up at the user level, outside this repo. They aren't in `.mcp.json`, but they reach repo sessions, so they're recorded here. Reviewed on 2026-10-28.

| Item                                  | Kind                  | Where it's set                                | Review                                                                                                                                                                | Decision                       |
| ------------------------------------- | --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `code-review@claude-plugins-official` | Plugin                | `enabledPlugins` in `~/.claude/settings.json` | Official marketplace. Cached build `f359d43b4060` holds one command (`commands/code-review.md`), `plugin.json`, README and LICENSE. No hooks, scripts or MCP servers. | Keep. Re-check on each update. |
| claude.ai Google Drive, Google Docs   | Connector (claude.ai) | The owner's claude.ai account                 | Read and write access to the owner's Drive.                                                                                                                           | Not for repo work or HR data.  |
| claude.ai Gmail, Google Calendar      | Connector (claude.ai) | The owner's claude.ai account                 | Need sign-in before use; mail and calendar are personal data.                                                                                                         | Not for repo work or HR data.  |

- The synthetic-data rule in [AGENTS.md](../AGENTS.md#conventions) still applies.
- Connector use is guidance only. Accepted for MVP because enforcing it needs `"disableClaudeAiConnectors": true` in `.claude/settings.json`, which only a human edits; the owner decides whether to add it.

## Adding or changing a server

1. Write a spec or ADR that says why the CLI isn't enough.
2. Add or update the server's section here with all seven fields: purpose, owner, source, pinned version, credentials, scopes and decision.
3. Open a PR that adds the entry to `.mcp.json`:
   - version pinned
   - credentials only as `${ENV_VAR}` references
   - read-only flags set.

   CODEOWNERS sends it to the owner for review.

4. A human adds the `deny` or `ask` rules for write-capable tools to `.claude/settings.json`, and any placeholders to `.env.example`.
5. Verify with `/mcp` that the server loads only after approval and that a write tool is denied or prompts. Record the result in the PR.
