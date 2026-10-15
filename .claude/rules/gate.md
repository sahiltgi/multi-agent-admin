---
paths:
  - 'server/src/gate/**'
---

# Policy Gate rules

- Pure functions only. No I/O (fs, network, DB), no `Date.now()` or `new Date()` without an argument, no `Math.random()`, no `process.env`, no LLM SDK imports.
- The caller passes today's date (and any other context) in as an argument.
- Never import from `server/src/agents/` or from DB or HTTP modules. The gate depends only on Zod schemas and the parsed policy data it is given.
- Every gate returns `{ verdict, ruleResults[], reason, policyVersion, policyHash }`. Each rule result names the rule, pass/fail and a human-readable reason.
- Leave precedence is fixed: `RETURN_TO_EMPLOYEE` → `ESCALATE_TO_HR` → `ROUTE_TO_MANAGER_WITH_FLAGS` → `ROUTE_TO_MANAGER`.
- Model self-reported confidence is never an input to any check.
- Every rule has unit tests (pass, fail and boundary cases) and at least one eval case.
- A change to policy YAML or its schema changes tests or evals in the same commit.
- Same input always gives the same output. Test determinism explicitly where it matters.
