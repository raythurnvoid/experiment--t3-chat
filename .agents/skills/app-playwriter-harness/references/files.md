# Files Route Playwriter Notes

Use this file as a quick testing map for `/files`. Keep it short and selector-oriented. If a check needs a large script, write a task-specific runner in the personal AI folder instead of pasting it here.

## Route Basics

- Route shape: `/w/:organizationName/:workspaceName/files?nodeId=<id>`.
- `nodeId=root` opens the root folder browser.
- Folder node ids open the folder browser; file node ids open the editor.
- Optional `view` values: `rich_text_editor`, `plain_text_editor`, `diff_editor`.
- There is also a path route, `/w/:organizationName/:workspaceName/files/<file path>`. It resolves the path and replaces the URL with `?nodeId=<id>`. Documents written by an import link to each other this way, so use it to open a file when you know its path but not its id.
- A link inside a mounted editor does not navigate on a plain click. The editor is editable, so the click only moves the caret. To follow a document link, read its `href` and `goto` it.

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
- Rich text editable content: `.FileEditorRichText-editor-content` while collaboration is on.
  After Properties turns collaboration off, the Save path uses
  `.FileEditorRichTextNonCollab-editor-content` instead. **Never use bare `.ProseMirror` and never
  `main`.** The route mounts at least three ProseMirror editors — the file, the AI chat composer
  (`.AiChatComposer-editor-content`), and the comment composer
  (`.FileEditorCommentsComposerControl-editor`) — so `querySelector(".ProseMirror")` can answer
  with the composer, and `main.innerText` returns the file text glued to the whole agent panel
  transcript. Either way a `text.includes(marker)` check reads as a pass on content the file does
  not hold. Verified 2026-09-01 while proving a Chitchat transcript write; non-collab class checked
  2026-09-18.
- Comments region: `getByRole("complementary", { name: "Document comments" })`.
- View picker: `[aria-label^="View:"]` in the toolbar; options render in `.FileNodeViewViewSelect-popover`
  (labels like `Rich text`, `Markdown`, `Review changes`, `File details`). Scope clicks to that
  popover — bare `[role=option]` also matches the agent panel's listboxes.
- Diff editor root: `[aria-label="File diff editor"]`.
- Review changes button: `[data-testid="review-changes-button"]`.
- Tables in the rich editor: plain `table`, `th`, `td` selectors inside `.FileEditorRichText-editor-content`.
- Table commands menu: toolbar `getByRole("button", { name: "Table commands" })`; items are `Add row above`, `Add row below`, `Add column left`, `Add column right`, `Delete row`, `Delete column`, `Toggle header row`, `Delete table` (disabled while the caret is outside a table).
- Properties button in the breadcrumb: `getByRole("button", { name: /^Properties of / })`. It still carries `data-file-write-policy` with the node's lock state. Its `.click()` can hang on "visible, enabled and stable" while `hitTest` shows the button itself on top and nothing covers it (hit 2026-08-21). Read its box in page context and click the middle with `page.mouse.click(x, y)`.
- Breadcrumb crumbs: folder crumbs are links inside `ol.FileNodeViewHeaderBreadcrumbPath-list` whose `aria-label` holds the full name while the text may end with `…`. The open node's crumb is `[aria-current="page"] button` (named by the full file name, `aria-haspopup="menu"`); its menu items are `Reveal in sidebar`, `Duplicate tab`, `Copy node id`, `Archive` (`Archive` only when the node can be archived; `Reveal in sidebar` is absent for an archived node; a pending entry gets only `Duplicate tab` and `Copy node id`). Recipe under "Breadcrumb Menu And Reveal In Sidebar" below; layout notes in `app-map.md`.

### Sidebar And Folder Browser

- Sidebar tree rows: `.FilesSidebarTreeItem[data-file-id]`.
- Sidebar selected rows: `.FilesSidebarTreeItem[data-file-id][aria-selected="true"]`. The attribute sits on the row wrapper itself; `FilesSidebarTreeItemPrimaryAction` never carries it (the row strips it before passing props down).
- Sidebar row primary action: `.FilesSidebarTreeItemPrimaryAction`.
- Sidebar row more action: `.FilesSidebarTreeItemMoreAction`.
- Sidebar search input: `#app_files_sidebar_search input` (combobox named `Search files by name, path, or key:value filters`); filter chips `.FilesSearchInputFilterChip`; suggestions `.FilesSearchInput-popover [role=option]`; sr-only status `.FilesSidebarTopSection [role=status]`. Recipes under "Sidebar Search Box" below.
- Locked row accessible name: `getByRole("treeitem", { name: "<name>, Read-only" })` when the lock is on that node. A parent lock does not mark a child `read-only from /path`. A writable folder with locked children can say it contains read-only items. `/meetings` after a Council meeting upload is that last shape. Expand it with `getByRole("button", { name: "Expand folder <name>, contains read-only items" })`. The visible title is an input, so `.FilesSidebarTreeItemTitle` with `hasText: /^name$/` does not match (verified 2026-08-26; row suffix recased 2026-09-18).
- Sidebar context menu: `[data-files-sidebar-tree-context][role="menu"]`.
- Archive from any menu (sidebar row, toolbar Archive selected, folder explorer row, breadcrumb) opens `getByRole("dialog", { name: /^Archive / })`; confirm with its `Archive` button, cancel with `Cancel`. A refusal is a `role=alert` inside the dialog, not a toast, and the dialog stays open. From page context, match `.FilesArchiveModal:not([hidden])` and read `.MyModalHeading` (the dialog has `aria-labelledby`, no `aria-label`). After a sidebar confirm, `document.activeElement` is the next tree row (or the previous one when the archived row was last); it lands about 100 ms after the dialog has closed, after a brief stop on the button that opened the dialog, so poll for it instead of reading it the moment the dialog hides. Multi-select archive: hold Control and click each row's `.FilesSidebarTreeItemPrimaryAction` (a Control-click on the open file's row removes it from the selection), then the sidebar header `More options` menu item `Archive N selected items` opens `Archive N items?` with the names in a list; after the confirm only the open file's row is selected again. Cancel keeps a multi-selection: the sidebar's click-outside selection reset is off while the dialog is open. Archive with the mutation directly (see "Sidebar Create Then Rename By Id") when the dialog is not what you test.
- Folder explorer root: `.FileNodeViewFolderExplorer`.
- Folder explorer rows: `.FileNodeViewFolderExplorer-row`.
- Folder table drop target state: `.FileNodeViewFolderExplorer-row-drop-target`.
- Folder table dragging state: `.FileNodeViewFolderExplorer-row-dragging`.

### Large And Virtual Trees

- The sidebar scroll owner is `.FilesSidebar-content`. Only viewport rows and active controls stay
  mounted. DOM row count is not the workspace file count. Use `[role="treeitem"][data-file-id="<id>"]`
  for a known row; the absolute outer wrapper is only presentation.
- Scroll with the pointer inside the sidebar, then locate the row again. An offscreen row can leave
  the DOM between observations. Do not reuse a saved box for drag start. Confirm both boxes in view
  immediately before mouse-down, and release mouse and Escape after a failed drag probe.
- Test keyboard focus on both root and file routes. Ctrl-click or Shift-click a row, let a live tree
  update arrive, then press ArrowDown. Check the exact focused row id separately from selection.
  The synthetic root has no DOM row. Also check rename cancel/re-entry/save and Properties/Share
  close, including focus again after 200–400 ms.
- `Failed to scroll to index ... after 10 attempts` is an unresolved scroll result. Record the
  focused id, scroll offset, row count, and build. A later wheel scroll does not prove End or drag
  auto-scroll passed. Test those actions separately.
- Narrow-layout limit observed at 512 px: the sidebar header can clip Collapse all and More options.
  Its five 36 px buttons, gap, and padding need 220 px, while the saved panel width is a percentage.
  Check control hit targets as well as document overflow. This limit was not fixed by virtual rows.
  The QA profile can carry a narrow saved width (14% on 2026-09-20 hid `More options` under the
  editor). The panel sizes live in `localStorage["app_state::resizable_panel::main_panel"]` as
  `[sidebarPercent, mainPercent]`; write `[24,76]` (the default) and reload. Only a drag end
  persists a size, so a keyboard resize on the `Resize files sidebar` separator is lost on reload.
- A stored binary can be present and downloadable while its workspace has no matching enabled
  viewer plugin. Record that as a preview limit. Verify bytes, node/asset ids, and Properties
  separately; do not re-upload the file or install plugins just to make a preview check pass.

## Upload Fixtures

Deterministic assets in `.agents/skills/app-playwriter-harness/assets/files/`:

- `r2-upload-sample.pdf` — PDF source-to-shadow conversion checks.
- `r2-upload-markdown-sample.md` — Markdown upload checks; it must become a normal editable Markdown node instead of a source-conversion panel.
- `shapes.png` — image-plugin QA: a red circle, a blue square, a green triangle, and the text `BONOBO QA IMAGE` on a white background.
- `speakers.wav` — video-plugin QA (audio path, ~39s): two distinct TTS voices alternating scripted lines about the quarterly budget, a penguin research station, the marketing plan, and a solar bicycle.
- `speakers.mp4` — video-plugin QA (video path, exercises the Modal audio extractor): the same `speakers.wav` audio muxed over a solid-color video track.

Plain-text document QA fixtures (plain-text-docs §11.5). Upload them in the throwaway non-default org, not the user's workspace. Bytes are pinned — regenerate only with the recorded generator, never by hand:

| Fixture                            | Purpose                                                                                                                                                                                                       | Bytes | Lines | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- | ------------------------------------------------------------------ |
| `qa-plain.json`                    | Pretty JSON becomes an editable plain-text document; token `BONOBO_QA_PLAIN_JSON_2026`.                                                                                                                       | 106   | 6     | `983e9aed87de77edbe28410e7351ac063799d69da26bbb1d83022ccc9da8ac89` |
| `qa-plain.yaml`                    | Starts with `---` to prove plain-text YAML never enters frontmatter parsing; token `BONOBO_QA_PLAIN_YAML_2026`.                                                                                               | 88    | 7     | `197253fd06f6c2c9e26f30577acff0252c07d9edb3396ed12a55fa973b48909b` |
| `qa-plain.csv`                     | CSV upload conversion; token `BONOBO_QA_PLAIN_CSV_2026`.                                                                                                                                                      | 65    | 3     | `37493e05d743d87b8a3a3a8c079f54849935423a3b7499da488f19a8f13a9791` |
| `qa-plain.txt`                     | Plain `.txt` upload conversion; token `BONOBO_QA_PLAIN_TXT_2026`.                                                                                                                                             | 118   | 3     | `1f437490ce737b637202e432afb01f544ac6361b4d3a3c9fc21727b9fc2d2961` |
| `qa-plain-bom.csv`                 | UTF-8 BOM + CRLF bytes; the stored document must be LF text without the BOM; token `BONOBO_QA_PLAIN_BOM_CSV_2026`.                                                                                            | 54    | 2     | `d002e97a17daf90711b1aca0f9d092afd84e60c5772c8b590d4e148fc9956042` |
| `qa-plain-minified.json`           | One line, no trailing newline; token `BONOBO_QA_PLAIN_MINIFIED_JSON_2026`.                                                                                                                                    | 85    | 1     | `dbb7640688394098fbce3383fffe56de03ecb71b83f190a03507275262829fd7` |
| `qa-plain-invalid-utf8.txt`        | Carries one lone `0xFF` byte, so the upload conversion's fatal UTF-8 decode fails: the node keeps the stored blob (no editable conversion), and the fallback settle still dispatches the plugin upload event. | 15    | 1     | `cb1715d56c0e816cbca6f4299a0a3edadc3fc9bf96e337fe49f0f4092d515dca` |
| `qa-frontmatter-overcap.md`        | Markdown with 129 frontmatter keys — one over `files_metadata_MAX_FRONTMATTER_FIELDS` (128); token `BONOBO_QA_FRONTMATTER_OVERCAP_2026`.                                                                      | 2418  | 135   | `8cb33857771b68cee0dfce80ca73a28214ed3af89f134a0f24db429c28d4d599` |
| `qa-frontmatter-values-overcap.md` | Markdown with one `tags` array of 600 unique values — over `files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS` (512); token `BONOBO_QA_FRONTMATTER_VALUES_OVERCAP_2026`.                                         | 7295  | 607   | `c3cd45983e3432693a91a9b9270f1a70e8add08c2e6a39948436db3ad3c855aa` |

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
	const membership = await m.app_convex.query(
		m.app_convex_api.organizations.get_membership_by_organization_workspace_name,
		{
			organizationName: "personal",
			workspaceName: "home",
		},
	);
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
- Submitting an empty inline rename closes it without saving. To check visible validation, submit a duplicate sibling name; the input stays focused with an error. After Escape, wait for focus to return to the row before testing arrow keys or F2 again.
- When a folder is selected, `New file` and `New folder` exist twice: once in the sidebar toolbar and once in the folder view toolbar. `getByRole("button", { name: "New file" })` is then a strict-mode violation. Scope to the sidebar with `.FilesSidebarTopSection-actions-icon-button[aria-label="New file"]`.
- A folder-explorer row's visible name (`span.FileNodeViewFolderExplorer-link`) is covered by a full-row overlay link, so clicking the text reports `intercepts pointer events`. Click the overlay by its accessible name instead: `getByRole("link", { name: "Open <name>" })`. That error message is also the quickest way to read a fixture's `nodeId`, because the overlay's `href` carries it.
- The sidebar toolbar `New file` / `New folder` buttons create at root with a generated `new-file*.md` / `new-folder*` name. After saving, they select the new node, navigate to it, and open inline rename. Wait for `input[aria-label="Rename <current name>"]` before typing. There is no create dialog. A slash path such as `qa-root/docs/api.md` moves the node and creates missing folders.
- The folder view toolbar has a different create flow: scope to `toolbar "File actions"`, choose
  `New folder`, fill the dialog's `Name` input, and press Enter. This creates inside the open folder.
- Pending row controls inherit disabled state from their fieldsets. Use `locator.isDisabled()` or `element.matches(":disabled")`; `button.disabled` only reads the button's own attribute. Check focus after a focused action becomes pending, then check menu and arrow access again after it finishes.
- Archived rows expose the restore action as menu item `Restore`, not `Unarchive`, and their row button label gains a suffix: `More actions for <name> archived`. Reveal them first with the sidebar `More options` menu item `Show N item(s) archived`.
- Use real drag gestures for drag/drop checks. Do not use `dispatchEvent`, DOM `element.click()`, or forced clicks.

