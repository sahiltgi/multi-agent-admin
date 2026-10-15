# AI-Assisted Workflow Audit

multi-sub-agent-admin · host: none (no git remote) · default branch: `master` (unborn) · HEAD: none (no commits) · 2026-10-15
Claude Code · claude-opus-5-5 · effort high · model check: pinned · ai-workflow-audit v1.2.0 (rubric 2.0, questionnaire 1.0)

_Independent, evidence-based AI assessment._

## Score summary

| Weighted Score | Score % | Security Avg | Maturity | Rated | Critical | High | AI tools detected   |
| -------------- | ------- | ------------ | -------- | ----- | -------- | ---- | ------------------- |
| 3.78           | 76      | 3.00         | Managed  | 11/11 | 0        | 4    | Claude Code (local) |

The biggest risk is that, with 0 commits, no remote and no CI, every guardrail and AI config file exists only in one working tree while agents run without a sandbox or egress limits, and the biggest opportunity is committing the setup through small reviewed PRs (+0.55).

## Scorecard

| #   | Parameter                    | Weight | SEC | Score | Confidence | Why (≤ 15 words, with key evidence path)                                          |
| --- | ---------------------------- | ------ | --- | ----- | ---------- | --------------------------------------------------------------------------------- |
| 1   | Instructions & Memory        | 15%    |     | 4     | High       | Lean `AGENTS.md` imported by `CLAUDE.md`, scoped rules; uncommitted, 3 stale refs |
| 2   | Skills & Commands            | 10%    |     | 4     | High       | 5 spec-compliant skills in `.claude/skills/`; uncommitted; 3 lack `allowed-tools` |
| 3   | MCP Servers & Plugins        | 10%    | ✓   | N/A   | High       | No `.mcp.json`, no plugins; `docs/mcp-inventory.md` rejects all servers           |
| 4   | Guardrails & Hooks           | 5%     | ✓   | 3     | High       | Strong tested hooks in `.claude/hooks/`, but local-only (untracked)               |
| 5   | Permissions & Secrets        | 5%     | ✓   | 3     | Medium     | Narrow policy, `.env` denied, bypass disabled; no sandbox or egress limits        |
| 6   | Context & Cost               | 10%    |     | 5     | High       | 54 always-loaded lines, path-scoped rules, model fields; session hygiene partial  |
| 7   | Knowledge Base & Docs        | 20%    |     | 4     | High       | Architecture, ADRs, map in `README.md`; docs describe a non-existent CI           |
| 8   | Verification & Testing       | 10%    |     | 3     | Medium     | `test:one` and Stop hook; no CI, no security scans on PRs, no e2e                 |
| 9   | Git & Review Workflow        | 5%     | ✓   | 3     | Medium     | CODEOWNERS covers AI config; 0 commits, no remote, whole tree uncommitted         |
| 10  | Governance & Data Compliance | 5%     | ✓   | 3     | Medium     | `docs/ai-policy.md` with owner; no CI validation, no licence/IP guidance          |
| 11  | Observability & Feedback     | 5%     |     | 4     | Medium     | `AI_LOG.md` tracks failures and rules added; no telemetry                         |

## Security actions required

| Severity | P#  | Finding (sub-check IDs)                                                                                                                                   | Evidence (`file:line`, redacted)                                                                                                 | Fix (exact file/setting)                                                                                                                           |
| -------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | P5  | No sandbox and no network egress restriction for agent shells (5.9, 5.10)                                                                                 | `.claude/settings.json:1-101` has no `sandbox` key; no `.devcontainer/`                                                          | Add `"sandbox": {"enabled": true, "network": {"allowedDomains": [...]}}` to `.claude/settings.json`, or a `.devcontainer/` with an egress firewall |
| High     | P9  | Entire project uncommitted: 0 commits, no remote, AI config and guardrails never reviewed or shared (9.5; also 1.1, 1.2, 1.11, 2.1, 4.1, 5.1, 10.1, 10.3) | `git log`: "does not have any commits yet"; 155 untracked files incl. `AGENTS.md`, `CLAUDE.md`, `.claude/**` [local]             | Push to GitHub; land the tree as small Conventional Commits on `feat/*` branches via PRs reviewed under `.github/CODEOWNERS`                       |
| High     | P10 | No CI workflow, although docs describe one; AI config not validated in CI, no PR security scans (10.5; also 8.5, 8.7, 7.5)                                | `.github/workflows/` missing; claimed at `docs/ai-policy.md:67`, `docs/architecture.md:68`, `CONTRIBUTING.md:14`, `AGENTS.md:36` | Add `.github/workflows/ci.yml`: typecheck, lint, test (incl. `hooks` project), build, gitleaks, dependency-review, CodeQL                          |
| High     | P10 | No licence/IP guidance for AI-generated code (10.12)                                                                                                      | `docs/ai-policy.md:5-16` has no licence/IP item                                                                                  | Add a "Licence and IP" bullet to `docs/ai-policy.md` ## Policy                                                                                     |

