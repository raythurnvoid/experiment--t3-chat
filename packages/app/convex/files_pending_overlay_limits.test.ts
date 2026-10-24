// Measure the private Discard core, hard delete, the metadata catalog and content Save, including
// the pending overlay flush. Paged Move and Accept cohort steps are in the .move and .accept files.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { archive_nodes, files_nodes_db_rebuild_node, unarchive_nodes } from "./files_nodes.ts";
import { db_replace_file_chunks } from "./files_nodes_content.ts";
import { files_metadata_committed_field_sort_fields, files_metadata_db_patch_file_scope } from "./files_metadata.ts";
import { compact_metadata_catalog, run_job as run_overlay_job } from "./files_pending_overlay.ts";
import * as resolver from "../server/files-visible-resolve.ts";
import * as overlay from "../server/files-pending-overlay.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
	test_move_nodes,
	test_rename_node,
	test_run_with_flush,
	test_seed_folder_chain,
	test_spy_handler,
} from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import {
	files_pending_overlay_db_flush,
	files_pending_overlay_db_mark_target,
} from "../server/files-pending-overlay.ts";
import { files_type_query_db_get_readiness } from "../server/files-type-query.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_MAX_TEXT_CONTENT_BYTES, files_NAME_MAX_LENGTH, files_PATH_MAX_LENGTH } from "../shared/files.ts";
import {
	add_member,
	budget_recorder,
	expect_under_convex_limits,
	finish_scheduled,
	insert_saved_node,
	mock_overlay_limits_storage,
	share_100_times,
	transaction_cost,
} from "./files_pending_overlay_limits.setup.test.ts";

