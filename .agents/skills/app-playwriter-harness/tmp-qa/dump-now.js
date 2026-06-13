const info = await state.qa.dump();
console.log("INFO:", JSON.stringify(info, null, 2));
const term = await state.qa.readTerminal();
console.log("TERM:", JSON.stringify(term, null, 2));
