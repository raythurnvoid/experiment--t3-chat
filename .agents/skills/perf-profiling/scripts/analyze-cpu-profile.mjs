// Usage: node analyze-cpu-profile.mjs path/to/file.cpuprofile
// Prints self-time per function and per file from a CDP Profiler.stop profile.
// Generic. To attribute a native getter (e.g. `get scrollX`) to its callers,
// walk `children` links in `nodes` from the hot node back to calling frames.
import fs from "node:fs";

const profile = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { nodes, samples, timeDeltas, startTime, endTime } = profile;

const nodeById = new Map(nodes.map((n) => [n.id, n]));

// Self time per node from samples + timeDeltas (microseconds)
const selfById = new Map();
for (let i = 0; i < samples.length; i++) {
	const delta = timeDeltas[i] ?? 0;
	selfById.set(samples[i], (selfById.get(samples[i]) ?? 0) + delta);
}

function label(node) {
	const cf = node.callFrame;
	const name = cf.functionName || "(anonymous)";
	let url = cf.url || "";
	url = url.replace(/https?:\/\/localhost:\d+\//, "").split("?")[0];
	return url ? `${name} @ ${url}:${cf.lineNumber + 1}` : name;
}

// Aggregate self time by label
const agg = new Map();
for (const [id, self] of selfById) {
	const node = nodeById.get(id);
	if (!node) continue;
	const key = label(node);
	agg.set(key, (agg.get(key) ?? 0) + self);
}

const totalUs = timeDeltas.reduce((a, b) => a + b, 0);
console.log(`profile span: ${((endTime - startTime) / 1000).toFixed(0)} ms, sampled: ${(totalUs / 1000).toFixed(0)} ms`);

const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 35);
for (const [key, us] of sorted) {
	console.log(`${(us / 1000).toFixed(1).padStart(8)} ms  ${key}`);
}

// Also aggregate by file
const byFile = new Map();
for (const [id, self] of selfById) {
	const node = nodeById.get(id);
	if (!node) continue;
	const url = (node.callFrame.url || "(native/idle)").replace(/https?:\/\/localhost:\d+\//, "").split("?")[0] || "(inline)";
	byFile.set(url, (byFile.get(url) ?? 0) + self);
}
console.log("\n--- by file ---");
for (const [file, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
	console.log(`${(us / 1000).toFixed(1).padStart(8)} ms  ${file}`);
}
