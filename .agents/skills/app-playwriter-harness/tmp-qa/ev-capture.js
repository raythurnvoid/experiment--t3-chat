// Generic capture: wait for the agent to finish, then dump the latest exchange.
const done = await state.qa.waitDone(90000);
const dump = await state.qa.dump();
const terminals = await state.qa.readTerminal();
console.log("DONE:", JSON.stringify(done));
console.log("DUMP:", JSON.stringify(dump, null, 1));
console.log("TERMINALS:", JSON.stringify(terminals, null, 1));
