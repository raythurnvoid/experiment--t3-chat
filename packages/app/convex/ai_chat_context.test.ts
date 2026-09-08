import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_get_file_yjs_pointers, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_create_yjs_snapshot_update_from_text } from "./files_nodes_content.ts";
import { encodeStateAsUpdate } from "yjs";
import { files_yjs_doc_create_from_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_get_utf8_byte_size, files_u8_to_array_buffer } from "../shared/files.ts";
import { ai_chat_skills_LIMITS } from "../shared/ai-chat-skills.ts";
import { ai_chat_context_create, ai_chat_context_system } from "../server/ai-chat-context.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_context_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test-upload",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { membershipId: db.membershipId, userId: db.userId };
	const user = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	async function create(path: string, textContent: string) {
		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
			textContent,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	}
	async function member(read: boolean) {
		return await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "second-user" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			if (read)
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
			return { userId, membershipId };
		});
	}
	return { t, db, scope, user, create, member };
}

const skillText = "---\nname: example\ndescription: Saved catalog description\n---\nPRIVATE_SKILL_BODY\n";

describe("get_source", () => {
	test("returns unavailable for a made-up model id while resolving a saved source", async () => {
		const { user, db, create } = await fixture();
		const nodeId = await create("/.agents/skills/example/SKILL.md", skillText);
		expect(await user.query(api.ai_chat_context.get_source, { membershipId: db.membershipId, nodeId: "missing" })).toBeNull();
		expect(await user.query(api.ai_chat_context.get_source, { membershipId: db.membershipId, nodeId })).toEqual({
			nodeId, path: "/.agents/skills/example/SKILL.md", name: "SKILL.md",
		});
	});
});

