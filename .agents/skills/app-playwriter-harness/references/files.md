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
- A GitHub Pages `/files` CORS error is the R2 bucket, not Pages or Convex. The editor `fetch()`es a signed snapshot URL on `*.r2.cloudflarestorage.com`. Convex `ALLOWED_ORIGINS` can already include `https://raythurnvoid.github.io` while the bucket still allows only localhost. Apply `packages/r2-upload-finalizer/r2-files-cors.json` with `wrangler r2 bucket cors set`, then prove the file body loaded and a page-context `fetch` of the Resource Timing R2 URL returns `{ ok: true, type: "cors" }`. Do not redeploy Pages for this.

## Stable Selectors

### Layout And Scroll

- Files route scroll owner: `.FileNodeView-editor-area`.
- Content panel: `.FileNodeView-content-panel`.
- Sidebar panel: `.FileNodeView-editor-sidebar-panel`.
- Comments tab: `#app_file_editor_sidebar_tabs_comments`.
- Agent tab: `#app_file_editor_sidebar_tabs_agent`.
- Pending tab: `#app_file_editor_sidebar_tabs_pending`.
- There is no Metadata tab. The key-value map moved into the Properties modal; see "File Properties Modal" below.

### File Node View

- Detailed editor-surface notes: [file-node-view.md](file-node-view.md).
- Rich text editable content: `.FileEditorRichText-editor-content`. **Use that exact class, never bare
  `.ProseMirror` and never `main`.** The route mounts two ProseMirror editors — the file, and the AI
  chat composer (`.AiChatComposer-editor-content`) — so `querySelector(".ProseMirror")` can answer
  with the composer, and `main.innerText` returns the file text glued to the whole agent panel
  transcript. Either way a `text.includes(marker)` check reads as a pass on content the file does
  not hold. Verified 2026-09-01 while proving a Chitchat transcript write.
- Comments region: `getByRole("complementary", { name: "Document comments" })`.
- Diff editor root: `[aria-label="File diff editor"]`.
- Review changes button: `[data-testid="review-changes-button"]`.
- Tables in the rich editor: plain `table`, `th`, `td` selectors inside `.FileEditorRichText-editor-content`.
- Table commands menu: toolbar `getByRole("button", { name: "Table commands" })`; items are `Add row above`, `Add row below`, `Add column left`, `Add column right`, `Delete row`, `Delete column`, `Toggle header row`, `Delete table` (disabled while the caret is outside a table).
- Properties button in the breadcrumb: `getByRole("button", { name: /^Properties of / })`. It still carries `data-file-read-only` with the node's lock state. Its `.click()` can hang on "visible, enabled and stable" while `hitTest` shows the button itself on top and nothing covers it (hit 2026-08-21). Read its box in page context and click the middle with `page.mouse.click(x, y)`.

### Sidebar And Folder Browser

- Sidebar tree rows: `.FilesSidebarTreeItem[data-file-id]`.
- Sidebar selected rows: `.FilesSidebarTreeItem[data-file-id][aria-selected="true"]`. The attribute sits on the row wrapper itself; `FilesSidebarTreeItemPrimaryAction` never carries it (the row strips it before passing props down).
- Sidebar row primary action: `.FilesSidebarTreeItemPrimaryAction`.
- Sidebar row more action: `.FilesSidebarTreeItemMoreAction`.
- Locked row accessible name: `getByRole("treeitem", { name: "<name>, read-only" })` when the lock is on that node, `"<name>, read-only from /path"` when it is inherited, or `"<name>, contains read-only items"` when the folder itself is writable but a child is locked. `/meetings` after a Council meeting upload is that last shape. Expand it with `getByRole("button", { name: "Expand folder <name>, contains read-only items" })`. The visible title is an input, so `.FilesSidebarTreeItemTitle` with `hasText: /^name$/` does not match (verified 2026-08-26).
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

Plain-text document QA fixtures (plain-text-docs §11.5). Upload them in the throwaway non-default org, not the user's workspace. Bytes are pinned — regenerate only with the recorded generator, never by hand:

| Fixture | Purpose | Bytes | Lines | SHA-256 |
| --- | --- | --- | --- | --- |
| `qa-plain.json` | Pretty JSON becomes an editable plain-text document; token `BONOBO_QA_PLAIN_JSON_2026`. | 106 | 6 | `983e9aed87de77edbe28410e7351ac063799d69da26bbb1d83022ccc9da8ac89` |
| `qa-plain.yaml` | Starts with `---` to prove plain-text YAML never enters frontmatter parsing; token `BONOBO_QA_PLAIN_YAML_2026`. | 88 | 7 | `197253fd06f6c2c9e26f30577acff0252c07d9edb3396ed12a55fa973b48909b` |
| `qa-plain.csv` | CSV upload conversion; token `BONOBO_QA_PLAIN_CSV_2026`. | 65 | 3 | `37493e05d743d87b8a3a3a8c079f54849935423a3b7499da488f19a8f13a9791` |
| `qa-plain.txt` | Plain `.txt` upload conversion; token `BONOBO_QA_PLAIN_TXT_2026`. | 118 | 3 | `1f437490ce737b637202e432afb01f544ac6361b4d3a3c9fc21727b9fc2d2961` |
| `qa-plain-bom.csv` | UTF-8 BOM + CRLF bytes; the stored document must be LF text without the BOM; token `BONOBO_QA_PLAIN_BOM_CSV_2026`. | 54 | 2 | `d002e97a17daf90711b1aca0f9d092afd84e60c5772c8b590d4e148fc9956042` |
| `qa-plain-minified.json` | One line, no trailing newline; token `BONOBO_QA_PLAIN_MINIFIED_JSON_2026`. | 85 | 1 | `dbb7640688394098fbce3383fffe56de03ecb71b83f190a03507275262829fd7` |
| `qa-plain-invalid-utf8.txt` | Carries one lone `0xFF` byte, so the upload conversion's fatal UTF-8 decode fails: the node keeps the stored blob (no editable conversion), and the fallback settle still dispatches the plugin upload event. | 15 | 1 | `cb1715d56c0e816cbca6f4299a0a3edadc3fc9bf96e337fe49f0f4092d515dca` |
| `qa-frontmatter-overcap.md` | Markdown with 129 frontmatter keys — one over `files_metadata_MAX_FRONTMATTER_FIELDS` (128); token `BONOBO_QA_FRONTMATTER_OVERCAP_2026`. | 2418 | 135 | `8cb33857771b68cee0dfce80ca73a28214ed3af89f134a0f24db429c28d4d599` |
| `qa-frontmatter-values-overcap.md` | Markdown with one `tags` array of 600 unique values — over `files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS` (512); token `BONOBO_QA_FRONTMATTER_VALUES_OVERCAP_2026`. | 7295 | 607 | `c3cd45983e3432693a91a9b9270f1a70e8add08c2e6a39948436db3ad3c855aa` |

Generator (records the exact bytes): `../t3-chat-+personal/+ai/plain-text-docs-2026-08-09/generate-qa-fixtures.mjs`.

`qa-plain-invalid-utf8.txt` is not in that generator. Regenerate it with this one-liner from the repo root (a Buffer write, because a text editor would replace the invalid byte):

```powershell
vp env exec node -e "require('node:fs').writeFileSync('.agents/skills/app-playwriter-harness/assets/files/qa-plain-invalid-utf8.txt', Buffer.from([0x69,0x6e,0x76,0x61,0x6c,0x69,0x64,0x20,0xff,0x20,0x62,0x79,0x74,0x65,0x0a]))"
```

Do not commit an over-cap text fixture. When a flow needs one, generate it into the personal scratch folder and delete it after the run:

```powershell
vp env exec node -e "require('node:fs').writeFileSync('../t3-chat-+personal/+ai/<task-folder>/qa-plain-overcap.txt', 'over-cap filler BONOBO_QA_OVERCAP_2026\n'.repeat(140000))"
```

That is ~5.4 MB. Any text upload over `files_MAX_TEXT_CONTENT_BYTES` (900,000 bytes) keeps the stored blob: the conversion checks the declared asset size before its GET, so it settles without fetching the bucket bytes at all.

The two frontmatter fixtures prove conversion, not refusal: an over-cap frontmatter `.md` still converts to an editable rich-text document — it commits WITHOUT the metadata index and with the `contentFrontmatterTooLarge*` marker pair set. `qa-frontmatter-overcap.md` trips the 128-field cap; `qa-frontmatter-values-overcap.md` trips the 512 index-document cap through one 600-value array. Uploading either requires the upload frontmatter preflight in `convex/r2.ts` (landed 2026-08-10) to be deployed. Without it the conversion throws in the infinite-retry workpool: the upload never publishes and every retry re-uploads both R2 objects. Check the deployment before uploading them.

### Upload Conversion Proof By Bytes

To prove an upload converted byte-exactly, hash the served content instead of reading editor panes (verified 2026-08-10 on `qa-plain.yaml`: hash match, leading `---` intact — which proves conversion, not frontmatter stripping):

```js
// Call 1 (page context): sign the download as the user, park the URL on state.
state.dl = await state.page.evaluate(async (nodeId) => {
	const m = await import("/src/lib/app-convex-client.ts");
	const membership = await m.app_convex.query(m.app_convex_api.organizations.get_membership_by_organization_workspace_name, {
		organizationName: "personal",
		workspaceName: "home",
	});
	const r = await m.app_convex.action(m.app_convex_api.r2.create_signed_download_url, {
		membershipId: membership._id,
		fileNodeId: nodeId,
	});
	return r._yay ? r._yay.url : { err: r._nay.message };
}, state.nodeId);

// Call 2 (sandbox, so a page reload cannot kill it): fetch and hash.
const buf = Buffer.from(await (await fetch(state.dl)).arrayBuffer());
console.log(require("node:crypto").createHash("sha256").update(buf).digest("hex"));
```

