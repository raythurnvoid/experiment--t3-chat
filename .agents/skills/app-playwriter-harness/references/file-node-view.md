# File Node View Playwriter Notes

Use this for the selected-file editor surface under `/files?nodeId=<file-id>`. Keep `files.md` for route/sidebar basics; use this file for editor, comments, diff, and right-sidebar workflows.

## Route And Layout

- Editor route shape: `/w/:organizationName/:workspaceName/files?nodeId=<id>`.
- Editor mode query values: `view=rich_text_editor`, `view=plain_text_editor`, `view=diff_editor`.
- Scroll owner: `.FileNodeView-editor-area`.
- Content panel: `.FileNodeView-content-panel`.
- Right sidebar panel: `.FileNodeView-editor-sidebar-panel`.
- Comments tab: `#app_file_editor_sidebar_tabs_comments`.
- Agent tab: `#app_file_editor_sidebar_tabs_agent`.

## Rich Text Editor

- Toolbar: `[role="toolbar"][aria-label="Toolbar"]`.
- Content root: `.FileEditorRichText-editor-content-root`.
- Editable content: `.FileEditorRichText-editor-content`.
- Run the destructive typing example below only in a disposable QA file. If the file already has suitable text, select that text instead of replacing the document.
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

- Switch to the **Markdown** editor mode from the header mode radios.
- Prefer snapshots after switching modes; the plain editor may expose Monaco-style editor DOM instead of a normal textarea.
- If a locator times out, first inspect the editor mode radio state and snapshot the content panel before trying editor-specific selectors.
- Toolbar: `[aria-label="Markdown editor actions"]`, holding `Save`, `Sync`, the size badge, and `Open file snapshots`.
- The plain text editor does not live-collaborate. Edits stay local until `Save`, and `Sync` is disabled while `workingYjsDocSequence === serverSequence` — that is, until somebody else moves the server forward.

### Sync And Undo QA

Use this after changing how the Markdown editor writes content into its Monaco model. It proves that a sync keeps the user's undo history instead of resetting it.

1. Create a disposable file and open it with `view=plain_text_editor`.
2. Make several local edits, each its own undo step. A pure cursor move ends the current Monaco undo group, so type a chunk and then press a navigation key:

```js
await page.locator(".FileEditorPlainText .view-lines").click();
await page.keyboard.press("Control+End");
for (const chunk of ["\nlocal-one", "\nlocal-two", "\nlocal-three"]) {
	await page.keyboard.type(chunk);
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("End");
}
```

3. Assert `Save` is enabled and `Sync` is still disabled.
4. Move the server forward from a second tab on the same `nodeId` with `view=rich_text_editor`, which does sync live. Type anything there. `Control+End` does not reach the document end in TipTap, so expect the text wherever the caret happened to be — the point is only that the sequence advances.
5. Back in the Markdown tab, `Sync` is now enabled. Click it and confirm the content merges: the remote change and every local edit are present together.
6. Click `.view-lines`, then press `Control+Z` several times **in the same execute call**, capturing the text after each press. The first undo must revert the sync alone and leave all local edits in place; each later undo must remove one local edit. If the first undo jumps straight to the server content and the second does nothing, the editor is replacing its model instead of editing it.
7. Check `getLatestLogs` is clean, then close both QA tabs.

## Diff Editor

- Diff editor root: `[aria-label="File diff editor"]`.
- Diff editor toolbar: `[aria-label="Diff editor actions"]`.
- Pending updates banner: `[data-testid="pending-edits-banner"]`.
- Review changes button: `[data-testid="review-changes-button"]`.
- Save staged changes: `getByRole("button", { name: "Save staged changes" })`.
- Accept all: `getByRole("button", { name: "Accept all pending changes in this file" })`.
- Accept all and save: `getByRole("button", { name: "Accept all pending changes and save" })`.
- Synthetic input cannot drive Monaco at all since `monaco-editor` 0.56.0 — clicks do not focus it, and `keyboard.type` / `keyboard.insertText` / paste never reach the model (see the Monaco section in `known-hazards.md`). To put content in the modified (unstaged) pane, write the draft through the same public action the editor's debounced sync calls, from page context as the user who owns the draft:

```js
const m = await import("/src/lib/app-convex-client.ts");
const membership = await m.app_convex.query(m.app_convex_api.organizations.get_membership_by_organization_workspace_name, {
	organizationName,
	workspaceName,
});
await m.app_convex.action(m.app_convex_api.files_pending_updates.upsert_file_pending_update, {
	membershipId: membership._id,
	nodeId,
	unstagedMarkdown, // the full proposed content; staged stays at the committed base when stagedMarkdown is omitted
});
```

  A fresh diff mount then shows the draft in the modified pane with hunk widgets, and the pending sidebar gets a `Modified` row. A draft equal to the committed content self-cancels and creates no row. Read pane text back with the sorted `.view-line` readback from `known-hazards.md`.

### Content Size Cap QA

**Disabled — not currently runnable.** The flow needs over-cap content inside the local Monaco pane, and no supported path creates that state: synthetic clicks and paste never reach Monaco since `monaco-editor` 0.56.0 (see `known-hazards.md`, Monaco section), and the `upsert_file_pending_update` action recipe cannot stand in because the diff editor never sends an over-cap draft and the backend rejects one anyway. The old click-and-paste steps silently did nothing, so they were removed instead of left looking runnable.

What the flow verified, kept for when Monaco input works again: with over-cap text in the unstaged pane, `.FileEditorDiffToolbarActions-size-badge` reads `Over limit`, the `role="status"` live region reads `File is over the size limit. Remove content to save.`, the blocked draft sync stays silent, each of `Save staged changes` / `Accept all pending changes in this file` / `Accept all pending changes and save` toasts `This file would be … over the … limit …` without changing `.editor.original`, and a reload returns both panes to the committed content. The durable server-side over-cap state has its own runnable flow below (`Content Too Large Banner QA`).

