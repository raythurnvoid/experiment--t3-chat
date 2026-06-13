// QA-11: message render smoke — markdown, tool expand/collapse, layout sanity.
// Select the QA-7 thread tab (3 bash blocks + markdown code blocks).
await state.page.evaluate(() => {
	const tab = document.querySelector('[data-ai-chat-thread-id="n1754871y7dwz0jbee3vy8n0nx88hcwb"]');
	const trigger = tab?.querySelector('[role="tab"], button:not([aria-label])') || tab;
	trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
});
await state.page.waitForTimeout(2500);

const info = await state.page.evaluate(() => {
	const chat = document.querySelector(".AiChat") || document.body;
	const messages = Array.from(document.querySelectorAll(".AiChatMessage"));
	const markdown = {
		strong: document.querySelectorAll(".AiChatMessage strong").length,
		codeInline: document.querySelectorAll(".AiChatMessage code").length,
		pre: document.querySelectorAll(".AiChatMessage pre").length,
	};

	// Expand/collapse the first bash disclosure.
	const summary = document.querySelector('summary[aria-label^="Bash"]');
	const details = summary?.closest("details");
	const wasOpen = details?.open ?? null;
	let toggled = null;
	if (summary && details) {
		summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
		toggled = details.open !== wasOpen;
	}

	// Layout sanity: no horizontal page overflow; messages fit their container.
	const doc = document.scrollingElement;
	const pageOverflow = doc.scrollWidth - doc.clientWidth;
	const container = messages[0]?.parentElement;
	const containerWidth = container ? container.getBoundingClientRect().width : null;
	const offenders = messages
		.map((m, i) => ({ i, w: m.getBoundingClientRect().width }))
		.filter((m) => containerWidth !== null && m.w > containerWidth + 2);
	const zeroHeight = messages.filter((m) => m.getBoundingClientRect().height === 0).length;

	return { messageCount: messages.length, markdown, wasOpen, toggled, pageOverflow, containerWidth, offenders, zeroHeight };
});
console.log(JSON.stringify(info, null, 2));
const pass =
	info.messageCount === 6 &&
	info.markdown.codeInline > 0 &&
	info.toggled === true &&
	info.pageOverflow <= 1 &&
	info.offenders.length === 0 &&
	info.zeroHeight === 0;
console.log("QA-11:", pass ? "PASS" : "CHECK");
