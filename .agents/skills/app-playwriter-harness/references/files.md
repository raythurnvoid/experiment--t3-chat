# Files Route Playwriter Notes

Use this file as a quick testing map for `/files`. Keep it short and selector-oriented. If a check needs a large script, write a task-specific runner in the personal AI folder instead of pasting it here.

## Route Basics

- Route shape: `/w/:organizationName/:workspaceName/files?nodeId=<id>`.
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
- Pending tab: `#app_file_editor_sidebar_tabs_pending`.

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

## Upload Fixtures

Deterministic assets in `.agents/skills/app-playwriter-harness/assets/files/`:

- `r2-upload-sample.pdf` — PDF source-to-shadow conversion checks.
- `r2-upload-markdown-sample.md` — Markdown upload checks; it must become a normal editable Markdown node instead of a source-conversion panel.
- `shapes.png` — image-plugin QA: a red circle, a blue square, a green triangle, and the text `BONOBO QA IMAGE` on a white background.
- `speakers.wav` — video-plugin QA (audio path, ~39s): two distinct TTS voices alternating scripted lines about the quarterly budget, a penguin research station, the marketing plan, and a solar bicycle.
- `speakers.mp4` — video-plugin QA (video path, exercises the Modal audio extractor): the same `speakers.wav` audio muxed over a solid-color video track.

## Common Gotchas

- Editor mode radios are small native inputs. If a radio locator times out, click the matching `#app_main_header_content label`.
- Uploaded source files and generated `.md` siblings can share filename prefixes. Use exact role-name locators for per-node actions, such as `getByRole("button", { name: "More actions for qa.pdf", exact: true })`.
- The folder explorer and sidebar tree can expose duplicate action names. Scope to the owning tree row, folder row, or panel before clicking.
- Inline create/rename inputs may stop matching by old value after `fill(...)`; re-locate by the new value or use `state.page.keyboard.press("Enter")` after confirming focus.
- When a folder is selected, `New file` and `New folder` exist twice: once in the sidebar toolbar and once in the folder view toolbar. `getByRole("button", { name: "New file" })` is then a strict-mode violation. Scope to the sidebar with `.FilesSidebarTopSection-actions-icon-button[aria-label="New file"]`.
- A folder-explorer row's visible name (`span.FileNodeViewFolderExplorer-link`) is covered by a full-row overlay link, so clicking the text reports `intercepts pointer events`. Click the overlay by its accessible name instead: `getByRole("link", { name: "Open <name>" })`. That error message is also the quickest way to read a fixture's `nodeId`, because the overlay's `href` carries it.
- The sidebar toolbar `New file` / `New folder` buttons always create at root with a generated `new-file*.md` / `new-folder*` name and do not open rename mode, so there is no create dialog to type a name into. Build deep fixtures in two steps: create, then row menu `Rename` and type a slash path such as `qa-root/docs/api.md`. Path-shaped renames move the node and create the missing folders. The rename input is `input[aria-label="Rename <current name>"]`.
- Archived rows expose the restore action as menu item `Restore`, not `Unarchive`, and their row button label gains a suffix: `More actions for <name> archived`. Reveal them first with the sidebar `More options` menu item `Show N item(s) archived`.
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

### Folder Import

Use this after changing the bulk import flow (`run_folder_import` in `files-sidebar.tsx`, `files_nodes.create_upload_nodes`).

- Entry points: `More options` menu → `Import folder` (hidden `input[type=file][webkitdirectory]`), and multi-file/folder drops. The OS dialog cannot be fed in extension mode — use the constructed-File recipe in `known-hazards.md` ("File uploads cannot go through the OS file dialog"): predefine `path` on each `File`, assign `input.files`, dispatch a bubbling `change` event on the directory input.
- First import of a nested fixture should recreate the folder structure; `readme.md` (markdown MIME) lands as `README.md`, `*.markdown` lands as `*.md`, `.DS_Store`/`Thumbs.db` and extension-less files never appear. Verify via `app_convex.query(app_convex_api.files_nodes.list_tree, { membershipId })` paths, not the sidebar alone.
- Re-importing the same fixture opens `.FilesSidebarImportConflictModal` listing the existing paths, with buttons `Cancel import`, `Skip existing`, `Replace existing`; `Escape` cancels. Replace soft-archives the old node (old id gains `archiveOperationId`, new id appears at the same path — `list_tree` returns both, so filter archived rows before asserting).
- The progress toast (`Preparing files to import...` / `Uploading N of M files...`) carries a `Cancel` action; after a cancel, files under the import prefix must equal the summary's imported count (no phantom "waiting for upload" rows). The summary toast (`Import finished/cancelled: N imported, ...`) auto-dismisses in ~4s — read it in the same execute call or from `latestLogs` (`[FilesSidebar.runFolderImport] Skipped files`).
- Markdown finalization proof: open an imported `.md` node and assert its token text in `.FileEditorRichText-editor-content` (needs a few seconds for the R2 event + finalizer).
- Clean up by archiving the fixture root folders through `app_convex.mutation(app_convex_api.files_nodes.archive_nodes, ...)`.

