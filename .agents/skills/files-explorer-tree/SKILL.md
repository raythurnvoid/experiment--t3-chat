---
name: files-explorer-tree
description: Practical guide for the current Files sidebar (`@headless-tree` + Convex) implementation. Use this when implementing or modifying sidebar behavior (search, selection, drag/drop, rename, archive/unarchive, create file/folder, and root-drop-zone interactions).
---

# Source Of Truth Files

Primary:

- `../../../packages/app/src/components/file-node-view/files-sidebar.tsx`
- `../../../packages/app/src/components/file-node-view/files-sidebar.css`
- `../../../packages/app/src/components/file-node-view/file-node-view.tsx`
- `../../../packages/app/src/components/file-node-view/file-node-view.css`
- `../../../packages/app/src/routes/w/$workspaceName/$projectName/files/index.tsx`
- `../../../packages/app/convex/files_nodes.ts`
- `../../../packages/app/convex/r2.ts`
- `../../../packages/app/shared/files.ts`
- `../../../packages/app/src/lib/files.ts`
- `../../../packages/app/vendor/headless-tree/packages/core/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/react-compiler/index.tsx`

# Architecture Overview

The Files sidebar is implemented in `files-sidebar.tsx` on top of `@headless-tree` with Convex-backed data.

- Tree engine: `@headless-tree/core` + `@headless-tree/react`
- Backend data: Convex `files` query/mutations
- Primary data source: `files_nodes.list_tree`
- Local state is UI-only (`expandedItems`, search/selection, busy/pending flags) plus derived indexes from query data
- Prefer Convex mutation `optimisticUpdate` over ad-hoc local mirrored tree state
- Backend item types: `"root" | "node"`
- Node kinds: `"folder" | "file"`
- Placeholder rows are UI-only render artifacts
- Uploaded source files are normal visible nodes; generated Markdown outputs are normal visible sibling file nodes.
- Source files open their stored-file/status screen; generated Markdown outputs open directly as ordinary files once finalized.

# Data Model And Contracts

- `files_TreeItem` shape is defined in `../../../packages/app/convex/files_nodes.ts`.
- `files_ROOT_ID` and `files_create_tree_root` are in `../../../packages/app/shared/files.ts` and re-exported by `../../../packages/app/src/lib/files.ts`.
- Backend returns root/node items only; placeholder rows are client-rendered.
- Folder nodes can have children, expand/collapse, and receive drops.
- File nodes are leaves. Markdown-backed files open in the editor; uploaded source files and pending generated outputs open stored-file/status metadata until they have editable Markdown state.
- Clicking a folder opens its folder screen. `FileNodeView` decides whether the selected node renders the folder explorer or the file editor, and folder screens embed an editable child `README.md` when present.
- Editable Markdown file nodes have `assetId`, a Markdown media type (`text/markdown`, regardless of charset parameters), Yjs rows, R2-backed committed Markdown assets, Markdown chunks, plain-text chunks, and snapshots.
- User-created Markdown files and the auto-created home `README.md` are seeded by the Convex create action with `files_INITIAL_CONTENT`; the rich-text editor must not bootstrap initial Yjs content on the client.
- Uploaded non-Markdown source file nodes create an upload asset immediately, store the source `contentType` on the node, and get `r2Key` on the asset after the R2 object-create event confirms the source object exists.
- Uploaded Markdown files still upload directly to R2 through the signed PUT path. The R2 event finalizer then promotes the uploaded object into the ordinary editable Markdown shape by creating the Markdown asset, Yjs snapshot, chunks, and version snapshot.
- Generated Markdown outputs are normal visible file nodes created as siblings of the uploaded source during R2 event processing. PDF uploads create `<source-name>.md`; image uploads create `<source-name>.description.md`; video uploads create `<source-name>.summary.md` and `<source-name>.transcript.md`.
- Assets are the single R2 object metadata record for source binaries, live Markdown, compacted Yjs snapshots, and version snapshot Markdown. Owners point to assets; assets do not own relationships between source files and generated outputs.
- Source/conversion metadata stays in DB/R2 metadata, not visible generated Markdown.
- Upload status is derived in the UI from the selected node and its asset: missing `r2Key` is waiting for upload, `conversionWorkId` means processing, and `null` means terminal.
- R2 asset keys use `workspaces/<workspaceId>/projects/<projectId>/assets/<assetId>` for every asset kind. Convex uses `files_r2_assets.kind` to decide upload finalization behavior.
- Upload max is 50 MiB; converted Markdown max is 900,000 characters.

