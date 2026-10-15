---
name: run-evals
description: Runs the eval suite (npm run evals), compares it with the latest results file in evals/results/, prints a per-agent delta table and flags regressions. Use when asked to run evals, check eval pass rates, or see whether a prompt or agent change made quality worse.
argument-hint: '[agent]'
arguments: [agent]
allowed-tools: Bash(npm run evals)
---

# Run evals

Agent filter: `$agent` (empty means all agents)

Latest baseline in `evals/results/`: !`ls -t evals/results/ 2>/dev/null | head -1 || true`

Never invent or estimate a number (HARD RULE 6). Never write, move or overwrite anything in `evals/results/`; this skill only reads results.

## Steps

1. Run exactly `npm run evals`. Other variants aren't on the allow list, and the script doesn't take an agent flag yet. The agent filter only narrows the table in step 3.
2. Read the baseline file named above as the previous run. If there is no baseline, or the eval output has no per-case or per-agent results (the script is still a placeholder), print the raw output, say `No baseline` or `No structured results`, and stop.
3. Print one table, filtered to `$agent` if it is set:

   | Agent | Category | Baseline pass % | Current pass % | Δ   | Flag |
   | ----- | -------- | --------------- | -------------- | --- | ---- |

   Categories are `routing`, `extraction`, `verdict`, `citation` and `injection`. Flag:
   - ⚠ for any drop,
   - ❌ if the current rate falls below the threshold in the `evals/` thresholds file, when that file exists,
   - blank otherwise.

4. Under the table, list every case id that passed in the baseline and fails now. Write `Regressions: none` if there are none.

## Verify before reporting

- Name the baseline file and the command you ran.
- Every number in the table comes from the run output or the baseline file. A missing value is shown as `n/a`, never filled in.
- Your summary line counts the ⚠ and ❌ rows correctly.
