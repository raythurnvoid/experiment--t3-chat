---
name: files-agent-pending-updates
description: "Current /files pending changes: private file and folder creates, per-user content branches, moves, copies, replacement, deletes, review, Save, Discard, search, and expiry. Use when changing pending state, agent Files tools, review actions, or cleanup."
---

# Content And Structural Proposal States

Cross-workspace rule: only Copy may cross workspace boundaries. Copy current content,
metadata, and allowed write rules. Leave originals, old versions, and comments at the source.
Cross-workspace `mv` returns `cross_workspace_move` and suggests `cp` or `cp -R`.
Never turn this refusal into automatic Copy plus Archive or delete.
TODO: revisit transferring file versions and comments across workspaces in a future change.
The boundary and Copy lifecycle are in
[Files transfer runs](../files-explorer-tree/references/transfer.md#workspace-boundary).

Each `files_pending_updates` doc belongs to one user and one saved or private target. It may contain a content proposal, a structural proposal, or both. Saved Files doors still accept a saved `nodeId` and build the tagged target at their boundary.

Pending updates work for both document shapes: a Markdown file's `rich_text` (ProseMirror) Yjs document and every other editable text file's `plain_text` (`Y.Text`) document. The node's `textKind` decides the current shape. After a restore changes shape, `contentRebaseRootKind` keeps the old branches readable until preparation replaces them (see the `files-editable-text` skill). Both shapes use the same three branches and text merge.

A content proposal stores one `content` object. Its `base` is `{ kind: "yjs", sequence, lineageGeneration }` for a collaborative file, `{ kind: "asset", assetId }` for a file with collaboration off, or `{ kind: "new" }` for private new content. The same object owns the three sealed state IDs:

- `base`: the live file state the pending update was built from.
- `staged`: the branch that save will persist.
- `unstaged`: the unresolved/proposed branch shown on the modified side of the diff editor.

That separation enables per-hunk accept/discard, `Accept all` without saving, partial saves that keep unresolved edits pending, and sync/rebase against newer live file state.

Structural state uses:

- `pendingMove` for move or rename intent.
- `copiedFrom` for copy or replace provenance.
- `pendingArchive` for delete intent (bash `rm`): accepting archives the node; a folder archives its whole subtree, computed at accept time. Setting it clears `pendingMove` — a delete supersedes a move. Content branches survive on the doc (accept ignores them; discard restores them as a Modified row).
- `createIntent` for a private file or folder. Missing agent write and copy targets stay private until Save. Removing an owned private create discards that private identity and its approved pending work.
- `mediaDependencySetId` on copied documents points to sealed, indexed image/video mappings.
  Each set has one owner and a generation. The mappings pin selected destination targets and versions.
  Save checks real embeds in the actual accepted text before writing. Each used media target must
  be saved unchanged or in the same reviewed unit. Group by resolved target, including permanent
  private-origin links after Save. A new replacement or Archive proposal cannot bypass that group.
  Removing the embed releases its Save requirement; code and plain links do not require media.
  Bulk review reads the sealed text selected for Save before joining media items. It keeps stored
  pins for other branches and checks the final merged text again before writing.
  If a live merge adds a link to media selected in another unit, Save refuses that document and
  asks for a fresh review. The whole run's selection is never treated as one atomic unit.

There is no separate source-removal review. Saving a Copy never changes its original.
Completed proposals need current destination access for human Review and Save, not access to the
old source chat. New copies use destination read access; replacements keep destination access.

Move-only docs have no `content` object and use `size: 0`. Private creates and proposals with a move or delete may remain when the three content states match.

# Data Model

Main table in `packages/app/convex/schema.ts`:

- `files_pending_updates`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `target`: exactly `{ kind: "saved", id: Id<"files_nodes"> }` or `{ kind: "private", id: Id<"files_pending_nodes"> }`
  - `revision`: advances whenever reviewed content or intent changes; `updatedAt` records the last proposal edit
  - optional `content` object:
    - `base`: exactly one of the `new`, `yjs`, or `asset` variants above.
    - `baseStateId` / `stagedStateId` / `unstagedStateId`, each pointing at one sealed `files_pending_update_yjs_states` doc whose pages hold that branch's full Yjs state. Branch bytes never live on the pending update doc itself.
  - optional `contentNeedsRebase: true` after a collaboration toggle or restore. The old base and all three states stay intact until preparation replaces them.
  - optional `contentRebaseRootKind`: the source shape captured before restore. Repeated restores keep the first captured shape. Preparation and content removal clear both fields.
  - optional `pendingMove`
  - optional `copiedFrom`
  - optional `pendingArchive` (`fromPath` display metadata only; the node id is authoritative)
  - optional `createIntent` for private text, stored content, or folders
  - optional `threadIds` (contributor set: the chat threads that touched this doc, deduped; agent writes append their thread id, client-driven writes leave the field out of their patches so it survives, and it dies with the doc; unset for client-only docs and rows older than the field)
  - `size` (UTF-8 byte size of the current `unstaged` text, or `0` for a structural-only doc)
  - `updatedAt`

Private lifetime and cleanup (`packages/app/convex/files_pending_nodes.ts`):

- Every private node has one proposal. Its owner, parent, creation generation, and structural revision stay on the node. Its create intent, content, contributors, and idle expiry stay on the proposal.
- Direct Discard checks the exact proposal ID and revision before any writes. A ready child or another chat's child outside the reviewed set returns `needs_review`. A pending move into the folder also needs review. The direct transaction checks up to 256 private nodes; larger sets use bulk review.
- Closing the generation hides the approved subtree at once. Each node gets a durable `files_pending_node_cleanup_tasks` doc. Cleanup removes the proposal indexes, retires its states, hands assets to the deletion ledger, and expires its batches. It keeps the node until its batches, states, and discarded children are gone. Node slots release only after node deletion. A 15-minute cron resumes failed cleanup continuations.
- Expiry removes private leaves first. Any active child keeps its private parent alive without a
  whole-tree scan. Cleanup records store the current `expiresAt` and `expiryGeneration`; callbacks
  require that exact task and generation. Rescheduling expiry does not change the proposal revision.
- `files_pending_holds` keeps exact proposals alive for active Copy and review jobs. Roles separate
  source, destination parent, preparing output, ready output, and review. Private identities also
  pin their creation generation. Holds delay expiry only; they grant no access or write permission.
  A selected source folder protects its private descendants during discovery. A retry's later
  manifest pages stay protected until their new holds are installed.
- Retry pins each completed output's exact proposal ID, private creation generation (or null),
  and replacement asset (or null). Later edits or renames of that proposal keep its hold.
  A different proposal or replacement at the same target does not inherit it. Completed retry
  items keep this pin; an item selected for a fresh attempt clears it.
- Ready output and retained review work get four hours from producer completion. The producer
  stores that fixed deadline once. Release pages install it before removing holds and preserve any
  later edit deadline. Old callbacks cannot shorten it. History retains the producer until release ends.
- A published parent resolves through its owner-scoped saved receipt; Discard does not remove that saved identity. Daily receipt cleanup keeps the private identity for seven days and while any child, proposal, copy source, state, batch, review item, transfer item or parent, or a Bash shell's cwd still refers to it. It pages past retained identities so they cannot block later cleanup. Removing the unused private identity and receipt never removes the saved file.
- Every private Save records `files_nodes.publishedFromPrivateNodeId`. Read-only target lookup can use this indexed origin after private cleanup, then checks the saved file's current ACL. Private mutation lookup remains strict. Old chat links therefore survive Save, rename and move without granting access.
- Copied-folder receipts can carry `copiedWritePolicy` and `copiedPath`. Only Save may use this proof
  to finish a child under its unchanged copied parent. Check owner, private generation, structural
  revision, saved origin, frozen path and policy, and current ACL. Normal editing and new-child
  creation still obey the parent's write policy.
- A new draft under an archived saved parent has a narrow recovery read. It requires the owner,
  live membership, and current read access to that saved ancestor. Pending and the private detail
  view expose Copy/Download, the expiry date, and an `Open archived folder` link. A user who may
  restore the folder does it there. Save stays blocked, and the toolbar says to restore the folder.
  Missing, purging, or unreadable ancestry does not become export access. Normal path/search,
  agent traversal, editing, and media signing do not use this recovery exception.
- Producer outputs use `files_ingestion.prepare_file`, `finalize_file`, and `abort_file`. Each file is its own commit. The trusted writer accepts at most eight files and 8 MiB per call, including empty files. It uses canonical Files paths such as `/reports/output.bin`. It checks strict paths, access, policies, depth, and node quota before allocating content. Stored finalization repeats the path check and uses bounded suffixes to avoid saved and private occupants.
- `files_ingestion_receipts` binds one actor, tenant, and request ID to the path, MIME, byte count, SHA-256 digest, and text shape. A 30-minute preparing receipt owns one attempt token and its asset or initial text batch. The same attempt can recover a lost prepare reply. Another attempt gets `in_progress` and no resource IDs. Finalize adopts the content and completes the receipt in one mutation. Completed and aborted receipts stay for 24 hours. Indexed cleanup handles at most eight receipts per pass. Completed receipt expiry never deletes its file.
- Stored content uploads before finalization. Valid editable text uses the normal initial private batch and sealed state family. It stays Preparing until the text and receipt commit together. The writer chooses its text shape from resolved MIME before creating the draft. Unsupported, invalid, or over-limit text stays as exact stored bytes. Generated Markdown with over-cap frontmatter also stays stored; normal uploads instead convert with their existing frontmatter markers.
- Agent downloads from a web browser command use the same writer. `browser_run` turns each download of a successful run into a file at `/.system/downloads/<name>` in the current workspace, with the name from `files_normalize_browser_download_name` (special names get `-download`, for example `agents-download.md`). They join the emitted files in one call, inside the same eight-file/8-MiB limit, and become normal pending creates with bounded suffixes. The tool checks each download first and drops only a bad one, because the writer refuses the whole list for one bad path. Ask mode refuses them with `agent_required`. A human download saved from the viewer is not a proposal: it is a normal upload node (see the `cloud-browser` skill).
- Generic ingestion checks current user, membership, plan, destination access, policy, and byte holds. Chat doors add Agent mode and current thread access. Browser doors add source and lease checks. These checks run again inside fresh finalization. Completed retries check current file access and return the current target without rerunning a producer gate. Abort skips completed work. It retires only its own unchanged draft and unused parents. New edits or dependent children survive. Asset holds remain until exact-key deletion settles after the last possible PUT.
- `files_nodes_content.get_file_read_data` resolves the caller's pending view. Stored replacements use their held asset; pending deletes and preparing content are unavailable. It pins the target, asset, MIME, path, proposal ID/revision, and private generation. Old private links follow Save and then use current saved-file access. Ready private downloads require a cleared `unfinalizedExpiresAt`, a held byte reservation, and the exact active proposal. All outputs keep normal four-hour expiry and Save billing.
- `get_file_pending_target` and pending rows return `requiredParents` in root-first order plus `canAcceptWithParents`, and `savedParentId`: the saved folder the pending chain hangs from, `null` at the root. The header breadcrumb builds its saved crumbs from it. UI shows those folder paths before connected Save and submits their exact proposal IDs/revisions with the file. It never silently selects siblings.
- A private folder draft that holds at least one active child draft is not a change of its own, like in Git: saving the child creates the folder too. `db_pending_update_is_listed` decides which proposals are listed. It checks that the proposal matches the chat filter, that its private draft is still active, and that a folder draft holds no active draft (one indexed read on `files_pending_nodes.by_organization_workspace_user_parent_state_name`). The summary counts use the same function, so the Pending list, its source counts, the tab badge, and the chat strip counts always agree. The folder stays hidden under every source, even when its child came from another chat. When its last child draft is saved or discarded, the folder shows as its own row again. Each `requiredParents` item carries the parent proposal's `threadIds`, so the client knows a hidden folder's chats without loading its row.
- `list_files_pending_updates` runs that check inside the convex-helpers `stream(...).filterWith(...)` before paging, so a skipped proposal never uses a page slot. The stream reads at most 100 proposals per page. When it reaches that limit, it ends the page early, and the page can be short or empty while `isDone` is false. A page with an `endCursor` has no read limit: the hook splits a page at its early stop, so an early stop there would leave the rows after it unloaded. Page it with `usePaginatedQuery` from `convex-helpers/react`, not `convex/react`. Only that hook pins each loaded page's end with `endCursor`, so an added or removed proposal cannot skip or repeat a row.

Bulk review (`packages/app/convex/files_pending_update_runs.ts`):

- One review lane runs per user/workspace, separate from transfer admission. A different busy request returns the active run and Activity IDs. Preparation uses the same two-worker Workpool component as transfers. Each unit keeps its Workpool ID so Stop and retries cancel queued work after fencing publication.
- The run stores reviewed proposal IDs, revisions, and selected content state IDs in pages.
  Planning classifies independent Copy outputs separately from ordinary linked work. Copy has no
  total selection cap: indexed prerequisites order parents and selected media before dependents.
  Ordinary linked changes keep bounded atomic units. An unrelated edit does not pull thousands
  of copied files into one transaction. Each unit commits independently, so Copy Save can finish partly.
  Bulk Discard still accepts at most 10,000 selected changes.
- A selection whose proposal changed or disappeared before classification never uses the new intent. It joins the bounded atomic subset, because its reviewed links are unknown. If atomic planning finds a changed item, or an unselected change the subset needs, `block_atomic_plan_page` puts the whole subset into one `needs_review` unit, page by page. The unselected change is only listed in `needsReviewIds`; it never joins the Save. Before the Copy units are planned, every selected Copy that shares a reviewed or current path with the subset (contains it, sits in it, replaces it, or holds a folder the subset moves into) is promoted into that blocked unit, repeating until no new Copy links. Current paths only add links; nothing is planned with a changed intent. Independent Copy units still save. An owner clock change during planning does not refuse the whole run: the seal clock stays pinned, and each unit is checked again before it saves. Known limits: a Copy used only as media by a blocked document still saves alone (safe; the document waits), and cycles, `review_too_large`, the media-page window, and a partly staged normal plan still fail the whole run.
- Planning and later checks use the same dependency graph. It accounts for private parents, moved saved parents, replaced targets, projected paths, and archive or Discard scope. An unselected affected proposal returns `needs_review`; the worker never adds it to the selection.
- `files_pending_review_versions` is the owner's pending-change clock. The normal path seals each unit against the run's current clock. An outside edit enables `revalidateRemaining` for the rest of the run. Every later unit then checks its original IDs, revisions, content states, paths, and dependency scope in pages, even after an earlier unit's own commit advances the run clock.
- Every page and the final seal check the same clock. The final transaction requires that unit's `validatedReviewVersion`. A clock change retries the same unit up to three attempts, then returns `needs_review`. A changed reviewed item or new dependency blocks the unit at once.
- Private subtree Discard checks the selected descendants in pages, then fences the approved roots in one small transaction. The unchanged unit clock protects that checked set. Activity counts the full unit when the roots close; cleanup continues after Stop. Other final transactions count their reads, writes, bytes, and query ranges and roll back as `review_too_large` before exceeding the supported budget.
- Before final writes, each connected Save checks the full file-save cost for each pinned payer. Folders, moves, unchanged text, and replaced occupants add no charge. Anonymous debits and signed-in billing jobs commit with the files; failed units publish and bill nothing.
- Copy media validation checks pages against organization/workspace access versions and the owner's
  pending version. Seal the exact prepared text, selection, set generation, and proposal revision.
  Final commit checks those pins again. Atomic units validate every media proof before their first
  write and carry only an in-memory token tied to that mutation; it cannot be reused in another call.
- Real planning and preparation progress refresh the idle deadline. Waiting alone does not.
- Stop fences unfinished workers and retires prepared content. It keeps completed units. Recovery bounds lost planning and preparation attempts; user and workspace purge stop review work before removing proposals. Late replies from expired attempts use the watchdog's same three-attempt limit. Whole-run expiry ends as `timed_out` even when delayed planning arrives before the watchdog.
- Common Activity history cleanup owns the seven-day review retention window. It drains finished run items and units through the producer's bounded delete helper. Review recovery scans only active work; it has no separate finished-history scan.

Paged pending-state storage (`packages/app/convex/schema.ts`; shared helpers in `packages/app/server/files.ts`):

- `files_pending_update_yjs_states` — metadata for one branch state (one role: `base`, `staged`, or `unstaged`), with the same tagged `target`. A full Yjs state can be larger than one Convex value, so it never travels or stores as a single value. The `owner` union says who deletes the family: `active` states belong to a pending update doc, `temporary` states to an operation batch (expiry-swept), `retired` states to a durable cleanup task. Each state records `lineageGeneration` (unset for a file with collaboration off, which has no document lineage), `sealed`, `pageCount`, `totalBytes`, and `digest`.
- `files_pending_update_yjs_state_pages` — the bytes, in non-empty pages of at most `files_MAX_YJS_WIRE_BYTES` (930,000 bytes), contiguous by `pageIndex` from 0. A state holds at most 5 pages, which covers the 4 MiB state cap.
- `files_pending_update_state_cleanup_tasks` — durable cleanup task for a retired family. A commit re-owns the previous states to a task doc instead of deleting pages inline; a bounded scheduled continuation drains pages, states, then the task.
- `files_pending_update_operation_batches` — one in-flight upsert or rebase per user and tagged target. It captures the expected proposal ID and revision, or null when no proposal exists. Private targets also capture creation generation and structural revision. Staging, sealing, and adoption refuse changed targets. A batch expires after 30 minutes, and a new create by the same user takes over a batch idle past 2 minutes (`lastActivityAt`, refreshed by page staging, text-input staging, and the seal).
- Agent text batches also store `agentSource`: the chat, creator, source membership, and captured membership lifetime. Batch reads and final adoption recheck that source and its allowed destination. Bash text/folder creation and `edit_file` carry this source. A finished proposal is independent: human Save creates its own batch and does not need the old chat. Non-agent batches have no `agentSource`; this is a caller distinction, not an old-schema fallback.
- Agent archive proposals and Added-draft removal carry the same `agentSource` into their writing transaction. Removal refuses an ended source membership, including after re-invite. This check does not attach a lasting source-access rule to finished proposals.
- Agent preparation and proposal readback carry `agentSource` too. A rebase creates its own source-bound batch, so revocation during preparation cannot update a home proposal. Human Review and Save keep their own destination checks and do not depend on the source chat.
- `files_pending_update_text_inputs` — one staged text value (role `staged` or `unstaged`) per batch, with its batch's tagged target, so no registered call carries two large values at once.
- `files_yjs_trusted_update_stages` — one server-built Yjs update staged ahead of its commit (pending accept, public fill, snapshot restore), so the commit call carries only ids and one bounded text. 30-minute TTL.

The digest is two FNV-1a 32-bit passes joined as hex (`files_pending_update_yjs_state_digest` in `packages/app/server/files.ts`). It is not cryptographic; it only detects a torn or mixed page family when a state is reassembled.

Unified exact text chunk table:

All three index tables below use strict committed/pending variants. Committed docs require a real `fileNodeId` and may carry `yjsSequence`. Pending docs require real tenant IDs, `target`, `userId`, `pendingUpdateId`, and `proposalRevision`; they have no saved `fileNodeId`. Saved move and cleanup helpers query both the committed file index and the pending target index. Owner reads hide content marked for rebase until preparation rebuilds its indexes.

- `files_text_chunks`
  - `organizationId`
  - `workspaceId`
  - committed `fileNodeId` or pending `target`
  - `sourceKind: "committed" | "pending"`
  - required `userId`, `pendingUpdateId`, and `proposalRevision` for pending docs
  - optional `yjsSequence` for committed docs
  - `chunkIndex`
  - `textChunk`
  - `startIndex` / `endIndex` / `lineStart` / `lineEnd` / `chunkFlags`
  - committed yjs-sequence indexes and pending-update indexes for exact reads and regex scans

Unified full-text search table:

- `files_plain_text_chunks`
  - `organizationId`
  - `workspaceId`
  - committed `fileNodeId` or pending `target`
  - `sourceKind: "committed" | "pending"`
  - required `userId`, `pendingUpdateId`, and `proposalRevision` for pending docs
  - optional `yjsSequence` for committed docs
  - `textChunkId`
  - denormalized `path`
  - optional `archiveOperationId`
  - `chunkIndex`
  - `plainTextChunk`
  - `textChunk`
  - `startIndex` / `endIndex` / `lineStart` / `lineEnd` / `chunkFlags`
  - `hasChunkAbove` / `hasChunkBelow`
  - search index `search_by_plainTextChunk` (filter fields `organizationId`, `workspaceId`, `archiveOperationId`)
  - committed replacement, pending replacement, and scope patching indexes

The old separate search and pending chunk tables no longer exist. Bash full-text `search` uses the unified `files_plain_text_chunks` table as a self-contained search-result doc; exact text reads use `files_text_chunks`, while plain-text regex search reads line numbers from `files_plain_text_chunks`.

Unified Markdown frontmatter metadata docs:

- `files_metadata_docs`
  - one table for committed and pending indexed metadata docs
  - field docs use `docKind: "field"` and support existence search, including fields whose value is an object, array, unsupported value, or otherwise only searchable by existence
  - value docs use `docKind: "value"` and support one searchable primitive value per field value
  - `organizationId`
  - `workspaceId`
  - committed `fileNodeId` or pending `target`
  - `sourceKind: "committed" | "pending"`
  - required `userId`, `pendingUpdateId`, and `proposalRevision` for pending docs
  - optional `yjsSequence` for committed docs
  - denormalized `path`
  - denormalized `treePath`
  - optional `archiveOperationId`
  - `fieldPath`, currently `frontmatter.*`
  - optional `valueKind: "string" | "number" | "boolean" | "maybe_date"` for value docs
  - one value column matching `valueKind`: `stringValue`, `numberValue`, or `booleanValue`; `maybe_date` stores its epoch-milliseconds timestamp in `numberValue`
  - a date-like string value is indexed twice: the normal string value doc plus one `maybe_date` companion doc
  - committed replacement, pending replacement, scope patching, field-existence search, string prefix/equality, numeric and maybe_date range/equality, and boolean equality indexes; maybe_date reuses the number-range index because `valueKind` sorts before `numberValue` in it

Frontmatter caps: there are two, both in `packages/app/shared/files-metadata.ts` — `files_metadata_MAX_FRONTMATTER_FIELDS` (128 distinct fields) and `files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS` (512 index documents; fields plus values, `maybe_date` companions included). The pure preflight `files_metadata_preflight_frontmatter` counts both. All three pending commit mutations (upsert, rebase, save-partial) run `files_pending_update_check_frontmatter_caps` BEFORE any canonical write and return the visible `Too many frontmatter fields` `_nay`; the calling actions answer it by retiring the staged batch. The throws inside the metadata insert helpers in `packages/app/convex/files_metadata.ts` stay as impossible backstops only. The caps exist because each field becomes one or two metadata doc inserts in the same transaction, and the 900 KB content cap alone would allow thousands. Frontmatter indexing is `rich_text`-only: a pending `.yaml` file that starts with `---` is never frontmatter-indexed.

Date-like frontmatter strings: a string shaped like an ISO date (`YYYY-MM-DD`, optionally with a time) also gets a `maybe_date` value doc holding its epoch-milliseconds timestamp, so the agent can range-filter dates that YAML keeps as strings. The shared recognizer is `files_metadata_parse_maybe_date` in `packages/app/shared/files-metadata.ts`. Extraction and `meta search` range-bound parsing must use that same recognizer, or a query bound could ask for timestamps the index never wrote. Only files saved after this feature landed have the companion docs; there is no backfill, so an older file stays string-only until its next save.

Value docs are bounded by the 512 index-document cap above: array items add one value doc per distinct item, and a date-like string adds a second `maybe_date` doc, so one field with a long array can blow the cap on its own. Committed materialization must not throw inside the workpool (`maxParallelism: 1`, infinite retries — a throw would retry forever and block every other file), so it settles instead: over-cap frontmatter marks the node with the `contentFrontmatterTooLargeFieldCount` / `contentFrontmatterTooLargeIndexDocumentCount` pair and keeps the committed content at the last sequence that fit. See the `files-editable-text` skill for the marker lifecycle.

Saved-sequence marker table:

- `files_pending_updates_last_sequence_saved`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `fileNodeId`
  - `lastSequenceSaved`
  - `updatedAt`

Cleanup table:

- `files_pending_updates_cleanup_tasks`
  - `pendingUpdateId`
  - `scheduledFunctionId`
  - `expectedUpdatedAt`

The authoritative identity is per user and per file node. Two users can each have independent pending updates on the same file.

# Editable-Text File Scope

Pending updates attach to editable text `files_nodes` docs (`files_node_has_editable_text_content`), in either shape and in both collaboration modes.

Node keys are required. `textKind` records the text shape, including when `collaborationEnabled` is false and live Yjs pointers are null. Blobs and folders have null text and collaboration settings. Pending replacements keep optional `yjsRootKind` and `nonCollaborative`; map those fields explicitly when publishing a node. Snapshots require their saved content type, nullable `yjsRootKind`, and boolean `collaborationEnabled`. Stored snapshots use null shape and false collaboration; stored nodes use null for both. Node archive markers use null while pending metadata and plain-text chunks keep an absent archive marker for active content.

- Editable Markdown files (`rich_text`) and plain-text files such as `.json` or `.yaml` (`plain_text`) participate directly in pending review/edit flows.
- Plugin-generated Markdown outputs are ordinary files, so they can participate in pending review/edit flows after the plugin creates them.
- Raw uploaded source file nodes without Yjs ids (stored blobs) do not directly participate in pending content edits today.
- A text file with collaboration turned off has no Yjs document, but it takes part in pending review the same way: the agent's write builds the three branches from the saved text (see "Files with collaboration turned off" below). A move or delete proposal on such a file works normally, because those docs carry no branches. The diff view shows the proposal when the member has one (`FileEditorDiff` with `nonCollaborative`), and otherwise the member's own unsaved edits against the committed text (`FileEditorDiffNonCollab`; see the `files-editable-text` skill).
- Uploaded source paths do not alias to generated outputs; pending edits attach to the exact file node being edited.
- Move-only and delete-only docs can represent folders and non-content file nodes. Those docs do not carry Yjs branches.

# End-To-End Flow

HTML Preview can read the member's current `unstaged` branch before Accept or Save. It never calls review preparation or writes proposal content. A stale proposal asks the member to Review or Sync first. A local modified Diff pane is also Proposed changes; the staged pane is not Saved. Preview keeps its selected source and frozen text until Refresh. If that source disappears, it stops the frame and asks for another source instead of silently showing Saved. See [files-editors](../files-editors/SKILL.md#file-view-dropdown-and-html-preview) for the editor lifetime and draft getter rules.

Workspace AGENTS.md and skills use the same current-user pending content and paths as ordinary file reads. Startup discovers skill metadata and root rules. Bash loads whole skills and returns rules for the paths it uses. There is no separate saved-only view or activation state. New reads check current access; earlier tool results remain in chat history. See the [workspace skills spec](../ai-chat-skills/SKILL.md).

1. Ordinary file tools in `packages/app/server/server-ai-tools.ts` translate visible paths to committed paths through the current user's pending structural overlay, then read file content through `internal.files_nodes_content.get_file_last_available_text_content_by_path`, an internal action that can fetch committed Markdown from R2. `edit_file.pendingUpdateId` is only a model-provided lookup hint. The tool normalizes it through Convex and treats an invalid value as absent, so the user-and-file lookup can still find the current pending update.
2. That read path overlays the current user's pending `unstaged` branch when content exists. Pending destinations are visible, vacated or replaced paths are hidden, and descendants follow a pending folder move.
3. `edit_file` and Agent-mode bash shell writes (`bash_DbFilesFs.writeFile`/`appendFile` in `packages/app/server/bash-utils.ts`, reached by `>`/`>>` redirects, heredocs, `tee`, and `touch` on a new path — `touch` on an existing app file is a no-op) go through `files_agent_write_file_text` in `bash-utils.ts`: create an operation batch, stage the one proposed text, then call the ids-only `internal.files_pending_updates.upsert_file_pending_update_internal_action`. Every staged text crosses `db_stage_operation_batch_text_input`, which drops one leading BOM and normalizes CRLF and lone CR to LF (`files_normalize_text_document_input`) before the byte count, so the branch document, the pending chunks, and the stored size all see the same string. A staging refusal retires the batch first so the user is not locked out. The branch is built under the TARGET file's `textKind`, so a shell write or `edit_file` is always a text edit in the file's own shape. A `cp` never gets a branch: it is staged as a whole-file copy that keeps the source's content type and shape (step 2 below), and `mv -f` is a structural replace-move, so neither one parses the text.
4. Agent calls stage no `staged` text, so the backend preserves the current `staged` branch and updates only `unstaged`.
5. `files_pending_updates` creates or updates a doc for the user and tagged saved or private target. A missing agent write target is created in `files_pending_nodes`. Its initial text batch must seal before the draft is ready.

Before reading text for an edit or shell write, the tool calls `prepare_file_pending_update_for_agent` with the acting user's scope and node id. This uses the same preparation as Review, with active membership and file-write checks. It runs before the write batch and needs no owner to open Review. Targeted edits and appends then read the prepared proposal and compute fresh output. Their write carries the base state id from that read. If the base changes before commit, they prepare, read, and recompute once; they never resend old whole-file output. A shell overwrite still replaces the proposed text with the supplied bytes. Preparation failure keeps the old proposal and stops the write.

**Files with collaboration turned off use an asset base.** The pending doc stores `content.base: { kind: "asset", assetId }`. The first upsert builds base and staged from committed text in the file's shape; the agent's text becomes unstaged. A member save makes the proposal stale when `content.base.assetId !== node.assetId`. Ordinary reads and searches then show committed content until Review or the next agent write prepares the proposal. Direct stale upserts and Save still refuse with `files_PENDING_UPDATE_STALE_BASE_MESSAGE`; tool entrypoints prepare before calling them. Discard removes the content and keeps any move or delete.

Save dispatches to `action_save_file_pending_update_non_collaborative` and `save_file_pending_update_non_collaborative_in_db`. It publishes staged text, stores a version snapshot, and bills one `file_save`. A partial save keeps unstaged work and advances `content.base.assetId`. Text normalization is unchanged: one leading BOM is removed, line endings become LF, and rich text uses its Markdown serialization. Ordinary saves, collaboration toggles, and every restore preserve proposals. Accepted whole-file copies still drop destination content proposals for every member. `mv -f` on a committed file remains a structural replace-move: it archives the target and moves the source with its own mode and history. A private source uses `pendingMove` only to keep an exact saved replacement claim until Save.

In the UI, a proposal on a file with collaboration off opens in `FileEditorDiff` with `nonCollaborative` and `committedAssetId` (the `assetId` of the editor node `FileNodeView` chose for the route: the selected file, or a folder's README): the editor loads only the proposal's branches, so there is no live-file fetch, no Sync, and no versions button. Save calls the same `save_file_pending_update` and shows "Changes saved". The action result carries `pendingUpdateUpdatedAt` (the doc's `updatedAt` after the save, or null when the save deleted the doc), and the view stays busy until its doc query shows that doc, because the query can deliver the save later than the action result and the reconcile effect would otherwise reload state pages the save deleted. The view exits once the doc is gone (a full save, a Discard, a row action, another tab). These exits replace the current browser history entry, so Back does not reopen the finished review. A failed ordinary branch reload shows "Failed to load the updated proposal. Open it again." and exits. A failed preparation reload keeps the old panes and offers Retry; Retry loads the pages again without preparing an already current proposal. An asset-stale proposal uses the same preparation flow as a marked proposal. The pending row says "Review to update" in its caption and accessible name. Accept explains that Review is needed and sends nothing. "Accept all" skips unprepared content with one explanation.
Saving in the normal editor has no warning about making a proposal stale. The Pending caption and Review status after Save give that feedback.

**Proposals kept across collaboration changes and restores.** Both toggles and every restore mark all owners' content proposals with `contentNeedsRebase: true`. The mark keeps ids, old base pointers, branch states, chunks, contributor threads, and move/delete intent. It leaves `updatedAt` and the expiry task unchanged. Saved-sequence markers are deleted even when there is no pending content. Structural-only and whole-file copy proposals are not marked. Restore captures the old node shape in `contentRebaseRootKind` only when it is not already set. Both same-shape live restore and replacement-style restore preserve content; the shared replacement installer takes an explicit preserve-or-drop policy. Copy still uses drop.

Marked content still counts in Pending. Normal reads and text/frontmatter search use committed content until preparation finishes. Direct upsert, Sync, Save, and their final commits refuse marked content. Agent edit and shell-write entrypoints prepare first. Pending deletes can still be accepted. Discard proposal removes text changes and keeps any pending move or delete. A restore to stored bytes also retains text proposals; applying them to a stored-byte file is not implemented, and the conversion rule remains undecided.

When Review needs fresh branches, it calls `prepare_file_pending_update_for_review` for the current user's exact proposal. Preparation handles a changed asset, live sequence or lineage, collaboration mode, and restore. It reads old branches with the captured source shape, then merges base-to-staged and base-to-unstaged changes onto current text separately. Preparation, client Sync, and collaborative Save share `files_pending_text_merge` in `packages/app/shared/files-pending-text-merge.ts`. Proposed changed lines win overlap; saved text outside those ranges survives. Thus accepted `150` stays `150` over saved `120` or `200`, while unaccepted `170` stays separate. Identical edits appear once. Exact unique moved lines keep their new position; accepted text in a deleted section is restored with its paragraph breaks. An ambiguous mapping, diff-budget, size, shape, or frontmatter failure keeps the old proposal untouched.

Successful preparation builds base from the current target, clones staged from base, then clones unstaged from staged. It projects each merged text into that shared history, seals the pages, and commits only if the source proposal and target still match. The guards include the source timestamp and three state ids, current access/lock/shape, and the exact live sequence-doc id/counter/generation or current asset. The commit retires old state ownership before activating the replacement in one transaction. It clears `contentNeedsRebase`, `contentRebaseRootKind`, and the unused base kind, updates indexes, and refreshes normal expiry. A no-change result settles under the same checks. Preparation neither saves file text nor bills a file save.

An expanded saved replacement may mix rewritten text with unrelated notes. If the current block has more lines than its old range and the target is unclear, merging refuses. Exact unique old ranges and already-applied proposal text remain usable. Shared letters or words do not prove a target: a note can quote the old text. The refusal leaves saved text and every stored proposal branch unchanged.

The review UI blocks typing, hunk actions, Save, Sync, and delayed draft writes while preparation or a history change loads new branches. It handles mode changes, restores, and another member Save in the same mounted editor. A restore reloads the prepared proposal; it never replaces both proposal panes with restored text. Prepared pages must reach the panes before writes resume, even if an older draft response is still pending. Draft writes, Sync, and Save carry the `reviewedUpdatedAt` of the loaded proposal, so they cannot accept a newer version the user has not reviewed. A preparation failure keeps the old text available with Retry, Discard, Copy accepted text, and Copy proposed text. Unsent local typing is kept for copying when panes must be replaced. If Review unmounts, separate accepted/proposed copy warnings keep that text available for 30 seconds. Cleanup also reads live panes, because proposal removal may arrive before the preparation status. Clean or confirmed text needs no warning. Bulk Accept skips unprepared content and explains why.

`get_file_pending_update` returns `currentYjsLastSequenceId` beside the proposal fields. It reads the node and proposal together; the extra field is query metadata, not stored proposal data. Loaded branches use this id instead of a separately delivered node prop. Review waits until both agree. Live fetches also check their returned document id before Sync merges text or a late Save/Sync refresh replaces the file text in the UI.

An ordinary draft refresh within the same history keeps local typing enabled while persistence, hunk actions, Save, and Sync wait for the branches. Compare local text with the newest confirmed draft; an older query result must not replay its edits. Ending content retires that version, not its doc id: a pending move can keep the same doc and later gain new content.

Public `upsert_file_pending_update` returns `{ pendingUpdate, currentYjsLastSequenceId }` inside `_yay`. Commit, refresh, and no-change mutations return their exact saved result; a remaining structural doc has no content, and a deleted doc is null. Stale final writes refuse. The internal agent action keeps its null success result. The editor loads the returned state ids directly. `ConvexReactClient.query` may return cached content from before the write, so it cannot confirm that write. If the acknowledged branches cannot be read, or a reviewed write refuses because the proposal changed, keep both local texts for copying and stop writes until Review is reopened. Do not retry old full text or treat a cached null as fresh proof that the proposal ended. Normal input validation errors remain editable.

6. `FileNodeView` queries `list_files_pending_updates`, filters content-bearing docs into the diff queue, and passes that queue to `FileEditor`, which renders the floating banner and pager.
7. `Review changes` switches the `/files` route to `view=diff_editor`.
8. `FileEditorDiff` bootstraps from the pending update doc if present, otherwise from live file Yjs state. With collaboration off it loads only the proposal's branches.
9. In the diff editor, original side is `staged` and modified side is `unstaged`.
10. Local Monaco edits debounce back into `upsert_file_pending_update`.
11. `Accept all` copies unstaged content into staged content.
12. `Discard all` copies staged content into unstaged content.
13. `Save` flushes pending upserts, then calls `save_file_pending_update`.
14. `save_file_pending_update` writes only the `staged` diff into the live file Yjs stream through `files_db_yjs_push_update`. With collaboration off it dispatches to `action_save_file_pending_update_non_collaborative`, which commits the staged text as the file's new version instead.
15. The Yjs push records the transactional update immediately and enqueues the content materialization workpool to compact the latest Markdown/Yjs state, refresh the committed chunks (the read source for current content — editable files keep no current-content object in R2), write the Yjs snapshot to R2, and create a version snapshot.
16. The saved-sequence marker is upserted even when the live file already matched the staged branch and no new Yjs packet was inserted.
17. If `unstaged` now matches the saved live file state, the doc is deleted.
18. If unresolved edits remain, the doc stays alive with `base` and `staged` advanced to saved live content.
19. `Sync` rebases both branches on top of the latest live Yjs state through `persist_file_pending_update_rebased_state`.

Structural review follows a parallel path:

1. Agent-mode Bash `mv` uses a durable transfer run. A saved source gets `pendingMove`; its saved path does not change until Accept. Moving a private source updates its private parent and name. Its proposal, content states, and contributing chat threads follow that private identity. A forced file replacement supports every saved/private source and occupant pair. Replacing an owned private occupant retires it only after readiness, type, access, policy, and empty-folder checks. Its contributing threads join the surviving source proposal. If that private occupant already claimed a saved replacement, the source inherits the exact saved target and version. A saved occupant stays unchanged until archive and source publication commit together on Save. Discard, expiry, and moving away release the claim without changing the saved occupant.
2. Agent-mode app-to-app `cp` captures content through a durable transfer run. A new destination gets a private node and `createIntent`; replacing a saved destination stores `pendingReplacement` with its exact saved content version. Both keep `copiedFrom`. A text copy over saved text keeps the destination's collaboration mode. A new private copy or a text copy over stored content inherits the source's mode. No-clobber skips an occupied path. Copied text has pending search chunks; stored content does not. Accept preserves a saved destination's id, name, permissions, metadata, and history, then installs the captured content. Replacing collaborative text with stored content requires turning collaboration off in Properties first. A changed saved content version refuses Accept. Edits past the snapshot are saved as a version before replacement; an unreadable document refuses that step. Failed Accept uploads enter the deletion ledger while the captured copy remains pending. A later text write cannot overwrite a pending whole-file copy; the user must accept or discard it first.
3. Agent-mode Bash `rm` stores `pendingArchive` for saved nodes. Accept archives the reviewed node and descendants. Removing an owned private create discards it without creating a saved node. Normal flags still apply: folders need `-r`, and `-f` silences missing paths.
4. Bash and legacy file reads/listings/searches apply the proposing user's pending path overlay. A pending-deleted node reads as gone (a deleted folder hides its whole subtree). Other users continue to see the committed tree, and the sidebar file tree shows no delete indicator until accept. Bash `resolve` checks access by node ID and projects its saved path through a fresh overlay for that same user. It follows file and ancestor moves, hides pending deletes and replaced targets, and does not fall back to the saved path when projection returns null. A path URL first finds its saved node, so a pending path swap still follows the original file. The next reader applies the normal pending content view.
5. The Pending changes tab renders content-only, move-only, copy, content-plus-move, and delete rows. It applies moves through `apply_file_pending_move`, deletes through `apply_file_pending_archive`, saves content through the normal save path, discards structural state through `discard_file_pending_structural`, and discards content rows through `discard_file_pending_content`.

# Backend Responsibilities

Main module:

- `packages/app/convex/files_pending_updates.ts`

Public and internal functions, grouped by role:

- Staging pipeline: `create_file_pending_update_operation_batch` (+`_internal`), `stage_file_pending_update_state_page` (+`_internal`), `seal_file_pending_update_state` (+`_internal`), `stage_file_pending_update_text_input` (+`_internal`), `retire_file_pending_update_operation_batch`, `stage_trusted_yjs_update`
- Paged reads: `get_file_pending_update_state_page` (+`_internal`), `get_file_pending_update_text_input_internal`, `get_data_for_pending_content_operation`
- Upsert and rebase: `upsert_file_pending_update` (action), `upsert_file_pending_update_internal_action`, `commit_file_pending_update_upsert_in_db`, `persist_file_pending_update_rebased_state` (action), `prepare_file_pending_update_for_review` (action), `prepare_file_pending_update_for_agent` (internal action), `commit_file_pending_update_rebase_in_db`, `settle_file_pending_update_no_change_in_db`, `refresh_file_pending_update_in_db`
- Structural: `upsert_file_pending_move_in_db`, `upsert_file_pending_archive_in_db`, `apply_file_pending_move`, `apply_file_pending_archive`, `discard_file_pending_structural`, `discard_file_pending_content`
- Save: `save_file_pending_update` (action), `save_file_pending_update_in_db`, `save_file_pending_update_non_collaborative_in_db`
- Reads: `get_file_pending_update`, `get_file_pending_update_internal`, `get_by_file_node`, `list_files_pending_updates`, `get_pending_path_overlay_data`, `get_file_pending_update_last_sequence_saved`
- Cleanup: `remove_file_pending_update_if_expired`, `cleanup_expired_pending_state_rows` (15-minute cron)

Important behavior:

- Every large value moves through the staged pipeline; registered calls carry one page or one text plus ids and scalars. The order is: create a batch (ONE active 30-minute batch per user/node; a second create refuses with a visible "already in progress" `_nay` unless the existing batch is the same user's and idle past 2 minutes, which takes it over), stage pages (each checked non-empty and at most 930,000 bytes BEFORE insert, in order, at most 5 per state, with per-phase envelopes of 3 states and 12 MiB total), then seal each state.
- The seal is door 2 and the only step that may mark a state valid: it reassembles the pages, checks the whole state (non-empty, at most `files_MAX_YJS_RECONSTRUCTED_STATE_BYTES` = 4 MiB, v1 encoding), reconstructs the document and runs the per-`rootKind` shape rule (plain: parity plus empty root `_map`; rich: the share-name test; one branch, never both), checks the visible projection is at most 900,000 bytes, then records the FNV-1a digest and the current lineage generation.
- The final commit mutations take sealed state ids plus digests (and at most one bounded `unstagedText`), re-check the digests, and atomically swap the canonical ids on the pending update doc. The previous family is retired into a durable cleanup task instead of being deleted inline; a bounded continuation drains it. Commits never reload pages.
- Every refusal terminal retires the batch immediately (staging refusals, commit `_nay`s, and thrown commits), so a refused flow does not block the user for the batch TTL. The 15-minute sweeper (`cleanup_expired_pending_state_rows`) drains expired batches, text inputs, temporary states, trusted stages, and retired cleanup tasks; the TTL sweep must bound `by_owner_expiresAt` from below (`gte(0)`) because docs without the field sort before every number.
- Node `content.write` is enforced at batch creation and re-enforced at every commit that swaps sealed states canonical. Page staging, text-input staging, and the seal check batch ownership only — any future path that commits sealed states MUST re-check `content.write`.
- Upsert reconstructs existing branches or clones the saved base, applies the incoming unstaged text, and changes staged text only when supplied. When both branches match base, it removes saved content proposals while keeping a move or delete. Private creates keep their sealed branches, including empty text.
- The base reconstruction reads the materialization header plus one update row per query call. A walk that ends before the frozen target sequence (covered-row cleanup deleted rows mid-walk) is treated as stale and refused with `Failed to load file state` instead of returning a partial base labeled complete — a partial base would let Accept commit duplicated content.
- Content Accept, draft persistence, Sync, and Save can pass `reviewedUpdatedAt`. The diff editor and sidebar pass the version they loaded. Each flow refuses a changed proposal; final `expectedUpdatedAt` checks also catch changes during the action. Agent flows omit the reviewed timestamp and use the prepared base state id for read-dependent edits.
- The agent pending read treats a Yjs content base whose `lineageGeneration` differs from the node's current generation as no pending content, so ordinary reads use committed text. The next agent write prepares the retained family before reading fresh text. An operator Yjs repair bumps the lineage, which makes old proposals stale.
- Rebase persistence rejects stale live bases and only accepts rebased state built from the current live file snapshot.
- Rebase persistence is update-only and patches only the exact doc id the client synced. When that doc was discarded, fully accepted, or replaced by a newer proposal while the sync was in flight, it returns a benign `Not found` and never recreates or overwrites anything.
- Two more rebase guards. A sync whose captured base is older than the doc's current base returns a benign `Stale save` (a tab that saved meanwhile wins). A sync against a doc that degraded to move-only returns `Not found` (in-flight syncs cannot resurrect reverted content).
- Structural Accept and Discard name the exact tagged target, proposal ID, and reviewed revision. A changed proposal refuses. Removing one structural part keeps the same proposal when other pending parts remain.
- Connected moves, folder cycles, content, and replacement occupants must appear in the explicit server review selection. Accepting one member never silently selects another member. The connected unit applies all selected changes in one bounded transaction.
- Folder Move replaces only an empty folder. Bash requires the explicit `mv -T -f` form. Active saved children, private children, and the owner's pending moves into that folder count as contents. The final Save checks again, so a late saved child keeps its folder. A file never replaces a folder, and a folder never replaces a file. Move never merges nonempty folders.
- A replacement pins the saved occupant ID and content version at proposal time. A later occupant or changed version requires a new review; Save never adopts either automatically. The occupant's own pending changes must be selected too, even when another chat contributed them.
- The only stale literal the client treats as benign is `Stale save` (plus `Not found` on in-flight syncs); both come from multi-second ACTIONS, not from panel clicks.
- One documented cross-tab edge (accepted editing model): an OPEN diff editor owns a live local draft, and a dead doc id with no replacement doc deliberately falls through to the create path — so a diff tab left open on a file can recreate a proposal that was discarded in another tab. The recreated content is pending only (never committed or billed) and shows up in the panel like any proposal. Making Discard authoritative across tabs would need a separate draft-cancellation design.
- Every proposal edit refreshes the 4-hour expiry, including identical-content upsert and sync. An identical rewrite still bumps `updatedAt`, reschedules cleanup, and records new structural intent. Toggle and restore marking leave the timestamp and expiry task unchanged. Successful preparation refreshes them normally.
- Collaborative Save merges both branches against current text with the shared line rule, builds them on current history, and publishes only staged text. It writes the saved-sequence marker, enqueues R2 materialization, and keeps unresolved unstaged work on partial save. It does not replay old branch delete sets onto current content. A branch may contain another Yjs root accepted by the state seal; Save projects only the file's own text shape.
- Save guards the target node before any write: a missing, out-of-scope, or non-file target returns `Not found` and the doc survives. An archived target still saves: the archive only hides the node, its content stays writable, and unarchiving later shows the saved text. The sidebar marks those rows `· Archived`.
- A save whose action-read base sequence no longer matches the file's CURRENT committed last sequence returns `Stale save` before any write or billing. This one check covers two races: a second tab replaying an old save (no double billing), and another user committing between the action's read and the mutation (the doc's new base can never silently hide that commit).
- A replace-move Accept archives the reviewed saved occupant and moves or publishes the source into its place. A saved source keeps its saved ID, type, and history; a private source keeps its private identity until it receives its one saved receipt. A partial private Save clears the replacement claim and keeps unresolved content on the same proposal, now targeting the saved source. It does not merge the occupant's content.
- `apply_file_pending_archive` re-validates at accept time: a missing doc or one without `pendingArchive` no-ops; a missing/out-of-scope/already-archived node just drops the doc. A folder computes its subtree by following stored `parentId` links at accept time (nodes added after the proposal are archived too, while an archived tree that reuses the path stays separate) and everything gets ONE `archiveOperationId`, so Unarchive restores the delete as one unit. The acting user's docs on all archived nodes are removed; other users' docs stay, and a content accept still saves onto the archived node. Accepting a delete never runs the mv‑f replace-source chain.
- Save on a doc with `pendingArchive` is rejected with `File has a pending delete` (discard the delete first). Discarding a delete only clears `pendingArchive`: a doc that still has content or copy provenance survives as a content row; a delete-only doc is removed.
- Keep each public endpoint's current auth, membership, and rate-limit order. Do not infer one shared order: content upsert validates membership before its rate limit, while structural accept/discard and save perform the rate-limit check earlier.
- Saves that push a live Yjs diff must pass the billing credit gate and emit one `file_save` usage event. The billing event name is intentionally unchanged for now to avoid a separate billing taxonomy migration.
- Content-bearing doc lifecycle paths maintain pending `files_text_chunks`, pending `files_plain_text_chunks`, and pending `files_metadata_docs` in the same mutation. Chunking dispatches on the node's `textKind`: the Markdown chunker for `rich_text`, the byte-exact plain-text chunker for `plain_text`. YAML frontmatter is extracted and indexed for `rich_text` only. Replacing the `unstaged` text rebuilds those docs; a staged-only change reuses them. Doc deletion removes them. Structural-only docs own no pending indexed docs. If content collapses while `pendingMove` or `pendingArchive` remains, remove the pending indexed docs and retain the structural doc.
- Committed materialization writes committed `files_text_chunks`, committed `files_plain_text_chunks`, and committed metadata docs; committed replacement deletes the old committed exact-text chunks, plain-text search chunks, and metadata docs for that file before inserting new docs.
- If committed chunk replacement fails, the materialization finalizer throws so Convex rolls back the node, snapshot, update, job, and chunk writes together. Returning `_nay` from that branch would commit a partial materialization.
- Rename, move, archive, and unarchive patch denormalized `path` and `archiveOperationId` on `files_plain_text_chunks`, and `path`, `treePath`, and `archiveOperationId` on `files_metadata_docs`, so full-text and metadata search can filter scope before native pagination.
- Pending update doc writes also store `size` from the same current `unstaged` text whenever the unstaged branch is created or replaced. Staged-only changes preserve the existing size.
- A chunking failure never fails the pending update doc write: the stale pending Markdown/plain-text chunk docs are already deleted, the failure is logged, and search just misses that file until the next upsert (its committed chunks stay hidden for that user).

# Client Responsibilities

`packages/app/src/components/files/file-editor/file-editor.tsx` owns:

- floating banner for "Pending changes"
- `Review changes` CTA
- previous/next pager across content-bearing pending files for the current user

`packages/app/src/components/files/file-editor/file-editor-diff/file-editor-diff.tsx` owns:

- bootstrapping from pending update doc or live file state
- Monaco diff editor state
- debounced pending update doc upserts
- per-hunk accept/discard widgets
- `Save`
- `Sync`
- `Accept all`
- `Accept all + save`
- `Discard all`

`packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx` owns:

- the Pending changes tab content
- the source selector: `All changes`, `Your edits`, and every persisted agent chat referenced by a pending doc. `Your edits` means docs with no `threadIds`; zero-count sources are hidden. Thread options and stored-file contributor links use `files_pending_updates.get_pending_source_summary`. It checks the destination membership, chat creator, and current source membership plus `content.read`. It returns only the title, dates, archive flag, and real source organization/workspace route. Archived chats remain readable. An unavailable source shows no title or route, but stays selectable while it contributes to loaded proposals. Human review needs only destination access, not the old source chat
- source filtering after the full pending-row model is built. A doc with multiple `threadIds` appears with its same combined pending content under every linked chat, and source counts can overlap. The UI never tries to split one doc's changes by chat
- bulk Accept/Discard over only the rows shown by the selected source. The client has no hidden-row guard. The review run finds hidden rows the action would settle or invalidate through its dependency graph (see "Planning and later checks use the same dependency graph" above), for example a folder delete with a hidden descendant edit. It returns `needs_review` with `This action also affects unselected changes. Review them together.` and writes nothing. The result dialog then lists the blocked row, and its `Review remaining changes` link (and each row's `Review <path>` link) switches the selector back to `All changes`. If a selected chat stops contributing, the selector returns to `All changes`; a zero-row source disables both bulk actions
- content-only, move-only, copy, content-plus-move, and delete row rendering; the "Deleted" caption wins over every other caption
- editable Markdown delete rows prefetch committed Markdown and expand to an inline fully-removed diff; binary and folder delete rows are plain rows without a disclosure control
- binary structural replacements query both asset sizes while the row is mounted, then expand to removed and added size lines or `Size unchanged`
- delete and binary-replacement links open the file, never the diff editor
- per-row Accept/Discard actions. A row Accept that would affect a hidden source gets the same server `needs_review` refusal and the same way back to `All changes`. Accept is enabled only after the node's current write query returns true; Discard stays available for a readable own draft after write access is removed
- bulk Accept is enabled only when every shown row can be accepted: a saved row's node write query returns true, and a draft row is ready with `canAcceptWithParents`. The backend still checks destination, replacement, and subtree permissions that one source-node query cannot prove
- move-before-content ordering for content-plus-move row acceptance; the content publish re-reads the doc after the move settle bumps `updatedAt`, and the row caption compounds (`Modified · Moved`)
- delete rows run as their own trailing bulk phase (accepting a folder delete first would archive descendants and fail sibling accepts)
- private create discard without deleting saved files
- a folder draft that holds a draft is never listed, so it is neither drawn nor counted. A hidden folder goes with the drafts inside it. `Accept all` sends each shown draft's `requiredParents` first, like row Accept. `Discard all` sends the shown drafts' `requiredParents` first, except a parent that another loaded draft needs or whose `threadIds` do not match the current source. So a chat-scoped Discard all keeps a folder that holds another chat's draft; the server would refuse to discard it. A folder of another source in the middle of a draft's parent chain keeps every folder above it too. A draft on a page that is not loaded yet is unknown to the client, and the server then returns `needs_review`. Restricted views carry no `requiredParents`, so a hidden restricted folder is never sent; it shows again as its own `Draft unavailable` row after its drafts are discarded
- a draft row's Accept sends its `requiredParents` first, root-first, then the draft. It is enabled when the draft is ready and `canAcceptWithParents` is true. The row looks like any new file: its caption is `Added file`, and only the row link's tooltip and accessible name add `, also adds <paths>`. Row Discard sends only the draft
- every readable row, including a new folder and a stored draft, uses `FileEditorSidebarPendingItem` with inline Accept and Discard. A new folder shows `Added folder` and has nothing to open. A ready stored draft (a screenshot, an image, or other bytes) opens to show its file details: an image preview for safe images, type and size, creator, source chats, and Download. A preparing draft shows `Preparing…` in the same `<details>` row, with no chevron, and cannot open. It keeps the same row when it becomes ready, so keyboard focus on its link or buttons is not lost

`FileNodeViewPrivateActions` uses
`files_build_private_review_selection` in `src/lib/files.ts`. It sends the exact
proposal revisions shown in the UI. Save selects required parents in root-first
order, followed by the file. Discard selects only the file. Both locations use
`AppActivitiesProvider.startReview`, even when no parent is pending. The Activity
dialog shows progress and keeps failures visible. The detail view follows the
published target through its normal live Files query.

The helper sends a null `selectedContentStateId` for every item. That is right only
for stored files and folders, which have no `content`: the review run refuses an
accept item with `content` and a null state id. So `FileNodeViewPrivateActions`
shows its Save only when `createIntent.kind !== "text"`. Saving a folder from its
own view creates only that folder and its pending parents; its child drafts stay
pending.

A private text draft saves through its editor's own Save
(`files_save_private_file_pending_text`). After the upsert, it reads
`get_file_pending_target` once. Without pending parents, it calls the direct
`save_file_pending_update`. With pending parents and `canAcceptWithParents`, it
starts one review run: the parents first with a null state id, then the file with
its new `stagedStateId`. When `canAcceptWithParents` is false (a parent is still
preparing, or the user may not save), the parent list is not complete, so it calls
the direct save and shows that refusal instead.
The editor then stays on the draft, and the detail view follows the saved file
when the run ends. The direct save stays strict: it still refuses a draft whose
parent folder is pending (`Review and save the parent draft first`).

Images preview only inside Files. Other binary types show file details and
Download. Preparing files cannot preview, download, or be accepted; owner Discard stays
available. Removing the focused row or action returns focus to its panel. Signed
private image URLs stay local to the preview component and are never shared in a
cache or chat result.

`packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx` owns:

- the pending-changes strip above the Agent-tab chat composer (rendered through `AiChatThread`'s `composerTopSlot`): one row per destination, hidden at 0, never dismissable. With a persisted `threadId`, `get_chat_pending_updates_summary` counts this creator's contributing proposals separately in the current workspace and their own personal/home. It resolves home from the user's saved default pointers and collapses matching roots. Each root scans at most 500 proposals plus one extra doc to detect overflow; incomplete counts show `+`. It checks current chat read access and each destination's access. New and optimistic chats skip the query. Without the prop, the strip keeps the user's current-workspace count
- the amber count badge inside the "Pending changes" sidebar tab label, hidden at 0 (always the workspace-wide count)
- both the strip and the badge count only what the Pending list draws: they skip a folder draft that holds a draft (`db_pending_update_is_listed` above)
- chat rows link to the destination's existing Files route and select Pending changes through `app_state::files_last_tab`. The workspace-wide strip only switches the current sidebar tab. The badge is display-only. No combined Files view or cross-workspace bulk Save is added
- below a 320px chat-container width, each strip wraps its label above the count and Review action so the destination stays readable. Wider strips keep the compact 42px row
- the shared `FILE_EDITOR_SIDEBAR_TAB_ID_PENDING` constant (moved here so the sidebar tabs, the strip, and the agent panel import it without a cycle)

# Write Policies

Current file policy protects both proposal creation and proposal commit. Ordinary app, agent, and
Bash proposals use the human actor as writer. Selecting that user does not grant file access.
Only destination, occupant, and immediate-parent checks apply. The full contract lives in
`../files-read-only/SKILL.md`.

- New content checks the destination folder. Move checks the named item and its immediate parent.
  Replace, archive, and delete still check every removed or replaced item. Copy may read a locked
  source, but its destination and replacement occupant must be writable.
- Proposal creation, rebase, Save, and Accept check ACL and policy before their action work. The final
  mutation checks current policy again before its first write. It checks the destination,
  replacement occupant, and the occupant a replace-move archives.
- A proposal created before a policy change stays visible. Accept and Save refuse while any affected
  node refuses the human writer. They may finish when every affected node permits the writer again.
  There is no policy history counter. UI controls use actual `canWrite`, not policy presence.
- A replace flow also stores the ordered source node ids. This is not policy history. It stops Accept
  from changing different files from the ones the user reviewed.
- Whole-proposal Discard and Discard all stay available. They delete only the caller's pending docs.
  Diff hunk discard and editor-level discard that rewrite the pending Yjs model remain blocked.
- Private Discard retires only the owner's approved private nodes and proposals. Saved files and folders stay intact.

# Cleanup And Expiry Model

- Private cleanup hands captured assets to durable exact-key deletion jobs before removing their records. Physical storage reservations remain until deletion is confirmed.

- Every edit that leaves a pending update doc alive refreshes its four-hour cleanup task. This includes content upserts, move upserts, rebases, preparation, partial saves, and structural accept/discard paths that preserve part of a content-plus-move doc. Toggle and restore marking leave the existing deadline unchanged.
- If an operation deletes or fully resolves the doc, it removes the cleanup task instead.
- A new presence session reschedules cleanup for four hours from that session without changing the doc's `updatedAt`. Disconnect does not shorten the lifetime, so unreviewed proposals survive the user closing the app.
- Every scheduled cleanup carries `expectedUpdatedAt`; stale scheduled work cannot delete a newer doc.
- Expiry removes saved-target proposals, pending indexes, and cleanup tasks without deleting their saved targets.
- Private expiry uses the lifetime rules above. Missing folders created with an agent file are private nodes, each with its own proposal and expiry. Live descendants keep their private ancestors alive.

# Architectural Invariants

- Pending updates are per-user docs keyed by organization, workspace, user, and tagged target.
- A saved content-only doc normally exists while staged or unstaged differs from base. Private creates and structural proposals may persist when content branches match.
- Preparation, Sync, and Save merge text with `files_pending_text_merge`, then build base → staged → unstaged on current history. State-vector diffs publish only this rebuilt family. Never diff an independent fresh `Y.Doc` against live state: Yjs compares structs and client clocks, not visible text, so that can duplicate content.
- Use the shape-aware dispatchers (`files_yjs_doc_get_text` / `files_yjs_doc_update_from_text`). Read retained branches with `contentRebaseRootKind` when set, then write in the current node shape. ProseMirror-specific work belongs inside the rich-text dispatcher.
- AI reads use the current user's pending `unstaged` branch when it is current. Marked proposals and ordinary stale asset proposals leave committed text visible instead.
- Only content-bearing docs own pending exact-text chunks, plain-text search chunks, and metadata docs. Content insert, `unstaged` text replacement, deletion, save, and expiry keep those docs in sync with the pending update doc; staged-only changes reuse them.
- Bash `search` (`text_search_files`) uses one Convex full-text search query against `files_plain_text_chunks` with Convex native cursor pagination, and renders directly from those docs without hydrating linked exact-text chunks. It filters pending chunks to the acting user, filters out other users' pending chunks, and hides committed chunks for files that user has a live (not stale) proposal on. A marked proposal or an ordinary stale asset proposal is skipped: its pending chunks are hidden and the committed chunks show. Pending-first ordering is not an invariant.
- Bash `meta search` uses one Convex indexed query against `files_metadata_docs` per command. It filters pending metadata to the acting user, filters out other users' pending metadata, and hides committed metadata for files that user has a live (not stale) proposal on. Multi-predicate AND/OR is intentionally outside the command and should be composed by shell tools over path output.
- Metadata search hides committed metadata only for docs that carry pending chunks (`files_pending_update_has_pending_chunks`) and are not stale, the same rule full-text search uses. A move-only doc or a stale doc does not mask the file's committed metadata.
- `Review changes` must switch into diff mode.
- In the diff editor, `Accept all` only copies unstaged content into staged content; it does not save by itself. In the Pending changes tab, bulk Accept applies or saves every row shown by the selected source, with the pending folders those rows need.
- In the diff editor, `Discard all` copies staged content into unstaged content without a special clear mutation. The Pending changes tab uses backend discard mutations for its rows. Its content mutation copies staged into unstaged and may waive only a missing `content.write` permission for the caller's exact existing doc; it never weakens general pending upserts.
- `Save` can partially resolve a pending update and keep the unresolved branch alive.
- `Sync` must rebase on top of the latest live file state before persisting.
- Stale rebases must be rejected.
- Live rich-text Yjs sync must serialize outgoing local update batches and retain/retry failed batches ahead of newer edits.

# Verification Checklist

- Toggle and restore both ways with plain-text and Markdown proposals. Keep all owners' proposal ids, state ids, source shape, and expiry until preparation replaces the family.
- Verify partial acceptance, a separate live edit, and another save. Assert exact text without lost or duplicated edits.
- Verify accepted `150` wins over saved `120` and `200`, proposed `170` stays separate, and unrelated saved edits survive. Cover real shared-history section moves and deletes, including paragraph breaks.
- Verify late action results, locks, multiple owners, and mode changes while review stays open. A failed preparation keeps the old proposal readable; an old reviewed timestamp cannot Save a newer proposal.
- Verify marked content is hidden from ordinary reads and searches. The next agent edit or append prepares and recomputes without opening Review; a raced write recomputes once. Direct stale upsert still refuses. Bulk Accept skips unprepared content; pending deletes still work.
- Trigger an AI proposal and confirm the floating pending banner appears.
- Confirm `Review changes` enters diff mode for the current file.
- Confirm previous/next navigation can move across the pending queue.
- In diff mode, verify per-hunk accept/discard updates the correct side.
- `Accept all` should stage everything without saving.
- `Discard all` should revert unstaged content back to staged content.
- `Save` should persist only the staged branch and keep the pending update doc if unresolved unstaged content remains.
- `Accept all + save` should clear the pending update doc when no unresolved changes remain.
- `Sync` should preserve local intent while rebasing on newer live file state.
- Verify the Pending changes tab renders and sorts content-only, move-only, copy, content-plus-move, and delete rows.
- Verify the source selector shows All changes, threadless Your edits, archived chats, and contributing chats newest first. A shared pending doc should appear as the same complete row under every linked chat.
- Verify a home proposal links to its chat's real team route. Another creator and an organization owner receive no chat details. Leave or source deletion hides the source title and link without blocking destination review. Verify current/home strip counts, separate Pending links, same-home deduplication, and `+` for capped counts.
- Verify an added folder with a draft inside shows only the draft row, captioned `Added file` with `also adds <folder>` in its link name, and that the tab badge, source counts, and chat strip agree. Accepting the draft (row Accept or editor Save) also saves the folder. Discarding the draft keeps the folder, which then shows as its own row. Saving the folder alone creates an empty folder and keeps the draft pending.
- Verify source-scoped bulk actions touch only shown rows and the hidden folders that hold them. Empty sources, including Your edits, disappear; a selected source falls back to All changes after its last row settles.
- Verify source-scoped accept (row and bulk) never settles hidden move-chain/cycle members, hidden folder descendants, hidden replacement occupants, or hidden archive-source rows: the run ends `needs_review`, every row and saved node stays unchanged, and `Review remaining changes` switches the selector to All changes.
- Verify editable Markdown delete rows start fetching committed content before expansion and render it as fully removed.
- Verify binary and folder delete rows have no disclosure control and do not fetch committed Markdown.
- Verify binary replacements prefetch both asset sizes and show removed and added size lines, or `Size unchanged` when the sizes match.
- Verify bash `rm` hides the path from the proposer's reads, accept archives (folder cascade, one operation id), and discard restores visibility without touching the node.
- Verify pure moves do not enter the diff pager.
- Verify accept/discard applies pending paths, archive behavior, content, and move-before-save ordering for content-plus-move rows.
- Verify private discard and expiry leave saved files intact.
- Verify the proposing user sees the pending structural path overlay while another user sees the committed tree.
