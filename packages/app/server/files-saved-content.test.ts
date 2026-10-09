import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "../convex/_generated/api.js";
import { files_u8_to_array_buffer } from "../shared/files.ts";
import { test_create_saved_placement_fixture as fixture } from "./files-saved-placement.test-fixtures.ts";
import {
	files_saved_content_collect,
	files_saved_content_db_plain_text_chunks,
	files_saved_content_db_text_chunks,
	files_saved_content_db_yjs_updates,
} from "./files-saved-content.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("saved-content-test-work" as never);
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
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function content_fixture() {
	const f = await fixture();
	await f.t.run(async (ctx) => {
		for (const table of ["files_text_chunks", "files_plain_text_chunks", "files_yjs_updates"] as const) {
			const rows = await ctx.db.query(table).collect();
			for (const row of rows) await ctx.db.delete(table, row._id);
		}
	});
	const add = (text: string, index: number, view?: "before" | "after") =>
		f.t.run(async (ctx) => {
			const fields = {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				sourceKind: "committed" as const,
				fileNodeId: f.nodeId,
				yjsSequence: 0,
				moveView: view ? { cohortId: f.cohortId, view } : undefined,
				chunkIndex: index,
				startIndex: index * 4,
				endIndex: (index + 1) * 4,
				lineStart: index + 1,
				lineEnd: index + 1,
				chunkFlags: 0,
				textChunk: text,
			};
			const textChunkId = await ctx.db.insert("files_text_chunks", fields);
			const plainChunkId = await ctx.db.insert("files_plain_text_chunks", {
				...fields,
				textChunkId,
				path: view === "after" ? f.after.path : f.before.path,
				plainTextChunk: text,
				hasChunkAbove: index > 0,
				hasChunkBelow: index < 2,
			});
			return { textChunkId, plainChunkId };
		});
	const text = () =>
		f.t.run(async (ctx) =>
			(await files_saved_content_collect(files_saved_content_db_text_chunks(ctx.db, { ...f.db, nodeId: f.nodeId })))
				.map((row) => row.textChunk)
				.join(""),
		);
	return { ...f, add, text };
}

test("reads every original chunk while staging splits normal and before rows", async () => {
	const f = await content_fixture();
	await f.add("old1", 0);
	await f.add("old2", 1, "before");
	await f.add("old3", 2);
	await f.add("new2", 1, "after");
	expect(await f.text(), "staging keeps the full original content").toBe("old1old2old3");
	const plain = await f.t.run((ctx) =>
		files_saved_content_collect(files_saved_content_db_plain_text_chunks(ctx.db, { ...f.db, nodeId: f.nodeId })),
	);
	expect(plain.map((row) => row.plainTextChunk).join("")).toBe("old1old2old3");
});

test("reads every new chunk during cleanup and lets selected chunks win duplicates", async () => {
	const f = await content_fixture();
	await f.add("old1", 0, "before");
	await f.add("old2", 1, "before");
	await f.add("new1", 0);
	await f.add("same", 1);
	await f.add("new2", 1, "after");
	await f.add("new3", 2, "after");
	await f.publish();
	expect(await f.text(), "cleanup keeps the full selected content once per chunk").toBe("new1new2new3");
	const plain = await f.t.run((ctx) =>
		files_saved_content_collect(files_saved_content_db_plain_text_chunks(ctx.db, { ...f.db, nodeId: f.nodeId })),
	);
	expect(plain.map((row) => row.plainTextChunk).join("")).toBe("new1new2new3");
});

test("keeps exact line and character seeks across both selected sources", async () => {
	const f = await content_fixture();
	for (let index = 0; index < 80; index++)
		await f.add(index.toString().padStart(4, "0"), index, index % 2 ? "before" : undefined);
	const read = (bounds: { startLine?: number; startIndex?: number }) =>
		f.t.run(async (ctx) => {
			const rows: number[] = [];
			for await (const row of files_saved_content_db_text_chunks(ctx.db, { ...f.db, nodeId: f.nodeId, ...bounds })) {
				rows.push(row.chunkIndex);
				if (rows.length === 3) break;
			}
			return rows;
		});
	expect(await read({ startLine: 70 })).toEqual([69, 70, 71]);
	expect(await read({ startIndex: 277 })).toEqual([69, 70, 71]);
});

