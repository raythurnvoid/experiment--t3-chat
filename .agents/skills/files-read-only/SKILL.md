---
name: files-read-only
description: Spec for the workspace read-only lock on files and folders — the intrinsic post-ACL lock pointer, recursive folder scope, current-lock write checks, accepted-upload completion, exact-key R2 deletion ledger, and 409 `conflict` mapping. Use when changing the lock helpers or write doors in `packages/app/convex/files_nodes.ts` / `files_nodes_content.ts` / `files_pending_updates.ts` / `public_api.ts` / `r2.ts`, the read-only field in `packages/app/convex/schema.ts`, the Yjs provider in `packages/app/src/lib/files-yjs-provider.ts`, or the lock UI in the Files sidebar, folder view, and editors.
---

# Mental Model

Read-only is a property of a file or folder. It is separate from access control. ACL answers who may
act. Read-only answers whether the node may change.

No normal write bypasses a lock. This includes writes from owners, admins, members, API keys, plugin
runs, and agents. `content.permissions.manage` lets a caller lock or unlock a node. It does not let
other writes bypass the lock. Named tenant, workspace, and account deletion flows are lifecycle
bypasses because they remove the whole scope.

The closest OS comparison is the Linux immutable flag (`chattr +i`). It blocks content changes,
rename, and delete. POSIX mode bits and the Windows read-only attribute are different because the
parent folder may still allow rename or delete.

A folder lock covers all active and archived descendants. A locked descendant also protects its
ancestors. The app blocks rename, move, and archive on an unlocked ancestor when that action would
also change the locked descendant.

There are no writable exceptions inside a locked folder. The synthetic root cannot be locked. Clients
cannot send a bypass flag. Copying a locked node out is allowed, but the new copy is writable. The old
`readOnly` creation argument in `files_nodes_content.ts` is only for reserved mount content. It is not
part of this lock system.

# Data Model

On `files_nodes`, beside `restrictedScopeNodeId`:

- `readOnlyScopeNodeId`: `undefined` means writable. The node's own `_id` means it has a direct lock.
  Another id means it inherits the nearest folder lock. Folder cascades include archived descendants
  and stop at nested direct locks.

There is no read-only generation or lock-history table. A past lock does not make later work stale.
Every write checks the current pointer in its final transaction. If the pointer is clear at that time,
the write may continue.

## Upload fields

On `files_r2_assets`:

- `uploadStagingR2Key` is the temporary R2 key used by the signed PUT URL. The URL never writes to the
  live key. The event action checks that the event still matches the staging file. It then copies those
  bytes once to the live key with a conditional PUT. Reusing the URL can change only the staging file.
  It cannot overwrite the published file.
- `uploadUrlExpiresAt` stores when the signed PUT URL expires. Cleanup uses it to know how long another
  PUT may still arrive. It becomes `putMayArriveUntil` on the deletion job. An older asset without this
  field uses `unfinalizedExpiresAt` as a safe fallback.
- `unfinalizedExpiresAt` means the asset is not fully published, or its cleanup is still open. Clear it
  only after publication creates a live reference, or after cleanup reaches a confirmed final result.
  Having an `r2Key` alone is not enough.

## R2 deletion jobs

`files_r2_object_deletion_jobs` stores cleanup work for exact R2 keys. It exists because the R2
component retries only a limited number of times and does not report final success. Starting its
delete flow does not prove that the file was deleted.

- Keep one live job for each exact key. A new cleanup handoff or a new R2 object-create event increases
  the job's `generation`. Delivering the same event id again makes no change.
- The processor reads `{ jobId, generation }` before it calls `deleteR2Object`. It may finish that job
  only when the stored generation still matches. A newer PUT increases the generation, so an older
  delete result cannot finish newer cleanup work.
- `putMayArriveUntil` is the last time another PUT may still arrive. For a user-facing signed URL, it
  is at least `uploadUrlExpiresAt` plus five minutes. Public write stages use `stage.expiresAt` plus
  the same margin. Internal PUTs that already finished before cleanup do not need this field.
