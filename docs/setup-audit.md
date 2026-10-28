# AI Development Setup Audit

Audited: 2026-10-28 · Commit: bc55b6b (branch chore/setup-audit-fixes, PR #20) · Baseline: 622196e (18/28) · Rubric: [docs/setup-rubric.md](setup-rubric.md) · Auditor: independent read-only subagent

Method notes: I verified every claim with files, local commands or GitHub API GETs. I ran `npm audit` only through the CI log, because it sends a POST. The live `guard-bash` hook blocked one of my commands (see section 5) and I didn't work around it. I disabled the hook logging for my synthetic payloads (`HOOK_BLOCK_LOG=/dev/null`). The one live block did write a line to `.claude/logs/blocked.jsonl` at 2026-10-28T04:34:01Z. I didn't open `.env`.

An important point for every row: the owner-only files didn't change on this branch. This command printed nothing:

```
$ git diff --stat 622196e..HEAD -- .github/workflows .claude/settings.json .claude/hooks .husky
(no output)
```

## Before / after

| Parameter                | Security critical | Before      | After       | Change |
| ------------------------ | ----------------- | ----------- | ----------- | ------ |
| Instructions & Memory    | No                | 2           | 2           | 0      |
| Skills & Commands        | No                | 1           | 2           | +1     |
| Subagents & Roles        | No                | 2           | 2           | 0      |
| MCP Servers & Plugins    | Yes               | 1           | 1           | 0      |
| Guardrails & Hooks       | Yes               | 1           | 1           | 0      |
| Permissions & Secrets    | Yes               | 1           | 1           | 0      |
| Context & Cost           | No                | 1           | 1           | 0      |
| Knowledge Base & Docs    | No                | 2           | 2           | 0      |
| Verification & Testing   | No                | 1           | 1           | 0      |
| Git & Review Workflow    | Yes               | 1           | 1           | 0      |
| CI & Autonomous Runs     | Yes               | 2           | 2           | 0      |
| Governance & Ownership   | No                | 1           | 1           | 0      |
| Observability & Feedback | No                | 1           | 1           | 0      |
| Data & Compliance        | Yes               | 1           | 1           | 0      |
| **Total**                |                   | **18 / 28** | **19 / 28** | **+1** |

## Summary

| Parameter                | Score | Verdict                                                                                                                                                                                                 |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions & Memory    | 2     | 54-line AGENTS.md/CLAUDE.md pair. The `shared/` and worktree gitignore fixes are verified, and the commands run with correct exit codes.                                                                |
| Skills & Commands        | 2     | `/review-pr` added and `run-evals` made manual-only, both verified. Only the (not applicable) migration workflow is missing.                                                                            |
| Subagents & Roles        | 2     | Unchanged: six single-purpose agents with explicit tools, read-only reviewers and word caps. Still no worktree isolation and no path limits on writers.                                                 |
| MCP Servers & Plugins    | 1     | No repo MCP, auto-approve is off, and the plugin is reviewed and inventoried. But the inventory is incomplete (Claude Docs connector, IDE MCP), connectors aren't enforced and the plugin isn't pinned. |
| Guardrails & Hooks       | 1     | Hooks are unchanged and tested (73 pass). Agent config, `.husky/` and CODEOWNERS are still writable, and `HUSKY=0`, `core.hooksPath` and `gh pr merge --admin` pass.                                    |
| Permissions & Secrets    | 1     | Committed policy, bypass disabled, gitleaks history clean. Still no sandbox, egress allowlist, push protection, devcontainer or managed policy.                                                         |
| Context & Cost           | 1     | Session habits are now documented. Context has never been measured, spend alerts are still `TODO(owner)`, and connectors load into every session.                                                       |
| Knowledge Base & Docs    | 2     | Architecture doc, ADRs, clone-to-green and a doc map. New drift: `e2e/recordings/` is described but missing.                                                                                            |
| Verification & Testing   | 1     | `verify` is green on PR #20 (0 vulnerabilities). There are no required checks, no human reviews and no SAST, and e2e isn't in CI.                                                                       |
| Git & Review Workflow    | 1     | Attribution is consistent and CODEOWNERS resolves on the branch only. `master` is unprotected, 0 reviews, PR #20 itself is about 784 lines, and ai-review still fails.                                  |
| CI & Autonomous Runs     | 2     | Unchanged and strong: fork gating, `permissions: {}`, allowlists, `--max-turns 15` and timeouts. The PR-sourced prompt and repo-wide secrets remain.                                                    |
| Governance & Ownership   | 1     | Owner handle fixed. No backup owner, inconsistent backup and review statements, no settings schema check, nothing enforced.                                                                             |
| Observability & Feedback | 1     | Block log and dev-metrics exist. Telemetry is off, there are no cost alerts, and AI_LOG and dev-metrics are already behind HEAD.                                                                        |
| Data & Compliance        | 1     | IP, retention and regulatory scope are now documented. The interactive account and its data terms are unknown, there's no LICENSE, and connectors aren't enforced.                                      |

## 1. Instructions & Memory

**Score: 2 / 2**

**Evidence**

- `CLAUDE.md:1` is `@AGENTS.md`, and `AGENTS.md:3` says it is the "Single source of truth for every AI coding tool". `docs/ai-policy.md:7` names Claude Code as the only tool.
- Size:
  ```
  $ wc -l CLAUDE.md AGENTS.md
    6 CLAUDE.md
   48 AGENTS.md
  ```
- The `shared/` fix (d4f876c) is verified: `AGENTS.md:9` now lists `shared/` (`@hr/shared`).
- The commands in `AGENTS.md:24-25` run with correct exit codes:
  ```
  typecheck rc=0 · lint rc=0 · npm test: 124 files / 1944 tests passed, rc=0 · build rc=0
  npm run test:one -- server/src/nope.test.ts → rc=2
  ```
- Path-scoped rules are in `.claude/rules/{gate,agents,web}.md`.
- Personal and local files are ignored. The worktree fix (2adae0b) is verified:
  ```
  $ git check-ignore -v .claude/worktrees/ .claude/settings.local.json CLAUDE.local.md
  .gitignore:26:.claude/worktrees/	.claude/worktrees/
  .gitignore:13:.claude/settings.local.json	.claude/settings.local.json
  .gitignore:12:CLAUDE.local.md	CLAUDE.local.md
  ```

**Gaps**

- None material in the instruction files. A conflicting statement in `docs/ai-policy.md` is covered under section 12.

## 2. Skills & Commands

**Score: 2 / 2**

**Evidence**

- `.claude/skills/` holds six skills, each under 56 lines. Every one has `name`, a what-plus-when `description` and `argument-hint`, and ends with a "Verify" section.
- `review-pr/SKILL.md` (6cf4fdb) is verified:
  - its tools are read-only (`allowed-tools: Bash(git diff *) … Bash(gh pr diff *)`, `:6`)
  - "It never approves, comments on GitHub or merges" (`:13`)
  - it runs the done-check (`:25`) and has its own verify list (`:28-32`)
- `run-evals` is manual-only (d4f876c):
  ```
  $ git diff 622196e..HEAD -- .claude/skills/run-evals
  +disable-model-invocation: true
  ```
- `open-pr` is manual-only, has narrow `allowed-tools` and creates the PR only after the user says yes (`open-pr/SKILL.md:3-8`).

**Gaps**

- No migration workflow. Accepted for MVP because the project has no schema migrations (MongoDB, Zod at the boundaries)
- The register's claim that `disallowed-tools` is a documented key (`open-pr/SKILL.md:8`) isn't verified. I didn't fetch the external docs.

## 3. Subagents & Roles

**Score: 2 / 2**

**Evidence**

- Six agents in `.claude/agents/`, each with explicit `tools:`, `model:` and `maxTurns:` (frontmatter lines 2-7).
- The reviewers are read-only (`tools: Read, Grep, Glob`): `code-reviewer`, `policy-auditor` and `security-reviewer`.
- Every agent has a return-format cap: `code-reviewer.md:43` and `security-reviewer.md:50` (300 words), `policy-auditor.md:26` (table plus 50 words), and 150 words for each writer.
- The trust rule is in `docs/dev-agents.md:38`: "An agent that reads untrusted content gets only Read, Grep and Glob."

**Gaps**

- No `isolation: worktree` (`grep -rn isolation .claude/agents .claude/skills` found nothing). Accepted for MVP because writer subagents run one at a time in `/new-feature`, and a worktree would hide their output from the next step
- Writer paths are limited by prompt only: `test-writer` has `Write, Edit, Bash`, and `eval-drafter` and `spec-writer` have `Write`. Accepted for MVP because the `agent_type` path hook needs a `.claude/hooks/` change (owner)
- The `fable` alias can't be verified from the repo. Accepted for MVP because Claude Code resolves model aliases at runtime; a wrong alias fails loudly at spawn

## 4. MCP Servers & Plugins

**Score: 1 / 2**

**Evidence**

- No repo or user MCP servers for this project:
  ```
  $ ls .mcp.json
  ls: cannot access '.mcp.json': No such file or directory
  $ node -e '…~/.claude.json…'
  top mcpServers: []
  project mcpServers: [] enabledMcpjson: [] disabled: [] allowedTools: []
  ```
- Bulk auto-approval is off (`.claude/settings.json:53` `"enableAllProjectMcpServers": false`), and settings has no `mcp__*` allow rules.
- The plugin inventory and review (d4f876c) are verified against the cache. The manifest has no `hooks` or `mcpServers`:
  ```
  $ node -e '…~/.claude/settings.json…'   → enabledPlugins: { 'code-review@claude-plugins-official': true }
  $ find ~/.claude/plugins/cache/claude-plugins-official/code-review -type f   → f359d43b4060/{commands/code-review.md, .claude-plugin/plugin.json, README.md, LICENSE}
  $ cat …/f359d43b4060/.claude-plugin/plugin.json
  {"name":"code-review","description":"Automated code review …","author":{"name":"Anthropic",…}}
  ```
- `docs/mcp-inventory.md:168-179` now lists the plugin and the Drive, Docs, Gmail and Calendar connectors. The owner handle is now `@sahiltgi` (`:14`, `:43`).

**Gaps**

- The claude.ai connectors are guidance-only (`mcp-inventory.md:179`). Enforcement accepted for MVP because `disableClaudeAiConnectors` goes in `.claude/settings.json` (owner)
- No MCP deny rules set up in advance. Accepted for MVP because no servers are adopted, and the inventory requires deny rules at adoption
- (new) The inventory is incomplete. This audit session has the write-capable **claude.ai Claude Docs** connector loaded (`create`, `delete`, `update`, `batch`) and the **claude-vscode** IDE MCP (`getDiagnostics`). Neither appears in `mcp-inventory.md:172-176`.
- (new) The plugin isn't version-pinned (`enabledPlugins: …: true`), so the review covers only the cached snapshot `f359d43b4060` ("Re-check on each update" isn't enforced).
- Not verifiable from repo: whether connector write tools prompt in a live session.

