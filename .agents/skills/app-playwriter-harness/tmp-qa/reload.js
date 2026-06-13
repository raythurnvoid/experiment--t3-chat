// Recover a discarded/blank tab: navigate to the files page and wait for the app shell.
await state.page.goto("http://localhost:5173/w/personal/home/files?nodeId=v97b3hqgj46x9fggj6nyex3q45887md2", {
	waitUntil: "domcontentloaded",
	timeout: 30000,
});
await state.page.waitForSelector("#app_file_editor_sidebar_tabs_agent", { state: "attached", timeout: 30000 });
await state.page.evaluate(() => {
	document.querySelector("#app_file_editor_sidebar_tabs_agent").click();
});
await state.page.waitForSelector(".AiChatComposer-editor-content", { state: "attached", timeout: 15000 });
const out = await state.page.evaluate(() => ({
	url: location.href,
	composer: !!document.querySelector(".AiChatComposer-editor-content"),
	sendBtn: !!document.querySelector('[data-testid="ai-chat-send-button"]'),
}));
console.log(JSON.stringify(out));
