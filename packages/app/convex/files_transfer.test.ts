import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_transfer_db_delete_run_batch } from "./files_transfer.ts";
import { files_subtree_ops_db_delete, files_subtree_ops_db_insert } from "./files_subtree_ops_db.ts";
import {
	test_save_file_pending_update,
	test_rename_node,
	test_move_nodes,
	test_create_saved_text_file,
	test_db_get_slot_cohort,
	test_finish_transfer_run,
	test_mocks,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { r2_create_asset_key, r2_server_side_copy } from "./r2_client.ts";
import {
	r2Objects,
	mock_transfer_storage,
	create_folder_fixture,
	start_transfer,
	start_agent_transfer,
	start_copy,
	finish_discovery,
	finish_folder_copy,
	finish_move,
	finish_copy_worker,
	finish_copy_with_workers,
	get_node,
	add_member,
} from "./files_transfer.setup.test.ts";

beforeEach(mock_transfer_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("start", () => {
	test("keeps top selected ancestors and reuses the same request", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const args = {
			membershipId: db.membershipId,
			requestId: "same-request",
			kind: "copy" as const,
			sourceIds: [folders.get("/source")!, folders.get("/source/child")!, folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		};
		const first = await start_transfer(asUser, args);
		if (first._nay) throw new Error(first._nay.message);
		expect(await start_transfer(asUser, args)).toEqual(first);
		// The same request ID with other sources is a new request, not a retry of this one.
		expect((await start_transfer(asUser, { ...args, sourceIds: [folders.get("/source/child")!] }))._nay).toMatchObject({
			name: "request_changed",
			message: "This request ID was already used for another transfer",
		});
		expect((await start_transfer(asUser, { ...args, requestId: "another-request" }))._nay?.message).toBe(
			"A transfer is already running in this workspace",
		);
		expect(await asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId })).toMatchObject([
			{
				_id: first._yay.runId,
				step: "discover",
				activity: { status: "running", progress: { discovered: 1, total: null } },
				controls: { canStop: true, canRetry: false, canDismiss: false },
			},
		]);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_transfer_runs").collect()).toHaveLength(1);
			expect((await ctx.db.query("files_transfer_items").collect()).map((item) => item.source.id)).toEqual([
				folders.get("/source"),
			]);
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
	});

	test("rejects a move into the selected folder's child", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const started = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "cycle",
			kind: "move",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/source/child")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		expect(
			await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: started._yay.runId }),
		).toMatchObject({
			activity: {
				status: "failed",
				progress: { completed: 0 },
				errorMessage: "A folder cannot be transferred inside itself",
			},
		});
		expect((await get_node(fixture, "/source"))?._id).toBe(folders.get("/source"));
	});

	test("rejects a paste into an archived folder", async () => {
		const fixture = await create_folder_fixture(["/source", "/archived-target"]);
		const { t, db, asUser, folders } = fixture;
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [folders.get("/archived-target")!],
		});
		if (archived._nay) throw new Error(archived._nay.message);

		const refused = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "archived-target",
			kind: "copy",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/archived-target")!,
		});
		expect(refused._nay?.message).toBe("Destination changed");
		expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(0);
	});

	test("keeps a run private from another member of the same workspace", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const member = await add_member(fixture);
		const runId = await start_copy(fixture, [fixture.folders.get("/source")!]);
		expect(await member.asUser.query(api.files_transfer_queries.get, { membershipId: member.membershipId, runId })).toBeNull();
		expect(
			await member.asUser.query(api.files_transfer_queries.list_items, {
				membershipId: member.membershipId,
				runId,
				paginationOpts: { numItems: 10, cursor: null },
			}),
		).toBeNull();
		expect(await member.asUser.query(api.files_transfer_queries.list_current, { membershipId: member.membershipId })).toEqual(
			[],
		);
		const before = await fixture.asUser.query(api.files_transfer_queries.get, {
			membershipId: fixture.db.membershipId,
			runId,
		});
		expect(
			await member.asUser.mutation(api.files_transfer.stop, { membershipId: member.membershipId, runId }),
		).toEqual({ _yay: null });
		expect(
			await fixture.asUser.query(api.files_transfer_queries.get, { membershipId: fixture.db.membershipId, runId }),
		).toEqual(before);
		expect(
			(await fixture.asUser.query(api.files_transfer_queries.get, { membershipId: fixture.db.membershipId, runId }))?.activity
				.status,
		).toBe("running");
	});

	test.each(["missing", "deleted"] as const)("rejects transfer reads for a %s user", async (userState) => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.run(async (ctx) => {
			if (userState === "missing") await ctx.db.delete("users", db.userId);
			else await ctx.db.patch("users", db.userId, { deletedAt: Date.now() });
		});
		await expect(asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).rejects.toThrow(
			"Unauthenticated",
		);
		await expect(
			asUser.query(api.files_transfer_queries.list_items, {
				membershipId: db.membershipId,
				runId,
				paginationOpts: { numItems: 10, cursor: null },
			}),
		).rejects.toThrow("Unauthenticated");
		await expect(
			asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId }),
		).rejects.toThrow("Unauthenticated");
	});

	// 200 fills the last intake page exactly. 201 roots are in files_transfer_selection.test.ts.
	test("starts a copy of 200 selected roots across intake pages", async () => {
		const count = 200;
		const paths = Array.from({ length: count }, (_entry, index) => `/root-${index.toString().padStart(3, "0")}`);
		const fixture = await create_folder_fixture(paths);
		const { t, db, asUser, folders } = fixture;
		const started = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "root-limit",
			kind: "copy",
			sourceIds: paths.map((path) => folders.get(path)!),
			targetParentId: folders.get("/target")!,
		});

		expect(started._nay).toBeUndefined();
		if (started._nay) return;
		expect(
			await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: started._yay.runId }),
		).toMatchObject({ step: "discover", activity: { progress: { discovered: count } } });
		expect(await t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toHaveLength(count);
	});
});

