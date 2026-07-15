// Playwriter script — TEMPLATE. Records a CDP CPU profile around one interaction.
// Requires state.cdp from a prior getCDPSession (the ui-latency rig sets it up).
// Analyze the saved .cpuprofile with analyze-cpu-profile.mjs (same folder).
const cdp = state.cdp;
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
await state.page.evaluate(() => {
	window.__t = {};
});
await cdp.send("Profiler.start");

// ADAPT: the interaction + the in-page signal that it finished
// (waitForFunction on a window.__t field set by the MutationObserver rig,
//  NOT a Playwright DOM wait — those are rAF-throttled on backgrounded tabs).
const btn = state.page.locator('button[aria-label="New folder"]');
await btn.click();
await state.page.waitForFunction(() => window.__t && window.__t.rowAt, null, { timeout: 30000, polling: 100 });

const { profile } = await cdp.send("Profiler.stop");
await cdp.send("Profiler.disable");

const t = await state.page.evaluate(() => window.__t);
console.log("t:", JSON.stringify(t));

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const p = path.join(os.tmpdir(), "interaction.cpuprofile");
fs.writeFileSync(p, JSON.stringify(profile));
console.log("profile saved:", p, "nodes:", profile.nodes.length, "samples:", profile.samples.length);
