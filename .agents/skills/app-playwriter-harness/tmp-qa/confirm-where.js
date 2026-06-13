// Locate the stuck aria-busy Confirm button: ancestry + visibility.
const out = await state.page.evaluate(() => {
	const btn = Array.from(document.querySelectorAll('button[aria-busy="true"]')).find((b) =>
		(b.textContent || "").includes("Confirm"),
	);
	if (!btn) return { found: false };
	const r = btn.getBoundingClientRect();
	const chain = [];
	let el = btn;
	while (el && chain.length < 8) {
		chain.push(`${el.tagName}${el.id ? "#" + el.id : ""}.${(el.className || "").toString().slice(0, 60)}`);
		el = el.parentElement;
	}
	const dialog = btn.closest('[role="dialog"], dialog');
	return {
		found: true,
		rect: { x: r.x, y: r.y, w: r.width, h: r.height },
		visible: r.width > 0 && r.height > 0,
		inDialog: !!dialog,
		dialogLabel: dialog ? dialog.getAttribute("aria-label") : null,
		dialogText: dialog ? (dialog.textContent || "").slice(0, 200) : null,
		chain,
	};
});
console.log(JSON.stringify(out, null, 1));
