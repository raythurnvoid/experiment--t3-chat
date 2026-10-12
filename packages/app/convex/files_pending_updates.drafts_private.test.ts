// Private draft tests: chains, folder replacement, names and storage, then collaboration-off, provenance,
// chunk and expiry tests. Preparation and replacement tests are in files_pending_updates.drafts_replace.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_apply_file_pending_move,
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_pending_updates_db_drop_content_for_node } from "./files_pending_updates.ts";
import {
	files_db_get_pending_update,
	files_db_insert_pending_update,
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
} from "../server/files.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_PENDING_UPDATE_STALE_BASE_MESSAGE,
} from "../shared/files.ts";
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

describe("private pending text", () => {
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
