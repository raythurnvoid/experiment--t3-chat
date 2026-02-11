---
name: pages-explorer-tree
description: Practical guide for the current Pages sidebar (`@headless-tree` + Convex) implementation. This skill documents the **current** Pages sidebar implementation used by the app route: UI + behavior entry point: `../../../packages/app/src/routes/pages/-components/pages-sidebar.tsx`; Tree engine: `@headless-tree/core` + `@headless-tree/react`; Data source: Convex `ai_docs_temp` query/mutations. Use this guide when implementing or modifying sidebar behavior (search, selection, drag/drop, rename, archive/unarchive, create, and root-drop-zone interactions).
---

# Source of truth files

Primary:

- `../../../packages/app/src/routes/pages/-components/pages-sidebar.tsx`
- `../../../packages/app/src/routes/pages/-components/pages-sidebar.css`
- `../../../packages/app/convex/ai_docs_temp.ts`
- `../../../packages/app/shared/pages.ts`
- `../../../packages/app/src/lib/pages.ts`

Related contracts used by the sidebar:

- Convex API typing import via `app_convex_api` in `pages-sidebar.tsx`
- `pages_TreeItem` from `ai_docs_temp.ts` (re-exported from `src/lib/pages.ts`)
- `pages_ROOT_ID` and `pages_create_tree_placeholder_child` from shared pages helpers

# Data model and contracts

Sidebar tree item shape:

- `pages_TreeItem` lives in `../../../packages/app/convex/ai_docs_temp.ts`
- Item `type` is one of: `"root" | "page" | "placeholder"`
- Sidebar behavior treats only `"page"` items as mutable tree nodes (drag, rename, archive, create child)

Root/placeholder contracts:

- `pages_ROOT_ID` is defined in `../../../packages/app/shared/pages.ts`
- `pages_create_tree_placeholder_child(parentId)` is defined in `../../../packages/app/shared/pages.ts` and re-exported by `../../../packages/app/src/lib/pages.ts`
- Placeholders are **client-generated only** to show empty page containers

Important backend/client split:

- Convex `get_tree_items_list` returns root + page items
- Convex does **not** return placeholder items
- Client builds `treeCollection` and injects placeholder children where needed

# Component architecture

All current sidebar UI lives in `pages-sidebar.tsx`. Main exported component:

- `PagesSidebar` (root component)

Extracted tree-related components:

- `PagesSidebarTreeArea`
- `PagesSidebarTreeItem`
- `PagesSidebarTreeItemArrow`
- `PagesSidebarTreeRenameInput`
- `PagesSidebarTreeItemIcon`
- `PagesSidebarTreeItemPrimaryActionContent`
- `PagesSidebarTreeItemActionIconButton`

Helper layer (same file):

- Collection and sorting helpers (`pages_sidebar_build_collection`, `pages_sidebar_sort_children`)
- Convex ID conversion helpers (`pages_sidebar_to_page_id`, `pages_sidebar_to_parent_id`)
- Flicker reduction comparator (`pages_sidebar_are_tree_items_lists_equal`)

# State and behavior flows

## Query + fallback flow (flicker reduction)

- Sidebar queries `ai_docs_temp.get_tree_items_list`
- It stores a local `resolvedTreeItemsList`
- Effective list is `queriedTreeItemsList ?? resolvedTreeItemsList`
- An effect updates `resolvedTreeItemsList` only when item snapshots actually differ (shallow field-based comparison)

Why this exists:

- During transient undefined query windows, sidebar keeps previous tree data and avoids UI flicker/reset.

## Collection construction flow

- `pages_sidebar_build_collection` builds a normalized map keyed by `index`
- Filters out archived pages unless `showArchived` is enabled
- Re-parents detached/orphaned pages back under root
- Sorts children (locale, numeric, case-insensitive), with placeholders last
- Injects placeholder child for page nodes that have no children

## Search flow

- `searchQuery` is local state
- Search computes `visibleIds` with recursive descendant matching
- Placeholder items are excluded from search matching
- Render pass filters tree items against `visibleIds`
- Empty-state text changes based on whether search is active

## Selection and primary action flow

- Primary click manually handles single-select, toggle-select, and shift range select
- Non-modifier primary click triggers `onPrimaryAction` for page nodes (navigation/open)
- F2 on focused page starts rename mode
- Blur outside tree container clears selection and focus styling state

## Create / rename / archive / unarchive flow

- Create calls `ai_docs_temp.create_page`, then navigates to new page and starts rename
- Rename comes from headless-tree `onRename`, calling `ai_docs_temp.rename_page`
- Archive/unarchive call `ai_docs_temp.archive_pages` / `ai_docs_temp.unarchive_pages`
- Multi-select archive uses `Promise.all` over selected page IDs
- Per-page pending state is tracked by `pendingActionPageIds` plus coarse `isBusy` flags

## Drag and drop flow

- In-tree drops use headless-tree `onDrop` -> `movePagesToParent` -> `ai_docs_temp.move_pages`
- Root drop zone is handled manually on the outer tree area element
- Root drop path reads current dragged items from `tree.getState().dnd?.draggedItems`
- Drop to root calls same `movePagesToParent` with `targetParentId: pages_ROOT_ID`

# Headless-tree configuration details

`useTree<pages_TreeItem>` is configured in `PagesSidebar` with:

