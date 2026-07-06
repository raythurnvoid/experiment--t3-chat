---
name: data-deletion
description: Data deletion, account deletion, admin user data reset, delayed purge queues, R2 asset cleanup, and Workpool deletion orchestration. Use when changing `packages/app/convex/data_deletion.ts`, `data_deletion_requests`, `users.delete_current_user_account`, `users.hard_delete_user_now`, organization/workspace delete purge behavior, or tests for deletion retention and cleanup.
---

# Scope

Use this skill as the canonical map for the deletion system. Also load:

- `../convex/SKILL.md` before changing Convex functions, validators, schema, or tests.
- `../auth-system/SKILL.md` for user-facing account deletion, deleted-account recovery, Clerk cleanup, anonymous auth, and billing cancellation behavior.
- `../organizations-tenancy/SKILL.md` for organization/workspace ownership, memberships, default tenant rules, and tenant purge semantics.
- `../quotas/SKILL.md` when quota docs or usage counters are touched.
- `../access-control/SKILL.md` when role assignments or permission grants are touched.

# Mental Model

- `packages/app/convex/data_deletion.ts` owns delayed and destructive cleanup.
- `data_deletion_requests` is the shared queue. `scope` is `"user"`, `"organization"`, or `"workspace"`. `eligibleAt` gates retention/delay.
- User deletion is two-phase: phase 1 tombstones and deactivates access, phase 2 finalizes after retention.
- Organization/workspace deletion is also split: UI-facing mutations remove structure/access immediately where needed, then the data deletion worker purges heavy tenant content in batches.
- Admin data reset is not account deletion. It preserves the account and default tenant while deleting reset-owned content.
- Large deletes must remain retryable, bounded, and idempotent. Keep limited indexed reads and leave queue docs in place while work remains.

# Primary Files

- `packages/app/convex/data_deletion.ts`: queue helper, phase 1/2 user deletion, organization/workspace purge batches, admin data reset, Workpool actions.
- `packages/app/convex/users.ts`: `delete_current_user_account`, deleted-user recovery in `resolve_user`, `hard_delete_user_now`, `purge_deleted_user_tombstone`.
- `packages/app/convex/organizations.ts`: `delete_workspace` and `delete_organization` phase-1 behavior.
- `packages/app/convex/schema.ts`: `data_deletion_requests` and indexes.
- `packages/app/convex/crons.ts`: daily enqueue of `data_deletion.enqueue_deletion_requests_processing`.
- `packages/app/convex/data_deletion.test.ts`: main behavioral coverage.

# Function Map

- `data_deletion_db_request`: creates or reuses exactly one queue doc for the requested user, organization, or workspace scope.
- `db_prepare_user_for_deletion`: phase 1 for a user. It tombstones the user, deactivates memberships, and removes presence.
- `db_finalize_deleted_user`: phase 2 for a tombstoned user. It deletes user-scoped docs and returns organizations that became empty.
- `db_purge_organization_workspace_content_batch`: deletes tenant content for one `(organizationId, workspaceId)` in bounded batches.
- `db_delete_workspace_structure_batch`: deletes workspace notifications, memberships, access-control docs, and then the workspace doc after content is gone.
- `db_delete_workspace_batch`: full workspace deletion used by organization deletion and admin reset flows where the workspace doc may still exist.
- `db_delete_organization_batch`: drains queued workspace content, deletes remaining workspaces, deletes organization structure, then deletes the organization doc.
- `process_user_deletion_request`, `process_organization_deletion_request`, and `process_workspace_deletion_request`: own one queued request at a time and leave the queue doc in place while covered work remains.
- `run_deletion_request_batches`: Workpool action body that processes due requests in priority order within a fixed mutation-step budget.

# Queue Semantics

- Create requests through `data_deletion_db_request`, not direct inserts, unless a test is intentionally seeding a specific queue shape.
- User requests dedupe by `(userId, scope: "user")`.
- Organization requests dedupe by `(organizationId, scope: "organization")`.
- Workspace requests dedupe by `(organizationId, workspaceId, scope: "workspace")`.
- Repeated requests keep the earliest `eligibleAt`.
- User requests normally use the retention window. Organization/workspace requests use the same helper and may be immediate when an admin/finalization path passes `eligibleAt: now`.
- Do not delete a queue doc until the owning processor has finished all covered work, except invalid request docs that cannot target anything.

# User Deletion

## User-facing account deletion

`users.delete_current_user_account` is the UI-facing action.

- Resolve the current user and return `Unauthenticated` when no app user doc exists.
- Rate-limit before starting local deletion, Clerk cleanup, or billing cleanup.
- Block deletion while the user owns non-personal organizations not already queued for organization deletion.
- Call `internal.data_deletion.init_user_deletion` to apply local phase 1 before attempting external cleanup.
- Treat Clerk delete as best-effort after local deletion; do not fail local deletion because Clerk cleanup failed.
- Schedule Polar subscription period-end cancellation as deletion cleanup. Keep local Polar mirror docs Polar-owned.

