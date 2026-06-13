await state.qa.newChat();
await state.qa.send("Use the bash tool to run exactly `pwd` and tell me the output.");
await state.qa.waitDone(120000);
await state.qa.dump();
await state.qa.readTerminal();
