---
name: convex-migrations
description: Apply the user's case-by-case choice to erase, migrate, or mix explicit data scopes for a Convex data/schema change, then use the safe compatibility, data-run, switch/strip, and tighten rollout where stored data must survive. Use when the user asks to rename fields, change field types, backfill data, remove legacy fields, reset affected development data, or create/run migration scripts in packages/app/convex.
---

# Project Defaults

- Convex code root: `packages/app/convex`
- Package manager: `pnpm`
- Run normal Convex commands without generated JSON args from the repository root through Vite Plus: `vp env exec pnpm --dir packages/app exec convex ...`. For generated JSON args, use the admin-ops direct Node pattern because `pnpm` strips those quotes on this machine.
- Migration component package: `@convex-dev/migrations`
- Convex app config file: `packages/app/convex/convex.config.ts`
- Migration file location: `packages/app/convex/migrations.ts`

# Confirm Erase, Migrate, Or Mixed Scope First

The user decides whether existing data survives. Do not infer that development data is disposable only because this product is not in production. If the request does not decide and the paths materially differ, ask before coding.

- **Erase:** record the exact approved data scope, delete only that scope through its owning workflow, and build the final schema directly. Use `dev-data-reset` only for a full reset that preserves all Clerk-backed accounts; use `convex-admin-ops` plus the owning domain skills for selective cleanup.
- **Migrate:** preserve the approved scope through the compatibility, run, switch/strip, and tighten phases below. In a one-time development migration, remove the temporary compatibility and migration code after the audit and strict-schema deployment unless the user asks to keep it replayable.
- **Mixed:** record separate keep/migrate and erase scopes. Never let a broad reset delete the keep scope, and never keep compatibility code for the erase scope.
- **Ongoing rollout continuity:** keep replayable migrations or compatibility code only when the user explicitly needs deployment continuity beyond this task.

# Clarify Data Survival Before Coding

- Which table(s) are in scope?
- Which field is source vs destination?
- Target type of the new field?
- Backfill value/rule (constant or derived)?
- Which data should be erased, migrated, or left untouched? A mixed answer is valid.
- Must migrated data stay usable during an ongoing rollout, or is this a one-time development migration whose bridge code should be removed after success?
- Should this be dev-only run now, or just prepare migration code?

# Implementation Workflow

Copy this checklist and update status while working:

```md
Migration Progress:

- [ ] Confirm scope and exact field mapping
- [ ] Record the exact erase, migrate, and untouched scopes chosen by the user
- [ ] Confirm whether migration code is one-time or must stay replayable
- [ ] Confirm whether `@convex-dev/migrations` wiring already exists
- [ ] Add migration definition + runner in `convex/migrations.ts`
- [ ] Deploy the compatibility schema and matching code for the current phase
- [ ] Inspect live docs before changing/deleting data
- [ ] Run the backfill to completion and verify stored docs
- [ ] Switch reads/writes and make the legacy field optional when the migration needs a strip phase
- [ ] Run the strip to completion and verify stored docs when applicable
- [ ] Tighten the schema only after the stored data passes the final shape
- [ ] Remove temporary migration definitions, runners, casts, tests, and compatibility docs when this is a one-time development migration
```

# Compatibility, Run, And Tighten Rollout

## Phase A: Compatibility

1. Schema accepts both old and new representations.
2. Add an idempotent migration that backfills existing docs without removing a still-required legacy field.
3. For a simple default-value backfill, new writes should emit the new field. For a field rename, keep reads on the old field but dual-write the old and new fields until the backfill finishes, as the three-push workflow below describes.

## Phase B: Switch And Strip

1. Verify the backfill, then switch reads and writes to the new representation.
2. Make the old field optional and run a separate idempotent migration that strips it from stored docs.

## Phase C: Tighten

1. Verify the strip migration completed.
2. Remove the legacy field from the schema and code paths.

# Field Rename Rollout

A rename is a copy, not a symbol rename. Every push deploys schema + code atomically and
validates ALL existing docs against the schema, so each step below must typecheck and validate on
its own:

1. **Push A** — add the new field to the schema as `v.optional(...)` with the same value shape as
   the old field. Add the backfill migration + runner in the same push. Keep reads on the old field,
   but update every write path to write both old and new fields so docs created after a backfill batch
   cannot miss the new field.
