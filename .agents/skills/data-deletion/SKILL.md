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
- Tenant, workspace, and account purge are named read-only bypasses. These flows delete the whole
  lifecycle scope, so they do not call normal writable guards. They delete locked subtrees like other
  content. See [files-read-only](../files-read-only/SKILL.md).
- Only these flows hard-delete a member's real file. Everywhere else "delete a file" means archive:
  the UI delete, and the Council delete-meeting workflow, which archives the meeting folder through
  `/api/v1/files/service-uploads/archive-destination` instead of removing its files.
  `files_nodes_db_hard_delete_node` outside these purges only ever removes a node that never became
  real content — a rejected agent create proposal, or an upload placeholder that was canceled or
  never finished. An archived file keeps its R2 object and its quota bytes, so archiving frees no
  storage.

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
- `db_drain_user_plugin_publisher_docs_batch`: drains one bounded user-owned publisher phase in child-first order: repository secrets, repository docs, then version reviews. It deletes an unreferenced review. If a global plugin version or another publisher's `lastPublishAttempt` still points at the review, it keeps the immutable decision and clears `createdBy` instead. Replacing that attempt, deleting its repository, or cleaning a failed source snapshot then deletes the anonymized review only after the last version and publish-attempt link is gone. Fresh review persistence, version preparation, and ready finalization recheck the user tombstone and exact repository ownership in their write transactions. A provider call, cached review, or upload that finishes after this drain cannot recreate or expose publisher data. Both user-deletion paths repeat this phase until the deleted user's index is empty before `db_finalize_deleted_user`.
- `db_drain_user_notifications_batch`: deletes one bounded batch of notifications where the deleted user is the recipient, via `by_user`. Both user-deletion paths drain these to zero before `db_finalize_deleted_user`. The per-user cap sweep in `notifications.cleanup_extra_notifications` walks the `users` table, so without this drain a purged user record would leave its notifications unreachable forever. Notifications that only name the deleted user as `actorUserId` stay in the recipient's inbox with the deleted user's name (product decision 2026-08-09: keep the name, do not anonymize).
- `db_drain_user_direct_permission_grants_batch`: deletes one bounded indexed batch of every direct user grant, including file and plugin-scope grants. It schedules the existing stranded-scope cleanup for the plugin scopes named by that batch, so each scope's file access bindings (`plugins_file_access_bindings`, plan 4's `readScopeId` mechanism) follow the surviving principals. Both user-deletion paths drain this index to zero before finalization.
- `db_drain_user_plugin_service_grants_batch`: deletes one bounded `by_actorUser` batch before membership deletion. This prevents same-email recovery and a later invite from making an old service token valid again.
- `prepare_user_for_hard_deletion`: tombstones the user, sets the cross-transaction finalization fence, and drains bounded plugin UI session, publisher-doc, recipient-notification, and direct-permission-grant batches before the admin action performs external provider writes. The action reads the current Polar subscription before calling this mutation.
- `db_drain_user_finalization_batch`: deletes the first non-empty indexed user family in a fixed order. Membership decisions happen while the bounded membership batch still holds its organization ids. Pending-update children stay before parents, and Yjs pages stay before state parents.
- `db_finalize_deleted_user`: the small final phase-2 transaction. Growing user families are already empty. It deletes the one-row anonymous-token and billing-snapshot records when requested. Retained tombstone modes clear tenant/auth pointers and the recovery fence. Full user-record purge deletes the anagraphic and user in this same transaction.
- `db_purge_organization_workspace_content_batch`: deletes tenant content for one `(organizationId, workspaceId)` in bounded batches, then deletes the workspace-level public and service upload budget docs after every target, asset, and file is gone.
- `db_delete_workspace_structure_batch`: deletes workspace notifications, memberships, every workspace-scoped quota doc, access-control docs, and then the workspace doc after content is gone.
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

## Recovery Around Retention

Deleted-account recovery is handled in `users.resolve_user`.

- Recovery is same normalized verified-email only.
- Recovery may run before destructive phase 2 starts or after phase 2 fully succeeds. While bounded finalization is active, `users.deletionFinalizationStartedAt` blocks recovery so a partially deleted account cannot become live. The processor sets this fence in the same transaction as the first destructive batch. Successful retained-tombstone finalization clears it; full user-record purge removes the identity instead.
- Reclaim the same Convex `users` doc, clear `deletedAt`, relink the new Clerk id, reactivate ordinary inactive memberships, remove only the user-scope deletion request, and mark the auth response so billing bootstrap can restore a deletion-triggered Polar period-end cancellation when possible. Do not reactivate or recreate roles for memberships marked `pendingOrganizationRemoval`; the separate bounded organization-removal continuation still owns them.
- Do not remove resource-scope organization/workspace requests during account recovery.
- Do not backfill missing anagraphic email as part of deletion recovery.

