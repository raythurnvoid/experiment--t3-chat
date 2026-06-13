// EV-0: fixture verification through the in-app agent (fresh chat).
if (!state.qa) throw new Error("state.qa helpers missing — reinstall qa-helpers.js");
await state.qa.newChat();
await state.qa.send(
	[
		"Use Bash to run exactly these four commands one at a time and report each output:",
		"find /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-2026-06-12-a -maxdepth 3 --limit 20",
		"search --path /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-2026-06-12-a --limit 1 basheval-distinctive-2026-06-12-a",
		"head -n 3 /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-2026-06-12-a/large/large-paged.md",
		"find /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-2026-06-12-a --extension pdf -type f --limit 5",
	].join("\n"),
);
console.log("sent");