- A successful delete before `putMayArriveUntil` keeps the job as a tombstone. It sets
  `nextAttemptAt = putMayArriveUntil`. A second confirmed delete at or after that time may remove the
  job and clear the asset deadline.
- A transaction must create every needed deletion job before it deletes the stage or asset docs.
- The hourly cron processes at most 50 due jobs per page. It schedules another run while more jobs are
  due.
- A successful Yjs repair also sends the old snapshot key to this table before deleting its last asset
  doc. Reserved scopes still use the component cleanup because this table accepts real tenant ids only.

# Operation Matrix

| Operation | Locked file | Locked folder | Unlocked ancestor with a locked descendant |
| --- | --- | --- | --- |
| Open, read, search, download | Allow (ACL applies) | Allow (ACL applies) | Allow |
| Copy path, link, node id | Allow | Allow | Allow |
| Copy content or subtree out | Allow when readable; copy is writable | Same | Same |
| Edit or save content | Block | Not applicable | Allow on unlocked siblings |
| Create child, upload, import, paste media | Not applicable | Block | Allow into unlocked branches |
| Rename | Block | Block | Block for the ancestor |
| Move | Block as source and replacement | Block as source and destination | Block for the ancestor |
| Archive/delete | Block | Block | Block for the ancestor |
| Restore/unarchive | Block until unlocked | Block until unlocked | Block when the restored subtree includes a lock |
| Snapshot browse/download | Allow | Not applicable | Allow |
| Snapshot restore/archive/unarchive | Block | Not applicable | Not applicable |
| Share or change access | Allow with management permission | Same | Allow |
| Reply to an existing comment | Allow with comment permission | Not applicable | Allow |
| Create or resolve an anchored comment | Block (changes a Yjs mark) | Not applicable | Allow on unlocked documents |
| Discard a whole pending proposal | Allow | Allow | Allow |
| Accept/save pending work | Block | Block | Block when any affected subtree is locked |
| Lock/unlock | Only through the dedicated management action | Same | Same |
| Finish an upload accepted before the lock | Allow; the finished file stays locked | Same | Same |
| Materialize an already committed Yjs update | Allow | Not applicable | Allow |
| Tenant/account deletion | Allow through the explicit deletion workflow | Allow | Allow |

Direct `chat_messages` sidecar mutations stay under their current comment ACL rules while a file is locked. The Files UI blocks anchored Create and Resolve when `canEditContent` is false because those actions also change a Yjs mark. The Yjs write gate remains authoritative if a live race reaches it.

# Lock Management

The `read-only` region in `packages/app/convex/files_nodes.ts` owns the full lock system. It includes `set_node_read_only`, `set_node_writable`, `get_node_read_only_management_state`, and the low-level helpers. Keep this code together because it all changes the same `files_nodes` lock pointer.

Both mutations resolve auth and membership, apply the tree-write rate bucket, and require `content.permissions.manage` on the target. A folder lock preflights every distinct restricted scope in the subtree: a manager of an outer open folder must not freeze a hidden restricted subtree they cannot manage. A real transition patches and cascades pointers in one transaction. Idempotent calls make no extra writes. The mutations never patch `updatedBy`/`updatedAt`, and `v.id("files_nodes")` keeps the synthetic root unreachable.

- Lock: an already explicit lock is an idempotent success. A node that is only inherited may take its own explicit lock (pointer becomes itself), so it stays locked if the outer lock is later removed.
- Unlock: only an explicit root unlocks directly. Its pointer is replaced with the parent's current pointer and cascaded, so a still-locked parent keeps the node effectively read-only.
- New nodes: user creation already refused a locked destination, so inserted nodes start unlocked. A named migration/repair path allowed to create below a lock sets the inherited pointer — bypass means the creation is allowed, not that the new node is writable.

# Enforcement Rules

- Use this order at every write door: auth and membership → ACL → read-only check → conflict
  details → writes. Keep read-only outside the generic ACL code because owners pass ACL checks by
  design. Lock and unlock require management permission, but they must be able to change the lock
  being managed.
