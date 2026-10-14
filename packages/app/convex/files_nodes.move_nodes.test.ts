// Move and rename tests, split from files_nodes.test.ts so the two files can run at the same time.
import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { files_nodes_db_get_content_version } from "./files_nodes_db.ts";
import { files_nodes_db_require_writable, type files_nodes_WriteContext } from "../server/files-write-policy.ts";
import { db_insert_file_text_content } from "./files_nodes_content.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	test_convex,
	test_finish_pending_update_run,
	test_save_file_pending_update,
	test_rename_node,
	test_move_nodes,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { advance as advance_move_cohort } from "./files_move_cohorts.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import {
	files_ROOT_ID,
	files_INITIAL_CONTENT,
	files_db_get_visible_node_by_path,
	files_get_utf8_byte_size,
} from "../server/files.ts";
import { delay } from "../shared/async-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_NAME_MAX_LENGTH, files_PATH_MAX_LENGTH } from "../shared/files.ts";
import {
	propose_move_for_test,
	test_setup_r2_capture,
	read_deletion_jobs,
	expected_ledger_keys,
} from "./files_nodes.setup.test.ts";
import { accept_move_proposals_for_test } from "./files_nodes.move_nodes.setup.test.ts";

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return {
		...actual,
		generateText: generateTextMock,
		streamText: streamTextMock,
	};
});

// Tests that run the real SDK set this fake provider model. The receipt middleware stays real.
const inlineAiProvider = vi.hoisted(() => ({ model: null as MockLanguageModelV3 | null }));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
	return {
		...actual,
		openai: Object.assign(() => inlineAiProvider.model, actual.openai),
	};
});

let generateUploadUrlSpy: ReturnType<typeof vi.fn<(customKey?: string) => Promise<{ key: string; url: string }>>>;
const test = baseTest;