## Changes required (priority order)

| #   | Change                                                                                                                                                                                 | P# / sub-checks fixed                                                                   | Effort | Impact                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| 1   | Push to a GitHub remote and land the tree as small PRs with `Co-authored-by` trailers and the PR template filled in                                                                    | P1 1.1 1.2 1.9 1.11 · P2 2.1 · P4 4.1-4.9 · P5 5.1 5.3 5.6 · P9 9.1 9.5 · P10 10.1 10.3 | Short  | P1 4→5, P2 4→5, P4 3→5, P5 3→4, P9 3→5, P10 3→4 = +0.55 |
| 2   | Enable `sandbox` with a network `allowedDomains` list in `.claude/settings.json`                                                                                                       | P5 5.9 5.10                                                                             | Quick  | P5 3→4 = +0.05                                          |
| 3   | Add `.github/workflows/ci.yml` as described in `docs/ai-policy.md:67` (verify, gitleaks, dependency-review, CodeQL, `vitest --project hooks`)                                          | P8 8.5 8.7 · P10 10.5 · P4 4.9 backstop                                                 | Short  | P8 3→4, P10 3→4 = +0.15                                 |
| 4   | Extend `docs/ai-policy.md` ## Policy: licence/IP, approved org accounts only, transcript retention, monthly review cadence                                                             | P10 10.7 10.8 10.12 10.14                                                               | Quick  | P10 3→4 = +0.05                                         |
| 5   | Fix stale docs: `CONTRIBUTING.md:45` (evals "no cases yet" vs `evals/*/cases.jsonl`), `docs/mcp-inventory.md:65` (no DB code vs `server/src/models/`), CI references until row 3 lands | P7 7.5 · P1 1.5                                                                         | Quick  | P7 4→5 = +0.20                                          |
| 6   | Add `allowed-tools` to `.claude/skills/fix-issue/SKILL.md`, `new-feature/SKILL.md`, `change-policy/SKILL.md`                                                                           | P2 2.9                                                                                  | Quick  | P2 4→5 = +0.10                                          |
| 7   | Add an "AI usage" section to `CONTRIBUTING.md`: `/clear`/`/compact`/new session per task, `CLAUDE_CODE_ENABLE_TELEMETRY` + OTEL exporter with owner, monthly spend budget and alert    | P6 6.5 6.8 · P11 11.1 11.2                                                              | Quick  | P11 4→5 = +0.05                                         |
| 8   | After pushing: enable branch protection on `main` (required checks, code-owner review, no force push) and secret scanning push protection                                              | P9 9.2 · P8 8.6 · P5 5.7                                                                | Quick  | Resolves Unknowns (+0.00 now)                           |
| 9   | Add Playwright e2e tests for `web/` and run them in `ci.yml`                                                                                                                           | P8 8.9                                                                                  | Short  | P8 4→5 = +0.10 (after rows 1, 3)                        |
| 10  | Define data classes in `docs/ai-policy.md` and add `Read` deny rules for dump/export paths (e.g. `**/*.sql`, `**/*.dump`, `exports/**`) in `.claude/settings.json`                     | P10 10.9                                                                                | Quick  | Closes 10.9 (+0.00 alone)                               |
| 11  | State React, Vite, Vitest, Zod and Mongoose major versions in `AGENTS.md` ## Project                                                                                                   | P7 7.6                                                                                  | Quick  | Closes 7.6 (+0.00 alone)                                |

**Projected Weighted Score if all changes are done: 5.00 (Optimized)**

## AI practice (questionnaire)

Full-stack · 5-8 yrs · answers `interactive` · Self-administered: one person's answers, graded against fixed anchors. A practice indicator, not an employee evaluation.

