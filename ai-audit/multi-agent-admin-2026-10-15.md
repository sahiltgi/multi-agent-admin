# AI-Assisted Workflow Audit

multi-agent-admin · GitHub · master · 5aace9f0bebc2fa3557151959cfa8a1957fe72de · 2026-10-15
Claude Code · claude-opus-5-5 · effort high · model check pinned · ai-workflow-audit v1.2.0 (rubric 2.0, questionnaire 1.0)
_Independent, evidence-based AI assessment._

## Score summary

| Weighted Score | Score % | Security Avg | Maturity | Rated | Critical | High | AI tools detected                   |
| -------------- | ------- | ------------ | -------- | ----- | -------- | ---- | ----------------------------------- |
| 4.0            | 80%     | 3.5          | Managed  | 11/11 | 1        | 3    | Claude Code; AGENTS.md (cross-tool) |

Biggest risk: all code and AI config reached `master` as one 21,203-line direct commit, with no CI and no verified branch protection; biggest opportunity: correct AGENTS.md and the stale docs (P1 4→5 = +0.15, P7 4→5 = +0.20).

## Scorecard

| #   | Parameter                    | Weight | SEC | Score | Confidence | Why (≤ 15 words, with key evidence path)                                                      |
| --- | ---------------------------- | ------ | --- | ----- | ---------- | --------------------------------------------------------------------------------------------- |
| 1   | Instructions & Memory        | 15%    |     | 4     | High       | CLAUDE.md imports 48-line AGENTS.md, scoped rules; no build command, no PR history            |
| 2   | Skills & Commands            | 10%    |     | 5     | High       | 5 spec-compliant skills in `.claude/skills/`, verify steps, `/open-pr` manual-only            |
| 3   | MCP Servers & Plugins        | 10%    | ✓   | N/A   | High       | No MCP or plugin config anywhere; `docs/mcp-inventory.md:15` confirms none adopted            |
| 4   | Guardrails & Hooks           | 5%     | ✓   | 5     | High       | Tested PreToolUse/PostToolUse/Stop hooks, husky gitleaks; instruction files not write-guarded |
| 5   | Permissions & Secrets        | 5%     | ✓   | 4     | High       | Narrow allow/ask/deny, bypass disabled, no secrets; no sandbox or egress limit                |
| 6   | Context & Cost               | 10%    |     | 5     | High       | 54 always-loaded lines, path-scoped rules, model per subagent; spend not documented           |
| 7   | Knowledge Base & Docs        | 20%    |     | 4     | High       | Architecture, ADRs, clone-to-green, map; stale CI and DB claims in `docs/`                    |
| 8   | Verification & Testing       | 10%    |     | 3     | Medium     | Agent checks and hooks exist; no CI, no security scans on PRs, no e2e                         |
| 9   | Git & Review Workflow        | 5%     | ✓   | 2     | Medium     | Cap: AI config added by direct commit 5aace9f to master; no PRs                               |
| 10  | Governance & Data Compliance | 5%     | ✓   | 3     | High       | `docs/ai-policy.md` covers tools/data/MCP/modes/review; no licence, regulatory, CI checks     |
| 11  | Observability & Feedback     | 5%     |     | 4     | Medium     | `AI_LOG.md` tracks failures and rules added; no telemetry configured                          |

## Security actions required

| Severity | P#  | Finding (sub-check IDs)                                                                                    | Evidence (`file:line`, redacted)                                                                                    | Fix (exact file/setting)                                                                                                                    |
| -------- | --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | 9   | Hard cap: AI config and all code reached the default branch by direct commit, no PR (9.5, 9.6, 1.11, 10.3) | `git log master`: 5aace9f "initial commit", 158 files, +21,203, incl. AGENTS.md, CLAUDE.md, `.claude/settings.json` | GitHub ruleset on `master`: PR required, 1 approval, code-owner review, required checks, no force-push, no bypass; land every change via PR |
| High     | 5   | No sandbox, no network egress limit for agent shells (5.9, 5.10)                                           | `.claude/settings.json:1-101` has no `sandbox` key; no `.devcontainer/`                                             | `.claude/settings.json`: `sandbox.enabled: true` plus `sandbox.network.allowedDomains`                                                      |
| High     | 10  | No CI: AI config and hooks are never validated on PRs (10.5; also 8.5, 8.7)                                | no `.github/workflows/`; `docs/ai-policy.md:67` describes a `ci.yml` that does not exist                            | Add `.github/workflows/ci.yml` incl. `npx vitest run --project hooks`                                                                       |
| High     | 10  | No licence/IP guidance; no regulatory mapping for employee and sick-leave data (10.12, 10.13)              | `docs/ai-policy.md` has neither section; `policies/leave/v1.yaml:7` (sick leave)                                    | Add both sections to `docs/ai-policy.md`                                                                                                    |

