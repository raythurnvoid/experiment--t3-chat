---
name: data-deletion
description: Data deletion, account deletion, admin user data reset, delayed purge queues, R2 asset cleanup, and Workpool deletion orchestration. Use when changing `packages/app/convex/data_deletion.ts`, `data_deletion_requests`, `users.delete_current_user_account`, `users.hard_delete_user_now`, organization/workspace delete purge behavior, or tests for deletion retention and cleanup.
---

# Required Companion Rules

Load each companion skill that owns the affected boundary:

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
- `db_drain_user_plugin_ui_sessions_batch`: deletes one bounded batch of a user's `plugins_ui_sessions` docs via `by_user`. Both user-deletion paths drain these to zero before `db_finalize_deleted_user`, which therefore never reads them.
- `db_drain_user_plugin_publisher_docs_batch`: deletes one bounded user-owned publisher phase in child-first order: repository secrets, repository docs, then version reviews. Both user-deletion paths drain these docs to zero before `db_finalize_deleted_user`.
- `db_drain_user_notifications_batch`: deletes one bounded batch of notifications where the deleted user is the recipient, via `by_user`. Both user-deletion paths drain these to zero before `db_finalize_deleted_user`. The per-user cap sweep in `notifications.cleanup_extra_notifications` walks the `users` table, so without this drain a purged user record would leave its notifications unreachable forever. Notifications that only name the deleted user as `actorUserId` stay in the recipient's inbox with the deleted user's name (product decision 2026-08-09: keep the name, do not anonymize).
- `prepare_user_for_hard_deletion`: tombstones the user and drains bounded plugin UI session, publisher-doc, and recipient-notification batches before the admin action performs external provider writes. The action reads the current Polar subscription before calling this mutation.
- `db_finalize_deleted_user`: phase 2 for a tombstoned user. It deletes user-scoped docs and returns organizations that became empty. Its user-scoped drains include the paged pending-state family and its operation scaffolding via `by_user`: `files_pending_update_yjs_states` (with their pages), `files_pending_update_text_inputs`, `files_pending_update_operation_batches`, and `files_yjs_trusted_update_stages`.
- `db_purge_organization_workspace_content_batch`: deletes tenant content for one `(organizationId, workspaceId)` in bounded batches.
- `db_delete_workspace_structure_batch`: deletes workspace notifications, memberships, active API credential quota docs, access-control docs, and then the workspace doc after content is gone.
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
- Before finalization it drains bounded plugin UI session, publisher-doc, and recipient-notification batches. Publisher secrets are deleted before their repository parents, followed by version reviews. The queued path returns `done: false` after each non-empty batch, so its request doc stays in place. The direct admin preparation returns `false`, so its action schedules another bounded pass. Finalization never reads those growing tables.
- A post-retention reclaim through `users.resolve_user` can land between drain batches. Already-drained notifications are not restored then — the same accepted exposure as the session and publisher drains.
- The standalone `internal.data_deletion.finalize_user_deletion_data` entrypoint drains nothing itself; its contract assumes `prepare_user_for_hard_deletion` already ran the drains. A CLI-driven finalize alone does not remove notifications.
- `db_finalize_deleted_user` deletes the remaining user-scoped memberships, role assignments, direct user grants, API credentials, public API grants, pending-update docs, last-sequence docs, and user quota docs. Publishing is user-owned — there is no publisher account table. Normal finalization retains the tombstoned `users` doc and its anagraphic, so kept `plugins_versions.createdBy` still resolves and the marketplace can still show that retained display name. The reference becomes dangling, and the display becomes null, only after `purge_deleted_user_tombstone` removes both retained docs. Whether deleted publishers should remain named is an unresolved privacy rule; do not claim that normal finalization anonymizes them.
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
- Removes workspace invite notifications, memberships, active API credential quota docs, role assignments, permission grants, then deletes the workspace doc.
- The queued workspace request later purges heavy content for the deleted workspace id, even though the workspace doc is already gone.

`process_workspace_deletion_request`:

- Only owns workspace-scope request docs.
- Requires both `organizationId` and `workspaceId`; invalid docs are removed.
- Calls `db_purge_organization_workspace_content_batch`. Active API credential quota docs are workspace structure, so the UI-facing delete removes them in phase 1 and internal full-delete flows remove them through `db_delete_workspace_structure_batch`.
- Keeps the queue doc while content remains.
- Does not delete workspace structure. The UI-facing `organizations.delete_workspace` path already removed workspace memberships, access docs, active API credential quota docs, released one `extra_workspaces` usage unit, and deleted the workspace doc during phase 1. Use `db_delete_workspace_batch` only from flows that still need full content-plus-structure workspace deletion.

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

