# Files Browser Notes

Use this file for reusable `/files` route and editor interaction knowledge.

## Route

- Route shape: `/w/:workspaceName/:projectName/files?nodeId=<id>`.
- `nodeId=root` opens the root folder browser. Folder node ids open the folder browser, and file node ids open the file editor.
- Optional `view` search param selects editor mode:
  - `rich_text_editor`
  - `plain_text_editor`
  - `diff_editor`

## Stable Selectors

- Pending updates banner: `[data-testid="pending-edits-banner"]`.
- Review changes button: `[data-testid="review-changes-button"]`.
- Diff editor root: `[aria-label="File diff editor"]`.
- Rich text toolbar: `[role="toolbar"][aria-label="Toolbar"]`.
- Rich text content root class: `.FileEditorRichText-editor-content-root`.
- Rich text content class: `.FileEditorRichText-editor-content`.
- Folder explorer root: `.FileNodeViewFolderExplorer`.
- Folder explorer rows: `.FileNodeViewFolderExplorer-row`.
- Folder explorer drag target state: `.FileNodeViewFolderExplorer-row-drop-target`.
- Folder explorer dragging source state: `.FileNodeViewFolderExplorer-row-dragging`.

## Debugging Notes

- Start with `state.appPlaywriterHarness.observe({ search: /Files|Chat|Review|Toolbar/i })` to confirm the route and major controls.
- Use `state.appPlaywriterHarness.inspectElement(...)` before clicking the main sidebar when diagnosing navigation clickability.
- Avoid force-clicking editor or sidebar controls; if a click is blocked, inspect the topmost element at the target point.
- Editor mode radios are visually represented by labels in the app header. If clicking a radio locator times out because the native input is tiny, click the matching `#app_main_header_content label` instead.
- Source files and generated `.shadow.md` files share filename prefixes. Use exact role-name locators for per-node action buttons, such as `getByRole("button", { name: "More actions for qa.pdf", exact: true })`, so the source locator does not also match `qa.pdf.shadow.md`.
- When the folder explorer is visible, it can render a second action button with the same accessible name as the tree action. Scope the locator to the tree/folder row or use `.first()` intentionally after confirming the snapshot.
- Inline create/rename inputs are often selected by their current value in snapshots. After `fill(...)`, that locator may stop matching before `press("Enter")`; re-locate by the new value, scope to the focused input/modal, or press Enter through `page.keyboard` after confirming focus.

## Resize Handle QA

Keep resize-handle checks as recipe snippets instead of installed harness helpers. The useful checks are:

- inspect `.MyPanelResizeHandle[aria-label="Resize files sidebar"]`
- read `.MyPanelResizeHandleGrip-pill` background and outline colors
- read `.MyPanelResizeHandleGrip-icon` stroke/color/z-index
- hit-test the center of `.MyPanelResizeHandleGrip` and confirm the cursor is `ew-resize`
- drag both the regular handle track and the larger grip hit area, then double-click reset

