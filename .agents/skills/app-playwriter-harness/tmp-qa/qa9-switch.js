// QA-9 part 2: switching threads updates the URL ?threadId.
await state.page.evaluate(() => {
	const items = Array.from(document.querySelectorAll(".AiChatThreadsListItem-trigger"));
	const target = items.find((el) => (el.textContent || "").trim() === "The output is: /tmp");
	if (!target) throw new Error("thread item not found");
	target.click();
});
await state.page.waitForTimeout(4000);
const info = await state.page.evaluate(() => ({
	url: location.href,
	messages: document.querySelectorAll(".AiChatMessage").length,
}));
console.log(JSON.stringify(info, null, 2));
console.log("URL HAS ORIGINAL THREAD:", info.url.includes("n17evb9a1nxbpxtavm5k5z6r7h88hfvg") ? "PASS" : "FAIL");
