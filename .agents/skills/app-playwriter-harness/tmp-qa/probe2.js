// Inspect the README node view for pending/diff UI affordances.
const out = await state.page.evaluate(() => {
	const labels = Array.from(document.querySelectorAll("[aria-label]"))
		.map((el) => el.getAttribute("aria-label"))
		.filter((l) => /pending|accept|discard|diff|review|change/i.test(l || ""));
	const buttons = Array.from(document.querySelectorAll("button"))
		.map((b) => (b.textContent || "").trim())
		.filter((t) => t && /pending|accept|discard|diff|review|change/i.test(t));
	const bodyText = (document.body.textContent || "").slice(0, 300);
	return { url: location.href, labels, buttons, bodyText };
});
console.log(JSON.stringify(out, null, 1));
