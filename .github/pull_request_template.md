## Summary

<!-- What changes and why, in two or three sentences. -->

## Spec

<!-- Link the spec this PR implements, e.g. specs/leave-request.md. Every feature has a spec first (HARD RULE 7). -->

## AI assistance

<!-- Tool and model used (e.g. Claude Code, Opus), what it did, and what you wrote or changed by hand. Write "None" if no AI tool was used. -->

- Tool:
- What it did:
- What I did:

## Verification evidence

<!-- Paste the real output. A claim without output doesn't count. -->

```text
$ npm run typecheck && npm run lint && npm test

```

## Reviewer checklist

- [ ] Spec is linked and the change matches it
- [ ] Tests were added or changed with every behaviour change
- [ ] Verdicts come only from the Policy Gate; the LLM approves nothing (HARD RULE 1)
- [ ] `server/src/gate/` stays pure: no I/O, no `Date.now()`, no LLM calls (HARD RULE 4)
- [ ] Any `policies/` change also changes tests or evals (HARD RULE 5)
- [ ] Zod parses every new boundary (HTTP, tools, agent output, YAML, env)
- [ ] Prompts live in `prompts/`, not inline strings
- [ ] Synthetic data only; no secrets, real names, emails or IDs
- [ ] Under ~400 changed lines (lockfile excluded) and one feature only
