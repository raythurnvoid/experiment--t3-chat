// QA-6: per-file cap (2000 b) discards only the oversized file; small file persists.
await state.qa.newChat();
await state.page.waitForTimeout(1500);

await state.qa.send(
	"Use the bash tool to run exactly: `seq 1 1000 > /tmp/big.txt && printf keep > /tmp/keep.txt && ls /tmp` then report the output and any warnings or errors verbatim.",
);
await state.qa.waitDone(180000);
const d1 = await state.qa.dump();
console.log("MSG1:", JSON.stringify({ last: d1.lastMessageText, bash: d1.bashButtons }, null, 2));
const t1 = await state.qa.readTerminal();
console.log("TERM1:", JSON.stringify(t1, null, 2));

await state.page.waitForTimeout(16000);
await state.qa.send("Use the bash tool to run exactly: `ls /tmp && cat /tmp/keep.txt` and tell me exactly what you see.");
await state.qa.waitDone(180000);
const d2 = await state.qa.dump();
console.log("MSG2:", JSON.stringify({ last: d2.lastMessageText, bash: d2.bashButtons }, null, 2));
const t2 = await state.qa.readTerminal();
console.log("TERM2:", JSON.stringify(t2, null, 2));