describe("Rename at a group boundary", () => {
	test("keeps a Rename-only queue visible to current-run and busy checks", async () => {
		const fixture = await create_folder_fixture(["/one", "/two", "/source"]);
		const { db, asUser, folders } = fixture;
		const first = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "first-visible-rename",
			nodeId: folders.get("/one")!,
			path: "first",
		});
		vi.setSystemTime(Date.now() + 1);
		const second = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "second-visible-rename",
			nodeId: folders.get("/two")!,
			path: "second",
		});
		if (!first._yay || !second._yay) throw new Error("Expected both Renames");
		expect(await asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId })).toMatchObject([
			{ _id: first._yay.runId, activity: { source: { isRename: true }, status: "queued" } },
		]);
		expect(
			(await start_transfer(asUser, {
				membershipId: db.membershipId,
				requestId: "bulk-during-rename",
				kind: "copy",
				sourceIds: [folders.get("/source")!],
				targetParentId: folders.get("/target")!,
			}))._nay?.name,
		).toBe("busy");
		expect(await asUser.mutation(api.files_transfer.stop, {
			membershipId: db.membershipId,
			runId: first._yay.runId,
		})).toEqual({ _yay: null });
		await test_finish_transfer_run(asUser, first._yay.runId);
		expect(await asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId })).toMatchObject([
			{ _id: second._yay.runId },
		]);
		await test_finish_transfer_run(asUser, second._yay.runId);
		expect(await asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId })).toEqual([]);
	});

	test("lets queued Rename run after Stop finishes the bulk Move group", async () => {
		const fixture = await create_folder_fixture(["/first", "/first/child", "/second", "/other"]);
		const { t, db, asUser, folders } = fixture;
		const overlay = await import("../server/files-pending-overlay.ts");
		const canJoin = overlay.files_pending_overlay_db_can_join_step;
		const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step");
		let yielded = false;
		// Yield at cohort admission so Stop can inspect a real unfinished group.
		join.mockImplementation(async (ctx, limitFactor) => {
			const allowed = await canJoin(ctx, limitFactor);
			if (limitFactor !== 4) return allowed;
			yielded = true;
			join.mockRestore();
			return false;
		});
		const moved = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "stopped-bulk-move",
			kind: "move",
			sourceIds: [folders.get("/first")!, folders.get("/second")!],
			targetParentId: folders.get("/target")!,
		});
		if (!moved._yay) throw new Error(moved._nay.message);
		await finish_discovery(fixture, moved._yay.runId);
		await t.mutation(internal.files_transfer.advance, { runId: moved._yay.runId });
		await t.mutation(internal.files_transfer.advance, { runId: moved._yay.runId });
		expect(yielded, "the fixture yields before the initial Move step").toBe(true);
		const cohort = await t.run((ctx) => test_db_get_slot_cohort(ctx, db));
		if (!cohort) throw new Error("Expected the first Move group");
		await t.action(internal.files_move_run.run, {
			cohortId: cohort._id,
			step: cohort.step,
			runGeneration: cohort.runJob?.generation ?? null,
			mode: "step",
		});
		await t.run(async (ctx) => {
			const source = (await ctx.db.get("files_nodes", folders.get("/first")!))!;
			expect(source.moveCohortId, "the first group stays held before Stop").toBeDefined();
			expect(
				await ctx.db.get("files_move_cohorts", source.moveCohortId!),
				"Stop sees the group before publication",
			).toMatchObject({
				origin: { kind: "transfer", runId: moved._yay!.runId },
				visibleView: "before",
				publishedAt: null,
			});
		});
		const rename = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "rename-after-stop",
			nodeId: folders.get("/other")!,
			path: "renamed",
		});
		if (!rename._yay) throw new Error(rename._nay?.message ?? "Expected Rename");
		expect(await asUser.mutation(api.files_transfer.stop, {
			membershipId: db.membershipId,
			runId: moved._yay.runId,
		})).toEqual({ _yay: null });
		await t.mutation(internal.files_transfer.advance, { runId: rename._yay.runId });
		expect((await t.run((ctx) => ctx.db.get("activities", rename._yay!.activityId)))?.status).toBe("queued");
		await test_finish_transfer_run(asUser, moved._yay.runId);
		expect(
			await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: moved._yay.runId }),
		).toMatchObject({ activity: { status: "canceled", progress: { completed: 0, canceled: 2 } } });
		expect((await get_node(fixture, "/first"))?._id).toBe(folders.get("/first"));
		expect((await get_node(fixture, "/first/child"))?._id).toBe(folders.get("/first/child"));
		expect((await get_node(fixture, "/second"))?._id).toBe(folders.get("/second"));
		await test_finish_transfer_run(asUser, rename._yay.runId);
		expect((await get_node(fixture, "/renamed"))?._id).toBe(folders.get("/other"));
	});

	test("runs Rename after the active Move group and before the next root", async () => {
		const fixture = await create_folder_fixture(["/first", "/second", "/other"]);
		const { t, db, asUser, folders } = fixture;
		const moved = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "bulk-move",
			kind: "move",
			sourceIds: [folders.get("/first")!, folders.get("/second")!],
			targetParentId: folders.get("/target")!,
		});
		if (moved._nay) throw new Error(moved._nay.message);
		await finish_discovery(fixture, moved._yay.runId);
		await t.mutation(internal.files_transfer.advance, { runId: moved._yay.runId });
		await t.mutation(internal.files_transfer.advance, { runId: moved._yay.runId });
		const slot = await t.run((ctx) =>
			ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique(),
		);
		if (!slot?.cohortId) throw new Error("Expected the first Move group");
		const cohortId = slot.cohortId;
		const args = {
			membershipId: db.membershipId,
			requestId: "queued-rename",
			nodeId: folders.get("/other")!,
			path: "renamed",
		};
		const renamed = await asUser.mutation(api.files_nodes.rename_node, args);
		if (!renamed._yay) throw new Error(renamed._nay?.message ?? "Expected Rename");
		expect(await asUser.mutation(api.files_nodes.rename_node, args)).toEqual(renamed);
		const originalDeadline = (await t.run((ctx) => ctx.db.get("activities", renamed._yay!.activityId)))!.deadlineAt;
		vi.setSystemTime(Date.now() + 60_000);
		await t.mutation(internal.files_transfer.advance, { runId: renamed._yay.runId });
		expect(await t.run((ctx) => ctx.db.get("activities", renamed._yay!.activityId))).toMatchObject({
			status: "queued",
			deadlineAt: originalDeadline + 60_000,
		});
		expect((await t.run((ctx) => ctx.db.get("files_move_workspace_slots", slot._id)))?.cohortId).toBe(cohortId);
		for (let pass = 0; pass < 500; pass++) {
			const cohort = (await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId)))!;
			if (cohort.phase === "complete") break;
			await t.action(internal.files_move_run.run, {
				cohortId,
				step: cohort.step,
				runGeneration: cohort.runJob?.generation ?? null,
				mode: "step",
			});
		}
		expect((await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId)))?.phase).toBe("complete");
		await t.mutation(internal.files_transfer.settle_cohort, { cohortId });
		await t.mutation(internal.files_transfer.advance, { runId: moved._yay.runId });
		await t.mutation(internal.files_transfer.advance, { runId: moved._yay.runId });
		expect(
			(await t.run((ctx) => ctx.db.get("files_move_workspace_slots", slot._id)))?.cohortId,
			"Rename runs before the next Move root",
		).toBeNull();
		expect((await get_node(fixture, "/second"))?._id).toBe(folders.get("/second"));
		await test_finish_transfer_run(asUser, renamed._yay.runId);
		expect((await get_node(fixture, "/renamed"))?._id).toBe(folders.get("/other"));
		await test_finish_transfer_run(asUser, moved._yay.runId);
		expect(
			await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: moved._yay.runId }),
		).toMatchObject({ activity: { status: "succeeded", progress: { completed: 2 } } });
	});

	test("waits for Copy callbacks and pauses new workers until Rename finishes", async () => {
		const fixture = await create_folder_fixture(["/other"]);
		const { t, db, asUser, folders } = fixture;
		const sources: Id<"files_nodes">[] = [];
		for (const path of ["/one.txt", "/two.txt", "/three.txt"])
			sources.push(
				await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path,
					textContent: path,
				}),
			);
		const runId = await start_copy(fixture, sources);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		await t.mutation(internal.files_transfer.advance, { runId });
		const workers = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_state_order", (q) => q.eq("runId", runId).eq("state", "copying"))
				.collect(),
		);
		expect(workers).toHaveLength(2);
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "copy-rename",
			nodeId: folders.get("/other")!,
			path: "renamed",
		});
		if (!renamed._yay) throw new Error(renamed._nay?.message ?? "Expected Rename");
		const first = workers[0]!;
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: first._id, attempt: first.attempt });
		await t.mutation(internal.files_transfer.advance, { runId: renamed._yay.runId });
		expect((await t.run((ctx) => ctx.db.get("activities", renamed._yay!.activityId)))?.status).toBe("queued");
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.inFlight).toBe(2);
		await finish_copy_worker(fixture, workers[1]!);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.inFlight).toBe(1);
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", first._id))).toMatchObject({
			state: "completed",
			workId: first.workId,
		});
		await t.mutation(internal.files_transfer.advance, { runId: renamed._yay.runId });
		expect(
			(await t.run((ctx) => ctx.db.get("activities", renamed._yay!.activityId)))?.status,
			"Rename waits for the last completed Copy callback",
		).toBe("queued");
		expect((await get_node(fixture, "/other"))?._id).toBe(folders.get("/other"));
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: first.workId!,
			context: { itemId: first._id, attempt: first.attempt },
			result: { kind: "success", returnValue: null },
		});
		await t.mutation(internal.files_transfer.advance, { runId });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.inFlight).toBe(0);
		await test_finish_transfer_run(asUser, renamed._yay.runId);
		expect((await get_node(fixture, "/renamed"))?._id).toBe(folders.get("/other"));
		expect((await finish_copy_with_workers(fixture, runId)).activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 3 },
		});
	});

	test.each(["current", "personal"] as const)(
		"waits for a Copy from %s started in another chat workspace",
		async (sourceWorkspace) => {
			const fixture = await create_folder_fixture([]);
			const { t, db, asUser } = fixture;
			const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
				userId: db.userId,
				membershipId: db.membershipId,
			});
			if (!captured._yay) throw new Error(captured._nay.message);
			const personal = captured._yay.personal;
			const sourceId = await test_create_saved_text_file(t, {
				membershipId: captured._yay[sourceWorkspace].membershipId,
				path: "/source.txt",
				textContent: "cross-workspace",
			});
			const other = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: personal.organizationId,
				workspaceId: personal.workspaceId,
				userId: db.userId,
				path: "/other",
			});
			if (!other._yay) throw new Error(other._nay.message);
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "rename-cross-copy",
				lastMessageAt: Date.now(),
			});
			if (!thread._yay) throw new Error(thread._nay.message);
			const copy = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace,
				destinationWorkspace: sourceWorkspace === "current" ? "personal" : "current",
				requestId: "cross-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: sourceId }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (!copy._yay) throw new Error(copy._nay.message);
			const runId = copy._yay.runId;
			await finish_discovery(fixture, runId);
			await t.mutation(internal.files_transfer.advance, { runId });
			await t.mutation(internal.files_transfer.advance, { runId });
			const item = (await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.unique(),
			))!;
			expect(item.workId).not.toBeNull();
			const rename = await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: personal.membershipId,
				requestId: "personal-rename",
				nodeId: other._yay.nodeId,
				path: "renamed",
			});
			if (!rename._yay) throw new Error(rename._nay?.message ?? "Expected Rename");
			await t.mutation(internal.files_transfer.advance, { runId: rename._yay.runId });
			expect((await t.run((ctx) => ctx.db.get("activities", rename._yay!.activityId)))?.status).toBe("queued");
			await finish_copy_worker(fixture, item);
			await t.mutation(internal.files_transfer.advance, { runId });
			expect((await t.run((ctx) => ctx.db.get("activities", copy._yay!.activityId)))?.status).toBe("running");
			await test_finish_transfer_run(asUser, rename._yay.runId);
			expect((await t.run((ctx) => ctx.db.get("files_nodes", other._yay!.nodeId)))?.path).toBe("/renamed");
			expect((await finish_copy_with_workers(fixture, runId)).activity).toMatchObject({
				status: "succeeded",
				progress: { completed: 1 },
			});
		},
	);

	test("keeps Rename order and lets a conflict give way to other work", async () => {
		const fixture = await create_folder_fixture(["/source", "/one", "/two", "/three"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		const first = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "first-rename",
			nodeId: folders.get("/one")!,
			path: "renamed",
		});
		vi.setSystemTime(Date.now() + 1);
		const second = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "second-rename",
			nodeId: folders.get("/two")!,
			path: "renamed",
		});
		if (!first._yay || !second._yay) throw new Error("Expected both Renames");
		await t.mutation(internal.files_transfer.advance, { runId: second._yay.runId });
		expect((await t.run((ctx) => ctx.db.get("activities", second._yay!.activityId)))?.status).toBe("queued");
		expect(await asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId })).toMatchObject([
			{ _id: runId },
		]);
		await test_finish_transfer_run(asUser, first._yay.runId);
		await test_finish_transfer_run(asUser, second._yay.runId);
		const conflict = await asUser.query(api.files_transfer_queries.get, {
			membershipId: db.membershipId,
			runId: second._yay.runId,
		});
		expect(conflict).toMatchObject({
			activity: { status: "awaiting_input" },
			conflicts: [{ kind: "destination_changed" }],
		});
		expect((await get_node(fixture, "/two"))?._id).toBe(folders.get("/two"));
		expect((await finish_folder_copy(fixture, runId)).activity.status).toBe("succeeded");
		const third = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "third-rename",
			nodeId: folders.get("/three")!,
			path: "third",
		});
		if (!third._yay) throw new Error(third._nay?.message ?? "Expected Rename");
		await test_finish_transfer_run(asUser, third._yay.runId);
		expect((await get_node(fixture, "/third"))?._id).toBe(folders.get("/three"));
		if (!conflict) throw new Error("Expected the conflict");
		expect(
			(await asUser.mutation(api.files_transfer.resolve_conflicts, {
				membershipId: db.membershipId,
				runId: second._yay.runId,
				revision: conflict.revision,
				choices: conflict.conflicts.map((item) => ({ itemId: item.itemId, choice: "skip" as const })),
				applyToRemaining: { file: null, folder: null },
			}))._nay,
		).toBeUndefined();
		await test_finish_transfer_run(asUser, second._yay.runId);
	});

	test("lets a new Copy start while a Rename waits on a conflict", async () => {
		const fixture = await create_folder_fixture(["/source", "/one", "/two"]);
		const { db, asUser, folders } = fixture;
		const first = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "paused-first-rename",
			nodeId: folders.get("/one")!,
			path: "renamed",
		});
		vi.setSystemTime(Date.now() + 1);
		const second = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "paused-second-rename",
			nodeId: folders.get("/two")!,
			path: "renamed",
		});
		if (!first._yay || !second._yay) throw new Error("Expected both Renames");
		await test_finish_transfer_run(asUser, first._yay.runId);
		await test_finish_transfer_run(asUser, second._yay.runId);
		// The Activity card opens the paused Rename through get, so it does not need list_current.
		expect(
			await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: second._yay.runId }),
		).toMatchObject({ activity: { status: "awaiting_input" }, conflicts: [{ kind: "destination_changed" }] });
		expect(await asUser.query(api.files_transfer_queries.list_current, { membershipId: db.membershipId })).toEqual([]);
		const copy = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "copy-during-paused-rename",
			kind: "copy",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		expect(copy._nay, "a paused Rename gives way to a new Copy").toBeUndefined();
	});

	test("stops a queued Rename without stopping the Copy and retries Rename through its own queue", async () => {
		const fixture = await create_folder_fixture(["/source", "/other"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "stopped-rename",
			nodeId: folders.get("/other")!,
			path: "renamed",
		});
		if (!renamed._yay) throw new Error(renamed._nay?.message ?? "Expected Rename");
		expect(
			await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId: renamed._yay.runId }),
		).toEqual({ _yay: null });
		await test_finish_transfer_run(asUser, renamed._yay.runId);
		expect((await get_node(fixture, "/other"))?._id).toBe(folders.get("/other"));
		expect((await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.status).toBe(
			"running",
		);
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId: renamed._yay.runId,
			requestId: "retry-rename",
		});
		if (!retried._yay) throw new Error(retried._nay?.message ?? "Expected Rename Retry");
		expect((await t.run((ctx) => ctx.db.get("activities", retried._yay!.activityId)))?.source).toMatchObject({
			isRename: true,
		});
		await test_finish_transfer_run(asUser, retried._yay.runId);
		expect((await get_node(fixture, "/renamed"))?._id).toBe(folders.get("/other"));
		expect((await finish_folder_copy(fixture, runId)).activity.status).toBe("succeeded");
	});

	test("checks membership again while Rename waits", async () => {
		const fixture = await create_folder_fixture(["/one", "/two"]);
		const { t, folders } = fixture;
		const member = await add_member(fixture);
		const first = await member.asUser.mutation(api.files_nodes.rename_node, {
			membershipId: member.membershipId,
			requestId: "first-member-rename",
			nodeId: folders.get("/one")!,
			path: "first",
		});
		vi.setSystemTime(Date.now() + 1);
		const second = await member.asUser.mutation(api.files_nodes.rename_node, {
			membershipId: member.membershipId,
			requestId: "second-member-rename",
			nodeId: folders.get("/two")!,
			path: "second",
		});
		if (!first._yay || !second._yay) throw new Error("Expected both Renames");
		await t.mutation(internal.files_transfer.advance, { runId: second._yay.runId });
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", member.membershipId, { active: false }));
		await test_finish_transfer_run(member.asUser, second._yay.runId);
		expect(await t.run((ctx) => ctx.db.get("activities", second._yay!.activityId))).toMatchObject({
			status: "failed",
			errorMessage: "Permission denied",
			progress: { completed: 0 },
		});
		expect((await get_node(fixture, "/two"))?._id).toBe(folders.get("/two"));
		expect(await get_node(fixture, "/second")).toBeNull();
	});
});

