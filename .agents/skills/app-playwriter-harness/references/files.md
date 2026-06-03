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

### File Agent Just Bash

Use this after changing the AI bash tool, tool rendering, or agent file-access configuration.

- Bind one `/files` tab and navigate to `/w/personal/home/files` if needed.
- Open `#app_file_editor_sidebar_tabs_agent`.
- Start a new chat from the sidebar chat controls.
- Pace sequential sends and handle `429` responses by waiting for `retryAfterMs` and using the visible `Retry` button.
- Send a broad file-listing prompt such as `List all files in the system using bash`; verify the assistant uses a Bash disclosure and lists the mounted app file tree without explaining host-machine access limits.
- Send prompts that force separate bash tool calls for `pwd`, `ls /home/cloud-usr/w/personal/home`, `cat /home/cloud-usr/w/personal/home/<known-md-path>`, `search --limit 5 <known-token>`, and `grep -Rn <known-token> /home/cloud-usr/w/personal/home`.
- For search regressions, use a token known to appear in several Markdown files and verify the result includes every expected path up to the requested limit, not just the top indexed search hit.
- Send `cd /home/cloud-usr/w/personal/home/<known-folder>` and then a second prompt asking for `pwd`; verify the second bash result uses the persisted cwd.
- In Agent mode, ask it to create a timestamped folder with `mkdir /home/cloud-usr/w/personal/home/playwriter-ai-chat-qa-<timestamp>`; verify the new turn shows a Bash disclosure and does not show a `create_folder` tool.
- In Ask mode, ask it to try `mkdir /home/cloud-usr/w/personal/home/playwriter-ai-chat-ask-denied-<timestamp>`; verify bash reports that durable folder creation belongs in Agent mode and no folder appears.
- Ask it to try `echo nope > /home/cloud-usr/w/personal/home/agent-bash-qa.md`; verify the bash result reports a read-only filesystem error.
- Ask it to make one real Markdown edit; verify the new turn uses `write_file` or `edit_file`, not a bash write under the project mount.
- Inspect the latest assistant tool parts and verify new turns do not show legacy `Read file`, `List files`, `Glob files`, `Grep files`, or `Search files` disclosures unless they came from older transcript history.

### File Agent Corpus Generation

Use this when creating many QA files through the app agent.

- Use fresh chats for each small batch so model context stays clean.
- Keep each prompt to 3-4 `write_file` paths. Larger batches can make the assistant claim success before every file is actually persisted.
- After clicking `New chat`, verify the selected `.AiChatThread[data-thread-id]` starts with `ai_thread-` before sending. If the selected tab immediately reverts to an older persisted id, debug the optimistic tab cleanup before continuing.
- Include a unique batch token in every requested file, but treat the Convex file-node query as the source of truth for count and paths.
- Query actual file nodes after every batch with `app_convex.query(app_convex_api.files_nodes.get_file_nodes_list, { membershipId })`; do not rely on assistant summary text or visible tool previews for the final count.
- Repair missing files in separate one-file chats instead of resending a large batch.

### AI Chat Parent Id Race

Use this after changing chat send, stop, branch, pending-message, or parent-id logic.

- Bind one `/files` tab, open `#app_file_editor_sidebar_tabs_agent`, and capture `/api/chat` requests with `page.route("**/api/chat", ...)`.
- If a New chat tab id starts with `ai_thread-*` after reload/HMR, first verify it still has an optimistic session. A stored optimistic tab must be rehydrated, dropped, or upgraded before sending; `/api/chat` should receive `clientGeneratedThreadId` for an optimistic chat, never `threadId: "ai_thread-..."`.
- When a visible user bubble shows `Message failed to send.`, clicking `Retry` should create a new `/api/chat` request for the same text. If no request is captured and the console logs `target-message-not-persisted`, the retry path is treating the failed client-only user message as a persisted branch target instead of replacing it from its original parent.
- Start a fresh chat with `getByRole("button", { name: "New chat", exact: true })`; the open chat drag handle can otherwise match the same text.
- Send a prompt that starts with a unique marker and produces a long visible answer, for example `Start with <marker>, then write 80 numbered lines. Do not use tools.`
- Wait until the marker appears, click `Stop generating`, immediately type a follow-up, and inspect `getByRole("button", { name: "Send message" })`.
- Expected immediate state: Send is disabled and no second `/api/chat` request is created while the parent is still unsafe.
- Expected recovery state: a restored blank optimistic tab can send its first message with `clientGeneratedThreadId`; follow-up sends after a message exists remain blocked until the live query swaps the UI to the persisted Convex thread and parent message.
- The UI must not create a follow-up request before that recovery state. After recovery, the follow-up request should use a persisted parent id and must not return `409` with `Parent message is not available yet`.
- A `429` is the chat rate limiter, not this race. Wait for the retry window and rerun or retry the same message; do not count it as a parent-id failure.

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
