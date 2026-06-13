// Discard the C11 pending update on the fixture README via the file-editor diff UI.
const README_NODE_URL = "http://localhost:5173/w/personal/home/files?nodeId=v971ytcakn8d7yt0443peqj3q188hxej";
if (!state.page.url().includes("v971ytcakn8d7yt0443peqj3q188hxej")) {
	await state.page.goto(README_NODE_URL, { waitUntil: "domcontentloaded" });
}
// The diff editor (with Accept/Discard) opens via the "Review changes" button.
await state.page.waitForFunction(
	() => Array.from(document.querySelectorAll("button")).some((b) => (b.textContent || "").trim() === "Review changes"),
	{ timeout: 30000 },
);
await state.page.evaluate(() => {
	Array.from(document.querySelectorAll("button"))
		.find((b) => (b.textContent || "").trim() === "Review changes")
		.click();
});
await state.page.waitForSelector('[aria-label="Discard all pending changes"]', { state: "attached", timeout: 30000 });
const before = await state.page.evaluate(() => {
	const btn = document.querySelector('[aria-label="Discard all pending changes"]');
	return { found: !!btn, disabled: btn ? btn.disabled : null };
});
if (before.found && !before.disabled) {
	await state.page.evaluate(() => {
		document.querySelector('[aria-label="Discard all pending changes"]').click();
	});
}
// Let the debounced pending-update upsert flush before reporting.
await new Promise((r) => setTimeout(r, 6000));
const after = await state.page.evaluate(() => {
	const btn = document.querySelector('[aria-label="Discard all pending changes"]');
	return { found: !!btn, disabled: btn ? btn.disabled : null };
});
console.log(JSON.stringify({ before, after }, null, 1));