beforeEach(() => {
	generateTextMock.mockReset();
	streamTextMock.mockReset();
	inlineAiProvider.model = null;
	// Keep file tests focused on file behavior; billing event enqueue behavior is
	// covered in billing tests.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	generateUploadUrlSpy = vi.fn(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(generateUploadUrlSpy);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// #region move nodes

describe("reviewed Move graph", () => {
	test("creates shared private parents with the moving anchor's final scopes", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const anchor = db.files.file_root_1;
		const target = db.files.file_root_2;
		const sources = [db.files.file_root_1_child_1, db.files.file_root_1_child_2];
		const archivedChild = db.files.file_root_1_child_1_deep_1;
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_nodes", target._id, {
				restrictedScopeNodeId: target._id,
				isRestrictedScopeRoot: true,
				writePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
			});
			await ctx.db.patch("files_nodes", archivedChild._id, { archiveOperationId: "old-archive" });
		});
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: anchor.path + "/new/shared",
			kind: "folder",
		});
		if (created._nay) throw new Error(created._nay.message);
		if (created._yay.target.kind !== "private") throw new Error("Expected a private parent");
		const sharedTarget = created._yay.target;
		const ids = await t.run(async (ctx) => {
			const ids: Id<"files_pending_updates">[] = [];
			let target: typeof sharedTarget | { kind: "saved"; id: Id<"files_nodes"> } | { kind: "root" } = sharedTarget;
			while (target.kind === "private") {
				const node: Doc<"files_pending_nodes"> = (await ctx.db.get("files_pending_nodes", target.id))!;
				const proposal = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) =>
						q.eq("userId", db.userId).eq("target.kind", "private").eq("target.id", node._id),
					)
					.unique();
				ids.push(proposal!._id);
				target = node.parent;
			}
			return ids;
		});
		for (const source of sources) {
			const proposed = await propose_move_for_test(t, {
				...db,
				nodeId: source._id,
				destParent: sharedTarget,
				destName: source.name,
			});
			ids.push(proposed.pendingUpdateId);
		}
		ids.push(
			(
				await propose_move_for_test(t, {
					...db,
					nodeId: anchor._id,
					destParent: { kind: "saved", id: target._id },
					destName: anchor.name,
				})
			).pendingUpdateId,
		);
		expect((await accept_move_proposals_for_test(t, db, ids)).activity?.status).toBe("succeeded");
		await t.run(async (ctx) => {
			const shared = await files_db_get_visible_node_by_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				path: target.path + "/" + anchor.name + "/new/shared",
			});
			expect(shared).toMatchObject({ restrictedScopeNodeId: target._id });
			for (const source of sources)
				expect(await ctx.db.get("files_nodes", source._id)).toMatchObject({
					parentId: shared!._id,
					path: target.path + "/" + anchor.name + "/new/shared/" + source.name,
					restrictedScopeNodeId: target._id,
				});
			expect(await ctx.db.get("files_nodes", archivedChild._id)).toMatchObject({
				archiveOperationId: "old-archive",
				path: target.path + "/" + anchor.name + "/new/shared/" + sources[0]!.name + "/" + archivedChild.name,
				restrictedScopeNodeId: target._id,
			});
		});
	});

	test("reuses an existing destination parent during Rename", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const source = db.files.file_root_1_child_1;
		const parent = db.files.file_root_1_child_2;
		expect(
			(
				await test_rename_node(t, asUser, {
					membershipId: db.membershipId,
					nodeId: source._id,
					path: parent.name + "/leaf",
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toMatchObject({
			parentId: parent._id,
			path: parent.path + "/leaf",
		});
	});

	test.each(["planned-parent", "same-leaf", "cycle"] as const)(
		"refuses a draft Move with a %s conflict before saved writes",
		async (conflict) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const source = db.files.file_root_1_child_1;
			const other = db.files.file_root_1_child_2;
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: db.files.file_root_1.path + "/new",
				kind: "folder",
			});
			if (created._nay) throw new Error(created._nay.message);
			if (created._yay.target.kind !== "private") throw new Error("Expected a private parent");
			if (conflict !== "cycle")
				await propose_move_for_test(t, {
					...db,
					nodeId: source._id,
					destParent: created._yay.target,
					destName: "leaf",
				});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const result = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				target: { kind: "saved", id: conflict === "cycle" ? source._id : other._id },
				destParent:
					conflict === "planned-parent"
						? { kind: "saved", id: db.files.file_root_1._id }
						: conflict === "cycle"
							? { kind: "saved", id: source._id }
							: created._yay.target,
				destName: conflict === "planned-parent" ? "new" : "leaf",
			});
			expect(result._nay).toBeDefined();
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test("swaps parents and keeps an explicit child move in the final graph", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const first = db.files.file_root_1;
		const second = db.files.file_root_2;
		const child = db.files.file_root_1_child_1;
		await test_run_with_flush(t, (ctx) =>
			ctx.db.patch("files_nodes", second._id, {
				restrictedScopeNodeId: second._id,
				isRestrictedScopeRoot: true,
				writePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
			}),
		);
		await propose_move_for_test(t, {
			...db,
			nodeId: first._id,
			destParent: { kind: "root" },
			destName: "temporary-draft-name",
		});
		const secondMove = await propose_move_for_test(t, {
			...db,
			nodeId: second._id,
			destParent: { kind: "root" },
			destName: first.name,
		});
		const firstMove = await propose_move_for_test(t, {
			...db,
			nodeId: first._id,
			destParent: { kind: "root" },
			destName: second.name,
		});
		const childMove = await propose_move_for_test(t, {
			...db,
			nodeId: child._id,
			destParent: { kind: "saved", id: second._id },
			destName: "explicit-child",
		});
		expect(
			(
				await accept_move_proposals_for_test(t, db, [
					firstMove.pendingUpdateId,
					secondMove.pendingUpdateId,
					childMove.pendingUpdateId,
				])
			).activity?.status,
		).toBe("succeeded");
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", child._id)).toMatchObject({
				parentId: second._id,
				path: first.path + "/explicit-child",
				restrictedScopeNodeId: second._id,
			});
			expect(await ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id)).toMatchObject({
				parentId: child._id,
				path: first.path + "/explicit-child/" + db.files.file_root_1_child_1_deep_1.name,
				restrictedScopeNodeId: second._id,
			});
			expect(await ctx.db.get("files_nodes", db.files.file_root_1_child_2._id)).toMatchObject({
				parentId: first._id,
				path: second.path + "/" + db.files.file_root_1_child_2.name,
				restrictedScopeNodeId: null,
			});
		});
	});

	test("uses the final parent graph when a current child becomes a parent", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const parent = db.files.file_root_1;
		const child = db.files.file_root_1_child_1;
		const childMove = await propose_move_for_test(t, {
			...db,
			nodeId: child._id,
			destParent: { kind: "root" },
			destName: child.name,
		});
		const parentMove = await propose_move_for_test(t, {
			...db,
			nodeId: parent._id,
			destParent: { kind: "saved", id: child._id },
			destName: parent.name,
		});
		expect(
			(await accept_move_proposals_for_test(t, db, [parentMove.pendingUpdateId, childMove.pendingUpdateId])).activity
				?.status,
		).toBe("succeeded");
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", parent._id)).toMatchObject({
				parentId: child._id,
				path: "/" + child.name + "/" + parent.name,
			});
			expect(await ctx.db.get("files_nodes", db.files.file_root_1_child_2._id)).toMatchObject({
				path: "/" + child.name + "/" + parent.name + "/" + db.files.file_root_1_child_2.name,
			});
		});
	});

	test.each(["asset", "sequence", "lineage", "mode", "newcomer"] as const)(
		"refuses a reviewed replacement after its %s changes",
		async (changed) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const source = db.files.file_root_1_child_2;
			const occupant = db.files.file_root_2;
			const lastSequenceId = await test_run_with_flush(t, async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "upload",
					r2Bucket: "test-bucket",
					r2Key: "approved",
					size: 5,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: occupant._id,
					lastSequence: 4,
					lineageGeneration: 2,
					unmaterializedUpdateCount: 0,
					unmaterializedUpdateBytes: 0,
				});
				await ctx.db.patch("files_nodes", source._id, { kind: "file", treePath: source.path });
				await ctx.db.patch("files_nodes", occupant._id, {
					kind: "file",
					treePath: occupant.path,
					assetId,
					contentType: "text/plain",
					textKind: "plain_text",
					collaborationEnabled: changed !== "asset",
					yjsLastSequenceId: lastSequenceId,
					contentShapeMismatchAt: Date.now(),
				});
				return lastSequenceId;
			});
			const move = await propose_move_for_test(t, {
				...db,
				nodeId: source._id,
				destParent: { kind: "root" },
				destName: occupant.name,
				replace: true,
			});
			await test_run_with_flush(t, async (ctx) => {
				if (changed === "sequence" || changed === "lineage") {
					await ctx.db.patch(
						"files_yjs_docs_last_sequences",
						lastSequenceId,
						changed === "sequence" ? { lastSequence: 5 } : { lineageGeneration: 3 },
					);
				} else if (changed === "mode") {
					await ctx.db.patch("files_nodes", occupant._id, { collaborationEnabled: false });
				} else if (changed === "asset") {
					const assetId = await ctx.db.insert("files_r2_assets", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						kind: "upload",
						r2Bucket: "test-bucket",
						r2Key: "changed",
						size: 5,
						createdBy: db.userId,
						updatedAt: Date.now(),
					});
					await ctx.db.patch("files_nodes", occupant._id, { assetId });
				} else {
					await ctx.db.patch("files_nodes", occupant._id, { archiveOperationId: "old-occupant" });
					await ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						createdBy: db.userId,
						updatedBy: db.userId,
						kind: "file",
						parentId: files_ROOT_ID,
						name: occupant.name,
						sortName: files_sort_text_key(occupant.name),
						path: occupant.path,
						treePath: occupant.path,
					});
				}
			});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const review = await accept_move_proposals_for_test(t, db, [move.pendingUpdateId]);
			expect(review.activity?.status).toBe("failed");
			expect(review.units.some((unit) => unit.errorCode === "destination_changed")).toBe(true);
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test.each([false, true])(
		"archives an exact occupant under a moving parent (collaborative: %s)",
		async (collaborative) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const parent = db.files.file_root_1;
			const source = db.files.file_root_2;
			const occupant = db.files.file_root_1_child_2;
			const assetId = await test_run_with_flush(t, async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "upload",
					r2Bucket: "test-bucket",
					r2Key: "replacement",
					size: 5,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: occupant._id,
					lastSequence: 4,
					lineageGeneration: 2,
					unmaterializedUpdateCount: 0,
					unmaterializedUpdateBytes: 0,
				});
				for (const node of [source, occupant]) {
					await ctx.db.patch("files_nodes", node._id, {
						kind: "file",
						treePath: node.path,
						assetId,
						contentType: "text/plain",
						textKind: "plain_text",
						collaborationEnabled: node._id === occupant._id && collaborative,
						yjsLastSequenceId: node._id === occupant._id && collaborative ? lastSequenceId : null,
					});
					const inserted = await db_insert_file_text_content(ctx, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						nodeId: node._id,
						path: node.path,
						rootKind: "plain_text",
						textContent: "saved text",
					});
					if (inserted._nay) throw new Error(inserted._nay.message);
					await ctx.db.insert("files_metadata_docs", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: node._id,
						sourceKind: "committed",
						docKind: "field",
						fieldPath: "metadata.tag",
						path: node.path,
						treePath: node.path,
					});
				}
				return assetId;
			});
			const replace = await propose_move_for_test(t, {
				...db,
				nodeId: source._id,
				destParent: { kind: "saved", id: parent._id },
				destName: occupant.name,
				replace: true,
			});
			const parentMove = await propose_move_for_test(t, {
				...db,
				nodeId: parent._id,
				destParent: { kind: "root" },
				destName: "moved-parent",
			});
			const review = await accept_move_proposals_for_test(t, db, [replace.pendingUpdateId, parentMove.pendingUpdateId]);
			expect(review.activity?.status, JSON.stringify(review.units)).toBe("succeeded");
			await t.run(async (ctx) => {
				const archived = (await ctx.db.get("files_nodes", occupant._id))!;
				const path = "/moved-parent/" + occupant.name;
				expect(archived).toMatchObject({ path, assetId });
				expect(archived.archiveOperationId).toEqual(expect.any(String));
				expect(await ctx.db.get("files_nodes", source._id)).toMatchObject({ path, assetId, archiveOperationId: null });
				for (const table of ["files_plain_text_chunks", "files_metadata_docs"] as const) {
					const docs = await ctx.db.query(table).collect();
					expect(docs).toHaveLength(2);
					for (const doc of docs) {
						expect(doc.path).toBe(path);
						expect(doc.archiveOperationId).toBe(
							doc.sourceKind === "committed" && doc.fileNodeId === occupant._id
								? archived.archiveOperationId
								: undefined,
						);
					}
				}
			});
		},
	);

	test.each(["active", "read_only", "archived"] as const)(
		"checks a replacement folder's %s descendants before writing",
		async (childState) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const occupant = db.files.file_root_1_child_1;
			const child = db.files.file_root_1_child_1_deep_1;
			const source = db.files.file_root_2;
			await test_run_with_flush(t, async (ctx) => {
				if (childState !== "active") {
					await ctx.db.patch("files_nodes", child._id, {
						archiveOperationId: "earlier-archive",
						sortName: files_sort_text_key(child.name),
						...(childState === "read_only" ? { writePolicy: { mode: "read_only" as const } } : {}),
					});
					await ctx.db.patch("files_nodes", child._id, {
						ancestor1: db.files.file_root_1._id,
						ancestor2: occupant._id,
					});
				}
			});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const result = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				target: { kind: "saved", id: source._id },
				destParent: { kind: "saved", id: occupant.parentId as Id<"files_nodes"> },
				destName: occupant.name,
				replace: true,
			});
			if (childState === "archived") {
				expect(result._nay).toBeUndefined();
				const proposal = await t.run((ctx) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", source._id),
						)
						.unique(),
				);
				const parentMove = await propose_move_for_test(t, {
					...db,
					nodeId: db.files.file_root_1._id,
					destParent: { kind: "root" },
					destName: "moved-parent",
				});
				expect(
					(await accept_move_proposals_for_test(t, db, [proposal!._id, parentMove.pendingUpdateId])).activity?.status,
				).toBe("succeeded");
				const path = "/moved-parent/" + occupant.name + "/" + child.name;
				expect(await t.run((ctx) => ctx.db.get("files_nodes", child._id))).toEqual({
					...before.find((node) => node._id === child._id),
					path,
					treePath: path + "/",
				});
			} else {
				if (result._yay) {
					const proposal = await t.run((ctx) =>
						ctx.db
							.query("files_pending_updates")
							.withIndex("by_user_target", (q) =>
								q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", source._id),
							)
							.unique(),
					);
					const parentMove = await propose_move_for_test(t, {
						...db,
						nodeId: db.files.file_root_1._id,
						destParent: { kind: "root" },
						destName: "moved-parent",
					});
					const review = await accept_move_proposals_for_test(t, db, [proposal!._id, parentMove.pendingUpdateId]);
					expect(review.activity?.status).toBe("failed");
					expect(review.units.some((unit) => unit.errorMessage === "This item is read-only.")).toBe(true);
				} else
					expect(result._nay.message).toBe(childState === "active" ? "Directory not empty" : "This item is read-only.");
				expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			}
		},
	);

	test("refuses moving an occupant already claimed by a replacement", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const occupant = db.files.file_root_1_child_2;
		const source = db.files.file_root_2;
		const replacement = await propose_move_for_test(t, {
			...db,
			nodeId: source._id,
			destParent: { kind: "saved", id: db.files.file_root_1._id },
			destName: occupant.name,
			replace: true,
		});
		const movedOccupant = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: occupant._id },
			destParent: { kind: "root" },
			destName: occupant.name,
		});
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(movedOccupant._nay?.message).toBe("Not found");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", replacement.pendingUpdateId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test.each([
		{ label: "file over a folder", sourceKind: "file" as const, occupantKind: "folder" as const },
		{ label: "folder over a file", sourceKind: "folder" as const, occupantKind: "file" as const },
	])("refuses a replacement of a $label", async ({ sourceKind, occupantKind }) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const source = db.files.file_root_2;
		const occupant = db.files.file_root_1_child_2;
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_nodes", source._id, {
				kind: sourceKind,
				treePath: source.path + (sourceKind === "folder" ? "/" : ""),
			});
			await ctx.db.patch("files_nodes", occupant._id, {
				kind: occupantKind,
				treePath: occupant.path + (occupantKind === "folder" ? "/" : ""),
			});
		});
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const result = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: source._id },
			destParent: { kind: "saved", id: db.files.file_root_1._id },
			destName: occupant.name,
			replace: true,
		});
		expect(result._nay?.message).toBe("Path already exists");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});
});

