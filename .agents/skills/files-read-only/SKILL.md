---
name: files-read-only
description: Spec for the local Read-only flag, machine force grants, Copy and Restore receipts, bulk changes, editor recovery, accepted uploads, and exact-key R2 cleanup. Use when changing file write checks, creation, moves, pending work, public file doors, or Files controls.
---

# Mental Model

Read-only stops normal changes. It is separate from sharing. A person with Can edit can set or
clear it. Can manage still controls sharing. Owners and admins do not bypass Read-only.

Each file and folder has one local flag. A folder's flag guards the folder and its direct child
list. It does not guard content deeper inside. Rename and Move check the named item, its source
parent, and its destination. They carry descendants without changing their flags.

Normal app, agent, and Bash writes never force. A machine request may pass explicit `force: true`
only with its current Manage Read-only grant. Force skips the flag check only. It never grants
access, clears a flag, changes a destination seal, or removes a content-version check.
One exception: an agent delete that the user approves on Accept. See "Human-approved delete
exception" below.

There are no selected writers or new-item defaults. Ordinary new items start writable.
Copy preserves Read-only on new copies. Restore preserves it on the same item. These operations
need their normal authority; preserving a flag does not require permission to set arbitrary flags.
The synthetic workspace root has no flag.

# Data Model

`files_nodes` stores `readOnly: boolean` and the internal `readOnlyDecisionId: string | null`.

- False means null ID. Setting false to true mints one server UUID.
- True to true keeps its ID. Clearing and setting again makes a new ID.
- Move, Rename, Restore, and forced writes preserve both fields.
- An independent copy gets a fresh ID when it is Read-only.
- Flag changes do not change the item's modified time.
- Public node views expose the boolean and write access, never the decision ID.

The ID identifies one decision to make an item Read-only. It is not permission. Copy and Restore
receipts use it with their existing target, generation, path, and run proofs. A matching receipt
does not replace current ACL, credential, scope, content, or placement checks.

Flag fields stay outside Move placement snapshots. Publishing a prepared Move must not restore
an old flag over a later change.

## Upload fields

On `files_r2_assets`:

- Each external attempt gets a fresh asset ID and writes directly to its canonical `assets/<assetId>`
  key. The signed `If-None-Match: *` header prevents overwriting an existing object. Keep `r2Key`
  unset until the final mutation confirms the stored bytes and publishes their size and etag.
- `uploadUrlExpiresAt` stores when the signed PUT URL expires. Cleanup uses it to know how long another
  PUT may still arrive. It becomes `putMayArriveUntil` on the deletion job. An older asset without this
  field uses `unfinalizedExpiresAt` as a safe fallback.
- `unfinalizedExpiresAt` means the asset is not fully published, or its cleanup is still open. Clear it
  only after publication creates a live reference, or after cleanup reaches a confirmed final result.
  Having an `r2Key` alone is not enough.
- `uploadRetiredAt` fences a retained service placeholder after terminal cleanup starts. A late event
  cannot publish it. A service retry always creates a new asset and never clears this marker.

## R2 deletion jobs

`files_r2_object_deletion_jobs` stores cleanup work for exact R2 keys. It exists because the R2
component retries only a limited number of times and does not report final success. Starting its
delete flow does not prove that the file was deleted.

- Keep one live job for each exact key. A new cleanup handoff or a new R2 object-create event increases
  the job's `generation`. Delivering the same event id again makes no change.
- `failureCount` counts failed deletes in the current generation and resets when the generation advances.
- The processor reads `{ jobId, generation }` before it calls `deleteR2Object`. It may finish that job
  only when the stored generation still matches. A newer PUT increases the generation, so an older
  delete result cannot finish newer cleanup work.
- `putMayArriveUntil` keeps the job through the signed URL's arrival window: at least
  `uploadUrlExpiresAt` plus five minutes. An early delete makes a create-only URL usable again,
  so the canonical key still needs this guard. Missing-asset events use a fresh 15-minute window
  plus the margin. Public write stages use `stage.expiresAt` plus the same margin. Internal PUTs
  that already finished before cleanup do not need this field.
