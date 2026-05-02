# t3-chat App Map

Use this file for stable app browser facts that are worth reusing across Playwriter sessions.

## Local App

- Development app URL: `http://localhost:5173/`.
- Workspace/project pages route shape: `/w/:workspaceName/:projectName/pages`.
- The `/pages` route accepts `pageId` and optional `view` search params.
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

## Stable App Element IDs

- `root`
- `app_hoisting_container`
- `app_main_header_content`
- `app_tiptap_hoisting_container`
- `app_monaco_hoisting_container`
- `app_page_editor_sidebar_tabs_comments`
- `app_page_editor_sidebar_tabs_agent`
