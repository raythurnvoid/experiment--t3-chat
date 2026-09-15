import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	files_pending_nodes_db_create,
	files_pending_nodes_db_discard,
	files_pending_nodes_db_fence_discard,
	files_pending_nodes_db_get_ancestry,
	files_pending_nodes_db_publish,
} from "./files_pending_nodes.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function create_folder(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		name: string;
		parent?: Doc<"files_pending_nodes">["parent"];
	},
) {
	const created = await files_pending_nodes_db_create(ctx, {
		...args,
		kind: "folder",
		parent: args.parent ?? { kind: "root" },
	});
	if (created._nay) throw new Error(created._nay.message);
	await ctx.db.patch("files_pending_updates", created._yay.pendingUpdateId, {
		createIntent: { kind: "folder", metadata: [] },
	});
	const node = await ctx.db.get("files_pending_nodes", created._yay.privateNodeId);
	const pendingUpdate = await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId);
	if (!node || !pendingUpdate) throw new Error("Expected the private folder and proposal");
	return { node, pendingUpdate };
}

describe("files_pending_nodes_db_create", () => {
	test("creates one owner proposal and node slot without a saved node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "draft" }));
		expect(created.node).toMatchObject({
			parent: { kind: "root" },
			creationGeneration: 1,
			structuralRevision: 1,
			state: "active",
		});
		expect(created.pendingUpdate).toMatchObject({
			target: { kind: "private", id: created.node._id },
			revision: 1,
			createIntent: { kind: "folder", metadata: [] },
		});
		expect(await t.run(async (ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.query("files_private_storage_reservations").collect())).toMatchObject([
			{ resource: { kind: "node", id: created.node._id }, byteCount: 0, settlement: { kind: "held" } },
		]);
		const duplicate = await t.run(async (ctx) =>
			files_pending_nodes_db_create(ctx, { ...db, parent: { kind: "root" }, name: "draft", kind: "folder" }),
		);
		expect(duplicate._nay?.name).toBe("target_changed");
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect())).toHaveLength(1);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(1);
	});

	test("refuses a full node quota before creating a proposal", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const quotaId = await t.run(async (ctx) => {
			const id = await quotas_db_ensure(ctx, { ...db, quotaName: "files_private_nodes", now: Date.now() });
			await ctx.db.patch("quotas", id, { maxCount: 0 });
			return id;
		});
		const refused = await t.run(async (ctx) =>
			files_pending_nodes_db_create(ctx, { ...db, parent: { kind: "root" }, name: "draft", kind: "folder" }),
		);
		expect(refused._nay?.name).toBe("storage_full");
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.query("files_private_storage_reservations").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.get("quotas", quotaId))).toMatchObject({ usedCount: 0 });
	});
});

describe("files_pending_review_versions", () => {
	test("advances for owner edits and discard even when the clock does not move", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const { organizationId, workspaceId, userId } = db;
		const readVersion = () =>
			t.run(async (ctx) =>
				ctx.db
					.query("files_pending_review_versions")
					.withIndex("by_organization_workspace_user", (q) =>
						q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("userId", userId),
					)
					.first(),
			);
		const now = Date.now();
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId,
			workspaceId,
			userId,
			path: "/review-clock",
			kind: "folder",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder");
		const initialVersion = await readVersion();
		expect(initialVersion?.revision).toBeGreaterThan(0);
		const edited = await t.mutation(internal.files_metadata.update_entries_by_path, {
			organizationId,
			workspaceId,
			userId,
			path: "/review-clock",
			set: [{ key: "note", value: "reviewed" }],
			remove: [],
		});
		expect(edited._nay).toBeUndefined();
		const editedVersion = await readVersion();
		expect(editedVersion!.revision).toBeGreaterThan(initialVersion!.revision);
		const proposal = await t.run(async (ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (!proposal) throw new Error("Expected the folder proposal");
		const discarded = await t
			.withIdentity({ issuer: "https://clerk.test", external_id: userId })
			.mutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: db.membershipId,
				target: proposal.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
		expect(discarded._nay).toBeUndefined();
		expect((await readVersion())!.revision).toBeGreaterThan(editedVersion!.revision);
		expect(Date.now()).toBe(now);
	});

	test("a new child changes the parent's review version but another owner does not", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const other = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "review-clock-control",
			}),
		);
		const { organizationId, workspaceId, userId } = db;
		const readVersion = () =>
			t.run(async (ctx) =>
				ctx.db
					.query("files_pending_review_versions")
					.withIndex("by_organization_workspace_user", (q) =>
						q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("userId", userId),
					)
					.first(),
			);
		await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId,
			workspaceId,
			userId,
			path: "/review-parent",
			kind: "folder",
		});
		const initialVersion = await readVersion();
		const control = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: other.organizationId,
			workspaceId: other.workspaceId,
			userId: other.userId,
			path: "/control",
			kind: "folder",
		});
		expect(control._nay).toBeUndefined();
		expect(await readVersion()).toEqual(initialVersion);
		const child = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId,
			workspaceId,
			userId,
			path: "/review-parent/child",
			kind: "folder",
		});
		expect(child._nay).toBeUndefined();
		expect((await readVersion())!.revision).toBeGreaterThan(initialVersion!.revision);
	});
});

