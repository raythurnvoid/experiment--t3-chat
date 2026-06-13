// QA-5: path-cap eviction (10 paths). 1 old file + 10 new → oldest evicted with stderr note.
await state.qa.newChat();
await state.page.waitForTimeout(1000);

await state.qa.send("Use the bash tool to run exactly: `printf old > /tmp/old.txt && ls /tmp` then just tell me which files exist.");
await state.qa.waitDone(180000);
const d1 = await state.qa.dump();
console.log("MSG1:", JSON.stringify({ last: d1.lastMessageText, bash: d1.bashButtons }, null, 2));

await state.page.waitForTimeout(16000);
await state.qa.send(
	'Use the bash tool to run exactly: `cd /tmp && for i in 1 2 3 4 5 6 7 8 9 10; do printf "file-$i" > f$i.txt; done && ls` then report the output and any warnings or errors verbatim.',
);
await state.qa.waitDone(180000);
const d2 = await state.qa.dump();
console.log("MSG2:", JSON.stringify({ last: d2.lastMessageText, bash: d2.bashButtons }, null, 2));
const t2 = await state.qa.readTerminal();
console.log("TERM2:", JSON.stringify(t2, null, 2));

await state.page.waitForTimeout(16000);
await state.qa.send("Use the bash tool to run exactly: `ls /tmp` and tell me exactly which files exist now.");
await state.qa.waitDone(180000);
const d3 = await state.qa.dump();
console.log("MSG3:", JSON.stringify({ last: d3.lastMessageText, bash: d3.bashButtons }, null, 2));
const t3 = await state.qa.readTerminal();
console.log("TERM3:", JSON.stringify(t3, null, 2));
