const info = await state.page.evaluate(() => {
	const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-floating-ui-portal], .MyPopover')).map(
		(el) => ({ role: el.getAttribute("role"), cls: (el.className || "").toString().slice(0, 60), text: (el.textContent || "").slice(0, 120) }),
	);
	const pastChatsBtns = Array.from(document.querySelectorAll('button[aria-label="Past chats"]')).map((el) => ({
		expanded: el.getAttribute("aria-expanded"),
		visible: el.getBoundingClientRect().width > 0,
	}));
	return { dialogs: dialogs.slice(0, 8), pastChatsBtns, tabs: document.querySelectorAll("[data-ai-chat-thread-id]").length };
});
console.log(JSON.stringify(info, null, 2));
