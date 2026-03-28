import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const read_stdin = () =>
	new Promise((resolve, reject) => {
		let result = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			result += chunk;
		});
		process.stdin.on("end", () => resolve(result));
		process.stdin.on("error", reject);
	});

const normalize_workspace_root = (root) => {
	if (typeof root !== "string") {
		return "";
	}

	return root.replace(/^\/(?=[a-zA-Z]:[\\/])/, "");
};

const main = async () => {
	const raw = await read_stdin().catch(() => "");
	let payload = {};
	try {
		payload = raw.trim() ? JSON.parse(raw) : {};
	} catch {
		payload = {};
	}

	const workspace_roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
	const projectDir =
		workspace_roots
			.map(normalize_workspace_root)
			.find((root) => /(?:^|[\\/])t3-chat$/i.test(root)) ?? process.cwd();
	const readmePath = path.join(projectDir, "..", "t3-chat-+personal", "sources", "README.md");
	const readmeContent = await readFile(readmePath, "utf8").catch(() => null);

	if (!readmeContent) {
		process.stdout.write(JSON.stringify({}) + "\n");
		return;
	}

	process.stdout.write(
		JSON.stringify({
			additional_context: "<personal_sources_summary>\n" + readmeContent + "\n</personal_sources_summary>",
		}) + "\n",
	);
};

main().catch(() => {
	process.stdout.write("{}\n");
	process.exit(0);
});
