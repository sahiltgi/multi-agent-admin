---
name: change-policy
description: Changes a Policy Gate rule in policies/*.yaml safely. It updates gate tests and evals first, then edits the YAML, bumps the policy version and runs policy-auditor. Use when asked to change a leave or HR policy rule, threshold, limit or precedence.
argument-hint: '<rule-id and the change, e.g. max_consecutive_days 10 -> 15>'
---

# Change policy

Requested change: $ARGUMENTS

Order matters (HARD RULE 5): tests and evals change before the YAML. The `guard-files` hook blocks the YAML edit until a gate test or `evals/` file has changed. Follow its message; don't work around it.

## Steps

1. **Plan first.** Load `EnterPlanMode` with ToolSearch (`select:EnterPlanMode`) and enter plan mode, as CLAUDE.md requires for `policies/` and `server/src/gate/`.
   - Find the rule in `policies/`, the Zod policy schema, the gate code that reads the rule, and every spec that mentions it.
   - If `policies/` doesn't exist yet, stop and suggest `/new-feature`.
   - If a `Status: reviewed` spec states the old value, ask the user before going on.
   - Get approval with ExitPlanMode.
2. **Tests and evals first.**
   - In `server/src/gate/**/*.test.ts`, add or update pass, fail and boundary cases for the new value.
   - Under `evals/`, add or update at least one eval case that names the rule id.
   - Run `npm run test:one -- <test file>` and show the expected red.
3. **YAML.** Edit only the rule named in the request.
4. **Version.** Bump the policy version in the field and format the policy schema defines. Don't guess the key. If the bump level (major, minor or patch) is unclear, ask.
5. **Run.** Run `npm run test:one -- <test file>` until it's green, then `npm run typecheck && npm run lint && npm test`.
6. **Audit.** Collect the diff (`git diff`, plus the full contents of each untracked file from `git status --porcelain`). Call the Agent tool with `subagent_type: policy-auditor` and that diff.

## Verify before saying done

- The policy-auditor table shows `Covered: yes` for every changed rule.
- The policy version differs from the committed one (`git diff -- policies/`).
- The done-check passed after the last edit.

Report any `no` cell and fix it. Never call the change done while a cell is uncovered.