## 5. Guardrails & Hooks

**Score: 1 / 2**

**Evidence**

- The hooks are committed in `.claude/settings.json:54-100`:
  - PreToolUse `Bash` → `guard-bash.mjs`
  - PreToolUse `Edit|Write|MultiEdit|NotebookEdit` → `guard-files.mjs`
  - PostToolUse → `post-edit-check.mjs`
  - Stop → `stop-check.mjs`
- `lib.mjs:81-101` writes stderr and exits 2. The guards fail closed on unparseable input (`guard-bash.mjs:100-107`, `guard-files.mjs:50-56`).
- The live hook blocked one of my audit commands, because the text of a test payload contained a force push:
  ```
  PreToolUse:Bash hook error: [node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.mjs"]: Blocked: force push rewrites shared history. Push normally, or ask the user to force push.
  ```
- The hook suite passes:
  ```
  $ npx vitest run --project hooks
   Test Files  4 passed (4)
        Tests  73 passed (73)
  ```
- Synthetic payloads fed to the hooks with logging disabled:
  ```
  exit=0 :: HUSKY=0 git commit -m x
  exit=0 :: git -c core.hooksPath=/dev/null commit -m x
  exit=0 :: git clean -fdx
  exit=0 :: terraform destroy -auto-approve
  exit=0 :: find . -delete
  exit=0 :: gh pr merge 20 --admin
  exit=0 :: Write CLAUDE.md | AGENTS.md | .husky/pre-commit | .github/CODEOWNERS | .claude/agents/code-reviewer.md | .claude/skills/review-pr/SKILL.md | .mcp.json
  exit=2 :: Write .claude/settings.json | .github/workflows/ci.yml
  ```