beforeEach(mock_overlay_limits_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("discard_file_pending_update", () => {
	const start_unfinished_work = async (
		t: ReturnType<typeof test_convex>,
		proposals: Doc<"files_pending_updates">[],
		frameCount: number,
	) => {
		const create = resolver.files_visible_resolve_db_create;
		const spy = vi.spyOn(resolver, "files_visible_resolve_db_create").mockImplementation((db, args) => {
			const reader = create(db, args);
			return {
				...reader,
				resolveFacts: async () => null,
				resume: (operation, options) => reader.resume(operation, { ...options, stepLimit: 1 }),
			};
		});
		try {
			await test_run_with_flush(t, async (ctx) => {
				for (const proposal of proposals)
					files_pending_overlay_db_mark_target(ctx, { ...proposal, pendingUpdateId: proposal._id });
			});
		} finally {
			spy.mockRestore();
		}
		// Expand existing owned work to exercise cleanup across pages, without an orphan frame set.
		for (const proposal of proposals)
			await t.run(async (ctx) => {
				for (let index = 0; index < frameCount; index++)
					await ctx.db.insert("files_pending_overlay_resolve_work", {
						organizationId: proposal.organizationId,
						workspaceId: proposal.workspaceId,
						userId: proposal.userId,
						target: proposal.target,
						key: `m:fixture:${index}`,
						value: JSON.stringify({ operation: { kind: "facts", target: proposal.target } }),
					});
			});
	};

	test.each([
		[0, 0, 0, false],
		[20, 0, 0, false],
		[0, 65, 0, false],
		[0, 0, 128, false],
		[0, 0, 0, true],
	] as const)(
		"discards a 256-node private folder that claims a saved name, saved depth %i, stored frames %i, chats %i, unrelated Move %s",
		async (depth, frameCount, threadCount, unrelatedMove) => {
			const t = test_convex({ transactionLimits: true });
			const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

			const chain = await test_seed_folder_chain(t, {
				scope,
				createdBy: db.userId,
				parentId: "root",
				parentPath: "",
				startDepth: 1,
				depth,
				restrictedScopeNodeId: null,
			});
			let area = await t.run((ctx) => insert_saved_node(ctx, db, { parent: null, name: "area", kind: "folder" }));
			const threadIds: Id<"ai_chat_threads">[] = [];
			if (threadCount > 0) {
				const folder = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					...scope,
					path: "/area/drafts",
					kind: "folder",
				});
				if (folder._nay) throw new Error(folder._nay.message);
				for (let index = 0; index < threadCount; index++) {
					const threadId = await t.run((ctx) =>
						ctx.db.insert("ai_chat_threads", {
							organizationId: scope.organizationId,
							workspaceId: scope.workspaceId,
							clientGeneratedId: `discard-${index}`,
							title: null,
							archived: false,
							runtime: "aisdk_5",
							createdBy: scope.userId,
							updatedBy: scope.userId,
							updatedAt: Date.now(),
							newestNodeId: null,
							starred: false,
						}),
					);
					threadIds.push(threadId);
					// Real renames add contributors without adding content to the draft.
					const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						...scope,
						target: folder._yay.target,
						destParent: { kind: "saved", id: area._id },
						destName: index % 2 === 0 ? "renamed" : "drafts",
						threadId,
					});
					if (moved._nay) throw new Error(moved._nay.message);
				}
			}
			// A single Discard answers `needs_review` for a private child folder, a child file with content,
			// or a draft move into the tree. So the largest tree it removes is one folder with 255 new, empty
			// files.
			for (let index = 0; index < 255; index++) {
				const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					...scope,
					path: `${area.path}/drafts/note-${index}.md`,
					kind: "file",
					...(threadCount > 0 ? { threadId: threadIds[index % threadCount] } : {}),
				});
				if (created._nay) throw new Error(created._nay.message);
			}
			if (depth > 0) {
				expect(
					await test_move_nodes(t, asOwner, {
						membershipId: db.membershipId,
						itemIds: [area._id],
						targetParentId: chain.id,
					}),
				).toEqual({ _yay: null });
				area = (await t.run((ctx) => ctx.db.get("files_nodes", area._id)))!;
				expect(`${area.path}/drafts/note-254.md`).toHaveLength(2 * depth + 24);
			}
			// Another user saves a folder named "drafts" under area. The private folder now claims that name.
			const claimed = await test_run_with_flush(t, async (ctx) => {
				const other = await add_member(ctx, db, "clerk_discard_other");
				const claimed = await insert_saved_node(ctx, db, {
					parent: area,
					name: "drafts",
					kind: "folder",
					createdBy: other,
				});
				for (let index = 0; index < 10; index++)
					await insert_saved_node(ctx, db, {
						parent: claimed,
						name: `note-${index}.md`,
						kind: "file",
						createdBy: other,
					});
				return claimed;
			});
			await finish_scheduled(
				t,
				async () => await t.run(async (ctx) => (await ctx.db.query("files_pending_overlay_jobs").first()) === null),
			);
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("files_pending_hides")
						.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", claimed._id).eq("userId", scope.userId))
						.unique(),
				),
			).not.toBeNull();
			const root = await t.run(async (ctx) => {
				const node = (await ctx.db.query("files_pending_nodes").collect()).find((node) => node.name === "drafts")!;
				const proposal = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) =>
						q.eq("userId", db.userId).eq("target.kind", "private").eq("target.id", node._id),
					)
					.unique();
				return { node, proposal: proposal! };
			});
			expect(await t.run(async (ctx) => (await ctx.db.query("files_pending_nodes").collect()).length)).toBe(256);
			if (frameCount > 0) {
				const proposals = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());
				await start_unfinished_work(t, proposals, frameCount);
			}
			if (unrelatedMove) {
				const folders = [];
				for (const path of ["/moving", "/destination"]) {
					const folder = await asOwner.mutation(api.files_nodes.create_folder_node, {
						membershipId: db.membershipId,
						parentId: "root",
						path,
					});
					if (folder._nay) throw new Error(folder._nay.message);
					folders.push(folder._yay.nodeId);
				}
				const canJoin = overlay.files_pending_overlay_db_can_join_step;
				// Leave native Move queued while Discard measures the active workspace guards.
				const join = vi
					.spyOn(overlay, "files_pending_overlay_db_can_join_step")
					.mockImplementation(async (ctx, factor) => {
						const allowed = await canJoin(ctx, factor);
						const slot = await ctx.db.query("files_move_workspace_slots").first();
						return allowed && !slot?.cohortId;
					});
				try {
					const started = await asOwner.mutation(api.files_transfer.accept_input, {
						membershipId: db.membershipId,
						requestId: "discard-unrelated-move",
						kind: "move",
						sourceIds: [folders[0]!],
						expectedSourceCount: 1,
						targetParentId: folders[1]!,
					});
					if (started._nay) throw new Error(started._nay.message);
					expect(
						await asOwner.mutation(api.files_transfer.seal, {
							membershipId: db.membershipId,
							runId: started._yay.runId,
						}),
					).toEqual({ _yay: null });
					for (let step = 0; step < 20; step++) {
						const slot = await t.run((ctx) => ctx.db.query("files_move_workspace_slots").first());
						if (slot?.cohortId) break;
						await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
					}
					const slot = await t.run((ctx) => ctx.db.query("files_move_workspace_slots").first());
					expect(slot?.cohortId, "native Move owns the workspace before Discard").toBeTruthy();
				} finally {
					join.mockRestore();
				}
			}

			const { result, cost } = await asOwner.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runMutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: db.membershipId,
					target: { kind: "private", id: root.node._id },
					pendingUpdateId: root.proposal._id,
					reviewedRevision: root.proposal.revision,
				});
				return { result, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
			});
			console.info(
				`discard_file_pending_update, 256 private nodes, depth ${depth}, frames ${frameCount}, chats ${threadCount}`,
				cost,
			);

			expect(result).toEqual({ _yay: null });
			const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			expect(nodes.filter((node) => node.state !== "discarded")).toEqual([]);
			expect_under_convex_limits(cost);
			if (unrelatedMove)
				await finish_scheduled(
					t,
					async () => await t.run(async (ctx) => (await ctx.db.query("files_pending_overlay_jobs").first()) === null),
				);
			await t.run(async (ctx) => {
				expect(
					await ctx.db
						.query("files_pending_hides")
						.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", claimed._id).eq("userId", scope.userId))
						.unique(),
				).toBeNull();
				expect(await ctx.db.query("files_pending_type_entries").collect()).toEqual([]);
				expect(await ctx.db.query("files_pending_places").collect()).toEqual([]);
				expect(await ctx.db.query("files_pending_list_rows").collect()).toEqual([]);
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.run(async (ctx) => {
				expect(await ctx.db.query("files_pending_nodes").collect()).toEqual([]);
				expect(await ctx.db.query("files_pending_updates").collect()).toEqual([]);
				expect(await ctx.db.query("files_pending_overlay_resolve_work").collect()).toEqual([]);
				expect(await ctx.db.query("files_pending_overlay_jobs").collect()).toEqual([]);
				expect(await files_type_query_db_get_readiness(ctx.db, scope)).toEqual({ state: "ready" });
			});
		},
		120_000,
	);

	test("closing a private draft clears stored resolver work in counted pages", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/note.md",
			kind: "file",
		});
		if (created._nay) throw new Error(created._nay.message);
		const proposal = (await t.run((ctx) => ctx.db.query("files_pending_updates").unique()))!;
		await start_unfinished_work(t, [proposal], 258);
		expect(
			await asOwner.mutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: db.membershipId,
				target: proposal.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			}),
		).toEqual({ _yay: null });
		await t.run(async (ctx) => {
			expect((await ctx.db.query("files_pending_nodes").unique())?.state).toBe("discarded");
			expect(await ctx.db.query("files_pending_list_rows").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_places").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_type_entries").collect()).toEqual([]);
			const work = await ctx.db.query("files_pending_overlay_resolve_work").collect();
			expect(work.length).toBeGreaterThan(0);
			expect(await files_type_query_db_get_readiness(ctx.db, scope)).toEqual({ state: "updating" });
		});
		const listed = await t.query(internal.files_visible.internal_list_children_places, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			visibilityUserId: scope.userId,
			subject: { kind: "user", userId: scope.userId, plugin: null },
			folderPath: "/",
			orderBy: "name",
			order: "asc",
			numItems: 10,
			position: { cursor: null, lastKey: null, rangeStart: null },
		});
		expect(listed._nay).toBeUndefined();
		expect(listed._yay?.rows).toEqual([]);
		const unfinished: number[] = [];
		test_spy_handler(run_overlay_job, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			const work = await ctx.db.query("files_pending_overlay_resolve_work").collect();
			if (work.length > 0) {
				unfinished.push(work.length);
				expect(await files_type_query_db_get_readiness(ctx.db, scope)).toEqual({ state: "updating" });
			}
			return result;
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(unfinished.length).toBeGreaterThan(0);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_pending_overlay_resolve_work").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_overlay_jobs").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_type_entries").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_places").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_updates").collect()).toEqual([]);
			expect(await files_type_query_db_get_readiness(ctx.db, scope)).toEqual({ state: "ready" });
		});
	});

	test("discarding a private file restores a claimed folder before its child path work finishes", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const { folder, other, membershipId } = await test_run_with_flush(t, async (ctx) => {
			const other = await add_member(ctx, db, "clerk_claim_other");
			const folder = await insert_saved_node(ctx, db, {
				parent: null,
				name: "old",
				kind: "folder",
				createdBy: other,
			});
			await insert_saved_node(ctx, db, { parent: folder, name: "g", kind: "folder", createdBy: other });
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", other)
						.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId),
				)
				.unique();
			return { folder, other, membershipId: membership!._id };
		});
		const nested = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/old/g/note.md",
			kind: "file",
		});
		if (nested._nay) throw new Error(nested._nay.message);
		const claimant = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/claimed",
			kind: "file",
		});
		if (claimant._nay) throw new Error(claimant._nay.message);
		expect(
			(
				await test_rename_node(t, t.withIdentity({ issuer: "https://clerk.test", external_id: other }), {
					membershipId,
					nodeId: folder._id,
					path: "claimed",
				})
			)._nay,
		).toBeUndefined();
		await finish_scheduled(
			t,
			async () => await t.run(async (ctx) => (await ctx.db.query("files_pending_overlay_jobs").first()) === null),
		);
		const proposal = await t.run(async (ctx) => {
			expect(
				await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", folder._id).eq("userId", scope.userId))
					.unique(),
			).not.toBeNull();
			expect(
				await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) =>
						q
							.eq("target.kind", nested._yay.target.kind)
							.eq("target.id", nested._yay.target.id)
							.eq("userId", scope.userId),
					)
					.unique(),
			).toMatchObject({ isVisible: false });
			return (await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q
						.eq("userId", scope.userId)
						.eq("target.kind", claimant._yay.target.kind)
						.eq("target.id", claimant._yay.target.id),
				)
				.unique())!;
		});
		const create = resolver.files_visible_resolve_db_create;
		const spy = vi.spyOn(resolver, "files_visible_resolve_db_create").mockImplementation((readerDb, args) => {
			const reader = create(readerDb, args);
			return {
				...reader,
				resolveFacts: (target, budget, options) =>
					options?.claimOnly ? reader.resolveFacts(target, budget, options) : Promise.resolve(null),
				resume: (operation, options) => reader.resume(operation, { ...options, stepLimit: 1 }),
			};
		});
		try {
			expect(
				await asOwner.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: db.membershipId,
					target: proposal.target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				}),
			).toEqual({ _yay: null });
		} finally {
			spy.mockRestore();
		}
		await t.run(async (ctx) => {
			expect(
				await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", folder._id).eq("userId", scope.userId))
					.unique(),
			).toBeNull();
			const jobs = await ctx.db.query("files_pending_overlay_jobs").collect();
			expect(
				jobs.some(
					(job) =>
						job.kind === "targets" && job.items.some((item) => item.target.id === folder._id && item.ownerPathPending),
				),
			).toBe(true);
			expect(await files_type_query_db_get_readiness(ctx.db, scope)).toEqual({ state: "updating" });
		});
		await finish_scheduled(
			t,
			async () => await t.run(async (ctx) => (await ctx.db.query("files_pending_overlay_jobs").first()) === null),
		);
		await t.run(async (ctx) => {
			expect(
				await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) =>
						q
							.eq("target.kind", nested._yay.target.kind)
							.eq("target.id", nested._yay.target.id)
							.eq("userId", scope.userId),
					)
					.unique(),
			).toMatchObject({ ownerTreePath: "/claimed/g/note.md", isVisible: true });
			expect(
				await ctx.db
					.query("files_pending_type_entries")
					.withIndex("by_target_user", (q) =>
						q
							.eq("target.kind", nested._yay.target.kind)
							.eq("target.id", nested._yay.target.id)
							.eq("userId", scope.userId),
					)
					.unique(),
			).toMatchObject({ ownerTreePath: "/claimed/g/note.md", isVisible: true });
			expect(await ctx.db.query("files_pending_overlay_resolve_work").collect()).toEqual([]);
			expect(await files_type_query_db_get_readiness(ctx.db, scope)).toEqual({ state: "ready" });
		});
	});
});

