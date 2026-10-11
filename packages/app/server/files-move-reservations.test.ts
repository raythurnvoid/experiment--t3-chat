import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { Doc as YjsDoc, encodeStateAsUpdate } from "yjs";
import { files_u8_to_array_buffer, files_YJS_DOC_KEYS } from "../shared/files.ts";
import { r2_create_asset_key } from "../convex/r2_client.ts";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { files_private_storage_db_reserve } from "../convex/files_private_storage.ts";
import { test_mocks, test_mocks_fill_db_with, test_run_with_flush } from "../convex/setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
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

	test("refuses a live editor push on a file held by a Move with move_busy", async () => {
		const f = await fixture();
		if (!f.saved.yjsLastSequenceId) throw new Error("Expected saved fixture input");
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		const before = await f.t.run((ctx) => ctx.db.get("files_yjs_docs_last_sequences", f.saved.yjsLastSequenceId!));
		const doc = new YjsDoc();
		doc.getText(files_YJS_DOC_KEYS.plainText).insert(0, "typed during the Move");
		const push = await f.asUser
			.mutation(api.files_nodes.yjs_push_update, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				expectedYjsLastSequenceId: f.saved.yjsLastSequenceId,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(doc)),
				sessionId: "editor-during-move",
			})
			.catch((error: unknown) => error);
		doc.destroy();
		// A thrown error would look like a network error to the editor, which then retries with no message.
		expect(push, "the push answers move_busy instead of throwing").toMatchObject({ _nay: { name: "move_busy" } });
		const after = await f.t.run((ctx) => ctx.db.get("files_yjs_docs_last_sequences", f.saved.yjsLastSequenceId!));
		expect(after?.lastSequence).toBe(before?.lastSequence);
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

	test("the pending-state sweep skips a moved file's retired state until the Move ends", async () => {
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
		const stateId = await f.t.run(async (ctx) => {
			const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId };
			const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				...scope,
				createdAt: Date.now(),
			});
			const id = await ctx.db.insert("files_pending_update_yjs_states", {
				...scope,
				userId: f.db.userId,
				target: { kind: "saved", id: f.nodeId },
				owner: { kind: "retired", cleanupTaskId },
				sealed: true,
				pageCount: 0,
				totalBytes: 0,
				digest: "",
			});
			const held = await files_private_storage_db_reserve(ctx, {
				...scope,
				userId: f.db.userId,
				resource: { kind: "state", id },
				byteCount: 0,
			});
			if (held._nay) throw new Error(held._nay.message);
			return id;
		});
		const sweep = () =>
			f.t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
				_test_disableReschedule: true,
			});
		// A busy row stays for a later pass. The sweep must not fail for every other workspace.
		expect(await sweep()).toMatchObject({ done: true });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_yjs_states", stateId))).not.toBeNull();
		// The Move ends: its reservation goes and the workspace slot is free again.
		await f.t.run(async (ctx) => {
			await ctx.db.delete("files_move_source_reservations", reservationId);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique();
			await ctx.db.patch("files_move_workspace_slots", slot!._id, { cohortId: null });
		});
		await sweep();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_yjs_states", stateId))).toBeNull();
	});

	// In parallel, every write starts its check before the first walk ends.
	test.each([false, true])("a bulk metadata replace during a Move walks once, parallel: %s", async (parallel) => {
		const f = await fixture();
		// An unrelated file at depth 3, while the fixture's Move holds the workspace.
		const file = await test_run_with_flush(f.t, async (ctx) => {
			let parent: Doc<"files_nodes"> | null = null;
			for (const [name, kind] of [
				["a", "folder"],
				["b", "folder"],
				["max", "file"],
			] as const) {
				const path: string = `${parent?.path ?? ""}/${name}`;
				const id: Id<"files_nodes"> = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: parent?._id ?? "root",
					name,
					sortName: files_sort_text_key(name),
					kind,
					path,
					treePath: kind === "folder" ? `${path}/` : path,
					pathDepth: path.split("/").length - 1,
				});
				parent = (await ctx.db.get("files_nodes", id))!;
			}
			return parent!;
		});
		// The largest metadata set of one file: 128 keys per namespace, 3 frontmatter or 2 metadata values each.
		const docs = (round: number) =>
			(["frontmatter", "metadata"] as const).flatMap((namespace) =>
				Array.from({ length: 128 }, (_, key) => {
					const base = {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						sourceKind: "committed" as const,
						fileNodeId: file._id,
						path: file.path,
						treePath: file.treePath,
						fieldPath: `${namespace}.r${round}k${key}`,
					};
					return [
						{ ...base, docKind: "field" as const, parentId: file.parentId },
						...Array.from({ length: namespace === "frontmatter" ? 3 : 2 }, (_, value) => ({
							...base,
							docKind: "value" as const,
							valueKind: "string" as const,
							stringValue: `r${round}k${key}v${value}`,
						})),
					];
				}).flat(),
			);
		await test_run_with_flush(f.t, async (ctx) => {
			for (const doc of docs(0)) await ctx.db.insert("files_metadata_docs", doc);
		});
		const cost = await test_run_with_flush(f.t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const old = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode", (q) =>
					q
						.eq("organizationId", f.db.organizationId)
						.eq("workspaceId", f.db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", file._id),
				)
				.collect();
			if (parallel) {
				await Promise.all(old.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));
				await Promise.all(docs(1).map((doc) => ctx.db.insert("files_metadata_docs", doc)));
			} else {
				for (const doc of old) await ctx.db.delete("files_metadata_docs", doc._id);
				for (const doc of docs(1)) await ctx.db.insert("files_metadata_docs", doc);
			}
			const after = await ctx.meta.getTransactionMetrics();
			return { ranges: after.databaseQueries.used - before.databaseQueries.used, docs: old.length };
		});
		expect(cost.docs).toBe(896);
		// Without a Move this write uses 2 ranges. Each doc once walked the file's 3 ancestors.
		expect(cost.ranges, "index ranges of 896 deletes and 896 inserts during a Move").toBeLessThan(16);
	});

	test("a reservation added later in the same mutation still blocks a side write", async () => {
		const f = await fixture();
		const fileId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: f.parentId,
				name: "free.md",
				sortName: files_sort_text_key("free.md"),
				kind: "file",
				path: "/target/free.md",
				treePath: "/target/free.md",
				pathDepth: 2,
			}),
		);
		const insert_doc = (ctx: MutationCtx, fieldPath: string) =>
			ctx.db.insert("files_metadata_docs", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				sourceKind: "committed",
				fileNodeId: fileId,
				path: "/target/free.md",
				treePath: "/target/free.md",
				fieldPath,
				docKind: "field",
				parentId: f.parentId,
			});
		const written: string[] = [];
		await expect(
			f.t.run(async (ctx) => {
				const guarded = { ...ctx, ...files_move_reservations_db_wrap(ctx) };
				await insert_doc(guarded, "metadata.a");
				written.push("metadata.a");
				await guarded.db.insert("files_move_source_reservations", {
					cohortId: f.cohortId,
					source: { kind: "saved", id: f.parentId },
					mode: "subtree",
					userId: null,
					generation: 1,
				});
				await insert_doc(guarded, "metadata.b");
				written.push("metadata.b");
			}),
		).rejects.toThrow("This item is being moved");
		expect(written, "only the write before the reservation passes").toEqual(["metadata.a"]);
	});

	test("a busy check reads the free Move slot only, and a Move reads each parent once per mutation", async () => {
		const f = await fixture();
		// A chain of 64 folders below the fixture's target folder, outside the Move.
		const chain = await f.t.run(async (ctx) => {
			const ids: Id<"files_nodes">[] = [];
			let parentId = f.parentId;
			let path = "/target";
			for (let pathDepth = 2; pathDepth <= 65; pathDepth++) {
				path = `${path}/a`;
				parentId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId,
					name: "a",
					sortName: files_sort_text_key("a"),
					kind: "folder",
					path,
					treePath: `${path}/`,
					pathDepth,
				});
				ids.push(parentId);
			}
			return ids;
		});
		const deepId = chain.at(-1)!;
		const create = (name: string) => ({
			parent: { kind: "saved" as const, id: deepId },
			slot: { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, parentId: deepId, name },
		});
		// The index ranges each check reads, in one mutation.
		const ranges = async (
			ctx: MutationCtx,
			db: MutationCtx["db"],
			check: Parameters<typeof files_move_reservations_db_find_blocker>[1],
		) => {
			const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used;
			const blocker = await files_move_reservations_db_find_blocker(db, check);
			return { blocker, ranges: (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before };
		};

		await f.t.run(async (ctx) => {
			const { db } = files_move_reservations_db_wrap(ctx);
			const first = await ranges(ctx, db, create("x"));
			expect(first.blocker).toBeNull();
			expect(first.ranges, "the first create walks the 65 parents").toBeGreaterThan(65);
			const second = await ranges(ctx, db, create("y"));
			expect(second, "the second create in the same folder reads no parent again").toEqual({
				blocker: null,
				ranges: 1,
			});
			// A new reservation drops the kept answers, so a Move that starts here is seen at once.
			await db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: chain[10]! },
				mode: "subtree",
				userId: null,
				generation: 1,
			});
			expect((await ranges(ctx, db, create("z"))).blocker).toBe(f.cohortId);
		});

		// No Move holds the slot, so there is no reservation anywhere and no parent walk.
		await f.t.run(async (ctx) => {
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique();
			for (const reservation of await ctx.db.query("files_move_source_reservations").collect())
				await ctx.db.delete("files_move_source_reservations", reservation._id);
			await ctx.db.patch("files_move_workspace_slots", slot!._id, { cohortId: null });
		});
		await f.t.run(async (ctx) => {
			expect(await ranges(ctx, ctx.db, create("x")), "a create reads only the free slot").toEqual({
				blocker: null,
				ranges: 1,
			});
			expect(
				await ranges(ctx, ctx.db, { source: { kind: "saved", id: deepId } }),
				"a node check reads only the node and the free slot",
			).toEqual({ blocker: null, ranges: 2 });
		});
	});

	test("the pending-state sweep does not reschedule a pass that only skipped busy rows", async () => {
		const f = await fixture();
		// A full page of tasks in the Move's workspace. Each one is skipped this pass.
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 32; index++)
				await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdAt: Date.now(),
				});
		});
		const read_sweeps = () =>
			f.t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect())
					.filter((job) => job.name.includes("cleanup_expired_pending_state_rows"))
					.map((job) => job._id),
			);
		const read_tasks = () => f.t.run((ctx) => ctx.db.query("files_pending_update_state_cleanup_tasks").collect());
		const tasks = await read_tasks();
		const before = await read_sweeps();
		const result = await f.t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		expect(await read_sweeps(), "a pass that walked past every skipped row has nothing to continue").toEqual(before);
		expect(result).toEqual({ deletedCount: 0, done: true });
		expect(await read_tasks(), "every busy task stays for a later pass").toEqual(tasks);
	});

	test("one sweep pass handles at most 32 rows, and skipped rows do not count", async () => {
		const f = await fixture();
		const otherWorkspaceId = await f.t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" });
			// Busy tasks first, then more free tasks than one pass may handle.
			for (const scope of [
				{ organizationId: f.db.organizationId, workspaceId: f.db.workspaceId },
				{ organizationId: db.organizationId, workspaceId: db.workspaceId },
			])
				for (let index = 0; index < 40; index++)
					await ctx.db.insert("files_pending_update_state_cleanup_tasks", { ...scope, createdAt: Date.now() });
			return db.workspaceId;
		});
		const result = await f.t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_disableReschedule: true,
		});
		const otherTasks = await f.t.run(
			async (ctx) =>
				(await ctx.db.query("files_pending_update_state_cleanup_tasks").collect()).filter(
					(task) => task.workspaceId === otherWorkspaceId,
				).length,
		);
		expect({ ...result, otherTasks }, "one pass handles at most 32 rows").toEqual({
			deletedCount: 32,
			done: false,
			otherTasks: 8,
		});
	});

	test("busy rows at the head of the sweep do not block another workspace", async () => {
		const f = await fixture();
		const other = await f.t.run(async (ctx) => {
			// Six old expired text inputs in the Move's workspace use the whole large-value budget.
			const busy = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
			const target = { kind: "saved" as const, id: f.nodeId };
			const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
				...busy,
				target,
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				updatedAt: Date.now(),
				lastActivityAt: Date.now(),
			});
			for (let index = 0; index < 6; index++)
				await ctx.db.insert("files_pending_update_text_inputs", {
					...busy,
					target,
					operationBatchId,
					role: "staged",
					text: "busy",
					expiresAt: 1,
				});
			// Another workspace has a retired state waiting in its cleanup task.
			const db = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" });
			const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
			const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				...scope,
				createdAt: Date.now(),
			});
			const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
				...scope,
				userId: db.userId,
				target,
				owner: { kind: "retired", cleanupTaskId },
				sealed: true,
				pageCount: 0,
				totalBytes: 0,
				digest: "",
			});
			const held = await files_private_storage_db_reserve(ctx, {
				...scope,
				userId: db.userId,
				resource: { kind: "state", id: stateId },
				byteCount: 0,
			});
			if (held._nay) throw new Error(held._nay.message);
			return { cleanupTaskId, stateId };
		});
		// Follow the self-scheduled chain like the scheduler would.
		const used = new Set(
			(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).map((job) => job._id),
		);
		let args: Record<string, unknown> = {};
		for (let pass = 0; pass < 10; pass++) {
			const result = await f.t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, args);
			if (result.done) break;
			const next = (await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
				(job) => job.name.includes("cleanup_expired_pending_state_rows") && !used.has(job._id),
			)[0];
			if (!next) throw new Error("Expected the next sweep pass");
			used.add(next._id);
			args = next.args[0] as Record<string, unknown>;
		}
		const left = await f.t.run(async (ctx) => ({
			otherState: (await ctx.db.get("files_pending_update_yjs_states", other.stateId)) !== null,
			otherTask: (await ctx.db.get("files_pending_update_state_cleanup_tasks", other.cleanupTaskId)) !== null,
			busyInputs: (await ctx.db.query("files_pending_update_text_inputs").collect()).length,
		}));
		expect(left, "the other workspace's retired state is cleaned").toEqual({
			otherState: false,
			otherTask: false,
			busyInputs: 6,
		});
	});
});
