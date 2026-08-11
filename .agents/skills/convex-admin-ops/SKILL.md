---
name: convex-admin-ops
description: Run live Convex admin/operational CLI tasks safely in this repo, especially destructive internal functions, one-off data cleanup, user hard deletion, environment/deployment checks, export/import recovery snapshots, and targeted readback verification. Use for `convex run`, `convex data`, `convex logs`, `convex export`, `convex import`, or similar commands against the configured dev deployment. Explicit preview or production work requires a separately confirmed target.
---

# Load The Owning Domain Rules

Before a live Convex operation, load the domain skill that owns the behavior being invoked, such as `convex`, `auth-system`, `organizations-tenancy`, or `billing-system`.

# Safety Workflow

1. Identify the target deployment before running a write.
   - In this repo, deployment env lives under `packages/app`.
   - Read only `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, and `VITE_CONVEX_HTTP_URL` from `packages/app/.env.local`. Never print the whole file; it also contains secrets.
   - Treat every command example below as targeting the dev deployment configured in `packages/app/.env.local`.
   - If the user explicitly requests another deployment, confirm its exact identifier and check the installed CLI's help for that command before proceeding. Current commands that support an explicit deployment use `--deployment <deployment-name>`, not `--deployment-name` or `--preview-name`. Do not infer a production or preview target from memory.
2. Confirm the function signature from source before constructing args.
   - Prefer `rg` first, then read the function registration and nearby tests.
   - For destructive account operations, read the relevant auth/data-deletion skill sections.
3. State the function, deployment, and destructive mode before the write.
4. Run the smallest targeted command.
5. Verify durable state with a readback command after the write.

# Windows CLI Invocation

Run Convex commands from `packages/app` through Vite Plus and the installed Node CLI. This direct invocation preserves JSON arguments on this machine:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable "<module:function>" '<json args>'
Pop-Location
```

Do not route JSON args through `pnpm.CMD`, `convex.ps1`, or a nested `powershell -Command`; those paths have stripped JSON quotes on this machine. If Convex reports unquoted keys or values, the function did not run. Fix the direct Node argument and verify it with a read-only function before retrying a write.

The direct-node form is required only for commands that pass JSON arguments (`run`). Commands without JSON args (`data`, `logs`, `function-spec`) may use the troubleshooting skill's `vp env exec pnpm --dir packages/app exec convex ...` form, which works from the repo root. The direct-node form must run from `packages\app` — from the repo root it fails with `MODULE_NOT_FOUND`.

Do not use `npm`, `npx`, Bun, or `bunx`. If a one-off Convex package executable is needed outside an installed workspace binary, use it through Vite Plus: `vp env exec pnpx <package> ...`.

For operational calls that do not depend on local code changes, use:

```text
--typecheck disable --codegen disable
```

Use `--push` only when you intentionally need to deploy local Convex source changes before running the function.

# JSON Args Pattern

For generated args, pass a PowerShell string variable as the final argument:

```powershell
$argsJson = @{
	userId = "m579b05e4rkd8n5af1qmjsee9x860cm5"
	purgeUserMod = "data"
} | ConvertTo-Json -Compress

vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable users:hard_delete_user_now $argsJson
```

If Convex reports a JSON parse error such as unquoted keys or values, stop and fix argument passing before retrying. A parse error means the function did not run.

# User Hard Deletion

The direct admin entrypoint is:

```powershell
users:hard_delete_user_now
```

Arguments:

```json
{
	"userId": "<users id>",
	"purgeUserMod": "data"
}
```

`purgeUserMod` behavior:

- `"data"`: reset data owned by this user while keeping the account live; preserve shared tenant content, the `users` doc, Clerk and anonymous auth state, profile, billing/customer state, and a usable default tenant.
- `"data_and_auth"`: finalize user-scoped data and auth state, queue cleanup for tenants that become empty, preserve shared tenant content, attempt Clerk deletion, remove anonymous auth tokens, keep the final tombstoned `users` doc, and schedule period-end subscription cancellation when applicable. This is true cleanup cancellation, not the normal billing-panel cancellation flow that downgrades a live user to `Free`.
- `"data_auth_and_user_record"`: finalize user-scoped data and auth state, queue cleanup for tenants that become empty, preserve shared tenant content, revoke/delete billing state immediately, and purge the final local `users` doc. This is the only routine admin path that should immediately revoke/delete billing instead of preserving or downgrading the account.

