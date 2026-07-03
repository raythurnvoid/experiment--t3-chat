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

## Plugins Publisher Route

- Route shape: `/w/:organizationName/:workspaceName/plugins/publisher`.
- Signed-in with a publisher: sections `.RoutePluginsPublisherRepositories`, `.RoutePluginsPublisherReviews`, `.RoutePluginsPublisherSecrets`; header identity `.RoutePluginsPublisherHeader-identity`.
- Signed-in without a publisher: create form `.RoutePluginsPublisherCreate`.
- Anonymous: sign-in gate `.RoutePluginsPublisherSignIn` with a `Log in` button that opens the Clerk sign-in modal; the create form and management sections must not render.

## Stable App Element IDs

- `root`
- `app_hoisting_container`
- `app_main_header_content`
- `app_tiptap_hoisting_container`
- `app_monaco_hoisting_container`
- `app_file_editor_sidebar_tabs_comments`
- `app_file_editor_sidebar_tabs_agent`
