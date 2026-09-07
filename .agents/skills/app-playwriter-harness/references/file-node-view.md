# File Node View Playwriter Notes

Use this for the selected-file editor surface under `/files?nodeId=<file-id>`. Keep `files.md` for route/sidebar basics; use this file for editor, comments, diff, and right-sidebar workflows.

## Route And Layout

- Editor route shape: `/w/:organizationName/:workspaceName/files?nodeId=<id>`.
- Editor mode query values: `view=rich_text_editor`, `view=plain_text_editor`, `view=diff_editor`.
- The mode radios use 1px native inputs inside visible `.MyButtonGroupItem` controls. If a radio click waits forever, locate its visible wrapper with `.locator(".MyButtonGroupItem").filter({ has: page.getByRole("radio", { name: "Markdown", exact: true }) })`, inspect its rect, and click its center with normal mouse input. Check the resulting editor and route before typing.
- Plugin file views (Video Player and any plugin whose manifest declares a `fileViews` match for the content type) are extra tabs in the same switcher, named by the view's title (`getByRole("tab", { name: "Video player" })`, class `MyTabsTab`). They are never the default and there is no `view=` query value for them. Selecting the tab mints the frame session and mounts `.PluginsUiFrame` inside `.FileNodeViewPluginView`; wait ~10 s and take the frame from `page.frames()` as for a plugin page. A non-plugin video node therefore shows `File details` and no iframe until the tab is clicked. Verified 2026-09-02 on `recording.mp4` with Video Player 0.1.2.
- A file with `collaborationEnabled: false` (service uploads like Council `/meetings/<id>/transcript.md` and `summary.md`) supports every view its document shape supports, and the switcher radios do check. `files_resolve_effective_editor_view` (`packages/app/src/lib/files.ts`) takes only `requestedView` and `rootKind`; its one clamp is `plain_text` shape + `rich_text_editor` request. A non-collaborative `rich_text` file opens Rich in `FileEditorRichTextNonCollab` and Diff in `FileEditorDiffNonCollab`. Changed 2026-08-31; before that it really was clamped to Monaco.
- Scroll owner: `.FileNodeView-editor-area`.
- Content panel: `.FileNodeView-content-panel`.
- Right sidebar panel: `.FileNodeView-editor-sidebar-panel`.
- Comments tab: `#app_file_editor_sidebar_tabs_comments`.
- Agent tab: `#app_file_editor_sidebar_tabs_agent`.
- Details tab: `#app_file_editor_sidebar_tabs_details` (since 2026-08-10). Rows are `.FileEditorSidebarDetails-row` with `-label` / `-value` slots. Sidebar tabs depend on the node: a plain-text node shows Details and no Comments (and Details is its default), a Markdown node shows Comments only while collaboration is on — a non-collaborative `.md` node shows Details and no Comments, exactly like a plain-text node; a stored selection naming a hidden tab falls back without being overwritten.
- Download control: `.FileNodeViewToolbarFileDownloadAction-button`, an icon button with the tooltip `Download` and the accessible name `Download <file name>` (since 2026-08-13 it no longer shows the file name as visible text). It renders for any node that has an uploaded asset, in every node view. Locate it with `getByRole("button", { name: "Download <file name>" })`, and read the result with `page.waitForEvent("download")` — the file lands in the real `~/Downloads` folder (see `known-hazards.md`). A file whose stored asset is gone answers with a `Not found` toast, so read `[data-sonner-toast]` in the same execute call as the click.

## Read-Only Selected Node

- The selected-node header has a separate lock control; Share remains separate. Exercise all five
  states: writable, direct, direct below an outer lock, inherited with a visible source, and inherited
  with a protected source. On mutation failure the modal stays open and shows the server message.
  Escape closes, focus returns to the trigger, and a pending submit cannot run twice.
- The top floating status says exactly `This file is read-only.`, `Read-only because /docs is locked.`,
  or `This folder contains read-only items. It cannot be renamed, moved, or archived.` as applicable.
- Rich text must expose `contenteditable=false`. Plain and diff Monaco models must report read-only.
  Keep selection, copy, search, mode changes, snapshots browse/download, and existing-comment replies.
  Disable Save, Sync where it would write, Accept, anchored comment create/resolve, media insert/upload,
  and diff hunk/model discard. The Pending panel's dedicated whole-proposal Discard stays enabled.
- To prove stale Yjs work is gone, queue a local rich-text edit, lock and unlock from the other
  identity, wait for the persistent unsaved-changes warning and committed resync, then make one fresh
  edit. The old text must never appear after the fresh edit or a reload.
- Start an upload, lock its node or parent from another session, then finish the PUT. Assert the
  normal waiting/processing state becomes ready, Download works, and the file keeps its direct or
  inherited read-only state. A reused signed URL must not replace the immutable live bytes.

## Rich Text Editor

