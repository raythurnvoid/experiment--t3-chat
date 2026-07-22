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

## Agent Sidebar

- Switch with `#app_file_editor_sidebar_tabs_agent`.
- On the **Agent** tab, `.FileNodeView-editor-sidebar-panel` should stay sticky during `.FileNodeView-editor-area` scroll.
- Verify `.AiChatComposer` remains visible near the bottom of the viewport after scrolling.

## Pending Changes Sidebar

- Switch with `#app_file_editor_sidebar_tabs_pending`.
- Panel region: `getByRole("region", { name: "Pending changes" })` (class `.FileEditorSidebarPending`); empty state is `.FileEditorSidebarPending-empty` ("No pending changes").
- Items are sorted by path. Captions are `Modified`, `Added`, `Moved`, `Replaced`, or `Replaces <name>`.
- Move-only rows without a binary replacement are plain `.FileEditorSidebarPending-item-move` rows. Their path links open the moved node without `view=diff_editor`.
- A move-only replacement involving a binary file is expandable. Its preview shows removed and added size lines when the sizes differ, or `Size unchanged` when they match. Its path link also opens the moved node without `view=diff_editor`.
- Content edits, copies, and mixed moves use `<details class="FileEditorSidebarPending-item">`. Click `.FileEditorSidebarPending-item-summary` to expand the `DiffMonospaceBlock` preview. Their path links use `view=diff_editor`.
- Editable Markdown delete rows use the same expandable preview and prefetch their committed content. Binary and folder delete rows are plain rows with no chevron because there is no text diff to show.
- Per-item actions, scoped to the row, are `Accept` and `Discard`. `Accept` applies a pure move directly; content and copy rows save the accepted content; mixed rows apply the move before saving content.
- `Discard` removes the proposal or restores the committed path/content as required by its kind. Assert the reactive `list_files_pending_updates` result through list membership rather than a fixed index.
- Bulk actions are `Accept all` and `Discard all`.

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
