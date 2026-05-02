# Pages Browser Notes

Use this file for reusable `/pages` route and editor interaction knowledge.

## Route

- Route shape: `/w/:workspaceName/:projectName/pages?pageId=<id>`.
- Optional `view` search param selects editor mode:
  - `rich_text_editor`
  - `plain_text_editor`
  - `diff_editor`

## Stable Selectors

- Pending edits banner: `[data-testid="pending-edits-banner"]`.
- Review changes button: `[data-testid="review-changes-button"]`.
- Diff editor root: `[aria-label="Page diff editor"]`.
- Rich text toolbar: `[role="toolbar"][aria-label="Toolbar"]`.
- Rich text content root class: `.PageEditorRichText-editor-content-root`.
- Rich text content class: `.PageEditorRichText-editor-content`.

## Debugging Notes

- Start with `state.appPlaywriterHarness.observe({ search: /Pages|Chat|Review|Toolbar/i })` to confirm the route and major controls.
- Use `state.appPlaywriterHarness.inspectLeftNav()` before clicking the main sidebar when diagnosing navigation clickability.
- Avoid force-clicking editor or sidebar controls; if a click is blocked, inspect the topmost element at the target point.