Compare against the table's pinned SHA-256. Two caveats: the comparison holds only for fixtures already stored as LF without a BOM — `qa-plain-bom.csv` deliberately does not round-trip, because the stored document drops the BOM and stores LF. And since 2026-08-10 the signed GET serves editable text as an `attachment` with the name-derived type, so assert on bytes, never on the disposition or the URL string.

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

### Insert A Table

In an editable collaborative `.md` file, type `/table` in an empty paragraph and pick the
`Table` item in the slash popover (`.FileEditorRichTextToolsSlashCommand-item`). A 3x3 table
with a header row appears and the caret lands in the first cell. Tab moves to the next cell;
Tab in the last cell adds a row. Switching the same file to the Markdown (Code) view must show
a GFM pipe table (`| ... |` rows with a `| --- |` delimiter row).

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

### Sidebar Create Then Rename By Id

The sidebar `New file` button creates immediately at root with a generated `new-file*.md` name and no rename mode, so never locate the new row by a guessed name — harvest its id by diffing the `data-file-id` sets (verified 2026-08-10):

```js
// Call 1: snapshot ids, click New file.
state.beforeIds = await state.page.evaluate(() => Array.from(document.querySelectorAll("[role=treeitem][data-file-id]")).map((t) => t.getAttribute("data-file-id")));
await state.page.locator('.FilesSidebarTopSection-actions-icon-button[aria-label="New file"]').click();

// Call 2 (poll): the fresh id is the one not in the snapshot.
const created = await state.page.evaluate((prev) => {
	const fresh = Array.from(document.querySelectorAll("[role=treeitem][data-file-id]")).find((t) => !prev.includes(t.getAttribute("data-file-id")));
	return fresh ? { id: fresh.getAttribute("data-file-id"), label: fresh.getAttribute("aria-label") } : null;
}, state.beforeIds);
```

Then rename by id: click `[role="treeitem"][data-file-id="<id>"] .FilesSidebarTreeItemPrimaryAction`, press `F2`, wait until `document.activeElement`'s `aria-label` starts with `Rename`, `fill` the focused input (`state.page.locator(":focus")`), press `Enter`.

Do not press `F2` while the new file's editor is still mounting. The create-then-rename race crashed `FileEditorInner` (`NotFoundError: removeChild`, caught by the route error boundary) twice in ~12 editor mount transitions on 2026-08-10 — a filed app follow-up, not a harness bug. Wait for the editor surface first (`.FileEditorRichText-editor-content` or `.monaco-editor`); if the boundary appears, `Try again` recovers.

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

### Restricted Folder Archive / Restore

Use this after changing `files_nodes.unarchive_nodes`, `authorize_leaving_restricted_scope`, or anything about restricted scopes.

- Build the fixture so the two cases differ: the folder must carry its **own** restriction (`restrictedScopeNodeId === its own _id`, which the restore loop deliberately skips) and the child must **inherit** it (`restrictedScopeNodeId === the folder's _id`). Only the inheriting child exercises the leaving check. Read both from `list_tree` — the sidebar shows neither.
- Restrict through the row menu `Share` → `Restrict access` (toast `Access restricted`), then `Done`.
- To make a restore behave as a **move**, archive the parent folder and then restore the child alone: its parent is still archived, so the restore relocates it to root. That is the only in-app route to the leaving check. Ground truth is the child's `path`, `parentId` and `restrictedScopeNodeId` in `list_tree`; a successful owner restore moves it to root and clears the scope pointer.
- Reveal archived rows with the sidebar `More options` → `Show N items archived` (`menuitemcheckbox`). It does **not** close the menu on click, so press `Escape` after, and it is **not persisted** — any route load resets it to off, so re-read `aria-checked` instead of assuming your earlier toggle survived.
- Restoring a folder that carries its own restriction must bring it back still restricted (`restrictedScopeNodeId` unchanged, row label keeps ` restricted`).
- The owner bypasses every permission check, so owner-only runs prove **no over-refusal**, never that the refusal works. The refusal needs a second member holding a `content.write` grant on the folder. Get that member without any sign-in by following `references/second-user-fixtures.md`: an anonymous user in a scratch browser, invited by `userIdToAdd` into a throwaway non-default org. Verified end to end — a `member` with only `write` archives the folder fine, is refused on restoring the child alone with `You need Can manage on the shared folder to move this out of it.`, and still restores the scope-carrying folder itself.
- A `write`-only member **can** archive the restricted folder. The hole this guards is the pair: archive the folder, then restore one file out of it. With the leaving check removed, that same click succeeds and clears the child's `restrictedScopeNodeId` to `null` at root — the file becomes readable by the whole workspace. Count that pointer, not the toast, when proving the guard.