- Toolbar: `[role="group"][aria-label="Rich text editor actions"]` (class `.FileEditorRichTextToolbarActions`). The only `role="toolbar"` in the app is the page-level `[aria-label="File actions"]`.
- Content root: `.FileEditorRichText-editor-content-root`.
- Editable content: `.FileEditorRichText-editor-content`.
- Run the destructive typing example below only in a disposable QA file. If the file already has suitable text, select that text instead of replacing the document.
- A sidebar-created `new-file*.md` opens with template content, and a click into the editor can land the caret mid-word. Select all (`Control+A`) or press `Control+End` before typing a fixture token, or the token lands inside the template text and substring assertions match confusingly (hit in the 2026-08-10 QA run).
- Split a select from the destructive key that follows it: run `Control+A` and the delete/replacement typing in separate execute calls with an observe between them. Combined in one call, the destructive step can run against a selection that has not landed yet (hit in the 2026-08-10 QA run).
- To expose the bubble **Comment** button, keep a non-empty selection. Typing after `Control+A` collapses the selection, so reselect text before clicking **Comment**:

```js
const editor = state.page.locator(".FileEditorRichText-editor-content").first();
await editor.click();
await state.page.keyboard.press("Control+A");
await state.page.keyboard.type("Playwriter comment anchor text.");
await state.page.keyboard.press("Shift+Home");
await state.page.getByRole("button", { name: "Comment" }).click();
await state.page.getByRole("form", { name: "New document comment" }).waitFor({ state: "visible" });
```

## Rich Text Comments

Use role locators for forms and buttons. For TipTap contenteditable editors, use a scoped semantic selector with `contenteditable` and `aria-label`; Playwright's role textbox locator may not resolve these editors consistently even though snapshots show them as textboxes.

| Context | Form | Editor | Submit button |
|---|---|---|---|
| Rich text inline comment | `getByRole("form", { name: "New document comment" })` | `locator('[contenteditable="true"][aria-label="Add comment to selection"]')` | `getByRole("button", { name: "Submit comment" })` |
| Sidebar thread reply | `getByRole("form", { name: "Reply to comment" })` | `locator('[contenteditable="true"][aria-label="Reply to comment"]')` | `getByRole("button", { name: "Reply to comment" })` |

```js
const newCommentForm = state.page.getByRole("form", { name: "New document comment" });
await newCommentForm.locator('[contenteditable="true"][aria-label="Add comment to selection"]').fill(text);
await newCommentForm.getByRole("button", { name: "Submit comment" }).click();
```

```js
const replyForm = state.page.getByRole("form", { name: "Reply to comment" });
await replyForm.locator('[contenteditable="true"][aria-label="Reply to comment"]').fill(text);
await replyForm.getByRole("button", { name: "Reply to comment" }).click();
```

- Commented text in the document is wrapped in `span.lb-tiptap-thread-mark` (class from `packages/app/shared/files-tiptap-comments.ts`); its `data-lb-thread-id` attribute carries the thread id. Use it to assert a comment mark survived a save or a reload.

## Comments Sidebar

- Comments region: `getByRole("complementary", { name: "Document comments" })`.
- Comments filter: `getByRole("searchbox", { name: "Search document comments" })` scoped within the comments region.
- Anchored comment item: `.FileEditorRichTextAnchoredComments-thread-container`.
- Thread summary: `.FileEditorCommentsThread-summary`.

```js
await state.page.locator("#app_file_editor_sidebar_tabs_comments").click();
await state.page.locator(".FileEditorCommentsThread-summary").filter({ hasText: threadRootText }).first().click();
await state.page.getByRole("form", { name: "Reply to comment" }).waitFor({ state: "visible" });
```

## Plain Text Editor

- Since 2026-08-10 this is a primary editor surface, not just the Markdown source view: every plain-text file (`.json`, `.yaml`, `.csv`, `.txt`, `.ts`, `.js`, `.css`, and any name whose stored type is not Markdown) opens in it by default, with Monaco language tokenization derived from the stored content type (`files_monaco_language_id_of_content_type`), so a renamed file keeps its language. A Markdown file keeps the rich text editor whatever its name and reaches this surface as the **Markdown** mode radio; on a plain-text node the same radio reads **Code** and there is no **Rich**.
- Root: `.FileEditorPlainText`, holding a real Monaco editor (`.monaco-editor`), not a textarea. Drive and read it with the Monaco recipes in `known-hazards.md`: the keyed handle (`window.__qa.monaco().plainText`), `trigger`-typing, `executeEdits`, the sorted `.view-line` readback, and the `data-mode-id` language read.
- Toolbar: `[aria-label="Text editor actions"]` (renamed from `Markdown editor actions` on 2026-08-10), holding `Save`, `Sync`, the size badge, and `Open file snapshots`.
- Dirty tracking is debounced: after an edit, `Save` shows a `Checking` spinner before it enables. Poll `save.isEnabled()` for a few 300ms rounds instead of clicking right away.
- Save and Sync refusals surface as toasts; push refusals show the server `_nay` message verbatim, including the "This change is too large to compare safely" diff-budget message. Read `[data-sonner-toast]` in the same execute call as the click.
- A refused content read renders a closed-editor alert instead of a fabricated empty document. Do not read a missing `.monaco-editor` as "still loading" without checking for that alert.
- The plain text editor does not live-collaborate. Edits stay local until `Save`, and `Sync` is disabled while `workingYjsDocSequence === serverSequence` — that is, until somebody else moves the server forward.

### Sync And Undo QA

