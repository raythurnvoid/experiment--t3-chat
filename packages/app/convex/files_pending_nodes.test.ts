import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	files_media_dependencies_db_append,
	files_media_dependencies_db_create,
	files_media_dependencies_db_retire,
	files_media_dependencies_db_seal,
} from "./files_media_dependencies.ts";
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

async function expiry_check(
	t: ReturnType<typeof test_convex>,
	scope: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	return await t.run((ctx) =>
		ctx.db
			.query("files_pending_update_expiry_checks")
			.withIndex("by_organization_workspace_user", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", scope.userId),
			)
			.unique(),
	);
}

/**
 * Run the owner's expiry check like its scheduled job would, until it is not due anymore.
 * One run handles at most 8 drafts and then continues in a new run.
 */
async function expire_drafts(
	t: ReturnType<typeof test_convex>,
	scope: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	for (let run = 0; run < 100; run++) {
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
		});
		const check = await expiry_check(t, scope);
		if (!check || check.nextCheckAt > Date.now()) return;
	}
	throw new Error("The expiry check never finished");
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

	test.each(["active", "cleanup"])(
		"keeps a published media alias while its set is %s and still has its dependency",
		async (state) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const prepared = await t.mutation(internal.files_ingestion.prepare_file, {
				...scope,
				membershipId: db.membershipId,
				requestId: "media-alias",
				attemptId: "one",
				path: "/photo.png",
				size: 4,
				contentType: "image/png",
				digest: "a".repeat(64),
				content: { kind: "stored" },
			});
			if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected stored preparation");
			const capture = prepared._yay;
			const completed = await t.mutation(internal.files_ingestion.finalize_file, {
				...scope,
				membershipId: db.membershipId,
				receiptId: capture.receiptId,
				attemptId: "one",
			});
			if (completed._nay || completed._yay.target.kind !== "private") throw new Error("Expected a private image");
			const target = completed._yay.target;
			const proposal = await asUser.query(api.files_pending_updates.get_file_pending_update, {
				membershipId: db.membershipId,
				target,
			});
			if (!proposal) throw new Error("Expected the image proposal");
			const draft = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path: "/draft",
				kind: "folder",
			});
			if (draft._nay || !draft._yay.pendingUpdateId) throw new Error("Expected the set owner");
			const owner = { kind: "proposal" as const, pendingUpdateId: draft._yay.pendingUpdateId };
			const set = await t.run((ctx) => files_media_dependencies_db_create(ctx, { ...scope, owner, expectedCount: 1 }));
			if (set._nay) throw new Error(set._nay.message);
			const pin = { setId: set._yay, generation: 0 };
			expect(
				await t.run((ctx) =>
					files_media_dependencies_db_append(ctx, {
						...pin,
						offset: 0,
						mappings: [
							{
								sourceSrc: "source:photo",
								dependency: {
									src: `bonobo-file://${target.id}`,
									target,
									assetId: capture.assetId,
									version: {
										kind: "asset",
										assetId: capture.assetId,
										contentType: "image/png",
										textKind: null,
										collaborationEnabled: null,
									},
								},
							},
						],
					}),
				),
			).toEqual({ _yay: null });
			expect(await t.run((ctx) => files_media_dependencies_db_seal(ctx, pin))).toEqual({ _yay: null });
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: db.membershipId,
				target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			if (saved._nay) throw new Error(saved._nay.message);
			if (saved._yay.target.kind !== "saved") throw new Error("Expected a saved image");
			const savedId = saved._yay.target.id;
			const savedBefore = await t.run((ctx) => ctx.db.get("files_nodes", savedId));
			const receiptBefore = await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
			expect(receiptBefore).toHaveLength(1);
			if (state === "cleanup") await t.run((ctx) => files_media_dependencies_db_retire(ctx, { ...pin, owner }));
			vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
			await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
			expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({ state: "published" });
			expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual(
				receiptBefore,
			);
			if (state === "active") await t.run((ctx) => files_media_dependencies_db_retire(ctx, { ...pin, owner }));
			await t.mutation(internal.files_media_dependencies.cleanup_set, { setId: set._yay });
			expect(await t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toEqual([]);
			await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
			expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toBeNull();
			expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.get("files_nodes", savedId))).toEqual(savedBefore);
		},
	);

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
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: task.privateNodeId });
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
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: db.userId,
			membershipId: db.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const begin = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...scope,
			threadId,
			membershipId: db.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "select-folder",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (begin._nay || !("shell" in begin._yay)) throw new Error("Expected a fresh shell");
		await t.mutation(internal.ai_chat.save_shell, {
			...scope,
			threadId,
			invocationId: begin._yay.invocationId,
			shellId: begin._yay.shell._id,
			cwd: "/cwd",
			cwdTarget: created._yay.target,
			transcriptEntry: "$ cd /cwd",
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
			membershipId: db.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "leave-folder",
			commandHash: "b".repeat(64),
			shellName: "default",
		});
		if (next._nay) throw new Error(next._nay.message);
		await t.mutation(internal.ai_chat.save_shell, {
			...scope,
			threadId,
			invocationId: next._yay.invocationId,
			shellId: begin._yay.shell._id,
			cwd: "/",
			cwdTarget: null,
			transcriptEntry: "$ cd /",
		});
		await t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", privateId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", savedId))).toEqual(savedBefore);
	});
});