describe("get_catalog", () => {
	test.each([
		["node", "unsupported"],
		["worker-async-body-v1", "supported"],
		[undefined, undefined],
		["PRIVATE_RUNTIME_SENTINEL", "unsupported"],
	] as const)("labels explicit script runtime %s without blocking instructions", async (runtime, scriptStatus) => {
		const { t, scope, user, db, create } = await fixture();
		const metadata = runtime === undefined ? "" : `metadata:\n  bonobo-script-runtime: ${JSON.stringify(runtime)}\n`;
		const skillId = await create("/.agents/skills/example/SKILL.md", `---\nname: example\ndescription: A useful skill\ncompatibility: May need Python and Node\n${metadata}---\nPRIVATE_INSTRUCTIONS\n`);
		const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
		expect(catalog?.skills[0]).toMatchObject({ skillId, status: "available" });
		if (scriptStatus === undefined) expect(catalog?.skills[0]).not.toHaveProperty("scriptStatus");
		else expect(catalog?.skills[0].scriptStatus).toBe(scriptStatus);
		expect(JSON.stringify(catalog)).not.toContain("PRIVATE_RUNTIME_SENTINEL");
		expect(JSON.stringify(catalog)).not.toContain("PRIVATE_INSTRUCTIONS");
		expect(catalog?.skills[0]).not.toHaveProperty("metadata");
		const skill = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.skills[0];
		const read = await t.action(internal.ai_chat_context.read_source, { ...scope, nodeId: skillId, version: skill.version, maxBytes: 65536 });
		expect(read._yay?.content).toContain("PRIVATE_INSTRUCTIONS");
	});

	test("reports an incomplete catalog when more than 100 readable skills exist", async () => {
		const { create, user, db } = await fixture();
		for (let index = 0; index < 101; index++) {
			await create(`/.agents/skills/skill-${index}/SKILL.md`, `---\nname: skill-${index}\ndescription: Skill\n---\n`);
		}
		const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
		expect(catalog?.status).toBe("limit");
		expect(catalog?.skills).toEqual([]);
	});

	test("counts serialized catalog bytes like the runtime, including escaped and multibyte descriptions", async () => {
		const { t, scope, create, user, db } = await fixture();
		const description = '🐵"'.repeat(30) + "D".repeat(50);
		for (let index = 0; index < 100; index++) {
			await create(`/.agents/skills/skill-${index}/SKILL.md`, `---\nname: skill-${index}\ndescription: ${JSON.stringify(description)}\n---\n`);
		}
		const runtime = await t.action((ctx) => ai_chat_context_create(ctx, scope));
		expect(runtime._nay?.name).toBe("limit");
		const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
		expect(catalog?.status).toBe("limit");
		expect(catalog?.skills).toEqual([]);
	});

	test("accepts exactly 32 KiB including invalid and unreadable entries, then refuses one more byte", async () => {
		// Keep scheduled storage cleanup out of this catalog boundary check.
		vi.useFakeTimers();
		const { t, scope, create, user, db } = await fixture();
		for (let index = 0; index < 100; index++) {
			const text = index === 98 ? "Missing YAML" : index === 99 ? "S".repeat(ai_chat_skills_LIMITS.skill + 1) :
				`---\nname: skill-${index}\ndescription: ${"D".repeat(180)}\n---\n`;
			await create(`/.agents/skills/skill-${index}/SKILL.md`, text);
		}
		const initial = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
		expect(initial?.status).toBe("complete");
		expect(initial?.skills.map((skill) => skill.status)).toContain("invalid");
		expect(initial?.skills.map((skill) => skill.status)).toContain("too_large");
		// The model labels every unreadable entry invalid but keeps the same repair text.
		const modelEntries = initial!.skills.map((skill) => ({ ...skill, status: skill.status === "available" ? "available" : "invalid" }));
		const remaining = ai_chat_skills_LIMITS.catalog - files_get_utf8_byte_size(JSON.stringify(modelEntries));
		expect(remaining).toBeGreaterThan(0);
		expect(180 + remaining + 1).toBeLessThanOrEqual(ai_chat_skills_LIMITS.descriptionCharacters);
		const skillId = initial!.skills[0].skillId;
		const nonCollaborative = await user.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId, nodeId: skillId, acknowledgeDropCollaborativeHistory: true,
		});
		expect(nonCollaborative._nay).toBeUndefined();
		for (const extra of [0, 1]) {
			const saved = await user.action(api.files_nodes_content.replace_file_content, {
				membershipId: db.membershipId, nodeId: skillId,
				text: `---\nname: skill-0\ndescription: ${"D".repeat(180 + remaining + extra)}\n---\n`,
			});
			expect(saved._nay).toBeUndefined();
			const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
			const runtime = await t.action(async (ctx) => {
				const context = await ai_chat_context_create(ctx, scope);
				return context._nay ? { error: context._nay.name } : { system: ai_chat_context_system(context._yay, "base") };
			});
			if (extra === 0) {
				expect(catalog?.status).toBe("complete");
				expect(runtime.error).toBeUndefined();
				const catalogText = runtime.system!.split("Skill catalog (use load_skill by skillId):\n")[1];
				expect(files_get_utf8_byte_size(catalogText)).toBe(ai_chat_skills_LIMITS.catalog);
			} else {
				expect(catalog?.status).toBe("limit");
				expect(runtime.error).toBe("limit");
			}
		}
	});

	test("reserves unknown saved metadata while keeping a small updating catalog visible", async () => {
		const { t, create, user, db } = await fixture();
		for (let index = 0; index < 4; index++) {
			const nodeId = await create(`/.agents/skills/skill-${index}/SKILL.md`, `---\nname: skill-${index}\ndescription: Saved text\n---\n`);
			const pointers = await test_get_file_yjs_pointers(t, nodeId);
			await t.run(async (ctx) => {
				const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
				await ctx.db.patch("files_yjs_docs_last_sequences", sequence!._id, { lastSequence: sequence!.lastSequence + 1 });
			});
			const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
			if (index < 3) {
				expect(catalog?.status).toBe("complete");
				expect(catalog?.skills).toHaveLength(index + 1);
				expect(catalog?.skills.every((skill) => skill.status === "updating" && skill.description === "")).toBe(true);
			} else expect(catalog?.status).toBe("limit");
		}
	});

	test("lists exact saved sources in root-to-leaf order and returns no bodies", async () => {
		const { create, user, db } = await fixture();
		await create("/docs/AGENTS.md", "NESTED_PRIVATE_BODY");
		await create("/AGENTS.md", "ROOT_PRIVATE_BODY");
		const skillId = await create("/.agents/skills/example/SKILL.md", skillText);
		await create("/elsewhere/SKILL.md", skillText);
		// Reserved runtime locations are not workspace instruction roots.
		await create("/tmp/AGENTS.md", "TEMPORARY_PRIVATE_BODY");
		const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
		expect(catalog?.instructions.map((source) => source.path)).toEqual(["/AGENTS.md", "/docs/AGENTS.md"]);
		expect(catalog?.skills).toMatchObject([
			{ skillId, name: "example", description: "Saved catalog description", status: "available" },
		]);
		expect(JSON.stringify(catalog)).not.toContain("PRIVATE_BODY");
		expect(JSON.stringify(catalog)).not.toContain("PRIVATE_SKILL_BODY");
	});

	test("refuses a non-member and a member without content.read", async () => {
		const { t, db, member, create } = await fixture();
		await create("/.agents/skills/example/SKILL.md", skillText);
		const second = await member(false);
		const user = t.withIdentity({ issuer: "https://clerk.test", external_id: second.userId });
		expect(await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId })).toBeNull();
		expect(await user.query(api.ai_chat_context.get_catalog, { membershipId: second.membershipId })).toBeNull();
		expect((await t.query(internal.ai_chat_context.discover_sources, second))._nay?.name).toBe("unavailable");
	});

	test("filters restricted source paths before exposing names or errors", async () => {
		const { t, member, create } = await fixture();
		const secret = await create("/.agents/skills/secret/SKILL.md", "malformed secret");
		await create("/.agents/skills/example/SKILL.md", skillText);
		await t.run((ctx) => ctx.db.patch("files_nodes", secret, { restrictedScopeNodeId: secret }));
		const second = await member(true);
		const user = t.withIdentity({ issuer: "https://clerk.test", external_id: second.userId });
		const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: second.membershipId });
		expect(catalog?.skills.map((skill) => skill.name)).toEqual(["example"]);
		expect(JSON.stringify(catalog)).not.toContain("secret");
		expect(
			await user.query(api.ai_chat_context.get_source, { membershipId: second.membershipId, nodeId: secret }),
		).toBeNull();
	});

	test("shows Updating for real materialization lag without serving stale metadata", async () => {
		const { t, create, user, db } = await fixture();
		const nodeId = await create("/.agents/skills/example/SKILL.md", skillText);
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		await t.run(async (ctx) => {
			const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
			await ctx.db.patch("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId, {
				lastSequence: sequence!.lastSequence + 1,
			});
		});
		const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
		expect(catalog?.skills).toMatchObject([{ status: "updating", description: "" }]);
		expect(JSON.stringify(catalog)).not.toContain("Saved catalog description");
	});

	test("keeps any author's eager-created source out until its saved stamp advances", async () => {
		const { t, db, scope, create, member } = await fixture();
		const nodeId = await create("/.agents/skills/example/SKILL.md", skillText);
		const second = await member(true);
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		await t.run(async (ctx) => {
			const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
			await ctx.db.insert("files_pending_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				userId: second.userId,
				eagerCreated: { committedSequence: sequence!.lastSequence },
				size: 0,
				updatedAt: Date.now(),
			});
		});
		expect((await t.query(internal.ai_chat_context.discover_sources, scope))._yay?.skills).toEqual([]);
		await t.run(async (ctx) => {
			const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
			await ctx.db.patch("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId, {
				lastSequence: sequence!.lastSequence + 1,
			});
		});
		expect((await t.query(internal.ai_chat_context.discover_sources, scope))._yay?.skills).toHaveLength(1);
	});
});

