---
name: files-explorer-tree
description: Practical guide for the current Files sidebar (`@headless-tree` + Convex) implementation. Use this when implementing or modifying sidebar behavior (search, selection, drag/drop, rename, archive/unarchive, create file/folder, and root-drop-zone interactions).
---

# Source Of Truth Files

Primary:

- `../../../packages/app/src/components/files/files-sidebar.tsx`
- `../../../packages/app/src/components/files/files-sidebar.css`
- `../../../packages/app/src/components/files/files-name-input.tsx`
- `../../../packages/app/src/components/files/file-node-view/file-node-view.tsx`
- `../../../packages/app/src/components/files/file-node-view/file-node-view.css`
- `../../../packages/app/src/routes/w/$organizationName/$workspaceName/files/index.tsx`
- `../../../packages/app/convex/files_nodes.ts`
- `../../../packages/app/convex/r2.ts`
- `../../../packages/app/convex/plugins_runtime.ts`
- `../../../packages/app/shared/files.ts`
- `../../../packages/app/src/lib/files.ts`
- `../plugin-system/SKILL.md`
- `../../../plugins/bonobo-plugin-pdf/README.md`
- `../../../plugins/bonobo-plugin-image/README.md`
- `../../../plugins/bonobo-plugin-video/README.md`
- `../../../packages/app/vendor/headless-tree/packages/core/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/react-compiler/index.tsx`

# Architecture Overview

The Files sidebar is implemented in `files-sidebar.tsx` on top of `@headless-tree` with Convex-backed data.

- Tree engine: `@headless-tree/core` + `@headless-tree/react`
- Backend data: Convex `files_nodes` queries and mutations
- Primary data source: `files_nodes.list_tree`
- Local state is UI-only (`expandedItems`, search/selection, busy/pending flags) plus derived indexes from query data
- Prefer Convex mutation `optimisticUpdate` over ad-hoc local mirrored tree state
- The client prepends `files_SYNTHETIC_ROOT_FOLDER` to the returned `files_nodes` docs.
- Root is identified by `files_ROOT_ID`; tree items use `kind: "folder" | "file"`.
- Placeholder rows are UI-only render artifacts
- Uploaded source files are normal visible nodes. Non-Markdown sources open their stored-file/status screen. Enabled upload plugins may create normal visible Markdown siblings.

# Data Model And Contracts

- `files_TreeItem`, `files_ROOT_ID`, `files_SYNTHETIC_ROOT_FOLDER`, and `files_create_tree_items_list_from_nodes` are defined in `../../../packages/app/shared/files.ts` and re-exported by `../../../packages/app/src/lib/files.ts`.
- Backend returns visible `files_nodes` docs; the client adds the synthetic root. Placeholder rows are client-rendered.
- Folder nodes can have children, expand/collapse, and receive drops.
- File nodes are leaves. Markdown-backed files, including plugin outputs created through `files/write` or `files/touch`, open in the editor. Uploaded non-Markdown source files open stored-file/status metadata.
- Clicking a folder opens its folder screen. `FileNodeView` decides whether the selected node renders the folder explorer or the file editor, and folder screens embed an editable child `README.md` when present.
- Editable Markdown file nodes have `assetId`, a Markdown media type (`text/markdown`, regardless of charset parameters), Yjs rows, Markdown chunks, plain-text chunks, and snapshots. `assetId` points at the newest content snapshot asset (each materialization/restore re-points it), while committed current reads use the Markdown chunks. If an editable node came from an uploaded Markdown file, R2 also retains the original upload object.
- User-created Markdown files and the auto-created home `README.md` are seeded by the Convex create action with `files_INITIAL_CONTENT`; the rich-text editor must not bootstrap initial Yjs content on the client.
- Uploaded non-Markdown source file nodes create an upload asset immediately, store the source `contentType` on the node, and get `r2Key` on the asset after the R2 object-create event confirms the source object exists.
- Uploaded Markdown files still upload directly to R2 through the signed PUT path. The R2 event finalizer then promotes the uploaded object into the ordinary editable Markdown shape by creating the Yjs snapshot, chunks, and first version snapshot, and re-points the node at that version snapshot (the upload asset stays as the untouched upload record).
- For non-Markdown uploads, R2 completion marks the source terminal and dispatches `files.upload.completed` to eligible enabled plugins. Plugins, not R2 event processing, create any sibling Markdown files.
- Assets are the single R2 object metadata record for source binaries, compacted Yjs snapshots, and version snapshot Markdown. Editable files keep no content-kind asset row: the node's `assetId` is the newest version snapshot asset, whose size doubles as the committed byte size for read caps. Owners point to assets; assets do not own relationships between source files and generated outputs.
- Source/conversion metadata stays in DB/R2 metadata, not visible generated Markdown.
- `files_get_upload_pipeline_state` returns `waiting_for_upload`, `pending_processing`, `processing`, or `terminal` for the source asset. Plugin-run progress is separate and is not represented by the source `processingWorkId`.
- R2 asset keys use `organizations/<organizationId>/workspaces/<workspaceId>/assets/<assetId>` for every asset kind. Convex uses `files_r2_assets.kind` to decide upload finalization behavior.
- Upload max is 50 MiB; converted Markdown max is 900,000 bytes.

# Uploaded Source And Plugin-Generated Files

