---
name: files-editable-text
description: Spec for editable text files and their Yjs shape system — the extension classifier, the stored `yjsRootKind`, the read-side shape guards, the write doors, the collaborative/non-collaborative flag and its two toggles, the size limits, the four durable refusal markers, and the operator repair path. Use when changing the classifier or editor maps in `packages/app/shared/files.ts`, the shape guards or update scans in `packages/app/shared/files-yjs.ts` / `files-tiptap.ts`, the Yjs write doors or materialization markers in `packages/app/convex/files_nodes.ts` / `files_nodes_content.ts`, the plain-text chunker, or upload text conversion in `packages/app/convex/r2.ts`.
---

# The Two Document Shapes

Every editable text file has a Yjs document in one of two shapes (`files_YjsRootKind` in `packages/app/shared/files.ts`):

- `rich_text`: the ProseMirror document Markdown files use. Root name: `default`.
- `plain_text`: a flat `Y.Text` document every other editable text file uses. Root name: `plain_text`.

The root names live in `files_YJS_DOC_KEYS` (`packages/app/shared/files.ts`). Markdown keeps the rich text editor. The other 19 extensions open in the Monaco "Code" editor.

# The Extension Classifier

Everything derives from the file NAME's extension and only the extension. The client-declared media type is unvalidated input and must never pick a shape or a served type. All in `packages/app/shared/files.ts`:

- `files_get_editable_text_content_type(fileName)`: the stored media type, or `null` when the name is not editable text. The 20 editable extensions: `md`, `txt`, `log`, `json`, `jsonc`, `yaml`, `yml`, `toml`, `ini`, `csv`, `tsv`, `css`, `js`, `mjs`, `cjs`, `jsx`, `ts`, `tsx`, `sh`, `sql`.
- `files_get_editable_text_yjs_root_kind(fileName)`: `rich_text` for `.md`, `plain_text` for the other 19, `null` otherwise.
- `files_editable_text_refusal_message(fileName)`: the one refusal text every write surface shows for a non-editable name, so the agent learns the supported list instead of retrying blindly.
- `files_get_monaco_language_id(fileName)`: the Monaco language per extension; unmapped names render as plain text.
- `files_get_signed_download_serving(fileName)`: the response headers every signed R2 download must pin. Only the literal media map serves inline; everything else — editable text, `svg`, `html`, unknown — downloads as an attachment. A presigned R2 GET carries no nosniff and no CSP, so this pinned type plus the disposition is the whole defense against hostile bytes running on the shared R2 origin.
- The extension rule matches `files_lowercase_extension` in `packages/app/convex/files_nodes.ts`: a leading-dot name like `.gitignore` and a trailing-dot name have no extension.

# The Stored `yjsRootKind`

`files_nodes.yjsRootKind` (`packages/app/convex/schema.ts`) stores the shape when the node is created. Absent means the node is NOT editable text: folders, stored blobs, and read-only mounts leave it unset and have no Yjs document. There is no default. Never read a missing field as `rich_text` — `node.yjsRootKind ?? "rich_text"` would classify every folder, stored blob, and read-only mount as a Markdown file and send it into the Markdown chunker and the frontmatter indexer. `files_node_has_editable_text_content` refuses a node without the field, which is why this field, not the Yjs pointers, is what marks a node as an editable text file.

Reads never re-derive the shape from the name. Every read, write, chunker dispatch, and guard passes `node.yjsRootKind` through directly, narrowed by the `files_node_has_editable_text_content` type guard. There is no accessor helper wrapping the field, so do not look for one.

The name classifier `files_get_editable_text_yjs_root_kind(fileName)` answers a different question, and it answers it about a NAME the caller is proposing, never about a stored node. It runs where a name is being chosen: the create paths, upload conversion in `r2.ts`, the sidebar's own create and upload prepare, and the rename class rule (`files_validate_file_rename_class`), which asks what the new name would mean and compares that against the stored field. The name decides the shape once, at creation; after that the stored field is the answer.

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
- Non-collaborative: the file has NO Yjs document. No snapshot doc, no sequence doc, no update log, no materialization. Only the committed chunks, the content asset, and the version history exist. The file is still editable: a save replaces the whole text. Every save names the content asset it loaded. If another save changed that asset, the stale save is refused and the editor tells the user to copy local changes before reloading.

