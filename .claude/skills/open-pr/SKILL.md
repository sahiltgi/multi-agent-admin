---
name: open-pr
description: Drafts a GitHub pull request for the current branch from the PR template, shows the title and body, and runs gh pr create only after the user says yes. Manual only, run with /open-pr.
argument-hint: '[base-branch]'
arguments: [base]
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git branch *) Bash(git rev-parse *) Bash(gh auth status *) Bash(gh pr view *) Bash(gh repo view *)
disallowed-tools: Edit Write NotebookEdit Agent WebFetch WebSearch
---

# Open PR

Use only git and gh. Never run `gh pr create` or `git push` before the user replies with an explicit yes.

## Context

- Branch: !`git branch --show-current 2>&1 || true`
- Upstream: !`git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>&1 || true`
- Base argument: `$base` (if empty, use the repo default below)
- Repo default branch: !`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>&1 || true`
- Uncommitted changes: !`git status --short 2>&1 || true`
- gh auth: !`gh auth status 2>&1 | head -3 || true`

PR template:

!`cat .github/pull_request_template.md 2>&1 || true`

## Steps

1. **Resolve the base.** Use `$base`, or the repo default branch shown above. Then run `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`.
2. **Stop if** any of these is true, and say which:
   - the branch is the base,
   - there are no commits ahead of the base,
   - there are uncommitted changes,
   - gh isn't authenticated,
   - there is no GitHub remote.
3. **Draft.**
   - Title: `<type>(<scope>): <summary>` (CONTRIBUTING.md).
   - Body: fill in every template section. Link the spec. Take verification evidence only from output shown in this session; otherwise write `not run`. Keep the template's "AI assistance" section.
   - If the body contains `--no-verify` or `DROP`, the guard-bash hook will block the command. Tell the user instead of rewording around it.
4. **Show and wait.** Print the title, the full body and the exact commands you'll run:
   - `git push -u origin <branch>`, only if there's no upstream,
   - `gh pr create --base <base> --title '<title>' --body-file - <<'EOF' … EOF`.

   Ask "Create this PR? (yes / edit / no)" and end your turn.

5. **Act on the reply.**
   - `yes`: run the commands. Neither is pre-approved, so in the default permission mode the user gets a second confirmation prompt.
   - Anything else: revise and show the draft again, or abort.

The tool limits in this skill's frontmatter apply only to the drafting turn. After the user's reply, the project permission rules still apply.

## Verify

Run `gh pr view --json url,title,baseRefName`. Confirm the title and base match what the user approved, then print the PR URL.
