// QA-9: chat page loads ?threadId thread; switching threads updates the URL.
await state.page.goto("http://localhost:5173/w/personal/home/chat?threadId=n178s145sjh5b5pe43p9gjb3yh88hkkp", {
	waitUntil: "domcontentloaded",
});
await state.page.waitForTimeout(6000);

const loaded = await state.page.evaluate(() => {
	const messages = document.querySelectorAll(".AiChatMessage").length;
	const threadItems = Array.from(document.querySelectorAll("a, button"))
		.filter((el) => (el.textContent || "").includes("The output is: /tmp"))
		.map((el) => ({
			tag: el.tagName,
			text: (el.textContent || "").slice(0, 60),
			href: el.getAttribute("href"),
			classes: (el.className || "").toString().slice(0, 80),
		}));
	return { url: location.href, messages, composer: document.querySelector(".AiChatComposer-editor-content") !== null, threadItems };
});
console.log("LOADED:", JSON.stringify(loaded, null, 2));
