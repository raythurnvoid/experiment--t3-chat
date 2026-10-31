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
| Ordinary Archive or reviewed Delete | Check active items and their directly changed parent lists; older Trash does not block |
| Forced Archive | Archive allowed children first; keep denied children and their ancestors |
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
  Only a machine door that checked the current grant may set force true. Persist it with the
  request and fingerprint; workers recheck the live key or installation before each step.
  Existing request fingerprints encode force only when true. False and omission keep the same
  ordinary request identity; changing to true needs a new request ID.
- Scope may be workspace, subtree, exact node, or creation at a pinned parent and path. Parent-ID
  lineage, seals, registered-writer generation, content/reader revision, and target identity remain
  required. Force never broadens those bounds.
- Final content, Yjs, create, snapshot, repair, and pending transactions repeat current checks.
  Accepted upload completion is separate: the first accepted bytes may finish after a later flag.
- A refusal names an item only while the caller may read it. Locked folders stop recursive reads.
  Never use a stored path as proof that it is still safe to show.
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

## Archive and Restore

`files_archive_runs` uses the existing `files_subtree_ops` scheduling and Activity records.
Requests do a bounded first step; larger work continues in indexed pages.

Ordinary archive checks each named item's current direct parent for Can edit and Read-only in
both its fast and background checks. It then keeps the existing check-then-stamp behavior. Its fast path queries active
Read-only nodes with `by_org_ws_archive_readOnly_treePath`; archived and false nodes are outside
that range. Restricted areas still need the existing authority checks. Older Trash keeps its own
archive operation and never blocks deletion of its active parent.

Accepted limitation: an ordinary archive does not repeat flag or ACL checks during its later stamp
walk. A flag set after its check may not stop that archive. This window also exists when a bulk job
sets flags. Do not describe ordinary archive as checking each final stamp.

Forced archive uses postorder work: children first, then their parent. Every step checks current
authority. It enters a Restricted folder only when allowed. A denied branch stays active with all
its ancestors; allowed siblings remain archived. Before archiving a folder, check that it has no
active child, including a child added behind the cursor. A queued item moved elsewhere is not
archived at its new location. Stop or revocation keeps the completed part.

Force waits for overlapping Move, scope, or running Restore work. A Restore queued behind the
archive does not make it wait in a cycle. Outcomes are stored and paged, with current read checks
when shown. A retained parent is not counted as archived. Activity shows partial results.

Restore preserves an item's own flag and decision ID. A Read-only live parent normally blocks
landing. The narrow exception is a parent restored by this same run with the exact recorded
decision ID, including null. Repair-only docs grant no exception. Clearing and setting again breaks
the receipt. Current ACL and placement checks still apply.

Restore name clashes keep Keep both, Skip, and Replace. Replace always refuses a Read-only occupant,
even for a forced request. It keeps its existing empty-folder and bounded archived-content rules.
Separate archive operations remain separate. Moving an item to root still needs its root and
restricted-scope exit permissions.

Reviewed pending Delete uses the Save cohort. It checks active descendants before the group switch;
already archived descendants keep their stamps and do not block it. Stop before the switch keeps
saved files and proposals; after the switch, required repair finishes.

## Delete permanently

Delete permanently and Empty archive never delete a Read-only item. The job keeps it with the
reason `read_only`, and keeps its folders too, because a folder goes only when it is empty. There is
no force for a permanent delete. Details: `../data-deletion/SKILL.md` ("Delete Permanently").

Once a purge job starts deleting a node, it sets `purgeRunId`. Then the write check refuses every
write to the node, and every create inside it, with `name: "deleting"` ("This item is being
deleted."), even a forced one. Restore does not use this check for the archive operation's own
items. The purge's busy paths keep a Restore of the same items waiting instead.

## Plugin and service partial deletion

Bounded plugin/service archive keeps its existing synchronous size limit. It returns an exact
request receipt with completed count, completion state, and safe refusals. A new attempt names the
previous receipt and must still match its original destination ID, epoch, and seal. Same-request
replay returns the saved result without archiving twice. Receipts do not expire into fresh authority.

A partial service delete retires only targets actually archived. It does not close the destination
epoch, remove remaining grants, or tell the caller all artifacts were deleted. Full completion
closes once. Council retains its attempt and prior receipt across retries.

# Error Contract

- Internal Read-only refusals keep `name: "read_only"`. Missing ACL remains a permission refusal.
- Preserve each public door's existing envelope and status mapping. Do not force every route into
  one HTTP status shape.
- `/files/write-many` keeps per-item results. Touch keeps sequential request-level failure.
  Upload URL batches preflight before minting. Atomic batch doors remain atomic.
- Partial archive reports completed work and refusals. It does not roll back completed siblings.
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

The service `delete` route also checks current policy before any write. It archives a committed upload,
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
the flag even while content writes are blocked. Explain the direct-child rule for folders and that
a machine with Manage Read-only can force changes. Work accepted earlier may finish.

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
| RO-10 | Public responses hide decision IDs and inaccessible paths |
| RO-11 | Accepted uploads and committed materialization finish; failed placeholders can be cleaned |
| RO-12 | Capture unsaved text before reset; keep recovery reachable within the tab |
| RO-13 | Keep read_only and each door's existing error shape |
| RO-14 | Partial archive keeps completed work and retained parents; atomic doors stay atomic |

# Test Map

- `convex/files_nodes.read_only*.test.ts`: flags, decision IDs, Can edit, direct children, privacy.
- `convex/files_write_policy_runs.test.ts`: bulk changes, authority loss, Stop, retries.
- `convex/files_transfer*.test.ts`, `files_pending_nodes.test.ts`, pending structural tests:
  Copy/Save receipts, clear/re-lock, partial Save, Trash, Move.
- `convex/files_archive_runs*.test.ts`: Restore receipts, forced partial archive, current authority.
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