describe("hard delete", () => {
	// The flush's inline part of a hard delete reads the node's hides and places and at most one
	// proposal (`.first()`); the saved node job then pages the proposals. So no hard-delete batch
	// counts proposals. This measures the inline part for 25 nodes with drafts of 5 users, then of 20
	// users: the ranges per node stay the same.
	const hard_delete_cost = async (userCount: number) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const seeded = await t.run(async (ctx) => {
			const a = await insert_saved_node(ctx, db, { parent: null, name: "a", kind: "folder" });
			const b = await insert_saved_node(ctx, db, { parent: null, name: "b", kind: "folder" });
			const files: Doc<"files_nodes">[] = [];
			for (let index = 0; index < 25; index++) {
				const file = await insert_saved_node(ctx, db, { parent: a, name: `note-${index}.md`, kind: "file" });
				await ctx.db.patch("files_nodes", file._id, { archiveOperationId: "archive-op" });
				files.push(file);
			}
			const userIds: Id<"users">[] = [];
			for (let index = 0; index < userCount; index++)
				userIds.push(await add_member(ctx, db, `clerk_hard_delete_${index}`));
			return { b, files, userIds };
		});
		// Each user drafts a move of every node into /b. One flush per user writes the places.
		for (const userId of seeded.userIds)
			await test_run_with_flush(t, async (ctx) => {
				for (const file of seeded.files)
					await ctx.db.insert("files_pending_updates", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userId,
						target: { kind: "saved", id: file._id },
						revision: 1,
						size: 0,
						updatedAt: Date.now(),
						expiresAt: Date.now() + 60 * 60 * 1000,
						pendingMove: { destParent: { kind: "saved", id: seeded.b._id }, destName: file.name, fromPath: file.path },
					});
			});
		const places_of_files = () =>
			t.run(async (ctx) => {
				const places = [];
				for (const file of seeded.files)
					places.push(
						...(await ctx.db
							.query("files_pending_places")
							.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", file._id))
							.collect()),
					);
				return places;
			});
		expect(await places_of_files()).toHaveLength(25 * userCount);

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			for (const file of seeded.files) await ctx.db.delete("files_nodes", file._id);
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info(`hard delete, 25 archived nodes with drafts of ${userCount} users each`, cost);
		expect_under_convex_limits(cost);

		// The saved node jobs remove the places of the deleted nodes.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await places_of_files()).toEqual([]);
		return cost;
	};

	test("hard deletes 25 archived nodes with the same ranges for drafts of 5 or 20 users", async () => {
		const few = await hard_delete_cost(5);
		const many = await hard_delete_cost(20);
		expect(many.databaseQueries).toBe(few.databaseQueries);
	}, 120_000);
});