### Read-Only File And Folder Locks

Use a throwaway non-default organization and follow `second-user-fixtures.md` for a normal member who
does not hold `content.permissions.manage`. Keep owner and member sessions open together so live races
do not depend on signing in or out.

- Fixture: one directly locked file, one locked folder with rich/plain/nested descendants, one free
  folder, and one unlocked outer folder with a locked child plus writable sibling. Create one pending
  content proposal before locking.
- Drive the lock through the Properties modal's `Protection` checkbox (`.FilesPropertiesModalReadOnly-checkbox`);
  under an inherited lock it also offers `Manage /<path>` and `Also lock here`. There are no
  `Make read-only` / `Make writable` / `Add direct lock` / `Remove direct lock` controls. The member must not get management controls. Query `list_tree` as each identity
  and assert projected `readOnlyState` and source visibility; never inspect the raw pointer from
  a public result.
- Assert the exact accessible row descriptions for a direct lock, a visible inherited lock, a hidden
  inherited lock, and an unlocked folder that contains read-only items. Locked rows must still open,
  expand, search, and expose safe Copy and Share actions.
- Try F2/menu rename, source drag, folder drops, archive/restore, mixed-selection archive, New file,
  New folder, `Create a README.md`, Upload, and Import folder. Check the tree and pending rows after each
  refusal; a toast alone does not prove zero writes. Copy a locked source out and confirm the new copy
  is writable.
- Start rename, create/upload UI, drag, and a dirty editor in the member session. Lock from the owner
  session. Assert each UI cancels or disables live, keeps useful draft text copyable, announces why,
  and returns or moves focus as documented in the plan.
- For a signed-upload race, mint the target first, lock the parent, then finish the PUT. The existing
  node must publish normally, become downloadable, and keep its inherited lock. Read back the live
  `r2Key`, cleared `unfinalizedExpiresAt`, normal processing completion, and the expected upload plugin
  run. Reuse the signed staging URL and prove the immutable live bytes do not change.
- Run `auditAccessibility({ selector: "body", minTargetSize: 24 })`, then separately audit the lock
  modal and Pending panel. Also check keyboard focus, Escape/focus return, 200% zoom, 360 px width,
  contrast, target sizes, and reduced motion.

### Non-Collaborative File Fixture

Use this when a check needs a file with collaboration turned off (a Council-note-shaped file). Build your own; never edit or delete the read-only Council meeting notes under `/meetings/`, they are shared QA fixtures.

For a **read-only** check you do not need to build anything: list the ones the dev deployment already
has. Use `--format jsonLines` and filter on the field. The default table format hides it: `nonCollaborative`
is optional, so it becomes a column only when the fetched page happens to contain a row that sets it,
and the column order then shifts under any awk field numbers you wrote earlier.

```powershell
vp env exec pnpm --dir packages/app exec convex data files_nodes --limit 1000 --format jsonLines
```

Keep the rows where `"nonCollaborative": true`, then open one straight from its id with
`/w/<org>/<workspace>/files?nodeId=<_id>`. On 2026-09-04 that returned two rows, both Chitchat
transcripts (`/chitchat/general.md` and `/chitchat/park.md`), `rootKind: "rich_text"` and read-only,
which is enough to check how the non-collaborative rich editor renders but not to type in it.

To build a writable one, follow the UI steps below.

1. Create a `.md` file from the sidebar. A new file is collaborative.
2. Open it, switch to the **Markdown** view, and give it a body that carries a real Markdown escape, for example a line holding `2026\-08\-30`. Save.
3. Open the breadcrumb Properties dialog (see "File Properties Modal" below for its two click hazards) and uncheck `Collaboration` by clicking its label, `.FilesPropertiesModalCollaboration-checkbox`. Focusing the 1px input and pressing Space does NOT toggle it (tried 2026-08-31: the input stayed `checked`), so use the label. The confirmation is not a separate dialog — it appears INSIDE the properties modal as a `Turn collaboration off` / `Cancel` pair, so do not wait for a new `[role=dialog]` to show up.
4. For a read-only variant, tick `Protection` in the same dialog by clicking its label, `.FilesPropertiesModalReadOnly-checkbox`.
5. Reopen the dialog and read both states back before you start the checks.

The rich view must then render the content un-escaped (`2026-08-30`) while the Markdown view shows the raw bytes. Selectors and behaviors of the non-collaborative rich and diff editors are in `file-node-view.md` under "Non-Collaborative Editors (No Yjs)".

### Folder Import

Use this after changing the bulk import flow (`run_folder_import` in `files-sidebar.tsx`, `files_nodes.create_upload_nodes`).