describe("start_for_agent", () => {
	test("cross-workspace Copy keeps three real worker attempts", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/retry.txt",
			textContent: "Keep all retries\n",
		});
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "retry-count",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "retry-count",
			kind: "copy",
			sources: [{ kind: "saved", id: sourceId }],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		await finish_discovery(fixture, runId);
		const enqueueAction = vi.spyOn(Workpool.prototype, "enqueueAction").mockClear();
		for (let worker = 1; worker <= 3; worker++) {
			await t.mutation(internal.files_transfer.advance, { runId });
			await t.mutation(internal.files_transfer.advance, { runId });
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.unique(),
			);
			expect(item?.workId, `Worker ${worker} must be queued`).not.toBeNull();
			if (!item?.workId) throw new Error("Expected a queued worker");
			if (worker < 3)
				await t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "failed", error: "Temporary storage failure" },
				});
			else await finish_copy_worker(fixture, item);
		}
		expect(enqueueAction).toHaveBeenCalledTimes(3);
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, failed: 0 },
		});
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({ archiveOperationId: null });
	});

	test.each([false, true])(
		"reserves every cross-workspace file draft before starting content workers, selected media: %s",
		async (withMedia) => {
			const fixture = await create_folder_fixture([]);
			const { t, db, asUser } = fixture;
			const sources: Array<{ kind: "saved"; id: Id<"files_nodes"> }> = [];
			for (const path of ["/document.txt", "/other.txt"]) {
				const created = await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path,
					textContent: `${path}\n`,
				});
				sources.push({ kind: "saved", id: created });
			}
			let mediaId: Id<"files_nodes"> | null = null;
			if (withMedia) {
				const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: db.membershipId,
					parentId: files_ROOT_ID,
					filename: "image.png",
					contentType: "image/png",
					size: 3,
				});
				if (upload._nay) throw new Error(upload._nay.message);
				mediaId = upload._yay.nodeId;
				sources.push({ kind: "saved", id: mediaId });
				const key = r2_create_asset_key({ ...db, assetId: upload._yay.assetId });
				r2Objects.set(key, new Uint8Array([1, 2, 3]));
				await t.run((ctx) =>
					ctx.db.patch("files_r2_assets", upload._yay.assetId, { r2Key: key, unfinalizedExpiresAt: undefined }),
				);
				vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
					r2Objects.set(args.destinationKey, r2Objects.get(args.sourceKey)!);
					return { outcome: "copied", size: 3, etag: "copied" };
				});
			}
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "reserve-copy",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const enqueueAction = vi.spyOn(Workpool.prototype, "enqueueAction").mockClear();
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
				requestId: "reserve-copy",
				kind: "copy",
				sources,
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect((await finish_discovery(fixture, started._yay.runId)).step).toBe("apply");
			expect(enqueueAction).not.toHaveBeenCalled();
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.collect(),
			);
			expect(items).toHaveLength(sources.length);
			for (const item of items) {
				expect(item.state).toBe(item.source.id === mediaId ? "pending" : "waiting_media");
				expect(item.preparation).not.toBeNull();
				expect(item.workId).toBeNull();
			}
			expect(new Set(items.map((item) => item.preparation?.privateNodeId)).size).toBe(sources.length);
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			expect(enqueueAction).toHaveBeenCalledTimes(1);
			if (withMedia) {
				const working = await t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_state_order", (q) => q.eq("runId", started._yay.runId).eq("state", "copying"))
						.unique(),
				);
				expect(working?.source.id).toBe(mediaId);
			}
			expect((await finish_copy_with_workers(fixture, started._yay.runId)).activity).toMatchObject({
				status: "succeeded",
				progress: { completed: sources.length, failed: 0 },
			});
		},
	);

	test.each(["current", "personal"] as const)(
		"copies folders from %s to the other workspace as private proposals",
		async (sourceWorkspace) => {
			const fixture = await create_folder_fixture([]);
			const { t, db, asUser } = fixture;
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "cross-workspace-copy",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
				userId: db.userId,
				membershipId: db.membershipId,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			const destinationWorkspace = sourceWorkspace === "current" ? "personal" : "current";
			const source = captured._yay[sourceWorkspace];
			const destination = captured._yay[destinationWorkspace];
			const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: db.userId,
				path: "/cross-source/child",
			});
			if (created._nay) throw new Error(created._nay.message);
			const sourceFolder = await t.run((ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", source.organizationId)
							.eq("workspaceId", source.workspaceId).eq("moveCohortId", undefined)
							.eq("path", "/cross-source")
							.eq("archiveOperationId", null),
					)
					.unique(),
			);
			if (!sourceFolder) throw new Error("Missing source folder");
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace,
				destinationWorkspace,
				requestId: "cross-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: sourceFolder._id }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const finished = await finish_folder_copy(fixture, started._yay.runId);
			expect(finished.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, failed: 0 } });
			expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", started._yay.runId))).toMatchObject({
				workspaceId: db.workspaceId,
				sourceScope: { workspaceId: source.workspaceId, membershipId: source.membershipId },
				destinationScope: { workspaceId: destination.workspaceId, membershipId: destination.membershipId },
			});
			const drafts = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			expect(drafts).toHaveLength(2);
			for (const draft of drafts)
				expect(draft).toMatchObject({
					organizationId: destination.organizationId,
					workspaceId: destination.workspaceId,
					userId: db.userId,
					state: "active",
				});
			expect(drafts.map((draft) => draft.name)).toEqual(["cross-source", "child"]);
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			const items = await asUser.query(api.files_transfer_queries.list_items, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
				paginationOpts: { numItems: 20, cursor: null },
			});
			expect(items?.page).toHaveLength(2);
		},
	);

	test("a copy to another workspace during a restore copies the items already back and not the others", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		// 100 folders do not fit in the 10 stamps of the request, so the restore still runs when the copy reads them.
		const topId = await t.run(async (ctx) => {
			const insert_folder = (args: { parentId: Doc<"files_nodes">["parentId"]; name: string; path: string }) => {
				const { name, path, parentId } = args;

				return ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId,
					name,
					sortName: files_sort_text_key(name),
					kind: "folder",
					path,
					treePath: `${path}/`,
					pathDepth: path.split("/").length - 1,
				});
			};
			const topId = await insert_folder({ parentId: "root", name: "restoring", path: "/restoring" });
			for (let index = 0; index < 100; index++) {
				const name = `d${String(index).padStart(3, "0")}`;
				await insert_folder({ parentId: topId, name, path: `/restoring/${name}` });
			}
			return topId;
		});
		const step_op = async () => {
			const op = await t.run((ctx) => ctx.db.query("files_subtree_ops").first());
			if (!op) return false;
			const walk = await t.run((ctx) =>
				ctx.db
					.query("files_subtree_op_walks")
					.withIndex("by_op", (q) => q.eq("opId", op._id))
					.unique(),
			);
			await t.mutation(internal.files_subtree_ops.advance, { opId: op._id, step: walk!.step });
			return true;
		};
		const read_children = () =>
			t.run(async (ctx) => (await ctx.db.query("files_nodes").collect()).filter((node) => node.parentId === topId));

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [topId],
		});
		if (archived._nay) throw new Error(archived._nay.message);
		for (let count = 0; count < 20 && (await step_op()); count++);
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);

		const restored = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [topId],
		});
		if (restored._nay) throw new Error(restored._nay.message);
		for (
			let count = 0;
			count < 20 && !(await read_children()).some((node) => node.archiveOperationId === null);
			count++
		) {
			await step_op();
		}
		const children = await read_children();
		const backNames = children.filter((node) => node.archiveOperationId === null).map((node) => node.name);
		expect(backNames.length).toBeGreaterThan(0);
		expect(children.filter((node) => node.archiveOperationId !== null).length).toBeGreaterThan(0);

		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "copy-during-restore",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "copy-during-restore",
			kind: "copy",
			sources: [{ kind: "saved", id: topId }],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect((await finish_folder_copy(fixture, started._yay.runId)).activity.status).toBe("succeeded");

		// The copy reads what is active when it reads it. The items the restore has not reached are not copied.
		const drafts = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(
			drafts
				.map((draft) => draft.name)
				.filter((name) => name !== "restoring")
				.sort(),
		).toEqual(backNames.sort());
	}, 120_000);

	test.each([false, true])(
		"a viewer can copy to home, but old work stays stopped after leave and re-invite: %s",
		async (reinvite) => {
			const fixture = await create_folder_fixture(["/source"]);
			const { t, db, asUser, folders } = fixture;
			const visitor = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			expect(
				await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userIdToAdd: visitor.userId,
				}),
			).toEqual({ _yay: null });
			const organization = await t.run((ctx) => ctx.db.get("organizations", db.organizationId));
			if (!organization?.defaultWorkspaceId) throw new Error("Missing primary workspace");
			expect(
				await asUser.mutation(api.access_control.set_user_role, {
					organizationId: db.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					userId: visitor.userId,
					role: "viewer",
				}),
			).toEqual({ _yay: null });
			const member = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("userId", visitor.userId).eq("active", true),
					)
					.unique(),
			);
			if (!member) throw new Error("Missing invited membership");
			const asVisitor = t.withIdentity({ issuer: "https://clerk.test", external_id: visitor.userId });
			const thread = await asVisitor.mutation(api.ai_chat.thread_create, {
				membershipId: member._id,
				clientGeneratedId: "viewer-transfer",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: member._id,
				threadId: thread._yay.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
				requestId: "viewer-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			let membershipId = member._id;
			if (reinvite) {
				expect(
					await asVisitor.mutation(api.organizations.remove_user_from_organization, {
						organizationId: db.organizationId,
						userIdToRemove: visitor.userId,
					}),
				).toEqual({ _yay: null });
				expect(
					await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userIdToAdd: visitor.userId,
					}),
				).toEqual({ _yay: null });
				const rejoined = await t.run((ctx) =>
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", db.workspaceId).eq("userId", visitor.userId).eq("active", true),
						)
						.unique(),
				);
				if (!rejoined) throw new Error("Missing rejoined membership");
				membershipId = rejoined._id;
			}
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const finished = await finish_folder_copy(
				{ ...fixture, db: { ...db, userId: visitor.userId, membershipId }, asUser: asVisitor },
				started._yay.runId,
			);
			expect(finished.activity.status).toBe(reinvite ? "failed" : "succeeded");
			if (reinvite) expect(finished.activity.errorMessage).toBe("Permission denied");
			const drafts = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			expect(drafts).toHaveLength(reinvite ? 0 : 1);
			if (!reinvite)
				expect(drafts[0]).toMatchObject({ workspaceId: visitor.workspaceId, userId: visitor.userId, name: "source" });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test.each(["writePolicy", "newChildWritePolicy"] as const)(
		"refuses a copied folder's %s when its writer has no destination access",
		async (field) => {
			const fixture = await create_folder_fixture(["/source"]);
			const { t, db, asUser, folders } = fixture;
			const member = await add_member(fixture);
			const writePolicy = { mode: "writer" as const, writers: [{ kind: "user" as const, userId: member.userId }] };
			const policyResult =
				field === "writePolicy"
					? await asUser.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: db.membershipId,
							nodeId: folders.get("/source")!,
							writePolicy,
						})
					: await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
							membershipId: db.membershipId,
							nodeId: folders.get("/source")!,
							newChildWritePolicy: writePolicy,
						});
			if (policyResult._nay) throw new Error(policyResult._nay.message);
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "copied-writer",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
				requestId: "writer-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect((await finish_folder_copy(fixture, started._yay.runId)).activity).toMatchObject({
				status: "failed",
				progress: { completed: 0, failed: 1 },
			});
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.collect(),
			);
			expect(items[0]?.errorMessage).toBe(
				"The copied protection names a writer who cannot edit this destination. Change the source rule or pick a writer with access first.",
			);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.get("files_nodes", folders.get("/source")!))).toMatchObject({
				[field]: writePolicy,
				archiveOperationId: null,
			});
		},
	);

	test.each(["", ".", "../hidden", "nested/name", "nested\\name"])(
		"rejects a destination that is not one name: %j",
		async (targetName) => {
			const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "transfer-name-thread",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "invalid-name",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "saved", id: folders.get("/target")! },
				targetPath: "/target",
				targetName,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect(await t.run((ctx) => ctx.db.get("activities", started._yay.activityId))).toMatchObject({
				status: "failed",
				errorMessage: "Invalid destination name",
				progress: { completed: 0 },
			});
			expect(await t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toEqual([]);
			expect((await t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual([
				"/source",
				"/target",
			]);
		},
	);
});

describe("transfers of a background job", () => {
	/**
	 * A folder fixture plus one job row of the user, started through the real door.
	 */
	async function create_job_fixture() {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser } = fixture;
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "transfer-job-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const scope = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			threadId: thread._yay.threadId,
		};
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: db.userId,
			membershipId: db.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...scope,
			membershipId: db.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "job-parent",
			commandHash: "a".repeat(64),
			shellName: "default",
			run: null,
		});
		if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a fresh call");
		const started = await t.mutation(internal.ai_chat_files.start_bash_job, {
			parentInvocationId: begun._yay.invocationId,
			commandNumber: 0,
			shellId: begun._yay.shell._id,
			script: "cp -R source target",
			startCwd: "/",
			startCwdTarget: null,
			shellState: {
				env: [],
				arrays: [],
				options: {},
				shoptOptions: {},
				readonlyVars: [],
				associativeArrays: [],
				namerefs: [],
				boundNamerefs: [],
				invalidNamerefs: [],
				integerVars: [],
				lowercaseVars: [],
				uppercaseVars: [],
				exportedVars: [],
				declaredVars: [],
				functions: [],
				previousDir: "/",
				directoryStack: [],
				lastExitCode: 0,
				lastArg: "",
				openFileDescriptors: [],
			},
			allowDbFilesMkdir: true,
		});
		if (started._nay) throw new Error(started._nay.message);
		const job = await t.run(async (ctx) =>
			(await ctx.db.query("ai_chat_bash_invocations").collect()).find((row) => row.job?.jobNumber === 1),
		);
		if (!job) throw new Error("Expected the job row");
		const copy = async (commandNumber: number) =>
			await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: scope.threadId,
				invocation: { id: job._id, commandNumber },
				requestId: `job-copy-${commandNumber}`,
				kind: "copy",
				sources: [{ kind: "saved", id: fixture.folders.get("/source")! }],
				targetParent: { kind: "saved", id: fixture.folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
		return { ...fixture, scope, job, copy };
	}

	test("hides the job's transfer from the feed, also after a retry, and the lane query sees it", async () => {
		const f = await create_job_fixture();
		const laneArgs = { membershipId: f.db.membershipId, threadId: f.scope.threadId };
		expect(await f.t.query(internal.files_transfer.get_current_activity_for_agent, laneArgs)).toBeNull();
		const started = await f.copy(0);
		if (started._nay) throw new Error(started._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId))).toMatchObject({
			feedVisible: false,
			status: "running",
		});
		expect(await f.t.query(internal.files_transfer.get_current_activity_for_agent, laneArgs)).toEqual({
			activityId: started._yay.activityId,
			status: "running",
		});
		// The lane query is fenced on the membership and the thread's owner.
		const other = await add_member(f);
		expect(
			await f.t.query(internal.files_transfer.get_current_activity_for_agent, {
				membershipId: other.membershipId,
				threadId: f.scope.threadId,
			}),
		).toBeNull();

		// Retry needs a finished discovery, so stop only after it.
		await finish_discovery(f, started._yay.runId);
		await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId: started._yay.runId });
		await finish_folder_copy(f, started._yay.runId);
		expect(await f.t.query(internal.files_transfer.get_current_activity_for_agent, laneArgs)).toBeNull();
		const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: f.db.membershipId,
			runId: started._yay.runId,
			requestId: "job-copy-retry",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("activities", retried._yay.activityId))).toMatchObject({
			feedVisible: false,
		});
	});

	test("refuses a new transfer once the job is stopping, but still answers a replayed one", async () => {
		const f = await create_job_fixture();
		const started = await f.copy(0);
		if (started._nay) throw new Error(started._nay.message);
		expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 1 })).toBe(true);
		expect((await f.copy(1))._nay).toMatchObject({ name: "stopped" });
		expect((await f.copy(0))._yay).toMatchObject({ runId: started._yay.runId, activityId: started._yay.activityId });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(1);
	});
});

