---
name: quotas
description: Persisted per-user, per-organization, and per-workspace quota counters. Use when changing `packages/app/convex/quotas.ts`, quota helpers, quota schema docs, organization/workspace/API credential quota behavior, or tests for quotas.
---

# Mental model

- Quotas are **persisted documents**, not live doc-count queries at runtime.
- The quota state lives in one generic `quotas` table in `packages/app/convex/schema.ts`.
- Quotas are looked up by their typed scope fields:
	- `userId` plus `quotaName: "extra_organizations"` for user-level organization creation quota
	- `organizationId` plus `quotaName: "extra_workspaces"` for organization-level workspace creation quota
	- `userId`, `organizationId`, and `workspaceId` plus `quotaName: "active_api_credentials"` for a user's active API keys in one workspace
	- `organizationId` plus `workspaceId` plus `quotaName: "public_api_upload_bytes"` for the workspace's declared upload bytes through the public API
	- `organizationId` plus `workspaceId` plus `quotaName: "plugin_service_storage_bytes"` for the workspace's plugin service upload storage
- The product rule is still:
	- each user gets `personal` plus at most **2** extra organizations (**3** total organizations)
	- each organization gets `home` plus at most **5** extra workspaces (**6** total workspaces)
	- each user can have at most **20** active API keys in one workspace
	- each workspace gets a **50 GB** budget of declared upload bytes through the public API; the counter only grows (deleting files does not give bytes back)
	- each workspace gets **10 GiB** of plugin service storage; this counter only grows, exactly like `public_api_upload_bytes` — deleting a service-uploaded file gives nothing back (see `../public-api/SKILL.md#service-upload-routes`)
- Default entities do **not** consume quota usage:
	- default organization `personal`
	- default workspace `home`
- Revoked API keys do not consume active API credential quota. The separate 100-entry API key list bound only limits recent history returned to the UI.

# Source of truth

- Runtime quota reads are DB-authoritative.
- Use quota helpers from `packages/app/convex/quotas.ts` for ensure and required reads.
- Usage-changing mutations call `quotas_db_get(...)` and patch the quota doc directly with `ctx.db.patch(...)` in the owning write flow.
- Helper call sites pass only schema-typed quota names such as `"extra_organizations"` and `"extra_workspaces"`; `quotas.ts` maps those names to the shared definitions internally.
- Do **not** add runtime fallback behavior that:
	- recomputes `usedCount` from live docs
	- substitutes code `maxCount` defaults when a quota doc is missing
- Missing required quota docs in write flows should fail intentionally via `should_never_happen(...)` so bootstrap bugs stay visible.
- Exception: `public_api_upload_bytes` and `plugin_service_storage_bytes` have no bootstrap owner, so the first consumer seeds them with `quotas_db_ensure` — the first `/api/v1/files/upload-urls` mint inside `public_api.create_file_upload_targets`, and the first service upload target inside `public_api_service_uploads.create_upload_target`. A missing doc means nothing was consumed yet, and the public `quotas.get` arm returns the doc or `null` instead of failing.
- Public quota queries may return `null` for stale identities or unauthorized quota scopes. Missing quota docs for authorized scopes fail intentionally.

# Schema

- `packages/app/convex/schema.ts` has one `quotas` table.
- Each quota doc stores:
	- `quotaName`
	- `userId` for user-scoped quotas
	- `organizationId` for organization-scoped quotas
	- `workspaceId` for workspace-scoped quotas
	- `usedCount`
	- `maxCount`
	- `createdAt`
	- `updatedAt`
- Scope indexes:
	- `quotas.by_user_quotaName`
	- `quotas.by_organization_quotaName`
	- `quotas.by_workspace_quotaName`
	- `quotas.by_user_organization_workspace_quotaName`
- Organization quota read authorization checks active membership against the requested `organizationId` with `organizations_workspaces_users.by_active_user_organization_workspace`, then reads the quota doc by `organizationId` and `quotaName`.
- Stable definitions live in `packages/app/shared/quotas.ts`:
	- `quotas.extra_organizations`
	- `quotas.extra_workspaces`
	- `quotas.active_api_credentials`
	- `quotas.public_api_upload_bytes`
	- `quotas.plugin_service_storage_bytes`

# Runtime write paths

## User bootstrap

- `users.create_anonymous_user` and signed-in restore/create flows ensure the user quota with `quotas_db_ensure({ quotaName: "extra_organizations", userId })`.
- `organizations_db_ensure_default_organization_and_workspace_for_user` creates `personal`/`home` when `users.defaultOrganizationId` is absent or points to a missing organization doc. If the pointed organization exists, it does not repair the workspace pointer or memberships.
- Default provisioning through `organizations_db_create(..., default: true)` does not consume the user extra-organization quota.

