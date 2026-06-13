// Generation status probe: send button state, busy tool blocks, message count.
const out = await state.page.evaluate(() => {
	const sendBtn = document.querySelector('[data-testid="ai-chat-send-button"]');
	const busy = Array.from(document.querySelectorAll("[aria-busy]")).map((el) => ({
		label: el.getAttribute("aria-label"),
		busy: el.getAttribute("aria-busy"),
	}));
	return {
		sendBtnLabel: sendBtn ? sendBtn.getAttribute("aria-label") : null,
		sendBtnDisabled: sendBtn ? sendBtn.disabled : null,
		busyEls: busy.filter((b) => b.busy === "true"),
		messages: document.querySelectorAll(".AiChatMessage").length,
		failedSend: !!Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("Retry")),
	};
});
console.log(JSON.stringify(out, null, 1));
