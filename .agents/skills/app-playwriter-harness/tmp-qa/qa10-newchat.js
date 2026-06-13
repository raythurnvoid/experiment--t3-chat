await state.page.evaluate(() => {
	const btn = Array.from(document.querySelectorAll('button[aria-label="New chat"]')).find(
		(el) => el.getBoundingClientRect().width > 0,
	);
	if (!btn) throw new Error("New chat button not found");
	btn.click();
});
await state.page.waitForTimeout(1500);
const after = await state.page.evaluate(() => ({
	tabs: Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
		id: el.getAttribute("data-ai-chat-thread-id"),
		selected: el.querySelector('[aria-selected="true"]') !== null,
	})),
	messages: document.querySelectorAll(".AiChatMessage").length,
	composer: document.querySelector(".AiChatComposer-editor-content") !== null,
}));
const last = after.tabs.at(-1);
console.log(JSON.stringify({ last, tabCount: after.tabs.length, messages: after.messages, composer: after.composer }));
console.log("NEW CHAT:", last && last.id.startsWith("ai_thread-") && last.selected && after.messages === 0 ? "PASS" : "FAIL");
