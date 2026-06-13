const info = await state.page.evaluate(() => {
	const tabsEl = document.querySelector('[aria-label="Open chats"]');
	const agentTab = document.getElementById("app_file_editor_sidebar_tabs_agent");
	return {
		url: location.href,
		title: document.title,
		hasOpenChats: tabsEl !== null,
		openChatsText: tabsEl ? (tabsEl.textContent || "").slice(0, 300) : null,
		hasAgentRootTab: agentTab !== null,
		agentRootSelected: agentTab?.getAttribute("aria-selected") ?? null,
		composer: document.querySelector(".AiChatComposer-editor-content") !== null,
		viteErrorOverlay: document.querySelector("vite-error-overlay") !== null,
		messages: document.querySelectorAll(".AiChatMessage").length,
	};
});
console.log(JSON.stringify(info, null, 2));
