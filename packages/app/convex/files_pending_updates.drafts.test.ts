// Draft text, Copy replies, upsert, provenance and expiry tests. Save, review, Move, archive and
// read-only tests are in files_pending_updates.test.ts.
import { RateLimiter } from "@convex-dev/rate-limiter";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_finish_pending_update_run,
	test_apply_file_pending_move,
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_rename_node,
	test_finish_transfer_run,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { files_media_dependencies_db_create, files_media_dependencies_db_seal } from "./files_media_dependencies.ts";
import {
	files_pending_updates_db_drop_content_for_node,
	files_pending_updates_action_prepare_content,
} from "./files_pending_updates.ts";
import {
	files_db_get_pending_update,
	files_db_patch_pending_update,
	files_db_insert_pending_update,
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_PENDING_UPDATE_STALE_BASE_MESSAGE,
	files_YJS_DOC_KEYS,
} from "../shared/files.ts";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
} from "../shared/files-metadata.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import {
	create_private_text_for_test,
	expect_consumed_pending_content_cleanup_for_test,
	expire_pending_update_for_test,
	file_save_events,
	finish_pending_job_review_holds_for_test,
	finish_single_save_review_holds_for_test,
	list_pending_update_plain_text_chunks,
	list_pending_update_text_chunks,
	list_root_for_test,
	mock_pending_updates_storage,
	normalize_pending_update_markdown,
	presenceHeartbeatIntervalMs,
	r2Objects,
	read_committed_text,
	read_file_markdown_from_yjs,
	read_pending_review_state_for_test,
	read_pending_row_markdown_state,
	read_pending_row_state_bytes,
	read_pending_update_expiry_check,
	read_pending_update_row,
	read_seeded_pending_row,
	reviewed_pending_for_test,
	run_agent_move_for_test,
	save_as_member,
	save_pending_review_for_test,
	seal_output_family_for_test,
	seed_chat_thread,
	seed_file_with_markdown,
	seed_folder_node,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	set_pending_test_read_only,
	upsert_file_pending_archive_for_test,
	upsert_file_pending_move_for_test,
	upsert_file_pending_update_internal_for_test,
	upsert_file_pending_update_public_for_test,
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
				await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
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
			const finished = await asUser.query(api.files_transfer.get, { membershipId, runId });
			expect(finished?.activity, finished?.activity.errorMessage ?? "Expected a completed move").toMatchObject({
				status: "succeeded",
				progress: { completed: 1, failed: 0 },
			});
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
			expect(
				await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target: sourceTarget }),
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

	test("requires the saved occupant's other-chat proposal in the private replacement review", async () => {
		const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
		const { t, asUser, membershipId } = draft;
		const occupantId = await test_create_saved_text_file(t, {
			membershipId,
			path: "/destination.txt",
			textContent: "destination\n",
		});
		const [sourceThread, occupantThread] = await t.run((ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...draft }), seed_chat_thread({ ctx, ...draft })]),
		);
		expect(
			(
				await upsert_file_pending_update_internal_for_test({
					...draft,
					nodeId: occupantId,
					unstagedMarkdown: "other chat\n",
					threadId: occupantThread,
				})
			)._nay,
		).toBeUndefined();
		const occupantProposal = await t.run((ctx) =>
			files_db_get_pending_update(ctx, { ...draft, target: { kind: "saved", id: occupantId } }),
		);
		if (!occupantProposal?.content) throw new Error("Expected the occupant's content proposal");
		const originalOccupantContent = occupantProposal.content;
		expect(
			(
				await run_agent_move_for_test(draft, {
					target: draft.target,
					destName: "destination.txt",
					threadId: sourceThread,
				})
			).activity.status,
		).toBe("succeeded");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
		if (!proposal) throw new Error("Expected the replacement proposal");
		expect(proposal.threadIds).toEqual(expect.arrayContaining([sourceThread, occupantThread]));
		expect(proposal.threadIds).toHaveLength(2);
		const savedBefore = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(
			(
				await test_save_file_pending_update(asUser, {
					membershipId,
					target: draft.target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay?.name,
		).toBe("needs_review");
		const incomplete = await save_pending_review_for_test(draft, [proposal]);
		// The blocked unit holds `needs_review`; the Activity only says that changes still need review.
		expect(incomplete?.activity).toMatchObject({ status: "failed", errorMessage: "Some changes still need review." });
		expect(incomplete?.run.needsReviewIds).toEqual([occupantProposal._id]);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", occupantProposal._id))).toEqual(occupantProposal);
		await test_drain_billing_usage_event_outbox(t);
		const savesBefore = file_save_events().length;
		const saved = await save_pending_review_for_test(draft, [proposal, occupantProposal]);
		expect(saved?.activity, "The reviewed replacement publishes the source and removes the selected occupant").toMatchObject({
			status: "succeeded",
			progress: { completed: 2 },
		});
		expect(saved?.run.unitCount, "The replacement and its selected occupant publish together").toBe(1);
		if (!saved) throw new Error("Expected the completed replacement review");
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const output = nodes.find((node) => node.archiveOperationId === null && node.path === "/destination.txt");
		if (!output) throw new Error("Expected the published private source");
		expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId: output._id }))).toBe("source\n");
		expect(nodes.find((node) => node._id === occupantId)?.archiveOperationId).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", occupantProposal._id))).toBeNull();
		expect(
			await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId: occupantId })),
			"Replacement does not save the occupant's draft text",
		).toBe("destination\n");
		const occupantContent = await t.run(async (ctx) => {
			const unit = await ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", saved.run._id))
				.unique();
			if (!unit?.cohortId) throw new Error("Expected the replacement cohort");
			const cohortId = unit.cohortId;
			return await ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohortId).eq("nodeId", occupantId))
				.unique();
		});
		expect(occupantContent, "Replacement does not prepare the occupant's draft text for Save").toBeNull();
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events(), "Only the published source has a Save charge").toHaveLength(savesBefore + 1);
		expect(file_save_events().at(-1)?.[2]).toMatchObject({
			events: [{ name: "file_save", metadata: { nodeId: output._id } }],
		});
		await expect_consumed_pending_content_cleanup_for_test(
			t,
			originalOccupantContent,
			"The selected replacement retires the occupant's original draft states",
		);
	});

	test("keeps same-name root Move claims inside their workspace", async () => {
		vi.useFakeTimers();
		const source = await create_private_text_for_test({ path: "/source.txt", staged: "first workspace\n" });
		const { t, asUser } = source;
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: source.membershipId,
			target: source.target,
			pendingUpdateId: source.pendingUpdateId,
			reviewedRevision: source.proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		const workspace = await asUser.mutation(api.organizations.create_workspace, {
			organizationId: source.organizationId,
			name: "other-claims",
			description: "",
		});
		if (workspace._nay) throw new Error(workspace._nay.message);
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", workspace._yay.workspaceId).eq("userId", source.userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected the other workspace membership");
		const otherId = await test_create_saved_text_file(t, {
			membershipId: membership._id,
			path: "/destination.txt",
			textContent: "second workspace\n",
		});
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...source }));
		expect(
			(await run_agent_move_for_test(source, { target: saved._yay.target, destName: "destination.txt", threadId }))
				.activity.status,
		).toBe("succeeded");
		const visible = await list_root_for_test(t, { membershipId: membership._id });
		expect(visible._yay?.items.map(({ target, path }) => ({ target, path }))).toEqual([
			{ target: { kind: "saved", id: otherId }, path: "/destination.txt" },
		]);
		const read = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: source.userId,
			overlayUserId: source.userId,
			path: "/destination.txt",
			mode: { kind: "full", maxBytes: 1000 },
		});
		expect(read?.content).toBe("second workspace\n");
	});

	test.each(
		(["private", "saved"] as const).flatMap((sourceKind) =>
			(["single", "review"] as const).map((saveMode) => ({ sourceKind, saveMode })),
		),
	)(
		"keeps the saved replacement claim and all contributors through a private chain from a $sourceKind source with $saveMode Save",
		async ({ sourceKind, saveMode }) => {
			const occupant = await create_private_text_for_test({ path: "/middle.txt", staged: "middle\n" });
			const { t, asUser, membershipId } = occupant;
			const savedId = await test_create_saved_text_file(t, {
				membershipId,
				path: "/destination.txt",
				textContent: "saved\n",
			});
			const [firstThread, secondThread] = await t.run((ctx) =>
				Promise.all([seed_chat_thread({ ctx, ...occupant }), seed_chat_thread({ ctx, ...occupant })]),
			);
			const source = await create_private_text_for_test(
				{ path: "/source.json", staged: '{"source":true}\n', threadId: secondThread },
				{ t, membershipId },
			);
			const sourceStates = source.proposal.content;
			const sourceCreate = source.proposal.createIntent;
			let sourceTarget: Doc<"files_pending_updates">["target"] = source.target;
			if (sourceKind === "saved") {
				const saved = await test_save_file_pending_update(asUser, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: source.pendingUpdateId,
					reviewedRevision: source.proposal.revision,
				});
				if (saved._nay) throw new Error(saved._nay.message);
				sourceTarget = saved._yay.target;
			}
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const movedOccupant = await run_agent_move_for_test(occupant, {
				target: occupant.target,
				destName: "destination.txt",
				threadId: firstThread,
			});
			expect(movedOccupant.activity.status).toBe("succeeded");
			const occupantProposal = await t.run((ctx) => ctx.db.get("files_pending_updates", occupant.pendingUpdateId));
			if (!occupantProposal) throw new Error("Expected the occupant's replacement proposal");
			const expiresAt = Math.max(
				occupantProposal.expiresAt,
				await finish_pending_job_review_holds_for_test(t, { kind: "files_transfer_run", id: movedOccupant._id }),
			);
			expect(
				(
					await run_agent_move_for_test(source, {
						target: sourceTarget,
						destName: "destination.txt",
						threadId: secondThread,
					})
				).activity.status,
			).toBe("succeeded");
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", occupant.target.id))).toMatchObject({
				state: "discarded",
			});
			const proposal = await t.run((ctx) => files_db_get_pending_update(ctx, { ...source, target: sourceTarget }));
			if (!proposal) throw new Error("Expected the surviving source proposal");
			if (sourceTarget.kind === "private")
				expect(proposal).toMatchObject({ content: sourceStates, createIntent: sourceCreate });
			expect(proposal).toMatchObject({
				pendingMove: {
					replacesTarget: { kind: "saved", id: savedId },
					replacesContentVersion: occupantProposal?.pendingMove?.replacesContentVersion,
				},
			});
			expect(proposal.threadIds).toEqual(expect.arrayContaining([firstThread, secondThread]));
			expect(proposal.threadIds).toHaveLength(2);
			// The discarded occupant's proposal stays until cleanup. It must not mask the surviving source.
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", occupant.pendingUpdateId))).toEqual(
				{ ...occupantProposal, expiresAt },
			);
			const visible = await list_root_for_test(t, { membershipId });
			expect(visible._yay?.items.map(({ target, path }) => ({ target, path }))).toEqual([
				{ target: sourceTarget, path: "/destination.txt" },
			]);
			const read = await t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: source.userId,
				overlayUserId: source.userId,
				path: "/destination.txt",
				mode: { kind: "full", maxBytes: 1000 },
			});
			expect(read?.content).toBe('{"source":true}\n');
			if (saveMode === "single" && sourceTarget.kind === "saved") {
				const saved = await test_apply_file_pending_move(asUser, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				expect(saved._nay).toBeUndefined();
			} else if (saveMode === "single") {
				expect(
					(
						await test_save_file_pending_update(asUser, {
							membershipId,
							target: sourceTarget,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			} else {
				expect((await save_pending_review_for_test(source, [proposal]))?.activity.status).toBe("succeeded");
			}
			const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const output = nodes.find((node) => node.archiveOperationId === null);
			if (!output || sourceCreate?.kind !== "text") throw new Error("Expected the saved source text");
			if (sourceTarget.kind === "saved") expect(output._id).toBe(sourceTarget.id);
			expect(output).toMatchObject({
				path: "/destination.txt",
				contentType: sourceCreate.contentType,
				textKind: "plain_text",
			});
			expect(await t.run((ctx) => read_committed_text({ ctx, ...source, nodeId: output._id }))).toBe(
				'{"source":true}\n',
			);
			expect(nodes.find((node) => node._id === savedId)?.archiveOperationId).not.toBeNull();
			expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", source.target.id))).toMatchObject({
				state: "published",
			});
		},
	);

	test.each(["preparing", "no replace", "folder"] as const)(
		"does not retire a private Move occupant on %s refusal",
		async (reason) => {
			const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
			const { t, membershipId } = draft;
			const occupant =
				reason === "folder"
					? await t.mutation(internal.files_nodes.create_private_node_by_path, {
							organizationId: draft.organizationId,
							workspaceId: draft.workspaceId,
							userId: draft.userId,
							path: "/destination.txt",
							kind: "folder",
						})
					: null;
			if (occupant?._nay) throw new Error(occupant._nay.message);
			if (reason !== "folder")
				await create_private_text_for_test(
					{ path: "/destination.txt", staged: "destination\n", preparing: reason === "preparing" },
					{ t, membershipId },
				);
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
			const before = await read_pending_review_state_for_test(t);
			const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			const moved = await run_agent_move_for_test(draft, {
				target: draft.target,
				destName: "destination.txt",
				threadId,
				replace: reason !== "no replace",
			});
			expect(moved.activity.status).not.toBe("succeeded");
			expect(await read_pending_review_state_for_test(t)).toEqual(before);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual(nodes);
		},
	);

	test.each(
		(
			[
				{ sourceKind: "private", destinationKind: "saved" },
				{ sourceKind: "private", destinationKind: "private" },
				{ sourceKind: "saved", destinationKind: "private" },
			] as const
		).flatMap((pair) =>
			(["empty", "private child", "pending move"] as const).flatMap((contents) =>
				(contents === "empty" ? (["single", "review"] as const) : (["review"] as const)).map((saveMode) => ({
					...pair,
					contents,
					saveMode,
				})),
			),
		),
	)(
		"Move replaces a $destinationKind folder from a $sourceKind folder only when empty: $contents with $saveMode Save",
		async ({ sourceKind, destinationKind, contents, saveMode }) => {
			vi.useFakeTimers();
			const t = test_convex({ transactionLimits: {} });
			const scope = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "folder-move-owner" });
				return await test_mocks_fill_db_with.membership(ctx, { userId });
			});
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
			const fixture = { t, asUser, ...scope };
			const targets: Doc<"files_pending_updates">["target"][] = [];
			for (const [path, kind] of [
				["/source", sourceKind],
				["/destination", destinationKind],
			] as const) {
				const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: scope.userId,
					path,
					kind: "folder",
				});
				if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder");
				let target = created._yay.target;
				if (kind === "saved") {
					const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
					const saved = await test_save_file_pending_update(asUser, {
						membershipId: scope.membershipId,
						target,
						pendingUpdateId: proposal!._id,
						reviewedRevision: proposal!.revision,
					});
					if (saved._nay) throw new Error(saved._nay.message);
					target = saved._yay.target;
				}
				targets.push(target);
			}
			const [source, destination] = targets as [
				Doc<"files_pending_updates">["target"],
				Doc<"files_pending_updates">["target"],
			];
			if (contents === "private child") {
				const child = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: scope.userId,
					path: "/destination/child",
					kind: "folder",
				});
				expect(child._nay).toBeUndefined();
			} else if (contents === "pending move") {
				const childId = await test_create_saved_text_file(t, {
					membershipId: scope.membershipId,
					path: "/child.txt",
					textContent: "child\n",
				});
				const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: scope.userId,
					target: { kind: "saved", id: childId },
					destParent: destination,
					destName: "child.txt",
				});
				expect(moved._nay).toBeUndefined();
			}
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...scope }));
			const before = await read_pending_review_state_for_test(t);
			const privateBefore = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			const moved = await run_agent_move_for_test(fixture, { target: source, destName: "destination", threadId });
			if (contents !== "empty") {
				expect(moved.activity.status).not.toBe("succeeded");
				expect(await read_pending_review_state_for_test(t)).toEqual(before);
				expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual(privateBefore);
				return;
			}
			expect(moved.activity, moved.activity.errorMessage ?? "Expected folder Move").toMatchObject({
				status: "succeeded",
			});
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before.nodes);
			const proposal = await t.run((ctx) => files_db_get_pending_update(ctx, { ...scope, target: source }));
			if (!proposal) throw new Error("Expected the moved folder proposal");
			if (saveMode === "review") {
				const saved = await save_pending_review_for_test(fixture, [proposal]);
				expect(saved?.activity, saved?.activity.errorMessage ?? "Expected folder Save").toMatchObject({
					status: "succeeded",
				});
			} else if (source.kind === "private") {
				expect(
					(
						await test_save_file_pending_update(asUser, {
							membershipId: scope.membershipId,
							target: source,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			} else {
				expect(
					(
						await test_apply_file_pending_move(asUser, {
							membershipId: scope.membershipId,
							target: source,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			}
			const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(nodes.filter((node) => node.archiveOperationId === null)).toMatchObject([
				{ name: "destination", kind: "folder" },
			]);
			if (destination.kind === "saved")
				expect(nodes.find((node) => node._id === destination.id)?.archiveOperationId).not.toBeNull();
		},
	);

	test.each(["single", "review"] as const)(
		"keeps a late saved child when a private folder replacement uses %s Save",
		async (saveMode) => {
			const draft = await create_private_text_for_test({ path: "/unrelated.txt", staged: "unrelated\n" });
			const { t, asUser, membershipId } = draft;
			const source = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId: draft.userId,
				path: "/source",
				kind: "folder",
			});
			if (source._nay || !source._yay.pendingUpdateId) throw new Error("Expected a private source folder");
			const sourceTarget = source._yay.target;
			const destination = await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId,
				parentId: files_ROOT_ID,
				path: "destination",
			});
			if (destination._nay) throw new Error(destination._nay.message);
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
			const moved = await run_agent_move_for_test(draft, { target: sourceTarget, destName: "destination", threadId });
			expect(moved.activity.status).toBe("succeeded");
			const child = await asUser.action(api.files_nodes_content.create_text_node, {
				membershipId,
				parentId: destination._yay.nodeId,
				path: "late.md",
			});
			expect(child._nay).toBeUndefined();
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", source._yay.pendingUpdateId!));
			if (!proposal) throw new Error("Expected the replacement proposal");
			let expiresAt = Math.max(
				proposal.expiresAt,
				await finish_pending_job_review_holds_for_test(t, { kind: "files_transfer_run", id: moved._id }),
			);
			if (saveMode === "single") {
				expect(
					(
						await test_save_file_pending_update(asUser, {
							membershipId,
							target: sourceTarget,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay?.message,
				).toBe("Cannot replace a non-empty folder.");
				expiresAt = Math.max(expiresAt, await finish_single_save_review_holds_for_test(draft, proposal));
			} else {
				const saved = await save_pending_review_for_test(draft, [proposal]);
				expect(saved?.activity.status).toBe("failed");
				if (!saved) throw new Error("Expected the refused review job");
				expiresAt = Math.max(
					expiresAt,
					await finish_pending_job_review_holds_for_test(t, { kind: "files_pending_update_run", id: saved.run._id }),
				);
			}
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual({ ...proposal, expiresAt });
		},
	);

	test("partial Save replaces the saved occupant once and keeps the source's remaining content", async () => {
		const draft = await create_private_text_for_test({
			path: "/source.txt",
			staged: "accepted\n",
			unstaged: "remaining\n",
		});
		const { t, asUser, membershipId } = draft;
		const occupantId = await test_create_saved_text_file(t, {
			membershipId,
			path: "/destination.txt",
			textContent: "destination\n",
		});
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
		expect(
			(await run_agent_move_for_test(draft, { target: draft.target, destName: "destination.txt", threadId })).activity
				.status,
		).toBe("succeeded");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
		if (!proposal) throw new Error("Expected the replacement proposal");
		const saved = await test_save_file_pending_update(asUser, {
			membershipId,
			target: draft.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved private source");
		const target = saved._yay.target;
		const remaining = await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id));
		expect(remaining).toMatchObject({ target, content: { base: { kind: "yjs", sequence: 0 } }, threadIds: [threadId] });
		expect(remaining?.pendingMove).toBeUndefined();
		expect(remaining?.createIntent).toBeUndefined();
		expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId: target.id }))).toBe("accepted\n");
		const oldOccupant = await t.run((ctx) => ctx.db.get("files_nodes", occupantId));
		expect(oldOccupant?.archiveOperationId).not.toBeNull();
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId,
					target,
					pendingUpdateId: proposal._id,
					reviewedRevision: remaining!.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", occupantId))).toEqual(oldOccupant);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", target.id))).toMatchObject({
			archiveOperationId: null,
			path: "/destination.txt",
		});
	});

	test.each(["/metadata.txt", "/metadata.md"])("indexes captured metadata separately from text in %s", async (path) => {
		const draft = await create_private_text_for_test({
			path,
			unstaged: "---\nstatus: proposed\n---\nBody\n",
			metadata: [{ key: "status", value: "captured" }],
		});
		const docs = await draft.t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
		const values = docs.filter((doc) => doc.docKind === "value");
		expect(values.map((doc) => ({ fieldPath: doc.fieldPath, stringValue: doc.stringValue }))).toEqual(
			path.endsWith(".md")
				? [
						{ fieldPath: "metadata.status", stringValue: "captured" },
						{ fieldPath: "frontmatter.status", stringValue: "proposed" },
					]
				: [{ fieldPath: "metadata.status", stringValue: "captured" }],
		);
		for (const doc of docs)
			expect(doc).toMatchObject({
				sourceKind: "pending",
				target: draft.target,
				pendingUpdateId: draft.pendingUpdateId,
				proposalRevision: draft.proposal.revision,
			});
	});

	test("keeps another member out and allows the owner to discard after losing read access", async () => {
		const draft = await create_private_text_for_test({ unstaged: "private content\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const other = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_private_other" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: other.membershipId,
				target,
			}),
		).toBeNull();
		expect(
			await asOther.query(api.files_pending_updates.list_files_pending_updates, {
				membershipId: other.membershipId,
				listKey: "all",
				paginationOpts: { numItems: 5, cursor: null },
			}),
		).toMatchObject({ page: [], isDone: true });
		expect(
			(
				await asOther.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: other.membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay?.name,
		).toBe("not_found");
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations", draft.organizationId, { ownerUserId: other.userId });
		});
		expect(await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target })).toBeNull();
		expect(await list_root_for_test(t, { membershipId })).toMatchObject({ _yay: { items: [] } });
		// The row's own view is null above, so the Pending tab shows it as restricted.
		expect(
			(
				await asUser.query(api.files_pending_updates.list_files_pending_updates, {
					membershipId,
					listKey: "all",
					paginationOpts: { numItems: 5, cursor: null },
				})
			).page,
		).toMatchObject([{ target, pendingUpdateId, revision: proposal.revision }]);
		expect(
			(
				await test_save_file_pending_update(asUser, {
					membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({
			state: "discarded",
			creationGeneration: 2,
		});
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test.each(["../outside.txt", "a/b.txt", ""])("refuses the invalid draft name %s", async (destName) => {
		const draft = await create_private_text_for_test();
		const before = await read_pending_review_state_for_test(draft.t);
		const moved = await draft.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target: draft.target,
			destParent: { kind: "root" },
			destName,
		});
		expect(moved._nay).toBeDefined();
		expect(await read_pending_review_state_for_test(draft.t)).toEqual(before);
		expect(
			await draft.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: draft.membershipId,
				target: draft.target,
			}),
		).toMatchObject({ entry: { path: "/draft.txt" } });
	});

	test("lists a preparing draft and refuses ordinary content work", async () => {
		const draft = await create_private_text_for_test({ preparing: true });
		const { t, asUser, membershipId, target, pendingUpdateId } = draft;
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({
			entry: { kind: "private", path: "/draft.txt", pendingUpdate: { _id: pendingUpdateId } },
			readiness: "preparing",
			canAccept: false,
		});
		expect(await list_root_for_test(t, { membershipId })).toMatchObject({
			_yay: { items: [{ target: { kind: "private" }, path: "/draft.txt", preparing: true }] },
		});
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId,
			target,
		});
		expect(batch._nay).toBeDefined();
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target,
			destParent: { kind: "root" },
			destName: "other.txt",
		});
		expect(moved._nay?.name).toBe("preparing");
		const saved = await test_save_file_pending_update(asUser, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: draft.proposal.revision,
		});
		expect(saved._nay?.message).toContain("preparing");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_yjs_states").collect())).toEqual([]);
	});

	test.each([
		{ path: "/empty.txt", collaborative: true },
		{ path: "/empty.txt", collaborative: false },
		{ path: "/empty.md", collaborative: true },
		{ path: "/empty.md", collaborative: false },
	])("publishes a sealed empty $path draft with collaboration $collaborative", async ({ path, collaborative }) => {
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = await create_private_text_for_test({
			path,
			collaborative,
		});
		expect(proposal.content?.base).toEqual({ kind: "new" });
		const saved = await test_save_file_pending_update(asUser, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		expect(saved._yay.target.kind).toBe("saved");
		const savedTarget = saved._yay.target;
		if (savedTarget.kind !== "saved") throw new Error("Expected a saved target");
		const node = await t.run((ctx) => ctx.db.get("files_nodes", savedTarget.id));
		expect(node).toMatchObject({ path, collaborationEnabled: collaborative });
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toBeNull();

		// The old private target still resolves after Save. It now points at the saved file, which
		// remembers the private node it came from, so old links keep working.
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({
			entry: { kind: "saved", node: { _id: node!._id, publishedFromPrivateNodeId: target.id }, pendingUpdate: null },
		});
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toMatchObject([
			{ privateNodeId: target.id, savedNodeId: node!._id },
		]);
		const nodeHold = await t.run((ctx) =>
			ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "node").eq("resource.id", target.id))
				.first(),
		);
		expect(nodeHold?.settlement).toMatchObject({ kind: "saved", savedNodeId: node!._id });
	});

	test("keeps the same proposal and exact remaining states after its first partial Save", async () => {
		const draft = await create_private_text_for_test({ staged: "accepted\n", unstaged: "proposed\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const before = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: proposal }));
		const saved = await test_save_file_pending_update(asUser, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		if (saved._yay.target.kind !== "saved") throw new Error("Expected the published target");
		const savedTarget = saved._yay.target;
		const remaining = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!remaining) throw new Error("Expected the same remaining proposal");
		expect(remaining).toMatchObject({
			_id: pendingUpdateId,
			target: savedTarget,
			revision: proposal.revision + 1,
			content: { base: { kind: "yjs", sequence: 0, lineageGeneration: 0 } },
		});
		expect(remaining.createIntent).toBeUndefined();
		const after = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: remaining }));
		expect(after.baseBytes).toEqual(before.stagedBytes);
		expect(after.stagedBytes).toEqual(before.stagedBytes);
		expect(after.unstagedBytes).toEqual(before.unstagedBytes);
		expect(
			await t.run((ctx) =>
				read_file_markdown_from_yjs({
					ctx,
					organizationId: draft.organizationId,
					workspaceId: draft.workspaceId,
					nodeId: savedTarget.id,
					rootKind: "plain_text",
				}),
			),
		).toBe("accepted\n");
		const runIdsBeforeReplay = await t.run(async (ctx) =>
			(await ctx.db.query("files_pending_update_runs").collect()).map((run) => run._id),
		);
		expect(runIdsBeforeReplay).toHaveLength(1);
		const billedBeforeReplay = file_save_events().length;
		const replayed = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		expect(replayed._nay).toBeUndefined();
		if (replayed._nay || !("kind" in replayed._yay)) throw new Error("Expected the original Save job");
		expect(replayed._yay).toMatchObject({ kind: "queued", runId: runIdsBeforeReplay[0] });
		const original = await asUser.query(api.files_pending_update_runs.get, { membershipId, runId: replayed._yay.runId });
		expect(original?.activity).toMatchObject({
			_id: replayed._yay.activityId,
			status: "succeeded",
			progress: { completed: 1 },
		});
		expect(file_save_events()).toHaveLength(billedBeforeReplay);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toEqual(remaining);
		const stale = await asUser.mutation(api.files_pending_update_runs.start, {
			membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [{
				pendingUpdateId,
				reviewedRevision: proposal.revision,
				selectedContentStateId: proposal.content?.stagedStateId ?? null,
			}],
		});
		expect(stale._nay?.name).toBe("needs_review");
		expect(await t.run(async (ctx) =>
			(await ctx.db.query("files_pending_update_runs").collect()).map((run) => run._id),
		)).toEqual(runIdsBeforeReplay);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toEqual(remaining);
	});

	test("allows Save but refuses more draft bytes when private storage is full", async () => {
		const draft = await create_private_text_for_test({ staged: "accepted\n", unstaged: "remaining\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const before = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: proposal }));
		const quotaIds = await t.run(async (ctx) => {
			const ids = [];
			for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
				const id = await quotas_db_ensure(ctx, {
					organizationId: draft.organizationId,
					workspaceId: draft.workspaceId,
					...(quotaName === "files_private_user_bytes" ? { quotaName, userId: draft.userId } : { quotaName }),
					now: Date.now(),
				});
				await ctx.db.patch("quotas", id, { maxCount: 0 });
				ids.push(id);
			}
			return ids;
		});
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId,
			target,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const added = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "more bytes",
		});
		expect(added._nay?.name).toBe("storage_full");
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: batch._yay.operationBatchId,
		});
		const saved = await test_save_file_pending_update(asUser, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		expect(saved._nay, "A reviewed partial Save stays available when private byte storage is full").toBeUndefined();
		if (saved._nay) throw new Error(saved._nay.message);
		expect(saved._yay.target.kind).toBe("saved");
		const remaining = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!remaining?.content) throw new Error("Expected the remaining text proposal");
		const after = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: remaining }));
		expect(after.baseBytes).toEqual(before.stagedBytes);
		expect(after.stagedBytes).toEqual(before.stagedBytes);
		expect(after.unstagedBytes).toEqual(before.unstagedBytes);
		const expectedRetainedBytes =
			after.baseBytes.byteLength + after.stagedBytes.byteLength + after.unstagedBytes.byteLength;
		await t.run(async (ctx) => {
			for (const id of quotaIds)
				expect(await ctx.db.get("quotas", id)).toMatchObject({ usedCount: expectedRetainedBytes, maxCount: 0 });
			for (const [stateId, bytes] of [
				[remaining.content!.baseStateId, after.baseBytes],
				[remaining.content!.stagedStateId, after.stagedBytes],
				[remaining.content!.unstagedStateId, after.unstagedBytes],
			] as const) {
				const reservation = await ctx.db.query("files_private_storage_reservations")
					.withIndex("by_resource", (q) => q.eq("resource.kind", "state").eq("resource.id", stateId)).unique();
				expect(reservation).toMatchObject({ settlement: { kind: "held" }, byteCount: bytes.byteLength });
				expect(reservation?.cohortContentId).toBeUndefined();
			}
			const nodeReservation = await ctx.db.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "node").eq("resource.id", target.id)).unique();
			expect(nodeReservation?.settlement).toMatchObject({ kind: "saved", savedNodeId: saved._yay.target.id });
		});
	});

	test("refuses an old review after the owner renames the draft", async () => {
		const draft = await create_private_text_for_test({ staged: "text\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target,
			destParent: { kind: "root" },
			destName: "renamed.txt",
		});
		expect(moved._nay).toBeUndefined();
		const saved = await test_save_file_pending_update(asUser, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		expect(saved._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({ entry: { path: "/renamed.txt" } });
	});
});