// The advance and resolve_conflicts tests are in files_transfer.advance.test.ts.

describe("stop", () => {
	test("drains large selections in batches before finishing", async () => {
		const paths = Array.from({ length: 101 }, (_entry, index) => `/source-${index}`);
		const fixture = await create_folder_fixture(paths);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(
			fixture,
			paths.map((path) => folders.get(path)!),
		);
		const args = { membershipId: db.membershipId, runId };
		expect((await asUser.mutation(api.files_transfer.stop, args))._nay).toBeUndefined();
		const stopping = await asUser.query(api.files_transfer_queries.get, args);
		expect(stopping).toMatchObject({
			activity: { status: "stopping", progress: { discovered: 101, total: null, canceled: 50 } },
			controls: { canStop: false, canRetry: false, canDismiss: false },
		});
		expect(stopping?.activity.finishedAt).toBeUndefined();
		expect(
			(
				await start_transfer(asUser, {
					membershipId: db.membershipId,
					requestId: "during-stop",
					kind: "copy",
					sourceIds: [folders.get(paths[0]!)!],
					targetParentId: folders.get("/target")!,
				})
			)._nay?.message,
		).toBe("A transfer is already running in this workspace");
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer_queries.get, args)).toMatchObject({
			activity: { status: "stopping", progress: { canceled: 100 } },
		});
		await t.mutation(internal.files_transfer.advance, { runId });
		const finished = await asUser.query(api.files_transfer_queries.get, args);
		// Stop came before discovery ended, so Retry would copy an incomplete list.
		expect(finished).toMatchObject({
			activity: { status: "canceled", progress: { total: null, canceled: 101, completed: 0, blocked: 0 } },
			controls: { canStop: false, canRetry: false, canDismiss: true },
		});
		expect(finished?.activity.finishedAt).toBeTypeOf("number");
		await asUser.mutation(api.files_transfer.stop, args);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer_queries.get, args)).toEqual(finished);
		await t.run(async (ctx) => {
			const items = await ctx.db.query("files_transfer_items").collect();
			expect(items).toHaveLength(101);
			expect(items.every((item) => item.state === "canceled" && item.attemptExpiresAt === null)).toBe(true);
			expect(await ctx.db.query("files_nodes").collect()).toHaveLength(102);
		});
	});

	test("moves blocked items into the canceled count once", async () => {
		const fixture = await create_folder_fixture(["/first", "/second", "/target/first", "/target/second"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/first")!, folders.get("/second")!]);
		expect(await finish_discovery(fixture, runId)).toMatchObject({
			activity: { status: "awaiting_input", progress: { total: 2, blocked: 2, canceled: 0 } },
		});
		const args = { membershipId: db.membershipId, runId };
		await asUser.mutation(api.files_transfer.stop, args);
		await asUser.mutation(api.files_transfer.stop, args);
		expect(await asUser.query(api.files_transfer_queries.get, args)).toMatchObject({
			activity: { status: "canceled", progress: { total: 2, blocked: 0, canceled: 2 } },
			conflicts: [],
		});
	});

	test("cancels discovery before any output and lets a new request start", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "canceled", progress: { discovered: 1, total: null, canceled: 1, completed: 0 } },
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(
			(
				await start_transfer(asUser, {
					membershipId: db.membershipId,
					requestId: "after-stop",
					kind: "copy",
					sourceIds: [folders.get("/source")!],
					targetParentId: folders.get("/target")!,
				})
			)._yay?.runId,
		).not.toBe(runId);
	});

	test("keeps a completed folder and prevents a queued file from publishing", async () => {
		const cancel = vi.spyOn(Workpool.prototype, "cancel");
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const file = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/source")!,
			filename: "queued.pdf",
			contentType: "application/pdf",
			size: 8,
		});
		if (file._nay) throw new Error(file._nay.message);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const completed = await get_node(fixture, "/target/source");
		expect(completed).not.toBeNull();
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_source", (q) =>
					q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", file._yay.nodeId),
				)
				.unique(),
		);
		if (!item?.workId) throw new Error("Missing queued copy worker");
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		expect(
			(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.status,
		).toBe("stopping");
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: item.workId,
			context: { itemId: item._id, attempt: item.attempt },
			result: { kind: "canceled" },
		});
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "canceled", progress: { completed: 1, canceled: 1 } },
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(completed!._id);
		expect(await get_node(fixture, "/target/source/queued.pdf")).toBeNull();
		expect(cancel).toHaveBeenCalledWith(expect.anything(), item.workId);
	});
});

describe("retry_remaining", () => {
	test.each(["immediately", "after its idle deadline"] as const)(
		"does not retry a preparing leaf discarded %s",
		async (when) => {
			const fixture = await create_folder_fixture(["/source", "/source/z-keep"]);
			const { t, db, asUser, folders } = fixture;
			const sourceFile = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get("/source")!,
				filename: "a.pdf",
				contentType: "application/pdf",
				size: 8,
			});
			if (sourceFile._nay) throw new Error(sourceFile._nay.message);
			await t.run((ctx) =>
				ctx.db.patch("files_r2_assets", sourceFile._yay.assetId, {
					r2Key: r2_create_asset_key({ ...db, assetId: sourceFile._yay.assetId }),
					unfinalizedExpiresAt: undefined,
				}),
			);
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "retry-leaf-thread",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "copy-leaf",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "saved", id: folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			await finish_discovery(fixture, runId);
			await t.mutation(internal.files_transfer.advance, { runId });
			const parent = await t.run((ctx) => ctx.db.query("files_pending_updates").first());
			if (!parent || parent.target.kind !== "private") throw new Error("Expected the copied parent");
			const saved = await test_save_file_pending_update(asUser, {
				membershipId: db.membershipId,
				target: parent.target,
				pendingUpdateId: parent._id,
				reviewedRevision: parent.revision,
			});
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected its saved parent");
			const savedParentId = saved._yay.target.id;
			await t.mutation(internal.files_transfer.advance, { runId });
			const leaf = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) =>
						q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", sourceFile._yay.nodeId),
					)
					.unique(),
			);
			if (!leaf?.preparation || !leaf.workId) throw new Error("Expected a preparing leaf");
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", leaf.preparation!.pendingUpdateId));
			if (!proposal) throw new Error("Expected its proposal");
			if (when === "after its idle deadline") {
				const expiresAt = proposal.updatedAt + 4 * 60 * 60 * 1000;
				expect(proposal.expiresAt).toBe(expiresAt);
				vi.setSystemTime(expiresAt);
				await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
					organizationId: proposal.organizationId,
					workspaceId: proposal.workspaceId,
					userId: proposal.userId,
				});
				// The running copy holds the leaf. The job keeps it and only moves its expiry to the next try.
				expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual({
					...proposal,
					expiresAt: expiresAt + 60_000,
				});
				expect(await t.run((ctx) => ctx.db.get("files_transfer_items", leaf._id))).toMatchObject({ state: "copying" });
			}
			expect(
				(
					await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
						membershipId: db.membershipId,
						target: proposal.target,
						pendingUpdateId: proposal._id,
						reviewedRevision: proposal.revision,
					})
				)._nay,
			).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", leaf._id))).toMatchObject({
				state: "canceled",
				cancelReason: "proposal_discard",
			});
			await t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: leaf.workId,
				context: { itemId: leaf._id, attempt: leaf.attempt },
				result: { kind: "canceled" },
			});
			await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId });
			await finish_folder_copy(fixture, runId);
			const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
				membershipId: db.membershipId,
				runId,
				requestId: "retry-without-leaf",
			});
			if (retried._nay) throw new Error(retried._nay.message);
			const finished = await finish_folder_copy(fixture, retried._yay.runId);
			expect(finished.activity).toMatchObject({
				status: "partial",
				progress: { total: 3, completed: 2, canceled: 1, failed: 0 },
			});
			const retryItems = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", retried._yay.runId))
					.collect(),
			);
			expect(retryItems.find((item) => item.source.id === sourceFile._yay.nodeId)).toMatchObject({
				state: "canceled",
				attempt: 0,
				outputTarget: null,
				cancelReason: "proposal_discard",
			});
			const activeDrafts = await t.run((ctx) =>
				ctx.db
					.query("files_pending_nodes")
					.filter((q) => q.eq(q.field("state"), "active"))
					.collect(),
			);
			expect(activeDrafts.map((node) => ({ name: node.name, parent: node.parent }))).toEqual([
				{ name: "z-keep", parent: { kind: "saved", id: savedParentId } },
			]);
			expect((await get_node(fixture, "/source/a.pdf"))?._id).toBe(sourceFile._yay.nodeId);
			expect(await get_node(fixture, "/target/source/a.pdf")).toBeNull();
		},
	);

	test("a move retry takes no op", async () => {
		const fixture = await create_folder_fixture(["/source", "/target/source"]);
		const { t, db, asUser, folders } = fixture;
		const started = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "move-retry-no-op",
			kind: "move",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await finish_discovery(fixture, runId)).toMatchObject({ activity: { status: "awaiting_input" } });
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await finish_move(fixture, runId);

		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "move-retry-no-op-again",
		});
		if (retried._nay) throw new Error(retried._nay.message);

		// Only a copy op is deleted when its run ends. An op on a move retry would stay and block every
		// later restore and paste on these folders.
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
	});

	test("does not copy a source that moved away after the first run", async () => {
		const fixture = await create_folder_fixture(["/source", "/elsewhere"]);
		const { t, db, asUser, folders } = fixture;
		const created = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/source")!,
			filename: "moved.bin",
			contentType: "application/octet-stream",
			size: 8,
		});
		if (created._nay) throw new Error(created._nay.message);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await finish_folder_copy(fixture, runId);

		// The manifest is frozen, so the retry still names the old path. Moving the file out must not
		// let the retry copy from where it used to be.
		expect(
			(
				await test_move_nodes(t, asUser, {
						membershipId: db.membershipId,
						itemIds: [created._yay.nodeId],
						targetParentId: folders.get("/elsewhere")!,
					})
			)._nay,
		).toBeUndefined();
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-moved-source",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		const finished = await finish_folder_copy(fixture, retried._yay.runId);
		// The retry stops while it is still planning, so nothing is copied at all.
		expect(finished.activity).toMatchObject({ status: "awaiting_input", progress: { completed: 0 } });
		expect(finished.conflicts).toMatchObject([{ kind: "source_changed" }]);
		expect(await get_node(fixture, "/target/source/moved.bin")).toBeNull();
		expect((await get_node(fixture, "/elsewhere/moved.bin"))?._id).toBe(created._yay.nodeId);
	});

	test("keeps the first run in history while the retry copies its manifest", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await finish_folder_copy(fixture, runId);
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-pins-history",
		});
		if (retried._nay) throw new Error(retried._nay.message);

		// The retry still reads its manifest from the first run, so a deletion must wait. Otherwise the
		// retry would copy half a manifest and lose the rest of the work.
		expect(await t.run((ctx) => files_transfer_db_delete_run_batch(ctx, { runId, batchSize: 50 }))).toEqual({
			done: false,
			deletedCount: 0,
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).not.toBeNull();

		// Once the manifest is copied the retry leaves the "retry" step and the first run can go away.
		await finish_folder_copy(fixture, retried._yay.runId);
		for (let step = 0; step < 20; step += 1) {
			const deleted = await t.run((ctx) => files_transfer_db_delete_run_batch(ctx, { runId, batchSize: 50 }));
			if (deleted.done) break;
		}
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toBeNull();
	});

	test("retries a failed file and leaves a skipped sibling out of the retry", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const sourceIds: Id<"files_nodes">[] = [];
		for (const parent of ["/source", "/target"] as const) {
			for (const filename of ["skipped.bin", "fails.bin"]) {
				// The copy of "skipped.bin" meets an occupant in /target and asks; the answer is Skip.
				if (parent === "/target" && filename === "fails.bin") continue;
				const created = await asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: db.membershipId,
					parentId: folders.get(parent)!,
					filename,
					contentType: "application/octet-stream",
					size: 8,
				});
				if (created._nay) throw new Error(created._nay.message);
				if (parent === "/source") sourceIds.push(created._yay.nodeId);
			}
		}
		const runId = await start_copy(fixture, sourceIds);
		const waiting = await finish_discovery(fixture, runId);
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "skip" as const }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();

		// Drop the plan so the remaining file copy fails for real instead of being canceled.
		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" }));
		const read_failing = async () =>
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) =>
						q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", sourceIds[1]!),
					)
					.unique(),
			);
		let failing = await read_failing();
		for (let step = 0; step < 10 && !failing?.workId; step += 1) {
			await t.mutation(internal.files_transfer.advance, { runId });
			failing = await read_failing();
		}
		if (!failing?.workId) throw new Error("Missing queued copy worker");
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: failing._id, attempt: failing.attempt });
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: failing.workId,
			context: { itemId: failing._id, attempt: failing.attempt },
			result: { kind: "success", returnValue: null },
		});
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "failed", progress: { total: 2, completed: 0, skipped: 1, failed: 1 } },
		});

		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-failed-file",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		await t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
		const retryItems = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", retried._yay.runId))
				.collect(),
		);
		// The skipped file keeps the user's answer and is never copied again. The failed file starts over.
		expect(retryItems.find((item) => item.source.id === sourceIds[0])).toMatchObject({
			state: "skipped",
			attempt: 0,
			errorMessage: null,
		});
		expect(retryItems.find((item) => item.source.id === sourceIds[1])).toMatchObject({
			state: "pending",
			attempt: 0,
			errorMessage: null,
			outputTarget: null,
		});
		expect(
			await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: retried._yay.runId }),
		).toMatchObject({ activity: { progress: { discovered: 2, skipped: 1, completed: 0 } } });
		expect(await get_node(fixture, "/target/fails.bin")).toBeNull();
	});

	test.each(["private", "saved", "moved", "discarded"] as const)(
		"resolves a completed private parent that is %s before retry",
		async (parentState) => {
			const fixture = await create_folder_fixture(["/source", "/source/first", "/source/second"]);
			const { t, db, asUser, folders } = fixture;
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "retry-private-parent",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "private-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "saved", id: folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			await finish_discovery(fixture, runId);
			await t.mutation(internal.files_transfer.advance, { runId });
			const parent = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_parentItem", (q) => q.eq("runId", runId).eq("parentItemId", null))
					.unique(),
			);
			if (parent?.outputTarget?.kind !== "private") throw new Error("Expected a ready private folder");
			const privateParent = parent.outputTarget;
			const proposal = await t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", privateParent.id))
					.unique(),
			);
			if (!proposal) throw new Error("Expected its create proposal");
			const reviewed = {
				membershipId: db.membershipId,
				target: privateParent,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			};
			let savedParentId: Id<"files_nodes"> | null = null;
			if (parentState === "saved" || parentState === "moved") {
				const saved = await test_save_file_pending_update(asUser, reviewed);
				if (saved._nay || saved._yay.target.kind !== "saved")
					throw new Error(saved._nay?.message ?? "Expected a saved folder");
				savedParentId = saved._yay.target.id;
				if (parentState === "moved")
					expect(
						(
							await test_rename_node(t, asUser, {
								membershipId: db.membershipId,
								nodeId: savedParentId,
								path: "moved",
							})
						)._nay,
					).toBeUndefined();
			} else if (parentState === "discarded") {
				expect(
					(await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, reviewed))._nay,
				).toBeUndefined();
			}
			expect(
				(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
			).toBeUndefined();
			await finish_folder_copy(fixture, runId);
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
				membershipId: db.membershipId,
				runId,
				requestId: "retry-private",
			});
			if (retried._nay) throw new Error(retried._nay.message);
			const finished = await finish_folder_copy(fixture, retried._yay.runId);
			if (parentState === "moved" || parentState === "discarded") {
				expect(finished).toMatchObject({
					activity: { status: "awaiting_input", progress: { completed: 1 } },
					conflicts: [{ kind: "destination_changed" }],
				});
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("files_pending_nodes")
							.filter((q) => q.eq(q.field("state"), "active"))
							.collect(),
					),
				).toEqual([]);
			} else {
				expect(finished.activity).toMatchObject({ status: "succeeded", progress: { total: 3, completed: 3 } });
				const children = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
				expect(
					children
						.filter((node) => node._id !== privateParent.id)
						.map((node) => ({ name: node.name, parent: node.parent })),
				).toEqual([
					{ name: "first", parent: savedParentId ? { kind: "saved", id: savedParentId } : privateParent },
					{ name: "second", parent: savedParentId ? { kind: "saved", id: savedParentId } : privateParent },
				]);
			}
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test("keeps ready parents and retries only the frozen remaining manifest", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/first", "/source/second"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const readyParent = await get_node(fixture, "/target/source");
		await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId });
		await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/source")!,
			path: "added-later",
		});
		const args = { membershipId: db.membershipId, runId, requestId: "retry-remaining" };
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, args);
		if (retried._nay) throw new Error(retried._nay.message);
		expect(await asUser.mutation(api.files_transfer.retry_remaining, args)).toEqual(retried);
		expect(await finish_folder_copy(fixture, retried._yay.runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 3, completed: 3 } },
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(readyParent!._id);
		expect(await get_node(fixture, "/target/source/first")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/second")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/added-later")).toBeNull();
		expect(
			await asUser.mutation(api.files_transfer.retry_remaining, { ...args, requestId: "reopen-old-retry" }),
		).toEqual(retried);
	});

	test("keeps the whole manifest when Stop is repeated during retry preparation", async () => {
		const fixture = await create_folder_fixture([
			"/source",
			...Array.from({ length: 55 }, (_, index) => `/source/${index}`),
		]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId });
		await finish_folder_copy(fixture, runId);
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-stop",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		const stopArgs = { membershipId: db.membershipId, runId: retried._yay.runId };
		await asUser.mutation(api.files_transfer.stop, stopArgs);
		await asUser.mutation(api.files_transfer.stop, stopArgs);
		await t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
		await asUser.mutation(api.files_transfer.stop, stopArgs);
		expect((await asUser.query(api.files_transfer_queries.get, stopArgs))?.activity.status).toBe("stopping");
		expect(await finish_folder_copy(fixture, retried._yay.runId)).toMatchObject({
			activity: { status: "canceled", progress: { discovered: 56, total: 56, completed: 0, canceled: 56 } },
		});
		const again = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId: retried._yay.runId,
			requestId: "retry-again",
		});
		if (again._nay) throw new Error(again._nay.message);
		expect(await finish_folder_copy(fixture, again._yay.runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 56, completed: 56 } },
		});
	});
});