describe("saved scope job", () => {
	// Full-size files have more than 16 chunks, so Archive and Restore patch only their nodes. The saved
	// scope job then copies the new scope onto each file's saved chunks and metadata docs, one page per run.
	test("keeps Archive and Restore of two full-size files at the longest path under the budget", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folder = `/${Array.from({ length: 3 }, (_, index) => String(index).repeat(files_NAME_MAX_LENGTH)).join("/")}`;
		const body = Array.from({ length: files_MAX_TEXT_CONTENT_BYTES / 16 - 200 }, (_, index) =>
			index.toString(36).padStart(15, "-"),
		).join("\n");
		const nodeIds: Id<"files_nodes">[] = [];
		for (const letter of ["e", "f"]) {
			const path = `${folder}/${letter.repeat(files_NAME_MAX_LENGTH - 3)}.md`;
			expect(path).toHaveLength(files_PATH_MAX_LENGTH);
			const nodeId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path, textContent: "x" });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			// A real Save of this size is slow in tests.
			await t.run((ctx) =>
				db_replace_file_chunks(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId,
					textContent: body,
				}),
			);
			// The most metadata one file can have, like the metadata catalog test below.
			await test_run_with_flush(t, async (ctx) => {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				for (const namespace of ["frontmatter", "metadata"] as const)
					for (let key = 0; key < 128; key++) {
						const prefix = `${namespace}.k${key}-`;
						const base = {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							sourceKind: "committed" as const,
							fileNodeId: nodeId,
							path: node.path,
							treePath: node.treePath,
							restrictedScopeNodeId: node.restrictedScopeNodeId,
							fieldPath: prefix + "x".repeat(160 - prefix.length),
						};
						await ctx.db.insert("files_metadata_docs", {
							...base,
							docKind: "field",
							...files_metadata_committed_field_sort_fields(node, []),
						});
						for (let value = 0; value < (namespace === "frontmatter" ? 3 : 2); value++) {
							const head = `k${key}v${value}-`;
							await ctx.db.insert("files_metadata_docs", {
								...base,
								docKind: "value",
								valueKind: "string",
								stringValue: head + "v".repeat(1024 - head.length),
							});
						}
					}
			});
			nodeIds.push(nodeId);
		}
		// Each file's saved docs whose path or archive state differs from the node.
		const stale_docs = (nodeId: Id<"files_nodes">) =>
			t.run(async (ctx) => {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				const archiveOperationId = node.archiveOperationId ?? undefined;
				const chunks = await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect();
				const metadata = await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", nodeId),
					)
					.collect();
				expect(chunks.length).toBeGreaterThan(700);
				expect(metadata).toHaveLength(896);
				return [...chunks, ...metadata].filter(
					(doc) => doc.path !== node.path || doc.archiveOperationId !== archiveOperationId,
				).length;
			});

		const { peaks, record } = budget_recorder();
		for (const [registered, phase] of [
			[archive_nodes, "archive"],
			[unarchive_nodes, "restore"],
		] as const)
			test_spy_handler(registered, async (handler, ctx, args) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await handler(ctx, args);
				record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
				return result;
			});
		test_spy_handler(run_overlay_job, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			if ((args as { kind: string }).kind === "saved_scope")
				record("saved scope job", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		for (const mutation of [api.files_nodes.archive_nodes, api.files_nodes.unarchive_nodes]) {
			expect(await asOwner.mutation(mutation, { membershipId: db.membershipId, nodeIds })).toEqual({ _yay: null });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			for (const nodeId of nodeIds) expect(await stale_docs(nodeId), "every saved doc follows its node").toBe(0);
		}
		expect(peaks.get("saved scope job")?.calls).toBeGreaterThan(8);
		console.info("saved scope job at the longest path", JSON.stringify(Object.fromEntries(peaks)));
	}, 600_000);
});