### R2 Upload And PDF Siblings

- Fixture: `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`.
- Before the check, confirm the PDF plugin is installed for the workspace and its required conversion service settings are configured. Otherwise conversion cannot produce the Markdown sibling.
- Select the target folder before uploading; file-selected uploads may target root. `Upload file` is a menu item under the sidebar `More options` button, not a standalone toolbar button.
- After upload prep, the source PDF should appear as a normal tree node.
- During processing, the source file panel should show pending/processing metadata, not converted Markdown.
- Same-folder duplicate upload should show the `File already exists` modal (`.FilesSidebarUploadConflictModal`) with a `Filename` input plus `Cancel` and `Replace`/`Upload`; to upload renamed, edit the filename and submit `Upload`.
- After conversion, folder explorer should show visible regular siblings in order: `<name>.pdf`, `<name>.pdf.md`.
- Opening `<name>.pdf.md` should mount the normal rich editor with converted content.

### File Agent Bash Search Read Edit

- Put or find a unique token in the selected Markdown file.
- Open `Agent` and ask it to search for the token, read the file, and make a small edit.
- Verify a `Bash` disclosure appears for search/read steps, using commands such as `search --limit N <token>` and `cat /home/cloud-usr/w/personal/home/<known-md-path>`.
- Verify the edit step uses `Edit file` or `Write file`, not a Bash redirect under `/home/cloud-usr/w/personal/home`.
- Review/apply via `[data-testid="review-changes-button"]`.
- In Agent mode, ask Bash to `mv` a file to a new path and verify the Pending tab shows a move proposal before acceptance. Test both a rename and a move between folders.
- Ask Bash to `cp` a file to a new path and to an occupied path. Verify the Pending tab shows the copy or replacement proposal and that committed files stay unchanged until acceptance.
- For a mixed move plus content proposal, accept it and verify the move is applied before the updated content is saved.
- Writes, redirects, deletes, and `rm` remain unsupported through Bash. Verify they fail instead of creating a pending proposal.

### File Agent Just Bash

Use this after changing the AI bash tool, tool rendering, or agent file-access configuration.

- Bind one `/files` tab and navigate to `/w/personal/home/files` if needed.
- Open `#app_file_editor_sidebar_tabs_agent`.
- Start a new chat from the sidebar chat controls.
- Pace sequential sends and handle `429` responses by waiting for `retryAfterMs` and using the visible `Retry` button.
- Send a broad file-listing prompt such as `List all files in the system using bash`; verify the assistant uses a Bash disclosure and lists the mounted app file tree through `ls --limit N` or `find <path> --limit N`.
- Send prompts that force separate bash tool calls for `pwd`, `ls --limit 5 /home/cloud-usr/w/personal/home`, `find /home/cloud-usr/w/personal/home --limit 5`, `cat /home/cloud-usr/w/personal/home/<known-md-path>`, `search --limit 5 <known-token>`, and `grep -Rn <known-token> /home/cloud-usr/w/personal/home`.
- Ask for files by extension and verify the assistant uses `find -name '*.md' --limit N` or `find -iname '*.MD' --limit N`, not shell glob operands such as `ls *.md`.
- Ask for files by path prefix and verify the assistant uses `find --prefix <prefix> --limit N`.
- Ask for only the top-level entries under a folder and verify the assistant uses `find <path> -maxdepth 1`; ask for only the deeper descendants and verify it uses `find <path> -mindepth 2`. `-print` is accepted as a no-op, so `find <path> -print` must not error.
- Ask it to read many files at once (more than 10 app files or agent-only external mount files in one `cat`/`head`/`tail`/`wc`); verify the bash result reports `db-backed file reads are limited to 10 files per command` and the assistant either splits the reads across calls or switches to `search`, instead of batching one giant read.
- For search regressions, use a token known to appear in several Markdown files and verify the result includes every expected path up to the requested limit, not just the top indexed search hit.
- Send `cd /home/cloud-usr/w/personal/home/<known-folder>` and then a second prompt asking for `pwd`; verify the second bash result uses the persisted cwd.
- In Agent mode, ask it to create a timestamped folder with `mkdir /home/cloud-usr/w/personal/home/playwriter-ai-chat-qa-<timestamp>`; verify the new turn shows a Bash disclosure and does not show a `create_folder` tool.
- In Ask mode, ask it to try `mkdir /home/cloud-usr/w/personal/home/playwriter-ai-chat-ask-denied-<timestamp>`; verify bash reports that durable folder creation belongs in Agent mode and no folder appears.
- Ask it to try `echo nope > /home/cloud-usr/w/personal/home/agent-bash-qa.md`; verify the bash result reports a read-only filesystem error.
- Ask it to make one real Markdown edit; verify the new turn uses `edit_file`, not a bash write under the workspace mount.
- Inspect the latest assistant tool parts and verify new turns do not show legacy `Read file`, `List files`, `Glob files`, `Grep files`, or `Search files` disclosures unless they came from older transcript history.

