// Re-open the agent sidebar tab after a page reload (DOM click — locator.click hangs on backgrounded tab).
await state.page.evaluate(() => {
	const tab = document.querySelector("#app_file_editor_sidebar_tabs_agent");
	if (tab) tab.click();
	return !!tab;
});
await state.page.waitForSelector(".AiChatComposer-editor-content", { timeout: 15000 });
const out = await state.page.evaluate(() => ({
	composer: !!document.querySelector(".AiChatComposer-editor-content"),
	sendBtn: !!document.querySelector('[data-testid="ai-chat-send-button"]'),
}));
console.log(JSON.stringify(out));
