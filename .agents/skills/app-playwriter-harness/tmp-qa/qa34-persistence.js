await state.qa.newChat();
await state.qa.send(
	"Use the bash tool to run exactly this command: `printf hello-qa3 > /tmp/qa.txt; cd /tmp; pwd` and tell me the output.",
);
await state.qa.waitDone(120000);
const d1 = await state.qa.dump();
console.log("MSG1:", JSON.stringify(d1, null, 2));

await state.qa.send(
	"Now use the bash tool to run exactly: `pwd; cat qa.txt` (no cd first) and tell me both outputs verbatim.",
);
await state.qa.waitDone(120000);
const d2 = await state.qa.dump();
console.log("MSG2:", JSON.stringify(d2, null, 2));
const term = await state.qa.readTerminal();
console.log("TERM:", JSON.stringify(term, null, 2));
