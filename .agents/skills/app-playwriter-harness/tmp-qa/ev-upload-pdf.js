// EV-0: upload r2-upload-sample.pdf into the 2026-06-12-a fixture uploads folder.
// Upload parent = URL-selected folder node, so navigate there first.
await state.page.goto("http://localhost:5173/w/personal/home/files?nodeId=v9788fx7chc1vrt5jdnaq76pch88htcb");
await state.page.waitForSelector('input[type="file"][aria-hidden="true"]', { state: "attached", timeout: 15000 });
await state.page.waitForTimeout(2500);

const selection = await state.page.evaluate(() => ({
	url: location.href,
	selectedRows: Array.from(document.querySelectorAll('[aria-selected="true"]')).map((el) =>
		(el.getAttribute("aria-label") || el.textContent || "").slice(0, 60),
	),
}));
console.log("SELECTION:", JSON.stringify(selection));

const input = state.page.locator('input[type="file"][aria-hidden="true"]');
await input.setInputFiles(
	"c:/Users/rt0/Documents/workspace/rt0/t3-chat/.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf",
);
console.log("setInputFiles done; waiting for upload");
await state.page.waitForTimeout(8000);

const after = await state.page.evaluate(() => ({
	modal: document.querySelector('[role="dialog"]')?.textContent?.slice(0, 200) ?? null,
	treeTexts: Array.from(document.querySelectorAll('[role="treeitem"]'))
		.map((el) => el.getAttribute("aria-label") || "")
		.filter((t) => t.toLowerCase().includes("pdf") || t.toLowerCase().includes("upload"))
		.slice(0, 10),
}));
console.log("AFTER:", JSON.stringify(after));
