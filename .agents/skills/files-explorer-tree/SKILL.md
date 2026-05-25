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
- Primary data source: `files.get_tree_nodes_list`
- Local state is UI-only (`expandedItems`, search/selection, busy/pending flags) plus derived indexes from query data
- Prefer Convex mutation `optimisticUpdate` over ad-hoc local mirrored tree state
- Backend item types: `"root" | "node"`
- Node kinds: `"folder" | "file"`
- Placeholder rows are UI-only render artifacts
- Uploaded source files are normal visible nodes; generated shadow files are hidden from normal tree/table UI.
- Converted source files open their generated Markdown representation while selection and breadcrumbs stay on the source file node.

# Data Model And Contracts

- `files_TreeItem` shape is defined in `../../../packages/app/convex/files_nodes.ts`.
- `files_ROOT_ID` and `files_create_tree_root` are in `../../../packages/app/shared/files.ts` and re-exported by `../../../packages/app/src/lib/files.ts`.
- Backend returns root/node items only; placeholder rows are client-rendered.
- Folder nodes can have children, expand/collapse, and receive drops.
- File nodes are leaves. Markdown-backed files open in the editor; pending uploaded source files open stored-file metadata; converted uploaded source files open the backing Markdown shadow editor.
- Clicking a folder opens its folder screen. `FileNodeView` decides whether the selected node renders the folder explorer or the file editor, and folder screens embed an editable child `README.md` when present.
- Editable Markdown file nodes have `assetId`, a Markdown media type (`text/markdown`, regardless of charset parameters), Yjs rows, R2-backed committed Markdown assets, Markdown chunks, plain-text chunks, and snapshots.
- User-created Markdown files and the auto-created home `README.md` are seeded by the Convex create action with `files_INITIAL_CONTENT`; the rich-text editor must not bootstrap initial Yjs content on the client.
- Uploaded non-Markdown source file nodes create an upload asset immediately, store the source `contentType` on the node, get `r2Key` on the asset after the R2 object-create event confirms the source object exists, and own generated shadows through `shadowFileNodeIds`.
- Uploaded Markdown files still upload directly to R2 through the signed PUT path. The R2 event finalizer then promotes the uploaded object into the ordinary editable Markdown shape by creating the Markdown asset, Yjs snapshot, chunks, and version snapshot.
- Generated shadow files are Markdown file nodes with `shadowSourceFileNodeId` pointing back to the visible shadow source file node. Shadow file nodes keep `shadowFileNodeIds: []`.
- Assets are the single R2 object metadata record for source binaries, live Markdown, compacted Yjs snapshots, and version snapshot Markdown. Owners point to assets; assets do not own node/snapshot/shadow relationships.
- Use the term **shadow file** for these generated Markdown records in engineering docs.
- `.shadow.md` is system-reserved for generated shadow files. Normal user-created files should avoid that suffix even though current conflict handling can archive an unexpected occupant.
- Source/conversion metadata stays in DB/R2 metadata, not visible shadow Markdown; the authoritative source/asset/shadow relationship is the DB link between the source file node, its upload asset, and the generated shadow file node fields.
- Upload status is derived in the UI from the upload asset plus the source file node shadow fields: missing `r2Key` is waiting for upload, `conversionWorkId` means processing, confirmed `r2Key` with no shadow is uploaded/processing, and an upload asset with at least one linked shadow file node is ready.
- R2 asset keys use `workspaces/<workspaceId>/projects/<projectId>/assets/<assetId>` for every asset kind. Convex uses `files_r2_assets.kind` to decide upload finalization behavior.
- Upload max is 50 MiB; converted Markdown max is 900,000 characters.

# Uploaded Source And Shadow Files

- Upload creates a visible source file node immediately.
- While upload/conversion is pending, opening the source shows stored-file status such as waiting or processing.
- After finalization, opening the source renders the generated Markdown shadow through the normal file editor while the selected node remains the source.
- The generated `.shadow.md` node is not returned by normal sidebar/list/path queries and is not linked from normal UI.
- Direct shadow file node-id URLs may resolve by showing the shadow source file node, but normal UI should never expose shadow ids or paths.
- Replacing an uploaded source archives the old source plus its linked shadow before creating the replacement source.
- If the source is archived before conversion finishes, finalization creates the shadow file archived with the same archive operation id.
- Rename and move keep generated shadow paths following the source path.
- Archive/unarchive keep `shadowFileNodeIds` intact and include linked shadows with the shadow source file node.
- Archiving a source upload should keep the original R2 object; permanent tenant purge deletes R2 objects for every `files_r2_assets` row before deleting the rows.
- Rich-text image uploads should create visible upload nodes next to the document where the image was inserted and use the same R2 source/shadow conversion model.
- If conversion fails, keep the source file visible in the last durable source-asset state rather than archiving it or creating an empty shadow. Cleanup/recovery for abandoned or failed reservations is intentionally still a TODO.
- Conversion rerun is not a normal product flow; if a forced rerun is added later, it may overwrite the shadow.