Use this after changing how the plain editor writes content into its Monaco model. It proves that a sync keeps the user's undo history instead of resetting it. Runnable again since 2026-08-10 through the editor-handle route (synthetic keyboard input still never reaches Monaco — see `known-hazards.md`).

1. Create a disposable `.md` file and open it with `view=plain_text_editor` (step 4 needs the rich editor, so a plain-text node cannot carry this flow).
2. Make several local edits, each its own undo step. `ed.trigger("keyboard", "type", ...)` runs the same command path as typing, including the undo stack, and a cursor move ends the current Monaco undo group:

```js
await page.evaluate(() => {
	const ed = window.__qa.monaco().plainText;
	for (const chunk of ["\nlocal-one", "\nlocal-two", "\nlocal-three"]) {
		const end = ed.getModel().getFullModelRange().getEndPosition();
		ed.setPosition(end); // the cursor move also closes the previous undo group
		ed.trigger("keyboard", "type", { text: chunk });
	}
});
```

3. Assert `Save` is enabled and `Sync` is still disabled. `Save` enables after a debounced dirty check, so poll it.
4. Move the server forward from a second tab on the same `nodeId` with `view=rich_text_editor`, which does sync live. Type anything there. `Control+End` does not reach the document end in TipTap, so expect the text wherever the caret happened to be — the point is only that the sequence advances.
5. Back in the plain-editor tab, `Sync` is now enabled. Click it and confirm the content merges: the remote change and every local edit are present together.
6. Run the undos through the handle **in the same execute call**, capturing `ed.getModel().getValue()` after each `ed.trigger("keyboard", "undo", null)`. The first undo must revert the sync alone and leave all local edits in place; each later undo must remove one local edit. If the first undo jumps straight to the server content and the second does nothing, the editor is replacing its model instead of editing it.
7. Check `getLatestLogs` is clean, then close both QA tabs.

## Diff Editor

- Diff editor root: `[aria-label="File diff editor"]`.
- Diff editor toolbar: `[aria-label="Diff editor actions"]`.
- Pending updates banner: `[data-testid="pending-edits-banner"]`.
- Review changes button: `[data-testid="review-changes-button"]`.
- Save staged changes: `getByRole("button", { name: "Save staged changes" })`.
- Accept all: `getByRole("button", { name: "Accept all pending changes in this file" })`.
- Accept all and save: `getByRole("button", { name: "Accept all pending changes and save" })`.
- Synthetic input cannot drive Monaco at all since `monaco-editor` 0.56.0 — clicks do not focus it, and `keyboard.type` / `keyboard.insertText` / paste never reach the model. For local pane edits, use the keyed editor handle route (`window.__qa.monaco().diffModified` + `trigger`/`executeEdits`, see the Monaco section in `known-hazards.md`). To create the draft as server state instead, write it through the client helper the editor's own flows use — it runs the whole staged-page pipeline (operation batch, text inputs, ids-only action), which replaced the old `upsert_file_pending_update({ unstagedMarkdown })` action shape on 2026-08-10. From page context as the user who owns the draft:

```js
const m = await import("/src/lib/app-convex-client.ts");
const f = await import("/src/lib/files.ts");
const membership = await m.app_convex.query(m.app_convex_api.organizations.get_membership_by_organization_workspace_name, {
	organizationName,
	workspaceName,
});
const result = await f.files_upsert_file_pending_update({
	membershipId: membership._id,
	nodeId,
	unstagedText, // the full proposed content; staged stays at the committed base when stagedText is omitted
});
// result._nay carries the refusal (over-cap, active batch, frontmatter caps, ...); handle it.
```

  A fresh diff mount then shows the draft in the modified pane with hunk widgets, and the pending sidebar gets a `Modified` row. A draft equal to the committed content self-cancels and creates no row. Read pane text back with the sorted `.view-line` readback from `known-hazards.md`. One batch per user/node is active at a time: a refused flow retires its batch immediately, but a crashed runner's batch can block the same user's next draft for up to ~2 minutes (idle takeover) — retry rather than debugging the app.

### Content Size Cap QA

**Runnable again since 2026-08-10** through the keyed editor handle: `window.__qa.monaco().diffModified` (or `.plainText` in the plain editor) plus `executeEdits` puts over-cap content into the local pane — see the Monaco section in `known-hazards.md`. Build the over-cap text by repeating a short line until the total passes 900,000 bytes (`files_MAX_TEXT_CONTENT_BYTES`). Synthetic clicks and paste still never reach Monaco, and the pending-draft helper cannot stand in because the backend rejects an over-cap draft.

What the flow verifies: with over-cap text in the unstaged pane, `.FileEditorDiffToolbarActions-size-badge` reads `Over limit`, the `role="status"` live region reads `File is over the size limit. Remove content to save.`, the blocked draft sync stays silent, each of `Save staged changes` / `Accept all pending changes in this file` / `Accept all pending changes and save` toasts `This file would be … over the … limit …` without changing `.editor.original`, and a reload returns both panes to the committed content (nothing over-cap ever persists). The durable server-side over-cap state has its own runnable flow below (`Content Too Large Banner QA`).

### Content Too Large Banner QA

