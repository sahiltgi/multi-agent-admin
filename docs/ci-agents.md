# CI agents

Every headless model run in CI (brief §9). For each one this page lists the trigger, permissions, tools, limits and secrets. The workflows live in `.github/workflows/`, which a human edits (AGENTS.md). Change this page in the same PR as any change to those files. The spec is [specs/ci-agents.md](../specs/ci-agents.md).

| Workflow        | Job         | What runs headless                                         | Secret (repository)        |
| --------------- | ----------- | ---------------------------------------------------------- | -------------------------- |
| `evals.yml`     | `evals`     | `npm run evals -- <agent>` for orchestrator and leave      | `ANTHROPIC_API_KEY_EVALS`  |
| `ai-review.yml` | `ai-review` | Claude Code via `anthropics/claude-code-action`, PR review | `ANTHROPIC_API_KEY_REVIEW` |

The two keys are separate repository secrets, each a different Anthropic key with its own spend limit. GitHub Environments would scope each key to one job, but this is a private repo on a personal GitHub Free account, where Environments aren't available. A repository secret can be read by any workflow in the repo, including one edited on a pushed branch. Only the two model jobs reference the keys, and only on the steps that need them. See Caveats.

`ci.yml` (verify with `npm audit`, and gitleaks) calls no model and uses no secret, so it isn't listed here. See [ai-policy.md](ai-policy.md#git-hooks-and-ci).

**Two agents only, for now:** every case in `evals/policy_qa/cases.jsonl` and `evals/onboarding/cases.jsonl` is tagged `blocked:no-runner`, so the runner skips them. An agent with no scored case fails its threshold closed (`server/src/evals/summary.ts`), so a full `npm run evals` would always exit 1. CI therefore runs only `npm run evals -- orchestrator` and `npm run evals -- leave`. Once those cases can run, add a step for each agent, or go back to a single `npm run evals`, and raise the job timeout (see Limits).

## evals

[`.github/workflows/evals.yml`](../.github/workflows/evals.yml) runs the eval suite the way `npm run evals -- <agent>` does locally (spec eval-runner), one step per agent. The leave step runs even if the orchestrator step misses its thresholds.

### Trigger

- `pull_request` into `master` that changes `prompts/**`, `server/src/agents/**`, `server/src/gate/**` or `policies/**`. Changes to `evals/**`, `server/src/evals/**` (the runner) or the workflow file trigger it too. `prompts/ci/**` is excluded, because CI-only prompts don't affect the HR agents.
- `schedule`: nightly at 03:17 UTC. GitHub runs schedules only from the default branch, so the default branch must be `master` (see Setup).
- `workflow_dispatch`: run by hand from the Actions tab.
- Fork PRs: the job is skipped (`if:` checks that the head repo is this repo). It never uses `pull_request_target`.
- `concurrency` per ref with `cancel-in-progress`: a new push cancels the older run, because each run spends credit.

### Permissions

- Workflow: `permissions: {}`. Job: `contents: read`, enough to check out the repo.
- `actions/checkout` runs with `persist-credentials: false`, so no token stays in the git config.
- Every action is pinned by commit SHA.

### Tools

The runner drives the production agents in-process (`server/src/evals/drivers.ts`) against a fresh in-memory, seeded world per case (`server/src/evals/world.ts`). It uses no MongoDB, no socket and no network apart from the model API. Each agent gets only its config allowlist:

| Agent        | Model               | Tools (allowlist)                                                                           |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------- |
| orchestrator | `claude-haiku-5-5`  | `route`                                                                                     |
| leave        | `claude-sonnet-5-5` | `get_my_balance`, `get_holidays`, `get_team_calendar`, `submit_to_gate`, `hand_back`        |
| policy_qa    | `claude-sonnet-5-5` | none: one model call, no tool loop                                                          |
| onboarding   | `claude-sonnet-5-5` | `get_template`, `create_checklist`, `propose_deviation` (notes mode: no `create_checklist`) |

Sources: `server/src/agents/*/config.ts`, `server/src/agents/leave/schemas.ts` and `server/src/agents/onboarding/schemas.ts`. No tool approves anything; verdicts come from the Policy Gate (HARD RULE 1).

### Limits

- Job: `timeout-minutes: 75`. This is deliberately longer than the 30 minutes first planned: see the worst case below.
- Cases run one at a time (spec eval-runner, rule 7). The runner never retries a case (`server/src/evals/model.ts`). The Anthropic SDK's own request retries still apply inside a case's `timeoutMs`, because `server/src/agents/anthropic-client.ts` doesn't set `maxRetries`.
- Per-run budgets from the agent configs:

| Agent        | `maxTurns` | `timeoutMs` | `maxTokens` per call | effort |
| ------------ | ---------- | ----------- | -------------------- | ------ |
| orchestrator | 3          | 30000       | 1024                 | low    |
| leave        | 8          | 60000       | 1024                 | low    |
| policy_qa    | 1 call     | 60000       | 1024                 | low    |
| onboarding   | 8          | 60000       | 1024                 | low    |

There are 40 cases per agent today, and CI runs only the orchestrator and leave cases (see above). If every runnable case used its full `timeoutMs`, the run would take 40 × 30 s + 40 × 60 s = 60 min, plus `npm ci`. That is why the steps have their own timeouts (25 and 45 minutes) inside a 75-minute job timeout. A step timeout is a step failure, so the upload still runs and keeps any results file already written. Raise it when the blocked cases start running: with all four agents at their limit, the run would take 140 min. Each agent run writes its results file only when it finishes. A step that times out leaves no file for that agent. If the whole job times out, it is cancelled and nothing is uploaded.

### Secrets

- The repository secret `ANTHROPIC_API_KEY_EVALS`, set as `ANTHROPIC_API_KEY` in `env:` on the two `npm run evals -- <agent>` steps only. `npm ci` and the upload step never see it.
- CI has no `.env`. `--env-file-if-exists` skips it, and the runner fails with exit 2 if the key is empty.

### Outputs

- Exit code per step: 0 means the agent met `evals/thresholds.yaml`, 1 means it missed (the job fails), and 2 means a setup error.
- Artifact `evals-results-<run id>`: `evals/results/*.json`, one file per agent run (`<date>-<agent>-<promptVersion>.json`) with pass rates, escalation precision and recall, tokens and cost (from `evals/pricing.yaml`). It is kept for 30 days, and also uploaded when thresholds are missed. Results files hold no case text (spec eval-runner, rule 19).
- CI never commits results back. To track a run over time, download the artifact. To compare with a baseline, run `/run-evals` locally.

## ai-review

[`.github/workflows/ai-review.yml`](../.github/workflows/ai-review.yml) is an optional read-only review. It may comment on the PR, but it can't push, approve or request changes. It is advisory: a human still reviews every PR.

### Trigger

- `pull_request` into `master`: `opened`, `synchronize`, `ready_for_review`, `reopened`.
- Skipped for fork PRs, drafts and PRs opened by bots (the action refuses non-human actors anyway).
- `concurrency` per PR with `cancel-in-progress`.

### Permissions

- Workflow: `permissions: {}`. Job: `contents: read` and `pull-requests: write` (PR and inline comments).
- `github_token: ${{ secrets.GITHUB_TOKEN }}` is passed explicitly. Without it the action exchanges an OIDC token for a Claude GitHub App token, and that token can have `contents: write`. The job doesn't grant `id-token: write`, so that exchange can't happen.
- With `contents: read`, `git push` fails even if it were attempted.
- Checkout uses `persist-credentials: false` and `fetch-depth: 1`. The action then writes the job's `GITHUB_TOKEN` into the `origin` URL in `.git/config` itself. The reviewer has no local file access (see Tools), so it can't read that file.
- `anthropics/claude-code-action` is pinned to the v1.0.247 commit SHA.

### Tools

The action runs in agent mode (a `prompt` is set). It starts only the MCP servers that `--allowedTools` names: the GitHub server and the inline-comment server. Commit signing is off, so there's no file-ops or commit server. The GitHub server exposes all of its tools, so three separate controls keep the reviewer comment-only:

1. Claude Code denies any tool that isn't in `--allowedTools`.
2. The GitHub server's write tools are also denied by name.
3. The job token can't push (`contents: read`), and the repo setting "Allow GitHub Actions to create and approve pull requests" is off (`can_approve_pull_request_reviews: false`), so even an approving review call would fail. Keep it off.

- Allowed:
  - reading through the GitHub API: `mcp__github__get_pull_request`, `mcp__github__get_pull_request_diff`, `mcp__github__get_pull_request_files`, `mcp__github__get_file_contents`;
  - commenting: `mcp__github__add_issue_comment` (the summary) and `mcp__github_inline_comment__create_inline_comment`.