- The two upload entry points call **different** mutations: `Import folder` → `files_nodes.create_upload_nodes` (plural), single `Upload file` → `files_nodes.create_upload_node` (singular). Check which one your change touches before designing the browser check.
- `create_upload_node`'s intermediate-path walk is **not reachable from the sidebar**: `uploadBrowserFile` normalizes the name first (`files_normalize_upload_file_name` keeps only the leaf segment, `files_normalize_markdown_name` turns separators into `-`), so the filename always arrives without slashes and the walk loop never runs. It is a public mutation, so drive it directly through `app_convex.mutation(...)` with a real multi-segment `filename` when you need to exercise that walk.
- To prove an "answer before anything is written" fix, count the asset docs rather than reading the message — a pre-write and a post-write refusal can return the identical string. `convex data files_r2_assets --limit 400 --order desc --format jsonLines`, filtered to `"kind": "upload"`, is a read-only ground truth; the editor's own `content_snapshot`/`yjs_snapshot` rows churn constantly, so never use "newest row unchanged" without filtering by kind. An orphan asset left by a refused upload is reaped by the hourly `cleanup expired unfinalized assets` cron, so it needs no manual cleanup.

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
- In Agent mode, shell writes ARE supported. `cat > path <<'EOF' ... EOF`, `>`, `>>`, and app-to-app `cp` normally create reviewable pending content. If the existing target has collaboration turned off, those content writes save immediately and their output says there is nothing to review. App-to-app `mv` and `rm` stay pending structural proposals (`rm` archives on acceptance). Verified 2026-08-21; the older "writes are unsupported" note here was stale. Links are still not shell operations, and app-to-`/tmp` copy stays immediate thread scratch.

### Indexed Frontmatter Metadata Through The Agent

Use this to verify backend changes to `files_metadata` (extraction, `meta search`, `meta get`) from the running app without touching the user's own files. Verified 2026-08-03.

- Drive the checks by asking the agent to run exact Bash commands: prefix the prompt with "Run exactly these Bash commands, one per Bash call, in this order. Do not modify them. Show the raw stdout and stderr of each. Do not summarize." Without that, the agent rewrites commands or reports a summary instead of output.
- Read results from `[aria-label="Bash terminal output"]` via `textContent`, not the assistant's prose.
- Create the fixture with a heredoc write (`cat > qa-<topic>/a.md <<'EOF' ... EOF`) instead of editing real files. The write is a pending proposal, and pending metadata docs are indexed and overlaid for the acting user, so `meta search` and `meta get` already see them — no acceptance needed for a read-path check.
- Copy the real frontmatter shape you care about. Sybill meeting files quote their dates: `realStartTime: "2026-07-29T19:00:00.000Z"`.
- Clean up with the Pending changes tab: use `role=button[name="Discard changes to /<path>"]` for each file. Discarding an eager-created file also deletes the folders that same write created, but only while they are still empty, and only the first write into a new folder records them. Two fixture files in one folder therefore always leave the folder behind, so archive it through `More actions for <folder>` → `Archive`.
- Metadata changes live in `convex/`, which `pnpm dev` does NOT push (that script is Vite only). Run `vp env exec pnpm exec convex dev --once` from `packages/app` after each edit, and reload the route afterwards using the blanked-tab recipe in `agent-panel.md`.

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

### Content Search Palette

Selectors and a proven flow for the file-content search palette (verified 2026-08-09).

- The trigger is the header icon button `[aria-label="Search file contents (Ctrl+Shift+F)"]`. It is a `MyTooltipTrigger`, so `locator.click()` can burn the whole CLI timeout without landing — open it with `focus()` + `Enter`, or with the `Control+Shift+F` hotkey (works while the editor or another input has focus).
- The dialog is `.FilesSearchPalette` (`role=dialog`, label `Search file contents`), removed from the DOM when closed. Focus lands in the combobox input on open; the query resets on close. Escape closes it, but the leave animation takes ~500ms — a DOM-presence probe right after Escape reads it as still open.
- Rows are `.FilesSearchPalette-item` (`role=option`); slots: `-item-name`, `-item-path`, `-item-snippet`, `-item-count` (only when a file has 2+ matching chunks). The state line `.FilesSearchPalette-state` shows `Type to search file contents` under 2 chars, a spinner while loading, and `No matches`.
- Typing auto-highlights the first row (`[data-active-item]`); Enter or a row click navigates to `?nodeId=<id>` and closes. A row `click()` often times out on the post-click actionability check after it already landed — re-read the URL before retrying.
- Results come from the public `files_nodes.search_content` query (args: `membershipId`, `query`), which searches committed `files_plain_text_chunks` plus the caller's own pending chunks and drops files the member cannot read. Grants apply reactively: adding a `set_node_share_grant` while the palette is open pushes the newly readable file into the visible results with no user action.
- Fixture recipe: upload a small file with a unique token through the sidebar's hidden file input. Since 2026-08-10 any of the 20 editable text extensions works, not just `.md`: uploads of `.md`, `.json`, `.yaml`, `.csv`, `.txt`, `.ts`, `.js`, `.css`, ... convert to editable documents, get plain-text chunks, and become searchable (~8s in dev). The classifier derives the stored type from the file NAME and beats the client MIME — `.ts` is TypeScript text now, never `video/mp2t`. The pinned fixtures in the table above are ready-made search fixtures; each carries a unique token.

