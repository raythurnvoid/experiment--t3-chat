# Files Route Playwriter Notes

Use this file as a quick testing map for `/files`. Keep it short and selector-oriented. If a check needs a large script, write a temporary script during the task instead of pasting it here.

## Route Basics

- Route shape: `/w/:workspaceName/:projectName/files?nodeId=<id>`.
- `nodeId=root` opens the root folder browser.
- Folder node ids open the folder browser; file node ids open the editor.
- Optional `view` values: `rich_text_editor`, `plain_text_editor`, `diff_editor`.

## First Checks

- Bind with `state.appPlaywriterHarness.bindOpenTab({ urlIncludes: "/files" })`.
- Confirm route/UI with `state.appPlaywriterHarness.observe({ search: /Files|Comments|Agent|Review|Toolbar/i })`.
- If the app is blank, read logs before retrying: `getLatestLogs({ page: state.page, search: /error|failed|not defined|syntax/i, count: 30 })`.
- Do not force-click editor/sidebar controls. If a click is blocked, inspect the target or hit-test the point.

## Stable Selectors

### Layout And Scroll

- Files route scroll owner: `.FileNodeView-editor-area`.
- Content panel: `.FileNodeView-content-panel`.
- Sidebar panel: `.FileNodeView-editor-sidebar-panel`.
- Comments tab: `#app_file_editor_sidebar_tabs_comments`.
- Agent tab: `#app_file_editor_sidebar_tabs_agent`.

### File Node View

- Detailed editor-surface notes: [file-node-view.md](file-node-view.md).
- Rich text editable content: `.FileEditorRichText-editor-content`.
- Comments region: `getByRole("complementary", { name: "Document comments" })`.
- Diff editor root: `[aria-label="File diff editor"]`.
- Review changes button: `[data-testid="review-changes-button"]`.

### Sidebar And Folder Browser

- Sidebar tree rows: `.FilesSidebarTreeItem[data-file-id]`.
- Sidebar selected rows: `.FilesSidebarTreeItem[data-file-id]:has(.FilesSidebarTreeItemPrimaryAction[aria-selected="true"])`.
- Sidebar row primary action: `.FilesSidebarTreeItemPrimaryAction`.
- Sidebar row more action: `.FilesSidebarTreeItemMoreAction`.
- Sidebar context menu: `[data-files-sidebar-tree-context][role="menu"]`.
- Folder explorer root: `.FileNodeViewFolderExplorer`.
- Folder explorer rows: `.FileNodeViewFolderExplorer-row`.
- Folder table drop target state: `.FileNodeViewFolderExplorer-row-drop-target`.
- Folder table dragging state: `.FileNodeViewFolderExplorer-row-dragging`.

## Common Gotchas

- Editor mode radios are small native inputs. If a radio locator times out, click the matching `#app_main_header_content label`.
- Uploaded source files and generated `.md` siblings can share filename prefixes. Use exact role-name locators for per-node actions, such as `getByRole("button", { name: "More actions for qa.pdf", exact: true })`.
- The folder explorer and sidebar tree can expose duplicate action names. Scope to the owning tree row, folder row, or panel before clicking.
- Inline create/rename inputs may stop matching by old value after `fill(...)`; re-locate by the new value or use `page.keyboard.press("Enter")` after confirming focus.
- Use real drag gestures for drag/drop checks. Do not use `dispatchEvent`, DOM `element.click()`, or forced clicks.

## High-Value Recipes

### Sticky Comments Filter

Use this after changing rich-text comments layout.

- Select `#app_file_editor_sidebar_tabs_comments`.
- Read `getBoundingClientRect().y` for `getByRole("searchbox", { name: "Search document comments" })` scoped within `getByRole("complementary", { name: "Document comments" })`.
- Set `.FileNodeView-editor-area.scrollTop` to a larger value.
- Verify the filter `y` stays stable while `.FileEditorRichTextAnchoredComments-thread-container` moves.
- Verify the filter has an opaque background so comments do not show underneath it.

### Sticky Agent Panel

Use this after changing the right sidebar, tabs, panel group, or chat layout.