- A successful delete before `putMayArriveUntil` keeps the job as a tombstone. It sets
  `nextAttemptAt = putMayArriveUntil`. A second confirmed delete at or after that time may remove the
  job and clear the asset deadline.
- A transaction must create every needed deletion job before it deletes the stage or asset docs.
- The hourly cron processes at most 50 due jobs per page. It schedules another run while more jobs are
  due.
- A successful Yjs repair also sends the old snapshot key to this table before deleting its last asset
  doc. Reserved scopes still use the component cleanup because this table accepts real tenant ids only.

# Operation Matrix

ACL applies in every row. A machine force request still needs current access and its extra grant.

| Operation | Read-only behavior |
| --- | --- |
| Read, search, download, copy path/link/ID | Allow |
| Copy readable content out | Allow; check the destination and replacement occupant |
| Edit content, metadata, Yjs marks, or collaboration mode | Refuse normal writes |
| Create, upload, import, or paste media | Check the direct destination folder |
| Rename or Move | Check the item and direct source/destination parents; carry descendants |
| Ordinary Move to Trash or reviewed Delete | Check active items and their directly changed parent lists; older Trash does not block |
| Reviewed agent Delete that ignores Read-only | Skip only the flag after the user's Accept; check Can edit on the item, its parent and active items inside; keep flags |
| Forced Move to Trash | Move to Trash allowed children first; keep denied children and their ancestors |
| Restore | Preserve the item's own flag; check the live parent and any replacement occupant |
| Restore, archive, or unarchive snapshots | Check the file's current flag |
| Set or clear Read-only | Require Can edit; the flag itself does not block the setter |
| Share | Require Can manage separately |
| General comment, reply, resolve, reopen | Require content.write; do not change file content |
| Add a comment anchor | Check Read-only because this adds a Yjs mark |
| Discard a whole pending proposal | Allow owner cleanup; keep saved nodes |
| Finish an accepted upload or committed Yjs materialization | Finish the already accepted work |
| Delete a tenant, workspace, or account | Use the named lifecycle workflow |

# Read-only Management

`files_nodes.read_only_get` returns the safe flag and underlying `canEdit`.
`files_nodes.read_only_set` and `files_nodes_db_set_read_only` use
`content.write` on the target. They check membership, resource scope, Move holds, and current
authority before changing the flag. A parent flag does not block changing a child's own flag.

Machine setters and arbitrary create-time flags also need the new grant:
`files:read-only` for API keys, or `workspace.files.manage-read-only` for plugins.
The former protection grant is not an alias. Old consent does not grant the new capability.

Registered writer setup remains an access operation. Its first private setup can grant its exact
account Can manage after the existing parent grant ceiling and service-account checks. Repeating
ensure does not restore removed grants or overwrite manual sharing. Read-only creates no grant.

## Change contents

`files_write_policy_runs` keeps its stored job name. It takes `targetReadOnly: boolean` and runs
one of two explicit actions: Make contents Read-only, or Clear Read-only from contents.
The action is separate from saving the folder's own checkbox.

Start checks Can edit on the folder. Every step checks the original membership lifetime, current
folder, Move holds, and Can edit again. Each changed child goes through the common setter.
Already matching flags count as skipped; true-to-true never renews an ID. Clear also removes
hand-set flags. The job is a live pass and may miss items added or moved during the pass.

The existing worker walks active nodes by treePath. Readable items without Can edit count as
blocked. Locked folders and their contents are skipped without exposing counts. Stop and lost
authority keep completed changes. There is no undo claim.

The worker retains its existing progress batches: 50 counted, 200 checked, or 1,000 read nodes per
step. It publishes full progress batches so gaps do not expose hidden counts. A long hidden range
can still reach its idle deadline. This existing limitation is not a new scalable read pattern.

# Enforcement Rules

- Check current identity, membership, ACL, resource scope, and then Read-only before writes or
  conflict details. `server/files-write-policy.ts` owns the local flag and resource-scope checks.
  Callers prove current credentials and ACL. Labels and plugin names grant nothing.