# Uploaded Source And Generated Files

- Upload creates a visible source file node immediately.
- While upload/conversion is pending, opening the source shows stored-file status such as waiting or processing.
- R2 event processing for PDF, image, and video uploads creates visible generated Markdown sibling placeholders before queueing conversion or AI media processing.
- Opening a generated placeholder before finalization shows stored-file/status metadata. After finalization, opening it renders the normal Markdown editor.
- Replacing an uploaded source archives only the conflicting source path. Generated output conflicts are handled when the R2 event creates planned output names.
- Rename, move, archive, and unarchive treat generated outputs as ordinary independent files. Moving a pending generated output after enqueue does not break finalization because the conversion job targets output node ids.
- Archiving a source upload should keep the original R2 object; permanent tenant purge deletes R2 objects for every `files_r2_assets` row before deleting the rows.
- Browser-side source uploads try to compress static JPEG/PNG/WebP images before `files_nodes.create_upload_node`; keep the original file when compression fails or is not smaller. Animated GIFs must keep the original blob so animation is not destroyed, but still use the image-description generation path.
- Rich-text image uploads should create visible upload nodes next to the document where the image was inserted and use the same R2 source/generated-output conversion model.
- If conversion fails, keep the source and generated output placeholders visible in their last durable asset state. Cleanup/recovery for abandoned or failed reservations is intentionally still a TODO.
- Conversion rerun is not a normal product flow; if a forced rerun is added later, it may overwrite generated outputs by node id.

Known gaps:

- Rich-text image upload currently posts to legacy `/api/upload`; that is not the first-party R2 source/generated-output upload pipeline.
- Generated Markdown outputs are materialized to R2 using the same asset key shape as every other file asset. Convex keeps Yjs/update rows, chunks, snapshots, and asset pointers on the generated output node.

# Main Components

Main component:

- `FilesSidebar` (name retained to avoid a large route/component rename)
- `FileNodeView` owns the files route shell, sidebar panel, app-header breadcrumb, folder explorer branch, and file editor branch.

Main sections:

- `FilesSidebarHeader`
- `FilesSidebarSearch`
- `FilesSidebarTree`

Tree-item components:

- `FilesSidebarTreeItem`
- `FilesSidebarTreeItemArrow`
- `FilesSidebarTreeItemTitle`
- `FilesSidebarTreeItemIcon`
- `FilesSidebarTreeItemPrimaryContent`
- `FilesSidebarTreeItemPrimaryAction`
- `FilesSidebarTreeItemSecondaryContent`
- `FilesSidebarTreeItemActions`
- `FilesSidebarTreeItemSecondaryAction`
- `FilesSidebarTreeItemSecondaryActionCreateFile`
- `FilesSidebarTreeItemMoreAction`
- `FilesSidebarTreeItemTrack`
- `FilesSidebarTreeItemPlaceholder`

# State And Behavior Flows

## Server-Driven Data

- Sidebar queries `files_nodes.list_tree`.
- Tree collection maps/sets are derived from query results (`useMemo`) and rebuilt from server data.
- Loading/empty states are derived from query presence and visible IDs.

## Search

- Search input is debounced and consumed through a deferred query value.
- Visible IDs are computed from title matches plus ancestor chain inclusion.
- Ancestors of matched files/folders remain visible.
- Search-open snapshots expansion state and auto-expands relevant parents; search-close restores prior expansion.

## Selection And Primary Action

- Primary click implements single select, toggle-select, and shift-range.
- Non-modifier click runs primary action for node items.
- File primary action navigates to the file.
- Folder primary action navigates to the folder screen.
- In multi-select mode, selection anchor files active track highlighting.
- The current route/navigated row uses a stable row-left accent rail instead of bold text. Keep row labels regular weight so selection does not change text metrics. The rail belongs only to navigated rows. Internal Headless Tree focus and pointer hover are not selection and must not paint the selected row surface after pointer clicks; hover can brighten row text, while `:focus-visible` keeps the keyboard interaction surface. Idle non-selected rows use one quieter foreground shade and brighten to the navigated-row lightness on hover, selected, and navigated states. Keyboard focus must stay as the top visual layer: keep the focus ring continuous, keep the rail visible just inside it, and remove idle title input chrome so row names render as plain text outside rename mode. The disabled title input must inherit the row color; otherwise only icons dim while filenames remain too bright.

