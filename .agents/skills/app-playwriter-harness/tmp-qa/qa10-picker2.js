// QA-10 picker via DOM clicks (backgrounded-tab-safe).
const readTabs = () =>
	state.page.evaluate(() => ({
		tabs: Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
			id: el.getAttribute("data-ai-chat-thread-id"),
			selected: el.querySelector('[aria-selected="true"]') !== null,
		})),
	}));

await state.page.evaluate(() => {
	const btn = document.querySelector('button[aria-label="Past chats"]');
	if (!btn) throw new Error("Past chats button not found");
	btn.click();
});
await state.page.waitForTimeout(1500);

const open = await state.page.evaluate(() => {
	const btn = document.querySelector('button[aria-label="Past chats"]');
	const list = document.querySelector(".FileEditorSidebarAgentThreadPickerList-list, [class*='FileEditorSidebarAgentThreadPickerList']");
	const options = list
		? Array.from(list.querySelectorAll('[role="option"], button')).map((el) => ({
				role: el.getAttribute("role"),
				text: (el.textContent || "").slice(0, 50),
				ariaLabel: el.getAttribute("aria-label"),
			}))
		: [];
	return { expanded: btn?.getAttribute("aria-expanded"), options: options.slice(0, 12) };
});
console.log("PICKER OPEN:", JSON.stringify(open, null, 2));
