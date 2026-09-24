// Usage: vp env exec node summarize-dev-data.mjs <export folder>
// Prints what test data exists on the dev deployment and where, from the JSON exports described in
// qa-data/SKILL.md. Use the output to refresh qa-data/references/inventory.md.
// `files_nodes` and `files_r2_assets` are larger than one export, so the folder holds the newest
// rows (<table>.json) and the oldest rows (<table>.asc.json). Rows between the two are missing.
import fs from "node:fs";

const dir = process.argv[2];
const read = (table) => JSON.parse(fs.readFileSync(`${dir}/${table}.json`, "utf8"));
const readBoth = (table) => {
	const newest = read(table);
	const oldest = read(`${table}.asc`);
	const day = (ms) => new Date(ms).toISOString().slice(0, 16);
	console.log(
		`${table}: oldest rows ${day(oldest[0]._creationTime)} to ${day(oldest.at(-1)._creationTime)}, ` +
			`newest rows ${day(newest.at(-1)._creationTime)} to ${day(newest[0]._creationTime)}`,
	);

	const byId = new Map();
	for (const doc of [...newest, ...oldest]) byId.set(doc._id, doc);
	return [...byId.values()];
};

const users = read("users");
const orgs = read("organizations");
const workspaces = read("organizations_workspaces");
const members = read("organizations_workspaces_users").filter((m) => m.active);
const installs = read("plugins_workspace_installations");
const threads = read("ai_chat_threads");
const nodes = readBoth("files_nodes");
const assets = readBoth("files_r2_assets");

const userById = new Map(users.map((u) => [u._id, u]));
const orgById = new Map(orgs.map((o) => [o._id, o]));
const wsById = new Map(workspaces.map((w) => [w._id, w]));
const isAnon = (userId) => !userById.get(userId)?.clerkUserId;
const isAnonPersonalOrg = (org) => org.default && isAnon(org.ownerUserId);
const scopeLabel = (doc) => {
	const org = orgById.get(doc.organizationId);
	return `${org.name}[${org.ownerUserId.slice(0, 8)}]/${wsById.get(doc.workspaceId)?.name ?? doc.workspaceId}`;
};
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

// Accounts, orgs, workspaces
const anonUsers = users.filter((u) => !u.clerkUserId);
console.log(`\nusers: ${users.length} (clerk ${users.length - anonUsers.length}, anonymous ${anonUsers.length})`);
console.log(`organizations: ${orgs.length} (anonymous personal orgs: ${orgs.filter(isAnonPersonalOrg).length})`);
for (const org of orgs) {
	if (isAnonPersonalOrg(org)) continue;
	const orgMembers = [...new Set(members.filter((m) => m.organizationId === org._id).map((m) => m.userId))];
	console.log(`  ${org.name} ${org._id} owner=${org.ownerUserId}`);
	console.log(`    workspaces: ${workspaces.filter((w) => w.organizationId === org._id).map((w) => `${w.name} ${w._id}`).join(", ")}`);
	console.log(`    members: ${orgMembers.map((id) => (isAnon(id) ? `anon:${id}` : id)).join(", ")}`);
}

console.log("\nplugins that run on every matching upload:");
for (const i of installs) {
	if (!i.configurationYaml) continue;
	console.log(`  ${scopeLabel(i)} ${i.pluginName}: ${i.configurationYaml.replace(/\s+/g, " ").trim()}`);
}

// Keep live files in real tenants only. Anonymous personal orgs and GLOBAL (plugin sources,
// GitHub mounts) are not test data.
const liveNodes = nodes.filter((n) => {
	const org = orgById.get(n.organizationId);
	return org && !isAnonPersonalOrg(org) && !n.archiveOperationId;
});
const nodeLabel = (n) => `${scopeLabel(n)}:${n.path}${n.kind === "file" ? ` (${n.contentByteSize ?? "?"} B)` : ""}`;
console.log(`\nlive files and folders in real tenants: ${liveNodes.length}`);

console.log("\nfile types (extension | text kind or stored | collaboration):");
const byType = new Map();
for (const n of liveNodes) {
	if (n.kind !== "file") continue;
	const type = `${n.lowercaseExtension ?? "(none)"} | ${n.textKind ?? "stored"} | collab=${n.collaborationEnabled ?? "-"}`;
	if (!byType.has(type)) byType.set(type, []);
	byType.get(type).push(n);
}
for (const [type, list] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
	const perScope = new Map();
	for (const n of list) bump(perScope, scopeLabel(n));
	// Show examples outside the read-only demo import first.
	const examples = [...list.filter((n) => !scopeLabel(n).startsWith("sybill-demo")), ...list].slice(0, 3);
	console.log(`  ${list.length}  ${type}  in ${[...perScope].map(([s, c]) => `${s} ${c}`).join(", ")}`);
	for (const n of examples) console.log(`      ${nodeLabel(n)}`);
}

console.log("\nfiles and folders with a write rule:");
for (const n of liveNodes.filter((n) => n.writePolicy)) {
	const writer = n.writePolicy.mode === "writer" ? ` ${n.writePolicy.writer.kind}` : "";
	console.log(`  ${n.writePolicy.mode}${writer}  ${nodeLabel(n)}`);
}
console.log("\nrestricted scope roots:");
for (const n of liveNodes.filter((n) => n.isRestrictedScopeRoot)) console.log(`  ${nodeLabel(n)}`);

const childCount = new Map();
for (const n of liveNodes) if (n.parentId) bump(childCount, n.parentId);
const nodeById = new Map(liveNodes.map((n) => [n._id, n]));
console.log("\nbiggest folders (children in the sample):");
for (const [id, count] of [...childCount].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
	if (nodeById.has(id)) console.log(`  ${count}  ${nodeLabel(nodeById.get(id))}`);
}
console.log("\ndeepest paths:");
for (const n of [...liveNodes].sort((a, b) => (b.pathDepth ?? 0) - (a.pathDepth ?? 0)).slice(0, 3)) {
	console.log(`  depth ${n.pathDepth}  ${nodeLabel(n)}`);
}

console.log("\ntop folders by workspace:");
const topFolders = new Map();
for (const n of liveNodes) bump(topFolders, `${scopeLabel(n)} /${(n.path ?? "").split("/").filter(Boolean)[0] ?? ""}`);
for (const [key, count] of [...topFolders].sort()) console.log(`  ${count}  ${key}`);

// Stored bytes and chats
const bytesByScope = new Map();
for (const a of assets) {
	const org = orgById.get(a.organizationId);
	bump(bytesByScope, !org ? "(GLOBAL or deleted)" : isAnonPersonalOrg(org) ? "(anonymous personal orgs)" : scopeLabel(a), a.size ?? 0);
}
console.log("\nstored bytes by workspace:");
for (const [key, bytes] of [...bytesByScope].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB  ${key}`);
}

const threadsByScope = new Map();
for (const t of threads) {
	const org = orgById.get(t.organizationId);
	bump(threadsByScope, !org || isAnonPersonalOrg(org) ? "(anonymous personal orgs)" : scopeLabel(t));
}
console.log(`\nchats: ${threads.length}`);
for (const [key, count] of [...threadsByScope].sort((a, b) => b[1] - a[1])) console.log(`  ${count}  ${key}`);
