---
name: files-agent-pending-updates
description: Current `/files` pending-changes system: per-user Yjs content branches plus structural move, copy, replace, delete, and eager-create proposals; diff review; accept, discard, save, and sync; AI and Bash file-tool overlays; indexed pending content; and TTL cleanup. Use when changing pending banners or tabs, bash shell write/edit_file/cp/mv/rm proposals, pending path or content reads, search overlays, review actions, rebase/save behavior, or expiry.
---

# Content And Structural Proposal States

Each `files_pending_updates` doc — the pending update doc — belongs to one user and one file node. It may contain a content proposal, a structural proposal, or both.

Pending updates work for both document shapes: a Markdown file's `rich_text` (ProseMirror) Yjs document and every other editable text file's `plain_text` (`Y.Text`) document. The node's `yjsRootKind` decides the shape everywhere (see the `files-editable-text` skill). Branch handling is string-level: the same three-branch model, the same rebase, the same diff review.

A content proposal sets the five canonical content fields together and tracks three states:

- `base`: the live file state the pending update was built from.
- `staged`: the branch that save will persist.
- `unstaged`: the unresolved/proposed branch shown on the modified side of the diff editor.

That separation enables per-hunk accept/discard, `Accept all` without saving, partial saves that keep unresolved edits pending, and sync/rebase against newer live file state.

Structural state uses:

- `pendingMove` for move or rename intent.
- `copiedFrom` for copy or replace provenance.
- `pendingArchive` for delete intent (bash `rm`): accepting archives the node; a folder archives its whole subtree, computed at accept time. Setting it clears `pendingMove` — a delete supersedes a move. Content branches survive on the doc (accept ignores them; discard restores them as a Modified row).
- `eagerCreated` when `edit_file`, a bash shell write, or `cp` eagerly created a destination node so discard or expiry can remove it safely. `rm` on such a doc cancels it immediately when the hard-delete gate passes, like Discard — no proposal remains; when the gate fails, `rm` falls back to a normal pending delete proposal.

Move-only docs have no Yjs fields and use `size: 0`. Docs do not always disappear when the three content states match: eager-created docs, replace-move docs, and content-plus-move docs (`content_and_move` in code) may still need structural review.

# Data Model

Main table in `packages/app/convex/schema.ts`:

- `files_pending_updates`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `fileNodeId`
  - optional canonical content group, always set together:
    - `baseYjsSequence`
    - `baseLineageGeneration` (the live document lineage this proposal was built against)
    - `baseStateId` / `stagedStateId` / `unstagedStateId`, each pointing at one sealed `files_pending_update_yjs_states` doc whose pages hold that branch's full Yjs state. Branch bytes never live on the pending update doc itself.
  - optional `pendingMove`
  - optional `copiedFrom`
  - optional `pendingArchive` (`fromPath` display metadata only; the node id is authoritative)
  - optional `eagerCreated`
  - optional `threadIds` (contributor set: the chat threads that touched this doc, deduped; agent writes append their thread id, client-driven writes leave the field out of their patches so it survives, and it dies with the doc; unset for client-only docs and rows older than the field)
  - `size` (UTF-8 byte size of the current `unstaged` text, or `0` for a structural-only doc)
  - `updatedAt`

Paged pending-state storage (`packages/app/convex/schema.ts`; shared helpers in `packages/app/server/files.ts`):