describe("existing service-account writer policy", () => {
	test.each([
		{ policyReach: "none", lockedParent: "current" },
		{ policyReach: "direct", lockedParent: "current" },
		{ policyReach: "ancestors", lockedParent: "current" },
		{ policyReach: "none", lockedParent: "final" },
		{ policyReach: "direct", lockedParent: "final" },
		{ policyReach: "ancestors", lockedParent: "final" },
	] as const)(
		"checks local rules with $policyReach reach on the $lockedParent parent",
		async ({ policyReach, lockedParent }) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const created = await asUser.mutation(api.access_control.create_service_account, {
				membershipId: db.membershipId,
				name: "Move writer",
			});
			if (created._nay) throw new Error(created._nay.message);
			const serviceAccountId = created._yay.serviceAccountId;
			const grant = await asUser.mutation(api.access_control.set_service_account_grant, {
				membershipId: db.membershipId,
				serviceAccountId,
				resource: { kind: "workspace" },
				level: "write",
			});
			if (grant._nay) throw new Error(grant._nay.message);
			const policyNode = lockedParent === "current" ? db.files.file_root_1 : db.files.file_root_2;
			await t.run(async (ctx) => {
				await ctx.db.patch("files_nodes", policyNode._id, {
					writePolicy: { mode: "writer", writers: [{ kind: "service_account", serviceAccountId }] },
				});
				const before = await ctx.db.query("files_nodes").collect();
				const writeContext: files_nodes_WriteContext = {
					writer: { kind: "service_account", serviceAccountId },
					actorUserId: db.userId,
					resourceScope: { kind: "workspace" },
					policyReach,
				};
				// Existing-node writes check each named local rule. Create reach is separate.
				for (const nodeId of [db.files.file_root_1_child_2._id, db.files.file_root_1._id, db.files.file_root_2._id]) {
					const node = (await ctx.db.get("files_nodes", nodeId))!;
					expect(
						await files_nodes_db_require_writable(ctx, {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							writeContext,
							target: { kind: "node", node },
						}),
					).toEqual({ _yay: null });
				}
				expect(await ctx.db.query("files_nodes").collect()).toEqual(before);
				const locked = {
					...(await ctx.db.get("files_nodes", policyNode._id))!,
					writePolicy: { mode: "read_only" as const },
				};
				expect(
					(
						await files_nodes_db_require_writable(ctx, {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							writeContext,
							target: { kind: "node", node: locked },
						})
					)._nay?.name,
				).toBe("read_only");
			});
		},
	);
});

