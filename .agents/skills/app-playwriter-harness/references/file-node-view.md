# File Node View Playwriter Notes

Use this for the selected-file editor surface under `/files?nodeId=<file-id>`. Keep `files.md` for route/sidebar basics; use this file for editor, comments, diff, and right-sidebar workflows.

## Route And Layout

- Editor route shape: `/w/:organizationName/:workspaceName/files?nodeId=<id>`.
- Editor mode query values: `view=rich_text_editor`, `view=plain_text_editor`, `view=diff_editor`.
- A `nonCollaborative` file (service uploads like Council `/meetings/<id>/transcript.md` and `summary.md`) is ALWAYS clamped to the plain (Monaco) editor: `files_resolve_effective_editor_view` (`packages/app/src/lib/files.ts`) forces `plain_text_editor` because the file has no Yjs document, even when `yjsRootKind` is `rich_text` and even with an explicit `view=rich_text_editor` in the URL. The switcher still renders `Rich` and `Diff` for such a node, and clicking them silently does nothing — the radio never checks. That is the clamp, not a click that failed to land; do not re-click or file it as a hung page. Verified 2026-08-30.
- Scroll owner: `.FileNodeView-editor-area`.
- Content panel: `.FileNodeView-content-panel`.
- Right sidebar panel: `.FileNodeView-editor-sidebar-panel`.
- Comments tab: `#app_file_editor_sidebar_tabs_comments`.
- Agent tab: `#app_file_editor_sidebar_tabs_agent`.
- Details tab: `#app_file_editor_sidebar_tabs_details` (since 2026-08-10). Rows are `.FileEditorSidebarDetails-row` with `-label` / `-value` slots. Sidebar tabs depend on the node: a plain-text node shows Details and no Comments (and Details is its default), a Markdown node shows Comments; a stored selection naming a hidden tab falls back without being overwritten.
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

- Toolbar: `[role="toolbar"][aria-label="Toolbar"]`.
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

- Since 2026-08-10 this is a primary editor surface, not just the Markdown source view: the 19 plain-text extensions (`.json`, `.yaml`, `.csv`, `.txt`, `.ts`, `.js`, `.css`, ...) open in it by default, with Monaco language tokenization derived from the extension. `.md` keeps the rich text editor and reaches this surface as the **Markdown** mode radio; on a plain-text node the same radio reads **Code** and there is no **Rich**.
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
vp env exec pnpm exec convex run files_nodes:mark_file_content_too_large '{…,"sequence":4,"targetSequence":4,"byteSize":987654}'
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

- Same content selectors as the collaborative rich editor: `.FileEditorRichText-editor-content` and `.FileEditorRichText-editor-content-root`, so the existing typing recipes work unchanged.
- Toolbar: `[role="group"][aria-label="Rich text editor actions"]` with class `.FileEditorRichTextNonCollabToolbarActions`, holding `Save` (with the `Checking` spinner while the dirty check debounces), the word/size badges, and `Open file snapshots`. No Sync.
- Reformat hint: `.FileEditorRichTextNonCollabToolbarActions-reformat-hint` reads "Saving from the rich editor will reformat this file's Markdown." It shows only while the loaded Markdown differs from what the editor would serialize, and it goes away after the first save.
- The bubble **Comment** button is disabled while unsaved edits exist. The disabled button carries `title` and `aria-label` `Add comment — save your changes first`. After a save it enables, and submitting a comment saves the file again at once (the mark must live in a committed version).
- A refused content read renders `.FileEditorRichText-refusal` (`role="alert"`) instead of the editor.
- A save that lost the race toasts "This file changed while you were saving. Copy your local changes before reloading, then try again."

Diff view (`FileEditorDiffNonCollab`, both shapes):

- Same root and toolbar labels as the collaborative diff editor: `[aria-label="File diff editor"]`, `[aria-label="Diff editor actions"]`. Tell them apart by class: the non-collaborative root is `.FileEditorDiffNonCollab` and its toolbar holds only `Save`, `Discard all` (`aria-label="Discard all changes in this file"`), the size badge, and the snapshots button — no Sync, no Accept all.
- The original pane is the committed text, the modified pane is the member's local edits. Monaco's per-hunk revert arrow in the margin restores the committed text for one hunk; there are no accept/discard widgets.
- Both panes register the usual keyed handles: `window.__qa.monaco().diffOriginal` / `.diffModified`.
- A refused content read renders `.FileEditorDiffNonCollab-refusal` (`role="alert"`).

Fixture recipe: see "Non-Collaborative File Fixture" in `files.md`.

## Agent Sidebar

- Switch with `#app_file_editor_sidebar_tabs_agent`.
- On the **Agent** tab, `.FileNodeView-editor-sidebar-panel` should stay sticky during `.FileNodeView-editor-area` scroll.
- Verify `.AiChatComposer` remains visible near the bottom of the viewport after scrolling.

## Pending Changes Sidebar

- Switch with `#app_file_editor_sidebar_tabs_pending`.
- Panel region: `getByRole("region", { name: "Pending changes" })` (class `.FileEditorSidebarPending`); empty state is `.FileEditorSidebarPending-empty` ("No pending changes"). Since 2026-08-12 the empty state carries the `.FileEditorSidebarPending` root class too, so that class alone does not tell the two states apart — only the populated branch has `role="region"`.
- The panel is pinned to the viewport like the Agent tab: `.FileNodeView-editor-sidebar-panel` turns sticky and `.FileEditorSidebarPending` is `calc(100dvh - 92px)` tall at `top: 92`, with its own scroller. So on a long page (a folder after `Show more`) the panel height must stay near the viewport height, not the document height — a measured 4000+ px panel means the pinning rule stopped matching. The Comments tab is deliberately NOT pinned; it stays on the shared editor scroll surface for anchored comments.
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
- Synthetic clicks and keys still do not reach Monaco (`monaco-editor` 0.56.0, see `known-hazards.md`, Monaco section), but since 2026-08-10 the keyed editor handle drives it from page context: `window.__qa.monaco()` plus `trigger("keyboard", "type", …)` / `executeEdits`, read back with the sorted `.view-line` recipe or `getModel().getValue()`. `Sync And Undo QA` and `Content Size Cap QA` are rewritten above to use it and are runnable again. Rich-text (TipTap) typing still works normally. The pending-draft helper recipe in the Diff Editor section stays the route for creating a draft as server state.
- The rich-text comment button depends on a live selection. If it is missing, reselect text and snapshot the toolbar/bubble controls.
- Contenteditable TipTap editors may appear as textboxes in snapshots but still fail `getByRole("textbox")`; use the scoped `contenteditable` + `aria-label` selector above.
- Right-sidebar content changes with the selected tab. Scope locators to comments or agent contexts after switching tabs.
