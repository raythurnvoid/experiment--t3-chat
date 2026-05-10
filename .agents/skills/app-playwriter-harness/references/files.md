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


## Rapid page-switch presence QA

For /files presence regressions, first make sure presence is enabled (left sidebar Presence region shows online users plus a Disable button). A reliable stress flow is to use treeitem locators for two sibling files, e.g. role=treeitem[name="setup"] and role=treeitem[name="readme"], click them back and forth 10+ times, then wait ~8-10s for presence heartbeats/disconnects. Check console/pageerror logs for presence:disconnect, presence:heartbeat, Rate limit exceeded, should_never_happen, and currentPresenceData. If the requested workspace tab is not Playwriter-enabled, bind any enabled localhost /files tab and navigate it to the target route instead of asking for a new tab.