Generic inspection command:

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' }); await state.appPlaywriterHarness.inspectElement({ selector: '.MyPanelResizeHandle', attribute: { name: 'aria-label', value: 'Resize files sidebar' }, computedStyles: [{ name: 'pill', selector: '.MyPanelResizeHandleGrip-pill', properties: ['backgroundColor', 'outlineColor', 'outlineWidth'] }, { name: 'icon', selector: '.MyPanelResizeHandleGrip-icon', properties: ['stroke', 'color', 'zIndex'] }], hitTargets: [{ name: 'grip center', selector: '.MyPanelResizeHandleGrip' }] });"
```

## Folder Create QA

Keep folder/file creation checks as a route-specific recipe. Do not promote this flow into the installed harness unless it becomes generic across routes.

- Bind a single `/files` tab and verify no extra Playwriter-enabled tabs open during the flow.
- From the root folder, click `New folder in current folder`.
- Verify the default folder name matches `new-folder` or `new-folder-<n>` and the whole value is selected.
- Create a temporary folder with a unique `aaa-pw-qa-*` name and verify the route does not navigate.
- Open the temporary folder and verify the empty-folder toolbar exposes `New file in current folder` and `New folder in current folder`.
- Click `New file in current folder`, verify the default file name matches `new-file.md` or `new-file-<n>.md`, and verify only the basename is selected.
- Create `deep/path/example.md`, verify the route does not navigate, and verify a top-level `deep` folder row appears.
- Try creating the same deep file path again and verify `This file already exists.` disables `Create file`.
- Try creating `deep/path` as a folder and verify `This folder already exists.` disables `Create folder`.
- Archive the temporary `aaa-pw-qa-*` folder at the end of the flow.

## Folder Explorer Drag And Drop QA

Keep folder-table drag/drop checks as a route-specific recipe. The folder table uses Pragmatic Drag and Drop, while the sidebar tree still uses Headless Tree DnD.

- Bind a single `/files` tab and navigate to a folder screen or root folder screen where `.FileNodeViewFolderExplorer` is visible.
- Create a temporary `aaa-pw-dnd-*` folder with two child folders and at least one Markdown file so the folder table has both draggable files and folder drop targets.
- Use real Playwright drag gestures: prefer `source.dragTo(target)`; if that is flaky for this table, use `mouse.move`, `mouse.down`, stepped `mouse.move`, and `mouse.up`. Do not use `dispatchEvent`, DOM `element.click()`, or forced clicks.
- Drag the Markdown file row onto a folder row. Verify the source row leaves the current folder table, then open the target folder and verify the file appears there.
- Drag one folder row onto another folder row. Verify the moved folder leaves the current folder table and appears inside the target folder.
- Try dragging a row onto a file row. Verify no move occurs and no `FileNodeViewFolderExplorer-row-drop-target` state is applied to the file row.
- Try same-parent or self/descendant-style moves when the setup exposes them. Verify no move occurs.
- While a move is pending, verify the pending row does not start another drag and the more-actions button remains disabled.
- After folder-table checks, run one sidebar tree move or external file upload drop to confirm the unchanged Headless Tree DnD flow still works.

## Sidebar Tree Drop Zone Visual QA

Keep sidebar drop-zone checks as a route-specific recipe because they depend on Headless Tree drag state, the `/files` sidebar layout, and the fixed 44px tree rows.

- Bind a single `/files` tab and create or reuse a visible nested tree like `new-folder/drop-child/drop-grandchild/test.md`, plus a root-level `README.md`.
- Capture a baseline screenshot before dragging so visual comparison has the normal tree rails, selected row, folder indentation, and root/sidebar borders.
- Verify root drops by dragging over the empty tree area: the full tree/root area should show one orange dotted enclosure and a compact `Drop at root` indicator.
- Verify folder drops at depth 0, depth 1, and depth 2/collapsed folders: the orange dotted enclosure should cover the target folder row plus the whole visible subtree, not only the target row.
- Verify invalid file-row drops: hovering a file row must not show the folder/root drop-zone visual or upload into the file's parent.
- Inspect computed styles for `.FilesSidebarTreeDropZoneArea` and `.FilesSidebarTreeDropZoneIndicator-label`. The indicator should be transparent and blurred with no glow, and the dotted area should use the app accent token.
- Check the accessibility snapshot while the indicator is visible. The visual indicator is `aria-hidden`; the snapshot should still expose the normal `files_nodes` tree and treeitems without an extra button, link, or duplicate drop-zone label.

## Sidebar Tree Row Surface Visual QA

Keep row-surface checks as a lightweight Playwriter/manual recipe because they verify CSS state styling without needing committed browser tests.

- Bind a single `/files` tab and inspect a visible `.FilesSidebarTreeItemPrimaryAction`.
- Verify idle, not-selected, not-focused rows have no elevated gradient surface.
- Verify selected rows, Headless Tree focused rows from arrow-key navigation, hovered rows, and focus-visible rows use the elevated gradient surface.
- Verify active/pressed rows use the darker pressed gradient and inset-only shadow.
- Inspect computed styles for the primary action: `borderWidth` should be `0px`, `outlineStyle` should be `none`, and no transparent rim should appear between the row edge and the shadowed surface.
- Confirm secondary action buttons still use their existing button styling and do not inherit the row-surface treatment.

## Sidebar Tree Selection Context QA

Keep selection-context checks as a route-specific Playwriter recipe. The behavior depends on Headless Tree state, TanStack route state, portaled menus, and browser focus/pointer events, so prefer this recipe over committed browser tests or mocked tree instances.

- Bind a single `/files` tab and clear the search box.
- Ensure the route is on a non-root `nodeId`; if it is missing or `root`, click the first visible `.FilesSidebarTreeItemPrimaryAction` and wait for the URL `nodeId` to match that row's `data-file-id`.
- Read selected rows with `.FilesSidebarTreeItem[data-file-id]:has(.FilesSidebarTreeItemPrimaryAction[aria-selected="true"])`.
- Control-click a non-navigated visible row and verify at least two selected ids are visible.
- Click the Search files input. The selected ids should reconcile to exactly `[nodeId]`.
- Recreate the multi-selection, open a row `More actions` menu, and verify the multi-selection remains visible while the menu is open. Then click Search files and verify it reconciles to `[nodeId]`.
- Recreate the multi-selection, open the top `More options` menu, and verify the multi-selection remains visible while the menu is open. Then click Search files and verify it reconciles to `[nodeId]`.
- Recreate the multi-selection and click empty whitespace inside `.FilesSidebarTree`, below the last visible row when space is available. The selected ids should reconcile to exactly `[nodeId]`.
- Navigate to `nodeId=root`, Control-click two visible rows, then click Search files or empty tree whitespace. The selected ids should become `[]`.
- Do not click archive/delete menu items during this check.

Reusable script shape:

```powershell
$scriptPath = Join-Path $env:TEMP 'playwriter-files-sidebar-selection-context-check.js'
@'
await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/files' });
state.page.setDefaultTimeout(10000);