## Create, Rename, Archive, Unarchive

- Root actions create `New File` and `New Folder`.
- Folder row actions can create child files and folders.
- File rows do not show child-creation actions.
- Default generated names are sibling-aware: `new-file.md`, `new-file-2.md`, `new-folder`, `new-folder-2`.
- File and folder create support path-like names: missing parent folders are created first, then the final file/folder is created at that path.
- File create/rename input canonicalizes path segments in the frontend; backend path creation trusts those segments and only rejects an empty path.
- Rename input filters draft typing/paste/composition through shared live-name normalization: files and folders allow lowercase letters, digits, `/`, `.`, `-`, `_`; adjacent separators are blocked while typing; special file-name casing remains submit-time only.
- File and folder create/rename reject double-dot names; file names with a non-empty basename and a trailing dot are treated as missing the extension, while invalid extension text such as separators inside the final extension is rejected.
- Markdown file create/rename then applies the Markdown storage contract: extensionless file names get `.md`, and explicit alternate extensions are rejected.
- R2 source file upload/rename preserves the uploaded file extension for non-Markdown files, requires a real extension, and uses the normal tree node as the visible processing/finalized item instead of a dedicated upload list.
- Uploaded non-Markdown source file names are normalized with `files_normalize_upload_file_name`, which preserves the uploaded extension and uses only the last browser path segment. Uploaded Markdown names follow normal Markdown file normalization.
- Uploaded source file names must have a real extension: the dot cannot be the first or last character.
- Missing upload extensions open the rename upload modal.
- Upload path conflicts open the conflict modal; file conflicts support replace or renamed upload, while folder conflicts block replacement.
- File create/rename applies special file-name casing after normalization: `readme`, `readme.md`, and `README.md` store as `README.md`.
- File rename selects the basename by default so `.md` is not included in the initial edit selection.
- Rename uses `files.rename_node` with Convex `optimisticUpdate` for immediate title feedback.
- The selected file/folder path auto-expands in the sidebar after route changes and path-based create/rename moves so the focused row stays visible.
- Archive/unarchive uses `files.archive_nodes` / `files.unarchive_nodes`.

## Content Type Checks

- Trust app-owned content-type strings to be lowercase.
- Check Markdown content types inline with `contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false`.
- Use `"text/markdown;charset=utf-8" satisfies files_ContentType` when writing the canonical Markdown content type.
- Do not add shared helpers or constants for these Markdown content-type literals.

## Drag And Drop

- In-tree DnD uses headless-tree `onDrop` -> `files.move_nodes`.
- `canDrop` guards target kind, self-drop, and descendant-drop.
- Root and folders can receive drops.
- Files cannot receive drops.
- External OS file drops use headless-tree foreign DnD for tree targeting and `file-selector` for browser file extraction, then reuse the existing Upload file pipeline.
- External file drops are accepted only on the root drop zone, folder rows, and empty-folder placeholders.
- Dropped browser `File` objects are uploaded through `files_nodes.create_upload_node`, PUT to the signed R2 URL, then processed by the R2 event flow. Markdown media types and `.md` names are canonicalized as Markdown before upload so finalization creates the normal Markdown/Yjs/snapshot rows on the uploaded node.
- Keep external upload acceptance file-type neutral. Do not add MIME or extension allowlists beyond the existing non-Markdown uploaded-source requirement that a filename has a real extension.
- Reject multi-file and directory drops in the UI; v1 uploads one file at a time.

## Upload Lifecycle