`yjsRootKind` stays set on a non-collaborative file. It still decides Markdown versus plain text for the chunker, the editor choice, the rename class rule, and the copy class rule, and turning collaboration back on needs it to rebuild the right document shape.

Two predicates in `packages/app/shared/files.ts` ask the two different questions, and picking the wrong one is the main bug risk in this area:

- `files_node_has_editable_text_content(node)` — kind `file`, has `assetId`, has `yjsRootKind`. True for BOTH modes. This is the "is this editable text" question: reads, the editor choice, the class rules, and every not-a-stored-blob fork.
- `files_node_has_editable_yjs_state(node)` — the same three plus `yjsSnapshotId` and `yjsLastSequenceId`. True only for a collaborative file. This is the "does this have a Yjs document" question: the Yjs doors, materialization, pending proposals, and snapshot restore.

## The third write door

`replace_file_content` (`packages/app/convex/files_nodes_content.ts`) is the only **user and agent** content-write door for a non-collaborative file. It is an action plus a final mutation, because a Convex mutation cannot reach R2 and this door writes a new version snapshot object. Named plugin file-projection replace is a separate internal door. It copies store text into a locked derived file and does not go through this helper.

- The action checks auth and credits, runs the text cap and the frontmatter preflight, and PUTs the new content object. Over-cap frontmatter is refused with `Too many frontmatter fields`, the same words as the pending-update preflight: both are doors where a person hands over a whole text and can shorten it after reading the message. Materialization cannot refuse anybody, so it settles with the marker pair instead — see the `file-metadata` skill.
- `finalize_file_content_replacement` re-runs auth → membership → ACL `content.write` → read-only lock → staleness, then replaces the chunks, points the node at the new asset, stores the version snapshot, and emits the `file_save` billing event.
- Staleness is `baseAssetId`: the caller names the asset its text came from, and the door refuses when the node no longer points at it. The success value carries the NEW asset id, so an editor that stays open can save again at once instead of waiting for the reactive node doc to arrive.
- The door refuses a collaborative file. That file's text lives in its Yjs document, and replacing the chunks under it would leave the two disagreeing.

## The two toggles

Both live in `packages/app/convex/files_nodes_content.ts`. Both need ACL `content.write`, because changing the mode changes how the file is written. Both are refused by the read-only lock, and both are rate-limited on `files_tree_write`. Calling either one on a file already in that mode succeeds and does nothing, like `set_node_read_only`.

`set_file_non_collaborative` (mutation) turns collaboration OFF and is destructive:

- It needs `acknowledgeDropCollaborativeHistory: true`, checked before anything is read or written.
- It deletes the Yjs snapshot doc, the sequence doc, the whole update log, the superseded Yjs snapshot object, the saved-sequence markers (`files_pending_updates_last_sequence_saved`, which count in the deleted document's sequence numbers), and the staged content of every pending update. The comment docs in `chat_messages` are NOT deleted, but the marks that pinned them to the words are, so the threads disappear from the file and nothing can bring them back. The committed text, the version history, and the file metadata survive. The confirmation dialog names all three losses: history, comments, and proposals waiting for review.
- It clears the three markers that describe the deleted document: `contentShapeMismatchAt`, `contentYjsStateTooLargeByteSize`, and `contentTooLargeByteSize`. The last one is set when the text INSIDE the document grew past the cap, so the committed text this toggle keeps is the older one that still fit, and leaving the marker would show a permanent "too large" banner on a file that is now small. If the toggle also drops newer unmaterialized state, it clears the frontmatter marker pair because those counts describe the dropped state, not the older committed text.
- It refuses a file that still has unmaterialized updates: "This file is still saving. Try again in a moment." The committed text only reaches the last materialized sequence, so deleting the log now would silently drop everything typed after it. A file carrying `contentShapeMismatchAt`, `contentYjsStateTooLargeByteSize`, or `contentTooLargeByteSize` is the exception: normal materialization cannot close that gap, so asking the user to wait would be a lie, and the toggle goes ahead. The temporary frontmatter marker pair is not an exception. A later fitting edit can clear it, so the toggle must wait rather than drop newer text.
- The mutation records the old sequence-doc id in `collaborationCleanupYjsLastSequenceId` before it schedules paged cleanup. Turning collaboration back on refuses while old Yjs snapshot or update docs still exist. If cleanup removed every old doc but failed before clearing the marker, the enable path clears that stale marker in its final transaction. Cleanup only deletes docs owned by that exact sequence doc, so old numeric sequence ranges cannot cross into a new document whose sequence restarts at zero.
- It refuses a file that is still an eager-created pending node: "Accept or discard this new file before turning collaboration off." Such a node without a `yjsLastSequenceId` could never be hard-deleted again, so discard, expiry, and account deletion would all skip it and the sidebar would show it as "Added" forever.

`set_file_collaborative` (action) turns collaboration ON without deleting committed history. It reads the committed content object, builds one fresh compact document for the stored `yjsRootKind`, and commits the text that new document produces — not the text that went in, because building a rich document normalizes Markdown. It borrows the operator repair's split (the action PUTs, the mutation publishes) but is built on the CREATION path: the repair patches Yjs docs a file already has, and this file has none. Its preflight returns the node's `readOnlyScopeNodeId` so the lock is answered BEFORE the two uploads; the publish mutation asks again, because somebody can lock the file while the objects upload.

Every live writer carries the exact current `yjsLastSequenceId`, and materialization, restore, repair, and marker workers carry both exact Yjs pointer ids. Incremental reads also return this id, so a client never joins a snapshot from one lineage to update rows from another. Sequence numbers restart after a mode toggle, and repair rotates the exact last-sequence id even though it keeps the numeric target. The numbers alone do not identify a document lineage. Work from an older lineage must refuse or become a no-op before it changes rows or markers. Every bounded row-cleanup continuation carries the same exact id; superseded-asset cleanup stays independent because it reference-checks the asset before deleting it.

The two toggles answer a permission refusal with different words, and that is not an oversight: the mutation asks the permission question itself and bubbles the shared helper's `Permission denied`, while the action only learns that its preflight query said no and answers `Not found` for every reason, exactly like `restore_snapshot_r2`.

## Where the mode comes from

There are exactly four sources. Nothing else sets the flag.

- `POST /api/v1/files/write` and `/write-many` accept an optional `nonCollaborative` boolean in the body. It is read only when the write CREATES the file; a write over a file that already exists keeps the mode that file has. See the `public-api` skill.
- The Collaboration checkbox in the Properties dialog (`packages/app/src/components/files/files-properties-modal.tsx`). Either direction remounts the editor, so the dialog confirms that only last-saved text is used and warns the user to save open editor changes first. The OFF confirmation also names the deleted history, comments, and pending proposal text.
- A sealed service `create-target` request with required `nonCollaborative: true`. The filename must
  pass the normal editable-text classifier. The choice stays on the service target while the empty
  placeholder is a blob, then successful conversion publishes the flag.
- Named plugin file-projection create in `packages/app/convex/plugins_projections.ts`. It inserts a
  non-collaborative Markdown file with a content/version R2 object (same as other non-collab creates).
  Only the projection doors call it. `create_file_by_path` is unchanged and still creates a collaborative file.

Member uploads never create a non-collaborative file. A service upload and file projection are the
narrow exceptions. After
classifier, UTF-8, NUL, size, document-build, and frontmatter handling succeeds, a service upload publishes chunks,
one content/version snapshot and one file snapshot, with no Yjs asset, snapshot, sequence, or update
docs. A deterministic fallback stays a blob, preserves any service lock provenance, and leaves the
node flag unset. There is still no lazy Yjs creation: a collaborative file gets its document eagerly.

## What the editors do

`files_resolve_effective_editor_view` (`packages/app/src/lib/files.ts`) sends every view of a non-collaborative file to the plain text editor, whatever its `yjsRootKind`. The rich text editor is built on a Yjs document and the diff view compares a proposal against one, so neither can open a file that has none. Monaco edits an ordinary string instead: the toolbar shows Save, and Save calls `replace_file_content`. There is no Sync button, because there is nothing to sync. Restoring an old version from the snapshots dialog also goes through the replace door.

The editor loads its text with `get_non_collaborative_file_content`, which returns the committed text and the asset that text came from in one query, so the two cannot straddle somebody else's save.

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

Only two paths create a `plain_text` node:

- Upload conversion: `finalize_uploaded_text_file` (`packages/app/convex/r2.ts`) classifies from the node NAME and converts every editable text upload (`.md` to rich, the other 19 to `Y.Text`). Deterministic failures (unrecognized name, over-cap, invalid UTF-8, NUL bytes, refused document build) fall back to a stored blob through `settle_upload_conversion_fallback`, which dispatches the upload plugin event — only a successful conversion suppresses it. Service uploads (`/api/v1/files/service-uploads/*`) feed the same conversion: their create-target leaves `processingWorkId` unset for editable-text names, but their fallback blob dispatches no plugin upload event (see the `public-api` skill). Over-cap FRONTMATTER is not a fallback: the markdown itself is valid, so the upload still converts — the finalize mutation mirrors the materializer's preflight, commits the chunks without the metadata index, and publishes with the frontmatter marker pair set, so the insert backstop can never throw inside the infinite-retry conversion workpool.
- Agent write: `create_file_by_path` (agent route only) derives shape and media type from the classifier and refuses unknown extensions with `files_editable_text_refusal_message`.

A committed collaborative service upload is a normal editable file after conversion. A committed
non-collaborative service upload has the same chunks and version history but no Yjs docs. The service
`delete` route archives either form and keeps its content, snapshots, metadata, and R2 asset. Only an
unfinished service placeholder may use `files_nodes_db_hard_delete_node`.

There is deliberately NO in-app create path: the sidebar New-file flow creates Markdown only, and the rename rule (`files_validate_file_rename_class` in `packages/app/shared/files.ts`, enforced by `rename_node`, pending-move proposal, and accept) never lets a name cross the Markdown/plain class. That strictness is why no in-app path is needed — a `.md` file can never be renamed into a `.json` file, so the UI has nothing to route. Renames inside the plain class (`json` → `yaml`) are allowed and patch the classifier `contentType` with the name. An extensionless destination claims no class, which keeps mixed file/folder swap cycles working.

`data_import.create_upload_targets` (`packages/app/convex/data_import.ts`) is not a third path, by decision: it mints its assets with `processingWorkId: null`, so the R2 event finalizer records the object and never starts the editable-text conversion. An operator import stays a stored blob whatever its name.

# Generic Text Function Names

Editable create publishes the node, Yjs pointers, both live asset references, and the first version snapshot in one `create_file_node` mutation. The action waits for both initial R2 PUTs before failure cleanup, then hands every possibly written exact key to the durable deletion ledger. There is no second creation-finalizer mutation and no committed half-published editable file.

These six Convex functions serve both rich Markdown and plain-text files. Their generic names match that shared role:

- `create_text_node` (`files_nodes_content.ts`, the only public one)
- `get_file_text_content_db_state_by_path` (`files_nodes_content.ts`)
- `get_file_last_available_text_content_by_path` (`files_nodes_content.ts`)
- `finalize_text_file_node_from_r2_assets` (`r2.ts`)
- `finalize_uploaded_text_file` (`r2.ts`)
- `match_text_file_lines` (`files_nodes.ts`)

Exact content uses `files_text_chunks.textChunk` for both document classes. Search rows link to those chunks through `files_plain_text_chunks.textChunkId`.

# Related Skills

- `../files-agent-pending-updates/SKILL.md` — the paged pending-state pipeline that door 2 protects.
- `../convex-admin-ops/SKILL.md` — the operator runbook for the markers and the repair action.
- `../ai-chat-agent/SKILL.md` — the agent tools that read and write both classes.
- `../file-metadata/SKILL.md` — the flat key-value map stored next to a file. It is not part of the document, so neither write door sees it, but it shares the read-only lock and the `content.write` permission.
- `../public-api/SKILL.md` — the public routes; `/files/write` stays Markdown-only by contract.
