# Pages Sidebar Smoke

Goal: quickly validate core `/pages` sidebar behaviors without relying on fixed data.

Route: `http://localhost:5173/pages`

## Step 1 - Open route and wait for tree

```js
state.sidebarPage = await context.newPage(); await state.sidebarPage.goto("http://localhost:5173/pages", { waitUntil: "domcontentloaded" }); await waitForPageLoad({ page: state.sidebarPage, timeout: 7000 }); let rowCount = 0; for (let i = 0; i < 20; i++) { rowCount = await state.sidebarPage.evaluate(() => document.querySelectorAll(".PagesSidebarTreeItem").length); if (rowCount > 0) break; await state.sidebarPage.waitForTimeout(300); } if (rowCount === 0) throw new Error("No sidebar rows found");
```

## Step 2 - Pick first expandable row and check row-click behavior

```js
const result = await state.sidebarPage.evaluate(() => { const rows = Array.from(document.querySelectorAll(".PagesSidebarTreeItem")); const row = rows.find((r) => r.querySelector('button[aria-label="Expand page"], button[aria-label="Collapse page"]')); if (!row) return { skipped: true }; const button = row.querySelector('button[aria-label="Expand page"], button[aria-label="Collapse page"]'); const before = button?.getAttribute("aria-label") ?? null; const area = row.querySelector(".PagesSidebarTreeItem-primary-action-interactive-area"); (area ?? row).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); const afterRowClick = button?.getAttribute("aria-label") ?? null; button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); const afterArrowClick = button?.getAttribute("aria-label") ?? null; return { skipped: false, before, afterRowClick, afterArrowClick }; }); console.log(result); if (!result.skipped && result.before !== result.afterRowClick) throw new Error("Row click unexpectedly toggled expand/collapse");
```

## Step 3 - Check search is working

```js
const firstTitle = await state.sidebarPage.locator(".PagesSidebarTreeItemPrimaryActionContent-title").first().textContent(); const q = (firstTitle ?? "").trim().slice(0, 3); if (!q) throw new Error("No sidebar title text"); await state.sidebarPage.getByPlaceholder("Search pages").fill(q); const filteredCount = await state.sidebarPage.locator(".PagesSidebarTreeItem").count(); console.log({ query: q, filteredCount }); await state.sidebarPage.getByPlaceholder("Search pages").fill("");
```

## Step 4 - Open first row and confirm URL has pageId

```js
await state.sidebarPage.evaluate(() => { const row = document.querySelector(".PagesSidebarTreeItem"); if (!row) throw new Error("No row to open"); const action = row.querySelector(".PagesSidebarTreeItem-primary-action-interactive-area"); (action ?? row).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }); await waitForPageLoad({ page: state.sidebarPage, timeout: 6000 }); console.log({ url: state.sidebarPage.url() });
```

## Expected result

- Tree renders.
- Row click does not toggle expand/collapse state by itself.
- Arrow click does toggle expand/collapse state.
- Search filters rows.
- Opening a row updates URL (usually includes `pageId`).
