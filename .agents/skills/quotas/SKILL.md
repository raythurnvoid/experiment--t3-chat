---
name: quotas
description: Persisted per-user and per-organization creation quotas for extra organizations and workspaces. Use when changing `packages/app/convex/quotas.ts`, quota helpers, quota schema docs, organization/workspace quota behavior, or tests for quotas.
---

# Mental model

- Quotas are **persisted documents**, not live doc-count queries at runtime.
- The quota state lives in one generic `quotas` table in `packages/app/convex/schema.ts`.
- Quotas are looked up by their typed scope fields:
	- `userId` plus `quotaName: "extra_organizations"` for user-level organization creation quota
	- `organizationId` plus `quotaName: "extra_workspaces"` for organization-level workspace creation quota
- The product rule is still:
	- each user gets `personal` plus at most **2** extra organizations (**3** total organizations)
	- each organization gets `home` plus at most **5** extra workspaces (**6** total workspaces)
- Default entities do **not** consume quota usage:
	- default organization `personal`
	- default workspace `home`

# Source of truth

- Runtime quota reads are DB-authoritative.
- Use quota helpers from `packages/app/convex/quotas.ts` for ensure and required reads.
- Usage-changing mutations call `quotas_db_get(...)` and patch the quota doc directly with `ctx.db.patch(...)` in the owning write flow.
- Helper call sites pass only schema-typed quota names such as `"extra_organizations"` and `"extra_workspaces"`; `quotas.ts` maps those names to the shared definitions internally.
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
	- `organizationId` for organization-scoped quotas
	- `usedCount`
	- `maxCount`
	- `createdAt`
	- `updatedAt`
- Scope indexes:
	- `quotas.by_user_quotaName`
	- `quotas.by_organization_quotaName`
- Organization quota read authorization checks active membership against the requested `organizationId` with `organizations_workspaces_users.by_active_user_organization_workspace`, then reads the quota doc by `organizationId` and `quotaName`.
- Stable definitions live in `packages/app/shared/quotas.ts`:
	- `quotas.extra_organizations`
	- `quotas.extra_workspaces`

# Runtime write paths

## User bootstrap

- `users.create_anonymous_user` and signed-in restore/create flows ensure the user quota with `quotas_db_ensure({ quotaName: "extra_organizations", userId })`.
- `organizations_db_ensure_default_organization_and_workspace_for_user` trusts `users.defaultOrganizationId` when present and creates `personal`/`home` only when missing.
- Default provisioning through `organizations_db_create(..., default: true)` does not consume the user extra-organization quota.

## Organization create

- `organizations_db_create(..., default: false)` reads the creator `"extra_organizations"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Every organization creation ensures the organization `"extra_workspaces"` quota with `usedCount: 0`.
- Missing user quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Organization quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## Workspace create

- `organizations_db_create_workspace` reads the organization `"extra_workspaces"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Missing organization quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Workspace quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## Delete flows

- `delete_workspace` reads the organization extra-workspace quota and decrements `usedCount` directly when deleting a non-default workspace.
- `delete_organization` reads the owner from `organizations.ownerUserId`, decrements that owner's extra-organization quota directly, and defers deleting the organization quota doc until `data_deletion.process_organization_deletion_request`.
- Account deletion uses the same direct owner quota decrement when the backend queues a still-owned organization for deletion instead of the frontend transferring it first.
- `data_deletion.process_organization_deletion_request` deletes all quota docs for the organization id.
- `data_deletion.process_user_deletion_request` deletes all quota docs for the user id.
- Organization deletion requests are expected to reference an existing organization and delete quota docs by the request organization id before deleting the organization doc. If a user-scope queued request finds the user shell doc already gone, treat that request as stale and still delete the matching user quota docs by user id.

## Ownership transfer

- `access_control.transfer_organization_ownership` must respect the recipient’s persisted `extra_organizations` quota doc.
- Transfer reads both owner quota docs directly in `access_control.transfer_organization_ownership` alongside the organization/member reads, then releases one old-owner usage unit and consumes one new-owner quota unit in the same mutation write phase as patching `organizations.ownerUserId` and replacing the mirrored default-workspace owner assignment.
- Auth-removing user finalization must preserve a shared organization when another active member remains. It transfers ownership to the first remaining default-workspace member and increments that user's persisted usage even when the user is already at the normal creation limit. In that forced handoff, `usedCount` may exceed `maxCount`; new organization creation stays blocked until later deletions bring usage below the limit.
- Do not recompute quota usage from organization docs during normal product flows; use audits or explicit maintenance flows if drift ever needs investigation.

# Public API

- Quota queries live in `packages/app/convex/quotas.ts`.
- Use `api.quotas.get({ quotaName: "extra_organizations", userId })` for user quotas.
- Use `api.quotas.get({ quotaName: "extra_workspaces", organizationId })` for organization quotas.
- Returned objects are the persisted quota docs. Frontend callers derive remaining capacity from `usedCount` and `maxCount`, and use `packages/app/shared/quotas.ts` for quota-specific display copy.

# Tests

- Main coverage lives in `packages/app/convex/organizations.test.ts`.
- Account-deletion quota behavior is also covered in `packages/app/convex/data_deletion.test.ts` and `packages/app/convex/users.test.ts`.
- Tests and setup must seed quota docs through `quotas_db_ensure({ quotaName: "extra_organizations", userId })` or the real user bootstrap path before exercising organization/workspace create flows.
- Focused verification for this feature is:
	- `pnpm exec vitest run "convex/organizations.test.ts"`
	- `pnpm exec vitest run "convex/data_deletion.test.ts" "convex/users.test.ts"`

# Guardrails

- Keep rate limiting separate; rate-limiter names, config, and copy still use rate-limit terminology.
- Do not add migrations for this quota shape while the product assumes an empty database.
- Cross-check tenancy/product rules with `../organizations-tenancy/SKILL.md`.