describe("move", () => {
	// 3 names of 255 characters and one of 249 make a path of 1,018 characters. Under /target it
	// would be 1,025.
	const topPath = `/${"0".repeat(255)}`;
	const deepPath = `/${Array.from({ length: 3 }, (_, index) => String(index % 10).repeat(255)).join("/")}/${"z".repeat(249)}`;

	test("refuses a Move that would push a path inside the folder past 1,024 characters", async () => {
		const fixture = await create_folder_fixture([deepPath]);
		const top = await get_node(fixture, topPath);
		if (!top) throw new Error("Expected the top folder");

		expect(
			await test_move_nodes(fixture.t, fixture.asUser, {
				membershipId: fixture.db.membershipId,
				itemIds: [top._id],
				targetParentId: fixture.folders.get("/target")!,
			}),
		).toMatchObject({
			_nay: {
				name: "path_too_long",
				message: `…/${"z".repeat(249)} would have a path of 1,025 characters. Paths can have at most 1,024 characters. Shorten a folder name or move it higher.`,
			},
		});
		expect((await get_node(fixture, deepPath))?._id, "the deepest folder keeps its path").toBe(
			fixture.folders.get(deepPath),
		);
	});

	test.each(["parent", "item"] as const)("a Move path refusal respects a restricted %s", async (restricted) => {
		const secretName = "secret-file-name-should-stay-private.txt";
		const deepPath = `/source/locked/${["a", "b", "c"].map((letter) => letter.repeat(240)).join("/")}/${secretName}`;
		const destination = `/${"d".repeat(255)}`;
		const fixture = await create_folder_fixture(["/source", "/source/locked", deepPath, destination]);
		const member = await add_member(fixture);
		expect(
			await fixture.asUser.mutation(api.files_sharing.restrict_node, {
				membershipId: fixture.db.membershipId,
				nodeId: fixture.folders.get(restricted === "parent" ? "/source/locked" : deepPath)!,
			}),
		).toEqual({ _yay: null });
		const result = await test_move_nodes(fixture.t, member.asUser, {
			membershipId: member.membershipId,
			itemIds: [fixture.folders.get("/source")!],
			targetParentId: fixture.folders.get(destination)!,
		});
		expect(result._nay?.name).toBe("path_too_long");
		if (restricted === "parent") {
			expect(result._nay?.message, "Move errors must not name descendants below a locked folder").not.toContain(
				secretName,
			);
			expect(result._nay?.message).toBe(
				'An item inside "source" would exceed the 1,024-character path limit. Shorten a folder name or move it higher.',
			);
		} else {
			// A locked item's name stays visible when its parent is readable.
			expect(result._nay?.message).toContain(secretName);
		}
		expect((await get_node(fixture, deepPath))?._id, "the failed Move keeps the original path").toBe(
			fixture.folders.get(deepPath),
		);
	});

	// `/s` + 3 names of 255 characters + one of 251 make 1,022 characters.
	const names = [..."abc"].map((letter) => letter.repeat(255));
	const chainPath = `/${[...names, "d".repeat(251)].join("/")}`;

	/**
	 * Give `/s` a longer name with every path inside, like paths stored before the limit. The deepest
	 * one gets 1,031 characters.
	 */
	async function lengthen_s(fixture: Awaited<ReturnType<typeof create_folder_fixture>>) {
		await fixture.t.run(async (ctx) => {
			for (const node of await ctx.db.query("files_nodes").collect()) {
				if (node.path !== "/s" && !node.path.startsWith("/s/")) continue;
				const path = `/ssssssssss${node.path.slice(2)}`;
				await ctx.db.patch("files_nodes", node._id, {
					...(node.path === "/s" ? { name: "ssssssssss", sortName: files_sort_text_key("ssssssssss") } : {}),
					path,
					treePath: `${path}/`,
				});
			}
		});
	}

	test("moves a folder whose paths are already over 1,024 characters higher, even when they stay over", async () => {
		const fixture = await create_folder_fixture([`/s${chainPath}`, "/sssss"]);
		await lengthen_s(fixture);
		const top = await get_node(fixture, `/ssssssssss/${names[0]}`);
		if (!top) throw new Error("Expected the top folder");
		expect((await get_node(fixture, `/ssssssssss${chainPath}`))?.path.length).toBe(1031);

		expect(
			await test_move_nodes(fixture.t, fixture.asUser, {
				membershipId: fixture.db.membershipId,
				itemIds: [top._id],
				targetParentId: fixture.folders.get("/sssss")!,
			}),
		).toEqual({ _yay: null });
		expect((await get_node(fixture, `/sssss${chainPath}`))?.path.length, "the deepest path got shorter").toBe(1026);
	});

	test("Rename lets a path over 1,024 characters get shorter, and a refusal names the item", async () => {
		const fixture = await create_folder_fixture([`/s${chainPath}`]);
		await lengthen_s(fixture);
		const deepest = (await get_node(fixture, `/ssssssssss${chainPath}`))!;
		const rename = (name: string) =>
			test_rename_node(fixture.t, fixture.asUser, {
				membershipId: fixture.db.membershipId,
				nodeId: deepest._id,
				path: name,
			});

		expect((await rename("d".repeat(246)))._nay, "a Rename that makes the path 5 characters shorter").toBeUndefined();
		expect((await fixture.t.run((ctx) => ctx.db.get("files_nodes", deepest._id)))?.path.length).toBe(1026);
		expect(await rename("d".repeat(252)), "a Rename that makes the path 6 characters longer").toMatchObject({
			_nay: {
				name: "path_too_long",
				message: `…/${"d".repeat(252)} would have a path of 1,032 characters. Paths can have at most 1,024 characters. Shorten a folder name or move it higher.`,
			},
		});
	});

	test("an agent Move of a draft lets a path over 1,024 characters get shorter, and a refusal names the item", async () => {
		const fixture = await create_folder_fixture([`/s/${names.join("/")}`]);
		const created = await fixture.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: fixture.db.organizationId,
			workspaceId: fixture.db.workspaceId,
			userId: fixture.db.userId,
			path: `/s/${names.join("/")}/${"e".repeat(251)}`,
			kind: "folder",
		});
		if (created._nay) throw new Error(created._nay.message);
		// The draft follows its saved folder to 1,031 characters.
		await lengthen_s(fixture);
		const folder = (await get_node(fixture, `/ssssssssss/${names.join("/")}`))!;
		const move = (destName: string) =>
			fixture.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: fixture.db.organizationId,
				workspaceId: fixture.db.workspaceId,
				userId: fixture.db.userId,
				target: created._yay.target,
				destParent: { kind: "saved", id: folder._id },
				destName,
			});

		expect(await move("e".repeat(246)), "a Move that makes the path 5 characters shorter").toMatchObject({
			_yay: { destPath: `/ssssssssss/${names.join("/")}/${"e".repeat(246)}` },
		});
		expect(await move("e".repeat(252)), "a Move that makes the path 6 characters longer").toMatchObject({
			_nay: {
				name: "path_too_long",
				message: `…/${"e".repeat(252)} would have a path of 1,032 characters. Paths can have at most 1,024 characters. Shorten a folder name or move it higher.`,
			},
		});
	});

	test("an agent mv to a new name lets a path over 1,024 characters get shorter", async () => {
		const fixture = await create_folder_fixture([`/s${chainPath}`]);
		await lengthen_s(fixture);
		const parentPath = `/ssssssssss/${names.join("/")}`;
		const parent = (await get_node(fixture, parentPath))!;
		const deepest = (await get_node(fixture, `/ssssssssss${chainPath}`))!;
		const thread = await fixture.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: fixture.db.membershipId,
			clientGeneratedId: "long-path-mv-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const mv = (name: string) =>
			start_agent_transfer(fixture.t, {
				membershipId: fixture.db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: `long-path-mv-${name.length}`,
				kind: "move",
				sources: [{ kind: "saved", id: deepest._id }],
				targetParent: { kind: "saved", id: parent._id },
				targetPath: parentPath,
				targetName: name,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});

		expect(await mv("d".repeat(252)), "an mv that makes the path 1 character longer").toMatchObject({
			_nay: {
				name: "path_too_long",
				message: `…/${"d".repeat(252)} would have a path of 1,032 characters. Paths can have at most 1,024 characters. Shorten a folder name or move it higher.`,
			},
		});
		expect((await mv("d".repeat(246)))._nay, "an mv that makes the path 5 characters shorter").toBeUndefined();
	});

	test("refuses a Copy that would push a path inside the folder past 1,024 characters, before any write", async () => {
		const fixture = await create_folder_fixture([deepPath]);
		const top = await get_node(fixture, topPath);
		if (!top) throw new Error("Expected the top folder");
		const nodesBefore = await fixture.t.run((ctx) => ctx.db.query("files_nodes").collect());

		const runId = await start_copy(fixture, [top._id]);
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "failed",
			errorMessage: "Paths can have at most 1,024 characters.",
		});
		expect(await fixture.t.run((ctx) => ctx.db.query("files_nodes").collect()), "nodes after the refused Copy").toEqual(
			nodesBefore,
		);
	});

	test("releases proposal Move holds after Stop keeps its first output", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser, folders } = fixture;
		const sources = [];
		for (const path of ["/one", "/two"]) {
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path,
				kind: "folder",
			});
			if (created._nay) throw new Error(created._nay.message);
			sources.push(created._yay.target);
		}
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "move-stop-holds",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "move-stop-holds",
			kind: "move",
			sources,
			targetParent: { kind: "saved", id: folders.get("/target")! },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		await finish_discovery(fixture, runId);
		const completed = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_state_order", (q) => q.eq("runId", runId).eq("state", "completed"))
				.unique(),
		);
		expect(completed?.outputPath).toBe("/target/one");
		if (!completed?.outputProposal) throw new Error("Expected the first Move output proposal");
		const pendingUpdateId = completed.outputProposal.pendingUpdateId;
		const before = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!before) throw new Error("Expected its ready draft");
		vi.setSystemTime(Date.now() + 60_000);
		expect(
			await t.mutation(internal.files_transfer.stop_for_agent, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				runId,
				reason: "user",
			}),
		).toEqual({ _yay: null });
		const ended = await t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		expect(ended?.outputReviewUntil, "Stop must set the Move output review deadline").toBe(
			Date.now() + 4 * 60 * 60 * 1000,
		);
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "canceled", progress: { completed: 1, canceled: 1 } },
		});
		await expect(
			t.mutation(internal.files_pending_holds.release_producer, {
				producer: { kind: "files_transfer_run", id: runId },
			}),
			"Terminal Move holds must release without a missing deadline",
		).resolves.toBeNull();
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_pending_holds")
					.withIndex("by_producer_pendingUpdate_role", (q) =>
						q.eq("producer.kind", "files_transfer_run").eq("producer.id", runId),
					)
					.collect(),
			),
		).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toEqual({
			...before,
			expiresAt: ended!.outputReviewUntil,
		});
	});

	test("moves while another user's unrelated Copy waits for a conflict choice", async () => {
		const fixture = await create_folder_fixture([
			"/copy-source/item",
			"/copy-target",
			"/copy-target/item",
			"/moving",
			"/moving/child",
		]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const copying = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "paused-unrelated-copy",
			kind: "copy",
			sourceIds: [folders.get("/copy-source/item")!],
			targetParentId: folders.get("/copy-target")!,
		});
		if (copying._nay) throw new Error(copying._nay.message);
		const copyRunId = copying._yay.runId;
		expect(await finish_discovery(fixture, copyRunId)).toMatchObject({
			activity: { status: "awaiting_input", progress: { completed: 0, blocked: 1 } },
		});
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_subtree_ops")
					.withIndex("by_transferRun", (q) => q.eq("transferRunId", copyRunId))
					.unique(),
			),
		).toMatchObject({ kind: "copy", status: "running" });
		const moving = await start_transfer(member.asUser, {
			membershipId: member.membershipId,
			requestId: "move-past-unrelated-copy",
			kind: "move",
			sourceIds: [folders.get("/moving")!],
			targetParentId: folders.get("/target")!,
		});
		if (moving._nay) throw new Error(moving._nay.message);
		const moveArgs = { membershipId: member.membershipId, runId: moving._yay.runId };
		// Finish only this Move. The other user's choice must stay open.
		await test_finish_transfer_run(member.asUser, moving._yay.runId);
		expect(
			await member.asUser.query(api.files_transfer_queries.get, moveArgs),
			"An unrelated paused Copy must not block Move",
		).toMatchObject({ activity: { status: "succeeded", progress: { completed: 1 } } });
		expect((await get_node(fixture, "/target/moving"))?._id).toBe(folders.get("/moving"));
		expect((await get_node(fixture, "/target/moving/child"))?._id).toBe(folders.get("/moving/child"));
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: copyRunId })).toMatchObject({
			activity: { status: "awaiting_input", progress: { completed: 0, blocked: 1 } },
		});
	});

	test("keeps a Paste alive while it waits for another user's long Move", async () => {
		const fixture = await create_folder_fixture(["/first", "/second"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const first = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "long-move",
			kind: "move",
			sourceIds: [folders.get("/first")!],
			targetParentId: folders.get("/target")!,
		});
		if (first._nay) throw new Error(first._nay.message);
		const slot = () =>
			t.run((ctx) =>
				ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
					.unique(),
			);
		for (let step = 0; step < 10 && !(await slot())?.cohortId; step++)
			await t.mutation(internal.files_transfer.advance, { runId: first._yay.runId });
		expect((await slot())?.cohortId, "the first Move holds the workspace").not.toBeNull();
		const second = await member.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: member.membershipId,
			requestId: "waiting-move",
			kind: "move",
			sourceIds: [folders.get("/second")!],
			expectedSourceCount: 1,
			targetParentId: folders.get("/target")!,
		});
		if (second._nay) throw new Error(second._nay.message);
		expect(
			await member.asUser.mutation(api.files_transfer.seal, {
				membershipId: member.membershipId,
				runId: second._yay.runId,
			}),
		).toEqual({ _yay: null });
		const secondArgs = { membershipId: member.membershipId, runId: second._yay.runId };
		// The waiting Paste checks again every second. Here each check is 5 minutes apart, for 35 minutes.
		for (let minute = 5; minute <= 35; minute += 5) {
			await t.mutation(internal.files_transfer.advance, { runId: second._yay.runId });
			vi.setSystemTime(Date.now() + 5 * 60_000);
			await t.mutation(internal.activities.recover_expired, { _test_disableReschedule: true });
		}
		const waiting = (await member.asUser.query(api.files_transfer_queries.get, secondArgs))?.activity;
		expect(waiting?.status, "a Paste waiting for a Move does not time out").toBe("queued");
		expect(waiting?.errorCode, "the waiting Paste says why").toBe("waiting_for_move");
		expect((await slot())?.cohortId, "the first Move still holds the workspace").not.toBeNull();
		// An agent's Move keeps its fixed deadline. When that ends the wait, the reason is clear.
		await t.run((ctx) => ctx.db.patch("files_transfer_runs", second._yay.runId, { fixedDeadline: true }));
		await t.mutation(internal.files_transfer.advance, { runId: second._yay.runId });
		vi.setSystemTime(Date.now() + 31 * 60_000);
		await t.mutation(internal.files_transfer.advance, { runId: second._yay.runId });
		expect(
			(await member.asUser.query(api.files_transfer_queries.get, secondArgs))?.activity,
			"a Move that timed out while waiting says why",
		).toMatchObject({
			errorCode: "timed_out",
			errorMessage: "Another Move in this workspace did not finish in time. Nothing was moved. Try again later.",
		});
	});

	test("holds the empty private destination before a Move Retry's first page", async () => {
		const paths = Array.from({ length: 201 }, (_, index) => `/source-${index.toString().padStart(3, "0")}`);
		const fixture = await create_folder_fixture(paths);
		const { t, db, asUser, folders } = fixture;
		const parent = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/draft-target",
			kind: "folder",
		});
		if (parent._nay || parent._yay.target.kind !== "private" || !parent._yay.pendingUpdateId)
			throw new Error("Expected a private destination folder");
		const privateParentId = parent._yay.target.id;
		const pendingUpdateId = parent._yay.pendingUpdateId;
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "move-retry-parent-hold",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "move-retry-parent-hold",
			kind: "move",
			sources: paths.map((path) => ({ kind: "saved", id: folders.get(path)! })),
			targetParent: parent._yay.target,
			targetPath: "/draft-target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			step: "plan",
			activity: { progress: { total: paths.length, completed: 0 } },
		});
		expect(
			await t.mutation(internal.files_transfer.stop_for_agent, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				runId,
				reason: "user",
			}),
		).toEqual({ _yay: null });
		await test_finish_transfer_run(asUser, runId);
		await t.mutation(internal.files_pending_holds.release_producer, {
			producer: { kind: "files_transfer_run", id: runId },
		});
		const released = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!released) throw new Error("Expected the empty destination draft");
		vi.setSystemTime(released.expiresAt - 1);
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "move-parent-retry",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		// No retry page has run yet. Its parent still needs protection now.
		vi.setSystemTime(released.expiresAt + 1);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
		});
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_nodes", privateParentId)))?.state,
			"Move Retry must hold its empty private destination past its old expiry",
		).toBe("active");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toEqual({
			...released,
			expiresAt: Date.now() + 60_000,
		});
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_pending_holds")
					.withIndex("by_producer_pendingUpdate_role", (q) =>
						q
							.eq("producer.kind", "files_transfer_run")
							.eq("producer.id", retried._yay.runId)
							.eq("pendingUpdateId", pendingUpdateId),
					)
					.collect(),
			),
		).toMatchObject([{ role: "destination_parent" }]);
	});

	test.each(["file", "folder"] as const)(
		"replaces only the reviewed %s and keeps the source identity",
		async (kind) => {
			const fixture = await create_folder_fixture(kind === "folder" ? ["/source", "/target/source"] : []);
			const { t, db, asUser, folders } = fixture;
			const nodeIds: Id<"files_nodes">[] = [];
			if (kind === "file") {
				for (const parentId of [files_ROOT_ID, folders.get("/target")!]) {
					const created = await asUser.mutation(api.files_nodes.create_upload_node, {
						membershipId: db.membershipId,
						parentId,
						filename: "source",
						contentType: "application/octet-stream",
						size: 8,
					});
					if (created._nay) throw new Error(created._nay.message);
					nodeIds.push(created._yay.nodeId);
				}
			} else nodeIds.push(folders.get("/source")!, folders.get("/target/source")!);
			const started = await start_transfer(asUser, {
				membershipId: db.membershipId,
				requestId: "move-replace",
				kind: "move",
				sourceIds: [nodeIds[0]!],
				targetParentId: folders.get("/target")!,
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			const waiting = await finish_discovery(fixture, runId);
			const page = await asUser.query(api.files_transfer_queries.list_items, {
				membershipId: db.membershipId,
				runId,
				paginationOpts: { cursor: null, numItems: 50 },
			});
			const item = page!.page[0]!;
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting.revision,
						choices: [
							{
								itemId: item.itemId,
								choice: "replace",
								reviewedTarget: item.conflict!.target!,
								reviewedVersion: item.conflict!.version,
							},
						],
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
			expect(await finish_move(fixture, runId)).toMatchObject({
				activity: { status: "succeeded", progress: { completed: 1 } },
			});
			const source = await t.run((ctx) => ctx.db.get("files_nodes", nodeIds[0]!));
			const replaced = await t.run((ctx) => ctx.db.get("files_nodes", nodeIds[1]!));
			expect(source?.path).toBe(`/target/${source!.name}`);
			expect(source?.archiveOperationId).toBeNull();
			expect(replaced?.archiveOperationId).not.toBeNull();
		},
	);

	test("keeps the moved file's metadata and version history when it replaces an occupant", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser, folders } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/notes.md",
			textContent: "keep these bytes",
		});
		// Finish the fixture's future draft checks before the Move deadline starts.
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: sourceId,
					metadataYaml: ["owner: Ray", "priority: 3"].join("\n"),
				})
			)._nay,
		).toBeUndefined();
		const occupant = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/target")!,
			filename: "notes.md",
			contentType: "application/octet-stream",
			size: 8,
		});
		if (occupant._nay) throw new Error(occupant._nay.message);

		const read_versions = async (fileNodeId: Id<"files_nodes">) =>
			await t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.filter((q) => q.eq(q.field("fileNodeId"), fileNodeId))
					.collect(),
			);
		const read_metadata_docs = async (fileNodeId: Id<"files_nodes">) =>
			await t.run((ctx) =>
				ctx.db
					.query("files_metadata_docs")
					.filter((q) => q.eq(q.field("fileNodeId"), fileNodeId))
					.collect()
					// Move writes new docs, so their creation order can change.
					.then((docs) =>
						docs.sort((a, b) =>
							a.fieldPath.localeCompare(b.fieldPath) ||
							a.docKind.localeCompare(b.docKind) ||
							(a.entryIndex ?? 0) - (b.entryIndex ?? 0),
						),
					),
			);
		const versionsBefore = await read_versions(sourceId);
		const metadataDocsBefore = await read_metadata_docs(sourceId);
		const entriesBefore = await asUser.query(api.files_metadata.get_entries, {
			membershipId: db.membershipId,
			fileNodeId: sourceId,
		});
		// Guard the fixture: an empty history or empty metadata would make the checks below pass for
		// the wrong reason.
		expect(versionsBefore.length).toBeGreaterThan(0);
		expect(entriesBefore.length).toBeGreaterThan(0);

		const started = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "move-replace-history",
			kind: "move",
			sourceIds: [sourceId],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		const waiting = await finish_discovery(fixture, runId);
		const page = await asUser.query(api.files_transfer_queries.list_items, {
			membershipId: db.membershipId,
			runId,
			paginationOpts: { cursor: null, numItems: 50 },
		});
		const item = page!.page[0]!;
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [
						{
							itemId: item.itemId,
							choice: "replace",
							reviewedTarget: item.conflict!.target!,
							reviewedVersion: item.conflict!.version,
						},
					],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_move(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1 } },
		});

		// The move replaces the occupant and carries the source node itself, so the source keeps its
		// id, its saved versions and its metadata. Nothing may move to the archived occupant.
		const moved = await t.run((ctx) => ctx.db.get("files_nodes", sourceId));
		expect(moved).toMatchObject({ path: "/target/notes.md", archiveOperationId: null });
		expect(await read_versions(sourceId)).toEqual(versionsBefore);
		// Move publishes new docs with the same values, node id, and saved version.
		const metadataDocsAfter = await read_metadata_docs(sourceId);
		expect(metadataDocsAfter.map(({ _id, _creationTime, ...fields }) => fields)).toEqual(
			metadataDocsBefore.map(({ _id, _creationTime, ...fields }) => ({
				...fields,
				path: moved!.path,
				treePath: moved!.treePath,
				...(fields.docKind === "field" ? {
					parentId: moved!.parentId,
					name: moved!.name,
					sortName: moved!.sortName,
				} : {}),
			})),
		);
		expect(metadataDocsAfter.map((doc) => doc.fieldPath).sort()).toEqual(
			metadataDocsBefore.map((doc) => doc.fieldPath).sort(),
		);
		expect([...new Set(metadataDocsAfter.map((doc) => doc.path))]).toEqual(["/target/notes.md"]);
		expect(
			await asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: sourceId }),
		).toEqual(entriesBefore);
		expect(await read_versions(occupant._yay.nodeId)).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get("files_nodes", occupant._yay.nodeId)))?.archiveOperationId).not.toBeNull();
	});

	test.each(["normal", "held"] as const)(
		"Move refuses to replace a folder with a %s child and keeps the choice open",
		async (childState) => {
			const fixture = await create_folder_fixture([
				"/source",
				"/source/child",
				"/target/source",
				"/target/source/keep",
				...(childState === "held" ? ["/target/source/keep/child"] : []),
				"/other",
			]);
			const { t, db, asUser, folders } = fixture;
			const started = await start_transfer(asUser, {
				membershipId: db.membershipId,
				requestId: "move-replace-full-folder",
				kind: "move",
				sourceIds: [folders.get("/source")!],
				targetParentId: folders.get("/target")!,
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			const waiting = await finish_discovery(fixture, runId);
			const list = async () =>
				(await asUser.query(api.files_transfer_queries.list_items, {
					membershipId: db.membershipId,
					runId,
					paginationOpts: { cursor: null, numItems: 50 },
				}))!.page[0]!;
			const item = await list();
			expect(item).toMatchObject({ state: "conflict", conflictKind: "name_conflict" });
			if (childState === "held") {
				// Another member's Move holds the child, so the child is out of the normal docs until it ends.
				const member = await add_member(fixture);
				const keepId = folders.get("/target/source/keep")!;
				const overlay = await import("../server/files-pending-overlay.ts");
				const canJoin = overlay.files_pending_overlay_db_can_join_step;
				const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step");
				let yielded = false;
				// Yield once before the other Move reserves its source.
				join.mockImplementation(async (ctx, limitFactor) => {
					const allowed = await canJoin(ctx, limitFactor);
					if (limitFactor !== 4) return allowed;
					yielded = true;
					join.mockRestore();
					return false;
				});
				const other = await start_transfer(member.asUser, {
					membershipId: member.membershipId,
					requestId: "move-hold-child",
					kind: "move",
					sourceIds: [keepId],
					targetParentId: folders.get("/other")!,
				});
				if (other._nay) throw new Error(other._nay.message);
				for (let step = 0; !(await t.run((ctx) => ctx.db.get("files_nodes", keepId)))?.moveCohortId; step++) {
					if (step === 20) throw new Error("The other Move did not hold the child");
					const cohort = await t.run((ctx) => test_db_get_slot_cohort(ctx, db));
					if (cohort)
						await t.action(internal.files_move_run.run, {
							cohortId: cohort._id,
							step: cohort.step,
							runGeneration: cohort.runJob?.generation ?? null,
							mode: "step",
						});
					else await t.mutation(internal.files_transfer.advance, { runId: other._yay.runId });
				}
				expect(yielded, "the fixture yields before the initial Move step").toBe(true);
				await t.run(async (ctx) => {
					const keep = (await ctx.db.get("files_nodes", keepId))!;
					expect(keep.moveCohortId, "the other Move holds the child").toBeDefined();
					expect(
						await ctx.db.get("files_move_cohorts", keep.moveCohortId!),
						"the held child stays Before replacement",
					).toMatchObject({
						origin: { kind: "transfer", runId: other._yay!.runId },
						visibleView: "before",
						publishedAt: null,
					});
					expect(await files_saved_placement_db_get_node(ctx.db, keepId)).toMatchObject({
						_id: keepId,
						parentId: folders.get("/target/source"),
						path: "/target/source/keep",
					});
				});
			}
			expect(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [
						{
							itemId: item.itemId,
							choice: "replace",
							reviewedTarget: item.conflict!.target!,
							reviewedVersion: item.conflict!.version,
						},
					],
					applyToRemaining: { file: null, folder: null },
				}),
				"the refusal names the reason",
			).toEqual({ _nay: { message: "Cannot replace a folder that is not empty. Keep both or skip it." } });
			expect(await list(), "Keep both and Skip stay open").toMatchObject({
				state: "conflict",
				conflictKind: "name_conflict",
			});
		},
	);

	test.each([
		{ access: "none", archived: false },
		{ access: "read", archived: false },
		{ access: "write", archived: false },
		{ access: "owner", archived: false },
		{ access: "none", archived: true },
		{ access: "read", archived: true },
		{ access: "write", archived: true },
		{ access: "owner", archived: true },
	] as const)(
		"moves nested restricted descendants along with $access access (archived: $archived)",
		async ({ access, archived }) => {
			const fixture = await create_folder_fixture([
				"/source",
				"/source/hidden-name",
				"/source/hidden-name/child",
				"/other",
			]);
			const { t, db, asUser, folders } = fixture;
			const member = await add_member(fixture);
			const restrictedId = folders.get("/source/hidden-name")!;
			expect(
				(
					await asUser.mutation(api.files_sharing.restrict_node, {
						membershipId: db.membershipId,
						nodeId: restrictedId,
					})
				)._nay,
			).toBeUndefined();
			if (access === "read" || access === "write") {
				expect(
					(
						await asUser.mutation(api.files_sharing.set_node_share_grant, {
							membershipId: db.membershipId,
							nodeId: restrictedId,
							principal: { kind: "user", userId: member.userId },
							level: access,
						})
					)._nay,
				).toBeUndefined();
			}
			if (archived) {
				expect(
					(
						await asUser.mutation(api.files_nodes.archive_nodes, {
							membershipId: db.membershipId,
							nodeIds: [restrictedId],
						})
					)._nay,
				).toBeUndefined();
			}
			const actor = access === "owner" ? asUser : member.asUser;
			const membershipId = access === "owner" ? db.membershipId : member.membershipId;
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const started = await start_transfer(actor, {
				membershipId,
				requestId: "nested-restricted-cut",
				kind: "move",
				sourceIds: [folders.get("/other")!, folders.get("/source")!],
				targetParentId: folders.get("/target")!,
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
			const view = await actor.query(api.files_transfer_queries.get, { membershipId, runId });
			expect(JSON.stringify(view)).not.toContain("hidden-name");
			expect(view).toMatchObject({
				activity: { status: "succeeded", progress: { completed: 2 }, errorMessage: null },
			});
			for (const path of ["/source/hidden-name", "/source/hidden-name/child"]) {
				const nodeId = folders.get(path)!;
				expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
					path: `/target${path}`,
					restrictedScopeNodeId: restrictedId,
					archiveOperationId: before.find((node) => node._id === nodeId)!.archiveOperationId,
				});
			}
			expect((await get_node(fixture, "/target/other"))?._id).toBe(folders.get("/other"));
			if (!archived) {
				// The restricted folder keeps its own people: the member opens it only with a grant.
				const opened = await member.asUser.query(api.files_tree.get_file_node_for_membership, {
					membershipId: member.membershipId,
					fileNodeId: String(restrictedId),
				});
				expect(opened?._id ?? null).toBe(access === "read" || access === "write" ? restrictedId : null);
			}
		},
	);

	test("continues suffix checks in later steps and moves every source", async () => {
		const names = ["one", "two", "three"];
		const fixture = await create_folder_fixture([
			...names.map((name) => `/${name}`),
			...names.flatMap((name) =>
				Array.from({ length: 70 }, (_, index) => `/target/${index === 0 ? name : `${name}-copy-${index}`}`),
			),
		]);
		const { db, asUser, folders } = fixture;
		const started = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "many-conflicts",
			kind: "move",
			sourceIds: names.map((name) => folders.get(`/${name}`)!),
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.conflicts).toHaveLength(3);
		const resolved = await asUser.mutation(api.files_transfer.resolve_conflicts, {
			membershipId: db.membershipId,
			runId,
			revision: waiting.revision,
			choices: waiting.conflicts.map((item) => ({ itemId: item.itemId, choice: "keep_both" as const })),
			applyToRemaining: { file: null, folder: null },
		});
		expect(resolved._nay).toBeUndefined();
		expect(await finish_move(fixture, runId)).toMatchObject({
			activity: {
				status: "succeeded",
				progress: { completed: 3 },
				errorMessage: null,
			},
		});
		for (const name of names) {
			expect(await get_node(fixture, `/${name}`)).toBeNull();
			expect((await get_node(fixture, `/target/${name}-copy-70`))?._id).toBe(folders.get(`/${name}`));
		}
	});

	test("keeps completed roots when a later root pauses on a name conflict", async () => {
		const fixture = await create_folder_fixture(["/one", "/one/child", "/two"]);
		const { t, db, asUser, folders } = fixture;
		const started = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "move",
			kind: "move",
			sourceIds: [folders.get("/one")!, folders.get("/two")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect((await finish_discovery(fixture, runId)).activity.status).toBe("running");
		expect(
			(
				await asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: db.membershipId,
					parentId: folders.get("/target")!,
					path: "two",
				})
			)._nay,
		).toBeUndefined();
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		const waiting = await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId });
		expect(waiting).toMatchObject({ activity: { status: "awaiting_input", progress: { completed: 1 } } });
		expect(await get_node(fixture, "/one")).toBeNull();
		expect((await get_node(fixture, "/two"))?._id).toBe(folders.get("/two"));
		expect((await get_node(fixture, "/target/one"))?._id).toBe(folders.get("/one"));
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting!.revision,
					choices: [{ itemId: waiting!.conflicts[0]!.itemId, choice: "skip" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_move(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1, skipped: 1 } },
			movedNodeIds: [folders.get("/one")],
		});
		expect((await get_node(fixture, "/target/one"))?._id).toBe(folders.get("/one"));
		expect((await get_node(fixture, "/target/one/child"))?._id).toBe(folders.get("/one/child"));
		expect((await get_node(fixture, "/two"))?._id).toBe(folders.get("/two"));
	});

	test("a member moves a renamed folder with a restricted child they cannot open, and the child stays closed", async () => {
		const fixture = await create_folder_fixture(["/a", "/a/shared", "/other"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const sharedId = folders.get("/a/shared")!;
		expect(
			(await asUser.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: sharedId }))
				._nay,
		).toBeUndefined();
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "rename-restricted-descendant",
			nodeId: folders.get("/a")!,
			path: "b",
		});
		if (!renamed._yay) throw new Error(renamed._nay?.message ?? "Expected a Rename run");
		let observedOldPath = false;
		await test_finish_transfer_run(asUser, renamed._yay.runId, async () => {
			if (observedOldPath) return;
			const cohort = await t.run(async (ctx) => {
				const slot = await ctx.db.query("files_move_workspace_slots").withIndex("by_workspace", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
				).unique();
				return slot?.cohortId ? await ctx.db.get("files_move_cohorts", slot.cohortId) : null;
			});
			if (!cohort || cohort.publishedAt === null) return;
			const stored = await t.run((ctx) => ctx.db.get("files_nodes", sharedId));
			if (stored?.path !== "/a/shared") return;
			observedOldPath = true;
			expect(await asUser.query(api.files_tree.get_file_node_for_membership, {
				membershipId: db.membershipId, fileNodeId: String(sharedId),
			}), "A published Rename shows the new path before stored repair").toMatchObject({ path: "/b/shared" });
			expect(await member.asUser.query(api.files_tree.get_file_node_for_membership, {
				membershipId: member.membershipId, fileNodeId: String(sharedId),
			})).toBeNull();
			// The old name stays reserved until the Move repairs its stored docs.
			expect(await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId, parentId: files_ROOT_ID, path: "a",
			})).toMatchObject({ _nay: { name: "move_busy" } });
		});
		expect(observedOldPath, "The test sees publication before stored path repair").toBe(true);
		expect(await asUser.query(api.files_transfer_queries.get, {
			membershipId: db.membershipId, runId: renamed._yay.runId,
		})).toMatchObject({ activity: { status: "succeeded" } });
		const newA = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId, parentId: files_ROOT_ID, path: "a",
		});
		if (newA._nay) throw new Error(newA._nay.message);
		const move = (itemId: Id<"files_nodes">) =>
			test_move_nodes(t, member.asUser, {
					membershipId: member.membershipId,
					itemIds: [itemId],
					targetParentId: folders.get("/other")!,
				});

		// The member cannot open `shared`, but it moves along inside /b and keeps its own people.
		expect(await move(folders.get("/a")!)).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sharedId))).toMatchObject({
			path: "/other/b/shared",
			restrictedScopeNodeId: sharedId,
		});
		expect(await member.asUser.query(api.files_tree.get_file_node_for_membership, {
			membershipId: member.membershipId, fileNodeId: String(sharedId),
		})).toBeNull();
		// The new /a reuses the old name.
		expect(await move(newA._yay.nodeId)).toEqual({ _yay: null });
	});

	test("checks the restricted folder of an item whose stored scope a running scope op has not written yet", async () => {
		const paths = Array.from({ length: 100 }, (_entry, index) => `/shared/item-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/shared", "/other", ...paths]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const itemId = folders.get(paths.at(-1)!)!;
		expect(await asUser.mutation(api.files_sharing.restrict_node, {
			membershipId: db.membershipId, nodeId: folders.get("/shared")!,
		})).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", itemId)), "Restrict leaves the selected child's stored scope for its next step").toMatchObject({
			restrictedScopeNodeId: null,
		});

		const started = await member.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: member.membershipId,
			requestId: "move-during-scope-repair",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [itemId],
			targetParentId: folders.get("/other")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await member.asUser.mutation(api.files_transfer.seal, {
			membershipId: member.membershipId, runId,
		})).toEqual({ _yay: null });
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)), "Move waits for the native scope repair before reading its source").toMatchObject({ step: "select" });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", itemId))).toMatchObject({
			parentId: folders.get("/shared")!, restrictedScopeNodeId: null,
		});
		await test_finish_transfer_run(member.asUser, runId);
		expect(await member.asUser.query(api.files_transfer_queries.get, {
			membershipId: member.membershipId, runId,
		})).toMatchObject({ activity: { status: "failed", errorMessage: "Permission denied" } });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", itemId))).toMatchObject({
			parentId: folders.get("/shared")!, restrictedScopeNodeId: folders.get("/shared")!,
		});
	});

	test("moves an item whose stored scope still names a folder that a running scope op has unrestricted", async () => {
		const paths = Array.from({ length: 100 }, (_entry, index) => `/shared/item-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/shared", "/other", ...paths]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const sharedId = folders.get("/shared")!;
		const itemId = folders.get(paths.at(-1)!)!;
		expect(await asUser.mutation(api.files_sharing.restrict_node, {
			membershipId: db.membershipId, nodeId: sharedId,
		})).toEqual({ _yay: null });
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", itemId))).toMatchObject({ restrictedScopeNodeId: sharedId });
		expect(await asUser.mutation(api.files_sharing.unrestrict_node, {
			membershipId: db.membershipId, nodeId: sharedId,
		})).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", itemId)), "Unrestrict leaves the selected child's stored scope for its next step").toMatchObject({
			restrictedScopeNodeId: sharedId,
		});

		const started = await member.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: member.membershipId,
			requestId: "move-during-unrestrict-repair",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [itemId],
			targetParentId: folders.get("/other")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await member.asUser.mutation(api.files_transfer.seal, {
			membershipId: member.membershipId, runId,
		})).toEqual({ _yay: null });
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)), "Move waits for the native scope repair before reading its source").toMatchObject({ step: "select" });
		await test_finish_transfer_run(member.asUser, runId);
		expect(await member.asUser.query(api.files_transfer_queries.get, {
			membershipId: member.membershipId, runId,
		})).toMatchObject({ activity: { status: "succeeded" } });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", itemId))).toMatchObject({
			parentId: folders.get("/other")!, restrictedScopeNodeId: null,
		});
	});

	test("says Not found for a source deleted after it was picked", async () => {
		const fixture = await create_folder_fixture(["/gone", "/other"]);
		const { t, db, asUser, folders } = fixture;
		const started = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "copy-deleted-source",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [folders.get("/gone")!],
			targetParentId: folders.get("/other")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		// An Archive would wait for this transfer, so remove the node directly.
		await t.run((ctx) => ctx.db.delete("files_nodes", folders.get("/gone")!));
		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		await test_finish_transfer_run(asUser, runId);
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "failed", errorMessage: "Not found" },
		});
	});
});

