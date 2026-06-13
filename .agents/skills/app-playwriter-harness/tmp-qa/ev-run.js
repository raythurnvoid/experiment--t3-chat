// Eval runner: fresh chat + send the scenario prompt (edited per scenario).
const PROMPT =
	"Use Bash to show a tree for /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-2026-06-12-a with limit 3. If Bash prints a Next page command, run one continuation.";
await state.qa.newChat();
await state.qa.send(PROMPT);
console.log("sent:", PROMPT.slice(0, 80));
