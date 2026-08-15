---
name: files-editable-text
description: Spec for editable text files and their Yjs shape system — the extension classifier, the stored `yjsRootKind`, the read-side shape guards, the two write doors, the size limits, the four durable refusal markers, and the operator repair path. Use when changing the classifier or editor maps in `packages/app/shared/files.ts`, the shape guards or update scans in `packages/app/shared/files-yjs.ts` / `files-tiptap.ts`, the Yjs write doors or materialization markers in `packages/app/convex/files_nodes.ts` / `files_nodes_content.ts`, the plain-text chunker, or upload text conversion in `packages/app/convex/r2.ts`.
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

`files_nodes.yjsRootKind` (`packages/app/convex/schema.ts`) stores the shape when the node is created. Absent means `rich_text` (nodes written before the field existed). Folders, stored blobs, and read-only mounts leave it unset and have no Yjs document.

Reads never re-derive the shape from the name. `files_get_node_yjs_root_kind(node)` (`packages/app/shared/files.ts`) resolves the stored field, and every read, write, chunker dispatch, and guard uses that value. The name decides the shape once, at creation.

# Read-Side Shape Guards

`files_yjs_doc_check_text_addressable` in `packages/app/shared/files-yjs.ts` is the read-side backstop both dispatchers run as their first statement (`files_yjs_doc_get_text` / `_update_from_text` / `_create_from_text` in `packages/app/shared/files-tiptap.ts`, which take a required `rootKind`).

- `plain_text` — the parity check: `toString().length` must equal `length`. `toString()` concatenates only string content, while `length` also counts embeds and child types, so the line diff can address the text by offset exactly when the two agree. Parity does not catch a `Y.Map` named `plain_text` (parity holds, reads `""`); the byte doors close that case, so do not delete a door check because "the getter already checks".
- `rich_text` — a name test: refuse when the `plain_text` root is present and the `default` root is absent. The test MUST read `share.has()` before any accessor call, in both directions: an accessor registers the root it reads, so `getXmlFragment` first makes the test allow a vandalised document, and `getText` first makes it refuse an ordinary empty Markdown document.

Refusal messages are stable `Result` values (`File text is not addressable`, `File document does not match its rich text shape`). The guard logs nothing; each caller logs with the node id it holds.

# The Two Write Doors

Door 1 — `files_db_yjs_push_update` (`packages/app/convex/files_nodes.ts`) checks every client-pushed incremental update as its FIRST statements, above every write: zero-byte refusal (a stored zero-byte update breaks every later merge; the two-byte v1 no-op stays legal), the 930,000-byte wire cap, then `files_yjs_scan_client_update` (`packages/app/shared/files-yjs.ts`). For `plain_text` that scan is a whitelist over the decoded v1 structs: only `Y.Item`s, only `ContentString`/`ContentDeleted` content (no `ContentFormat`), and `parentSub` must be null — a map-slot item would land in the plain root's `_map`, which door 2 refuses forever, and an asymmetry between the doors is a permanent brick. For `rich_text` the scan applies the update to a throwaway doc and refuses when it creates the `plain_text` root. V2-encoded and malformed updates are refused for both shapes. Only after the checks does the reserve gate bump the sequence and insert the update doc.

Door 2 — the pending-state seal (`packages/app/convex/files_pending_updates.ts`) checks every whole document state a client stages: non-empty, at most 4 MiB, v1 encoding, then the per-`rootKind` shape rule. The plain branch runs the parity check AND requires the plain root's `_map.size === 0` (`files_yjs_doc_plain_text_root_map_size`) — this is the root-map-size rule that closes the `Y.Map` hole parity cannot see. A whole state legitimately carries content an incremental plain diff never should, so door 1's content whitelist must not run on door 2's input.

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

# The Four Durable Refusal Markers

Fields on `files_nodes` (`packages/app/convex/schema.ts`; read the docblocks there for lifecycle detail):

- `contentShapeMismatchAt`: set when materialization finds the reconstructed document's shape does not match the node's `yjsRootKind`. Readers report a shape mismatch instead of content; the Yjs writers refuse more updates.
- `contentYjsStateTooLargeByteSize`: set when the reconstructed state passes the 4 MiB cap. Materialization does not advance, readers report the failure, and the Yjs writers refuse more updates.
- `contentFrontmatterTooLargeFieldCount` and `contentFrontmatterTooLargeIndexDocumentCount`: set as a pair when a materialization's frontmatter is over the 128-field or 512-index-document cap. Committed content stays at the last sequence that fit. The Files top status shows both stored counts and limits, so the user knows frontmatter indexing is paused. Cleared when the user reduces the metadata and a later materialization succeeds. An uploaded `.md` that converts with over-cap frontmatter is born with the pair already set (see the upload path below).

While `contentShapeMismatchAt` or `contentYjsStateTooLargeByteSize` is set, door 1 refuses every update with the repair message — accepting more would only grow the broken log. The pre-existing `contentTooLargeByteSize` (visible text over 900,000 bytes) is a settle marker, not one of the four: content freezes at the last fitting sequence, but writes continue. When an unmaterialized budget trips on a settle-marked file, the reserve gate returns the repair message instead of a false "retry in a moment", because a settled materialization never shrinks the counters.

Operator repair (`repair_file_yjs_state_from_visible_text` plus its staleness-gated `finalize_file_yjs_repair` in `packages/app/convex/files_nodes_content.ts`) is the ONLY recovery for the durable markers. It rebuilds one fresh compact document from the file's visible text, swaps every committed representation atomically, clears the markers, resets the counters, and increments `lineageGeneration` so pending proposals built against the old history become visibly stale. The old content asset stays under normal snapshot retention. Run it through the `convex-admin-ops` skill.

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

There is deliberately NO in-app create path: the sidebar New-file flow creates Markdown only, and the rename rule (`files_validate_file_rename_class` in `packages/app/shared/files.ts`, enforced by `rename_node`, pending-move proposal, and accept) never lets a name cross the Markdown/plain class. That strictness is why no in-app path is needed — a `.md` file can never be renamed into a `.json` file, so the UI has nothing to route. Renames inside the plain class (`json` → `yaml`) are allowed and patch the classifier `contentType` with the name. An extensionless destination claims no class, which keeps mixed file/folder swap cycles working.

`convex/data_import.ts:32-34` stays a Markdown-only dead end by decision: import-minted assets get `processingWorkId: null`, so imports never run the editable-text conversion.

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
- `../public-api/SKILL.md` — the public routes; `/files/write` stays Markdown-only by contract.