1. User uploads one file through the menu or drops one external file onto an accepted target.
2. Frontend detects Markdown uploads by Markdown media type or `.md` name for upload normalization; backend conversion behavior is based on stored `contentType`, not filename. Static image uploads are prepared with browser `createImageBitmap` + canvas compression before the upload node is created, and the smaller compressed `File` is used only when it is smaller than the original.
3. Missing extension for non-Markdown uploads or any upload path conflict opens the upload draft modal.
4. `files_nodes.create_upload_node` validates membership, rate limit, parent folder/root, size, and conflicts.
5. Backend creates an upload `files_r2_assets` row without `r2Key` and creates the visible source file node with `assetId` and `contentType`.
6. Backend returns a signed R2 PUT URL and optional content-type header for the upload asset key.
7. Browser uploads the binary directly to R2.
8. R2 object-create events under the asset prefix flow through the upload finalizer Worker to Convex.
9. Convex parses the deterministic asset key from the R2 event, ignores non-upload asset kinds, patches `r2Key`/`etag`/`size` for upload assets, queues upload processing, and stores `conversionWorkId` on the asset.
10. For Markdown uploads, Convex reads the uploaded Markdown from R2, creates the normal Markdown asset, Yjs snapshot, chunks, and version snapshot, then patches the visible node into the same shape as an app-created Markdown file.
11. For PDF MIME uploads, Convex creates a generated sibling placeholder for `<source filename>.md`, archiving active name conflicts for that planned output name.
12. For image MIME uploads, Convex credit-gates media work, creates `<source filename>.description.md`, then an R2 Workpool action sends a short-lived signed R2 URL to OpenAI vision and writes the generated description as editable Markdown.
13. For video MIME uploads, Convex credit-gates media work, creates `<source filename>.summary.md` and `<source filename>.transcript.md`, then asks the Cloudflare Media Transformer Worker to extract sampled frames and bounded M4A audio segments from private R2. Convex transcribes sampled audio with OpenAI, summarizes transcript plus frame samples, and writes both outputs as editable Markdown.
14. If every Cloudflare audio sample fails and the original uploaded video is still within the OpenAI transcription byte cap, Convex downloads the original R2 object through a signed URL and transcribes that MP4 directly. This covers long compressed videos that exceed Cloudflare Media Transformations' source-duration limit while keeping larger uploads terminal instead of proxying unbounded bytes through Convex.
15. Modal converts only PDF R2 source objects to Markdown. Do not use Modal for image/video extraction.
16. Convex writes generated Markdown, compacted Yjs objects, and version snapshots to R2.
17. Convex patches the exact generated output node ids into editable Markdown files, clears conversion work, and writes chunks/snapshot rows.

# Headless-Tree Configuration Highlights

`useTree<files_TreeItem>` configuration includes:

- `rootItemId: files_ROOT_ID`
- controlled `expandedItems` + `setExpandedItems`
- `canReorder: false`
- sync data loader + selection + hotkeys + DnD + renaming + expand-all + click behavior + prop memoization features
- node-only `canDrag` and `canRename`
- folder-only `isItemFolder`
- guarded `canDrop`
- guarded `canDragForeignDragObjectOver` / `canDropForeignDragObject` for external file drops

# Architectural Invariants

1. Keep placeholder behavior client-only and non-mutable.
2. Keep tree record data server-driven from Convex query; do not introduce local mirror/fallback state.
3. Preserve ancestor-aware search visibility and search expansion-restore behavior.
4. Preserve custom selection semantics and selection-anchor behavior.
5. Keep DnD safety guards (self/descendant/kind) and root-zone feedback behavior.
6. Keep pending state split (`isBusy` and `pendingActionNodeIds`) for correct UI gating.
7. Prefer Convex optimistic updates over manual local tree patching.
8. Do not let file nodes act as folders.
9. Keep external file drops on the same upload lifecycle as the Upload file menu action: signed R2 upload first, then Markdown finalization or MIME-based generated output conversion.
10. Keep assets focused on R2 object metadata and file nodes focused on tree position, content pointers, snapshots, and archive state.

# Verification Checklist

- Tree updates come from `files_nodes.list_tree`.
- Search keeps ancestor chain for matching files/folders.
- Search-open expands relevant branches and search-close restores prior expansion.
- Selection modes and anchor behavior are correct.
- Root create can create a file and a folder.
- Folder create can create child files/folders.
- File rows do not show child creation actions and are not expandable.
- Rename guards and optimistic rename behavior are correct.
- Archive/unarchive and archived filter/toggle behavior is correct.
- DnD allows legal moves, blocks drops onto files, and root-zone feedback works.
- PDF external file drops onto root/folders create normal uploaded source file nodes and visible generated Markdown sibling files through the R2 conversion flow.
- Static image uploads are compressed in the browser when smaller, remain visible as source files, and create readable `<source>.description.md` siblings.
- Video uploads remain visible as source files and create readable `<source>.summary.md` and `<source>.transcript.md` siblings.
- Markdown external file drops onto root/folders use the same signed R2 upload path, then finalize into ordinary Markdown file nodes.
- External file drops onto file rows do not upload to the file's parent.
- Multi-file and directory external drops are rejected without creating nodes.
- Placeholder nodes are never sent to mutations.
- Normal tree/list/glob results expose uploaded sources and generated outputs as ordinary visible nodes.