describe("pending Copy disclosure", () => {
	test("text copied over a saved file keeps destination sharing", async () => {
		const t = test_convex();
		const source = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/source.md", name: "source.md", markdown: "# Source" }),
		);
		const destination = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/destination.md",
				name: "destination.md",
				markdown: "# Destination",
				membership: source,
			}),
		);
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			...destination,
			unstagedMarkdown: "# Source",
			copiedFrom: { nodeId: source.nodeId, path: "/source.md" },
		});
		if (proposed._nay) throw new Error(proposed._nay.message);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: source.userId });
		const args = { membershipId: source.membershipId, target: { kind: "saved" as const, id: destination.nodeId } };
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, args);
		expect(view?.entry.pendingUpdate?.content).toBeDefined();
		expect(view?.entry.pendingUpdate?.pendingReplacement).toBeUndefined();
		expect(view?.copyDestination).toEqual({ personal: false, replacement: true, folderPath: "/" });
	});
});

describe.each(["saved", "private"] as const)("%s Copy action replies", (kind) => {
	test.each(["prepare", "upsert", "upsert-refresh", "rebase", "rebase-refresh"] as const)(
		"omits source proof from %s and keeps the exact stored proposal",
		async (operation) => {
			const t = test_convex();
			const source = await t.run((ctx) =>
				seed_file_with_markdown({ ctx, path: "/source.md", name: "source.md", markdown: "# Source" }),
			);
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: source.userId });
			const scope = { organizationId: source.organizationId, workspaceId: source.workspaceId, userId: source.userId };
			let target: Doc<"files_pending_updates">["target"];
			if (kind === "private") {
				const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...scope }));
				const started = await t.mutation(internal.files_transfer.start_for_agent, {
					membershipId: source.membershipId,
					threadId,
					requestId: "action-redaction",
					sourceWorkspace: "current",
					destinationWorkspace: "current",
					kind: "copy",
					expectedSourceCount: 1,
					sources: [{ kind: "saved", id: source.nodeId }],
					targetParent: { kind: "root" },
					targetPath: "/",
					targetName: "destination.md",
					missingParentNames: [],
					conflictPolicy: { file: "error", folder: "error" },
				});
				if (started._nay) throw new Error(started._nay.message);
				const runId = started._yay.runId;
				expect(
					await t.mutation(internal.files_transfer.seal_for_agent, {
						membershipId: source.membershipId,
						threadId,
						runId,
					}),
				).toEqual({ _yay: null });
				for (let step = 0; step < 30; step++) {
					await t.mutation(internal.files_transfer.advance, { runId });
					const item = await t.run((ctx) =>
						ctx.db
							.query("files_transfer_items")
							.withIndex("by_run_order", (q) => q.eq("runId", runId))
							.first(),
					);
					if (item?.workId && item.state === "copying") {
						await t.action(internal.files_nodes_content.copy_transfer_file, {
							itemId: item._id,
							attempt: item.attempt,
						});
						await t.mutation(internal.files_transfer.handle_copy_complete, {
							workId: item.workId,
							context: { itemId: item._id, attempt: item.attempt },
							result: { kind: "success", returnValue: null },
						});
					}
					const run = await asUser.query(api.files_transfer.get, { membershipId: source.membershipId, runId });
					if (run?.activity.status === "succeeded") break;
				}
				const item = await t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_order", (q) => q.eq("runId", runId))
						.first(),
				);
				if (item?.state !== "completed" || item.outputTarget?.kind !== "private")
					throw new Error("Expected a copied private file");
				target = item.outputTarget;
			} else {
				const destination = await t.run((ctx) =>
					seed_file_with_markdown({
						ctx,
						path: "/destination.md",
						name: "destination.md",
						markdown: "# Destination",
						membership: source,
					}),
				);
				target = { kind: "saved", id: destination.nodeId };
				const copied = await upsert_file_pending_update_internal_for_test({
					t,
					...destination,
					unstagedMarkdown: "# Source",
					copiedFrom: { nodeId: source.nodeId, path: "/source.md" },
				});
				if (copied._nay) throw new Error(copied._nay.message);
			}
			const args = { membershipId: source.membershipId, target };
			const visible = await asUser.query(api.files_pending_updates.get_file_pending_update, args);
			if (!visible?.content) throw new Error("Expected copied text");
			expect(visible.copiedFrom?.path).toBe("/source.md");
			const before = await t.run((ctx) => ctx.db.get("files_pending_updates", visible._id));
			if (!before?.content) throw new Error("Expected the stored Copy");
			expect(
				await test_rename_node(t, asUser, {
					membershipId: source.membershipId,
					nodeId: source.nodeId,
					path: "renamed.md",
				}),
			).toMatchObject({ _yay: { runId: expect.any(String), activityId: expect.any(String) } });
			expect((await t.run((ctx) => ctx.db.get("files_nodes", source.nodeId)))?.path).toBe("/renamed.md");
			let returned: Doc<"files_pending_updates"> | null;
			if (operation === "prepare") {
				const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
					...args,
					pendingUpdateId: before._id,
				});
				if (result._nay) throw new Error(result._nay.message);
				returned = result._yay.pendingUpdate;
			} else {
				const writing = await asUser.mutation(
					api.files_pending_updates.create_file_pending_update_operation_batch,
					args,
				);
				if (writing._nay) throw new Error(writing._nay.message);
				const operationBatchId = writing._yay.operationBatchId;
				if (operation === "upsert" || operation === "upsert-refresh") {
					expect(
						await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
							membershipId: source.membershipId,
							operationBatchId,
							role: "unstaged",
							text: operation === "upsert" ? "# Source\n\nReview edit" : "# Source",
						}),
					).toEqual({ _yay: null });
					const result = await asUser.action(api.files_pending_updates.upsert_file_pending_update, {
						...args,
						operationBatchId,
						pendingUpdateId: before._id,
						reviewedRevision: before.revision,
					});
					if (result._nay) throw new Error(result._nay.message);
					returned = result._yay.pendingUpdate;
				} else {
					const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: before }));
					if (operation === "rebase") {
						const branch = files_yjs_doc_create_from_array_buffer_update(bytes.unstagedBytes);
						expect(
							files_yjs_doc_update_from_text({
								rootKind: "rich_text",
								mut_yjsDoc: branch,
								text: "# Source\n\nReview edit",
							})._nay,
						).toBeUndefined();
						bytes.unstagedBytes = files_u8_to_array_buffer(encodeStateAsUpdate(branch));
						branch.destroy();
					}
					for (const [role, update] of [
						["base", bytes.baseBytes],
						["staged", bytes.stagedBytes],
						["unstaged", bytes.unstagedBytes],
					] as const) {
						expect(
							(
								await asUser.mutation(api.files_pending_updates.stage_file_pending_update_state_page, {
									membershipId: source.membershipId,
									operationBatchId,
									role,
									pageIndex: 0,
									bytes: update,
								})
							)._nay,
						).toBeUndefined();
						expect(
							(
								await asUser.mutation(api.files_pending_updates.seal_file_pending_update_state, {
									membershipId: source.membershipId,
									operationBatchId,
									role,
									expectedTotalBytes: update.byteLength,
								})
							)._nay,
						).toBeUndefined();
					}
					const result = await asUser.action(api.files_pending_updates.persist_file_pending_update_rebased_state, {
						...args,
						operationBatchId,
						pendingUpdateId: before._id,
						reviewedRevision: before.revision,
						baseYjsSequence: before.content.base.kind === "yjs" ? before.content.base.sequence : 0,
					});
					if (result._nay) throw new Error(result._nay.message);
					returned = result._yay.pendingUpdate;
				}
			}
			const stored = await t.run((ctx) => ctx.db.get("files_pending_updates", before._id));
			expect(stored?.copiedFrom).toEqual(before.copiedFrom);
			expect(returned?._id).toBe(before._id);
			expect(returned?.copiedFrom).toBeUndefined();
			expect(returned).toEqual({ ...stored, copiedFrom: undefined });
			if (operation === "upsert" || operation === "rebase") {
				const text = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: stored! }));
				expect(text.unstagedMarkdown).toContain("Review edit");
			}
		},
	);
});