- `rootItemId: pages_ROOT_ID`
- `initialState.expandedItems: [pages_ROOT_ID]`
- `canReorder: true`
- `dataLoader` backed by `treeCollection`
- Features:
  - `syncDataLoaderFeature`
  - `selectionFeature`
  - `hotkeysCoreFeature`
  - `dragAndDropFeature`
  - `renamingFeature`
  - `expandAllFeature`

Behavior callbacks:

- `getItemName`: `item.getItemData().title`
- `isItemFolder`: all non-placeholder items
- `canDrag`: page items only
- `canDrop`:
  - target must be root or page
  - cannot drop onto self
  - cannot drop onto descendant of dragged item
- `onDrop`: server move mutation call
- `canRename`: page items only
- `onRename`: trim/no-op checks, then server rename mutation
- `onPrimaryAction`: page items only

Rendering model:

- Tree DOM is rendered by mapping `tree.getItems()` into `PagesSidebarTreeItem`
- Root item is not rendered as a row (container only)
- `tree.getDragLineStyle()` drives the visual between-row DnD indicator
- `tree.scheduleRebuildTree()` is called each render cycle to sync the latest loader data

# Convex integration details

Query used by sidebar:

- `ai_docs_temp.get_tree_items_list`

Mutations used by sidebar:

- `ai_docs_temp.create_page`
- `ai_docs_temp.rename_page`
- `ai_docs_temp.move_pages`
- `ai_docs_temp.archive_pages`
- `ai_docs_temp.unarchive_pages`

ID conversion in client:

- Local helper converts string tree IDs to `Id<"pages">`
- Parent conversion accepts either page ID or `pages_ROOT_ID`
- Always pass workspace/project IDs with each mutation

Backend behavior to keep in mind (from `ai_docs_temp.ts`):

- Some operations skip the home page (`path === "/"`) server-side
- UI should not assume every requested move/rename/archive is applied if server ignores protected page operations

# Critical invariants and gotchas

1. **Do not treat placeholders as real pages**

   - Never send placeholder IDs to mutations
   - Drag/rename/archive/create-child actions should remain page-only

2. **Placeholders are client-only**

   - Backend list query intentionally has no placeholder rows
   - Placeholder logic belongs in collection-building only

3. **Keep `resolvedTreeItemsList` fallback behavior**

   - Removing it reintroduces loading flicker and transient empty trees

4. **Root drop zone depends on exact event target**

   - Root-drop handler checks `event.target === rootElement.current`
   - Changes to structure/event bubbling can break root-drop behavior silently

5. **Search visibility is ancestor-aware**

   - Visible set includes ancestors of matching descendants
   - Avoid flat filtering that hides parent context for matches

6. **Pending-state UX is split**

   - `isBusy` gates bulk/global actions
   - `pendingActionPageIds` gates item-level controls
   - Keep both if you add async actions

7. **Selection model is custom**

   - Primary click logic includes range anchor handling via `tree.getDataRef()`
   - Modifier-click semantics should be preserved when extending click behavior

8. **Do not reintroduce outdated tree architecture**
   - Current implementation is `@headless-tree`, not React Complex Tree/data-provider patterns

# Safe change playbooks

## Add a new per-item action button

1. Add button in `PagesSidebarTreeItem` action row using `PagesSidebarTreeItemActionIconButton`
2. Gate it for page items only
3. Add pending-state integration:
   - mark/unmark page in `pendingActionPageIds` for async action
   - disable button when `isPending`
4. If action changes tree structure, rely on Convex + query refresh (do not mutate collection ad hoc)

## Change archive/filtering behavior

1. Update filtering logic in `pages_sidebar_build_collection`
2. Keep detached-page reattachment and sorting steps intact
3. Verify `archivedCount`, `showArchived`, and `shouldForceShowArchived` behavior together
4. Ensure search still operates on the post-filter collection

## Adjust drag-and-drop rules

1. Update `canDrop` guard first (self/descendant/type checks)
2. Keep `canDrag` page-only unless backend supports more types
3. If changing drop targets, align both:
   - tree `onDrop` path
   - manual root-drop-zone path
4. Re-test root drop separately from in-tree drop

## Change create-page flow

1. Update `createPage` mutation args and post-create navigation together
2. Preserve pending rename startup (`pendingRenamePageId` + effect)
3. Keep busy-state handling around async create

## Change rename behavior

1. Update `onRename` checks (trim, empty, unchanged) deliberately
2. Keep page-only guard
3. Preserve pending marker lifecycle for per-item disabled state

# Verification checklist after edits

Run through this after any sidebar change:

- Query load:
  - Initial load shows pages
  - No flash-to-empty while query is temporarily undefined
- Search:
  - Matching leaf shows ancestor chain
  - No placeholder-only false matches
  - Empty-state messages are correct
- Selection:
  - Single click selects + opens
  - Ctrl/Cmd toggles selection
  - Shift range selection works
  - Blur outside tree clears selection
- Rename:
  - F2 starts rename on focused page
  - Empty/unchanged rename does nothing
  - Successful rename persists via Convex
- Create:
  - New page appears under expected parent
  - Sidebar navigates to new page
  - Rename starts automatically for created page
- Archive/unarchive:
  - Per-item archive toggles correctly
  - Multi-select archive works
  - Show/hide archived toggle behaves correctly
- Drag/drop:
  - In-tree move works
  - Illegal drops are blocked (self/descendant/non-page)
  - Root drop zone accepts dragged page items
- Visual + pending states:
  - Pending item actions disable correctly
  - Drag-over/focused/selected classes still apply as expected
