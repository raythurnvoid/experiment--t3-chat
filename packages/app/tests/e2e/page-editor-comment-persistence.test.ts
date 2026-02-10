import { expect, test, type Page } from "@playwright/test";

const pagesTreeItem = ".PagesSidebarTreeItem";
const pagesTitle = ".PagesSidebarTreeItemPrimaryActionContent-title";
const pagesPrimaryAction = ".PagesSidebarTreeItem-primary-action-interactive-area";
const editorContent = ".PageEditorRichText-editor-content";
const commentComposerEditor = ".PageEditorRichTextCommentComposer-editor";
const threadSummary = ".PageEditorCommentsThread-summary";

async function waitForPagesTreeReady(page: Page) {
	await page.waitForLoadState("domcontentloaded");
	await expect
		.poll(async () => page.locator(pagesTreeItem).count(), {
			message: "Expected pages tree to have at least one item",
			timeout: 20_000,
		})
		.toBeGreaterThan(0);
}

async function clickPageByTitle(page: Page, title: string) {
	const searchInput = page.getByPlaceholder("Search pages");
	await searchInput.fill(title);

	const pageTitle = page.locator(pagesTitle).filter({ hasText: new RegExp(`^${title}$`) }).first();
	await expect(pageTitle).toBeVisible({ timeout: 3_000 });

	const pageRow = pageTitle.locator(`xpath=ancestor::*[contains(@class,"PagesSidebarTreeItem")][1]`);
	await pageRow.locator(pagesPrimaryAction).click();

	await searchInput.fill("");
}

async function openPageForComments(page: Page) {
	const preferredTitles = ["Test 2", "Test"];

	for (const title of preferredTitles) {
		try {
			await clickPageByTitle(page, title);
			await expect(page.locator(editorContent).first()).toBeVisible({ timeout: 8_000 });
			return;
		} catch {
			// keep trying fallbacks
		}
	}

	await page.locator(`${pagesTreeItem} ${pagesPrimaryAction}`).first().click();
	await expect(page.locator(editorContent).first()).toBeVisible({ timeout: 15_000 });

	return;
}

test("adds a comment and reply that persist after refresh", async ({ page }) => {
	const runId = Date.now().toString().slice(-8);
	const rootComment = `e2e_root_${runId}`;
	const replyComment = `e2e_reply_${runId}`;

	await page.goto("/pages");
	await waitForPagesTreeReady(page);
	await openPageForComments(page);

	const richViewButton = page.getByRole("button", { name: /^Rich$/ }).first();
	if (await richViewButton.isVisible()) {
		await richViewButton.click();
	}

	await expect(page.locator(editorContent).first()).toBeVisible({ timeout: 20_000 });
	await page.locator(editorContent).first().click();
	await page.keyboard.press("Control+A");

	await page.getByRole("button", { name: "Comment" }).click();
	const rootComposer = page.locator(`.PageEditorRichTextToolsComment ${commentComposerEditor}`).first();
	await expect(rootComposer).toBeVisible();
	await rootComposer.fill(rootComment);
	await page.locator(".PageEditorRichTextToolsComment-submit-button").first().click();

	const matchingSummary = page.locator(threadSummary).filter({ hasText: rootComment }).first();
	await expect(matchingSummary).toBeVisible();
	await matchingSummary.click();

	const replyComposer = page.locator(`.PageEditorCommentsThreadForm ${commentComposerEditor}`).first();
	await expect(replyComposer).toBeVisible();
	await replyComposer.fill(replyComment);
	await page.locator(".PageEditorCommentsThreadForm-submit-button").first().click();

	await expect(page.getByText(rootComment).first()).toBeVisible();
	await expect(page.getByText(replyComment).first()).toBeVisible();

	await page.reload({ waitUntil: "domcontentloaded" });
	await waitForPagesTreeReady(page);
	await expect
		.poll(async () => page.locator(threadSummary).count(), {
			message: "Expected at least one comment thread after refresh",
			timeout: 20_000,
		})
		.toBeGreaterThan(0);

	const refreshedSummary = page.locator(threadSummary).filter({ hasText: rootComment }).first();
	await refreshedSummary.click();

	await expect(page.getByText(rootComment).first()).toBeVisible();
	await expect(page.getByText(replyComment).first()).toBeVisible();

	const threadDetails = page.locator(".PageEditorCommentsThread").filter({ hasText: rootComment }).first();
	await threadDetails.locator(".PageEditorCommentsThreadResolveButton").first().click();
});