Checks the durable server state: when materialization rebuilds Markdown over the cap it stops committing and sets `files_nodes.contentTooLargeByteSize`. The banner lives in the shared top floating surface (`.FileNodeViewTopFloating-content-too-large-message`, inside the existing `role="status" aria-live="polite"` surface).

The editors block over-cap content before it is pushed, so the UI cannot produce this state. Drive it from the CLI instead, in `packages/app`:

1. Open any Markdown file and read its `data-file-id` from the sidebar row. Look up its org and workspace ids with `vp env exec pnpm exec convex data files_nodes --limit 1000 --order asc`, filtered on that id (there is no per-id filter, so pipe through `Select-String`).
2. Read the current sequence with `vp env exec pnpm exec convex run files_nodes:get_file_content_materialization_state '{"organizationId":…,"workspaceId":…,"nodeId":…}'`. `mark_file_content_too_large` only applies when `sequence` equals both `yjsLastSequenceDoc.lastSequence` and `targetSequence`, so pass that one number for both.
3. Prove the banner arrives reactively, without a reload: start a runner that waits on the selector, then run the mutation while it waits.

```powershell
Start-Job -ScriptBlock { vp env exec pnpx playwriter -s 13 -f <wait-runner> --timeout 30000 } -Name banner | Out-Null
Start-Sleep -Seconds 3
vp env exec pnpm exec convex run files_nodes_content:mark_file_content_too_large '{…,"sequence":4,"targetSequence":4,"byteSize":987654}'
Receive-Job -Name banner -Wait
```

The wait runner reads the message before and after `waitForSelector`, and logs `performance.now()` so the report can show the DOM changed mid-session rather than on a load.

4. Assert the message names the size, the limit and how much to remove, that it is ellipsized with the full text in `title`, and that the icon uses the red token. Do not screenshot it: the floating surface never settles for Playwright's stability check and both page and element screenshots time out.
5. Clear it the real way: type a few characters in the editor, then wait for `waitForSelector(…, { state: "detached" })`. Materialization runs through the workpool, so allow up to ~90s; it cleared in ~14s in practice. Remove the typed characters afterwards if the file is not disposable.

### Frontmatter Indexing Warning QA

Upload `assets/files/qa-frontmatter-overcap.md` through the sidebar. After conversion, the rich editor stays editable and `.FileNodeViewTopFloating-frontmatter-too-large` appears in the shared top status. Its full message is in the nested span's `title`; assert it reports 129 fields and 258 index entries, with limits of 128 and 512. The node must not show the stored-file card or enter a conversion retry loop. Archive the fixture after the check.

## Non-Collaborative Editors (No Yjs)

Since 2026-08-31 a file with collaboration turned off supports every view its document shape supports: the rich and diff views are backed by the stored string instead of a Yjs document. The view-switcher buttons are functional; asserting the mounted editor changed is the real check.

Rich view (`FileEditorRichTextNonCollab`, only for `rich_text` shape):

- Since 2026-09-04 this editor owns its own class names, so the collaborative selectors do NOT match it: use `.FileEditorRichTextNonCollab-editor-content` and `.FileEditorRichTextNonCollab-editor-content-root` (root `.FileEditorRichTextNonCollab`, shown state `.FileEditorRichTextNonCollab-visible`). The element structure is the same, so the existing typing recipes work once the class prefix is swapped. The CSS still shares the rules by listing both selectors, so the two variants look identical.
- The editor is a multiline textbox named `File text`; use `getByRole("textbox", { name: "File text" })`. Its `aria-readonly` follows the file's edit permission.
- Toolbar: `[role="group"][aria-label="Rich text editor actions"]` with class `.FileEditorRichTextNonCollabToolbarActions`, holding `Save` (with the `Checking` spinner while the dirty check debounces), the word/size badges, and `Open file snapshots`. No Sync.
- A crowded rich toolbar can put the snapshots button under the Comments sidebar tab. Hit-test a failed pointer click. Keyboard access still works: focus `Open file snapshots`, then press Enter; Escape closes the dialog and returns focus. Save can drop focus to the page body when it becomes disabled. These are known layout and focus issues.
- Reformat hint: `.FileEditorRichTextNonCollabToolbarActions-reformat-hint` reads "Saving from the rich editor will reformat this file's Markdown." It shows only while the loaded Markdown differs from what the editor would serialize, and it goes away after the first save.
- The bubble **Comment** button is disabled while unsaved edits exist. The disabled button carries `title` and `aria-label` `Add comment — save your changes first`. After a save it enables, and submitting a comment saves the file again at once (the mark must live in a committed version).
- A refused content read renders `.FileEditorRichTextNonCollab-refusal` (`role="alert"`) instead of the editor.
- Last write wins. A tab with older text can save that text, and the previous saves stay in File Snapshots. Adding a comment also saves the tab's whole text plus its mark, without merging another tab's edits.

Diff view (`FileEditorDiffNonCollab`, both shapes):

