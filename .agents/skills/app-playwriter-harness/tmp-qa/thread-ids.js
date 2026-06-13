const info = await state.page.evaluate(() => {
	const tabs = Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
		id: el.getAttribute("data-ai-chat-thread-id"),
		title: (el.querySelector(".FileEditorSidebarAgentHeaderTabs-tab-title")?.textContent || "").slice(0, 60),
		selected: el.querySelector('[aria-selected="true"]') !== null,
	}));
	const selectedTab = document.querySelector('[aria-label="Open chats"] [aria-selected="true"]');
	return { tabs, selectedTabId: selectedTab?.id ?? null };
});
console.log(JSON.stringify(info, null, 2));