- Upload creates a visible source file node immediately.
- R2 completion finalizes Markdown MIME uploads into editable Yjs, chunk, and snapshot state on the source node.
- Other uploads become terminal stored files, and the host emits `files.upload.completed` to each eligible enabled plugin installation subscribed to the exact content type.
- Plugin runs track their own queued, running, failed, and terminal state. They do not use the source asset's `processingWorkId`, and they do not create output placeholders before calling the host files API.
- The first-party PDF plugin writes `<source-name>.md`; the image plugin writes `<source-name>.description.md`; the video/audio plugin writes a transcript and, for video, a summary. Outputs exist only when the matching plugin is installed, enabled, configured with required secrets, and completes the relevant write.
- Plugin `files/write` or `files/touch` calls create ordinary Markdown sibling files. Image and video flows may touch an empty output before filling it.
- Rename, move, archive, and unarchive treat source and output nodes independently. Plugin writes derive target paths from `source.path`; do not claim the host finalizes a pre-created output by node id.
- Archiving a source upload should keep the original R2 object; permanent tenant purge deletes R2 objects for every `files_r2_assets` row before deleting the rows.
- Browser-side source uploads try to compress static JPEG/PNG/WebP images before `files_nodes.create_upload_node`; keep the original file when compression fails or is not smaller. Animated GIFs must keep the original blob so animation is not destroyed, but still use the image-description generation path.
- If a plugin fails, the source stays. Outputs already touched or written also stay; a missing-secret failure before the first write creates no output.
- Manual plugin reruns are supported. Keep detailed plugin execution, permissions, services, and release behavior in `../plugin-system/SKILL.md` and the individual plugin README files.

Known gaps:

- Rich-text image upload currently posts to legacy `/api/upload`; that is not the first-party R2 source/generated-output upload pipeline.
- Plugin-generated Markdown outputs use the same normal editable-file lifecycle as other Markdown files after creation.

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
- The selection anchor drives active-track highlighting.
- The current route/navigated row uses a stable row-left accent rail instead of bold text. Keep row labels regular weight so selection does not change text metrics. The rail belongs only to navigated rows. Internal Headless Tree focus and pointer hover are not selection and must not paint the selected row surface after pointer clicks; hover can brighten row text, while `:focus-visible` keeps the keyboard interaction surface. Idle non-selected rows use one quieter foreground shade and brighten to the navigated-row lightness on hover, selected, and navigated states. Keyboard focus must stay as the top visual layer: keep the focus ring continuous, keep the rail visible just inside it, and remove idle title input chrome so row names render as plain text outside rename mode. The disabled title input must inherit the row color; otherwise only icons dim while filenames remain too bright.

## Create, Rename, Archive, Unarchive

- Root actions create `New File` and `New Folder`.
- Folder row actions can create child files and folders.
- File rows do not show child-creation actions.
- Default generated names are sibling-aware: `new-file.md`, `new-file-1.md`, `new-file-2.md`, and the matching `new-folder`, `new-folder-1`, `new-folder-2` sequence.
- File and folder create support path-like names: missing parent folders are created first, then the final file/folder is created at that path.
- File create/rename input canonicalizes path segments in the frontend. Backend recursive creation trusts callers to pass a non-empty normalized path; do not claim it returns a normal empty-path validation result.
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
- Rename uses `files_nodes.rename_node` with Convex `optimisticUpdate` for immediate title feedback.
- The selected file/folder path auto-expands in the sidebar after route changes and path-based create/rename moves so the focused row stays visible.
- Archive/unarchive uses `files_nodes.archive_nodes` / `files_nodes.unarchive_nodes`.

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
- External drops over file rows resolve to the file's containing folder. Root, folder rows, empty-folder placeholders, and file-row parent resolution are accepted targets.
- Dropped browser `File` objects are uploaded through `files_nodes.create_upload_node`, PUT to the signed R2 URL, then processed by the R2 event flow. Current frontend classification treats a file as Markdown only when `File.type` starts with `text/markdown`; a `.md` filename alone does not make it a Markdown upload.
- Keep external upload acceptance file-type neutral. Do not add MIME or extension allowlists beyond the existing non-Markdown uploaded-source requirement that a filename has a real extension.
- Reject multi-file and directory drops in the UI; v1 uploads one file at a time.

## Upload Lifecycle

1. The upload menu or external drop receives one file. Directory and multi-file drops are rejected.
2. The client prepares static images, classifies Markdown from MIME type, normalizes the path, and opens the draft/conflict modal when needed.
3. `files_nodes.create_upload_node` validates the request and creates the upload asset plus visible source node.
4. The browser uploads the binary through the signed R2 PUT URL.
5. The R2 event patches the source asset's key, size, and optional ETag.
6. Markdown MIME uploads run the host Markdown finalizer, which creates Yjs, chunks, and a content snapshot on the uploaded node. Oversized Markdown stays a stored file.
7. Other uploads become terminal source files and dispatch eligible `files.upload.completed` plugin runs.
8. Installed first-party plugins own PDF, image, video, and audio-derived outputs plus their external provider calls.
9. Plugin-created outputs are ordinary Markdown files. No host-owned output placeholder exists before the plugin writes or touches the path.
10. Rich-text image upload still uses the legacy `/api/upload` route rather than this Files-sidebar flow.

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
9. Keep external file drops on the same upload lifecycle as the Upload file menu action: signed R2 upload first, host Markdown finalization for Markdown MIME uploads, and plugin-event dispatch for other uploads.
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
- With the matching plugin installed and enabled and its required secrets configured, verify PDF, image, video, and audio-derived outputs.
- Static image uploads are compressed in the browser only when the result is smaller and always keep a visible source node.
- Video and audio uploads remain visible as source nodes even when a plugin run fails.
- Markdown external file drops onto root/folders use the same signed R2 upload path, then finalize into ordinary Markdown file nodes.
- External file drops over a file row upload into that file's containing folder.
- Multi-file and directory external drops are rejected without creating nodes.
- Placeholder nodes are never sent to mutations.
- Normal tree/list/glob results expose uploaded sources and generated outputs as ordinary visible nodes.