describe("copied-parent text Save", () => {
	test.each(["plain", "rich_text", "asset"] as const)("publishes %s through Save-only preparation", async (kind) => {
		const f = await create_private_text_for_test();
		const scope = { organizationId: f.organizationId, workspaceId: f.workspaceId, userId: f.userId };
		const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/source" });
		if (source._nay) throw new Error(source._nay.message);
		await set_pending_test_read_only({ asUser: f.asUser, membershipId: f.membershipId, nodeId: source._yay.nodeId });
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.membershipId,
			clientGeneratedId: "copied-parent-text",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.membershipId,
			threadId: thread._yay.threadId,
			requestId: "copied-parent-text",
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [{ kind: "saved", id: source._yay.nodeId }],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "copied",
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 20; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			if ((await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId)))?.status === "succeeded") break;
		}
		expect(await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId))).toMatchObject({
			status: "succeeded",
		});
		const child = await create_private_text_for_test(
			{
				path: kind === "plain" ? "/copied/child.txt" : "/copied/child.md",
				staged: "Saved child",
				collaborative: kind !== "asset",
			},
			{ t: f.t, membershipId: f.membershipId },
		);
		const parent = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", f.organizationId)
						.eq("workspaceId", f.workspaceId)
						.eq("userId", f.userId)
						.eq("parent.kind", "root")
						.eq("parent.id", undefined)
						.eq("state", "active")
						.eq("name", "copied"),
				)
				.unique(),
		);
		if (!parent) throw new Error("Expected the copied parent");
		const proposal = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", parent._id))
				.unique(),
		);
		if (!proposal) throw new Error("Expected the parent proposal");
		expect(
			(
				await test_save_file_pending_update(f.asUser, {
					membershipId: f.membershipId,
					target: proposal.target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.membershipId,
				target: child.target,
			}),
		).toMatchObject({ canEdit: false, canAccept: true });
		expect(
			(
				await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
					membershipId: f.membershipId,
					target: child.target,
				})
			)._nay,
		).toBeDefined();
		const saved = await test_save_file_pending_update(f.asUser, {
			membershipId: f.membershipId,
			target: child.target,
			pendingUpdateId: child.pendingUpdateId,
			reviewedRevision: child.proposal.revision,
		});
		expect(saved._nay).toBeUndefined();
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved child");
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", saved._yay.target.id as Id<"files_nodes">))).toMatchObject({
			path: child.path,
			collaborationEnabled: kind !== "asset",
			textKind: kind === "plain" ? "plain_text" : "rich_text",
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child.pendingUpdateId))).toBeNull();
	});
});

describe("prepared Save media proof", () => {
	test("an asset Save with nothing staged validates media without changing the proposal or file", async () => {
		vi.useFakeTimers();
		const f = await create_private_text_for_test({ path: "/noop-proof.md", staged: "# Before", collaborative: false });
		const saved = await test_save_file_pending_update(f.asUser, {
			membershipId: f.membershipId,
			target: f.target,
			pendingUpdateId: f.proposal._id,
			reviewedRevision: f.proposal.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved file");
		const target = saved._yay.target;
		const edited = await upsert_file_pending_update_public_for_test(f.asUser, {
			membershipId: f.membershipId,
			nodeId: target.id,
			stagedMarkdown: "# Before",
			unstagedMarkdown: "# After",
		});
		if (edited._nay || !edited._yay.pendingUpdate) throw new Error("Expected the pending edit");
		const proposal = edited._yay.pendingUpdate;
		await f.t.run(async (ctx) => {
			const created = await files_media_dependencies_db_create(ctx, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.userId,
				owner: { kind: "proposal", pendingUpdateId: proposal._id },
				expectedCount: 0,
			});
			if (created._nay) throw new Error(created._nay.message);
			expect(await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 })).toEqual({
				_yay: null,
			});
			await files_db_patch_pending_update({
				ctx,
				pendingUpdateId: proposal._id,
				value: { mediaDependencySetId: created._yay },
			});
		});
		const before = await f.t.run(async (ctx) => ({
			proposal: await ctx.db.get("files_pending_updates", proposal._id),
			file: await ctx.db.get("files_nodes", target.id),
		}));
		await test_drain_billing_usage_event_outbox(f.t);
		const savesBefore = file_save_events().length;
		expect(
			(
				await test_save_file_pending_update(f.asUser, {
					membershipId: f.membershipId,
					target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.t.run(async (ctx) => ({
				proposal: await ctx.db.get("files_pending_updates", proposal._id),
				file: await ctx.db.get("files_nodes", target.id),
			})),
		).toEqual(before);
		await test_drain_billing_usage_event_outbox(f.t);
		expect(file_save_events()).toHaveLength(savesBefore);
		const inputs = await f.t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect());
		expect(inputs.some((input) => input.mediaValidation?.pendingUpdateId === proposal._id)).toBe(true);
	});

	test.each(["save", "discard", "expiry"] as const)("%s retires the proposal's media set", async (operation) => {
		vi.useFakeTimers();
		const f = await create_private_text_for_test({ path: "/retire.md", staged: "# Retained" });
		const setId = await f.t.run(async (ctx) => {
			const created = await files_media_dependencies_db_create(ctx, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.userId,
				owner: { kind: "proposal", pendingUpdateId: f.proposal._id },
				expectedCount: 0,
			});
			if (created._nay) throw new Error(created._nay.message);
			expect(await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 })).toEqual({
				_yay: null,
			});
			await files_db_patch_pending_update({
				ctx,
				pendingUpdateId: f.proposal._id,
				value: { mediaDependencySetId: created._yay },
			});
			return created._yay;
		});
		const args = {
			membershipId: f.membershipId,
			target: f.target,
			pendingUpdateId: f.proposal._id,
			reviewedRevision: f.proposal.revision,
		};
		if (operation === "save") {
			expect((await test_save_file_pending_update(f.asUser, args))._nay).toBeUndefined();
		} else if (operation === "discard") {
			expect(await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, args)).toEqual({
				_yay: null,
			});
		} else {
			await expire_pending_update_for_test(f.t, f.proposal._id);
		}
		if (operation !== "save") {
			const cleanup = await f.t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").first());
			if (!cleanup) throw new Error("Expected the private cleanup task");
			await f.t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: cleanup.privateNodeId });
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.proposal._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "cleanup" },
			generation: 1,
		});
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
	});

	test.each(["saved_yjs", "saved_asset"] as const)(
		"%s refuses a missing proof before publishing",
		async (kind) => {
			const f = await create_private_text_for_test({
				path: "/proof.md",
				staged: "# Before",
				collaborative: kind !== "saved_asset",
			});
			let target: Doc<"files_pending_updates">["target"] = f.target;
			let proposal = f.proposal;
			{
				const saved = await test_save_file_pending_update(f.asUser, {
					membershipId: f.membershipId,
					target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved file");
				target = saved._yay.target;
				const edited = await upsert_file_pending_update_public_for_test(f.asUser, {
					membershipId: f.membershipId,
					nodeId: target.id,
					stagedMarkdown: "# After",
					unstagedMarkdown: "# After",
				});
				if (edited._nay || !edited._yay.pendingUpdate) throw new Error("Expected the pending edit");
				proposal = edited._yay.pendingUpdate;
			}
			// The Copy producer owns this empty set. Use its helpers, not raw set docs.
			await f.t.run(async (ctx) => {
				const created = await files_media_dependencies_db_create(ctx, {
					organizationId: f.organizationId,
					workspaceId: f.workspaceId,
					userId: f.userId,
					owner: { kind: "proposal", pendingUpdateId: proposal._id },
					expectedCount: 0,
				});
				if (created._nay) throw new Error(created._nay.message);
				expect(await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 })).toEqual({
					_yay: null,
				});
				await files_db_patch_pending_update({
					ctx,
					pendingUpdateId: proposal._id,
					value: { mediaDependencySetId: created._yay },
				});
			});
			const args = {
				membershipId: f.membershipId,
				target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			};
			const prepared = await f.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					...args,
					userId: f.userId,
					reviewedPrivateParentIds: [],
				}),
			);
			if (prepared._nay || prepared._yay.kind === "private") throw new Error("Expected prepared saved content");
			const before = await f.t.run(async (ctx) => ({
				proposal: await ctx.db.get("files_pending_updates", proposal._id),
				nodes: await ctx.db.query("files_nodes").collect(),
			}));
			const refused = await f.t.mutation(internal.files_pending_updates.commit_prepared_content, {
				userId: f.userId,
				prepared: prepared._yay,
			});
			expect(refused).toMatchObject({ _nay: { name: "media_validation_changed" } });
			expect(
				await f.t.run(async (ctx) => ({
					proposal: await ctx.db.get("files_pending_updates", proposal._id),
					nodes: await ctx.db.query("files_nodes").collect(),
				})),
			).toEqual(before);
			await f.t.mutation(internal.files_pending_updates.retire_prepared_content, { prepared: prepared._yay });
			const saved = await test_save_file_pending_update(f.asUser, args);
			expect(saved._nay).toBeUndefined();
			expect(saved._yay?.target.kind).toBe("saved");
		},
	);
});