describe("seal", () => {
	test("waits behind an op on its source, shows no card, and starts when that op ends", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		// An earlier op still works inside the source folder.
		const blockerId = await t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					kind: "scope",
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [folders.get("/source")!],
					treePaths: ["/source/"],
				},
				now: Date.now(),
			}),
		);
		const started = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "queued-copy",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId, activityId } = started._yay;

		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_subtree_ops")
					.withIndex("by_transferRun", (q) => q.eq("transferRunId", runId))
					.unique(),
			),
		).toMatchObject({ status: "queued", blockedByOpId: blockerId, sourceTreePaths: ["/source/"] });
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "queued",
			feedVisible: false,
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();

		await t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: blockerId, now: Date.now() }));
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "succeeded",
			feedVisible: true,
		});
		expect(await get_node(fixture, "/target/source")).not.toBeNull();
		// The paste ended, so its op is gone and a later op no longer waits for it.
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
	});

	test("does not wait on the path of a source from another organization", async () => {
		const fixture = await create_folder_fixture(["/secret"]);
		const { t, db, asUser, folders } = fixture;
		await t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					kind: "scope",
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [folders.get("/secret")!],
					treePaths: ["/secret/"],
				},
				now: Date.now(),
			}),
		);
		// A node of another organization that sits under the same path there.
		const foreignId = await t.run(async (ctx) => {
			const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" });
			return await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: other.organizationId,
				workspaceId: other.workspaceId,
				createdBy: other.userId,
				updatedBy: other.userId,
				name: "x",
				sortName: files_sort_text_key("x"),
				path: "/secret/x",
				treePath: "/secret/x/",
				pathDepth: 2,
			});
		});
		const started = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "foreign-copy",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [foreignId],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId });

		// Whether this paste waits must not tell the caller where a node of another tenant sits.
		const op = await t.run((ctx) =>
			ctx.db
				.query("files_subtree_ops")
				.withIndex("by_transferRun", (q) => q.eq("transferRunId", started._yay.runId))
				.unique(),
		);
		expect(op).toMatchObject({ status: "running", blockedByOpId: null, sourceTreePaths: [] });
	});
});

