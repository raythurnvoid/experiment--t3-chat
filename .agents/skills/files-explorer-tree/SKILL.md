---
name: files-explorer-tree
description: Practical guide for the current Files sidebar (`@headless-tree` + Convex) implementation. Use this when implementing or modifying sidebar behavior (search, selection, Cut/Copy/Paste, drag/drop, rename, archive/unarchive, create file/folder, and root-drop-zone interactions).
---

# Source Of Truth Files

Primary:

- `../../../packages/app/src/components/files/files-sidebar.tsx`
- `../../../packages/app/src/components/files/files-sidebar.css`
- `../../../packages/app/src/components/files/files-name-input.tsx`
- `../../../packages/app/src/components/files/files-clipboard.tsx`
- `../../../packages/app/src/components/files/files-clipboard.css`
- `../../../packages/app/src/components/files/file-node-view/file-node-view.tsx`
- `../../../packages/app/src/components/files/file-node-view/file-node-view.css`
- `../../../packages/app/src/routes/w/$organizationName/$workspaceName/files/index.tsx`
- `../../../packages/app/convex/files_nodes.ts`
- `../../../packages/app/convex/files_transfer.ts`
- `../../../packages/app/convex/files_folder_sorts.ts`
- `../../../packages/app/shared/files-sort.ts`
- `../../../packages/app/src/hooks/files-search-hooks.ts`
- `../../../packages/app/convex/r2.ts`
- `../../../packages/app/convex/plugins_runtime.ts`
- `../../../packages/app/shared/files.ts`
- `../../../packages/app/src/lib/files.ts`
- `../../../packages/app/src/lib/files-tree-context.tsx`
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
- Primary data source: `files_nodes.list_tree_children`, one open folder at a time (see Server-Driven Data)
- Local state is UI-only (`expandedItems`, search/selection, busy/pending flags) plus derived indexes from query data
- Prefer Convex mutation `optimisticUpdate` over ad-hoc local mirrored tree state
- The client prepends `files_SYNTHETIC_ROOT_FOLDER` to the returned `files_nodes` docs.
- Root is identified by `files_ROOT_ID`; tree items use `kind: "folder" | "file"`.
- Placeholder rows are UI-only render artifacts
- Uploaded source files are normal visible nodes. Uploads with an editable text extension (all 20, see `../files-editable-text/SKILL.md`) convert into editable documents; other sources open their stored-file/status screen. Enabled upload plugins may create normal visible Markdown siblings.

# Data Model And Contracts

- `files_TreeItem`, `files_ROOT_ID`, `files_SYNTHETIC_ROOT_FOLDER`, and `files_create_tree_items_list_from_nodes` are defined in `../../../packages/app/shared/files.ts` and re-exported by `../../../packages/app/src/lib/files.ts`.
- Backend returns visible `files_nodes` docs; the client adds the synthetic root. Placeholder rows are client-rendered.
- Folder nodes can have children, expand/collapse, and receive drops.
- File nodes are leaves. Editable text files open in an editor: Markdown (including plugin outputs created through `files/write` or `files/touch`) in the rich text editor, the plain-text extensions in the Monaco "Code" editor. Uploaded non-editable source files open stored-file/status metadata.
- Clicking a folder opens its folder screen. `FileNodeView` decides whether the selected node renders the folder explorer or the file editor, and folder screens embed an editable child `README.md` when present.
- Editable file nodes have a non-null `assetId`, stored `contentType`, and `textKind`, plus exact text chunks, plain-text search chunks, and version snapshots. `collaborationEnabled: true` adds a live Yjs document; false keeps the text editable with null Yjs pointers. `assetId` points at the newest content snapshot asset (each materialization/restore re-points it), while committed current reads use the chunks. If an editable node came from an upload, R2 also retains the original upload object.
- User-created Markdown files and the auto-created home `README.md` are seeded by the Convex create action with `files_INITIAL_CONTENT`; the rich-text editor must not bootstrap initial Yjs content on the client.
- Uploaded source file nodes create an upload asset immediately. The signed PUT writes directly to
  its canonical asset key with signed `If-None-Match: *`, so a repeated PUT cannot overwrite it.
  The R2 event finalizer checks the stored object before publishing `r2Key`, size, and etag.
  The node keeps the content type it was
  created with: the caller's valid type, else the name's hint, else `application/octet-stream`.
- After publication, the finalizer reads that stored type. It converts editable text
  uploads into the normal editable shape: a Yjs snapshot in the node's `textKind`, chunks, and the
  first version snapshot. It then points the node at that version snapshot. The upload asset stays as
  the original upload record. Before conversion, it drops one leading BOM and changes CRLF or lone CR
  to LF.
- Uploads that stay stored blobs — non-editable types, and editable-text uploads whose conversion failed deterministically (over-cap, invalid UTF-8, NUL bytes) — are marked terminal and dispatch `files.upload.completed` to eligible enabled plugins; only a successful conversion suppresses the event. Plugins, not R2 event processing, create any sibling Markdown files.
- Assets are the single R2 object metadata record for source binaries, compacted Yjs snapshots, and version snapshot Markdown. Editable files keep no content-kind asset row: the node's `assetId` is the newest version snapshot asset, whose size doubles as the committed byte size for read caps. Owners point to assets; assets do not own relationships between source files and generated outputs.
- Source/conversion metadata stays in DB/R2 metadata, not visible generated Markdown.
- `files_get_upload_pipeline_state` returns `waiting_for_upload`, `pending_processing`, `processing`, or `terminal` for the source asset. Plugin-run progress is separate and is not represented by the source `processingWorkId`.
- R2 asset keys use `organizations/<organizationId>/workspaces/<workspaceId>/assets/<assetId>` for every asset kind. Convex uses `files_r2_assets.kind` to decide upload finalization behavior.
- Upload max is 2 GiB (`files_MAX_UPLOADS_BYTES`); converted text max is 900,000 bytes (`files_MAX_TEXT_CONTENT_BYTES`).

# Uploaded Source And Plugin-Generated Files