- The pre-commit hook fails closed without gitleaks (`.husky/pre-commit:4-11`).
- The `ask` list (`settings.json:18-40`) covers commit, push, branch delete or move, npm install and docker.

**Gaps**

- Agent config, `.husky/` and CODEOWNERS are writable by agents (see the output above). Accepted for MVP because extending `guard-files` is a `.claude/hooks/` change (owner); CODEOWNERS now resolves, so changes there are visible in review
  - It resolves only on the branch, not on `master` (see section 10).
- The `HUSKY=0` / `core.hooksPath` bypass. Accepted for MVP because `guard-bash` is owner-edited; the CI gitleaks job and the `git commit` ask rule are the backstop
- `terraform destroy`, `git clean -fdx`, `find -delete` and `bash -c` pass. Accepted for MVP because `guard-bash` is owner-edited; no Terraform exists here, and the rest is documented in `ai-policy.md`
- `guard-files` has 0 real blocks (`grep -c '"hook":"guard-files"' .claude/logs/blocked.jsonl` → `0`). Accepted for MVP because no agent has tried a blocked write; the synthetic tests prove the behaviour
- (new, related to row 10) `gh pr merge --admin` passes `guard-bash`, and no ask or deny rule covers it (`grep 'gh pr merge' .claude/settings.json` → rc=1).

## 6. Permissions & Secrets

**Score: 1 / 2**

**Evidence**

- `cat .claude/settings.json` (lines 41-51):
  ```
  "deny": ["Read(.env)","Read(.env.*)","Read(!.env.example)","Edit(.env)","Edit(.env.*)","Edit(!.env.example)","Read(secrets/**)","Edit(secrets/**)"],
  "disableBypassPermissionsMode": "disable"
  ```
- There's no local settings file, and it would be ignored. `.env` is ignored and has never been committed:
  ```
  $ ls .claude/settings.local.json → No such file or directory
  $ git check-ignore -v .env → .gitignore:8:.env*	.env
  $ git log --all --oneline -- .env | wc -l → 0
  ```
- Secret scans:
  ```
  $ gitleaks git -v --redact
  INF 51 commits scanned.
  INF no leaks found
  $ gitleaks dir -v --redact . | grep -E '^(RuleID|File|Line):'
  RuleID: generic-api-key
  File:   .env
  Line:   9
  ```
  The only finding is in the untracked, gitignored `.env`.

**Gaps**

- The sandbox is off and egress isn't allowlisted: no `sandbox` key in either settings file (`~/.claude/settings.json` keys: `model, enabledPlugins, modelSettings, advisorModel`). Accepted for MVP because `sandbox` goes in `.claude/settings.json` (owner); `ai-policy.md` now states the real state (`d4f876c`)
  - That's confirmed at `ai-policy.md:13`.