describe("metadata catalog", () => {
	// The most catalog work one node can cause: 896 committed metadata docs (128 frontmatter keys with
	// 3 values, 128 metadata keys with 2 values), each key 160 characters and each value 1,024 bytes,
	// the longest that still count. Every doc makes its own delta, so this is also the byte peak. Each
	// key and value also counts in its area's rows.
	test("measures create, full replacement, archive, restore, restrict and the compactor at maximum delta sizes", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const node = await t.run((ctx) => insert_saved_node(ctx, db, { parent: null, name: "max", kind: "folder" }));
		const docs = (round: number) =>
			(["frontmatter", "metadata"] as const).flatMap((namespace) =>
				Array.from({ length: 128 }, (_, key) => {
					const prefix = `${namespace}.r${round}k${key}-`;
					const fieldPath = prefix + "x".repeat(160 - prefix.length);
					const base = {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						sourceKind: "committed" as const,
						fileNodeId: node._id,
						path: node.path,
						treePath: node.treePath,
						fieldPath,
						restrictedScopeNodeId: null,
					};
					return [
						{ ...base, docKind: "field" as const, parentId: files_ROOT_ID, isRestrictedScopeRoot: false },
						...Array.from({ length: namespace === "frontmatter" ? 3 : 2 }, (_, value) => {
							const head = `r${round}k${key}v${value}-`;
							return {
								...base,
								docKind: "value" as const,
								valueKind: "string" as const,
								stringValue: head + "v".repeat(1024 - head.length),
							};
						}),
					];
				}).flat(),
			);
		expect(docs(0)).toHaveLength(896);
		const { peaks, record } = budget_recorder();
		const measure = async (phase: string, write: (ctx: MutationCtx) => Promise<void>) =>
			await test_run_with_flush(t, async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				await write(ctx);
				await files_pending_overlay_db_flush(ctx);
				record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			});
		const all_docs = (ctx: MutationCtx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", node._id),
				)
				.collect();
		test_spy_handler(compact_metadata_catalog, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("catalog/compactor", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const compact = async () => {
			for (let run = 0; run < 100; run++) {
				vi.setSystemTime(Date.now() + 5001);
				const marker = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").first());
				if (!marker) return;
				await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker._id });
			}
			throw new Error("The catalog compactor did not drain");
		};
		const count = (table: "files_metadata_catalog" | "files_metadata_catalog_deltas") =>
			t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

		await measure("catalog/create", async (ctx) => {
			for (const doc of docs(0)) await ctx.db.insert("files_metadata_docs", doc);
		});
		expect(await count("files_metadata_catalog_deltas")).toBe(2048);
		await compact();
		expect(await count("files_metadata_catalog")).toBe(2048);
		await measure("catalog/replace", async (ctx) => {
			for (const doc of await all_docs(ctx)) await ctx.db.delete("files_metadata_docs", doc._id);
			for (const doc of docs(1)) await ctx.db.insert("files_metadata_docs", doc);
		});
		expect(await count("files_metadata_catalog_deltas")).toBe(4096);
		await compact();
		// Each archive or restore patch reads its doc first, like the scope helper's own query.
		await measure("catalog/archive", async (ctx) => {
			for (const doc of await all_docs(ctx))
				await ctx.db.patch("files_metadata_docs", doc._id, { archiveOperationId: "archive-op" });
		});
		await compact();
		expect(await count("files_metadata_catalog")).toBe(0);
		await measure("catalog/restore", async (ctx) => {
			for (const doc of await all_docs(ctx))
				await ctx.db.patch("files_metadata_docs", doc._id, { archiveOperationId: undefined });
		});
		await compact();
		expect(await count("files_metadata_catalog")).toBe(2048);
		// A restrict of the node itself: every doc moves to the node's area, and its keys to
		// `parent_restricted`.
		await measure("catalog/restrict", async (ctx) => {
			await files_metadata_db_patch_file_scope(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId: node._id,
				isRestrictedScopeRoot: true,
				restrictedScopeNodeId: node._id,
			});
		});
		expect(await count("files_metadata_catalog_deltas")).toBe(2304);
		await compact();
		expect(await count("files_metadata_catalog")).toBe(2048);
		console.info("metadata catalog peaks at maximum delta sizes", JSON.stringify(Object.fromEntries(peaks)));
		expect(peaks.get("catalog/compactor")?.measured.documentsRead).toBeGreaterThan(1000);
	}, 600_000);
});

