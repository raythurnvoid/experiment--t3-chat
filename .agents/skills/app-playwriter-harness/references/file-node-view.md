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

## Diff Editor

- Diff editor root: `[aria-label="File diff editor"]`.
- Diff editor toolbar: `[aria-label="Diff editor actions"]`.
- Pending updates banner: `[data-testid="pending-edits-banner"]`.
- Review changes button: `[data-testid="review-changes-button"]`.
- Save staged changes: `getByRole("button", { name: "Save staged changes" })`.
- Accept all: `getByRole("button", { name: "Accept all pending changes in this file" })`.
- Accept all and save: `getByRole("button", { name: "Accept all pending changes and save" })`.
- Monaco exposes each editor input as a `div.native-edit-context`, so Playwright `fill()` does not work. Focus the second textbox, press `Control+A`, then use `keyboard.insertText(...)`. A normal locator `focus()` is more reliable than a pointer click when the tab is in the background.

```js
const modifiedEditor = state.page.locator('[aria-label="File diff editor"] [role="textbox"]').nth(1);
await modifiedEditor.focus();
await state.page.keyboard.press("Control+A");
await state.page.keyboard.insertText("Replacement text");
```

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
- The rich-text comment button depends on a live selection. If it is missing, reselect text and snapshot the toolbar/bubble controls.
- Contenteditable TipTap editors may appear as textboxes in snapshots but still fail `getByRole("textbox")`; use the scoped `contenteditable` + `aria-label` selector above.
- Right-sidebar content changes with the selected tab. Scope locators to comments or agent contexts after switching tabs.