- No `.devcontainer/` (`ls .devcontainer` → No such file or directory). Accepted for MVP because one can't be verified on this machine, and the README clone-to-green path was verified
- No push protection (`gh api repos/sahiltgi/multi-agent-admin --jq .security_and_analysis` → `null`). Accepted for MVP because secret scanning push protection isn't available on a private Free repo (owner plan decision); pre-commit and CI gitleaks cover it
- No managed policy (`ls /etc/claude-code` → No such file or directory). Accepted for MVP because this is a solo project with no organization
- `Bash(npm run evals)` is still allow-listed (`settings.json:11`), and the script loads `.env` (`package.json` `evals`). Accepted for MVP because moving it to `ask` is a `.claude/settings.json` change (owner); the skill is now manual-only
- Deny-rule negation (`Read(!.env.example)`) is undocumented syntax. Accepted for MVP because it fails closed and is documented in `ai-policy.md`
- Agent shells carry the sole-admin `gh` token (`gh auth status` → "Logged in to github.com as sahiltgi"). Accepted for MVP because a least-privilege token and `gh pr merge` ask rules are owner changes

## 7. Context & Cost

**Score: 1 / 2**

**Evidence**

- The always-on context is 54 lines. Situational guidance sits in path-scoped rules and skills.
- The new session habits (d4f876c) are verified at `CONTRIBUTING.md:66-71`: `/context` after config changes, `/clear` and `/compact` habits, model per task, and `/cost` into AI_LOG.
- Worktrees are excluded from tooling (`.prettierignore` contains `.claude/worktrees`). `npm run format:check` passes with "All matched files use Prettier code style!".
- Hook output is trimmed (`post-edit-check.mjs`, `stop-check.mjs`).

**Gaps**

- `/context` has never been measured, and no PR records a startup total. Not verifiable from repo. Accepted for MVP because `/context` is interactive-only; the habit is now documented (`d4f876c`) for the owner's next session
- No spend alerts (`ai-policy.md:87` "Budget alert: `TODO(owner)`"). Console limits are not verifiable from repo. Accepted for MVP because Console limits are an owner setting
- (new) Unused MCP tools aren't disabled. The claude.ai connectors (Drive, Docs, Claude Docs, Gmail, Calendar) and the IDE MCP load into every repo session.

## 8. Knowledge Base & Docs

**Score: 2 / 2**

**Evidence**

- `docs/architecture.md` is linked from `AGENTS.md:14`. The "planned" wording fix (d4f876c) is verified: the section is now "## Module layout … Every module below exists".
- Five ADRs (`docs/adr/0001…0005`).
- `README.md` gives the clone-to-green steps and the where-to-find-what map. `npm test` is green locally (124 files, 1944 tests).
- Auto-memory review is now documented (`ai-policy.md:105`).
- `docs/dev-metrics.md` was regenerated ("Generated on 2026-10-28 … HEAD 6cf4fdb").

**Gaps**

- Architecture length (117 lines): length accepted for MVP because the module map is the content
- No devcontainer or Makefile (`ls Makefile .devcontainer` → not found). Accepted for MVP (see row 6)
- Doc links are dated, not version-pinned (`ai-policy.md:75`, `:100`). Accepted for MVP because the Claude Code docs aren't versioned; the check date is the pin
- (new) "Every module below exists" is not quite true. `architecture.md:112` describes replay "over `e2e/recordings/`", and `.gitignore:20` says it "is committed", but `ls e2e/recordings` → "No such file or directory".
- (new) `dev-metrics.md` is already behind: it was generated at `6cf4fdb`, and HEAD is `bc55b6b`.

## 9. Verification & Testing

**Score: 1 / 2**

**Evidence**

- Local headless checks: typecheck, lint, test and build all exit 0, and `format:check` passes.
- The single-test command is fast:
  ```
  $ time npm run test:one -- server/src/gate/leave-policy.schema.test.ts
        Tests  15 passed (15)
  real	0m0.850s
  ```
- No skipped or focused tests: `git ls-files '*.test.ts' '*.test.tsx' | xargs grep -nE '\.(skip|only|todo)\(' | wc -l` → `0`.
- The CI `verify` fix (2adae0b) is verified on PR #20:
  ```
  $ gh pr checks 20
  ai-review	fail	33s
  gitleaks	pass	7s
  verify	pass	2m22s
  $ gh run view 40632344810 --log | grep 'found .* vulnerabilities'
  found 0 vulnerabilities
  ```
- AI PRs include tests in 9 of the last 10: `#19 9 · #18 7 · #17 12 · #16 23 · #15 8 · #14 6 · #13 1 · #12 20 · #11 0 · #10 10` test or eval files.
- The PR template asks for evidence, and there's a Playwright e2e suite.

**Gaps**

