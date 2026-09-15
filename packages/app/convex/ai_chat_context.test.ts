import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { ai_chat_context_create, ai_chat_context_read_instructions } from "../server/ai-chat-context.ts";
import { files_agent_write_file_text } from "../server/bash-utils.ts";
import { files_ROOT_ID } from "../shared/files.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_context_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	const objects = new Map<string, BodyInit>();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key!,
		url: `https://r2.test/object?key=${encodeURIComponent(key!)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key")!;
			if (init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null);
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { membershipId: db.membershipId, userId: db.userId };
	async function create(path: string, textContent: string) {
		return await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path,
			textContent,
		});
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

	async function move(
		nodeId: Id<"files_nodes">,
		destParentId: Id<"files_nodes"> | typeof files_ROOT_ID,
		destName: string,
	) {
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: nodeId },
			destName,
			destParent: destParentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: destParentId },
		});
		if (moved._nay) throw new Error(moved._nay.message);
	}

	async function system() {
		return await t.action(async (ctx) => {
			const result = await ai_chat_context_create(ctx, scope);
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.system;
		});
	}
	return { t, db, scope, create, member, move, system };
}

const skillText = "---\nname: example\ndescription: Saved description\n---\nSKILL_BODY\n";

describe("discover_sources", () => {
	test("discovers exact skill paths without scanning nested instructions or resources", async () => {
		const f = await fixture();
		await f.create("/.agents/skills/example/SKILL.md", skillText);
		await f.create("/elsewhere/SKILL.md", skillText);
		await f.create("/.agents/skills/example/references/details.md", "RESOURCE_BODY");
		await f.create("/invoices/AGENTS.md", "SIBLING_BODY");
		expect((await f.t.query(internal.ai_chat_context.discover_sources, f.scope))._yay?.skills).toEqual([
			"/.agents/skills/example/SKILL.md",
		]);
		expect(await f.system()).toContain("Saved description");
		expect(await f.system()).not.toMatch(/SKILL_BODY|RESOURCE_BODY|SIBLING_BODY/u);
	});

	test("finds an ordinary file renamed to SKILL.md before save", async () => {
		const f = await fixture();
		const nodeId = await f.create("/.agents/skills/example/draft.md", skillText);
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		await f.move(nodeId, node!.parentId, "SKILL.md");
		expect((await f.t.query(internal.ai_chat_context.discover_sources, f.scope))._yay?.skills).toEqual([
			"/.agents/skills/example/SKILL.md",
		]);
		expect(await f.system()).toContain("Saved description");
	});

	test("projects skills when their parent folder moves into the catalog", async () => {
		const f = await fixture();
		const nodeId = await f.create("/outside/example/SKILL.md", skillText);
		const anchor = await f.create("/.agents/skills/anchor.txt", "anchor");
		const [node, root] = await f.t.run(async (ctx) =>
			Promise.all([ctx.db.get("files_nodes", nodeId), ctx.db.get("files_nodes", anchor)]),
		);
		await f.move(node!.parentId as Id<"files_nodes">, root!.parentId, "example");
		expect((await f.t.query(internal.ai_chat_context.discover_sources, f.scope))._yay?.skills).toEqual([
			"/.agents/skills/example/SKILL.md",
		]);
		expect(await f.system()).toContain("Saved description");
	});

	test("hides pending deletes and does not apply another user's pending move", async () => {
		const f = await fixture();
		const nodeId = await f.create("/.agents/skills/example/SKILL.md", skillText);
		await f.move(nodeId, files_ROOT_ID, "other.md");
		expect((await f.t.query(internal.ai_chat_context.discover_sources, f.scope))._yay?.skills).toEqual([]);
		const second = await f.member(true);
		expect((await f.t.query(internal.ai_chat_context.discover_sources, second))._yay?.skills).toEqual([
			"/.agents/skills/example/SKILL.md",
		]);
		await f.t.run(async (ctx) => {
			const pending = await ctx.db.query("files_pending_updates").first();
			await ctx.db.patch("files_pending_updates", pending!._id, {
				pendingMove: undefined,
				pendingArchive: { fromPath: "/.agents/skills/example/SKILL.md" },
			});
		});
		expect((await f.t.query(internal.ai_chat_context.discover_sources, f.scope))._yay?.skills).toEqual([]);
	});

	test("refuses other memberships and content.read denial", async () => {
		const f = await fixture();
		const second = await f.member(false);
		expect((await f.t.query(internal.ai_chat_context.discover_sources, second))._nay?.name).toBe("unavailable");
		expect(
			(await f.t.query(internal.ai_chat_context.discover_sources, { ...f.scope, userId: second.userId }))._nay?.name,
		).toBe("unavailable");
	});

	test("filters restricted file paths before exposing names or invalid-source warnings", async () => {
		const f = await fixture();
		const secret = await f.create("/.agents/skills/secret/SKILL.md", "PRIVATE_INVALID");
		await f.create("/.agents/skills/example/SKILL.md", skillText);
		await f.t.run((ctx) => ctx.db.patch("files_nodes", secret, { restrictedScopeNodeId: secret }));
		const second = await f.member(true);
		const found = await f.t.query(internal.ai_chat_context.discover_sources, second);
		expect(found._yay?.skills).toEqual(["/.agents/skills/example/SKILL.md"]);
		expect(JSON.stringify(found)).not.toContain("secret");
	});

	test("reports a bounded catalog when more than 100 readable skills exist", async () => {
		// Saving 101 fixture files through the full publish flow needs more time during the full suite.
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: true, retryAfter: 0 });
		const f = await fixture();
		for (let index = 0; index < 101; index++) {
			await f.create(`/.agents/skills/skill-${index}/SKILL.md`, `---\nname: skill-${index}\ndescription: Skill\n---\n`);
		}
		const found = await f.t.query(internal.ai_chat_context.discover_sources, f.scope);
		expect(found._yay?.skills).toHaveLength(100);
		expect(found._yay?.warning).toContain("incomplete");
	}, 120_000);
});

describe("ai_chat_context_create", () => {
	test("uses pending skill text through the same reader as normal files", async () => {
		const f = await fixture();
		const nodeId = await f.create("/.agents/skills/example/SKILL.md", skillText);
		const written = await f.t.action((ctx) =>
			files_agent_write_file_text(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				target: { kind: "saved", id: nodeId },
				unstagedText: skillText.replace("Saved description", "Pending description"),
			}),
		);
		expect(written._nay).toBeUndefined();
		expect(await f.system()).toContain("Pending description");
		expect(await f.system()).not.toContain("Saved description");
	});

	test("includes private skills and root rules before their first save", async () => {
		const f = await fixture();
		for (const [path, unstagedText] of [
			["/.agents/skills/example/SKILL.md", skillText],
			["/AGENTS.md", "PRIVATE_ROOT_RULE"],
		]) {
			const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				path: path!,
				kind: "file",
			});
			if (created._nay || !created._yay.operationBatchId) throw new Error("Expected a private file batch");
			const written = await f.t.action((ctx) =>
				files_agent_write_file_text(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					target: created._yay.target,
					operationBatchId: created._yay.operationBatchId!,
					unstagedText: unstagedText!,
				}),
			);
			expect(written._nay).toBeUndefined();
		}
		const system = await f.system();
		expect(system).toContain("Saved description");
		expect(system).toContain("PRIVATE_ROOT_RULE");
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test("loads pending root instructions and only current visible ancestors", async () => {
		const f = await fixture();
		const rootId = await f.create("/AGENTS.md", "SAVED_ROOT\n");
		const nestedId = await f.create("/old/AGENTS.md", "NESTED_RULE\n");
		await f.create("/invoices/AGENTS.md", "SIBLING_RULE\n");
		const written = await f.t.action((ctx) =>
			files_agent_write_file_text(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				target: { kind: "saved", id: rootId },
				unstagedText: "PENDING_ROOT\n",
			}),
		);
		expect(written._nay).toBeUndefined();
		const nested = await f.t.run((ctx) => ctx.db.get("files_nodes", nestedId));
		await f.move(nested!.parentId as Id<"files_nodes">, files_ROOT_ID, "new");
		const result = await f.t.action(async (ctx) => {
			const created = await ai_chat_context_create(ctx, f.scope);
			if (created._nay) throw new Error(created._nay.message);
			return {
				system: created._yay.system,
				old: await ai_chat_context_read_instructions(ctx, created._yay.context, ["/old/file.md"]),
				current: await ai_chat_context_read_instructions(ctx, created._yay.context, ["/new/file.md"]),
			};
		});
		expect(result.system).toContain("PENDING_ROOT");
		expect(result.system).not.toMatch(/SAVED_ROOT|NESTED_RULE|SIBLING_RULE/u);
		expect(result.old).toBe("");
		expect(result.current).toContain("NESTED_RULE");
		expect(result.current).toContain("/new/AGENTS.md");
		expect(result.current).not.toContain("SIBLING_RULE");
	});
});
