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
- `../../../packages/app/shared/files-media.ts` (saved/private reference parsing and builders)
- `../../../packages/app/src/lib/files-media-src.ts` (signed-url resolution and saved-media cache)
- `../../../packages/app/convex/r2.ts` (`get_media_by_reference`, current media access)
- `../../../packages/app/src/lib/files-image-compression.ts` (client-side image compression, shared with the sidebar)
- `../../../packages/app/convex/files_nodes.ts` (`create_upload_node`, `discard_failed_upload_node`, `get_authorized_by_path`)
- `../../../packages/app/convex/files_share_links.ts` (public link page: media checks and signed URLs)
- `../../../packages/app/shared/files-share-rich-text.ts` (public schema, media map, alt rules)
- `../../../packages/app/src/components/files/files-share-page.tsx` (public media node views)

# Reference Format

A document never stores media bytes or signed urls. An embed's `src` is one of:

- `bonobo-file://<fileNodeId>` — a workspace file. The markdown form is
  `![alt](bonobo-file://<id>)` for images and `<video src="bonobo-file://<id>"></video>` for
  videos (markdown has no video syntax, so the video node serializes as a raw tag).
- `bonobo-file://private/<privateNodeId>` — a stable draft reference. Before Save, only the
  draft owner can resolve ready media. After Save, the permanent saved-origin index resolves
  the same reference under the saved file's current access rules. Draft receipt cleanup does
  not break it. Resolution stays inside the requested workspace; the ID grants no access.
- A plain external `http(s)` url.

Signed R2 urls live for 15 minutes, so one written into a document would be dead on the next
open. The node view resolves a reference to a signed url only while the embed is on screen,
with a capped in-memory cache for saved media (`files-media-src.ts`). That cache includes
membership, file, and asset identity. Private media URLs are never cached; signing checks
the exact proposal revision and creation generation.

# Copy And Save

Cross-workspace Copy rewrites only real rich-text image/video embeds. The media must be selected
explicitly, directly or through a selected folder. Plain links and code do not import media.
New media copies have destination-owned assets and use destination access.

Mappings are sealed paged sets, not arrays on the document. A rich-text Copy gets a set even with
no embeds, so an embed added before Save still gets checked. Copy adoption and Save pin exact
accepted text and current media/access versions. Removing an embed removes its Save requirement.
Adding or changing one needs a fresh check. Large Copy review saves selected media first; it never
silently selects it. Partial Save keeps the mappings needed by the remaining proposal.

The full contracts live in [pending updates](../files-agent-pending-updates/SKILL.md) and
[transfer runs](../files-explorer-tree/references/transfer.md).

# The Dual Extension-Set Contract

The image and video nodes live in `files_get_tiptap_shared_extensions()` in
`shared/files-tiptap.ts`, NOT in the editor. Convex serializes Yjs documents to markdown with
that same shared set, and a node type missing from it is silently dropped from the saved
markdown. The client registers the same node objects (`extensions.ts`), and the editor-only
parts — node views, upload flow, insertion UI — layer on top as separate extensions.
The four GFM table nodes (`#region tables` in `shared/files-tiptap.ts`) are another consumer of
this same contract, with their own browser-list schema test in
`file-editor-rich-text/extensions.test.ts`.

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
  `app_convex.watchQuery(r2.get_media_by_reference)`, so the embed swaps to `ready` without a reload when
  the R2 event confirms the object (~seconds in dev).
- `ready` — `r2Key` set (signed url minted) or an external url.
- `failed` — the asset stayed unfinalized past the TTL. Nothing cleans this up; the reader is
  told. The remove affordance is deliberately out of scope.
- `missing` — no node, no asset, no read access, or an unsupported scheme.
- `broken` — the element fired an error while loading.
- `incompatible` — the file's stored `contentType` no longer starts with `image/` (or `video/`
  for a video node). A whole-file copy or a restored version can replace the content of a file
  that keeps its id, so the same media query watches content type and asset identity together.

Each reference change or query update cancels the previous URL result. Access loss clears
the visible media. A late signing reply cannot restore an old image, video, or destroyed view.

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
8. Send every returned header on the direct asset PUT, including the signed `If-None-Match: *`.
   A 412 means the attempt already has an object. Keep the file reference, clear local transfer
   state, and let the asset watch confirm it. Do not discard or assume this PUT's body matches.
   On another failed PUT, call `discard_failed_upload_node` FIRST: `removed: true` keeps a local
   retry placeholder with no file reference; `removed: false` means the R2 event recorded the object
   first, so the file and embed stay. The discard is metered on the `files_bulk_import` bucket
   and can answer `Rate limit exceeded` with `retryAfterMs` — wait it out in a loop.
9. If the node is gone from the doc mid-flight (undo, collaborator delete): stop; if the
   create already ran, still run the discard branching. `uploadId` is cleared once the PUT
   settles.

Multi-file batches run sequentially so collision suffixes stay deterministic. Deleting a
document does not delete its assets folder — no repair or cleanup logic exists on purpose.

# Public Link Page

A document shared with "Anyone with the link can view" shows its images and videos only through
its own link. The page never calls `get_media_by_reference` and never uses the editor node views.
One server preparation (`db_prepare_share_link_view`) builds a media map, and the browser names a
media only by its index in that map.

The media map (`files_share_rich_text_prepare`):