describe("paged folder moves and scope jobs", () => {
	/**
	 * Insert `/source` with `childCount` child folders and `/target`. Every node gets
	 * `metadataPerNode` metadata docs, so a test can see that the side docs follow their node.
	 */
	async function seed_wide_source(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		childCount: number;
		metadataPerNode: number;
	}) {
		const { t, db } = args;

		return await t.run(async (ctx) => {
			const base = {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
			};
			const sourceId = await ctx.db.insert("files_nodes", {
				...base,
				name: "source",
				sortName: files_sort_text_key("source"),
				path: "/source",
				treePath: "/source/",
			});
			const targetId = await ctx.db.insert("files_nodes", {
				...base,
				name: "target",
				sortName: files_sort_text_key("target"),
				path: "/target",
				treePath: "/target/",
			});
			const nodeIds = [sourceId];
			for (let index = 0; index < args.childCount; index += 1) {
				nodeIds.push(
					await ctx.db.insert("files_nodes", {
						...base,
						parentId: sourceId,
						name: `child-${index}`,
						sortName: files_sort_text_key(`child-${index}`),
						path: `/source/child-${index}`,
						treePath: `/source/child-${index}/`,
						pathDepth: 2,
						archiveOperationId: index === args.childCount - 1 ? "earlier-archive" : null,
					}),
				);
			}
			for (const nodeId of nodeIds) {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				for (let index = 0; index < args.metadataPerNode; index += 1) {
					await ctx.db.insert("files_metadata_docs", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: node._id,
						sourceKind: "committed",
						docKind: "field",
						fieldPath: `metadata.key-${index}`,
						path: node.path,
						treePath: node.treePath,
						archiveOperationId: node.archiveOperationId ?? undefined,
					});
				}
			}
			return {
				source: (await ctx.db.get("files_nodes", sourceId))!,
				target: (await ctx.db.get("files_nodes", targetId))!,
			};
		});
	}

	/**
	 * 65 children need several descendant pages even when one transaction joins small steps.
	 */
	const BIG_FOLDER_CHILDREN = 65;

	/**
	 * Count descendant transactions that leave more walking work for the next transaction.
	 */
	function count_paged_moves() {
		const paged = { count: 0 };
		test_spy_handler(advance_move_cohort, async (handler, ctx, args) => {
			const { cohortId, step } = args as { cohortId: Id<"files_move_cohorts">; step: number };
			const cohort = await ctx.db.get("files_move_cohorts", cohortId);
			const result = await handler(ctx, args);
			const after = await ctx.db.get("files_move_cohorts", cohortId);
			if (cohort?.step === step && cohort.workPhase === "descendants" && after?.workPhase === "descendants" && after.step > step)
				paged.count++;
			return result;
		});
		return paged;
	}

	test("reviews a big folder and repairs every descendant's metadata", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const { source, target } = await seed_wide_source({ t, db, childCount: BIG_FOLDER_CHILDREN, metadataPerNode: 3 });
		const pagedMoves = count_paged_moves();
		const move = await propose_move_for_test(t, {
			...db,
			nodeId: source._id,
			destParent: { kind: "saved", id: target._id },
			destName: source.name,
		});
		const review = await accept_move_proposals_for_test(t, db, [move.pendingUpdateId]);
		expect(review.activity?.status, JSON.stringify(review.units)).toBe("succeeded");
		expect(review.units).toHaveLength(1);
		expect(review.units[0]?.itemCount).toBe(1);
		await t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			const children = nodes.filter((node) => node.parentId === source._id);
			expect(children).toHaveLength(BIG_FOLDER_CHILDREN);
			expect(children.every((node) => node.path.startsWith("/target/source/"))).toBe(true);
			expect(children.filter((node) => node.archiveOperationId !== null).map((node) => node.name)).toEqual([
				`child-${BIG_FOLDER_CHILDREN - 1}`,
			]);
			const paths = new Map(nodes.map((node) => [node._id, node.path]));
			const metadata = await ctx.db.query("files_metadata_docs").collect();
			expect(metadata).toHaveLength((BIG_FOLDER_CHILDREN + 1) * 3);
			expect(metadata.every((doc) => doc.sourceKind === "committed" && doc.path === paths.get(doc.fileNodeId))).toBe(
				true,
			);
		});
		expect(pagedMoves.count, "the folder needs more than one Move page").toBeGreaterThan(0);
	});

	test("a public Move finishes every child path in a big folder", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const { source, target } = await seed_wide_source({ t, db, childCount: BIG_FOLDER_CHILDREN, metadataPerNode: 1 });
		const pagedMoves = count_paged_moves();

		expect(
			await test_move_nodes(t, asUser, {
				membershipId: db.membershipId,
				itemIds: [source._id],
				targetParentId: target._id,
			}),
		).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toMatchObject({
			parentId: target._id,
			path: "/target/source",
		});
		// The public helper waits for publication and physical path repair.
		const lookup = (path: string) =>
			t.run(
				async (ctx) =>
					(
						await files_db_get_visible_node_by_path(ctx, {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							path,
						})
					)?.name ?? null,
			);
		const child = await t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).find((node) => node.name === "child-1"),
		);
		expect(child?.path).toBe("/target/source/child-1");
		expect(await lookup("/target/source/child-1")).toBe("child-1");
		expect(await lookup("/source/child-1")).toBeNull();
		expect(
			await asUser.query(api.files_nodes.get_authorized_by_path, {
				membershipId: db.membershipId,
				path: "/target/source/child-1",
			}),
		).toMatchObject({ nodeId: child!._id });
		expect(
			await asUser.query(api.files_nodes.get_authorized_by_path, {
				membershipId: db.membershipId,
				path: "/source/child-1",
			}),
		).toBeNull();

		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const children = nodes.filter((node) => node.parentId === source._id);
		expect(children).toHaveLength(BIG_FOLDER_CHILDREN);
		expect(children.filter((node) => !node.path.startsWith("/target/source/child-"))).toEqual([]);
		// The walk writes paths, never the archive stamp.
		expect(children.filter((node) => node.archiveOperationId !== null).map((node) => node.name)).toEqual([
			`child-${BIG_FOLDER_CHILDREN - 1}`,
		]);
		const metadata = await t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
		const pathById = new Map(nodes.map((node) => [node._id, node.path]));
		expect(
			metadata.filter((doc) => doc.sourceKind !== "committed" || doc.path !== pathById.get(doc.fileNodeId)),
		).toEqual([]);
		expect(pagedMoves.count, "the folder needs more than one Move page").toBeGreaterThan(0);
	});

	test("a public Move finishes a big group of archived items with one name", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const { source, target } = await seed_wide_source({ t, db, childCount: 0, metadataPerNode: 0 });
		// Each replace of `report.md` archives the old one, so a folder can collect many items with one name.
		await t.run(async (ctx) => {
			for (let index = 0; index < BIG_FOLDER_CHILDREN; index += 1) {
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: source._id,
					kind: "file",
					name: "report.md",
					sortName: files_sort_text_key("report.md"),
					path: "/source/report.md",
					treePath: "/source/report.md",
					pathDepth: 2,
					archiveOperationId: `replace-${index}`,
				});
			}
		});
		const moved = async () =>
			(await t.run((ctx) => ctx.db.query("files_nodes").collect())).filter(
				(node) => node.path === "/target/source/report.md",
			).length;
		const pagedMoves = count_paged_moves();

		expect(
			await test_move_nodes(t, asUser, {
				membershipId: db.membershipId,
				itemIds: [source._id],
				targetParentId: target._id,
			}),
		).toEqual({ _yay: null });
		expect(await moved()).toBe(BIG_FOLDER_CHILDREN);
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		expect(pagedMoves.count, "the group needs more than one Move page").toBeGreaterThan(0);
	});

	test("a restrict of a big folder commits now and a job gives every child the new scope", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		// `child-0` below keeps its own scope, so the step writes the other children. One more than
		// a step writes leaves work for the job.
		const childCount = files_subtree_ops_STEP_MAX_NODES + 2;
		const { source } = await seed_wide_source({ t, db, childCount, metadataPerNode: 0 });
		// A restricted child keeps its own scope. The walk still goes inside it.
		const nested = await t.run(async (ctx) => {
			const node = (await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/source/child-0")!;
			await ctx.db.patch("files_nodes", node._id, { isRestrictedScopeRoot: true, restrictedScopeNodeId: node._id });
			return node;
		});
		const drain = async () => {
			for (let round = 0; round < 20; round += 1) {
				await delay(0);
				await t.finishInProgressScheduledFunctions();
			}
		};
		const scopes = async () =>
			new Map(
				(await t.run((ctx) => ctx.db.query("files_nodes").collect()))
					.filter((node) => node.parentId === source._id)
					.map((node) => [node.name, node.restrictedScopeNodeId]),
			);

		expect(
			(await asUser.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: source._id }))
				._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").first())).toMatchObject({ kind: "scope" });
		const activity = await t.run((ctx) => ctx.db.query("activities").first());
		expect(activity).toMatchObject({ source: { kind: "files_subtree_op", opKind: "scope" }, feedVisible: false });
		expect(
			[...(await scopes())].filter(([name, scope]) => name !== "child-0" && scope !== source._id),
			"the first step leaves one child for the job",
		).toHaveLength(1);

		await drain();
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		const restricted = await scopes();
		expect(restricted.size).toBe(childCount);
		expect([...restricted].filter(([name, scope]) => name !== "child-0" && scope !== source._id)).toEqual([]);
		expect(restricted.get("child-0")).toBe(nested._id);

		expect(
			(await asUser.mutation(api.files_sharing.unrestrict_node, { membershipId: db.membershipId, nodeId: source._id }))
				._nay,
		).toBeUndefined();
		await drain();
		const open = await scopes();
		expect([...open].filter(([name, scope]) => name !== "child-0" && scope !== null)).toEqual([]);
		expect(open.get("child-0")).toBe(nested._id);
	});

	// Each pair below fills one budget to its cap, then crosses that one only. The success case
	// reports every counter, so it shows which limit refused the next step.
});