describe("copy deadline", () => {
	test("blocks a staged file at the Activity deadline before the sweep runs", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		const file = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "late.pdf",
			contentType: "application/pdf",
			size: 8,
		});
		if (file._nay) throw new Error(file._nay.message);
		const runId = await start_copy(fixture, [file._yay.nodeId]);
		const running = await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		if (!item?.workId) throw new Error("Missing copy worker");
		await t.run((ctx) => ctx.db.patch("files_r2_assets", file._yay.assetId, { r2Key: "test/late.pdf" }));
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: item._id,
			attempt: item.attempt,
		});
		const staged = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: item._id,
			attempt: item.attempt,
			workId: item.workId,
			contentSize: 8,
		});
		if (!staged._yay) throw new Error("Missing staged asset");
		const deadlineAt = Date.now() + 1000;
		await t.run((ctx) => ctx.db.patch("activities", running.activity._id, { deadlineAt }));
		vi.setSystemTime(deadlineAt);
		expect(
			(
				await t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
					itemId: item._id,
					attempt: item.attempt,
					workId: item.workId,
					contentAssetId: staged._yay.contentAssetId,
				})
			)._nay,
		).toBeUndefined();
		const stopping = await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId });
		expect(stopping).toMatchObject({
			activity: { status: "stopping", errorCode: "timed_out", progress: { completed: 0, canceled: 1 } },
		});
		expect(stopping?.activity.finishedAt).toBeUndefined();
		expect(await get_node(fixture, "/target/late.pdf")).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", staged._yay!.contentAssetId))).toBeNull();
		const callback = {
			workId: item.workId,
			context: { itemId: item._id, attempt: item.attempt },
			result: { kind: "success" as const, returnValue: null },
		};
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		const finished = await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId });
		expect(finished).toMatchObject({
			activity: { status: "timed_out", errorMessage: "Paste timed out.", progress: { completed: 0, canceled: 1 } },
		});
		vi.setSystemTime(deadlineAt + 1000);
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toEqual(finished);
	});
});

