# t3-chat App Map

Use this file for stable app browser facts that are worth reusing across Playwriter sessions.

## Local App

- Development app URL: `http://localhost:5173/`.
- Files route shape: `/w/:organizationName/:workspaceName/files`.
- The `/files` route accepts `nodeId` and optional `view` search params.
- Known page editor views: `rich_text_editor`, `plain_text_editor`, `diff_editor`.

## Main Left Navigation

- Main app sidebar owner: `MainAppSidebar`.
- Main navigation landmark: `[aria-label="Main navigation"]`. It is the `ul.MySidebarList.MainAppSidebar-nav-list` **inside** the sidebar, not the sidebar element itself.
- The two `complementary` landmarks are named (fixed 2026-07-26): `<aside class="MySidebar … MainAppSidebar">` is `aria-label="Main"` (`main-app-sidebar.tsx`) and `<aside class="FilesSidebar">` is `aria-label="Files"` (`files-sidebar.tsx`). Chrome's AX tree reports `complementary "Main"` and `complementary "Files"`, and axe `landmark-unique` / `landmark-complementary-is-top-level` PASS on `/files`.
- Main sidebar classes include `.MainAppSidebar` and shared `.MySidebar` state classes.
- Sidebar localStorage keys:
  - `app_state::sidebar::main_app_open`
  - `app_state::sidebar::main_app_collapsed`
- Closed sidebar state uses `.MySidebar-state-closed`.
- Collapsed main sidebar state uses `.MainAppSidebar-state-collapsed`.

## Organization / Workspace Switcher