describe("read_source", () => {
	test("changes the pin after a rename, collaboration change, and whole-text save", async () => {
		const { t, scope, user, db, create } = await fixture();
		const nodeId = await create("/.agents/skills/example/references/help.txt", "Saved text");
		const sourceArgs = { ...scope, sources: [{ nodeId, version: "" }] };
		let source = (await t.query(internal.ai_chat_context.check_sources, sourceArgs))._yay![0];
		const renamed = await user.mutation(api.files_nodes.rename_node, { membershipId: db.membershipId, nodeId, path: "renamed.txt" });
		expect(renamed._nay).toBeUndefined();
		expect((await t.action(internal.ai_chat_context.read_source, { ...scope, nodeId, version: source.version, maxBytes: 65536 }))._nay?.name).toBe("changed");
		source = (await t.query(internal.ai_chat_context.check_sources, sourceArgs))._yay![0];
		const disabled = await user.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId, nodeId, acknowledgeDropCollaborativeHistory: true,
		});
		expect(disabled._nay).toBeUndefined();
		expect((await t.action(internal.ai_chat_context.read_source, { ...scope, nodeId, version: source.version, maxBytes: 65536 }))._nay?.name).toBe("changed");
		source = (await t.query(internal.ai_chat_context.check_sources, sourceArgs))._yay![0];
		const saved = await user.action(api.files_nodes_content.replace_file_content, { membershipId: db.membershipId, nodeId, text: "New saved text" });
		expect(saved._nay).toBeUndefined();
		expect((await t.action(internal.ai_chat_context.read_source, { ...scope, nodeId, version: source.version, maxBytes: 65536 }))._nay?.name).toBe("changed");
	});

	test.each(["version", "membership"] as const)("rechecks %s after snapshot reconstruction", async (change) => {
		const { t, scope, create } = await fixture();
		const nodeId = await create("/AGENTS.md", "SAVED\n");
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		await t.run(async (ctx) => {
			const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
			await ctx.db.patch("files_yjs_docs_last_sequences", sequence!._id, { lastSequence: sequence!.lastSequence + 1 });
		});
		const snapshot = files_nodes_create_yjs_snapshot_update_from_text({ rootKind: "rich_text", text: "SAVED\n" });
		if (snapshot._nay) throw new Error(snapshot._nay.message);
		vi.mocked(fetch).mockImplementation(async () => {
			await t.run(async (ctx) => {
				if (change === "membership")
					await ctx.db.patch("organizations_workspaces_users", scope.membershipId, { active: false });
				else {
					const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
					await ctx.db.patch("files_yjs_docs_last_sequences", sequence!._id, {
						lastSequence: sequence!.lastSequence + 1,
					});
				}
			});
			return new Response(snapshot._yay);
		});
		const source = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.instructions[0];
		const read = await t.action(internal.ai_chat_context.read_source, {
			...scope,
			nodeId,
			version: source.version,
			maxBytes: 16384,
		});
		expect(read._nay?.name).toBe(change === "membership" ? "unavailable" : "changed");
		expect(JSON.stringify(read)).not.toContain("SAVED");
	});

	test("refuses reconstruction work before downloading an oversized snapshot", async () => {
		const { t, scope, create } = await fixture();
		const nodeId = await create("/AGENTS.md", "SAVED\n");
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		await t.run(async (ctx) => {
			const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			await ctx.db.patch("files_yjs_docs_last_sequences", sequence!._id, { lastSequence: sequence!.lastSequence + 1 });
			await ctx.db.patch("files_r2_assets", snapshot!.assetId, { size: 1024 * 1024 + 1 });
		});
		vi.mocked(fetch).mockClear();
		const source = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.instructions[0];
		expect(
			(
				await t.action(internal.ai_chat_context.read_source, {
					...scope,
					nodeId,
					version: source.version,
					maxBytes: 16384,
				})
			)._nay?.name,
		).toBe("limit");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("refuses oversized instruction text without truncation", async () => {
		const { t, scope, create } = await fixture();
		const nodeId = await create("/AGENTS.md", "🐵".repeat(4097));
		const source = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.instructions[0];
		expect(source.status).toBe("too_large");
		expect(
			(
				await t.action(internal.ai_chat_context.read_source, {
					...scope,
					nodeId,
					version: source.version,
					maxBytes: 16384,
				})
			)._nay?.name,
		).toBe("too_large");
	});

	test("reads saved chunks, ignores pending text, and returns an opaque version", async () => {
		const { t, db, scope, create } = await fixture();
		const nodeId = await create("/AGENTS.md", "SAVED_GUIDANCE\n");
		await t.run(async (ctx) => {
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				fileNodeId: nodeId,
				pendingArchive: { fromPath: "/AGENTS.md" },
				size: 0,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("files_text_chunks", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sourceKind: "pending",
				userId: db.userId,
				pendingUpdateId,
				chunkIndex: 0,
				textChunk: "PENDING_GUIDANCE",
				startIndex: 0,
				endIndex: 16,
				lineStart: 1,
				lineEnd: 1,
				chunkFlags: 0,
			});
		});
		const found = await t.query(internal.ai_chat_context.discover_sources, scope);
		const source = found._yay!.instructions[0];
		expect(source.version).toMatch(/^[a-f0-9]{64}$/u);
		const read = await t.action(internal.ai_chat_context.read_source, {
			...scope,
			nodeId,
			version: source.version,
			maxBytes: 16384,
		});
		expect(read._yay?.content).toBe("SAVED_GUIDANCE\n");
	});

	test("rejects stale versions while current checks keep edited readable sources", async () => {
		const { t, scope, create } = await fixture();
		const nodeId = await create("/AGENTS.md", "SAVED\n");
		const source = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.instructions[0];
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const sequence = await ctx.db.get("files_yjs_docs_last_sequences", node!.yjsLastSequenceId!);
			await ctx.db.patch("files_yjs_docs_last_sequences", sequence!._id, {
				lineageGeneration: sequence!.lineageGeneration + 1,
			});
		});
		const current = await t.query(internal.ai_chat_context.check_sources, {
			...scope,
			sources: [{ nodeId, version: source.version }],
		});
		expect(current._yay).toHaveLength(1);
		expect(current._yay![0].version).not.toBe(source.version);
		expect(
			(
				await t.action(internal.ai_chat_context.read_source, {
					...scope,
					nodeId,
					version: source.version,
					maxBytes: 16384,
				})
			)._nay?.name,
		).toBe("changed");
	});

	test("checks access again at the read boundary", async () => {
		const { t, scope, create, member } = await fixture();
		const nodeId = await create("/AGENTS.md", "SAVED\n");
		const source = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.instructions[0];
		const second = await member(false);
		expect(
			(
				await t.action(internal.ai_chat_context.read_source, {
					...second,
					nodeId,
					version: source.version,
					maxBytes: 16384,
				})
			)._nay?.name,
		).toBe("unavailable");
	});
});