## Phase 2

`process_user_deletion_request` runs after `eligibleAt`.

- It only owns user-scope request docs.
- If the user doc is already gone, keep the request through the same bounded user-owned drain order: plugin UI sessions, publisher docs, notifications, direct grants, then `db_drain_user_finalization_batch`. Membership draining still queues an empty personal organization before deleting its last membership. Remove the stale request only after every indexed family is empty.
- A non-tombstoned user request should make no destructive progress and should log.
- Before the small final transaction it drains one indexed family per pass. The order is plugin UI sessions, publisher docs, notifications, direct grants, plugin service grants, memberships, role assignments, pending-update children and parents, last-sequence rows, pending Yjs pages and states, pending text inputs, operation batches, trusted stages, deleted-append replay receipts, plugin member usage, quota rows, API credentials, and public API grants. Receipt deletion returns the installation tombstone slot and the exact old member-counter slot before that counter row is removed. The queued path returns `done: false` after each non-empty batch, so its request doc stays in place.
- Phase 2 sets `users.deletionFinalizationStartedAt` before its first destructive batch. `users.resolve_user` refuses recovery while this field is set. The fence stays through every bounded continuation and is cleared only in the successful finalization transaction, so recovery cannot land between drain batches.
- The admin `internal.data_deletion.finalize_user_deletion_data` entrypoint runs only after provider deletion succeeds. It advances the same finalization families in bounded passes. It then uses `data_deletion_requests.by_user_eligibleAt` to make retained tenant requests immediate in bounded passes. Already-eligible rows do not block that range. Its boolean result says whether local finalization is complete.
- Membership batches queue an immediate organization request before deleting the last member. For a shared non-default organization owned by the deleted user, the chosen successor's role assignments are collected and deleted in the same transaction that transfers `ownerUserId`, changes `billingMode` to `user`, and moves the quota charge. That organization-scoped collect is bounded by the six-workspace product limit. The user-wide membership scan still uses `.take(batchSize)`. This keeps empty-tenant and ownership decisions durable without an unbounded affected-organization loop or a successor-choice race.
- The member-usage table names the user, so its bounded `by_user` pass reaches every workspace, not only those for which a membership still exists. The plugin documents those rows counted stay because they belong to the workspace. Publishing is user-owned — there is no publisher account table. Normal finalization retains the tombstoned `users` doc and its anagraphic, so kept `plugins_versions.createdBy` still resolves and the marketplace can still show that retained display name. The reference becomes dangling, and the display becomes null, only after `purge_deleted_user_tombstone` removes both retained docs. Whether deleted publishers should remain named is an unresolved privacy rule; do not claim that normal finalization anonymizes them.
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
- Removes workspace invite notifications, memberships, active API credential quota docs, role assignments, permission grants, then deletes the workspace doc. It keeps the workspace upload budgets during retention so late accepted R2 events can still settle.
- The queued workspace request later purges heavy content for the deleted workspace id, even though the workspace doc is already gone.

`process_workspace_deletion_request`:

- Only owns workspace-scope request docs.
- Requires both `organizationId` and `workspaceId`; invalid docs are removed.
- Calls `db_purge_organization_workspace_content_batch`. After service targets, assets, and files are gone, that content purge deletes `public_api_upload_bytes` and `plugin_service_storage_bytes`. This ordering keeps service settlement valid during retention and resets a preserved admin-data-reset workspace to fresh upload budgets.
- Keeps the queue doc while content remains.
- Does not delete the remaining workspace structure. The UI-facing `organizations.delete_workspace` path already removed memberships, access docs, active API credential quota docs, released one `extra_workspaces` usage unit, and deleted the workspace doc during phase 1. The content purge itself removes the two workspace upload-budget docs last. Use `db_delete_workspace_batch` only from flows that still need full content-plus-structure workspace deletion.

## Organization Delete

`organizations.delete_organization`:

- Rejects the default organization and requires `organizations.ownerUserId` ownership.
- Queues one organization-scope request.
- Sets `pluginDataPurgeStartedAt` on every retained workspace doc before returning, so plugin
  sessions, services, runs, and store calls stop during retention.
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
- `ai_chat_threads_messages_aisdk_5` (the `aisdk_5` in that name is stored data and does not track the AI SDK major version), `ai_chat_threads_state`, `ai_chat_threads`
- `api_credentials`
- `public_api_grants`
- `public_api_file_write_stages` via `public_api_db_cleanup_file_write_stage`, before the calls/runs/assets passes: staged asset docs have no `r2Key` yet, so the stage cleanup derives the R2 object keys itself and deletes the objects before their asset docs
- Before the first bounded content step, the purge sets `organizations_workspaces.pluginDataPurgeStartedAt`. Before `plugins_event_run_calls`, it changes enabled plugin installations to `disabled` in bounded indexed passes. Then it drains `plugins_event_run_calls`, `plugins_event_runs` with `plugins_runtime_workpool` run cancellation (plugin event runs execute on that dedicated component; R2 asset `processingWorkId` jobs stay on `files_upload_conversion_workpool`), `plugins_workspace_event_handlers`, `plugins_workspace_installation_secrets`, the plugin document store, and finally `plugins_workspace_installations` one installation per pass: its `plugins_ui_sessions` (via `by_installation`) drain one bounded batch per transaction, and the installation doc is deleted only once no sessions remain
- The plugin document store goes through `plugins_data_db_drain_batch` with `installationId: null`, which covers every installation in the workspace. The durable workspace fence makes `plugins.install_version` refuse new installs and re-enables. Every central plugin UI, store, service, and runtime gate also requires the workspace doc to exist with no fence. The later disabled status is a second guard while live scope rows and released fences drain. Both guards stay until the later session and installation passes remove the records. A data-only reset clears the fence only when the full reset finishes; a deleted workspace removes it with the workspace doc, and the missing doc itself keeps the gates closed. The store drain order is: reservations, deleted-append replay receipts, revision tombstones, documents, service grants, `plugins_file_access_bindings` rows, `plugin_scope` grants, live scope rows, then scope lifecycle rows (identity markers plus real released-range fences). Grants go before scope docs so a partial drain fails closed, and released fences go last so stale writers stay refused until both the documents and their live scope docs are gone. The binding drain deletes only the binding rows and leaves the mirrored file `content.read` grants: the bound files belong to the workspace and outlive the plugin, and member removal and workspace purge find those grants through their own tenant indexes. It then drains service destination fences and `plugin_service_storage_targets` only in workspace mode, member usage, and the accounting doc. The accounting doc goes last so it is never the survivor. It runs before the installation pass, so no row points at a deleted installation. An installation-scoped drain writes to no `files_nodes` row and deletes no service destination fence, storage target, or mirrored private-folder `file` grant: files a plugin created belong to the workspace and stay, uploaded and plugin-door-written alike. A `plugin_scope` grant whose `resourceId` is `"<installationId>:<scopeId>"` does leave with its live store row; a `file` grant naming a bound folder stays because the file stays. A placeholder whose upload never finished stays as an empty file a member can delete.
- `activities` after the plugin passes. The run-retention path normally deletes an activity together with its plugin run, but this purge deletes run docs directly, so it drains the leftover activities by the workspace index. Every activity producer needs a live run doc, so no new rows can appear once the run pass is empty.
- `chat_messages`
- `files_metadata_docs`
- `files_plain_text_chunks`, `files_text_chunks`
- `files_yjs_snapshots`, `files_yjs_updates`, `files_yjs_docs_last_sequences`
- `files_snapshots`, `file_stats`
- `files_content_materialization_jobs` with Workpool job cancellation
- `files_r2_assets` with upload-conversion job cancellation and durable exact-key R2 cleanup. This
  also covers `generated_image` assets, the pictures the chat agent drew: they belong to a chat
  message instead of a file node, so nothing in the file tree points at them, but they are ordinary
  asset docs in the workspace and this pass deletes them with the rest. A picture whose message was
  never stored keeps its `unfinalizedExpiresAt` deadline and `cleanup_expired_unfinalized_assets`
  deletes it a day later. A referenced upload retries for at most eight days after its latest signed
  URL. The terminal pass for an ordinary upload removes its placeholder and hands both possible keys
  to the deletion ledger. A pending plugin service upload keeps its empty placeholder, asset doc, and
  target. It hands only its stale staging key to the ledger. Remint and an exact pending create replay
  wait until that job settles, then reuse the same asset and staging key: there is no resume, so the
  service sends the whole file again. If the placeholder is read-only, cleanup defers that handoff and both
  retry doors stay open so the accepted upload can still finish.
  Before deleting an asset doc, create a deletion job for the stored live key or its deterministic live key.
  Also create one for `uploadStagingR2Key` when present. The staging job keeps
  `putMayArriveUntil` through `uploadUrlExpiresAt` plus the normal margin. An older upload without a
  staging key uses the same tombstone on its live key because its signed URL wrote there directly.