- On `Comments`, `.FileNodeView-editor-sidebar-panel` should be `position: static` and move with `.FileNodeView-editor-area` page scroll.
- On `Agent`, `.FileNodeView-editor-sidebar-panel` should be `position: sticky` and keep a stable `y` during page scroll.
- Verify `.AiChatComposer` remains visible near the bottom of the viewport after scrolling.

### Create File Or Folder

- Bind one `/files` tab and use a unique `aaa-pw-qa-*` temporary folder.
- Create a folder from root; verify the default name is selected and the route does not unexpectedly navigate.
- Inside the temp folder, create a file and verify the basename selection for `new-file.md`.
- Try duplicate deep paths: duplicate file should show `This file already exists.`, duplicate folder should show `This folder already exists.`.
- Archive the temp folder when done.

### Sidebar Selection Context

Use this when changing tree focus, context menus, selection, or route sync.

- Ensure URL has a non-root `nodeId`; if needed, click a visible `.FilesSidebarTreeItemPrimaryAction`.
- Control-click a second row and verify selected rows include both ids.
- Click Search files or empty tree whitespace; selection should reconcile to `[nodeId]`.
- Open a row menu and the top more-options menu; multi-selection should remain visible while each menu is open.
- On `nodeId=root`, outside interactions should clear temporary multi-selection to `[]`.
- Do not click archive/delete menu items during this check.

### Folder Table Drag And Drop

- Create or reuse a folder with two child folders and at least one Markdown file.
- Drag a file row onto a folder row; verify it leaves the source table and appears in the target folder.
- Drag a folder row onto another folder row; verify the moved folder appears inside the target.
- Drag onto a file row; verify no move and no `.FileNodeViewFolderExplorer-row-drop-target`.
- While a move is pending, verify the row cannot start another drag and its more-actions button is disabled.

### Sidebar Drop Zone Visuals

- Use a nested tree such as `new-folder/drop-child/drop-grandchild/test.md`.
- Drag over root empty space and folders at multiple depths.
- Valid folder/root drops should show the orange dotted enclosure; invalid file-row drops should not.
- The drop indicator should be `aria-hidden`; accessibility snapshots should still expose only the normal `files_nodes` tree and treeitems.

### Sidebar Row Surface Visuals

- Inspect `.FilesSidebarTreeItemPrimaryAction`.
- Idle unselected rows should have no elevated selected surface.
- Selected and focus-visible rows should use the elevated surface.
- Hover should brighten text without applying the selected surface.
- Active/pressed rows should use the darker pressed surface and inset-only shadow.
- Secondary action buttons should keep button styling and not inherit row-surface styles.

### R2 Upload And PDF Siblings

- Fixture: `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`.
- Select the target folder before clicking sidebar `Upload file`; file-selected uploads may target root.
- After upload prep, the source PDF should appear as a normal tree node.
- During processing, the source file panel should show pending/processing metadata, not converted Markdown.
- Same-folder duplicate upload should show `File already exists` with `Replace` and `Upload renamed file`.
- After conversion, folder explorer should show visible regular siblings in order: `<name>.pdf`, `<name>.pdf.md`.
- Opening `<name>.pdf.md` should mount the normal rich editor with converted content.

### File Agent Search Read Edit

- Put or find a unique token in the selected Markdown file.
- Open `Agent` and ask it to search for the token, read the file, and make a small edit.
- Verify `Search files`, `Read file`, and `Edit file` tool disclosures appear.
- Review/apply via `[data-testid="review-changes-button"]`.

### Presence Stress

- Make sure presence is enabled in the left sidebar.
- Click between two sibling file treeitems 10+ times.
- Wait 8-10 seconds for presence heartbeats/disconnects.
- Check logs for `presence:disconnect`, `presence:heartbeat`, `Rate limit exceeded`, `should_never_happen`, and `currentPresenceData`.

## Script Pattern

For anything longer than a one-liner, prefer a temp file:

```powershell
$scriptPath = Join-Path $env:TEMP 'playwriter-files-check.js'
@'
await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: "/files" });
state.page.setDefaultTimeout(10000);
// Task-specific checks here.
state.page.removeAllListeners();
'@ | Set-Content -LiteralPath $scriptPath -Encoding utf8
pnpx playwriter -s $session -f $scriptPath --timeout 90000
```