- `files_pending_update_yjs_state_pages`, `files_pending_update_yjs_states`, `files_pending_update_state_cleanup_tasks`, `files_pending_update_text_inputs`, `files_pending_update_operation_batches`, `files_yjs_trusted_update_stages` — the paged pending-state family and its operation scaffolding, child docs first (pages before states, text inputs before batches), all before the pending-update docs they belong to
- `files_pending_updates_cleanup_tasks`, `files_pending_updates`
- `files_pending_updates_last_sequence_saved`
- `ai_chat_files_content`, `ai_chat_files`
- `ai_chat_threads_messages_aisdk_5`, `ai_chat_threads_state`, `ai_chat_threads`
- `api_credentials`
- `public_api_grants`
- `public_api_file_write_stages` via `public_api_db_cleanup_file_write_stage`, before the calls/runs/assets passes: staged asset docs have no `r2Key` yet, so the stage cleanup derives the R2 object keys itself and deletes the objects before their asset docs
- `plugins_event_run_calls`, `plugins_event_runs` with `plugins_runtime_workpool` run cancellation (plugin event runs execute on that dedicated component; R2 asset `processingWorkId` jobs stay on `files_upload_conversion_workpool`), `plugins_workspace_event_handlers`, `plugins_workspace_installation_secrets`, then `plugins_workspace_installations` one installation per pass: its `plugins_ui_sessions` (via `by_installation`) drain one bounded batch per transaction, and the installation doc is deleted only once no sessions remain
- `activities` after the plugin passes. The run-retention path normally deletes an activity together with its plugin run, but this purge deletes run docs directly, so it drains the leftover activities by the workspace index. Every activity producer needs a live run doc, so no new rows can appear once the run pass is empty.
- `chat_messages`
- `files_metadata_docs`
- `files_plain_text_chunks`, `files_text_chunks`
- `files_yjs_snapshots`, `files_yjs_updates`, `files_yjs_docs_last_sequences`
- `files_snapshots`, `file_stats`
- `files_content_materialization_jobs` with Workpool job cancellation
- `files_r2_assets` with upload-conversion job cancellation and R2 object deletion. When `r2Key` is not set, derive the deterministic asset key because the browser PUT may have landed before its event updated the asset doc.
- `access_control_permission_grants` before their file scope nodes. This purge step also runs for data-only reset, where the preserved home workspace never reaches structure deletion.
- `files_nodes` last