## Organization create

- `organizations_db_create(..., default: false)` reads the creator `"extra_organizations"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Every organization creation ensures the organization `"extra_workspaces"` quota with `usedCount: 0`.
- Missing user quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Organization quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## Workspace create

- `organizations_db_create_workspace` reads the organization `"extra_workspaces"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Missing organization quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Workspace quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## API credential create, revoke, and rotate

- Membership creation ensures one `active_api_credentials` quota doc for the user, organization, and workspace tuple.
- `public_api.api_credential_create` reads the persisted quota with `quotas_db_get`, blocks when `usedCount >= maxCount`, and increments the counter in the same mutation as the credential insert.
- `public_api.api_credential_revoke` decrements the counter only when it changes an active credential to revoked.
- `public_api.api_credential_rotate` revokes one credential and creates one credential in the same mutation, so the active counter does not change.
- Do not count active credential docs at create time. The persisted quota is the runtime source of truth.

## Public API upload minting

- Before this quota is touched at all, `public_api.create_file_upload_targets` refuses a workspace that does not pay for usage, exactly like the service route below: `billing_db_check_paid_plan` on the billed user, `"This workspace's plan does not include file uploads"` → 403 for `Free`, for an anonymous payer, and for a payer with no billing state. A refusing mutation still commits what it already wrote, so that gate must run before the lazy seeding below. A test asserts the refused call leaves no quota doc behind, which is what pins the order.
- `public_api.create_file_upload_targets` (the mutation behind `/api/v1/files/upload-urls`) ensures the workspace `"public_api_upload_bytes"` quota lazily with `quotas_db_ensure`, refuses the whole batch when the declared bytes would cross `maxCount`, and consumes them in the same mutation that creates the nodes and assets.
- The counter is monotonic on purpose: deleting files does not decrement it. It is a coarse declared-bytes ceiling, not an exact storage meter (the finalizer records the real object size without refunding the difference).

## Plugin service upload storage

- Before this quota is touched at all, `public_api_service_uploads.create_upload_target` refuses a workspace that does not pay for usage: `billing_db_check_paid_plan` on the billed user, `plan_required` → 403 for `Free`, for an anonymous payer, and for a payer with no billing state. A refusing mutation still commits what it already wrote, so that gate must run before the lazy seeding below. The gate is the door that stops an upload; this quota can only bill one.
- `public_api_service_uploads.create_upload_target` ensures the workspace `"plugin_service_storage_bytes"` quota lazily and charges nothing. The `size` in the request is only the service's guess, and a signed PUT does not bind how many bytes actually arrive, so billing it would charge a number nobody can be held to. The door only refuses a workspace whose `usedCount` already reached `maxCount` (`storage_full` → 403), which stops the next file rather than the current one.
- This counter only grows, exactly like `public_api_upload_bytes`. Nothing refunds: not an upload the service abandoned, not a cancelled placeholder, not archiving a committed service file, and not a later physical deletion of its canonical R2 object. The service `delete` route archives committed files and releases their target tombstones. It hard-deletes only pending placeholders.
- The R2 event is what charges. It settles the target and bills the confirmed stored size, so `usedCount` may exceed `maxCount` (precedent: the forced ownership handoff above). A signed PUT does not bind the object's length, so the quota can only bill what was stored, never prevent it. Finalize reports this settlement and can reconcile an older canonical asset.
- A late event after a pending target was cancelled, or after the member discarded its failed placeholder, charges the stored bytes too: they are in the bucket, so they are billed. `actualBytes` is both the size that was recorded and the amount already charged for that target, so a duplicate or smaller event adds nothing and a bigger object charges only the difference. Nothing gives bytes back.
- Invariant to preserve: `usedCount` equals the sum of every target's `actualBytes`, which is the largest object size R2 confirmed for that target. A target whose upload never reached R2 has charged nothing.

## Delete flows

