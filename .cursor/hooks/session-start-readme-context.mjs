import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
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

const file_exists = async (filePath) => {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

const main = async () => {
	await read_stdin().catch(() => "");

	const projectDir = process.env.CURSOR_PROJECT_DIR || process.cwd();
	const readmePath = path.join(projectDir, "..", "t3-chat-+personal", "sources", "README.md");
	const exists = await file_exists(readmePath);

	if (!exists) {
		process.stdout.write(JSON.stringify({}) + "\n");
		return;
	}

	const readmeContent = await readFile(readmePath, "utf8");

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
