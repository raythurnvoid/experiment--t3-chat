// What exactly is aria-busy right now?
const out = await state.page.evaluate(() => {
	const busy = Array.from(document.querySelectorAll('[aria-busy="true"]')).map((el) => ({
		tag: el.tagName,
		cls: (el.className || "").toString().slice(0, 80),
		label: el.getAttribute("aria-label"),
		text: (el.textContent || "").slice(0, 80),
	}));
	const stop = !!document.querySelector('[aria-label="Stop generating"]');
	const messages = Array.from(document.querySelectorAll(".AiChatMessage"));
	const last = messages[messages.length - 1];
	return { stop, busy, messages: messages.length, lastTail: last ? (last.textContent || "").slice(-200) : null };
});
console.log(JSON.stringify(out, null, 1));