- Every final user-write transaction checks the current lock before its first write. This includes a
  Yjs push, file create, snapshot restore, Yjs repair, pending Save or Accept, and public text publish.
  A lock removed before this check does not refuse the write.
- Other safety checks still apply. A public replacement keeps the expected target node id. A pending
  replacement keeps the ordered source node ids. These checks stop the operation from changing
  different files from the ones the user reviewed.
- If a final mutation refuses after R2 writes already happened, it sends every written exact key to
  `files_r2_object_deletion_jobs` before deleting temporary docs.
- Upload publication and conversion finish a node and signed target that the app already accepted.
  A later lock does not cancel this work.
- Rename, move, archive, unarchive, and replace use the complete operation plan they already build.
  Check that plan before the first write. One locked affected node refuses the whole call. Archive also
  checks archived descendants for locks without widening normal ACL access.
- Build read-only subtrees from stored `parentId` links. Do not use `path` or `treePath` prefixes. An
  archived tree and a newer active tree may use the same path, but they are separate trees. A lock in
  one must not affect the other.
- Clients cannot request a bypass. Tenant, workspace, and account deletion are named lifecycle
  bypasses in `data_deletion.ts`. Named migration and repair entrypoints may also bypass the lock.
  Normal operator imports in `data_import.ts` do not bypass it.
- If discard or expiry finds a locked eager-created node or created ancestor, remove the pending docs
  but keep the empty committed branch. `eagerCreated` stores the creation-time committed sequence and
  optional `createdAncestorIds`. Cleanup checks every existing node's current lock before its first
  hard delete. It then runs the existing checks that prove the nodes were not changed.
- Workspace Bash writes create pending proposals and follow the same rules; `/tmp` stays writable, and `cp` may read a locked source (copy-out).
- Hidden-source privacy (RO-10): a refusal never names or reveals a hidden node. Public query boundaries project `readOnlyState` and return `readOnlySourceNodeId`/path only when the source is in the caller's authorized result; otherwise the UI says `Read-only from a protected folder.` The management query returns the non-identifying `hasInheritedParentLock` flag instead of the outer node's id, name, or path.

# Error Contract

- Internal: `Result({ _nay: { name: "read_only", message: "This item is read-only." } })`. Callers branch on `_nay.name`, never the message. No `_nay.data` and no new validator.
- Public API: HTTP `409 Conflict` with the existing code `conflict` and the message `This item is read-only.` Never map a lock refusal to `permission_denied` — the caller may have permission and still be blocked by resource state.
- Batch semantics stay route-shaped: `/files/write-many` reports read-only as a per-item `conflict` and continues later items. `/files/touch` returns a request-level 409 and may keep earlier sequential touches. `/files/upload-urls` preflights the whole batch and returns one request-level 409 naming the offending caller-supplied path, minting nothing. Single write/fill routes return their normal request-level 409, and plugin routes settle with the existing `conflict` code. `skipIfUnchanged` still answers 409 on a locked target.

# Race Rules

- Lock during a write: the final mutation checks every affected node before its first write. It refuses
  while a lock is present. It continues if the lock was removed before this check. Identity, ACL, and
  content-staleness checks still apply.
- Accepted upload: creating the upload node, asset doc, staging key, and signed target accepts the
  upload. A later lock, or a lock and unlock cycle, does not cancel the upload, conversion, or
  upload-completed plugin event. The live key is immutable, so a reused signed URL cannot overwrite
  the published bytes.
- Yjs uses the same current-lock rule. The server checks the lock in `yjs_push_update`. If a queued update reaches the server after the file is writable again, the server may accept it.
- A read-only refusal is final for the queued local edits. The provider does not retry them. It drops them, reloads the saved document, and shows: `This file became read-only, so your unsaved changes were not saved. The saved version was reloaded.`
- A permission refusal shows a warning on the first refusal: `You no longer have permission to edit this file. Your unsaved changes were not saved.`
- A rate limit or network error keeps the queued edits and retries every 5 seconds. These cases do not show the final refusal warning.
- A compaction refusal means the server is joining old Yjs updates to free space. The provider retries 5 times and waits 5 seconds between retries. It shows the final refusal warning if the server refuses the sixth request.
- For a currently absent destination, publication resolves the path again and checks current ACL and locks. A past lock on a folder that is now unlocked, archived, or deleted does not stale the write. A target that appeared at the exact path is still a normal identity conflict and cannot be overwritten by stale create work.
- A durable pending proposal committed before a lock stays visible. Accept, Save, and rebase fail while an affected node is locked. If every affected node is writable again before the final mutation, even an operation that started before the lock → unlock cycle may finish.

