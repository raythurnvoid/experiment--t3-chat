import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import type { files_PendingTarget } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `copy-privacy-${++workCount}` as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	const objects = new Map<string, BodyInit>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (url.pathname === "/upload" && init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture(sourceWorkspace: "current" | "personal" = "personal") {
	const t = test_convex({ transactionLimits: true });
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "copy-team", workspaceName: "home" }),
	);
	const personal = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: personal.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", personal.userId).eq("active", true),
			)
			.first(),
	);
	if (!membership) throw new Error("Expected team membership");
	const current = { ...owner, userId: personal.userId, membershipId: membership._id };
	const source = sourceWorkspace === "current" ? current : personal;
	const destination = sourceWorkspace === "current" ? personal : current;
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: personal.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: current.membershipId,
		clientGeneratedId: "copy-privacy",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	return { t, owner, asOwner, asUser, current, source, destination, sourceWorkspace, threadId: thread._yay.threadId };
}

async function copy(f: Awaited<ReturnType<typeof fixture>>, sources: files_PendingTarget[]) {
	const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.current.membershipId,
		threadId: f.threadId,
		requestId: "copy",
		sourceWorkspace: f.sourceWorkspace,
		destinationWorkspace: f.sourceWorkspace === "current" ? "personal" : "current",
		kind: "copy",
		expectedSourceCount: sources.length,
		sources,
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: null,
		missingParentNames: [],
		conflictPolicy: { file: "error", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 40; step++) {
		await f.t.mutation(internal.files_transfer.advance, { runId });
		const items = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		const activity = await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
		if (activity?.status === "succeeded") return { runId, items };
		if (activity?.status === "failed") throw new Error(activity.errorMessage ?? "Copy failed");
		for (const item of items) {
			if (!item.workId || item.state !== "copying") continue;
			await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			await f.t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: item.workId,
				context: { itemId: item._id, attempt: item.attempt },
				result: { kind: "success", returnValue: null },
			});
		}
	}
	throw new Error("Copy did not finish");
}

async function proposal(f: Awaited<ReturnType<typeof fixture>>, target: files_PendingTarget) {
	const pending = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) =>
				q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
			)
			.first(),
	);
	if (!pending) throw new Error("Expected a proposal");
	return pending;
}

async function save(f: Awaited<ReturnType<typeof fixture>>, pending: Doc<"files_pending_updates">) {
	const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
		membershipId: f.destination.membershipId,
		target: pending.target,
		pendingUpdateId: pending._id,
		reviewedRevision: pending.revision,
	});
	if (saved._nay) throw new Error(saved._nay.message);
	if (saved._yay.target.kind !== "saved") throw new Error("Expected a saved copy");
	return saved._yay.target;
}

describe("cross-workspace Copy privacy", () => {
	test("another workspace owner cannot Save the actor's private output", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.source.membershipId,
			path: "/document.md",
			textContent: "Private copy\n",
		});
		const { items } = await copy(f, [{ kind: "saved", id: sourceId }]);
		const pending = await proposal(f, items[0]!.outputTarget!);
		expect(pending.target.kind).toBe("private");
		expect(
			await f.asOwner.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: f.owner.membershipId,
				target: pending.target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toHaveProperty("_nay");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q.eq("organizationId", f.destination.organizationId).eq("workspaceId", f.destination.workspaceId),
					)
					.collect(),
			),
		).toEqual([]);
		await save(f, pending);
	});

	test("copies the owner's private subtree below a saved root and keeps the source drafts", async () => {
		const f = await fixture("current");
		const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.source.membershipId,
			parentId: "root",
			path: "/folder",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const drafts: Id<"files_pending_nodes">[] = [];
		for (const path of ["/folder/draft", "/folder/draft/nested"]) {
			const child = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: f.source.organizationId,
				workspaceId: f.source.workspaceId,
				userId: f.source.userId,
				path,
				kind: "folder",
			});
			if (child._nay || child._yay.target.kind !== "private") throw new Error("Expected a private child");
			drafts.push(child._yay.target.id);
		}
		const before = await f.t.run((ctx) => Promise.all(drafts.map((id) => ctx.db.get("files_pending_nodes", id))));
		const { items } = await copy(f, [{ kind: "saved", id: folder._yay.nodeId }]);
		expect(items.map((item) => item.source)).toEqual([
			{ kind: "saved", id: folder._yay.nodeId },
			...drafts.map((id) => ({ kind: "private", id })),
		]);
		for (const item of items) {
			const saved = await save(f, await proposal(f, item.outputTarget!));
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", saved.id))).toMatchObject({
				workspaceId: f.destination.workspaceId,
				path: item.sourcePath,
				archiveOperationId: null,
			});
		}
		expect(await f.t.run((ctx) => Promise.all(drafts.map((id) => ctx.db.get("files_pending_nodes", id))))).toEqual(
			before,
		);
	});

	test("account finalization removes transfer history and keeps the saved team copy", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.source.membershipId,
			path: "/document.md",
			textContent: "Keep the team copy\n",
		});
		const { runId, items } = await copy(f, [{ kind: "saved", id: sourceId }]);
		const saved = await save(f, await proposal(f, items[0]!.outputTarget!));
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", saved.id));
		const assets = await f.t.run((ctx) =>
			ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", f.destination.organizationId).eq("workspaceId", f.destination.workspaceId),
				)
				.collect(),
		);
		expect(assets.length).toBeGreaterThan(0);
		expect(await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.current.userId })).not.toBeNull();
		let done = false;
		for (let step = 0; step < 300 && !done; step++)
			done = await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: f.current.userId,
				_test_batchSize: 8,
				_test_disableReschedule: true,
			});
		expect(done).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", saved.id))).toEqual(node);
		for (const asset of assets) expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", asset._id))).toEqual(asset);
		expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.current.membershipId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("users", f.current.userId))).toMatchObject({
			deletedAt: expect.any(Number),
		});
	});

	test("destination purge leaves the source file unchanged", async () => {
		const f = await fixture("current");
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.source.membershipId,
			path: "/document.md",
			textContent: "Keep the original\n",
		});
		const { runId, items } = await copy(f, [{ kind: "saved", id: sourceId }]);
		const saved = await save(f, await proposal(f, items[0]!.outputTarget!));
		const before = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
		const requestId = await f.t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: f.destination.userId,
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);
		let done = false;
		for (let step = 0; step < 300 && !done; step++)
			done = (
				await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
					requestId,
					_test_batchSize: 8,
				})
			).done;
		expect(done).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", saved.id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toEqual(before);
	});

	test.each(["current", "personal"] as const)(
		"copies %s text without comments and keeps the original",
		async (sourceWorkspace) => {
			const f = await fixture(sourceWorkspace);
			const sourceId = await test_create_saved_text_file(f.t, {
				membershipId: f.source.membershipId,
				path: "/document.md",
				textContent: 'Keep **bold** and <span data-type="comment" data-lb-thread-id="old-thread">these words</span>.\n',
			});
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			const { items } = await copy(f, [{ kind: "saved", id: sourceId }]);
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				userId: f.destination.userId,
				overlayUserId: f.destination.userId,
				path: "/document.md",
			});
			expect(read?.content).toBe("Keep **bold** and these words.\n");
			await save(f, await proposal(f, items[0]!.outputTarget!));
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toEqual(before);
		},
	);
});
