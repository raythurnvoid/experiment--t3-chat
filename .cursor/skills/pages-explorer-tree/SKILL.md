---
name: pages-explorer-tree
description: Practical guide for the current Pages sidebar (`@headless-tree` + Convex) implementation. This skill documents the **current** Pages sidebar implementation used by the app route: UI + behavior entry point: `../../../packages/app/src/routes/pages/-components/pages-sidebar.tsx`; Tree engine: `@headless-tree/core` + `@headless-tree/react`; Data source: Convex `ai_docs_temp` query/mutations. Use this guide when implementing or modifying sidebar behavior (search, selection, drag/drop, rename, archive/unarchive, create, and root-drop-zone interactions).
---

# Source of truth files

Primary:

- `../../../packages/app/src/routes/pages/-components/pages-sidebar.tsx`
- `../../../packages/app/src/routes/pages/-components/pages-sidebar.css`
- `../../../packages/app/src/routes/pages/index.tsx`
- `../../../packages/app/convex/ai_docs_temp.ts`
- `../../../packages/app/shared/pages.ts`
- `../../../packages/app/src/lib/pages.ts`
- `../../../packages/app/vendor/headless-tree/packages/core/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/react-compiler/index.tsx`

# Architecture overview

The Pages sidebar is implemented in `pages-sidebar.tsx` on top of `@headless-tree` with Convex-backed data.

- Tree engine: `@headless-tree/core` + `@headless-tree/react`
- Vendored sources: `../../../packages/app/vendor/headless-tree/packages/*`
- Backend data: Convex `ai_docs_temp` query/mutations
- Primary data source: `ai_docs_temp.get_tree_items_list` (server-driven)
- Local state is UI-only (`expandedItems`, search/selection, busy/pending flags) plus derived indexes from query data
- Prefer Convex mutation `optimisticUpdate` over ad-hoc local mirrored tree state
- Backend item types: `"root" | "page"`; placeholder rows are UI-only render artifacts
- Only `"page"` items are mutable entities

# Data model and contracts

- `pages_TreeItem` shape is defined in `../../../packages/app/convex/ai_docs_temp.ts`.
- `pages_ROOT_ID` and `pages_create_tree_root` are in `../../../packages/app/shared/pages.ts` (re-exported by `../../../packages/app/src/lib/pages.ts`).
- Backend returns root/page items only; placeholder rows are client-rendered.
- Placeholder nodes are structural UI helpers and must never be mutation targets.

# Component and helper structure

Main component:

- `PagesSidebar`

Main sections (same file):

- `PagesSidebarHeader`
- `PagesSidebarSearch`
- `PagesSidebarTree`

Tree-item components (same file):

- `PagesSidebarTreeItem`
- `PagesSidebarTreeItemArrow`
- `PagesSidebarTreeItemTitle`
- `PagesSidebarTreeItemIcon`
- `PagesSidebarTreeItemPrimaryContent`
- `PagesSidebarTreeItemPrimaryAction`
- `PagesSidebarTreeItemMetaLabel`
- `PagesSidebarTreeItemActions`
- `PagesSidebarTreeItemSecondaryAction`
- `PagesSidebarTreeItemSecondaryActionCreatePage`
- `PagesSidebarTreeItemMoreAction`
- `PagesSidebarTreeItemTrack`
- `PagesSidebarTreeItemPlaceholder`

Core helpers:

- `pages_sidebar_to_page_id`
- `pages_sidebar_to_parent_id`
- `pages_sidebar_get_default_page_name`
- `sort_children`

# State and behavior flows

## Server-driven data flow

- Sidebar queries `ai_docs_temp.get_tree_items_list`.
- Tree collection maps/sets are derived from query results (`useMemo`) and rebuilt from server data.
- No local fallback mirror (for example `queried* ?? resolved*`) is maintained for tree records.
- Loading/empty states are derived from query presence and visible IDs.

## Collection construction

- Build normalized collection keyed by item index.
- Filter archived rows unless archived mode is enabled.
- Sort children consistently (locale/numeric/case-insensitive).
- Render placeholder rows only in UI when an expanded page has no children.

## Search

- Search input is debounced and consumed through a deferred query value.
- Visible IDs are computed from title matches plus ancestor chain inclusion.
- Ancestors of matched pages remain visible.
- Placeholder nodes are excluded from search matching.
- Search-open snapshots expansion state and auto-expands relevant parents; search-close restores prior expansion.

## Selection and primary action