- Trusted write context carries `subject`, `actorUserId`, `resourceScope`, and `force`.
  Only a machine door that checked the current grant may set force true, apart from the
  human-approved delete exception below. Persist it with the
  request and fingerprint; workers recheck the live key or installation before each step.
  Existing request fingerprints encode force only when true. False and omission keep the same
  ordinary request identity; changing to true needs a new request ID.
- Scope may be workspace, subtree, exact node, or creation at a pinned parent and path. Parent-ID
  lineage, seals, registered-writer generation, content revision, and target identity remain
  required. Force never broadens those bounds.
- Final content, Yjs, create, snapshot, repair, and pending transactions repeat current checks.
  Accepted upload completion is separate: the first accepted bytes may finish after a later flag.
- When creating a refusal, name an item only when the caller may read it. Locked folders stop
  recursive reads. A stored path is not proof of current access for live details or new actions.
  Saved job warnings and errors for every file operation follow the
  [Activity history rule](../activities/SKILL.md#historical-messages-and-live-data).
- Keep exact expected node IDs and ordered pending source IDs. Never retarget a retry to a new
  occupant at the same path.
- If external bytes exist before a refusal, queue their exact keys for durable cleanup before
  dropping temporary records. Starting vendor retries does not prove deletion.

## Copy and pending Save

A newly copied Read-only folder may receive only the original captured children while its exact
decision ID still matches. The receipt also pins the saved parent, creator, generation, and copied
path. Saving one child does not invalidate a sibling saved later. Clear and re-lock invalidates
the receipt, even when the visible boolean is true again.

Merging into an existing folder creates no such receipt. Replacing content keeps the destination's
flag and ID. Private copied parents mint their ID when allocated as saved nodes, once, and record
that same ID in their publish receipt.

Pending proposals stay visible through a refusal. Save, Accept, and rebase recheck current access.
Whole-proposal Discard and owner expiry keep saved files intact. App agents and Bash cannot force.
An agent can only ask for the human-approved delete exception, with `rm --ignore-read-only`.

## Trash and Restore

`files_archive_runs` uses the existing `files_subtree_ops` scheduling and Activity records.
Requests do a bounded first step; larger work continues in indexed pages.

Saved Trash refusals may name the Read-only parent folder or an item inside the selected folder
that the caller could read when the check ran. Those warnings and their Activity error copies are
history, like saved Move, Copy, and other file-operation messages. They may keep the old path after
a rename, move, or loss of file access. This is not a bug and needs no live refresh or removal.
Current item paths and new actions still check current access.
See the [Activity history rule](../activities/SKILL.md#historical-messages-and-live-data).

An ordinary move to Trash checks each named item's current direct parent for Can edit and Read-only in
both its fast and background checks. It then keeps the existing check-then-stamp behavior. Its fast path queries active
Read-only nodes with `by_org_ws_archive_readOnly_treePath`; trashed and false nodes are outside
that range. Restricted areas still need the existing authority checks. Older Trash keeps its own
Trash operation and never blocks deletion of its active parent.

App and API Trash check queued and running op paths through `files_subtree_op_paths`.
The old workspace scan is gone from this fast check. A balanced tree finds a matching path without
reading unrelated jobs or every parent folder. It stores one doc per distinct covered path, including
old Move paths and same-workspace Copy sources. It does not add docs per child, user, or grant.
Each path change updates a short tree branch. Large sets are built and removed in background steps.

A pending path-index job means the records are incomplete. Trash then shows Checking and waits,
instead of walking every child just because the records are not ready. It repeats current access,
Read-only, Move and overlap checks before stamping. It excludes its own op. A real overlapping op
still selects the ordinary full check; waiting for it could create a cycle in the job queue.
Keep the global running Move/scope checks. This path index does not replace the general queue
blocker and waiter scans in `files_subtree_ops_db_find_blocker`.

TODO: replace that queue scan with an indexed path lookup that keeps running jobs and earlier
queued jobs as blockers. Restore uses it during admission and later work. Many unrelated jobs
can make it hit the database read limit. The user accepted keeping this scan for development
and Plugin Restore on 2026-11-06. Keep the overlap check; this exception allows no new scans.

A folder's name stays taken while its move to Trash runs. The job stamps the items inside page by
page, and until it ends they are still live under the old path. A new folder at that path, from a
create, upload, `mkdir`, import or copy, would share their paths. So it is refused with `path_busy`:
`"/A" is still being updated. Wait for it to finish, or use another name.` A copy tries again every
second. A Restore that would land a folder there waits for the job, which wakes it when it ends.
The same holds while a Move job rewrites child paths. Files are not refused: a file has no items
under it. One indexed read of live items (archive operation `null`) under the new path decides
it (`files_nodes_db_find_live_under_path`), so the refusal ends with the job. This keeps live
paths unique, which the plugin folder-choice check needs (see the `access-control` skill).

Accepted limitation: an ordinary move to Trash does not repeat flag or ACL checks during its later stamp
walk. A flag set after its check may not stop that move to Trash. This window also exists when a bulk job
sets flags. Do not describe ordinary moves to Trash as checking each final stamp.

Forced moves to Trash use postorder work: children first, then their parent. Every step checks current
authority. It enters a Restricted folder only when allowed. A denied branch stays active with all
its ancestors; allowed siblings remain in Trash. Before moving a folder to Trash, check that it has no
active child, including a child added behind the cursor. A queued item moved elsewhere is not
trashed at its new location. Stop or revocation keeps the completed part.

Force waits for overlapping Move, scope, or running Restore work. A Restore queued behind the
delete does not make it wait in a cycle. Outcomes are stored and paged, with current read checks
when shown. A retained parent is not counted as trashed. Activity shows partial results.

Restore brings back each selected item and the items inside it that were moved to Trash with it.
Inside means a strict `treePath` prefix under the selected folder, with the same `archiveOperationId`.
A file comes back alone. Unselected siblings and descendants from other deletes stay in Trash.
The shared id groups a folder with what was moved to Trash with it. It does not widen a selection.
Overlapping selections restore each item once. Access and Read-only checks cover that selection.

Check the selected item and its direct parent, not an unselected ancestor from the same delete.
An active parent at the item's Trash parent path keeps the item in place and needs Can edit; a live
Read-only parent blocks it.
An archived parent's own Read-only flag does not block Restore, but its access checks still apply.

Restore brings a selected item back at its Trash path, like `mkdir -p` and then a move. Move to
Trash saves the path in `archivedPath` at the first stamp. A later stamp, rename or Move above the
item does not change it, and Restore clears it. Decided 2026-11-01: following the old parent folder
gave too many edge cases, for example a parent that is in Trash too.

- The item stays in place when its live parent still has the Trash parent path, or when it was at
  the root and still is.
- It joins its parent's restore when another restore brings the parent back, or when somebody moved
  the parent to Trash during the job.
- Otherwise the job walks the Trash parent path from the root, by parent id, through live folders.
  It creates the missing folders in the deepest live folder it finds, at most
  `files_NEW_FOLDER_DEPTH_MAX` (32) per step, and lands the item there. A live folder that was
  renamed keeps its new name. An old folder in Trash stays there with its other items.
- The new folders are open folders, made by the normal folder create. So that create needs write
  access in the deepest live folder, which must not be Read-only. The landing also needs permission
  to leave the item's restricted scope. An item with its own restriction keeps it and needs no
  scope-leave check, but the create check still applies.
- A live file where a folder of the path should be refuses the job with `file_in_the_way`. The
  message names the file only for somebody who may read it, else "Permission denied".
- The check phase runs these checks before any write, so a refusal changes nothing.

The job stores every selected id and path in required `restoreRoots`, separate from `rootNodeIds`,
the top items that land at their Trash path in another folder. After the Move job fixes stored
paths, discovery reads those ids again and refreshes their paths. When a selected folder contains another selected item, the check visits that
item only once. Folder ids stay separate even when they have the same path. Each operation is
one job; jobs in a request run one at a time. A refusal names every original selection of that
operation, even a covered child. Other operations may start in the API; the app stops at the first
refusal. Retrying keeps the original selection and answer.

Worker descendants use `by_organization_workspace_archiveOperation_treePath`: exact organization,
workspace, `moveCohortId: undefined`, and operation id, with `treePath > root.treePath` and
`< path_tree_prefix_upper_bound(root.treePath)`. Convex pagination cursors keep each item when
several items inside the folder have the same path, including across pages.
The worker waits until the Move job fixes stored paths. Recovery readback instead follows each
selected id's current saved path. It checks that bounded range in `files_nodes` and the same range
in the published Move view (`files_saved_places` index `by_view_archive_tree`), with exact cohort,
visible view, and operation id. Successful jobs need no recovery lookup. A stopped job
names one item still inside the current selection, subject to current read access. Other selected
roots may need separate restores. Reusing an old path never adds an item to that job.

Restore preserves an item's own flag and decision ID. A Read-only live parent normally blocks
landing. The narrow exception is a parent restored by this same run with the exact recorded
decision ID, including null. Repair-only docs grant no exception. Clearing and setting again breaks
the receipt. Current ACL and placement checks still apply.

A public API restore dry run (`files/restore` with `dryRun: true`) runs this same restore and then
rolls it back. So for the steps it runs, it answers with the same Read-only refusals a real restore
would give, and it saves nothing. See the `public-api` skill.

Restore name clashes keep Keep both, Skip, and Replace. Replace always refuses a Read-only occupant,
even for a forced request. It keeps its existing empty-folder rules and bounded checks of content in Trash.
Separate Trash operations remain separate. Landing an item in another folder still needs write
access there and restricted-scope exit permissions.

Reviewed pending Delete uses the Save cohort. It checks active descendants before the group switch;
already trashed descendants keep their stamps and do not block it. Stop before the switch keeps
saved files and proposals; after the switch, required repair finishes.

The agent's `rm` proposal uses the move to Trash fast check (`files_archive_runs_db_check_fast` with
`opCheck: "any"`). It checks the item, its parent folder, and the first two active Read-only items
inside, so its cost does not grow with the folder. A refusal names the blocking item: a Read-only
item inside, or the Read-only parent folder. It shows the path the person's drafts show, like
`resolve`, so a draft move above the item does not give a stale path. The check reads the saved
tree, so when the person's drafts moved the blocker out of the folder or hid it, it refuses nothing:
Accept may pass then. It also says when the person may read another Read-only
item inside. It names an item only in an area the person can read.

When the check cannot decide, the proposal is made and Accept checks every item. That happens for a
non-owner with a restricted folder inside, while any subtree job runs, or while a Move holds the
workspace. Accept's refusal of an item inside uses the general wording "An item inside it is
read-only." with no path. This wording is specific to the review; other saved errors may include paths.

A Move, Rename or reviewed delete refused because of a Read-only folder talks about that folder, not
"This item". These flows use general wording without a path. A Move says
"The destination folder is read-only." or "The source folder is read-only.". A Rename that puts the
item in another folder checks each folder on the way, so it says "A folder in the destination path
is read-only.". A Rename refused at once because the item's folder is Read-only says "Its folder is
read-only." with no path too. A reviewed delete says the same. Each text ends with "Unlock it, then
try again."

A Copy or Move checks its destination folder again at each step. When that folder became Read-only
after the start, the item fails with "The destination folder is read-only.". When the destination
is a draft folder, the lock is on a saved folder above it, so the text is "A folder in the
destination path is read-only.".

A Copy or Move that merges into a folder or replaces a file checks that item too. When it is
Read-only, the text says "The destination folder is read-only." or "The destination file is
read-only.". When the item is a draft, the lock is on a saved folder above it, so the text is "A
folder in the destination path is read-only.". Before it saves, the Move checks the replaced item and
the items inside it again, and says "An item the Move replaces is read-only.". A folder that a Move
creates on the way to its destination checks the folder above it, and says "A folder in the
destination path is read-only.". The Pending tab keeps Accept disabled while the file a Move replaces
is Read-only. So a user sees "The destination file is read-only." there only when the lock comes after
the tab loaded.

## Human-approved delete exception

The agent's `rm`, `rm -r` and `rm -f` refuse a Read-only item, a folder that holds one, or an item in
a Read-only folder. When the user asks in the chat to delete those items, the agent runs
`rm --ignore-read-only`. That only records a request: `pendingArchive.ignoreReadOnly: true` on the
proposal. The last `rm` decides, so a later plain `rm` of the same item drops the request. The
proposal's early checks skip only the flag. They still refuse a purge of the item and a missing
permission on it. Accept checks the parent folder and the items inside.

The user's Accept of that row is the approval. The review item carries `ignoreReadOnly: true` for
that exact proposal revision. A plain Accept of such a delete, or an approval on any other proposal,
returns `needs_review`. Accept all lists these deletes in a dialog first (Delete them too, Skip
them, Cancel).

Accept copies the approval to the cohort item. Only that item's `selected` and `descendant`
records act with `force: true`: the item, its current parent, and the active items inside. Every
other record in the same group keeps the normal checks, so a linked Move into a Read-only folder
still fails. ACL, purge, Move holds and placement are checked as usual, and a denied item inside
still refuses the whole delete. Flags and decision IDs stay, so a restored item is still Read-only.

Who grants it: only the owner of the proposal, by Accept. It needs no new authority: Can edit may
already clear the flag. It is not machine force, so RO-07 is unchanged, and API keys and plugins
cannot use it.

Decided 2026-10-31: people in Files keep "clear Read-only first, then delete". The exception exists
only to approve an agent's request; a person can already clear the flag.

## Delete permanently

Delete permanently and Empty Trash never delete a Read-only item. The job keeps it with the
reason `read_only`, and keeps its folders too, because a folder goes only when it is empty. There is
no force for a permanent delete. Details: `../data-deletion/SKILL.md` ("Delete Permanently").

Once a purge job starts deleting a node, it sets `purgeRunId`. Then the write check refuses every
write to the node, and every create inside it, with `name: "deleting"` ("This item is being
deleted."), even a forced one. Restore does not use this check for the Trash operation's own
items. The purge's busy paths keep a Restore of the same items waiting instead.

## Plugin and service partial deletion

Bounded plugin/service deletion keeps its existing synchronous size limit. It returns an exact
request receipt with completed count, completion state, and safe refusals. A new attempt names the
previous receipt and must still match its original destination ID, epoch, and seal. Same-request
replay returns the saved result without moving to Trash twice. Receipts do not expire into fresh authority.

A partial service delete retires only targets actually trashed. It does not close the destination
epoch, remove remaining grants, or tell the caller all artifacts were deleted. Full completion
closes once. Council retains its attempt and prior receipt across retries.

# Error Contract

- Internal Read-only refusals keep `name: "read_only"`. Missing ACL remains a permission refusal.
- Preserve each public door's existing envelope and status mapping. Do not force every route into
  one HTTP status shape.
- `/files/write-many` keeps per-item results. Touch keeps sequential request-level failure.
  Upload URL batches preflight before minting. Atomic batch doors remain atomic.
- A partial move to Trash reports completed work and refusals. It does not roll back completed siblings.
- `skipIfUnchanged` still checks current authority and the flag.

# Race Rules

Final writes check the current flag, with only the exact Copy/Restore and accepted-work exceptions
above. Old success acknowledgements do not grant new access.

Before an editor drops queued local edits, rebuilds, or closes after losing access, capture the
current unsaved text, including the last keystroke. Use the live Y.Doc or editor model. Keep separate
captures for distinct refused drafts and coalesce duplicate signals for one draft.
Review also captures changed panes before each preparation or history reset. A later reset must not
replace an earlier recovery copy. These copies remain available after the editor closes.

Recovery lives in memory in the current tab, outside the editor. Files and the workspace access-denied
or login screen offer Unsaved text for the current user's copies, even without current workspace membership.
Each name read uses the copy's own membership. Offer Copy, Download, and Discard.
Use generic names after read access is lost. Warn that reload or tab closure loses this text and
register beforeunload while captures remain. Clear on discard or sign-out/user replacement.
Never upload, log, persist, broadcast, or automatically replay captured text.

Network and rate failures keep their existing retry behavior. Pending proposals remain reviewable.

# Accepted Upload Completion

The upload flow is:

1. The signed PUT creates the object at `assets/<assetId>`. Reusing that URL gets 412 while the object exists.
2. The event action matches the exact stored bucket and canonical key, then reads the object's metadata.
3. The final mutation rechecks ownership and retirement, then rejects bytes larger than declared. Valid publication counts actual bytes and emits `file_upload` once before processing.
4. A stale or retired attempt goes to exact-key cleanup. It cannot change a newer node or service target.

An already published event changes no metadata and starts no new work. If notification or publication
fails, recovery reads the same direct object. Keep `unfinalizedExpiresAt` until publication or cleanup
finishes. Recovery retries hourly for the first 30 hours after the signed URL was issued, then weekly.
After eight days, it checks the object once more, then removes an ordinary failed placeholder
even when locked. A pending service placeholder retires instead: terminal cleanup sets
`uploadRetiredAt` and queues its canonical key in one mutation, and the target stays pending
so remint can revive it.

Pending service remint and create replay rotate the node and target to a fresh asset in one mutation.
That mutation queues the old key before removing the old asset. It does not wait for old cleanup.
A committed target stays terminal. Named tenant, workspace, and account deletion use their lifecycle
authority through `db_purge_organization_workspace_content_batch` in `data_deletion.ts`.

Those retry doors still recheck the target's original destination seal, active current path, and
current subject authority and restricted-file ACL. Fresh attempts also repeat paid-plan and
stored-cap admission. A later lock alone does not stop them.
If a service call observes that a member moved the file outside the seal, it closes those doors
permanently for that target. The accepted R2 event can still finish and charge the file's real size.

The service `delete` route also checks current policy before any write. It moves a committed upload to Trash,
because that file may now hold normal editable state and history. It hard-deletes only a pending
service placeholder, which has no accepted content yet.

R2 publication settles a service target once. `actualBytes` is the winning object's size;
`chargedBytes` is its counted size. Late attempts only queue deletion. They add no bytes or events.
An oversized object is never published: cleanup removes the placeholder and releases the target
with `releaseReason: "oversized"`. Finalize returns `oversized_upload`, HTTP 409. It cannot be
revived by remint. A fresh key with a correct declaration can start another target.
Only operator import assets may carry `uploadBillingExempt: true`. Their size check still applies.
Cleanup never refunds bytes.

Failed-placeholder discard queues the canonical key with its signed-URL arrival window before deleting
the asset and node. It also releases the current service target when present. Missing-asset events
refresh the same job. Stale operator-repair uploads use this durable table for real tenants. Reserved
scopes keep their component cleanup.

After acceptance, a later protection change never stops the first write. The R2 event publishes
the file, text conversion still creates the editable representation, and upload-completed
plugins still receive the event. The finished node keeps its own local policy. New edits,
replacements, renames, moves, and deletes still check that policy.

- UI: the uploading session marks in-flight files "Uploading" and blocks rename; the editor
  only opens after conversion sets text. The agent refuses in-flight files with
  `upload_in_progress`. The normal waiting/processing state changes to the normal ready state.
- Rich-text media: the asset upload may finish after its destination policy changes. Inserting the reference still checks whether the document is editable. If the document stops allowing edits during the upload, keep the visible asset file and explain that it uploaded but was not inserted.

# UI Capability Model

Public views return `readOnly`, `canWrite`, and `writeBlockedReason` (null, permission, or read_only).
Missing Can edit is shown as View only. Sharing and Read-only remain separate.

Properties has one native Read-only checkbox. It uses underlying Can edit, so a person can clear
the flag even while content writes are blocked. Its description says in plain words what the flag
stops (for a folder: adding or removing items in it, not the items inside). It never changes with
the state. The help button's tooltip says why the box is disabled, that a machine with Manage
Read-only can still make changes, and that work accepted earlier may finish. See "Setting text
stays fixed" in the `ui-design` skill.

When enabling Read-only with dirty metadata, save metadata first and then the flag. When clearing
it, save the flag first and then metadata. If the second part fails, keep that draft and say which
part saved. Never silently force or roll back the first success.

Folder contents actions are separate, explicit confirmations. Clear says it removes hand-set flags.
Both explain the live pass and report progress, skipped items, and partial completion.
Keep visible labels, keyboard and focus behavior, and usable layout at 200% zoom.

# Requirements

| ID | Requirement |
| --- | --- |
| RO-01 | Normal writes pass current ACL and Read-only checks |
| RO-02 | Move checks the item and direct parents, and carries descendant flags |
| RO-03 | Owners do not bypass the flag; force never grants access |
| RO-04 | Can edit changes Read-only; Can manage controls sharing |
| RO-05 | New items are writable; Copy and Restore preserve flags under their normal authority |
| RO-06 | Reads, safe comments, downloads, and copy-out keep working |
| RO-07 | Machine force needs an explicit request and current new grant |
| RO-08 | Decision IDs prevent clear/re-lock from reviving a Copy or Restore exception |
| RO-09 | Pending work and whole-proposal Discard remain available after refusal |
| RO-10 | Public responses hide decision IDs and unreadable live paths; saved job messages follow the Activity history rule |
| RO-11 | Accepted uploads and committed materialization finish; failed placeholders can be cleaned |
| RO-12 | Capture unsaved text before reset; keep recovery reachable within the tab |
| RO-13 | Keep read_only and each door's existing error shape |
| RO-14 | A partial move to Trash keeps completed work and retained parents; atomic doors stay atomic |
| RO-15 | An agent delete skips Read-only only with the user's Accept of that exact revision; flags stay |

# Test Map

- `convex/files_nodes.read_only*.test.ts`: flags, decision IDs, Can edit, direct children, privacy.
- `convex/files_write_policy_runs.test.ts`: bulk changes, authority loss, Stop, retries.
- `convex/files_transfer*.test.ts`, `files_pending_nodes.test.ts`, pending structural tests:
  Copy/Save receipts, clear/re-lock, partial Save, Trash, Move. RO-15: the structural
  "pending update read-only checks" block (approval, ACL) and `files_pending_update_runs.test.ts`
  (a move in the same unit, page replay).
- `server/bash.files.test.ts`: `rm -f` refuses a Read-only file; `rm -r` of its folder names it by its
  shell path; `--ignore-read-only` only requests.
- `convex/files_archive_runs*.test.ts`: Restore receipts, forced partial moves to Trash, current authority.
- `convex/public_api*.test.ts`, `plugins_external_files*.test.ts`: grant checks, force, exact retries,
  sealed destinations, partial completion, accepted uploads.
- `convex/files_nodes_content*.test.ts`, `r2.test.ts`: final content checks and durable cleanup.
- Properties, editor, provider, recovery, archive-modal and Activity tests: UI state, save order,
  retained drafts, recovery, and partial outcomes.

# Related Skills

- `../access-control/SKILL.md`: subjects, permissions, grants, and account management.
- `../files-agent-pending-updates/SKILL.md`: proposal, commit, discard, and private cleanup.
- `../files-editable-text/SKILL.md`: Yjs write doors and shape guards.
- `../files-explorer-tree/SKILL.md`: tree operations and row interactions.
- `../public-api/SKILL.md`: credentials, scopes, plugin adapters, and conflict responses.
- `../data-deletion/SKILL.md`: named lifecycle deletion and durable asset cleanup.
- `../ai-chat-agent/SKILL.md`: ordinary human agent/Bash behavior.
- `../files-rich-text-embeds/SKILL.md`: document and destination checks for embeds.
- `../plugin-system/SKILL.md`: installation account bindings and integration limits.
