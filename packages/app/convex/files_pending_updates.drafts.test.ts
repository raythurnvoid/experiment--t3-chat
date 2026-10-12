// Copy replies, Save preparation, recovery and upsert tests. Save, review, Move, archive and read-only tests
// are in files_pending_updates.test.ts, files_pending_updates.review.test.ts and
// files_pending_updates.structural.test.ts. Private draft tests are in files_pending_updates.drafts_*.test.ts.
import { RateLimiter } from "@convex-dev/rate-limiter";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_rename_node,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { quotas_db_ensure } from "./quotas.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { files_media_dependencies_db_create, files_media_dependencies_db_seal } from "./files_media_dependencies.ts";
import { files_pending_updates_action_prepare_content } from "./files_pending_updates.ts";
import {
	files_db_patch_pending_update,
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
} from "../shared/files-metadata.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import {
	create_private_text_for_test,
	expire_pending_update_for_test,
	file_save_events,
	list_pending_update_plain_text_chunks,
	list_pending_update_text_chunks,
	mock_pending_updates_storage,
	normalize_pending_update_markdown,
	presenceHeartbeatIntervalMs,
	r2Objects,
	read_pending_review_state_for_test,
	read_pending_row_markdown_state,
	read_pending_row_state_bytes,
	read_pending_update_expiry_check,
	read_pending_update_row,
	read_seeded_pending_row,
	seed_chat_thread,
	seed_file_with_markdown,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	set_pending_test_read_only,
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