## Phase 1

`init_user_deletion`:

- Internal/admin callers may still reach this with owned non-default organizations. Queue those organizations first through `db_queue_organization_deletion_for_owner_account_deletion`.
- `db_prepare_user_for_deletion` sets `users.deletedAt`, marks memberships inactive, and removes presence docs.
- Phase 1 keeps the user doc, anagraphic, auth pointers, billing state, tenant docs, files, and queue docs needed for recovery.
- Phase 1 creates or reuses one user-scope `data_deletion_requests` doc.

## Recovery During Retention

Deleted-account recovery is handled in `users.resolve_user`.

- Recovery is same normalized verified-email only.
- Reclaim the same Convex `users` doc, clear `deletedAt`, relink the new Clerk id, reactivate memberships, remove only the user-scope deletion request, and mark the auth response so billing bootstrap can restore a deletion-triggered Polar period-end cancellation when possible.
- Do not remove resource-scope organization/workspace requests during account recovery.
- Do not backfill missing anagraphic email as part of deletion recovery.

## Phase 2

`process_user_deletion_request` runs after `eligibleAt`.

- It only owns user-scope request docs.
- If the user doc is already gone, clear user quota docs and remove the stale request.
- A non-tombstoned user request should make no destructive progress and should log.
- `db_finalize_deleted_user` deletes user-scoped memberships, role assignments, direct user grants, pending-update docs, last-sequence docs, user quota docs, and the user's plugin publishing docs (`plugins_publisher_repositories` by `ownerUserId`, `plugins_publisher_repository_secrets` by `ownerUserId`, `plugins_version_reviews` by `createdBy`). Publishing is user-owned — there is no publisher account table. `plugins_versions` are intentionally kept with a dangling `createdBy`; the marketplace shows a null publisher display name for them.
- Keep `billing_usage_snapshots` whenever the `users` doc is retained. Delete them only when the full user-record purge path passes `deleteBillingState`.
- Auth pointers and anonymous tokens are removed only when the caller passes `deleteUserAuth`.
- After finalization, queue now-empty organizations with immediate organization requests.
- Leave the tombstoned user doc unless `users.purge_deleted_user_tombstone` runs later.

# Organization And Workspace Deletion

## Workspace Delete

`organizations.delete_workspace`:

- Rejects default workspaces.
- Queues a workspace-scope request.
- Releases one `extra_workspaces` quota unit.
- Removes workspace invite notifications, memberships, role assignments, permission grants, then deletes the workspace doc.
- The queued workspace request later purges heavy content for the deleted workspace id, even though the workspace doc is already gone.

`process_workspace_deletion_request`:

- Only owns workspace-scope request docs.
- Requires both `organizationId` and `workspaceId`; invalid docs are removed.
- Calls `db_purge_organization_workspace_content_batch`.
- Keeps the queue doc while content remains.
- Does not delete workspace structure. The UI-facing `organizations.delete_workspace` path already removed workspace memberships, access docs, quota usage, and the workspace doc during phase 1. Use `db_delete_workspace_batch` only from flows that still need full content-plus-structure workspace deletion.

## Organization Delete

`organizations.delete_organization`:

- Rejects the default organization and requires `organizations.ownerUserId` ownership.
- Queues one organization-scope request.
- Removes organization notifications, access-control docs, and all workspace memberships.
- Releases one owner `extra_organizations` quota unit.
- Ensures affected users still have a default tenant.
- Defers organization/workspace docs, quota docs, and heavy content to the worker.

`process_organization_deletion_request`:

- Only owns organization-scope request docs.
- Processes queued workspace requests in that organization first, including workspace ids whose workspace docs were already removed.
- Then deletes remaining workspace docs through `db_delete_workspace_batch`.
- Then deletes organization notifications, access-control docs, organization quota docs, and the organization doc.
- Keeps the queue doc while structure or content remains.

# Workspace Content Purge Coverage

`db_purge_organization_workspace_content_batch` is the tenant-content purge order. When adding a tenant-scoped table with workspace data, update this function and add a narrow index or a parent-doc batching strategy.

Current purge coverage includes:

- `files_pending_updates_cleanup_tasks`, `files_pending_updates`
- `files_pending_updates_last_sequence_saved`
- `ai_chat_files_content`, `ai_chat_files`
- `ai_chat_threads_messages_aisdk_5`, `ai_chat_threads_state`, `ai_chat_threads`
- `api_credentials`, `public_api_grants`
- `plugins_event_run_calls`, `plugins_event_runs`, `plugins_workspace_event_handlers`, `plugins_workspace_installation_secrets`, `plugins_workspace_installations`
- `chat_messages`
- `files_metadata_docs`
- `files_plain_text_chunks`, `files_markdown_chunks`
- `files_yjs_snapshots`, `files_yjs_updates`, `files_yjs_docs_last_sequences`
- `files_snapshots`, `file_stats`
- `files_content_materialization_jobs` with Workpool job cancellation
- `files_r2_assets` with upload-conversion job cancellation and R2 object deletion
- `files_nodes` last

