import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { getFunctionName } from "convex/server";
import { public_api_http_read_file } from "./public_api.ts";
import * as publicApiHttpAuth from "./public_api_http_auth.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_save_file_pending_update,
} from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";

const tokens = { current: "a".repeat(64), personal: "b".repeat(64) };
const objects = new Map<string, ArrayBuffer>();

beforeEach(() => {
	objects.clear();
	vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: true, retryAfter: 0 });
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_code_grants" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
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
			const key =
				url.searchParams.get("key") ?? decodeURIComponent(url.pathname.replace(/^\/test-files-bucket\//u, ""));
			if (init?.method === "PUT") {
				objects.set(key, await new Response(init.body).arrayBuffer());
				return new Response(null);
			}
			const body = objects.get(key);
			if (!body) return new Response(null, { status: 404 });
			const range = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/u);
			if (range) {
				const start = Number(range[1]);
				const end = Math.min(Number(range[2]), body.byteLength - 1);
				return new Response(body.slice(start, end + 1), {
					status: 206,
					headers: { "Content-Range": `bytes ${start}-${end}/${body.byteLength}`, ETag: '"test-etag"' },
				});
			}
			return new Response(body, { headers: { ETag: '"test-etag"' } });
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture(personal = false) {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const actor = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: actor.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q
					.eq("workspaceId", personal ? actor.workspaceId : owner.workspaceId)
					.eq("userId", actor.userId)
					.eq("active", true),
			)
			.first(),
	);
	if (!membership) throw new Error("Expected actor membership");
	const thread = await t
		.withIdentity({ issuer: "https://clerk.test", external_id: actor.userId })
		.mutation(api.ai_chat.thread_create, {
			membershipId: membership._id,
			clientGeneratedId: "code-grants",
			lastMessageAt: Date.now(),
		});
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		membershipId: membership._id,
		userId: actor.userId,
	});
	if (thread._nay || captured._nay) throw new Error("Expected source chat");
	const roots = captured._yay;
	const source = {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: actor.userId,
		membershipId: membership._id,
		threadId: thread._yay.threadId,
		membershipLifetime: roots.membershipLifetime,
	};
	const mintArgs = {
		source,
		principalKey: "code-test",
		tokenHashes: {
			current: await crypto_sha256_hex(tokens.current),
			personal: await crypto_sha256_hex(tokens.personal),
		},
	};
	const mint = () => t.mutation(internal.public_api.create_code_grants, mintArgs);
	const request = (args: { workspace: "current" | "personal"; route: string; body: Record<string, unknown> }) => {
		const { workspace, route, body } = args;

		return t.fetch(`/api/v1/files/${route}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${tokens[workspace]}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	};
	const read = (workspace: "current" | "personal", cursor?: string) =>
		request({ workspace, route: "read", body: { path: "/data.txt", ...(cursor ? { cursor } : {}) } });
	async function file(args: { workspace: "current" | "personal"; textContent?: string; stored?: boolean }) {
		const { workspace, textContent = workspace, stored = false } = args;

		const nodeId = await test_create_saved_text_file(t, {
			membershipId: roots[workspace].membershipId,
			path: "/data.txt",
			textContent,
		});
		if (stored)
			await test_run_with_flush(t, async (ctx) => {
				const node = await ctx.db.get("files_nodes", nodeId);
				await ctx.db.patch("files_nodes", nodeId, {
					textKind: null,
					collaborationEnabled: null,
					yjsSnapshotId: null,
					yjsLastSequenceId: null,
					contentType: "application/octet-stream",
				});
				const asset = await ctx.db.get("files_r2_assets", node!.assetId!);
				expect(objects.has(asset!.r2Key!)).toBe(true);
			});
		return nodeId;
	}
	async function leave(reinvite = false) {
		expect(
			await t
				.withIdentity({ issuer: "https://clerk.test", external_id: actor.userId })
				.mutation(api.organizations.remove_user_from_organization, {
					organizationId: owner.organizationId,
					userIdToRemove: actor.userId,
				}),
		).toEqual({ _yay: null });
		if (reinvite) {
			expect(
				await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					userIdToAdd: actor.userId,
				}),
			).toEqual({ _yay: null });
		}
	}
	return { t, owner, actor, asOwner, roots, source, mintArgs, mint, file, request, read, leave };
}

describe("two-root code grants", () => {
	test.each(["current", "personal"] as const)("reads saved text despite the source user's draft in %s", async (workspace) => {
		const f = await fixture();
		const nodeId = await f.file({ workspace, textContent: "saved\n" });
		await f.mint();
		const before = await f.read(workspace);
		expect(before.status).toBe(200);
		const revision = before.headers.get("X-File-Revision");
		const scope = { ...f.roots[workspace], userId: f.actor.userId };
		const batch = await f.t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			target: { kind: "saved", id: nodeId },
			expectedPendingContentVersion: (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!.pendingContentVersion,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const staged = await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "private draft\n",
		});
		if (staged._nay) throw new Error(staged._nay.message);
		const ready = await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			target: { kind: "saved", id: nodeId },
			operationBatchId: batch._yay.operationBatchId,
		});
		if (ready._nay) throw new Error(ready._nay.message);
		const single = await f.request({ workspace, route: "read", body: { path: "/data.txt" } });
		expect(single.status).toBe(200);
		expect(await single.text(), "code grants must read saved text").toBe("saved\n");
		expect(single.headers.get("X-File-Revision"), "private text must not change the saved revision").toBe(revision);
	});

	test("mints only the trusted pair with one budget and reads each root through HTTP", async () => {
		const f = await fixture();
		const third = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { userId: f.actor.userId, organizationName: "third" }),
		);
		const nodeIds = {
			current: await f.file({ workspace: "current" }),
			personal: await f.file({ workspace: "personal" }),
		};
		const before = Date.now();
		expect(await f.mint()).toEqual({ _yay: { personalIsCurrent: false } });
		const grants = await f.t.run((ctx) => ctx.db.query("public_api_grants").collect());
		const budgets = await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect());
		expect(grants).toHaveLength(2);
		expect(budgets).toHaveLength(1);
		expect(new Set(grants.map((grant) => grant.workspaceId))).toEqual(
			new Set([f.roots.current.workspaceId, f.roots.personal.workspaceId]),
		);
		expect(grants.some((grant) => grant.workspaceId === third.workspaceId)).toBe(false);
		for (const grant of grants) {
			expect(grant).toMatchObject({
				agentSource: f.source,
				codeReadBudgetId: budgets[0]!._id,
				threadId: f.source.threadId,
				remainingReadBytes: 0,
				pathPrefix: null,
				scopes: ["files:list", "files:read", "files:download"],
			});
			expect(grant.createdAt).toBeGreaterThanOrEqual(before);
			expect(grant.expiresAt - grant.createdAt).toBe(10 * 60 * 1000);
			expect(grant.expiresAt).toBe(budgets[0]!.expiresAt);
		}
		expect(budgets[0]).toMatchObject({
			userId: f.actor.userId,
			threadId: f.source.threadId,
			remainingReadBytes: 8 * 1024 * 1024,
		});
		for (const workspace of ["current", "personal"] as const) {
			const read = await f.request({ workspace, route: "read", body: { path: "/data.txt" } });
			expect(read.status).toBe(200);
			expect(await read.text()).toBe(workspace);
			const list = await f.request({ workspace, route: "list", body: { path: "/" } });
			expect(list.status).toBe(200);
			expect(await list.json()).toMatchObject({ items: [{ path: "/data.txt" }] });
			expect(
				(await f.request({ workspace, route: "download-urls", body: { fileNodeIds: [nodeIds[workspace]] } })).status,
			).toBe(403);
		}
	});

	test("says permission denied for a locked saved file and not found for a missing one", async () => {
		const f = await fixture();
		const nodeId = await f.file({ workspace: "current", textContent: "hidden content" });
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.owner.membershipId,
					nodeId,
				})
			)._nay,
		).toBeUndefined();
		await f.mint();
		const responses = [];
		for (const path of ["/data.txt", "/missing.txt"]) {
			const response = await f.request({ workspace: "current", route: "read", body: { path } });
			responses.push({ status: response.status, body: JSON.stringify(await response.json()) });
		}
		const [locked, missing] = responses;
		expect(locked?.status).toBe(403);
		expect(missing?.status).toBe(404);
		expect(locked?.body).toContain("Permission denied: /data.txt");
		expect(missing?.body).not.toContain("Permission denied");
		expect(locked?.body).not.toContain("hidden content");
	});

	test("home uses one grant and ignores the unused personal token", async () => {
		const f = await fixture(true);
		await f.file({ workspace: "current" });
		expect(await f.mint()).toEqual({ _yay: { personalIsCurrent: true } });
		expect(await f.t.run((ctx) => ctx.db.query("public_api_grants").collect())).toHaveLength(1);
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect())).toHaveLength(1);
		expect((await f.read("current")).status).toBe(200);
		expect((await f.read("personal")).status).toBe(401);
	});

	test("refuses an unavailable home without minting partial authority or repairing membership", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces_users", f.roots.personal.membershipId, { active: false }),
		);
		expect((await f.mint())._nay).toBeDefined();
		expect(await f.t.run((ctx) => ctx.db.query("public_api_grants").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect())).toEqual([]);
		expect(
			(await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.roots.personal.membershipId)))?.active,
		).toBe(false);
	});

	test.each(["creator", "lifetime", "workspace"])("rejects a changed source %s before minting", async (change) => {
		const f = await fixture();
		const source =
			change === "creator"
				? { ...f.source, userId: f.owner.userId, membershipId: f.owner.membershipId }
				: change === "lifetime"
					? { ...f.source, membershipLifetime: f.source.membershipLifetime + 1 }
					: { ...f.source, organizationId: f.actor.organizationId, workspaceId: f.actor.workspaceId };
		expect(
			(
				await f.t.mutation(internal.public_api.create_code_grants, {
					...f.mintArgs,
					source,
				})
			)._nay,
		).toBeDefined();
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect())).toEqual([]);
	});

	test("old home authority stays revoked after source removal and re-invitation", async () => {
		const f = await fixture();
		await f.file({ workspace: "personal", textContent: "abcdef" });
		await f.mint();
		expect((await f.read("personal")).status).toBe(200);
		expect(
			await f.asOwner.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userIdToRemove: f.actor.userId,
			}),
		).toEqual({ _yay: null });
		for (const route of ["read", "list"]) {
			expect(
				(
					await f.request({
						workspace: "personal",
						route,
						body: { path: "/data.txt" },
					})
				).status,
			).toBe(401);
		}
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userIdToAdd: f.actor.userId,
			}),
		).toEqual({ _yay: null });
		expect((await f.read("personal")).status).toBe(401);
		expect(
			await f.t.mutation(internal.public_api.reserve_grant_read_bytes, { presented: tokens.personal, length: 1 }),
		).toBe(false);
		const budget = await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").first());
		expect(budget?.remainingReadBytes).toBe(8 * 1024 * 1024 - 6);
		expect((await f.mint())._nay).toBeDefined();
	});

	test("reservation itself rechecks source authority before spending bytes", async () => {
		const f = await fixture();
		await f.mint();
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.source.membershipId, { active: false }));
		for (const presented of Object.values(tokens)) {
			expect(await f.t.mutation(internal.public_api.reserve_grant_read_bytes, { presented, length: 1 })).toBe(false);
		}
		expect((await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").first()))?.remainingReadBytes).toBe(
			8 * 1024 * 1024,
		);
	});

	test("both roots atomically share eight range reservations under concurrent HTTP reads", async () => {
		const f = await fixture();
		for (const workspace of ["current", "personal"] as const) {
			const nodeId = await f.file({ workspace, stored: true });
			await f.t.run(async (ctx) => {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				const asset = (await ctx.db.get("files_r2_assets", node.assetId!))!;
				objects.set(asset.r2Key!, new ArrayBuffer(1024 * 1024));
				await ctx.db.patch("files_r2_assets", asset._id, { size: 1024 * 1024 });
			});
		}
		await f.mint();
		const reads = await Promise.all(
			Array.from({ length: 9 }, (_, index) => f.read(index % 2 ? "personal" : "current")),
		);
		expect(reads.filter((response) => response.status === 200)).toHaveLength(8);
		expect(reads.filter((response) => response.status === 429)).toHaveLength(1);
		expect((await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").first()))?.remainingReadBytes).toBe(0);
	});

	test("failed range fetches keep their shared charge", async () => {
		const f = await fixture();
		await f.file({ workspace: "personal", textContent: "abcdef", stored: true });
		await f.mint();
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));
		expect((await f.read("personal")).status).toBe(502);
		expect((await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").first()))?.remainingReadBytes).toBe(
			8 * 1024 * 1024 - 6,
		);
	});

	test("rechecks the source after an in-flight byte read", async () => {
		const f = await fixture();
		await f.file({ workspace: "personal", textContent: "abcdef", stored: true });
		await f.mint();
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const fetchRange = vi.mocked(fetch).getMockImplementation()!;
		vi.mocked(fetch).mockImplementationOnce(async (...args) => {
			started.resolve();
			await released.promise;
			return fetchRange(...args);
		});
		const response = f.read("personal");
		await started.promise;
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.source.membershipId, { active: false }));
		released.resolve();
		const result = await response;
		expect(result.status).toBe(404);
		expect(await result.text()).not.toContain("abcdef");
		expect((await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").first()))?.remainingReadBytes).toBe(
			8 * 1024 * 1024 - 6,
		);
	});

	test("rechecks source at the text read response boundary", async () => {
		const f = await fixture();
		await f.file({ workspace: "personal", textContent: "abcdef" });
		await f.mint();
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const response = f.t.action(async (ctx) => {
			let sourceReads = 0;
			const runQuery: typeof ctx.runQuery = async (ref, args) => {
				const result = await ctx.runQuery(ref, args);
				if (getFunctionName(ref) === "files_nodes_content:get_saved_file_read_source" && ++sourceReads === 2) {
					started.resolve();
					await released.promise;
				}
				return result;
			};
			const request = new Request("https://app.test/api/v1/files/read", {
				method: "POST",
				headers: { Authorization: `Bearer ${tokens.personal}`, "Content-Type": "application/json" },
				body: JSON.stringify({ path: "/data.txt" }),
			});
			return await public_api_http_read_file({ ctx: { ...ctx, runQuery }, request, path: "/api/v1/files/read" });
		});
		await started.promise;
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.source.membershipId, { active: false }));
		released.resolve();
		const result = await response;
		expect(result.status).toBe(404);
		expect(JSON.stringify(result.body)).not.toContain("abcdef");
	});

	test.each(["keep", "leave", "reinvite", "expire", "archive"] as const)(
		"list checks source after its page and asset reads: %s",
		async (change) => {
			const f = await fixture();
			const nodeId = await f.file({ workspace: "personal", textContent: "private contents" });
			await f.mint();
			const started = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const settle = publicApiHttpAuth.public_api_settle_plugin_call_best_effort;
			// This point follows both the real list query and its asset-readiness query.
			vi.spyOn(publicApiHttpAuth, "public_api_settle_plugin_call_best_effort").mockImplementationOnce(
				async (ctx, args) => {
					await settle(ctx, args);
					started.resolve();
					await released.promise;
				},
			);
			const response = f.request({ workspace: "personal", route: "list", body: { path: "/" } });
			await started.promise;
			try {
				if (change === "leave" || change === "reinvite") await f.leave(change === "reinvite");
				if (change === "expire") {
					const grant = await f.t.run((ctx) =>
						ctx.db
							.query("public_api_grants")
							.withIndex("by_tokenHash", (q) => q.eq("tokenHash", f.mintArgs.tokenHashes.personal))
							.first(),
					);
					vi.spyOn(Date, "now").mockReturnValue(grant!.expiresAt);
				}
				if (change === "archive")
					await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.source.threadId, { archived: true }));
			} finally {
				released.resolve();
			}
			const result = await response;
			if (change === "keep") {
				expect(result.status).toBe(200);
				expect(await result.json()).toMatchObject({
					items: [{ nodeId, path: "/data.txt", status: "ready" }],
					isDone: true,
				});
			} else {
				expect(result.status, "list must reject changed code-source authority after settlement").toBe(404);
				expect(await result.json(), "lost code source must release no file details").toEqual({
					message: "File unavailable",
				});
			}
		},
	);

	test("list rechecks the source before it refuses a folder", async () => {
		const f = await fixture();
		await f.file({ workspace: "personal" });
		await f.mint();
		const list = async (path: string) => {
			const response = await f.request({ workspace: "personal", route: "list", body: { path } });
			return [response.status, await response.json()];
		};
		expect(await list("/data.txt")).toEqual([400, { message: "Path must point to a folder: /data.txt" }]);

		// The auth step calls this function inside its own module, so the spy sees only the route's recheck.
		const resolve = publicApiHttpAuth.public_api_resolve_live_principal;
		const recheck = vi
			.spyOn(publicApiHttpAuth, "public_api_resolve_live_principal")
			.mockImplementation(async (ctx, args) => {
				await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.source.threadId, { archived: true }));
				return resolve(ctx, args);
			});
		expect(await list("/data.txt"), "a lost source must not learn that the path is a file").toEqual([
			404,
			{ message: "File unavailable" },
		]);
		expect(recheck).toHaveBeenCalledTimes(1);
	});

	test("list answers 404 for a folder that is only the source user's draft", async () => {
		const f = await fixture();
		await f.mint();
		const list = async () => {
			const response = await f.request({ workspace: "personal", route: "list", body: { path: "/drafts" } });
			return [response.status, await response.json()];
		};
		const draft = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: f.roots.personal.organizationId,
			workspaceId: f.roots.personal.workspaceId,
			userId: f.actor.userId,
			agentSource: f.source,
			threadId: f.source.threadId,
			path: "/drafts",
			kind: "folder",
		});
		if (draft._nay || !draft._yay.pendingUpdateId) throw new Error("Expected a folder draft");
		expect(await list(), "the folder lookup reads saved files only").toEqual([
			404,
			{ message: "Folder not found: /drafts" },
		]);

		const saved = await test_save_file_pending_update(
			f.t.withIdentity({ issuer: "https://clerk.test", external_id: f.actor.userId }),
			{
				membershipId: f.roots.personal.membershipId,
				target: draft._yay.target,
				pendingUpdateId: draft._yay.pendingUpdateId,
				reviewedRevision: 1,
			},
		);
		expect(saved._nay).toBeUndefined();
		expect(await list()).toEqual([200, expect.objectContaining({ items: [], isDone: true })]);
	});

	test("read suppresses missing-file results after source re-invitation", async () => {
		const f = await fixture();
		await f.mint();
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const response = f.t.action(async (ctx) => {
			const runQuery: typeof ctx.runQuery = async (ref, args) => {
				const result = await ctx.runQuery(ref, args);
				if (getFunctionName(ref) === "files_nodes_content:get_saved_file_read_source") {
					started.resolve();
					await released.promise;
				}
				return result;
			};
			const request = new Request("https://app.test/api/v1/files/read", {
				method: "POST",
				headers: { Authorization: `Bearer ${tokens.personal}`, "Content-Type": "application/json" },
				body: JSON.stringify({ path: "/missing.txt" }),
			});
			return await public_api_http_read_file({ ctx: { ...ctx, runQuery }, request, path: "/api/v1/files/read" });
		});
		await started.promise;
		try {
			await f.leave(true);
		} finally {
			released.resolve();
		}
		expect(await response).toMatchObject({ status: 404, body: { message: "File unavailable" } });
	});

	test.each(["revision", "final-query"] as const)(
		"byte reads suppress %s results after source re-invitation",
		async (phase) => {
			const f = await fixture();
			const nodeId = await f.file({ workspace: "personal", textContent: "abcdef", stored: true });
			await f.mint();
			let cursor: string | undefined;
			if (phase === "revision") {
				const asset = await f.t.run(async (ctx) => {
					const node = (await ctx.db.get("files_nodes", nodeId))!;
					const asset = (await ctx.db.get("files_r2_assets", node.assetId!))!;
					objects.set(asset.r2Key!, new ArrayBuffer(1024 * 1024 + 6));
					await ctx.db.patch("files_r2_assets", asset._id, { size: 1024 * 1024 + 6 });
					return asset;
				});
				const first = await f.read("personal");
				expect(first.status).toBe(200);
				cursor = first.headers.get("X-File-Next-Cursor")!;
				expect(cursor).toBeTruthy();
				await f.t.run((ctx) => ctx.db.patch("files_r2_assets", asset._id, { size: 1024 * 1024 + 7 }));
			}
			const started = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const response = f.t.action(async (ctx) => {
				let sourceReads = 0;
				const runQuery: typeof ctx.runQuery = async (ref, args) => {
					const result = await ctx.runQuery(ref, args);
					if (
						getFunctionName(ref) === "files_nodes_content:get_saved_file_read_source" &&
						++sourceReads === (phase === "revision" ? 1 : 2)
					) {
						started.resolve();
						await released.promise;
					}
					return result;
				};
				const result = await public_api_http_read_file({
					ctx: { ...ctx, runQuery },
					request: new Request("https://app.test/api/v1/files/read", {
						method: "POST",
						headers: { Authorization: `Bearer ${tokens.personal}`, "Content-Type": "application/json" },
						body: JSON.stringify({
							path: "/data.txt",
							...(cursor ? { cursor } : {}),
						}),
					}),
					path: "/api/v1/files/read",
				});
				return { ...result, body: result.status === 200 ? new TextDecoder().decode(result.body) : result.body };
			});
			await started.promise;
			try {
				await f.leave(true);
			} finally {
				released.resolve();
			}
			expect(await response).toMatchObject({ status: 404, body: { message: "File unavailable" } });
		},
	);

	test.each(["invalid-range", "redirect", "throw"] as const)(
		"byte reads hide %s storage errors after source re-invitation",
		async (failure) => {
			const f = await fixture();
			await f.file({ workspace: "personal", textContent: "abcdef", stored: true });
			await f.mint();
			const started = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			vi.mocked(fetch).mockImplementationOnce(async () => {
				started.resolve();
				await released.promise;
				if (failure === "throw") throw new Error("Storage failed");
				if (failure === "redirect")
					return new Response(null, { status: 302, headers: { Location: "https://r2.test/private" } });
				return new Response("abcdef", { status: 206, headers: { "Content-Range": "bytes 0-1/6" } });
			});
			const response = f.read("personal");
			await started.promise;
			try {
				await f.leave(true);
			} finally {
				released.resolve();
			}
			const result = await response;
			expect(result.status).toBe(404);
			expect(result.headers.get("Location")).toBeNull();
			expect(await result.json()).toEqual({ message: "File unavailable", errorCode: "not_found" });
		},
	);

	test("code grants cannot get signed URLs or service replay responses", async () => {
		const f = await fixture();
		const nodeId = await f.file({ workspace: "personal", textContent: "abcdef", stored: true });
		await f.mint();
		const getUrl = vi.spyOn(R2.prototype, "getUrl");
		getUrl.mockClear();
		const requests = [
			{ route: "download-urls", body: { fileNodeIds: [nodeId] } },
			{ route: "service-uploads/remint", body: { idempotencyKey: "previous", targetKey: "previous" } },
			{ route: "service-uploads/finalize", body: { idempotencyKey: "previous", targetKey: "previous" } },
		];
		for (const { route, body } of requests) {
			const response = await f.request({ workspace: "personal", route, body });
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ message: "Permission denied" });
		}
		await f.leave(true);
		for (const { route, body } of requests) {
			const response = await f.request({ workspace: "personal", route, body });
			expect(response.status).toBe(401);
			expect(response.headers.get("Location")).toBeNull();
			expect(await response.json()).toEqual({ message: "Unauthenticated" });
		}
		expect(getUrl).not.toHaveBeenCalled();
	});

	test("ordinary grants keep their own byte counter and no code source", async () => {
		const f = await fixture();
		await f.file({ workspace: "current", textContent: "abcdef", stored: true });
		await f.t.mutation(internal.public_api.create_grant, {
			organizationId: f.source.organizationId,
			workspaceId: f.source.workspaceId,
			userId: f.source.userId,
			threadId: null,
			principalKey: "ordinary",
			tokenHash: f.mintArgs.tokenHashes.current,
			scopes: ["files:download"],
			pathPrefix: null,
			now: Date.now(),
		});
		expect((await f.read("current")).status).toBe(200);
		expect(await f.t.run((ctx) => ctx.db.query("public_api_grants").first())).toMatchObject({
			agentSource: null,
			codeReadBudgetId: null,
			remainingReadBytes: 8 * 1024 * 1024 - 6,
		});
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect())).toEqual([]);
	});

	test("expiry cleanup bounds grants and budgets together", async () => {
		const f = await fixture();
		await f.mint();
		const budget = await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").first());
		for (let pass = 0; pass < 3; pass++) {
			expect(
				await f.t.mutation(internal.public_api.cleanup_expired_grants_until_done, {
					_test_now: budget!.expiresAt + 1,
					batchSize: 1,
					_test_disableReschedule: true,
				}),
			).toEqual({ deletedCount: 1, done: false });
		}
		expect(
			await f.t.mutation(internal.public_api.cleanup_expired_grants, {
				_test_now: budget!.expiresAt + 1,
				batchSize: 1,
			}),
		).toEqual({ deletedCount: 0, done: true });
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect())).toEqual([]);
	});

	test("workspace purge drains source budgets before deleting their thread", async () => {
		const f = await fixture();
		await f.mint();
		const requestId = await f.t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				scope: "workspace",
				organizationId: f.source.organizationId,
				workspaceId: f.source.workspaceId,
				userId: f.source.userId,
				eligibleAt: Date.now(),
			}),
		);
		for (let pass = 0; pass < 100; pass++) {
			const result = await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 1,
			});
			const state = await f.t.run(async (ctx) => ({
				thread: await ctx.db.get("ai_chat_threads", f.source.threadId),
				budgets: await ctx.db.query("ai_chat_code_read_budgets").collect(),
			}));
			if (!state.thread) expect(state.budgets).toEqual([]);
			if (result.done) break;
		}
		expect(await f.t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect())).toEqual([]);
		expect((await f.request({ workspace: "personal", route: "list", body: {} })).status).toBe(401);
	});

	test("user finalization drains budgets even without their source thread", async () => {
		const f = await fixture();
		await f.mint();
		await f.t.run((ctx) => ctx.db.delete("ai_chat_threads", f.source.threadId));
		let done = false;
		for (let pass = 0; pass < 100 && !done; pass++)
			done = await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: f.actor.userId,
				_test_batchSize: 1,
				_test_disableReschedule: true,
			});
		expect(done).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.query("public_api_grants").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_code_read_budgets").collect())).toEqual([]);
	});
});
