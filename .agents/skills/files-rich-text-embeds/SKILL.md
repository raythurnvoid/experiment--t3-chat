---
name: files-rich-text-embeds
description: Spec for image and video embeds in rich text documents — the bonobo-file:// reference format, the dual extension-set contract, the node-view state machine, the paste/drop/slash upload flow, and the onConflict naming rules. Use when changing media embed rendering, the editor upload flow, the media slash commands, or the shared image/video nodes.
---

# Source Of Truth Files

- `../../../packages/app/shared/files-tiptap.ts` (`#region media embeds` — the image and video nodes)
- `../../../packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text-media-extension.ts` (node views)
- `../../../packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text-media-upload.ts` (paste/drop/picked upload flow)
- `../../../packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text-media-insert.tsx` (slash-command insertion UI)
- `../../../packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text-tools-slash-command.tsx` (media slash items)
- `../../../packages/app/src/lib/files-media-src.ts` (reference parsing and signed-url resolution; its cache also serves the chat agent's generated pictures)
- `../../../packages/app/src/lib/files-image-compression.ts` (client-side image compression, shared with the sidebar)
- `../../../packages/app/convex/files_nodes.ts` (`create_upload_node`, `discard_failed_upload_node`, `get_authorized_by_path`)

# Reference Format

A document never stores media bytes or signed urls. An embed's `src` is one of:

- `bonobo-file://<fileNodeId>` — a workspace file. The markdown form is
  `![alt](bonobo-file://<id>)` for images and `<video src="bonobo-file://<id>"></video>` for
  videos (markdown has no video syntax, so the video node serializes as a raw tag).
- A plain external `http(s)` url.

Signed R2 urls live for 15 minutes, so one written into a document would be dead on the next
open. The node view resolves a reference to a signed url only while the embed is on screen,
with a capped in-memory cache (`files-media-src.ts`).

# The Dual Extension-Set Contract

The image and video nodes live in `files_get_tiptap_shared_extensions()` in
`shared/files-tiptap.ts`, NOT in the editor. Convex serializes Yjs documents to markdown with
that same shared set, and a node type missing from it is silently dropped from the saved
markdown. The client registers the same node objects (`extensions.ts`), and the editor-only
parts — node views, upload flow, insertion UI — layer on top as separate extensions.

Shape caveat: this serialization story is true for `rich_text` documents only. A `plain_text`
document (every editable text file that is not `.md`) has no ProseMirror tree and consults no
extension set — its text projects byte-for-byte from the `Y.Text` root. Do not look for a
plain-text path in the extension list; it does not exist. See `../files-editable-text/SKILL.md`.

Node attributes: `src`, `alt` (image only), `title` (image only), and `uploadId` with
`rendered: false`. `uploadId` marks this browser's in-flight upload; it never reaches the
saved markdown, but it does persist in the Yjs doc until the flow clears it.

# Node-View State Machine

`MediaNodeView` (plain DOM, ProseMirror plugin `nodeViews`) renders one of:

- `uploading` — the node has an `uploadId` and no `src` (this browser's own upload).
- `processing` — a `bonobo-file://` reference whose asset has no `r2Key` yet and whose
  `unfinalizedExpiresAt` (24h TTL) has not passed. The asset is watched via
  `app_convex.watchQuery(r2.get_asset_by_file_node_id)`, so the embed swaps to `ready` without a reload when
  the R2 event confirms the object (~seconds in dev).
- `ready` — `r2Key` set (signed url minted) or an external url.
- `failed` — the asset stayed unfinalized past the TTL. Nothing cleans this up; the reader is
  told. The remove affordance is deliberately out of scope.
- `missing` — no node, no asset, no read access, or an unsupported scheme.
- `broken` — the element fired an error while loading.

Scheme safety lives entirely here: the shared nodes' `parseHTML` accepts any `img[src]` /
`video[src]`, and `files_media_parse_src` classifies everything that is not `bonobo-file://`
or `http(s)://` as unsupported, which renders as `missing` and never puts the value on the
DOM element. External images also get `referrerPolicy: "no-referrer"`. The external-URL slash
items keep an http(s)-only gate as the required second gate at insertion time.

# Upload Flow (paste, drop, /image, /video)

`file-editor-rich-text-media-upload.ts` owns the flow. Key rules:

1. Only `image/*` and `video/*` files are handled; other files fall through to ProseMirror's
   default (which is nothing — the app has no attachment support). Plain text pastes are
   untouched.
2. The placeholder node (`{ src: "", uploadId, alt }`) is inserted synchronously before the
   first await. Positions go stale across awaits, so every later step re-finds the node by
   scanning for its `uploadId`.
3. Images are compressed client-side first (`files_prepare_image_upload_file`, same helper as
   the sidebar; returns the original on any decode error). Videos upload as-is.
4. Uploads land in an `assets` folder that is a sibling of the document: probe with
   `get_authorized_by_path` (join paths with the root-aware helper — a root parent's path is
   `/`, and naive concat produces `//assets` which matches nothing), create the folder when
   missing, fall back to the document's parent folder when a file squats on the name or the
   folder refuses writes (the probe authorizes `content.read` only, so writability is only
   discovered at create time via `Permission denied`).
5. Names: clipboard pastes become `pasted-image-YYYYMMDD-HHMMSS.png` (the browser calls every
   pasted bitmap `image.png`); dropped and picked files keep their normalized name
   (`files_normalize_upload_file_name` — raw names may carry path separators, which
   `create_upload_node` would treat as folder segments).
6. `create_upload_node` is always called with `onConflict: "fail"`. The editor must never
   replace a file on a name collision, because the existing file may be another document's
   embed. On a collision the flow probes free `name 2.ext` style names with the free path
   query and retries — mutations are capped (~10) because each one charges the shared
   `files_tree_write` bucket (50/min).
7. `Rate limit exceeded` from the create stops the rest of the batch with one toast.
8. On a failed PUT, call `discard_failed_upload_node` FIRST and branch: `removed: true` →
   remove the embed and toast; `removed: false` → the R2 event recorded the object first, so
   the file and the embed both stay. The discard is metered on the `files_bulk_import` bucket
   and can answer `Rate limit exceeded` with `retryAfterMs` — wait it out in a loop.
9. If the node is gone from the doc mid-flight (undo, collaborator delete): stop; if the
   create already ran, still run the discard branching. `uploadId` is cleared once the PUT
   settles.

Multi-file batches run sequentially so collision suffixes stay deterministic. Deleting a
document does not delete its assets folder — no repair or cleanup logic exists on purpose.

# Insertion UI (slash menu)

Five items sit next to the Youtube item in
`file-editor-rich-text-tools-slash-command.tsx`:

- `Image` / `Video` — `editor.commands.filesMediaPickUpload(kind)` opens a hidden
  accept-scoped file input; picked files run the upload flow above at the caret.
- `Embed file` — `editor.commands.filesMediaEmbedExisting()` opens a caret-anchored
  `MySearchSelect` picker listing workspace nodes whose `contentType` starts with `image/` or
  `video/` (data: the same `files_nodes.list_tree` subscription the sidebar holds — Convex
  dedupes identical subscriptions; the picker mounts only while open). Picking inserts the
  `bonobo-file://` reference with the file name as alt — no upload, no byte copy.
- `Image from URL` / `Video from URL` — `prompt()` like the Youtube item, http(s)-only,
  insert an external embed. Kind is chosen by the item, never sniffed from the url.

The commands live on `file_editor_rich_text_MediaInsertExtension`, which is configured with
component-owned callbacks in `FileEditorRichTextInner` (the file-input click must run inside
the user gesture). The picker pins `value=""` because Ariakit adopts the first item's value on
mount when no value is given, which would fire `setValue` and insert an unpicked embed.

# Read-Only Documents

- Hide or disable paste, drop, picker, slash upload, external embed, and existing-file embed actions
  when the document is read-only. Check the document again before `create_upload_node`. This prevents
  a locked document from creating a separate asset file. The `assets` destination must also be
  writable.
- Creating the asset node accepts the upload. If the asset destination locks before its R2 event, the
  upload still finishes and the asset file stays locked. Adding the embed to the document is a
  separate write. If the document locks before that write, keep the visible asset file and explain
  that the file uploaded but was not inserted.
- Creating or resolving an anchored comment is disabled because it changes a Yjs mark. Reading and
  replying to an existing sidecar thread stays available under the comment ACL.

# Out Of Scope (decided)

Youtube/Twitter markdown persistence, content-hash dedupe, Monaco inline previews,
alt-editing UI, image resize (Novel's `ImageResizer` never attaches to the wrapper-span node
views), the `failed`-embed remove affordance, and video compression (none exists in the
sidebar either).

# QA

Harness recipes: `.agents/skills/app-playwriter-harness/references/files.md`, section "Rich
Text Image And Video Embeds" (selectors, state classes, paste/drop event simulation, slash
flows, reactive-swap proof).