2. **Run the backfill** — `vp env exec pnpm --dir packages/app exec convex run "migrations:run_backfill_<table>_<new_field>"`. Copy the
   old value verbatim: `null` is a value and must copy; only `undefined` means absent. Poll
   `vp env exec pnpm --dir packages/app exec convex run --component migrations lib:getStatus`
   until the target migration reports `isDone`, then spot-check with
   `vp env exec pnpm --dir packages/app exec convex data "<table>" --format jsonArray` after replacing the quoted placeholder.
3. **Push B** — make the new field mandatory, make the old field `v.optional(...)` (comment it as
   legacy), and rename every code usage: args validators (`doc(...).fields.<new>`), all reads and
   writes, and every `ctx.db.insert` seed in `*.test.ts` and harness files (grep `<old_field>:`
   across `packages/app` — seeds hide outside `convex/` too, e.g. `server/bash.ts`). Add the strip
   migration in THIS push — it cannot typecheck earlier, because its destructure+replace omits a
   field the phase-A schema still requires.
4. **Run the strip** — `vp env exec pnpm --dir packages/app exec convex run "migrations:run_remove_<table>_<old_field>"` removes the old
   field from all docs. Poll the component status until the target migration reports `isDone`, then
   inspect stored docs before Push C.
5. **Push C** — delete the old field from the schema. This push's full-table validation doubles as
   verification: it fails if any doc still carries the field.

Run tsc and the affected vitest suites before each push. Do NOT rename keys in external file
formats the DB field mirrors (e.g. a plugin manifest key) — map old→new at the parse boundary
instead.

# Code Templates

## `convex.config.ts` Wiring

```ts
import migrations from "@convex-dev/migrations/convex.config";
app.use(migrations);
```

## `convex/migrations.ts` Skeleton

This repo already defines the shared instance near the top of `packages/app/convex/migrations.ts` — reuse it:

```ts
const app_migrations = new Migrations<DataModel>(components.migrations, {
	internalMutation,
});

// Backfill: patch the new field, prefer an existing new value (idempotent re-runs).
export const backfill_example = app_migrations.define({
	table: "your_table",
	migrateOne: async (ctx, doc) => {
		if (doc.newField !== undefined) {
			return;
		}
		await ctx.db.patch("your_table", doc._id, { newField: "value" });
	},
});

export const run = app_migrations.runner();
export const run_backfill_example = app_migrations.runner(internal.migrations.backfill_example);
```

## Legacy Cast Types

For a migration that must stay replayable, never reference a legacy field through `Doc<...>`
directly — once the field leaves the schema the migration stops compiling, and returning
`{ old_field: undefined }` from `migrateOne` fails tsc for the same reason. Define an Omit-based
cast type (see `LegacyVersionReview` / `LegacyPluginsVersion` in `migrations.ts`) and strip fields
with destructure + `ctx.db.replace`:

```ts
type LegacyPluginsVersion = Omit<Doc<"plugins_versions">, "backend"> & {
	/** Renamed to backendEntrypointFile; docs were copied over then stripped. */
	backend?: Doc<"plugins_versions">["backendEntrypointFile"];
};

export const remove_plugins_versions_backend = app_migrations.define({
	table: "plugins_versions",
	migrateOne: async (ctx, version) => {
		const legacy = version as LegacyPluginsVersion;
		if (legacy.backend === undefined) {
			return;
		}

		const { _id, _creationTime, backend: _backend, ...next } = legacy;
		await ctx.db.replace("plugins_versions", _id, next);
	},
});
```

Typing the legacy field as `Doc<...>["<newField>"]` keeps the value shape single-sourced from the
schema and compiles in every phase.

For a one-time development migration, keep this cast and its migration definitions only until the
data audit and strict-schema deployment pass. Then delete the definitions, runners, casts, and
migration-only tests in the same task.

# CLI Workflow

Run normal commands without generated JSON args from the repository root. For generated JSON args, use the direct Node pattern under Real-run lessons. Do not start the dev server for the user.