describe("files_nodes_db_get_content_version", () => {
	test("reads the Yjs sequence without needing a materialized snapshot", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		await t.run(async (ctx) => {
			const node = db.files.file_root_2;
			expect(await files_nodes_db_get_content_version(ctx, node)).toBeNull();
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				r2Key: "version",
				size: 5,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: node._id,
				lastSequence: 42,
				lineageGeneration: 3,
				unmaterializedUpdateCount: 20,
				unmaterializedUpdateBytes: 1000,
			});
			await ctx.db.patch("files_nodes", node._id, {
				kind: "file",
				assetId,
				contentType: "text/plain",
				textKind: "plain_text",
				collaborationEnabled: true,
				yjsLastSequenceId: lastSequenceId,
				contentShapeMismatchAt: Date.now(),
			});
			expect(await files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", node._id))!)).toEqual({
				kind: "yjs",
				lastSequenceId,
				lineageGeneration: 3,
				sequence: 42,
				contentType: "text/plain",
				textKind: "plain_text",
				collaborationEnabled: true,
			});
			await ctx.db.patch("files_nodes", node._id, { collaborationEnabled: false });
			expect(await files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", node._id))!)).toEqual({
				kind: "asset",
				assetId,
				contentType: "text/plain",
				textKind: "plain_text",
				collaborationEnabled: false,
			});
		});
	});
});

describe("move_nodes", () => {
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
		"checks nested restricted descendants with $access access (archived: $archived)",
		async ({ access, archived }) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const member = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "nested-move-member" });
				const now = Date.now();
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: now,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role: "member",
					now,
				});
				return { userId, membershipId };
			});
			const source = db.files.file_root_1;
			const restricted = db.files.file_root_1_child_1;
			const child = db.files.file_root_1_child_1_deep_1;
			const target = db.files.file_root_2;
			const other = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path: "other-source",
			});
			if (other._nay) throw new Error(other._nay.message);
			expect(
				(
					await asOwner.mutation(api.files_sharing.restrict_node, {
						membershipId: db.membershipId,
						nodeId: restricted._id,
					})
				)._nay,
			).toBeUndefined();
			if (access === "read" || access === "write") {
				expect(
					(
						await asOwner.mutation(api.files_sharing.set_node_share_grant, {
							membershipId: db.membershipId,
							nodeId: restricted._id,
							principal: { kind: "user", userId: member.userId },
							level: access,
						})
					)._nay,
				).toBeUndefined();
			}
			if (archived) {
				expect(
					(
						await asOwner.mutation(api.files_nodes.archive_nodes, {
							membershipId: db.membershipId,
							nodeIds: [restricted._id],
						})
					)._nay,
				).toBeUndefined();
			}
			const asUser =
				access === "owner" ? asOwner : t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
			const membershipId = access === "owner" ? db.membershipId : member.membershipId;
			const sourceBefore = await t.run((ctx) => ctx.db.get("files_nodes", source._id));
			// An unchanged parent does not act on its hidden descendants.
			expect(
				(
					await test_move_nodes(t, asUser, {
						membershipId,
						itemIds: [source._id],
						targetParentId: files_ROOT_ID,
					})
				)._nay,
			).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toMatchObject({
				parentId: sourceBefore!.parentId,
				path: sourceBefore!.path,
				updatedAt: sourceBefore!.updatedAt,
			});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const result = await test_move_nodes(t, asUser, {
				membershipId,
				itemIds: [other._yay.nodeId, source._id],
				targetParentId: target._id,
			});
			if (access === "none" || access === "read") {
				expect(result._nay?.message).toBe("Permission denied");
				expect(JSON.stringify(result)).not.toContain(restricted.name);
				expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toEqual(
					before.find((node) => node._id === source._id),
				);
				for (const node of [restricted, child]) {
					expect(await t.run((ctx) => ctx.db.get("files_nodes", node._id))).toEqual(
						before.find((saved) => saved._id === node._id),
					);
				}
				expect(await t.run((ctx) => ctx.db.get("files_nodes", other._yay.nodeId))).toMatchObject({
					parentId: target._id,
					path: `${target.path}/other-source`,
				});
			} else {
				expect(result._nay).toBeUndefined();
				for (const node of [restricted, child]) {
					expect(await t.run((ctx) => ctx.db.get("files_nodes", node._id))).toMatchObject({
						path: `${target.path}${node.path}`,
						restrictedScopeNodeId: restricted._id,
						archiveOperationId: before.find((saved) => saved._id === node._id)!.archiveOperationId,
					});
				}
				expect(await t.run((ctx) => ctx.db.get("files_nodes", other._yay.nodeId))).toMatchObject({
					parentId: target._id,
					path: `${target.path}/other-source`,
				});
			}
		},
	);

	test("moves only the selected ancestor when a child and duplicate ids are selected", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const source = db.files.file_root_1_child_1;
		const child = db.files.file_root_1_child_1_deep_1;
		const target = db.files.file_root_2;

		const result = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [child._id, source._id, source._id],
			targetParentId: target._id,
		});
		expect(result._yay).toBe(null);
		const moved = await t.run(async (ctx) => ctx.db.get("files_nodes", child._id));
		expect(moved).toMatchObject({ parentId: source._id, path: `${target.path}/${source.name}/${child.name}` });
	});

	test.each(["self", "descendant"])(
		"refuses a %s destination before moving another selected item",
		async (targetKind) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const result = await test_move_nodes(t, asUser, {
				membershipId: db.membershipId,
				itemIds: [db.files.file_root_2._id, db.files.file_root_1._id],
				targetParentId: targetKind === "self" ? db.files.file_root_1._id : db.files.file_root_1_child_1._id,
			});
			expect(result._nay?.message).toBe("A folder cannot be transferred inside itself");
			expect(await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_2._id))).toEqual(
				db.files.file_root_2,
			);
		},
	);

	test.each(["missing", "archived"])("refuses a %s source without moving the other source", async (sourceKind) => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const unavailable = db.files.file_root_1_child_2;
		await t.run(async (ctx) => {
			if (sourceKind === "missing") {
				await ctx.db.delete("files_nodes", unavailable._id);
			} else {
				await ctx.db.patch("files_nodes", unavailable._id, { archiveOperationId: "archived-source" });
			}
		});
		const result = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [db.files.file_root_1_child_1._id, unavailable._id],
			targetParentId: db.files.file_root_2._id,
		});
		expect(result._nay?.message).toBe("Permission denied");
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1._id))).toEqual(
			db.files.file_root_1_child_1,
		);
	});

	test("refuses an archived destination", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [db.files.file_root_2._id],
		});
		const result = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [db.files.file_root_1._id],
			targetParentId: db.files.file_root_2._id,
		});
		expect(result._nay?.message).toBe("Destination changed");
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id))).toEqual(
			db.files.file_root_1,
		);
	});
});