- `files_pending_update_yjs_states` — metadata for one branch state (one role: `base`, `staged`, or `unstaged`). A full Yjs state can be larger than one Convex value, so it never travels or stores as a single value. The `owner` union says who deletes the family: `active` states belong to a pending update doc, `temporary` states to an operation batch (expiry-swept), `retired` states to a durable cleanup task. Each state records `lineageGeneration`, `sealed`, `pageCount`, `totalBytes`, and `digest`.
- `files_pending_update_yjs_state_pages` — the bytes, in non-empty pages of at most `files_MAX_YJS_WIRE_BYTES` (930,000 bytes), contiguous by `pageIndex` from 0. A state holds at most 5 pages, which covers the 4 MiB state cap.
- `files_pending_update_state_cleanup_tasks` — durable cleanup task for a retired family. A commit re-owns the previous states to a task doc instead of deleting pages inline; a bounded scheduled continuation drains pages, states, then the task.
- `files_pending_update_operation_batches` — one in-flight upsert or rebase per user and file. One active batch per user/node; a batch expires after 30 minutes, and a new create by the SAME user takes over a batch idle past 2 minutes (`lastActivityAt`, refreshed by page staging, text-input staging, and the seal), so a crashed client does not lock the user out.
- `files_pending_update_text_inputs` — one staged text value (role `staged` or `unstaged`) per batch, so no registered call carries two large values at once.
- `files_yjs_trusted_update_stages` — one server-built Yjs update staged ahead of its commit (pending accept, public fill, snapshot restore), so the commit call carries only ids and one bounded text. 30-minute TTL.

The digest is two FNV-1a 32-bit passes joined as hex (`files_pending_update_yjs_state_digest` in `packages/app/server/files.ts`). It is not cryptographic; it only detects a torn or mixed page family when a state is reassembled.

Unified exact text chunk table:

- `files_text_chunks`
  - `organizationId`
  - `workspaceId`
  - `fileNodeId`
  - `sourceKind: "committed" | "pending"`
  - optional `userId` for pending docs
  - optional `pendingUpdateId` for pending docs
  - optional `yjsSequence` for committed docs
  - `chunkIndex`
  - `textChunk`
  - `startIndex` / `endIndex` / `lineStart` / `lineEnd` / `chunkFlags`
  - committed yjs-sequence indexes and pending-update indexes for exact reads and regex scans

Unified full-text search table:

- `files_plain_text_chunks`
  - `organizationId`
  - `workspaceId`
  - `fileNodeId`
  - `sourceKind: "committed" | "pending"`
  - optional `userId` for pending docs
  - optional `pendingUpdateId` for pending docs
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
  - `fileNodeId`
  - `sourceKind: "committed" | "pending"`
  - optional `userId` for pending docs
  - optional `pendingUpdateId` for pending docs
  - optional `yjsSequence` for committed docs
  - denormalized `path`
  - denormalized `treePath`
  - optional `archiveOperationId`
  - `qualifiedField`, currently `frontmatter.*`
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

Pending updates attach to editable text `files_nodes` docs — nodes with Yjs state, in either shape.

- Editable Markdown files (`rich_text`) and plain-text files such as `.json` or `.yaml` (`plain_text`) participate directly in pending review/edit flows.
- Plugin-generated Markdown outputs are ordinary files, so they can participate in pending review/edit flows after the plugin creates them.
- Raw uploaded source file nodes without Yjs ids (stored blobs) do not directly participate in pending content edits today.
- A text file with collaboration turned off has no Yjs document either, so it has no content branch and never shows a diff row. The agent still edits it: the write is saved right away instead (see step 3 below). A move or delete proposal on such a file works normally, because those docs carry no branches.
- Uploaded source paths do not alias to generated outputs; pending edits attach to the exact file node being edited.
- Move-only and delete-only docs can represent folders and non-content file nodes. Those docs do not carry Yjs branches.

# End-To-End Flow

1. AI tools in `packages/app/server/server-ai-tools.ts` translate visible paths to committed paths through the current user's pending structural overlay, then read file content through `internal.files_nodes_content.get_file_last_available_text_content_by_path`, an internal action that can fetch committed Markdown from R2. `edit_file.pendingUpdateId` is only a model-provided lookup hint. The tool normalizes it through Convex and treats an invalid value as absent, so the user-and-file lookup can still find the current pending update.
2. That read path overlays the current user's pending `unstaged` branch when content exists. Pending destinations are visible, vacated or replaced paths are hidden, and descendants follow a pending folder move.
3. `edit_file` and Agent-mode bash shell writes (`bash_DbFilesFs.writeFile`/`appendFile` in `packages/app/server/bash-utils.ts`, reached by `>`/`>>` redirects, heredocs, `tee`, and `touch` on a new path — `touch` on an existing app file is a no-op) go through `files_agent_write_file_text` in `bash-utils.ts`: create an operation batch, stage the one proposed text, then call the ids-only `internal.files_pending_updates.upsert_file_pending_update_internal_action`. Every staged text crosses `db_stage_operation_batch_text_input`, which drops one leading BOM and normalizes CRLF and lone CR to LF (`files_normalize_text_document_input`) before the byte count, so the branch document, the pending chunks, and the stored size all see the same string. A staging refusal retires the batch first so the user is not locked out.
4. Agent calls stage no `staged` text, so the backend preserves the current `staged` branch and updates only `unstaged`.
5. `files_pending_updates` creates or updates a doc for `(organizationId, workspaceId, userId, fileNodeId)`. A missing `edit_file` or bash shell write target may be eagerly created and recorded with `eagerCreated`.

