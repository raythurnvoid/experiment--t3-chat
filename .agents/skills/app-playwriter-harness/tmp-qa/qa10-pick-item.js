// Click the QA-7 thread option in the open picker, then verify tab re-added + selected.
await state.page.evaluate(() => {
	const options = Array.from(document.querySelectorAll('[role="option"]'));
	const target = options.find((el) => (el.textContent || "").includes("Sequence files created"));
	if (!target) throw new Error("option not found");
	for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
		target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
	}
});
await state.page.waitForTimeout(2000);
const after = await state.page.evaluate(() => ({
	tabs: Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
		id: el.getAttribute("data-ai-chat-thread-id"),
		selected: el.querySelector('[aria-selected="true"]') !== null,
	})),
	pickerExpanded: document.querySelector('button[aria-label="Past chats"]')?.getAttribute("aria-expanded"),
	messages: document.querySelectorAll(".AiChatMessage").length,
}));
const picked = after.tabs.find((t) => t.id === "n1754871y7dwz0jbee3vy8n0nx88hcwb");
console.log("AFTER PICK:", JSON.stringify(after, null, 2));
console.log("PICKER RE-OPEN:", picked && picked.selected ? "PASS" : "FAIL");
