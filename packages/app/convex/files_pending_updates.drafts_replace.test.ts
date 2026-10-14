// Draft content preparation and private replacement tests. More private draft tests are in
// files_pending_updates.drafts_private.test.ts, and the rest in files_pending_updates.drafts.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_finish_pending_update_run,
	test_apply_file_pending_move,
	test_convex,
	test_rename_node,
	test_finish_transfer_run,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
} from "./setup.test.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_pending_updates_action_prepare_content } from "./files_pending_updates.ts";
import { files_db_get_pending_update, files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import { files_YJS_DOC_KEYS } from "../shared/files.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import {
	create_private_text_for_test,
	expire_pending_update_for_test,
	finish_pending_job_review_holds_for_test,
	finish_single_save_review_holds_for_test,
	list_root_for_test,
	mock_pending_updates_storage,
	read_committed_text,
	read_file_markdown_from_yjs,
	read_pending_row_state_bytes,
	run_agent_move_for_test,
	save_pending_review_for_test,
	seed_chat_thread,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	set_pending_test_read_only,
	upsert_file_pending_update_internal_for_test,
} from "./files_pending_updates.setup.test.ts";

// Wrap the shared markdown serializer in a delegating mock so focused tests can make one call
// fail with the real producer's cause-carrying `_nay` shape. A crafted Y.Doc cannot force that
// failure: y-prosemirror drops elements it cannot convert instead of throwing.
const { filesYjsDocGetMarkdownMock } = vi.hoisted(() => {
	return {
		filesYjsDocGetMarkdownMock: vi.fn(),
	};
});

vi.mock("../shared/files-tiptap.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shared/files-tiptap.ts")>();
	filesYjsDocGetMarkdownMock.mockImplementation(actual.files_yjs_doc_get_text);
	return {
		...actual,
		files_yjs_doc_get_text: filesYjsDocGetMarkdownMock,
	};
});

