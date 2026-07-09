---
name: git-submit-push
description: Finish AnoClaw work by reviewing the diff, staging only intentional changes, creating a clear git commit, and pushing the current branch. Use after verified code, docs, config, or skill changes; before ending a session with completed work; or whenever the user asks to submit, commit, push, publish, or save work to GitHub. Replaces the old Obsidian work-log habit; do not write Obsidian notes.
---

# Git Submit Push

## Overview

Use Git as the project completion record. After meaningful AnoClaw changes are implemented and verified, commit the exact intended diff and push it to the configured remote.
`DESIGN.md` is retired. Do not recreate it, keep notes in it, or treat its absence as a problem; durable guidance belongs in `AGENTS.md` or focused docs under `docs/`.

## Workflow

1. Inspect the worktree with `git status --short --branch` and review the relevant diff.
2. Confirm generated or unrelated files are not included. Do not stage user changes that are outside the completed task.
3. Run appropriate verification before committing. For code changes, prefer the focused tests first, then the project-required build/test flow when applicable.
4. Stage only the intended files with explicit paths.
5. Commit with a concise imperative message that describes the user-visible or engineering outcome.
6. Push the current branch. If the branch has no upstream, use `git push -u origin HEAD`.
7. Report the commit hash, pushed branch, and verification results.

## Rules

- Never use Obsidian, vault notes, or local REST work logs as the completion record.
- Do not use `DESIGN.md`; include its deletion when the current task is retiring legacy guidance.
- Do not commit secrets, private config, local data, build caches, or unrelated edits.
- Do not amend, rebase, force-push, or rewrite history unless the user explicitly asks.
- If tests or builds fail, do not commit unless the user explicitly accepts the failing state.
- If pushing fails because credentials, permissions, or network access are unavailable, report the exact blocker and leave the commit local.
- Keep final user-facing summaries short: what changed, what passed, commit hash, branch, push status.
