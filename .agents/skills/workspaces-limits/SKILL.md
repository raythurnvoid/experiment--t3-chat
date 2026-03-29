---
name: workspaces-limits
description: Counter-based per-user and per-workspace creation limits for extra workspaces and projects. Use when changing `packages/app/server/workspaces.ts`, `packages/app/convex/workspaces.ts`, related migrations, or tests for workspace/project quota behavior.
---

# Mental model

- Limits are **persisted documents**, not live row-count queries at runtime.
- There are two scoped limit tables in `packages/app/convex/schema.ts`:
	- `limits_per_user` for `extra_workspaces`
	- `limits_per_workspace` for `extra_projects`
- The product rule is still:
	- each user gets `personal` plus at most **1** extra workspace
	- each workspace gets `home` plus at most **1** extra project
- Default entities do **not** consume counters:
	- default workspace `personal`
	- default project `home`

# Source of truth

- Runtime capability reads are DB-authoritative.
- Read the persisted limit docs inline at the call site instead of routing through a dedicated limits module.
- Do **not** add runtime fallback behavior that:
	- recomputes `usedCount` from live rows
	- substitutes code `maxCount` defaults when a limit doc is missing
- Missing required limit docs should fail intentionally via `should_never_happen(...)` so rollout bugs stay visible.

# Schema

- `packages/app/convex/schema.ts` uses explicit literal-union validators:
	- `extra_workspaces` for `limits_per_user.limitName`
	- `extra_projects` for `limits_per_workspace.limitName`
- Each limit doc stores:
	- scope id (`userId` or `workspaceId`)
	- `limitName`
	- `usedCount`
	- `maxCount`
	- `createdAt`
	- `updatedAt`
	- optional `lastReconciledAt`
- Key indexes:
	- `limits_per_user.by_userId_limitName`
	- `limits_per_workspace.by_workspaceId_limitName`

# Runtime write paths

- Keep mutation-side counter logic **inline at the caller**.
- Do **not** introduce single-use helper abstractions for consume/release flows.
- Current ownership:
	- `packages/app/server/workspaces.ts`: create/bootstrap seeding + counter increments
	- `packages/app/convex/workspaces.ts`: list capability reads + delete flows + counter decrements

## User bootstrap

- `workspaces_db_ensure_default_workspace_and_project_for_user` in `packages/app/server/workspaces.ts` must:
	- ensure the user `limits_per_user` doc exists
	- reuse an existing valid `personal`/`home` tenant if found
	- otherwise create the default workspace/project
- This helper is called from `packages/app/convex/users.ts` during anonymous/clerk bootstrap.

## Workspace create

- `workspaces_db_create(..., default: false)` must:
	- require the existing user limit doc
	- check capability from that doc
	- increment `limits_per_user.usedCount`
	- insert the new workspace
	- insert the new workspace `limits_per_workspace` doc with `usedCount: 0`

## Project create

- `workspaces_db_create_project` must:
	- require the existing workspace limit doc
	- check capability from that doc
	- increment `limits_per_workspace.usedCount`
	- insert the new non-default project

## Delete flows

- `packages/app/convex/workspaces.ts` keeps decrement logic inline.
- `delete_project` decrements the workspace limit when deleting a non-default project.
- `delete_workspace` decrements the owner user limit and deletes the workspace limit docs for that workspace.

# Shared constants

- `packages/app/shared/limits.ts` holds:
	- stable limit names
	- disabled messages
	- configured `maxCount`
- Using the constants for seeded writes and migrations is fine.
- Do not use those constants as a runtime substitute for missing DB docs.

# Migrations and rollout

- Existing data must be aligned through Convex migrations, not runtime fallback.
- Use:
	- `migrations:backfill_limits_per_user_and_workspace`
	- `migrations:audit_limits_counter_drift`
- The backfill migration inserts missing limit docs and reconciles stale `usedCount` / `maxCount`.
- The audit mutation reports drift and updates `lastReconciledAt`.

## Practical commands

From `packages/app`:

```bash
pnpm exec convex dev --once
pnpm exec convex run migrations:backfill_limits_per_user_and_workspace
pnpm exec convex run migrations:audit_limits_counter_drift
pnpm exec vitest run "convex/workspaces.test.ts"
```

# Tests

- Main coverage lives in `packages/app/convex/workspaces.test.ts`.
- Tests and local setup must respect the bootstrap-first contract:
	- if a test inserts a `users` row directly and then exercises workspace/project create flows, bootstrap first with `workspaces_db_ensure_default_workspace_and_project_for_user(...)`
- Focused verification for this feature is the workspace test file, not the whole repo by default.

# Guardrails

- Keep mutation logic explicit and local.
- Prefer fixing rollout/data issues with migrations over adding runtime self-healing.
- When changing limits behavior, review together:
	- `packages/app/server/workspaces.ts`
	- `packages/app/convex/workspaces.ts`
	- `packages/app/convex/migrations.ts`
	- `packages/app/convex/workspaces.test.ts`
- Cross-check tenancy/product rules with `../workspaces-tenancy/SKILL.md`.
