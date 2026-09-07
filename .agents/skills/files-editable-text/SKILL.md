---
name: files-editable-text
description: Spec for editable text files and their Yjs shape system — the content type policy, the stored `yjsRootKind`, the read-side shape guards, the write doors, the collaborative/non-collaborative flag and its two toggles, the size limits, the four durable refusal markers, and the operator repair path. Use when changing the content type helpers or editor maps in `packages/app/shared/files.ts`, the shape guards or update scans in `packages/app/shared/files-yjs.ts` / `files-tiptap.ts`, the Yjs write doors or materialization markers in `packages/app/convex/files_nodes.ts` / `files_nodes_content.ts`, the plain-text chunker, or upload text conversion in `packages/app/convex/r2.ts`.
---

# The Two Document Shapes

Every editable text file has a Yjs document in one of two shapes (`files_YjsRootKind` in `packages/app/shared/files.ts`):

- `rich_text`: the ProseMirror document Markdown files use. Root name: `default`.
- `plain_text`: a flat `Y.Text` document every other editable text file uses. Root name: `plain_text`.

The root names live in `files_YJS_DOC_KEYS` (`packages/app/shared/files.ts`). Markdown keeps the rich text editor. Every other editable text type opens in the Monaco "Code" editor.

Rich text documents support GFM tables. The shared extension set in `packages/app/shared/files-tiptap.ts` (`#region tables`) registers the four table nodes for both the browser and the server, so the two schemas stay identical. The serializer writes GFM pipe tables: no column padding, alignment colons read from the first row, `\|` escaping with the backslash run in front of a pipe doubled, `<br>` for newlines inside a cell, and an empty header row when the document's first row holds body cells. Merged cells, column widths, and multiple blocks inside a cell are not representable in GFM: they are flattened once on the first save and are stable afterwards. One special spelling: a code span in a cell that holds a backslash right before a pipe is written as an HTML `<code>` element with numeric character references (`&#92;`, `&#124;`), because the backtick form would grow its backslash run on every save. Cells accept `paragraph+` only, so members cannot create lists, headings, or code blocks inside a cell.

# The Content Type Policy

`files_nodes.contentType` decides how a file opens, how it is edited, and how it is served. The name is only a hint, used once, when a file is created without an explicit type. All in `packages/app/shared/files.ts`:

- `files_parse_content_type` / `files_normalize_content_type`: parse and normalize a content type string; a bad one is refused with `files_INVALID_CONTENT_TYPE_MESSAGE`.
- `files_editable_text_content_type_of(contentType)`: the stored editable text type, or `null` when the type is not editable text. Editable text is Markdown, plain text, JSON, YAML, TOML, CSV, TSV, CSS, JavaScript, TypeScript, shell, SQL, and the other text types the app edits.
- `files_yjs_root_kind_of_content_type(contentType)`: `rich_text` for Markdown, `plain_text` for every other editable text type, `null` otherwise. `files_editable_text_shape_of` returns the shape and the normalized type together.
- `files_default_text_shape_for_name(name)`: the shape a create path uses when the caller gives no type: the name's hint (`.md` is Markdown, a known text extension is that type), else plain text. An unknown extension and an extensionless name make a plain text file. Nothing appends `.md`, and no name is refused for its extension.
- `files_guess_content_type_from_name(name)` and `files_resolve_upload_content_type`: an upload keeps the caller's valid type; without one, the name's hint, else `application/octet-stream`.
- `files_monaco_language_id_of_content_type(contentType)`: the Monaco language per stored type; unmapped types render as plain text.
- `files_get_signed_download_serving({ contentType, fileName })`: the response headers every signed R2 download must pin, from the stored type. The name only fills the disposition file name. Only the literal media set serves inline; everything else — editable text, `svg`, `html`, unknown — downloads as an attachment. A presigned R2 GET carries no nosniff and no CSP, so this pinned type plus the disposition is the whole defense against hostile bytes running on the shared R2 origin. The stored type is client input at upload time, and that is fine here: the inline set holds only types a browser never runs as a page.
- `files_lowercase_extension` in `packages/app/convex/files_nodes.ts` still stores the name's extension for search filters only: a leading-dot name like `.gitignore` and a trailing-dot name have no extension.

# The Stored `yjsRootKind`