**Files with collaboration turned off skip all of this.** They have no Yjs document, so there is no branch to build and nothing to review. `files_agent_write_file_text` takes a `nonCollaborativeBaseAssetId`, and when the read step above reports one, it calls `internal.files_nodes_content.replace_file_content_internal_action` instead: the text the agent wrote is saved straight away. The tools say so in their output, so the model does not tell the user to review a proposal that does not exist — `edit_file` ends with "Collaboration is off for this file, so the change is already saved and there is nothing to review", `cp` prints `copied: <source> -> <dest> — collaboration is off for the destination, so the new content is already saved`, and a redirect/`tee` write adds `bash: saved '<path>' immediately because collaboration is off; there is no pending change to review.` The save door runs the same ACL `content.write` check and the same read-only lock check the proposal path runs, so nothing is looser. Two consequences worth knowing: a direct save keeps the exact bytes the shell wrote, while the collaborative path renders the pending Markdown document and so appends Markdown's trailing newline; and `mv -f` needs a Yjs document on the TARGET only, because the proposal lives there — the source just has to be readable text, so a non-collaborative source still proposes onto a collaborative target. A non-collaborative TARGET is refused because a structural move would archive the target and reverse which file survives. See the `files-editable-text` skill for the mode itself.
6. `FileNodeView` queries `list_files_pending_updates`, filters content-bearing docs into the diff queue, and passes that queue to `FileEditor`, which renders the floating banner and pager.
7. `Review changes` switches the `/files` route to `view=diff_editor`.
8. `FileEditorDiff` bootstraps from the pending update doc if present, otherwise from live file Yjs state.
9. In the diff editor, original side is `staged` and modified side is `unstaged`.
10. Local Monaco edits debounce back into `upsert_file_pending_update`.
11. `Accept all` copies unstaged content into staged content.
12. `Discard all` copies staged content into unstaged content.
13. `Save` flushes pending upserts, then calls `save_file_pending_update`.
14. `save_file_pending_update` writes only the `staged` diff into the live file Yjs stream through `files_db_yjs_push_update`.
15. The Yjs push records the transactional update immediately and enqueues the content materialization workpool to compact the latest Markdown/Yjs state, refresh the committed chunks (the read source for current content — editable files keep no current-content object in R2), write the Yjs snapshot to R2, and create a version snapshot.
16. The saved-sequence marker is upserted even when the live file already matched the staged branch and no new Yjs packet was inserted.
17. If `unstaged` now matches the saved live file state, the doc is deleted.
18. If unresolved edits remain, the doc stays alive with `base` and `staged` advanced to saved live content.
19. `Sync` rebases both branches on top of the latest live Yjs state through `persist_file_pending_update_rebased_state`.

Structural review follows a parallel path:

1. Agent-mode Bash `mv` stores `pendingMove` instead of moving the committed node immediately.
2. Agent-mode app-to-app `cp` and replace-moves may create or update a doc with `copiedFrom`, `eagerCreated`, or both. `cp -n` and `cp --no-clobber` create no pending replacement when the final destination already exists, including when it appears during eager creation.
3. Agent-mode Bash `rm` stores `pendingArchive` (per operand, builtin flag semantics: `-r` for folders, `-f` silences missing paths, folder without `-r` fails with `Is a directory`). Accepting archives; nothing is ever hard-deleted except the own-Added-file cancel path.
4. Bash and legacy file reads/listings/searches apply the proposing user's pending path overlay. A pending-deleted node reads as gone (a deleted folder hides its whole subtree). Other users continue to see the committed tree, and the sidebar file tree shows no delete indicator until accept.
5. The Pending changes tab renders content-only, move-only, copy, content-plus-move, and delete rows. It applies moves through `apply_file_pending_move`, deletes through `apply_file_pending_archive`, saves content through the normal save path, discards structural state through `discard_file_pending_structural`, and discards content rows through `discard_file_pending_content`.

# Backend Responsibilities

Main module:

- `packages/app/convex/files_pending_updates.ts`

Public and internal functions, grouped by role:

- Staging pipeline: `create_file_pending_update_operation_batch` (+`_internal`), `stage_file_pending_update_state_page` (+`_internal`), `seal_file_pending_update_state` (+`_internal`), `stage_file_pending_update_text_input` (+`_internal`), `retire_file_pending_update_operation_batch`, `stage_trusted_yjs_update`
- Paged reads: `get_file_pending_update_state_page` (+`_internal`), `get_file_pending_update_text_input_internal`, `get_data_for_pending_content_operation`
- Upsert and rebase: `upsert_file_pending_update` (action), `upsert_file_pending_update_internal_action`, `commit_file_pending_update_upsert_in_db`, `persist_file_pending_update_rebased_state` (action), `commit_file_pending_update_rebase_in_db`, `settle_file_pending_update_no_change_in_db`, `refresh_file_pending_update_in_db`
- Structural: `upsert_file_pending_move_in_db`, `upsert_file_pending_archive_in_db`, `apply_file_pending_move`, `apply_file_pending_archive`, `discard_file_pending_structural`, `discard_file_pending_content`
- Save: `save_file_pending_update` (action), `save_file_pending_update_in_db`
- Reads: `get_file_pending_update`, `get_file_pending_update_internal`, `get_by_file_node`, `list_files_pending_updates`, `get_pending_path_overlay_data`, `get_file_pending_update_last_sequence_saved`
- Cleanup: `remove_file_pending_update_if_expired`, `cleanup_expired_pending_state_rows` (15-minute cron)

Important behavior:

