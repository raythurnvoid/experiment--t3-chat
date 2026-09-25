---
name: files-read-only
description: Spec for local file write policies, folder new-item defaults, selected human and service-account writers, policy management, accepted-upload completion, exact-key R2 deletion jobs, and the stable read_only conflict. Use when changing file write checks, creation, moves, pending work, snapshot writes, public file doors, or the Files policy controls.
---

# Mental Model

File access and write policy are separate checks. Access control decides whether the current actor
and any bound service account have the requested permission. A write policy then limits which writer
may change the node. Selecting a writer grants no file access.

The writer is either a human user or a service account. Ordinary app, agent, and Bash operations use
the human. A service-bound key or plugin backend uses its bound account, with the current human actor
as a separate permission ceiling. Plugin names, labels, run IDs, and upload targets do not identify a
writer. They remain separate integration constraints.

Each file and folder has its own `writePolicy`. A parent rule never blocks a child by itself.
A folder also has `newChildWritePolicy`. That default is copied once onto a brand-new child.
Later default changes do not touch existing children. Owners and admins do not bypass policy.
Management permission lets them change the policy through the common setter. Named tenant,
workspace, and account deletion flows remove their whole scope and remain lifecycle exceptions.

Rename and move check the named item and its immediate parent. Delete, archive, and replace still
check every removed or replaced item. A writable folder can be renamed or moved while it holds
protected children. Readable files may still be copied out. Copy and Duplicate keep the source
`writePolicy` and a folder's `newChildWritePolicy`. The synthetic root has no local policy.

A read-only folder blocks rename and move-out of all its direct children, restricted children
included, even ones the person who locked it cannot see. This matches write access on a Linux or
macOS folder. This also covers a move to the workspace root. Anyone who manages the folder can
unlock it.