`files_nodes.yjsRootKind` (`packages/app/convex/schema.ts`) stores the shape when the node is created. Absent means the node is NOT editable text: folders, stored blobs, and read-only mounts leave it unset and have no Yjs document. There is no default. Never read a missing field as `rich_text` — `node.yjsRootKind ?? "rich_text"` would classify every folder, stored blob, and read-only mount as a Markdown file and send it into the Markdown chunker and the frontmatter indexer. `files_node_has_editable_text_content` refuses a node without the field, which is why this field, not the Yjs pointers, is what marks a node as an editable text file.

Reads never re-derive the shape from the name. Every read, write, chunker dispatch, and guard passes `node.yjsRootKind` through directly, narrowed by the `files_node_has_editable_text_content` type guard. There is no accessor helper wrapping the field, so do not look for one.

The stored type and shape are set once, when the node is created. The agent's create and shell write doors, the public write routes, upload conversion in `r2.ts`, and the sidebar's upload prepare all resolve them there, from the caller's explicit type or the name's hint (`files_default_text_shape_for_name`, `files_guess_content_type_from_name`). The sidebar's New file button is the one door that picks no type: it creates a Markdown file with a default name (`create_text_node`), and the user renames it afterwards. After creation the stored fields are the answer. A rename keeps the content and the type: `notes.md` renamed to `notes.txt` is still a Markdown file that opens in the rich text editor, and `data.json` renamed to `data.yaml` still opens as JSON. There is no rename class rule and no name classifier for a stored node.

# Read-Side Shape Guards

`files_yjs_doc_check_text_addressable` in `packages/app/shared/files-yjs.ts` is the read-side backstop both dispatchers run as their first statement (`files_yjs_doc_get_text` / `_update_from_text` in `packages/app/shared/files-tiptap.ts`, which take a required `rootKind`).

The third dispatcher, `files_yjs_doc_create_from_text`, runs NO guard, on purpose. It builds the document itself, so at that moment there is no existing shape to check. That leaves the `rootKind` argument as the only protection on the create direction: a wrong value builds a wrongly shaped document, and nothing downstream can catch it. So check the `rootKind` a caller hands that function, and do not delete a caller-side shape check there as redundant with the guard — the guard does not run.

- `plain_text` — the parity check: `toString().length` must equal `length`. `toString()` concatenates only string content, while `length` also counts embeds and child types, so the line diff can address the text by offset exactly when the two agree. Parity does not catch a `Y.Map` named `plain_text` (parity holds, reads `""`); the byte doors close that case, so do not delete a door check because "the getter already checks".
- `rich_text` — a name test: refuse when the `plain_text` root is present and the `default` root is absent. The test MUST read `share.has()` before any accessor call, in both directions: an accessor registers the root it reads, so `getXmlFragment` first makes the test allow a vandalised document, and `getText` first makes it refuse an ordinary empty Markdown document.

Refusal messages are stable `Result` values (`File text is not addressable`, `File document does not match its rich text shape`). The guard logs nothing; each caller logs with the node id it holds.

# The Two Write Doors

Door 1 — `files_db_yjs_push_update` (`packages/app/convex/files_nodes.ts`) checks every client-pushed incremental update as its FIRST statements, above every write: zero-byte refusal (a stored zero-byte update breaks every later merge; the two-byte v1 no-op stays legal), the 930,000-byte wire cap, then `files_yjs_scan_client_update` (`packages/app/shared/files-yjs.ts`). For `plain_text` that scan is a whitelist over the decoded v1 structs: only `Y.Item`s, only `ContentString`/`ContentDeleted` content (no `ContentFormat`), and `parentSub` must be null — a map-slot item would land in the plain root's `_map`, which door 2 refuses forever, and an asymmetry between the doors is a permanent brick. For `rich_text` the scan applies the update to a throwaway doc and refuses when it creates the `plain_text` root. V2-encoded and malformed updates are refused for both shapes. Only after the checks does the reserve gate bump the sequence and insert the update doc.

Door 2 — the pending-state seal (`packages/app/convex/files_pending_updates.ts`) checks every whole document state a client stages: non-empty, at most 4 MiB, v1 encoding, then the per-`rootKind` shape rule. The plain branch runs the parity check AND requires the plain root's `_map.size === 0` (`files_yjs_doc_plain_text_root_map_size`) — this is the root-map-size rule that closes the `Y.Map` hole parity cannot see. A whole state legitimately carries content an incremental plain diff never should, so door 1's content whitelist must not run on door 2's input.

# Collaborative And Non-Collaborative Files

