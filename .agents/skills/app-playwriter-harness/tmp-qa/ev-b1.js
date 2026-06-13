// Attempt 27 re-run: B1 recursive grep (bad-habit) → dump terminals + final answer.
const PROMPT =
	"Use Bash to grep recursively under /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-2026-06-12-a for basheval-common-2026-06-12-a.";
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
