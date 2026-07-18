# t3-chat App Map

Use this file for stable app browser facts that are worth reusing across Playwriter sessions.

## Local App

- Development app URL: `http://localhost:5173/`.
- Files route shape: `/w/:organizationName/:workspaceName/files`.
- The `/files` route accepts `nodeId` and optional `view` search params.
- Known page editor views: `rich_text_editor`, `plain_text_editor`, `diff_editor`.

## Main Left Navigation

- Main app sidebar owner: `MainAppSidebar`.
- Main navigation landmark: `[aria-label="Main navigation"]`.
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
- List item primary actions use `Select organization: <name>` / `Select workspace: <name>`.
- List item overflow menus use `More actions for organization: <name>` / `More actions for workspace: <name>`.

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