- Header switcher button accessible name starts with `Open organization and workspace switcher`.
- Switcher dialog heading: `Organizations and workspaces`.
- Switcher close button accessible name: `Close organization switcher`.
- Organization billing close button accessible name: `Close`.
- Organization pane selector: `.MainAppHeaderOrganizationSwitcherModalSelectPane[aria-label="Organizations"]`.
- Workspace pane selector: `.MainAppHeaderOrganizationSwitcherModalSelectPane[aria-label="Workspaces"]`.
- Pane lists use `.MainAppHeaderOrganizationSwitcherModalSelectList` and expose scroll metrics through `inspectElement(...)`.
- List item primary actions use `Select organization: <name>` / `Select workspace: <name>`. The already-current row is instead named `Current organization: <name>` / `Current workspace: <name>` and carries `aria-disabled="true"`, so a locator built on `Select …` silently misses it.
- List item overflow menus use `More actions for organization: <name>` / `More actions for workspace: <name>`.
- A row renders no overflow menu at all when it has no action to offer (no ⋮ button in the DOM, not hidden by CSS, not gated on hover or selection). The **default** organization and the **default** workspace never offer one. Every other row gates each item on a permission, so the menu can be missing there too: organization `Manage billing` needs `organization.billing.manage`, `Edit` needs `organization.update`, `Delete` needs you to own the organization; workspace `Edit` needs `workspace.update` (and is hidden on the organization's primary workspace), `Delete` needs `workspace.delete`. A plain member holds `workspace.update` but not `organization.update` or `workspace.delete`, so it sees a menu with only `Edit` on secondary workspace rows, and none on the organization row.
- Row badges: ownership `span.MainAppHeaderOrganizationSwitcherModalListItem-ownership-badge` (`Personal` on the default org, `Owner` on an org you own, `Joined` on one you were invited to), billing `span.MainAppHeaderOrganizationSwitcherModalListItem-billing-badge` (for example `Members pay`). Workspace rows carry no ownership badge.
- Pane headers show a quota counter `.MainAppHeaderOrganizationSwitcherModalSelectHead-quota` shaped `used/limit` (`1/3` organizations, `1/6` workspaces). It is a quota, not a "loaded of total" count — do not read it as a sign that rows are missing.
- Strict-mode trap: the close button is labelled `Close organization switcher`, whose name contains both `Switch` and `switcher`. `getByRole("button", { name: "Switch" })` and `{ name: "Create organization" }` (vs `Close create organization dialog`) both resolve to two elements. Always pass `exact: true` inside this modal.
- Several Ariakit dialogs stay mounted while closed, so `locator('[role="dialog"]').last()` picks a hidden one and snapshots empty. Target `.MainAppHeaderOrganizationSwitcherModal`, or filter on `!el.hidden && getComputedStyle(el).display !== "none"`.
- Deleting an organization from the row menu applies immediately with no confirmation step, and leaves `document.activeElement` on `<body>`. Escape then does not close the switcher (Ariakit needs focus inside the dialog) — click `Cancel` (`exact: true`) instead.

## Users Route

- Route: `/w/:organizationName/:workspaceName/users`.
- Page header `.RouteUsersHeader` (heading `Users`, subtitle `<org> organization membership`) with actions in `.RouteUsersHeader-toolbar`; invite dialog root `.RouteUsersInviteModal`.
- Member list is a real `ul[aria-label="Organization members"]` with rows `li.RouteUsersUserListItem[data-user-id="<users id>"]`.
- Role badge: `span.MyBadge[data-role-kind="<kind>"]` inside `.RouteUsersUserListItem-title`. Its text is `Role: <label>`, built from a `span.sr-only` prefix plus the visible label — there is no `aria-label`, because ARIA forbids naming a plain span. The owner renders `Role: Owner` / `data-role-kind="owner"`. The row does not render until both the anagraphic and the role have loaded, so there is no `No role` flicker to poll past.
- Row action button lives in `.RouteUsersUserListItem-actions`, named `Leave organization` on your own row and `Remove <display name>` on everyone else's. When not allowed it uses `aria-disabled="true"` (never the `disabled` attribute), stays keyboard focusable, and points `aria-describedby` at an `sr-only` element holding the reason. The `MyTooltipTrigger` tooltip shows the same text on focus or hover, but Ariakit only wires `aria-labelledby` and only for label-type tooltips, so the tooltip alone would never reach a screen reader.
- The header `Invite` button uses `aria-disabled="true"` the same way, so it stays in the tab order and refuses pointer clicks, `Enter`, and `Space`. It is disabled on the default `personal` organization and for anyone without `organization.members.manage`; both cases render a tooltip and an `sr-only` `#RouteUsersInviteModal-reason` that `aria-describedby` points at. While the permission query is still loading the button is disabled with no reason, deliberately — that state is transient.
- Verified on the default `personal` organization: Chrome's AX tree reports the Invite button as `button` / name `Invite` / `focusable: true` / `disabled: true` with a non-null `description`, and the description is identical whether the tooltip is closed or open — Ariakit's tooltip does **not** rewrite `aria-describedby` here, because `MyTooltipContent` is a description-type tooltip and the route owns the `sr-only` element itself. Locate the button as `.RouteUsersHeader-toolbar button.MyTooltipTrigger`: `button.MyTooltipTrigger` alone matches ~11 elements page-wide and `.first()` lands on a main-sidebar icon button.

## Files Route Landmarks And Tabs

- `/files` renders exactly one `<main class="FileNodeView-editor-area">`, inside `.FileNodeView-main-panel`. It contains the editor toolbar, `.FileNodeView-content-panel`, and the right sidebar tabs; `<aside class="FilesSidebar">` is deliberately a sibling outside it. axe `landmark-one-main` and `landmark-no-duplicate-main` both PASS on `/files` and `/users`.
- `landmark-no-duplicate-banner` and `landmark-banner-is-top-level` PASS on both routes. Ariakit's dialog is a `role="dialog"` div, not sectioning content, so **any `<header>`/`<footer>` inside a modal claims the whole page's `banner`/`contentinfo`**. `MyModalHeader` and `MyModalFooter` both render plain `div`s since 2026-07-26 (their prop types always said `div`); the CSS was always class-based, so nothing moved. Verified in Chrome's AX tree: both read `generic` + ignored.
  - The pattern bit two more panels, both fixed the same day: `MainAppAccountManagementProfile-header` (`main-app-account-management.tsx`) and `BillingAccountManagementPanelHeader` (`billing/billing-account-management-panel.tsx`) rendered `<header>` inside plain `div`s and were live `banner` landmarks inside the account modal, one per selected tab. Both are `div`s now. The two `MainAppAccountManagementSecurity-panel-header` headers are inside `<section>` and were always correctly scoped. When auditing a modal, list `dlg.querySelectorAll("header, footer, [role=banner], [role=contentinfo]")` and check each one's nearest `article/aside/main/nav/section` ancestor — a `null` ancestor means it is a page-level landmark.
- The only `region` offender on a tooltip-free `/files` is `.FileNodeView > .MyPanelResizeHandle` — the presentational wrapper around the sidebar splitter, which sits between `<aside class="FilesSidebar">` and `<main>` and so belongs to no landmark. The `role="separator"` control with `aria-label="Resize files sidebar"` and `tabindex="0"` is the **inner** `.MyPanelResizeHandle-control` div, not the wrapper — do not look for the role or the label on `.MyPanelResizeHandle` itself. The second handle inside `.FileNodeView-content-group` is already inside `<main>` and is not flagged.
- The two remaining `aria-required-children` nodes on `/files` (measured 2026-07-26, both critical) are **not** the folder-explorer rows: `.FilesSidebarTree` (`role="tree"`, disallowed children `span[aria-live]`, `div[tabindex]`, `button[aria-label]`, `button[aria-haspopup]` — see the sidebar-row bullet below) and `.FileEditorSidebarAgentHeaderTabs` (`role="tablist"`, disallowed child `button[aria-label]`, the per-tab `Close tab` button). Both are structural: the tree's `sr-only` live-region span and the chevron/add-file/more-actions buttons are siblings of the `role="treeitem"` button rather than inside it, and each chat tab pairs a `role="tab"` with a plain close button. Re-run with `runOnly: { type: "rule", values: [...] }` to attribute them in one call instead of reading a full-document report.
- Header breadcrumb `ol.FileNodeViewHeader-breadcrumb` owns **only** `li` (axe `list` PASSES). Separators are `<li aria-hidden="true">/</li>` with no class and no CSS rule of their own — the `ol`'s `display: flex; gap: 4px; flex-wrap: nowrap` does all the spacing, so adding or removing a separator class changes nothing visually. They contribute **zero** AX nodes, so the slashes are never announced; the list exposes one `listitem` per real segment plus the Copy path / Copy link buttons. Only a nested folder (2+ path segments) renders an in-path separator, so test breadcrumbs there, not at `nodeId=root`.
- Right sidebar tabs live in `[role="tablist"][aria-label="Sidebar tabs"]`; the agent chat tab strip is `[role="tablist"][aria-label="Open chats"]` (`.FileEditorSidebarAgentHeaderTabs`). Each chat tab is a `MyTabsTabSurface` div holding a `role="tab"` button plus a separate `Close tab` button, so the tablist owns non-`tab` children.
- Files sidebar rows: `div.FilesSidebarTreeItem` is a **role-less** wrapper; `role="treeitem"` sits on the inner `button.FilesSidebarTreeItemPrimaryAction`, and that button `aria-owns` the chevron wrapper `#files_sidebar_tree_item_arrow_<fileId>`. The rename `input.FilesSidebarTreeItemTitle-input` and its `MyInput` wrapper both carry `tabindex="-1"` and are **not** owned by the treeitem, and `.FilesSidebarTree` also has a bare `<span aria-live="assertive">` as its first child.
- Folder explorer rows: `div.MyGridTableRow.FileNodeViewFolderExplorer-row[role="row"]` owns exactly four `div[role="cell"]` and nothing else (fixed 2026-07-26 — axe `aria-required-children` no longer reports these rows). The full-row overlay `<a class="FileNodeViewFolderExplorer-row-action" aria-label="Open <name>">` is the first child of the **name cell**, stretched over the row with `position: absolute; inset: 0` against the row's `position: relative`.
  - Hit testing: the name/updated-by/updated cells are `pointer-events: none` and the link is `pointer-events: auto`, so `document.elementFromPoint` returns the link everywhere on the row **except inside `.FileNodeViewFolderExplorer-cell-actions`**, which re-enables pointer events for its whole box. The dead zone is the entire actions cell, not just the ⋮ button: its `padding: 4px 6px` band hit-tests to the cell `div`, so a near-miss on the menu button does nothing instead of navigating. Verified on every row — probe the four padding edges and both corners, not only the button centre. Clicking any other cell area navigates; the ⋮ button opens its Archive menu without changing the URL.
  - Focus: `Tab` order is link → ⋮ → next row's link. `:focus-visible` on the link draws `2px solid var(--color-fg-12)` at `outline-offset: -2px`. Nothing lifts a cell to make that outline visible — the row's hover/focus tint and its bottom divider both live on `.FileNodeViewFolderExplorer-row` itself, so the cells paint nothing opaque over it. The cells' own `z-index: 1` is load-bearing for a different reason: it is what keeps `.cell-actions` above the link's `z-index: 0`, so the ⋮ button stays clickable. Drop it and the positioned link outranks every static cell and swallows the click. **Do not "fix" a clipped outline by raising `.FileNodeViewFolderExplorer-cell-name`**: the link is `inset: 0` against the row, so lifting its cell lifts the link over `.cell-actions` too, and a mouse click on the ⋮ of a row whose link has keyboard focus then navigates instead of opening the menu. That regression shipped once (2026-07-26) and was caught by review, not by a hit-test sweep — testing hit-testing and focus separately misses it.

## Plugins Routes

- All plugins routes portal a breadcrumb `ol.PluginsHeaderBreadcrumb` into the main app header slot `#app_main_header_content` (same mechanism as the files page header): catalog shows `Plugins`, detail `Plugins / <name>`, publisher `Plugins / Publisher`, publisher repo `Plugins / Publisher / <displayName>`. Linked segments are `.PluginsHeaderBreadcrumb-segment` anchors; the current one is `.PluginsHeaderBreadcrumb-segment-current`. There are no in-page back buttons or in-page breadcrumbs.
- Workspace plugins page: `/w/:organizationName/:workspaceName/plugins`. Catalog only: marketplace gallery section `.RoutePluginsGallery` with search input `.RoutePluginsGallery-search`, card grid `.RoutePluginsGallery-grid`, and link cards `.PluginsGalleryCard` showing publisher, description, version, and installed state. No install buttons or per-plugin management appear here.
- Plugin detail page: `/w/:organizationName/:workspaceName/plugins/:pluginName` (for example `/plugins/media`). Root `.RoutePluginsPlugin`; hero `.RoutePluginsPluginHero` with an Install, Update, or Uninstall action; consent dialog `.RoutePluginsPluginConsentModal` (Ariakit modal: stays in the DOM as `hidden` when closed — wait for state `hidden`, not `detached`). The page owns `.RoutePluginsPluginSecrets`, `.RoutePluginsPluginAccess`, optional `.RoutePluginsPluginPublisherReleases`, and `.RoutePluginsInstalledRuns`. Unknown names render `.RoutePluginsPlugin-missing`.
- Publisher home: `/w/:organizationName/:workspaceName/plugins/publisher`. There is no publisher account or create form: publishing is user-owned, and plugins/marketplace/consent show the signed-in user's anagraphic display name.
  - Signed-in: `.RoutePluginsPublisherPlugins` contains the claim form and claimed-repository cards. Published entries link to `/plugins/:pluginName`; unpublished claims stay as non-link cards until their first publish. The header identity chip `.RoutePluginsPublisherIdentity` shows `-name` (anagraphic display name) and `-email`.
  - Anonymous: sign-in gate `.RoutePluginsPublisherSignIn` with a `Log in` button that opens the Clerk sign-in modal; the claim form and management sections must not render.
- Plugin page host route: `/w/:organizationName/:workspaceName/plugins/:pluginName/pages/:pageId`. Root `.RoutePluginsPluginPage`; the plugin SPA runs in the sandboxed iframe `.RoutePluginsPluginPage-frame` (opaque origin — find its Playwright frame handle and evaluate there; `contentDocument` is null from the app document). Loading state has `role="status"`; startup failure replaces the iframe with a `role="alert"` `.RoutePluginsPluginPage-error` containing a focused Retry button. Canonical iframe assets use `/plugins-ui/<versionId>/<path>`; Retry creates a fresh frame generation. Sidebar items come from passed-review `list_ui_pages` results; see `references/plugin-gallery.md` for driving Gallery.

## Stable App Element IDs

- `root`
- `app_hoisting_container`
- `app_main_header_content`
- `app_tiptap_hoisting_container`
- `app_monaco_hoisting_container`
- `app_file_editor_sidebar_tabs_comments`
- `app_file_editor_sidebar_tabs_agent`
- `app_file_editor_sidebar_tabs_pending`
- `app_file_node_view_toolbar_editor_actions`
