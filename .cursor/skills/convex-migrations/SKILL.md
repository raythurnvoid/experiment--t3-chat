---
name: convex-migrations
description: Implements Convex data/schema migrations with safe two-phase rollout (compat schema -> run migration -> tighten schema). Use when user asks to rename fields, change field types, backfill data, remove legacy fields, or create/run migration scripts in packages/app/convex.
---

# Convex Migrations

Use this skill for migration tasks in `packages/app/convex`.

## When to use

- Field rename (`created_by` -> `createdBy`)
- Type change (string -> `v.id("users")`)
- Backfill/default values for existing rows
- Dropping deprecated fields after rollout
- Requests mentioning Convex migration scripts or migration commands

## Project defaults

- Convex code root: `packages/app/convex`
- Package manager: `pnpm`
- Migration component package: `@convex-dev/migrations`
- Convex app config file: `packages/app/convex/convex.config.ts`
- Migration file location: `packages/app/convex/migrations.ts`

## Required clarifications (ask before coding if ambiguous)

- Which table(s) are in scope?
- Which field is source vs destination?
- Target type of the new field?
- Backfill value/rule (constant or derived)?
- Should this be dev-only run now, or just prepare migration code?

## Implementation workflow

Copy this checklist and update status while working:

```md
Migration Progress:
- [ ] Confirm scope and exact field mapping
- [ ] Add/wire `@convex-dev/migrations` component
- [ ] Add migration definition + runner in `convex/migrations.ts`
- [ ] Update schema to compatibility state (if needed)
- [ ] Update write paths to emit new field
- [ ] Run migration
- [ ] Verify migration result
- [ ] Tighten schema (remove legacy field / enforce required new field)
```

## Two-phase rollout (default)

### Phase A: Compatibility

1. Schema accepts both old and new representations.
2. Write paths emit the new field.
3. Migration script backfills existing docs and removes old field.

### Phase B: Tighten

1. New field becomes required.
2. Old field removed from schema and code paths.

## Code templates

### `convex.config.ts` wiring

```ts
import migrations from "@convex-dev/migrations/convex.config";
app.use(migrations);
```

### `convex/migrations.ts` skeleton

```ts
import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { DataModel } from "./_generated/dataModel.js";

export const migrations = new Migrations<DataModel>(components.migrations);

export const migrate_example = migrations.define({
	table: "your_table",
	migrateOne: () => ({
		newField: "value",
		old_field: undefined,
	}),
});

export const run = migrations.runner();
export const run_migrate_example = migrations.runner(internal.migrations.migrate_example);
```

## Commands

From `packages/app`:

```bash
pnpm add @convex-dev/migrations
pnpm exec convex run migrations:run_<migration_name>
```

Optional status check:

```bash
pnpm exec convex run --component migrations lib:getStatus
```

## Verification

- Migration command reports finished/already done.
- Schema compiles with tightened shape.
- Updated write paths no longer write legacy field.
- No diagnostics in modified files.

## Real-run lessons (important)

- For field renames that affect indexes, treat index changes as first-class migration work:
	- Add new index names for new field names.
	- Move query callsites to new indexes.
	- Remove old indexes only in tighten phase.
- Keep API contract renames explicit and separate from DB renames:
	- DB row fields: e.g. `workspace_id` -> `workspaceId`.
	- Convex args/returns: e.g. `workspace_id` -> `workspaceId`, `page_id` -> `pageId`.
	- Preserve semantic distinction between client-generated id and Convex doc id.
- Write migrations to be idempotent and "prefer existing new value":
	- Use `newField ?? old_field` patterns.
	- Unset legacy field with `old_field: undefined`.
- Run migration before tightening required fields, then re-check generated types:
	- `pnpm exec convex run migrations:run_<name>`
	- Expect `_generated` typings to update after schema/function changes.
- Add focused runtime checks for boot-critical flows after API key renames:
	- App boot/homepage initialization.
	- Pages tree create/rename/archive/move.
	- These paths can fail silently if response keys change.
- Scope discipline prevents regressions:
	- Migrate only the requested table.
	- Do not opportunistically rename neighboring tables in the same pass.

## Guardrails

- Keep diffs minimal; do not refactor unrelated logic.
- Do not migrate unrelated tables unless explicitly requested.
- Keep naming/style consistent with local files.
- Do not add barrel files.
