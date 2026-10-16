---
name: new-feature
description: Builds a new feature end to end through the repo workflow (spec-writer, human spec approval by replying "approved", test-writer, plan-mode implementation, done-check, code-reviewer) and prints a PR description with evidence. Use when starting a new feature, user story or capability that has no spec yet.
argument-hint: '<feature-slug> [short description]'
arguments: [feature]
---

# New feature: $feature

Request: $ARGUMENTS

Follow HARD RULE 7 (spec → tests → code → review) in order. Never skip a step and never weaken a test to get green.

Step 2 is the only place you end your turn on purpose. After the user replies "approved", run steps 3–8 in this same session without ending your turn. The only other pauses are the plan approval in step 4 and a question you can't answer yourself (low confidence, or a conflict with a HARD RULE). The skill is never done after the spec alone, or after the tests alone.

## Steps

1. **Spec.** Call the Agent tool with `subagent_type: spec-writer`. Pass the feature slug `$feature` and the description (the rest of the request). Show the user the spec path, a short summary of its Goal, Rules and `AT-n` list, and its open questions.
2. **Stop for approval.** Ask the user to review `specs/$feature.md` and reply **"approved"**, or say what to change. End your turn here. When the user replies, re-read the spec, then:
   - **Changes requested:** apply them to the spec, show what changed, and ask for approval again. End your turn.
   - **Open questions that block a rule or an `AT-n`:** ask the user to answer them. Record the answers in the spec. Don't go on until every blocking question is answered (HARD RULE 6).
   - **"approved"**, with no blocking open questions: set the spec's status to `Status: reviewed` and append `(set on the owner's explicit "approved" on <YYYY-MM-DD>)` after the template comment on that line. Then go straight to step 3 in the same turn.
   - Anything other than an explicit approval is not approval. Ask again.
3. **Failing tests.** Call `subagent_type: test-writer` with `specs/$feature.md`. Show its failing output. Red is expected here and the hooks will report it. Don't stop; go on to step 4.
4. **Implement in plan mode.** Load `EnterPlanMode` with ToolSearch (`select:EnterPlanMode`) and enter plan mode. Plan the implementation against the spec's rules and `AT-n` list, then get approval with ExitPlanMode. Implement only what the spec says. Implementation code goes under `server/src/` (plus `shared/` or `web/src/` only where the spec says so). After every edit, run `npm run test:one -- <related test file>`.
5. **Done-check.** Run `npm run typecheck && npm run lint && npm test` and keep the output.
6. **Review.** Collect the diff: `git diff`, plus the full contents of each untracked file from `git status --porcelain` (git diff leaves those out). Call `subagent_type: code-reviewer` with the diff and `specs/$feature.md`. Also call `policy-auditor` if `policies/` changed, and `security-reviewer` if `server/src/agents/`, `prompts/`, RBAC or logging changed. Fix every Blocking item, then repeat steps 5 and 6.
7. **PR description.** Fill in `.github/pull_request_template.md`: summary, spec link, AI assistance, and the real done-check output from step 5 pasted into "Verification evidence". Tick only checklist items you verified. Print it; don't open the PR (that's `/open-pr`).
8. **Verify before saying done.** The feature is done only when all of these hold, checked with real commands in this session:
   - `git status --porcelain server/src/` lists at least one new or changed file that isn't a `*.test.ts` file.
   - Every `AT-n` in `specs/$feature.md` maps to a test named `AT-n: …`, and `npm run test:one -- <file>` passes for each of those test files.
   - The done-check passed after the last edit.
   - The latest code-reviewer report has `Blocking` = none.

If a check fails, go back to the step that fixes it and keep working. If you are truly blocked, list exactly what is still open and say the feature is not done.
