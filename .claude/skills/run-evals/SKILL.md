---
name: run-evals
description: Runs the eval suite (npm run evals, or npm run evals -- <agent>), compares each agent with its latest earlier results file in evals/results/, prints a per-agent delta table and flags regressions. Use when asked to run evals, check eval pass rates, or see whether a prompt or agent change made quality worse.
argument-hint: '[agent]'
arguments: [agent]
disable-model-invocation: true
allowed-tools: Bash(npm run evals), Bash(npm run evals -- *)
---

# Run evals

Agent: `$agent` (empty means all four: `orchestrator`, `leave`, `policy_qa`, `onboarding`)

Results files in `evals/results/` (newest first): !`ls -t evals/results/ 2>/dev/null | head -12 || true`

Never invent or estimate a number (HARD RULE 6). Never write, move or overwrite anything in `evals/results/` yourself. Only `npm run evals` adds results files there, and it never overwrites one.

## Steps

1. Run exactly `npm run evals` when `$agent` is empty, or `npm run evals -- $agent` when it names one of the four agents. For any other value, say so and stop without running anything.
   - The run spends API credit.
   - This skill's `allowed-tools` covers both forms. Outside the skill, `npm run evals -- <agent>` prompts for permission until the owner allow-lists it in `.claude/settings.json`.
   - Exit 0 means every agent that ran met its thresholds, and 1 means at least one missed. Exit 2 is a setup error or a failed write; print stderr and stop.
2. **Current files.** The current results are the files listed in the run's `evals: results written to <path>` lines, one per agent (`<date>-<agent>-<promptVersion>[-n].json`, `schemaVersion: 2`).
3. **Baseline (spec eval-runner D-23).** For each agent, the baseline is the earlier results file whose `startedAt` is the newest.
   - It must be for the same agent, whatever its `promptVersion`. A prompt bump is exactly what the comparison is for.
   - Exclude the files this run just wrote.
   - Decide "newest" by the `startedAt` inside the file, never by the file name (`-2.json` sorts before `.json`).
   - Ignore v1 files (`<date>.json`, `schemaVersion: 1`, all agents in one file).
   - If an agent has no baseline, write `No baseline` for it and still print its current rows.
4. **Table.** Use the runner's own metric rows from stdout, which are also `summary` in each file:
   - categories: `routing`, `extraction`, `verdict`, `citation`, `injection`;
   - `tag:<name>`;
   - `escalation_precision` and `escalation_recall`, for agents with a gate;
   - `overall`.

   Print one table:

   | Agent | Metric | Baseline | Current | Δ   | Threshold | Flag |
   | ----- | ------ | -------- | ------- | --- | --------- | ---- |

   Rates are percentages with one decimal place, or `n/a` when null. Flag:
   - ❌ if the runner reports `Met` = `no` for that row;
   - ⚠ for any drop from the baseline;
   - blank otherwise.

5. Under the table:
   - each agent's tokens and cost line, copied from the run output;
   - every `(agent, id)` whose status was `passed` in the baseline file and isn't `passed` now (match cases on `agent` and `id`). Write `Regressions: none` if there are none.

## Verify before reporting

- Name the command you ran, each current file and each baseline file.
- Every number in the table comes from the run output or a results file. A missing value is shown as `n/a`, never filled in.
- Your summary line counts the ⚠ and ❌ rows correctly and states the exit code.