### Content Too Large Banner QA

Checks the durable server state: when materialization rebuilds Markdown over the cap it stops committing and sets `files_nodes.contentTooLargeByteSize`. The banner lives in the shared top floating surface (`.FileNodeViewTopFloating-content-too-large-message`, inside the existing `role="status" aria-live="polite"` surface).

The editors block over-cap content before it is pushed, so the UI cannot produce this state. Drive it from the CLI instead, in `packages/app`:

1. Open any Markdown file and read its `data-file-id` from the sidebar row. Look up its org and workspace ids with `pnpm exec convex data files_nodes --limit 1000 --order asc`, filtered on that id (there is no per-id filter, so pipe through `Select-String`).
2. Read the current sequence with `pnpm exec convex run files_nodes:get_file_content_materialization_state '{"organizationId":…,"workspaceId":…,"nodeId":…}'`. `mark_file_content_too_large` only applies when `sequence` equals both `yjsLastSequenceDoc.lastSequence` and `targetSequence`, so pass that one number for both.
3. Prove the banner arrives reactively, without a reload: start a runner that waits on the selector, then run the mutation while it waits.

```powershell
Start-Job -ScriptBlock { vp env exec pnpx playwriter -s 13 -f <wait-runner> --timeout 30000 } -Name banner | Out-Null
Start-Sleep -Seconds 3
pnpm exec convex run files_nodes:mark_file_content_too_large '{…,"sequence":4,"targetSequence":4,"byteSize":987654}'
Receive-Job -Name banner -Wait
```

The wait runner reads the message before and after `waitForSelector`, and logs `performance.now()` so the report can show the DOM changed mid-session rather than on a load.

4. Assert the message names the size, the limit and how much to remove, that it is ellipsized with the full text in `title`, and that the icon uses the red token. Do not screenshot it: the floating surface never settles for Playwright's stability check and both page and element screenshots time out.
5. Clear it the real way: type a few characters in the editor, then wait for `waitForSelector(…, { state: "detached" })`. Materialization runs through the workpool, so allow up to ~90s; it cleared in ~14s in practice. Remove the typed characters afterwards if the file is not disposable.

## Agent Sidebar

- Switch with `#app_file_editor_sidebar_tabs_agent`.
- On the **Agent** tab, `.FileNodeView-editor-sidebar-panel` should stay sticky during `.FileNodeView-editor-area` scroll.
- Verify `.AiChatComposer` remains visible near the bottom of the viewport after scrolling.

## Pending Changes Sidebar

- Switch with `#app_file_editor_sidebar_tabs_pending`.
- Panel region: `getByRole("region", { name: "Pending changes" })` (class `.FileEditorSidebarPending`); empty state is `.FileEditorSidebarPending-empty` ("No pending changes").
- Source selector: `getByRole("combobox", { name: /^Pending changes source:/ })`. It contains `All changes`, `You`, and one option per contributing persisted agent chat, newest activity first. `You` is the threadless group and stays visible at count 0. Archived chats remain available and say `Archived` in their option detail.
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
- Per-item actions, scoped to the row, are `Accept` and `Discard`. `Accept` applies a pure move directly; content and copy rows save the accepted content; mixed rows apply the move before saving content. The same `All changes` guard protects hidden dependent rows.
- `Discard` removes the proposal or restores the committed path/content as required by its kind. Assert the reactive `list_files_pending_updates` result through list membership rather than a fixed index.
- Bulk actions are `Accept all` and `Discard all`.

### Pending Source Selector QA

Use disposable files and a unique run id. Keep each browser action in its own observe-act-observe step and read the new page logs after every action.

1. Start with at least one threadless pending file, one file touched by chat A, one file touched by chat B, and one file touched by both chats. Reuse the same file from chat B after chat A so the stored pending doc gains both thread ids; do not expect separate per-chat diffs.
2. Open the Pending changes tab and assert that `All changes` shows every pending doc once. Open the source selector and record each option's count.
3. Select `You`. Assert that only docs with an empty or unset `threadIds` field remain and that bulk actions are enabled only when this view has rows.
4. Select chat A, then chat B. Assert that the shared file appears in both views with identical path, caption, and preview. Also assert that each chat-only file appears only in its own view.
5. In a disposable source with at least two rows, accept or discard one per-row action. Assert that the count and list react without changing the selected source while that chat still contributes.
6. On disposable data, run a bulk action from one chat view. Confirm only its shown rows settle; rows that belong only to another chat or `You` remain. A shared row settles for every source because it is one pending doc.
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
- The keyboard-driven Monaco steps in `Sync And Undo QA` predate `monaco-editor` 0.56.0 and no longer run: synthetic clicks and keys do not reach Monaco (see `known-hazards.md`, Monaco section). Rich-text (TipTap) typing still works. Until that flow is rewritten, drive Monaco content through the Convex actions recipe in the Diff Editor section and use the sorted `.view-line` readback. That recipe cannot stand in for `Content Size Cap QA` — over-cap drafts are rejected server-side — so that flow is disabled in place above.
- The rich-text comment button depends on a live selection. If it is missing, reselect text and snapshot the toolbar/bubble controls.
- Contenteditable TipTap editors may appear as textboxes in snapshots but still fail `getByRole("textbox")`; use the scoped `contenteditable` + `aria-label` selector above.
- Right-sidebar content changes with the selected tab. Scope locators to comments or agent contexts after switching tabs.