describe("archived-parent draft recovery", () => {
	async function fixture(nested = false) {
		vi.useFakeTimers();
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: true, retryAfter: 0 });
		const t = test_convex();
		const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const home = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
		expect(
			await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userIdToAdd: home.userId,
			}),
		).toEqual({ _yay: null });
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
				)
				.first(),
		);
		if (!membership) throw new Error("Expected the draft owner's membership");
		const folder = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: owner.membershipId,
			parentId: files_ROOT_ID,
			path: "retained",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const draft = await create_private_text_for_test(
			{
				path: nested ? "/retained/outer/inner/draft.txt" : "/retained/draft.txt",
				staged: "accepted text\n",
				unstaged: "proposed text\n",
			},
			{ t, membershipId: membership._id },
		);
		expect(
			await asOwner.mutation(api.files_nodes.archive_nodes, {
				membershipId: owner.membershipId,
				nodeIds: [folder._yay.nodeId],
			}),
		).toEqual({ _yay: null });
		return { ...draft, owner, asOwner, parentId: folder._yay.nodeId };
	}

	test.each([false, true])("reads retained branches without reopening paths or Save (nested %s)", async (nested) => {
		const f = await fixture(nested);
		const { asUser, membershipId, target, proposal, pendingUpdateId } = f;
		const before = await read_pending_review_state_for_test(f.t);
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target });
		expect(view).toMatchObject({
			entry: { path: f.path, pendingUpdate: { _id: pendingUpdateId } },
			readiness: "ready",
			canEdit: false,
			canAccept: false,
			canAcceptWithParents: false,
			recovery: { savedParentId: f.parentId, expiresAt: expect.any(Number) },
		});
		const page = await asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId,
			listKey: "all",
			paginationOpts: { cursor: null, numItems: 5 },
		});
		expect(page.page).toContainEqual(expect.objectContaining({ pendingUpdateId }));
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_update, { membershipId, target }),
		).toMatchObject({ _id: pendingUpdateId, content: proposal.content });
		for (const [stateId, text] of [
			[proposal.content!.stagedStateId, "accepted text\n"],
			[proposal.content!.unstagedStateId, "proposed text\n"],
		] as const) {
			const state = await asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
				membershipId,
				target,
				stateId,
				pageIndex: 0,
			});
			expect(state).not.toBeNull();
			const decoded = files_yjs_doc_create_from_array_buffer_update(state!.bytes);
			expect(files_yjs_doc_get_text({ yjsDoc: decoded, rootKind: "plain_text" })._yay).toBe(text);
			decoded.destroy();
		}
		expect(await asUser.query(api.files_nodes.get_visible_target_by_path, { membershipId, path: f.path })).toBeNull();
		expect(
			(
				await test_save_file_pending_update(asUser, {
					membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
					membershipId,
					target,
				})
			)._nay,
		).toBeDefined();
		expect(await read_pending_review_state_for_test(f.t)).toEqual(before);
		expect(
			await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: f.owner.membershipId,
				nodeIds: [f.parentId],
			}),
		).toEqual({ _yay: null });
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({ canEdit: true, canAcceptWithParents: true });
	});

	test("downloads captured bytes under an archived parent without changing its asset or expiry", async () => {
		const f = await fixture();
		await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: f.owner.membershipId,
			nodeIds: [f.parentId],
		});
		const scope = {
			organizationId: f.organizationId,
			workspaceId: f.workspaceId,
			userId: f.userId,
			membershipId: f.membershipId,
		};
		const prepared = await f.t.mutation(internal.files_ingestion.prepare_file, {
			...scope,
			requestId: "recovery-bytes",
			attemptId: "one",
			path: "/retained/capture.bin",
			size: 4,
			contentType: "application/octet-stream",
			digest: "a".repeat(64),
			content: { kind: "stored" },
		});
		if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected stored preparation");
		const capture = prepared._yay;
		r2Objects.set(capture.r2Key, "bits");
		const completed = await f.t.mutation(internal.files_ingestion.finalize_file, {
			...scope,
			receiptId: capture.receiptId,
			attemptId: "one",
		});
		if (completed._nay || completed._yay.target.kind !== "private") throw new Error("Expected private capture");
		const target = completed._yay.target;
		await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.owner.membershipId,
			nodeIds: [f.parentId],
		});
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.membershipId,
			target,
		});
		if (view?.entry.kind !== "private") throw new Error("Expected recovery view");
		expect(view.recovery).toMatchObject({ savedParentId: f.parentId, expiresAt: expect.any(Number) });
		const args = {
			membershipId: f.membershipId,
			target,
			pendingUpdateId: view.entry.pendingUpdate._id,
			reviewedRevision: view.entry.pendingUpdate.revision,
			creationGeneration: view.entry.node.creationGeneration,
		};
		const before = await read_pending_review_state_for_test(f.t);
		const assetBefore = await f.t.run((ctx) => ctx.db.get("files_r2_assets", capture.assetId));
		const download = await f.asUser.action(api.files_pending_updates.create_private_pending_download_url, args);
		if (download._nay) throw new Error(download._nay.message);
		expect(await (await fetch(download._yay.url)).text()).toBe("bits");
		expect(await read_pending_review_state_for_test(f.t)).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", capture.assetId))).toEqual(assetBefore);
		expect(
			(
				await f.asOwner.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					membershipId: f.owner.membershipId,
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await f.asUser.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					reviewedRevision: args.reviewedRevision + 1,
				})
			)._nay,
		).toBeDefined();
		await f.asUser.mutation(api.organizations.remove_user_from_organization, {
			organizationId: f.organizationId,
			userIdToRemove: f.userId,
		});
		const denied = await f.asUser.action(api.files_pending_updates.create_private_pending_download_url, args);
		expect(denied._nay).toBeDefined();
		expect(JSON.stringify(denied)).not.toContain("retained");
		expect(JSON.stringify(denied)).not.toContain(capture.r2Key);
	});

	test("recovery reads keep the real expiry and cannot revive an expired draft", async () => {
		const f = await fixture();
		const args = { membershipId: f.membershipId, target: f.target };
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, args);
		if (!view?.recovery) throw new Error("Expected the recovery view");
		const draft = await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.pendingUpdateId));
		// Without a heartbeat, the recovery view shows the draft's own expiry.
		expect(view.recovery.expiresAt).toBe(draft?.expiresAt);
		const parentBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", f.parentId));

		// An open app tab keeps the draft 4 hours past the last heartbeat, and the view shows that time.
		vi.setSystemTime(view.recovery.expiresAt - 1);
		await f.asUser.mutation(api.presence.heartbeat, {
			roomId: `recovery-room-${f.pendingUpdateId}`,
			userId: f.userId,
			sessionId: "recovery-session",
			interval: presenceHeartbeatIntervalMs,
		});
		const expiry = Date.now() + files_DRAFT_IDLE_EXPIRY_MS;
		expect((await f.asUser.query(api.files_pending_updates.get_file_pending_target, args))?.recovery?.expiresAt).toBe(
			expiry,
		);
		vi.setSystemTime(expiry - 1);
		expect((await f.asUser.query(api.files_pending_updates.get_file_pending_target, args))?.recovery?.expiresAt).toBe(
			expiry,
		);
		vi.setSystemTime(expiry + 1);
		await f.t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: f.organizationId,
			workspaceId: f.workspaceId,
			userId: f.userId,
		});
		expect(await f.asUser.query(api.files_pending_updates.get_file_pending_target, args)).toBeNull();
		expect(await f.asUser.query(api.files_pending_updates.get_file_pending_update, args)).toBeNull();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
				...args,
				stateId: f.proposal.content!.unstagedStateId,
				pageIndex: 0,
			}),
		).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.parentId))).toEqual(parentBefore);
	});

	test("keeps recovery owner-only and denies revoked ancestor access or membership", async () => {
		const f = await fixture();
		const { membershipId, target } = f;
		expect(
			await f.asOwner.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.owner.membershipId,
				target,
			}),
		).toBeNull();
		// Restrict while active through the normal sharing door, then archive again.
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
					membershipId: f.owner.membershipId,
					nodeIds: [f.parentId],
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.owner.membershipId,
					nodeId: f.parentId,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.archive_nodes, {
					membershipId: f.owner.membershipId,
					nodeIds: [f.parentId],
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toBeNull();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
				membershipId,
				target,
				stateId: f.proposal.content!.unstagedStateId,
				pageIndex: 0,
			}),
		).toBeNull();
		const rows = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId,
			listKey: "all",
			paginationOpts: { cursor: null, numItems: 5 },
		});
		// The row's own view is null above, so the Pending tab shows it as restricted.
		expect(rows.page).toMatchObject([{ target }]);
		expect(JSON.stringify(rows)).not.toContain("retained");
		expect(
			await f.asOwner.mutation(api.files_sharing.unrestrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.parentId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({ recovery: { savedParentId: f.parentId }, canAccept: false });
		expect(
			(
				await f.asUser.mutation(api.organizations.remove_user_from_organization, {
					organizationId: f.organizationId,
					userIdToRemove: f.userId,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toBeNull();
	});
});

describe("private pending downloads", () => {
	test("signs only the owner's current ready capture and refuses stale or retired captures", async () => {
		const draft = await create_private_text_for_test({ path: "/capture.png", preparing: true });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const args = { membershipId, target, pendingUpdateId, reviewedRevision: proposal.revision, creationGeneration: 1 };
		expect(
			(await asUser.action(api.files_pending_updates.create_private_pending_download_url, args))._nay?.message,
		).toContain("preparing");
		const assetId = await t.run(async (ctx) => {
			// Leave `unfinalizedExpiresAt` unset. The download door signs an asset only after its
			// upload has finished.
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				createdBy: draft.userId,
				kind: "upload",
				r2Bucket: "test-bucket",
				r2Key: "private/capture.png",
				size: 8,
				updatedAt: Date.now(),
			});
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						organizationId: draft.organizationId,
						workspaceId: draft.workspaceId,
						userId: draft.userId,
						resource: { kind: "asset", id: assetId, r2Key: "private/capture.png" },
						byteCount: 8,
					})
				)._nay,
			).toBeUndefined();
			await ctx.db.patch("files_pending_updates", pendingUpdateId, {
				createIntent: { kind: "stored", assetId, size: 8, contentType: "image/png", metadata: [] },
			});
			return assetId;
		});
		expect(
			(await asUser.action(api.files_pending_updates.create_private_pending_download_url, args))._yay?.url,
		).toContain(encodeURIComponent("private/capture.png"));
		expect(
			(
				await asUser.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					reviewedRevision: args.reviewedRevision + 1,
				})
			)._nay?.name,
		).toBe("target_changed");
		expect(
			(
				await asUser.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					creationGeneration: 2,
				})
			)._nay?.name,
		).toBe("target_changed");
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-downloads" }),
		);
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			(
				await asOther.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					membershipId: other.membershipId,
				})
			)._nay,
		).toBeDefined();
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", assetId, { uploadRetiredAt: Date.now() });
		});
		expect(
			(await asUser.action(api.files_pending_updates.create_private_pending_download_url, args))._nay?.message,
		).toContain("no longer available");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});
});

describe("saved proposal publication headroom", () => {
	test.each([false, true])(
		"saves a partial proposal at the private storage cap with collaboration %s",
		async (collaborative) => {
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				seed_non_collaborative_file({ ctx, path: "/full-storage.txt", text: "base\n" }),
			);
			r2Objects.set("content-snapshot/full-storage.txt", "base\n");
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Owner" });
			if (collaborative)
				expect(
					(
						await asUser.action(api.files_nodes_content.set_file_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
						})
					)._nay,
				).toBeUndefined();
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...seeded,
						stagedMarkdown: "accepted\n",
						unstagedMarkdown: "remaining\n",
					})
				)._nay,
			).toBeUndefined();
			const proposal = await read_seeded_pending_row(t, seeded);
			await t.run(async (ctx) => {
				for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
					const id = await quotas_db_ensure(ctx, { ...seeded, quotaName, now: Date.now() });
					await ctx.db.patch("quotas", id, { maxCount: 0 });
				}
			});
			const saved = await test_save_file_pending_update(asUser, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			if (saved._nay) throw new Error(saved._nay.message);
			expect(saved._yay.target).toEqual({ kind: "saved", id: seeded.nodeId });
			const remaining = await read_seeded_pending_row(t, seeded);
			expect(
				await t.run((ctx) =>
					read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind: "plain_text" }),
				),
			).toEqual({
				baseMarkdown: "accepted\n",
				stagedMarkdown: "accepted\n",
				unstagedMarkdown: "remaining\n",
			});
			const reservations = await t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			expect(
				reservations.filter((hold) => hold.resource.kind === (collaborative ? "trusted_stage" : "asset")),
			).toMatchObject([{ settlement: { kind: collaborative ? "deleted" : "saved" } }]);
		},
	);
});

