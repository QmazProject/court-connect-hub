# Project Agent Instructions

## Change Discipline

* Make the smallest safe change necessary to complete the requested task.
* Do not reformat entire files when implementing a feature or bug fix.
* Do not mix unrelated refactoring, formatting, renaming, cleanup, or dependency changes into feature work.
* Preserve the existing code style in areas that are not being modified.
* Before finishing, inspect the git diff and remove unrelated changes.
* If a formatter creates substantial unrelated churn because an existing file is not formatter-clean, revert that unrelated formatting and keep the diff focused.
* Separate cleanup/refactoring work from feature implementation unless explicitly requested.

## Before Changing Code

* Inspect the relevant implementation and understand the existing data flow before editing.
* Search for existing related functions, components, types, queries, and business rules before creating new ones.
* Prefer existing project patterns over introducing a new pattern.
* Do not assume that similarly named logic has the same business definition; verify how it is currently used.

## Business Logic Consistency

* When changing a business rule, search the project for all places that implement or depend on that rule.
* Keep the same business definition consistent across UI, queries, aggregations, reports, and dashboard metrics.
* If two areas intentionally use different definitions, make that distinction explicit in the code.

## Database and Security

* Treat database migrations, permissions, RLS policies, triggers, RPCs, and SECURITY DEFINER functions as high-impact changes.
* Inspect existing security patterns before changing database privileges.
* Do not grant broader database permissions merely to make an error disappear.
* Prefer the narrowest permission or execution-context change that solves the problem.
* Do not apply untested destructive or high-impact SQL changes.
* Clearly report when a migration was parsed but not actually executed against a database.

## Testing and Verification

After making changes:

1. Run the relevant tests.
2. Run TypeScript/type checking when applicable.
3. Run the production build when applicable.
4. Run lint when applicable.
5. Inspect the final git diff.
6. Confirm there are no unrelated changes.

Do not claim a feature is fully verified when only static checks passed. Clearly distinguish:

* Code verified locally
* Tests passed
* Build passed
* Database migration parsed but not executed
* Browser/UI behavior not manually verified

## Git Discipline

* Do not rewrite published git history unless explicitly requested.
* Do not force-push unless explicitly requested.
* Prefer normal commits and additive history.
* Never reset, delete, or discard the user's existing work without explicit permission.
* Before committing, inspect `git status` and `git diff`.
* Keep commits focused on the task being implemented.

## Communication

When completing a task, report:

* What changed
* Files changed
* Important implementation decisions
* Tests/checks performed
* Anything not verified
* Any known limitations or follow-up work

Do not hide unresolved issues merely because the main implementation is complete.