describe("reviewed Move names and paths", () => {
	test("Save names a long draft child, keeps the private tree, and succeeds after shortening a parent", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/a/b/c/d/leaf",
			kind: "folder",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder tree");
		const drafts = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(drafts).toHaveLength(5);
		const parents = ["a", "b", "c", "d"].map((name) => drafts.find((node) => node.name === name)!);
		// Each Rename checks its own path. Later parent renames can lengthen the leaf beyond the limit.
		for (const parent of [...parents].reverse())
			expect(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "private", id: parent._id },
					destParent: parent.parent,
					destName: parent.name.repeat(files_NAME_MAX_LENGTH),
				}),
			).toMatchObject({ _yay: { appliedImmediately: true } });
		const parentPath = "/" + parents.map((parent) => parent.name.repeat(files_NAME_MAX_LENGTH)).join("/");
		const longPath = parentPath + "/leaf";
		expect(parentPath.length).toBe(files_PATH_MAX_LENGTH);
		expect(longPath.length).toBeGreaterThan(files_PATH_MAX_LENGTH);
		const proposal = (await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!)))!;
		const args = {
			membershipId: db.membershipId,
			target: proposal.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		};
		expect(
			await test_save_file_pending_update(asUser, args),
			"Save refuses the long leaf before publication",
		).toMatchObject({
			_nay: {
				name: "path_too_long",
				message: `…/leaf would have a path of ${longPath.length.toLocaleString("en-US")} characters. Paths can have at most ${files_PATH_MAX_LENGTH.toLocaleString("en-US")} characters. Shorten a folder name or move it higher.`,
			},
		});
		expect(
			await t.run((ctx) => ctx.db.query("files_nodes").collect()),
			"the failed Save publishes no folder",
		).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(
			(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).map((node) => ({
				id: node._id,
				state: node.state,
			})),
			"the failed Save keeps every private folder",
		).toEqual(drafts.map((node) => ({ id: node._id, state: "active" })));

		const root = parents[0]!;
		expect(
			await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				target: { kind: "private", id: root._id },
				destParent: root.parent,
				destName: "a",
			}),
		).toMatchObject({ _yay: { appliedImmediately: true } });
		const saved = await test_save_file_pending_update(asUser, args);
		if (saved._nay) throw new Error(saved._nay.message);
		const savedTarget = saved._yay.target;
		if (savedTarget.kind !== "saved") throw new Error("Expected Save to publish the folder");
		const shorterPath =
			"/a/" + parents.slice(1).map((parent) => parent.name.repeat(files_NAME_MAX_LENGTH)).join("/") + "/leaf";
		expect(await t.run((ctx) => ctx.db.get("files_nodes", savedTarget.id))).toMatchObject({ path: shorterPath });
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(drafts.length);
		expect(
			(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).map((node) => node.state),
		).toEqual(drafts.map(() => "published"));
	});

	test("moves 41 mixed files with final counter names and keeps their assets", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const sources = await t.run(async (ctx) => {
			const files: Array<{
				nodeId: Id<"files_nodes">;
				assetId: Id<"files_r2_assets">;
				destName: string;
			}> = [];
			const extensions = ["md", "txt", "png", "pdf", "mp4", "json"];
			for (let index = 0; index < 41; index += 1) {
				const name = `file-${index}.${extensions[index % extensions.length]}`;
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "upload",
					r2Bucket: "test-bucket",
					r2Key: `test-assets/${index}`,
					size: 100,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const nodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					kind: "file",
					parentId: files_ROOT_ID,
					name,
					sortName: files_sort_text_key(name),
					path: `/${name}`,
					treePath: `/${name}/`,
					pathDepth: 1,
					assetId,
				});
				files.push({
					nodeId,
					assetId,
					destName: `file-${index}-copy-1.${extensions[index % extensions.length]}`,
				});
			}
			return files;
		});
		const proposalIds: Id<"files_pending_updates">[] = [];
		for (const source of sources) {
			const proposal = await propose_move_for_test(t, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId: source.nodeId,
				destParent: { kind: "saved", id: db.files.file_root_2._id },
				destName: source.destName,
			});
			proposalIds.push(proposal.pendingUpdateId);
		}
		const review = await accept_move_proposals_for_test(t, db, proposalIds);
		expect(review.activity?.status).toBe("succeeded");
		expect(review.activity?.progress?.completed).toBe(41);
		await t.run(async (ctx) => {
			for (const source of sources) {
				expect(await ctx.db.get("files_nodes", source.nodeId)).toMatchObject({
					_id: source.nodeId,
					assetId: source.assetId,
					name: source.destName,
					parentId: db.files.file_root_2._id,
					path: `${db.files.file_root_2.path}/${source.destName}`,
				});
				expect((await ctx.db.get("files_r2_assets", source.assetId))?.size).toBe(100);
			}
		});
	}, 7_200_000);

	test.each([
		{ changed: "source", afterPlanning: false },
		{ changed: "destination", afterPlanning: false },
		{ changed: "destination", afterPlanning: true },
	] as const)(
		"pins the reviewed $changed path before publication (planned: $afterPlanning)",
		async ({ changed, afterPlanning }) => {
			vi.useFakeTimers();
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const source = db.files.file_root_1_child_1;
			const target = db.files.file_root_2;
			const move = await propose_move_for_test(t, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId: source._id,
				destParent: { kind: "saved", id: target._id },
				destName: "copied-folder-1",
			});
			const started = await asUser.mutation(api.files_pending_update_runs.start, {
				membershipId: db.membershipId,
				requestId: crypto.randomUUID(),
				kind: "accept",
				expectedItemCount: 1,
				items: [
					{
						pendingUpdateId: move.pendingUpdateId,
						reviewedRevision: move.reviewedRevision,
						selectedContentStateId: null,
					},
				],
			});
			if (started._nay) throw new Error(started._nay.message);
			const review = started._yay;
			if (afterPlanning) {
				expect(
					await asUser.mutation(api.files_pending_update_runs.seal, {
						membershipId: db.membershipId,
						runId: review.runId,
					}),
				).toEqual({ _yay: null });
				for (let pass = 0; pass < 1_000; pass++) {
					const job = await t.run((ctx) =>
						ctx.db
							.query("files_pending_overlay_jobs")
							.withIndex("by_org_ws", (q) =>
								q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
							)
							.first(),
					);
					if (job)
						await t.mutation(internal.files_pending_overlay.run_job, {
							kind: job.kind,
							key: job.key,
							nextAttemptAt: job.nextAttemptAt,
						});
					else await asUser.action(internal.files_pending_update_runs.plan, { runId: review.runId, fence: 0 });
					const run = await t.run((ctx) => ctx.db.get("files_pending_update_runs", review.runId));
					if (run?.step !== "planning") break;
					if (pass === 999) throw new Error("Review planning did not finish");
				}
			}

			const renamed = await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: db.membershipId,
				requestId: crypto.randomUUID(),
				nodeId: changed === "source" ? db.files.file_root_1._id : target._id,
				path: `changed-${changed}`,
			});
			if (!renamed._yay) throw new Error(renamed._nay?.message ?? "Expected the Rename job");
			const rename = renamed._yay;
			// Drive only Rename. The other job must keep its reviewed paths until its own worker starts.
			for (let pass = 0; pass < 5_000; pass++) {
				const activity = await t.run((ctx) => ctx.db.get("activities", rename.activityId));
				if (activity?.status === "succeeded") break;
				expect(activity?.status, "the concurrent Rename stays valid").not.toBe("failed");
				const job = await t.run(async (ctx) =>
					(
						await ctx.db
							.query("files_pending_overlay_jobs")
							.withIndex("by_org_ws", (q) =>
								q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
							)
							.collect()
					).find((entry) => !entry.blockedByCohortId),
				);
				if (job) {
					await t.mutation(internal.files_pending_overlay.run_job, {
						kind: job.kind,
						key: job.key,
						nextAttemptAt: job.nextAttemptAt,
					});
					continue;
				}
				const cohort = await t.run((ctx) =>
					ctx.db
						.query("files_move_cohorts")
						.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", rename.runId))
						.order("desc")
						.first(),
				);
				if (cohort && cohort.phase !== "complete")
					await asUser.action(internal.files_move_run.run, { cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, mode: "step" });
				else if (cohort) await t.mutation(internal.files_transfer.settle_cohort, { cohortId: cohort._id });
				await t.mutation(internal.files_transfer.advance, { runId: rename.runId });
				if (pass === 4_999) throw new Error("Rename did not finish");
			}
			if (!afterPlanning)
				expect(
					await asUser.mutation(api.files_pending_update_runs.seal, {
						membershipId: db.membershipId,
						runId: review.runId,
					}),
				).toEqual({ _yay: null });
			await test_finish_pending_update_run(asUser, review.runId);
			const activity = await t.run((ctx) => ctx.db.get("activities", review.activityId));
			expect(activity?.status, "a reviewed path change needs a new review").toBe("failed");
			expect(activity?.progress?.completed).toBe(0);
			const current = await t.run((ctx) => ctx.db.get("files_nodes", source._id));
			expect(current).toMatchObject({
				name: source.name,
				parentId: source.parentId,
				path: changed === "source" ? `/changed-source/${source.name}` : source.path,
			});
			expect((await t.run((ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id)))?.path).toBe(
				`${current!.path}/${db.files.file_root_1_child_1_deep_1.name}`,
			);
		},
	);
});
test("move_nodes updates descendants materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await test_move_nodes(t, asUser, {
		itemIds: [db.files.file_root_1_child_1._id],
		targetParentId: db.files.file_root_2._id,
		membershipId: db.membershipId,
	});

	await t.run(async (ctx) => {
		const [movedChild, movedDeep] = await Promise.all([
			ctx.db.get("files_nodes", db.files.file_root_1_child_1._id),
			ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id),
		]);

		expect(movedChild?.path).toBe(`/${db.files.file_root_2.name}/${db.files.file_root_1_child_1.name}`);
		expect(movedDeep?.path).toBe(
			`/${db.files.file_root_2.name}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		);
	});
});

test("move_nodes leaves generated siblings independent from the source", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const targetFolder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "received",
	});
	if (targetFolder._nay) {
		throw new Error(targetFolder._nay.message);
	}
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf",
			kind: "file",
			path: "/report.pdf",
			treePath: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf.md",
			kind: "file",
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	const moveResult = await test_move_nodes(t, asUser, {
		membershipId: db.membershipId,
		itemIds: [sourceNodeId],
		targetParentId: targetFolder._yay.nodeId,
	});
	if (moveResult._nay) {
		throw new Error("Expected source move with generated sibling to succeed", {
			cause: moveResult._nay,
		});
	}

	const docs = await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { source, generated };
	});
	expect(docs.source?.path).toBe("/received/report.pdf");
	expect(docs.generated).toMatchObject({
		parentId: files_ROOT_ID,
		name: "report.pdf.md",
		path: "/report.pdf.md",
	});
});

test("home file can be renamed and moved like any file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const homeNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			contentType: null,
			assetId: null,
			contentByteSize: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			isRestrictedScopeRoot: false,
			writePolicy: null,

			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "README.md",
			sortName: files_sort_text_key("README.md"),
			kind: "file",
			path: "/README.md",
			treePath: "/README.md",
			pathDepth: 1,
			lowercaseExtension: "md",
			archiveOperationId: null,
			newChildWritePolicy: null,
		}),
	);

	await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: homeNodeId,
		path: "renamed-home.md",
	});

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.name).toBe("renamed-home.md");
		expect(homeFileNode?.path).toBe("/renamed-home.md");
	});

	await test_move_nodes(t, asUser, {
		itemIds: [homeNodeId],
		targetParentId: db.files.file_root_1._id,
		membershipId: db.membershipId,
	});

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.name).toBe("renamed-home.md");
		expect(homeFileNode?.path).toBe(`/${db.files.file_root_1.name}/renamed-home.md`);
		expect(homeFileNode?.parentId).toBe(db.files.file_root_1._id);
	});
});

test("home file can be archived like any file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const homeNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			contentType: null,
			assetId: null,
			contentByteSize: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			isRestrictedScopeRoot: false,
			writePolicy: null,

			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "README.md",
			sortName: files_sort_text_key("README.md"),
			kind: "file",
			path: "/README.md",
			treePath: "/README.md",
			pathDepth: 1,
			lowercaseExtension: "md",
			archiveOperationId: null,
			newChildWritePolicy: null,
		}),
	);

	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [homeNodeId],
	});
	if (archived._nay) {
		throw new Error(archived._nay.message);
	}

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.archiveOperationId).toBeDefined();
	});
});

test("create_folder_node rejects duplicate active path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const duplicateCreation = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: db.files.file_root_1.name,
		membershipId: db.membershipId,
	});

	if (duplicateCreation._yay) {
		throw new Error("Expected duplicate creation to fail");
	}

	expect(duplicateCreation._nay.message).toBe("This folder already exists.");
});

test("create_folder_node rejects active file at leaf path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
			treePath: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes",
	});

	if (result._yay) {
		throw new Error("Expected folder creation to fail when a file already owns the path");
	}
	expect(result._nay.message).toBe("This folder already exists.");
});

test("create_folder_node rejects active file at intermediate path without creating descendants", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const fileNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
			treePath: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes/child",
	});

	if (result._yay) {
		throw new Error("Expected folder creation to fail when an intermediate path is a file");
	}
	expect(result._nay.message).toBe("This folder already exists.");

	await t.run(async (ctx) => {
		const existingFile = await ctx.db.get("files_nodes", fileNodeId);
		const child = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/notes/child")
					.eq("archiveOperationId", null),
			)
			.first();

		expect(existingFile?.kind).toBe("file");
		expect(child).toBeNull();
	});
});

test("create_folder_node reuses active intermediate folders", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: `${db.files.file_root_1.name}/new-child`,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to reuse the existing intermediate folder", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
		const rootFolders = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", files_ROOT_ID)
					.eq("name", db.files.file_root_1.name)
					.eq("archiveOperationId", null),
			)
			.collect()
			.then((fileNodes) => fileNodes.filter((fileNode) => fileNode.kind === "folder"));

		expect(folderFileNode).toMatchObject({
			name: "new-child",
			path: `/${db.files.file_root_1.name}/new-child`,
			parentId: db.files.file_root_1._id,
			kind: "folder",
		});
		expect(rootFolders).toHaveLength(1);
		expect(rootFolders[0]?._id).toBe(db.files.file_root_1._id);
	});
});

test("create_text_node preserves caller-provided file names", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "extensionless-create-file",
	});
	if (createdFile._nay) {
		throw new Error("Expected create_text_node to preserve caller-provided file name", {
			cause: createdFile._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(fileNode?.name).toBe("extensionless-create-file");
		expect(fileNode?.path).toBe("/extensionless-create-file");
	});
});

test("create_text_node stores Markdown file properties", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "properties.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		const asset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
		const assetKinds = (await ctx.db.query("files_r2_assets").collect()).map((doc) => doc.kind).sort();
		return { fileNode, asset, assetKinds };
	});
	expect(saved.fileNode).toMatchObject({
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		contentType: "text/markdown;charset=utf-8",
		assetId: saved.asset?._id,
	});
	// Editable files have no content asset row: the node points at its first version snapshot.
	expect(saved.asset).toMatchObject({
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		kind: "content_snapshot",
		r2Bucket: "test-files-bucket",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.assetKinds).toEqual(["content_snapshot", "yjs_snapshot"]);
	expect(saved.asset?.r2Key).toBe(
		`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.asset?._id}`,
	);
});

test("create_text_node seeds initial Yjs content on the server", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial Content User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "server-initial.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsLastSequenceId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected server-seeded Markdown node docs");
		}

		const [asset, lastSequence, yjsSnapshot, yjsUpdates, textChunks, plainTextChunks] = await Promise.all([
			ctx.db.get("files_r2_assets", fileNode.assetId),
			ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
			ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.order("asc")
				.collect(),
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.collect(),
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.collect(),
		]);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const stats = fileNode.statsId ? await ctx.db.get("file_stats", fileNode.statsId) : null;

		return {
			fileNode,
			asset,
			lastSequence,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			textChunks,
			plainTextChunks,
			stats,
		};
	});

	expect(saved.fileNode.contentType).toBe("text/markdown;charset=utf-8");
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.lastSequence?.lastSequence).toBe(0);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		kind: "yjs_snapshot",
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.textChunks.length).toBeGreaterThan(0);
	expect(saved.textChunks.every((chunk) => chunk.sourceKind === "committed" && chunk.yjsSequence === 0)).toBe(true);
	expect(saved.plainTextChunks.length).toBe(saved.textChunks.length);
	expect(saved.plainTextChunks.every((chunk) => chunk.sourceKind === "committed" && chunk.yjsSequence === 0)).toBe(
		true,
	);
	expect(saved.stats).toMatchObject({
		lineCount: 2,
		wordCount: 9,
		charCount: files_INITIAL_CONTENT.length,
	});
});

test("create_text_node writes server-seeded initial content to R2", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial Materialize User",
		email: "initial-materialize-user@example.com",
	});
	const r2Writes = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return {
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		};
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Writes.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Writes.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}

			return new Response(null, { status: 404 });
		}),
	);

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "server-initial-materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected materialized server-seeded file docs");
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshot = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId)
					.eq("archivedAt", -1),
			)
			.first();
		const versionSnapshotAsset = versionSnapshot?.assetId
			? await ctx.db.get("files_r2_assets", versionSnapshot.assetId)
			: null;

		return {
			asset,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			versionSnapshot,
			versionSnapshotAsset,
		};
	});

	// Editable files do not store their current content in R2: only the Yjs snapshot and the
	// version snapshot are uploaded, and the node points at the version snapshot.
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.asset?._id).toBe(saved.versionSnapshot?.assetId);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshot?.fileNodeId).toBe(createdFile._yay.nodeId);
	expect(saved.versionSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.versionSnapshotAsset?._id}`,
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	const versionSnapshotR2Key = saved.versionSnapshotAsset?.r2Key;
	const yjsSnapshotR2Key = saved.yjsSnapshotAsset?.r2Key;
	if (!versionSnapshotR2Key || !yjsSnapshotR2Key) {
		throw new Error("Expected version and Yjs snapshot R2 keys");
	}
	expect(r2Writes.get(versionSnapshotR2Key)).toBe(files_INITIAL_CONTENT);
	expect(r2Writes.has(yjsSnapshotR2Key)).toBe(true);
});