Current cleanup can still leave tenant `activities` and notifications whose recipient was deleted. Read [data-deletion](../data-deletion/SKILL.md#workspace-content-purge-coverage) before treating any mode as complete cleanup.

Use `"data"` when the user wants to wipe app data while keeping the account usable. Use `"data_and_auth"` for account deletion that keeps the final tombstone. Use `"data_auth_and_user_record"` only when the user explicitly wants the final user record purged too.

The action returns `null`. One successful invocation per user is enough: it schedules the same user and mode when bounded user-local work remains, and it hands queued organization/workspace cleanup to the existing Workpool. If the invocation fails on Clerk, Polar, or another external dependency, correct that problem and retry the same user and mode. Record the reset start time and each successful user/mode invocation. Before writing replacement data, inspect only `hard_delete_user_now` scheduled docs created since that start time. Require no `pending` or `inProgress` doc. A failed doc remains unresolved unless a later explicit invocation for the same user and mode succeeded and left no later pending or running continuation. Scheduled history persists for seven days, so an older or superseded failed doc does not fail the new reset. Verify `data_deletion_requests` is empty and confirm the target tables are still empty on a second readback.

# Selective Development User Cleanup

Use this workflow when the user chooses an explicit keep/delete split instead of the full `dev-data-reset` behavior:

1. Record the exact keep, delete, migrate, and untouched scopes. If the request is unclear, stop before any write and ask the user; do not infer a keep set from who appears active.
2. Resolve accounts through live `users` and `users_anagraphics` readbacks. Email or display name may find a candidate, but the exact `users` id is the destructive boundary. Require a unique match for every kept account.
3. Decide with the user whether the operation needs a recovery export. If approved, complete the export workflow below before deletion. A Convex export cannot restore deleted R2 objects or external Clerk/Polar state.
4. If kept data also needs a schema migration, migrate and audit that keep scope before removing its old representation. Load `convex-migrations` for the phase order.
5. Preview every account as `{ userId, displayName/email summary, clerkUserId present, purgeUserMod }`. Build the delete list as exact ids after subtracting the exact keep ids. Do not add or call a deployment-wide `delete_all_except` mutation.
6. Invoke `users:hard_delete_user_now` once per previewed delete id with the approved mode. Track each success and failure explicitly; a failed call does not prove that the user was deleted.
7. Wait for bounded continuations and tenant deletion work as described above. Do not create replacement or migrated data while a continuation can still delete the same scope.
8. Read back `users`, `users_anagraphics`, memberships, deletion requests, and the kept data invariants. Require every remaining membership to belong to a kept user. Report kept-user deletion requests instead of deleting or cancelling them without separate approval.

# File Content Refusal Markers And Yjs Repair

Load `../files-editable-text/SKILL.md` first; it owns the marker and door model. This section is the operator view.

Symptoms map to durable marker fields on the `files_nodes` doc:

- The agent or a reader reports a marker-qualified message (shape mismatch, state too large, content too large) instead of "the file does not exist". Check the node doc for `contentShapeMismatchAt`, `contentYjsStateTooLargeByteSize`, `contentFrontmatterTooLargeFieldCount` / `contentFrontmatterTooLargeIndexDocumentCount`, and the settle marker `contentTooLargeByteSize`.
- Saves refuse with the repair message while `contentShapeMismatchAt` or `contentYjsStateTooLargeByteSize` is set, and also when an update-budget trip hits a settle-marked file (a settled materialization cannot shrink the counters, so "retry in a moment" would be a lie).
- The frontmatter marker pair alone does not block writes: committed content stays at the last sequence that fit, and the user's next fitting edit clears the pair. An over-cap-frontmatter `.md` UPLOAD is born with the pair set (`convex/r2.ts` commits the chunks with the metadata index skipped instead of retrying forever); that node is published and editable, not stuck.

The ONLY recovery for the durable markers is the operator repair:

```powershell
$argsJson = @{
	organizationId = "<organizations id>"
	workspaceId = "<workspaces id>"
	nodeId = "<files_nodes id>"
	authorUserId = "<users id>"
} | ConvertTo-Json -Compress

vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable files_nodes_content:repair_file_yjs_state_from_visible_text $argsJson
```

Rules the action enforces (do not fight them):

- Exact author: `authorUserId` must be an active member of the node's tenant. It is recorded as the author of the repair's new version; an outside id would forge history.
- The default `source: "latest_state"` requires a durable marker on the node (the four fields above; `contentTooLargeByteSize` deliberately does NOT qualify — its visible text is over the cap). It reconstructs the current document under the repair-only 16 MiB cap (`files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES`), with a pre-GET size refusal on the snapshot asset before any download.
- `source: "last_committed"` discards unmaterialized updates and rebuilds from the committed content. It requires `acknowledgeDiscardUnmaterialized: true` and never happens automatically. Export the Yjs snapshot/update assets first when the discarded edits may matter.
- The finalize mutation is staleness-gated: any concurrent write or lineage change between the action's read and the commit makes the repair stale instead of merging onto it. Rerun on a stale refusal.

What a successful repair does: replaces the whole Yjs history with one fresh compact document built from the visible text, swaps every committed representation atomically, clears the markers, resets the update counters, and increments `lineageGeneration` — pending proposals built against the old history become visibly stale instead of merging. The OLD content asset stays under normal snapshot retention (its `files_snapshots` history doc still owns it); only the superseded Yjs snapshot asset is removed, by a bounded continuation. If the repair text still carries over-cap frontmatter, the repair keeps the frontmatter marker pair set with fresh counts and skips the metadata index; everything else still repairs.

After the repair, editors that had the file open must CLOSE or RELOAD the file before writes resume — their in-memory document belongs to the replaced lineage. Readback: confirm the marker fields are gone from the node doc and `lineageGeneration` increased on the `files_yjs_docs_last_sequences` doc.

# Remove A Registered Plugin

Workspace members can uninstall a plugin from its plugin detail page (`plugins.uninstall_version`): that deletes the workspace's event handlers, installation secrets, and installation doc, and keeps event runs/run calls as version-owned history. Registry-level removal remains the internal-only admin flow in `packages/app/convex/plugins.ts`. It targets one plugin name and hard-deletes its versions, reviews (including rejected first publishes with no version), interrupted-upload cleanup attempts and keys, per-version source trees (`/<pluginVersionId>/...` in GLOBAL/PLUGINS), workspace installations and children, version-owned run history, repository claims backing registered versions, and exact R2 artifact objects. Current code does not preview or delete related `activities`; do not describe the result as complete registry cleanup until that gap is fixed.

Run preview → delete → preview readback from `packages/app`:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:preview_hard_delete_registered_plugin '{"pluginName":"<name>"}'
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:hard_delete_plugin_from_registry '{"pluginName":"<name>"}'
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:preview_hard_delete_registered_plugin '{"pluginName":"<name>"}'
Pop-Location
```

The delete command performs one bounded pass. Repeat the same command until it returns `done: true`, then run the preview again. If it returns `{ done: false, deleted: 0 }`, an active plugin run is finishing; wait and retry. The preview returns per-table counts (including `publishCleanupAttempts` and `sourceFileNodes`) plus the distinct known R2 keys; expect those reported counts to be zero after deletion. It does not currently report `activities`, so a zero preview is not proof of complete cleanup. Claim/secret counts include only claims this name cleanup can delete: claims shared with another plugin name or reclaimed by another user stay for their rightful owner or the later reset-wide repository-id step. An R2 deletion failure aborts the mutation and leaves the owning version or cleanup attempt retryable.

A claim can exist before its manifest reveals a plugin name. After all name-scoped previews are zero, delete each remaining exported claim id with:

```powershell
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:hard_delete_publisher_repository_now '{"repositoryId":"<id>"}'
```

This idempotent mutation deletes that claim and its publisher secrets only. Do not run it before name-scoped cleanup.

# Bulk File Import (`data_import`)

`packages/app/convex/data_import.ts` is an internal operator module for bulk-importing files into one workspace. Imports now go through the public API with a write-scoped API key: text files through `/api/v1/files/write` or `/api/v1/files/write-many` (`overwrite: "replace"` for idempotent re-runs, `skipIfUnchanged: true` so re-runs do not mint new versions), and binary files through `/api/v1/files/upload-urls` (presigned PUT urls; pass `skipProcessing: true` for import-style uploads that must skip conversion and plugin dispatch). Ordinary user folder imports do not need any of this: the Files sidebar has a browser bulk import (`files_nodes.create_upload_nodes`, see the [files-explorer-tree skill](../files-explorer-tree/SKILL.md)) that runs the full processing pipeline. What remains here is mostly operator diagnostics:

- `data_import:create_upload_targets` (internalMutation): mints file nodes plus presigned R2 PUT urls for binary files. It inserts assets with `processingWorkId: null`, so the R2 event finalizer records the object without starting conversion or plugin dispatch. Args: `organizationId`, `workspaceId`, `createdBy` (a `users` id), `items` as `[{ path, contentType, size }]`. Re-running a failed path archives and replaces its half-created node. Superseded by `/api/v1/files/upload-urls`, which adds quota and per-path ACL checks; this mutation stays only until the import CLI moves to the public route, then it gets deleted.
- `data_import:verify_run` (query): returns node counts, asset counts, and `pluginEventRuns` for the workspace. Use `assets.unfinalizedActive` (unfinalized assets referenced by an active node) to judge an import: crashed create attempts and archive-and-replace leave unfinalized rows that no active file references, and those are harmless.
- `data_import:list_unfinalized` (query): for each unfinalized asset, lists the active/archived node paths and snapshot references that point at it. Use it to prove an asset has zero references before deleting it with `files_nodes_content:cleanup_file_node_creation_assets` (args need the computed R2 keys `organizations/<org>/workspaces/<ws>/assets/<assetId>`).
- `data_import:verify_metadata` (query): for each given path, counts committed frontmatter metadata docs (`null` when no active node exists). Use it to prove frontmatter indexing after a text import.

Two operational gotchas from the first real run (2026-08-01): R2 events can arrive several minutes late through Cloudflare queue retries, so wait on `unfinalizedActive`, not on raw `unfinalized`; and a crashed create attempt leaves unfinalized asset rows behind. The hourly `cleanup expired unfinalized assets` cron (`r2.ts`) now deletes unreferenced ones about 24 hours after creation; rows still referenced by an archived node are only logged, so use the manual `list_unfinalized` → `cleanup_file_node_creation_assets` flow above for those or when you cannot wait a day.

The import CLI that drives this module lives in the separate private repo `raythurnvoid/bonobo-senate-press-cli`.

Run these functions with the direct-node JSON form from the Windows CLI Invocation section.

# Dev Reset Preserving Clerk Users

For a dev-environment reset where signed-in accounts should keep auth and Polar billing:

1. Confirm the target deployment is not production.
2. Record the reset start time. Enumerate every `users` doc with `data users --format jsonArray --limit 1000`. If the result contains exactly 1000 docs, double the limit until the returned count is below it. Do not infer user ids from auth provider ids. Record the completion time of each successful user/mode invocation.
3. First, for every user with a non-null `clerkUserId`, successfully invoke `users:hard_delete_user_now` with `purgeUserMod: "data"`.
4. Then, for every user without a `clerkUserId`, successfully invoke it with `purgeUserMod: "data_auth_and_user_record"`.
5. Poll `data_deletion_requests` until it is empty. The successful auth-removing calls already enqueue the Workpool. Do not enqueue a second worker while one is queued or running. A manual `data_deletion:enqueue_deletion_requests_processing` call is recovery only after logs and repeated readback show that the queue has stopped and no worker remains.
6. Inspect `hard_delete_user_now` scheduled docs created since the reset started and require no `pending` or `inProgress` continuation. Investigate and retry a failed user/mode pair; a later successful explicit retry resolves that failure when it leaves no later pending or running continuation. Ignore older or superseded failed history. Then verify Clerk-backed user docs and their Clerk/Polar links remain while non-Clerk user docs are gone.

The existing user deletion logic deletes an organization only after its last active user is removed. It preserves shared organizations that still have an active user. Do not add a separate all-users or shared-organization deletion function. Follow `../dev-data-reset/SKILL.md` for plugin cleanup, the current `activities` and notification blockers, and reseeding.

# Data Readback Via `convex data`

`convex data <table> --limit N` can hide ids and long fields when it truncates columns to the terminal width. Prefer `--format jsonArray` for exact values. The command returns at most the requested limit and JSON output does not warn when more docs exist, so increase the limit whenever the returned count equals it. For sensitive tables, prefer a read-only inline query that returns only needed ids, counts, status fields, or redacted data. Never paste PII, decrypted values, or secret material into a report. Pass CLI help through Vite Plus with `vp env exec -- node node_modules/convex/bin/main.js "<command>" --help`; replace the quoted placeholder first. The separator prevents Vite Plus from consuming the child CLI's `--help` flag.

# Export And Import Recovery Snapshots

Use an export only when the user or operator has approved the snapshot and confirmed the exact deployment. Store it in a dated folder under `../t3-chat-+personal/+ai/`, never in the repository. Treat the ZIP as sensitive user data: do not commit it, paste its contents into reports, or upload it elsewhere.

From `packages/app`, export to a new path and name the operation in the file:

```powershell
$deployment = "<confirmed-deployment>"
$snapshotDirectory = "C:\Users\rt0\Documents\workspace\rt0\t3-chat-+personal\+ai\convex-recovery-<YYYY-MM-DD>"
$snapshotPath = Join-Path $snapshotDirectory "before-<operation>.zip"

New-Item -ItemType Directory -Force -Path $snapshotDirectory | Out-Null
vp env exec node node_modules/convex/bin/main.js export --deployment $deployment --path $snapshotPath
Get-Item -LiteralPath $snapshotPath | Select-Object FullName, Length
Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256
```

- Replace every placeholder before running the command. The export path must not already exist.
- Add `--include-file-storage` only when recovery must include Convex file storage. A database-only migration normally needs only database docs.
- Record the deployment, path, size, and SHA-256 hash without reading or printing snapshot contents.
- Do not treat a successful export as permission to start the destructive operation. Confirm that operation separately.

Import only as an explicitly approved recovery action. Confirm the deployment, snapshot path, and import mode immediately before running it. The safe default requires the imported tables to be empty:

```powershell
$deployment = "<confirmed-deployment>"
$snapshotPath = "C:\Users\rt0\Documents\workspace\rt0\t3-chat-+personal\+ai\convex-recovery-<YYYY-MM-DD>\before-<operation>.zip"

Get-Item -LiteralPath $snapshotPath | Select-Object FullName, Length
Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256
vp env exec node node_modules/convex/bin/main.js import $snapshotPath --deployment $deployment
```

Choose a destructive mode only when the user explicitly approves its exact effect:

- `--replace` replaces data in tables present in the snapshot.
- `--replace-all` also deletes or clears tables absent from the snapshot. Reserve it for an approved full-deployment restore.
- `--append` is not a normal snapshot-recovery mode because it can duplicate data or conflict with existing ids.
- Do not add `--yes` unless the user has approved the exact deployment, snapshot, and destructive mode and non-interactive execution is required.

After import, run targeted readbacks for the repaired tables and the original failing flow. Keep the snapshot until the user confirms recovery is complete; do not delete it automatically.

# Verification

Use the smallest readback that proves the requested state:

```powershell
$argsJson = @{ userId = "<users id>" } | ConvertTo-Json -Compress
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable users:get $argsJson
```

Interpret readback carefully:

- A printed user object means the `users` doc still exists.
- No printed result object with exit code `0` means the function returned `null`; for `users:get`, that means the user doc is missing. Unrelated warnings may still appear.
- Nonzero exit code means the verification failed, not that the doc is missing.

For bulk operations, track successes and failures explicitly, then perform a separate readback pass. Treat already-missing docs as idempotent only if the source function does so.

# Environment And Logs

Read only the needed non-secret deployment URLs and ids from `packages/app/.env.local`; never dump the whole file. Use `convex env list --names-only` only when the task must confirm that an exact remote variable exists. Never use `convex env get` for a secret, and never copy a secret value into a command, captured output, or report. Confirm required secret values through an approved operator channel without retrieving them from Convex, a browser page, or logs.

Logs remain available through the local CLI:

```powershell
vp env exec node node_modules/convex/bin/main.js logs --history 100 --success
```

When reporting results, summarize which deployment and function were used. Do not paste secrets into the final answer.