### File Agent Corpus Generation

Use this when creating many QA files through the app agent.

- Use fresh chats for each small batch so model context stays clean.
- Keep each prompt to 3-4 `edit_file` paths. Larger batches can make the assistant claim success before every file is actually persisted.
- After clicking `New chat`, verify `[aria-label="Open chats"] [role="tab"][aria-selected="true"]` has an id that starts with `ai_thread-` before sending. If it immediately reverts to an older persisted id, debug the optimistic tab cleanup before continuing.
- Include a unique batch token in every requested file, but treat the Convex file-node query as the source of truth for count and paths.
- Query actual file nodes after every batch with `app_convex.query(app_convex_api.files_nodes.list_tree, { membershipId })`; do not rely on assistant summary text or visible tool previews for the final count.
- Repair missing files in separate one-file chats instead of resending a large batch.

### AI Chat Parent Id Race

Use this after changing chat send, stop, branch, pending-message, or parent-id logic.

- Bind one `/files` tab, open `#app_file_editor_sidebar_tabs_agent`, and capture `/api/chat` requests with `state.page.route("**/api/chat", ...)`.
- If a New chat tab id starts with `ai_thread-*` after reload/HMR, first verify it still has an optimistic session. A stored optimistic tab must be rehydrated, dropped, or upgraded before sending; `/api/chat` should receive `clientGeneratedThreadId` for an optimistic chat, never `threadId: "ai_thread-..."`.
- When a visible user bubble shows `Message failed to send.`, clicking `Retry` should create a new `/api/chat` request for the same text. If no request is captured and the console logs `target-message-not-persisted`, the retry path is treating the failed client-only user message as a persisted branch target instead of replacing it from its original parent.
- Start a fresh chat with `getByRole("button", { name: "New chat", exact: true })`; the open chat drag handle can otherwise match the same text.
- Send a prompt that starts with a unique marker and produces a long visible answer, for example `Start with <marker>, then write 80 numbered lines. Do not use tools.`
- Wait until the marker appears, click `Stop generating`, immediately type a follow-up, and inspect `getByRole("button", { name: "Send message" })`.
- Expected immediate state: Send is disabled and no second `/api/chat` request is created while the parent is still unsafe.
- Expected recovery state: a restored blank optimistic tab can send its first message with `clientGeneratedThreadId`; follow-up sends after a message exists remain blocked until the live query swaps the UI to the persisted Convex thread and parent message.
- For parent recovery checks, inspect the captured `/api/chat` body: once the live query catches up, the follow-up request should use the persisted `parentId` produced from normalized `metadata.convexId`, not a client-only message id.
- The UI must not create a follow-up request before that recovery state. After recovery, the follow-up request should use a persisted parent id and must not return `409` with `Parent message is not available yet`.
- A `429` is the chat rate limiter, not this race. Wait for the retry window and rerun or retry the same message; do not count it as a parent-id failure.

### Presence Stress

- Make sure presence is enabled in the left sidebar.
- Click between two sibling file treeitems 10+ times.
- Wait 8-10 seconds for presence heartbeats/disconnects.
- Check logs for `presence:disconnect`, `presence:heartbeat`, `Rate limit exceeded`, `should_never_happen`, and `currentPresenceData`.

## Script Pattern

For anything longer than a one-liner, keep the runner in a dated personal AI folder:

```powershell
$runDirectory = "../t3-chat-+personal/+ai/files-qa-$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$scriptPath = Join-Path $runDirectory "playwriter-files-check.js"
# Create this runner with the agent's targeted edit tool. Do not write it with a shell rewrite.
vp env exec pnpx playwriter -s $session -f $scriptPath --timeout 90000
```