- Only the decoded `src` of a real image or video element adds an entry. Plain text, code,
  frontmatter, and ordinary links never do. A link to a `bonobo-file://` address becomes the text
  `[file reference]`.
- The key is the media kind plus the exact reference. Indexes 0 to 49 follow document order, and
  the same pair reuses its index. An image and a video with the same reference are two entries.
- After 50 entries, and for a malformed or unsupported reference, the node gets a null index and
  shows as unavailable.
- An external `http(s)` image or video becomes a plain link. The page never loads a third-party
  resource by itself.
- Public image and video nodes carry only `index` and `alt`. They have no `src`, `title`, width, or
  upload ID.

An embed shows only when all of these hold (`db_read_media_node`, `db_check_media_node`):

1. It resolves to a saved file in the same organization and workspace. `bonobo-file://<id>` is
   normalized with `ctx.db.normalizeId`. `bonobo-file://private/<id>` resolves only through the
   permanent saved origin: `files_pending_nodes_db_resolve_read_target` must return `kind: "saved"`.
   An unsaved draft never shows, and no draft bytes are read. The owner-only branch of
   `get_media_by_reference` is never used, because a visitor has no identity.
2. The file is not archived. Its content type is in the inline-served media set
   (`files_is_inline_media_content_type`) and matches the node: an image node needs `image/*`, and a
   video node needs `video/*`. SVG and other types are unavailable.
3. It passes the same live checks as the shared document: no archived folder above it, no plugin
   binding on it or on a folder above it, no queued or running subtree job on its path, and a
   finished asset.
4. Same audience: its live restricted scope equals the document's live restricted scope. Both are
   open to the workspace, or both sit inside the same restricted folder.
5. No narrow writers, open scope only. Every service account with an exact `content.write` grant on
   the document must be live (not revoked, same tenant) and able to read the media file, through a
   workspace `content.read` grant or an exact file `content.read` grant. A revoked or missing account
   is never skipped. More than 50 such grants on either file makes the media unavailable.

Otherwise the view returns `{ index, available: false }`, with no type, name, ID, or reason. The page
shows a gray box, "This image is not shared" or "This video is not shared", from the node's own kind.
The editor often fills alt with the real file name, so only an available media keeps its alt, after
reference redaction. Every other media node has `alt: null`. When the document falls back to plain
text, the page has fixed `[image]` and `[video]` labels and no media at all.

The normal case works: uploads land in the `assets` folder next to the document (Upload Flow, step 4),
so they share its scope. An image from a more private or a differently restricted folder is
unavailable. A document inside a restricted folder that embeds an image from an open folder is also
unavailable, because people with only the folder grant may not read the whole workspace. This is
expected, not a bug. The fix is to move or copy the image next to the document.

Narrow-writer changes:

- Removing or downgrading a service account's exact `content.write` grant on the document ends the
  document's link for good (`access_control_db_set_service_account_grant`). The account may have added
  media while it could write, and the check no longer sees it.
- Revoking the account keeps its grant. So its media check fails and every media under rule 5 becomes
  unavailable, while the page itself stays.
- Recovery is a manager action: remove the revoked account's write grant, then turn the link on again.
  That creates a new token. The old token never works again.
- A new write grant needs no hook. The next view checks the new account.

Saved human, API, and plugin edits update the page. New media show when the rules above allow them.
A credential's download scope does not limit this: a key with `files:write` but no `files:download`
can add a readable image of the same audience, and the link then serves it. This is an approved rule.
No file becomes public just because someone knows its ID.

`create_share_link_download_urls({ token, revision, targets })` signs 1 to 50 unique targets. It
charges the `files_share_link_download` bucket (200 targets per minute, keyed by the link doc, shared
by all visitors) before the full preparation, and answers `stale` for an old revision. Media are
signed under a neutral name such as `image.png`, because the file's own name can be private. URLs
work for 15 minutes. A URL signed before the link was turned off, or before the media became
unavailable, keeps working until it expires. The page drops old URLs when the revision changes or a
media becomes unavailable, and asks for a new URL at most once per expired URL.

# Insertion UI (slash menu)

Five items sit next to the Youtube item in
`file-editor-rich-text-tools-slash-command.tsx`:

- `Image` / `Video` — `editor.commands.filesMediaPickUpload(kind)` opens a hidden
  accept-scoped file input; picked files run the upload flow above at the caret.
- `Embed file` — `editor.commands.filesMediaEmbedExisting()` opens a caret-anchored
  `MySearchSelect` picker with the shared `FilesNodePicker` body
  (`components/files/files-node-picker.tsx`). It browses one folder at a time, or searches names
  with `files_nodes.search_saved`, in pages of 50 with "Show more". It lists active, saved rows
  only. Files whose `contentType` does not start with `image/` or `video/` show disabled with the
  reason "This file is not an image or video", because the name search cannot leave them out. Folders open.
  Picking inserts the `bonobo-file://` reference with the file name as alt — no upload, no byte copy.
- `Image from URL` / `Video from URL` — `prompt()` like the Youtube item, http(s)-only,
  insert an external embed. Kind is chosen by the item, never sniffed from the url.

The commands live on `file_editor_rich_text_MediaInsertExtension`, which is configured with
component-owned callbacks in `FileEditorRichTextInner` (the file-input click must run inside
the user gesture). The picker has no value: the select never picks an option by itself, so only
a click or Enter on a row inserts an embed. It anchors to the caret through `anchorRect`.

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