- Denied: `Bash`, `Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `NotebookRead`, `WebFetch`, `WebSearch`, `Task`, `Agent`. Read, Grep and Glob need no permission by default, so they are denied explicitly. Also denied: the GitHub server's write tools (create_and_submit_pull_request_review, create_pending_pull_request_review, submit_pending_pull_request_review, add_comment_to_pending_review, delete_pending_pull_request_review, merge_pull_request, update_pull_request, update_pull_request_branch, create_pull_request, request_copilot_review, create_branch, create_or_update_file, delete_file, push_files, create_repository, fork_repository, create_issue, update_issue, assign_copilot_to_issue).
- **No shell and no local file access, by design.** On the runner, the Anthropic key is in Claude's process env, the MCP config (with the GitHub token) is on its command line, and the job token is in `.git/config`. Without Bash or file tools, the reviewer has no way to read any of them and post them in a comment, even if a PR tricks it. That's why there's no env scrub, no `bubblewrap` and no path deny.
- The `mcp__github__*` tools come from the GitHub MCP server, which the action runs in Docker (`ghcr.io/github/github-mcp-server:sha-23fa0dd`, v0.17.1). Its only env is the job's `GITHUB_TOKEN` and the GitHub host.
- `--strict-mcp-config`: Claude Code uses only the action's MCP servers, never a `.mcp.json` in the repo (there is none today). The action also restores `.claude/` and `.mcp.json` from the base branch before Claude starts.
- AGENTS.md is read from `master` (`refs/heads/master`), so a PR can't rewrite the rules it is reviewed against.
- `add_issue_comment` takes any issue number. The prompt limits it to this PR, and an injected comment elsewhere could only be text. The inline-comment server is fixed to this PR by the action.
- `--setting-sources user`: Claude Code does not load the PR branch's `.claude/settings.json`. That stops hooks from the PR's own branch running in a job that holds the key. It also skips the Stop hook, which would run the test suite.
- The prompt is in [`prompts/ci/ai-review.md`](../prompts/ci/ai-review.md). A workflow step reads it from the PR checkout, and the job fails if the file is missing or empty. The workflow adds the repo and PR number in front. It tells Claude to treat the PR text and the files as data (HARD RULE 3) and to comment only.

### Limits

- `--max-turns 15`. That is deliberately more than the 10 first planned, so there's room to read the diff, post several inline comments and a summary.
- Job: `timeout-minutes: 15`.

### Secrets

- The repository secret `ANTHROPIC_API_KEY_REVIEW`, passed as the action's `anthropic_api_key`. It is a different key from the evals key, with its own spend limit.
- `GITHUB_TOKEN`: the job's own token, scoped as above, which expires when the job ends.

## Setup (human, once)

1. Make `master` the default branch (Settings → General). The nightly evals don't run until then.
2. In the Anthropic Console, create two workspaces (e.g. `ci-evals` and `ci-review`), each with a monthly spend limit, and one API key in each.
3. Add both keys as repository secrets (Settings → Secrets and variables → Actions): `ANTHROPIC_API_KEY_EVALS` and `ANTHROPIC_API_KEY_REVIEW`.
4. Commit `.github/workflows/ci.yml`, `.github/workflows/evals.yml` and `.github/workflows/ai-review.yml`.

## Caveats

- **Path filters and required checks.** `evals` doesn't run on PRs outside its paths. If you make it a required check, those PRs wait on it forever. Keep it optional, or add a no-op job with the same name for the other paths.
- **Same-repo PR code runs with the key.** Fork PRs are skipped for this reason. A `pull_request` run uses the PR branch's copy of the code and of the workflow file. So anyone who can push a branch here can:
  - change the agent code that `evals` runs with the key,
  - loosen `ai-review`'s tool lists,
  - add a job that reads either repository secret.

  CODEOWNERS and branch protection cover what merges, not what runs on a PR. Each key therefore has its own spend limit. If the repo gains collaborators, move to GitHub Pro or an organisation and put the keys back into Environments, with required reviewers.

- **Dependabot PRs** get no Actions secrets. They rarely touch the eval paths. If one does, the eval steps exit 2.
- **No CodeQL or dependency review.** Both need GitHub Code Security, which a private repo on a personal account can't have. `npm audit --audit-level=high` in `verify` covers known-vulnerable packages. Strict TypeScript and ESLint cover some of what CodeQL would find. Add both jobs back if the repo moves to an organisation with Code Security, or is made public.
