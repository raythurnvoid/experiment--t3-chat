import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
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

async function fixture(personal = false) {
	const t = test_convex();
	const db = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(
			ctx,
			personal ? { organizationName: "personal", workspaceName: "home" } : undefined,
		),
	);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "context-write",
		lastMessageAt: Date.now(),
	});
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		membershipId: db.membershipId,
		userId: db.userId,
	});
	if (thread._nay || captured._nay) throw new Error("Expected source chat");
	const workspaces = captured._yay;
	const agentSource = { ...db, threadId: thread._yay.threadId, membershipLifetime: workspaces.membershipLifetime };
	const scope = { source: agentSource };
	async function create(path: string, textContent: string, workspace: "current" | "personal" = "current") {
		return await test_create_saved_text_file(t, {
			membershipId: workspaces[workspace].membershipId,
			path,
			textContent,
		});
	}

	async function member(read: boolean) {
		const { userId } = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		expect(
			await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userIdToAdd: userId,
			}),
		).toEqual({ _yay: null });
		const other = await t.run(async (ctx) => {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("userId", userId).eq("active", true),
				)
				.first();
			return { userId, membershipId: membership!._id };
		});
		const created = await t
			.withIdentity({ issuer: "https://clerk.test", external_id: other.userId })
			.mutation(api.ai_chat.thread_create, {
				membershipId: other.membershipId,
				clientGeneratedId: "member-context",
				lastMessageAt: Date.now(),
			});
		const capturedOther = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: other.userId,
			membershipId: other.membershipId,
		});
		if (created._nay || capturedOther._nay) throw new Error("Expected member chat");
		if (!read)
			await t.run(async (ctx) => {
				const assignments = await ctx.db.query("access_control_role_assignments").collect();
				for (const assignment of assignments) {
					if (assignment.userId === other.userId && assignment.organizationId === db.organizationId)
						await ctx.db.delete("access_control_role_assignments", assignment._id);
				}
			});
		return {
			source: {
				...agentSource,
				userId: other.userId,
				membershipId: other.membershipId,
				threadId: created._yay.threadId,
				membershipLifetime: capturedOther._yay.membershipLifetime,
			},
		};
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
	return { t, db, scope, agentSource, create, member, move, system, asUser, captured: workspaces };
}

const skillText = "---\nname: example\ndescription: Saved description\n---\nSKILL_BODY\n";