describe("upsert_file_pending_update", () => {
	test.each(["refresh", "settle"] as const)("does not acknowledge a newer proposal from a stale %s", async (phase) => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/stale-ack.txt", text: "base\n" }));
		expect(
			(await upsert_file_pending_update_internal_for_test({ t, ...seeded, unstagedMarkdown: "newer proposal\n" }))._nay,
		).toBeUndefined();

		const pendingUpdate = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!pendingUpdate) throw new Error("Expected the newer proposal");
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const args = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingUpdate._id,
			expectedRevision: pendingUpdate.revision - 1,
		};

		const result =
			phase === "refresh"
				? await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, args)
				: await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, args);

		expect(result._nay?.message).toBe("Pending update changed, retry the write");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdate._id))).toEqual(pendingUpdate);
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", args.operationBatchId)))?.expiresAt,
		).toBe(0);
	});

	test.each(["plain_text", "rich_text"] as const)(
		"acknowledges the exact committed %s proposal on every success path",
		async (rootKind) => {
			for (const collaborative of [false, true]) {
				const t = test_convex();
				const path = rootKind === "rich_text" ? "/ack.md" : "/ack.txt";
				const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: "base\n" }));
				r2Objects.set(`content-snapshot${path}`, "base\n");
				const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
				if (collaborative) {
					expect(
						(
							await asUser.action(api.files_nodes_content.set_file_collaborative, {
								membershipId: seeded.membershipId,
								nodeId: seeded.nodeId,
							})
						)._nay,
					).toBeUndefined();
				}
				const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
				const currentYjsLastSequenceId = node?.yjsLastSequenceId ?? null;
				const empty = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					unstagedMarkdown: "base\n",
				});
				expect(empty).toEqual({ _yay: { pendingUpdate: null, currentYjsLastSequenceId } });

				const created = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					unstagedMarkdown: "first\n",
				});
				const first = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				if (!first?.content) throw new Error("Expected the first committed proposal");
				expect(created).toEqual({ _yay: { pendingUpdate: first, currentYjsLastSequenceId } });
				const firstBytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: first }));
				const refreshed = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: first._id,
					reviewedRevision: first.revision,
					unstagedMarkdown: "first\n",
				});
				const refreshedDoc = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				expect(refreshed).toEqual({ _yay: { pendingUpdate: refreshedDoc, currentYjsLastSequenceId } });
				expect(refreshedDoc?.content?.unstagedStateId).toBe(first.content.unstagedStateId);

				const changed = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: first._id,
					reviewedRevision: refreshedDoc?.revision,
					unstagedMarkdown: "second\n",
				});
				const second = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				expect(changed).toEqual({ _yay: { pendingUpdate: second, currentYjsLastSequenceId } });
				expect(second?.content?.unstagedStateId).not.toBe(first.content.unstagedStateId);
				// The old acknowledgment still identifies its own bytes after a later write.
				const oldPage = await asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
					stateId: first.content.unstagedStateId,
					pageIndex: 0,
				});
				expect(oldPage?.bytes).toEqual(firstBytes.unstagedBytes);
				expect(created._yay?.pendingUpdate).toEqual(first);

				const ended = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: first._id,
					reviewedRevision: second?.revision,
					unstagedMarkdown: "base\n",
				});
				expect(ended).toEqual({ _yay: { pendingUpdate: null, currentYjsLastSequenceId } });
				expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();

				expect(
					(await upsert_file_pending_update_public_for_test(asUser, { ...seeded, unstagedMarkdown: "move draft\n" }))
						._nay,
				).toBeUndefined();
				expect(
					(
						await upsert_file_pending_move_for_test({
							t,
							...seeded,
							destParentId: files_ROOT_ID,
							destName: "moved.txt",
						})
					)._nay,
				).toBeUndefined();
				const moved = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				const settled = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: moved?._id,
					reviewedRevision: moved?.revision,
					unstagedMarkdown: "base\n",
				});
				const structural = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				expect(structural?.pendingMove).toBeDefined();
				expect(structural?.content).toBeUndefined();
				expect(settled).toEqual({ _yay: { pendingUpdate: structural, currentYjsLastSequenceId } });
			}
		},
	);

	test("upsert_file_pending_update rejects content over the size cap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-size-cap",
				name: "pending-edits-size-cap",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const overCapMarkdown = "a".repeat(files_MAX_TEXT_CONTENT_BYTES + 1);

		const unstagedOverCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: overCapMarkdown,
		});
		expect(unstagedOverCap._nay?.message).toContain("exceeds");

		// The staged branch is the one published on save, so capping only the unstaged side would
		// leave the hole exactly where it matters.
		const stagedOverCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: overCapMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		expect(stagedOverCap._nay?.message).toContain("exceeds");

		// A rejected upsert must not leave a pending update behind.
		const row = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("refuses the upsert when covered-row cleanup truncated the base reconstruction mid-walk", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-partial-base",
				name: "pending-partial-base",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The file advanced two sequences past the seeded snapshot, then the covered-row cleanup
		// deleted both rows (as it does behind a newer snapshot) while the base walker still
		// holds the older header. The one-row reader then reports "done" before the walk reaches
		// `throughSequence`.
		await t.run(async (ctx) => {
			const rowIds = await Promise.all(
				[1, 2].map((sequence) =>
					ctx.db.insert("files_yjs_updates", {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						fileNodeId: seeded.nodeId,
						sequence,
						update: files_u8_to_array_buffer(encodeStateAsUpdate(new YDoc())),
						origin: { type: "USER_EDIT", sessionId: "partial-base-session" },
						createdBy: seeded.userId,
						createdAt: Date.now(),
					}),
				),
			);
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!node?.yjsLastSequenceId) {
				throw new Error("Expected the seeded node to have a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", node.yjsLastSequenceId, { lastSequence: 2 });
			await Promise.all(rowIds.map((rowId) => ctx.db.delete("files_yjs_updates", rowId)));
		});

		// A partial document labeled with the full sequence must never become a proposal base:
		// done-before-target means stale, so the whole upsert refuses.
		const result = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Base\n\nMore text",
		});
		expect(result._nay?.message).toBe("Failed to load file state");

		const row = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("an accept anchored to a stale reviewed version refuses; the current version passes", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-reviewed-version",
				name: "pending-reviewed-version",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const created = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft v1",
		});
		expect(created._nay).toBeUndefined();
		// The version the user opened for review.
		const reviewedRow = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!reviewedRow) {
			throw new Error("Expected a pending update row after the first upsert");
		}

		// The agent revises the proposal while the user is still looking at v1.
		const revised = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: reviewedRow._id,
			unstagedMarkdown: "# Draft v2 (revised)",
		});
		expect(revised._nay).toBeUndefined();
		const currentRow = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!currentRow) {
			throw new Error("Expected a pending update row after the revision");
		}
		expect(currentRow.updatedAt).not.toBe(reviewedRow.updatedAt);

		// Publishing what the stale review decoded must refuse instead of silently dropping the
		// revision the user never saw.
		const staleAccept = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: reviewedRow._id,
			reviewedRevision: reviewedRow.revision,
			stagedMarkdown: "# Draft v1",
			unstagedMarkdown: "# Draft v1",
		});
		expect(staleAccept._nay?.message).toBe("Pending changes were revised, review the latest version");

		// A review of the current version passes.
		const freshAccept = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: currentRow._id,
			reviewedRevision: currentRow.revision,
			stagedMarkdown: "# Draft v2 (revised)",
			unstagedMarkdown: "# Draft v2 (revised)",
		});
		expect(freshAccept._nay).toBeUndefined();
	});

	test("upsert_file_pending_update refuses over-cap frontmatter before any canonical write", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-frontmatter-cap",
				name: "pending-edits-frontmatter-cap",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const frontmatterMarkdown = (fieldCount: number) =>
			`---\n${Array.from({ length: fieldCount }, (_, index) => `field_${index}: ${index}`).join("\n")}\n---\n\n# Body`;
		// One field whose unique date-like array values each index a string value plus a
		// `maybe_date` companion, so the TOTAL index-document count blows the 512 cap while the
		// field count stays at one.
		const largeArrayMarkdown = (dateCount: number) => {
			const dates = Array.from(
				{ length: dateCount },
				(_, index) => ` - "${new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10)}"`,
			);
			return `---\ntags:\n${dates.join("\n")}\n---\n\n# Body`;
		};

		// The commit refuses BEFORE any canonical proposal/state/chunk/metadata write, and the
		// action retires the staged input batch: a visible `_nay`, not a thrown rollback.
		const overFieldCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: frontmatterMarkdown(files_metadata_MAX_FRONTMATTER_FIELDS + 1),
		});
		expect(overFieldCap._nay?.message).toBe("Too many frontmatter fields");

		// 1 field doc + 256 string values + 256 maybe_date companions = 513 > 512.
		const overIndexDocumentCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: largeArrayMarkdown((files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS - 1) / 2 + 1),
		});
		expect(overIndexDocumentCap._nay?.message).toBe("Too many frontmatter fields");

		// No canonical or temporary row survives the refusals. The refusal retired the batch
		// family; the sweep it scheduled never runs under convex-test, so drain it directly.
		let cleanupDone = false;
		for (let pass = 0; pass < 20 && !cleanupDone; pass++) {
			cleanupDone = (
				await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
					_test_disableReschedule: true,
				})
			).done;
		}
		expect(cleanupDone).toBe(true);
		const leftovers = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			const [batches, textInputs, states, metadataDocs] = await Promise.all([
				ctx.db.query("files_pending_update_operation_batches").collect(),
				ctx.db.query("files_pending_update_text_inputs").collect(),
				ctx.db.query("files_pending_update_yjs_states").collect(),
				ctx.db.query("files_metadata_docs").collect(),
			]);
			return { row, batches, textInputs, states, metadataDocs };
		});
		expect(leftovers.row).toBeNull();
		expect(leftovers.batches).toEqual([]);
		expect(leftovers.textInputs).toEqual([]);
		expect(leftovers.states).toEqual([]);
		expect(leftovers.metadataDocs).toEqual([]);

		// Exactly at the field cap the save is allowed.
		const atCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: frontmatterMarkdown(files_metadata_MAX_FRONTMATTER_FIELDS),
		});
		expect(atCap._nay).toBeUndefined();
	});

	test("a pending yaml file starting with --- is not frontmatter-indexed", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-plain.yaml",
				name: "qa-plain.yaml",
				markdown: "existing: true\n",
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// On a Markdown file this opener would index `frontmatter.title`; on a plain text `.yaml`
		// it is ordinary content.
		const yamlText = "---\ntitle: not frontmatter\ncount: 3\n---\nbody: value\n";
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: yamlText,
		});
		expect(upserted._nay).toBeUndefined();

		const after = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending update doc to exist");
			}
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", row._id))
				.collect();
			const plainTextChunks = await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: row._id });
			return { metadataDocs, chunkTexts: plainTextChunks.map((chunk) => chunk.plainTextChunk) };
		});
		// The chunks exist (the content is searchable) but no frontmatter metadata doc was written.
		expect(after.metadataDocs).toEqual([]);
		expect(after.chunkTexts.join("")).toBe(yamlText);
	});

	test("frontmatter the parser cannot read saves the file without indexing it", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-frontmatter-unreadable",
				name: "pending-frontmatter-unreadable",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The parser reads one nesting level by calling itself again until the stack is full. 1000
		// levels is enough under Node, which is what convex-test runs on; the real Convex runtime
		// needs a deeper document. Flow style needs no indentation, so this whole file is about
		// 5 KB: the byte caps never see a problem. The save must still finish, because the user
		// cannot fix this by writing less and a refusal would trap their own text.
		const unreadableMarkdown = `---\na: ${"{b: ".repeat(1000)}v${"}".repeat(1000)}\n---\n\n# Body`;
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: unreadableMarkdown,
		});
		expect(upserted._nay).toBeUndefined();

		const after = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending update doc to exist");
			}
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", row._id))
				.collect();
			const plainTextChunks = await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: row._id });
			return { metadataDocs, chunkTexts: plainTextChunks.map((chunk) => chunk.plainTextChunk) };
		});
		// The text is stored and searchable; only the frontmatter index is missing. The chunks hold
		// the rendered plain text, not the raw markdown, so check the body survived rather than
		// comparing the two strings.
		expect(after.metadataDocs).toEqual([]);
		expect(after.chunkTexts.join("")).toContain("Body");
	});

	test("the agent read path returns a plain-text file's pending content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-plain-read.json",
				name: "pending-plain-read.json",
				markdown: '{"base": true}\n',
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Byte-exact plain text on purpose: no trailing newline and markdown-hostile characters,
		// which rendered Markdown text would rewrite but the plain branch must preserve.
		const pendingText = '{"pending": [1, 2, 3], "note": "*not markdown*"}';
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: pendingText,
		});
		expect(upserted._nay).toBeUndefined();

		// The agent/public-API read source: the pending branch must serve those exact bytes.
		const readState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/pending-plain-read.json",
		});
		expect(readState?.content).toBe(pendingText);
	});

	test("the agent read serves the committed text, not the stale pending text, after a lineage bump", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-stale-lineage.md",
				name: "pending-stale-lineage.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Pending draft",
		});
		expect(upserted._nay).toBeUndefined();

		// Before the repair, the read serves the proposal.
		const beforeBump = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/pending-stale-lineage.md",
		});
		expect(beforeBump?.content).toContain("Pending draft");

		// A repair replaced the document history: the proposal's base generation is now stale, so
		// the commit gate would refuse it and the read must not present it as current either.
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!node?.yjsLastSequenceId) {
				throw new Error("Expected the seeded node to have a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", node.yjsLastSequenceId, { lineageGeneration: 1 });
		});

		const afterBump = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/pending-stale-lineage.md",
		});
		expect(afterBump?.content).toBe(seeded.baseMarkdown);
		// The doc keeps its id, so the agent's next write mixes onto it and rebuilds the family.
		expect(afterBump?.pendingUpdateId).not.toBeNull();
	});

	test("both pending branches store LF with the leading BOM dropped", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-lf.txt",
				name: "pending-lf.txt",
				markdown: "base\n",
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Both content branches cross the same request boundary, and the STAGED branch is the one
		// published on save — normalizing only the unstaged row would rewrite whole files on save.
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "\uFEFFsA\r\nsB\rsC\n",
			unstagedMarkdown: "\uFEFFuA\r\nuB\ruC\n",
		});
		expect(upserted._nay).toBeUndefined();

		const branches = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending update doc to exist");
			}
			return await read_pending_row_state_bytes({ ctx, pendingUpdate: row });
		});

		const stagedText = files_yjs_doc_get_text({
			yjsDoc: files_yjs_doc_create_from_array_buffer_update(branches.stagedBytes),
			rootKind: "plain_text",
		});
		const unstagedText = files_yjs_doc_get_text({
			yjsDoc: files_yjs_doc_create_from_array_buffer_update(branches.unstagedBytes),
			rootKind: "plain_text",
		});
		// Each branch asserts separately, so a normalize that covers only one role fails here.
		expect(stagedText._yay).toBe("sA\nsB\nsC\n");
		expect(unstagedText._yay).toBe("uA\nuB\nuC\n");
	});

	test("upsert_file_pending_update writes the paged state family and deletes it with the content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-state-family",
				name: "pending-edits-state-family",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nState family`,
		});
		expect(upserted._nay).toBeUndefined();

		const afterUpsert = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			return {
				row,
				states: await ctx.db.query("files_pending_update_yjs_states").collect(),
				pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			};
		});

		expect(afterUpsert.row?.content).toMatchObject({
			base: { kind: "yjs", lineageGeneration: 0 },
			baseStateId: expect.any(String),
			stagedStateId: expect.any(String),
			unstagedStateId: expect.any(String),
		});

		// One sealed family per role whose page totals reassemble to the recorded sizes (the
		// digest-verified load throws on any mismatch).
		const afterUpsertBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: afterUpsert.row! }),
		);
		expect(afterUpsert.states).toHaveLength(3);
		const stateById = new Map(afterUpsert.states.map((state) => [state._id, state]));
		expect(stateById.get(afterUpsert.row!.content!.baseStateId)).toMatchObject({
			sealed: true,
			lineageGeneration: 0,
			pageCount: 1,
			totalBytes: afterUpsertBytes.baseBytes.byteLength,
			owner: { kind: "active", pendingUpdateId: afterUpsert.row!._id, role: "base" },
		});
		expect(stateById.get(afterUpsert.row!.content!.stagedStateId)).toMatchObject({
			totalBytes: afterUpsertBytes.stagedBytes.byteLength,
			owner: { kind: "active", pendingUpdateId: afterUpsert.row!._id, role: "staged" },
		});
		expect(stateById.get(afterUpsert.row!.content!.unstagedStateId)).toMatchObject({
			totalBytes: afterUpsertBytes.unstagedBytes.byteLength,
			owner: { kind: "active", pendingUpdateId: afterUpsert.row!._id, role: "unstaged" },
		});
		expect(afterUpsert.pages).toHaveLength(3);

		// A second upsert replaces the family: the old one is retired to a cleanup task, and the
		// sweeper drain leaves exactly the new three states.
		const replaced = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nState family replaced`,
		});
		expect(replaced._nay).toBeUndefined();
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		const afterReplace = await t.run(async (ctx) => ({
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
		}));
		expect(afterReplace.states).toHaveLength(3);
		expect(afterReplace.pages).toHaveLength(3);

		// Collapsing the content back to base deletes the doc and its whole state family with it.
		const collapsed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		expect(collapsed._nay).toBeUndefined();
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		const afterCollapse = await t.run(async (ctx) => ({
			row: await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
		}));
		expect(afterCollapse.row).toBeNull();
		expect(afterCollapse.states).toHaveLength(0);
		expect(afterCollapse.pages).toHaveLength(0);
	});

	test("upsert_file_pending_update replaces updates deterministically", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-status",
				name: "pending-edits-status",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nChanged once`;

		const unresolved = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (unresolved._nay) {
			throw new Error(unresolved._nay.message);
		}
		expect(unresolved._yay.pendingUpdate).not.toBeNull();

		const ready = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (ready._nay) {
			throw new Error(ready._nay.message);
		}
		expect(ready._yay.pendingUpdate).not.toBeNull();

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(firstPendingRow).not.toBeNull();

		const readyAgain = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (readyAgain._nay) {
			throw new Error(readyAgain._nay.message);
		}
		expect(readyAgain._yay).toBeNull();

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(secondPendingRow).not.toBeNull();
		expect(secondPendingRow!._id).toBe(firstPendingRow!._id);
		expect(secondPendingRow!.content?.base).toEqual(firstPendingRow!.content?.base);

		const secondPendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: secondPendingRow! }),
		);
		expect(secondPendingRowMarkdownState.stagedMarkdown).toContain("Changed once");
		expect(secondPendingRowMarkdownState.unstagedMarkdown).toContain("Changed once");
		expect(secondPendingRowMarkdownState.stagedMarkdown).toBe(secondPendingRowMarkdownState.unstagedMarkdown);

		const discarded = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay).toBeNull();

		const pendingAfterDiscard = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterDiscard).toBeNull();
	});

	test("upsert_file_pending_update accepts a matching pendingUpdateId hint", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-matching-id-hint",
				name: "pending-edits-matching-id-hint",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nFirst`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing pending doc while testing matching pendingUpdateId hint");
		}

		const secondMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSecond`);
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstPendingRow._id,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(secondPendingRow).not.toBeNull();
		expect(secondPendingRow!._id).toBe(firstPendingRow._id);

		const secondPendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: secondPendingRow! }),
		);
		expect(secondPendingRowMarkdownState.stagedMarkdown).toBe(secondMarkdown);
		expect(secondPendingRowMarkdownState.unstagedMarkdown).toBe(secondMarkdown);
	});

	test("upsert_file_pending_update rejects a stale pendingUpdateId instead of falling back to the current scoped doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-stale-id-fallback",
				name: "pending-edits-stale-id-fallback",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFirst`,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending doc while testing fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCurrent`,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending doc while testing stale fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const staleMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nFallback`);
		const staleUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: stalePendingRow._id,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});
		// The stale id must not fall back to the newer row: the upsert refuses instead of
		// overwriting it with the dead proposal's content.
		expect(staleUpsertResult._nay?.message).toBe("Not found");

		const pendingRowAfterStaleUpsert = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingRowAfterStaleUpsert).not.toBeNull();
		expect(pendingRowAfterStaleUpsert!._id).toBe(currentPendingRow._id);

		const pendingRowAfterStaleUpsertMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRowAfterStaleUpsert! }),
		);
		expect(pendingRowAfterStaleUpsertMarkdownState.unstagedMarkdown).toContain("Current");
	});

	test("upsert_file_pending_update rejects a stale pendingUpdateId after a newer proposal replaced it", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-stale-id-race",
				name: "pending-edits-stale-id-race",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Tab A opens the diff editor on proposal one and holds its id.
		const firstUpserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the stale upsert");
		}

		// Tab B discards proposal one, then the agent creates a NEW proposal on the same file.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal two`,
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRowBefore || !files_pending_update_has_yjs_content(secondRowBefore)) {
			throw new Error("Missing second pending row before the stale upsert lands");
		}
		const secondRowBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowBefore }),
		);

		// Tab A's delayed debounced upsert still carries proposal one's id and stale content.
		const staleMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nStale editor content`);
		const staleUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});
		expect(staleUpsertResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The new proposal must be untouched: same row id, byte-identical branches.
			const secondRowAfter = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!secondRowAfter || !files_pending_update_has_yjs_content(secondRowAfter)) {
				throw new Error("Missing second pending row after the stale upsert");
			}
			expect(secondRowAfter._id).toBe(secondRowBefore._id);
			const secondRowAfterBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowAfter });
			expect(new Uint8Array(secondRowAfterBytes.baseBytes)).toEqual(new Uint8Array(secondRowBytes.baseBytes));
			expect(new Uint8Array(secondRowAfterBytes.stagedBytes)).toEqual(new Uint8Array(secondRowBytes.stagedBytes));
			expect(new Uint8Array(secondRowAfterBytes.unstagedBytes)).toEqual(new Uint8Array(secondRowBytes.unstagedBytes));
		});
	});

	test("upsert_file_pending_update creates a new row when the passed id is dead and no row exists", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-dead-id-create",
				name: "pending-edits-dead-id-create",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstUpserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the discard");
		}

		// The proposal is discarded and NO newer row exists: a retry with the dead id is the
		// normal new-proposal path and must still create.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});

		const retryMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nRetry content`);
		const retried = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: retryMarkdown,
		});
		if (retried._nay) {
			throw new Error(retried._nay.message);
		}

		const rowAfter = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!._id).not.toBe(firstRow._id);
		const rowAfterMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: rowAfter! }),
		);
		expect(rowAfterMarkdownState.unstagedMarkdown).toBe(retryMarkdown);
	});

	test("upsert_file_pending_update keeps staged at base when the agent omits stagedMarkdown", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-new-proposal",
				name: "pending-edits-agent-new-proposal",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
		const agentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: agentMarkdown,
		});
		if (agentUpsertResult._nay) {
			throw new Error(agentUpsertResult._nay.message);
		}
		expect(agentUpsertResult._yay.pendingUpdate).not.toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after creating an agent proposal");
		}

		const pendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRow }),
		);
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(agentMarkdown);
	});

	test("upsert_file_pending_update preserves existing staged changes when the agent omits stagedMarkdown", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-preserve-staged",
				name: "pending-edits-agent-preserve-staged",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nUser staged`);
		const firstAgentMarkdown = normalize_pending_update_markdown(`${stagedMarkdown}\n\nAgent proposal`);
		const stagedPendingUpdateResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedMarkdown,
			unstagedMarkdown: firstAgentMarkdown,
		});
		if (stagedPendingUpdateResult._nay) {
			throw new Error(stagedPendingUpdateResult._nay.message);
		}

		const secondAgentMarkdown = normalize_pending_update_markdown(`${firstAgentMarkdown}\n\nAgent follow up`);
		const secondAgentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: secondAgentMarkdown,
		});
		if (secondAgentUpsertResult._nay) {
			throw new Error(secondAgentUpsertResult._nay.message);
		}
		expect(secondAgentUpsertResult._yay.pendingUpdate).not.toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after the follow-up agent proposal");
		}

		const pendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRow }),
		);
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(stagedMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(secondAgentMarkdown);
	});

	test("upsert_file_pending_update keeps a pending doc for trailing whitespace at EOF", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-trailing-whitespace-eof",
				name: "pending-edits-trailing-whitespace-eof",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const whitespaceMarkdown = seeded.baseMarkdown + " ";
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: whitespaceMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}
		expect(upsertResult._yay.pendingUpdate).not.toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after adding trailing whitespace at EOF");
		}

		const pendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRow }),
		);
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
		// The whitespace lands on its own trailing paragraph and file content always
		// ends with one `\n`, so the read-back shape differs from the raw input.
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe("# Base\n\n \n");
	});

	test("upsert_file_pending_update clears the doc when agent changes collapse to base", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-collapse-to-base",
				name: "pending-edits-agent-collapse-to-base",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
		const firstAgentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: agentMarkdown,
		});
		if (firstAgentUpsertResult._nay) {
			throw new Error(firstAgentUpsertResult._nay.message);
		}

		const discardAgentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discardAgentUpsertResult._nay) {
			throw new Error(discardAgentUpsertResult._nay.message);
		}
		expect(discardAgentUpsertResult._yay.pendingUpdate).toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingRow).toBeNull();
	});

	test("pending update expiry follows the latest pending doc state", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-task",
				name: "pending-edits-cleanup-task",
				markdown: "# Expiry base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nExpiry first`;
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing first pending doc while testing expiry scheduling");
		}

		expect(firstPendingRow.expiresAt).toBe(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const firstCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		if (!firstCheck) {
			throw new Error("Missing the expiry check after the first upsert");
		}
		expect(firstCheck.nextCheckAt).toBe(firstPendingRow.expiresAt);

		await new Promise((resolve) => setTimeout(resolve, 2));

		const secondMarkdown = `${seeded.baseMarkdown}\n\nExpiry second`;
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!secondPendingRow) {
			throw new Error("Missing second pending doc while testing expiry rescheduling");
		}

		// The edit moves the draft's expiry later. The check stays at the earlier time, and when it
		// runs it reschedules itself for the new expiry.
		expect(secondPendingRow.expiresAt).toBe(secondPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(secondPendingRow.expiresAt).toBeGreaterThan(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }))).toEqual(firstCheck);

		const discardResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discardResult._nay) {
			throw new Error(discardResult._nay.message);
		}

		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", secondPendingRow._id))).toBeNull();

		// With no draft left, the next check run deletes the check instead of scheduling again.
		vi.useFakeTimers();
		vi.setSystemTime(firstCheck.nextCheckAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});
		expect(await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }))).toBeNull();
	});

	test("an identical re-upsert refreshes the pending update lifetime", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-identical-ttl",
				name: "pending-edits-identical-ttl",
				markdown: "# Identical TTL base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const unstagedMarkdown = `${seeded.baseMarkdown}\n\nIdentical TTL content`;
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstPendingRow) {
			throw new Error("Missing pending doc while testing identical re-upsert TTL refresh");
		}
		expect(firstPendingRow.expiresAt).toBe(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		await new Promise((resolve) => setTimeout(resolve, 2));

		// The AI re-writes the exact same pending content: the row bytes do not change, but
		// the 4h lifetime must still restart or the old expiry removes the proposal.
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondPendingRow) {
			throw new Error("Missing pending doc after the identical re-upsert");
		}
		expect(secondPendingRow._id).toBe(firstPendingRow._id);
		expect(secondPendingRow.updatedAt).toBeGreaterThan(firstPendingRow.updatedAt);

		expect(secondPendingRow.expiresAt).toBe(secondPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(secondPendingRow.expiresAt).toBeGreaterThan(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
	});

	test("upsert_file_pending_update keeps a new proposal on an archived file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-archived-new-row",
				name: "pending-edits-archived-new-row",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The file is archived between the tool's read and its upsert. The archive only hides
		// the node: a proposal on it still saves, so the upsert is kept.
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.nodeId],
		});
		expect(archived).not.toHaveProperty("_nay");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAfter archive`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const rowAfter = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfter).not.toBeNull();
	});

	test("upsert_file_pending_update keeps an existing row editable on an archived file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-archived-existing-row",
				name: "pending-edits-archived-existing-row",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The row exists before the file is archived.
		const firstUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBefore archive`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing pending row before the archive");
		}

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.nodeId],
		});
		expect(archived).not.toHaveProperty("_nay");

		// The surviving row stays editable on the archived file.
		const editedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAfter archive`);
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: editedMarkdown,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const editedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(editedRow?._id).toBe(firstRow._id);
		const editedRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: editedRow! }),
		);
		expect(editedRowMarkdownState.unstagedMarkdown).toBe(editedMarkdown);

		// The panel's content-discard revert (upsert back to base) still clears the row.
		const reverted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (reverted._nay) {
			throw new Error(reverted._nay.message);
		}
		const rowAfterRevert = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfterRevert).toBeNull();
	});

	test("the upsert action returns a message-only nay when the markdown projection fails", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-upsert-serializer-failure",
				name: "pending-edits-upsert-serializer-failure",
				markdown: "# Upsert serializer failure",
			}),
		);

		// Fail the action's first markdown read with the real producer's cause-carrying shape.
		filesYjsDocGetMarkdownMock.mockReturnValueOnce({
			_nay: {
				name: "nay",
				message: "Error while extracting markdown from Y.Doc",
				cause: new Error("serializer exploded"),
			},
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "Fresh pending content",
		});

		// The `_nay` must stay message-only: an extra `cause` field would fail the action's
		// strict `v_result` returns validator in a real deployment.
		expect(upserted).toEqual({
			_nay: { message: "Failed to apply unstaged text to pending branch" },
		});
	});
});

describe("upsert, discard, move, and restore on a file with collaboration off", () => {
	test("builds the branches from the committed text and records the node's asset as base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-create.md", text: "# Off base" }),
		);
		const unstagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a pending content doc");
			}
			expect(row.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(await read_pending_row_markdown_state({ ctx, pendingUpdate: row })).toEqual({
				baseMarkdown: normalize_pending_update_markdown("# Off base"),
				stagedMarkdown: normalize_pending_update_markdown("# Off base"),
				unstagedMarkdown,
			});

			// The file has no Yjs document, so its states carry no lineage.
			const states = await ctx.db.query("files_pending_update_yjs_states").collect();
			expect(states).toHaveLength(3);
			expect(states.map((state) => state.lineageGeneration)).toEqual([undefined, undefined, undefined]);

			// Pending chunks let the agent's overlay reads see the proposal.
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).not.toHaveLength(0);
		});
	});

	test("a second write on the same base keeps the doc and its base asset", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-second-write.md", text: "# Off base" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const read_row = () =>
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			);

		// The member accepted the first hunk: the staged branch differs from the base. A second
		// write must reuse this branch family, not rebuild it, or the accepted hunk is lost.
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted");
		const first = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted\n\nFirst"),
		});
		expect(first._nay).toBeUndefined();
		const firstRow = await read_row();
		if (!firstRow) {
			throw new Error("Expected a pending content doc after the first write");
		}

		const secondMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted\n\nSecond");
		const second = await upsert_file_pending_update_internal_for_test({
			...ids,
			pendingUpdateId: firstRow._id,
			unstagedMarkdown: secondMarkdown,
		});
		expect(second._nay).toBeUndefined();

		const secondRow = await read_row();
		expect(secondRow?._id).toBe(firstRow._id);
		expect(secondRow?.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		// A rebuild would clone the base into the staged branch and lose the accepted hunk.
		const state = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: secondRow! }));
		expect(state.baseMarkdown).toBe(normalize_pending_update_markdown("# Off base"));
		expect(state.stagedMarkdown).toBe(stagedMarkdown);
		expect(state.unstagedMarkdown).toBe(secondMarkdown);
	});

	test("accepts a client edit on a fresh proposal, the way the pending row does before Accept", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-client-fresh.md", text: "# Off base" }),
		);
		const proposalMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: proposalMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		// The row's Accept first stages every hunk through the anchored public upsert.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const staged = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: row._id,
			reviewedRevision: row.revision,
			stagedMarkdown: proposalMarkdown,
			unstagedMarkdown: proposalMarkdown,
		});
		expect(staged._nay).toBeUndefined();

		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		expect(rowAfter?.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		const state = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: rowAfter! }));
		expect(state.stagedMarkdown).toBe(proposalMarkdown);
		expect(state.unstagedMarkdown).toBe(proposalMarkdown);
	});

	test("refuses a client edit after a member saved the file and leaves the proposal untouched", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-client-stale.md", text: "# Off base" }),
		);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member({ t, seeded, text: "# Off base\n\nMember line" });

		// The client reviewed the doc as it is (`reviewedRevision` matches), so the only refusal
		// left is the stale base.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const edited = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: row._id,
			reviewedRevision: row.revision,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line edited"),
		});
		expect(edited._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		// The stale proposal stays as it was, for Discard.
		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		expect(rowAfter?.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		expect(rowAfter?.updatedAt).toBe(row.updatedAt);
		expect(rowAfter?.content?.unstagedStateId).toBe(row.content?.unstagedStateId);

		// The refusal retired its operation batch, so the next attempt is refused for the same
		// reason, not as a batch that is still in progress.
		const activeBatches = await t.run(
			async (ctx) =>
				(await ctx.db.query("files_pending_update_operation_batches").collect()).filter(
					(batch) => batch.target.kind === "saved" && batch.target.id === seeded.nodeId && (batch.expiresAt === undefined || batch.expiresAt > Date.now()),
				).length,
		);
		expect(activeBatches).toBe(0);
		const editedAgain = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: row._id,
			reviewedRevision: row.revision,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line edited twice"),
		});
		expect(editedAgain._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
	});

	test("direct agent upsert keeps a stale proposal until preparation", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-agent-rebuild.md", text: "# Off base" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};

		const first = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line"),
		});
		expect(first._nay).toBeUndefined();
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member({ t, seeded, text: "# Off base\n\nMember line" });

		const rebuiltMarkdown = normalize_pending_update_markdown("# Off base\n\nMember line\n\nAgent line");
		const second = await upsert_file_pending_update_internal_for_test({
			...ids,
			pendingUpdateId: firstRow._id,
			unstagedMarkdown: rebuiltMarkdown,
		});
		expect(second._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		await t.run(async (ctx) => {
			const row = await ctx.db.get("files_pending_updates", firstRow._id);
			expect(row).toEqual(firstRow);
			// Refusal leaves the retained family active for Review.
			const activeRoles = (await ctx.db.query("files_pending_update_yjs_states").collect())
				.flatMap((state) =>
					state.owner.kind === "active" && state.owner.pendingUpdateId === firstRow._id ? [state.owner.role] : [],
				)
				.sort();
			expect(activeRoles).toEqual(["base", "staged", "unstaged"]);
			expect(await read_pending_row_markdown_state({ ctx, pendingUpdate: firstRow })).toEqual({
				baseMarkdown: normalize_pending_update_markdown("# Off base"),
				stagedMarkdown: normalize_pending_update_markdown("# Off base"),
				unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line"),
			});
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base\n\nMember line");
		});
	});

	test("a version restore keeps the content proposal for preparation", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-restore-preserve.md", text: "# Off base" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		// The first save is the version to restore. The second save is the base of the proposal.
		const versionAssetId = await save_as_member({ t, seeded, text: "# Off base\n\nFirst save" });
		await save_as_member({ t, seeded, text: "# Off base\n\nSecond save" });
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nSecond save\n\nAgent line"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const versionId = await t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("files_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", versionAssetId))
				.first();
			if (!snapshot) {
				throw new Error("Expected the first save to keep a version");
			}
			return snapshot._id;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			snapshotId: versionId,
			sessionId: "restore-preserve",
		});
		expect(restored._nay).toBeUndefined();

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base\n\nFirst save");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual({
				...row,
				revision: row.revision + 1,
				contentNeedsRebase: true,
				contentRebaseRootKind: "rich_text",
			});
		});
	});

	test("the commit refuses a base asset the node no longer has", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-commit-stale.md", text: "# Off base" }),
		);
		const commit = async (expectedAssetId: Id<"files_r2_assets">) => {
			const family = await seal_output_family_for_test(t, seeded);
			const committed = await t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: family.operationBatchId,
				expectedRevision: null,
				base: { kind: "asset", expectedAssetId },
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "# Off base\n\nAgent line",
				unstagedBranchChanged: true,
			});
			// The action retires the batch on a refusal; do the same so the next commit can open one.
			if (committed._nay) {
				await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
					operationBatchId: family.operationBatchId,
				});
			}
			return committed;
		};

		// The action read the seeded asset; a member saved before the commit landed.
		const savedAssetId = await save_as_member({ t, seeded, text: "# Off base\n\nMember line" });
		const stale = await commit(seeded.assetId);
		expect(stale._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);

		// The asset check comes before the mode check: with collaboration turned on in the meantime
		// the agent still reads the stale message, not `Not found`.
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { collaborationEnabled: true }));
		const staleAndCollaborative = await commit(seeded.assetId);
		expect(staleAndCollaborative._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { collaborationEnabled: false }));

		// Positive control: the same commit with the node's current asset lands.
		const fresh = await commit(savedAssetId);
		expect(fresh._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.content?.base).toEqual({ kind: "asset", assetId: savedAssetId });
	});

	test("Discard deletes a stale proposal even when its staged branch differs from base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-discard-stale.md", text: "# Off base" }),
		);

		// The positive control is the first test of `discard_file_pending_content`: a collaborative
		// doc with accepted staged text survives Discard.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted change"),
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted change\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member({ t, seeded, text: "# Off base\n\nMember line" });

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		// The branches are retired to a cleanup task; the sweeper drain deletes them.
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", row._id)).toBeNull();
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toHaveLength(0);
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).toHaveLength(0);
		});
	});

	test("Discard on a stale mixed row keeps the move and drops the content with its base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-discard-stale-mixed.md", text: "# Off base" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		// The staged branch differs from the base, so only the stale rule can collapse the content.
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown: normalize_pending_update_markdown("# Off base\n\nStale staged change"),
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nStale mixed change"),
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-discard-stale-mixed-renamed.md",
		});
		expect(moved._nay).toBeUndefined();
		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...ids }));
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member({ t, seeded, text: "# Off base\n\nMember line" });

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const after = await ctx.db.get("files_pending_updates", row._id);
			expect(after?.pendingMove?.destName).toBe("off-discard-stale-mixed-renamed.md");
			expect(after?.content).toBeUndefined();
			expect(after?.size).toBe(0);
		});
	});

	test("Discard on a stale row with a delete keeps the delete and drops the content", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-discard-stale-delete.md", text: "# Off base" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nStale change"),
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test(ids);
		expect(archived._nay).toBeUndefined();
		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...ids }));
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member({ t, seeded, text: "# Off base\n\nMember line" });

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const after = await ctx.db.get("files_pending_updates", row._id);
			expect(after?.pendingArchive).toEqual(row.pendingArchive);
			expect(after?.content).toBeUndefined();
		});
	});

	test("Discard on a fresh proposal deletes the doc when no hunk was accepted", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-discard-fresh.md", text: "# Off base" }),
		);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		// Staged equals base, so nothing is left to review: the doc goes, like on a collaborative file.
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", row._id)).toBeNull();
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toHaveLength(0);
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).toHaveLength(0);
		});
	});

	test("Discard on a fresh proposal keeps the accepted hunks and drops only the unstaged edits", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-discard-partial.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted change");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted change\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		// The doc stays with its base asset. The unstaged branch is now a copy of the staged one,
		// stored in a new state that carries no lineage, like the other states of this file.
		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		if (!rowAfter) {
			throw new Error("Expected the doc to survive Discard");
		}
		expect(rowAfter.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		expect(rowAfter.content?.stagedStateId).toBe(row.content?.stagedStateId);
		expect(rowAfter.content?.unstagedStateId).not.toBe(row.content?.unstagedStateId);
		const state = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: rowAfter }));
		expect(state.stagedMarkdown).toBe(stagedMarkdown);
		expect(state.unstagedMarkdown).toBe(stagedMarkdown);
		const unstagedState = await t.run((ctx) =>
			ctx.db.get("files_pending_update_yjs_states", rowAfter.content!.unstagedStateId),
		);
		expect(unstagedState?.lineageGeneration).toBeUndefined();
	});

	test("one review publishes a move and non-collaborative content", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-apply-mixed.md", text: "# Off base" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};

		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown: normalize_pending_update_markdown("# Off base\n\nApply mixed change"),
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nApply mixed change"),
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-apply-mixed-renamed.md",
		});
		expect(moved._nay).toBeUndefined();

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const accepted = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/off-apply-mixed-renamed.md");
			expect(await read_committed_text({ ctx, ...seeded })).toBe(
				normalize_pending_update_markdown("# Off base\n\nApply mixed change"),
			);
			expect(await read_pending_update_row({ ctx, ...seeded })).toBeNull();
		});
	});

	test("dropping the content of a mixed row clears the base asset with the branches", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-drop-mixed.md", text: "# Off base" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};

		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nDropped change"),
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-drop-mixed-renamed.md",
		});
		expect(moved._nay).toBeUndefined();

		await t.run(async (ctx) => {
			await files_pending_updates_db_drop_content_for_node(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			});

			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the move to survive as a move-only row");
			}
			expect(row.pendingMove).toBeDefined();
			expect(row.content).toBeUndefined();
		});
	});

	test("builds the base from an empty file, which stores no chunk", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/off-empty.md", text: "" }));
		const unstagedMarkdown = normalize_pending_update_markdown("Agent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a pending content doc");
			}
			expect(row.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
			const state = await read_pending_row_markdown_state({ ctx, pendingUpdate: row });
			expect(state.stagedMarkdown).toBe("");
			expect(state.unstagedMarkdown).toBe(unstagedMarkdown);
		});
	});
});

describe("pending update provenance", () => {
	test("a later copy proposal overwrites the recorded source", async () => {
		const t = test_convex();

		const sourceA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-source-a.md",
				name: "provenance-source-a.md",
				markdown: "# Provenance source A",
			}),
		);
		const sourceB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-source-b.md",
				name: "provenance-source-b.md",
				markdown: "# Provenance source B",
				membership: {
					userId: sourceA.userId,
					organizationId: sourceA.organizationId,
					workspaceId: sourceA.workspaceId,
					membershipId: sourceA.membershipId,
				},
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-dest.md",
				name: "provenance-dest.md",
				markdown: "# Provenance dest base",
				membership: {
					userId: sourceA.userId,
					organizationId: sourceA.organizationId,
					workspaceId: sourceA.workspaceId,
					membershipId: sourceA.membershipId,
				},
			}),
		);

		const firstCopy = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${sourceA.baseMarkdown}\n\nFrom A`,
			copiedFrom: { nodeId: sourceA.nodeId, path: "/provenance-source-a.md" },
		});
		if (firstCopy._nay) {
			throw new Error(firstCopy._nay.message);
		}

		// cp from A, then cp from B onto the same target: the newest intent wins the provenance slot.
		const secondCopy = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${sourceB.baseMarkdown}\n\nFrom B`,
			copiedFrom: { nodeId: sourceB.nodeId, path: "/provenance-source-b.md" },
		});
		if (secondCopy._nay) {
			throw new Error(secondCopy._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		expect(row?.copiedFrom).toEqual({
			target: { kind: "saved", id: sourceB.nodeId },
			path: "/provenance-source-b.md",
		});
	});

	test("an agent content upsert stamps its thread and dedupes across writers", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-stamp.md",
				name: "thread-ids-stamp.md",
				markdown: "# Thread ids stamp base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...seeded }), seed_chat_thread({ ctx, ...seeded })]),
		);

		const firstWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread A`,
			threadId: threadA,
		});
		if (firstWrite._nay) {
			throw new Error(firstWrite._nay.message);
		}
		const rowAfterFirst = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterFirst?.threadIds).toEqual([threadA]);

		const secondWriteSameThread = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread A again`,
			threadId: threadA,
		});
		if (secondWriteSameThread._nay) {
			throw new Error(secondWriteSameThread._nay.message);
		}
		const rowAfterSameThread = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterSameThread?.threadIds).toEqual([threadA]);

		const thirdWriteOtherThread = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread B`,
			threadId: threadB,
		});
		if (thirdWriteOtherThread._nay) {
			throw new Error(thirdWriteOtherThread._nay.message);
		}
		const rowAfterOtherThread = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterOtherThread?.threadIds).toEqual([threadA, threadB]);
	});

	test("an identical re-write from another chat still appends its thread", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-identical.md",
				name: "thread-ids-identical.md",
				markdown: "# Thread ids identical base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...seeded }), seed_chat_thread({ ctx, ...seeded })]),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nSame bytes from both threads`;
		for (const threadId of [threadA, threadB]) {
			const written = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				unstagedMarkdown: changedMarkdown,
				threadId,
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.threadIds).toEqual([threadA, threadB]);
	});

	test("a client upsert preserves the recorded threads", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-client-preserve.md",
				name: "thread-ids-client-preserve.md",
				markdown: "# Thread ids client preserve base",
			}),
		);
		const threadA = await t.run(async (ctx) => seed_chat_thread({ ctx, ...seeded }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent write`,
			threadId: threadA,
		});
		if (agentWrite._nay) {
			throw new Error(agentWrite._nay.message);
		}

		const clientWrite = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nClient edit on top`,
		});
		if (clientWrite._nay) {
			throw new Error(clientWrite._nay.message);
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.threadIds).toEqual([threadA]);
	});

	test("an agent move stamps a fresh row and appends on an existing content row", async () => {
		const t = test_convex();

		const moveOnly = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-move-only.md",
				name: "thread-ids-move-only.md",
				markdown: "# Thread ids move only",
			}),
		);
		const contentThenMove = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-content-move.md",
				name: "thread-ids-content-move.md",
				markdown: "# Thread ids content move",
				membership: {
					userId: moveOnly.userId,
					organizationId: moveOnly.organizationId,
					workspaceId: moveOnly.workspaceId,
					membershipId: moveOnly.membershipId,
				},
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...moveOnly }), seed_chat_thread({ ctx, ...moveOnly })]),
		);

		const freshMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: moveOnly.organizationId,
			workspaceId: moveOnly.workspaceId,
			userId: moveOnly.userId,
			nodeId: moveOnly.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-move-only-renamed.md",
			threadId: threadA,
		});
		if (freshMove._nay) {
			throw new Error(freshMove._nay.message);
		}
		const moveOnlyRow = await t.run((ctx) => read_pending_update_row({ ctx, ...moveOnly }));
		expect(moveOnlyRow?.pendingMove).toBeDefined();
		expect(moveOnlyRow?.threadIds).toEqual([threadA]);

		const contentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: contentThenMove.organizationId,
			workspaceId: contentThenMove.workspaceId,
			userId: contentThenMove.userId,
			nodeId: contentThenMove.nodeId,
			unstagedMarkdown: `${contentThenMove.baseMarkdown}\n\nContent from thread A`,
			threadId: threadA,
		});
		if (contentWrite._nay) {
			throw new Error(contentWrite._nay.message);
		}
		const moveAfterContent = await upsert_file_pending_move_for_test({
			t,
			organizationId: contentThenMove.organizationId,
			workspaceId: contentThenMove.workspaceId,
			userId: contentThenMove.userId,
			nodeId: contentThenMove.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-content-move-renamed.md",
			threadId: threadB,
		});
		if (moveAfterContent._nay) {
			throw new Error(moveAfterContent._nay.message);
		}
		const contentMoveRow = await t.run((ctx) => read_pending_update_row({ ctx, ...contentThenMove }));
		expect(contentMoveRow?.pendingMove).toBeDefined();
		expect(contentMoveRow?.threadIds).toEqual([threadA, threadB]);
	});

	test("a structural discard keeps the recorded threads on the surviving content doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-discard-preserve.md",
				name: "thread-ids-discard-preserve.md",
				markdown: "# Thread ids discard preserve base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...seeded }), seed_chat_thread({ ctx, ...seeded })]),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const contentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nContent from thread A`,
			threadId: threadA,
		});
		if (contentWrite._nay) {
			throw new Error(contentWrite._nay.message);
		}
		const moveWrite = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-discard-preserve-renamed.md",
			threadId: threadB,
		});
		if (moveWrite._nay) {
			throw new Error(moveWrite._nay.message);
		}

		// The client-driven structural discard drops the move but keeps the content doc alive —
		// and with it the recorded contributor set.
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row!)).toBe(true);
		expect(row?.threadIds).toEqual([threadA, threadB]);
	});

	test("an upsert without a thread leaves threadIds unset until an agent write lands", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-unset.md",
				name: "thread-ids-unset.md",
				markdown: "# Thread ids unset base",
			}),
		);
		const threadA = await t.run(async (ctx) => seed_chat_thread({ ctx, ...seeded }));

		const threadlessWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nThreadless write`,
		});
		if (threadlessWrite._nay) {
			throw new Error(threadlessWrite._nay.message);
		}
		const rowAfterThreadless = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterThreadless?.threadIds).toBeUndefined();

		const agentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent write after`,
			threadId: threadA,
		});
		if (agentWrite._nay) {
			throw new Error(agentWrite._nay.message);
		}
		const rowAfterAgent = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterAgent?.threadIds).toEqual([threadA]);
	});
});