- Same root and toolbar labels as the collaborative diff editor: `[aria-label="File diff editor"]`, `[aria-label="Diff editor actions"]`. Tell them apart by class: the non-collaborative root is `.FileEditorDiffNonCollab` and its toolbar holds only `Save`, `Discard all` (`aria-label="Discard all changes in this file"`), the size badge, and the snapshots button — no Sync, no Accept all.
- The original pane is the committed text, the modified pane is the member's local edits. Monaco's per-hunk revert arrow in the margin restores the committed text for one hunk; there are no accept/discard widgets.
- Both panes register the usual keyed handles: `window.__qa.monaco().diffOriginal` / `.diffModified`.
- A refused content read renders `.FileEditorDiffNonCollab-refusal` (`role="alert"`).

Diff view with a pending proposal (since 2026-09-06, `FileEditorDiff` in its collaboration-off mode): when the signed-in member has an agent proposal on the file, `view=diff_editor` reviews it instead. The root is `.FileEditorDiff` (not `.FileEditorDiffNonCollab`), the original pane is the staged branch (the committed text, re-serialized for a Markdown file, until a hunk is accepted) and the modified pane is the unstaged branch (the proposal), the hunk widgets and `Save staged changes` / `Accept all` / `Discard all` work as for a collaborative file, and the toolbar has no `Sync with live file` and no `Open file snapshots`. Save shows the toast `Changes saved` and the view exits to the default editor once the doc is gone. Opening a stale proposal (a member saved the file after the agent made it) starts Review preparation. A `role="status"` line `.FileEditorDiff-stale` says `Updating this proposal for the file's current text…`. Both panes stay read-only until the merged branches load. Conflicts keep the old text and offer `Copy accepted text`, `Copy proposed text`, Retry, and `Discard proposal`. Preparation never saves file text. While the pending list is still loading the view shows `FileEditorDiffSkeleton` (`role="status"`, sr-only `Loading changes…`). The pending row of a stale proposal shows the caption `Review to update`, its link name ends with `, review to update`, and its Accept button stays enabled with the refusal message in `title`. Bulk Accept skips stale content and explains that it needs Review. Save keeps `Save staged changes` disabled until the view's doc query shows the save, which can land about a second after the action result, so assert on the toast and the exit rather than a fixed delay. `mv -f <src> <dst>` onto a file with collaboration off is a replace proposal, not a content one: the row caption is `Replaced`, its buttons are `Accept move of <src> to <dst>` / `Discard move of <src> to <dst>` (not `Accept changes to`), and Accept moves the source node onto the path with its own asset and archives the old node under the same id, so resolve the id again from `list_tree` afterwards. Collaboration changes use the preservation and preparation flow below. The `.FileEditorDiff-stale` status line is always rendered, so assert its text, not its presence. `list_files_pending_updates` rows hold the node under `fileNodeId`. To move between files without a reload (the chooser in `FileEditorInner` keeps state across nodes, which only an in-app move can exercise), navigate from page context: `const { app_router } = await import("/src/lib/app-router.ts"); await app_router().navigate({ to: "/w/$organizationName/$workspaceName/files", params: { organizationName: "personal", workspaceName: "home" }, search: (prev) => ({ ...prev, nodeId, view: "diff_editor" }) })`. Every such move between diff views logs `[pageerror] no diff result available`; that is Monaco's own (see `collab-yjs-comments-regression.md`), not an app fault.

Review exit checks:

- At a 1156px viewport with both sidebars open, check that preparation and conflict status text starts below the floating Pending bar. Copy, Retry, and Discard proposal must stay clear. The page must not overflow sideways. An empty status line must take no space.
- The assembled toolbar scrolls horizontally. Before treating a failed hit test as an overlap, check its clipping bounds and scroll position. Tab must bring each button fully into view; then test its center again. A clipped button's unscrolled center can land on a sidebar tab even though the visible controls work correctly.
- Accept all + save, content discard, and an ordinary failed branch reload return to the file's default editor with history replacement. A failed preparation reload keeps the old panes and offers Retry instead. Read `history.length` before and after an exit; it must not grow. Then use Back and assert the empty `.FileEditorDiffNonCollab` view does not mount.
- To check a mixed delete proposal, have the agent write the file and then run `rm` on the same path. Open its content review and use `Discard all pending changes in this file`. The toast says `Text change discarded. The delete is still pending.` The Pending list must still show `Deleted`, and a fresh row read must keep `pendingArchive` with no content base. Discard the delete row separately when resetting the fixture.
- To check a thrown branch reload, create two text hunks, accept one, and Save. Temporarily make the page client's `get_file_pending_update_state_page` query throw for only that fixture node during the reload. Expect `Failed to load the updated proposal. Open it again.` and an exit to the default editor. Restore the original query method immediately, then reopen the proposal to confirm it still loads. This checks the client failure path; it does not emulate a real server outage.

Fixture recipe: see "Non-Collaborative File Fixture" in `files.md`. Resolve active nodes by id or skip `archiveOperationId` when finding them by path. Inspect stale branches before opening Review, since Review now prepares them immediately.

### Pending Proposals After a Member Save

Use a collaboration-off file and the branch readback steps in the toggle recipe below. Give the accepted and proposed branches separate edits, then save a third edit far away through the normal editor. Before Review, check that the old proposal and all three branch texts are unchanged. Agent reads must return the saved text, and a text write must refuse with instructions to open Review or discard.