- Every large value moves through the staged pipeline; registered calls carry one page or one text plus ids and scalars. The order is: create a batch (ONE active 30-minute batch per user/node; a second create refuses with a visible "already in progress" `_nay` unless the existing batch is the same user's and idle past 2 minutes, which takes it over), stage pages (each checked non-empty and at most 930,000 bytes BEFORE insert, in order, at most 5 per state, with per-phase envelopes of 3 states and 12 MiB total), then seal each state.
- The seal is door 2 and the only step that may mark a state valid: it reassembles the pages, checks the whole state (non-empty, at most `files_MAX_YJS_RECONSTRUCTED_STATE_BYTES` = 4 MiB, v1 encoding), reconstructs the document and runs the per-`rootKind` shape rule (plain: parity plus empty root `_map`; rich: the share-name test; one branch, never both), checks the visible projection is at most 900,000 bytes, then records the FNV-1a digest and the current lineage generation.
- The final commit mutations take sealed state ids plus digests (and at most one bounded `unstagedText`), re-check the digests, and atomically swap the canonical ids on the pending update doc. The previous family is retired into a durable cleanup task instead of being deleted inline; a bounded continuation drains it. Commits never reload pages.
- Every refusal terminal retires the batch immediately (staging refusals, commit `_nay`s, and thrown commits), so a refused flow does not block the user for the batch TTL. The 15-minute sweeper (`cleanup_expired_pending_state_rows`) drains expired batches, text inputs, temporary states, trusted stages, and retired cleanup tasks; the TTL sweep must bound `by_owner_expiresAt` from below (`gte(0)`) because docs without the field sort before every number.
- Node `content.write` is enforced at batch creation and re-enforced at every commit that swaps sealed states canonical. Page staging, text-input staging, and the seal check batch ownership only — any future path that commits sealed states MUST re-check `content.write`.
- Upsert reconstructs existing branch docs or clones the live file base, applies the incoming text to `unstaged`, applies `staged` only when a staged text was staged, and deletes the pending update doc if both branches match base.
- The base reconstruction reads the materialization header plus one update row per query call. A walk that ends before the frozen target sequence (covered-row cleanup deleted rows mid-walk) is treated as stale and refused with `Failed to load file state` instead of returning a partial base labeled complete — a partial base would let Accept commit duplicated content.
- Accept can pass `reviewedUpdatedAt` (the sidebar passes the decoded row's `updatedAt`). When the proposal's `updatedAt` moved past that read, the action retires the batch and refuses with `Pending changes were revised, review the latest version`. Chained with the commit's `expectedUpdatedAt` gate, the accepted content is exactly what the user reviewed. Agent flows omit the argument.
- The agent pending read treats a content group whose `baseLineageGeneration` differs from the node's current `lineageGeneration` as no pending content (the commit gate would refuse that family anyway), so content resolves from the committed tree. The doc keeps its id so the agent's next write rebuilds the family from the live state. An operator Yjs repair bumps the lineage, which is what makes old proposals visibly stale.
- Rebase persistence rejects stale live bases and only accepts rebased state built from the current live file snapshot.
- Rebase persistence is update-only and patches only the exact doc id the client synced. When that doc was discarded, fully accepted, or replaced by a newer proposal while the sync was in flight, it returns a benign `Not found` and never recreates or overwrites anything.
- Two more rebase guards. A sync whose captured base is older than the doc's current base returns a benign `Stale save` (a tab that saved meanwhile wins). A sync against a doc that degraded to move-only returns `Not found` (in-flight syncs cannot resurrect reverted content).
- Accept and discard are deliberately simple: `apply_file_pending_move` and `discard_file_pending_structural` take only `{membershipId, nodeId}` and act on the user's CURRENT doc for that node.
- A click that raced a newer proposal applies or discards the doc's current state. The stale-panel window is sub-second (Convex reactivity) and accepted by design; there are no rendered-snapshot bindings.
- Discard is idempotent: a missing doc or a doc with nothing structural returns `_yay`, so bulk flows and already-settled swap cycle members just no-op.
- Deliberate non-guarantees: other members of a swap cycle apply their current destinations, and equal-base concurrent content edits stay last-write-wins.
- Same-user swap cycles accept atomically for any kind mix (files, folders, or both): accepting one member applies every member's move in one transaction, folder members cascade their descendants, and the other members' rows settle so a later accept on them no-ops.
- Folder replaces follow rename() semantics: a folder move soft-archives and replaces an EMPTY folder occupant, both when `mv` resolves into a folder with a same-named empty folder child and with `mv -T`; no `-f` is needed. A non-empty occupant is rejected with `Directory not empty` — committed children count, and so do the user's own pending moves into that folder. Accept also replaces an empty folder occupant that appears after proposal time, the same way it auto-replaces a file occupant. A file never replaces a folder, and a folder never replaces a file.
- The only stale literal the client treats as benign is `Stale save` (plus `Not found` on in-flight syncs); both come from multi-second ACTIONS, not from panel clicks.
- One documented cross-tab edge (accepted editing model): an OPEN diff editor owns a live local draft, and a dead doc id with no replacement doc deliberately falls through to the create path — so a diff tab left open on a file can recreate a proposal that was discarded in another tab. The recreated content is pending only (never committed or billed) and shows up in the panel like any proposal. Making Discard authoritative across tabs would need a separate draft-cancellation design.
- Every proposal write refreshes the 4-hour expiry, including the identical-content short-circuits (upsert and sync). An identical re-write still bumps `updatedAt`, reschedules cleanup, and records new structural intent (`copiedFrom` changes and a missing `eagerCreated` stamp still land).
- Save applies remote drift from base into both branches before saving, persists only the `staged` diff to the live file, writes the saved-sequence marker, enqueues R2 content materialization, and keeps the pending update doc alive on partial save.
- Save guards the target node before any write: a missing, out-of-scope, non-file, or archived target returns `Not found` and the doc survives.
- A save whose action-read base sequence no longer matches the file's CURRENT committed last sequence returns `Stale save` before any write or billing. This one check covers two races: a second tab replaying an old save (no double billing), and another user committing between the action's read and the mutation (the doc's new base can never silently hide that commit).
- A replace-move save (`copiedFrom.archivesSourceOnAccept`) archives the replace source and deletes the acting user's leftover doc on it. When that doc is itself a replace-move (chained `mv -f`), the walk continues down the replace chain to the deeper replace sources, so accepting the head of a chain consumes every hop in either accept order.
- `apply_file_pending_archive` re-validates at accept time: a missing doc or one without `pendingArchive` no-ops; a missing/out-of-scope/already-archived node just drops the doc. A folder computes its subtree by following stored `parentId` links at accept time (nodes added after the proposal are archived too, while an archived tree that reuses the path stays separate) and everything gets ONE `archiveOperationId`, so Unarchive restores the delete as one unit. The acting user's docs on all archived nodes are removed; other users' docs stay and go inert through the existing archived-node filters. Accepting a delete never runs the mv‑f replace-source chain.
- Save on a doc with `pendingArchive` is rejected with `File has a pending delete` (discard the delete first). Discarding a delete only clears `pendingArchive`: a doc that still has content or copy provenance survives as a content row; a delete-only doc is removed.
- Keep each public endpoint's current auth, membership, and rate-limit order. Do not infer one shared order: content upsert validates membership before its rate limit, while structural accept/discard and save perform the rate-limit check earlier.
- Saves that push a live Yjs diff must pass the billing credit gate and emit one `file_save` usage event. The billing event name is intentionally unchanged for now to avoid a separate billing taxonomy migration.
- Content-bearing doc lifecycle paths maintain pending `files_text_chunks`, pending `files_plain_text_chunks`, and pending `files_metadata_docs` in the same mutation. Chunking dispatches on the node's `yjsRootKind`: the Markdown chunker for `rich_text`, the byte-exact plain-text chunker for `plain_text`. YAML frontmatter is extracted and indexed for `rich_text` only. Replacing the `unstaged` text rebuilds those docs; a staged-only change reuses them. Doc deletion removes them. Structural-only docs own no pending indexed docs. If content collapses while `pendingMove` remains, remove the pending indexed docs and retain the structural doc.
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
- the source selector: `All changes`, `You`, and every persisted agent chat referenced by a pending doc. `You` means docs with no `threadIds`; it stays visible with a zero count. Thread options use the membership-scoped `ai_chat.thread_get` query, so archived contributing chats remain selectable
- source filtering after the full pending-row model is built. A doc with multiple `threadIds` appears with its same combined pending content under every linked chat, and source counts can overlap. The UI never tries to split one doc's changes by chat
- bulk Accept/Discard over only the rows shown by the selected source. A source-scoped accept that would also settle or invalidate a hidden row asks the user to switch to `All changes`; this covers cross-source move chains/cycles, folder deletes with hidden descendants, replacements, and archive-source copies. If a selected chat stops contributing, the selector returns to `All changes`; a zero-row source disables both bulk actions
- content-only, move-only, copy, content-plus-move, and delete row rendering; the "Deleted" caption wins over every other caption
- editable Markdown delete rows prefetch committed Markdown and expand to an inline fully-removed diff; binary and folder delete rows are plain rows without a disclosure control
- binary structural replacements query both asset sizes while the row is mounted, then expand to removed and added size lines or `Size unchanged`
- delete and binary-replacement links open the file, never the diff editor
- per-row Accept/Discard actions, with the same `All changes` guard when accept would affect a hidden source. Accept is enabled only after the node's current write query returns true; Discard stays available for a readable own draft after write access is removed
- bulk Accept is enabled only when every shown row currently returns true from its node write query. The backend still checks destination, replacement, and subtree permissions that one source-node query cannot prove
- move-before-content ordering for content-plus-move row acceptance
- delete rows run as their own trailing bulk phase (accepting a folder delete first would archive descendants and fail sibling accepts)
- safe eager-created destination deletion during discard

`packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx` owns:

- the pending-changes strip above the Agent-tab chat composer (rendered through `AiChatThread`'s `composerTopSlot`): a one-line clickable row, hidden at 0, never dismissable. With a `threadId` prop (the agent panel passes the selected persisted thread id) it counts only the docs whose `threadIds` contributor set includes that chat and labels them "from this chat"; without the prop it shows the user's workspace-wide count
- the amber count badge inside the "Pending changes" sidebar tab label, hidden at 0 (always the workspace-wide count)
- both switch the sidebar to the Pending changes tab by writing `app_state::files_last_tab` (the strip on click; the badge is display-only)
- the shared `FILE_EDITOR_SIDEBAR_TAB_ID_PENDING` constant (moved here so the sidebar tabs, the strip, and the agent panel import it without a cycle)

# Read-Only Locks

Read-only protects both proposal creation and proposal commit. The full contract lives in
`../files-read-only/SKILL.md`.

- New content, move, replace, archive, and delete proposals require every node they would change to
  be writable. Copy may read a locked source, but its destination and replacement occupant must be
  writable.
- Proposal creation, rebase, Save, and Accept may check locks before their action work. The final
  mutation checks the current locks again before its first write. It checks the destination,
  replacement occupant, and every source in an `archivesSourceOnAccept` chain.
- The final mutation uses only the current lock state. A proposal created before a lock stays visible.
  Accept and Save refuse while an affected node is locked. They may finish after every affected node
  is writable again. There is no lock history counter.
- A replace flow also stores the ordered source node ids. This is not lock history. It stops Accept
  from changing different files from the ones the user reviewed.
- Whole-proposal Discard and Discard all stay available. They delete only the caller's pending docs.
  Diff hunk discard and editor-level discard that rewrite the pending Yjs model remain blocked.
- `eagerCreated.createdAncestorIds` stores the ids of missing folders created with the new file. The
  ids are stored deepest first so cleanup can delete empty folders from the inside out.
- Discard, expiry, and failed-write cleanup check the current lock on the eager-created file and each
  created ancestor before the first delete. If one is locked, delete the pending docs but keep the
  committed file and folders. A past lock that is now removed does not block safe cleanup.

# Cleanup And Expiry Model

- Every write that leaves a pending update doc alive refreshes its four-hour cleanup task. This includes content upserts, move upserts, rebases, partial saves, and structural accept/discard paths that preserve part of a content-plus-move doc.
- If an operation deletes or fully resolves the doc, it removes the cleanup task instead.
- A new presence session reschedules cleanup for four hours from that session without changing the doc's `updatedAt`. Disconnect does not shorten the lifetime, so unreviewed proposals survive the user closing the app.
- Every scheduled cleanup carries `expectedUpdatedAt`; stale scheduled work cannot delete a newer doc.
- Expiry hard-deletes the file node only when every check passes: the doc has an `eagerCreated` stamp, the node's committed sequence still matches that stamp, the node's `updatedBy` is still the proposer, and no other pending update doc uses the node. The `updatedBy` check exists because a committed rename or move by another user never advances the Yjs sequence, so the stamp alone cannot catch it; `rename_node` and `move_nodes` both stamp `updatedBy`.
- An ancestor-folder move does not restamp descendants and does not block the hard delete — removing the eager-created node does not undo the ancestor's move.
- When the node is not eligible, expiry deletes only the pending update doc and its pending indexes/task, and the node stays active. Expiry never hard-deletes a pre-existing node targeted by a replace proposal. A delete-only doc expires the same way: the doc goes, the node is untouched.
- Eager creates commit missing parent folders. `eagerCreated.createdAncestorIds` remembers their ids,
  deepest first.
- Every path that safely hard-deletes the eager-created leaf — discard, expiry, and the failed-upsert compensation — then removes those folders too, but only while each folder is provably untouched: created AND last updated by the proposer, zero children in any archive state, no pending update doc ON the folder (`by_fileNode`), and no pending move TARGETING it as a destination (`by_pendingMove_destParentId` — another user's proposed move into the folder keeps it alive).
- The first kept folder stops the walk (everything shallower contains it).

# Architectural Invariants

- Pending updates are per-user docs keyed by `(organizationId, workspaceId, userId, fileNodeId)`.
- A content-only doc normally exists while `staged` or `unstaged` differs from `base`. Structural docs, eager-created destinations, and replace-moves may persist even when the content branches match.
- The `base`, `staged`, `unstaged` and live documents must share the Yjs history used by state-vector diffs. Start each branch from the exact base state and apply text edits to that branch. Never rebuild a branch as a fresh `Y.Doc` from visible Markdown and then diff it against the live document: state vectors compare Yjs structs and client clocks, not visible text, so applying a diff between independent histories can duplicate the document.
- Rebase and reconciliation are string-level for both shapes: the client and server use the shape-aware dispatchers (`files_yjs_doc_get_text` / `files_yjs_doc_update_from_text`) plus raw state-vector diff updates. The only ProseMirror-touching code on these paths is the `rich_text` branch inside the dispatchers themselves.
- AI reads must continue to see the current user's pending `unstaged` branch overlay.
- Only content-bearing docs own pending exact-text chunks, plain-text search chunks, and metadata docs. Content insert, `unstaged` text replacement, deletion, save, and expiry keep those docs in sync with the pending update doc; staged-only changes reuse them.
- Bash `search` (`text_search_files`) uses one Convex full-text search query against `files_plain_text_chunks` with Convex native cursor pagination, and renders directly from those docs without hydrating linked exact-text chunks. It filters pending chunks to the acting user, filters out other users' pending chunks, and hides committed chunks for files that user has pending edits on. Pending-first ordering is not an invariant.
- Bash `meta search` uses one Convex indexed query against `files_metadata_docs` per command. It filters pending metadata to the acting user, filters out other users' pending metadata, and hides committed metadata for files that user has pending edits on. Multi-predicate AND/OR is intentionally outside the command and should be composed by shell tools over path output.
- Metadata search hides committed metadata only for docs that carry a content proposal (`files_pending_update_content_of` returns non-null), the same rule full-text search uses. A move-only doc does not mask the file's committed metadata.
- `Review changes` must switch into diff mode.
- In the diff editor, `Accept all` only copies unstaged content into staged content; it does not save by itself. In the Pending changes tab, bulk Accept applies or saves every row shown by the selected source.
- In the diff editor, `Discard all` copies staged content into unstaged content without a special clear mutation. The Pending changes tab uses backend discard mutations for its rows. Its content mutation copies staged into unstaged and may waive only a missing `content.write` permission for the caller's exact existing doc; it never weakens general pending upserts.
- `Save` can partially resolve a pending update and keep the unresolved branch alive.
- `Sync` must rebase on top of the latest live file state before persisting.
- Stale rebases must be rejected.
- Live rich-text Yjs sync must serialize outgoing local update batches and retain/retry failed batches ahead of newer edits.

# Verification Checklist

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
- Verify the source selector shows All, threadless You, archived chats, and contributing chats newest first. A shared pending doc should appear as the same complete row under every linked chat.
- Verify source-scoped bulk actions touch only shown rows, a selected chat falls back to All after its last row settles, and You stays available at zero with disabled bulk actions.
- Verify source-scoped accept asks for All instead of settling hidden move-chain/cycle members, hidden folder descendants, hidden replacement occupants, or hidden archive-source rows.
- Verify editable Markdown delete rows start fetching committed content before expansion and render it as fully removed.
- Verify binary and folder delete rows have no disclosure control and do not fetch committed Markdown.
- Verify binary replacements prefetch both asset sizes and show removed and added size lines, or `Size unchanged` when the sizes match.
- Verify bash `rm` hides the path from the proposer's reads, accept archives (folder cascade, one operation id), and discard restores visibility without touching the node.
- Verify pure moves do not enter the diff pager.
- Verify accept/discard applies pending paths, archive behavior, content, and move-before-save ordering for content-plus-move rows.
- Verify discard and expiry hard-delete only eligible eager-created destinations.
- Verify the proposing user sees the pending structural path overlay while another user sees the committed tree.