const treeRows = state.page.locator(".FilesSidebarTreeItem[data-file-id]");
const searchInput = state.page.locator('input[placeholder="Search files"]').first();
await treeRows.first().waitFor({ timeout: 10000 });
await searchInput.fill("");

async function selectedIds() {
	const selectedRows = state.page.locator('.FilesSidebarTreeItem[data-file-id]:has(.FilesSidebarTreeItemPrimaryAction[aria-selected="true"])');
	const ids = [];
	const count = await selectedRows.count();
	for (let index = 0; index < count; index++) {
		ids.push(await selectedRows.nth(index).getAttribute("data-file-id"));
	}
	return ids;
}

async function waitForNodeId(expectedNodeId) {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (new URL(state.page.url()).searchParams.get("nodeId") === expectedNodeId) return;
		await state.page.waitForTimeout(100);
	}
	throw new Error(`Expected URL nodeId ${expectedNodeId}, got ${state.page.url()}`);
}

async function expectSelectedIds(expectedIds, label) {
	await state.page.waitForTimeout(250);
	const actualIds = await selectedIds();
	console.log(label, actualIds);
	if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
		throw new Error(`${label}: expected ${JSON.stringify(expectedIds)}, got ${JSON.stringify(actualIds)}.`);
	}
}

async function firstNonNavigatedRow(navigatedId) {
	const count = await treeRows.count();
	for (let index = 0; index < count; index++) {
		const row = treeRows.nth(index);
		const id = await row.getAttribute("data-file-id");
		if (id && id !== navigatedId) return row;
	}
	throw new Error("No non-navigated row is available.");
}

let navigatedId = new URL(state.page.url()).searchParams.get("nodeId");
if (!navigatedId || navigatedId === "root") {
	const firstRow = treeRows.first();
	const firstRowId = await firstRow.getAttribute("data-file-id");
	if (!firstRowId) throw new Error("Could not read the first row id.");
	await firstRow.locator(".FilesSidebarTreeItemPrimaryAction").click();
	await waitForNodeId(firstRowId);
	navigatedId = firstRowId;
}

async function createMultiSelection() {
	const row = await firstNonNavigatedRow(navigatedId);
	const rowId = await row.getAttribute("data-file-id");
	await row.locator(".FilesSidebarTreeItemPrimaryAction").click({ modifiers: ["Control"] });
	const ids = await selectedIds();
	if (!rowId || ids.length < 2 || !ids.includes(navigatedId) || !ids.includes(rowId)) {
		throw new Error(`Expected navigated row ${navigatedId} and Control-click row ${rowId} to be selected, got ${JSON.stringify(ids)}.`);
	}
	return { row, rowId };
}

await createMultiSelection();
await searchInput.click();
await expectSelectedIds([navigatedId], "Search input reconciles to navigated row");

const rowMenuSelection = await createMultiSelection();
await rowMenuSelection.row.hover();
await rowMenuSelection.row.locator(".FilesSidebarTreeItemMoreAction").first().click();
await state.page.locator('[data-files-sidebar-tree-context][role="menu"]').first().waitFor({ timeout: 5000 });
if ((await selectedIds()).length < 2) throw new Error("Expected row menu to keep multi-selection visible.");
await searchInput.click();
await expectSelectedIds([navigatedId], "Leaving row menu reconciles to navigated row");

await createMultiSelection();
await state.page.locator(".FilesSidebarTopSectionMoreAction").first().click();
await state.page.locator('[data-files-sidebar-tree-context][role="menu"]').first().waitFor({ timeout: 5000 });
if ((await selectedIds()).length < 2) throw new Error("Expected top menu to keep multi-selection visible.");
await searchInput.click();
await expectSelectedIds([navigatedId], "Leaving top menu reconciles to navigated row");