describe("pending file chunk docs lifecycle", () => {
	const read_pending_row = async (args: {
		t: ReturnType<typeof test_convex>;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
	}) =>
		await args.t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("userId", args.userId)
						.eq("target.kind", "saved")
						.eq("target.id", args.nodeId),
				)
				.first(),
		);

	test("upsert creates chunks, re-chunks only on unstaged change, and collapse deletes them", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-chunks-upsert",
				name: "pending-chunks-upsert",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nChunk needle one`);
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing chunk creation");
		}
		expect(pendingRow.size).toBe(files_get_utf8_byte_size(firstMarkdown));

		const firstTextChunks = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const firstPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(firstTextChunks.length).toBeGreaterThan(0);
		expect(firstPlainTextChunks).toHaveLength(firstTextChunks.length);
		expect(firstTextChunks.map((chunk) => chunk.textChunk).join("\n")).toContain("Chunk needle one");
		expect(firstPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).toContain("Chunk needle one");
		expect(firstTextChunks[0]).toMatchObject({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: String(seeded.userId),
			target: { kind: "saved", id: seeded.nodeId },
			proposalRevision: pendingRow.revision,
			pendingUpdateId: pendingRow._id,
			sourceKind: "pending",
			chunkIndex: 0,
		});
		expect(firstPlainTextChunks[0]).toMatchObject({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: String(seeded.userId),
			target: { kind: "saved", id: seeded.nodeId },
			proposalRevision: pendingRow.revision,
			pendingUpdateId: pendingRow._id,
			sourceKind: "pending",
			path: "/pending-chunks-upsert",
			chunkIndex: 0,
		});
		expect(new Set(firstTextChunks.map((chunk) => chunk._id))).toContain(firstPlainTextChunks[0]?.textChunkId);
		for (const chunk of firstPlainTextChunks) {
			const textChunk = firstTextChunks.find((candidate) => candidate._id === chunk.textChunkId);
			if (!textChunk) throw new Error("Expected linked text chunk");
			expect(chunk).toMatchObject({
				textChunk: textChunk.textChunk,
				startIndex: textChunk.startIndex,
				endIndex: textChunk.endIndex,
				lineStart: textChunk.lineStart,
				lineEnd: textChunk.lineEnd,
				chunkFlags: textChunk.chunkFlags,
				hasChunkAbove: chunk.chunkIndex > 0,
				hasChunkBelow: chunk.chunkIndex < firstPlainTextChunks.length - 1,
			});
		}

		// Unstaged content changed -> chunk docs are replaced.
		const secondMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nChunk needle two`);
		const secondUpsertResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await read_pending_row({ t, ...seeded });
		if (!secondPendingRow) {
			throw new Error("Missing pending doc while testing chunk replacement");
		}
		expect(secondPendingRow._id).toBe(pendingRow._id);
		expect(secondPendingRow.size).toBe(files_get_utf8_byte_size(secondMarkdown));

		const secondTextChunks = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const secondPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(secondTextChunks.length).toBeGreaterThan(0);
		expect(secondPlainTextChunks).toHaveLength(secondTextChunks.length);
		expect(secondTextChunks.map((chunk) => chunk.textChunk).join("\n")).toContain("Chunk needle two");
		expect(secondTextChunks.map((chunk) => chunk.textChunk).join("\n")).not.toContain("Chunk needle one");
		expect(secondPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).toContain("Chunk needle two");
		expect(secondPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).not.toContain("Chunk needle one");
		const firstTextChunkIds = new Set(firstTextChunks.map((chunk) => chunk._id));
		for (const chunk of secondTextChunks) {
			expect(firstTextChunkIds.has(chunk._id)).toBe(false);
		}
		const firstPlainTextChunkIds = new Set(firstPlainTextChunks.map((chunk) => chunk._id));
		for (const chunk of secondPlainTextChunks) {
			expect(firstPlainTextChunkIds.has(chunk._id)).toBe(false);
		}

		// Staged-only change (Accept all) keeps the unstaged content intact -> chunk doc ids survive.
		const stagedOnlyUpsertResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (stagedOnlyUpsertResult._nay) {
			throw new Error(stagedOnlyUpsertResult._nay.message);
		}

		const stagedOnlyPendingRow = await read_pending_row({ t, ...seeded });
		if (!stagedOnlyPendingRow) {
			throw new Error("Missing pending doc while testing staged-only pending update");
		}
		expect(stagedOnlyPendingRow.size).toBe(secondPendingRow.size);

		const stagedOnlyTextChunks = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const stagedOnlyPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(new Set(stagedOnlyTextChunks.map((chunk) => chunk._id))).toEqual(
			new Set(secondTextChunks.map((chunk) => chunk._id)),
		);
		expect(new Set(stagedOnlyPlainTextChunks.map((chunk) => chunk._id))).toEqual(
			new Set(secondPlainTextChunks.map((chunk) => chunk._id)),
		);

		// Collapse back to base deletes the pending update doc and its chunk docs in the same mutation.
		const collapseResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (collapseResult._nay) {
			throw new Error(collapseResult._nay.message);
		}

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const textChunksAfterCollapse = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterCollapse = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksAfterCollapse).toHaveLength(0);
		expect(plainTextChunksAfterCollapse).toHaveLength(0);
	});

	test("full save deletes the pending chunks with the pending update doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-chunks-full-save",
				name: "pending-chunks-full-save",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved chunk needle`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: resolvedMarkdown,
			unstagedMarkdown: resolvedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing full-save chunk cleanup");
		}
		const textChunksBeforeSave = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksBeforeSave = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksBeforeSave.length).toBeGreaterThan(0);
		expect(plainTextChunksBeforeSave.length).toBeGreaterThan(0);

		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const textChunksAfterSave = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterSave = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksAfterSave).toHaveLength(0);
		expect(plainTextChunksAfterSave).toHaveLength(0);
	});

	test("expiry cleanup deletes the pending chunks with the pending update doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-chunks-expiry",
				name: "pending-chunks-expiry",
				markdown: "# Expiry base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nExpiry chunk needle`,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing expiry chunk cleanup");
		}
		const textChunksBeforeExpiry = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksBeforeExpiry = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksBeforeExpiry.length).toBeGreaterThan(0);
		expect(plainTextChunksBeforeExpiry.length).toBeGreaterThan(0);

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const textChunksAfterExpiry = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterExpiry = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksAfterExpiry).toHaveLength(0);
		expect(plainTextChunksAfterExpiry).toHaveLength(0);
	});
});