- `access_control_permission_grants` before their file scope nodes. This purge step also runs for data-only reset, where the preserved home workspace never reaches structure deletion.
- `files_nodes` last

The exact-key jobs are the durable handoff. The purge deletes the asset docs after it writes the
jobs; the scheduled job action then retries R2 independently. An R2 outage must not roll the Convex
purge back or keep tenant data alive.

**Accepted residue: R2 credentials at rest outside this purge.** The installed Convex version can
declare typed component environment values with `defineComponent(..., { env })`, and a parent can
bind them with `app.use(..., { env })`. The current R2 component does not declare that environment,
so its client passes R2 credentials as retrier arguments and the retrier stores them for about one
week. This workspace purge no longer uses that client path. Other `r2_delete_object` call sites still
do, so moving the component to declared environment values is separate follow-up work.

Keep existing job docs and advance them through the normal exact-key helper. The processor does not need
tenant or asset docs. Each job stays until its processor confirms the R2 file is absent after the
signed URL can no longer be used. The job's final confirm (`settle_object_deletion_job`) is also where a
plugin service upload target is retired: a canonical `assets/<assetId>` key with a committed
`plugin_service_storage_targets` doc consumes that doc. Nothing is refunded — the
`plugin_service_storage_bytes` quota only grows.

An R2 staging event can arrive after the service cancels a pending target, or after the member
discards its failed placeholder. In the same transaction,
`record_untracked_asset_event` hands both the staging key and deterministic live key to the deletion
ledger. This covers a staging-to-live copy that was already running when the asset was deleted. It
charges those stored bytes to the released target. `actualBytes` is both the recorded size and the
amount already charged, so a bigger object charges only the difference. Member discard already releases the service target and keeps the deterministic live-key
job through a fresh upload window in the same transaction that deletes the asset. A target that
committed before deletion keeps its canonical size when later staging events arrive. Duplicate and
smaller events do not charge twice. The target stays released, and the quota is never refunded.