- CI checks aren't required for merge. Accepted for MVP because branch protection needs a paid plan or a public repo (owner)
- 0 human reviews (`#10–#19 reviews=0 by=sahiltgi`, and PR #20 has `reviews=0`). Accepted for MVP because this is a solo project; `/review-pr` gives a recorded AI review step
- No SAST, CodeQL or dependency review (`ci.yml:1-3`). Accepted for MVP because CodeQL needs Code Security, which a private Free repo can't have
- e2e doesn't run in CI. Accepted for MVP because it's a `.github/workflows/` change (owner)
- (new) `master` CI is still red until PR #20 merges (`gh run list`: `2026-10-28T03:17 ci push master failure`).

## 10. Git & Review Workflow

**Score: 1 / 2**

**Evidence**

- Attribution: 12 of the last 12 non-merge commits carry a `Co-authored-by: Claude` trailer, including all 6 on this branch.
- CODEOWNERS (2adae0b) resolves on the branch but not on the default branch:
  ```
  $ gh api 'repos/sahiltgi/multi-agent-admin/codeowners/errors?ref=chore/setup-audit-fixes'
  {"errors":[]}
  $ gh api repos/sahiltgi/multi-agent-admin/codeowners/errors --jq '.errors|length'
  9
  ```
- Branch state:
  ```
  $ gh api repos/sahiltgi/multi-agent-admin/branches/master --jq '{protected, protection}'
  {"protected":false,"protection":{"enabled":true,"required_status_checks":{"checks":[],"contexts":[],"enforcement_level":"off"}}}
  $ gh api repos/sahiltgi/multi-agent-admin/branches/master/protection
  {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.",…,"status":"403"}
  ```

**Gaps**

- `master` is unprotected. Accepted for MVP because protection and rulesets return 403 on this plan (owner plan decision)
- Agents use the admin `gh` identity, and `gh pr merge 20 --admin` passes the hook with exit 0 (section 5). Accepted for MVP because a least-privilege token and `gh pr merge` ask rules are owner changes
- PRs are over ~400 lines (`#19 +3638/-33 … #10 +2544/-350`). Accepted for MVP because merged history can't change; the guide applies to new PRs
  - (new) The guide isn't being applied: PR #20 is `+730/-54` (about 784 changed lines, about 766 without the lockfile) with `reviews=0`.
- ai-review fails on every run, PR #20 included:
  ```
  "num_turns": 1, "total_cost_usd": 0, "is_error": true
  ##[error]Action failed with error: Claude execution failed: result is_error:true
  ```
  Accepted for MVP because the logs show `is_error:true` with no model usage, which points at the key or its workspace credit (owner)
- (new) The CODEOWNERS fix isn't effective until merge (9 errors on `master`).

## 11. CI & Autonomous Runs

**Score: 2 / 2**

**Evidence**

- All headless runs are listed in `docs/ci-agents.md:5-8` (`evals.yml`, `ai-review.yml`). `ci.yml` calls no model.
- Untrusted triggers are gated:
  - no `pull_request_target` and no comment triggers
  - fork, draft and bot PRs are skipped (`ai-review.yml:21-24`)
  - fork PRs are skipped in evals (`evals.yml:32`)
- Tokens are minimal:
  - `permissions: {}` (`ai-review.yml:11`, `evals.yml:22`)
  - the ai-review job gets `contents: read` and `pull-requests: write` (`:27-29`)
  - checkout sets `persist-credentials: false`
  - repo settings:
    ```
    $ gh api repos/sahiltgi/multi-agent-admin/actions/permissions/workflow
    {"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
    ```
- Tool and turn limits (`ai-review.yml:69-74`): `--max-turns 15`, `--setting-sources user`, `--strict-mcp-config`, an explicit `--allowedTools` list of 6 tools, and `--disallowedTools` covering Bash, file tools and the GitHub write tools.
- Timeouts: 15 (ai-review), 20 and 10 (ci), and 75 per job plus 25 and 45 per step (evals).
- Actions are SHA-pinned, and eval artifacts are kept for `retention-days: 30`.

**Gaps**

- The ai-review prompt is read from the PR checkout (`ai-review.yml:36-45`, `cat prompts/ci/ai-review.md`). Accepted for MVP because it's a `.github/workflows/` change (owner)
- Secrets are repo-scoped (`docs/ci-agents.md:10`). Accepted for MVP because Environment protection rules need a paid plan for private repos (owner)
- Actions settings:
  ```
  $ gh api repos/sahiltgi/multi-agent-admin/actions/permissions
  {"enabled":true,"allowed_actions":"all","sha_pinning_required":false}
  ```
  Accepted for MVP because these are repo Actions settings (owner); SHA pinning could break actions used inside claude-code-action
- The model jobs are failing (ai-review on PR #20, see section 10). Accepted for MVP (see row 10, ai-review)

## 12. Governance & Ownership

**Score: 1 / 2**

**Evidence**

- Team config is committed (`.claude/settings.json`, hooks, agents, skills and rules), and personal config is gitignored (`.gitignore:11-14`, `:25-26`).
- The written policy covers tools, data, MCP, dangerous modes and review (`docs/ai-policy.md:5-16`). Onboarding is in CONTRIBUTING.
- The owner handle is fixed to `@sahiltgi` in CODEOWNERS, `ai-policy.md:15`, `mcp-inventory.md:14` and the specs (2adae0b).
- Hook tests run in CI again: `vitest.config.ts:18-20` defines the `hooks` project inside `npm test`, and PR #20 `verify` passes.

**Gaps**

- No backup owner (`ai-policy.md:15` "Backup: none"). Accepted for MVP because this is a solo project with no second maintainer (`ai-policy.md`, `d4f876c`)
- Config isn't validated in CI. A settings.json schema check is accepted for MVP because its home is `.claude/hooks/` (owner)
- "Changes via PR" isn't enforced. Accepted for MVP (see row 10, `master` unprotected)
- No quarterly review yet. Accepted for MVP because the first one is due 2026-11-01
- (new) The backup owner is stated inconsistently: `mcp-inventory.md:14` says "Backup: TBD (same as ai-policy)", while `ai-policy.md:15` says "Backup: none".
- (new) The review rule conflicts with itself. `ai-policy.md:14` says "every PR needs a human review before merge … CODEOWNERS, branch protection", but `ai-policy.md:71` says branch protection is "Not in effect", and every PR shows 0 reviews.

## 13. Observability & Feedback

**Score: 1 / 2**

**Evidence**

- The block log has 572 lines (`wc -l .claude/logs/blocked.jsonl`; 8 of them are guard-bash).
- `npm run dev-metrics` output is in `docs/dev-metrics.md` ("AI-assisted 21 (87.5%)", "Reverts 0").
- `AI_LOG.md` has 4 rule-adding entries.
- The policy forbids `OTEL_LOG_USER_PROMPTS` (`ai-policy.md:85`).

**Gaps**

- Telemetry is off: `~/.claude/settings.json` has only `model, enabledPlugins, modelSettings, advisorModel` (no `env`/OTEL), and `ai-policy.md:80` says "It's off today". Vendor dashboards are not verifiable from repo. Accepted for MVP because OTEL goes in user or managed settings with a collector (owner)
- No cost spike alerts. Accepted for MVP (see row 7)
- `AI_LOG.md` is behind (4 entries, the latest dated 2026-10-27). Accepted for MVP because past `/cost` figures can't be recovered
  - (new) There's no row for this branch's audit-fix work either.
- No issue labels, retro or outcome split. Accepted for MVP because `AI_LOG.md` is the retro log for a solo project
- Run logs use the default retention. Accepted for MVP because GitHub's default retention covers MVP needs

## 14. Data & Compliance

**Score: 1 / 2**

**Evidence**

- The data rules are written down (`AGENTS.md:33` "Synthetic data only", `ai-policy.md:8`). The `.env` and `secrets/**` deny rules are in `settings.json:41-50`.
- Fixtures contain no non-reserved email domains. This scan printed nothing:
  ```
  $ git ls-files | grep -v package-lock.json | xargs grep -hoE '<email regex>' | grep -vE '\.(example|test|invalid)$|example\.(com|org)$|anthropic\.com$|noreply' | sort | uniq -c
  (no output)
  ```
- New in `ai-policy.md:98-110` (d4f876c), verified present:
  - API-key accounts under the Commercial Terms (`:102`)
  - transcript retention (`:104`)
  - auto-memory review (`:105`)
  - IP and licence guidance (`:106-109`)
  - regulatory scope, out of scope while data is synthetic (`:110`)

**Gaps**

- No LICENSE (`ls LICENSE*` → No such file or directory). LICENSE accepted for MVP because choosing one is the owner's legal decision and the repo is private
- The account for interactive sessions and its data terms are unrecorded (`ai-policy.md:103`, "treat sessions as consumer-terms"). Not verifiable from repo. The interactive sign-in type is accepted for MVP because only the owner can see it
- Connectors are guidance-only. Personal Drive, Docs and Claude Docs write tools are reachable from repo sessions. Accepted for MVP (see row 4)
- The data-terms facts at `ai-policy.md:102-104` come from external docs I didn't re-fetch.

## Top remaining gaps by risk

1. **`master` is unprotected and every merge is a self-merge with 0 reviews (Git, security critical).** It needs the owner: a plan change or public repo, then rulesets requiring a PR, code-owner review, `verify`/`gitleaks` and no force push. Merge PR #20 so CODEOWNERS resolves on `master`.
2. **Agent sessions hold the sole-admin `gh` identity, and `gh pr merge --admin` passes both the hook and the permissions (Git and Permissions, security critical).** Needs the owner: add `ask`/`deny` rules for `gh pr merge`, `gh api -X`, `gh secret` and `gh repo` in `.claude/settings.json`, or give agents a least-privilege token.
3. **Agents can rewrite their own guardrails: CLAUDE.md, AGENTS.md, agents, skills, `.husky/pre-commit` and CODEOWNERS. `HUSKY=0` and `core.hooksPath` skip the gitleaks pre-commit (Guardrails, security critical).** Needs the owner: extend `guard-files` HUMAN_ONLY and `guard-bash`.
4. **No sandbox, egress allowlist, push protection or managed policy, and `npm run evals` with the real `.env` key is allow-listed (Permissions, security critical).** Needs the owner: `.claude/settings.json` and the GitHub plan.
5. **Connectors with write access (Drive, Docs, Claude Docs) are reachable from repo sessions; the inventory misses Claude Docs and the IDE MCP; the plugin is unpinned (MCP and Data, security critical).** The inventory fix is a doc change an agent can make. `disableClaudeAiConnectors` needs the owner.
6. **The ai-review prompt comes from the PR branch, secrets are repo-wide, and `allowed_actions: all` (CI, security critical).** Needs the owner (`.github/workflows/` and repo settings). ai-review also needs a working key or credit (owner).
7. **The interactive account's data terms are unrecorded and there's no LICENSE (Data, security critical).** Needs the owner.
8. **No required checks, SAST or e2e in CI; PR #20 itself is over 400 lines (Verification and Git).** Required checks and e2e need the owner. PR size discipline is a process change.
9. **Governance and doc drift.** Contradictory review rule (`ai-policy.md:14` vs `:71`), inconsistent backup owner, missing `e2e/recordings/`, and `dev-metrics.md` and `AI_LOG.md` behind HEAD. An agent can fix the docs. Naming a backup owner needs the owner.
10. **Context and cost.** `/context` never measured, no spend alerts, telemetry off. Needs the owner (an interactive session, the Console and user settings).

## Gap register (from the baseline, 2026-10-28)

Every gap above, with what happened to it. "Owner" means the change needs a file only humans edit (`.claude/settings.json`, `.claude/hooks/`, `.github/workflows/`), a GitHub or Console setting, or a decision only the owner can make.

| #   | Gap                                                                   | Status                                                                                                                                                                |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `AGENTS.md` omits `shared/`                                           | Fixed in `d4f876c`                                                                                                                                                    |
| 1   | `.claude/worktrees/` not gitignored                                   | Fixed in `2adae0b`                                                                                                                                                    |
| 2   | No PR-review skill                                                    | Fixed in `6cf4fdb` (`/review-pr`)                                                                                                                                     |
| 2   | No migration workflow                                                 | Accepted for MVP because the project has no schema migrations (MongoDB, Zod at the boundaries)                                                                        |
| 2   | `run-evals` model-invocable                                           | Fixed in `d4f876c` (`disable-model-invocation: true`)                                                                                                                 |
| 2   | `open-pr` `disallowed-tools` undocumented                             | No change needed: `disallowed-tools` is a documented skill key ([skills docs](https://code.claude.com/docs/en/skills.md), checked 2026-10-28)                         |
| 3   | No `isolation: worktree`                                              | Accepted for MVP because writer subagents run one at a time in `/new-feature`, and a worktree would hide their output from the next step                              |
| 3   | Writer paths limited by prompt only                                   | Accepted for MVP because the `agent_type` path hook needs a `.claude/hooks/` change (owner)                                                                           |
| 3   | `fable` alias unverifiable from repo                                  | Accepted for MVP because Claude Code resolves model aliases at runtime; a wrong alias fails loudly at spawn                                                           |
| 4   | User-scope plugin not inventoried or reviewed                         | Fixed in `d4f876c` (reviewed: one command file, no hooks, scripts or MCP)                                                                                             |
| 4   | claude.ai connectors not inventoried                                  | Fixed in `d4f876c`; enforcement accepted for MVP because `disableClaudeAiConnectors` goes in `.claude/settings.json` (owner)                                          |
| 4   | Owner handle invalid                                                  | Fixed in `2adae0b`                                                                                                                                                    |
| 4   | No MCP deny rules in advance                                          | Accepted for MVP because no servers are adopted, and the inventory requires deny rules at adoption                                                                    |
| 5   | Agent config, `.husky/` and CODEOWNERS writable by agents             | Accepted for MVP because extending `guard-files` is a `.claude/hooks/` change (owner); CODEOWNERS now resolves, so changes there are visible in review                |
| 5   | `HUSKY=0` / `core.hooksPath` bypass                                   | Accepted for MVP because `guard-bash` is owner-edited; the CI gitleaks job and the `git commit` ask rule are the backstop                                             |
| 5   | `terraform destroy`, `git clean -fdx`, `find -delete`, `bash -c` pass | Accepted for MVP because `guard-bash` is owner-edited; no Terraform exists here, and the rest is documented in `ai-policy.md`                                         |
| 5   | `guard-files` has 0 real blocks                                       | Accepted for MVP because no agent has tried a blocked write; the synthetic tests prove the behaviour                                                                  |
| 6   | Sandbox off, no egress allowlist                                      | Accepted for MVP because `sandbox` goes in `.claude/settings.json` (owner); `ai-policy.md` now states the real state (`d4f876c`)                                      |
| 6   | No `.devcontainer/`                                                   | Accepted for MVP because one can't be verified on this machine, and the README clone-to-green path was verified                                                       |
| 6   | No push protection                                                    | Accepted for MVP because secret scanning push protection isn't available on a private Free repo (owner plan decision); pre-commit and CI gitleaks cover it            |
| 6   | No managed policy                                                     | Accepted for MVP because this is a solo project with no organization                                                                                                  |
| 6   | `Bash(npm run evals)` allow-listed                                    | Accepted for MVP because moving it to `ask` is a `.claude/settings.json` change (owner); the skill is now manual-only                                                 |
| 6   | Deny-rule negation undocumented                                       | Accepted for MVP because it fails closed and is documented in `ai-policy.md`                                                                                          |
| 7   | `/context` never measured                                             | Accepted for MVP because `/context` is interactive-only; the habit is now documented (`d4f876c`) for the owner's next session                                         |
| 7   | No `/clear`, `/compact` or model-per-task guidance                    | Fixed in `d4f876c` (CONTRIBUTING "Session habits")                                                                                                                    |
| 7   | Worktrees picked up by tooling                                        | Fixed in `d4f876c` (`.prettierignore`)                                                                                                                                |
| 7   | No spend alerts                                                       | Accepted for MVP because Console limits are an owner setting                                                                                                          |
| 8   | Architecture "planned" wording stale                                  | Fixed in `d4f876c`; length accepted for MVP because the module map is the content                                                                                     |
| 8   | No devcontainer or Makefile                                           | Accepted for MVP (see row 6)                                                                                                                                          |
| 8   | Doc links dated, not version-pinned                                   | Accepted for MVP because the Claude Code docs aren't versioned; the check date is the pin                                                                             |
| 8   | No auto-memory review                                                 | Fixed in `d4f876c` (`ai-policy.md` "Data, IP and retention")                                                                                                          |
| 8   | `dev-metrics.md` stale                                                | Fixed: regenerated on this branch                                                                                                                                     |
| 9   | CI `verify` red at `npm audit`                                        | Fixed in `2adae0b` (`npm audit fix`, 0 vulnerabilities)                                                                                                               |
| 9   | CI checks not required                                                | Accepted for MVP because branch protection needs a paid plan or a public repo (owner)                                                                                 |
| 9   | 0 human reviews                                                       | Accepted for MVP because this is a solo project; `/review-pr` gives a recorded AI review step                                                                         |
| 9   | No SAST                                                               | Accepted for MVP because CodeQL needs Code Security, which a private Free repo can't have                                                                             |
| 9   | e2e not in CI                                                         | Accepted for MVP because it's a `.github/workflows/` change (owner)                                                                                                   |
| 10  | `master` unprotected                                                  | Accepted for MVP because protection and rulesets return 403 on this plan (owner plan decision)                                                                        |
| 10  | CODEOWNERS unknown owner                                              | Fixed in `2adae0b`                                                                                                                                                    |
| 10  | Agents use the admin `gh` identity                                    | Accepted for MVP because a least-privilege token and `gh pr merge` ask rules are owner changes                                                                        |
| 10  | PRs over ~400 lines                                                   | Accepted for MVP because merged history can't change; the guide applies to new PRs                                                                                    |
| 10  | ai-review fails every run                                             | Accepted for MVP because the logs show `is_error:true` with no model usage, which points at the key or its workspace credit (owner)                                   |
| 11  | ai-review prompt read from the PR branch                              | Accepted for MVP because it's a `.github/workflows/` change (owner)                                                                                                   |
| 11  | Secrets repo-scoped                                                   | Accepted for MVP because Environment protection rules need a paid plan for private repos (owner)                                                                      |
| 11  | `allowed_actions: all`, `sha_pinning_required: false`                 | Accepted for MVP because these are repo Actions settings (owner); SHA pinning could break actions used inside claude-code-action                                      |
| 11  | Model jobs failing                                                    | Accepted for MVP (see row 10, ai-review)                                                                                                                              |
| 12  | Owner handle invalid                                                  | Fixed in `2adae0b`                                                                                                                                                    |
| 12  | Backup owner overdue                                                  | Accepted for MVP because this is a solo project with no second maintainer (`ai-policy.md`, `d4f876c`)                                                                 |
| 12  | Config not validated in CI                                            | Partly fixed: with `verify` unblocked, CI runs the 73 hook tests again; a settings.json schema check is accepted for MVP because its home is `.claude/hooks/` (owner) |
| 12  | "Changes via PR" not enforced                                         | Accepted for MVP (see row 10, `master` unprotected)                                                                                                                   |
| 12  | No quarterly review yet                                               | Accepted for MVP because the first one is due 2026-11-01                                                                                                              |
| 13  | Telemetry off                                                         | Accepted for MVP because OTEL goes in user or managed settings with a collector (owner)                                                                               |
| 13  | No cost spike alerts                                                  | Accepted for MVP (see row 7)                                                                                                                                          |
| 13  | `AI_LOG.md` behind                                                    | Accepted for MVP because past `/cost` figures can't be recovered                                                                                                      |
| 13  | No issue labels, retro or outcome split                               | Accepted for MVP because `AI_LOG.md` is the retro log for a solo project                                                                                              |
| 13  | Default run-log retention                                             | Accepted for MVP because GitHub's default retention covers MVP needs                                                                                                  |
| 14  | No licence or IP guidance                                             | IP guidance fixed in `d4f876c`; LICENSE accepted for MVP because choosing one is the owner's legal decision and the repo is private                                   |
| 14  | No account or data-terms record                                       | Fixed in `d4f876c` for the API keys; the interactive sign-in type is accepted for MVP because only the owner can see it                                               |
| 14  | Transcript retention undocumented                                     | Fixed in `d4f876c`                                                                                                                                                    |
| 14  | No regulatory mapping                                                 | Fixed in `d4f876c` (out of scope while data is synthetic; required before real data)                                                                                  |
| 14  | Connectors guidance-only                                              | Accepted for MVP (see row 4)                                                                                                                                          |

The full baseline report is in git history at commit `622196e`.