describe("expire_file_pending_updates owner activity", () => {
	async function seed_saved_draft(t: ReturnType<typeof test_convex>, path: string) {
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path, name: path.slice(1), markdown: "# Expiry base" }),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}

Expiry pending`,
		});
		if (upserted._nay) throw new Error(upserted._nay.message);
		const scope = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, userId: seeded.userId };
		const read = () =>
			t.run(async (ctx) => {
				const draft = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.nodeId),
					)
					.unique();
				const check = await read_pending_update_expiry_check({ ctx, ...scope });
				const reviewVersion = await ctx.db
					.query("files_pending_review_versions")
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId),
					)
					.unique();
				return { draft, check, reviewVersion: reviewVersion?.revision ?? null };
			});
		return { seeded, asUser, scope, read };
	}

	test("keeps due drafts while an app tab is open, then removes them 4 hours after the last heartbeat", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const { seeded, asUser, scope, read } = await seed_saved_draft(t, "/expiry-active-owner");
		const created = await read();
		if (!created.draft || !created.check) throw new Error("Missing the draft or its expiry check");
		expect(created.draft.expiresAt).toBe(created.draft.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(created.check.nextCheckAt).toBe(created.draft.expiresAt);

		// The tab sends a heartbeat 3 hours later, then the draft's own deadline passes.
		vi.setSystemTime(created.draft.updatedAt + 3 * 60 * 60 * 1000);
		const heartbeat = await asUser.mutation(api.presence.heartbeat, {
			roomId: `expiry-room-${seeded.nodeId}`,
			userId: seeded.userId,
			sessionId: "expiry-session",
			interval: presenceHeartbeatIntervalMs,
		});
		const lastActiveAt = Date.now();
		vi.setSystemTime(created.draft.expiresAt + 1);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);

		const kept = await read();
		expect(kept.draft).toEqual(created.draft);
		expect(kept.reviewVersion).toBe(created.reviewVersion);
		expect(kept.check?.nextCheckAt).toBe(lastActiveAt + files_DRAFT_IDLE_EXPIRY_MS);

		// Closing the tab does not shorten the lifetime.
		await asUser.mutation(api.presence.disconnect, { sessionToken: heartbeat.sessionToken });
		vi.setSystemTime(lastActiveAt + files_DRAFT_IDLE_EXPIRY_MS - 1);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);
		expect((await read()).draft).not.toBeNull();

		vi.setSystemTime(lastActiveAt + files_DRAFT_IDLE_EXPIRY_MS);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);
		const expired = await read();
		expect(expired.draft).toBeNull();
		// No draft is left, so the check deletes itself instead of waking up again.
		expect(expired.check).toBeNull();
	});

	test("removes drafts in a workspace the owner left, even while the owner uses the app", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const { seeded, asUser, scope, read } = await seed_saved_draft(t, "/expiry-left-workspace");
		const created = await read();
		if (!created.draft) throw new Error("Missing the draft");

		vi.setSystemTime(created.draft.expiresAt);
		await asUser.mutation(api.presence.heartbeat, {
			roomId: `expiry-room-${seeded.nodeId}`,
			userId: seeded.userId,
			sessionId: "expiry-session",
			interval: presenceHeartbeatIntervalMs,
		});
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", seeded.membershipId, { active: false }));
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);

		expect((await read()).draft).toBeNull();
	});

	test("a new-session heartbeat does not read or schedule drafts, even with 1,500 of them", async () => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: true });
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/expiry-many-drafts", name: "expiry-many-drafts", markdown: "# Many" }),
		);
		for (let batch = 0; batch < 3; batch++) {
			await t.run(async (ctx) => {
				for (let index = 0; index < 500; index++) {
					await files_db_insert_pending_update(ctx, {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userId: seeded.userId,
						target: { kind: "saved", id: seeded.nodeId },
						revision: 1,
						size: 0,
						updatedAt: Date.now(),
					});
				}
			});
		}

		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		const heartbeat = await asUser.mutation(api.presence.heartbeat, {
			roomId: "expiry-many-drafts-room",
			userId: seeded.userId,
			sessionId: "expiry-many-drafts-session",
			interval: presenceHeartbeatIntervalMs,
		});

		expect(heartbeat.isNewSession).toBe(true);
		const lastActive = await t.run((ctx) =>
			ctx.db
				.query("users_last_active")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique(),
		);
		expect(lastActive?.lastActiveAt).toBe(Date.now());
	});

	test("stops a batch after about one full-size draft, then continues at once", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/expiry-large-drafts", name: "expiry-large-drafts", markdown: "# Large" }),
		);
		const scope = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, userId: seeded.userId };
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 3; index++) {
				// One draft per target, like real data: the overlay reads a user's draft of a target with `unique()`.
				const nodeId =
					index === 0
						? seeded.nodeId
						: await seed_folder_node({ ctx, ...scope, path: `/expiry-large-${index}`, name: `expiry-large-${index}` });
				await files_db_insert_pending_update(ctx, {
					...scope,
					target: { kind: "saved", id: nodeId },
					revision: 1,
					size: files_MAX_TEXT_CONTENT_BYTES,
					updatedAt,
				});
			}
		});

		const dueAt = updatedAt + files_DRAFT_IDLE_EXPIRY_MS;
		vi.setSystemTime(dueAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);

		const after = await t.run(async (ctx) => ({
			drafts: await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_expiresAt", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", scope.userId),
				)
				.collect(),
			check: await read_pending_update_expiry_check({ ctx, ...scope }),
		}));
		expect(after.drafts).toHaveLength(2);
		expect(after.check?.nextCheckAt).toBe(dueAt);
	});
});