Open Review and check the preparation status, read-only panes, and final branch texts. Both branches must include the member's edit while keeping accepted and proposed edits separate. Preparation must leave the saved file unchanged. Save accepted text, then save the remaining proposal; check exact saved text after each action. Repeat with Review mounted during another member Save.

Use overlapping edits to check conflict, Copy accepted text, Copy proposed text, Retry, and Discard. Retained unsent pane text must remain available to copy. If preparation settles and closes Review, only panes with unsent text should show a 30-second Copy toast. Closing a clean or confirmed draft must not warn about unsaved text. Hold an old draft response while preparation finishes and check that it cannot restore old panes. Record simulated races separately from normal browser checks.

Before Review, check single Accept refusal and bulk Accept skipping stale content. A pending delete keeps its own action. After successful Review, have the agent read again and confirm a fresh text write succeeds. Also check Markdown/frontmatter, saved-text search and metadata, keyboard access, and narrow layout.

### Pending Proposals Across Collaboration Changes

Run this recipe with matching backend and frontend code. Record the checks that ran and any limits before claiming a pass.

Use disposable files and a unique run id. Follow "Non-Collaborative File Fixture" in `files.md` for Markdown and real plain-text shapes. A `.txt` name passed to `create_text_node` still creates Markdown. Read `second-user-fixtures.md` before any check with a second member; keep the primary browser's login.

1. Save the file, then create a proposal through the client helper in "Diff Editor" above. Supply `stagedText` and `unstagedText` with separate edits to test partially accepted changes. Finish any pending new-file decision first.
2. Record the proposal id, `updatedAt`, three state ids, branch texts, and exact committed text. Use fresh authenticated HTTP queries for `get_file_pending_update` and `list_files_pending_updates`; the React client's subscription cache can return the state before a write. Fetch all three branches with `files_fetch_file_pending_update_yjs_state` and decode them with `contentRebaseRootKind ?? node.textKind`. Use a signed download for saved non-collaborative text. `files_fetch_file_yjs_state_and_text` returns null for those files; for collaborative files its `text` is a Result, so read `text._yay` after checking `_nay`.
3. Open Properties. Scope to `[data-files-properties-modal][data-open="true"]`, click `.FilesPropertiesModalCollaboration-checkbox`, and confirm with `Turn collaboration off`. Check the warning says proposals are kept and still explains the loss of shared edit history and comments. Check focus reaches the inline confirmation.
4. Before opening Review, read the stored proposal again. Its id, old branch ids, text, and `updatedAt` must be unchanged, with `contentNeedsRebase: true`. `get_file_pending_update` also returns `currentYjsLastSequenceId` from the current file. That field is not stored on the proposal and changes across the switch. The Pending count must still include it and the row must say `Review to update`.
5. Try single and bulk content Accept before Review. They must keep marked content pending and explain why it needs review. Ordinary agent reads return committed text. An agent append or edit prepares its proposal automatically, then computes the write from the fresh proposed text. Run the read and write separately. Assert the old proposed edit and unrelated saved text survive, the new edit appears once, and saved content stays unchanged. Use separate fixtures for agent preparation and the Review preparation check below. A pending delete keeps its own action. A marked content-plus-move row's combined Accept still refuses. To test its separate move, use Diff's `Discard proposal` to remove only content, then accept the remaining move-only row. The Pending row's Discard removes both parts.
6. Open Review. Check the status `Updating this proposal for the file's current text…`. Typing, hunk actions, Save, Sync, and delayed draft writes must stay blocked until the prepared proposal and all three new states load. While preparation is held, try keyboard input and read both the visible panes and stored branch text again. Monaco's accessibility tree may report `readonly: false` even for its always-read-only original pane, so also inspect each editor's `readOnly` option and its actual response to input. Read the final proposal: the flag is gone, its base matches the current mode, and both branches keep their expected edits.
7. Save the staged edits. Read exact committed text and remaining proposal text, then save the remaining proposal. While ON, also test a separate live edit between the two saves. Confirm no duplicated accepted text and no lost edits. While OFF, an ordinary separate save makes the remaining proposal stale; opening Review prepares it against that saved text. A toast or screenshot alone does not prove a save.
8. Create a proposal while OFF and repeat through `Turn collaboration on`. Check Markdown formatting against the actual new document text. Run both directions for `.md` and `.txt`, then repeat with Review already open in a second tab. Preserve unsent pane text for copying and check that late results cannot replace the current panes.
9. Before toggling, save a newer edit far from the proposal's edit. Switch modes and open Review; both edits must survive. Repeat with proposed `150` over saved `120` and `200`: accepting that line must save `150`. If saved text adds lines inside a rewritten section and the target cannot be matched, preparation must refuse while keeping both stored branches. Check `Copy accepted text`, `Copy proposed text`, Retry, and Discard for that refusal. Windows clipboard reads can use CRLF; normalize line endings before comparing.
10. With two authorized members on a non-default QA workspace, create one proposal per owner. The switch must keep both. Each member must see and prepare only their own proposal. Also check a proposal with a pending move and one with a pending delete. Create their content proposals first, wait for readback, then ask for one exact Bash move/delete command; a model can otherwise run its setup tools in parallel.
11. Check keyboard review, confirmation, Retry, and copy actions; status announcements; focus after loading; 200% zoom; and narrow layout. A smaller viewport is a reflow check, not proof of actual browser zoom. Screen the open Properties dialog, Pending panel, and the separate File actions toolbar with `auditAccessibility`, read `controlCount`, and inspect any reported overlap. If toolbar text is clipped, check whether Tab brings each control into view. Use the browser accessibility tree for names and states when needed.
12. Read `latestLogs({ sinceLastCall: true })` after every action. Save exact before/after text, proposal ids, assertions, logs, and relevant screenshots in the personal task folder. Record races that were observed separately from races covered only by tests. Archive only the disposable fixtures after the final readback.

