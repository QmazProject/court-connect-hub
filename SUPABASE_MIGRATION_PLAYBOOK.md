# Supabase Migration Playbook

This file is a quick reference for keeping local `supabase/migrations` and the remote database in sync.

## Core Commands

```bash
supabase migration list
supabase db push
supabase db push --include-all
supabase migration repair --status applied <migration_id_1> <migration_id_2>
supabase migration repair --status reverted <migration_id_1> <migration_id_2>
```

## When To Use Each Command

### `supabase migration list`
Use this first when something looks out of sync.

It shows:
- `Local` = migration file exists in your repo
- `Remote` = migration is recorded in Supabase

If one side is blank, the history is mismatched.

### `supabase db push`
Use this to apply local migrations to the remote database.

If the CLI says the migration history is out of order or some local files must be inserted before the last remote migration, you may need `--include-all`.

### `supabase db push --include-all`
Use this when the CLI says:

```text
Found local migration files to be inserted before the last migration on remote database.
```

That means some older local migrations are missing from remote history, but later migrations already exist remotely.

### `supabase migration repair --status applied`
Use this when the database object already exists, but the migration history row is missing.

Example:

```bash
supabase migration repair --status applied 20260727070303
```

This tells Supabase to treat that migration as already applied.

### `supabase migration repair --status reverted`
Use this when you need to mark a migration as not applied in the history table.

This is usually for fixing history mismatches, not for deleting schema manually.

## Common Errors And What They Mean

### `relation "... " already exists`

Example:

```text
ERROR: relation "court_block_rules" already exists (SQLSTATE 42P07)
```

Meaning:
- The table, view, index, or sequence already exists in the remote database.
- The migration is trying to create it again.

Usually the fix is:

```bash
supabase migration repair --status applied <migration_id>
```

### `column "... " already exists`

Meaning:
- The migration is trying to add a column that is already present.
- The schema likely exists already, but the migration history is behind.

### `policy "... " already exists`

Meaning:
- A row-level security policy already exists.
- Same pattern: schema is there, history is out of sync.

### `function "... " already exists`

Meaning:
- A database function is already present.
- Usually repair history instead of rerunning the migration.

## Practical Rule

- If the remote schema already contains the object, use `supabase migration repair --status applied`.
- If the remote history is ahead of your local files, inspect carefully before changing anything.
- If `supabase migration list` shows local and remote aligned, just run `supabase db push`.

## Current Project Note

For this repo, the migration history issue was resolved by repairing the missing history rows until `supabase migration list` showed local and remote aligned.

