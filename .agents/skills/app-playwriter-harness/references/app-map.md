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
- Organization billing close button accessible name: `Close organization billing dialog`.
- Organization pane selector: `.MainAppHeaderOrganizationSwitcherModalSelectPane[aria-label="Organizations"]`.
- Workspace pane selector: `.MainAppHeaderOrganizationSwitcherModalSelectPane[aria-label="Workspaces"]`.
- Pane lists use `.MainAppHeaderOrganizationSwitcherModalSelectList` and expose scroll metrics through `inspectElement(...)`.
- List item primary actions use `Select organization: <name>` / `Select workspace: <name>`.
- List item overflow menus use `More actions for organization: <name>` / `More actions for workspace: <name>`.

## Plugins Routes

- All plugins routes portal a breadcrumb `ol.PluginsHeaderBreadcrumb` into the main app header slot `#app_main_header_content` (same mechanism as the files page header): catalog shows `Plugins`, detail `Plugins / <name>`, publisher `Plugins / Publisher`, publisher repo `Plugins / Publisher / <displayName>`. Linked segments are `.PluginsHeaderBreadcrumb-segment` anchors; the current one is `.PluginsHeaderBreadcrumb-segment-current`. There are no in-page back buttons or in-page breadcrumbs.
- Workspace plugins page: `/w/:organizationName/:workspaceName/plugins`. Catalog only: marketplace gallery section `.RoutePluginsGallery` with search input `.RoutePluginsGallery-search`, card grid `.RoutePluginsGallery-grid`, cards `.RoutePluginsGalleryCard` are links (anchor aria-label `Open plugin page for <displayName>`; the class sits on the MyLink surface span inside the anchor) showing publisher, description, version, and a green `Installed` indicator. No install buttons or per-plugin management here.
- Plugin detail page: `/w/:organizationName/:workspaceName/plugins/:pluginName` (e.g. `/plugins/media`). Root `.RoutePluginsPlugin`; hero `.RoutePluginsPluginHero` with the Install/Update/Reinstall button; consent dialog `.RoutePluginsPluginConsentModal` (Ariakit modal: stays in the DOM as `hidden` when closed — wait for state `hidden`, not `detached`). When installed, section `.RoutePluginsInstalled` ("Installed in this workspace") shows the version meta line (no mount path is shown), then always-open `.RoutePluginsInstalledSecrets`, followed by two adjacent collapsed `<details>` accordions: `.RoutePluginsInstalledEvents` (handled events list) and `.RoutePluginsInstalledRuns`. Unknown names render `.RoutePluginsPlugin-missing`.
- Publisher home: `/w/:organizationName/:workspaceName/plugins/publisher`. There is no publisher account or create form: publishing is user-owned, and plugins/marketplace/consent show the signed-in user's anagraphic display name.
  - Signed-in: sections `.RoutePluginsPublisherPlugins` (claim form + per-repo card links `.RoutePluginsPublisherPluginCard`) and `.RoutePluginsPublisherSecrets`; header identity chip `.RoutePluginsPublisherIdentity` shows `-name` (anagraphic display name) and `-email`.
  - Anonymous: sign-in gate `.RoutePluginsPublisherSignIn` with a `Log in` button that opens the Clerk sign-in modal; the claim form and management sections must not render.
- Publisher plugin detail: `/w/:organizationName/:workspaceName/plugins/publisher/:repositoryId` (navigate by clicking a `.RoutePluginsPublisherPluginCard`). Root `.RoutePluginsPublisherRepository`; hero `.RoutePluginsPublisherRepositoryHero` (Publish + remove-claim actions); sections `.RoutePluginsPublisherRepositoryVersions` and `.RoutePluginsPublisherRepositoryReviews`.

## Stable App Element IDs

- `root`
- `app_hoisting_container`
- `app_main_header_content`
- `app_tiptap_hoisting_container`
- `app_monaco_hoisting_container`
- `app_file_editor_sidebar_tabs_comments`
- `app_file_editor_sidebar_tabs_agent`
