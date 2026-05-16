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

## Debugging Notes

- Start with `state.appPlaywriterHarness.observe({ search: /Files|Chat|Review|Toolbar/i })` to confirm the route and major controls.
- Use `state.appPlaywriterHarness.inspectElement(...)` before clicking the main sidebar when diagnosing navigation clickability.
- Avoid force-clicking editor or sidebar controls; if a click is blocked, inspect the topmost element at the target point.
- Editor mode radios are visually represented by labels in the app header. If clicking a radio locator times out because the native input is tiny, click the matching `#app_main_header_content label` instead.
- Source files and generated `.shadow.md` files share filename prefixes. Use exact role-name locators for per-node action buttons, such as `getByRole("button", { name: "More actions for qa.pdf", exact: true })`, so the source locator does not also match `qa.pdf.shadow.md`.
- When the folder explorer is visible, it can render a second action button with the same accessible name as the tree action. Scope the locator to the tree/folder row or use `.first()` intentionally after confirming the snapshot.

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

## R2 Upload QA

Keep R2 upload checks as a route-specific recipe. Do not promote this flow into the installed harness unless file upload controls become a generic primitive across routes.

- Fixture asset: `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`. Keep harness file assets under Git LFS.
- Bind a single `/files` tab and verify no dedicated Uploads section appears in the files sidebar.
- From the root folder or a temporary `aaa-pw-qa-*` folder, click `Upload file`, then set the hidden `input[type="file"]` to the fixture path.
- Verify a normal tree node named `r2-upload-sample.pdf` appears immediately after upload preparation; it should not appear in a separate uploads list.
- Open the new source node and verify the file panel shows a processing/pending state instead of the converted file until finalization completes.
- Upload the same fixture to the same folder again and verify the modal title is `File already exists` with `Replace` and `Upload renamed file` actions.
- Choose `Upload renamed file` with a unique filename such as `r2-upload-sample-<timestamp>.pdf` and verify the renamed source node appears in the normal tree.
- Repeat the collision flow and choose `Replace`; verify the old active source is archived and the replacement source appears as the active `r2-upload-sample.pdf`.
- Archive the temporary `aaa-pw-qa-*` folder at the end of the flow.
- Oversized upload UI checks are hard to drive through Playwriter because `setInputFiles` refuses files larger than 50 MB in extension mode. Prefer backend/unit coverage for the size gate, or use a smaller app-configured size limit in a dedicated test build if browser-level oversized QA becomes required.


## Rapid page-switch presence QA

For /files presence regressions, first make sure presence is enabled (left sidebar Presence region shows online users plus a Disable button). A reliable stress flow is to use treeitem locators for two sibling files, e.g. role=treeitem[name="setup"] and role=treeitem[name="readme"], click them back and forth 10+ times, then wait ~8-10s for presence heartbeats/disconnects. Check console/pageerror logs for presence:disconnect, presence:heartbeat, Rate limit exceeded, should_never_happen, and currentPresenceData. If the requested workspace tab is not Playwriter-enabled, bind any enabled localhost /files tab and navigate it to the target route instead of asking for a new tab.
