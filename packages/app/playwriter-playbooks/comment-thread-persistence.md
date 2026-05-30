# Comment Thread Persistence

Goal: verify a user can add a root comment, reply to it, refresh, and still see both messages.

Route: `http://localhost:5173/files`

## Data strategy

- Do not hardcode file IDs.
- Prefer opening `Test/Test 2` if present.
- Fallback to the first selectable file row when `Test 2` is missing.
- Use dynamic comment text to avoid collisions.

## Step 1 - Open route and init run state

```js
state.qaPage = await context.newPage(); state.runId = Date.now().toString().slice(-6); state.rootComment = `pw_root_${state.runId}`; state.replyComment = `pw_reply_${state.runId}`; await state.qaPage.goto("http://localhost:5173/files", { waitUntil: "domcontentloaded" }); await waitForPageLoad({ page: state.qaPage, timeout: 7000 });
```

## Step 2 - Wait for sidebar tree

```js
let count = 0; for (let i = 0; i < 20; i++) { count = await state.qaPage.evaluate(() => document.querySelectorAll(".FilesSidebarTreeItem").length); if (count > 0) break; await state.qaPage.waitForTimeout(300); } if (count === 0) throw new Error("Files tree did not load");
```

## Step 3 - Open `Test/Test 2` (fallback to first row)

```js
await state.qaPage.evaluate(() => { const titles = Array.from(document.querySelectorAll(".FilesSidebarTreeItemPrimaryActionContent-title")); const test = titles.find((el) => el.textContent?.trim() === "Test"); if (test) { const row = test.closest(".FilesSidebarTreeItem"); const expand = row?.querySelector('button[aria-label="Expand folder"]'); if (expand) expand.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } });
```

```js
await state.qaPage.evaluate(() => { const titles = Array.from(document.querySelectorAll(".FilesSidebarTreeItemPrimaryActionContent-title")); const target = titles.find((el) => el.textContent?.trim() === "Test 2") ?? titles[0]; if (!target) throw new Error("No files available"); const row = target.closest(".FilesSidebarTreeItem"); const action = row?.querySelector(".FilesSidebarTreeItem-primary-action-interactive-area"); (action ?? target).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
```

```js
const richBtn = state.qaPage.getByRole("button", { name: /^Rich$/ }).first(); if (await richBtn.count()) await richBtn.click(); await state.qaPage.locator(".FileEditorRichText-editor-content").first().waitFor({ state: "visible", timeout: 20000 });
```

## Step 4 - Create root comment

```js
await state.qaPage.locator(".FileEditorRichText-editor-content").first().click(); await state.qaPage.keyboard.press("Control+A"); await state.qaPage.keyboard.type("Playwriter comment anchor text."); await state.qaPage.keyboard.press("Shift+Home"); await state.qaPage.getByRole("button", { name: "Comment" }).click();
```

```js
const newCommentForm = state.qaPage.getByRole("form", { name: "New document comment" }); await newCommentForm.locator('[contenteditable="true"][aria-label="Add comment to selection"]').fill(state.rootComment); await newCommentForm.getByRole("button", { name: "Submit comment" }).click();
```

## Step 5 - Reply in thread

```js
await state.qaPage.locator(".FileEditorCommentsThread-summary").filter({ hasText: state.rootComment }).first().click();
```

```js
const replyForm = state.qaPage.getByRole("form", { name: "Reply to comment" }); await replyForm.locator('[contenteditable="true"][aria-label="Reply to comment"]').fill(state.replyComment); await replyForm.getByRole("button", { name: "Reply to comment" }).click();
```

## Step 6 - Refresh and verify persistence

```js
await state.qaPage.reload({ waitUntil: "domcontentloaded" }); await waitForPageLoad({ page: state.qaPage, timeout: 7000 });
```

```js
await state.qaPage.locator(".FileEditorCommentsThread-summary").filter({ hasText: state.rootComment }).first().click(); const rootVisible = await state.qaPage.getByText(state.rootComment).first().isVisible(); const replyVisible = await state.qaPage.getByText(state.replyComment).first().isVisible(); console.log({ rootVisible, replyVisible, url: state.qaPage.url() }); if (!rootVisible || !replyVisible) throw new Error("Comment persistence check failed");
```

## Optional cleanup (resolve test thread)

```js
const thread = state.qaPage.locator(".FileEditorCommentsThread").filter({ hasText: state.rootComment }).first(); const resolveBtn = thread.locator(".FileEditorCommentsThreadResolveButton").first(); if (await resolveBtn.count()) await resolveBtn.click();
```

## Expected result

- Root comment is visible after submit.
- Reply is visible after submit.
- After refresh, root and reply are still visible once the thread is opened.