describe("files_pending_nodes_db_get_ancestry", () => {
	test("hides another owner's draft and its parent chain", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const other = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, { ...db, name: "child", parent: { kind: "private", id: parent.node._id } }),
		);
		const own = await t.run(async (ctx) =>
			files_pending_nodes_db_get_ancestry(ctx, { ...db, privateNodeId: child.node._id }),
		);
		expect(own._yay).toEqual({ node: child.node, ancestors: [parent.node], savedParent: null });
		const refused = await t.run(async (ctx) =>
			files_pending_nodes_db_get_ancestry(ctx, { ...db, userId: other.userId, privateNodeId: child.node._id }),
		);
		expect(refused._nay?.name).toBe("not_found");
		const underOtherParent = await t.run(async (ctx) =>
			files_pending_nodes_db_create(ctx, {
				...other,
				parent: { kind: "private", id: parent.node._id },
				name: "child",
				kind: "folder",
			}),
		);
		expect(underOtherParent._nay?.name).toBe("not_found");
	});

	test("hides descendants at the Discard fence and keeps their storage held", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, { ...db, name: "child", parent: { kind: "private", id: parent.node._id } }),
		);
		await t.run(async (ctx) => files_pending_nodes_db_fence_discard(ctx, parent.node));
		const refused = await t.run(async (ctx) =>
			files_pending_nodes_db_get_ancestry(ctx, { ...db, privateNodeId: child.node._id }),
		);
		expect(refused._nay?.name).toBe("target_changed");
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toMatchObject({
			state: "discarded",
			creationGeneration: 2,
		});
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", child.node._id))).toEqual(child.node);
		expect(await t.run(async (ctx) => ctx.db.query("files_private_storage_reservations").collect())).toMatchObject([
			{ settlement: { kind: "held" } },
			{ settlement: { kind: "held" } },
		]);
		const lateChild = await t.run(async (ctx) =>
			files_pending_nodes_db_create(ctx, {
				...db,
				parent: { kind: "private", id: parent.node._id },
				name: "late",
				kind: "folder",
			}),
		);
		expect(lateChild._nay?.name).toBe("target_changed");
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect())).toHaveLength(2);
	});
});

