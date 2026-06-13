const errors = [];
const onConsole = (msg) => {
	if (msg.type() === "error" || msg.type() === "warning") {
		errors.push(`[${msg.type()}] ${msg.text().slice(0, 800)}`);
	}
};
state.page.on("console", onConsole);
state.page.on("pageerror", (err) => errors.push(`[pageerror] ${String(err).slice(0, 1200)}`));
await state.page.reload({ waitUntil: "domcontentloaded" });
await state.page.waitForTimeout(8000);
state.page.off("console", onConsole);
const info = await state.page.evaluate(() => ({
	url: location.href,
	hasOpenChats: document.querySelector('[aria-label="Open chats"]') !== null,
	composer: document.querySelector(".AiChatComposer-editor-content") !== null,
	messages: document.querySelectorAll(".AiChatMessage").length,
}));
console.log(JSON.stringify({ info, errors: errors.slice(0, 15) }, null, 2));