test("merges selected Yjs sequences once and keeps the frozen upper bound", async () => {
	const f = await content_fixture();
	await f.t.run(async (ctx) => {
		for (const [sequence, view] of [
			[1, undefined],
			[2, "before"],
			[3, undefined],
			[2, "after"],
		] as const) {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				fileNodeId: f.nodeId,
				sequence,
				moveView: view ? { cohortId: f.cohortId, view } : undefined,
				update: files_u8_to_array_buffer(new Uint8Array([sequence])),
				origin: { type: "USER_EDIT", sessionId: "saved-content" },
				createdBy: f.db.userId,
				createdAt: Date.now(),
			});
		}
	});
	const read = () =>
		f.t.run(async (ctx) =>
			(
				await files_saved_content_collect(
					files_saved_content_db_yjs_updates(ctx.db, {
						...f.db,
						nodeId: f.nodeId,
						afterSequence: 0,
						throughSequence: 2,
					}),
				)
			).map((row) => [row.sequence, row.moveView?.view ?? "normal"]),
		);
	expect(await read()).toEqual([
		[1, "normal"],
		[2, "before"],
	]);
	await f.t.run(async (ctx) => {
		const rows = await ctx.db.query("files_yjs_updates").collect();
		for (const row of rows)
			if (!row.moveView)
				await ctx.db.patch("files_yjs_updates", row._id, { moveView: { cohortId: f.cohortId, view: "before" } });
	});
	await f.publish();
	expect(await read()).toEqual([[2, "after"]]);
});

test("the editor reads the effective non-collaborative header and split chunks", async () => {
	const f = await content_fixture();
	await f.add("old1", 0);
	await f.add("old2", 1, "before");
	await f.t.run(async (ctx) => {
		const record = await ctx.db.get("files_move_cohort_nodes", f.recordId);
		if (!record?.beforePlaceId || !record.afterPlaceId) throw new Error("Expected saved candidates");
		for (const id of [record.beforePlaceId, record.afterPlaceId])
			await ctx.db.patch("files_saved_places", id, {
				collaborationEnabled: false,
				yjsLastSequenceId: null,
				yjsSnapshotId: null,
			});
	});
	expect(
		await f.asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
		}),
	).toEqual({ _yay: { text: "old1old2", textKind: "plain_text" } });
});

test("a paged Yjs read stops when its effective lineage changes", async () => {
	const f = await content_fixture();
	if (!f.saved.yjsLastSequenceId) throw new Error("Expected Yjs head");
	const head = await f.t.run((ctx) => ctx.db.get("files_yjs_docs_last_sequences", f.saved.yjsLastSequenceId!));
	if (!head) throw new Error("Expected Yjs head");
	await f.t.run((ctx) =>
		ctx.db.insert("files_yjs_updates", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			fileNodeId: f.nodeId,
			sequence: 1,
			update: files_u8_to_array_buffer(new Uint8Array([1])),
			origin: { type: "USER_EDIT", sessionId: "saved-content" },
			createdBy: f.db.userId,
			createdAt: Date.now(),
		}),
	);
	const args = {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		nodeId: f.nodeId,
		expectedLastSequenceId: head._id,
		expectedLineageGeneration: head.lineageGeneration,
		afterSequence: 0,
		throughSequence: 1,
	};
	expect((await f.t.query(internal.files_nodes.get_file_next_yjs_update, args)).kind).toBe("row");
	await f.t.run((ctx) =>
		ctx.db.patch("files_yjs_docs_last_sequences", head._id, { lineageGeneration: head.lineageGeneration + 1 }),
	);
	expect(
		await f.t.query(internal.files_nodes.get_file_next_yjs_update, args),
		"a changed lineage cannot enter a frozen Yjs read",
	).toEqual({ kind: "done" });
});

test("content search pages both views and refuses a cursor after side rows change", async () => {
	const f = await content_fixture();
	await f.add("needle", 0);
	await f.add("needle", 1, "before");
	await f.add("other", 2, "after");
	const args = {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		hasWorkspaceRead: true,
		query: "needle",
		numItems: 10,
		cursor: null,
	};
	let cursor: string | null = null;
	const items: Array<{ textChunk: string; chunkIndex: number }> = [];
	for (;;) {
		const result: FunctionReturnType<typeof internal.files_nodes.text_search_files> = await f.t.query(
			internal.files_nodes.text_search_files,
			{ ...args, cursor },
		);
		items.push(...result.items);
		if (result.isDone) break;
		cursor = result.continueCursor;
	}
	expect(items.map((row) => row.chunkIndex).sort(), "search includes normal and selected chunks").toEqual([0, 1]);
	const first = await f.t.query(internal.files_nodes.text_search_files, args);
	await f.t.run(async (ctx) => {
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId))
			.unique();
		if (!slot) throw new Error("Expected saved view slot");
		await ctx.db.patch("files_move_workspace_slots", slot._id, { searchGeneration: slot.searchGeneration + 1 });
	});
	await expect(
		f.t.query(internal.files_nodes.text_search_files, { ...args, cursor: first.continueCursor }),
	).rejects.toThrow("Search changed");
});

async function claimed_asset(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run(async (ctx) => {
		if (!f.saved.assetId) throw new Error("Expected fixture asset");
		const original = await ctx.db.get("files_r2_assets", f.saved.assetId);
		if (!original) throw new Error("Expected fixture asset");
		const { _id: _id, _creationTime: _creationTime, ...fields } = original;
		const assetId = await ctx.db.insert("files_r2_assets", {
			...fields,
			r2Key: "cohort-staged-content",
			unfinalizedExpiresAt: Date.now() - 1,
		});
		// Seeds the inactive future producer's claim, with no physical saved reference yet.
		const claimId = await ctx.db.insert("files_move_asset_claims", { cohortId: f.cohortId, assetId });
		return { assetId, claimId };
	});
}