```powershell
vp env exec pnpm --dir packages/app exec convex codegen
vp env exec pnpm --dir packages/app exec convex data "<table>" --limit 20 --order desc --format jsonArray
vp env exec pnpm --dir packages/app exec convex run "migrations:run_<migration_name>"
vp env exec pnpm --dir packages/app exec convex run --component migrations lib:getStatus
```

- `convex codegen` refreshes `_generated` after local schema or function changes when the user's existing dev process has not done so.
- `convex data <table>` is useful for bounded spot checks before and after a migration. Prefer `--format jsonArray` so the terminal does not hide long fields. If the result count equals the limit, increase it before concluding the scan is complete.
- `convex run <module:function> [jsonArgs]` accepts a JSON object for args.
- Dry-run a risky named migration through the admin-ops direct Node path. A dry run executes one batch and rolls it back:

```powershell
Push-Location packages/app
$argsJson = @{ dryRun = $true } | ConvertTo-Json -Compress
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable "migrations:run_<migration_name>" $argsJson
Pop-Location
```

  Read the dry-run output and verify the target docs did not change before starting the real run.
  A cross-table migration can insert into another table without the dry-run summary showing a
  useful source-row change. Treat that summary as a safety check, not proof of the copy. After the
  real run, compare source and destination counts and audit the per-row mapping and foreign links.
- A named runner can return `Migration started` or `Migration running` while scheduled batches remain. Poll `convex run --component migrations lib:getStatus` until the target reports `isDone`; do not tighten the schema based on the runner's first response.
- If an existing `convex dev` watcher auto-deploys local Convex edits, do not edit deployable schema, function, or migration files while a live migration reports `inProgress`. This is only a migration sequencing rule; follow the main Convex guidance for general watcher use.
- Use `--push` only when you intentionally need to deploy local Convex source before the call.
- Use `--watch` only for a query whose changing result you need to inspect.

A migration request does not authorize a live write, a production target, an environment change, or an export/import. Before any live Convex command, load [Convex admin ops](../convex-admin-ops/SKILL.md) for deployment targeting, secret handling, exact Windows argument passing, destructive-operation gates, recovery snapshots, and readback. Never use `convex env get` for a secret or copy secret values into captured output.

