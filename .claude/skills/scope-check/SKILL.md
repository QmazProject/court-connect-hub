---
name: scope-check
description: Audit the working tree's diff for changes outside the requested scope — unrelated formatting, drive-by refactors, or files that shouldn't be touched — and revert just those hunks. Run this before saying a task is done, before opening a PR, and after any subagent finishes an edit. Triggers on "check the diff", "make sure nothing unrelated changed", "is this diff clean", "scope check", "revert unrelated changes".
---

# Scope check

Before calling an edit task finished, verify the diff contains only what the task asked for. A correct fix wrapped in unrelated formatting churn is still a bad diff — it's harder to review, harder to blame later, and more likely to collide with someone else's in-flight change.

## This project's style (don't fight it, don't "fix" it)

- Prettier: `printWidth: 100`, double quotes, semicolons on, trailing commas everywhere (`.prettierrc`).
- ESLint runs `eslint-plugin-prettier`, so style violations show up as lint errors — but that's a reason to match existing style in the lines you touch, not a reason to reformat the rest of the file.
- `npm run format` / `npm run lint` are whole-repo commands. Never run them as a cleanup step after a small fix — they will rewrite every file that happens to be out of date with Prettier, producing a diff with nothing to do with your task.

## Procedure

1. `git status` — list every file that changed. For each one, ask: did the task actually require touching this file? If not, find out why it changed (an editor auto-format on save is the usual cause) and revert it.
2. `git diff` (or per-file `git diff -- <path>`) — read every hunk, not just the ones you expect. Look specifically for:
   - Whitespace/indentation-only changes on lines you didn't otherwise edit
   - Reordered imports, object keys, or JSX props
   - Quote style, trailing-comma, or line-wrap changes on untouched logic
   - Renamed variables/functions beyond what the task asked for
   - Files with a diff of only formatting and zero behavior change
3. For anything that fails that check:
   - If the unrelated change is a whole file with no intended edits in it: `git checkout -- <path>` to fully discard it.
   - If a file mixes a real change with unrelated noise: use `git diff -- <path>` to see exactly what moved, then hand-edit the file back to the original text for the unrelated lines (or `git checkout -p <path>` to interactively drop just the noisy hunks), keeping the intended change intact.
4. Re-run `git diff` after cleanup and confirm every remaining hunk maps to something the task explicitly asked for.
5. If a formatter or IDE keeps re-touching unrelated lines every time you save, say so rather than repeatedly re-cleaning the diff — that's a tooling problem (format-on-save scoped to the whole file) worth fixing once rather than working around every time.

## When wider changes are legitimate

Don't over-apply this — if the task *is* "refactor this module" or "run prettier across the repo," a wide diff is the point. This check is for the common case: a targeted fix or feature that should produce a targeted diff.

## Reporting

State which files ended up in the diff and that each hunk was checked against the request. If you reverted anything, say what and why (e.g. "reverted an auto-formatting pass on `src/lib/utils.ts` that reordered imports; kept the one-line fix in `computeDiscount`").