await createMultiSelection();
const treeBox = await state.page.locator(".FilesSidebarTree").first().boundingBox();
const lastRowBox = await treeRows.last().boundingBox();
if (treeBox && lastRowBox && treeBox.y + treeBox.height > lastRowBox.y + lastRowBox.height + 24) {
	await state.page.mouse.click(treeBox.x + treeBox.width / 2, Math.min(treeBox.y + treeBox.height - 12, lastRowBox.y + lastRowBox.height + 24));
	await expectSelectedIds([navigatedId], "Tree whitespace reconciles to navigated row");
} else {
	console.log("Skipped tree whitespace click because no empty tree area is visible.");
}

const rootUrl = new URL(state.page.url());
rootUrl.searchParams.set("nodeId", "root");
rootUrl.searchParams.delete("view");
await state.page.goto(rootUrl.toString(), { waitUntil: "commit" });
await treeRows.first().waitFor({ timeout: 10000 });
await searchInput.fill("");
await treeRows.first().locator(".FilesSidebarTreeItemPrimaryAction").click({ modifiers: ["Control"] });
await treeRows.nth(1).locator(".FilesSidebarTreeItemPrimaryAction").click({ modifiers: ["Control"] });
if ((await selectedIds()).length < 2) throw new Error("Expected temporary root multi-selection before reset.");
await searchInput.click();
await expectSelectedIds([], "Root route outside interaction clears selection");

state.page.removeAllListeners();
'@ | Set-Content -LiteralPath $scriptPath -Encoding utf8
pnpx playwriter -s $session -f $scriptPath --timeout 90000
```

## R2 Upload QA

Keep R2 upload checks as a route-specific recipe. Do not promote this flow into the installed harness unless file upload controls become a generic primitive across routes.

- Fixture asset: `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`. Keep harness file assets under Git LFS.
- Bind a single `/files` tab and verify no dedicated Uploads section appears in the files sidebar.
- From the root folder or a temporary `aaa-pw-qa-*` folder, click `Upload file`, then set the hidden `input[type="file"]` to the fixture path.
- Select the target folder before clicking the sidebar `Upload file` item. If a file is selected, the current sidebar upload flow targets root, which can make same-name collision checks look like duplicate creation in different folders.
- Verify a normal tree node named `r2-upload-sample.pdf` appears immediately after upload preparation; it should not appear in a separate uploads list.
- Open the new source file node and verify the file panel shows a processing/pending state instead of the converted file until finalization completes.
- Upload the same fixture to the same folder again and verify the modal title is `File already exists` with `Replace` and `Upload renamed file` actions.
- Choose `Upload renamed file` with a unique filename such as `r2-upload-sample-<timestamp>.pdf` and verify the renamed source file node appears in the normal tree.
- Repeat the collision flow and choose `Replace`; verify the old active source is archived and the replacement source appears as the active `r2-upload-sample.pdf`.
- Archive the temporary `aaa-pw-qa-*` folder at the end of the flow.
- Oversized upload UI checks are hard to drive through Playwriter because `setInputFiles` refuses files larger than 50 MB in extension mode. Prefer backend/unit coverage for the size gate, or use a smaller app-configured size limit in a dedicated test build if browser-level oversized QA becomes required.


## Comments And Agent QA

Keep comments/agent checks as route-specific recipes because they depend on the active editor.

- To create a rich-text comment, focus text in `.FileEditorRichText-editor-content`, select content with keyboard selection, click the bubble `Comment` button, type into `.FileEditorRichTextCommentComposer-editor`, then click `Submit comment`.
- Verify the comments sidebar shows the new thread under the `Comments` tab and that `Search comments` appears once at least one thread exists.
- To test file-agent search/read/edit, use a unique token in the selected Markdown file, open the `Agent` tab, and ask the agent to search for that token, read the matching file, and make a small edit. Verify the agent message shows `Search files`, `Read file`, and `Edit file` tool disclosures, then review/apply the pending edit through `[data-testid="review-changes-button"]`.
- If native editor mode radios time out in Playwriter, click the corresponding `#app_main_header_content label` instead of force-clicking the radio input.


## Rapid page-switch presence QA

For /files presence regressions, first make sure presence is enabled (left sidebar Presence region shows online users plus a Disable button). A reliable stress flow is to use treeitem locators for two sibling files, e.g. role=treeitem[name="setup"] and role=treeitem[name="readme"], click them back and forth 10+ times, then wait ~8-10s for presence heartbeats/disconnects. Check console/pageerror logs for presence:disconnect, presence:heartbeat, Rate limit exceeded, should_never_happen, and currentPresenceData. If the requested workspace tab is not Playwriter-enabled, bind any enabled localhost /files tab and navigate it to the target route instead of asking for a new tab.
