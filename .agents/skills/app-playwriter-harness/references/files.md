# Files Browser Notes

Use this file for reusable `/files` route and editor interaction knowledge.

## Route

- Route shape: `/w/:workspaceName/:projectName/files?fileId=<id>`.
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

## Debugging Notes

- Start with `state.appPlaywriterHarness.observe({ search: /Files|Chat|Review|Toolbar/i })` to confirm the route and major controls.
- Use `state.appPlaywriterHarness.inspectLeftNav()` before clicking the main sidebar when diagnosing navigation clickability.
- Avoid force-clicking editor or sidebar controls; if a click is blocked, inspect the topmost element at the target point.


## Rapid page-switch presence QA

For /files presence regressions, first make sure presence is enabled (left sidebar Presence region shows online users plus a Disable button). A reliable stress flow is to use treeitem locators for two sibling files, e.g. role=treeitem[name="setup"] and role=treeitem[name="readme"], click them back and forth 10+ times, then wait ~8-10s for presence heartbeats/disconnects. Check console/pageerror logs for presence:disconnect, presence:heartbeat, Rate limit exceeded, should_never_happen, and currentPresenceData. If the requested workspace tab is not Playwriter-enabled, bind any enabled localhost /files tab and navigate it to the target route instead of asking for a new tab.