test("create_text_node does not publish a file node when initial R2 writes fail", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial R2 Failure User",
	});
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	let releaseSecondPut: (() => void) | undefined;
	const secondPutBlocked = new Promise<void>((resolve) => {
		releaseSecondPut = resolve;
	});
	let announceSecondPut: (() => void) | undefined;
	const secondPutStarted = new Promise<void>((resolve) => {
		announceSecondPut = resolve;
	});
	let putCount = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			putCount += 1;
			if (putCount === 1) {
				return new Response(null, { status: 500 });
			}
			announceSecondPut?.();
			await secondPutBlocked;
			return new Response(null, { status: 200 });
		}),
	);

	const creatingFile = asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "broken.md",
	});
	await secondPutStarted;
	// Give an early-rejecting Promise.all path time to start cleanup while its sibling PUT is
	// still blocked. The fixed path waits for both results, so both asset docs remain owned here.
	await delay(50);
	const preparedAssetIds = await t.run(async (ctx) =>
		(await ctx.db.query("files_r2_assets").collect()).map((asset) => asset._id),
	);
	expect(preparedAssetIds).toHaveLength(2);
	expect(await read_deletion_jobs(t)).toEqual([]);
	expect(deleteObjectSpy).not.toHaveBeenCalled();

	releaseSecondPut?.();
	const createdFile = await creatingFile;

	expect(createdFile._nay?.message).toBe("Failed to create file");
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/broken.md")
					.eq("archiveOperationId", null),
			)
			.first();
		const assets = await ctx.db.query("files_r2_assets").collect();

		return { assets, fileNode };
	});
	expect(saved.fileNode).toBeNull();
	expect(saved.assets).toHaveLength(0);
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	const jobs = await read_deletion_jobs(t);
	expect(jobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
	expect(jobs.map((job) => job.r2Key).sort()).toEqual(expected_ledger_keys(db, preparedAssetIds));
});

