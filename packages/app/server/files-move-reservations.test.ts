import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { Doc as YjsDoc, encodeStateAsUpdate } from "yjs";
import { files_u8_to_array_buffer, files_YJS_DOC_KEYS } from "../shared/files.ts";
import { r2_create_asset_key } from "../convex/r2_client.ts";
import { test_mocks } from "../convex/setup.test.ts";
import { test_create_saved_placement_fixture as fixture } from "./files-saved-placement.test-fixtures.ts";
import {
	files_move_reservations_db_check,
	files_move_reservations_db_enter,
	files_move_reservations_db_enter_security,
	files_move_reservations_db_find_blocker,
	files_move_reservations_db_is_rename_allocation,
	files_move_reservations_db_note_source,
	files_move_reservations_db_pause_worker,
	files_move_reservations_db_take_waiters,
	files_move_reservations_db_wrap,
} from "./files-move-reservations.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("move-reservations-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
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

describe("Move write reservations", () => {
	test("protects an exact source and a claimed empty slot, while other names stay writable", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		expect(
			await f.t.run((ctx) => files_move_reservations_db_check(ctx.db, { source: { kind: "saved", id: f.nodeId } })),
		).toMatchObject({ _nay: { name: "move_busy" } });
		expect(
			await f.t.run((ctx) =>
				files_move_reservations_db_find_blocker(ctx.db, {
					slot: { ...f.db, parentId: f.parentId, name: "new.txt" },
				}),
			),
		).toBe(f.cohortId);
		expect(
			await f.t.run((ctx) =>
				files_move_reservations_db_check(ctx.db, {
					parent: { kind: "saved", id: f.parentId },
					slot: { ...f.db, parentId: f.parentId, name: "other.txt" },
				}),
			),
		).toEqual({ _yay: null });
		await expect(
			f.t.run(async (ctx) => {
				const guarded = files_move_reservations_db_wrap(ctx);
				await guarded.db.patch("files_nodes", f.nodeId, { name: "changed.txt" });
			}),
		).rejects.toThrow("This item is being moved");
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.name).toBe("old.txt");
	});

	test("protects descendants only when their ancestor reserves its subtree", async () => {
		const f = await fixture();
		const reservationId = await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.parentId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		const childId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: f.parentId,
				name: "child",
				sortName: "child",
				path: "/target/child",
				treePath: "/target/child/",
				pathDepth: 2,
			}),
		);
		const read = () =>
			f.t.run((ctx) => files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: childId } }));
		expect(await read()).toBeNull();
		await f.t.run((ctx) => ctx.db.patch("files_move_source_reservations", reservationId, { mode: "subtree" }));
		expect(await read(), "a reserved ancestor blocks a child write").toBe(f.cohortId);
	});

	test("keeps staging narrow and rejects old fences before a physical source write", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		const enter = { cohortId: f.cohortId, fence: 1, attemptFence: 1, mode: "stage" as const };
		expect(
			await f.t.run(async (ctx) =>
				files_move_reservations_db_enter(
					{ ...ctx, ...files_move_reservations_db_wrap(ctx) },
					{
						...enter,
						attemptFence: 0,
					},
				),
			),
		).toMatchObject({ _nay: { name: "stopped" } });
		await expect(
			f.t.run(async (ctx) => {
				const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
				expect(await files_move_reservations_db_enter(guarded, enter)).toEqual({ _yay: null });
				await guarded.db.patch("files_nodes", f.nodeId, { name: "changed.txt" });
			}),
		).rejects.toThrow("This item is being moved");
		await f.t.run(async (ctx) => {
			const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
			expect(await files_move_reservations_db_enter(guarded, enter)).toEqual({ _yay: null });
			expect(
				await files_move_reservations_db_check(guarded.db, { source: { kind: "saved", id: f.nodeId } }),
				"the current internal stage can check its own reserved source",
			).toEqual({ _yay: null });
			await guarded.db.patch("files_nodes", f.nodeId, { moveCohortId: f.cohortId });
		});
		await f.publish();
		await f.t.run(async (ctx) => {
			const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
			expect(await files_move_reservations_db_enter(guarded, { ...enter, mode: "finish" })).toEqual({ _yay: null });
			await guarded.db.patch("files_nodes", f.nodeId, { name: "new.txt", parentId: f.parentId });
		});
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.name).toBe("new.txt");
	});

	test("allows abort cleanup only while the old saved view is still visible", async () => {
		const f = await fixture();
		const enter = { cohortId: f.cohortId, fence: 1, attemptFence: 1, mode: "abort" as const };
		const check = () =>
			f.t.run((ctx) => files_move_reservations_db_enter({ ...ctx, ...files_move_reservations_db_wrap(ctx) }, enter));
		expect(await check()).toMatchObject({ _nay: { name: "stopped" } });
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "aborting" }));
		expect(await check()).toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) =>
				files_move_reservations_db_enter(
					{ ...ctx, ...files_move_reservations_db_wrap(ctx) },
					{ ...enter, mode: "stage" },
				),
			),
		).toMatchObject({ _nay: { name: "stopped" } });
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { visibleView: "after" }));
		expect(await check(), "abort never restores an already published group").toMatchObject({
			_nay: { name: "stopped" },
		});
	});

	test("allocates only a reserved private source as an after-only saved node", async () => {
		const f = await fixture();
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			kind: "folder",
			path: "/private-output",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private draft");
		const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (proposal?.target.kind !== "private") throw new Error("Expected the private source");
		const privateNodeId = proposal.target.id;
		const node = {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			parentId: f.parentId,
			name: "new.txt",
			sortName: "new.txt",
			path: "/target/new.txt",
			treePath: "/target/new.txt/",
			pathDepth: 2,
			moveCohortId: f.cohortId,
			publishedFromPrivateNodeId: privateNodeId,
		};
		const allocate = (marker = true) =>
			f.t.run(async (ctx) => {
				const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
				expect(
					await files_move_reservations_db_enter(guarded, {
						cohortId: f.cohortId,
						fence: 1,
						attemptFence: 1,
						mode: "stage",
					}),
				).toEqual({ _yay: null });
				return await guarded.db.insert("files_nodes", { ...node, moveCohortId: marker ? f.cohortId : undefined });
			});
		await expect(allocate()).rejects.toThrow("This item is being moved");
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "private", id: privateNodeId },
				mode: "receipt",
				userId: f.db.userId,
				generation: 1,
			}),
		);
		await expect(allocate(false)).rejects.toThrow("This item is being moved");
		const allocation = allocate();
		await expect(allocation, "the exact reserved private source can allocate its after-only node").resolves.toBeTypeOf(
			"string",
		);
		const nodeId = await allocation;
		expect(
			await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)),
			"the exact reserved private source can allocate its after-only node",
		).toMatchObject({ moveCohortId: f.cohortId, publishedFromPrivateNodeId: privateNodeId });
		await expect(
			f.t.run(async (ctx) => {
				const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
				expect(
					await files_move_reservations_db_enter(guarded, {
						cohortId: f.cohortId,
						fence: 1,
						attemptFence: 1,
						mode: "stage",
					}),
				).toEqual({ _yay: null });
				await guarded.db.patch("files_nodes", nodeId, { name: "another.txt" });
			}),
		).rejects.toThrow("This item is being moved");
	});

	test("allocates only the current accepted rename parent", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			const item = (await ctx.db.get("files_transfer_items", f.itemId))!;
			await ctx.db.patch("files_transfer_runs", item.runId, {
				revision: 1,
				origin: { kind: "rename" },
				rename: {
					inputPath: "missing/final.txt",
					source: { parentId: "root", name: "old.txt", path: "/old.txt", archiveOperationId: null },
					parentPath: "/target",
					parentArchiveOperationId: null,
				},
			});
			await ctx.db.patch("files_transfer_items", item._id, { state: "pending", attempt: 1 });
			await ctx.db.patch("files_move_cohorts", f.cohortId, {
				workPhase: "rename_parents",
				planningCursor: JSON.stringify({
					segmentIndex: 0,
					parentId: f.parentId,
					parentPath: "/target",
					parentArchiveOperationId: null,
				}),
			});
		});
		const node = {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			parentId: f.parentId,
			name: "missing",
			sortName: "missing",
			path: "/target/missing",
			treePath: "/target/missing/",
			pathDepth: 2,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			moveCohortId: f.cohortId,
			newChildWritePolicy: null,
		};
		const allocate = (value = node) =>
			f.t.run(async (ctx) => {
				const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
				expect(
					await files_move_reservations_db_enter(guarded, {
						cohortId: f.cohortId,
						fence: 1,
						attemptFence: 1,
						mode: "stage",
					}),
				).toEqual({ _yay: null });
				return await guarded.db.insert("files_nodes", value);
			});
		expect(
			await f.t.run((ctx) => files_move_reservations_db_is_rename_allocation(ctx.db, { cohortId: f.cohortId, node })),
		).toBe(true);
		await expect(allocate({ ...node, name: "another" })).rejects.toThrow("This item is being moved");
		await expect(allocate({ ...node, contentType: "text/plain" })).rejects.toThrow("This item is being moved");
		await expect(allocate(), "the accepted rename segment can allocate its empty folder").resolves.toBeTypeOf("string");
		await f.t.run((ctx) =>
			ctx.db.patch("files_move_cohorts", f.cohortId, {
				planningCursor: JSON.stringify({
					segmentIndex: 1,
					parentId: f.parentId,
					parentPath: "/target",
					parentArchiveOperationId: null,
				}),
			}),
		);
		await expect(allocate(), "a final leaf is never a derived parent").rejects.toThrow("This item is being moved");
	});

	test("keeps one durable accepted-worker waiter across retries and removes stale waits", async () => {
		const f = await fixture();
		const reservationId = await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		const worker = {
			kind: "upload" as const,
			id: f.saved.assetId!,
			resume: { kind: "conversion" as const, eventId: "accepted-upload" },
		};
		const pause = () =>
			f.t.run((ctx) =>
				files_move_reservations_db_pause_worker(ctx, {
					worker,
					check: { source: { kind: "saved", id: f.nodeId } },
				}),
			);
		expect(await pause()).toBe(true);
		expect(await pause()).toBe(true);
		const page = await f.t.run((ctx) =>
			files_move_reservations_db_take_waiters(ctx, { cohortId: f.cohortId, numItems: 20 }),
		);
		expect(page.page).toHaveLength(1);
		expect(page.page[0]?.worker).toEqual(worker);
		await f.t.run(async (ctx) => {
			await ctx.db.delete("files_move_source_reservations", reservationId);
			for (const claim of await ctx.db
				.query("files_move_slot_claims")
				.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
				.collect())
				await ctx.db.delete("files_move_slot_claims", claim._id);
		});
		expect(await pause()).toBe(false);
		expect(
			(await f.t.run((ctx) => files_move_reservations_db_take_waiters(ctx, { cohortId: f.cohortId, numItems: 20 })))
				.page,
		).toEqual([]);
	});

	test("allows only the named node's live security fields", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		await f.t.run(async (ctx) => {
			const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
			files_move_reservations_db_enter_security(guarded, { nodeId: f.nodeId });
			expect(await files_move_reservations_db_check(guarded.db, { source: { kind: "saved", id: f.nodeId } })).toEqual({
				_yay: null,
			});
			expect(
				await files_move_reservations_db_check(guarded.db, {
					source: { kind: "saved", id: f.nodeId },
					slot: { ...f.db, parentId: f.parentId, name: "new.txt" },
				}),
			).toMatchObject({ _nay: { name: "move_busy" } });
			await guarded.db.patch("files_nodes", f.nodeId, { writePolicy: { mode: "read_only" } });
		});
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.writePolicy).toEqual({ mode: "read_only" });
		await expect(
			f.t.run(async (ctx) => {
				const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
				files_move_reservations_db_enter_security(guarded, { nodeId: f.nodeId });
				await guarded.db.patch("files_nodes", f.nodeId, { contentByteSize: 100 });
			}),
		).rejects.toThrow("This item is being moved");
	});

	test("a public protection change stays live and invalidates old proof during a Move", async () => {
		const f = await fixture();
		const before = await f.t.run((ctx) =>
			ctx.db
				.query("files_media_validation_versions")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique(),
		);
		expect(
			await f.asUser.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });
		expect(
			(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.writePolicy,
			"the current public policy change commits while placement is reserved",
		).toEqual({ mode: "read_only" });
		const after = await f.t.run((ctx) =>
			ctx.db
				.query("files_media_validation_versions")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique(),
		);
		expect(after?.revision).toBe((before?.revision ?? 0) + 1);
	});

	test("a known scope never bypasses a current workspace reservation", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		await expect(
			f.t.run(async (ctx) => {
				const guarded = files_move_reservations_db_wrap(ctx);
				files_move_reservations_db_note_source(guarded.db, { table: "files_nodes", id: f.nodeId, old: f.saved });
				await guarded.db.patch("files_nodes", f.nodeId, { name: "changed.txt" });
			}),
		).rejects.toThrow("This item is being moved");
	});

	test("public unrestrict inherits each saved placement's current parent scope", async () => {
		const f = await fixture();
		for (const nodeId of [f.parentId, f.nodeId])
			expect(
				await f.asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId,
				}),
			).toEqual({ _yay: null });
		const places = () =>
			f.t.run((ctx) =>
				ctx.db
					.query("files_saved_places")
					.withIndex("by_cohort_view_node", (q) => q.eq("cohortId", f.cohortId))
					.collect(),
			);
		expect((await places()).map((place) => place.restrictedScopeNodeId)).toEqual([f.nodeId, f.nodeId]);
		expect(
			await f.asUser.mutation(api.files_sharing.unrestrict_node, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(
			(await places()).map((place) => [place.view, place.restrictedScopeNodeId]).sort(),
			"unrestrict uses each candidate's own parent now",
		).toEqual([
			["after", f.parentId],
			["before", null],
		]);
	});

	test("a native accepted content job pauses before a failure marker and keeps its author", async () => {
		const f = await fixture();
		const slot = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique(),
		);
		if (!slot || !f.saved.yjsLastSequenceId) throw new Error("Expected saved fixture input");
		// Produce accepted work before installing the inactive future cohort's reservation.
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_move_workspace_slots", slot._id, { cohortId: null });
			await ctx.db.patch("files_nodes", f.nodeId, { moveCohortId: undefined });
		});
		const doc = new YjsDoc();
		doc.getText(files_YJS_DOC_KEYS.plainText).insert(0, "queued text");
		expect(
			(
				await f.asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: f.db.membershipId,
					nodeId: f.nodeId,
					expectedYjsLastSequenceId: f.saved.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(doc)),
					sessionId: "accepted-before-move",
				})
			)._nay,
		).toBeUndefined();
		doc.destroy();
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_content_materialization_jobs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", f.nodeId))
				.unique(),
		);
		if (!job) throw new Error("Expected the native content job");
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_move_workspace_slots", slot._id, { cohortId: f.cohortId });
			await ctx.db.patch("files_nodes", f.nodeId, { moveCohortId: f.cohortId });
			await ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			});
		});
		await expect(
			f.t.mutation(internal.files_nodes_content.mark_file_content_too_large, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				nodeId: f.nodeId,
				userId: f.db.userId,
				expectedYjsLastSequenceId: f.saved.yjsLastSequenceId,
				sequence: job.targetSequence,
				targetSequence: job.targetSequence,
				byteSize: 5_000_000,
			}),
			"accepted content pauses before any guarded failure write",
		).resolves.toBeNull();
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.contentTooLargeByteSize).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_content_materialization_jobs", job._id))).not.toBeNull();
		const waiter = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_waiters")
				.withIndex("by_worker", (q) => q.eq("worker.kind", "content").eq("worker.id", job._id))
				.unique(),
		);
		expect(waiter?.worker).toEqual({ kind: "content", id: job._id, userId: f.db.userId });
	});

	test("a native accepted Yjs cleanup waits before history and old asset cleanup", async () => {
		// The fixture holds the Move slot, and a Save waits for it. Create the file before that.
		const f = await fixture({ normalPaths: ["/cleanup.txt"] });
		const nodeId = f.normalNodes.get("/cleanup.txt")!;
		expect(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		const task = await f.t.run((ctx) =>
			ctx.db
				.query("files_yjs_cleanup_tasks")
				.withIndex("by_organization_workspace_fileNode_historyPending", (q) =>
					q
						.eq("organizationId", f.db.organizationId)
						.eq("workspaceId", f.db.workspaceId)
						.eq("fileNodeId", nodeId)
						.eq("historyPending", true),
				)
				.unique(),
		);
		if (!task) throw new Error("Expected the accepted cleanup task");
		await f.stageNode(nodeId);
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		expect(await f.t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id })).toBeNull();
		expect(
			await f.t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)),
			"accepted cleanup stays durable while its source is reserved",
		).toEqual(task);
		expect(
			await f.t.run((ctx) => ctx.db.get("files_r2_assets", task.supersededYjsAssetId)),
			"a waiting cleanup keeps its old asset until it can recheck references",
		).not.toBeNull();
		const waiter = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_waiters")
				.withIndex("by_worker", (q) => q.eq("worker.kind", "yjs_task").eq("worker.id", task._id))
				.unique(),
		);
		expect(waiter?.worker).toEqual({ kind: "yjs_task", id: task._id });
	});

	test("an accepted upload event keeps its exact input while its saved source is reserved", async () => {
		const f = await fixture();
		const created = await f.asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			filename: "accepted.png",
			contentType: "image/png",
			size: 12,
		});
		if (created._nay) throw new Error(created._nay.message);
		const { nodeId, assetId } = created._yay;
		await f.stageNode(nodeId);
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		const event = {
			assetId,
			r2Key: r2_create_asset_key({ ...f.db, assetId }),
			size: 11,
			etag: "accepted-etag",
			eventId: "accepted-event",
		};
		expect(await f.t.mutation(internal.r2.process_uploaded_asset_event, event)).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId)))?.r2Key).toBeUndefined();
		expect(
			(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.contentByteSize,
			"the reserved upload does not publish any source fields",
		).toBe(12);
		const waiter = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_waiters")
				.withIndex("by_worker", (q) => q.eq("worker.kind", "upload").eq("worker.id", assetId))
				.unique(),
		);
		const { assetId: _id, ...input } = event;
		expect(waiter?.worker).toEqual({ kind: "upload", id: assetId, resume: { kind: "event", ...input } });
	});

	test("a live folder restriction pauses its accepted descendant repair before the C range", async () => {
		const f = await fixture();
		const created = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: f.parentId,
			path: "/target/child",
		});
		if (created._nay) throw new Error(created._nay.message);
		await f.stageNode(f.parentId);
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.parentId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: f.parentId,
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.parentId)))?.restrictedScopeNodeId).toBe(f.parentId);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", created._yay.nodeId)))?.restrictedScopeNodeId).toBeNull();
		const waiter = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_waiters")
				.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
				.unique(),
		);
		expect(waiter?.worker.kind, "the accepted scope repair waits before reading normal-only children").toBe("subtree");
	});
});