- Upload creates a visible source file node immediately.
- R2 completion reads the node's stored content type (the caller's valid type, else the name's hint, never the browser MIME on its own) and finalizes editable text uploads into editable Yjs, chunk, and snapshot state on the source node.
- Other uploads — and editable-text uploads whose conversion fell back to the stored blob — become terminal stored files, and the host emits `files.upload.completed` to each eligible enabled plugin installation subscribed to the exact content type.
- Plugin runs track their own queued, running, failed, and terminal state. They do not use the source asset's `processingWorkId`, and they do not create output placeholders before calling the host files API.
- The first-party PDF plugin writes `<source-name>.md`; the image plugin writes `<source-name>.description.md`; the video/audio plugin writes a transcript and, for video, a summary. Outputs exist only when the matching plugin is installed, enabled, configured with required secrets, and completes the relevant write.
- Plugin `files/write` or `files/touch` calls create ordinary Markdown sibling files. Image and video flows may touch an empty output before filling it.
- Rename, move, archive, and unarchive treat source and output nodes independently. Plugin writes derive target paths from `source.path`; do not claim the host finalizes a pre-created output by node id.
- Archiving a source upload should keep the original R2 object; permanent tenant purge deletes R2 objects for every `files_r2_assets` row before deleting the rows.
- Browser-side source uploads try to compress static JPEG/PNG/WebP images before `files_nodes.create_upload_node` (`files_prepare_image_upload_file` in `packages/app/src/lib/files-image-compression.ts`, shared with the rich-text editor's paste/drop upload); keep the original file when compression fails or is not smaller. Animated GIFs must keep the original blob so animation is not destroyed, but still use the image-description generation path.
- If a plugin fails, the source stays. Outputs already touched or written also stay; a missing-secret failure before the first write creates no output.
- Manual plugin reruns are supported. Keep detailed plugin execution, permissions, services, and release behavior in `../plugin-system/SKILL.md` and the individual plugin README files.

Known gaps:

- Plugin-generated Markdown outputs use the same normal editable-file lifecycle as other Markdown files after creation.

# Main Components

Main component:

- `FilesSidebar` (name retained to avoid a large route/component rename)
- `FileNodeView` owns the files route shell, sidebar panel, app-header breadcrumb, folder explorer branch, and file editor branch.

Main sections:

- `FilesSidebarHeader`
- `FilesSearchInput`
- `FilesSidebarTree`

Tree-item components:

- `FilesSidebarTreeItem`
- `FilesSidebarTreeRow`
- `FilesSidebarTreeItemArrow`
- `FilesSidebarTreeItemTitle`
- `FilesSidebarTreeItemIcon`
- `FilesSidebarTreeItemPrimaryContent`
- `FilesSidebarTreeItemPrimaryAction`
- `FilesSidebarTreeItemActions`
- `FilesSidebarTreeItemSecondaryAction`
- `FilesSidebarTreeItemSecondaryActionCreateFile`
- `FilesSidebarTreeItemMoreAction`
- `FilesSidebarTreeItemTrack`
- `FilesSidebarTreeItemPlaceholder`

# State And Behavior Flows

## Server-Driven Data

- The sidebar loads only open folders. A workspace can hold tens of thousands of nodes, and the old
  whole-tree load took seconds before the first row showed. Keep the first rows within a few hundred
  milliseconds: never make the default sidebar wait for the whole tree again.
- `FilesTreeProvider` (`lib/files-tree-context.tsx`), mounted once inside `AppTenantProvider`, has two
  attached hooks:
  - `useFolders({ folderIds, archived, pinnedNodeIds })` loads the root and each listed folder. The
    sidebar passes its expanded folders; the folder view passes the open folder. It returns `rows`
    (`undefined` until the root page and the shared roots answer), `statusByFolderId` (`loading`,
    `more`, `done`), `hoistedIds`, and `loadMore(folderId)`.
  - `useFullList(enabled)` loads the whole workspace through `files_nodes.list_tree`. Only search,
    AI chat mentions, the media picker, and a Pending panel with entry changes use it. It subscribes
    only while an enabled caller is mounted, and it keeps the last complete result during a page split.
- Each open folder runs two `list_tree_children` pagers of 200 rows at once: one for subfolders and
  one for files. `loadMore` asks for the next subfolders page first, then files. A pager reports rows
  only when both pagers are settled, because a split page drops its rows for a moment. The provider
  keeps the old rows until then.
- The sidebar asks for the next page when the last loaded child of a `more` folder is rendered. The
  effect runs again after every settled page, because a page can add no row below that last child:
  the last subfolders page adds rows above the files, and an access-filtered page can be empty.
- `pinnedNodeIds` (the selected node, a reveal request, a renamed row) load through
  `get_tree_ancestors`, which returns the node and its readable folders from the top down. Those rows
  show before their folder's page reaches them. When the top readable folder is not at the root,
  its row is hoisted to the root level.
- `list_tree_shared_roots` returns restricted folders and files that were shared with a member whose
  folder above them is hidden. They are hoisted to the root level. The owner gets none.
- Every folder has a chevron, because an unopened folder's children are unknown. An open empty folder
  shows "No files inside"; a loading one shows "Loading…" and sets `aria-busy` on its row.
- Children sort folders first, then by name in raw byte order (`sort_children`), the same order as
  the `by_organization_workspace_parent_archiveOperation_kind_name` index. So `B` sorts before `a`.
  This keeps loaded pages in place while later pages arrive.
- Show archived items runs extra archived pagers for each open folder. The menu shows no archived
  count, because counting would need the whole tree.
- `FileNodeView` uses the matching loaded tree node while `get_file_node_for_membership` is loading.
  Keep that query running: its returned node or `null` always wins over the tree. A node absent from
  the loaded rows stays loading until the query answers. Do not add an archive filter; both queries
  return readable archived nodes. Switching from the tree to the query must keep the same editor and
  draft.
- Measure the first root rows and the first rows of a big folder separately. The Playwriter Files
  reference has the timing recipe.
- Tree collection maps/sets are derived from query results (`useMemo`) and rebuilt from server data.
  A row whose parent is not loaded is dropped unless it is in `hoistedIds`.
- Loading/empty states are derived from query presence and visible IDs.

## Search

- Shared controls live in `components/files/files-search-input.tsx`, field matching in `lib/files-search.ts`, and metadata subscriptions in `hooks/files-search-hooks.ts`. Both search surfaces use them.
- The search box is `FilesSearchInput`: a combobox (`MyCombobox`, from `native-popovers/combobox`) inside a `MyInput`, with the committed filters shown as chips (`FilesSearchInputFilterChip`, a `MyChip` inside a `MyChipRow`) above the input. The chips wrap within a scroll area capped at 96px. A query is whitespace-separated tokens: a `metadata.key:value`, `frontmatter.path:value`, or `file.field:value` token is a filter, everything else is free text (a bare `status:open` is free text). The language (parser, serializer, plans) lives in `packages/app/shared/files-search-query.ts`; the `file-metadata` skill describes it and the three Convex doors under "Search Box".
- The input sets `autoCapitalize="none"`, `autoCorrect="off"` and `spellCheck={false}`: keys and metadata values are exact-case, so a phone keyboard must not capitalize `status` into `Status` or correct a value.
- Search input is debounced and consumed through a deferred query value.
- Visible IDs are computed from matches plus ancestor chain inclusion.
- Ancestors of matched files/folders remain visible.
- Search-open snapshots expansion state and auto-expands relevant parents; search-close restores prior expansion.
- The free text keeps its shape rules, so users paste what they copied without learning a prefix syntax. `detect_search_query_mode` decides: a pasted app link is unwrapped into the `nodeId` search param or the `/files/<path>` splat it carries; a long lowercase alphanumeric string is a node id; anything containing `/` matches `path`; everything else matches `name`. There is no `>`/`#` prefix syntax.
- Filters run in two places. `file.*` filters (`path`, `name`, `extension`, `kind`, `updated`) match tree fields on the client in `search_filter_matches_item` (every field ignores case; a whole `file.extension` value matches the end of a file's name so `tar.gz` works and a folder never matches `file.extension`, a prefix matches the stored `lowercaseExtension`, and a leading dot is ignored; `file.updated` goes through `files_search_query_file_updated_matches`, where a day literal means the whole local day, like the dates the tree shows).
- Every other filter, except `file.link`, is one `files_metadata.search_nodes` query per chip (`useQueries`, keyed by the filter's raw token); `get_search_matches` ANDs the answers, applies `!` negation, and lets files and folders match their own metadata. Synthetic folders do not match metadata filters.
- `file.link:public` is answered by the server too, but with one `files_share_links.list_workspace_links` query for all its chips. The answer is stored under each chip's raw token like a metadata answer, so loading, failed, and negated chips follow the same rules as metadata chips. The list covers the whole workspace, so a linked file inside a folder that is not expanded still matches. The `file-metadata` skill has the full rule.
- A filter whose answer has not arrived matches nothing, and the tree shows "Searching…" instead of "No files match your search." A filter whose query threw is unknown too: `searchServerTargetKeys` stores `null` for it, it matches nothing negated or not, and it ends the "Searching…" state; `isSearchFailed` (any `null` answer) then shows "Search failed" in the status line and "The search failed. Change a filter to try again." in the tree.
- Once a metadata filter is present an archived node never matches either, because archived nodes have no active search docs.
- The first positive `file.path:` chip is also sent as `pathPrefix` (`searchPathPrefix`): the stored path of the tree node the typed path names in any case, so the server scans only that subtree with an exact index range, unless that node is a file: a file has nothing under it, so nothing is sent and the tree filter keeps the file by its own path.
- The free text loses its quotes before `detect_search_query_mode`, and a text of quotes alone matches nothing.
- Both `useQueries` argument objects are wrapped in `useMemo` on purpose: `useQueries` resubscribes on object identity and calls setState during render, so a fresh object every render is "Too many re-renders". `searchServerTargetKeys` and `searchMatches` are memoized for the same kind of reason: the tree rebuild layout effect keys on the `visibleFileIds` identity.
- Suggestions: while the box is focused, the popover lists keys from `files_metadata.list_search_fields` (read once per focus with `convex.query`, not subscribed, so a metadata write elsewhere does not rerun the catalog walk; each key row is one qualified key such as `metadata.status`, with a short value-kind hint), the `file.*` fields (each row shows only its key, such as `file.extension`, the same text the chip shows; there is no second label), and values from `list_search_values` (or `true`/`false` for a boolean key, `* (any value)`, and extensions or folder paths for `file.*` keys; a folder is listed when its path contains the typed text without the leading slash the filter adds, so `tasks` lists `/projects/tasks` and `arch` lists `/tasks-archive`). Picking a key writes `key:` into the input; picking a value commits the chip. The final token comes from `files_search_query_typing_token`, so a quoted value with spaces still gets value suggestions. Key rows match the typed text anywhere in the qualified key, so `meta` lists every `metadata.` key. A typed `file.path` value is read as a folder path (`tasks` lists `/tasks`) and a typed `file.extension` value drops its leading dot. The old spelling `file.ext` is not a field any more; the chip shows the reason. Metadata value rows match the typed prefix in exact case, the same rule as the server walk, so a row never shows for a prefix the server will not confirm; file value rows ignore case like their filters. A short hint sits below the list. The expandable Filter syntax section shows every token form.
- Keyboard: Enter commits the typed filters, or opens the top match when only free text is typed. Space commits the complete filters typed so far, but only when the caret is at the end of the text, because the commit rewrites the whole text; a filter with a problem stays in the text next to the free text, so the user can fix it. An open quote is closed on commit: `metadata.assignee:"Denys` becomes the chip `metadata.assignee:"Denys"`. A key pressed while an IME composes text (`nativeEvent.isComposing`, or Safari's `keyCode` 229 on the key that ends a composition) is left to the composition. Removing a chip re-parses the chips left, so a chip past the 20-filter cap becomes valid once there is room. Escape closes suggestions and keeps the text and chips. Ctrl+Space reopens suggestions without changing the text or selection. Plain typing and Space do not reopen a dismissed menu. Backspace on an empty input focuses the last chip's remove button; after a removal the chip row moves focus to the next chip, else the previous one, else back to the input. The chip row comes before the input in the Tab order. Tab from the input reaches Add search filter, then Clear. A filter the parser cannot run becomes a chip on Enter, with the `-invalid` class, a `title`, and an `aria-describedby` reason; it matches nothing.
- The sr-only `role="status"` line reads "Added filter …", "Removed filter …", or "Filter … cannot run. <reason>", followed by "Searching…" or "N matches".
- Chips show a muted key and a separate value. A file field shows its key, such as `file.path` or `file.extension`, with no short label. Negation, ranges, and quoted values stay visible; the raw token remains in the URL, hover title, and remove-button name.
- Suggestions use `MyComboboxPopover` with the shared `MyFloatingSurface` colors and border. Menu content padding belongs inside the scrolling list, so no padding sits to the right of its scrollbar. Rows and separators use the alternative base color scale.
- Both search inputs show fields on entry. Returning from chips, suggestions, or the global result list keeps the menu state. Add search filter and Ctrl+Space open the same suggestions. Opening the menu leaves the query unchanged. A matching field prefix is completed; otherwise choosing a field adds it after the plain search text. Choosing a key keeps the menu open for values; committing a filter closes it. The visible summary shows the match count or loading/failure state. Clear search removes the text and all chips, closes suggestions, and returns focus to the input. Invalid filters show their reason below the summary.
- The top section uses content height so wrapped chips cannot overlap the tree. Keep the chip area's height cap so a long query still leaves room for results.
- Enter opens the query's top match: the node whose `path` matched exactly, or the only node that matched at all. While a metadata chip or a `file.link` chip is still loading, `onSubmit` returns false and the status line reads "Still searching. Press Enter again when the results are in". A query with neither needs only the tree, so it never waits. The tree's scoped rename `Enter` hotkey is separate and must keep working.
- A pasted private link opens its tagged target. If a bare absolute path has no saved-tree match and no filters, Enter opens the path route so it can resolve a private draft. Keep the typed case for that exact lookup.
- Enter also waits, again only while the live query holds a metadata chip, when the `file.path` chip of the live query differs from the deferred one (`search_path_filter` on both): the metadata results were fetched inside the old folder, so a node picked from them right after that chip is removed could be the wrong one.
- `Mod+K` (registered in `FileNodeView`, `ignoreInputs: false`) opens the files sidebar if closed and focuses the search input through the global `app_files_sidebar_search` id on the `MyInput` wrapper. `MyComboboxInputControl` owns its own generated id for the combobox wiring (label and `aria-controls`), so the global id cannot live on the control.
- The files route's `q` search param mirrors the search box both ways. The router reads search params as JSON, so a hand-typed `?q=2026` arrives as a number; the route turns a number or a boolean back into text before the length cap. A pasted app link whose path holds a raw `%` (`50% off.md`) is plain text: `url_parse_file_link` answers null instead of throwing from `decodeURIComponent` inside the render. The box serializes the chips' raw tokens plus the text with `files_search_query_serialize`, so the URL holds exactly what the user typed and seeds the chips on mount. It seeds the box on mount (the path route's not-found panel uses that so a failed link lands on a filled, case-insensitive search), and the box writes back to it through `FilesSidebar_Props.onSearchQueryChange` → `FileNodeView.handleSearchQueryChange` → `onNavigateSearch(..., { replace: true })`. The write is already debounced by `FilesSearchInput`; do not add a second timer. `replace` keeps a whole typing session on one history entry, and an empty query drops the param instead of leaving `?q=`. The route caps `q` at 2000 characters (`.catch(undefined)` drops a longer one) and the parser caps a query at `files_search_query_MAX_FILTERS` (20) filters, so a shared link cannot fill the box with thousands of chips and subscriptions.
- External route changes update the mounted sidebar and its input. The sidebar tracks the last route value. The input compares incoming queries with its debounced value, so its own URL writes do not reset text still being typed.
- Every link into the files route must preserve `q` with the functional form `search={(prev) => ({ ...prev, nodeId, view })}`. The sidebar stays mounted with its box filled across those navigations, so an object literal would silently desync the URL from what the user sees. This covers the sidebar header title, the breadcrumb's Home link and folder crumbs (saved and pending), folder-explorer rows, and the pending-changes panel.

## Global Search

- The header search and `Mod+Shift+F` open `FilesSearchPalette`. Chips wrap above the shared input.
- Plain text searches names, paths, and contents. Filter-only queries work too. All chips are ANDed. Invalid chips block results.
- Names and folders come from the owner's `files_visible.list` pages, including saved entries and private drafts at their current paths. `useFilesVisibleEntries` keeps every loaded page subscribed and waits for completion before filtering or negating results. A changed earlier cursor replaces its old suffix. Content comes from `files_nodes.search_content`, including ready private text. Deduplicate by target kind and id.
- Metadata filters, including negated filters, match active files and folders. Content queries stay file-only.
- Filtered content queries send every candidate file `target` in groups of at most 1,000 through
  `useQueries`, so a broad filter stays below Convex's argument-array limit. Each scope applies
  before pagination, with tenant and file access checks still enforced. Empty scopes send no
  content query. The palette waits for every group and shows an error if any group fails. It merges
  the bounded responses by target kind and id; these groups do not provide exhaustive results or a shared
  relevance score. Unfiltered text keeps one content query.
- Suggestions open on entry, with the same Escape, Ctrl+Space, and filter-button behavior as the sidebar. After dismissing suggestions, ArrowDown from the input focuses results. ArrowUp from the first result returns to the input. Enter opens a result. Escape closes suggestions first, then the modal.
- “Use filters in sidebar” transfers chips into route `q` and opens the tree. Plain content text stays in global search because the sidebar matches names and paths.
- The result list scrolls separately from the input. Chips are capped at the smaller of 96px and 20% of viewport height. On short screens, the sidebar action replaces the keyboard hint. The list shows up to 50 combined rows and asks for narrower filters when more name matches exist. Content matches retain the bounded server search.

## Path URLs And Copy Actions

- Saved URLs use `/w/:organizationName/:workspaceName/files?nodeId=<id>&view=<view>&fileView=<fileView>`. `view` is the editor mode; `fileView` is any other View pick, such as `details`, `browser`, or a plugin view. Links may leave both out: the file view writes the node's default into the URL with `replace` once the node's type is known. Private URLs use `pendingNodeId=<id>` instead. Links clear the other id, `view`, and `fileView`, and preserve `q`. Last-open storage keeps `{kind,id}` per membership; a missing private target never falls back to a saved lookup.
- `/w/:organizationName/:workspaceName/files/<path>` is an entry format only. The splat route `routes/w/$organizationName/$workspaceName/files/$.tsx` calls `files_nodes.get_visible_target_by_path`, then replaces the URL with the matching tagged id route. `view` and `q` ride along.
- Only a resolved `null` renders the not-found panel. `undefined` still means loading, so a cold pasted link must not flash not-found.
- Path lookup is exact and case-sensitive. `get_visible_target_by_path` first calls `get_visible_entry_by_path` with no overlay user: a readable saved row at that path wins. Only when there is none does it call it again in the owner's current view, which includes private entries and proposed moves. So after a draft move of `/a/x.md` to `/b/`, both `/files/a/x.md` (the saved row) and `/files/b/x.md` (the draft) open the file. An unreadable saved row counts as not found, so the answer never depends on a hidden row. A hand-typed `/readme.md` for a stored `README.md` misses on purpose and recovers through the not-found panel's search link. Do not add a case-insensitive server fallback.
- Canonicalize a splat with `path_extract_segments_from`. Do not use `files_get_normalized_node_path_segments` for lookups: it is the create/rename normalizer and rewrites characters, which would resolve to a different file.
- `get_visible_target_by_path` uses the same owner, tenant, and read checks as direct target lookup. Private parent paths disappear when destination read access is lost.
- Three copy actions, all multi-select aware in the sidebar and joined with newlines: Copy path (sidebar row menu and breadcrumb) copies the plain path for pasting into search or an AI chat message; Copy link (same two places) copies the absolute `?nodeId=` URL built from `url_path_file_by_node_id`, so a shared link survives rename and move; Copy node id (sidebar row menu and the breadcrumb menu) copies the bare id.
- Copy link deliberately does not emit the readable `/files/<path>` shape. That shape has no in-app producer: it exists so a hand-written or externally generated path can be opened, and the sidebar search still unwraps it when pasted.
- The open node's breadcrumb crumb is a menu button: Reveal in sidebar (sends `files::reveal_node`; the sidebar expands the folders above the row, scrolls to it and focuses it), Duplicate tab (`window.open` of the current URL), Copy node id, and Archive (only when the node can be archived). An archived node's menu has no Reveal in sidebar, because its row is hidden from the tree. A pending entry's menu has Duplicate tab and Copy node id.
- A pending entry's breadcrumb links its saved parents by `nodeId` (from `get_file_pending_target`'s `savedParentId`) and its pending parents by `pendingNodeId` (from `requiredParents`), root-first, then the entry itself. Folder crumbs are shortened with `…` when the row is too narrow; `aria-label` keeps the full name.

## Saved-only lists

- The rule: the UI lists (folder table, sidebar, search box, pickers) show saved files only. The
  agent's bash tools also read the user's drafts. Drafts show to the user in the Pending tab, in the
  draft folder view, and when one draft is opened by its link.
- Why: a list page is one index range, and every member reads the same index. One shared index
  cannot leave out the rows one user moved or deleted in a draft, or add the rows that user created,
  without reading and dropping rows (a scan). Reading drafts on top of saved rows (the overlay) costs
  extra reads for each draft, so only the agent pays it.
- So a saved row with a draft move, rename, or delete on it looks normal in the folder table, and a
  draft create does not show there.
- The folder table follows this rule now. The search box and the global search palette still
  include the owner's drafts until they move to saved-only reads (see "Search" and "Global
  Search").
- Code that keeps a list saved-only says so in a short comment that points here, like
  `// Saved rows only: UI lists never show drafts.` in `list_tree_children_sorted`.

## Folder Contents

The home and saved-folder table (`FileNodeViewFolder`) is sorted and paged on the server, and it
shows saved rows only (see "Saved-only lists"). A private folder (`FileNodeViewPrivateFolder`, the
draft folder view) still lists its children through `useFilesVisibleEntries` in `"children"` mode,
in raw name order. The agent's `ls` and `find` also keep raw name order.

### Sort rules

- Sort by one field (`files_sort_MAX_CLAUSES` is 1): `file.name`, `file.updated`, `file.created`,
  `file.extension`, `file.size`, or any `metadata.*` / `frontmatter.*` key. A sort is still a list
  with one clause, so saved docs keep their shape. Each field has one name. The key, the column
  label, the sort label and the chip all show that same text. The extension field id is
  `extension`; the Convex column `lowercaseExtension` and its indexes keep their names. Folders
  always come first.
- There is no multi-sort. Each table stream reads one index range, and an index orders by one
  field. A second field would need a scan; it waits for the search engine.
- The row key ends with the name, so equal values sort by name in the same direction. Equal
  file.created times keep the index order.
- A file with no extension and a file with no known size have no value. In a file.extension or
  file.size sort they come last, by name A to Z, in both directions. Folders have no extension and
  no size: a file.extension sort puts them in that last group, and a file.size sort lists them by
  name A to Z.
- A metadata sort shows only the rows that have the key. The table says "Rows without <key> are
  hidden." Finding the rows without a key would need a scan.
- Metadata values sort as text through `files_sort_text_key` in `packages/app/shared/files-sort.ts`:
  case and accents are ignored, and digit runs compare by value (`file2` before `file10`). A number
  sorts as `String(value)`, a boolean as `true`/`false`, a list by its first item. The raw name
  breaks ties, so the order is total.
- Known limits of text sort: decimals compare digit run by digit run (`1.5` after `1.25`), a minus
  sign is text (`-5` is not below `3`), and dates sort in time order only when they use the same
  format and time zone. Locale alphabets are not handled (Swedish `å` sorts with `a`, not after `z`).
- `file.extension` uses its raw lowercase extension. Dates and file sizes use numeric values.
- New fields start with `file.updated` and `file.created` newest first, `file.size` largest first, and everything
  else A to Z. A header click applies one field; a second click flips its direction. A header click
  writes the sort into the URL as a `sort_by:` token (see "Table filter and sort bar").
- While a filter is on, the filter fixes the order (see "Table filter and sort bar"). The table then
  sorts only in that order, in either direction.

### Saved sort

- Each folder, and the root, has one saved sort in `files_folder_sorts`, shared by every member.
  `files_folder_sorts.get_folder_sort` returns `{ sort, canSave }` with file.name, A to Z filled in when
  there is no sort doc, or null when the caller cannot read the folder. A grant-only member at the root
  gets file.name, A to Z and cannot save. Saving the file.name asc default deletes the sort doc.
  `set_folder_sort` refuses more or fewer than one clause with "Sort by one field." and a field
  that cannot be sorted with "This field cannot be sorted." The stored field for file.extension is
  `extension`.
- Older sort docs can still hold up to eight clauses. `get_folder_sort` reads only the first clause
  (`sort.slice(0, 1)`), and `files_sort_validator` still accepts the old docs. The migration
  `trim_files_folder_sorts_to_first_clause` in `convex/migrations.ts` (runner
  `run_trim_files_folder_sorts_to_first_clause`) cuts each doc to its first clause. It deletes no
  doc: a doc left with file.name, A to Z shows the same as no doc. After it ran on every deployment,
  make `get_folder_sort` strict again and delete the migration.
- A filter never writes the saved sort. Removing the filter brings the saved sort back.
- The table waits for the saved sort before it loads rows, so it never loads by name and then sorts
  again.
- A sort in the URL (a `sort_by:` token) wins over the saved sort. With no sort token the table uses
  the saved sort. A writer (`canSave: true`) sees "Save sort for everyone" while the URL has a sort.
  It calls `set_folder_sort` with the URL sort and shows the toast "Sort saved for everyone." The
  tokens stay in the bar after the save. A failed save shows "The sort could not be saved. Try
  again." Other members' tables follow the saved sort live.
- A reader (`canSave: false`) gets the same bar and header clicks, but no Save button. The sort lives
  only in their URL. A different folder starts without it. Who may save is in the `access-control`
  skill.
- The sidebar still lists children in name order (`list_tree_children`). Its order is separate from the table.

### Data path

- `files_nodes.list_tree_children_sorted` pages one stream of one folder: one `kind` (folder or
  file), one `segment` (`value` or `missing`), and `restricted` (the open children, or the children
  that are their own restricted root). Each stream is one index range, read with one `.paginate()`
  and the client's `numItems` (at most 200). There is no scan, no work limit, no custom cursor, and
  no sort limit. It reads saved rows only, on purpose (see "Saved-only lists").
  - Args: `sort` is one clause, the filter's order when a filter is on, else the table sort.
    `filter` is one filter or null. `namePrefix` is the `name starts with` value next to an "is"
    filter, else null; a `name starts with` alone is the `filter`. A sort that is not the filter's
    order (`files_table_filter_order_field`), a `namePrefix` next to a filter that cannot take it,
    or a bad page size throws "Invalid table filter or page limit."
  - The open stream (`restricted: false`) reads the rows with `isRestrictedScopeRoot: false`, and
    only when the caller can read the folder. These rows share the folder's access scope, so every
    row is readable. No row is dropped after paging, and a hidden row never takes a page slot.
  - The restricted twin (`restricted: true`) reads the children that are their own restricted root.
    Only the owner gets rows; everybody else gets an empty, done page. A member gets the restricted
    children shared with them from the side rows below.
  - Every row must match its stream: the reader's organization and workspace, right parent, active,
    and both `isRestrictedScopeRoot` and `restrictedScopeNodeId === _id` equal to `restricted`. A
    metadata row's field doc must also copy the node's `sortName`, `name` and kind. A mismatch
    throws `should_never_happen`, because a stale copy would show a hidden row or put it in the
    wrong place.
  - Only a file.extension or file.size sort with no filter has a `missing` segment (rows with no
    value, by name A to Z). A file.size sort reads folders by name in the `value` segment. Any other
    `missing` request gets an empty, done page. A metadata sort has no `missing` segment.
  - Every row carries `sortKey: { parts: [key], nameKey }`. The key is the index suffix:
    `[value, sortName, name]`, `[_creationTime]` for file.created, `[sortName, name]` for
    file.name, and null for a row with no value or a folder in a file.size sort. Metadata cell
    values come from a separate checked query, not the sort payload.
  - Indexes: file.name `by_org_ws_parent_archive_restricted_kind_sortName_name`, file.updated
    `..._kind_updatedAt_name`, file.created `by_org_ws_parent_archive_restricted_kind` (creation
    order), file.extension `..._kind_ext_sortName_name`, file.size `..._kind_size_sortName_name`. A
    metadata key reads committed field docs on `files_metadata_docs`
    `by_org_ws_source_archive_docKind_field_parent_restricted_sort` (4 MiB `maximumBytesRead`),
    then one `get` of the node per row.
  - Page guards. A reactive rerun has no row cap, so a page can grow far past `numItems`. A stream
    with reads per row returns no rows and `pageStatus: "SplitRequired"` (with Convex's
    `splitCursor`) when its page passes its guard, or when Convex already marked the page for a
    split. It does this only when Convex gave a `splitCursor`; without one it returns the page as
    read. `usePaginatedQuery` then splits the page. Guard = floor(3,000 / index ranges read by the worst
    row), or lower. An owner restricted row is its own scope and checks access with 2 reads (the
    user and the organization; the owner reads no grant): 1,500, guard 1,000. An open metadata row
    reads its node (1 read): 3,000, guard 1,800 so the node bytes stay small. An owner restricted
    metadata row reads 3: 1,000, guard 700. A test measures each with
    `ctx.meta.getTransactionMetrics()`. The open built-in stream reads nothing per row (its rows
    share one access scope), so it has no guard.
- `files_nodes.list_tree_children_sort_side_rows` returns the restricted children shared with a
  member, as saved rows with `createdAt`, `contentByteSize` and `treeRow`. It stays until shared
  items get their own sorted streams. It reads no drafts.
  - It returns null when the caller cannot read the folder. The owner gets an empty list: the
    restricted twins hold those rows.
  - A member's candidates come from their own `content.read` grants and their roles' grants
    (`db_list_granted_restricted_scope_nodes`, like `list_tree_shared_roots`), kept when they are
    active children of this folder. The query walks them in name order, checks each one with saved
    reads (`db_get_readable_tree_node`), skips the ones the member cannot read, and stops at 200
    rows with `tooManyShared`. When one grant list passes 500, the member gets no rows and
    `tooManyShared: true`. The `access-control` skill explains why.
  - The list has no sort, filter, or metadata argument. Two point checks fill in the rest:
    `get_table_sort_key` (metadata sorts only; built-in keys come from the row facts in the
    browser) and `get_table_filter_match` (with a filter; it also applies `namePrefix`). Both take a
    saved target and return null for a private one. They load the node, check organization,
    workspace, active state and `parentId`, then `access_control_db_authorize_membership` with
    `content.read`. Any failure returns null. `get_table_sort_key` reads `sort[0]` only.
- `useFilesSortedChildren` in `packages/app/src/hooks/files-search-hooks.ts` merges it all:
  - Per kind and segment there are three streams: the open stream, the owner's restricted twin
    (empty and done for everybody else), and the side rows of that kind and segment. Each
    paginated stream uses `usePaginatedQuery` from `convex/react`, with pages of 100.
  - `merge_sorted_streams` merges the streams of one segment. A row shows only when every other
    stream that is not done has loaded strictly past it (`files_sort_compare`, then the stream
    order). Otherwise that stream's next page could still hold a row that sorts before it. The
    stream whose loaded rows end first loads next. The side rows come in one complete list, so
    they never hold the merge back.
  - Segments show in order folders/value, folders/missing, files/value, files/missing. A later
    segment shows only after every earlier one is done, so the next folder page never pushes
    files down. A missing segment starts once both value streams of its kind are done, and stays
    started for that sort.
  - The hook loads pages until it has the rows the table wants. `loadMore()` asks for 100 more.
  - Side row keys: built-in keys come from the row facts at once. A metadata sort asks
    `get_table_sort_key` for each side row; a side row without the key is hidden, like stream
    rows. With a filter, a side row shows only after `get_table_filter_match` says it matches. A
    null answer removes the row. A node that is in two streams for a moment (for example right
    after it became restricted) shows once.
  - While a new sort or a page loads, the last settled rows stay, with `aria-busy="true"` on the
    table. `rowsSort` and `rowsFilter` keep the sort and filter of the shown rows; the header
    arrows already show the requested sort. A side-row refusal removes a held row at once.
    `sideTargets` lists the side rows for field discovery.
  - No draft enters the table: no private rows.

### Table UI

- Default columns are `file.name`, `file.updated_by`, `file.updated`, then Actions. Columns may show
  `file.created`, `file.extension`, `file.size`, and qualified `metadata.<key>` / `frontmatter.<path>`
  fields. `file.name` and Actions stay visible. A column shows its field name as its label, with no
  second label ("Date created", "Type" and "(metadata)" are gone). One shared helper,
  `files_folder_table_query_field_text`, gives that name.
  Allow at most eight data columns, including file.name. Actions is outside that count.
  Sorting a hidden field does not show it. Built-in sortable headers keep their sort buttons.
- The toolbar holds the filter and sort bar (`FileNodeViewFolderFilterBar`), then "Save sort for
  everyone" (writers, only while the URL has a sort), then the Columns icon button.
- The Columns popover uses visible labels and native checkboxes, grouped as Built-in and
  Metadata. Its catalog covers the saved direct children: `list_folder_fields` (the open children,
  and for the owner the restricted children too) plus `list_node_fields` for each side row of a
  member. Search checks loaded keys. Show more fields requests another page from unfinished
  sources. An absent selected key stays removable.
- Column choices use `app_state::files_folder_columns::scope::${membershipId}` in browser storage.
  Each folder id, or `root`, has its own list. Keep at most 100 recent folder choices per membership.
  A folder rename keeps its choice. Another membership starts with its own choices. A list saved
  before the rename may hold `type`. The reader maps it to `extension`, and the key is written
  again only at the next column change.
- Cells read their own row facts or `files_metadata.get_field_values`. Every row is saved, so cells
  show committed values, also while the owner edits pending text. Lists show the first plain
  value. Only a checked missing value shows `—`. Loading, deferred, and failed reads have real text.
  Retry values belongs in Actions, so it does not open the row link.
- A `file.updated_by` cell reads `users.get_anagraphic` for the row's updater and shows
  `files_table_updated_by_text`: the name, or "Unknown" when no name is found. It shows
  "Loading…" with the `loading` state until the query answers, never the raw user id.
- `files_updated_by_docs` keeps one updater sort doc per file node with a real user updater: its
  parent, kind, name, archive id, restricted-root flag and the updater's name key. Nothing reads
  it yet; the updater sort comes later. Every node write calls `files_updated_by_db_sync_node`
  after it: insert, move, archive, restore, restrict, the member create door, the content writers
  in `files_nodes_content.ts` and the R2 text finalize. Hard delete removes the doc. A name change
  runs `internal.files_updated_by.drain_user_name`, which patches the user's stale keys in
  batches, so the key can lag behind the name a cell shows.
- Metadata display keeps at most 100 active targets and 700 value page descriptors. One observer
  uses the editor scroll box with a 400px vertical margin. Focused rows come first, then visible
  rows, then nearby rows. Scrolling and resizing update that order. Offscreen payloads are dropped.
  This bound covers cell display only; side catalog and sort queries use the full supported side set.
- An empty readable folder keeps its toolbar and header. "This folder is empty" shows only after
  every stream is done without an error. With a filter, an empty done table says "No rows match
  this filter" ("No matches in the rows checked" when some shared items are not shown). While a
  stream has more pages but no row to show yet: "No matches loaded yet. Show more to keep
  looking." Wide tables scroll horizontally inside the table region.
- The table carries `data-sort-fields` for the sort of the shown rows (`rowsSort`, held while a new
  sort loads). Headers follow the requested sort at once: the sorted header carries
  `data-sort-direction`, the arrow, and `aria-sort` for the new sort before its rows arrive. A sort
  change alone shows no notice; the table only sets `aria-busy` and `data-sort-state="applying"`.
  `Showing: …` appears only while the held rows belong to another filter.
  A header click sorts by that field: the field's first direction, then later clicks flip it.
- While a filter is on, the effective order is the filter's order. Its direction comes from the
  URL sort token when it names the filter's field, else A to Z. `aria-sort` and the arrow follow
  this order. The static text "Sorted by <column> because of the filter" is tied to the grid with
  `aria-describedby`. The header buttons of other columns have `aria-disabled="true"` and point to
  that text, but stay focusable: a click or Enter does not sort and shows "Remove the filter to
  sort by <column>" (`role="status"`).
- A metadata sort with no filter shows the static text "Rows without <key> are hidden." There is
  no text yet about members' shared items: until shared items get their own streams, a member's
  shared rows still show in metadata sorts and filters when they have the key.
- A sortable header is one `<button>` stretched over the whole cell with a `::after` overlay, so a
  click anywhere in the cell sorts and the focus ring wraps the cell. The column options button sits
  on top at the right edge and opens its menu without sorting. Only sortable headers get the hover
  background and pointer. A column that cannot sort (`file.updated_by`) has no sort button and no hover.
- Each header has a column menu. Sortable columns offer both directions (each sets the sort) and
  Filter by, which puts `file.<field>:` or the metadata key in the bar and opens its operations.
  Every column except file.name offers Hide column. While a filter is on, the Sort items of other
  columns stay in the menu, disabled with `aria-disabled` but reachable by keyboard, and show the
  reason "Remove the filter to sort by <column>".
- Cap notice: "Too many shared items here to sort. Some are not shown."
- A failed stream or side query shows "Filter could not be applied" (or "Folder contents could not
  be loaded." with no filter) and Retry, which resets the side queries.
- The table first shows 5 rows. Show more shows the rest of the loaded rows; when every loaded row
  is shown and the folder is not done, it asks for 100 more. Show less goes back to 5. The table's
  README comes from `files_nodes.get_folder_readme`, not from the loaded rows.
- Row actions look up the saved row in one merged list: the tree rows from `FilesTreeProvider.useFolders` plus the table rows' `treeRow`. So a row on a page the tree has not loaded still works.
- Every table row is a saved row: row actions use the real saved document and its current
  permission data. Private folders (the draft folder view) use tagged children and owner review
  actions.

### Table filter and sort bar

- The bar (`file-node-view-folder-filter-bar.tsx`) is one input with chips, copied from
  `FilesSearchInput`. The URL owns the state. The `filter` search param holds the committed tokens,
  and `view_q` holds the text still being typed (debounced 300 ms, never parsed). The folder keeps no
  local filter or sort copy, so a refresh, a copied link, and Back all restore the table.
- One token is `<field>:<op>[:<value>]` for a filter, or `sort_by:<field>:<asc|desc>` for a sort.
  Fields are `file.name`, `file.updated`, `file.created`, `file.extension`, `file.size`,
  `metadata.<key>`, and `frontmatter.<path>`. A metadata key never contains `:`. There is no
  negation. The grammar and the cleaner live in `shared/files-folder-table-query.ts`.
- Allow one filter, or `file.name:starts_with` plus one "is" filter, and one sort. The "is"
  filters are `file.extension` is or missing, `file.size` is or missing, and a metadata is. The
  index of an "is" filter keeps the name right after the value, so the name prefix is one more
  range on the same index; other pairs, free AND, and multi-sort wait for the search engine. The
  pair reaches the server as `filter` plus `namePrefix`.
- The filter picks the index, and the index fixes the order (`files_table_filter_order_field`):
  - `file.name` starts with, and every "is" filter: name order.
  - `file.updated` and `file.created` (on, before, after): that date.
  - `file.size` at least and at most: size. At most leaves out the rows with no size.
  - A metadata starts with or present: that key's value.
  Both directions work. While a filter is on, a `sort_by:` token for another field is refused with
  "Remove the filter to sort by <field>". The parser reads filters before sorts, so a filter
  always wins over a sort for another field.
- A typed token that breaks a rule stays in the input and the bar shows why (`role="alert"`): "Use
  one filter, or 'name starts with' plus one 'is' filter.", "Remove the filter to sort by
  <field>", or "The folder table sorts by one field". A URL that breaks a rule is cleaned:
  `validateSearch` in the files route keeps the first allowed filter (or pair) and the first
  allowed sort, drops the rest, and the router rewrites the address bar. So old links with `name
  contains`, a metadata `missing`, or extra sorts open with those parts removed. Bare words are not
  structure and are never parsed.
- Enter and Space commit whole tokens. Ctrl+Space or the slider button opens the menu. Menu groups:
  Sort, Filter by, Sort by, Direction, How to compare, Values. Value suggestions for metadata and
  frontmatter fields come from `files_metadata.list_search_values`. Backspace on empty text focuses
  the last chip. The Clear button removes every token. Typing `sort` offers `sort_by` and a metadata
  key named `sort_by` side by side. The menu stops offering `sort_by` once the bar has a sort, and
  with a filter Sort by lists only the filter's order field. With a filter, Filter by lists only
  the fields that can join it (file.name next to an "is" filter, an "is" field next to a name
  prefix, with only its is and missing operations). When nothing can join, the menu says "Use one
  filter, or 'name starts with' plus one 'is' filter."
- Every same-node navigation (view, editor mode, `q`) carries `filter` and `view_q`. Every link to
  another node drops them, so a child folder opens clean and Back restores the bar. The `files::open_browser` event opens a file, which has no table, so it drops them too.
- Operations per field: `file.name` offers starts with. `file.extension` offers is and missing.
  Dates (`file.updated`, `file.created`) offer on, before, and after one local calendar day,
  written `2026-09-04`. `file.size` offers is, at least, at most, and missing. Metadata offers text
  is, starts with, and present. An applied key can stay hidden as a column.
- `is` and `starts with` on names and metadata compare the stored sort key
  (`files_sort_text_key`): case and accents are ignored, and digit runs compare by value. The key
  writes a number with its length first (`2` is `012`, `10` is `0210`), so a `starts with` value
  cannot end in a digit: the bar says "'Starts with' cannot end with a number here. Remove the last
  digits, or use 'is'." The check reads the key, so a digit followed by an accent mark is refused
  too. A `starts with` range ends at `string_prefix_upper_bound` of the key.
  `file.extension` uses the lowercase extension. A leading dot is ordinary input and does not match
  an extension. Dates use checked half-open day bounds. Size is a nonnegative whole number;
  folders have no size.
- Known limit: "starts with" uses the sort key, so a few letters that change at the end of a word
  (Greek final sigma) can miss rows.
- A filter pages like the plain table: five rows first, then Show more and Show less.

## File Cut, Copy, And Paste

- `FilesClipboardProvider` lives inside `AppTenantProvider`, keyed by membership. It keeps source
  node ids, mode, and a local revision in memory. Navigation keeps the clipboard; reload and
  workspace or account changes clear it. It does not write to the operating system clipboard.
- Sidebar row menus offer Cut and Copy. A selected row uses the full selection; an unselected row
  uses only that row. The top `More options` menu has no Cut, Copy, or Paste: use Mod+X, Mod+C,
  and Mod+V on the tree for the selection. Copy path, Copy link, and
  Copy node id keep their existing behavior. When a folder and its children are selected, all
  menu and keyboard entry points keep only the top-level selected items in the clipboard. Collapsing
  a folder keeps its selected children available to those clipboard actions.
- Folder row menus offer Paste into that folder. No menu pastes into the root folder. Like the VS
  Code explorer, a click on empty tree space focuses the `role="tree"` element itself (it has
  `tabIndex={-1}`, so it stays out of the Tab order), and Mod+V there pastes into the root. The
  scroll box draws a thin focus ring while the tree element has focus. File rows never act as
  folders. There is no Paste button in the sidebar or the folder toolbar, and no line that says
  how many files are ready to copy or move. The selection count already shows how many rows are
  selected.
- `FilesClipboardProvider.useHotkeys` scopes Mod+C, Mod+X, Mod+V, and Escape to file navigation.
  Sidebar Paste uses the focused folder, or the focused file's parent. When the key comes from the
  tree element itself (no row has DOM focus), it uses the root. Headless Tree still keeps a
  `focusedItem` then, so check the event target, not `getFocusedItem()`. Folder-table shortcuts use
  the focused row. The folder toolbar's New file and New folder group also accepts Mod+V for the
  open folder. That group refuses when the folder cannot take children, or while a create is still
  running. The table does not add multi-selection. Search, rename, editors, chat, and other
  editable controls keep normal text shortcuts. Copy and Cut also leave selected text alone.
- Cut requires source move access, including visible protected descendants. Copy only needs read
  access. Paste requires destination write access. The backend checks the full operation again.
  A move also checks hidden and archived restricted descendants before changing any paths.
  Cut rows are muted and their accessible names say `ready to move`. Escape clears only an idle
  cut while file navigation has focus. Copy stays until the next Cut or Copy, or until the
  workspace changes. There is no Clear button.
- Paste calls `files_transfer.start`. The provider keeps one request id after a lost response,
  and blocks another start while this member has an active run in the workspace. Run progress
  comes from `get` and `list_current`. Tree changes come from the live `list_tree_children` pages
  of the open folders.
- The progress dialog opens by itself only when the paste has more than one source. A one-item
  paste shows only its Activity card, which can still open the dialog.
- The progress dialog says `Paste files` until the saved run kind is available, then shows
  `Copy files` or `Move files`, counts, and 50-item pages from `list_items`. Previous/Next page
  follows the server cursor, even after an empty page. Each conflict shows its authorized source
  and destination paths. File name conflicts offer Keep both, Replace, or Skip. Copy folder conflicts
  offer Keep both or Skip: a pasted folder never merges into another folder. Move folder conflicts
  offer Keep both, Replace empty folder, or Skip. Replace sends the exact reviewed target and version.
  Move has no future-folder replace choice. The remaining-folder choice has no Replace or Merge.
  Changed or unavailable items offer only Skip or Stop. Remaining-file and remaining-folder
  choices start unset. Continue submits only the current page. Choices reset on each server revision.
  Finished items show their authorized output path and say Saved or Ready for review.
  Hide, X, and Escape close the
  dialog without stopping the run. After any copy is published, the stop button says
  `Stop and keep completed copies`; before that it says `Cancel`.
- Activity can reopen the dialog after navigation or reload and can stop an active run. Clipboard
  runs belong to their requester. Terminal runs can be dismissed without workspace write access.
  When the server allows it, Retry remaining files starts a new run and opens its progress.
  A lost retry response keeps the same request ID. A retried Cut still clears only moved IDs
  from its original clipboard revision, so a newer Cut or Copy stays intact.
  Canceled runs say `Stopped` and use a neutral icon. Active runs cannot be dismissed.
- `AppActivitiesProvider` owns common Stop requests above the clipboard provider. The server
  returns controls and common progress through Activity. See the [Activity spec](../activities/SKILL.md).
- A finished cut removes only the returned moved ids from the same clipboard revision. Opening
  an older Activity dialog must not stop that update. A later Cut or Copy must stay intact. Copy
  stays ready after completion so it can be pasted again.

Backend rules, limits, billing, cleanup, and Activity privacy are in
[Files transfer runs](references/transfer.md).

## Selection And Primary Action

- Primary click implements single select, toggle-select, and shift-range.
- A pointer down or focus outside the tree's selection areas (`FILES_SIDEBAR_SELECTION_CONTEXT_EVENTS`) drops the multi-selection and selects the open file's row again. The reset is skipped while a tree menu or the Archive dialog is open, so a cancelled multi-select archive keeps its selection.
- Non-modifier click runs primary action for node items.
- File primary action navigates to the file.
- Folder primary action navigates to the folder screen.
- The selection anchor drives active-track highlighting.
- Create lets the route update selection and its anchor. Do not select the new id before navigation:
  the tree query can refresh first and restore the previous route's selection.
- Create waits for both the new route and its visible tree row. A layout effect starts rename and
  ends the busy state together with route selection. Leaving the page or workspace cancels the
  pending navigation and rename; a server create already in progress still finishes.
- Keep normal navigation focus in a passive effect, after tree data resets. Moving it to a layout
  effect loses keyboard focus during live tree updates on the root page.
- The current route/navigated row uses a stable row-left accent rail instead of bold text. Keep row labels regular weight so selection does not change text metrics. The rail belongs only to navigated rows. The navigated row's fill is a neutral base gradient, not an accent tint: the rail alone carries the accent "current" signal. Internal Headless Tree focus and pointer hover are not selection and must not paint the selected row surface after pointer clicks; hover can brighten row text, while `:focus-visible` keeps the keyboard interaction surface. Idle non-selected rows use one quieter foreground shade and brighten to the navigated-row lightness on hover, selected, and navigated states. Keyboard focus must stay as the top visual layer: keep the focus ring continuous, keep the rail visible just inside it, and remove idle title input chrome so row names render as plain text outside rename mode. The disabled title input must inherit the row color; otherwise only icons dim while filenames remain too bright.
- Rows are single-line: only the icon, the name, and the inline `Processing` badge. The tree never marks pending-change state — that lives in the Pending changes panel only. The updated-when/by info lives in the row tooltip, not in the row itself.

## Create, Rename, Archive, Unarchive

- Root actions create `New File` and `New Folder`.
- Folder row actions can create child files and folders.
- File rows do not show child-creation actions.
- Default generated names are sibling-aware: `new-file.md`, `new-file-1.md`, `new-file-2.md`, and the matching `new-folder`, `new-folder-1`, `new-folder-2` sequence.
- File and folder create support path-like names: missing parent folders are created first, then the final file/folder is created at that path.
- Only an active folder takes new children. Every create door with a parent id answers `Not found`
  when the parent is a file or an archived folder: `create_folder_node`, `create_text_node` (its
  preflight refuses before any R2 write), `create_upload_node(s)`, and the shared
  `files_nodes_db_create_node_recursively_at_path` that the copy and publish paths use. Paste
  (`files_transfer.start`) answers `Destination changed`, moves answer `Not found`, and a draft whose
  saved parent is archived cannot be saved. A live child under an archived parent would stay hidden
  until the folder is restored.
- The folder view of an archived folder (reached from the draft recovery link `Open archived folder`)
  shows `This folder is archived. Restore it before adding items.` and disables New file, New
  folder, Paste, and Create a README.md. Its archived children are not listed in the folder table.
- File create/rename input canonicalizes path segments in the frontend. Backend recursive creation trusts callers to pass a non-empty normalized path; do not claim it returns a normal empty-path validation result.
- Rename input filters draft typing/paste/composition through shared live-name normalization: files and folders allow lowercase letters, digits, `/`, `.`, `-`, `_`; adjacent separators are blocked while typing, except a leading dot can begin `.agents` or `.system`. Special file-name casing remains submit-time only.
- File and folder create/rename reject double-dot names; file names with a non-empty basename and a trailing dot are treated as missing the extension, while invalid extension text such as separators inside the final extension is rejected.
- Sidebar file CREATE makes a Markdown file with a default name (`create_text_node` stamps `text/markdown;charset=utf-8` and `rich_text`). The user renames it afterwards, and a rename never changes the type. Files of other text types enter through uploads, the agent's shell writes, and the public write routes, which take the type from the caller or the name's hint. The content type choice does not add an extension. See `../files-editable-text/SKILL.md`.
- File RENAME keeps the stored type: `rename_node` changes the name only, so `data.json` → `data.yaml` still opens as JSON and `notes.md` → `notes.txt` still opens in the rich text editor. Names follow `files_normalize_file_rename_name`; a stored upload still needs a real extension.
- R2 source file upload requires a real extension and uses the normal tree node as the visible processing/finalized item instead of a dedicated upload list.
- Uploading is closed to `Free`. `files_nodes.create_upload_node` (one file) and `files_nodes.create_upload_nodes` (a folder import) both call `billing_db_check_paid_plan` on the workspace payer right after the permission check, and refuse with `This workspace's plan does not include file uploads`. The payer is `billing_pick_billed_user_id`, so an owner-billed organization answers with the owner's plan, not the acting member's. The sidebar shows that message directly in its error toast, and the rich-text media upload returns it to its caller, so there is no separate UI copy to keep in sync. Creating and saving text files is NOT gated by plan — they answer to the credit gate instead. The same gate guards `/api/v1/files/upload-urls` and the plugin service route; see `../public-api/SKILL.md`.
- Uploaded names whose type hint is not Markdown are normalized with `files_normalize_upload_file_name`, which preserves the uploaded extension and uses only the last browser path segment. Names whose hint is Markdown follow normal Markdown file normalization.
- Normalized upload names must have a real extension: the dot cannot be the first or last character.
- Names still missing an extension after normalization open the rename upload modal.
- Upload path conflicts open the conflict modal; file conflicts support replace or renamed upload, while folder conflicts block replacement. The draft carries its `rootKind` (rich, plain, or null for a stored upload) for the modal's copy; its stored type was decided when the file was picked, so the rename field accepts any valid name and only refuses a stored upload without an extension.
- File name normalization uses conventional `README`, `AGENTS`, and `SKILL` basenames. A new bare `readme` becomes `README.md` in create, rename, upload, and import. Other rename and upload names keep the typed extension. The `.agents` and `.system` folders keep their leading dot (any casing becomes lowercase) and appear like any folder. The cloud browser saves downloads in `/.system/downloads/`. Existing stored names are not migrated, and file lookup stays exact.
- File rename selects the basename by default so `.md` is not included in the initial edit selection.
- Rename uses `files_nodes.rename_node` with Convex `optimisticUpdate` and
  `optimisticallyUpdateValueInPaginatedQuery` for immediate title feedback across cached pages.
- Rename and saved-node moves use `files_nodes_db_preflight_move` followed by
  `files_nodes_db_apply_move` in the same mutation. Every move entry uses them: `move_nodes`,
  `rename_node`, the Cut/Paste commit in `files_transfer.ts`, `apply_file_pending_move`, and review
  runs. Preflight resolves the final paths, permissions, write policies, search chunks, and
  metadata of the named items before any Files write. It reads no other descendant. It finds the
  restricted folders inside a reparented folder by their stored `treePath` and asks each one for
  write access. Archived renames keep their archive identity and can share an active path.
- Apply writes the named items now. Then `files_subtree_ops_db_start_rebuild` (kind `move`, in
  `files_subtree_ops.ts`) starts a move job for each moved folder. The job walks children by
  `parentId`, in pages of 50 by name and creation time (`by_organization_workspace_parent_name`). The
  queue takes the row with the highest number first, so the job goes into the folders of a page before it goes back
  for the next page, and the queue stays small. It rewrites each child's `path`, `treePath`,
  `pathDepth`, and `restrictedScopeNodeId` from its live parent, with the child's search chunks and
  metadata docs. A child that is its own restricted folder keeps its own scope. The job is done only
  after one full pass from the roots writes nothing. A step ends after it writes 75 items or nears a
  transaction limit. The children of the page it did not reach wait on the queue row (`pending`), and
  the next step takes them first. A normal page never splits items with the same name and creation
  time: it leaves the group for the next page. When more than 50 of them share both (every replace
  of a file leaves an archived one), the job reads that group 50 at a time with a paginated read and
  saves where it stopped. Convex allows one paginated read per mutation, so a big group can take
  several steps. The first step runs inside the request, so a
  small folder is done there with no op and no Activity. A bigger one leaves a `files_subtree_ops`
  op and a requester-only Activity (source kind `files_subtree_op`, title "Move files") that shows in
  the feed and has no Stop. Each scheduled step has one retry due after 60 seconds. A retry of a
  finished step does nothing. The recover cron still schedules a lost step again.
- While a move op exists in the workspace, a child can still carry its old stored path. The tree is
  right, because it lists children by `parentId`. `files_db_get_visible_node_by_path` in
  `server/files.ts` then walks names from the root instead of one path index read. The path picker
  query `files_nodes.get_authorized_by_path` uses that same walk, so a moved child resolves at its
  new path while its stored path still has the old prefix.
- A path-like rename starts at the source's current parent. Missing folders are planned below a
  saved parent ID with `missingParentNames`. Shared folder chains are inserted once. Paths and
  inherited scopes use that saved parent's final position, even when it also moves in the batch.
  Apply inserts the folders from top to bottom and resolves their real IDs without reading again.
- Move limits (`move_too_large`) bound only the request: the named items, new parent folders, and a
  replaced empty folder's archived children. That is at most 139 changed or inserted nodes
  (`MAX_MOVE_NODE_COUNT`, small enough for the pending overlay flush), 2,000
  Files docs read or written, and 4 MiB in each direction. Descendants of a moved folder do not count,
  because the move job writes them. A refusal writes no Files changes. Permission reads and the
  caller's receipt use separate transaction headroom.
- The selected file/folder path auto-expands in the sidebar after route changes and path-based create/rename moves so the focused row stays visible.
- Archive/unarchive uses `files_nodes.archive_nodes` / `files_nodes.unarchive_nodes`. Archive always asks first in the shared `FilesArchiveModal` (`files-archive-modal.tsx`). The sidebar row menu, the toolbar Archive-selected button, the folder explorer row menu and the breadcrumb menu open it with the nodes to archive; the modal owns the mutation, shows a refusal inline in the dialog (`role="alert"`), and reports success to its host. The row menu of a row outside the selection enables Archive from that row alone. On a selected row it acts on the whole selection, like the header Archive-selected action: Archive is enabled when at least one selected row is writable and has no visible protected descendant, even when the clicked row is read-only. The dialog lists every selected row, read-only ones too, one name per line in a read-only `TextMonospaceBlock` (`Items to archive`). Ctrl+A in it selects only the names. It shows 6 lines. With more than 6 names, a Show more button (`aria-expanded`) grows it to 16 lines. A click in the list does not grow it, so the text does not move under a selection. The server refuses each selected item it cannot change, with everything inside it, and archives the rest. When the archive ended in the request but refused items, the dialog closes with a warning toast ("Some items could not be archived. See Activity.") whose View opens the job; the Activity card counts them in its result line ("Archived 45 of 46 items."), still as Completed, and the job dialog lists the archived names under `Archived items` and the refused ones under "Not archived (N)" (see `../activities/SKILL.md` Feed cards). `onArchived` gets only the ids the server did not report as refused (`notArchivedNodeIds`). A background job can refuse more later. When the request's own check refuses every item, the dialog shows the refusal inline and stays open. After a sidebar confirm, keyboard focus moves to the first row after the archived rows, or to the last row before them. The sidebar picks that row while the archived rows are still in the tree (Convex resolves the mutation in the same task as the tree update) and moves DOM focus from an effect once the dialog has closed, because the sidebar is inert while the dialog is open and the closing dialog first gives focus back to the button that opened it. A multi-select archive also clears the selection. Cancel puts focus back on the first row of the request. Restore is still direct.
- A big archive or restore goes on as a background job (rules in `../files-read-only/SKILL.md`). The job stamps every named item first, at most 75 per step, so with more named items some stay in the tree until a later step. Then it stamps the items inside them, the first named item's folder first. Restore first finds every top item of its archive operation by creation order and keeps at most 64 folder paths that hold them (up to `/`). It checks those paths against running jobs. Then it finds the top items again one page at a time while it brings them back. A name clash inside a restored folder asks like a clash of a top item. A copy during a restore copies only the items already back (see `references/transfer.md`). A blocked restore waits hidden and checks access again after promotion. The job dialog `FilesArchiveRunModal` shows Stop only when the server returns `controls.canStop`: archive never has it, and a restore has it only while it waits for a name clash choice. A restore clash offers Keep both, Replace, or Skip, with no Merge.
- The row menu's Restore gate mirrors the backend restore plan (`can_unarchive_item`): a node whose parent is missing or still archived restores to root, so Restore also needs workspace write at root plus scope manage when the node would leave its restricted scope. A node that carries its own restriction only needs its own write answer. An in-place restore only needs the node's write answer.
- TODO: archived nodes are never purged. They stay until the whole workspace is deleted. Add a
  retention purge that permanently deletes an archive operation some time after it was archived, like
  the 30-day trash of Google Drive, Dropbox and OneDrive. Decide the retention period first.

## Content Type Checks

- Trust app-owned content-type strings to be lowercase.
- Take the upload's type from the file NAME first (`files_guess_content_type_from_name` in `shared/files.ts`); the browser MIME is only the fallback when the name has no hint — the sidebar's own upload prepare does this. The shape follows the type (`files_yjs_root_kind_of_content_type`).
- Use `"text/markdown;charset=utf-8" satisfies files_ContentType` when writing the canonical Markdown content type at an md-by-definition site.

## Read-Only Files And Folders

- Tree rows (`list_tree`, `list_tree_children`, and the other tree queries) carry `canWrite`,
  `writeBlockedReason` (`null`, `permission`, or `read_only`), and `writePolicyState` (`none`,
  `read_only`, or `writer`). They never carry raw `writePolicy` or `newChildWritePolicy`. When the
  loaded rows change, derive one set of loaded ancestors that contain protected descendants, so
  Archive can warn without scanning a subtree for every rendered row. The set only knows loaded
  rows. The server check on archive stays the authority for descendants that are not loaded.
- Keep locked rows selectable, openable, searchable, and expandable. Add the lock mark beside, not in
  place of, the restricted-access icon. Use the exact row descriptions and status text from
  `../files-read-only/SKILL.md`.
- Disable Rename, source drag, and locked-folder drop targets when the named item or its immediate
  parent is protected. A writable folder can be renamed or moved while it holds protected children.
  Archive still looks at protected descendants, so Archive/Restore stays disabled when a visible
  descendant is protected. An unlocked ancestor with a visible locked descendant may still receive a
  new sibling. A mixed selection is blocked when any affected node is blocked.
- A locked folder disables New file, New folder, Create README, Upload file, Import folder, and
  external drops. A drop over a locked file still resolves to its writable parent under the normal
  file-row rule. Upload conflicts keep rename-upload available while Replace is disabled for a locked
  occupant.
- The row menu and selected-node header open Files Properties. Files Properties offers Editable,
  Read-only, and Selected writer. Folders also have a New items default. There is no inherited text
  and no Open parent policy. Share remains a separate control.
- Archived local locks stay marked and manageable. Restore remains blocked until that node's lock
  is removed.

## Public Link Mark

A file with a public link ("Anyone with the link can view", made in the Share dialog) has a mark in
the tree. The link rules live in the "Public file links" section of `../access-control/SKILL.md`.

- `FilesSidebar` reads `files_share_links.list_workspace_links({ membershipId })` and passes the
  node ids down as `publicLinkNodeIds`. The `file.link:public` search chip reads the same query with
  the same args, so Convex keeps one subscription for both. Do not add a second query or a provider.
- The list names only the files the member may read, and it never holds the token. So a member who
  cannot manage the file still sees the mark on a file they can read. Only a manager gets the token,
  from the Share dialog.
- While the list loads, or when it is refused (`null`), the set is empty and no row has a mark. The
  mark is only a hint.
- The mark is a small link badge over the corner of the leading icon
  (`FilesSidebarTreeItemIcon-public-link`), not a second icon. A restricted file already shows the
  `FileUser` icon, so a restricted file with a link shows both marks. The badge is decoration only:
  the icon is `aria-hidden`, and the badge has no tooltip or pointer target of its own.
- The row gets `data-file-public-link="on"`. Rows without a link have no such attribute. Browser
  tests read this attribute instead of a screenshot.
- The row's accessible name ends in ", public link", after every other suffix (restricted,
  read-only, archived, ready to move, uploading).
- The row tooltip starts with "Anyone with the link can view." Then it says "In Files, only chosen
  people and roles have access." for a restricted file, or the usual updated-when/by text for other
  files. A restricted row without a link keeps "Only chosen people and roles can open this".

## Drag And Drop

- In-tree DnD uses headless-tree `onDrop` -> `files.move_nodes`.
- `canDrag`, `canDrop`, and keyboard rename use the same per-node `content.write` answer as each row menu. Restricted scopes are queried once per scope, while unrestricted nodes and root share the workspace answer.
- `canDrop` also guards target kind, self-drop, descendant-drop, source write access, and destination write access.
- Moving a descendant out of its restricted scope also needs that scope's `content.permissions.manage` answer. The restricted folder itself carries its scope with it, so moving that folder does not need this extra check.
- Root and folders can receive drops.
- Files cannot receive drops.
- External OS file drops use headless-tree foreign DnD for tree targeting and `file-selector` for browser file extraction.
- Foreign file and node drops use the same destination write, source write, and cross-scope manage checks as in-tree drops.
- The folder table uses the same source write, destination write, and cross-scope manage checks for its row drag/drop.
- External drops over file rows resolve to the file's containing folder. Root, folder rows, empty-folder placeholders, and file-row parent resolution are accepted targets.
- A single bare-file drop keeps the per-file flow: `files_nodes.create_upload_node`, PUT to the signed R2 URL, then the R2 event flow, with the rename/conflict modals. The frontend takes the type from the file name's hint (after the `.markdown` → `.md` alias); the browser MIME is only the fallback for a name with no hint.
- Multi-file and folder drops run the folder import flow (see "Folder Import" below). The "Import folder" menu action feeds the same flow through a hidden `webkitdirectory` input.
- Keep external upload acceptance file-type neutral. Do not add MIME or extension allowlists beyond the existing non-Markdown uploaded-source requirement that a filename has a real extension. `.DS_Store` and `Thumbs.db` are the only always-filtered junk names.

## Upload Lifecycle

1. The Upload file menu action and a single bare-file drop receive one file. Folder drops, multi-file drops, and the Import folder picker run the folder import flow, which ends in the same per-file lifecycle below.
2. The client prepares static images, takes each file's type from its name's hint (or the browser type when the name has none), normalizes the path, and opens the draft/conflict modal when needed (single file) or the import conflict modal once for the whole batch (folder import).
3. `files_nodes.create_upload_node` (single) or `files_nodes.create_upload_nodes` (batch) checks paid plan, safe size through 2 GiB, and remaining `stored_file_bytes` before any allocation. A batch admits all accepted items together; skipped conflicts use no capacity. It then creates the upload asset plus visible source node. After batch validation, per-item problems are reported as skips, never whole-call failures. `create_upload_node` takes `onConflict: "replace" | "fail"`: `"replace"` (the sidebar's choice after the conflict modal) archives the existing file, `"fail"` answers `_nay` with the path-taken message so the caller can pick another name — the rich-text editor always uses `"fail"` because the existing file may be another document's embed.
4. The browser uploads directly to the fresh asset's canonical key through the signed R2 PUT URL.
   Send every returned header, including `If-None-Match: *`. A 412 means the attempt already has an
   object, not that this PUT's body matches it. Keep the node and wait for its normal server status.
5. The R2 event verifies the stored object and publishes its key, size, and optional ETag. If the
   node became read-only after step 3, this accepted upload still finishes and the node keeps its lock.
6. Editable text uploads (decided by the node's stored content type) run the host conversion, which creates the Yjs document in the type's shape, chunks, and a content snapshot on the uploaded node. Text above the conversion limit or undecodable text stays a stored file. An object above its declared upload size is refused before conversion.
7. Uploads that stay stored blobs — non-editable types and fallback-settled text — become terminal source files and dispatch eligible `files.upload.completed` plugin runs.
8. Installed first-party plugins own PDF, image, video, and audio-derived outputs plus their external provider calls.
9. Plugin-created outputs are ordinary Markdown files. No host-owned output placeholder exists before the plugin writes or touches the path.
10. Rich-text paste/drop/slash media uploads run this same lifecycle (`create_upload_node` with `onConflict: "fail"`, signed PUT, R2 event) from the editor, landing files in an `assets` folder next to the document. The editor-side flow is specified in `../files-rich-text-embeds/SKILL.md`.

## Folder Import

- Entry points: dropping multiple files or a folder onto root or a folder row, and the "Import folder" menu action (hidden `<input webkitdirectory>`; the attribute is spread raw because React's input typings omit it).
- The import runs in `run_folder_import` (`files-sidebar.tsx`) with progress in the module-level `useFilesImportStore`, so a sidebar remount re-attaches to a running import. Only one import runs at a time, and a workspace switch mid-import requests a cancel.
- While an import runs, the upload/import entry points and external file drops are disabled, but moving existing nodes in the tree stays enabled — an import can take minutes and node moves conflict with nothing in it. Only the short single-file upload blocks node moves.
- Client-side prepare: junk filter, image compression, segment normalization with the shared name normalizers (the `.markdown` → `.md` alias runs first, then the name's type hint picks the name rule), and first-wins dedupe of fully normalized target paths. Client skip reasons: `invalid_name`, `missing_extension`, `too_large`, `too_deep`, `duplicate_after_normalization`.
- A bundle containing `SKILL.md` has stricter path preflight in `build_import_plan`. Conventional SKILL.md and `.agents` casing is allowed, but resource paths must survive normalization unchanged. A changed, invalid, or colliding bundle path stops the whole import before upload and lists the paths to fix. The user must rename resources and update their references first. Ordinary uploads keep the normalization and dedupe behavior above. See the [workspace skills spec](../ai-chat-skills/SKILL.md).
- Caps: 1,000 files per import; 50 items and 1 GiB declared bytes per `create_upload_nodes` call; path depth 32; path length 1,024 characters.
- `create_upload_nodes` charges `files_tree_write` once per call and the `files_bulk_import` bucket once per item; the client waits `_nay.data.retryAfterMs` and retries the chunk on "Rate limit exceeded".
- Server-side per-item skip reasons are only `conflict` (an existing file was kept, or a permission check refused — deliberately indistinguishable so the payload does not reveal restricted paths) and `path_blocked` (a folder holds the target path, a file holds an ancestor segment, or another batch item collided). `path_blocked` names the blocking node's kind, so it is only used when the caller can `content.read` that node; a hidden blocker answers `conflict` instead.
- Before any write, the client asks `files_nodes.get_upload_conflicts` which target paths already exist and confirms replace/skip once in `FilesSidebarImportConflictModal`. The query filters by per-node `content.read`, so it reveals nothing `list_tree` would not show.
- Replace mode archives an existing file only after every existing folder on the item's path passed `content.write` (the pre-walk), so a refused item can never archive a file without importing its replacement.
- A failed or cancelled PUT calls `files_nodes.discard_failed_upload_node`, which removes the placeholder node and deletes the R2 object. `removed: false` means the R2 event recorded the object first, and the client counts the file as imported.
- A PUT 412 never calls discard. The import summary counts it as awaiting confirmation, and the
  normal file status updates when the R2 event arrives. It does not count that response as an imported file.
- Import assets keep `processingWorkId` unset, so the standard R2 event finalizer runs text conversion and plugin dispatch exactly like single-file uploads. `data_import` differs: it suppresses processing with `processingWorkId: null`.

# Headless-Tree Configuration Highlights

`useTree<files_TreeItem>` configuration includes:

- `rootItemId: files_ROOT_ID`
- controlled `expandedItems` + `setExpandedItems`
- `canReorder: false`
- sync data loader + selection + hotkeys + DnD + renaming + expand-all + click behavior + prop memoization features
- node-and-write-permission `canDrag` and `canRename`
- folder-only `isItemFolder`
- guarded `canDrop`
- guarded `canDragForeignDragObjectOver` / `canDropForeignDragObject` for external file drops

Row guide lines use `ItemMeta.posInSet` (zero-based) and `setSize` to find the last sibling.
Do not call `parent.getChildren()` for this check in each row: it loads every sibling again per row.

## Virtual Rows

- Headless Tree keeps the full visible item list and uses `buildProxiedInstance`. TanStack Virtual
  mounts only the viewport rows, five extra rows on each side, and active rows that must keep their DOM.
- The existing `FilesSidebar-content` is the scroll element. `scrollToItem` uses the virtualizer so
  keyboard navigation can reach rows that have not mounted yet. Opening a different node scrolls to
  its row after its ancestors expand; query updates and manual scrolling do not repeat that scroll.
- A normal row is 45 px. An expanded empty folder owns its extra 45 px placeholder in the same
  virtual row. Search hides placeholders. Keep the row keys tied to the row model so changed
  placeholders refresh heights even when they are offscreen. The tree has 2 px padding at each end.
- Keep the focused row (or first tab stop), rename row, open menu source, actual drag source, and
  Properties/Share source mounted. Do not pin every selected row. Dialog close restores the source's
  tree focus before clearing its pin so focus can return to the same DOM element.
- Focusing any row control also sets Headless Tree focus to that row. This keeps the More and folder
  arrow buttons mounted while they hold focus, including menu focus return after scrolling.
- Compare the live `focusedItem` id before setting it from a DOM focus event. Rename and keyboard
  navigation often set it first; writing the same id again rerenders the tree. Do not use `isFocused()`
  for this check: its first-row fallback can be true while the stored id is still null.
- Live node updates keep the current keyboard focus when its row is still visible. A changed route
  focuses its node; a removed or filtered row falls back to the visible route node or first row.
  Never focus the synthetic root: it has no rendered row and its Headless Tree index is -1.
- Query updates still reset Ctrl/Shift selection to the route row, but keep the keyboard target.
  Outside clicks and drag cleanup keep their normal focus reset.
- If a create action changes the route before its node reaches the tree query, keep valid keyboard
  focus while waiting and focus the new node when it arrives. Search filters do not make a known node new.
- Keep Headless Tree's ref and ARIA props on the inner `treeitem`. The absolute outer row has
  `role="presentation"`. Drop-zone height and target checks still use the full visible row list.
- `FilesSidebarTree` uses `use no memo` because the virtualizer returns a mutable instance. Its row
  components keep their normal memoization. Do not add per-row measurement: heights are fixed.
- `FilesSidebarTreeItem` reads the current tree values on every tree update. `FilesSidebarTreeRow`
  compares those snapshots before rendering the row UI. Compare every new render prop, callback,
  ARIA value, and guide-line set. Never compare old and new values by reading the same mutable tree.
- Only the active rename row receives rename input props. Idle titles must not receive the global
  rename value or a fresh rename props object on every keystroke.
- Global `isBusy` reaches only the row element, pointer hit-area, and native fieldsets through
  `FilesSidebarTreeBusyContext`. Keep the full row and its menus outside that subscription.
  The row's `isPending` prop covers only its own pending action. DOM controls combine both flags.
  Keep the focused row usable and the active rename input enabled while global work is pending.
- Arrow and action groups use native disabled fieldsets while pending. This keeps the child menu
  and tooltip components stable. Keep permission-specific disabling on each create button.
  Check native disabled state with `:disabled` or Playwright `isDisabled()`, not `button.disabled`.

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

- Tree updates come from `files_nodes.list_tree_children` pages of the open folders, plus pinned
  rows and shared roots. The default sidebar sends no `list_tree`.
- Search keeps ancestor chain for matching files/folders.
- Search-open expands relevant branches and search-close restores prior expansion.
- Search matches a name fragment, a path, a node id, and a pasted app link, and Enter opens the top match for each.
- `metadata.status:open`, `!metadata.status:done`, `metadata.priority:>2`, and `file.path:/tasks metadata.status:open` show the files and folders whose own metadata matches, plus their ancestors, and `/tasks-archive` stays out of `file.path:/tasks`.
- A member with no read access on a restricted folder never sees its files, keys, or values in the results or in the suggestions, while the owner sees them (second identity).
- A file with a public link shows the badge and `data-file-public-link="on"` for the owner and for a second member who can read it. `file.link:public` lists it even inside a folder that is not expanded, and Enter right after typing the chip waits for the link list.
- Breaking `search_nodes` on purpose empties every metadata chip while `file.name:` and free text keep matching, which proves the browser runs the Convex working tree.
- `Mod+K` opens the files sidebar when closed, focuses the search input, and keeps the chips.
- Renaming a row commits on Enter only while its live write permission still allows it. Losing that permission cancels the active rename.
- A pasted path URL opens the file, settles on `?nodeId=`, adds one history entry, and never flashes the not-found panel on a cold load.
- An unknown, archived, or wrong-case path URL shows the not-found panel with a working "Search for this path" link.
- Copy path yields the plain path; Copy link yields an absolute `?nodeId=` URL that reopens the same node; Copy node id yields the bare id. All three still work after the node is renamed or moved.
- File Cut/Copy survives navigation. Paste uses the stated destination. Cut clears only moved ids,
  preserves a newer clipboard, and marks rows accessibly. Normal text shortcuts still work.
- Conflict choices carry the current revision. Hide does not stop a run; Activity can reopen it.
  Stop keeps completed copies, reports an unconfirmed request, and waits for the server result.
- The folder table sorts by each built-in field and a metadata key in both directions, with folders first and missing values last; a metadata sort hides the rows without the key. Each filter orders the table by its own order in both directions, and other columns say "Remove the filter to sort by <column>". A writer's saved sort shows live for a second member; a sort in the URL stays with that URL and a different folder starts without it. The owner sees restricted children merged in order; a restricted child the member cannot read never shows, and Show more pages without repeats. Loaded rows stay in place when an earlier row changes. A draft create, move, rename, or delete does not change the table.
- Selection modes and anchor behavior are correct.
- A tree with thousands of visible rows mounts only the viewport plus active rows. Home/End and
  arrow keys scroll and focus correctly. Scrolling keeps an active rename, menu, drag, or dialog
  source mounted. Search toggles and folder changes leave no blank gaps or stale placeholder height.
- Root create can create a file and a folder.
- Root create, upload, and folder import controls stay disabled unless the destination is writable. The header "Archive N selected" action needs at least one writable selected row, like the row menu. The backend refuses each selected item that is unwritable or holds an unwritable item, lists a selected item that is gone as "Not found", and archives the rest, like `rm` with several files. The Archive dialog shows the refusal inline and stays open only when the request's own check refuses every item.
- Folder create can create child files/folders.
- File rows do not show child creation actions and are not expandable.
- Rename guards and optimistic rename behavior are correct.
- Archive/unarchive and archived filter/toggle behavior is correct.
- DnD allows legal moves, blocks drops onto files, and root-zone feedback works.
- A viewer cannot start keyboard rename or drag a row. Read-only root and folder screens disable create, README, upload, import, archive, and drop controls.
- With the matching plugin installed and enabled and its required secrets configured, verify PDF, image, video, and audio-derived outputs.
- Static image uploads are compressed in the browser only when the result is smaller and always keep a visible source node.
- Video and audio uploads remain visible as source nodes even when a plugin run fails.
- Markdown external file drops onto root/folders use the same signed R2 upload path, then finalize into ordinary Markdown file nodes.
- External file drops over a file row upload into that file's containing folder.
- A folder drop or Import folder pick recreates the nested structure; existing files surface once in the import conflict modal; cancelling mid-import leaves no `waiting_for_upload` phantom rows behind.
- Placeholder nodes are never sent to mutations.
- Normal tree/list/glob results expose uploaded sources and generated outputs as ordinary visible nodes.
