# Comment Thread Persistence

Goal: verify a user can add a root comment, reply to it, refresh, and still see both messages.

Route: `http://localhost:5173/pages`

## Data strategy

- Do not hardcode page IDs.
- Prefer opening `Test/Test 2` if present.
- Fallback to the first selectable page row when `Test 2` is missing.
- Use dynamic comment text to avoid collisions.

## Step 1 - Open route and init run state

```js
state.qaPage = await context.newPage(); state.runId = Date.now().toString().slice(-6); state.rootComment = `pw_root_${state.runId}`; state.replyComment = `pw_reply_${state.runId}`; await state.qaPage.goto("http://localhost:5173/pages", { waitUntil: "domcontentloaded" }); await waitForPageLoad({ page: state.qaPage, timeout: 7000 });
```

## Step 2 - Wait for sidebar tree

```js
let count = 0; for (let i = 0; i < 20; i++) { count = await state.qaPage.evaluate(() => document.querySelectorAll(".PagesSidebarTreeItem").length); if (count > 0) break; await state.qaPage.waitForTimeout(300); } if (count === 0) throw new Error("Pages tree did not load");
```

## Step 3 - Open `Test/Test 2` (fallback to first row)

```js
await state.qaPage.evaluate(() => { const titles = Array.from(document.querySelectorAll(".PagesSidebarTreeItemPrimaryActionContent-title")); const test = titles.find((el) => el.textContent?.trim() === "Test"); if (test) { const row = test.closest(".PagesSidebarTreeItem"); const expand = row?.querySelector('button[aria-label="Expand page"]'); if (expand) expand.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } });
```

```js
await state.qaPage.evaluate(() => { const titles = Array.from(document.querySelectorAll(".PagesSidebarTreeItemPrimaryActionContent-title")); const target = titles.find((el) => el.textContent?.trim() === "Test 2") ?? titles[0]; if (!target) throw new Error("No pages available"); const row = target.closest(".PagesSidebarTreeItem"); const action = row?.querySelector(".PagesSidebarTreeItem-primary-action-interactive-area"); (action ?? target).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
```

```js
const richBtn = state.qaPage.getByRole("button", { name: /^Rich$/ }).first(); if (await richBtn.count()) await richBtn.click(); await state.qaPage.locator(".PageEditorRichText-editor-content").first().waitFor({ state: "visible", timeout: 20000 });
```

## Step 4 - Create root comment

```js
await state.qaPage.locator(".PageEditorRichText-editor-content").first().click(); await state.qaPage.keyboard.press("Control+A"); await state.qaPage.getByRole("button", { name: "Comment" }).click();
```

```js
await state.qaPage.locator(".PageEditorRichTextToolsComment .PageEditorRichTextCommentComposer-editor").first().fill(state.rootComment); await state.qaPage.locator(".PageEditorRichTextToolsComment-submit-button").first().click();
```

## Step 5 - Reply in thread

```js
await state.qaPage.locator(".PageEditorCommentsThread-summary").filter({ hasText: state.rootComment }).first().click(); await state.qaPage.locator(".PageEditorCommentsThreadForm .PageEditorRichTextCommentComposer-editor").first().fill(state.replyComment); await state.qaPage.locator(".PageEditorCommentsThreadForm-submit-button").first().click();
```

## Step 6 - Refresh and verify persistence

```js
await state.qaPage.reload({ waitUntil: "domcontentloaded" }); await waitForPageLoad({ page: state.qaPage, timeout: 7000 });
```

```js
await state.qaPage.locator(".PageEditorCommentsThread-summary").filter({ hasText: state.rootComment }).first().click(); const rootVisible = await state.qaPage.getByText(state.rootComment).first().isVisible(); const replyVisible = await state.qaPage.getByText(state.replyComment).first().isVisible(); console.log({ rootVisible, replyVisible, url: state.qaPage.url() }); if (!rootVisible || !replyVisible) throw new Error("Comment persistence check failed");
```

## Optional cleanup (resolve test thread)

```js
const thread = state.qaPage.locator(".PageEditorCommentsThread").filter({ hasText: state.rootComment }).first(); const resolveBtn = thread.locator(".PageEditorCommentsThreadResolveButton").first(); if (await resolveBtn.count()) await resolveBtn.click();
```

## Expected result

- Root comment is visible after submit.
- Reply is visible after submit.
- After refresh, root and reply are still visible once the thread is opened.
