const h = state.appPlaywriterHarness;
const auth = await h.authSummary();
const dom = await state.page.evaluate(() => {
	const agentTab = document.querySelector("#app_file_editor_sidebar_tabs_agent");
	const sidebar = document.querySelector(".FileEditorSidebarAgent");
	const composer = document.querySelector(".AiChatComposer-editor-content");
	const send = document.querySelector('[data-testid="ai-chat-send-button"]');
	const body = document.body.textContent || "";
	return {
		hasAgentTab: Boolean(agentTab),
		agentTabSelected: agentTab?.getAttribute("aria-selected"),
		hasAgentSidebar: Boolean(sidebar),
		hasComposer: Boolean(composer),
		hasSendButton: Boolean(send),
		bodyLength: body.length,
		bodySample: body.slice(0, 200),
	};
});
console.log("DOM:", JSON.stringify(dom, null, 2));
await h.latestLogs({ count: 20 });