describe("files_pending_nodes_db_publish", () => {
	test.each(["unchanged", "policy", "ancestor_path", "acl", "owner"] as const)(
		"copied parent lock: %s",
		async (change) => {
			const t = test_convex({ transactionLimits: true });
			const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const author = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "author", workspaceName: "home" }),
			);
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
			expect(
				await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					userIdToAdd: author.userId,
				}),
			).toEqual({ _yay: null });
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", owner.workspaceId).eq("userId", author.userId).eq("active", true),
					)
					.unique(),
			);
			if (!membership) throw new Error("Expected the author's membership");
			const db = { ...owner, userId: author.userId, membershipId: membership._id };
			const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const source = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/source" });
			const destination = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
				...scope,
				path: "/destination",
			});
			if (source._nay || destination._nay) throw new Error("Expected the saved folders");
			expect(
				(await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/source/child" }))._nay,
			).toBeUndefined();
			expect(
				await asOwner.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: owner.membershipId,
					nodeId: source._yay.nodeId,
					writePolicy: { mode: "read_only" },
				}),
			).toEqual({ _yay: null });
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "copied-parent",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await t.mutation(internal.files_transfer.start_for_agent, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				requestId: "copied-parent",
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				kind: "copy",
				expectedSourceCount: 1,
				sources: [{ kind: "saved", id: source._yay.nodeId }],
				targetParent: { kind: "saved", id: destination._yay.nodeId },
				targetPath: "/destination",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect(
				await t.mutation(internal.files_transfer.seal_for_agent, {
					membershipId: db.membershipId,
					threadId: thread._yay.threadId,
					runId: started._yay.runId,
				}),
			).toEqual({ _yay: null });
			for (let step = 0; step < 25; step++) {
				await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
				const activity = await t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
				if (activity?.status === "succeeded") break;
			}
			expect(await t.run((ctx) => ctx.db.get("activities", started._yay.activityId))).toMatchObject({
				status: "succeeded",
			});
			const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			const parent = nodes.find((node) => node.name === "source")!;
			const child = nodes.find((node) => node.name === "child")!;
			const proposals = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			const parentProposal = proposals.find((proposal) => proposal.target.id === parent._id)!;
			const childProposal = proposals.find((proposal) => proposal.target.id === child._id)!;
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: db.membershipId,
				target: parentProposal.target,
				pendingUpdateId: parentProposal._id,
				reviewedRevision: parentProposal.revision,
			});
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved parent");
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("files_pending_node_publish_receipts")
						.withIndex("by_privateNode", (q) => q.eq("privateNodeId", parent._id))
						.unique(),
				),
			).toMatchObject({
				copiedWritePolicy: { mode: "read_only" },
				copiedPath: "/destination/source",
			});
			expect(
				await asUser.query(api.files_pending_updates.get_file_pending_target, {
					membershipId: db.membershipId,
					target: childProposal.target,
				}),
			).toMatchObject({ canEdit: false, canAccept: true, canAcceptWithParents: true });
			expect(
				(
					await t.mutation(internal.files_nodes.create_private_node_by_path, {
						...scope,
						path: "/destination/source/new",
						kind: "folder",
					})
				)._nay,
			).toBeDefined();
			if (change === "policy")
				expect(
					await asOwner.mutation(api.files_nodes.set_node_write_policy, {
						membershipId: owner.membershipId,
						nodeId: saved._yay.target.id,
						writePolicy: { mode: "writer", writer: { kind: "user", userId: owner.userId } },
					}),
				).toEqual({ _yay: null });
			if (change === "ancestor_path")
				expect(
					await asOwner.mutation(api.files_nodes.rename_node, {
						membershipId: owner.membershipId,
						nodeId: destination._yay.nodeId,
						path: "moved",
					}),
				).toEqual({ _yay: null });
			if (change === "acl")
				expect(
					(
						await asOwner.mutation(api.files_sharing.restrict_node, {
							membershipId: owner.membershipId,
							nodeId: saved._yay.target.id,
						})
					)._nay,
				).toBeUndefined();
			const caller = change === "owner" ? asOwner : asUser;
			const membershipId = change === "owner" ? owner.membershipId : db.membershipId;
			const before = await t.run(async (ctx) => ({
				proposal: await ctx.db.get("files_pending_updates", childProposal._id),
				nodes: await ctx.db.query("files_nodes").collect(),
			}));
			const savedChild = await caller.action(api.files_pending_updates.save_file_pending_update, {
				membershipId,
				target: childProposal.target,
				pendingUpdateId: childProposal._id,
				reviewedRevision: childProposal.revision,
			});
			if (change === "unchanged") {
				expect(savedChild._nay).toBeUndefined();
				expect(savedChild._yay?.target.kind).toBe("saved");
				expect(await t.run((ctx) => ctx.db.get("files_pending_updates", childProposal._id))).toBeNull();
			} else {
				expect(savedChild._nay).toBeDefined();
				expect(
					await t.run(async (ctx) => ({
						proposal: await ctx.db.get("files_pending_updates", childProposal._id),
						nodes: await ctx.db.query("files_nodes").collect(),
					})),
				).toEqual(before);
			}
		},
	);

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
		// Every draft is due 4 hours after its last edit, and one check covers the whole workspace.
		expect(oldProposals.every((proposal) => proposal.expiresAt === startedAt + 4 * 60 * 60 * 1000)).toBe(true);
		expect(await expiry_check(t, scope)).toMatchObject({ nextCheckAt: startedAt + 4 * 60 * 60 * 1000 });
		vi.setSystemTime(startedAt + 3 * 60 * 60 * 1000);
		const newer = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/parent/newer",
			kind: "folder",
		});
		if (newer._nay || newer._yay.target.kind !== "private") throw new Error("Expected the newer child");
		const newerId = newer._yay.target.id;

		// The old children expire in runs of 8. The parent waits while the newer child is live.
		vi.setSystemTime(startedAt + 4 * 60 * 60 * 1000);
		await expire_drafts(t, scope);
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", parent._id))).toEqual(parent);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toHaveLength(258);
		const cleanupTasks = await t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect());
		expect(cleanupTasks).toHaveLength(256);
		for (const task of cleanupTasks)
			await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: task.privateNodeId });
		vi.setSystemTime(Date.now() + 60_000);
		await expire_drafts(t, scope);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toHaveLength(2);
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", newerId))).toMatchObject({ state: "active" });
		expect(
			(await t.run((ctx) => files_pending_nodes_db_get_ancestry(ctx, { ...scope, privateNodeId: newerId })))._yay
				?.ancestors,
		).toEqual([parent]);

		// The newer child expires first. The parent goes in a later run.
		vi.setSystemTime(startedAt + 7 * 60 * 60 * 1000);
		await expire_drafts(t, scope);
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", newerId))).toMatchObject({ state: "discarded" });
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", parent._id))).toEqual(parent);
		vi.setSystemTime(Date.now() + 60_000);
		await expire_drafts(t, scope);
		const finalTasks = await t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect());
		for (const privateNodeId of [newerId, parent._id]) {
			const task = finalTasks.find((item) => item.privateNodeId === privateNodeId)!;
			await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: task.privateNodeId });
		}
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		const reservations = await t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		expect(reservations).toHaveLength(258);
		expect(reservations.every((reservation) => reservation.settlement.kind === "deleted")).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("quotas", reservations[0]!.userQuotaId))).toMatchObject({ usedCount: 0 });

		// No draft is left, so the next check deletes itself instead of waking up again.
		vi.setSystemTime(Date.now() + 60_000);
		await expire_drafts(t, scope);
		expect(await expiry_check(t, scope)).toBeNull();
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
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: parentTask.privateNodeId });
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toMatchObject({
			state: "discarded",
		});
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: childTask.privateNodeId });
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: parentTask.privateNodeId });
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: parentTask.privateNodeId });
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
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
		// An unfinished child needs no review, so only the children-first expiry rule keeps the folder.
		const child = await t.run(async (ctx) => {
			const created = await files_pending_nodes_db_create(ctx, {
				...db,
				name: "child.txt",
				kind: "file",
				parent: { kind: "private", id: parent.node._id },
			});
			if (created._nay) throw new Error(created._nay.message);
			const pendingUpdate = await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId);
			if (!pendingUpdate) throw new Error("Expected the child proposal");
			return { nodeId: created._yay.privateNodeId, pendingUpdate };
		});
		vi.setSystemTime(parent.pendingUpdate.expiresAt);
		const refused = await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
				reason: "expired",
			}),
		);
		expect(refused._nay?.name).toBe("needs_review");
		await expire_drafts(t, scope);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toEqual(parent.node);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_cleanup_tasks").collect())).toEqual([]);
		// The job tries the folder again in 60 seconds and changes nothing else.
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_updates", parent.pendingUpdate._id))).toEqual({
			...parent.pendingUpdate,
			expiresAt: Date.now() + 60_000,
		});

		// One run expires the child. The folder was checked before the child in that run, so it waits.
		vi.setSystemTime(child.pendingUpdate.expiresAt);
		await expire_drafts(t, scope);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", child.nodeId))).toMatchObject({
			state: "discarded",
		});
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toEqual(parent.node);
		vi.setSystemTime(Date.now() + 60_000);
		await expire_drafts(t, scope);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect())).toMatchObject([
			{ state: "discarded" },
			{ state: "discarded" },
		]);
	});

	test("keeps an expired folder while another draft moves a node into it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const folder = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "folder" }));
		vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
		const saved = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/moved" });
		if (saved._nay) throw new Error(saved._nay.message);
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...scope,
			target: { kind: "saved", id: saved._yay.nodeId },
			destParent: { kind: "private", id: folder.node._id },
			destName: "moved",
		});
		expect(moved._nay).toBeUndefined();
		const move = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", saved._yay.nodeId))
				.unique(),
		);
		if (!move) throw new Error("Expected the move draft");

		vi.setSystemTime(folder.pendingUpdate.expiresAt);
		await expire_drafts(t, scope);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", folder.node._id))).toEqual(folder.node);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_updates", folder.pendingUpdate._id))).toEqual({
			...folder.pendingUpdate,
			expiresAt: Date.now() + 60_000,
		});

		// After the move draft expires, a later run removes the folder.
		vi.setSystemTime(move.expiresAt);
		await expire_drafts(t, scope);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_updates", move._id))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", folder.node._id))).toEqual(folder.node);
		vi.setSystemTime(Date.now() + 60_000);
		await expire_drafts(t, scope);
		expect(await t.run(async (ctx) => ctx.db.get("files_pending_nodes", folder.node._id))).toMatchObject({
			state: "discarded",
		});
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