During the retention window, tombstoning an anonymous user also does not revoke every anonymous access path. See the current security gap in [auth-system](../auth-system/SKILL.md#known-anonymous-deletion-gap).

Uninstalling one plugin does not go through this purge. `plugins.uninstall_version` deletes the installation doc in its own transaction. That deletion is the immediate kill switch for every UI session and store door, so the mutation does not need to read an unbounded session list first. It schedules `plugins_data.drain_uninstalled_installation` with the tenant and installation id it already holds, and that mutation drains UI sessions and every store table in bounded batches until nothing is left. The registry hard delete first disables every matching installation in bounded passes, so ordinary producers stop before deletion can spend several calls draining growing tables. It then runs the same drain synchronously, per installation, before deleting the installation doc.

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
- `"data_auth_and_user_record"`: tombstone locally, drain user sessions, revoke the paid subscription, delete the Polar customer, delete Clerk auth, finalize local data/auth/billing state, durably schedule queued tenant purge requests, and atomically delete the anagraphic and user record.

Both auth-removing modes read the current Polar subscription, then call `prepare_user_for_hard_deletion` before any external provider write. The initial Polar lookup can fail before the tombstone exists. After preparation starts, the action sets `users.deletionFinalizationStartedAt`, repeats bounded session, publisher-doc, notification, and direct-grant batches, and schedules the same user and mode when needed. The fence stays set across those continuations and provider failures. After provider writes succeed, the action advances bounded local finalization and tenant-request eligibility passes. If more remain, it schedules the same action; supported provider deletes are idempotent on that retry. Retained-tombstone finalization clears the fence. Full user-record finalization schedules any remaining tenant worker in the same transaction that deletes the anagraphic and user, so an action crash after that commit cannot lose the handoff or reopen same-email recovery.

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
- Plugin UI session deletion is bounded on every path: per-installation batches in workspace purge, installation-scoped batches after public uninstall, per-pass `by_user` batches in the queued user path, and repeated `prepare_user_for_hard_deletion` batches in the direct admin action. Public uninstall revokes sessions immediately by deleting the installation, then the generic drain removes their rows. Direct permission grants use the same queued/direct split through their user-first index, and plugin-scope batches schedule their ACL cleanup after the grant deletes commit. Account finalization also drains service grants through `plugin_service_grants.by_actorUser` before it deletes memberships.
- Plugin document-store deletion is bounded on all three paths through the one `plugins_data_db_drain_batch` helper: workspace-scoped inside the content purge, installation-scoped and self-rescheduling after uninstall, installation-scoped inside the registry hard delete. The registry hard delete also drains the plugin's `plugins_service_registrations` row: the registration is name-scoped and dies with the name, so no tenant path touches it. The stored documents have no user-scoped path, because they belong to an installation and not to the member who wrote them. Two sibling tables are the exception, and both are deleted by the same `remove_user_from_organization` block that already handles public API grants and plugin UI sessions:

  - `plugin_service_grants` names an `actorUserId`. Organization removal ranges `by_organization_workspace_actorUser`; account finalization ranges `by_actorUser`. Interactive grants live 24 hours and sealed processing grants live up to six days, so both drains finish before memberships disappear or can be recreated.
  - `plugins_data_append_replay_receipts` names `createdBy`. Account finalization ranges `by_createdBy`, releases its held installation and exact old member slots, and deletes it before member usage. Installation and workspace deletion remove it through the central store drain.
  - `plugins_data_member_usage` names a `userId`, ranged on `by_organization_workspace_user`. Map it over the memberships the mutation already collected, one per workspace: that mutation removes the user from **every** workspace in the organization, so a single-workspace prune would leave the member's rows behind everywhere else with nothing left to reach them. Re-inviting the same person then starts them from a zeroed share, which is intended — the row is a counter, not an entitlement.

  Those two prunes remove the counters and the grants. A bounded scheduled continuation (`cleanup_stranded_scopes`) then deletes any live plugin scope whose last principal disappeared, and clears the scope's file-access bindings and their mirrored file `content.read` grants when a deleted account or organization empties the scope — the whole fix lives inside `plugins_data_db_keep_scope_managed`, so `data_deletion.ts` and `organizations.ts` need NO change of their own: both already schedule `cleanup_stranded_scopes`. Do not add a second binding-sync call in the deletion modules. The bound node stays restricted after the grants go, so nothing widens. The scope's documents stay because they belong to the installation; released-range fences keep them private. A deleted user's raw id keeps sitting in every document's `createdBy` and `updatedBy`, in `chargedTo`, and inside any key a plugin chose to build from a user id, in every workspace that has the plugin, permanently. Nothing sweeps those opaque plugin values. `db_prepare_user_for_deletion` instead schedules the `users.account.deleted` plugin event from its tombstone branch, once per subscribed installation in each workspace the user belonged to. That event only tells the plugin the id no longer resolves to a person, so it can render them as deleted; it deletes nothing on its own. It also fires at tombstone time, so a `users.resolve_user` recovery during retention returns a user the subscribed plugins were already told was gone — the same accepted exposure as the drains above. Any new table added under the plugin store follows the drain contract: add a bounded pass inside `plugins_data_db_drain_batch` before the accounting doc. When a store row has an access-control grant, delete that exact grant before its row; when a file merely bound by the store outlives the plugin, keep its file grant for the normal file/member/workspace cleanup paths.

- Publisher repository secrets, repository docs, and version reviews are bounded on both user-deletion paths. Delete secrets first, then repository parents, then reviews.
- Recipient notifications are bounded on both user-deletion paths through `db_drain_user_notifications_batch`, after the publisher docs.
- `process_workspace_deletion_request` deletes content only; `db_delete_workspace_batch` deletes content and structure.
- Every growing user-finalization family uses an indexed `.take(batchSize)` pass, except the chosen successor's organization roles: those are bounded to six by the workspace limit and stay atomic with ownership transfer. Pending-update cleanup tasks, exact chunks, plain chunks, and metadata are deleted before their pending-update parent. Pending Yjs pages are deleted before their state parent. The one-row anonymous-token and billing-snapshot invariants stay in the small final transaction.

# Guardrails

- Keep deletion idempotent. Missing docs are usually already-deleted state, not failure.
- Do not mask broken invariants with fallback repair code unless the relevant producer path is identified and the product rule explicitly wants repair.
- Preserve child-before-parent deletion ordering.
- Cancel Workpool jobs before deleting their tracking docs when a purge owns that job lifecycle.
- Hand every possible R2 key to the durable deletion ledger before deleting `files_r2_assets`. Use `r2Key` when set; otherwise derive the deterministic live key. Include the upload staging key and its signed-URL arrival window when present.
- Never delete a `files_r2_object_deletion_jobs` doc during purge. Only its processor may remove it.
  The processor first confirms deletion after the signed URL expires.
- Do not add read-only checks to tenant, workspace, or account purge. These deletion lifecycles are
  named bypasses.
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
