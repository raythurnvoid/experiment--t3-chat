// QA-7: byte-cap eviction (4000 b total). Three ~1.5 KB files across two calls → oldest evicted.
await state.qa.newChat();
await state.page.waitForTimeout(1500);

await state.qa.send(
	"Use the bash tool to run exactly: `seq 1 400 > /tmp/a.txt && seq 1 400 > /tmp/b.txt && wc -c /tmp/a.txt /tmp/b.txt` then report the output and any warnings verbatim.",
);
await state.qa.waitDone(180000);
const t1 = await state.qa.readTerminal();
console.log("TERM1:", JSON.stringify(t1, null, 2));

await state.page.waitForTimeout(16000);
await state.qa.send(
	"Use the bash tool to run exactly: `seq 1 400 > /tmp/c.txt && ls /tmp` then report the output and any warnings verbatim.",
);
await state.qa.waitDone(180000);
const d2 = await state.qa.dump();
console.log("MSG2:", JSON.stringify({ last: d2.lastMessageText }, null, 2));
const t2 = await state.qa.readTerminal();
console.log("TERM2:", JSON.stringify(t2, null, 2));

await state.page.waitForTimeout(16000);
await state.qa.send("Use the bash tool to run exactly: `ls /tmp` and tell me exactly which files exist now.");
await state.qa.waitDone(180000);
const d3 = await state.qa.dump();
console.log("MSG3:", JSON.stringify({ last: d3.lastMessageText }, null, 2));
const t3 = await state.qa.readTerminal();
console.log("TERM3:", JSON.stringify(t3, null, 2));
