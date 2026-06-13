const logs = await getLatestLogs({ page: state.page, search: /error|warn|fail|reject/i, count: 40 });
console.log("BROWSER LOGS:\n", logs || "(none)");
