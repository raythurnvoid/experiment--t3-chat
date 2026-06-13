// Read every bash terminal in the current chat + final answer text.
const out = await state.page.evaluate(() => {
	const terminals = Array.from(document.querySelectorAll('[aria-label="Bash terminal output"]')).map((el) =>
		(el.textContent || "").slice(0, 900),
	);
	const messages = Array.from(document.querySelectorAll(".AiChatMessage"));
	const last = messages[messages.length - 1];
	const finalAnswer = last ? (last.textContent || "").slice(-1200) : null;
	return { terminals, finalAnswer };
});
console.log(JSON.stringify(out, null, 1));
