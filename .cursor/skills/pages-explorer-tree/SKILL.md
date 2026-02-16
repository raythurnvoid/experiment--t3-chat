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
- `../../../packages/app/vendor/headless-tree/packages/core/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/index.ts`
- `../../../packages/app/vendor/headless-tree/packages/react/src/react-compiler/index.tsx`

# Architecture overview

The Pages sidebar is implemented in `pages-sidebar.tsx` on top of `@headless-tree` with Convex-backed data.

- Tree engine: `@headless-tree/core` + `@headless-tree/react`
- Vendored sources: `../../../packages/app/vendor/headless-tree/packages/*`
- Backend data: Convex `ai_docs_temp` query/mutations
- Item types: `"root" | "page" | "placeholder"`
- Only `"page"` items are mutable tree entities

# Data model and contracts

- `pages_TreeItem` shape is defined in `../../../packages/app/convex/ai_docs_temp.ts`.
- `pages_ROOT_ID` and `pages_create_tree_placeholder_child` are in `../../../packages/app/shared/pages.ts` (re-exported by `../../../packages/app/src/lib/pages.ts`).
- Backend returns root/page items only; placeholder rows are client-generated.
- Placeholder nodes are structural UI helpers and must never be mutation targets.

# Component and helper structure

Main component:

- `PagesSidebar`

Tree components (same file):

- `PagesSidebarTreeArea`
- `PagesSidebarTreeItem`
- `PagesSidebarTreeItemArrow`
- `PagesSidebarTreeRenameInput`
- `PagesSidebarTreeItemIcon`
- `PagesSidebarTreeItemPrimaryActionContent`
- `PagesSidebarTreeItemActionIconButton`

Core helpers:

- `pages_sidebar_build_collection`
- `pages_sidebar_sort_children`
- `pages_sidebar_to_page_id`
- `pages_sidebar_to_parent_id`
- `pages_sidebar_are_tree_items_lists_equal`

# State and behavior flows

## Query fallback and flicker control

- Sidebar queries `ai_docs_temp.get_tree_items_list`.
- Effective source is `queriedTreeItemsList ?? resolvedTreeItemsList`.
- `resolvedTreeItemsList` updates only when snapshots differ.
- This prevents transient undefined-query windows from flashing the tree empty.

## Collection construction

- Build normalized collection keyed by item index.
- Filter archived rows unless archived mode is enabled.
- Re-parent detached/orphan pages under root.
- Sort children consistently (locale/numeric/case-insensitive), placeholders last.
- Inject placeholder child for page nodes with no children.

## Search

- Search computes a visible ID set with descendant-aware matching.
- Ancestors of matched descendants remain visible.
- Placeholder nodes are excluded from search matching.

## Selection and primary action

- Primary click implements single select, toggle-select, and shift-range.
- Non-modifier click runs primary action for page nodes.
- `F2` starts rename on focused page.
- Blur outside tree clears selection/focus styling state.

## Create, rename, archive, unarchive

- Create: `ai_docs_temp.create_page`, then navigate and start rename.
- Rename: headless-tree `onRename` -> `ai_docs_temp.rename_page`.
- Archive/unarchive: `ai_docs_temp.archive_pages` / `ai_docs_temp.unarchive_pages`.
- Multi-select archive uses batched async operations over selected page IDs.
- Pending UI state is split across `isBusy` (global) and `pendingActionPageIds` (per-item).

## Drag and drop

- In-tree DnD: headless-tree `onDrop` -> `movePagesToParent` -> `ai_docs_temp.move_pages`.
- Root drop-zone path is handled on the outer tree area.
- Root drop reads `tree.getState().dnd?.draggedItems` and moves to `pages_ROOT_ID`.
- In-tree and root-drop paths must stay behaviorally aligned.

# Headless-tree configuration highlights

`useTree<pages_TreeItem>` configuration includes:

- `rootItemId: pages_ROOT_ID`
- initial expanded root
- sync data loader + selection + hotkeys + DnD + renaming + expand-all features
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

# Architectural invariants

1. Keep placeholder behavior client-only and non-mutable.
2. Keep fallback list behavior to avoid tree flicker/reset.
3. Preserve ancestor-aware search visibility.
4. Preserve custom selection semantics and keyboard rename behavior.
5. Keep DnD safety guards (self/descendant/type) and root-drop support.
6. Keep pending state split (`isBusy` and `pendingActionPageIds`) for correct UI gating.
7. Do not reintroduce outdated tree/data-provider architecture patterns.

# Change playbooks

## Add per-item action

1. Add button in `PagesSidebarTreeItem` actions.
2. Gate to page items.
3. Wire per-item pending disable state.
4. Rely on Convex refresh for final source of truth.

## Change filtering/search

1. Update collection/search logic together.
2. Preserve orphan re-parenting and sort guarantees.
3. Re-check archived mode behavior with search.

## Change drag/drop rules

1. Update `canDrop` first.
2. Keep all safety guards.
3. Validate in-tree and root-drop-zone paths separately.

## Change create/rename

1. Keep create -> navigate -> rename-start flow.
2. Preserve trim/empty/unchanged rename no-op guards.
3. Preserve async pending marker lifecycle.

# Verification checklist

- Query fallback prevents flash-to-empty.
- Search keeps ancestor chain for matching leaves.
- Selection modes (single/toggle/range) behave correctly.
- `F2` rename and rename guards behave correctly.
- Create navigates and starts rename.
- Archive/unarchive and archived filter/toggle behavior is correct.
- DnD allows legal moves, blocks illegal moves, and root drop still works.
- Placeholder nodes are never sent to mutations.
