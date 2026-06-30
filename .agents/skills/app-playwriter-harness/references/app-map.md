# t3-chat App Map

Use this file for stable app browser facts that are worth reusing across Playwriter sessions.

## Local App

- Development app URL: `http://localhost:5173/`.
- Files route shape: `/w/:workspaceName/:projectName/files`.
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

## Workspace / Project Switcher

- Header switcher button accessible name starts with `Open workspace and project switcher`.
- Switcher dialog heading: `Workspaces and projects`.
- Switcher close button accessible name: `Close workspace switcher`.
- Workspace billing close button accessible name: `Close workspace billing dialog`.
- Workspace pane selector: `.MainAppHeaderWorkspaceSwitcherModalSelectPane[aria-label="Workspaces"]`.
- Project pane selector: `.MainAppHeaderWorkspaceSwitcherModalSelectPane[aria-label="Projects"]`.
- Pane lists use `.MainAppHeaderWorkspaceSwitcherModalSelectList` and expose scroll metrics through `inspectElement(...)`.
- Row primary actions use `Select workspace: <name>` / `Select project: <name>`.
- Row overflow menus use `More actions for workspace: <name>` / `More actions for project: <name>`.

## Stable App Element IDs

- `root`
- `app_hoisting_container`
- `app_main_header_content`
- `app_tiptap_hoisting_container`
- `app_monaco_hoisting_container`
- `app_file_editor_sidebar_tabs_comments`
- `app_file_editor_sidebar_tabs_agent`