describe("cleanup_published_nodes", () => {
	test("keeps an unused receipt for seven days", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/saved",
			kind: "folder",
		});
		if (created._nay || created._yay.target.kind !== "private" || !created._yay.pendingUpdateId)
			throw new Error("Expected a private folder");
		const privateId = created._yay.target.id;
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (!proposal) throw new Error("Expected the folder proposal");
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: db.membershipId,
			target: proposal.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved folder");
		const savedId = saved._yay.target.id;
		const savedBefore = await t.run((ctx) => ctx.db.get("files_nodes", savedId));
		const savedAt = Date.now();
		vi.setSystemTime(savedAt + 7 * 24 * 60 * 60 * 1000 - 1);
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", privateId))).toMatchObject({ state: "published" });
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(1);
		vi.setSystemTime(Date.now() + 1);
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", privateId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", savedId))).toEqual(savedBefore);
	});

	test("continues past a full page of retained parents", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const retainedIds = [];
		let unusedId: Id<"files_pending_nodes"> | null = null;
		for (let index = 0; index < 33; index++) {
			const path = `/parent-${index}`;
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path,
				kind: "folder",
			});
			if (created._nay || created._yay.target.kind !== "private" || !created._yay.pendingUpdateId)
				throw new Error("Expected a private folder");
			if (index < 32) {
				retainedIds.push(created._yay.target.id);
				const child = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					...scope,
					path: `${path}/child`,
					kind: "folder",
				});
				expect(child._nay).toBeUndefined();
			} else unusedId = created._yay.target.id;
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
			if (!proposal) throw new Error("Expected the folder proposal");
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: db.membershipId,
				target: proposal.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			expect(saved._nay).toBeUndefined();
		}
		if (!unusedId) throw new Error("Expected the unused private identity");
		const unusedPrivateId = unusedId;
		vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
		const savedBefore = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", unusedPrivateId))).not.toBeNull();
		const jobs = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.state.kind === "pending" && job.name.includes("cleanup_published_nodes"),
			),
		);
		expect(jobs).toHaveLength(1);
		const args = jobs[0]!.args[0];
		if (!args || typeof args !== "object" || !("cursor" in args) || typeof args.cursor !== "string")
			throw new Error("Expected a cleanup cursor");
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, { cursor: args.cursor });
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", unusedPrivateId))).toBeNull();
		const receipts = await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(new Set(receipts.map((receipt) => receipt.privateNodeId))).toEqual(new Set(retainedIds));
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
	});

	test("keeps a child's parent link, then removes the unused receipt without touching the saved folder", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/parent/child",
			kind: "folder",
		});
		if (created._nay || created._yay.target.kind !== "private") throw new Error("Expected private folders");
		const childId = created._yay.target.id;
		const proposals = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const parent = proposals.find((proposal) => proposal._id !== created._yay.pendingUpdateId)!;
		const child = proposals.find((proposal) => proposal._id === created._yay.pendingUpdateId)!;
		if (parent.target.kind !== "private") throw new Error("Expected a private parent");
		const parentId = parent.target.id;
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: db.membershipId,
			target: parent.target,
			pendingUpdateId: parent._id,
			reviewedRevision: parent.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved folder");
		const savedId = saved._yay.target.id;
		const savedBefore = await t.run((ctx) => ctx.db.get("files_nodes", savedId));
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", parentId))).toMatchObject({ state: "published" });
		vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", parentId))).toMatchObject({ state: "published" });
		expect(
			(await t.run((ctx) => files_pending_nodes_db_get_ancestry(ctx, { ...scope, privateNodeId: childId })))._yay
				?.savedParent?._id,
		).toBe(savedId);
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: db.membershipId,
					target: child.target,
					pendingUpdateId: child._id,
					reviewedRevision: child.revision,
				})
			)._nay,
		).toBeUndefined();
		const task = await t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").first());
		if (!task) throw new Error("Expected child cleanup");
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: task._id });
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", parentId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", savedId))).toEqual(savedBefore);
	});

	test("keeps the Bash folder link until the thread selects another folder", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/cwd",
			kind: "folder",
		});
		if (created._nay || created._yay.target.kind !== "private" || !created._yay.pendingUpdateId)
			throw new Error("Expected a private folder");
		const privateId = created._yay.target.id;
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "receipt-cwd",
			title: "Receipt cwd",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const threadId = thread._yay.threadId;
		const begin = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...scope,
			threadId,
			toolCallId: "select-folder",
			commandHash: "a".repeat(64),
		});
		if (begin._nay) throw new Error(begin._nay.message);
		await t.mutation(internal.ai_chat.set_thread_state, {
			...scope,
			threadId,
			invocationId: begin._yay.invocationId,
			patch: { bashCwd: "/cwd", bashCwdTarget: created._yay.target },
		});
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (!proposal) throw new Error("Expected the folder proposal");
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: db.membershipId,
			target: proposal.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved folder");
		const savedId = saved._yay.target.id;
		const savedBefore = await t.run((ctx) => ctx.db.get("files_nodes", savedId));
		vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", privateId))).toMatchObject({ state: "published" });
		expect(
			(
				await t.query(internal.files_visible.internal_get_directory_path, {
					...scope,
					target: { kind: "private", id: privateId },
				})
			)?.path,
		).toBe("/cwd");
		const next = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...scope,
			threadId,
			toolCallId: "leave-folder",
			commandHash: "b".repeat(64),
		});
		if (next._nay) throw new Error(next._nay.message);
		await t.mutation(internal.ai_chat.set_thread_state, {
			...scope,
			threadId,
			invocationId: next._yay.invocationId,
			patch: { bashCwd: "/", bashCwdTarget: null },
		});
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", privateId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", savedId))).toEqual(savedBefore);
	});
});

