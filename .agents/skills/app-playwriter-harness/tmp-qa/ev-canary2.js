// Attempt 27 canary 2: search --limit 1 must follow exactly one printed continuation.
const PROMPT =
	"Use Bash to search for basheval-common-2026-06-12-a with limit 1. If Bash prints a Next page command, run exactly one continuation.";
await state.qa.newChat();
await state.qa.send(PROMPT);
await state.qa.waitDone(280000);
const out = await state.page.evaluate(() => {
	const terminals = Array.from(document.querySelectorAll('[aria-label="Bash terminal output"]')).map((el) =>
		(el.textContent || "").slice(0, 3000),
	);
	const messages = Array.from(document.querySelectorAll(".AiChatMessage"));
	const last = messages[messages.length - 1];
	return {
		messageCount: messages.length,
		terminalCount: terminals.length,
		terminals,
		finalAnswer: last ? (last.textContent || "").slice(-2500) : null,
	};
});
console.log(JSON.stringify(out, null, 1));
