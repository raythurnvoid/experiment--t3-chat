// QA-10 continued: pick the just-closed QA-7 thread from "Past chats", then "New chat".
const readTabs = () =>
	state.page.evaluate(() => ({
		tabs: Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
			id: el.getAttribute("data-ai-chat-thread-id"),
			selected: el.querySelector('[aria-selected="true"]') !== null,
		})),
	}));

await state.page.getByRole("button", { name: "Past chats", exact: true }).click();
await state.page.waitForTimeout(1500);

const picker = await state.page.evaluate(() => {
	const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], .AiChatThreadsListItem-trigger'));
	return items.slice(0, 15).map((el) => ({ role: el.getAttribute("role"), text: (el.textContent || "").slice(0, 50) }));
});
console.log("PICKER ITEMS:", JSON.stringify(picker, null, 2));

await state.page.evaluate(() => {
	const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], .AiChatThreadsListItem-trigger'));
	const target = items.find((el) => (el.textContent || "").includes("Sequence files created"));
	if (!target) throw new Error("picker item for QA-7 thread not found");
	target.click();
});
await state.page.waitForTimeout(2000);
const afterPick = await readTabs();
const picked = afterPick.tabs.find((t) => t.id === "n1754871y7dwz0jbee3vy8n0nx88hcwb");
console.log("PICKER RE-OPEN:", picked && picked.selected ? "PASS" : "FAIL", JSON.stringify(afterPick.tabs.at(-1)));

await state.page.getByRole("button", { name: "New chat", exact: true }).click();
await state.page.waitForTimeout(1500);
const afterNew = await readTabs();
const last = afterNew.tabs.at(-1);
console.log("NEW CHAT:", last && last.id.startsWith("ai_thread-") && last.selected ? "PASS" : "FAIL", JSON.stringify(last));