| Practice Score | Level    | Written /40 | Prompt exercise /15 | Scenarios /24 | Work mode /11 | Matches audit /10 |
| -------------- | -------- | ----------- | ------------------- | ------------- | ------------- | ----------------- |
| 66             | Advanced | 22.2        | 6                   | 20            | 8             | 10                |

- **Prompt exercise (Q8):** `2/5 · has E2 E3 · missing E1 done-criteria, E4 constraints, E5 verification (failing test + run suite)`
- **Written answers:**
  - `Q9 · 1 · names the current project only; no how-used or outcome`
  - `Q10 · 2 · concrete steps with docs, skills, guardrails; no pre-merge check named`
  - `Q11 · 2 · concrete UI problem and process change; how it was caught not stated`
- **Scenarios:** 5/6 correct. Missed Q4: don't run it, and don't ask the agent. Text in files is data, not instructions: stop and flag it as prompt injection.
- **Says vs found:**

| Row  | Claim (Q#)                                        | Audit (P#, score)               | Verdict                        |
| ---- | ------------------------------------------------- | ------------------------------- | ------------------------------ |
| X1   | Works from repo docs, skills and guardrails (Q10) | P1 4, P2 4                      | Consistent                     |
| X2   | Tests/CI before merge (Q10)                       | P8 3                            | No claim                       |
| X3   | Rule/hook/check added after mistake (Q11)         | P4 3, P11 4                     | No claim (process change only) |
| Tool | Claude Code used most (Q1)                        | `.claude/`, `CLAUDE.md` present | Consistent                     |

- **Flags:** None.
- **Next steps for the respondent:**
  1. Q4 (P5): treat instructions inside files as data; enable `sandbox` + egress allowlist in `.claude/settings.json` so such text cannot reach the network.
  2. Add to every agent brief: done-criteria (E1), scope limits (E4), and "write a failing test, then run the suite" (E5).
  3. P8 (lowest numeric, highest weight among ties): add `.github/workflows/ci.yml` so checks run on every PR.

## Sub-check evidence

`P1 · Score 4 · Pass: 1.3 (54 lines incl. import), 1.4, 1.6, 1.7, 1.8 (.claude/rules/*.md paths), 1.10 · Partial: 1.1 [local, untracked], 1.2 [local; CLAUDE.md:1 imports AGENTS.md], 1.5 (17/20 = 85%; missing .github/workflows/ AGENTS.md:36, evals/results/ run-evals/SKILL.md:13, shared/ test-writer.md:15), 1.9 (AGENTS.md, CLAUDE.md, .claude/** untracked, not ignored) · Fail: 1.11 (0 commits, no PRs) · ratio 0.73 → 4 · caps: none`

`P2 · Score 4 · Pass: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8 (open-pr: disable-model-invocation + explicit yes) · Partial: 2.1 [local], 2.9 (only open-pr, run-evals set allowed-tools) · ratio 0.89 → 4 · caps: none`

`P3 · N/A · no .mcp.json, no enabledPlugins/extraKnownMarketplaces in .claude/settings.json; docs/mcp-inventory.md:15 "no servers adopted"`

`P4 · Score 3 · Pass: 4.7 (docs/ai-policy.md:18-41 ask list, AGENTS.md:36) · Partial (local safeguards, untracked): 4.1, 4.2 (post-edit-check.mjs prettier/eslint), 4.3 (stop-check.mjs), 4.4 (guard-bash.mjs), 4.5 (guard-files.mjs:9-20), 4.6 (exit 2, tests in .claude/hooks/*.test.ts), 4.8 (.husky/pre-commit gitleaks), 4.9 (guard-bash.mjs:79; no server backstop) · ratio 0.56 → 3 · caps: none`

`P5 · Score 3 · Pass: 5.2, 5.4 (git grep --untracked: 0 hits), 5.5 (gitleaks: 0 commits), 5.8 (disableBypassPermissionsMode, settings.json:51), 5.11 · Partial (local): 5.1, 5.3 (settings.json:41-49), 5.6 (.gitignore:8-9 untracked) · Fail: 5.9, 5.10 · Unknown: 5.7, 5.12 · ratio 0.65 → 3 · caps: none`

`P6 · Score 5 · Pass: 6.1 (54 lines), 6.2, 6.4 (model fields .claude/agents/*.md, docs/dev-agents.md), 6.6 (hooks tail output to 60 lines), 6.7 · Partial: 6.5 (plan mode only, CLAUDE.md:5; no /clear or /compact guidance) · Unknown: 6.8 · N/A: 6.3 · ratio 0.92 → 5 · caps: none`

`P7 · Score 4 · Pass: 7.1 (AGENTS.md:14), 7.2 (docs/adr/ 4 ADRs), 7.3 (README.md:5-19), 7.4 (README.md:21-37), 7.7 · Partial: 7.6 (Node 24.21, Express 5 stated; React/Vite/Vitest/Zod not) · Fail: 7.5 (CI described as existing at docs/ai-policy.md:67; CONTRIBUTING.md:45; docs/mcp-inventory.md:65) · N/A: 7.8 · ratio 0.79 → 4 · caps: none`

`P8 · Score 3 · Pass: 8.1 (AGENTS.md:25), 8.2 (AGENTS.md:24), 8.4 (no .skip/.only/xit in working tree) · Partial: 8.8 (template has evidence section; no PRs), 8.10 (template checklist; no PRs) · Fail: 8.5, 8.7 (no .github/workflows/), 8.9 (web/ UI, no e2e) · Unknown: 8.6 · N/A: 8.3 (no AI-attributed commits) · ratio 0.50 → 3 · caps: none`

`P9 · Score 3 · Pass: 9.4 (.github/CODEOWNERS:4-11 [local]), 9.8 (0 commits) · Partial: 9.1 (policy CONTRIBUTING.md:87-95; no history) · Fail: 9.5 (whole 155-file tree is one uncommitted change) · Unknown: 9.2, 9.3, 9.6 · N/A: 9.7 · ratio 0.63 → 3 · caps: none`

`P10 · Score 3 · Pass: 10.2 (owner docs/ai-policy.md:15; 0 contributors → owner only), 10.4 (docs/ai-policy.md:7-14), 10.6 (CONTRIBUTING.md:50-59, docs/dev-agents.md), 10.10 (5 files sampled, 0 real-looking PII; .example domains), 10.11 · Partial: 10.1, 10.3 [local], 10.7 (single "Next review" date), 10.9 (synthetic-only defined; no data-dir denies) · Fail: 10.5, 10.12 · Unknown: 10.8, 10.14 · N/A: 10.13 · ratio 0.64 → 3 · caps: none`

`P11 · Score 4 · Pass: 11.3 (AI_LOG.md:5-8 "What went wrong"), 11.5 (AI_LOG.md "Fix or rule added"), 11.7 · Fail: 11.1 · Unknown: 11.2, 11.4 · N/A: 11.6 (no headless runs) · ratio 0.75 → 4 · caps: none`

## Not verifiable from the repository

- 5.7 host secret scanning / push protection: no remote; `gh` not authenticated.
- 5.12 central/managed org policy: no managed-settings reference in the repo.
- 6.8 spend tracking per project: no docs; check the Anthropic console with the team.
- 8.6 required CI checks: no remote; `gh` not authenticated.
- 8.8 / 8.10 (sampled part) PR bodies and non-author reviews: no PRs exist.
- 9.2 default-branch protection: no remote; `gh` not authenticated.
- 9.3 bot/agent identity rights: no remote or host app config to read.
- 9.6 median PR size: no merged PRs.
- 10.8 approved org accounts only: not stated in `docs/ai-policy.md`.
- 10.14 transcript/data retention for Claude Code: not documented.
- 11.2 cost spike alerts and 11.4 outcome metrics split by AI work: not documented.

## Method note

CLIs: `gitleaks` (history, 0 commits); `gh` installed but unauthenticated and no remote, so host checks are Unknown. Zero commits: all 155 project files are untracked, so every AI file is `[local]` (26 untracked, 1 ignored `.claude/logs/blocked.jsonl`, 0 modified). The secret scan used `git grep --untracked`. Sub-checks that need a positive history fail (1.11, 9.5, and the history half of 9.1); those that need an absent violation pass (5.5, 9.8). 8.4 and 9.5 treat the uncommitted tree as the AI-produced change set. The tree may have been edited concurrently, so only the 3.0 baseline was used. One questionnaire question line surfaced in a keyword grep before scoring; it was not used. The project's PostToolUse hook reformatted this report with Prettier; the auditor ran no project commands.
Read-only audit; nothing was executed or modified except this report.