## High-Value Recipes

### Shared Cloud Browser End To End

Needs `AI_CHAT_BROWSER_ENABLED=true` on the dev deployment and an HTML file (search `.html` in the sidebar; dismiss the suggestions dialog with Escape before clicking a row or the click times out behind it).

- Open the HTML file, choose `Code + Browser` from the `View` combobox, then click `Start shared browser`. Wait for the `Watching. Take control to click and type.` text (up to 120 s for the first provider boot).
- The live viewer is `role=application` named `Shared browser page. Type and click to drive it; Tab goes to the page, Escape leaves it.` (view-only when input is off, with `tabIndex=-1`); status, source hash, countdown, and controls live in `.FilesBrowser`.
- `Take control` → wait for `You have control` + `Resume agent` before sending input. Clicking and wheeling in the same call as Take can arrive before control changes. Resume returns to `Live`.
- Agent run: sidebar Agent tab, select a `New chat` tab, fill `.AiChatComposer-editor-content`, wait for `[data-testid="ai-chat-send-button"]` to enable, send. The snippet receives `page, frame, expect, emitFile`; name that scope in the prompt. Wait for Stop to appear first, then waitIdle per `agent-panel.md`.
- A `Browser run` card shows a short status such as `Browser succeeded.`. Each output file adds an `Open in Files` link in both chat surfaces. The card has no image preview or raw tool text. The browser panel has no Results list. Follow the screenshot recipe below to review the files.
- Reload, Focus/Exit focus (editor collapses but stays mounted; focus returns to it), `End browser` (start card returns, no session left).
- Popout: `Pop out` opens `/files/browser?session=…`. If its first Playwriter handle hangs, bind the same existing URL in a second owned session (see known-hazards). Click `Focus popout` in the opener before retrying native popup controls. With human control active, click `Dock in Files`; require the popup to close, the docked viewer to return, and a real page click to work.
- Pointer check: use an HTML fixture with a click counter, double-click counter, text input, range slider, and a tall page. Compute pointer positions from the contained image rectangle, excluding black margins. Check JPEG dimensions match the hello viewport. Confirm values through a read-only `browser_run` in the same chat after Resume.
- Create that fixture with sidebar `More options` → `Upload file`, using a `.html` file with MIME type `text/html`. Renaming a new Markdown file to `.html` keeps its Markdown content type and does not add the Browser view.
- For two viewers, first open the same HTML file in two owned tabs and select `Browser` or `Code + Browser` in both. Start once. Opening the second tab in Code view after Start can end the session through selection cleanup. Require both images to show the same counter. Only the viewer that took control may change it; a click in the other viewer must leave it unchanged. Check the actual counter, not only the control label: both tabs can currently say `You have control`, even though the runner refuses the other viewer's input. Close the extra tab before measuring latency.
- To resume into a new chat, send its first message and wait for the saved chat tab. An empty optimistic `New chat` tab does not yet enable `Resume agent`. For screenshot and tracing QA, use `expect(frame.locator(...))`, start `page.context().tracing` with screenshots, pass `page.screenshot()` bytes to `emitFile` with a canonical Files path, and stop tracing in `finally`. After the agent finishes, take control again; a native click must update the live image. Do this before opening a screenshot in Files, because selecting a non-HTML file ends the browser session.
- For a reported dead click, test the same button before and after Take control. View-only mode must send no input. With control, check `mouse.down` and `mouse.up` plus their `input-ack` replies, then require the page counter to change. An accepted input alone does not prove the page script worked. Read agent-made fixture code too: missing counter elements can throw inside a click handler and look like a viewer failure. Keep socket logs limited to input, acknowledgements, control, and viewport messages; do not log grants or URLs.
- For slow clicks, load `perf-profiling` and use one fresh measurement tab. Time native pointer input and the changed counter image inside the page; use CDP timestamps for each input and `input-ack`. An image load proves the changed image is ready, not that it was painted. Compare at least five samples per variant and use at least 20 for the final result. Report median, p95, and maximum; aim toward 100 ms, with p95 at or below 500 ms. Keep permission checks active. Recompute the contained image rectangle before every click: changing the view or panel width invalidates saved coordinates. Keep extra human clicks and missed targets separate from controlled samples. Remove socket wrappers and exact listeners, then close the measurement tab after saving results.
- Keep human control for more than 40 seconds while changing focus or editing the source. This checks two grant renewals; a quick click alone misses a timer reset that drops control after Take.
- Source check: edit and Save while the browser stays open. Updates must appear without changing the live page. Reload must advance the source version and load generation, then clear Updates.
- Idle is 5 minutes and watching does not extend it. Leave the viewer open without input or Keep open. After expiry, require the Start card and `current_browser_session` to return null, then start again. Check expiry before the next renewal too: a session-ended socket close must retire the app session, not strand a Time expired panel. For an expiry during a run, inspect its safe status and reason alongside the countdown. A failed card alone does not prove a transport fault.
- Selection cleanup: start on HTML, select a non-HTML file, then read `current_browser_session` and require null. Repeat from HTML to the root folder. Do not press End before switching.
- Narrow layout: at a 1280 px viewport, keep editor, browser, and agent panels open. Take control so the wider Resume button appears. Require every browser action to fit; the row may wrap. Check Focus at a smaller viewport too.
- Binding regression: only the first message of a new chat used to bind. After any transport change, send TWO messages in one thread and require a `Browser run` card in both answers — a follow-up with no card means the runtime body dropped `browserSessionId`. Verified 2026-09-19.
- Boundary regression: first prove a normal `expect`, click, and screenshot succeeds. Then try provider CDP methods through the agent and return booleans only; never print provider IDs or control links. Raw CDP attachment must fail while normal page tools keep working.
- Delayed page actions need a separate check after the tool returns. Schedule a main-page navigation several seconds later; require the session to end. For a popup, save the returned window on the page, then read `created` and `closed` booleans in a later command. Both must be true, with one assigned page still usable. Also test tracing and resize before taking human control again.
- A model may repeat an earlier tool error without making a new call. Check for a new `Browser run` card and its status. If it only repeats the old answer, use a fresh QA chat so the retry actually reaches the tool.
- For a screenshot-only check, use `emitFile({ workspace: "personal", path: "/qa-browser-RUN/page.png", bytes: await page.screenshot({ type: "png" }), contentType: "image/png" }); return "captured";`. Replace `RUN` with a unique id. The `browser_run` input contains only `code`. Do not add a locator for an unchecked element: its timeout fails the whole call and can end the browser session.

### Browser Screenshots And Image Reads