The toggle itself keeps proposal expiry unchanged. Opening Review may prepare immediately, so inspect the retained ids from another tab before opening it. Preparation writes no committed file text. OFF still removes the shared Yjs history and comment anchors; ON may change Markdown formatting. Existing stale proposals caused by an ordinary OFF save keep the behavior described above.

Also check ordinary draft typing in both modes after each change to the save path. Append six different text chunks 350 ms apart with Monaco `trigger("keyboard", "type")`. This tests the editor command and save path, not the browser's native keyboard input path. Record `getRawOptions().readOnly` before each command and the exact text after it. Let the writes settle, read the saved proposal through fresh HTTP queries, then reopen Review. Every added chunk must appear once. The pane must stay editable during its own ordinary draft save. Repeat after a full Save to check that new typing starts a new proposal. Do not count a run interrupted by HMR; reload after the source is frozen and start a fresh fixture.

### Collaborative section moves and deletions

For a collaborative move/delete check, create a pending paragraph edit, then use the Markdown editor's `executeEdits` and real Save button to move or delete that paragraph. Record `yjsLastSequenceId` before and after Save: it must stay the same while the sequence increases. Open Review and click `Sync with live file`. Read both visible panes and the stored staged/unstaged states. A unique moved paragraph keeps its new position; a deleted proposed paragraph returns in the proposed pane with its paragraph breaks. Save stays separate from Sync.

## Agent Sidebar

- Switch with `#app_file_editor_sidebar_tabs_agent`.
- On the **Agent** tab, `.FileNodeView-editor-sidebar-panel` should stay sticky during `.FileNodeView-editor-area` scroll.
- Verify `.AiChatComposer` remains visible near the bottom of the viewport after scrolling.

## Pending Changes Sidebar

- Switch with `#app_file_editor_sidebar_tabs_pending`.
- Panel region: `getByRole("region", { name: "Pending changes" })` (class `.FileEditorSidebarPending`); empty state is `.FileEditorSidebarPending-empty` ("No pending changes"). Since 2026-08-12 the empty state carries the `.FileEditorSidebarPending` root class too, so that class alone does not tell the two states apart — only the populated branch has `role="region"`.
- The panel is pinned to the viewport like the Agent tab: `.FileNodeView-editor-sidebar-panel` turns sticky and `.FileEditorSidebarPending` is `calc(100dvh - 92px)` tall at `top: 92`, with its own scroller. So on a long page (a folder after `Show more`) the panel height must stay near the viewport height, not the document height — a measured 4000+ px panel means the pinning rule stopped matching. The Comments tab is deliberately NOT pinned; it stays on the shared editor scroll surface for anchored comments.
- Source selector: `getByRole("combobox", { name: /^Pending changes source:/ })`. It contains `All changes`, `Your edits`, and one option per contributing persisted agent chat, newest activity first. `Your edits` is the threadless group. Only `All changes` stays visible at count 0; every other source, `Your edits` included, is filtered out when it has no rows. Archived chats remain available and say `Archived` in their option detail.
- One pending doc can list several contributor chat ids. The same complete row must appear in each matching chat view. Counts overlap by design and do not need to add up to the All count.
- Source filtering happens after the full row model is built. This keeps move-aware destination occupancy and replacement captions correct even when a related row belongs to a different source.
- `Accept all` and `Discard all` act only on the currently shown rows. Their accessible names are `Accept all shown pending changes` and `Discard all shown pending changes`; both are disabled when the selected source has no rows. If accepting a shown row would also settle or invalidate a hidden row, the app asks the user to switch to `All changes`.
- If the selected chat stops contributing after an accept, discard, expiry, or another live update, the selector returns to `All changes`.
- Items are sorted by path. Captions are `Modified`, `Added`, `Moved`, `Replaced`, or `Deleted`.
- Move-only rows without a binary replacement are plain `.FileEditorSidebarPending-item-move` rows. Their path links open the moved node without `view=diff_editor`.
- A move proposal, including a mixed content-and-move proposal, uses an expandable size preview when it replaces a file and either file has no editable Yjs state. The preview shows removed and added size lines when the sizes differ, or `Size unchanged` when they match. Its path link opens the moved node without `view=diff_editor`.
- Content edits, copies, and mixed moves use `<details class="FileEditorSidebarPending-item">`. Their path links use `view=diff_editor` unless the row uses the size-only preview.
- For pointer QA, scope the row by its path link and click the first button inside its `summary`. Do not click the middle of `.FileEditorSidebarPending-item-summary`; the nested path link or action buttons may receive that click.
- For keyboard QA, focus the row's native `summary` and press `Enter`, then `Space`, in separate observe-act-observe steps. Verify each key toggles the preview, the path link and `Accept` / `Discard` buttons keep their accessible names, and the browser logs stay clean.
- Editable Markdown delete rows use the same expandable preview and prefetch their committed content. Binary and folder delete rows are plain rows with no chevron because there is no text diff to show.
- Per-item actions, scoped to the row, are `Accept` and `Discard`. `Accept` applies a pure move directly; content rows save the accepted content; copy rows install the whole-file replacement (content, type, shape, and collaboration mode); mixed rows apply the move before saving content. The same `All changes` guard protects hidden dependent rows.
- `Discard` removes the proposal or restores the committed path/content as required by its kind. Assert the reactive `list_files_pending_updates` result through list membership rather than a fixed index.
- Bulk actions are `Accept all` and `Discard all`.