## Changes required (priority order)

| #   | Change                                                                                                                                                                                                                                                                                   | P# / sub-checks fixed                    | Effort (Quick ≤1d / Short ≤2w / Long) | Impact                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Enable a branch ruleset on `master` (see Critical row); open every change, incl. AI config, as a PR with the `Co-authored-by` trailer from `CONTRIBUTING.md:87-95`                                                                                                                       | P9 9.1, 9.2, 9.5, 9.6; P1 1.11; P10 10.3 | Quick                                 | P9 2→4 = +0.10 (cap lifts once direct commit leaves the 90-day window) |
| 2   | Create `.github/workflows/ci.yml` on `pull_request`: typecheck, lint, test (incl. hooks project), build, gitleaks, dependency-review, CodeQL; add `.github/dependabot.yml`                                                                                                               | P8 8.5, 8.7; P10 10.5                    | Short                                 | P8 3→4 = +0.10; with row 1, P10 4→5 = +0.05                            |
| 3   | `.claude/settings.json`: enable `sandbox` with a `network.allowedDomains` list (npm registry, GitHub)                                                                                                                                                                                    | P5 5.9, 5.10                             | Quick                                 | P5 4→5 = +0.05                                                         |
| 4   | `docs/ai-policy.md`: add licence/IP rules for AI code, regulatory mapping for employee/sick-leave data, review cadence, approved org accounts, transcript retention                                                                                                                      | P10 10.7, 10.8, 10.12, 10.13, 10.14      | Quick                                 | P10 3→4 = +0.05                                                        |
| 5   | `AGENTS.md`: add `npm run build` under Commands; mark "Express 5 API" (line 9) as planned, since no `express` dependency exists                                                                                                                                                          | P1 1.4                                   | Quick                                 | P1 4→5 = +0.15                                                         |
| 6   | Fix stale docs: `docs/mcp-inventory.md:65` (DB code and seeds exist), `docs/architecture.md:68` and `docs/ai-policy.md:67` (CI absent; branch is `master`, not `main`); add a key-versions line (Node 24, TS 6, Zod 4, React 19, Vite 8, Vitest 5, Mongoose 9) to `docs/architecture.md` | P7 7.5, 7.6                              | Quick                                 | P7 4→5 = +0.20                                                         |
| 7   | `.claude/hooks/guard-files.mjs` (human edit): add AGENTS.md, CLAUDE.md, `.claude/rules/`, `.claude/skills/`, `.claude/agents/` to `HUMAN_ONLY`                                                                                                                                           | P4 4.5                                   | Quick                                 | +0.00 (P4 stays 5)                                                     |
| 8   | `docs/ai-policy.md`: document `CLAUDE_CODE_ENABLE_TELEMETRY`/OTEL exporter with an owner, spend tracking and spike alerts                                                                                                                                                                | P11 11.1, 11.2; P6 6.8                   | Short                                 | P11 4→5 = +0.05                                                        |
| 9   | Add Playwright e2e for `web/` (`web/e2e/`, `test:e2e` script) and run it in CI                                                                                                                                                                                                           | P8 8.9                                   | Short                                 | +0.00 now; with PR evidence (8.8, 8.10) part of P8 4→5 = +0.10         |
| 10  | Add `allowed-tools` to `.claude/skills/{fix-issue,new-feature,change-policy}/SKILL.md`                                                                                                                                                                                                   | P2 2.9                                   | Quick                                 | +0.00 (P2 stays 5)                                                     |
| 11  | `CONTRIBUTING.md` "Claude Code setup": add session hygiene (`/clear` per task, `/compact`, restart from a summary)                                                                                                                                                                       | P6 6.5                                   | Quick                                 | +0.00 (P6 stays 5)                                                     |
| 12  | Name a backup owner in `docs/ai-policy.md:15`, `docs/mcp-inventory.md:14` and `.github/CODEOWNERS` (its stated deadline is today)                                                                                                                                                        | P10 10.2                                 | Quick                                 | +0.00 (needed once a 2nd contributor joins)                            |

**Projected Weighted Score if all changes are done: 4.83 (Optimized)**

## AI practice (questionnaire)

Full-stack · 5–8 yrs · answers `file` · Self-administered: one person's answers, graded against fixed anchors. A practice indicator, not an employee evaluation.

| Practice Score | Level    | Written /40 | Prompt exercise /15 | Scenarios /24 | Work mode /11 | Matches audit /10 |
| -------------- | -------- | ----------- | ------------------- | ------------- | ------------- | ----------------- |
| 63             | Advanced | 22.2        | 3                   | 20            | 8             | 10                |