# Accepted Upload Completion

The upload flow is:

1. The signed PUT writes to `uploadStagingR2Key`.
2. The event action checks that the current staging ETag and size match that event. A stale event cannot
   publish newer staging bytes with older metadata.
3. The action copies the matching bytes once to the immutable live `r2Key`.
4. The action reads the live file metadata and publishes it.
5. The action sends the staging key to `files_r2_object_deletion_jobs`. Cleanup keeps watching that key
   until the signed URL can no longer be used.

Ignore events for an already published live key. A late or reused signed URL can change only the
staging file.

If the live copy succeeds but publication or an event retry fails, keep `unfinalizedExpiresAt`. The
hourly unfinalized-asset sweep schedules the same safe staging-to-live action again and moves the
deadline forward. Recovery retries hourly for the first 30 hours after the latest signed URL was
issued, then once a week. After eight days it deletes the failed placeholder and hands both possible
keys to the durable deletion ledger. If the placeholder is read-only, cleanup keeps it and checks
again a week later. Releasing a plugin-service upload envelope follows the same lock rule; only a
named workspace deletion bypasses it. The slow retry exists because an hourly copy attempt for an
upload the caller abandoned costs more than it can ever recover.

When an unfinished upload is discarded, create deletion jobs for both possible keys before deleting
its docs. The staging key keeps the signed-URL arrival window. The deterministic live key has no
arrival window. The live-key job covers a crash after the copy but before the mutation stored `r2Key`.
Stale operator-repair uploads use this durable table for real tenants. Reserved scopes still use the
limited component cleanup.

After acceptance, a lock only changes what may start next. The R2 event still publishes the file, text conversion still creates the editable representation, and upload-completed plugins still receive the event. The finished node keeps its direct or inherited lock. New edits, replacements, renames, moves, and deletes remain blocked.

- UI: the normal waiting/processing state changes to the normal ready state. No separate read-only recovery action is needed.
- Rich-text media: the asset upload may finish after its destination locks. Inserting the reference still checks whether the document is editable. If the document locked during the upload, keep the visible asset file and explain that it uploaded but was not inserted.

# UI Capability Model

Derive operation-specific capabilities instead of one broad `canWrite`:

| Capability | Meaning |
| --- | --- |
| `canEditContent` | ACL write and no effective lock |
| `canReceiveChildren` | Folder ACL write and the folder is not effectively locked |
| `canRelocateOrRename` | Source ACL write, no effective lock, no VISIBLE locked descendant |
| `canArchiveOrRestore` | Same subtree rule plus existing restore/restricted-scope rules |
| `canManageReadOnly` | `content.permissions.manage` on the lock target |
| `readOnlyState` | `writable`, `self`, or `inherited` |
| `hasVisibleReadOnlyDescendant` | One ancestor-id set derived from the authorized `list_tree` result; no per-row subtree scan |

Locked rows stay selectable, openable, searchable, and expandable; the lock mark is separate from the restricted-access icon. Exact accessible row descriptions:

- `<name>, read-only` for a direct lock.
- `<name>, read-only from <visible path>` for an inherited lock with a readable source.
- `<name>, read-only from a protected folder` for an inherited lock with a hidden source.
- `<name>, contains read-only items` for an unlocked visible ancestor.

Tooltips use `Read-only`, `Read-only from /docs`, and `Contains read-only items`. The lock control labels are `Make read-only`, `Make writable`, `Remove direct lock` (explicit lock under an outer lock, driven by `hasInheritedParentLock`), and `Add direct lock` (on an inherited node, to keep it locked if the outer lock is removed). Top-status strings: `This file is read-only.`, `Read-only because /docs is locked.`, `This folder contains read-only items. It cannot be renamed, moved, or archived.`