test("expired asset cleanup keeps a staged cohort asset", async () => {
	const f = await fixture();
	const { assetId } = await claimed_asset(f);
	const result = await f.t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
		_test_now: Date.now(),
		_test_disableReschedule: true,
	});
	expect(result.deletedCount, "expiry keeps an asset held only by a cohort claim").toBe(0);
	expect(
		await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId)),
		"expiry keeps an asset held only by a cohort claim",
	).not.toBeNull();
});

test("accepted Yjs cleanup keeps a claimed asset and deletes it after release", async () => {
	const f = await fixture();
	const { assetId, claimId } = await claimed_asset(f);
	const args = {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		nodeId: f.nodeId,
		throughSequence: 0,
		supersededYjsAssetId: assetId,
	};
	await f.t.mutation(internal.files_nodes_content.cleanup_file_yjs_covered_rows, args);
	expect(
		await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId)),
		"accepted cleanup keeps an asset held only by a cohort claim",
	).not.toBeNull();
	await f.t.run((ctx) => ctx.db.delete("files_move_asset_claims", claimId));
	await f.t.mutation(internal.files_nodes_content.cleanup_file_yjs_covered_rows, args);
	expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId))).toBeNull();
});

test("unselected pending content follows its exact source reservation without accepting the proposal", async () => {
	const f = await content_fixture();
	const chunks = await f.t.run(async (ctx) => {
		await ctx.db.insert("files_move_source_reservations", {
			cohortId: f.cohortId,
			source: { kind: "proposal", id: f.proposal._id },
			mode: "proposal",
			userId: f.db.userId,
			generation: f.proposal.revision,
		});
		const beforeIds = [];
		const afterIds = [];
		for (let index = 0; index < 3; index++) {
			const fields = {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				sourceKind: "pending" as const,
				target: f.proposal.target,
				userId: f.db.userId,
				pendingUpdateId: f.proposal._id,
				proposalRevision: f.proposal.revision,
				chunkIndex: index,
				textChunk: `row${index}`,
				startIndex: index * 4,
				endIndex: (index + 1) * 4,
				lineStart: index + 1,
				lineEnd: index + 1,
				chunkFlags: 0,
			};
			const textChunkId = await ctx.db.insert("files_text_chunks", fields);
			const plain = {
				...fields,
				textChunkId,
				plainTextChunk: fields.textChunk,
				hasChunkAbove: index > 0,
				hasChunkBelow: index < 2,
			};
			// The owner worker changes scope rows. The exact body stays normal and unchanged.
			beforeIds.push(
				await ctx.db.insert("files_plain_text_chunks", {
					...plain,
					path: f.before.path,
					moveView: index === 1 ? { cohortId: f.cohortId, view: "before" } : undefined,
				}),
			);
			afterIds.push(
				await ctx.db.insert("files_plain_text_chunks", {
					...plain,
					path: f.after.path,
					moveView: { cohortId: f.cohortId, view: "after" },
				}),
			);
		}
		return { beforeIds, afterIds };
	});
	const read = (view?: "before" | "after") =>
		f.t.run(async (ctx) => {
			const args = {
				...f.db,
				pendingUpdateId: f.proposal._id,
				fixedView: view ? { cohortId: f.cohortId, view } : undefined,
			};
			const plain = await files_saved_content_collect(files_saved_content_db_plain_text_chunks(ctx.db, args));
			const text = await files_saved_content_collect(files_saved_content_db_text_chunks(ctx.db, args));
			return { paths: plain.map((row) => row.path), text: text.map((row) => row.textChunk).join("") };
		});
	expect(await read(), "unselected content keeps every original scope row during staging").toEqual({
		paths: Array(3).fill(f.before.path),
		text: "row0row1row2",
	});
	expect(await read("after"), "fixed after reads use the reserved owner's staged scope").toEqual({
		paths: Array(3).fill(f.after.path),
		text: "row0row1row2",
	});
	await f.t.run(async (ctx) => {
		for (const id of chunks.beforeIds)
			await ctx.db.patch("files_plain_text_chunks", id, { moveView: { cohortId: f.cohortId, view: "before" } });
	});
	await f.publish();
	await f.t.run((ctx) => ctx.db.patch("files_plain_text_chunks", chunks.afterIds[0]!, { moveView: undefined }));
	expect(await read(), "unselected content keeps every selected scope row during cleanup").toEqual({
		paths: Array(3).fill(f.after.path),
		text: "row0row1row2",
	});
	expect(
		await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.proposal._id)),
		"moving owner scope does not accept or mark its proposal",
	).toEqual(f.proposal);
});