describe("discover_sources", () => {
	test("discovers both roots but no third workspace or another user's home", async () => {
		const f = await fixture();
		await f.create("/.agents/skills/example/SKILL.md", skillText);
		await f.create(
			"/.agents/skills/example/SKILL.md",
			skillText.replace("Saved description", "Home description"),
			"personal",
		);
		const third = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { userId: f.db.userId, organizationName: "third-team" }),
		);
		const other = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		for (const membershipId of [third.membershipId, other.membershipId])
			await test_create_saved_text_file(f.t, {
				membershipId,
				path: "/.agents/skills/secret/SKILL.md",
				textContent: "PRIVATE_OTHER_WORKSPACE",
			});
		const found = await f.t.query(internal.ai_chat_context.discover_sources, f.scope);
		expect(found._yay?.workspaces.map((root) => root.workspaceId)).toEqual([
			f.db.workspaceId,
			f.captured.personal.workspaceId,
		]);
		expect(found._yay?.skills).toEqual([
			{ workspace: "current", path: "/.agents/skills/example/SKILL.md" },
			{ workspace: "personal", path: "/.agents/skills/example/SKILL.md" },
		]);
		const system = await f.system();
		expect(system).toContain("Saved description");
		expect(system).toContain("Home description");
		expect(system).not.toMatch(/secret|PRIVATE_OTHER_WORKSPACE/u);
	});

	test("scans personal home once when it is also current", async () => {
		const f = await fixture(true);
		await f.create("/.agents/skills/example/SKILL.md", skillText);
		await f.create("/AGENTS.md", "ONE_HOME_RULE");
		const found = await f.t.query(internal.ai_chat_context.discover_sources, f.scope);
		expect(found._yay?.workspaces).toHaveLength(1);
		expect(found._yay?.skills).toEqual([{ workspace: "current", path: "/.agents/skills/example/SKILL.md" }]);
		expect((await f.system()).match(/ONE_HOME_RULE/gu)).toHaveLength(1);
	});

	test("refuses old source access to home after removal and re-invitation", async () => {
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: true, retryAfter: 0 });
		const f = await fixture();
		const other = await f.member(true);
		const home = await f.t.query(internal.ai_chat_workspaces.resolve, { ...other, workspace: "personal" });
		if (home._nay) throw new Error(home._nay.message);
		await test_create_saved_text_file(f.t, {
			membershipId: home._yay.membershipId,
			path: "/.agents/skills/example/SKILL.md",
			textContent: skillText,
		});
		expect((await f.t.query(internal.ai_chat_context.discover_sources, other))._yay?.skills).toContainEqual({
			workspace: "personal",
			path: "/.agents/skills/example/SKILL.md",
		});
		expect(
			await f.asUser.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.db.organizationId,
				userIdToRemove: other.source.userId,
			}),
		).toEqual({ _yay: null });
		expect((await f.t.query(internal.ai_chat_context.discover_sources, other))._nay?.name).toBe("unavailable");
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: other.source.userId,
			}),
		).toEqual({ _yay: null });
		expect((await f.t.query(internal.ai_chat_context.discover_sources, other))._nay?.name).toBe("unavailable");
	});

	test("uses one twenty-page scan budget across both roots", async () => {
		const f = await fixture();
		for (const workspace of ["current", "personal"] as const) {
			const nodeId = await f.create("/.agents/skills/example/noise-0000.md", "Not a skill", workspace);
			// Clone a valid file header: discovery reads paths, not these noise files' content.
			await f.t.run(async (ctx) => {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				const { _id, _creationTime, ...fields } = node;
				for (let index = 1; index < 550; index++) {
					const name = `noise-${String(index).padStart(4, "0")}.md`;
					const path = `/.agents/skills/example/${name}`;
					await ctx.db.insert("files_nodes", { ...fields, name, path, treePath: path });
				}
			});
			await f.create("/.agents/skills/z-late/SKILL.md", "---\nname: z-late\ndescription: Late\n---\n", workspace);
		}
		const found = await f.t.query(internal.ai_chat_context.discover_sources, f.scope);
		expect(found._yay?.skills).toEqual([]);
		expect(found._yay?.warning).toContain("incomplete");
	}, 120_000);

	test("discovers exact skill paths without scanning nested instructions or resources", async () => {
		const f = await fixture();
		await f.create("/.agents/skills/example/SKILL.md", skillText);
		await f.create("/elsewhere/SKILL.md", skillText);
		await f.create("/.agents/skills/example/references/details.md", "RESOURCE_BODY");
		await f.create("/invoices/AGENTS.md", "SIBLING_BODY");
		expect((await f.t.query(internal.ai_chat_context.discover_sources, f.scope))._yay?.skills).toEqual([
			{ workspace: "current", path: "/.agents/skills/example/SKILL.md" },
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
			{ workspace: "current", path: "/.agents/skills/example/SKILL.md" },
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
			{ workspace: "current", path: "/.agents/skills/example/SKILL.md" },
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
			{ workspace: "current", path: "/.agents/skills/example/SKILL.md" },
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
			(
				await f.t.query(internal.ai_chat_context.discover_sources, {
					source: { ...f.agentSource, userId: second.source.userId },
				})
			)._nay?.name,
		).toBe("unavailable");
	});

	test("does not let an organization owner use another person's chat as the source", async () => {
		const f = await fixture();
		await f.create("/.agents/skills/example/SKILL.md", skillText, "personal");
		const other = await f.member(true);
		expect((await f.t.query(internal.ai_chat_context.discover_sources, f.scope))._yay?.skills).toHaveLength(1);
		const found = await f.t.query(internal.ai_chat_context.discover_sources, {
			source: { ...f.agentSource, threadId: other.source.threadId },
		});
		expect(found._nay?.name).toBe("unavailable");
		expect(found._yay).toBeUndefined();
	});

	test("filters restricted file paths before exposing names or invalid-source warnings", async () => {
		const f = await fixture();
		const secret = await f.create("/.agents/skills/secret/SKILL.md", "PRIVATE_INVALID");
		await f.create("/.agents/skills/example/SKILL.md", skillText);
		await f.t.run((ctx) => ctx.db.patch("files_nodes", secret, { restrictedScopeNodeId: secret }));
		const second = await f.member(true);
		const found = await f.t.query(internal.ai_chat_context.discover_sources, second);
		expect(found._yay?.skills).toEqual([{ workspace: "current", path: "/.agents/skills/example/SKILL.md" }]);
		expect(JSON.stringify(found)).not.toContain("secret");
	});

	test("reports one bounded catalog when more than 100 readable skills exist across both roots", async () => {
		// Saving 101 fixture files through the full publish flow needs more time during the full suite.
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: true, retryAfter: 0 });
		const f = await fixture();
		for (let index = 0; index < 101; index++) {
			await f.create(
				`/.agents/skills/skill-${index}/SKILL.md`,
				`---\nname: skill-${index}\ndescription: Skill\n---\n`,
				index < 60 ? "current" : "personal",
			);
		}
		const found = await f.t.query(internal.ai_chat_context.discover_sources, f.scope);
		expect(found._yay?.skills).toHaveLength(100);
		expect(found._yay?.skills.some((skill) => skill.workspace === "personal")).toBe(true);
		expect(found._yay?.skills.some((skill) => skill.workspace === "current")).toBe(true);
		expect(found._yay?.warning).toContain("incomplete");
	}, 120_000);
});

describe("ai_chat_context_create", () => {
	test("uses pending skill text through the same reader as normal files", async () => {
		const f = await fixture();
		const nodeId = await f.create("/.agents/skills/example/SKILL.md", skillText);
		const written = await f.t.action((ctx) =>
			files_agent_write_file_text(ctx, {
				agentSource: f.agentSource,
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
				agentSource: f.agentSource,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				path: path!,
				kind: "file",
			});
			if (created._nay || !created._yay.operationBatchId) throw new Error("Expected a private file batch");
			const written = await f.t.action((ctx) =>
				files_agent_write_file_text(ctx, {
					agentSource: f.agentSource,
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
				agentSource: f.agentSource,
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
				old: await ai_chat_context_read_instructions(ctx, created._yay.context, [
					{ workspace: "current", path: "/old/file.md" },
				]),
				current: await ai_chat_context_read_instructions(ctx, created._yay.context, [
					{ workspace: "current", path: "/new/file.md" },
				]),
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