### Rich Text Image And Video Embeds

Selectors and a proven flow for the media embeds in the rich text editor (verified 2026-08-08).

- Every embed's node view root is `span.FileEditorRichTextMedia` inside `.FileEditorRichText-editor-content`. The media element is its `img` or `video` child; while there is nothing to show, a state class sits on the root (`FileEditorRichTextMedia-state-uploading|processing|failed|missing|broken`) and `.FileEditorRichTextMedia-placeholder` holds text like `Processing…: <alt>` or `File not available: <alt>`.
- The `Uploading…`/`Processing…` placeholders are collaborator-only since 2026-08-08: the tab that pasted keeps the file in memory and shows it immediately as a dimmed blob preview (`-local-preview` class, `img[src^="blob:"]`), then swaps to the signed url (`-has-media` class, `src^="http"`). Assert upload placeholders in a second tab, not in the uploader's own tab. A failed PUT in the uploader tab keeps the embed as `Upload failed` with `-retryable` on the root and a visible `.FileEditorRichTextMedia-retry` button that re-runs the upload; simulate the failure by aborting `PUT` requests whose url contains `X-Amz-` via `page.route`.
- A document embeds a workspace file as `![alt](bonobo-file://<fileNodeId>)` or `<video src="bonobo-file://<fileNodeId>"></video>`. The node view resolves that to a 15-minute signed R2 url, so assert on `img.naturalWidth > 0` / `video.readyState >= 1`, never on the url string.
- Build the whole fixture set without any editor typing: upload the media files with `setInputFiles` on the sidebar's hidden input (see known-hazards), read their node ids from the folder-explorer overlay links (`a[aria-label="Open <name>"]`, the `href` carries `nodeId`), write a `.md` referencing those ids, and upload it too — markdown uploads become normal editable documents server-side.
- To prove the reactive swap: `create_upload_node` from page context gives `{ nodeId, url, headers }`; reference the node in an uploaded doc (shows `Processing…`), then `fetch(url, { method: "PUT", headers, body })` with bytes whose length matches the declared `size`. The open document swaps the placeholder to the rendered image without a reload when the R2 event lands (~8s in dev).
- Novel's `ImageResizer` never attaches to these embeds (it expects the selected node's DOM to be the `img` itself, not a wrapper span). The embeds own their controls instead (since 2026-08-08): clicking one selects it (`ProseMirror-selectednode` on the span) and, while real media is showing, a corner `.FileEditorRichTextMedia-resize-handle` (pointer drag commits `width`, double-click resets to natural size) and a `.FileEditorRichTextMedia-controls` button row appear — `Align: left|center|right` (cycles on click), `Caption`, and on images `Alt`. The caption/alt buttons open `.FileEditorRichTextMedia-caption-input`/`-alt-input` (Enter commits, Escape cancels, blur commits); a committed caption renders in `.FileEditorRichTextMedia-caption` under the media and rides in the node's `title` attr. A sized/aligned/captioned image serializes to markdown as a raw `<img src alt title width align>` tag instead of `![...]`; the video form is `<video src title width align>`. Commits re-select the node, so the controls stay up after each one.
- Keyboard paths on a selected embed (since 2026-08-09): `Alt+ArrowLeft/Right` nudges width ±64px (clamped 80–4096, starts from the rendered size when no width is stored), `Alt+Shift+A` cycles alignment, `Alt+Enter` opens the alt editor (images), `Alt+Shift+Enter` opens the caption editor (images and videos). Drive them with `page.keyboard.press("Alt+ArrowLeft")` etc. after clicking the media.
- An abandoned upload placeholder no longer lingers forever (since 2026-08-09): a src-less `Uploading…` embed with no local registry entry (collaborator view, or the uploader's tab after a reload) flips to a non-retryable `Upload failed` after 2 minutes. Repro: abort the PUT via `page.route`, reload the tab, wait ~2min.
- The Markdown view shows the server-materialized markdown, which lags rich-text edits by up to ~30s. An attribute missing right after a commit is usually this lag, not a serialization bug — poll the Markdown view for the expected substring instead of reading it once, or read the live node attrs via `el.pmViewDesc.node.attrs` in the Rich view.
- Paste and drop uploads can be driven synthetically: build a real `DataTransfer`, `dt.items.add(new File([bytes], "name.png", { type: "image/png" }))`, then dispatch `new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })` (or `new DragEvent("drop", { dataTransfer: dt, ... })` with `clientX/clientY` over the editor) on `.FileEditorRichText-editor-content`. This is the exception to the no-`dispatchEvent` rule: it exercises the app's own `editorProps.handlePaste`/`handleDrop`, the same code a real gesture reaches. `dispatchEvent` returns synchronously after the handler ran, so counting `.FileEditorRichTextMedia-state-uploading` in the same `evaluate` proves the placeholder is inserted before any network I/O.
- Uploads land in an `assets` folder created next to the document (fall back to the document's folder); clipboard pastes are named `pasted-image-YYYYMMDD-HHMMSS.png`, dropped/picked files keep their name with ` 2`, ` 3`... suffixes on collision. Assert final names via `list_tree`, not the toast.
- The image node is **inline** (`isInline: true`), so a shape dump that maps only `doc.content.content` never lists it — a dropped image "disappears" into its paragraph. Find media nodes with `doc.descendants((n) => ...)` instead. A drop lands at the pointer (`posAtCoords`), not at the caret; prove placement by parking the caret with `Ctrl+Home` and dropping onto a specific paragraph, then resolving the found node's parent (verified 2026-08-09).
- The signed-url grant is per membership: `r2.create_signed_download_url` with the caller's own valid membership plus a file node from another workspace answers `_nay "Not found"`, and an invited member's browser renders the embed from the R2 origin with no extra step (verified 2026-08-09 with the `second-user-fixtures.md` flow).
- `list_tree` returns a plain array of node docs, not `{ nodes }` or a paginated `{ page }`. A node has `kind`, not `type` — filtering on `node.type === "file"` silently matches nothing. Use `kind`, `lowercaseExtension`, or `contentType` (verified 2026-08-14).
- To sign a url without opening a document, import the module in page context: `const media = await import("/src/lib/files-media-src.ts")`, then `media.files_media_get_signed_url({ membershipId, fileNodeId })`. Call it twice and time the second call — a cached hit returns the same url in ~0 ms. `files_media_get_signed_chat_image_url({ membershipId, assetId })` does the same for a picture the chat agent drew, out of the same cache.
- Slash-menu drive (current, verified 2026-08-08 — supersedes the historical `rich-text-slash-command-keyboard.md`): type `/image` into the editor, wait for `.FileEditorRichTextToolsSlashCommand-item`, ArrowDown until `[aria-selected="true"]`'s `-item-title` matches, then Enter. Start each drive from a fresh paragraph (press Enter first): a refused URL prompt leaves the `/query` text in the doc, and typing another `/` right after it does not reopen the menu.
- `Image`/`Video` open a real file chooser from the hidden inputs — intercept with `state.page.waitForEvent("filechooser")` started before the Enter, then `chooser.setFiles("C:/absolute/path")`. Works under a Windows relay.
- `Embed file` opens `.FileEditorRichTextMediaEmbedPicker` (a `MySearchSelect` anchored to the caret): type to filter by path, Enter inserts the highlighted row's `bonobo-file://` reference, Escape closes and refocuses the editor. Rows are `-item-name` / `-item-path` spans.
- `Image from URL` / `Video from URL` use `window.prompt` — stub it in `evaluate` (`window.prompt = () => url`) before triggering the item; a non-http(s) answer must produce the alert (stub `window.alert` to capture) and insert nothing.

### File Properties Modal

One dialog holding the file's facts, its read-only lock, and the flat key-value map edited as YAML
(verified 2026-08-18). Spec: `.agents/skills/file-metadata/SKILL.md` and
`.agents/skills/files-read-only/SKILL.md`. It replaced both the sidebar `Metadata` tab and the old
`Read-only settings` modal, so a recipe that clicks either of those is out of date.

- Two ways in: right-click a sidebar row (or click its ⋮ button, `getByRole("button", { name: "More actions for <name>" })`)
  and pick `Properties`, or click the breadcrumb button, `getByRole("button", { name: /^Properties of / })`.
- **Two dialogs are mounted**, the sidebar's and the file view's, and the closed one keeps its class
  and its `data-files-properties-modal` attribute at `display: none`. Scope every query to
  `[data-files-properties-modal][data-open="true"]`. A plain `.FilesPropertiesModal` resolves to the
  hidden one first, and `waitForSelector` then times out on a dialog that is plainly on screen.
- The read-only control is a `MyCheckboxButton`, whose real `input` is 1px and covered. Clicking
  `getByRole("checkbox")` fails with `<div class="FilesPropertiesModalReadOnly"> intercepts pointer
  events`. Click `.FilesPropertiesModalReadOnly-checkbox` (the label) and read the state from the
  input.
- The dialog holds four sections, reachable by their region names: `General` (a `<dl>` of facts),
  `Protection` (the read-only checkbox), `Collaboration` (the collaborative-editing checkbox), and
  `Metadata` (the YAML editor). A folder gets the first two only — `set_entries` refuses a non-file,
  so there is no editor to find. `Collaboration` renders only for an editable text file, so an image
  shows three sections and no empty strip.
- The `Collaboration` checkbox is another `MyCheckboxButton`, so the same 1px-input rule applies:
  click `.FilesPropertiesModalCollaboration-checkbox`, or `focus()` the input and press `Space`.
  Both directions open an inline confirm step inside the same section —
  `getByRole("button", { name: "Turn collaboration off" })` or `Turn collaboration on`, next to
  `Cancel` — and nothing is written until that button is clicked (the ON confirm is newer than the
  OFF one; verified 2026-09-04). Focus moves to the confirm button, and the tick keeps its old
  state until the write lands, so do not read "still checked" as a missed click. Read the state from
  `.FilesPropertiesModalCollaboration-description`, not from the tick: the Metadata section repeats
  the same "read-only" and "no permission" sentences, so `getByText` finds several matches.
- Read-only is one checkbox, but the dialog holds two (Protection and Collaboration), so a bare
  `getByRole("checkbox")` is a strict-mode violation — scope it to `.FilesPropertiesModalReadOnly`. It writes as soon as it
  is clicked; there is no Save for it. The line under the label says which lock is in force, and it
  is the only thing that distinguishes the four states, so assert on that text, not on the tick
  alone. Under an inherited lock the box is `disabled` and two buttons appear instead:
  `Manage /<path>` and `Also lock here` — but only when the caller can manage the lock. A member
  without `content.permissions.manage` gets the disabled box and no buttons at all.
- The checkbox row is a `.MyButton`-styled `<label>`, so it inherits `justify-content: center` and
  `white-space: nowrap`. Only `white-space` is overridden. `justify-content: center` is still in
  force and is made harmless by `flex: 1` on `.FilesPropertiesModalReadOnly-text`, which makes the
  text fill the row so there is no free space left to centre. A regression shows as
  the checkbox and its text floating in the middle of the outlined card: measure
  `.MyCheckboxButton-box` left minus `.FilesPropertiesModalReadOnly-checkbox` left, which must equal
  the 12px padding and not roughly half the row.
- The editor is Monaco. Synthetic keyboard input does not reach it. Set the text through the editor
  handle from page context:
  `monaco.editor.getEditors().find((e) => e.getRawOptions().ariaLabel === "File metadata YAML").setValue(yaml)`.
  Get `monaco` with `await import("/@id/monaco-editor")` — the bare specifier `"monaco-editor"` does not
  resolve in page context under the Vite dev server, it throws `Failed to resolve module specifier`.
- Monaco inside this dialog hoists nothing, unlike the file editors. Its suggest and hover widgets
  clip at the editor box on purpose — see the layering note in `known-hazards.md`. Do not "fix" a
  clipped widget by pointing `overflowWidgetsDomNode` at `#app_monaco_hoisting_container`.
- On a read-only file, or without write permission, the button carries `aria-disabled` and
  `MyButton-state-disabled` instead of the `disabled` property, and the status line above it says
  why. Read `aria-disabled` there, not `disabled`.
- `Save metadata` stays disabled until the draft differs from the stored map, so a `setValue` with
  the same text leaves the button disabled — that is correct, not a broken run.
- The status line is one element: `role="status"` for `Metadata saved`, `role="alert"` for a
  refusal or a conflict. Read it by role, not by text position.
- A refusal to check: `owner:\n  name: nested\n` is refused in the dialog before any mutation runs,
  so the network stays quiet.
- Closing throws an unsaved draft away. The footer shows `Unsaved metadata will be lost.` while a
  draft is dirty; there is no confirm step.
- Read the stored map back from Convex instead of trusting the dialog:
  `app_convex.query(app_convex_api.files_metadata.get_entries, { membershipId, fileNodeId })` from
  page context returns the entries in stored order.
- Properties work on uploads. Open a PDF node and the same dialog is there.
- Agent side: ask the chat agent to run `meta get <file>` and to call `set_file_metadata`. The tool
  takes bare keys (`status`), and the model tends to paste the bash mount path — both are covered by
  the tool description now, but a run that fails with `Not found` is usually the path, not permissions.

## Script Pattern

For anything longer than a one-liner, keep the runner in a dated personal AI folder:

```powershell
$runDirectory = "../t3-chat-+personal/+ai/files-qa-$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$scriptPath = Join-Path $runDirectory "playwriter-files-check.js"
# Create this runner with the agent's targeted edit tool. Do not write it with a shell rewrite.
vp env exec pnpx playwriter -s $session -f $scriptPath --timeout 90000
```