- `delete_workspace` reads the organization extra-workspace quota and decrements `usedCount` directly when deleting a non-default workspace.
- The immediate `delete_workspace` phase deletes active API credential quota docs but keeps `public_api_upload_bytes` and `plugin_service_storage_bytes` through retention. The queued content purge deletes those two budgets only after service targets, assets, and files are gone, so late accepted R2 events can still settle first. Internal workspace structural deletion removes any remaining workspace quota docs. Admin data-only reset keeps the current user's active API credential quota doc and sets its `usedCount` to `0`, while the content purge removes the two upload budgets so their next use starts fresh.
- `delete_organization` reads the owner from `organizations.ownerUserId`, decrements that owner's extra-organization quota directly, and defers deleting the organization quota doc until `data_deletion.process_organization_deletion_request`.
- Account deletion uses the same direct owner quota decrement when the backend queues a still-owned organization for deletion instead of the frontend transferring it first.
- `data_deletion.process_organization_deletion_request` deletes all quota docs for the organization id.
- `data_deletion.process_user_deletion_request` deletes all quota docs for the user id.
- Organization deletion requests are expected to reference an existing organization and delete quota docs by the request organization id before deleting the organization doc. If a user-scope queued request finds the user shell doc already gone, treat that request as stale and still delete the matching user quota docs by user id.

## Ownership transfer

- `access_control.transfer_organization_ownership` must respect the recipient’s persisted `extra_organizations` quota doc.
- Transfer reads the current owner's quota alongside the recipient eligibility reads. It reads the recipient's quota only after proving that user is live and an active organization member. It then releases one old-owner usage unit and consumes one new-owner quota unit in the same mutation write phase as patching `organizations.ownerUserId`, deleting all of the new owner's assignments in that organization, and giving the old owner a `member` assignment.
- Auth-removing user finalization must preserve a shared organization when another active member remains. It transfers ownership to the first remaining default-workspace member and increments that user's persisted usage even when the user is already at the normal creation limit. In that forced handoff, `usedCount` may exceed `maxCount`; new organization creation stays blocked until later deletions bring usage below the limit.
- Do not recompute quota usage from organization docs during normal product flows; use audits or explicit maintenance flows if drift ever needs investigation.

# Public API

- Quota queries live in `packages/app/convex/quotas.ts`.
- Use `api.quotas.get({ quotaName: "extra_organizations", userId })` for user quotas.
- Use `api.quotas.get({ quotaName: "extra_workspaces", organizationId })` for organization quotas.
- Use `api.quotas.get({ quotaName: "active_api_credentials", membershipId })` for the current user's active API credential quota in that membership's workspace.
- Use `api.quotas.get({ quotaName: "public_api_upload_bytes", membershipId })` for that membership workspace's declared upload-byte budget; it returns `null` until the first mint seeds the doc.
- Use `api.quotas.get({ quotaName: "plugin_service_storage_bytes", membershipId })` for that membership workspace's plugin service storage; it returns `null` until the first upload target seeds the doc.
- Returned objects are the persisted quota docs. Frontend callers derive remaining capacity from `usedCount` and `maxCount`, and use `packages/app/shared/quotas.ts` for quota-specific display copy.

# Tests

- Main coverage lives in `packages/app/convex/organizations.test.ts`.
- API credential counter coverage lives in `packages/app/convex/public_api.test.ts`.
- Plugin service storage quota coverage (create charges nothing, full-workspace refusal, R2 event settlement, late-event billing, deletion settlement, and abandoned-placeholder cleanup) lives in `packages/app/convex/public_api_service_uploads.test.ts`.
- Account-deletion quota behavior is also covered in `packages/app/convex/data_deletion.test.ts` and `packages/app/convex/users.test.ts`.
- Tests and setup must seed quota docs through `quotas_db_ensure(...)` or the real user/membership bootstrap path before exercising the related quota write flow.
- Focused verification for this feature is:
	- `vp env exec pnpm --dir packages/app exec vitest run convex/organizations.test.ts`
	- `vp env exec pnpm --dir packages/app exec vitest run convex/data_deletion.test.ts convex/users.test.ts`
	- `vp env exec pnpm --dir packages/app exec vitest run convex/public_api.test.ts`

# Not quotas

The plugin document store keeps its own counters in `plugins_data_usage`, one doc per installation, and does not use the `quotas` table. Keep it that way. A quota is a product allowance the user can see and, in principle, buy more of; the plugin-data ceilings are safety limits on one plugin's storage, scoped to an installation that can disappear at any time. They also move in both directions — a reservation gives bytes back and a delete frees slots — while quota counters here are release-on-delete or monotonic by product rule. See `../plugin-system/SKILL.md` for the store's limits and accounting.

# Guardrails

- Keep rate limiting separate; rate-limiter names, config, and copy still use rate-limit terminology.
- Do not add migrations for this quota shape while the product assumes an empty database.
- Cross-check tenancy/product rules with `../organizations-tenancy/SKILL.md`.