describe("content save", () => {
	// A content save patches the file node, so the flush rewrites every share row of a shared file
	// that is a restricted root (see `share_100_times`).
	test("saves a shared file with 100 shares", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const file = await t.run(async (ctx) => {
			const file = await insert_saved_node(ctx, db, { parent: null, name: "shared.md", kind: "file" });
			await ctx.db.patch("files_nodes", file._id, { restrictedScopeNodeId: file._id, isRestrictedScopeRoot: true });
			return file;
		});
		await share_100_times(t, db, file._id);

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			// The node fields a content save patches in files_nodes_content.ts, without the new asset.
			await ctx.db.patch("files_nodes", file._id, {
				contentByteSize: 2048,
				updatedBy: db.userId,
				updatedAt: Date.now() + 1000,
			});
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info("content save, a shared file with 100 shares", cost);

		const rows = await t.run((ctx) => ctx.db.query("files_share_rows").collect());
		expect(rows).toHaveLength(100);
		expect(rows.every((row) => row.contentByteSize === 2048)).toBe(true);
		expect_under_convex_limits(cost);
	}, 120_000);

	// A rename of a folder changes the `treePath` of every node below it. A job that writes a shared
	// folder's new path (a restore, a scope job) does it through the flush, which rewrites every share
	// row of the folder.
	test("rewrites the paths of a shared folder with 100 shares after its parent's rename", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const { parent, shared } = await t.run(async (ctx) => {
			const parent = await insert_saved_node(ctx, db, { parent: null, name: "p", kind: "folder" });
			const shared = await insert_saved_node(ctx, db, { parent, name: "shared", kind: "folder" });
			await ctx.db.patch("files_nodes", shared._id, { restrictedScopeNodeId: shared._id, isRestrictedScopeRoot: true });
			return { parent, shared };
		});
		await share_100_times(t, db, shared._id);
		const renamed = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", parent._id, {
				name: "p2",
				sortName: files_sort_text_key("p2"),
				path: "/p2",
				treePath: "/p2/",
			});
			return (await ctx.db.get("files_nodes", parent._id))!;
		});

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			await files_nodes_db_rebuild_node(ctx, { node: (await ctx.db.get("files_nodes", shared._id))!, parent: renamed });
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info("path rewrite, a shared folder with 100 shares", cost);

		const rows = await t.run((ctx) => ctx.db.query("files_share_rows").collect());
		expect(rows).toHaveLength(100);
		expect(rows.every((row) => row.treePath === "/p2/shared/")).toBe(true);
		expect_under_convex_limits(cost);
	}, 120_000);
});