- In Agent mode, ask `browser_run` to emit two screenshots in one call. Use `emitFile({ workspace: "personal", path: "/qa-browser-RUN/page.png", bytes: await page.screenshot({ type: "png" }), contentType: "image/png" })`. Repeat with `workspace: "current"`, `page.jpg`, screenshot type `jpeg`, and `image/jpeg` to cover both destinations and formats. Each file requires its own workspace selector; it does not inherit the browser page's workspace.
- Each screenshot is capped at 2 MiB, 8192 pixels per edge, and 16 million pixels before the snippet receives it. File output allows eight files and 8 MiB total. Paths are explicit canonical Files paths. There is no default destination folder. A collision adds a name suffix. Check the returned target's actual path. Bash `/tmp` is separate scratch storage.
- Check both the Files sidebar chat and the chat page. The tool card must show two file paths, their current state, and two `Open in Files` links. It must stay text-only while streaming and after reload. Raw observations, image bytes, and signed download URLs must not appear in the card. A run without files has only its safe status and reason.
- Stored file results have `metadata: { status, reason, files }`. Status is `succeeded`, `partial`, `errored`, `cancelled`, or `timed_out`. Successful results normally have `reason: null`. Check partial file output too: earlier completed files must remain after a later failure or Stop.
- Open Pending and expand each image. Require a preview, size, creator, and source chat link. `Open file` and the chat's `Open in Files` must open the same private preview. PNG/JPEG previews must work without an image-viewer plugin.
- When parent folders are still private, require `Save also creates:` to list the exact folders. Save one image. Both the pending row and private-file view use a review Activity, even without pending parents. Wait for that Activity to finish; a `Started saving` message only confirms that it began. Require those folders and that image to become saved while the second image stays pending. Discard must leave unused parents and siblings alone.
- A private image can have two `.FileNodeViewPrivate-actions` containers. Use `allInnerTexts()` to inspect them, then locate the visible Save or Discard button by its role and name. Do not assume that class matches one element. Text drafts put Save in the editor toolbar.
- Keep the first image's original `pendingNodeId` URL. After Save, reopen it and require the saved preview and saved URL. Rename or move the saved image, then reload the chat: its path must update and its link must still open the file. Discard the second image and require its chat row and old private URL to show an unavailable state. Missing, archived, or denied files must not retain an active chat link or preview.
- Keep a separate image pending for image-read checks. While the shared browser is live, switch to Ask mode and request a new screenshot proposal. Require no new pending files and the stored result `status: "errored", reason: "agent_required"`. The model's answer alone is not evidence. Ask may still inspect the page and return private text observations.
- Then end the shared browser. In both Ask and Agent mode, call `view_image({ workspace: "personal", path: "/qa-browser-RUN/page.png" })` for a private image and a saved image. Resolve an old id or Files URL with Bash first when the path is unknown. Use the canonical Files path, not the Bash mount path. Ask about a visible detail to confirm that the model received the image. The tool card must show only safe status and one Files link, including after reload. This read needs neither a live browser nor the image's creation chat.
- `view_image` accepts PNG, JPEG, WEBP, and GIF. It allows 8 MiB per turn, 8192 pixels per edge, and 16 million canvas pixels. Header checks do not prove that all compressed pixels are valid. A later turn must read the image again. Stored chat keeps no pixels or browser observations.
- Test non-image output separately with the [arbitrary-file and byte-transform recipes](agent-panel.md#deterministic-arbitrary-file-check). The same `emitFile` helper supports every byte type. Editable UTF-8 becomes a normal private text draft. Invalid, unsupported, or over-limit text remains stored bytes. Use Bash for text and `execute_code` with `/api/v1/files/read-bytes` for binary transforms.
- Use Tab and Enter or Space to expand Pending images and reach Save/Discard. During a review, require a progress message and no duplicate action. When a focused row disappears, focus must stay in the Pending panel or file view. Check preview loading, a failed load with `Retry image`, stale review errors, and denied Save. A late preview response must not replace the newly selected image.
- Save and Discard leave their Activity dialog open after completion. Close `Save reviewed changes` or `Discard reviewed changes` before acting behind it. Use the scoped footer `Close` recipe below; the icon has the same accessible name.
- Check a narrow viewport and 200% zoom. Long file paths and the parent list must wrap, image previews must fit, and Save/Discard must remain reachable. At 360px, close the Files tree and widen Pending with its resize handle. The tab strip scrolls horizontally. This checks screenshot controls; the wider Files layout still needs manual panel sizing. Return to the HTML file and start a new browser session before continuing live browser checks.

### Personal Draft After Leaving Its Source Team

Create a personal draft from an owned team chat. First check that its source label opens that chat. Remove only the fixture user's team membership through the normal member-removal flow. In personal/home, require the draft to remain ready and reviewable, while `get_pending_source_summary` returns null. Open its `pendingNodeId` Files URL and Save with the keyboard. Read back the saved target and require the URL to switch to `nodeId`. Leaving the team must not remove saved home files or block the user's review of an existing home draft. Do not remove a real user's pre-existing membership for this check.

### Check Row Controls While Creating

Use an owned tab and an empty test folder. To hold the busy state, wrap that tab's
`app_convex.mutation`: await the real create result, then wait on a promise before returning it.
Click the normal sidebar `New folder` button. Check native button disabling and the row's
`aria-disabled` and pointer hit-area's `data-disabled`; the focused row stays usable.
Release the promise and restore the original method in `finally`. Check automatic rename focus
and enabled controls, then archive the unchanged empty test folder. Keep this delay out of timings.

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

- For dev rendering experiments, use the profiling skill's one-tab variant recipe. Time the same starting view, keep the mounted row count fixed, and retain the normal create/rename checks before treating an experiment as a fix.
- Bind one `/files` tab and use a unique `aaa-pw-qa-*` temporary folder.
- Create a folder from root; verify the route selects the new node and its default name is selected in the inline rename input.
- Inside the temp folder, create a file and verify the basename selection for `new-file.md`.
- Try duplicate deep paths: duplicate file should show `This file already exists.`, duplicate folder should show `This folder already exists.`.
- Archive the temp folder when done: its row menu `Archive` opens the confirm dialog (see the sidebar bullet under "Stable Selectors"), or call the mutation directly.

### Breadcrumb Menu And Reveal In Sidebar

Use this after changing the file header, `files::reveal_node`, or the sidebar's expand/focus effects.

- Open a file at least two folders deep. Read the crumbs with `[...document.querySelectorAll(".FileNodeViewHeaderBreadcrumbPath-segment")].map((el) => ({ shown: el.textContent.trim(), full: el.closest("a").getAttribute("aria-label") }))`; `shown !== full` means the ladder shortened that crumb.
- Open the menu: `page.getByRole("button", { name: "<file name>", exact: true })` inside `[aria-current="page"]`, then `page.getByRole("menu")`. Read the item names before clicking one; the menu unmounts when it closes.
- Reveal in sidebar: collapse the parent folder by hand first (the route's own auto-expand runs once per selected path, so it will not undo that), then click `Reveal in sidebar`. Assert the folder row's `aria-expanded === "true"` and `document.activeElement` is `.FilesSidebarTreeItem[data-file-id="<id>"]`. Repeat with the files panel closed (`Close` in the sidebar header): the panel opens and the same row ends focused. With a search query in the box, the reveal drops `?q=` and the full tree comes back first.
- Duplicate tab: `const [tab] = await Promise.all([context.waitForEvent("page"), item.click()])`; the new tab's URL equals the current one, `view` and `q` included. Close only that tab.
- Archive: opens the confirm dialog; see the sidebar bullet under "Stable Selectors". Confirming from the breadcrumb navigates to Home.

### Sidebar Create Then Rename By Id

The sidebar `New file` button saves a generated `new-file*.md` name, navigates to the new node, and opens inline rename. Read its id from the new route. The older DOM-diff recipe below also works in small trees:

Use this DOM-diff recipe only in a small tree where every row is mounted. In a virtual tree, scrolling
also changes that set. Prefer the new `nodeId` in the route after creation, then confirm the exact row.

```js
// Call 1: snapshot ids, click New file.
state.beforeIds = await state.page.evaluate(() =>
	Array.from(document.querySelectorAll("[role=treeitem][data-file-id]")).map((t) => t.getAttribute("data-file-id")),
);
await state.page.locator('.FilesSidebarTopSection-actions-icon-button[aria-label="New file"]').click();

// Call 2 (poll): the fresh id is the one not in the snapshot.
const created = await state.page.evaluate((prev) => {
	const fresh = Array.from(document.querySelectorAll("[role=treeitem][data-file-id]")).find(
		(t) => !prev.includes(t.getAttribute("data-file-id")),
	);
	return fresh ? { id: fresh.getAttribute("data-file-id"), label: fresh.getAttribute("aria-label") } : null;
}, state.beforeIds);
```

Wait for the new row's rename input, click it, fill it, and press `Enter`. If rename has already closed, click `[role="treeitem"][data-file-id="<id>"] .FilesSidebarTreeItemPrimaryAction`, press `F2`, and wait for the focused rename input before typing.

Do not press `F2` while the new file's editor is still mounting. The create-then-rename race crashed `FileEditorInner` (`NotFoundError: removeChild`, caught by the route error boundary) twice in ~12 editor mount transitions on 2026-08-10 — a filed app follow-up, not a harness bug. Wait for the editor surface first (`.FileEditorRichText-editor-content` or `.monaco-editor`); if the boundary appears, `Try again` recovers.

When the check does not care about the sidebar itself, skip the id diff and the rename: create the file with its final name from page context, the same door the sidebar button calls (verified 2026-09-05). The result carries the node id, so open it straight away with `?nodeId=<id>&view=rich_text_editor`.

```js
const r = await state.page.evaluate(
	async (name) => {
		const m = await import("/src/lib/app-convex-client.ts");
		const membership = await m.app_convex.query(
			m.app_convex_api.organizations.get_membership_by_organization_workspace_name,
			{ organizationName: "personal", workspaceName: "home" },
		);
		const created = await m.app_convex.action(m.app_convex_api.files_nodes_content.create_text_node, {
			membershipId: membership._id,
			parentId: "root",
			path: name,
		});
		return { membershipId: membership._id, nodeId: created._yay?.nodeId ?? null, nay: created._nay ?? null };
	},
	"qa-" + Date.now().toString(36) + ".md",
);
```

Archive it the same way at the end: `m.app_convex.mutation(m.app_convex_api.files_nodes.archive_nodes, { membershipId, nodeIds: [nodeId] })`.

### Sidebar Selection Context

Use this when changing tree focus, context menus, selection, or route sync.

- Ensure URL has a non-root `nodeId`; if needed, click a visible `.FilesSidebarTreeItemPrimaryAction`.
- Control-click a second row and verify selected rows include both ids.
- Click Search files or empty tree whitespace; selection should reconcile to `[nodeId]`.
- Open a row menu and the top more-options menu; multi-selection should remain visible while each menu is open.
- On `nodeId=root`, outside interactions should clear temporary multi-selection to `[]`.
- Do not click archive/delete menu items during this check.

### File Cut, Copy, And Paste

- Use a new QA folder with a source file and two destination folders. Scope duplicate row actions
  to the Files tree or folder table. Open `More actions for <name>` and choose the exact `Copy` or
  `Cut` item; `Copy path`, `Copy link`, and `Copy node id` are separate actions.
- Control-click two sidebar rows, Copy from either selected row, then navigate elsewhere. The
  toolbar must still say `2 ready to copy`. Copy from an unselected row must keep only that row.
- Select a folder and its child. Cut and Copy from a row menu, top menu, or keyboard must keep
  only the parent in the clipboard. A completed Cut must clear that parent from the clipboard.
- Select files under separate folders, then collapse one parent without changing the selection.
  Keyboard, selected-row menu, and top-menu Cut/Copy must all keep both selected files.
- Folder-row `Paste` targets that folder. `Paste into root folder` targets root. Do not click that
  root item on a real home tree. The sidebar `Paste files` toolbar targets the open folder, or the
  open file's parent, and it unmounts when the sidebar is closed. The folder-view header Paste
  targets the open folder only; a file view has no header Paste. Read `aria-describedby` to confirm
  the destination. Check the resulting parent ids with Convex.
- Sidebar Control+C / Control+X copy the **selected** rows, not the focused row. Arrow keys move
  focus only. After clicking a folder, ArrowDown onto a child and Control+C still copies the folder.
  A selected row's accessible name can end with `ready to move` after Control+X. Escape clears an
  idle cut. In the folder table, focus `Open <name>` before the shortcut — that table uses the
  focused row. Repeat shortcuts in Search files, rename, Monaco, rich text, and chat: they must
  keep normal text behavior.
- Open an archived QA folder with a non-empty clipboard. Header and sidebar Paste must both stay
  disabled, and their descriptions must keep that folder's name with Show archived on or off.
  A missing route target must also stay disabled without naming root. The Show archived checkbox
  label is `Show N item(s) archived` / `Hide N item(s) archived`; press Escape after toggling it.
  In the same view, `New file`, `New folder` and `Create a README.md` inside
  `[aria-label="File content"]` must be disabled, and the top `role=status` surface must say
  `This folder is archived. Restore it before adding items.` Read `button.disabled` from page
  context; the snapshot does not show disabled state. To prove the deployed create doors refuse
  too, run `convex run files_nodes_content:get_create_file_node_write_preflight` with the archived
  folder as `parentId`: it prints nothing (null) for an archived parent and an object for root.
- While a submitted New folder action is pending, Paste must say
  `Wait for the current file operation to finish.` and become available when creation completes.
  A Cut/Paste dialog can briefly say `Paste files` while loading, then `Move files`; it must never
  show `Copy files` for that run. A MutationObserver installed before Paste can record this transition.
- Closing the files sidebar unmounts the tree. Reopen with `Open files sidebar` before any
  treeitem work. `.FilesTransferRunModal` has two `Close` buttons; scope the footer ghost
  button or use `.nth()`.
- Repeat Copy into the same destination to reach `.FilesTransferRunModal`. Each conflict is a
  fieldset named after its full source path. Check same-name files from two folders have distinct
  fieldset names. Click the visible radio label for `Keep both` or `Skip`.
  `Apply to remaining name conflicts` starts at `Ask each time`. Continue stays disabled until
  every visible conflict has a choice or a valid apply-to-remaining choice.
- Hide the dialog and reopen it from Activity with `Review conflicts` or `View progress`. Reload
  while a run is waiting: local clipboard marks disappear, but Activity must still reopen it.
  A changed source offers Skip or Stop and must not expose Keep both.
- After opening from Activity, scope choices and Stop to `.FilesTransferRunModal`: the Activity
  popover may still contain a second Stop button. Radio `press("Space")` and button `press("Enter")`
  exercise the keyboard flow. Keep both targets in the page; do not choose an unscoped first match.
- Once at least one copy is published, stop with `Stop and keep completed copies` and read back both the run
  and copied nodes. Completed copies stay. Canceled Activity says `Stopped`; only terminal runs
  offer Dismiss. A failed Stop request must show an error without claiming the run stopped.
- For offline Stop, create a QA name conflict and reload while it waits. Open Notifications with
  focus + Enter if the Playwriter toolbar covers it. Use `getCDPSession({ page: state.page })`,
  `Network.enable`, then `Network.emulateNetworkConditions` with `{ offline: true, latency: 0,
downloadThroughput: -1, uploadThroughput: -1 }`. This affects only the owned QA tab.
  Click Cancel in Activity. It must say `Stop requested. Waiting for the server…` and disable Cancel.
  Open Review conflicts for the first time while offline: the dialog must keep that message even
  before its run query loads. Hide and reopen both views; the message must stay. Restore the same
  network settings with `offline: false`, then verify the saved result and final status. Do not
  treat a click as server confirmation or use browser-context offline mode on a shared profile.
- Check Activity with enough history to scroll. Each card must keep its full height, with readable
  status and clickable progress/Stop controls. Flex shrinking previously clipped cards to a few
  pixels; `.AppNotificationsActivityItem` now keeps its size while the list scrolls.
- Read progress through `files_transfer.get({ membershipId, runId })` and enumerate all tree pages
  after completion. Assert ids and parent ids for moves; new ids, names, and saved content for
  copies. Clipboard readiness alone does not prove a successful paste.
- For folder Cut permissions, use a [second member](second-user-fixtures.md). As owner, restrict a
  child folder inside an ordinary source folder. With no child grant, member Cut/Paste of the parent
  must fail with `Permission denied` and zero moved. Owner readback must show every original path
  and scope unchanged. Give the member `write` on the restricted child and repeat: the move must
  succeed and keep that child's scope. Unit tests also cover read-only grants and archived children.
- **Where `Upload file` actually is** (verified 2026-09-15): the sidebar toolbar's `More options`
  button, whose menu is `Cut`, `Copy`, `Paste into root folder`, `Upload file`, `Import folder`. It
  uploads into the **currently selected** folder, so select the target node first (open
  `/files?nodeId=<folder id>`) even though the Paste entry says "root folder". Drive it with
  `state.page.waitForEvent("filechooser")` started before the click, then
  `chooser.setFiles("C:/absolute/path")`; under a Windows relay a Windows path works. A 14 KB PNG
  needs ~20 s before the node appears. It is **not** on a row's `More actions` menu (that menu is
  Cut/Copy/Paste/Copy path/Copy link/Copy node id/Rename/Expand subtree/Collapse subtree/Share/
  Properties/Archive). Do not go looking for it behind the row's `Add file to <folder>` button or
  the toolbar's `New file` button: neither opens a menu, both immediately create a `new-file.md`
  node in inline-rename mode, so probing them litters the tree with files you then have to archive.
- For a small stored-file check, choose `Upload file` in an isolated folder and give its file chooser
  a known `application/octet-stream` buffer named with a `.bin` extension. Copy it through the menu.
  Sign both downloads, compare every byte, and check the copied file has a different asset id.
- To check an unfinished upload, hold only that chooser upload's signed R2 PUT with a Playwright
  route. Copy its parent into an empty QA destination while the PUT waits. Progress and Activity
  must show `The source file is still saving. Try again.`; the completed parent folder stays.
  Always release the held request, remove the route, and wait for the source upload to finish.
- Check a long source path in the conflict dialog at a 390px viewport. Its legend must wrap, the
  footer must fit, and radio labels must remain usable. The radio input itself is 18px; its label
  supplies the 36px hit target. Restore the viewport before continuing.

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
- Archive from the row menu opens the confirm dialog first (`getByRole("dialog", { name: /^Archive / })`); confirm with its `Archive` button. Restore is still direct.
- To make a restore behave as a **move**, archive the parent folder and then restore the child alone: its parent is still archived, so the restore relocates it to root. That is the only in-app route to the leaving check. Ground truth is the child's `path`, `parentId` and `restrictedScopeNodeId` in `list_tree`; a successful owner restore moves it to root and clears the scope pointer.
- Reveal archived rows with the sidebar `More options` → `Show N items archived` (`menuitemcheckbox`). It does **not** close the menu on click, so press `Escape` after, and it is **not persisted** — any route load resets it to off, so re-read `aria-checked` instead of assuming your earlier toggle survived. Archived rows inside a collapsed folder stay hidden until you expand that folder, so expand it before counting them.
- Restoring a folder that carries its own restriction must bring it back still restricted (`restrictedScopeNodeId` unchanged, row label keeps ` restricted`).
- The owner bypasses every permission check, so owner-only runs prove **no over-refusal**, never that the refusal works. The refusal needs a second member holding a `content.write` grant on the folder. Get that member without any sign-in by following `references/second-user-fixtures.md`: an anonymous user in a scratch browser, invited by `userIdToAdd` into a throwaway non-default org. Verified end to end — a `member` with only `write` archives the folder fine, is refused on restoring the child alone with `You need Can manage on the shared folder to move this out of it.`, and still restores the scope-carrying folder itself.
- A `write`-only member **can** archive the restricted folder. The hole this guards is the pair: archive the folder, then restore one file out of it. With the leaving check removed, that same click succeeds and clears the child's `restrictedScopeNodeId` to `null` at root — the file becomes readable by the whole workspace. Count that pointer, not the toast, when proving the guard.

### File And Folder Write Policies

Use a throwaway non-default organization and follow `second-user-fixtures.md` for a normal member who
does not hold `content.permissions.manage`. Keep owner and member sessions open together so live races
do not depend on signing in or out.

- Fixture: one directly locked file, one locked folder with rich/plain/nested descendants, one free
  folder, and one unlocked outer folder with a locked child plus writable sibling. Create one pending
  content proposal before locking.
- In Properties, use `.FilesPropertiesModalWritePolicy`: radios are `Editable`, `Read-only`, and
  `Selected writer`. Click `Read-only`, then `Save policy`. There is no `Inherit` radio and no
  `Open parent policy`. Unlock later with `Editable` + `Save policy`. A member without management
  rights gets disabled policy controls.
  Query `list_tree` as each identity and assert `canWrite`, `writeBlockedReason`, and
  `writePolicyState`. Policy presence alone does not mean that the current writer is blocked.
- Assert the exact accessible row descriptions for a lock on that node, and for an unlocked folder
  that contains read-only items. A parent lock does not mark the child `read-only from /path`.
  Locked rows must still open, expand, search, and expose safe Copy and Share actions.
- Try F2/menu rename, source drag, folder drops, archive/restore, mixed-selection archive, New file,
  New folder, `Create a README.md`, Upload, and Import folder. Check the tree and pending rows after each
  refusal; a toast alone does not prove zero writes. Archive and mixed-selection archive go through
  the confirm dialog: a refused archive shows its `alert` inside the dialog and leaves it open. Copy a locked source with the row menu exact
  `Copy` (not `Copy path`), then folder-row `Paste`. The transfer dialog reports `1 copied` and the
  destination path. The new copy keeps the source lock (`data-file-write-policy="read_only"`,
  `"<name>, Read-only"`, editor `contenteditable=false`). Verified 2026-09-18.
- Start rename, create/upload UI, drag, and a dirty editor in the member session. Lock from the owner
  session. Assert each UI cancels or disables live, keeps useful draft text copyable, announces why,
  and returns or moves focus as documented in the plan.
- For a signed-upload race, mint the target first, lock the file itself, then finish the PUT. The
  existing node must publish normally, become downloadable, and keep its local lock. Read back the live
  `r2Key`, cleared `unfinalizedExpiresAt`, normal processing completion, and the expected upload plugin
  run. Reuse the signed staging URL and prove the immutable live bytes do not change.
- Run `auditAccessibility({ selector: "body", minTargetSize: 24 })`, then separately audit the lock
  modal and Pending panel. Also check keyboard focus, Escape/focus return, 200% zoom, 360 px width,
  contrast, target sizes, and reduced motion.

### Service Account Key And Protected Log

Verified through native UI and HTTP on 2026-09-08. This checks a script account without creating
plugin installations, runs, service grants, or upload targets. Use only a unique QA folder, two new
accounts, and their own keys. Keep the existing signed-in identity.

1. Create and rename the QA folder through Files. Restrict it through Share → `Restrict access`.
   On `/w/<org>/<workspace>/service-accounts`, use `Create account`, textbox `Name`, and `Save account`.
   Confirm new accounts have no grants. Scope repeated row actions with `data-service-account-id`.
2. On account A, choose `Manage grants`. In `Access for <name>`, select Resource `File or folder`,
   enter `File or folder path`, and choose Access level `Can manage`. Confirm `This restricted scope`
   before `Save grant`. A normal folder's `This item only` grant does not grant its descendants access.
3. Use A's `Create API key` link. It preselects Identity. Bound accounts offer only `List files`,
   `Read file content`, `Download files`, `Write files`, and `Manage file policies`. Click checkbox
   labels, not their covered 1px inputs. After creation or rotation, keep the revealed key only in
   memory. Read `.RouteApiKeysRevealModal [aria-label="New API key"]`, then close with `I saved the key`
   before any snapshot or screenshot. For `Test key`, read only `.RouteApiKeysVerificationStatus`,
   never the reveal dialog's full text.
4. In folder Properties, save Selected writer → Writer type `Service account` → A. With A's key,
   POST `/api/v1/files/write` twice to create and update a short `<QA path>/run.md` log. Pair this with
   `/files/read`, `/files/list`, and `/files/download-urls` under `/api/v1`. Download into memory;
   save only expected bytes, length, MIME, and hash. `/api/v1/auth/verify` shows account and sponsor IDs.
5. Change A's grant to `Can view`: read succeeds, write returns 403. Remove its grant: read returns
   404 and write 403. Restore `Can manage` and prove the same write succeeds. Give B the same QA grant
   and a key with `Write files` only. B's write to A's protected log returns 409. B's policy setter
   returns 403 without `files:permissions`; A's same setter succeeds. Check unchanged bytes after each
   refusal. Selecting Read-only also refuses A's write with 409.
6. Select the current human through Properties and save one native editor change. Read it after
   reload, then restore A's policy. Native `Rotate <key name>` → `Rotate key` keeps account, sponsor,
   and scopes. The old key must return 401; the new key must update and read the same log successfully.
   Account `Revoke` → `Revoke account` then makes the new key return 401 while the policy stays set.
7. Read state through fresh public queries: `access_control.get_service_account`,
   `list_service_account_grants`, `public_api.api_credentials_list` (a Result with `_yay` array), and
   `files_nodes.get_node_write_policy_management_state`. Keep all created IDs in a safe manifest.
   A no-plugin claim needs a separate complete, paged database check for references to those IDs.
8. Clear only the QA policy with Editable → `Save policy`; remove A/B's grants, revoke their keys and
   accounts, then archive the QA folder. Revoked accounts still offer `Manage grants` and `Remove`.
   Confirm every created key is revoked, both grant pages are empty and complete, and both nodes have
   no policy and share an archive operation. Clear secrets from memory and close only the owned tab.

Wait for saved UI state before fresh readback. A click can return before its mutation; after a timeout
or HMR, read state before retrying. For the grant dialog's quick accessibility screen, the 1px
`Dismiss popup` button is a visually hidden library control. Check the visible controls separately.
Keep desktop/narrow screenshots away from key reveals and do not claim a full focus-trap audit.

### Non-Collaborative File Fixture

Use this when a check needs a file with collaboration turned off (a Council-note-shaped file). Build your own; never edit or delete the read-only Council meeting notes under `/meetings/`, they are shared QA fixtures.

For a **read-only** check you do not need to build anything: list the ones the dev deployment already
has. Use `--format jsonLines` and filter on `collaborationEnabled`, which is required and null for
non-text nodes. Read named fields instead of relying on the table's column order.

```powershell
vp env exec pnpm --dir packages/app exec convex data files_nodes --limit 1000 --format jsonLines
```

Keep the docs where `"collaborationEnabled": false`, then open one straight from its id with
`/w/<org>/<workspace>/files?nodeId=<_id>`. On 2026-09-04 that returned two docs, both Chitchat
transcripts (`/chitchat/general.md` and `/chitchat/park.md`), with rich text shape and read-only,
which is enough to check how the non-collaborative rich editor renders but not to type in it.

To build a writable one, follow the UI steps below.

1. Create a `.md` file from the sidebar. A new file is collaborative.
2. Open it, switch to the **Markdown** view, and give it a body that carries a real Markdown escape, for example a line holding `2026\-08\-30`. Save.
3. Open the breadcrumb Properties dialog (see "File Properties Modal" below for its two click hazards) and uncheck `Collaboration` by clicking its label, `.FilesPropertiesModalCollaboration-checkbox`. Focusing the 1px input and pressing Space does NOT toggle it (tried 2026-08-31: the input stayed `checked`), so use the label. The confirmation is not a separate dialog — it appears INSIDE the properties modal as a `Turn collaboration off` / `Cancel` pair, so do not wait for a new `[role=dialog]` to show up.
4. For a read-only variant, choose `Read-only` in the write-policy radios, then click `Save policy`. Unlock with `Editable` + `Save policy`.
5. Reopen the dialog and read both states back before you start the checks.

The rich view must then render the content un-escaped (`2026-08-30`) while the Markdown view shows the raw bytes. Selectors and behaviors of the non-collaborative rich and diff editors are in `file-node-view.md` under "Non-Collaborative Editors (No Yjs)".

For a plain-text fixture, upload a small `.txt` file with `text/plain` content type, then turn
collaboration off. Confirm the stored `textKind` is `plain_text`. The sidebar's `create_text_node`
door creates Markdown, even with a `.txt` name; a rename does not change the stored type or shape.

### Folder Import

Use this after changing the bulk import flow (`run_folder_import` in `files-sidebar.tsx`, `files_nodes.create_upload_nodes`).

- The two upload entry points call **different** mutations: `Import folder` → `files_nodes.create_upload_nodes` (plural), single `Upload file` → `files_nodes.create_upload_node` (singular). Check which one your change touches before designing the browser check.
- `create_upload_node`'s intermediate-path walk is **not reachable from the sidebar**: `uploadBrowserFile` normalizes the name first (`files_normalize_upload_file_name` keeps only the leaf segment, `files_normalize_markdown_name` turns separators into `-`), so the filename always arrives without slashes and the walk loop never runs. It is a public mutation, so drive it directly through `app_convex.mutation(...)` with a real multi-segment `filename` when you need to exercise that walk.
- To prove an "answer before anything is written" fix, count the asset docs rather than reading the message — a pre-write and a post-write refusal can return the identical string. `convex data files_r2_assets --limit 400 --order desc --format jsonLines`, filtered to `"kind": "upload"`, is a read-only ground truth; the editor's own `content_snapshot`/`yjs_snapshot` rows churn constantly, so never use "newest row unchanged" without filtering by kind. An orphan asset left by a refused upload is reaped by the hourly `cleanup expired unfinalized assets` cron, so it needs no manual cleanup.

- Entry points: `More options` menu → `Import folder` (hidden `input[type=file][webkitdirectory]`), and multi-file/folder drops. The OS dialog cannot be fed in extension mode — use the constructed-File recipe in `known-hazards.md` ("File uploads cannot go through the OS file dialog"): predefine `path` on each `File`, assign `input.files`, dispatch a bubbling `change` event on the directory input.
- First import of a nested fixture should recreate the folder structure; `readme.md` (markdown MIME) lands as `README.md`, `*.markdown` lands as `*.md`, `.DS_Store`/`Thumbs.db` and extension-less files never appear. Verify via `app_convex.query(app_convex_api.files_nodes.list_tree, { membershipId })` paths, not the sidebar alone.
- Re-importing the same fixture opens `.FilesSidebarImportConflictModal` listing the existing paths, with buttons `Cancel import`, `Skip existing`, `Replace existing`; `Escape` cancels. Replace soft-archives the old node (old id gains `archiveOperationId`, new id appears at the same path — `list_tree` returns both, so filter archived rows before asserting).
- The progress toast (`Preparing files to import...` / `Uploading N of M files...`) carries a `Cancel` action; after a cancel, files under the import prefix must equal the summary's imported count (no phantom "waiting for upload" rows). The summary toast (`Import finished/cancelled: N imported, ...`) auto-dismisses in ~4s — read it in the same execute call or from `latestLogs` (`[FilesSidebar.runFolderImport] Skipped files`).
- Row UI during upload (the `Uploading` pill) only renders for visible rows: the tree is virtualized, so expand the destination folder (click the row, then `ArrowRight`) and scroll it into view before asserting. A missing pill on a collapsed or below-fold row proves nothing. Verified 2026-09-18.
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
- Verify the edit step uses `Edit file` or a Bash write and leaves reviewable pending content.
- Review/apply via `[data-testid="review-changes-button"]`.
- In Agent mode, ask Bash to `mv` a file to a new path and verify the Pending tab shows a move proposal before acceptance. Test both a rename and a move between folders.
- Ask Bash to `cp` a file to a new path and to an occupied path. Verify the Pending tab shows the copy or replacement proposal and that committed files stay unchanged until acceptance.
- For a mixed move plus content proposal, accept it and verify the move is applied before the updated content is saved.
- In Agent mode, shell writes ARE supported. `cat > path <<'EOF' ... EOF`, `>`, `>>`, and app-to-app `cp` create reviewable pending content in both collaboration modes (changed 2026-09-06; before that a target with collaboration off saved immediately). App-to-app `mv` and `rm` stay pending structural proposals (`rm` archives on acceptance). Verified 2026-08-21; the older "writes are unsupported" note here was stale. Links are still not shell operations, and app-to-`/tmp` copy stays immediate thread scratch.
- Whole-file `cp` (verified 2026-09-05, after the content type policy landed): a copy carries the source's content, content type, and document shape onto the destination, whatever the destination's name says, so `cp a.md b.txt` makes `b.txt` a Markdown file that opens in the rich text editor, and `cp a.md shapes.png` turns the image node into a Markdown file. A new text destination inherits the source's collaboration mode; an existing text destination keeps its own mode. Build the fixtures without typing: `files_nodes.create_folder_node` from page context (`{ membershipId, parentId: "root", path: "<folder>" }`), select the folder row, then `setInputFiles` on the sidebar input for `r2-upload-markdown-sample.md`, `qa-plain.txt`, and `shapes.png` (one call each, ~3 s apart; the text nodes get their `textKind` a few seconds later). Ask the agent for exact commands with the prompt prefix from "Indexed Frontmatter Metadata" below, and use workspace-relative paths (`cp qa-x/a.md qa-x/b.txt`): the shell's cwd is the workspace root, and a leading `/` answers `cannot stat`. Expected stdout: `pending copy created: /qa-x/a.md -> /qa-x/b.txt — replaces the existing file's content and type when accepted; review in Files` for an existing destination (`— review in Files` for a new one), in both collaboration modes (since 2026-09-06). Accept it in the Pending tab with `getByRole("button", { name: "Accept changes to /qa-x/b.txt" })`. In `list_tree` the destination keeps its `_id` and `yjsSnapshotId` (the lineage is swapped in place), while `contentType` and `textKind` become the source's. Its `assetId` points at the copied content asset, which may be rebuilt when Markdown is normalized. Restore proves the other direction: `Open file snapshots` on the destination lists the replaced content as a version (`3m ago`, with the plain token in its preview), `Confirm` brings back `text/plain;charset=utf-8` and the Code editor with no reload (poll `[aria-label="Text editor actions"]` and `window.__qa.monaco().plainText.getValue()`). A rich text document that embeds the replaced image (`![x](bonobo-file://<nodeId>)` in an uploaded `.md`) shows `File is not an image or video anymore` in the node view after the accept.

### Indexed Frontmatter Metadata Through The Agent

Use this to verify backend changes to `files_metadata` (extraction, `meta search`, `meta get`) from the running app without touching the user's own files. Verified 2026-08-03.

- Drive the checks by asking the agent to run exact Bash commands: prefix the prompt with "Run exactly these Bash commands, one per Bash call, in this order. Do not modify them. Show the raw stdout and stderr of each. Do not summarize." Without that, the agent rewrites commands or reports a summary instead of output.
- Read results from `[aria-label="Bash terminal output"]` via `textContent`, not the assistant's prose.
- Create the fixture with a heredoc write (`cat > qa-<topic>/a.md <<'EOF' ... EOF`) instead of editing real files. The write is a pending proposal, and pending metadata docs are indexed and overlaid for the acting user, so `meta search` and `meta get` already see them — no acceptance needed for a read-path check.
- Copy the real frontmatter shape you care about. Sybill meeting files quote their dates: `realStartTime: "2026-07-29T19:00:00.000Z"`.
- Clean up the private fixture through the Pending tab. Select its folder and all its child proposals, then use Discard. A ready child outside that selection must require review. Discarding only a child leaves its private parent proposal. Check that the fixture disappears from owner reads, then verify private cleanup releases its node and storage holds. No saved folder should need archiving unless the fixture was saved first.
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
- In Agent mode, ask it to run `echo draft > /home/cloud-usr/w/personal/home/<unique-qa-name>.md`; verify a private proposal appears and `cat` reads it before Save. In Ask mode, the same write must fail without creating a proposal.
- Ask it to make one real Markdown edit; verify the new turn uses `edit_file` or Bash and leaves the change pending.
- **`sed -i` does not work on app files.** The db-backed tree exposes a fixed command set, and `sed` is not in it: `sed -i 's/a/b/' u39/target.md` answers `sed: u39/target.md: No such file or directory` plus `Native Just Bash /tmp commands cannot access app files directly`. To make a content proposal with an exact text, ask the agent for `printf '<the whole new file>' > <path>` instead — that writes the file the tool does know about and produces one proposal per file. Verified 2026-09-15.
- **Pick fixture names that no name rule rewrites.** The Bash writer leaves an existing occupant's path alone, but a **missing** target is normalized before the file is created (`server/bash-utils.ts:600-660`), and `readme` in any casing becomes `README.md` (`shared/files.test.ts:937-940`). So `mv u05/readme.md u05/guide.md ; echo new > u05/readme.md` puts the new private node at `/u05/README.md`, not at the path you vacated, and the case you were testing quietly stops being the case you meant. `create_text_node` called directly does **not** normalize, so a door-built fixture and a Bash-written file can sit at two different paths for the same requested name. Use a neutral name such as `notes.md`. Verified 2026-09-15.
- **The two writers answer that name rule differently, so pick your check deliberately.** A redirect refuses: `echo hello > 'my other.md'` exits 1 with `cannot write '<path>/my other.md': app file names are normalized; write to '<path>/my-other.md' instead`. A `cp` renames silently and still reports `1 ready for review`: `my copy.md` lands at `my-copy.md`, `café 🎉-copy.md` at `cafe-copy.md`, `-weird-copy.md` at `weird-copy.md`. The transfer's success line never names the output path, so always read the destination back from `files_visible.list` instead of trusting the command's own output. Verified 2026-09-15.
- `cd` works in the agent shell, the terminal footer reports it (`exit 0 · cwd changed: /home/cloud-usr/w/<org>/<ws> -> /home/cloud-usr/w/<org>/<ws>/u10`), and the new cwd **persists into later turns of the same chat**. A runner that sends workspace-relative paths after an earlier `cd` will address the wrong folder, so either `cd` back or keep every command anchored at the workspace root. Verified 2026-09-15.
- After a `cp -R`, the private nodes appear in `files_visible.list` before their rows appear in `files_pending_updates.list_files_pending_updates`. A read 8 s after the agent turn finished showed 5 of 8 rows; a re-read showed all 8. Poll the pending list until its count stops changing before asserting a missing row. Verified 2026-09-15.
- **`sha256sum` and `cmp` are not in that command set either**, so you cannot checksum or diff two app files from inside the agent's shell — both answer `No such file or directory` followed by the same `Native Just Bash /tmp commands cannot access app files directly` note. To compare content, use `stat` for size and `cat` for text, or read the nodes through Convex in page context. There is no digest to read on the server side either: `files_r2_assets` (`convex/schema.ts:1660`) stores `size`, `r2Key` and `kind`, but no hash column. Verified 2026-09-15.
- Inspect the latest assistant tool parts and verify new turns do not show legacy `Read file`, `List files`, `Glob files`, `Grep files`, or `Search files` disclosures unless they came from older transcript history.

### Pending Copy Onto A Collaborative File

Use this after changing bash `cp`, `pendingReplacement` accept, or the version rows a replacement writes. Verified 2026-09-06.

- Fixture: create an `aaa-pw-qa-*` folder with `files_nodes.create_folder_node` from page context, open it, and upload `qa-plain.json` (the source) and `r2-upload-markdown-sample.md` (a collaborative Markdown target) through `.FilesSidebar input[type=file]:not([webkitdirectory])`. For a second Markdown target call `files_nodes_content.create_text_node({ membershipId, parentId: <folderId>, path: "/target-b.md" })` — the `path` is relative to `parentId` (see the hazard in `known-hazards.md`).
- Copy through the Agent chat with the "Run exactly these Bash commands" prompt and one `cp /home/cloud-usr/w/personal/home/<folder>/qa-plain.json /home/cloud-usr/w/personal/home/<folder>/<target>.md`. The Bash output must end with `replaces the existing file's content and type when accepted; review in Files`; a line that ends with only `review in Files` means the destination did not exist and the copy created a new file.
- Write refusal: a following `echo edited > <same target>` must exit 1 with `This file has a pending copy. Accept or discard the copy in Files before writing to the file.`, and the Pending tab row keeps `Replaced`.
- Versions: read `files_nodes.get_file_snapshots_list({ membershipId, nodeId, showArchived: false })` before and after. Each snapshot has required `contentType`, nullable `yjsRootKind`, and positive `collaborationEnabled`; stored-byte snapshots use `null` and `false`. Use the returned order to match UI rows; an unarchived version can lead the list. Accepting the copy on a file with no unsaved edit adds exactly one row (the copy); with an unsaved edit it adds two (a Markdown row for the edit, then the copy). `files_nodes.create_file_snapshot_content_url({ membershipId, nodeId, snapshotId })` returns a URL that `fetch` reads from page context, which is how to prove the backup row holds the typed text.
- Unsaved-edit timing: `cp` first, then type in `.FileEditorRichText-editor-content`, wait about 3 s for the push, and click `Accept changes to <path>` in the Pending tab within 30 s of the last keystroke. The materializer runs 30 s after the last update and moves the file's asset, after which the accept refuses with `The file changed after this copy was proposed. Discard the copy and copy again.` — discard, `cp` again, type again.
- Break on purpose: an early `return Result({ _nay: { name: "nay", message: "PROBE-<runid>" } })` at the top of `files_nodes_reconstruct_latest_file_content_from_materialization_state` (`convex/files_nodes_reconstruct_content.ts`) makes the unsaved-edit accept fail with that toast and leaves the row pending. Read the toast from `[data-sonner-toast]` in the same call. Revert, wait for the watcher push, and repeat the accept with a fresh copy.

### Pending Proposal Under A Lock

Use this to check the desktop rule on pending proposals: Save and Accept must read the live lock,
keep the proposal, and accept the retry after unlock. Verified 2026-09-18 through the real editor
and review UI (not page-context doors).

- Create a throwaway `aaa-*-qa-*.md` with the sidebar `New file` button, then rename. Collaboration
  starts ON. Turn it OFF in Properties (click `.FilesPropertiesModalCollaboration-checkbox`, then
  keyboard-confirm `Turn collaboration off`) so the real `Save` button exists. Type in
  `.FileEditorRichTextNonCollab-editor-content` and click `Save`.
- Create the proposal from the Agent tab: new chat, then the "Run exactly these Bash commands"
  prompt and one `printf` / `echo` write to that path. Wait until
  `.FileEditorSidebarPendingTabBadge` shows a count.
- Lock the **file itself** (not a parent). Breadcrumb `getByRole("button", { name: /^Properties of / })`
  — click the box middle with `page.mouse.click` if locator click hangs. Scope to
  `[data-files-properties-modal][data-open="true"]`. Radios are `Editable`, `Read-only`,
  `Selected writer`. Click `Read-only`, then `Save policy`. The row becomes `"<name>, Read-only"`.
- Open `#app_file_editor_sidebar_tabs_pending`. The row button is
  `Accept changes to /<path>` (leading slash). While locked it stays **disabled**, the editor
  `contenteditable` is `false`, and `Save` stays disabled. The proposal row remains. Do not use
  `{ force: true }`.
- Unlock with `Editable` + `Save policy`. The same Accept button enables. Click it. The review
  dialog says `Changes saved.` / `1 saved`. The badge and Accept row go away. Close the dialog
  with `[role=dialog][data-open=true] button[data-dialog-dismiss]` (the dialog has two `Close`
  buttons).
- A parent lock does not block this file. Locks are local.

Page-context helpers (`files_upsert_file_pending_update`, `set_node_write_policy`, review-run
`start`/`seal`) still exist for runners, but they are not the UI proof.

### Saved Snapshot Fields And History

Verified 2026-09-07 with rich and plain text in both collaboration modes, plus PNG and invalid UTF-8 uploads.

- Open history with `getByRole("button", { name: "Open file snapshots", exact: true })`. Scope to `.FileEditorSnapshotsModal:visible`; closed modals stay mounted. Match `.FileEditorSnapshotsModalListItem` by the current query order, then activate its `.FileEditorSnapshotsModalListItem-primary-button`. Wait for preview loading to finish before asserting content or whether `Confirm` is enabled.
- Preview scope is `.FileEditorSnapshotsModalPreviewModal:visible`. `Newer` and `Older` move through the current list. It is a word diff: recover the selected text by joining `.FileEditorSnapshotsModalPreviewModalDiffBlock-word:not(.FileEditorSnapshotsModalPreviewModalDiffBlock-removed)` text, not the whole modal text. `Cancel` or Escape returns focus to the selected row; closing the list returns focus to the history trigger.
- `Show archived` is a switch; use Space and read `isChecked()`. `showArchived: true` returns only archived versions. The row's `Restore` button unarchives the version; preview `Confirm` restores its content. Archive and unarchive must leave the current asset and text unchanged. A read-only file still allows preview and download, while archive, unarchive, and content restore are disabled.
- `create_file_snapshot_content_url` returns nullable `{ url, snapshotId, _creationTime }`, not a Result. Fetch that URL without printing it. Compare the response MIME, byte count, and SHA-256 to the saved version, even when the current node has another MIME with the same text shape. `r2.create_signed_download_url` instead returns a Result with `_yay.url` for the current file.
- Create stored backups through actual upload, then accepted `cp` replacement. For API-only byte restore, use `files_nodes_content.restore_snapshot_r2({ membershipId, nodeId, snapshotId, sessionId })`; `sessionId` is a run-owned UUID. An ON text destination refuses stored bytes until collaboration is turned OFF in Properties. Restored stored bytes keep their exact bytes and MIME; the node has null text kind and mode, and its snapshot has null root and false collaboration.
- Restoring text onto an editable destination keeps its current mode. Restoring text onto a stored destination uses the saved mode. For both shapes, save an ON and an OFF version, restore each into the opposite current mode, and compare text and Yjs pointer behavior. For saved MIME, copy JSON over a plain text node, then restore its older TXT version: the MIME returns to TXT while its current ON mode and live Yjs pointers stay unchanged.
- Audit the visible list and preview separately using their class selectors without `:visible` in `auditAccessibility` (that helper uses native CSS). Preview controls passed at desktop and 512×384; narrow content scrolls while Cancel and Confirm remain visible. The timestamp button's 21px height is a quick-screen warning; also inspect the larger clickable row before reporting a target-size failure. Follow the viewport-cache and hidden-radio recipes in `known-hazards.md`.

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

### Sidebar Search Box

Selectors and a proven flow for the sidebar search box with metadata filters (verified 2026-09-05).

- `Add search filter` opens the suggestions and focuses the input. Pick the `status text` option, then `open`; check that the chip appears and `.FilesSearchInput-summary` shows the match count. `Clear search` clears both text and chips, removes `q` after the debounce, and returns focus to the input.
- Check wrapping by temporarily setting `.FilesSearchInput` to `width: 240px` through `locator.evaluate`. Add three filters and confirm they wrap without horizontal overflow. Restore the inline width afterward. The chip area stops growing at 96px and scrolls vertically for long queries; keyboard arrows still reach every remove button.
- Invalid filters show a visible reason in `.FilesSearchInput-error`. The existing sr-only status still announces changes. The filter popover is a dialog named `Search filters`; its `Filter syntax` disclosure must open by keyboard and keep the examples reachable in short viewports.

- Input: `#app_files_sidebar_search input` (role `combobox`, name `Search files by name, path, or key:value filters`). Focus it with `page.mouse.move(400, 400)` then `input.focus()`. After a keyboard chip removal the focused remove button's tooltip can sit over the input, and `locator.click()` then fails with `subtree intercepts pointer events`.
- Chips: `.FilesSearchInputFilterChip` (label in `.MyChipLabel`, remove button named `Remove filter <raw>`). An invalid one adds `.FilesSearchInputFilterChip-invalid`, and its remove button's `aria-describedby` carries the reason. The chip row is a list named `Search filters`. Labels show a key and value, such as `Path /tasks`; raw tokens stay in the hover title and remove-button name.
- Suggestions: `.FilesSearchInput-popover [role=option]` grouped under `Properties`, `File details`, and `Values for <key>`; the listbox is named `Search suggestions`; the short hint and expandable `Filter syntax` section sit outside it. Key rows read like `priority number`; their hover title includes the metadata kind.
- Status: `.FilesSidebarTopSection [role=status]` (sr-only) reads `Added filter status:open. 4 matches`, `Searching…`, `Search failed`, or `Filter x cannot run. <reason>`. The tree empty state `.FilesSidebarTree-empty-state` shows `Searching…` while a metadata answer is pending, `The search failed. Change a filter to try again.` when a chip's query threw, and `No files match your search.` when it is empty. The doors answer bad input with their empty shape, so the failed state needs a working-tree throw in `search_nodes` to see it.
- An open quote commits as a closed chip: `assignee:"Denys` + Enter makes the chip `assignee:"Denys"`, and a chip typed after it stays separate. `"raw-media"` as free text stays in the box and in `?q=` with its quotes, and matches the name without them.
- Type `status:open` and press `Enter` to commit a chip; the debounced `q` param follows in ~300 ms. Read the results as the `aria-label` of each `[role=treeitem]` that ends with `.md`, about 1 s after the commit.
- After typing a file name into sidebar search, press Escape to close suggestions **before** clicking a row. A click while the suggestion popover is open can commit a `due:` filter (`?q=…+due%3A`) and empty the tree. Clear that with Control+A, Backspace in the search input (verified 2026-09-18).
- Clear every chip from the keyboard: focus the empty input, `Backspace` (focuses the last chip's remove button), `Enter`, repeat until `.FilesSearchInputFilterChip` counts 0. Escape closes suggestions and keeps text and chips. Use Clear search to clear everything.
- Space commits only the complete filters in the text, and only with the caret at the end. `priority:>high status:open` plus Space leaves `priority:>high ` in the input and makes one `status:open` chip; Enter commits the broken one as an invalid chip. With the caret in the middle, Space just types a space (`input.setSelectionRange(n, n)` before `keyboard.press("Space")`).
- Enter inside the 300 ms debounce: remove the last chip with `.FilesSearchInputFilterChip button` `.last().click()`, `focus()` the input, press Enter at once. With a metadata chip in the query the status reads "Still searching. Press Enter again when the results are in" and `?nodeId=` stays; with only `file.*` chips and text the match opens right away (`?nodeId=` becomes the file id). The `/tasks` folder in the dev workspace holds the fixture files (`/tasks-archive` holds one): scope to `/tasks` and read the first `aria-label` ending in `.md`. The folder rows are capped and sorted, so `file.path:/` never reaches `/tasks`; type `file.path:/tasks` to list the two.
- IME guard: a key pressed while a composition is active commits nothing. Drive it over CDP through the harness global `getCDPSession({ page })` (never `page.context().newCDPSession`, see known-hazards): `Input.imeSetComposition({ text: "こん", selectionStart: 2, selectionEnd: 2 })` shows the composing text in the input, then a keyCode-229 key (`Input.dispatchKeyEvent({ type: "keyDown", key: "Process", code: "Space", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })` plus its `keyUp`) for Space and for Enter leaves 0 chips and the text unchanged. Chrome has no `Input.imeCommitComposition`; `Input.insertText` ends a composition. Positive control: End + Space outside the composition commits the chip (verified 2026-09-05).
- Page-context doors for a positive control or a second identity, with `m = await import("/src/lib/app-convex-client.ts")` and `q = await import("/shared/files-search-query.ts")`: `m.app_convex.query(m.app_convex_api.files_metadata.search_nodes, { membershipId, plans: q.files_search_query_to_plans(q.files_search_query_parse("status:open").filters[0]), pathPrefix: "/tasks" })`, `list_search_fields({ membershipId })`, and `list_search_values({ membershipId, fieldPath: "metadata.assignee", prefix: "" })`.
- Metadata fixture without the Properties modal: `files_metadata.set_entries({ membershipId, fileNodeId, metadataYaml: "status: open\n" })` from page context, the same door the modal calls.
- Working-tree proof: put `return { nodeIds: [] };` at the top of the `search_nodes` handler, poll the page-context door until it answers 0 (the Convex watcher pushes in ~10 s), check that `status:open` shows `No files match your search.` while `file.name:x` and free text still match, remove the line, and poll until the door answers again. Read `git status --short` after.
- Restricted-folder check needs a second identity (`second-user-fixtures.md`). The owner creates `tasks/public-task.md` and `private/secret-task.md` with the same `status` key, restricts `private`, and sees both files and both values. The member must see only the public file in the tree, in `search_nodes`, in the `Values` suggestions, and in the key catalog.

### Global Search Palette

- Open the header button named `Search files (Ctrl+Shift+F)` with focus + Enter, or use `Control+Shift+F`. The dialog is `.FilesSearchPalette`, named `Search files`.
- The shared suggestion popover has `MyFloatingSurface`. Check alternative base colors and a scrollbar flush with the inner right border in both searches. With `inspectElement`, pass `computedStyles: [{ name: "surface", properties: ["backgroundImage", "borderColor", "padding"] }]`; plain property strings give empty style results. Option rows are not included in the quick accessibility screen's control count, so check their labels, keyboard focus, and target size separately.
- After `Control+K`, wait for a field option or the sidebar input's `aria-expanded="true"` before typing. The shortcut focuses and selects the input on the next animation frame; typing sooner can race that selection.
- The combobox is named `Search files by name, contents, or key:value filters`. Fields appear as soon as the modal opens. Both searches use the same menu rules: Escape dismisses it without changing text or chips; typing and Space keep it closed; `Control+Space` and Add search filter reopen it. Check that Ctrl+Space keeps the text and caret position, including inside a word. Choosing a field after ordinary text appends a filter; choosing its value commits a chip and closes the menu.
- Fill `file.path:/tasks status:open priority:>=2`, then Enter. Check three chips above the input and matching paths. Add a content word and check snippets.
- Results are buttons in the list named `Search results`. Read `.FilesSearchPalette-item-path` and `-item-snippet`. After dismissing suggestions, ArrowDown from the input focuses the first result; ArrowUp there returns to the input with suggestions still closed. Enter opens a row and preserves the sidebar's `q`.
- “Use filters in sidebar” applies only chips. Test with another sidebar query already present. Verify the mounted sidebar updates its chips, count, and URL. Back/forward must restore the query.
- Escape closes filter suggestions before the modal. A second Escape closes the modal and resets its query. The leave animation takes about 500ms. Repeat the menu checks in the sidebar through `Control+K`; returning from chips keeps dismissal, while entering from outside search shows fields again. Ctrl+Space during IME composition must do nothing.
- The content door accepts `membershipId`, `query`, and optional `nodeIds` from structured matches. File scope applies before the content page limit. Tenant and file permissions still apply.
- Check narrow width and short height: chips scroll vertically after 96px (less in a short viewport), the input stays visible, and results scroll inside the modal. At 390 × 320 with 12 chips, the chip area is 64px and a result row remains visible.

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
- `list_tree` takes `paginationOpts: { numItems: 500, cursor: null }` and returns `{ page, isDone, continueCursor }`. Follow each cursor until `isDone` before checking all nodes or fixture children. A node has `kind`, not `type`; use `kind`, `lowercaseExtension`, or `contentType`.
- `files_visible.list` takes **flat** args, not a `paginationOpts` object: `{ membershipId, mode, folderPath, cursor, numItems }` with `mode` one of `children | subtree | recent`, and it returns a Result — read `_yay.items`, `_yay.isDone`, `_yay.continueCursor`. It is addressed by `folderPath`, not by a parent id. Verified 2026-09-15.
- **A `files_visible.list` item has no `_id`.** Each item is `{ kind, name, path, contentType, preparing, updatedAt, updatedBy, target: { kind, id } }`, so read `item.target.id`. `target.kind` also tells you which read door to use: `"saved"` is a real `files_nodes` row, `"private"` is a `files_pending_nodes` row that only the proposal's owner can see. Passing a private id to `files_nodes_content.get_non_collaborative_file_content` fails the validator with `Found ID ... from table files_pending_nodes, which does not match ... v.id("files_nodes")`. Read a private one with `files_fetch_private_file_pending_text({ membershipId, target })` from `/src/lib/files.ts` instead. An agent `cp`/`touch`/`>` into a new path always produces a private item, so a listing right after an agent write mixes both kinds. Verified 2026-09-15.
- `files_nodes.get_file_node_for_membership` takes **`fileNodeId`**, not `nodeId` (nearly every other files door takes `nodeId`). It returns the raw node doc plus `canWrite`, so it is the quickest way to read `assetId`, `collaborationEnabled`, `textKind` and `writePolicyState` for a node. Verified 2026-09-15.
- To decode a pending branch by hand in page context, the two helpers live in different modules: `files_yjs_doc_create_from_array_buffer_update` is in `/shared/files-yjs.ts` and `files_yjs_doc_get_text` is in `/shared/files-tiptap.ts`. Pair either with `files_fetch_file_pending_update_yjs_state({ membershipId, target, stateId })` from `/src/lib/files.ts` to read the base, staged or unstaged text of a saved-target proposal. Verified 2026-09-15.
- A copy is **not** byte-identical to its source for a `rich_text` file. The copy runs the text through a headless Tiptap editor to drop comment marks, and that markdown round-trip removes a single trailing newline (`"a\nb\n"` becomes `"a\nb"`; a trailing blank line, `"a\n\nb\n\n"`, survives) and writes a fresh asset. A file written straight through `replace_file_content` keeps whatever bytes you passed, so a fixture built that way and then copied shows a one-byte diff that is the serializer, not the transfer. Compare content after the same round-trip, or assert without the trailing newline. Verified 2026-09-15.
- **`create_text_node` and `create_folder_node` take `path` relative to `parentId`.** `create_text_node({ parentId: <the /u39 folder>, path: "/u39/target.md" })` silently makes `/u39/u39/target.md`. The failure shows up much later and looks like something else: the agent's Bash then answers `ls: No such file or directory` for the path you think you created, and a `>` write there creates a _new private draft_ (`Added` row, `target.kind: "private"`) instead of a content proposal on your file. Pass the leaf name (`path: "target.md"`) when `parentId` is a folder; pass the full path only with `parentId: "root"`. Verified 2026-09-15.
- To sign a URL without opening a document, query `r2.get_media_by_reference({ membershipId, src })` first. When it returns non-null `media`, call `files_media_get_signed_url({ membershipId, media })` from `/src/lib/files-media-src.ts`. Saved media caches by membership, file, and asset; private media always signs its exact review version again. Agent output uses normal Files preview and download doors.
- Stable private links: create an image draft through Agent `execute_code` and a Markdown draft that embeds `bonobo-file://private/<image pendingNodeId>`. Open the document with `pendingNodeId`, not `nodeId`. Require `.FileEditorRichTextMedia img` to have a positive `naturalWidth`. In Pending, expand the image and save only that image. The document must keep rendering, and `get_media_by_reference` must now return a saved target. Accept the document, reload, and read its saved text with `files_fetch_file_yjs_state_and_text`; `text` is a Result, so check `_nay` before reading `_yay`. Require the original private reference, not a signed URL or rewritten ID. A second account must get null using either its own membership or the first account's membership. The team-owner-before-Save and team-reader-after-Save cases also have focused backend tests.
- Slash-menu drive (current, verified 2026-08-08 — supersedes the historical `rich-text-slash-command-keyboard.md`): type `/image` into the editor, wait for `.FileEditorRichTextToolsSlashCommand-item`, ArrowDown until `[aria-selected="true"]`'s `-item-title` matches, then Enter. Start each drive from a fresh paragraph (press Enter first): a refused URL prompt leaves the `/query` text in the doc, and typing another `/` right after it does not reopen the menu.
- `Image`/`Video` open a real file chooser from the hidden inputs — intercept with `state.page.waitForEvent("filechooser")` started before the Enter, then `chooser.setFiles("C:/absolute/path")`. Works under a Windows relay.
- `Embed file` opens `.FileEditorRichTextMediaEmbedPicker` (a `MySearchSelect` anchored to the caret): type to filter by path, Enter inserts the highlighted row's `bonobo-file://` reference, Escape closes and refocuses the editor. Rows are `-item-name` / `-item-path` spans.
- `Image from URL` / `Video from URL` use `window.prompt` — stub it in `evaluate` (`window.prompt = () => url`) before triggering the item; a non-http(s) answer must produce the alert (stub `window.alert` to capture) and insert nothing.

### File Properties Modal

One dialog holding the file's facts, its write policy, and the flat key-value map edited as YAML
(write policy verified 2026-09-08). Spec: `.agents/skills/file-metadata/SKILL.md` and
`.agents/skills/files-read-only/SKILL.md`. It replaced both the sidebar `Metadata` tab and the old
`Read-only settings` modal, so a recipe that clicks either of those is out of date.

- Two ways in: right-click a sidebar row (or click its ⋮ button, `getByRole("button", { name: "More actions for <name>" })`)
  and pick `Properties`, or click the breadcrumb button, `getByRole("button", { name: /^Properties of / })`.
- When the folder browser shows the same node, its row repeats the sidebar's action button name.
  Scope the sidebar button to `getByRole("tree", { name: "Files", exact: true })` before opening its menu.
- **Two dialogs are mounted**, the sidebar's and the file view's, and the closed one keeps its class
  and its `data-files-properties-modal` attribute at `display: none`. Scope every query to
  `[data-files-properties-modal][data-open="true"]`. A plain `.FilesPropertiesModal` resolves to the
  hidden one first, and `waitForSelector` then times out on a dialog that is plainly on screen.
- The dialog holds four sections, reachable by their region names: `General` (a `<dl>` of facts),
  `Protection` (the write policy), `Collaboration` (the collaborative-editing checkbox), and
  `Metadata` (the YAML editor). A folder gets General, Protection, and Metadata.
  `Collaboration` renders only for an editable text file, so an image also shows three sections
  and no empty strip.
- The `Collaboration` checkbox is a `MyCheckboxButton` with a covered 1px input:
  click its label, `.FilesPropertiesModalCollaboration-checkbox`.
  Both directions open an inline confirm step inside the same section —
  `getByRole("button", { name: "Turn collaboration off" })` or `Turn collaboration on`, next to
  `Cancel` — and nothing is written until that button is clicked (the ON confirm is newer than the
  OFF one; verified 2026-09-04). Focus moves to the confirm button, and the tick keeps its old
  state until the write lands, so do not read "still checked" as a missed click. The confirm's
  `locator.click()` can also land nowhere: on 2026-09-05 the description stayed unchanged and no
  toast appeared after it, while `confirm.focus()` + `keyboard.press("Enter")` toggled both
  directions every time. Use the keyboard for the confirm step. Read the state from
  `.FilesPropertiesModalCollaboration-description`, not from the tick: the Metadata section repeats
  the same "read-only" and "no permission" sentences, so `getByText` finds several matches.
- Scope policy controls to `.FilesPropertiesModalWritePolicy`. The radios are `Editable`,
  `Read-only`, and `Selected writer`. There is no `Inherit` radio. Click the visible label. Unlock
  with `Editable` + `Save policy`. For a selected writer, choose `Writer type` (`Person` or
  `Service account`), then the matching picker. Only active accounts appear in the account picker.
  Nothing is saved until `Save policy` is clicked. Folders also have a New items default.
- Read `files_nodes.get_node_write_policy_management_state({ membershipId, nodeId })` through a fresh
  `ConvexHttpClient`. Check `localPolicy`, `canWrite`, and `canManage`.
  After a native click, wait for the saved UI state before readback; the click can finish before its
  mutation. A selected human can edit when their access permits it. Revoking a selected account keeps
  the file protected and shows `Protected file. The selected writer is unavailable.`
- For screenshots and hit-target checks, scroll the policy block into view first. Tabbing to footer
  controls can leave radios above the scroll area. At 512×768 the dialog scrolls and keeps its footer
  visible. The quick audit counts 18px radio inputs; inspect their clickable labels before treating
  these size warnings as accessibility failures. Escape returns focus to the Properties trigger.
- The editor is Monaco. Synthetic keyboard input does not reach it. Set the text through the editor
  handle from page context:
  `monaco.editor.getEditors().find((e) => e.getRawOptions().ariaLabel === "Metadata YAML").setValue(yaml)`.
  After opening Properties, wait for the textbox named `Metadata YAML` before reading the handle;
  the dialog can appear before Monaco mounts, so an immediate lookup can return `undefined`.
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
- Properties work on uploads and folders. Folder Metadata uses the same save and lock states;
  Collaboration stays file-only. Save a folder label, search it in the sidebar and global palette,
  then rename/move/archive/restore the folder and read back its current metadata and search path.
- Agent side: ask the chat agent to run `meta get <path>` and to call `set_file_metadata`. The tool
  takes bare keys (`status`), and the model tends to paste the bash mount path — both are covered by
  the tool description now, but a run that fails with `Not found` is usually the path, not permissions.

### Non-collaborative editors

All three
views — Rich (`FileEditorRichTextNonCollab`), Markdown (`FileEditorPlainText`) and Diff
(`FileEditorDiffNonCollab`, now folded into `file-editor-diff.tsx`) — save the whole text through
`replace_file_content`. There is no Yjs document, so nothing syncs between tabs. Each tab keeps
its own text, and the last save to commit wins. Saves carry no base-asset token. One exception:
when the member has an agent proposal on the file, the Diff view reviews that proposal in
`FileEditorDiff` (root `.FileEditorDiff`) and Save calls `save_file_pending_update`; see "Diff view
with a pending proposal" in `file-node-view.md`.

Drive the editors through the dev QA hook instead of typing into Monaco. `window.__qa.monaco()`
returns `{ plainText }` in the Markdown view and `{ diffOriginal, diffModified }` in the Diff view.
`model.setValue(...)` fires the same change event as typing, so the dirty debounce runs normally.
The Rich view has no Monaco: click `.FileEditorRichTextNonCollab-editor-content`, press `Control+End`, then
`keyboard.type(...)`.

Watch the button you assert on. `[aria-label="Rich text editor actions"] button` picks Undo, not
Save. Scope it: `locator('[aria-label="Rich text editor actions"] button', { hasText: "Save" })`,
`.FileEditorPlainTextToolbarActions-button` with `hasText: "Save"`, or
`.FileEditorDiffNonCollabToolbarActions-button`. A second `Save` button lives in an always-mounted
modal footer, so an unscoped `getByRole("button", { name: "Save" })` can match the wrong one.

**"Save is disabled" does not mean "the save finished".** `isSaveDisabled` is `isSaving || dirty
state !== "dirty"`, so the button disables on the click itself, before the server answers (measured
2026-09-04: disabled ~0.5 s after the click, `replace_file_content` answered ~1.8 s). A runner that
waits for `disabled` and then switches view unmounts the editor while the save is still in flight —
and gets the `Your unsaved changes to this file were discarded.` toast even though that save lands.
For a clean-state check, wait for the recorder's `replace_file_content` result (install the
page-side recorder from `snippets.md`, "Watch Convex Mutations On The Wire", patching `action` too),
then switch. Verified 2026-09-04: with the result awaited, Markdown → Diff → Rich shows no toast.

Fixture typing in the Rich view: `Control+a` then `keyboard.type(...)` replaced only the block under
the caret in this session, not the whole document, so word-count fixtures came out as 20/11/13
words instead of 12/3/5. That is fine for a "clearly different counts" check; to control the whole
text, set it in the Markdown view (`window.__qa.monaco().plainText.getModel().setValue(...)`) and Save.

**Two-tab last write wins.** Open the same file in two tabs before either saves. Type different
text in each. Save A and await its action result, then save B. Both succeed with `_yay: null` and
no stale-save toast. Reload and read the committed text: B wins. Use `Open file snapshots` and inspect both
saved texts. Repeat with plain text and Markdown, including the Markdown and Diff views.

**Comment from older text.** Only the Rich view can add a comment, and only while it is clean —
the button carries `title="Save your changes before adding a comment."` while it is not. Load B,
then save different text in A. In B, select text, use `getByRole("button", { name: "Add comment" })`,
fill `getByRole("form", { name: "New document comment" })`, and submit. B saves its older text plus the comment mark
in one call. It does not re-read or merge A's text. Reload and reopen the comment to verify it
persisted; A's text remains in File Snapshots.

**Restore from an older tab.** Load B, save different text in A, then restore an older version
from B's File Snapshots dialog. The restore succeeds and its text is committed. The replaced text stays
in File Snapshots. Collaboration must remain off until the restore commits.

**Typed while the comment save was waiting.** The real save is too fast to type into, so slow it
down from page context. Vite serves the app modules, so the live Convex client is reachable:

```js
await state.tab1.evaluate(async () => {
	const m = await import("/src/lib/app-convex-client.ts");
	const orig = m.app_convex.action.bind(m.app_convex);
	m.app_convex.action = async (ref, args) => {
		await new Promise((r) => setTimeout(r, 6000));
		return orig(ref, args);
	};
});
```

Submit the comment, then type into `.FileEditorRichTextNonCollab-editor-content` during the wait.
The save commits the text it captured, and the later typing stays dirty for the next Save. The same patch proves the plain editor keeps
Save armed for text typed while a save was in flight. Match the delay on the args (`typeof
args.text === "string" && args.nodeId && args.membershipId`), not on the function reference — the generated `api`
builds a new proxy on every access, so `ref === api.files_nodes_content.replace_file_content` is
never true. Expected readings: Save `disabled: true` while the save
waits; typing during the wait flips `aria-busy` to `"true"` for the dirty debounce; once the delayed
call resolves, Save is `disabled: false` and `aria-busy="false"`; the second Save sends the longer
text without a base-asset token; a reload shows both edits.

Recorder tip: also record `query` calls that carry `nodeId`. A comment commit makes one
`replace_file_content` call with `_yay: null`, with no content re-read or retry. Restore still
re-reads the committed text to refresh the editor.

**Unsaved-text warning.** Every non-collaborative editor warns when it goes away with text it never
saved: switch view, reload, or close the file. The toast is `Your unsaved changes to this file were
discarded.` with a `Copy text` action. After a clean save there is no toast.

Assert the clipboard through a `writeText` spy, not through `navigator.clipboard.readText()` alone:
the read worked in one session and answered empty in another (see `known-hazards.md`), so an empty
read is inconclusive. When it does answer, it hands back CRLF line endings, so compare with
`includes(sentence)`, not with equality. The toast's `Copy text` button clicks fine with a plain
`locator("[data-sonner-toast] button", { hasText: "Copy text" }).first().click()`; with several
warning toasts stacked, `first()` was the newest one. The spy:

```js
await state.tab1.evaluate(() => {
	window.__clipSpy = [];
	const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
	navigator.clipboard.writeText = (t) => (window.__clipSpy.push(t), orig(t));
});
```

**Snapshot restore.** The list button is the timestamp (`55m ago`); clicking it opens a second
dialog, `.FileEditorSnapshotsModalPreviewModal`, whose `Confirm` performs the restore. Scope every
follow-up click to that preview modal — the list dialog stays mounted underneath and intercepts
clicks. On reopening, `useStableQuery` can briefly show the previous list. After opening, query
`files_nodes.get_file_snapshots_list({ membershipId, nodeId, showArchived: false })` through the
app client, then wait until `.FileEditorSnapshotsModalListItem:visible` has that result's
`snapshots.length` items. Do this while no new saves are running. Versions saved seconds apart all
read `Just now`, newest first, so pick by index (`nth(i)`) only after that wait. Always prove which
version you opened from the preview's diff block: it is `diffWordsWithSpace(current, snapshot)`, so the snapshot text is every
`.FileEditorSnapshotsModalPreviewModalDiffBlock-word` that is NOT `-removed`, joined. After `Confirm`
the Rich view must refresh with no further interaction: the word badge
(`.FileEditorRichTextNonCollabToolbarActions-word-count-badge`), the `span.lb-tiptap-thread-mark`
elements, and the anchored-comments Convex subscription all follow the restored document. Poll the
badge from the click without touching the page; on 2026-09-04 it moved from the old count to the
restored one in the same poll in which the preview closed (~3.5 s, the restore action plus the
re-read), never later. Read the subscription without a click:

```js
window.__qa.convexSubscriptions().filter((s) => JSON.stringify(s.args).includes("threadIds"));
```

For a non-empty snapshot, wait for `.FileEditorSnapshotsModalPreviewModalDiffBlock-word` before
reading the preview text. The diff container can mount while its content is still loading; reading
the container alone can report an empty snapshot too early.

### Restore mode and failure checks

Use one new Markdown file in a temporary QA folder. Keep its initial version, turn collaboration
off through Properties, then save different text. Open `Open file snapshots`, preview the initial
version, and confirm. The old text must return while collaboration stays off. Read it through
`get_non_collaborative_file_content` and compare with the signed download body.

To check a thrown restore failure, temporarily throw in `restore_snapshot_r2` for only that QA
node id. Confirm in the preview and verify the error toast and enabled retry button. Remove the
temporary branch, wait for the dev watcher to deploy, and confirm again. The preview must close
and the restored text must appear. This also proves the browser reaches the working tree.
Snapshot and log reads can run before the action ends; observe again before calling it a failure.
Do not keep the temporary branch or the QA node id in committed code.

Use `convex/files_nodes_content.test.ts` for the exact overlapping R2 PUT order. Browser request
interception cannot pause those server-side uploads. The tests hold each PUT and cover stale
materialization, same-counter workers, restore after an edit, and OFF/ON during materialization.

### Copy, paste and answer a transfer name conflict

Build the fixture through the deployed doors, not the UI. `files_nodes:create_folder_node` joins its
`path` under `parentId`, so an absolute path creates a nested duplicate such as
`/run/run/a`. Pass a plain relative name.

A fixture that produces every conflict shape in one paste: `/<run>/a/report`, `/<run>/b/report` and
an empty `/<run>/target`. Copying both `report` folders into `target` makes the first item a free
name and the second a same-paste name claim, which has no destination document.

Drive it from the tree:

```js
const rowFor = (id) => page.locator(`[data-file-id="${id}"][role="treeitem"]`).first();
await rowFor(ids.aReport).click();
await rowFor(ids.bReport).click({ modifiers: ["Control"] });
await page.keyboard.press("Control+c");
await rowFor(ids.targetId).click(); // the paste destination follows the selection
await page.getByRole("button", { name: "Paste files" }).first().click();
```

Filter the tree first with `#app_files_sidebar_search input`, then press `Escape` — see the
suggestions-popover hazard. Scope the modal to `.FilesTransferRunModal`; `getByRole("dialog")`
matches the always-mounted organization switcher instead.

Answer the conflicts by fieldset legend (they are `group`, not `radiogroup`):

```js
const modal = page.locator(".FilesTransferRunModal").first();
const set = modal.locator("fieldset").filter({ hasText: "Apply to remaining folder name conflicts" }).first();
await set
	.locator("label")
	.filter({ hasText: /^Keep both$/ })
	.first()
	.click();
await modal.getByRole("button", { name: "Continue" }).first().click();
```

The modal holds **two kinds** of fieldset, and they carry the same choice words. Each open conflict
has its own set whose legend is the **source path** (`/run/src/skipme.md`, labels
`Keep both | Replace | Skip`), and below them sit the two `Apply to remaining ... name conflicts`
sets. A bare `modal.getByText("Skip", { exact: true }).first()` picks an apply-to-remaining radio,
which answers nothing, so `Continue` stays disabled and the run never moves. Always filter by the
legend text of the conflict you mean:

```js
await modal
	.locator("fieldset")
	.filter({ hasText: "/run/src/skipme.md" })
	.getByText("Skip", { exact: true })
	.first()
	.click();
```

The Files clipboard lives in the page, not on the server, so **a full page load clears it**. After a
Copy, do not `goto` the destination: the Paste button is there but disabled. Walk to the destination
inside the app instead, through the folder table's `a[aria-label="Open <name>"]` link.

To make one copy fail **for real** without touching the billing plan, create the source with
`files_nodes:create_upload_node` and never send the signed PUT. The node stays unfilled, and its
copy fails with `The source file is still saving. Try again.` while its siblings copy normally.
That is the cheap way to stage a partial run and then press `Retry remaining files`.

Read the result back from the server, not from the modal text alone:
`files_transfer:list_items` with `{ membershipId, runId, paginationOpts }` gives each item's
`state`, `outcome`, resolved `source` and `output` paths, and `conflictKind`. List the destination
folder with `files_visible:list` and remember the `_yay.items` shape.

A run that ends blocked stays reachable. Reopen it from the notifications bell (focus + Enter; the
Playwriter toolbar covers it) and click "Review conflicts" inside `.AppNotifications-popover`.
Pasting the same sources again is the way to check that duplicate names keep a stable order: the
counter must continue past the existing siblings, in source order.

### Reading A Reservation That Is Still "Preparing"

A private node the transfer created but has not filled yet reports `preparing: true` on
`files_visible.list`. Catching one is harder than it looks.

- `cp`/`mv` in the foreground block until the run ends, so the chained commands after them always
  see finished nodes. The background form is a job: `cp -R <sources> <dest> &` prints
  `bash: started job N in shell default. ...` on stderr and returns at once. `jobs`, `wait N` and
  `kill N` drive it afterwards, and the Notifications panel shows the job with its Stop button.
- To make the agent run a job in a **named** shell, say so in the prompt: "Set the Bash tool's
  shell field to release-prep". The model then passes `shell` and the launch line names it. Do not
  ask for a 32-character name even though the tool's pattern allows 32: asked for a 32-letter name
  on 2026-09-15, the model answered that the tool rejects it and ran nothing. Any name from 9
  characters up already removes every padding space, which is enough to check the `jobs` columns.
- Even in the background the window is about one poll sample wide. Polling `files_visible.list`
  every 120 ms during a 10-node `cp -R` caught one preparing node out of 38 samples. Chained Bash
  readers reliably miss it: they either run before any reservation exists (everything answers
  `No such file or directory`) or after the node is ready.
- `sleep` **is** available in the sandbox, so `cp -R ... <dest> & sleep 5; ls <dest>` samples a
  live run. With the old foreground-started `transfer start` verb, at t+5 s a 8-child copy listed
  3 rows, at t+6 s 4 rows, at t+7 s all 8; a job adds its queue wait before the copy starts, so
  re-measure.
- A job Stop (`kill N` or the Notifications panel) does not freeze a reservation. `db_cancel_items`
  (`convex/files_transfer.ts:369-395`) calls `files_pending_nodes_db_discard` for every item with
  a `preparation`, so stopping **deletes** the unfilled ones.
- The reliable way to get a **stable** preparing node is a write that dies mid-preparation.
  `seq 1 300000 > <path>` no longer does it — checked 2026-09-15, that write now succeeds and
  produces 588,902 bytes. `seq 1 2000000 > <path>` does, and leaves the reservation behind for as
  long as you need it. It can die two ways, and either is fine: the 1 s Convex mutation limit
  (`Uncaught Error: Function execution timed out (maximum duration: 1s)`), or a write conflict with
  another transfer running at the same time (`Documents read from or written to the
"files_pending_review_versions" table changed while this mutation was being run ... A call to
"files_nodes_content.js:finalize_transfer_file_copy" changed the document`). Discard it when you
  are done.

What the readers say about one of these is not uniform, so do not assert "the file is missing" or
"the file is binary" from a single command:

| reader                        | answer                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ls` / `find` / `tree`        | a plain row, no marker of any kind                                                                                 |
| `stat`                        | `Size: (content size not tracked for this file)`, `Type: regular file`                                             |
| `cat` / `tail -n` / `head -n` | `content is not available from materialized chunks`                                                                |
| `head -c`                     | `No such file or directory`                                                                                        |
| `wc -c`                       | the binary/media `[ADVISORY]`, even for `text/markdown`                                                            |
| `grep`                        | silent                                                                                                             |
| `meta get`                    | `item not found`                                                                                                   |
| `edit_file`                   | `Cannot edit <path>: this draft is still preparing`                                                                |
| `cp <preparing> <dest>`       | **rc 1**, `cp: draft '<path>' is still preparing` — the clearest of them all                                       |
| review-run Accept             | `blocked`, run `failed`, `Pending changes changed during review. Review them again.` (misleading: nothing changed) |

Only the writers name the state. Use `edit_file`, or a redirect write, when you need a command
that actually tells you a target is preparing.

Two of those answers are wrong about the reason, so do not quote them to a user. `cat` on a
preparing **plain text** draft prints the binary/media advisory and claims its
`text/plain;charset=utf-8` type "is not readable as text"; the type is fine, the draft is just not
filled yet. And the Accept refusal blames a concurrent change that did not happen. `cp` and
`edit_file` are the two that name the real state.

A preparing private draft cannot be opened with `/files?nodeId=<id>` either — that id belongs to
`files_pending_nodes`, so the route falls back to the root folder view.

### Clearing Many Pending Proposals

`Discard all shown pending changes` in the sidebar is **chat-scoped** — the strip says "N pending
file changes from this chat" — so it will not clear proposals made by earlier chats or earlier
runs, and clicking it repeatedly changes nothing. For test cleanup, go through the Convex doors
instead and page until the list is empty:

```js
const rows = /* page files_pending_updates.list_files_pending_updates with paginationOpts */;
for (const row of rows) {
	const pu = row.entry.pendingUpdate;
	const door = row.entry.kind === "private"
		? api.files_pending_updates.discard_file_pending_structural
		: api.files_pending_updates.discard_file_pending_update;
	await convex.mutation(door, { membershipId, target: pu.target, pendingUpdateId: pu._id, reviewedRevision: pu.revision });
}
```

Discarding a private node the page is currently viewing navigates the route, which kills a running
`page.evaluate` with `Execution context was destroyed`. Park the tab on `/chat` first.

Two things make that loop wrong if you write it from memory. The list door caps its page at five
rows no matter what `numItems` says, so you must follow `continueCursor` until `isDone` — see
`known-hazards.md`. And a `kind: "restricted"` row carries no `entry`, so read
`row.entry?.pendingUpdate?._id ?? row.pendingUpdateId`.

One review run clears everything in a single pass and is faster than the per-row loop. Collect
every row first, then `files_pending_update_runs.start({membershipId, requestId, kind: "discard",
expectedItemCount, items})`, `append_items` for anything past the first 100, `seal`, and poll `get`
until `step === "finished"`. The run refuses a partial selection on purpose, so it only works after
full paging.

### Public File API From The Browser

`/api/v1/files/read`, `read-many` and `list` take **paths**. `download-urls` is the only public
file door that takes ids (`fileNodeIds`), and it needs scope `files:download` — a key without it
answers `403 Permission denied` for every id, valid or not. Always send a known-good saved node in
the same check, or a refusal proves nothing about the id you care about.

A private (agent-created) target is refused everywhere public: `read` 404s, `read-many` returns it
under `errors` with `files: []`, `list` omits it, and `download-urls` returns
`{fileNodeId, message: "Not found"}` while a saved id in the same batch still returns its signed
URL. The public doors also serve committed state only — a saved file with a pending replacement
reads back at its saved size and body.

### Accepting A Pending Proposal From A Runner

Do not call `files_pending_updates.save_file_pending_update` to accept an agent's proposal on a
**saved** file. The agent's writer stages only the unstaged branch, and that action publishes only
what is on the staged branch. With nothing staged it returns the success shape
(`{"_yay":{"newSequence":null,"pendingUpdateRevision":<unchanged revision>,...}}`), writes nothing,
and leaves the pending row in place. There is no `_nay` to notice.

The sidebar Accept goes through a review run and names the branch explicitly, so copy that:

```js
const started = await m.app_convex.mutation(m.app_convex_api.files_pending_update_runs.start, {
	membershipId,
	requestId: crypto.randomUUID(),
	kind: "accept", // or "discard"
	expectedItemCount: rows.length,
	items: rows.map((r) => ({
		pendingUpdateId: r.entry.pendingUpdate._id,
		reviewedRevision: r.entry.pendingUpdate.revision,
		// A content proposal publishes its unstaged branch. Archives and replacements take null.
		selectedContentStateId:
			r.entry.pendingUpdate.pendingArchive || r.entry.pendingUpdate.pendingReplacement
				? null
				: (r.entry.pendingUpdate.content?.unstagedStateId ?? null),
	})),
});
const runId = started._yay.runId;
await m.app_convex.mutation(m.app_convex_api.files_pending_update_runs.seal, { membershipId, runId });
```

The run is asynchronous. Poll `files_pending_update_runs.get({membershipId, runId})` until
`run.step === "finished"`, then read per-item outcomes with
`files_pending_update_runs.list_items({membershipId, runId, paginationOpts})` — each row is
`queued | running | completed | needs_review | failed | canceled` with an optional `message`.
`start` takes at most 100 items; append the rest with `append_items({membershipId, runId, offset,
items})` before sealing.

`apply_file_pending_archive` and `apply_file_pending_move` are plain mutations with no content
branch, so those two can still be called directly.

### Reading And Restoring A Collaboration-Off File's Text

`files_nodes_content.get_non_collaborative_file_content` returns a `Result`, so the text is at
`result._yay.text`, not `result.text`. Reading `result.text` answers `undefined`. That matters more
than a wrong log line: a runner that builds the new text from the old one then writes `""` plus its
own line and silently wipes the file. Read the value back after every write.

To undo such a mistake, the file's version list is the source. `files_nodes.get_file_snapshots_list`
takes `{membershipId, nodeId, showArchived}` and takes **no** `paginationOpts` — it returns
`{snapshots: [...]}` newest first. Each snapshot's bytes come from a signed URL:

```js
const link = await m.app_convex.action(m.app_convex_api.files_nodes.create_file_snapshot_content_url, {
	membershipId,
	nodeId,
	snapshotId,
});
const text = await (await fetch(link.url)).text();
```

Then write `text` back with `files_nodes_content.replace_file_content`. There is no restore
mutation. Note the newest snapshot is taken **after** the save that created it, so the text you want
is usually the second row, not the first — check each one's `_creationTime` against the save.

### Listing And Draining Pending Rows From A Runner

`files_pending_updates.list_files_pending_updates` requires `paginationOpts`. Each row is
`{kind, canAccept, canEdit, readiness, entry}` with the useful fields one level down in
`entry.path`, `entry.node` and `entry.pendingUpdate` — there is no `row._id` or `row.path`.

Draining every row for a clean fixture needs **more than one pass**. A folder draft whose children
still have drafts refuses with `{_nay: {name: "needs_review", message: "Review the child drafts
before discarding this folder"}}`, so loop until the list is empty:

```js
for (let pass = 0; pass < 5; pass++) {
	const rows = await m.app_convex.query(m.app_convex_api.files_pending_updates.list_files_pending_updates, {
		membershipId,
		paginationOpts: { cursor: null, numItems: 50 },
	});
	if (rows.page.length === 0) break;
	for (const r of rows.page) {
		const pu = r.entry.pendingUpdate;
		await m.app_convex.mutation(m.app_convex_api.files_pending_updates.discard_file_pending_update, {
			membershipId,
			target: pu.target,
			pendingUpdateId: pu._id,
			reviewedRevision: pu.revision,
		});
	}
}
```

### Catching A Toast That Auto-Dismisses

`Accept all shown pending changes` fires its `toast.warning` at click time, and sonner removes the
node a few seconds later. Polling `[data-sonner-toast]` after the click therefore misses it while
the slower run-progress toasts are still on screen. Record instead: install a `MutationObserver`
over `document.body` **before** the click and collect every `[data-sonner-toast]` text it sees.

Save and Discard leave their progress dialog open when they finish. Its backdrop can block the
chat mode picker or another control behind it. The footer and icon both have the accessible name
`Close`. Scope to the named dialog and select the footer text:

```js
await state.page.getByRole("dialog", { name: "Save reviewed changes", exact: true })
	.getByText("Close", { exact: true }).click({ timeout: 4000 });
```

Use `Discard reviewed changes` for a Discard run. Read the page again after closing.

Check keyboard focus after Close in a separate call. If the action removed its button, focus
returns to the Pending panel or the file view. Cover plain-text rows, stored-file rows, file
details, and bulk actions. Busy action buttons keep focus with `aria-disabled`; readiness and
permission refusals still use `disabled`.

Pending starts with one page. Click `Load more pending changes` before counting all rows. To
clean up a QA run, select its chat in `Pending changes source`, load every page, and check the
shown paths before using Discard all. Do not discard unrelated pending work.

### A Member's Concurrent Save Making An Owner's Proposal Stale

The full shape, proven end to end with a second identity (see `second-user-fixtures.md`):

1. The owner's agent proposes content on a **collaboration-off** file (`printf ... > <path>`).
   `replace_file_content` only works on collaboration-off files — `get_replace_file_content_preflight`
   returns `null` (surfacing as `{"_nay":{"message":"Not found"}}`) when `collaborationEnabled !== false`.
2. The member calls `files_nodes_content.replace_file_content` on that same node. The committed text
   moves; the proposal is untouched and `contentNeedsRebase` stays `null` (an ordinary save's
   staleness is derived from the base asset, not from that flag).
3. The owner's row caption becomes `<path>, review to update`.
4. `Accept changes to <path>` toasts `This file changed. Open Review to update the proposal, or
discard it.` and writes nothing — same proposal id, revision and state ids afterwards.
5. `Accept all shown pending changes` toasts `Changes waiting for review are skipped. Open Review to
update them.`, saves the fresh rows and leaves the stale one alone.

## Cross-Workspace Copy

Only Copy crosses workspaces. Spec: `files-explorer-tree/references/transfer.md` (Workspace boundary). Verified 2026-09-22 with three identities: the org owner (paid, in the QA Edge profile) and two anonymous members from `second-user-fixtures.md`, each in a headless session. Use only owned QA files in a throwaway team workspace. Drive Bash through the native composer with a one-command prompt ("Run exactly this one Bash command, once, with no changes. Then reply with only the word DONE."). Read the stored `tool-bash` part (`output.metadata.exitCode`, `output.output`), not the model reply. In Bash, the team is `/home/cloud-usr/w/<org>/<ws>` and the home is `/home/cloud-usr/w/personal/home`.

1. Move refusal: `mv $H/x $T/y` and `mv $T/x $H/y` must each exit 1 with `mv: Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.` `ls` shows both originals, and no draft exists at the target. Same-workspace `mv` still makes a move proposal.
2. Copy both ways with `cp -R`. The tool output says `Transfer <id>: N ready for review`. Transfer completion is not Save. The copies are private drafts of the copier. Another member and the org owner get null from `get_visible_target_by_path` and `get_file_pending_target` for them. Use the copier's own personal membership id to probe their home.
3. Unreadable child: restrict one saved child with no grant for the copier. `cp -R` of its folder must print `cp: Permission denied`, exit 1, create nothing, and never name the hidden child. A human Paste of the same folder fails with `total: null` and offers no Retry. `retry_remaining` answers `This copy stopped before it found all its files. Start a new copy instead.`
4. Disclosure: the Pending row and the pending file view show `.FilePendingNotice[data-copy-destination]`. Team destination: `Destination: <org>/<ws> · <folder>`, `New copies use this folder's sharing rules. Source sharing is not copied.`, and `The destination organization owner can read saved copies.` Personal home: `Saved copies here are private to you.`
5. Save: `Accept all shown pending changes` loads only 5 rows, so click `Load more pending changes` until the required parents are loaded. Keyboard works: focus the button, press Enter, then Escape closes the dialog and focus returns to the `Pending changes` tab. After Save, the other identities can read team copies under the destination sharing rules.
6. Source access loss: after the owner restricts a copied source, the copier's `get_file_pending_target` and `list_files_pending_updates` drop `copiedFrom` for that row only. The copy still saves.
7. Media (owner, paid plan): build fixtures with `create_upload_node` plus a `fetch` PUT for both `shapes.png` and a `.md` that embeds `bonobo-file://<image id>`. Read the PNG bytes in the sandbox with `require("node:fs")`; bare `fs` is not defined there. `cp` of the doc alone must print `cp: Select the linked image or video files with this document` and exit 1. `cp -R` of the folder makes 3 drafts, and the doc embeds `bonobo-file://private/<image pendingNodeId>`. The doc's Accept stays disabled until its folder is saved. Accepting the doc alone gives `1 need review`: `Save the selected media first, or review it with this document.` Accept all then saves both. The saved doc keeps the private reference by design. `r2.get_media_by_reference` resolves it to the saved image with a new destination asset, and the image renders (`naturalWidth > 0`).
8. Background cp: `cp -R $T/src/sub $H/bg1 & { cp -R $T/src/sub $H/bg2; sleep 240; echo late; } &`. Both copies land as drafts. During the sleep, job 2 shows `Queued` with the rest of its script stored; that is a normal pause. `Stop Background command 2` in Notifications settles it as `Stopped`. After a reload, `jobs` is empty and `late` never ran.

### Archived-parent draft recovery

Use two identities: a member who owns an unsaved draft under a saved folder, and the org owner, who archives that folder.

1. The member creates the draft with a native agent `printf`. It must be ready with `canAccept=true`.
2. Archive the folder with `files_nodes.archive_nodes`. The tree row menu needs hover, which fails in a backgrounded tab.
3. As the member: path lookup returns null. `get_file_pending_target` by id returns `recovery: { expiresAt, savedParentId }` with `canAccept`, `canEdit`, and `canAcceptWithParents` all false. The org owner gets null.
4. Open `files?pendingNodeId=<id>`. Require `.FilePendingNotice[data-recovery="archived-parent"]`, `Unsaved draft expires <date>.`, the `Open archived folder` link (keyboard Enter opens the folder), the read-only accepted and proposed text with Copy buttons, and the toolbar text `Restore the archived folder before saving this draft.` No draft editor mounts. The chat composer and the zero-height shared Monaco container still match editor selectors, so check the size and parent.
5. `unarchive_nodes` brings back `canAccept`, `canEdit`, and `readiness: "ready"`.
6. Cleanup: restore parents before cleaning up drafts. Discard only owned drafts, archive only owned saved folders, and remove only the memberships added for this run.

The app's hidden Monaco hoisting container also matches `.monaco-editor`. Read the mounted editor with `.monaco-editor[data-uri]`, and scope further when a diff has two models.

## Script Pattern

For anything longer than a one-liner, keep the runner in a dated personal AI folder:

```powershell
$runDirectory = "../t3-chat-+personal/+ai/files-qa-$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$scriptPath = Join-Path $runDirectory "playwriter-files-check.js"
# Create this runner with the agent's targeted edit tool. Do not write it with a shell rewrite.
vp env exec pnpx playwriter -s $session -f $scriptPath --timeout 90000
```
