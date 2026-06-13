// QA-8: branch the current chat (which has /tmp/qa.txt) and read the file in the branch.
const before = await state.page.evaluate(() => {
	const tabsEl = document.querySelector('[aria-label="Open chats"]');
	return { tabs: tabsEl ? (tabsEl.textContent || "").slice(0, 300) : null, messages: document.querySelectorAll(".AiChatMessage").length };
});
console.log("BEFORE:", JSON.stringify(before));

await state.page.getByRole("button", { name: "Branch chat here" }).last().click();
await state.page.waitForTimeout(3000);

const after = await state.page.evaluate(() => {
	const tabsEl = document.querySelector('[aria-label="Open chats"]');
	return { tabs: tabsEl ? (tabsEl.textContent || "").slice(0, 300) : null, messages: document.querySelectorAll(".AiChatMessage").length, url: location.href };
});
console.log("AFTER:", JSON.stringify(after));

// Respect ai_chat_http rate limit before sending in the branched chat.
await state.page.waitForTimeout(16000);
await state.qa.send("Use the bash tool to run exactly: `cat /tmp/qa.txt` and tell me the output verbatim.");
await state.qa.waitDone(120000);
const d = await state.qa.dump();
console.log("BRANCH MSG:", JSON.stringify(d, null, 2));
const term = await state.qa.readTerminal();
console.log("TERM:", JSON.stringify(term, null, 2));
