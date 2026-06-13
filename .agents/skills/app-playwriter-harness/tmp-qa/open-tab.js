const targetUrl = "http://localhost:5173/w/personal/home/files?nodeId=v97b3hqgj46x9fggj6nyex3q45887md2";
const tabs = context.pages();
let appTab = tabs.find((p) => p.url().includes("localhost:5173"));
if (!appTab) {
	appTab = await context.newPage();
}
await appTab.goto(targetUrl, { waitUntil: "domcontentloaded" });
state.page = appTab;
state.appPlaywriterHarness.page = appTab;
state.appPlaywriterHarness.boundUrl = appTab.url();
await appTab.waitForLoadState("load", { timeout: 15000 }).catch(() => undefined);
console.log(JSON.stringify({ url: appTab.url(), title: await appTab.title().catch(() => "") }));