describe("recover_expired_attempts", () => {
	test("releases expired staging and ignores callbacks from an older attempt", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		const file = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "queued.pdf",
			contentType: "application/pdf",
			size: 8,
		});
		if (file._nay) throw new Error(file._nay.message);
		const runId = await start_copy(fixture, [file._yay.nodeId]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const first = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		if (!first?.workId) throw new Error("Missing first worker");
		await t.run((ctx) => ctx.db.patch("files_r2_assets", file._yay.assetId, { r2Key: "test/queued.pdf" }));
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: first._id,
			attempt: first.attempt,
		});
		const staged = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: first._id,
			attempt: first.attempt,
			workId: first.workId,
			contentSize: 8,
		});
		if (!staged._yay) throw new Error("Missing staged asset");
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);
		await t.mutation(internal.files_transfer.recover_expired_attempts, {});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", staged._yay!.contentAssetId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", first._id))).toMatchObject({
			state: "pending",
			workId: null,
			stagedAssetIds: [],
		});
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: first._id, attempt: first.attempt });
		await t.mutation(internal.files_transfer.advance, { runId });
		const second = await t.run((ctx) => ctx.db.get("files_transfer_items", first._id));
		expect(second?.attempt).toBe(first.attempt + 1);
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: first.workId,
			context: { itemId: first._id, attempt: first.attempt },
			result: { kind: "canceled" },
		});
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.inFlight).toBe(1);
		const callback = {
			workId: second!.workId!,
			context: { itemId: first._id, attempt: second!.attempt },
			result: { kind: "failed" as const, error: "Storage failed" },
		};
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.inFlight).toBe(0);
		expect(await get_node(fixture, "/target/queued.pdf")).toBeNull();
	});
});

describe("delete_run_batch", () => {
	test("deletes dismissed job history and keeps the saved output", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const finished = await finish_folder_copy(fixture, runId);
		const copied = await get_node(fixture, "/target/source");
		expect(finished.activity.status).toBe("succeeded");
		expect(
			(
				await asUser.mutation(api.activities.archive_activity, {
					membershipId: db.membershipId,
					activityId: finished.activity._id,
				})
			)._nay,
		).toBeUndefined();
		let deleted = false;
		for (let step = 0; step < 10 && !deleted; step++) {
			await t.mutation(internal.files_transfer.delete_run_batch, { runId });
			deleted = (await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))) === null;
		}
		expect(deleted).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_transfer_runs", runId)).toBeNull();
			expect(await ctx.db.get("activities", finished.activity._id)).toBeNull();
			expect(await ctx.db.query("files_transfer_items").collect()).toEqual([]);
			expect(await ctx.db.query("activities_user_states").collect()).toEqual([]);
		});
		expect(await get_node(fixture, "/target/source")).toEqual(copied);
	});
});

describe("changed folders", () => {
	test("keeps recorded result paths after source and output renames", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({ activity: { status: "succeeded" } });
		const receipt = () =>
			asUser.query(api.files_transfer_queries.list_items, {
				membershipId: db.membershipId,
				runId,
				paginationOpts: { numItems: 10, cursor: null },
			});
		const before = await receipt();
		expect(before?.page[0]).toMatchObject({
			source: { path: "/source", name: "source" },
			output: { path: "/target/source", name: "source" },
		});
		const output = await get_node(fixture, "/target/source");
		if (!output) throw new Error("Expected copied folder");
		for (const nodeId of [folders.get("/source")!, output._id]) {
			expect(
				await test_rename_node(t, asUser, {
					membershipId: db.membershipId,
					nodeId,
					path: "renamed",
				}),
			).toHaveProperty("_yay");
		}
		expect((await get_node(fixture, "/renamed"))?._id).toBe(folders.get("/source"));
		expect((await get_node(fixture, "/target/renamed"))?._id).toBe(output._id);
		expect(await receipt()).toEqual(before);
	});

	test("requires a new choice after the source moves and never follows its old path", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		expect(
			(
				await test_rename_node(t, asUser, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source")!,
					path: "renamed",
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		const view = await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId });
		expect(view).toMatchObject({
			activity: { status: "awaiting_input", progress: { completed: 0 } },
			conflicts: [{ kind: "source_changed", sourceName: "source", sourcePath: "/source" }],
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: view!.revision,
					choices: [{ itemId: view!.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeDefined();
	});

	test("does not write children into a copied folder moved by another member", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const copied = await get_node(fixture, "/target/source");
		expect(
			(
				await test_rename_node(t, member.asUser, {
					membershipId: member.membershipId,
					nodeId: copied!._id,
					path: "moved-copy",
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "awaiting_input", progress: { completed: 1 } },
			conflicts: [{ kind: "destination_changed" }],
		});
		expect((await get_node(fixture, "/target/moved-copy"))?._id).toBe(copied!._id);
		expect(await get_node(fixture, "/target/moved-copy/child")).toBeNull();
		expect(await get_node(fixture, "/target/child")).toBeNull();
	});
});