- **Prompt exercise (Q8):** `1/5 · has E2 (points to the auto-logout API call) · missing E1 goal/done-criteria, E3 investigate first, E4 constraints, E5 verification`
- **Written answers:**
  - `Q9 · 1 · names the current project only; no how-used and no outcome`
  - `Q10 · 1 · describes project setup, not a task-to-merge flow; no check before merge`
  - `Q11 · 3 · screenshot-copied UI details wrong, spotted visually; switched to HTML-first, per component`
- **Scenarios:** 5/6 correct. Missed Q4: do not run it, and do not ask the agent either; the text is data, so stop and flag it as prompt injection.
- **Says vs found:**

  | Row  | Claim (Q#)                                            | Audit (P#, score)             | Verdict    |
  | ---- | ----------------------------------------------------- | ----------------------------- | ---------- |
  | X1   | Works from shared docs, skills, guardrails (Q10)      | P1 4, P2 5                    | Consistent |
  | X2   | None (Q10)                                            | P8 3                          | No claim   |
  | X3   | None; a process change only, no rule/hook/check (Q11) | P4 5, P11 4                   | No claim   |
  | Tool | Claude Code (Q1)                                      | `.claude/`, CLAUDE.md present | Consistent |

- **Flags:** None.
- **Next steps for the respondent:**
  1. Q4 → P5: treat instructions found in files as data and flag them. Back this up by enabling the sandbox in `.claude/settings.json` (change 3).
  2. Every agent brief needs a goal and done-criteria, a request for the root cause before any edit, scope limits, and a test that reproduces the bug plus the done-check. `/fix-issue` already encodes these.
  3. The lowest audit parameter is P9 (2). Protect `master` and open every change as a PR with the `Co-authored-by` trailer (change 1).

## Sub-check evidence

`P1 · Score 4 · Pass: 1.1, 1.2 (CLAUDE.md:1 @AGENTS.md), 1.3 (48 lines), 1.5 (19/20 exist; missing .github/workflows/ AGENTS.md:36), 1.6, 1.7, 1.8 (.claude/rules/*.md paths:), 1.9 (.gitignore:11-13), 1.10 · Partial: 1.4 (typecheck/lint/test/test:one in package.json:13-17; no build in AGENTS.md) · Fail: 1.11 (only change is direct commit 5aace9f) · Unknown: — · N/A: — · ratio 0.86 → 4 · caps: none`

`P2 · Score 5 · Pass: 2.1, 2.2 (fix-issue, new-feature, open-pr, run-evals, change-policy), 2.3, 2.4, 2.5 (≤55 lines), 2.6, 2.7, 2.8 (open-pr disable-model-invocation + explicit yes) · Partial: 2.9 (allowed-tools only on open-pr, run-evals) · Fail: — · Unknown: — · N/A: — · ratio 0.94 → 5 · caps: none`

`P3 · Score N/A · no .mcp.json, mcpServers or enabledPlugins in committed or local config; enableAllProjectMcpServers false (.claude/settings.json:53) · caps: none`

`P4 · Score 5 · Pass: 4.1 (.claude/settings.json:54-100), 4.2 (post-edit-check.mjs; lint-staged), 4.3 (stop-check.mjs:10 typecheck+test), 4.4 (guard-bash.mjs: rm -rf, force push, reset --hard, DROP, curl|sh), 4.6 (exit 2, tests next to scripts, local block log shows firing), 4.7 (docs/ai-policy.md:18-41), 4.8 (.husky/pre-commit:11 gitleaks), 4.9 (guard-bash.mjs:79) · Partial: 4.5 (guard-files.mjs:9-20 covers .env*, workflows, settings, hooks; not AGENTS.md, CLAUDE.md, rules, skills, agents) · Fail: — · ratio 0.94 → 5 · caps: none`

`P5 · Score 4 · Pass: 5.1, 5.2, 5.3 (.claude/settings.json:41-49), 5.4 (scan: 0 hits), 5.5 (gitleaks: 1 commit, no leaks), 5.6, 5.8 (.claude/settings.json:51), 5.11 · Fail: 5.9 (no sandbox, no devcontainer), 5.10 (no egress limit) · Unknown: 5.7, 5.12 · N/A: — · ratio 0.80 → 4 · caps: none; injection-like strings are labelled synthetic product eval payloads (evals/agent-runtime/cases.jsonl:6, server/src/agents/untrusted.test.ts:71, specs/agent-runtime.md:295,359, specs/orchestrator.md:212; docs/dev-agents.md:40), not aimed at auditors or coding agents`

`P6 · Score 5 · Pass: 6.1 (54 lines), 6.2, 6.4 (model: in .claude/agents/*.md), 6.6 (hooks keep last 60 lines, NO_COLOR), 6.7 · Partial: 6.5 (plan mode CLAUDE.md:5; no clear/compact guidance) · Unknown: 6.8 · N/A: 6.3 · ratio 0.92 → 5 · caps: none`

`P7 · Score 4 · Pass: 7.1 (AGENTS.md:14), 7.2 (docs/adr/ x4), 7.3 (README.md:5-19), 7.4 (README.md:21-37), 7.7 · Partial: 7.5 (docs/ai-policy.md:67 cites missing ci.yml; docs/architecture.md:68; docs/mcp-inventory.md:65 "no database code"), 7.6 (Node 24.21 only; AGENTS.md:9 Express 5 not a dependency) · N/A: 7.8 · ratio 0.86 → 4 · caps: none`

`P8 · Score 3 · Pass: 8.1 (AGENTS.md:24-25), 8.2 (scripts/test-one.mjs), 8.4 (basis: tracked tests; no .skip/.only/xit; --passWithNoTests only in per-edit related run post-edit-check.mjs:59) · Partial: 8.8 (template evidence section; no PR bodies), 8.10 (template checklist; approvals unverifiable) · Fail: 8.5, 8.7 (no .github/workflows/, no Dependabot/CodeQL), 8.9 (React web/, no e2e) · Unknown: 8.6 · N/A: 8.3 (AI-attributed set empty, no merged PRs) · ratio 0.50 → 3 · caps: none`

`P9 · Score 2 · Pass: 9.4 (.github/CODEOWNERS:4-7), 9.8 (no AI-attributed commits) · Partial: 9.1 (policy CONTRIBUTING.md:87-95; 0 trailers in history) · Fail: 9.5 (no attributed commits to measure; only commit +21,203), 9.6 (no merged PRs) · Unknown: 9.2, 9.3 · N/A: 9.7 (no PR-level AI reviewer) · ratio 0.50 → 3 · caps: AI config by direct commit to master → max 2`

`P10 · Score 3 · Pass: 10.1, 10.2 (owner docs/ai-policy.md:15 + CODEOWNERS; 1 contributor, backup TBD), 10.4 (docs/ai-policy.md:7-14), 10.6 (CONTRIBUTING.md:50-59, docs/dev-agents.md), 10.10 (5 data files: email domains .example/.test only, 0 phone/card), 10.11 · Partial: 10.7 (one "Next review" date, no cadence), 10.9 (synthetic-only defined; denies cover only .env/secrets) · Fail: 10.3, 10.5, 10.12, 10.13 · Unknown: 10.8, 10.14 · ratio 0.58 → 3 · caps: none`

`P11 · Score 4 · Pass: 11.3 (AI_LOG.md:7-8; .claude/logs/blocked.jsonl [local]), 11.5 (AI_LOG.md:7-8 "Fix or rule added"), 11.7 · Fail: 11.1 (no telemetry config or docs) · Unknown: 11.2, 11.4 · N/A: 11.6 · ratio 0.75 → 4 · caps: none`

## Not verifiable from the repository

- 5.7 host secret scanning/push protection: `gh` not authenticated.
- 5.12 managed org policy: needs Claude Code managed settings or an org admin console.
- 6.8 spend tracking/alerts: needs the Anthropic Console or billing owner.
- 8.6 required CI checks: `gh` not authenticated (and no CI exists yet).
- 9.2 branch protection on `master`: `gh` not authenticated.
- 9.3 bot/app identities and rights: needs GitHub app and collaborator settings.
- 10.8 approved org accounts only: needs an org account policy or admin console.
- 10.14 transcript retention: needs the vendor data-retention settings.
- 11.2 cost spike alerts: needs the billing console.
- 11.4 AI-split outcome metrics: needs issue/PR labels or a metrics dashboard.

## Method note

CLIs: `gh` installed but unauthenticated (host settings Unknown); `gitleaks` used for the history scan (1 commit); `trufflehog` not installed. Sampling: the AI-attributed set is empty (0 trailers, no AI branches or bots) and there are no merged PRs, so the PR sample was empty. The PII sample covered 5 data files plus `specs/`. Local AI files reviewed: untracked 0, ignored 1 (`.claude/logs/blocked.jsonl`), modified 0. Earlier `ai-audit/` files were excluded.
The repository's own PostToolUse hook ran Prettier on this report after it was written. No other file changed.
Read-only audit; nothing was executed or modified except this report.