describe("files_pending_nodes_db_publish", () => {
	test("keeps private children on their parent receipt and releases only the published node slot", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, { ...db, name: "child", parent: { kind: "private", id: parent.node._id } }),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const saved = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "parent",
		});
		if (saved._nay) throw new Error(saved._nay.message);
		await t.run(async (ctx) => {
			await files_pending_nodes_db_publish(ctx, { ...parent, savedNodeId: saved._yay.nodeId });
			await ctx.db.delete("files_pending_updates", parent.pendingUpdate._id);
		});
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", child.node._id))).toEqual(child.node);
		const ancestry = await t.run(async (ctx) =>
			files_pending_nodes_db_get_ancestry(ctx, { ...db, privateNodeId: child.node._id }),
		);
		expect(ancestry._yay).toMatchObject({
			node: child.node,
			ancestors: [],
			savedParent: { _id: saved._yay.nodeId, path: "/parent" },
		});
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toMatchObject([
			{
				privateNodeId: parent.node._id,
				savedNodeId: saved._yay.nodeId,
				creationGeneration: 1,
				structuralRevision: 1,
				proposalRevision: 1,
			},
		]);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toMatchObject({
			state: "published",
			creationGeneration: 2,
		});
		const holds = await t.run(async (ctx) => ctx.db.query("files_private_storage_reservations").collect());
		expect(holds.find((hold) => hold.resource.id === parent.node._id)?.settlement).toMatchObject({
			kind: "saved",
			savedNodeId: saved._yay.nodeId,
		});
		expect(holds.find((hold) => hold.resource.id === child.node._id)?.settlement).toEqual({ kind: "held" });
		const quota = await t.run(async (ctx) => ctx.db.get("quotas", holds[0]!.userQuotaId));
		expect(quota?.usedCount).toBe(1);
		const oldTarget = await t.run(async (ctx) =>
			files_pending_nodes_db_get_ancestry(ctx, { ...db, privateNodeId: parent.node._id }),
		);
		expect(oldTarget._nay?.name).toBe("target_changed");
	});
});