test("create_text_node cleans up R2 objects when initial metadata sync fails", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial R2 Sync Failure User",
	});
	const r2Writes = test_setup_r2_capture();
	vi.spyOn(R2.prototype, "syncMetadata").mockRejectedValueOnce(new Error("sync failed"));
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "sync-failure.md",
	});

	expect(createdFile._nay?.message).toBe("Failed to create file");
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/sync-failure.md")
					.eq("archiveOperationId", null),
			)
			.first();
		const assets = await ctx.db.query("files_r2_assets").collect();

		return { assets, fileNode };
	});
	expect(saved.fileNode).toBeNull();
	expect(saved.assets).toHaveLength(0);
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	const jobs = await read_deletion_jobs(t);
	expect(jobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
	expect(jobs.map((job) => job.r2Key).sort()).toEqual(Array.from(r2Writes.keys()).sort());
});

test("create_text_node refuses a duplicate path at capture, before any upload", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Duplicate R2 Cleanup User",
	});
	const r2Writes = test_setup_r2_capture();
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockImplementation(async (_ctx, key) => {
		r2Writes.delete(key);
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "duplicate.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const beforeDuplicate = await t.run(async (ctx) => {
		return {
			assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
			fileCount: (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("path", "/duplicate.md")
							.eq("archiveOperationId", null),
					)
					.collect()
			).length,
		};
	});
	const baselineKeys = Array.from(r2Writes.keys()).sort();

	const duplicate = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "duplicate.md",
	});

	expect(duplicate._nay?.message).toBe("This file already exists.");
	const afterDuplicate = await t.run(async (ctx) => {
		return {
			assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
			fileCount: (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("path", "/duplicate.md")
							.eq("archiveOperationId", null),
					)
					.collect()
			).length,
		};
	});

	expect(afterDuplicate).toEqual(beforeDuplicate);
	expect(Array.from(r2Writes.keys()).sort()).toEqual(baselineKeys);
	// The preflight sees the occupied target before any asset doc or R2 upload exists.
	// A separate test covers a target that appears after the uploads.
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	expect(await read_deletion_jobs(t)).toEqual([]);
});

test("create_folder_node creates missing folders for nested folder paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: "invalid/name",
		membershipId: db.membershipId,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to create the nested folder path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
		expect(folderFileNode?.name).toBe("name");
		expect(folderFileNode?.path).toBe("/invalid/name");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/invalid"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), null))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(folderFileNode?.parentId).toBe(parentFolder?._id);
	});
});

test("create_text_node creates missing folders for nested file paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes/workspaces/plan.md",
	});
	if (result._nay) {
		throw new Error("Expected create_text_node to create the nested file path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
		expect(fileNode?.name).toBe("plan.md");
		expect(fileNode?.path).toBe("/notes/workspaces/plan.md");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/notes/workspaces"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), null))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(fileNode?.parentId).toBe(parentFolder?._id);
	});
});

test("archived nodes can share path with a new active node", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const duplicateName = "archived-duplicate-allowed.md";

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: duplicateName,
	});
	if (createdFile._nay) {
		throw new Error("Expected initial file creation to succeed");
	}

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [createdFile._yay.nodeId],
	});

	const recreatedFile = await asUser.action(api.files_nodes_content.create_text_node, {
		parentId: files_ROOT_ID,
		path: duplicateName,
		membershipId: db.membershipId,
	});
	if (recreatedFile._nay) {
		throw new Error("Expected recreated file creation to succeed");
	}

	await t.run(async (ctx) => {
		const path = `/${duplicateName}`;
		const filesAtPath = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", path),
			)
			.collect();

		expect(filesAtPath).toHaveLength(2);
		expect(filesAtPath.filter((fileNode) => fileNode.archiveOperationId !== null)).toHaveLength(1);
		expect(filesAtPath.filter((fileNode) => fileNode.archiveOperationId === null)).toHaveLength(1);
	});
});

test("create_private_node_by_path can reuse an existing private file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const path = "/existing-by-path.md";

	const createdFile = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
		kind: "file",
	});
	if (createdFile._nay) {
		throw new Error("Expected initial file creation to succeed");
	}
	if (!createdFile._yay.created) {
		throw new Error("Expected initial file creation to create a node");
	}

	const reusedFile = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
		kind: "file",
	});
	if (reusedFile._nay) {
		throw new Error("Expected existing file reuse to succeed");
	}
	if (reusedFile._yay.created) {
		throw new Error("Expected existing file reuse not to create a node");
	}

	expect(createdFile._yay.target.kind).toBe("private");
	expect(reusedFile._yay.target).toEqual(createdFile._yay.target);
	expect(reusedFile._yay.created).toBe(false);
});

// #endregion move nodes
