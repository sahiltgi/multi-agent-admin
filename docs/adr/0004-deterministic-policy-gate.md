# ADR-0004: Deterministic Policy Gate

Status: Accepted · 2026-10-08

## Context

The pitch is that the system is safe by structure, not because the model resists persuasion. The LLM must never approve anything (HARD RULE 1). Every verdict has to be reproducible and explainable to a manager or an auditor.

## Decision

Verdicts come only from pure TypeScript functions in `server/src/gate/`, evaluated over versioned YAML rules in `policies/` that Zod validates. Each gate returns `{ verdict, ruleResults[], reason, policyVersion, policyHash }`.

The gate has no I/O, no clock (today's date is passed in), no randomness and no LLM calls. Model confidence is never an input. Code copies the verdict onto the card.

## Consequences

- The same input always gives the same verdict. It can be unit-tested, and `policyHash` ties each verdict to the exact rules that produced it.
- Prompt injection can't change a verdict, because the model has no approve tool and no path to the gate's output.
- Rules can only express what the YAML schema allows. A new kind of check means a code change plus tests.
- A `policies/` change must change tests or evals in the same commit (HARD RULE 5). The `guard-files` hook enforces this.
