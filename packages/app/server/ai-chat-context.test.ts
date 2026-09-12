import { Result } from "common/errors-as-values-utils.ts";
import { getFunctionName, type FunctionReference } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import { ai_chat_skills_LIMITS } from "./ai-chat-skills.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { ai_chat_context_create, ai_chat_context_read_instructions } from "./ai-chat-context.ts";

const scope = {
	membershipId: "membership_1" as Id<"organizations_workspaces_users">,
	userId: "user_1" as Id<"users">,
};
const tenant = {
	organizationId: "organization_1" as Id<"organizations">,
	workspaceId: "workspace_1" as Id<"organizations_workspaces">,
};

function fixture() {
	const files = new Map<string, string>();
	const runQuery = vi.fn(
		async (ref: FunctionReference<"query">, args: { path?: string; mode?: { kind: string; maxBytes: number } }) => {
			switch (getFunctionName(ref)) {
				case "ai_chat_context:discover_sources":
					return Result({
						_yay: {
							...tenant,
							skills: [...files.keys()].filter((path) => /^\/\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(path)),
						},
					});
				case "files_nodes:get_by_path":
					return files.has(args.path!) ? { kind: "file", path: args.path } : null;
				case "files_nodes:read_file_content_from_chunks": {
					const content = files.get(args.path!);
					if (content === undefined) return null;
					if (args.mode?.kind === "prefix") {
						return { content: content.slice(0, args.mode.maxBytes), moreLines: content.length > args.mode.maxBytes };
					}
					return files_get_utf8_byte_size(content) <= args.mode!.maxBytes ? { content, moreLines: false } : null;
				}
				default:
					throw new Error(`Unexpected query: ${getFunctionName(ref)}`);
			}
		},
	);
	const runAction = vi.fn(async () => null);
	const ctx = { runQuery, runAction } as unknown as ActionCtx;
	async function create() {
		const result = await ai_chat_context_create(ctx, scope);
		if (result._nay) throw new Error(result._nay.message);
		return result._yay;
	}
	return { ctx, files, runQuery, runAction, create };
}

describe("ai_chat_context_create", () => {
	test("starts with root rules and a metadata-only skill catalog", async () => {
		const f = fixture();
		f.files.set("/AGENTS.md", "ROOT_RULE");
		f.files.set("/reports/AGENTS.md", "NESTED_RULE");
		f.files.set("/.agents/skills/example/SKILL.md", "---\nname: example\ndescription: Useful skill\n---\nSKILL_BODY");
		const { system } = await f.create();
		expect(system).toContain("ROOT_RULE");
		expect(system).toContain("Useful skill");
		expect(system).toContain("/.agents/skills/example/SKILL.md");
		expect(system).not.toContain("NESTED_RULE");
		expect(system).not.toContain("SKILL_BODY");
		expect(system).not.toContain("load_skill");
	});

	test("warns about invalid frontmatter without exposing its body", async () => {
		const f = fixture();
		f.files.set("/.agents/skills/example/SKILL.md", "PRIVATE_BAD_YAML");
		const { system } = await f.create();
		expect(system).toContain("/.agents/skills/example/SKILL.md");
		expect(system).toContain("YAML");
		expect(system).not.toContain("PRIVATE_BAD_YAML");
	});

	test("bounds the serialized catalog including escaped descriptions", async () => {
		const f = fixture();
		for (let index = 0; index < 100; index++) {
			f.files.set(
				`/.agents/skills/skill-${index}/SKILL.md`,
				`---\nname: skill-${index}\ndescription: ${JSON.stringify("\u0001".repeat(100))}\n---\nBODY`,
			);
		}
		const { system } = await f.create();
		expect(system).toContain("catalog is incomplete");
		expect(files_get_utf8_byte_size(system)).toBeLessThan(ai_chat_skills_LIMITS.catalog + 3000);
	});
});