Plugin publish source mounts live in the virtual global tenant (GLOBAL organization / GITHUB workspace), not in any user tenant, so no user or tenant purge reaches them. Deleting plugin registry rows without also sweeping that workspace leaves orphan `files_nodes` trees (plus chunks, file stats, metadata docs, and R2 assets). `github_sources.delete_mount_content_batch` is the reference child-before-parent deletion order for that content.

Use limited `.take(batchSize)` reads for growing tables. Do not reintroduce tenant-sized `.collect()` reads in content purge paths.

When adding a new purge target:

- Add or reuse an index that starts with `organizationId` and `workspaceId`, unless the table is reached safely through a bounded parent doc.
- Put child docs before parent docs.
- Cancel external or Workpool-owned work before deleting the tracking doc.
- Delete external storage objects before deleting the Convex doc that stores the object key.
- Add focused coverage in `packages/app/convex/data_deletion.test.ts` so the new table is proven to be removed.

# Admin Paths

`users.hard_delete_user_now` has three modes:

- `"data"`: data-only reset. Preserve `users`, auth ids, anonymous auth, anagraphic/profile, billing state, default `personal` organization, and default `home` workspace. Clear the user-scope deletion request. Purge content from the preserved home workspace. Delete extra personal workspaces, and delete non-default organizations/workspaces only when the reset user is the only active participant in that tenant scope.
- `"data_and_auth"`: delete tenant/user data and auth state, attempt Clerk deletion, remove anonymous auth tokens, keep the final tombstoned user doc, preserve `billing_usage_snapshots`, schedule period-end subscription cancellation, and drain or schedule queued tenant purge requests.
- `"data_auth_and_user_record"`: delete tenant/user data and auth state, revoke paid subscription immediately, delete the Polar customer immediately, delete `billing_usage_snapshots`, drain or schedule queued tenant purge requests, then purge the local tombstone.

For data-only reset, treat missing or inconsistent default tenant state as an invariant error. Do not recreate default pointers as a silent repair path unless the product rule changes.

# Worker Orchestration

- The daily cron enqueues `data_deletion.enqueue_deletion_requests_processing`.
- `process_deletion_requests` runs through `data_deletion_workpool` with `maxParallelism: 1`.
- Each worker run has a limited mutation-step budget.
- Processing order is user requests, then organization requests, then workspace requests.
- Each request is attempted independently; one failure should be logged and should not stop the whole batch.
- If work remains, enqueue another Workpool action instead of letting one action run unbounded.
- Tests may pass `_test_now`, `_test_batchSize`, and `_test_disableReschedule`; do not use those in production flows.

# Batching Boundaries

- Workspace content purge, workspace structure deletion, organization deletion, and the Workpool loop are explicitly bounded and retryable.
- `process_workspace_deletion_request` deletes content only; `db_delete_workspace_batch` deletes content and structure.
- `db_finalize_deleted_user` currently finalizes user-scoped docs in one mutation after loading them with bounded-by-user queries. If user-scoped memberships, grants, pending updates, auth docs, quota docs, or billing snapshots can grow beyond one safe mutation, split user finalization into its own batched phases before relying on it for large accounts.

# Guardrails

- Keep deletion idempotent. Missing docs are usually already-deleted state, not failure.
- Do not mask broken invariants with fallback repair code unless the relevant producer path is identified and the product rule explicitly wants repair.
- Preserve child-before-parent deletion ordering.
- Cancel Workpool jobs before deleting their tracking docs when a purge owns that job lifecycle.
- Delete R2 objects when deleting `files_r2_assets` with `r2Key`.
- Keep queue docs scoped; user restore removes only user-scope requests.
- Keep billing snapshot deletion tied to full user-record purge, not normal account deletion or data reset.
- Keep public/user-facing mutations responsible for phase-1 permissions, rate limits, quota release, and immediate access removal.
- Keep heavy content deletion in `data_deletion.ts`, not inside UI-facing organization/user mutations.

# Validation

Use focused tests when behavior changes. The usual target is:

```powershell
vp env exec pnpm --dir packages/app exec vitest run convex/data_deletion.test.ts
```

Also consider:

- `convex/users.test.ts` when deleted-account recovery, Clerk cleanup, auth pointers, or `hard_delete_user_now` behavior changes.
- `convex/organizations.test.ts` when organization/workspace delete phase-1 behavior changes.
- Quota tests when quota counters or quota doc cleanup changes.

Do not run lint/typecheck/full test suites unless the user asked for broad verification.
