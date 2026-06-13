// Eval capture: wait for the agent, then dump every bash terminal + the final answer.
await state.qa.waitDone(120000);
const out = await state.page.evaluate(() => {
	const terminals = Array.from(document.querySelectorAll('[aria-label="Bash terminal output"]')).map((el) =>
		(el.textContent || "").slice(0, 1200),
	);
	const messages = Array.from(document.querySelectorAll(".AiChatMessage"));
	const last = messages[messages.length - 1];
	return {
		messageCount: messages.length,
		terminals,
		finalAnswer: last ? (last.textContent || "").slice(-1500) : null,
		threadId: new URLSearchParams(location.search).get("threadId"),
	};
});
console.log(JSON.stringify(out, null, 1));