describe("ai_chat_context_read_instructions", () => {
	test("loads only target ancestors in order and includes a directory's own rules", async () => {
		const f = fixture();
		f.files.set("/AGENTS.md", "ROOT_RULE");
		f.files.set("/reports/AGENTS.md", "REPORT_RULE");
		f.files.set("/reports/monthly/AGENTS.md", "MONTH_RULE");
		f.files.set("/invoices/AGENTS.md", "SIBLING_RULE");
		const { context } = await f.create();
		const text = await ai_chat_context_read_instructions(f.ctx, context, ["/reports/monthly"]);
		expect(text).toContain("REPORT_RULE");
		expect(text).toContain("MONTH_RULE");
		expect(text.indexOf("REPORT_RULE")).toBeLessThan(text.indexOf("MONTH_RULE"));
		expect(text).not.toContain("ROOT_RULE");
		expect(text).not.toContain("SIBLING_RULE");
	});

	test("keeps ordinary app folders named tmp in scope", async () => {
		const f = fixture();
		f.files.set("/tmp/AGENTS.md", "APP_TMP_RULE");
		const { context } = await f.create();
		expect(await ai_chat_context_read_instructions(f.ctx, context, ["/tmp/file.md"])).toContain("APP_TMP_RULE");
	});

	test("dedupes path and text, rereads changed text, and keeps requests separate", async () => {
		const f = fixture();
		f.files.set("/a/AGENTS.md", "SAME");
		f.files.set("/b/AGENTS.md", "SAME");
		const first = await f.create();
		const second = await f.create();
		expect(await ai_chat_context_read_instructions(f.ctx, first.context, ["/a/file"])).toContain("SAME");
		expect(await ai_chat_context_read_instructions(f.ctx, first.context, ["/a/file"])).toBe("");
		expect(await ai_chat_context_read_instructions(f.ctx, first.context, ["/b/file"])).toContain("SAME");

		f.files.set("/a/AGENTS.md", "CHANGED");
		expect(await ai_chat_context_read_instructions(f.ctx, first.context, ["/a/file"])).toContain("CHANGED");
		expect(await ai_chat_context_read_instructions(f.ctx, second.context, ["/b/file"])).toContain("SAME");

		f.files.delete("/a/AGENTS.md");
		expect(await ai_chat_context_read_instructions(f.ctx, first.context, ["/a/file"])).toBe("");
	});

	test("does not mark guidance delivered when the result budget omits it", async () => {
		const f = fixture();
		f.files.set("/a/AGENTS.md", "\u0001".repeat(500));
		const { context } = await f.create();
		const limited = await ai_chat_context_read_instructions(f.ctx, context, ["/a/file"], 1024);
		expect(files_get_utf8_byte_size(JSON.stringify(limited))).toBeLessThanOrEqual(1024);
		expect(limited).not.toContain("\\u0001");
		expect(await ai_chat_context_read_instructions(f.ctx, context, ["/a/file"])).toContain("\\u0001");
	});

	test("shares the 64 KiB instruction limit across parallel tools", async () => {
		const f = fixture();
		const body = "x".repeat(ai_chat_skills_LIMITS.instruction);
		for (const name of ["a", "b", "c"]) f.files.set(`/${name}/AGENTS.md`, body);
		const { context } = await f.create();
		const texts = await Promise.all(
			["a", "b", "c"].map((name) => ai_chat_context_read_instructions(f.ctx, context, [`/${name}/file`])),
		);
		expect(texts.filter((text) => text.includes(body))).toHaveLength(2);
		expect(texts.filter((text) => text.includes("64 KiB instruction limit"))).toHaveLength(1);
		expect(context.instructionBytes).toBe(ai_chat_skills_LIMITS.active);
	});

	test("bounds rules and ancestor expansion with clear warnings", async () => {
		const f = fixture();
		f.files.set("/a/AGENTS.md", "x".repeat(ai_chat_skills_LIMITS.instruction + 1));
		const { context } = await f.create();
		expect(await ai_chat_context_read_instructions(f.ctx, context, ["/a/file"])).toContain("could not be read");

		f.runQuery.mockClear();
		const deepPath = `/${Array.from({ length: 1000 }, (_, index) => `dir${index}`).join("/")}`;
		expect(await ai_chat_context_read_instructions(f.ctx, context, [deepPath])).toContain("incomplete");
		expect(f.runQuery.mock.calls.length).toBeLessThanOrEqual(128);
	});

	test("keeps a warning when an ordinary reader fails", async () => {
		const f = fixture();
		const { context } = await f.create();
		f.runQuery.mockRejectedValueOnce(new Error("PRIVATE_FAILURE"));
		const text = await ai_chat_context_read_instructions(f.ctx, context, ["/a/file"]);
		expect(text).toContain("could not be read");
		expect(text).not.toContain("PRIVATE_FAILURE");
	});
});