describe("get_skill_resources", () => {
	test.each(["skill", "resource"] as const)("keeps a pinned %s readable when saved chunks finish updating", async (target) => {
		const { t, scope, user, db, create } = await fixture();
		// Use the real R2 upload/read path with an in-memory bucket, like the materializer tests.
		const objects = new Map<string, BodyInit>();
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async key => ({ key: key!, url: `https://r2.test/object?key=${encodeURIComponent(key!)}` }));
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(async key => `https://r2.test/object?key=${encodeURIComponent(key)}`);
		vi.mocked(fetch).mockImplementation(async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key")!;
			if (init?.method === "PUT") { objects.set(key, init.body ?? ""); return new Response(null); }
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		});
		const skillId = await create("/.agents/skills/example/SKILL.md", target === "skill" ? "" : skillText);
		const nodeId = target === "skill" ? skillId : await create("/.agents/skills/example/scripts/run.js", "");
		const rootKind = target === "skill" ? "rich_text" : "plain_text";
		const text = target === "skill" ? skillText.replace("PRIVATE_SKILL_BODY", "SAVED_EDIT") : 'return "SAVED_EDIT";';
		const yjsDoc = files_yjs_doc_create_from_text({ rootKind, text });
		if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		const pushed = await user.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId, nodeId, expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)), sessionId: "saved-source",
		});
		if (pushed._nay) throw new Error(pushed._nay.message);
		const skill = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.skills[0];
		const manifest = await t.query(internal.ai_chat_context.get_skill_resources, { ...scope, skillId, version: skill.version });
		const pinned = target === "skill" ? skill : manifest._yay![0];
		expect(pinned.status).toBe("updating");
		const readArgs = { ...scope, nodeId, version: pinned.version, maxBytes: 65536 };
		const before = await t.action(internal.ai_chat_context.read_source, readArgs);
		expect(before._yay?.content).toContain("SAVED_EDIT");
		const oldNode = await t.run(ctx => ctx.db.get("files_nodes", nodeId));
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId, nodeId,
			targetSequence: pushed._yay.newSequence,
		});
		expect(materialized._nay).toBeUndefined();
		const newNode = await t.run(ctx => ctx.db.get("files_nodes", nodeId));
		expect(newNode?.assetId).not.toBe(oldNode?.assetId);
		expect(newNode?.yjsLastSequenceId).toBe(oldNode?.yjsLastSequenceId);
		const catalog = await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId });
		expect(catalog?.skills[0].status).toBe("available");
		const after = await t.action(internal.ai_chat_context.read_source, readArgs);
		expect(after._nay).toBeUndefined();
		expect(after._yay?.content).toBe(before._yay?.content);
		expect((await t.query(internal.ai_chat_context.get_skill_resources, { ...scope, skillId, version: skill.version }))._nay).toBeUndefined();
		// A later user edit is a new saved version and must still reject the old pin.
		const changed = files_yjs_doc_update_from_text({ rootKind, mut_yjsDoc: yjsDoc, text: `${text}\nLATER_EDIT` });
		if (changed._nay) throw new Error(changed._nay.message);
		const later = await user.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId, nodeId, expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)), sessionId: "later-source",
		});
		yjsDoc.destroy();
		expect(later._nay).toBeUndefined();
		expect((await t.action(internal.ai_chat_context.read_source, readArgs))._nay?.name).toBe("changed");
	});

	test("refuses a partial manifest above 200 readable files", async () => {
		const { t, scope, create } = await fixture();
		const skillId = await create("/.agents/skills/example/SKILL.md", skillText);
		for (let index = 0; index < 201; index++)
			await create(`/.agents/skills/example/references/file-${index}.txt`, "Text\n");
		const skill = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.skills[0];
		const resources = await t.query(internal.ai_chat_context.get_skill_resources, {
			...scope,
			skillId,
			version: skill.version,
		});
		expect(resources._nay?.name).toBe("limit");
		expect(resources._yay).toBeUndefined();
	});

	test("lists only saved files inside the exact bundle", async () => {
		const { t, scope, create } = await fixture();
		const skillId = await create("/.agents/skills/example/SKILL.md", skillText);
		const resourceId = await create("/.agents/skills/example/references/help.txt", "Resource\n");
		await create("/.agents/skills/example-other/references/help.txt", "Sibling\n");
		const skill = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.skills[0];
		const resources = await t.query(internal.ai_chat_context.get_skill_resources, {
			...scope,
			skillId,
			version: skill.version,
		});
		expect(resources._yay?.map((resource) => resource.nodeId)).toEqual([resourceId]);
	});

	test("rechecks the skill's saved location", async () => {
		const { t, scope, create } = await fixture();
		const skillId = await create("/.agents/skills/example/SKILL.md", skillText);
		const skill = (await t.query(internal.ai_chat_context.discover_sources, scope))._yay!.skills[0];
		await t.run((ctx) =>
			ctx.db.patch("files_nodes", skillId, { name: "other.md", path: "/other.md", treePath: "/other.md" }),
		);
		expect(
			(await t.query(internal.ai_chat_context.get_skill_resources, { ...scope, skillId, version: skill.version }))._nay
				?.name,
		).toBe("unavailable");
	});
});