Every editable text file is collaborative by default. `files_nodes.nonCollaborative` (`packages/app/convex/schema.ts`) is an optional boolean, and an absent field means collaborative, so every file written before the field existed keeps the behavior it always had.

- Collaborative: the file has a Yjs document. Several people type at once, the edits merge, and comments stay anchored inside the document. The two Yjs doors above are its only content-write doors.
- Non-collaborative: the file has NO Yjs document. No snapshot doc, no sequence doc, no update log, no materialization. Only the committed chunks, the content asset, and the version history exist. The file is still editable: a save replaces the whole text. Last write wins, even when the tab read older text. The previous saves stay in version history.

`yjsRootKind` stays set on a non-collaborative file. It still decides Markdown versus plain text for the chunker and the editor choice, and turning collaboration back on needs it to rebuild the right document shape.

On a file with collaboration off, a member Save keeps existing proposal branches. Their old base asset makes them stale. Review and the next agent edit or shell write prepare them on current text; the agent needs no owner to open Review. Preparation merges accepted and proposed text separately. Changed proposal lines win overlap while unrelated saved text survives. Preparation changes only the proposal, never the saved file. Failed preparation keeps the old branches for Copy, Retry, or Discard. See the pending-updates skill for the shared merge and race checks.

A copy carries the source's content, content type, and document shape, whatever the destination's name says. A text copy over an existing text file keeps the destination's collaboration mode. A new copy, or a text copy over a stored file, inherits the source's mode. The destination keeps its id, permissions, custom metadata, and history. The copy is staged as a whole-file replacement (`files_pending_updates.pendingReplacement`, see `../files-agent-pending-updates/SKILL.md`) and reviewed as a whole; the replaced content stays in history with its own type. Every destination gets a pending copy, whatever its collaboration mode. Text is normalized once (one leading BOM removed, line endings to LF). A plain text source stays byte-exact after that, and a Markdown source is re-serialized by the rich text document it builds. `mv -f` is not a copy: it is a structural replace-move that keeps the source's identity and archives the occupant when accepted.

A version restore brings back the version's type and shape. An existing text file keeps its current collaboration mode; a stored file restored to text uses the version's mode. `restore_snapshot_r2` writes a version with the live document's shape into that document; other versions go through `finalize_snapshot_restore_replacement`. Both paths check the current `yjsLastSequenceId` and its `lastSequence` counter when restoring a live Yjs file. An edit that reaches the document while the restore runs refuses it with `This file changed while the snapshot was being restored. Try again.`, the same rule as the pending-copy accept. A refused same-shape restore hands both uploaded version assets to the deletion ledger; an unused trusted update stage expires through its normal sweep.

The live restore saves text serialized from the restored Yjs document. Rich text parsing can change Markdown saved while collaboration was off. This keeps committed text, downloads, and Yjs equal, even when the restore produces no Yjs update. The historical version keeps its original bytes.

Every restore preserves all owners' content proposals, including a same-shape live restore and a replacement that changes type or shape. It marks them for preparation without changing ids, branch states, timestamps, or expiry. `contentRebaseRootKind` captures the old node shape once; repeated restores keep it until preparation reads those branches and rebuilds them in the current shape. Review shows the proposal against restored text, including later saved edits. Later accepted text wins overlap. A restore to stored bytes also retains text proposals; applying them to a stored-byte file is not implemented, and its conversion rule remains undecided.

Whole-file copy and restore share `db_install_file_content_replacement` in `files_nodes_content.ts`. Its required `pendingContent` policy is `preserve` for restore and `drop` for copy. An accepted copy still removes all destination content proposals. When the live document has edits past its snapshot, the action keeps its latest text as a version first. Otherwise the helper uses `files_snapshots.by_asset` to add the old asset to history only if this file has no version doc for it. Version docs record `contentType`, `yjsRootKind`, and `nonCollaborative`; older docs are filled from the file by the `backfill_files_snapshots_content_state` migration. Replacing an existing collaborative text file with stored content refuses with `Turn collaboration off in Properties before replacing this text file with stored content.` The member must use the OFF warning and acknowledgement first. New eager copy placeholders may become stored files without that toggle.

Two predicates in `packages/app/shared/files.ts` ask the two different questions, and picking the wrong one is the main bug risk in this area:

- `files_node_has_editable_text_content(node)` — kind `file`, has `assetId`, has `yjsRootKind`. True for BOTH modes. This is the "is this editable text" question: reads, the editor choice, and every not-a-stored-blob fork.
- `files_node_has_editable_yjs_state(node)` — the same three plus `yjsSnapshotId` and `yjsLastSequenceId`. True only for a collaborative file. This is the "does this have a Yjs document" question: the Yjs doors, materialization, the Yjs base of a pending proposal, and snapshot restore. Pending proposals themselves exist in both modes (see `../files-agent-pending-updates/SKILL.md`, "Files with collaboration turned off").

## The third write door

`replace_file_content` (`packages/app/convex/files_nodes_content.ts`) is the **member's** content-write door for a non-collaborative file. It is an action plus a final mutation, because a Convex mutation cannot reach R2 and this door writes a new version snapshot object. The agent never uses it: an agent write becomes a pending update, and its Accept runs `save_file_pending_update_non_collaborative_in_db` (`files_pending_updates.ts`), which commits through the same `files_nodes_db_commit_text_replacement` helper as `finalize_file_content_replacement` (see `../files-agent-pending-updates/SKILL.md`, "Files with collaboration turned off"). A plugin updating its own non-collaborative file goes through the public `/api/v1/files/write` door instead, which has its own write pipeline and does not go through this helper.

- The action checks auth and credits, runs the text cap and the frontmatter preflight, and PUTs the new content object. Over-cap frontmatter is refused with `Too many frontmatter fields`, the same words as the pending-update preflight: both are doors where a person hands over a whole text and can shorten it after reading the message. Materialization cannot refuse anybody, so it settles with the marker pair instead — see the `file-metadata` skill.
- `finalize_file_content_replacement` re-runs auth → membership → ACL `content.write` → read-only lock and credits, then replaces the chunks, points the node at the new asset, stores the version snapshot, and emits the `file_save` billing event.
- Saves carry only the text and the caller's scope and file ids. Neither the action nor the final mutation compares an older content asset. The mutation that commits last wins, including when an earlier request takes longer to upload. Success is `_yay: null`.
- The door refuses a collaborative file. That file's text lives in its Yjs document, and replacing the chunks under it would leave the two disagreeing.

## The two toggles

Both live in `packages/app/convex/files_nodes_content.ts`. Both need ACL `content.write`, because changing the mode changes how the file is written. Both are refused by the read-only lock, and both are rate-limited on `files_tree_write`. Calling either one on a file already in that mode succeeds and does nothing, like `set_node_read_only`.

`set_file_non_collaborative` (mutation) turns collaboration OFF and is destructive:

- It needs `acknowledgeDropCollaborativeHistory: true`, checked before anything is read or written.
- It deletes the Yjs snapshot doc, the sequence doc, the whole update log, the superseded Yjs snapshot object, and the saved-sequence markers (`files_pending_updates_last_sequence_saved`, which count in the deleted document's sequence numbers). The comment docs in `chat_messages` are not deleted, but the marks that pinned them to words are, so the threads disappear from the file. The committed text, version history, file metadata, and every member's content proposals survive. The confirmation names the history and comment loss and asks the user to review proposals again before accepting them.
- It clears the three markers that describe the deleted document: `contentShapeMismatchAt`, `contentYjsStateTooLargeByteSize`, and `contentTooLargeByteSize`. The last one is set when the text INSIDE the document grew past the cap, so the committed text this toggle keeps is the older one that still fit, and leaving the marker would show a permanent "too large" banner on a file that is now small. If the toggle also drops newer unmaterialized state, it clears the frontmatter marker pair because those counts describe the dropped state, not the older committed text.
- It refuses a file that still has unmaterialized updates: "This file is still saving. Try again in a moment." The committed text only reaches the last materialized sequence, so deleting the log now would silently drop everything typed after it. A file carrying `contentShapeMismatchAt`, `contentYjsStateTooLargeByteSize`, or `contentTooLargeByteSize` is the exception: normal materialization cannot close that gap, so asking the user to wait would be a lie, and the toggle goes ahead. The temporary frontmatter marker pair is not an exception. A later fitting edit can clear it, so the toggle must wait rather than drop newer text.
- The mutation records the old sequence-doc id in `collaborationCleanupYjsLastSequenceId` before it schedules paged cleanup. Turning collaboration back on refuses while old Yjs snapshot or update docs still exist. If cleanup removed every old doc but failed before clearing the marker, the enable path clears that stale marker in its final transaction. Cleanup only deletes docs owned by that exact sequence doc, so old numeric sequence ranges cannot cross into a new document whose sequence restarts at zero.
- It refuses a file that is still an eager-created pending node: "Accept or discard this new file before turning collaboration off." Such a node without a `yjsLastSequenceId` could never be hard-deleted again, so discard, expiry, and account deletion would all skip it and the sidebar would show it as "Added" forever.

`set_file_collaborative` (action) turns collaboration ON without deleting committed history. It reads the committed content object, builds one fresh compact document for the stored `yjsRootKind`, and commits the text that new document produces — not the text that went in, because building a rich document normalizes Markdown. It borrows the operator repair's split (the action PUTs, the mutation publishes) but is built on the CREATION path: the repair patches Yjs docs a file already has, and this file has none. Its preflight returns the node's `readOnlyScopeNodeId` so the lock is answered BEFORE the two uploads; the publish mutation asks again, because somebody can lock the file while the objects upload.

Turning collaboration on still checks `baseAssetId` in `finalize_file_collaboration_enable`. A save during the upload must refuse the mode change, or the new Yjs document could contain older text. This check is separate from last-write-wins saves.

Both toggles call `files_pending_updates_db_mark_content_for_rebase`. It sets `contentNeedsRebase: true` on each content proposal and deletes saved-sequence markers, even when the file has no proposals. It keeps old base pointers, branch states, pending chunks, owners, contributor threads, move/delete intent, and expiry. Marking does not change `updatedAt`. Review or the next agent write prepares one owner's proposal on current text before content writes resume. Ordinary reads use committed text until then. Direct stale writes still refuse. Restores use the same marker and retain the source shape; copies keep their separate drop policy. See the pending-updates skill for merge and race checks.

Every live writer carries the exact current `yjsLastSequenceId`. Materialization and marker workers also check that `lastSequence`, the reconstructed sequence, and the job's target sequence agree. Restore checks the id and counter it read; repair checks the id and target sequence, then derives the next `lineageGeneration` from the current sequence doc. Incremental reads also return the id, so a client never joins a snapshot from one lineage to update docs from another. Sequence numbers restart after a mode toggle, and repair rotates the exact last-sequence id even though it keeps the numeric target. The numbers alone do not identify a document lineage. Work from an older lineage must refuse or become a no-op before it changes docs or markers. Every bounded update cleanup carries the same exact id; superseded-asset cleanup stays independent because it reference-checks the asset before deleting it.

Each materialization uploads a fresh Yjs snapshot asset and a fresh version asset. This action never overwrites a published R2 object. The final mutation also compares `expectedYjsSnapshotAssetId` with the current snapshot's asset: this rejects a second publication at the same sequence counter. A stale run hands both new assets to the deletion ledger and changes no current content. A successful run patches the existing snapshot doc and publishes both assets in one transaction. It keeps the snapshot doc id, sequence doc id, and lineage generation unchanged.

Materialization starts bounded cleanup of covered update and job docs immediately. It keeps the old Yjs object for 15 minutes for readers that already loaded its header, then checks its references before deleting it. The separate `putMayArriveUntil` used by OFF, repair, and replacement is a deletion-job settlement deadline: DELETE starts immediately, but a successful early delete keeps the job for another attempt after the deadline. The hourly recovery schedules due jobs. It is not a promise that the first DELETE waits 15 minutes.

The two toggles answer a permission refusal with different words, and that is not an oversight: the mutation asks the permission question itself and bubbles the shared helper's `Permission denied`, while the action only learns that its preflight query said no and answers `Not found` for every reason, exactly like `restore_snapshot_r2`.

## Where the mode comes from

Creation, Properties, and whole-file replacement choose the mode:

- `POST /api/v1/files/write` and `/write-many` accept an optional `nonCollaborative` boolean in the body. It is read only when the write CREATES the file; a write over a file that already exists keeps the mode that file has. See the `public-api` skill.
- The Collaboration checkbox in the Properties dialog (`packages/app/src/components/files/files-properties-modal.tsx`). Both confirmations say that proposals waiting for review are kept and must be reviewed again. They warn that only last-saved text is used and ask the user to save open editor changes first. OFF also names the deleted history and comments; ON warns that Markdown formatting may change. A proposal review can stay mounted across the toggle, so it must block old pane writes and reload the prepared branches.
- A sealed service `create-target` request with required `nonCollaborative: true`. The declared
  `contentType` must be an editable text type, or the request is refused. The choice stays on the
  service target while the empty placeholder is a blob, then successful conversion publishes the flag.
- A `nonCollaborative: true` create on the public `/api/v1/files/write` door. It inserts a
  non-collaborative Markdown file with a content/version R2 object (same as other non-collab creates).
  This is how a plugin backend creates its owned files. `create_file_by_path` is unchanged and still creates a collaborative file.
- A new copy inherits the source's mode. Copying or restoring text over an existing text file keeps that file's mode. Copying or restoring text over a stored file uses the source's or version's mode.

Member uploads never create a non-collaborative file. A service upload and the public write door's
`nonCollaborative` flag are the narrow exceptions. After
the content type check, UTF-8, NUL, size, document-build, and frontmatter handling succeeds, a service upload publishes chunks,
one content/version snapshot and one file snapshot, with no Yjs asset, snapshot, sequence, or update
docs. A deterministic fallback stays a blob, preserves any service lock provenance, and leaves the
node flag unset. There is still no lazy Yjs creation: a collaborative file gets its document eagerly.

## What the editors do

`files_resolve_effective_editor_view` (`packages/app/src/lib/files.ts`) clamps on the document shape only: a `plain_text` document has no rich view, and that is the whole rule. A non-collaborative file supports every view its shape supports. A non-collaborative `rich_text` file opens in the rich editor by default (`FileEditorRichTextNonCollab` in `file-editor-rich-text.tsx`), and its diff view compares the committed text against the member's local edits (`FileEditorDiffNonCollab` in `file-editor-diff/file-editor-diff.tsx`) when the member has no proposal on the file. When the agent left a proposal, the diff view reviews that proposal instead (`FileEditorDiff` with `nonCollaborative`; see `../files-agent-pending-updates/SKILL.md`).

The proposal review (`FileEditorDiff`) is the exception: it loads the proposal's branches and saves through `save_file_pending_update` (see the `files-agent-pending-updates` skill). Every other editor here loads its text with `get_non_collaborative_file_content`, which returns the committed text and its `yjsRootKind`. Save is explicit and calls `replace_file_content` with the whole local text. Last write wins; editors keep no base-asset token. There is no Sync button, because there is no shared document to merge. Restoring an old version uses `restore_snapshot_r2`. If the file had collaboration off when restore started and still does when it commits, the restore wins over intervening saves and keeps the replaced text in history. Stored and collaborative source files retain their restore checks. Switching views loses unsaved edits on purpose: each view edits its own copy of the stored string. The same is true when the file is closed, or when another member turns collaboration on while the editor is open. None of those are silent: every non-collaborative editor compares its live text against the last saved text in its unmount cleanup, and warns through `file_editor_warn_unsaved_text_dropped` (`packages/app/src/lib/file-editor.ts`) with a "Copy text" action that puts the dropped text on the clipboard.

The rich editor serializes the whole document back to Markdown on save, so the first save may reformat the file (the toolbar shows a hint while that is true). Every later save of the same content is byte-identical: an idempotence test suite over `nonCollaborativeExtensions` (`extensions.test.ts`, mirrored in `shared/files.test.ts`) protects that. One special case: a table cell holding a code span with a backslash serializes through an HTML `<code>` tag with HTML number codes for the pipe and backslash, because plain Markdown cannot spell that content inside a table row.

Adding a comment in the rich editor saves the file at once — the thread anchor must live in a committed version, or resolving from the sidebar would target text nobody saved. The Comment button is disabled while unsaved edits exist; the member saves first, then comments. A comment added from a tab with older text saves that older text plus the mark. It does not re-read or merge another tab's changes. The other text stays in the File Snapshots dialog.

# Read-Only Check

The file lock is checked after ACL and before both content-write doors. `yjs_push_update`, snapshot
restore, and operator Yjs repair check the current lock in their final mutation before any node,
asset, chunk, snapshot, or Yjs write. A current lock returns `read_only`. A past lock that was removed
before the final mutation does not refuse the write.

When the editor becomes read-only, the Yjs provider removes queued local updates. It reloads the saved
document and shows a warning that the local changes were not saved. The server does not keep lock
history. Materialization still processes Yjs updates committed before the lock. This work finishes
already saved content; it does not accept a new user edit.

# Limits

Constants in `packages/app/shared/files.ts`:

| Constant                                        | Value         | What it bounds                                                    |
| ----------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| `files_MAX_TEXT_CONTENT_BYTES`                  | 900,000 B     | Visible text read from or written into a Yjs document              |
| `files_MAX_YJS_WIRE_BYTES`                      | 930,000 B     | One transported Yjs value: one update doc, one pending-state page |
| `files_MAX_YJS_RECONSTRUCTED_STATE_BYTES`       | 4 MiB         | A whole reconstructed Yjs state, and a sealed pending full state  |
| `files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES`| 16 MiB        | Operator repair reads only; normal reads and writes never use it  |
| `files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES`     | 8 MiB         | Total bytes of not-yet-materialized update docs per file          |
| `files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT`     | 256           | Count of not-yet-materialized update docs per file                |

The unmaterialized budgets are counters on `files_yjs_docs_last_sequences`, maintained by the update writers and recomputed exactly at each successful materialization. A push that would cross a budget triggers an immediate materialization and asks the caller to retry.

# The Four Materialization Refusal Fields

Fields on `files_nodes` (`packages/app/convex/schema.ts`; read the docblocks there for lifecycle detail):

- `contentShapeMismatchAt`: set when materialization finds the reconstructed document's shape does not match the node's `yjsRootKind`. Readers report a shape mismatch instead of content; the Yjs writers refuse more updates.
- `contentYjsStateTooLargeByteSize`: set when the reconstructed state passes the 4 MiB cap. Materialization does not advance, readers report the failure, and the Yjs writers refuse more updates.
- `contentFrontmatterTooLargeFieldCount` and `contentFrontmatterTooLargeIndexDocumentCount`: set as a pair when a materialization's frontmatter is over the 128-field or 512-index-document cap. Committed content stays at the last sequence that fit. The Files top status shows both stored counts and limits, so the user knows frontmatter indexing is paused. Cleared when the user reduces the metadata and a later materialization succeeds. An uploaded `.md` that converts with over-cap frontmatter is born with the pair already set (see the upload path below).

While `contentShapeMismatchAt` or `contentYjsStateTooLargeByteSize` is set, door 1 refuses every update with the repair message — accepting more would only grow the broken log. The pre-existing `contentTooLargeByteSize` (visible text over 900,000 bytes) is a settle marker, not one of the four: content freezes at the last fitting sequence, but writes continue. When an unmaterialized budget trips on a settle-marked file, the reserve gate returns the repair message instead of a false "retry in a moment", because a settled materialization never shrinks the counters.

Operator repair (`repair_file_yjs_state_from_visible_text` plus its staleness-gated `finalize_file_yjs_repair` in `packages/app/convex/files_nodes_content.ts`) is the ONLY recovery for `contentShapeMismatchAt` and `contentYjsStateTooLargeByteSize`. It can also rebuild a frontmatter-marked file, but normal materialization clears that temporary pair after the user reduces the metadata. Repair rebuilds one fresh compact document from the file's visible text, swaps every committed representation atomically, clears the markers, resets the counters, rotates `yjsLastSequenceId`, and increments `lineageGeneration`. The exact-id change stops pre-repair live writers and workers. The generation change makes pending proposals built against the old history visibly stale. The old content asset stays under normal snapshot retention. Run it through the `convex-admin-ops` skill.

# Text Normalization Policy

- BOM: drop exactly one leading U+FEFF at every string→document producer, through `files_normalize_text_document_input` (`packages/app/shared/files.ts`), BEFORE any byte count. Stored text never begins with a BOM, so Monaco's silent BOM strip cannot make a file dirty on open. The same call normalizes CRLF and lone CR to LF.
- Trailing newline: preserve exactly. The plain-text getter and setter are byte-transparent; they neither append nor trim a final newline. The Markdown getter's forced trailing newline is rich-text-only behavior.
- The producers own normalization; the Yjs bridge below them stays byte-transparent. Normalizing only inside the setter would give one file different truths in the document, the R2 snapshot, the chunks, and the stored size.

# Plain-Text Chunking

`files_chunk_plain_text` (`packages/app/server/files-plain-text-chunking.ts`) tiles raw text into contiguous, zero-overlap chunks with the same 1,200-unit cap and doc shape as the Markdown chunker. For plain text, `textChunk` and `plainTextChunk` contain the same raw substring, so search and reads see byte-identical content. A single line longer than the cap is split MID-LINE into cap-sized surrogate-safe pieces; each piece reports that one line's number, and concatenating chunks in order reconstructs the input exactly. One accepted regression: a search token that straddles a cut inside a split line is findable in neither chunk.

# How Plain-Text Files Are Created

Three doors create a `plain_text` node:

- Upload conversion: `finalize_uploaded_text_file` (`packages/app/convex/r2.ts`) reads the node's stored content type and converts every editable text upload (Markdown to rich text, every other editable text type to `Y.Text`). Deterministic failures (a type that is not editable text, over-cap, invalid UTF-8, NUL bytes, refused document build) fall back to a stored blob through `settle_upload_conversion_fallback`, which dispatches the upload plugin event — only a successful conversion suppresses it. Service uploads (`/api/v1/files/service-uploads/*`) feed the same conversion: their create-target leaves `processingWorkId` unset for editable text types, but their fallback blob dispatches no plugin upload event (see the `public-api` skill). Over-cap FRONTMATTER is not a fallback: the markdown itself is valid, so the upload still converts — the finalize mutation mirrors the materializer's preflight, commits the chunks without the metadata index, and publishes with the frontmatter marker pair set, so the insert backstop can never throw inside the infinite-retry conversion workpool.
- Agent write: `create_file_by_path` (agent route only) takes the type from the caller's `contentType`, else the name's hint, else plain text (`files_default_text_shape_for_name`). It refuses only a type that is not editable text (`Content type '...' is not an editable text type`).
- Public write routes: `/files/write`, `/files/write-many`, and `/files/touch` take the caller's `contentType`, else the name's hint, else plain text (`files_default_text_shape_for_name` in `public_api.ts`).

A committed collaborative service upload is a normal editable file after conversion. A committed
non-collaborative service upload has the same chunks and version history but no Yjs docs. The service
`delete` route archives either form and keeps its content, snapshots, metadata, and R2 asset. Only an
unfinished service placeholder may use `files_nodes_db_hard_delete_node`.

The sidebar New-file flow creates a Markdown file with a default name, and a rename (`rename_node`, the pending-move proposal, and accept) keeps the stored content type, so no name can move a file to another type. Files of other types enter the workspace through uploads, the agent's write doors, and the public write routes. An extensionless destination is a valid rename target, which keeps mixed file/folder swap cycles working.

`data_import.create_upload_targets` (`packages/app/convex/data_import.ts`) is not a third path, by decision: it mints its assets with `processingWorkId: null`, so the R2 event finalizer records the object and never starts the editable-text conversion. An operator import stays a stored blob whatever its name.

Upload conversion keeps the original upload asset id until its final mutation. That mutation first
accepts an exact repeated publish, then checks that the node still uses the original upload. If the
node was deleted or replaced while R2 writes ran, it removes only that action's unpublished output.
It leaves saved snapshots alone. A later read-only lock still allows the accepted upload to finish.

# Generic Text Function Names

Editable create publishes the node, Yjs pointers, both live asset references, and the first version snapshot in one `create_file_node` mutation. The action waits for both initial R2 PUTs before failure cleanup, then hands every possibly written exact key to the durable deletion ledger. There is no second creation-finalizer mutation and no committed half-published editable file.

These six Convex functions serve both rich Markdown and plain-text files. Their generic names match that shared role:

- `create_text_node` (`files_nodes_content.ts`, the only public one)
- `get_file_text_content_db_state_by_path` (`files_nodes_content.ts`)
- `get_file_last_available_text_content_by_path` (`files_nodes_content.ts`)
- `finalize_text_file_node_from_r2_assets` (`r2.ts`)
- `finalize_uploaded_text_file` (`r2.ts`)
- `match_text_file_lines` (`files_nodes.ts`)

Exact content uses `files_text_chunks.textChunk` for both document shapes. Search rows link to those chunks through `files_plain_text_chunks.textChunkId`.

# Related Skills

- `../files-agent-pending-updates/SKILL.md` — the paged pending-state pipeline that door 2 protects.
- `../convex-admin-ops/SKILL.md` — the operator runbook for the markers and the repair action.
- `../ai-chat-agent/SKILL.md` — the agent tools that read and write both shapes.
- `../file-metadata/SKILL.md` — the flat key-value map stored next to a file. It is not part of the document, so neither write door sees it, but it shares the read-only lock and the `content.write` permission.
- `../public-api/SKILL.md` — the public routes; `/files/write` accepts every editable text type.
