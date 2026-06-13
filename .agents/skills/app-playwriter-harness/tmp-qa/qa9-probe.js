await state.page.waitForTimeout(4000);
const info = await state.page.evaluate(() => {
	const items = Array.from(document.querySelectorAll(".AiChatThreadsListItem-trigger")).slice(0, 12).map((el) => ({
		text: (el.textContent || "").slice(0, 50),
		ariaCurrent: el.getAttribute("aria-current"),
		ariaSelected: el.getAttribute("aria-selected"),
		dataState: el.getAttribute("data-state"),
		parentSelected: el.closest('[aria-selected="true"], [data-selected="true"], [aria-current]') !== null,
	}));
	return {
		url: location.href,
		messages: document.querySelectorAll(".AiChatMessage").length,
		bashSummaries: document.querySelectorAll('summary[aria-label^="Bash"]').length,
		items,
	};
});
console.log(JSON.stringify(info, null, 2));
