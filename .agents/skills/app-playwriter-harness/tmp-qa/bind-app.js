// Bind state.page to an existing localhost:5173 tab, or open a new tab if none exists.
const pages = context.pages();
const existing = pages.find((p) => p.url().includes("localhost:5173"));
if (existing) {
	state.page = existing;
} else {
	state.page = await context.newPage();
}
await state.page.goto("http://localhost:5173/w/personal/home/files?nodeId=v97b3hqgj46x9fggj6nyex3q45887md2", {
	waitUntil: "domcontentloaded",
});
await state.page.waitForSelector("#app_file_editor_sidebar_tabs_agent", { state: "attached", timeout: 30000 });
await state.page.evaluate(() => document.querySelector("#app_file_editor_sidebar_tabs_agent").click());
await state.page.waitForSelector(".AiChatComposer-editor-content", { state: "attached", timeout: 30000 });
console.log(JSON.stringify({ url: state.page.url(), pageCount: pages.length, reusedTab: !!existing }));
