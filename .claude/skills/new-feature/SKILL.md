---
name: new-feature
description: Builds a new feature end to end through the repo workflow (spec-writer, human spec approval, test-writer, plan-mode implementation, done-check, code-reviewer) and prints a PR description with evidence. Use when starting a new feature, user story or capability that has no spec yet.
argument-hint: '<feature-slug> [short description]'
arguments: [feature]
---

# New feature: $feature

Request: $ARGUMENTS

Follow HARD RULE 7 (spec → tests → code → review) in order. Never skip a step, never weaken a test to get green, and stop at step 2 until the human approves.

## Steps

1. **Spec.** Call the Agent tool with `subagent_type: spec-writer`. Pass the feature slug `$feature` and the description (the rest of the request). Show the user the spec path and its open questions.
2. **Stop for approval.** Tell the user to review `specs/$feature.md`, resolve every open question and set `Status: reviewed`. End your turn here. When the user returns, re-read the spec. If it isn't `reviewed`, or open questions remain, say so and stop again.
3. **Failing tests.** Call `subagent_type: test-writer` with `specs/$feature.md`. Show its failing output. Red is expected here; the hooks will report it.
4. **Implement in plan mode.** Load `EnterPlanMode` with ToolSearch (`select:EnterPlanMode`) and enter plan mode. Plan the implementation against the spec's rules and `AT-n` list, then get approval with ExitPlanMode. Implement only what the spec says. After every edit, run `npm run test:one -- <related test file>`.
5. **Done-check.** Run `npm run typecheck && npm run lint && npm test` and keep the output.
6. **Review.** Collect the diff: `git diff`, plus the full contents of each untracked file from `git status --porcelain` (git diff leaves those out). Call `subagent_type: code-reviewer` with the diff and `specs/$feature.md`. Also call `policy-auditor` if `policies/` changed, and `security-reviewer` if `server/src/agents/`, `prompts/`, RBAC or logging changed. Fix every Blocking item, then repeat steps 5 and 6.
7. **PR description.** Fill in `.github/pull_request_template.md`: summary, spec link, AI assistance, and the real done-check output from step 5 pasted into "Verification evidence". Tick only checklist items you verified. Print it; don't open the PR (that's `/open-pr`).

## Verify before saying done

- Every `AT-n` in `specs/$feature.md` maps to a passing test named `AT-n: …`.
- The done-check passed in this session, after the last edit.
- The latest code-reviewer report has `Blocking` = none.

If any check fails, list exactly what is still open instead of calling the feature done.
