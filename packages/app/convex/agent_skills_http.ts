import { zipSync, strToU8 } from "fflate";
import { ai_chat_builtin_skills_FILES } from "../server/ai-chat-builtin-skills.ts";
import { ai_chat_skills_parse } from "../server/ai-chat-skills.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";

// Serve the built-in skills with the Agent Skills Discovery RFC (draft 0.2.0):
// https://github.com/cloudflare/agent-skills-discovery-rfc
// Agents and the press-api helper read the index to find the skill copy that matches this deploy.

const INDEX_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

// Clients check the index again on every read, so they always see the digest of this deploy.
// The zip URL holds that digest, so a cached zip always matches its URL.
const INDEX_CACHE_CONTROL = "no-cache";
const ARCHIVE_CACHE_CONTROL = "public, max-age=300";

// Give every zip entry the same date. Then the same files always make the same zip bytes,
// and the digest in the index matches the zip on every server instance.
const ZIP_MTIME = new Date(1980, 0, 1);

const get_skills = ((/* iife */) => {
	async function value() {
		const filesBySkill = new Map<string, Record<string, Uint8Array>>();
		for (const [filePath, text] of Object.entries(ai_chat_builtin_skills_FILES)) {
			// Keys look like "/press-api/references/files.md".
			const [, name, ...rest] = filePath.split("/");
			const files = filesBySkill.get(name) ?? {};
			files[rest.join("/")] = strToU8(text);
			filesBySkill.set(name, files);
		}

		const index = { $schema: INDEX_SCHEMA, skills: [] as Array<Record<string, string | null>> };
		const archives = new Map<string, Uint8Array<ArrayBuffer>>();
		for (const [name, files] of filesBySkill) {
			const skillText = ai_chat_builtin_skills_FILES[`/${name}/SKILL.md`];
			const parsed = ai_chat_skills_parse(skillText ?? "", name);
			if (parsed._nay) {
				console.error("Skipped a built-in skill with an invalid SKILL.md", { name, error: parsed._nay });
				continue;
			}

			// The RFC wants the skill files at the root of the zip, with no wrapper folder.
			// Copy into an ArrayBuffer-backed view, so the bytes type as a Response body.
			const archive = new Uint8Array(zipSync(files, { mtime: ZIP_MTIME }));
			const archiveName = `${name}.zip`;
			archives.set(archiveName, archive);
			const digest = await crypto_sha256_hex(archive);

			index.skills.push({
				name,
				type: "archive",
				description: parsed._yay.description,
				// Put the digest in the URL, so a cache never pairs this digest with an older zip.
				// The handler ignores the query.
				url: `/.well-known/agent-skills/${archiveName}?sha256=${digest}`,
				digest: `sha256:${digest}`,
				// Extra field: the RFC tells clients to ignore it. The press-api helper compares it with
				// its own version. `scripts/public-api-skill.test.ts` keeps metadata.version in this shape.
				version: /^metadata:\n\s+version: "([^"]+)"/mu.exec(skillText)?.[1] ?? null,
			});
		}

		return { index, archives };
	}

	let cache: ReturnType<typeof value> | undefined;

	return function get_skills() {
		return (cache ??= value());
	};
})();

/**
 * Answer `GET /.well-known/agent-skills/index.json` and `GET /.well-known/agent-skills/<name>.zip`.
 */
export async function agent_skills_http_handle_request(args: { request: Request; pathPrefix: string }) {
	const { request, pathPrefix } = args;
	const fileName = new URL(request.url).pathname.slice(pathPrefix.length);
	const skills = await get_skills();

	if (fileName === "index.json") {
		return Response.json(skills.index, { headers: { "Cache-Control": INDEX_CACHE_CONTROL } });
	}

	const archive = skills.archives.get(fileName);
	if (!archive) {
		return new Response("Not found", { status: 404 });
	}
	return new Response(archive, {
		headers: { "Content-Type": "application/zip", "Cache-Control": ARCHIVE_CACHE_CONTROL },
	});
}
