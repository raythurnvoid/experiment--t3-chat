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
	organizationId: "organization_1" as Id<"organizations">,
	workspaceId: "workspace_1" as Id<"organizations_workspaces">,
	threadId: "thread_1" as Id<"ai_chat_threads">,
	membershipLifetime: 1,
};
const tenant = {
	organizationId: "organization_1" as Id<"organizations">,
	workspaceId: "workspace_1" as Id<"organizations_workspaces">,
	organizationName: "team",
	workspaceName: "docs",
};

function fixture(sameHome = false) {
	const files = new Map<string, string>();
	const personalFiles = sameHome ? files : new Map<string, string>();
	const personal = sameHome
		? tenant
		: {
				organizationId: "organization_home" as Id<"organizations">,
				workspaceId: "workspace_home" as Id<"organizations_workspaces">,
				organizationName: "personal",
				workspaceName: "home",
			};
	const runQuery = vi.fn(
		async (
			ref: FunctionReference<"query">,
			args: {
				agentSource?: typeof scope;
				workspaceId?: string;
				workspace?: string;
				path?: string;
				mode?: { kind: string; maxBytes: number };
			},
		): Promise<unknown> => {
			const targetFiles = args.workspaceId === personal.workspaceId ? personalFiles : files;
			switch (getFunctionName(ref)) {
				case "ai_chat_workspaces:resolve":
					return Result({ _yay: args.workspace === "personal" ? personal : tenant });
				case "ai_chat_context:discover_sources":
					return Result({
						_yay: {
							workspaces: [
								{ workspace: "current", ...tenant },
								...(sameHome ? [] : [{ workspace: "personal", ...personal }]),
							],
							skills: [...files.keys()]
								.map((path) => ({ workspace: "current", path }))
								.concat(sameHome ? [] : [...personalFiles.keys()].map((path) => ({ workspace: "personal", path })))
								.filter(({ path }) => /^\/\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(path))
								.slice(0, 100),
						},
					});
				case "files_visible:internal_get_by_path":
					return targetFiles.has(args.path!) ? { node: { kind: "file" }, path: args.path } : null;
				case "files_nodes:read_file_content_from_chunks": {
					const content = targetFiles.get(args.path!);
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
	const runAction = vi.fn(
		async (_ref: FunctionReference<"action">, _args: unknown): Promise<{ content: string } | null> => null,
	);
	const ctx = { runQuery, runAction } as unknown as ActionCtx;
	async function create() {
		const result = await ai_chat_context_create(ctx, { source: scope });
		if (result._nay) throw new Error(result._nay.message);
		return result._yay;
	}
	return { ctx, files, personalFiles, runQuery, runAction, create };
}

describe("ai_chat_context_create", () => {
	test("keeps same-name skills and root rules distinct across both workspace mounts", async () => {
		const f = fixture();
		for (const files of [f.files, f.personalFiles]) {
			files.set("/AGENTS.md", "SAME_ROOT");
			files.set("/.agents/skills/example/SKILL.md", "---\nname: example\ndescription: Same name\n---\nHIDDEN_BODY");
			files.set("/nested/AGENTS.md", "NESTED_RULE");
		}
		const { system, context } = await f.create();
		expect(system.match(/SAME_ROOT/gu)).toHaveLength(2);
		expect(system.match(/"name":"example"/gu)).toHaveLength(2);
		for (const root of ["/home/cloud-usr/w/team/docs", "/home/cloud-usr/w/personal/home"]) {
			expect(system).toContain(`"source":"${root}/AGENTS.md","scope":"${root}/"`);
			expect(system).toContain(`"path":"${root}/.agents/skills/example/SKILL.md"`);
		}
		expect(system).toContain('"workspace":"personal"');
		expect(system).not.toMatch(/HIDDEN_BODY|NESTED_RULE/u);
		expect(context.instructionBytes).toBe("SAME_ROOT".length * 2);
		expect(
			f.runQuery.mock.calls.filter(([ref]) => getFunctionName(ref) === "ai_chat_context:discover_sources"),
		).toHaveLength(1);
	});

	test("dedupes discovery, reads, and bytes when current is personal home", async () => {
		const f = fixture(true);
		f.files.set("/AGENTS.md", "ONE_ROOT");
		f.files.set("/.agents/skills/example/SKILL.md", "---\nname: example\ndescription: One skill\n---\n");
		const { system, context } = await f.create();
		expect(system.match(/ONE_ROOT/gu)).toHaveLength(1);
		expect(system.match(/"name":"example"/gu)).toHaveLength(1);
		f.runQuery.mockClear();
		expect(
			await ai_chat_context_read_instructions(f.ctx, context, [
				{ workspace: "current", path: "/" },
				{ workspace: "personal", path: "/" },
			]),
		).toBe("");
		expect(context.instructionBytes).toBe("ONE_ROOT".length);
		expect(
			f.runQuery.mock.calls.filter(([ref]) => getFunctionName(ref) === "files_nodes:read_file_content_from_chunks"),
		).toHaveLength(1);
	});

	test("shares the 32 KiB catalog budget across roots including workspace and mount labels", async () => {
		const f = fixture();
		for (const files of [f.files, f.personalFiles]) {
			for (let index = 0; index < 35; index++)
				files.set(
					`/.agents/skills/skill-${index}/SKILL.md`,
					`---\nname: skill-${index}\ndescription: ${"a".repeat(500)}\n---\n`,
				);
		}
		const { system } = await f.create();
		const catalog = system.split("Skill catalog:\n")[1].split("\n\n")[0];
		expect(catalog).toContain('"workspace":"current"');
		expect(catalog).toContain('"workspace":"personal"');
		expect(files_get_utf8_byte_size(catalog)).toBeLessThanOrEqual(ai_chat_skills_LIMITS.catalog);
		expect(system).toContain("metadata exceeds 32 KiB");
	});

	test("does not publish skill metadata after source access ends during its read", async () => {
		const f = fixture();
		f.personalFiles.set(
			"/.agents/skills/example/SKILL.md",
			"---\nname: example\ndescription: PRIVATE_DESCRIPTION\n---\n",
		);
		const runQuery = f.runQuery.getMockImplementation()!;
		let revoked = false;
		f.runQuery.mockImplementation(async (ref, args) => {
			if (revoked && getFunctionName(ref) === "ai_chat_workspaces:resolve")
				return Result({ _nay: { message: "Chat is no longer available" } });
			const result = await runQuery(ref, args);
			if (getFunctionName(ref) === "files_nodes:read_file_content_from_chunks") revoked = true;
			return result;
		});
		const result = await ai_chat_context_create(f.ctx, { source: scope });
		expect(result._nay).toBeDefined();
		expect(JSON.stringify(result)).not.toContain("PRIVATE_DESCRIPTION");
	});

	test("passes the captured source to visible, chunk, and fallback reads in both roots", async () => {
		const f = fixture();
		for (const files of [f.files, f.personalFiles]) files.set("/AGENTS.md", "ROOT_RULE");
		const runQuery = f.runQuery.getMockImplementation()!;
		f.runQuery.mockImplementation(async (ref, args) => {
			if (getFunctionName(ref) === "files_nodes:read_file_content_from_chunks") return null;
			return runQuery(ref, args);
		});
		f.runAction.mockResolvedValue({ content: "ROOT_RULE" });
		const { system } = await f.create();
		expect(system.match(/ROOT_RULE/gu)).toHaveLength(2);
		for (const name of ["files_visible:internal_get_by_path", "files_nodes:read_file_content_from_chunks"]) {
			const reads = f.runQuery.mock.calls.filter(([ref]) => getFunctionName(ref) === name);
			expect(reads.length).toBeGreaterThanOrEqual(2);
			for (const [, args] of reads) expect(args.agentSource).toEqual(scope);
			expect(reads.some(([, args]) => args.workspaceId === "workspace_home")).toBe(true);
			expect(reads.some(([, args]) => args.workspaceId === tenant.workspaceId)).toBe(true);
		}
		expect(f.runAction).toHaveBeenCalledTimes(2);
		for (const [ref, args] of f.runAction.mock.calls) {
			expect(getFunctionName(ref)).toBe("files_nodes_content:get_file_last_available_text_content_by_path");
			expect(args).toMatchObject({ agentSource: scope });
		}
	});

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
	test("keeps equal paths and text scoped to each workspace", async () => {
		const f = fixture();
		f.files.set("/notes/AGENTS.md", "SAME_RULE");
		f.personalFiles.set("/notes/AGENTS.md", "SAME_RULE");
		const { context } = await f.create();
		const current = await ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: "/notes" }]);
		const personal = await ai_chat_context_read_instructions(f.ctx, context, [
			{ workspace: "personal", path: "/notes" },
		]);
		expect(current).toContain('"scope":"/home/cloud-usr/w/team/docs/notes/"');
		expect(current).not.toContain("personal/home");
		expect(personal).toContain('"scope":"/home/cloud-usr/w/personal/home/notes/"');
		expect(personal).toContain("SAME_RULE");
		expect(context.instructionBytes).toBe("SAME_RULE".length * 2);
	});

	test("shares instruction bytes across roots and parallel calls", async () => {
		const f = fixture();
		const body = "b".repeat(ai_chat_skills_LIMITS.instruction);
		f.files.set("/a/AGENTS.md", body);
		f.personalFiles.set("/a/AGENTS.md", body);
		f.personalFiles.set("/b/AGENTS.md", body);
		const { context } = await f.create();
		const results = await Promise.all([
			ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: "/a" }]),
			ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "personal", path: "/a" }]),
			ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "personal", path: "/b" }]),
		]);
		expect(results.filter((result) => result.includes(body))).toHaveLength(2);
		expect(results.filter((result) => result.includes("64 KiB instruction limit"))).toHaveLength(1);
		expect(context.instructionBytes).toBe(ai_chat_skills_LIMITS.active);
	});

	test("drops text when the source is revoked during an awaited content fallback", async () => {
		const f = fixture();
		f.personalFiles.set("/notes/AGENTS.md", "PRIVATE_RULE");
		const { context } = await f.create();
		const runQuery = f.runQuery.getMockImplementation()!;
		let revoked = false;
		f.runQuery.mockImplementation(async (ref, args) => {
			if (getFunctionName(ref) === "files_nodes:read_file_content_from_chunks") return null;
			if (revoked && getFunctionName(ref) === "ai_chat_workspaces:resolve")
				return Result({ _nay: { message: "Chat is no longer available" } });
			return runQuery(ref, args);
		});
		f.runAction.mockImplementation(async () => {
			revoked = true;
			return { content: "PRIVATE_RULE" };
		});
		const result = await ai_chat_context_read_instructions(
			f.ctx,
			context,
			[{ workspace: "personal", path: "/notes" }],
			1024,
		);
		expect(result).not.toContain("PRIVATE_RULE");
		expect(result).toContain("unavailable");
		expect(context.instructionBytes).toBe(0);
		expect(files_get_utf8_byte_size(JSON.stringify(result))).toBeLessThanOrEqual(1024);
	});

	test("loads only target ancestors in order and includes a directory's own rules", async () => {
		const f = fixture();
		f.files.set("/AGENTS.md", "ROOT_RULE");
		f.files.set("/reports/AGENTS.md", "REPORT_RULE");
		f.files.set("/reports/monthly/AGENTS.md", "MONTH_RULE");
		f.files.set("/invoices/AGENTS.md", "SIBLING_RULE");
		const { context } = await f.create();
		const text = await ai_chat_context_read_instructions(f.ctx, context, [
			{ workspace: "current", path: "/reports/monthly" },
		]);
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
		expect(
			await ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: "/tmp/file.md" }]),
		).toContain("APP_TMP_RULE");
	});

	test("dedupes path and text, rereads changed text, and keeps requests separate", async () => {
		const f = fixture();
		f.files.set("/a/AGENTS.md", "SAME");
		f.files.set("/b/AGENTS.md", "SAME");
		const first = await f.create();
		const second = await f.create();
		expect(
			await ai_chat_context_read_instructions(f.ctx, first.context, [{ workspace: "current", path: "/a/file" }]),
		).toContain("SAME");
		expect(
			await ai_chat_context_read_instructions(f.ctx, first.context, [{ workspace: "current", path: "/a/file" }]),
		).toBe("");
		expect(
			await ai_chat_context_read_instructions(f.ctx, first.context, [{ workspace: "current", path: "/b/file" }]),
		).toContain("SAME");

		f.files.set("/a/AGENTS.md", "CHANGED");
		expect(
			await ai_chat_context_read_instructions(f.ctx, first.context, [{ workspace: "current", path: "/a/file" }]),
		).toContain("CHANGED");
		expect(
			await ai_chat_context_read_instructions(f.ctx, second.context, [{ workspace: "current", path: "/b/file" }]),
		).toContain("SAME");

		f.files.delete("/a/AGENTS.md");
		expect(
			await ai_chat_context_read_instructions(f.ctx, first.context, [{ workspace: "current", path: "/a/file" }]),
		).toBe("");
	});

	test("does not mark guidance delivered when the result budget omits it", async () => {
		const f = fixture();
		f.files.set("/a/AGENTS.md", "\u0001".repeat(500));
		const { context } = await f.create();
		const limited = await ai_chat_context_read_instructions(
			f.ctx,
			context,
			[{ workspace: "current", path: "/a/file" }],
			1024,
		);
		expect(files_get_utf8_byte_size(JSON.stringify(limited))).toBeLessThanOrEqual(1024);
		expect(limited).not.toContain("\\u0001");
		expect(
			await ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: "/a/file" }]),
		).toContain("\\u0001");
	});

	test("shares the 64 KiB instruction limit across parallel tools", async () => {
		const f = fixture();
		const body = "x".repeat(ai_chat_skills_LIMITS.instruction);
		for (const name of ["a", "b", "c"]) f.files.set(`/${name}/AGENTS.md`, body);
		const { context } = await f.create();
		const texts = await Promise.all(
			["a", "b", "c"].map((name) =>
				ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: `/${name}/file` }]),
			),
		);
		expect(texts.filter((text) => text.includes(body))).toHaveLength(2);
		expect(texts.filter((text) => text.includes("64 KiB instruction limit"))).toHaveLength(1);
		expect(context.instructionBytes).toBe(ai_chat_skills_LIMITS.active);
	});

	test("bounds rules and ancestor expansion with clear warnings", async () => {
		const f = fixture();
		f.files.set("/a/AGENTS.md", "x".repeat(ai_chat_skills_LIMITS.instruction + 1));
		const { context } = await f.create();
		expect(
			await ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: "/a/file" }]),
		).toContain("could not be read");

		f.runQuery.mockClear();
		const deepPath = `/${Array.from({ length: 1000 }, (_, index) => `dir${index}`).join("/")}`;
		expect(
			await ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: deepPath }]),
		).toContain("incomplete");
		expect(
			f.runQuery.mock.calls.filter(([ref]) => getFunctionName(ref) === "files_visible:internal_get_by_path"),
		).toHaveLength(128);
	});

	test("shares the ancestor path cap across both roots", async () => {
		const f = fixture();
		const { context } = await f.create();
		f.runQuery.mockClear();
		const path = `/${Array.from({ length: 70 }, (_, index) => `dir${index}`).join("/")}`;
		const result = await ai_chat_context_read_instructions(f.ctx, context, [
			{ workspace: "current", path },
			{ workspace: "personal", path },
		]);
		expect(result).toContain("too many ancestor paths");
		const reads = f.runQuery.mock.calls.filter(
			([ref]) => getFunctionName(ref) === "files_visible:internal_get_by_path",
		);
		expect(reads).toHaveLength(128);
		expect(reads.some(([, args]) => args.workspaceId === tenant.workspaceId)).toBe(true);
		expect(reads.some(([, args]) => args.workspaceId === "workspace_home")).toBe(true);
	});

	test("keeps a warning when an ordinary reader fails", async () => {
		const f = fixture();
		const { context } = await f.create();
		f.runQuery.mockRejectedValueOnce(new Error("PRIVATE_FAILURE"));
		const text = await ai_chat_context_read_instructions(f.ctx, context, [{ workspace: "current", path: "/a/file" }]);
		expect(text).toContain("could not be read");
		expect(text).not.toContain("PRIVATE_FAILURE");
	});
});