# Requirements

| ID | Requirement |
| --- | --- |
| RO-01 | A direct or inherited lock blocks every user-originated committed content change |
| RO-02 | Locked names, paths, parents, archive state, and child entries cannot change |
| RO-03 | Owners and admins do not bypass an active lock |
| RO-04 | `content.permissions.manage` is required to lock or unlock |
| RO-05 | Folder locks apply to active and archived descendants and preserve nested explicit locks |
| RO-06 | Reads, search, downloads, sharing, safe comment replies, and copy-out keep working |
| RO-07 | Every final transaction checks current lock state before its first write |
| RO-08 | A past lock does not refuse a write that is writable in the final transaction; normal ACL, identity, and content-staleness checks still apply |
| RO-09 | Existing pending proposals stay visible; accept/save fail while locked; discard remains available |
| RO-10 | Read-only checks do not reveal hidden restricted descendants |
| RO-11 | Committed-Yjs convergence and accepted uploads finish; node-deleting cleanup respects locks |
| RO-12 | UI state changes reactively and stays usable by keyboard, at 200% zoom, and with assistive names |
| RO-13 | API clients get one stable read-only conflict without new public error vocabulary |
| RO-14 | A refused final transaction commits no partial state; every multi-step flow has explicit cleanup or a durable terminal outcome |

# Test Map

- `convex/files_nodes.test.ts` — pointer/cascade states, tree operations, current-lock Yjs/snapshot/repair checks, lock → unlock success, upload-node and failed-upload-discard refusals, copy-out controls.
- `convex/files_pending_updates.test.ts` — proposal/accept/discard behavior, current-lock final checks, lock → unlock completion, and eager-created cleanup.
- `convex/public_api.test.ts` — 409 `conflict` contract, batch semantics, current-lock final checks, target identity conflicts, lock → unlock success, and zero partial output.
- `convex/plugins.test.ts` — locked plugin output, zero writes, source-only lock still allows a writable destination.
- `convex/r2.test.ts` — post-lock accepted upload publication, lock → unlock completion, immutable staging/live behavior, conversion completion, deletion-job generations/tombstones/durability, and crash-orphan recovery.
- `convex/data_deletion.test.ts` — lifecycle bypass and deletion-job ownership across purge.
- `convex/data_import.test.ts` — normal import respects locks; bypasses are named and internal.
- `convex/access_control.test.ts` — management authority, owner non-bypass, public-query projection privacy, hidden-outer-lock management state.
- `src/lib/files-yjs-provider.test.ts` — current-lock terminal drop, access-change resync, and unchanged transient retries.
- `server/bash.ts` in-source `action_run` — command matrix and eager-create compensation.
- `server/server-ai-tools.test.ts` — tool description says locked paths are read-only and copy-out is allowed.
- Frontend: sidebar in-source tests, `file-editor-sidebar-pending.test.tsx`, plain/diff editor and snapshot-modal tests, comment-tool tests, and lock-modal tests.

# Related Skills

- `../access-control/SKILL.md` — who may act; the lock is the post-ACL "may it change at all" gate.
- `../files-agent-pending-updates/SKILL.md` — proposals, accept/discard, and eager cleanup under the lock.
- `../files-editable-text/SKILL.md` — the Yjs write doors and shape guards the lock sits above.
- `../files-explorer-tree/SKILL.md` — sidebar row states and interactions.
- `../public-api/SKILL.md` — routes, batch contracts, and the `conflict` vocabulary.
- `../data-deletion/SKILL.md` — the named lifecycle bypass and durable asset cleanup.
- `../ai-chat-agent/SKILL.md` — agent and Bash tool behavior against locked paths.
- `../files-rich-text-embeds/SKILL.md` — document and destination checks before media node creation.
- `../plugin-system/SKILL.md` — plugin output cannot bypass a lock.
