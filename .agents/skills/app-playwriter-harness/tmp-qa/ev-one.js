// One full scored eval run: fresh chat → send PROMPT → wait → dump terminals + final answer.
const PROMPT =
	"Use Bash to write about 1700 bytes into each of /tmp/cap-c-1.txt and /tmp/cap-c-2.txt in one call, then about 1700 bytes into /tmp/cap-c-3.txt in a second call. Then list /tmp in a third call and report which files were kept and what limit caused any eviction.";
await state.qa.newChat();
await state.qa.send(PROMPT);
await state.qa.waitDone(280000);
const out = await state.page.evaluate(() => {
	const terminals = Array.from(document.querySelectorAll('[aria-label="Bash terminal output"]')).map((el) =>
		(el.textContent || "").slice(0, 1500),
	);
	const messages = Array.from(document.querySelectorAll(".AiChatMessage"));
	const last = messages[messages.length - 1];
	return {
		messageCount: messages.length,
		terminalCount: terminals.length,
		terminals,
		finalAnswer: last ? (last.textContent || "").slice(-2000) : null,
	};
});
console.log(JSON.stringify(out, null, 1));
