---
name: quotas
description: Persisted per-user and per-workspace creation quotas for extra workspaces and projects. Use when changing `packages/app/convex/quotas.ts`, quota helpers, quota schema docs, workspace/project quota behavior, or tests for quotas.
---

# Mental model

- Quotas are **persisted documents**, not live doc-count queries at runtime.
- The quota state lives in one generic `quotas` table in `packages/app/convex/schema.ts`.
- Quotas are looked up by their typed scope fields:
	- `userId` plus `quotaName: "extra_workspaces"` for user-level workspace creation quota
	- `workspaceId` plus `quotaName: "extra_projects"` for workspace-level project creation quota
- The product rule is still:
	- each user gets `personal` plus at most **2** extra workspaces (**3** total workspaces)
	- each workspace gets `home` plus at most **1** extra project
- Default entities do **not** consume quota usage:
	- default workspace `personal`
	- default project `home`

# Source of truth

- Runtime quota reads are DB-authoritative.
- Use quota helpers from `packages/app/convex/quotas.ts` for ensure and required reads.
- Usage-changing mutations call `quotas_db_get(...)` and patch the quota doc directly with `ctx.db.patch(...)` in the owning write flow.
- Helper call sites pass only schema-typed quota names such as `"extra_workspaces"` and `"extra_projects"`; `quotas.ts` maps those names to the shared definitions internally.
- Do **not** add runtime fallback behavior that:
	- recomputes `usedCount` from live docs
	- substitutes code `maxCount` defaults when a quota doc is missing
- Missing required quota docs in write flows should fail intentionally via `should_never_happen(...)` so bootstrap bugs stay visible.
- Public quota queries may return `null` for stale identities or unauthorized quota scopes. Missing quota docs for authorized scopes fail intentionally.

# Schema

- `packages/app/convex/schema.ts` has one `quotas` table.
- Each quota doc stores:
	- `quotaName`
	- `userId` for user-scoped quotas
	- `workspaceId` for workspace-scoped quotas
	- `usedCount`
	- `maxCount`
	- `createdAt`
	- `updatedAt`
- Scope indexes:
	- `quotas.by_user_quotaName`
	- `quotas.by_workspace_quotaName`
- Workspace quota read authorization checks active membership against the requested `workspaceId` with `workspaces_projects_users.by_active_user_workspace_project`, then reads the quota doc by `workspaceId` and `quotaName`.
- Stable definitions live in `packages/app/shared/quotas.ts`:
	- `quotas.extra_workspaces`
	- `quotas.extra_projects`

# Runtime write paths

## User bootstrap

- `users.create_anonymous_user` and signed-in restore/create flows ensure the user quota with `quotas_db_ensure({ quotaName: "extra_workspaces", userId })`.
- `workspaces_db_ensure_default_workspace_and_project_for_user` trusts `users.defaultWorkspaceId` when present and creates `personal`/`home` only when missing.
- Default provisioning through `workspaces_db_create(..., default: true)` does not consume the user extra-workspace quota.

## Workspace create

- `workspaces_db_create(..., default: false)` reads the creator `"extra_workspaces"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Every workspace creation ensures the workspace `"extra_projects"` quota with `usedCount: 0`.
- Missing user quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Workspace quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## Project create

- `workspaces_db_create_project` reads the workspace `"extra_projects"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Missing workspace quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Project quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## Delete flows

- `delete_project` reads the workspace extra-project quota and decrements `usedCount` directly when deleting a non-default project.
- `delete_workspace` reads the owner from `workspaces.ownerUserId`, decrements that owner's extra-workspace quota directly, and defers deleting the workspace quota doc until `data_deletion.process_workspace_deletion_request`.
- Account deletion uses the same direct owner quota decrement when the backend queues a still-owned workspace for deletion instead of the frontend transferring it first.
- `data_deletion.process_workspace_deletion_request` deletes all quota docs for the workspace id.
- `data_deletion.process_user_deletion_request` deletes all quota docs for the user id.
- Workspace deletion requests are expected to reference an existing workspace and delete quota docs by the request workspace id before deleting the workspace doc. If a user-scope queued request finds the user shell doc already gone, treat that request as stale and still delete the matching user quota docs by user id.

## Ownership transfer

- `access_control.transfer_workspace_ownership` must respect the recipient’s persisted `extra_workspaces` quota doc.
- Transfer reads both owner quota docs directly in `access_control.transfer_workspace_ownership` alongside the workspace/member reads, then releases one old-owner usage unit and consumes one new-owner quota unit in the same mutation write phase as patching `workspaces.ownerUserId` and replacing the mirrored default-project owner assignment.
- Do not recompute quota usage from workspace docs during normal product flows; use audits or explicit maintenance flows if drift ever needs investigation.

# Public API

- Quota queries live in `packages/app/convex/quotas.ts`.
- Use `api.quotas.get({ quotaName: "extra_workspaces", userId })` for user quotas.
- Use `api.quotas.get({ quotaName: "extra_projects", workspaceId })` for workspace quotas.
- Returned objects are the persisted quota docs. Frontend callers derive remaining capacity from `usedCount` and `maxCount`, and use `packages/app/shared/quotas.ts` for quota-specific display copy.

# Tests

- Main coverage lives in `packages/app/convex/workspaces.test.ts`.
- Account-deletion quota behavior is also covered in `packages/app/convex/data_deletion.test.ts` and `packages/app/convex/users.test.ts`.
- Tests and setup must seed quota docs through `quotas_db_ensure({ quotaName: "extra_workspaces", userId })` or the real user bootstrap path before exercising workspace/project create flows.
- Focused verification for this feature is:
	- `pnpm exec vitest run "convex/workspaces.test.ts"`
	- `pnpm exec vitest run "convex/data_deletion.test.ts" "convex/users.test.ts"`

# Guardrails

- Keep rate limiting separate; rate-limiter names, config, and copy still use rate-limit terminology.
- Do not add migrations for this quota shape while the product assumes an empty database.
- Cross-check tenancy/product rules with `../workspaces-tenancy/SKILL.md`.