Human clipboard Cut needs write access on the source entry and on the destination folder. The
source's parent folder must not be protected, but its sharing is not checked.
See [Files transfer runs](../files-explorer-tree/references/transfer.md#conflicts-and-concurrent-changes).

# Data Model

`files_nodes` stores these fields beside `restrictedScopeNodeId`:

- `writePolicy`: `null` means the item is writable (subject to ACL);
  `{ mode: "read_only" }` blocks content writes;
  `{ mode: "writer", writer }` selects one human or service account.
- `newChildWritePolicy`: same union. Folders copy this onto a brand-new child once. Files store
  `null`.

Transfer items store the policy value the run wrote on a produced node, and compare values:
a child may be created inside it while the node's current policy still equals that value,
even when it is a lock. A different current value refuses the child; a value restored to
what the run wrote allows it again. Pending proposals keep no receipt: Save and Accept check
the live lock. Uploads keep no receipt: an accepted upload always finishes.

The writer value is `{ kind: "user", userId }` or `{ kind: "service_account", serviceAccountId }`.
Moving or restoring a node keeps that node's own policy. Policy writes do not change `updatedAt`
or `updatedBy`.

Credential, ACL, scope, and content staleness checks still apply. Editable `plugin-name` metadata
changes neither policies nor grants.

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

The table describes a node whose policy refuses the current writer. ACL still applies in every row.

| Operation | Result |
| --- | --- |
| Open, read, search, download, copy path/link/ID | Allow |
| Copy readable content or subtree out | Allow; destination policy applies |
| Edit/save content, metadata, Yjs marks, or collaboration mode | Refuse |
| Create children, upload, import, or paste media | Refuse if the destination folder itself is protected |
| Rename or move | Refuse if the named item or its immediate parent is protected |
| Replace, archive, restore, or delete | Refuse if any removed or replaced item is protected; restore also refuses when the old or the landing folder is protected |
| Browse or download snapshots | Allow |
| Restore, archive, or unarchive snapshots | Refuse |
| Share or change policy | Require management permission separately |
| Reply to an existing comment | Allow with comment permission |
| Create or resolve an anchored comment | Refuse; this changes a Yjs mark |
| Discard a whole pending proposal | Allow; retire owned private work and keep saved nodes |
| Accept, save, or rebase pending work | Refuse |
| Finish an already accepted upload | Allow; a later lock stops new writes, not this one |
| Finish committed Yjs materialization | Allow |
| Delete a tenant, workspace, or account | Use the named deletion workflow |

Direct comment sidecar mutations keep their comment ACL rules. The editor uses content write access
for anchored Create and Resolve. The Yjs gate checks again if a race reaches the server.

# Policy Management

`files_nodes.ts` owns `set_node_write_policy`, `get_node_write_policy_management_state`, and the shared
internal management helpers. HTTP and plugin adapters use the same helpers after their own live
identity, token, capability, and resource checks.

Folder management (`files_nodes_db_require_write_policy_management`) checks only the target. It
reads no children, so Properties and policy saves cost the same on a folder like `/people` (about
9,700 children) as on an empty one. A folder's rule never changes a child's own rule. It only limits
rename and move-out of its direct children (see above). Each restricted child keeps its own
`content.permissions.manage` for its own rule.

The setter requires current actor and optional account `content.permissions.manage` on the actual
target. Apply to contents never runs from Save. New selected users must be active workspace members;
new selected accounts must be active in the same workspace. A stored revoked writer remains visible
as a redacted choice that a manager can replace.

Creation copies the destination folder's `newChildWritePolicy` once when the caller omits a policy.
An explicit `writePolicy` or `newChildWritePolicy` override needs a management check. Intermediate
folders created on a path get the same copied default. A refusal commits no partial folders, assets,
policy, or sharing changes.

Registered writer setup with explicit readers is a separate access operation. On first creation,
it restricts the empty folder and grants the exact bound service account **Can manage** there in the
same transaction. The actor must pass service-account management and the full parent grant ceiling;
the account must already pass parent write and management checks. This keeps the account usable when
the new restriction stops inherited access. Human reader permissions stay unchanged. Existing-folder
retries never restore this grant or replace manual sharing. Later grant changes use normal Files
sharing. A writer policy by itself still creates no access.

Editable (`null`) clears only that node's local policy. It does not change children. Repeating the
same local choice is an idempotent success. Management stays separate from effective content write
access. `files_write_policy_runs.start` is the only door that rewrites descendant rules.

## Apply to contents

`files_write_policy_runs.ts` runs "Apply to contents" as a background job with an Activity
(`source.kind: "files_write_policy_run"`). `start` checks management and the writer rule on the folder,
refuses while a data reset deletes the workspace files, allows one queued or running job per person
and workspace, saves the confirmed rule, and schedules `advance`. The Activity title is "Apply protection to folder contents" and its targets stay `[]`, so it
never names the folder or anything inside it.

Each `advance` step first checks again: the Activity is still active and inside its deadline, the saved
membership is still the same one (a leave and re-join stops the job), the folder has the same
`treePath` and is not archived, and the person still manages the folder with the saved rule. A failed
check ends the job. Items updated before that keep the new rule.

The step then walks active nodes inside the folder in `treePath` order
(`by_organization_workspace_archiveOperation_treePath` with `archiveOperationId = null`, so archived
items keep their rules):

- Managed: set the rule (`completed`), or count it as `skipped` when it already matches.
- Readable but not managed: count it as `blocked`. Walk on into a folder like that, because items
  inside it may have their own grant.
- Hidden (not readable): never count or name it. A hidden folder is skipped with everything inside
  it, like `chmod -R` skips a folder it cannot read. Its contents are skipped inside the same page,
  and the next page starts at the first path after them. A hidden file skips only itself.

A step ends after 50 counted items, 200 checked nodes, or 1,000 read nodes. The read limit matters
because the contents of a hidden folder are read but not checked. A step that stops before 50 counted
items passed hidden items, so it keeps its counts on the run (`unpublishedProgress`) and leaves the
Activity as it is. The next step fills those counts up to 50. So the Activity progress, `updatedAt`, and the 30-minute
`deadlineAt` change only at a full 50 or at the end, and the requester never sees how many hidden
items a step passed. The deadline is an idle limit. A long job that keeps showing progress never
times out. A step that updated anything advances the media validation clock once. The last step sets
`total` and finishes with `activities_get_result_status`. Only blocked items give `failed`, and a mix
gives `partial`. Stop, the deadline cron, and a failed check finish the Activity at once. They add
the kept `unpublishedProgress` first, so "Stopped. N items were updated." counts every updated item.
A step that was already scheduled then does nothing. A long stretch with nothing visible does not move
the deadline, so a job can time out while it walks well over a million hidden items. That is the cost
of never showing hidden items.

# Enforcement Rules

- Use this order: current auth and membership, actor/account ACL, resource scope and policy, conflict
  details, then writes. Policy is outside ACL because owner permission does not bypass a policy.
- `files_nodes_db_require_writable` accepts trusted writer, actor, resource scope, and policy reach.
  It does not read plugin docs or infer identity from labels. Its callers establish current credentials
  and ACL. `files_nodes_db_require_user_writable` supplies the explicit human writer for ordinary
  callers. Action preflights use the Result query `get_user_file_write_access`, preserving `read_only`.
- A scope is workspace, subtree, exact node, or create at a pinned nearest existing parent/root plus
  normalized intended path. Check subtree membership through parent IDs, including after moves.
- Reach is a service limit, not folder inheritance. Reach `none` passes no policy. Reach `direct`
  may match only the named node's own selected-writer rule. Reach `ancestors` may also match a
  destination folder's selected-writer rule when creating a child there. A parent read-only rule
  still never blocks an unlocked child. Generic sealed service doors use direct reach and keep
  their destination and target limits. Public service writer requests may use ancestor reach only
  after their sealed destination, current service secret, `workspace.files.own-write`, actor/account
  ACL, labels, and pinned output scope pass.
- Generic account keys use account permissions and their validated resource scope. Invoke plugins
  also keep accepted capability, editable label, source, and current installation checks. UI sessions
  keep their read-only backend contract. The generic helper adds no integration bypass.
- Every final content, Yjs, create, snapshot, repair, or pending transaction checks current
  policy before its first write. Both collaboration toggles require content write, not
  policy-management permission. Accepted upload finish (R2 publish, text conversion) is not
  a new write: it always completes, even after a later lock.
- Rename and move check the named item and its immediate parent before any write. Archive, unarchive,
  replace, and delete check every removed or replaced item. Archived descendants use their real parent
  links. Equal paths in separate archived and active trees are not the same node. Hidden refusals
  reveal no hidden node name, ID, or path. Cleanup of an upload that never landed deletes its
  placeholder even when locked. Cancel (discard) does the same for the creator.
- The up-front check of a folder's contents (`files_nodes_db_require_subtree_writable`) reads at most
  2,000 items, archived ones too. Above that it returns `subtree_too_large`, never a thrown limit
  error. An agent delete of a bigger folder still gets its proposal, because the accept job checks
  every item before it archives anything. A move that would replace a bigger folder is refused ("The
  folder in the way holds too many items to replace.").
- Archive and restore run through one archive job (`files_archive_runs`, Activity source
  `files_archive_run`). The request runs the first step itself. When that step finishes the work (up
  to 150 nodes), no run doc and no Activity exist. A bigger one continues in the background.
  - The job first checks every item and writes nothing. One protected item refuses the whole action.
    Archived items can share one path. When a check page ends inside such a group, the check reads up
    to 500 more of them at once; more refuse ("Too many archived items share one path.").
    Every later step checks its items again. A lock or lost access set during the job stops it as
    failed ("Stopped partway"). The done part keeps its one archive operation id, so Restore brings
    back exactly that part. Stop does the same.
  - Archive works bottom-up with no cursor: each step takes the deepest active nodes under the named
    folder's current path, and the named folder is archived last. So no active node ever sits inside
    an archived folder, and a node added or moved in during the job is archived too.
  - A node and its side docs (plain text chunks and metadata docs) change in the same mutation. Readers
    are unchanged: each doc keeps its own path, treePath, and archiveOperationId.
  - Restore brings back one archive operation. Several operations named in one call run in the order
    of each operation's top item, so a parent operation comes back first. Items archived earlier on
    their own keep their own operation. An item whose parent is active lands under the parent's current
    path. An item whose parent is missing or in another archived operation lands at the workspace root,
    which is a move: it needs root write and permission to leave its restricted folder. If a restore job
    of the parent's operation is running, the item joins that operation instead and comes back with it.
    If an archive job of the parent's operation is running, the restore is refused as busy.
  - The operations of one restore call share the request's first step. After the first job starts, the
    later operations wait as `queued` jobs, so their steps never write the same docs at the same time.
    Each queued job saves the first job's id in `requestFirstRunId`. When a restore job that was
    running ends (done, failed, Stop, timeout, or deleted), the oldest queued job of the same request
    starts. Jobs of another request are never started by it, so each request runs one job at a time.
    A Stop on a queued job ends only that job; the other queued jobs still run. A queued job has a
    24-hour deadline. When it passes while an earlier job of its request is still active, the job gets
    24 more hours. A later job checks its items only when it
    starts. If an earlier job stopped or failed and left their folder archived, the items land at the
    root, and their refusals show in the Activity, not in the Unarchive answer.
  - A restored folder that lands on a new path or scope (at the root, or renamed by Keep both) moves the
    items archived on their own inside it, like a move: they stay archived, and their path, treePath,
    scope, and side docs follow the folder in the same mutation. The move limits apply (500 items,
    2,000 docs with side docs, 4 MB). Above them the folder is not restored and the job fails.
  - Restore refuses when the item's old folder or landing folder is read-only. The message names the
    folder only to a caller who may read it.
  - A restore name clash pauses the job (`awaiting_input`) for up to 24 hours and asks like a paste:
    Keep both (`name-2.ext`), Skip (the item stays archived), or Replace (the item in the way is
    archived with a new operation id). Replace needs the same kind, a folder with no active child, and
    write access to the item in the way and to every archived item inside it (at most 500 items;
    a bigger folder cannot be replaced). `get` returns `canReplace`, and `resolve_conflicts` refuses a
    Replace that is not possible. A Replace that became impossible after the choice asks again. The
    item in the way is archived only after the restore of the clashing item worked. Apply-to-remaining choices are kept for the rest of the
    job. `resolve_conflicts` takes the shown `revision`. `get` shows the clash name and paths only to a caller who may read them.
  - Busy check: an archive that overlaps a running archive job, or a restore of an operation that
    already has a job, is refused.
  - A request whose first step fails after some writes returns the error ("Stopped partway") and keeps a
    failed Activity. A refusal before any write makes no job.
  - Agent delete (accepted `pendingArchive`) uses the same job and removes the proposal when it ends.
    A Discard of that proposal during the job stops the job at its next step. Plugin archive and
    service uploads stay synchronous with their 256-node cap.
- Keep expected target IDs and ordered pending source IDs. These stop stale work from changing a
  different file; they are separate from policy history.
- If an external write already happened before a final refusal, queue every exact key for durable
  cleanup before removing its temporary docs. Do not treat starting a vendor retry as final deletion.
- Plugin policy changes use common management checks. A requested `readOnly: true` maps to a local
  selected-account policy, including below a matching account parent. Ensure keeps existing folders'
  access unchanged. Policy changes never restore removed account grants.
  External ensure may recover only the IDs of an exact empty, attached private setup while its account
  awaits a file grant. Live credentials, pinned scope, labels, and sponsor read access still apply.
  This metadata-only path changes no files or grants; all write and policy doors stay unchanged.
- Service archive may clear an allowed direct policy only through the common managed setter in the
  same transaction. It still checks each swept node. A parent policy does not block an unlocked child.
  Reader binding edits preserve independently managed account grants; ordinary reader refreshes cannot
  add them back.
- External transcript writes keep their writer generation and expected content/reader revisions in
  the trusted file stage. The final transaction repeats these checks and saves the write receipt
  with publication. A worker abort or a receipt stored only in the external app cannot replace this.
  File archive can also pin `expectedContentRevision`, checked in its final transaction.
- The external `rollback-readers` door is a narrow ACL undo after a failed native private change.
  Its saved receipt, original credential proof, live service/account binding, and exact current reader
  revision/generation replace sponsor write authority only for restoring the recorded previous readers.
  The saved service writer still checks the current target policy before an undo.
  A new lock returns the normal `read_only` conflict and leaves the native change blocked.
  It changes no content or policy, preserves account grants, filters stale lifetimes, and leaves manual
  or newer sharing untouched. It is not a general file or sharing permission bypass.
  If the original HTTP result was lost, the worker can name the original operation ID. An unapplied
  operation is cancelled with a durable receipt before success is returned; late reader calls refuse.
  This cancellation changes no sharing and requires a recognized sealed grant for the pinned root.
  After an upgrade or account rebind, an old proof cannot authorize the undo. A current sealed
  grant for the same installation and exact root may recover that recorded operation. The current
  actor and account need Files write and sharing-management access. Current labels, policies,
  membership lifetimes, writer generation, and reader revision still apply. A detached binding is
  acknowledged without changing sharing. No old credential grants new authority.
- Private draft moves check current access and policy on their saved source and destination parents.
  Replacing a saved occupant also checks that occupant and its affected descendants. Save repeats
  these checks and the exact saved content-version check before archive and publication commit
  together. Replacing an owned private occupant requires a ready draft and an empty folder when
  applicable; all checks pass before its private generation closes.
- Discard and expiry retire owned private work without deleting saved nodes. A private replacement
  keeps its saved occupant until Save. Discard, expiry, and moving the draft elsewhere leave that
  occupant unchanged, including after a policy refusal. Bash `/tmp` and readable copy-out stay usable.
- Raw path/overlay resolution remains unfiltered so hidden occupied paths still conflict. Authorized
  read entrypoints apply actor and optional account visibility after lookup. Lists never expose raw
  policy fields or hidden writer/source identity.

# Error Contract

- Internal: `Result({ _nay: { name: "read_only", message: "This item is read-only." } })`.
  Branch on `_nay.name`. Do not turn a policy refusal into a generic permission refusal.
- HTTP: `409 Conflict`, existing code `conflict`, same message. Missing ACL remains a permission error.
- `/files/write-many` keeps per-item conflicts and continues. `/files/touch` keeps its sequential,
  request-level conflict. `/files/upload-urls` preflights the batch and mints nothing on refusal.
  Single and plugin routes keep their existing error shapes. `skipIfUnchanged` still checks policy.

# Race Rules

- A final transaction checks current policy again after action work. If the writer is allowed then,
  the write can finish subject to its other checks. Revoked credentials and changed resource identity
  still refuse. An absent destination is resolved again before publication.
- Upload acceptance (mint) checks the live lock, then creates the node, asset, and signed
  create-only target. The finish always completes, even after a later lock, unlock, or lock
  again. A reused URL cannot overwrite a published object. Cancel deletes the unfinished file.
- `yjs_push_update` applies the current rule. A final `read_only` refusal drops queued local edits,
  reloads the saved document, and explains that the unsaved changes were not saved. A permission
  refusal keeps its existing warning. Network/rate failures keep edits and retry every five seconds.
  Compaction retries five times with the existing delay, then shows the final refusal on the sixth.
- Pending proposals remain visible through policy changes. Save, Accept, and rebase can resume when
  every affected node allows the writer. Whole-proposal Discard stays available.

# Accepted Upload Completion

The upload flow is:

1. The signed PUT creates the object at `assets/<assetId>`. Reusing that URL gets 412 while the object exists.
2. The event action matches the exact stored bucket and canonical key, then reads the object's metadata.
3. The final mutation rechecks ownership and retirement, publishes size and etag, and starts processing once.
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
A committed target stays terminal. Only a named tenant, workspace, or account deletion bypasses file policy;
these use `db_purge_organization_workspace_content_batch` in `data_deletion.ts`.

Those retry doors still recheck the target's original destination seal, active current path, and
current actor/account authority and restricted-file ACL. A later lock does not stop them: remint
refreshes transport for the same accepted operation.
If a service call observes that a member moved the file outside the seal, it closes those doors
permanently for that target. The accepted R2 event can still finish and charge the file's real size.

The service `delete` route also checks current policy before any write. It archives a committed upload,
because that file may now hold normal editable state and history. It hard-deletes only a pending
service placeholder, which has no accepted content yet.

The R2 event settles a service target in the publication transaction. `actualBytes` is the winning
object's size. `chargedBytes` is the largest observed attempt size; only an increase is charged.
`plugin_service_storage_attempts` keeps each old asset's target link after asset removal. Late events
may increase the target's charge, but cannot change its winning size, pointers, or file-save event.
Duplicate and smaller events add no charge. Cleanup never refunds bytes.

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

Public node queries return `canWrite`, `writeBlockedReason` (`null`, `permission`, or `read_only`), and
`writePolicyState` (`none`, `read_only`, or `writer`). They hide raw `writePolicy` and
`newChildWritePolicy`. A selected human can edit while a policy is present.
Lists do not join account names or expose raw authority fields.

Operation capabilities use actual `canWrite` plus the immediate parent write for rename and move.
Delete and archive also look at visible protected descendants. The server checks hidden descendants
again. Rows stay readable, selectable, searchable, and expandable. A folder that only holds protected
children has no lock. Policy and restricted-sharing indicators stay separate.

Files Properties offers Editable, Read-only, and Selected writer. Folders also have a New items
default. There is no inherited text and no Open parent policy. The shared management state returns
`canManage`, safe `localPolicy`, `localDefault`, and write access. A hidden or revoked writer is
redacted to null while the local mode stays `writer`. Apply to contents uses the saved folder policy,
confirms first, never runs from Save, and then says the job runs in the background. Its progress and
result show in Activity: "Updated N items so far", "Updated N items, M already set, K not allowed",
"Stopped. N items were updated.", or "No items could be changed. K are not allowed."

Status copy: a read-only file says `This file is read-only.`; a read-only folder says
`Folder is read-only. Items keep their own protection.` Sidebar create of a protected default asks
for the name first. Cancel creates nothing. The sidebar learns the default from
`files_nodes.get_folder_new_child_write_policy_state`, which reads only the folder's own
`newChildWritePolicy` and returns `none`, `read_only`, or `writer` (no account names). Do not use the
management state there: it does more work than a create needs, because it checks management, write
access and the blocking rule, and looks up account names. If the lookup fails, the sidebar shows
a toast and creates nothing.

Policy saves use the dedicated setter. Metadata Save remains a separate action. Keep keyboard focus,
clear pending feedback, accessible labels, and usable layout at 200% zoom. Do not disable a focused
control only because its save is running. Folder radio groups use unique names.

# Requirements

| ID | Requirement |
| --- | --- |
| RO-01 | Every content write passes ACL and the named node's current local policy |
| RO-02 | Rename and move check the named item and its immediate parent, hidden restricted children included; delete checks every removed item |
| RO-03 | Owners/admins do not bypass policies; selecting a writer grants no access |
| RO-04 | Policy configuration requires actual target/creation-scope management |
| RO-05 | A folder default is copied once onto brand-new children; later default changes do not rewrite them |
| RO-06 | Reads, sharing, safe comment replies, downloads, and readable copy-out keep working |
| RO-07 | Final transactions check current actor, account, scope, and policy before writes |
| RO-08 | Past policy state does not replace current checks or content-staleness checks |
| RO-09 | Pending work remains visible; Discard remains available through a refusal |
| RO-10 | Queries and refusals hide inaccessible source and writer identity |
| RO-11 | Accepted uploads and committed Yjs convergence finish; dead-upload cleanup removes placeholders even when locked |
| RO-12 | UI uses actual human write access and remains keyboard/zoom accessible |
| RO-13 | Policy refusal keeps the stable read_only and HTTP conflict vocabulary |
| RO-14 | Refused operations commit no partial state and retain durable external cleanup |

# Test Map

- `convex/files_nodes.test.ts`: selected writers, ACL independence, local create defaults, folder-only
  management, creation management, unlock one child, redaction, and writes.
- `convex/files_write_policy_runs.test.ts`: Apply to contents steps, blocked and hidden items, rechecks,
  Stop, deadline, and history cleanup.
- `convex/files_pending_updates.test.ts`: current-policy proposal, commit, and private discard checks.
- `convex/files_nodes_content.test.ts`: replacement, collaboration, snapshots, and materialization.
- `convex/public_api*.test.ts`: bound accounts, current credentials/scopes, service targets, conflicts,
  policy management, accepted uploads, and no partial publication.
- `convex/access_control.test.ts`: human/account permissions, management authority, and source privacy.
- `convex/r2.test.ts`: accepted-upload completion and exact-key cleanup generations and tombstones.
- `convex/data_deletion*.test.ts`: lifecycle deletion and durable asset ownership.
- `convex/data_import.test.ts`, `server/bash.test.ts`: ordinary imports and human pending writes.
- Frontend policy, pending sidebar, editor, and Yjs provider tests: safe state, actual write access,
  current-policy refusals, and retry behavior.

# Related Skills

- `../access-control/SKILL.md`: actor/account permissions, grants, and account management.
- `../files-agent-pending-updates/SKILL.md`: proposal, commit, discard, and private cleanup.
- `../files-editable-text/SKILL.md`: Yjs write doors and shape guards.
- `../files-explorer-tree/SKILL.md`: tree operations and row interactions.
- `../public-api/SKILL.md`: credentials, scopes, plugin adapters, and conflict responses.
- `../data-deletion/SKILL.md`: named lifecycle deletion and durable asset cleanup.
- `../ai-chat-agent/SKILL.md`: ordinary human agent/Bash behavior.
- `../files-rich-text-embeds/SKILL.md`: document and destination checks for embeds.
- `../plugin-system/SKILL.md`: installation account bindings and integration limits.
