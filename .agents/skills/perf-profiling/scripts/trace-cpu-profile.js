// CPU profile through CDP Tracing, for connections that reject `Profiler.enable`.
// Run this file once to start, do the interaction, then run it again to stop. The second run keeps
// the rebuilt profile in `state.traceCpuProfile` and returns where the busy time went.
// ADAPT: `state.tracePage` (defaults to `state.page`).
const page = state.tracePage ?? state.page;

if (!state.traceCpu) {
	const cdp = await getCDPSession({ page });
	const events = [];
	const onData = (event) => {
		for (const e of event.value) if (e.name === "Profile" || e.name === "ProfileChunk") events.push(e);
	};
	let done;
	const finished = new Promise((resolve) => (done = resolve));
	const onComplete = () => done();
	cdp.on("Tracing.dataCollected", onData);
	cdp.on("Tracing.tracingComplete", onComplete);
	await cdp.send("Tracing.start", {
		transferMode: "ReportEvents",
		traceConfig: { includedCategories: ["disabled-by-default-v8.cpu_profiler"], excludedCategories: ["*"] },
	});
	state.traceCpu = { cdp, events, onData, onComplete, finished };
	return "tracing; run this file again to stop";
}

const { cdp, events, onData, onComplete, finished } = state.traceCpu;
delete state.traceCpu;
await cdp.send("Tracing.end");
await finished;
cdp.off("Tracing.dataCollected", onData);
cdp.off("Tracing.tracingComplete", onComplete);
await cdp.detach().catch(() => {});

// Each profiled thread has its own id. Keep the one with the most busy samples, which is the page's
// main thread. An idle thread can have more samples in total.
const threads = new Map();
for (const e of events) {
	const key = `${e.pid}:${e.id}`;
	const thread = threads.get(key) ?? { nodes: new Map(), samples: [], timeDeltas: [], startTime: 0 };
	threads.set(key, thread);
	if (e.name === "Profile") thread.startTime = e.args.data.startTime;
	const cpu = e.args.data.cpuProfile;
	if (e.name !== "ProfileChunk" || !cpu) continue;
	for (const n of cpu.nodes ?? []) thread.nodes.set(n.id, { id: n.id, callFrame: n.callFrame, parent: n.parent, children: [] });
	thread.samples.push(...(cpu.samples ?? []));
	thread.timeDeltas.push(...(e.args.data.timeDeltas ?? []));
}
const busySamples = (thread) =>
	thread.samples.filter((id) => !["(idle)", "(program)", "(root)"].includes(thread.nodes.get(id)?.callFrame.functionName)).length;
const main = [...threads.values()].sort((a, b) => busySamples(b) - busySamples(a))[0];
for (const n of main.nodes.values()) if (n.parent) main.nodes.get(n.parent)?.children.push(n.id);
const nodes = [...main.nodes.values()].map(({ parent, ...n }) => n);
const total = main.timeDeltas.reduce((a, b) => a + b, 0);
state.traceCpuProfile = { nodes, samples: main.samples, timeDeltas: main.timeDeltas, startTime: main.startTime, endTime: main.startTime + total };

// Charge each busy sample to its innermost app frame (src/ or vendor/), so React and library work
// shows under the app code that called it. Samples with no app frame are grouped by library file.
const byId = main.nodes;
const url = (n) => (n.callFrame.url || "").replace(/^https?:\/\/localhost:\d+\//, "").split("?")[0];
const label = (n) => `${n.callFrame.functionName || "(anon)"} @ ${url(n) ? `${url(n)}:${n.callFrame.lineNumber + 1}` : "(native)"}`;
const charged = new Map();
let busy = 0;
for (let i = 0; i < main.samples.length; i++) {
	const leaf = byId.get(main.samples[i]);
	const name = leaf.callFrame.functionName;
	const us = main.timeDeltas[i + 1] ?? 0;
	if (name === "(idle)" || name === "(root)") continue;
	busy += us;
	let app = null;
	for (let n = leaf; n && !app; n = n.parent ? byId.get(n.parent) : null) if (/^(src|vendor)\//.test(url(n))) app = n;
	const key = app ? label(app) : `(lib) ${url(leaf).split("/").pop() || name}`;
	charged.set(key, (charged.get(key) ?? 0) + us);
}
return {
	busyMs: Math.round(busy / 1000),
	top: [...charged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, us]) => `${(us / 1000).toFixed(1)} ${k}`),
};
