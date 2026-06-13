// QA-10 actions: close a tab, use the thread picker, create a new chat.
const readTabs = () =>
	state.page.evaluate(() => ({
		tabs: Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
			id: el.getAttribute("data-ai-chat-thread-id"),
			selected: el.querySelector('[aria-selected="true"]') !== null,
		})),
	}));

// 1. Close the optimistic "New chat" tab.
await state.page.evaluate(() => {
	const tab = document.querySelector('[data-ai-chat-thread-id="ai_thread-VKnG1WFRONgtfslLrTzzDUuigIyLiptK"]');
	const close = tab?.querySelector('button[aria-label="Close tab"]');
	if (!close) throw new Error("close button not found");
	close.click();
});
await state.page.waitForTimeout(1500);
const afterClose = await readTabs();
const closeGone = !afterClose.tabs.some((t) => t.id === "ai_thread-VKnG1WFRONgtfslLrTzzDUuigIyLiptK");
console.log("CLOSE TAB:", closeGone ? "PASS" : "FAIL", JSON.stringify(afterClose.tabs.length), "tabs left");

// 2. Close the currently selected tab (QA-7 thread) — fallback selection must move.
await state.page.evaluate(() => {
	const tab = document.querySelector('[data-ai-chat-thread-id="n1754871y7dwz0jbee3vy8n0nx88hcwb"]');
	tab?.querySelector('button[aria-label="Close tab"]')?.click();
});
await state.page.waitForTimeout(1500);
const afterClose2 = await readTabs();
console.log("CLOSE SELECTED:", JSON.stringify(afterClose2.tabs.filter((t) => t.selected)));

// 3. Thread picker: find its trigger button label.
const pickerLabels = await state.page.evaluate(() =>
	Array.from(document.querySelectorAll("#app_file_editor_sidebar_tabs_agent button, .FileEditorSidebarAgent button"))
		.map((el) => el.getAttribute("aria-label"))
		.filter(Boolean)
		.slice(0, 25),
);
console.log("PICKER CANDIDATE LABELS:", JSON.stringify(pickerLabels));
