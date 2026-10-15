# Spec: <feature name>

- **Status:** draft <!-- draft | reviewed. A human sets "reviewed" before test-writer runs. -->
- **Brief:** §<n> <!-- section(s) of docs/brief.md this refines -->
- **Owner:** <github handle>

## Goal

<One or two sentences: what this feature does and for whom.>

## Non-goals

- <What this spec deliberately leaves out.>

## Inputs and outputs

Zod sketches, not final code. Shared schemas go in `shared/` when the code lands.

```ts
const ExampleInput = z.object({
  // field: z.string().min(1),
});

const ExampleOutput = z.object({
  // verdict: z.enum([...]),
});
```

## Rules

Numbered. Name the Policy Gate rule id where one applies.

1. <Rule> (gate rule: `<rule_id>` | none)

## Edge cases

- <Missing or malformed input, boundaries, half days, weekends/holidays, wrong role, injection text.>

## Acceptance tests

Each rule has at least one. test-writer turns each into a Vitest case named `AT-n: …`.

- **AT-1:** Given <state>, when <action>, then <observable result>.

## Eval cases

Each rule has at least one. Category: `routing | extraction | verdict | citation | injection`.

| ID   | Category | Input (synthetic) | Expected |
| ---- | -------- | ----------------- | -------- |
| EV-1 |          |                   |          |

## Open questions

- <Anything the brief doesn't settle or where docs disagree. Must be empty before Status: reviewed.>