### Pending Source Selector QA

Use disposable files and a unique run id. Keep each browser action in its own observe-act-observe step and read the new page logs after every action.

1. Start with at least one threadless pending file, one file touched by chat A, one file touched by chat B, and one file touched by both chats. Reuse the same file from chat B after chat A so the stored pending doc gains both thread ids; do not expect separate per-chat diffs.
2. Open the Pending changes tab and assert that `All changes` shows every pending doc once. Open the source selector and record each option's count.
3. Select `Your edits`. Assert that only docs with an empty or unset `threadIds` field remain and that bulk actions are enabled only when this view has rows.
4. Select chat A, then chat B. Assert that the shared file appears in both views with identical path, caption, and preview. Also assert that each chat-only file appears only in its own view.
5. In a disposable source with at least two rows, accept or discard one per-row action. Assert that the count and list react without changing the selected source while that chat still contributes.
6. On disposable data, run a bulk action from one chat view. Confirm only its shown rows settle; rows that belong only to another chat or `Your edits` remain. A shared row settles for every source because it is one pending doc.
7. Create a cross-source move chain or swap, or a folder delete with a hidden descendant row. Try its source-scoped Accept and Accept all actions. Confirm both ask for `All changes` and no pending row settles.
8. Select a chat whose last row will settle. After that action, assert that the trigger falls back to `All changes`, not an empty missing-chat selection.
9. Refresh the page. Assert that the default source is `All changes`, thread titles resolve again without a visible error, and archived contributor chats remain in the list.
10. Keyboard: focus the combobox, press `Enter`, move with `ArrowDown`/`ArrowUp`, choose with `Enter`, reopen, and close with `Escape`. Check focus returns to the trigger and the selected option is announced by its label.
11. Narrow the editor sidebar and test browser zoom at 200%. The trigger label may truncate, but its count, chevron, bulk buttons, and row actions must remain reachable without horizontal page scrolling.
12. Run `state.appPlaywriterHarness.auditAccessibility({ selector: ".FileEditorSidebarPending", minTargetSize: 24 })`. Review its quick findings, then separately check focus order, semantic names, contrast, zoom fit, target size, and reduced-motion behavior.

The generic harness already has the needed primitives (`observe`, `latestLogs`, `auditAccessibility`, and normal Playwright locators). Keep this flow here unless a new helper is useful across unrelated routes.

## Helper Recipes

```js
async function writeInlineComment(page, text) {
	const form = page.getByRole("form", { name: "New document comment" });
	await form.locator('[contenteditable="true"][aria-label="Add comment to selection"]').fill(text);
	await form.getByRole("button", { name: "Submit comment" }).click();
}

async function replyInSidebarThread(page, threadRootText, replyText) {
	await page.locator("#app_file_editor_sidebar_tabs_comments").click();
	await page.locator(".FileEditorCommentsThread-summary").filter({ hasText: threadRootText }).first().click();
	const form = page.getByRole("form", { name: "Reply to comment" });
	await form.locator('[contenteditable="true"][aria-label="Reply to comment"]').fill(replyText);
	await form.getByRole("button", { name: "Reply to comment" }).click();
}
```

## Known Gotchas

- Do not use `{ force: true }`, `dispatchEvent`, or DOM `element.click()` to bypass editor/sidebar blockers.
- Synthetic clicks and keys still do not reach Monaco (`monaco-editor` 0.56.0, see `known-hazards.md`, Monaco section), but since 2026-08-10 the keyed editor handle drives it from page context: `window.__qa.monaco()` plus `trigger("keyboard", "type", …)` / `executeEdits`, read back with the sorted `.view-line` recipe or `getModel().getValue()`. `Sync And Undo QA` and `Content Size Cap QA` are rewritten above to use it and are runnable again. Rich-text (TipTap) typing still works normally. The pending-draft helper recipe in the Diff Editor section stays the route for creating a draft as server state.
- The rich-text comment button depends on a live selection. If it is missing, reselect text and snapshot the toolbar/bubble controls.
- Contenteditable TipTap editors may appear as textboxes in snapshots but still fail `getByRole("textbox")`; use the scoped `contenteditable` + `aria-label` selector above.
- Right-sidebar content changes with the selected tab. Scope locators to comments or agent contexts after switching tabs.