During the retention window, tombstoning an anonymous user also does not revoke every anonymous access path. See the current security gap in [auth-system](../auth-system/SKILL.md#known-anonymous-deletion-gap).

Plugin publish source trees live in the virtual global tenant (GLOBAL organization / PLUGINS workspace) under version-keyed roots `/<pluginVersionId>/...`, not in any user tenant, so no user or tenant purge reaches them. `plugins.hard_delete_plugin_from_registry` sweeps each version's tree (via `files_nodes_db_delete_subtree_batch`) before deleting the version doc, so registry hard deletes leave no source-tree file-node or R2 orphans. Activities cannot exist in these reserved tenants: their `organizationId`/`workspaceId` fields are strict ids, while the GLOBAL sentinels are plain strings. `plugins.delete_plugin_source_tree_batch` drains a single version's tree if one was ever orphaned. GitHub mirror trees follow the same shape under GLOBAL/GITHUB commit-keyed roots `/<name>/<commitSha>/...`: `github_mounts.clear_pending_root_batch` and `github_mounts.gc_sweep_mount_roots` drive `files_nodes_db_delete_subtree_batch`, the shared child-before-parent deleter both flows rely on.

Use limited `.take(batchSize)` reads for growing tables. Do not reintroduce tenant-sized `.collect()` reads in content purge paths.

When adding a new purge target:

- Add or reuse an index that starts with `organizationId` and `workspaceId`, unless the table is reached safely through a bounded parent doc.
- Put child docs before parent docs.
- Cancel external or Workpool-owned work before deleting the tracking doc.
- Delete external storage objects before deleting the Convex doc that stores the object key.
- Add focused coverage in `packages/app/convex/data_deletion.test.ts` so the new table is proven to be removed.

# Admin Paths

`users.hard_delete_user_now` has three modes:

- `"data"`: data-only reset. Preserve `users`, auth ids, anonymous auth, anagraphic/profile, billing state, default `personal` organization, and default `home` workspace. Clear the user-scope deletion request. Purge content and file permission grants from the preserved home workspace and reset its active API credential quota counter. Force queued personal-workspace purges and delete extra personal workspaces. Delete personal custom roles only after every home and extra-workspace file grant is gone. Force queue-only workspace purges in every other reviewed organization because a phase-1 delete may have already removed the workspace doc. Delete non-default organizations/workspaces only when the reset user is the only active participant in that tenant scope.
- `"data_and_auth"`: tombstone locally, drain user sessions, schedule period-end subscription cancellation, delete Clerk auth, finalize local user data/auth, keep the tombstone and `billing_usage_snapshots`, then hand queued tenant purge requests to the Workpool.
- `"data_auth_and_user_record"`: tombstone locally, drain user sessions, revoke the paid subscription, delete the Polar customer, delete Clerk auth, finalize local data/auth/billing state, hand queued tenant purge requests to the Workpool, then purge the local tombstone.

Both auth-removing modes read the current Polar subscription, then call `prepare_user_for_hard_deletion` before any external provider write. The initial Polar lookup can fail before the tombstone exists. After preparation starts, the action repeats bounded session and publisher-doc batches and, when needed, schedules the same user and mode to continue. Provider writes, external cleanup, and finalization start only after those batches are empty, so a later provider failure leaves a local tombstone with the provider ids needed for an idempotent retry.

Because this admin path is immediate, finalization removes its user-scope request and makes every existing organization/workspace request created by that user eligible immediately. The ordinary deletion worker then drains those resource requests without waiting for their original retention date. Requests created by other users are not changed.

The action returns `null`; completion is not a caller-driven batching contract. One successful invocation per user is enough: it schedules the same user and mode when bounded user-local work remains. If an external provider makes the invocation fail, fix the provider problem and retry the same user and mode. After finalization, the action asks the existing Workpool to process any tenant requests; it never runs the global queue inline. Reset automation must finish the scheduled-action, queue, and table readback gates before it starts reseeding.

For a disposable development-data reset, enumerate every user and inspect `clerkUserId` before choosing the mode. Process all Clerk-backed users first, followed by users without Clerk ids, so a preserved member is reset before a local-only owner is removed. A non-null `clerkUserId` always requires `"data"`: never delete that `users` doc, because it is the stable local identity that keeps Clerk and Polar customer/billing state connected. Use `"data_auth_and_user_record"` for users without a Clerk id. The ordinary deletion logic decides tenant cleanup: it deletes an organization only when no active user remains and preserves it when another user still belongs to it. If the removed user owned that surviving organization, finalization patches `ownerUserId` to a remaining active default-workspace member, deletes that member's assignments across every workspace in the organization, forces `billingMode: "user"`, and moves the quota charge. Do not add a special deployment-wide organization delete. See `../dev-data-reset/SKILL.md` for the full wipe and plugin reseed procedure.

For data-only reset, treat missing or inconsistent default tenant state as an invariant error. Do not recreate default pointers as a silent repair path unless the product rule changes.

# Worker Orchestration

- The daily cron enqueues `data_deletion.enqueue_deletion_requests_processing`.
- `process_deletion_requests` runs through `data_deletion_workpool` with `maxParallelism: 1`.
- Each worker run has a limited mutation-step budget.
- Processing order is user requests, then organization requests, then workspace requests.
- Each request is attempted independently; one failure should be logged and should not stop the whole batch.
- A failed organization/workspace request moves to the back of the already-due queue before the next Workpool pass. It stays eligible and retryable, while later tenant cleanup can continue.
- If work remains, enqueue another Workpool action instead of letting one action run unbounded.
- Tests may pass `_test_now`, `_test_batchSize`, and `_test_disableReschedule`; do not use those in production flows.

# Batching Boundaries

- Workspace content purge, workspace structure deletion, organization deletion, and the Workpool loop are explicitly bounded and retryable.
- Plugin UI session deletion is bounded on all three paths: per-installation batches in workspace purge, per-pass `by_user` batches in the queued user path, and repeated `prepare_user_for_hard_deletion` batches in the direct admin action.
- Publisher repository secrets, repository docs, and version reviews are bounded on both user-deletion paths. Delete secrets first, then repository parents, then reviews.
- Recipient notifications are bounded on both user-deletion paths through `db_drain_user_notifications_batch`, after the publisher docs.
- `process_workspace_deletion_request` deletes content only; `db_delete_workspace_batch` deletes content and structure.
- `db_finalize_deleted_user` still finalizes the remaining user-scoped docs in one mutation. If memberships, grants, pending updates, auth docs, quota docs, or billing snapshots can grow beyond one safe mutation, split them into their own batched phases before relying on finalization for large accounts.

# Guardrails

- Keep deletion idempotent. Missing docs are usually already-deleted state, not failure.
- Do not mask broken invariants with fallback repair code unless the relevant producer path is identified and the product rule explicitly wants repair.
- Preserve child-before-parent deletion ordering.
- Cancel Workpool jobs before deleting their tracking docs when a purge owns that job lifecycle.
- Delete R2 objects before deleting `files_r2_assets`. Use `r2Key` when set; otherwise derive the deterministic asset key.
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

For a live purge check on the dev deployment, two CLI levers avoid waiting out the grace window:

- Seed a purge fixture row with `vp env exec pnpx convex import --table <table> --append --yes <file.jsonl>`. Id fields only need to decode for the right table, so referencing an existing doc from another tenant is fine for purge proofs.
- Process one queued request early with `vp env exec pnpx convex run data_deletion:process_organization_deletion_request '{"requestId":"..."}'` (or the workspace/user variant) in a loop until `done: true`. This targets a single request by id, so other queued requests keep their undo window. Do not force the whole queue early with `process_deletion_requests` and `_test_now`.