If an approved risky operation needs a snapshot, follow [Export And Import Recovery Snapshots](../convex-admin-ops/SKILL.md#export-and-import-recovery-snapshots). Use import only as an explicit recovery operation, not as the normal migration mechanism.

# Component Commands

From the repository root:

```powershell
vp env exec pnpm --dir packages/app exec convex run --component migrations lib:getStatus
vp env exec pnpm --dir packages/app exec convex run "migrations:run_<migration_name>"
```

- In this repo, `packages/app/convex/convex.config.ts` already wires `@convex-dev/migrations`, so most tasks only need migration definitions/runners in `packages/app/convex/migrations.ts`.

# Verification

- Preview the live docs first with `vp env exec pnpm --dir packages/app exec convex data` and/or a dedicated `convex run` helper before deleting or backfilling.
- The component status reports `isDone` for the target migration; the named runner's first response is not completion proof.
- Schema compiles with tightened shape.
- Updated write paths no longer write legacy field.
- For a cross-table copy, source and destination counts match the intended mapping and a focused audit verifies every copied row plus foreign references. Do not use a dry-run summary as this proof.
- No diagnostics in modified files.
- Keep migration verification separate from regular runtime coverage:
  - Do not make normal feature tests call migration runners or `packages/app/convex/migrations.ts` APIs.
  - Add focused migration-specific tests only when the task actually introduces or changes a migration.

# One-Time Development Migration Cleanup

When the user chooses migration but does not need the migration to remain replayable:

1. Keep the temporary compatibility schema, dual writes, migrations, and audit helpers only while their phase is active.
2. Require the migration component to report success and complete the live readback or focused audit before moving to the next phase.
3. Deploy the strict final schema and current-only runtime code.
4. Remove temporary migration definitions, runners, legacy cast types, migration-only tests, compatibility comments, and dual-write branches.
5. Run codegen, type-check, affected tests, an obsolete-name search, and the final live readback. Record the executed migration and counts in the task result instead of leaving dead bridge code in the repository.

# Real-Run Lessons

- For field renames that affect indexes, treat index changes as first-class migration work:
  - Add new index names for new field names.
  - Move query callsites to new indexes.
  - Remove old indexes only in tighten phase.
- Keep API contract renames explicit and separate from DB renames:
  - DB doc fields: e.g. `organization_id` -> `organizationId`.
  - Convex args/returns: e.g. `organization_id` -> `organizationId`, `file_id` -> `fileId`.
  - Preserve semantic distinction between client-generated id and Convex doc id.
- Write migrations to be idempotent and prefer an existing new value during backfill without treating `null` as absent, for example `newField !== undefined ? newField : old_field`.
- Strip a legacy field with the Omit-based cast and destructure-plus-`ctx.db.replace` pattern above. Do not rely on assigning `undefined` after the field leaves the schema.
- Run migration before tightening required fields, then re-check generated types:
  - `vp env exec pnpm --dir packages/app exec convex run "migrations:run_<name>"`
  - Use `vp env exec pnpm --dir packages/app exec convex run --push ...` if your local function changes are not already deployed.
  - Expect `_generated` typings to update after schema/function changes.
- Use CLI table inspection as part of the real rollout, not just code review:
  - `vp env exec pnpm --dir packages/app exec convex data` to list tables before you touch anything.
  - `vp env exec pnpm --dir packages/app exec convex data "<table>" --limit "<n>" --order desc --format jsonArray` for spot checks; replace both quoted placeholders first.
  - For a targeted preview with generated JSON args, use the admin-ops Windows argument pattern:

```powershell
Push-Location packages/app
$argsJson = @{ id = "<id>" } | ConvertTo-Json -Compress
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable "<module:function>" $argsJson
Pop-Location
```
- When a migration depends on deployment config, follow the admin-ops skill. Confirm secret presence without printing its value, and do not infer a target from memory.
- Before destructive cleanup in an explicitly approved deployment, decide with the operator whether an export is required. When it is, follow the admin-ops [recovery snapshot workflow](../convex-admin-ops/SKILL.md#export-and-import-recovery-snapshots) before the write.
- Treat table renames as full data migrations, not symbol renames:
  - Add the new table alongside the old table in a compatibility phase.
  - Copy legacy docs into the new table with an idempotent mapping key when needed.
  - Remap all foreign references and pointer fields before deleting legacy docs.
  - Switch code paths to the new table only after the copy succeeds.
- For table-renamed ids stored on other tables, use temporary compatibility validators when needed:
  - Prefer `v.union(v.id("old_table"), v.id("new_table"))` during the remap window.
  - Tighten back to `v.id("new_table")` only after live docs are migrated.
- If strict schema rollout happens before legacy-field cleanup, recover with a temporary compatibility schema:
  - Reintroduce the legacy field(s) as optional in the validator.
  - Run the cleanup mutation to unset legacy fields from live docs.
  - Re-tighten the schema immediately after verification.
- Add focused runtime checks for boot-critical flows after API key renames:
  - App boot/homepage initialization.
  - Files tree create/rename/archive/move.
  - These paths can fail silently if response keys change.
- Scope discipline prevents regressions:
  - Migrate only the requested table.
  - Do not opportunistically rename neighboring tables in the same pass.
- `plugins_data.scopeId` is optional on purpose, and stripping it is not an ordinary strip:
  - The field marks a document as living inside a plugin's private key range. It ships as
    `v.optional(v.string())` because `schema.ts` runs full-table validation, which refuses a required
    new field on a populated table.
  - An absent `scopeId` is a real value, not a missing one. The read doors query
    `by_installation_collection_scope_key` with `.eq("scopeId", undefined)` to read the public half of
    a collection, exactly as `data_import.ts` and `files_metadata.ts` do for their own optional fields.
    So do not backfill it with a placeholder string to "make it required".
  - Stripping it would make every private document public in the same push. If a strip is ever really
    wanted, delete the `plugins_data_scopes` rows and the `plugin_scope` grants in the same migration,
    and say so to the operator first — the documents stay readable either way, and only the grants say
    who may read them.

# Guardrails

- Keep diffs minimal; do not refactor unrelated logic.
- Do not migrate unrelated tables unless explicitly requested.
- Keep naming/style consistent with local files.
- Do not add barrel files.
