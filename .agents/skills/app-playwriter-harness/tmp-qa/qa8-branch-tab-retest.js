// Retest branch-tab fix: branching must add a tab for the new thread and select it.
const readTabs = () =>
	state.page.evaluate(() => {
		const tabs = Array.from(document.querySelectorAll("[data-ai-chat-thread-id]")).map((el) => ({
			id: el.getAttribute("data-ai-chat-thread-id"),
			selected: el.querySelector('[aria-selected="true"]') !== null,
		}));
		return { tabs, messages: document.querySelectorAll(".AiChatMessage").length };
	});

const before = await readTabs();
console.log("BEFORE:", JSON.stringify(before));

await state.page.getByRole("button", { name: "Branch chat here" }).last().click();
await state.page.waitForTimeout(4000);

const after = await readTabs();
console.log("AFTER:", JSON.stringify(after, null, 2));

const beforeIds = new Set(before.tabs.map((t) => t.id));
const added = after.tabs.filter((t) => !beforeIds.has(t.id));
console.log("ADDED:", JSON.stringify(added));
console.log("VERDICT:", added.length === 1 && added[0].selected ? "PASS" : "FAIL");
