// Recover QA-3/4 message 2: wait out the rate limit, click Retry, wait for completion.
await state.page.waitForTimeout(16000);
await state.page.getByRole("button", { name: "Retry" }).last().click();
await state.page.waitForSelector('[aria-label="Stop generating"]', { timeout: 15000 }).catch(() => undefined);
await state.page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, {
	timeout: 120000,
	polling: 1000,
});
await state.page.waitForTimeout(1000);
const d2 = await state.qa.dump();
console.log("MSG2:", JSON.stringify(d2, null, 2));
const term = await state.qa.readTerminal();
console.log("TERM:", JSON.stringify(term, null, 2));