beforeEach(mock_pending_updates_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("files_pending_updates_action_prepare_content", () => {
	test.each([true, false])(
		"prepares all private content without changing S, with collaboration %s",
		async (collaborative) => {
			vi.useFakeTimers();
			const draft = await create_private_text_for_test({
				staged: "selected line\n",
				unstaged: "all lines\n",
				collaborative,
			});
			const originalStates = await draft.t.run((ctx) =>
				read_pending_row_state_bytes({ ctx, pendingUpdate: draft.proposal }),
			);
			const prepared = await draft.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: draft.userId,
					membershipId: draft.membershipId,
					target: draft.target,
					pendingUpdateId: draft.pendingUpdateId,
					reviewedRevision: draft.proposal.revision,
					selectedContentStateId: draft.proposal.content!.unstagedStateId,
					reviewedPrivateParentIds: [],
				}),
			);
			if (prepared._nay) throw new Error(prepared._nay.message);
			expect(prepared._yay.kind).toBe("private");
			expect(JSON.stringify(prepared._yay).length).toBeLessThan(5000);
			expect(await draft.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId))).toEqual(
				draft.proposal,
			);
			expect(await draft.t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: draft.proposal }))).toEqual(
				originalStates,
			);
			expect(await draft.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
			await draft.t.mutation(internal.files_pending_updates.retire_prepared_content, { prepared: prepared._yay });
			const queued = await draft.asUser.mutation(api.files_pending_update_runs.start, {
				membershipId: draft.membershipId, requestId: crypto.randomUUID(), kind: "accept", expectedItemCount: 1,
				items: [{ pendingUpdateId: draft.pendingUpdateId, reviewedRevision: draft.proposal.revision, selectedContentStateId: draft.proposal.content!.unstagedStateId }],
			});
			if (queued._nay) throw new Error(queued._nay.message);
			expect(await draft.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: draft.membershipId, runId: queued._yay.runId })).toEqual({ _yay: null });
			await test_finish_pending_update_run(draft.asUser, queued._yay.runId);
			expect((await draft.t.run(ctx => ctx.db.get("activities", queued._yay.activityId)))?.status).toBe("succeeded");
			const receipt = await draft.t.run(ctx => ctx.db.query("files_pending_node_publish_receipts").withIndex("by_privateNode", q => q.eq("privateNodeId", draft.target.id)).unique());
			if (!receipt) throw new Error("Expected a saved private file");
			const nodeId = receipt.savedNodeId;
			expect(await draft.t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId }))).toBe("all lines\n");
			expect(await draft.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId))).toBeNull();
		},
	);

	test.each([true, false])(
		"prepares all saved content without request auth, with collaboration %s",
		async (collaborative) => {
			const t = test_convex();
			const seeded = collaborative
				? await t.run((ctx) =>
						seed_signed_in_file_with_markdown({
							ctx,
							path: "/all.txt",
							name: "all.txt",
							markdown: "base\n",
							rootKind: "plain_text",
						}),
					)
				: await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/all.txt", text: "base\n" }));
			const upserted = await upsert_file_pending_update_internal_for_test({
				t,
				...seeded,
				stagedMarkdown: "selected\n",
				unstagedMarkdown: "all\n",
			});
			if (upserted._nay) throw new Error(upserted._nay.message);
			const target = { kind: "saved" as const, id: seeded.nodeId };
			const pending = await t.run((ctx) => files_db_get_pending_update(ctx, { ...seeded, target }));
			if (!pending?.content) throw new Error("Expected pending content");
			const prepared = await t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: seeded.userId,
					membershipId: seeded.membershipId,
					target,
					pendingUpdateId: pending._id,
					reviewedRevision: pending.revision,
					selectedContentStateId: pending.content!.unstagedStateId,
					reviewedPrivateParentIds: [],
				}),
			);
			if (prepared._nay || prepared._yay.kind === "private") throw new Error("Expected prepared saved content");
			expect(prepared._yay.kind).toBe(collaborative ? "saved_yjs" : "saved_asset");
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
			const saved = await t.mutation(internal.files_pending_updates.commit_prepared_content, {
				userId: seeded.userId,
				prepared: prepared._yay,
			});
			if (saved._nay) throw new Error(saved._nay.message);
			expect(
				await t.run((ctx) =>
					collaborative
						? read_file_markdown_from_yjs({ ctx, ...seeded, rootKind: "plain_text" })
						: read_committed_text({ ctx, ...seeded }),
				),
			).toBe("all\n");
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
		},
	);

	test("keeps the payer chosen during preparation when organization billing changes", async () => {
		const t = test_convex();
		const seeded = await t.run(ctx => seed_non_collaborative_file({ ctx, path: "/payer.txt", text: "base\n" }));
		const edited = await upsert_file_pending_update_internal_for_test({ t, ...seeded, stagedMarkdown: "saved\n", unstagedMarkdown: "saved\n" });
		if (edited._nay) throw new Error(edited._nay.message);
		const target = { kind: "saved" as const, id: seeded.nodeId };
		const proposal = await t.run(ctx => files_db_get_pending_update(ctx, { ...seeded, target }));
		if (!proposal?.content) throw new Error("Expected pending saved content");
		const prepared = await t.action((ctx) =>
			files_pending_updates_action_prepare_content(ctx, {
				userId: seeded.userId,
				membershipId: seeded.membershipId,
				target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: proposal.content!.stagedStateId,
				reviewedPrivateParentIds: [],
			}),
		);
		if (prepared._nay || prepared._yay.kind === "private") throw new Error("Expected prepared saved content");
		expect(prepared._yay.billedUserId).toBe(seeded.userId);
		await t.run(async (ctx) => {
			const ownerUserId = await ctx.db.insert("users", { clerkUserId: "new_owner_without_credits" });
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				role: "admin",
				now: Date.now(),
			});
			await ctx.db.patch("organizations", seeded.organizationId, {
				default: false,
				billingMode: "organization_owner",
				ownerUserId,
			});
		});
		const saved = await t.mutation(internal.files_pending_updates.commit_prepared_content, {
			userId: seeded.userId,
			prepared: prepared._yay,
		});
		expect(saved._nay).toBeUndefined();
		expect(saved._yay?.target.kind).toBe("saved");
	});

	test.each([false, true])(
		"publishes a reviewed private parent and child atomically, stale child %s",
		async (staleChild) => {
			vi.useFakeTimers();
			const draft = await create_private_text_for_test({ path: "/parent/child.txt", staged: "saved\n" });
			const parent = await draft.t.run(async (ctx) => {
				const node = (await ctx.db.query("files_pending_nodes").collect()).find((node) => node.kind === "folder");
				if (!node) throw new Error("Expected a private parent");
				const proposal = await files_db_get_pending_update(ctx, {
					...draft,
					target: { kind: "private", id: node._id },
				});
				if (!proposal) throw new Error("Expected the parent proposal");
				return { node, proposal };
			});
			const refused = await draft.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: draft.userId,
					membershipId: draft.membershipId,
					target: draft.target,
					pendingUpdateId: draft.pendingUpdateId,
					reviewedRevision: draft.proposal.revision,
					selectedContentStateId: draft.proposal.content!.stagedStateId,
					reviewedPrivateParentIds: [],
				}),
			);
			expect(refused._nay?.message).toContain("parent");
			const queued = await draft.asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: draft.membershipId, target: draft.target,
				pendingUpdateId: draft.pendingUpdateId, reviewedRevision: draft.proposal.revision,
			});
			if (queued._nay || !("kind" in queued._yay)) throw new Error("Expected queued parent and child Save");
			const { runId, activityId } = queued._yay;
			if (staleChild)
				await draft.t.run((ctx) =>
					ctx.db.patch("files_pending_updates", draft.pendingUpdateId, { revision: draft.proposal.revision + 1 }),
				);
			await test_finish_pending_update_run(draft.asUser, runId);
			const activity = await draft.t.run(ctx => ctx.db.get("activities", activityId));
			if (staleChild) {
				expect(activity?.status).not.toBe("succeeded");
				expect(await draft.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
				expect(await draft.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
				expect(await draft.t.run((ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toEqual(parent.node);
			} else {
				expect(activity?.status).toBe("succeeded");
				expect(
					(await draft.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort(),
				).toEqual(["/parent", "/parent/child.txt"]);
				expect(await draft.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
			}
		},
	);
});

describe("private pending text", () => {
	test.each(["save", "discard", "rm"] as const)("keeps a moved private file private until %s", async (outcome) => {
		const draft = await create_private_text_for_test({ staged: "source content\n" });
		const { t, asUser, membershipId, target, pendingUpdateId } = draft;
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
		const states = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: draft.proposal }));
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target,
			destParent: { kind: "root" },
			destName: "moved.txt",
			threadId,
		});
		expect(moved).toMatchObject({
			_yay: { fromPath: "/draft.txt", destPath: "/moved.txt", appliedImmediately: true },
		});
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!proposal) throw new Error("Expected the moved private proposal");
		expect(proposal).toMatchObject({ target, threadIds: [threadId], revision: draft.proposal.revision + 1 });
		expect(proposal.pendingMove).toBeUndefined();
		expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: proposal }))).toEqual(states);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		const reviewed = { membershipId, target, pendingUpdateId, reviewedRevision: proposal.revision };
		if (outcome === "save") {
			const saved = await test_save_file_pending_update(asUser, reviewed);
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the moved file to save");
			const nodeId = saved._yay.target.id;
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({ path: "/moved.txt" });
			expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId }))).toBe("source content\n");
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toBeNull();
		} else {
			if (outcome === "discard") {
				expect(
					(await asUser.mutation(api.files_pending_updates.discard_file_pending_update, reviewed))._nay,
				).toBeUndefined();
			} else {
				expect(
					await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
						organizationId: draft.organizationId,
						workspaceId: draft.workspaceId,
						userId: draft.userId,
						target,
						threadId,
					}),
				).toMatchObject({ _yay: { outcome: "cancelled_added_file", fromPath: "/moved.txt" } });
			}
			expect(
				await asUser.query(api.files_pending_target.get_file_pending_target, { membershipId, target }),
			).toBeNull();
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toMatchObject([
				{ _id: target.id, state: "discarded" },
			]);
		}
	});

	test.each(
		(
			[
				{ sourceKind: "saved", destinationKind: "saved" },
				{ sourceKind: "private", destinationKind: "saved" },
				{ sourceKind: "saved", destinationKind: "private" },
				{ sourceKind: "private", destinationKind: "private" },
			] as const
		).flatMap((pair) => (["single", "review"] as const).map((saveMode) => ({ ...pair, saveMode }))),
	)(
		"agent transfer replaces a $destinationKind destination from a $sourceKind source with $saveMode Save",
		async ({ sourceKind, destinationKind, saveMode }) => {
			const draft = await create_private_text_for_test({ path: "/destination.txt", staged: "destination\n" });
			const { t, asUser, membershipId } = draft;
			const scope = {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId: draft.userId,
			};
			if (destinationKind === "saved") {
				const saved = await test_save_file_pending_update(asUser, {
					membershipId,
					target: draft.target,
					pendingUpdateId: draft.pendingUpdateId,
					reviewedRevision: draft.proposal.revision,
				});
				if (saved._nay) throw new Error(saved._nay.message);
			}
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path: "/source.txt",
				kind: "file",
			});
			if (created._nay || !created._yay.operationBatchId || !created._yay.pendingUpdateId)
				throw new Error("Expected a new private source");
			const { operationBatchId, pendingUpdateId } = created._yay;
			let sourceTarget: Doc<"files_pending_updates">["target"] = created._yay.target;
			for (const role of ["staged", "unstaged"] as const) {
				const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId,
					role,
					text: "source\n",
				});
				if (staged._nay) throw new Error(staged._nay.message);
			}
			const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target: sourceTarget,
				operationBatchId,
				pendingUpdateId,
			});
			if (ready._nay) throw new Error(ready._nay.message);
			if (sourceKind === "saved") {
				const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
				if (!proposal) throw new Error("Expected the source proposal");
				const saved = await test_save_file_pending_update(asUser, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				});
				if (saved._nay) throw new Error(saved._nay.message);
				sourceTarget = saved._yay.target;
			}
			const savedBefore = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...scope }));
			const started = await t.mutation(internal.files_transfer.start_for_agent, {
				membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId,
				requestId: "private-replacement",
				kind: "move",
				sources: [sourceTarget],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: "destination.txt",
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			expect(await t.mutation(internal.files_transfer.seal_for_agent, { membershipId, threadId, runId })).toEqual({
				_yay: null,
			});
			await test_finish_transfer_run(asUser, runId);
			const finished = await asUser.query(api.files_transfer_queries.get, { membershipId, runId });
			expect(finished?.activity, finished?.activity.errorMessage ?? "Expected a completed move").toMatchObject({
				status: "succeeded",
				progress: { completed: 1, failed: 0 },
			});
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
			expect(
				await asUser.query(api.files_pending_target.get_file_pending_target, { membershipId, target: sourceTarget }),
			).toMatchObject({ entry: { path: "/destination.txt" } });
			const visible = await list_root_for_test(t, { membershipId });
			expect(visible._yay?.items.map(({ target, path }) => ({ target, path }))).toEqual([
				{ target: sourceTarget, path: "/destination.txt" },
			]);
			const proposal = await t.run((ctx) => files_db_get_pending_update(ctx, { ...scope, target: sourceTarget }));
			if (!proposal) throw new Error("Expected the moved proposal");
			const read = await t.query(internal.files_nodes.read_file_content_from_chunks, {
				...scope,
				overlayUserId: scope.userId,
				path: "/destination.txt",
				mode: { kind: "full", maxBytes: 1000 },
			});
			expect(read?.content).toBe("source\n");
			let nodeId: Id<"files_nodes">;
			if (saveMode === "review") {
				const saved = await save_pending_review_for_test(draft, [proposal]);
				expect(saved?.activity, saved?.activity.errorMessage ?? "Expected Save to finish").toMatchObject({
					status: "succeeded",
					progress: { completed: 1 },
				});
				const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
				const source = nodes.find((node) => node.archiveOperationId === null && node.path === "/destination.txt");
				if (!source) throw new Error("Expected the saved source");
				nodeId = source._id;
			} else if (sourceTarget.kind === "saved") {
				const saved = await test_apply_file_pending_move(asUser, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				expect(saved._nay).toBeUndefined();
				nodeId = sourceTarget.id;
			} else {
				const saved = await test_save_file_pending_update(asUser, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				expect(saved._nay).toBeUndefined();
				if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the moved file to save");
				nodeId = saved._yay.target.id;
			}
			expect(await t.run((ctx) => read_committed_text({ ctx, ...scope, nodeId }))).toBe("source\n");
			const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(
				nodes.filter((node) => node.archiveOperationId === null).map((node) => ({ id: node._id, path: node.path })),
			).toEqual([{ id: nodeId, path: "/destination.txt" }]);
			if (destinationKind === "saved") expect(nodes.filter((node) => node.archiveOperationId !== null)).toHaveLength(1);
		},
	);

	test.each(["discard", "expiry", "move away"] as const)(
		"keeps the saved occupant after private replacement %s",
		async (outcome) => {
			const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
			const { t, asUser, membershipId } = draft;
			const occupantId = await test_create_saved_text_file(t, {
				membershipId,
				path: "/destination.txt",
				textContent: "destination\n",
			});
			const savedBefore = await t.run((ctx) => ctx.db.get("files_nodes", occupantId));
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
			expect(
				(await run_agent_move_for_test(draft, { target: draft.target, destName: "destination.txt", threadId })).activity
					.status,
			).toBe("succeeded");
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
			if (!proposal) throw new Error("Expected the replacement proposal");
			expect(proposal.pendingMove?.replacesTarget).toEqual({ kind: "saved", id: occupantId });
			if (outcome === "move away") {
				expect(
					(await run_agent_move_for_test(draft, { target: draft.target, destName: "away.txt", threadId })).activity
						.status,
				).toBe("succeeded");
				const moved = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
				if (!moved) throw new Error("Expected the moved draft");
				expect(moved.pendingMove).toBeUndefined();
				const saved = await test_save_file_pending_update(asUser, {
					membershipId,
					target: draft.target,
					pendingUpdateId: moved._id,
					reviewedRevision: moved.revision,
				});
				expect(saved._nay).toBeUndefined();
			} else if (outcome === "discard") {
				expect(
					(
						await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
							membershipId,
							target: draft.target,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			} else {
				vi.useFakeTimers();
				try {
					await expire_pending_update_for_test(t, proposal._id);
				} finally {
					vi.useRealTimers();
				}
			}
			expect(await t.run((ctx) => ctx.db.get("files_nodes", occupantId))).toEqual(savedBefore);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId: occupantId }))).toBe("destination\n");
			const visible = await list_root_for_test(t, { membershipId });
			expect(
				visible._yay?.items.find((item) => item.path === "/destination.txt")?.target,
				"The saved occupant is visible after the private replacement ends",
			).toEqual({
				kind: "saved",
				id: occupantId,
			});
			if (outcome !== "move away") {
				expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", draft.target.id))).toMatchObject({
					state: "discarded",
				});
				expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([savedBefore]);
			}
		},
	);

	test.each(
		(["version", "new occupant", "read-only", "access"] as const).flatMap((change) =>
			(["single", "review"] as const).map((saveMode) => ({ change, saveMode })),
		),
	)("refuses private replacement after saved $change changes with $saveMode Save", async ({ change, saveMode }) => {
		const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
		const { t, asUser, membershipId } = draft;
		const occupantId = await test_create_saved_text_file(t, {
			membershipId,
			path: "/destination.txt",
			textContent: "destination\n",
		});
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
		const moved = await run_agent_move_for_test(draft, { target: draft.target, destName: "destination.txt", threadId });
		expect(moved.activity.status).toBe("succeeded");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
		if (!proposal) throw new Error("Expected the replacement proposal");
		let expiresAt = Math.max(
			proposal.expiresAt,
			await finish_pending_job_review_holds_for_test(t, { kind: "files_transfer_run", id: moved._id }),
		);
		if (change === "version") {
			const doc = new YDoc();
			doc.getText(files_YJS_DOC_KEYS.plainText).insert(0, "saved edit\n");
			const pointers = await test_get_file_yjs_pointers(t, occupantId);
			const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId,
				nodeId: occupantId,
				expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(doc)),
				sessionId: "replacement-change",
			});
			doc.destroy();
			expect(pushed._nay).toBeUndefined();
		} else if (change === "new occupant") {
			expect(
				(await test_rename_node(t, asUser, { membershipId, nodeId: occupantId, path: "old.txt" }))
					._nay,
			).toBeUndefined();
			const created = await asUser.action(api.files_nodes_content.create_text_node, {
				membershipId,
				parentId: files_ROOT_ID,
				path: "destination.txt",
			});
			expect(created._nay).toBeUndefined();
		} else if (change === "read-only") {
			await set_pending_test_read_only({ asUser, membershipId, nodeId: occupantId });
		} else {
			await t.run(async (ctx) => {
				const ownerId = await ctx.db.insert("users", { clerkUserId: "replacement-new-owner" });
				await ctx.db.patch("organizations", draft.organizationId, { ownerUserId: ownerId });
				await access_control_db_ensure_role_assignment(ctx, { ...draft, role: "member", now: Date.now() });
				await ctx.db.patch("files_nodes", occupantId, { restrictedScopeNodeId: occupantId });
			});
		}
		const savedBefore = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const receiptsBefore = await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		const savedText = await t.run((ctx) =>
			read_file_markdown_from_yjs({ ctx, ...draft, nodeId: occupantId, rootKind: "plain_text" }),
		);
		if (change === "version") expect(savedText).toContain("saved edit\n");
		if (saveMode === "single") {
			const saved = await test_save_file_pending_update(asUser, {
				membershipId,
				target: draft.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			expect(saved._nay).toBeDefined();
			expiresAt = Math.max(expiresAt, await finish_single_save_review_holds_for_test(draft, proposal));
		} else {
			const saved = await save_pending_review_for_test(draft, [proposal]);
			expect(saved?.activity.status).not.toBe("succeeded");
			if (!saved) throw new Error("Expected the refused review job");
			expiresAt = Math.max(
				expiresAt,
				await finish_pending_job_review_holds_for_test(t, { kind: "files_pending_update_run", id: saved.run._id }),
			);
		}
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual(receiptsBefore);
		expect(
			await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...draft, nodeId: occupantId, rootKind: "plain_text" })),
		).toBe(savedText);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual({ ...proposal, expiresAt });
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", draft.target.id))).toMatchObject({
			state: "active",
			name: "destination.txt",
		});
	});
});
