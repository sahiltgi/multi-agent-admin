# Contributing

Read [AGENTS.md](AGENTS.md) for the coding rules and HARD RULES, and [docs/brief.md](docs/brief.md) for what we are building.

## Setup

```sh
nvm use          # Node version from .nvmrc; .npmrc sets engine-strict, so other versions fail
npm install      # the prepare script runs husky, which installs the git hooks in .husky/
```

### Secret scanning

The pre-commit hook runs [gitleaks](https://github.com/gitleaks/gitleaks) on staged changes and fails if gitleaks isn't installed. CI uses version 8.30.1, so install the same one and verify the checksum before using it:

```sh
V=8.30.1
base=https://github.com/gitleaks/gitleaks/releases/download/v$V
curl -fsSLO "$base/gitleaks_${V}_linux_x64.tar.gz"
curl -fsSLO "$base/gitleaks_${V}_checksums.txt"
grep " gitleaks_${V}_linux_x64.tar.gz\$" "gitleaks_${V}_checksums.txt" | sha256sum -c -
tar -xzf "gitleaks_${V}_linux_x64.tar.gz" gitleaks
install -m 0755 gitleaks ~/.local/bin/gitleaks
gitleaks version
```

On macOS use the `darwin_arm64` or `darwin_x64` archive and `shasum -a 256 -c -`.

If gitleaks flags something, remove the secret from the change and rotate it. Don't silence the finding.

## Commands

Run from the repo root. These are the only scripts defined in the `package.json` files.

| Command                                      | What it does                                            |
| -------------------------------------------- | ------------------------------------------------------- |
| `npm run typecheck`                          | `tsc -b` across tools, server and web                   |
| `npm run lint`                               | ESLint, zero warnings allowed                           |
| `npm run format:check`                       | Prettier check                                          |
| `npm test`                                   | Vitest, server (node) and web (jsdom) projects          |
| `npm run test:one -- <path/to/file.test.ts>` | One test file; exits 2 if the path is missing           |
| `npm run test:integration`                   | Integration tests; needs the compose MongoDB and `.env` |
| `npm run seed`                               | Replaces the demo data in MongoDB (refuses production)  |
| `npm run build`                              | Builds every workspace (`server/dist`, `web/dist`)      |
| `npm run evals`                              | Placeholder: prints a message, no eval cases yet        |
| `npm run dev -w web`                         | Vite dev server for the UI                              |
| `npm run preview -w web`                     | Serves `web/dist` (run `npm run build` first)           |
| `npm run prepare`                            | Installs the husky git hooks; `npm install` runs it     |

## Claude Code setup

[CLAUDE.md](CLAUDE.md) imports [AGENTS.md](AGENTS.md) and stays small, because both load at the start of every session. Everything else loads only when needed:

- Path-scoped rules in `.claude/rules/` (`gate.md`, `agents.md`, `web.md`) load when Claude reads or edits matching files.
- Dev subagents are in `.claude/agents/` (see [docs/dev-agents.md](docs/dev-agents.md)).
- Workflow skills are in `.claude/skills/`: `/new-feature`, `/run-evals`, `/change-policy`, `/fix-issue`, and `/open-pr` (manual-only).
- Personal, uncommitted notes go in `CLAUDE.local.md` (gitignored).

Keep situational guidance out of AGENTS.md and CLAUDE.md. Put it in a path-scoped rule, a skill or a doc.

## Workflow

1. **Spec → tests → code → review** (HARD RULE 7). Write the spec in `specs/` first.
2. **One feature per branch**, named `<type>/<short-slug>`, e.g. `feat/leave-balance-check`.
3. **Keep PRs under ~400 changed lines**, not counting `package-lock.json`. Split larger work into stacked PRs.
4. Run the done-check before opening a PR, and paste its output into the PR template:
   ```sh
   npm run typecheck && npm run lint && npm test
   ```
5. Changes under the paths in [.github/CODEOWNERS](.github/CODEOWNERS) need the code owner's review.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <imperative summary, max ~72 chars>

<optional body: what and why>

<optional trailers>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`, `perf`.
Scopes follow the module: `gate`, `agents`, `server`, `web`, `policies`, `prompts`, `evals`, `hooks`.

**AI-assisted commits** end with a co-author trailer, separated from the body by a blank line:

```text
feat(gate): reject leave requests that overlap a blackout period

Co-authored-by: Claude <noreply@anthropic.com>
```

Git and GitHub recognise a trailer only in the `Name <email>` form, so keep the email. Add the trailer whenever an AI tool wrote or substantially changed code in the commit.

## Hooks

`.husky/pre-commit` runs lint-staged (Prettier and ESLint on staged files), then `gitleaks git --pre-commit --staged`. Never skip it with `--no-verify` or `-n`. Fix what it reports.