Known gaps:

- Rich-text image upload currently posts to legacy `/api/upload`; that is not the first-party R2 source/shadow upload pipeline.
- Generated Markdown shadows are materialized to R2 using the same asset key shape as every other file asset. Convex keeps the source/shadow relationship, Yjs/update rows, chunks, snapshots, and asset pointers.

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
- `FilesSidebarTreeItemMetaLabel`
- `FilesSidebarTreeItemActions`
- `FilesSidebarTreeItemSecondaryAction`
- `FilesSidebarTreeItemSecondaryActionCreateFile`
- `FilesSidebarTreeItemMoreAction`
- `FilesSidebarTreeItemTrack`
- `FilesSidebarTreeItemPlaceholder`

# State And Behavior Flows

## Server-Driven Data

- Sidebar queries `files.get_tree_nodes_list`.
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
- Rename input filters draft typing/paste/composition through shared live-name normalization: files allow lowercase letters, digits, `/`, `.`, `-`, `_`; folders allow lowercase letters, digits, `/`, `-`, `_`; adjacent separators are blocked while typing; special file-name casing remains submit-time only.
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
- Dropped browser `File` objects are uploaded through `files_nodes.create_upload_node`, PUT to the signed R2 URL, then processed by the R2 event flow. Markdown media types and `.md` names are canonicalized as Markdown before upload so finalization creates the normal Markdown/Yjs/snapshot rows instead of a generated shadow.
- Keep external upload acceptance file-type neutral. Do not add MIME or extension allowlists beyond the existing non-Markdown uploaded-source requirement that a filename has a real extension.
- Reject multi-file and directory drops in the UI; v1 uploads one file at a time.

## Upload Lifecycle

1. User uploads one file through the menu or drops one external file onto an accepted target.
2. Frontend detects Markdown uploads by Markdown media type or `.md` name; Markdown names follow normal Markdown normalization, while non-Markdown names preserve the uploaded extension.
3. Missing extension for non-Markdown uploads or any upload path conflict opens the upload draft modal.
4. `files_nodes.create_upload_node` validates membership, rate limit, parent folder/root, size, and conflicts.
5. Backend creates an upload `files_r2_assets` row without `r2Key` and creates the visible source file node with `assetId` and `contentType`.
6. Backend returns a signed R2 PUT URL and optional content-type header for the upload asset key.
7. Browser uploads the binary directly to R2.
8. R2 object-create events under the asset prefix flow through the upload finalizer Worker to Convex.
9. Convex parses the deterministic asset key from the R2 event, ignores non-upload asset kinds, patches `r2Key`/`etag`/`size` for upload assets, queues upload processing, and stores `conversionWorkId` on the asset.
10. For Markdown uploads, Convex reads the uploaded Markdown from R2, creates the normal Markdown asset, Yjs snapshot, chunks, and version snapshot, then patches the visible node into the same shape as an app-created Markdown file.
11. For non-Markdown uploads, Modal converts the R2 source object to Markdown.
12. Convex reserves Markdown/Yjs/version assets for the generated shadow.
13. Convex writes the generated shadow Markdown and compacted Yjs objects to R2.
14. Convex creates `<source filename>.shadow.md`, archives any unexpected active occupant of that path, patches the shadow source file node `shadowFileNodeIds` and shadow file node `shadowSourceFileNodeId`, clears conversion work, and writes chunks/snapshot rows.

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
9. Keep external file drops on the same upload lifecycle as the Upload file menu action: signed R2 upload first, then Markdown finalization or non-Markdown shadow conversion.
10. Keep assets focused on R2 object metadata and owners focused on node/snapshot/shadow relationships.

# Verification Checklist

- Tree updates come from `get_tree_nodes_list`.
- Search keeps ancestor chain for matching files/folders.
- Search-open expands relevant branches and search-close restores prior expansion.
- Selection modes and anchor behavior are correct.
- Root create can create a file and a folder.
- Folder create can create child files/folders.
- File rows do not show child creation actions and are not expandable.
- Rename guards and optimistic rename behavior are correct.
- Archive/unarchive and archived filter/toggle behavior is correct.
- DnD allows legal moves, blocks drops onto files, and root-zone feedback works.
- Non-Markdown external file drops onto root/folders create normal uploaded source file nodes and eventually hidden `.shadow.md` nodes through the R2 conversion flow.
- Markdown external file drops onto root/folders use the same signed R2 upload path, then finalize into ordinary Markdown file nodes without shadow files.
- External file drops onto file rows do not upload to the file's parent.
- Multi-file and directory external drops are rejected without creating nodes.
- Placeholder nodes are never sent to mutations.
- Normal tree/list/glob results expose source paths, not internal `.shadow.md` paths.
