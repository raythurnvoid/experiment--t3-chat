/// <reference types="node" />

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

// Generates `server/ai-chat-builtin-skills.ts` from the skills submodule. The chat agent reads
// these files in the read-only Bash folder `/skills`, so the skill ships in the same deploy as the
// API it describes. The app lint uses `--check` to report a stale file without writing it.

const CHECK_FLAG = "--check";

/**
 * The skills of `packages/bonobo-senate-skills/skills` that the app serves to its agent.
 */
const BUILTIN_SKILL_NAMES = ["press-api"];

const HEADER = `/**
 * GENERATED FILE. Do not edit by hand.
 *
 * The built-in skills that ship with the app. Each key is a file path under the read-only Bash
 * folder \`/skills\`. The source is \`packages/bonobo-senate-skills/skills\`.
 * \`packages/app/scripts/generate-builtin-skills.ts\` writes this file
 * (\`pnpm run generate:builtin-skills\`), and the app lint fails when it is stale.
 */
`;

async function list_files(folder: string): Promise<string[]> {
	const entries = await fs.readdir(folder, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(folder, entry.name);
			return entry.isDirectory() ? await list_files(entryPath) : [entryPath];
		}),
	);
	return files.flat();
}

async function generate_builtin_skills_main() {
	const check = process.argv.includes(CHECK_FLAG);
	const appRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const skillsDir = path.resolve(appRootDir, "..", "bonobo-senate-skills", "skills");
	const outputPath = path.resolve(appRootDir, "server", "ai-chat-builtin-skills.ts");

	const lines: string[] = [];
	for (const name of BUILTIN_SKILL_NAMES) {
		const skillDir = path.join(skillsDir, name);
		const files = (await list_files(skillDir)).sort();
		for (const file of files) {
			const relativePath = path.relative(skillDir, file).split(path.sep).join("/");
			// A Windows checkout can have CRLF line endings. The served file must not depend on that.
			const text = (await fs.readFile(file, "utf8")).replace(/\r\n/g, "\n");
			lines.push(`\t${JSON.stringify(`/${name}/${relativePath}`)}: ${JSON.stringify(text)},`);
		}
	}
	const output = `${HEADER}export const ai_chat_builtin_skills_FILES: Record<string, string> = {\n${lines.join("\n")}\n};\n`;

	if (!check) {
		await fs.writeFile(outputPath, output, "utf8");
		console.log(`[generate_builtin_skills] Wrote ${outputPath}`);
		return;
	}

	const committed = await fs.readFile(outputPath, "utf8").then(
		(content) => content.replace(/\r\n/g, "\n"),
		() => null,
	);
	if (committed === output) {
		console.log(`[generate_builtin_skills] ${outputPath} is up to date`);
		return;
	}
	console.error(
		`[generate_builtin_skills] ${outputPath} is stale. Run "pnpm run generate:builtin-skills" in packages/app.`,
	);
	process.exitCode = 1;
}

generate_builtin_skills_main().catch((error: unknown) => {
	console.error("[generate_builtin_skills] Failed", error);
	process.exitCode = 1;
});