- Primary click implements single select, toggle-select, and shift-range.
- Non-modifier click runs primary action for page nodes.
- Blur outside tree clears selection/focus styling state.
- In multi-select mode, selection anchor drives active track highlighting.

## Create, rename, archive, unarchive

- Create: `ai_docs_temp.create_page`, then navigate and start rename.
- Create naming: default `New Page` with sibling-aware numeric suffixes.
- Rename: headless-tree `onRename` -> `ai_docs_temp.rename_page`.
- Rename uses Convex `optimisticUpdate` for immediate title feedback.
- Archive/unarchive: `ai_docs_temp.archive_pages` / `ai_docs_temp.unarchive_pages`.
- Multi-select archive sends one mutation call with selected page IDs.
- Pending UI state is split across `isBusy` (global) and `pendingActionPageIds` (per-item).

## Drag and drop

- In-tree DnD: headless-tree `onDrop` -> `ai_docs_temp.move_pages`.
- `canDrop` guards target type, self-drop, and descendant-drop.
- Root-zone handling on outer tree area is visual feedback/state, while final move still flows through tree `onDrop`.

## Header actions

- New page, clear selection, expand root pages, collapse all.
- Archived toggle with live archived count.
- Search and top-level route/title actions.

# Headless-tree configuration highlights

`useTree<pages_TreeItem>` configuration includes:

- `rootItemId: pages_ROOT_ID`
- controlled `expandedItems` + `setExpandedItems`
- `canReorder: false`
- sync data loader + selection + hotkeys + DnD + renaming + expand-all + click behavior + prop memoization features
- page-only `canDrag` and `canRename`
- guarded `canDrop` (target type, self-drop, descendant-drop protection)

# Convex integration details

Query:

- `ai_docs_temp.get_tree_items_list`

Mutations:

- `ai_docs_temp.create_page`
- `ai_docs_temp.rename_page`
- `ai_docs_temp.move_pages`
- `ai_docs_temp.archive_pages`
- `ai_docs_temp.unarchive_pages`

Additional notes:

- Client converts tree IDs to Convex page IDs and passes workspace/project IDs for mutations.
- Backend may ignore protected operations (for example home page path); UI should not assume all requested mutations apply.
- Optimistic behavior should use Convex mutation `optimisticUpdate` hooks, while keeping query data as the source of truth.

# Architectural invariants

1. Keep placeholder behavior client-only and non-mutable.
2. Keep tree record data server-driven from Convex query; do not introduce local mirror/fallback state.
3. Preserve ancestor-aware search visibility and search expansion-restore behavior.
4. Preserve custom selection semantics and selection-anchor behavior.
5. Keep DnD safety guards (self/descendant/type) and root-zone feedback behavior.
6. Keep pending state split (`isBusy` and `pendingActionPageIds`) for correct UI gating.
7. Prefer Convex optimistic updates over manual local tree patching.
8. Do not reintroduce outdated tree/data-provider architecture patterns.

# Change playbooks

## Add per-item action

1. Add action in `PagesSidebarTreeItemActions` / item menu.
2. Gate to page items.
3. Wire per-item pending disable state.
4. Keep Convex query refresh as final source of truth.

## Change filtering/search

1. Update collection/search logic together.
2. Preserve ancestor chain visibility guarantees.
3. Re-check archived mode behavior with search.
4. Re-check search-open/search-close expansion restoration.

## Change drag/drop rules

1. Update `canDrop` first.
2. Keep all safety guards.
3. Validate in-tree behavior and root-zone feedback behavior separately.

## Change create/rename

1. Keep create -> navigate -> rename-start flow.
2. Preserve default sibling-aware `New Page` naming.
3. Preserve trim/empty/unchanged rename no-op guards.
4. Preserve async pending marker lifecycle and optimistic rename behavior.

## Add optimistic behavior

1. Prefer Convex mutation `optimisticUpdate` for optimistic UI.
2. Avoid introducing local mirrored tree state for optimistic paths.
3. Ensure query refresh reconciliation remains correct after optimistic updates.

# Verification checklist

- Tree updates come from `get_tree_items_list` and do not depend on local mirrored data.
- Search (debounced + deferred) keeps ancestor chain for matching leaves.
- Search-open expands relevant branches and search-close restores prior expansion.
- Selection modes (single/toggle/range) and anchor behavior are correct.
- Create navigates and starts rename.
- New page default naming remains unique among active siblings.
- Rename guards and optimistic rename behavior are correct.
- Archive/unarchive and archived filter/toggle behavior is correct.
- DnD allows legal moves, blocks illegal moves, and root-zone feedback works.
- Placeholder nodes are never sent to mutations.