describe("files_pending_nodes_db_discard", () => {
	test("expires a large tree in bounded child jobs and keeps its newer child", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const startedAt = Date.now();
		for (let index = 0; index < 256; index++) {
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path: `/parent/child-${index}`,
				kind: "folder",
			});
			expect(created._nay).toBeUndefined();
		}
		const oldProposals = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(oldProposals).toHaveLength(257);
		const parent = await t.run((ctx) =>
			ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId)
						.eq("userId", scope.userId)
						.eq("parent.kind", "root")
						.eq("parent.id", undefined)
						.eq("state", "active")
						.eq("name", "parent"),
				)
				.unique(),
		);
		if (!parent) throw new Error("Expected the private parent");
		const parentProposal = oldProposals.find((proposal) => proposal.target.id === parent._id)!;
		const scheduled = await t.run((ctx) => ctx.db.query("files_pending_updates_cleanup_tasks").collect());
		expect(new Set(scheduled.map((task) => task.pendingUpdateId)).size).toBe(257);
		vi.setSystemTime(startedAt + 3 * 60 * 60 * 1000);
		const newer = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/parent/newer",
			kind: "folder",
		});
		if (newer._nay || newer._yay.target.kind !== "private") throw new Error("Expected the newer child");
		const newerId = newer._yay.target.id;
		vi.setSystemTime(startedAt + 4 * 60 * 60 * 1000);
		await t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
			pendingUpdateId: parentProposal._id,
			expectedUpdatedAt: parentProposal.updatedAt,
		});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", parent._id))).toEqual(parent);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toHaveLength(258);
		for (const proposal of oldProposals) {
			if (proposal._id === parentProposal._id) continue;
			await t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
				pendingUpdateId: proposal._id,
				expectedUpdatedAt: proposal.updatedAt,
			});
		}
		const cleanupTasks = await t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect());
		expect(cleanupTasks).toHaveLength(256);
		for (const task of cleanupTasks)
			await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: task._id });
		await t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
			pendingUpdateId: parentProposal._id,
			expectedUpdatedAt: parentProposal.updatedAt,
		});
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toHaveLength(2);
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", newerId))).toMatchObject({ state: "active" });
		expect(
			(await t.run((ctx) => files_pending_nodes_db_get_ancestry(ctx, { ...scope, privateNodeId: newerId })))._yay
				?.ancestors,
		).toEqual([parent]);
		vi.setSystemTime(startedAt + 7 * 60 * 60 * 1000);
		await t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
			pendingUpdateId: parentProposal._id,
			expectedUpdatedAt: parentProposal.updatedAt,
		});
		const finalTasks = await t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect());
		for (const privateNodeId of [newerId, parent._id]) {
			const task = finalTasks.find((item) => item.privateNodeId === privateNodeId)!;
			await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: task._id });
		}
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		const reservations = await t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		expect(reservations).toHaveLength(258);
		expect(reservations.every((reservation) => reservation.settlement.kind === "deleted")).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("quotas", reservations[0]!.userQuotaId))).toMatchObject({ usedCount: 0 });
	});

	test("requires review for a ready child and keeps both drafts unchanged", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, {
				...db,
				name: "child",
				parent: { kind: "private", id: parent.node._id },
			}),
		);
		const refused = await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
			}),
		);
		expect(refused._nay?.name).toBe("needs_review");
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toEqual(parent.node);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", child.node._id))).toEqual(child.node);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect())).toEqual([]);
	});

	test("refuses a changed child revision before fencing the reviewed subtree", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, {
				...db,
				name: "child",
				parent: { kind: "private", id: parent.node._id },
			}),
		);
		await t.run(async (ctx) => ctx.db.patch("files_pending_updates", child.pendingUpdate._id, { revision: 2 }));
		const refused = await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
				reviewedProposals: [{ pendingUpdateId: child.pendingUpdate._id, revision: 1 }],
			}),
		);
		expect(refused._nay?.name).toBe("target_changed");
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toEqual(parent.node);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect())).toEqual([]);
	});

	test("fences the reviewed subtree and releases node slots only after cleanup", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, {
				...db,
				name: "child",
				parent: { kind: "private", id: parent.node._id },
			}),
		);
		const discarded = await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
				reviewedProposals: [{ pendingUpdateId: child.pendingUpdate._id, revision: 1 }],
			}),
		);
		expect(discarded).toEqual({ _yay: null });
		const holds = await t.run(async (ctx) => ctx.db.query("files_private_storage_reservations").collect());
		expect(holds.map((hold) => hold.settlement)).toEqual([{ kind: "held" }, { kind: "held" }]);
		const hidden = await t.run(async (ctx) =>
			files_pending_nodes_db_get_ancestry(ctx, {
				...db,
				privateNodeId: child.node._id,
			}),
		);
		expect(hidden._nay?.name).toBe("target_changed");
		const tasks = await t.run(async (ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect());
		const parentTask = tasks.find((task) => task.privateNodeId === parent.node._id)!;
		const childTask = tasks.find((task) => task.privateNodeId === child.node._id)!;
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: parentTask._id });
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toMatchObject({
			state: "discarded",
		});
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: childTask._id });
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: parentTask._id });
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: parentTask._id });
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.get("quotas", holds[0]!.userQuotaId))).toMatchObject({ usedCount: 0 });
	});

	test("includes an unfinished child and refuses a late child after the fence", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			files_pending_nodes_db_create(ctx, {
				...db,
				name: "preparing.txt",
				kind: "file",
				parent: { kind: "private", id: parent.node._id },
			}),
		);
		if (child._nay) throw new Error(child._nay.message);
		const discarded = await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
			}),
		);
		expect(discarded).toEqual({ _yay: null });
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", child._yay.privateNodeId))).toMatchObject({
			state: "discarded",
			creationGeneration: 2,
		});
		const late = await t.run(async (ctx) =>
			files_pending_nodes_db_create(ctx, {
				...db,
				name: "late.txt",
				kind: "file",
				parent: { kind: "private", id: parent.node._id },
			}),
		);
		expect(late._nay?.name).toBe("target_changed");
	});

	test("keeps an expired parent while a live child still needs it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
		const child = await t.run(async (ctx) =>
			create_folder(ctx, {
				...db,
				name: "child",
				parent: { kind: "private", id: parent.node._id },
			}),
		);
		vi.setSystemTime(Date.now() + 60 * 60 * 1000);
		await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
				reason: "expired",
			}),
		);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toEqual(parent.node);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_updates_cleanup_tasks").collect())).toMatchObject([
			{ pendingUpdateId: parent.pendingUpdate._id, expectedUpdatedAt: parent.pendingUpdate.updatedAt },
		]);
		vi.setSystemTime(child.pendingUpdate.updatedAt + 4 * 60 * 60 * 1000);
		await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
				reason: "expired",
			}),
		);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect())).toMatchObject([
			{ state: "discarded" },
			{ state: "discarded" },
		]);
	});

	test("keeps a previously saved parent when its remaining child is discarded", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, {
				...db,
				name: "child",
				parent: { kind: "private", id: parent.node._id },
			}),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const saved = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "parent",
		});
		if (saved._nay) throw new Error(saved._nay.message);
		await t.run(async (ctx) => {
			await files_pending_nodes_db_publish(ctx, { ...parent, savedNodeId: saved._yay.nodeId });
			await ctx.db.delete("files_pending_updates", parent.pendingUpdate._id);
		});
		const discarded = await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: child.node._id,
				pendingUpdateId: child.pendingUpdate._id,
				expectedRevision: 1,
			}),
		);
		expect(discarded).toEqual({ _yay: null });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", saved._yay.nodeId))).not.toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toMatchObject({
			state: "published",
		});
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toMatchObject([
			{ privateNodeId: parent.node._id, savedNodeId: saved._yay.nodeId },
		]);
	});
});