describe("cleanup_discarded_node", () => {
	async function read_cleanup_task(t: ReturnType<typeof test_convex>, privateNodeId: Id<"files_pending_nodes">) {
		return await t.run((ctx) =>
			ctx.db
				.query("files_pending_node_cleanup_tasks")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", privateNodeId))
				.unique(),
		);
	}

	test("the recovery cron keeps exactly one job for a late task", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const folder = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "late" }));
		const discarded = await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: folder.node._id,
				pendingUpdateId: folder.pendingUpdate._id,
				expectedRevision: 1,
			}),
		);
		expect(discarded).toEqual({ _yay: null });

		// The job never runs here, like a job stuck behind a busy scheduler. So every recovery pass
		// finds the task late again.
		for (let pass = 0; pass < 3; pass++) {
			vi.setSystemTime(Date.now() + 16 * 60 * 1000);
			await t.mutation(internal.files_pending_nodes.recover_discarded_node_cleanup, {});
		}

		const task = await read_cleanup_task(t, folder.node._id);
		const pendingJobs = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => {
				const jobArgs: unknown = job.args[0];
				return (
					job.state.kind === "pending" &&
					job.name.includes("cleanup_discarded_node") &&
					typeof jobArgs === "object" &&
					jobArgs !== null &&
					"privateNodeId" in jobArgs &&
					jobArgs.privateNodeId === folder.node._id
				);
			}),
		);
		expect(pendingJobs.map((job) => job._id)).toEqual([task?.scheduledFunctionId]);
	});

	test("the last child to finish wakes its waiting parent", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const parent = await t.run(async (ctx) => create_folder(ctx, { ...db, name: "parent" }));
		const child = await t.run(async (ctx) =>
			create_folder(ctx, { ...db, name: "child", parent: { kind: "private", id: parent.node._id } }),
		);
		await t.run(async (ctx) =>
			files_pending_nodes_db_discard(ctx, {
				...db,
				privateNodeId: parent.node._id,
				pendingUpdateId: parent.pendingUpdate._id,
				expectedRevision: 1,
				reviewedProposals: [{ pendingUpdateId: child.pendingUpdate._id, revision: 1 }],
			}),
		);

		// The parent waits for its child with only a late safety-net run.
		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: parent.node._id });
		const waiting = await read_cleanup_task(t, parent.node._id);
		if (!waiting) throw new Error("Expected the waiting parent task");
		expect(waiting.nextAttemptAt).toBe(Date.now() + 15 * 60 * 1000);

		await t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: child.node._id });
		const woken = await read_cleanup_task(t, parent.node._id);
		if (!woken) throw new Error("Expected the woken parent task");
		expect(woken.nextAttemptAt).toBe(Date.now());
		const [oldJob, newJob] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.system.get("_scheduled_functions", waiting.scheduledFunctionId),
				ctx.db.system.get("_scheduled_functions", woken.scheduledFunctionId),
			]),
		);
		expect(oldJob?.state.kind).toBe("canceled");
		expect(newJob?.state.kind).toBe("pending");
	});
});
