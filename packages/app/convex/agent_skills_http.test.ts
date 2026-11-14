import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { ai_chat_builtin_skills_FILES } from "../server/ai-chat-builtin-skills.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { test_convex } from "./setup.test.ts";

describe("agent_skills_http_handle_request", () => {
	test("serves an index whose digest matches the zip of the bundled skill", async () => {
		const t = test_convex();

		const indexResponse = await t.fetch("/.well-known/agent-skills/index.json");
		expect(indexResponse.status).toBe(200);
		expect(indexResponse.headers.get("cache-control")).toBe("no-cache");
		const index = (await indexResponse.json()) as {
			$schema: string;
			skills: Array<{ name: string; type: string; url: string; digest: string; version: string | null }>;
		};
		expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
		const entry = index.skills.find((skill) => skill.name === "press-api");
		expect(entry).toMatchObject({ type: "archive" });
		expect(entry?.url).toBe(`/.well-known/agent-skills/press-api.zip?sha256=${entry?.digest.slice("sha256:".length)}`);
		expect(entry?.version).toMatch(/^\d+\.\d+\.\d+$/u);

		const archiveResponse = await t.fetch(entry!.url);
		expect(archiveResponse.status).toBe(200);
		expect(archiveResponse.headers.get("content-type")).toBe("application/zip");
		const archive = new Uint8Array(await archiveResponse.arrayBuffer());
		// Clients must refuse an archive whose bytes do not match the digest.
		expect(entry?.digest).toBe(`sha256:${await crypto_sha256_hex(archive)}`);
		// The skill files sit at the zip root, with no wrapper folder.
		expect(strFromU8(unzipSync(archive)["SKILL.md"])).toBe(ai_chat_builtin_skills_FILES["/press-api/SKILL.md"]);

		expect((await t.fetch("/.well-known/agent-skills/missing.zip")).status).toBe(404);
	});

	test("refuses an archive URL with a different digest and asks for a fresh index", async () => {
		const t = test_convex();
		const digest = await crypto_sha256_hex("a previous skill archive");
		const response = await t.fetch(`/.well-known/agent-skills/press-api.zip?sha256=${digest}`);

		expect(response.status).toBe(409);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("Skill archive changed. Read /.well-known/agent-skills/index.json again.");

		const currentResponse = await t.fetch("/.well-known/agent-skills/press-api.zip");
		expect(currentResponse.status).toBe(200);
		expect(currentResponse.headers.get("content-type")).toBe("application/zip");
	});
});
