// QA-10: agent panel UI — close tab, thread picker, new chat.
await state.page.goto("http://localhost:5173/w/personal/home/files?nodeId=v97b3hqgj46x9fggj6nyex3q45887md2", {
	waitUntil: "domcontentloaded",
});
await state.page.waitForTimeout(8000);

const readTabs = () =>
	state.page.evaluate(() => {
		const tabs = Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
			id: el.getAttribute("data-ai-chat-thread-id"),
			selected: el.querySelector('[aria-selected="true"]') !== null,
		}));
		const buttons = Array.from(document.querySelectorAll('[aria-label="Open chats"] button')).map((el) =>
			el.getAttribute("aria-label"),
		);
		return { tabs, buttonLabels: buttons.filter(Boolean).slice(0, 30) };
	});

const t0 = await readTabs();
console.log("TABS BEFORE:", JSON.stringify(t0, null, 2));
