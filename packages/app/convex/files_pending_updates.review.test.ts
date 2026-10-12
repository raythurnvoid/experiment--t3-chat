// Review preparation, rebase and expiry tests, split from files_pending_updates.test.ts so the files can run
// at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_MAX_TEXT_CONTENT_BYTES, files_PENDING_UPDATE_STALE_BASE_MESSAGE } from "../shared/files.ts";
import { files_metadata_MAX_FRONTMATTER_FIELDS } from "../shared/files-metadata.ts";
import { encodeStateAsUpdate } from "yjs";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	build_file_diff_update_from_snapshot,
	expire_pending_update_for_test,
	file_save_events,
	list_pending_update_plain_text_chunks,
	list_pending_update_text_chunks,
	mock_pending_updates_storage,
	persist_file_pending_update_rebased_state_for_test,
	r2Objects,
	read_committed_text,
	read_file_markdown_from_yjs,
	read_file_yjs_state,
	read_pending_row_markdown_state,
	read_pending_row_state_bytes,
	read_pending_update_expiry_check,
	read_pending_update_row,
	read_seeded_pending_row,
	reviewed_pending_for_test,
	save_as_member,
	seal_output_family_for_test,
	seed_billing_snapshot_for_user,
	seed_committed_chunks_for_file,
	seed_file_with_markdown,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	set_pending_test_read_only,
	stage_and_seal_input_family_for_test,
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

describe("prepare_file_pending_update_for_agent upload in flight", () => {
	test("refuses a file whose upload has not landed, then allows it after landing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const ids = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 10,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 60 * 1000,
				updatedAt: now,
			});
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: files_ROOT_ID,
				path: "/uploading.txt",
				treePath: "/uploading.txt",
				pathDepth: 1,
				lowercaseExtension: "txt",
				name: "uploading.txt",
				sortName: files_sort_text_key("uploading.txt"),
				kind: "file",
				contentType: "text/plain",
				assetId,
				contentByteSize: null,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
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
				archiveOperationId: null,
				newChildWritePolicy: null,
			});
			return { assetId, nodeId };
		});

		const args = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved" as const, id: ids.nodeId },
		};
		const refused = await t.action(internal.files_pending_updates.prepare_file_pending_update_for_agent, args);
		expect(refused._nay).toMatchObject({ name: "upload_in_progress" });

		await t.run(async (ctx) => ctx.db.patch("files_r2_assets", ids.assetId, { r2Key: "landed-key" }));
		const allowed = await t.action(internal.files_pending_updates.prepare_file_pending_update_for_agent, args);
		expect(allowed._nay?.name).not.toBe("upload_in_progress");
	});
});

describe("prepare_file_pending_update_for_review after a member save", () => {
	async function seed_stale_proposal(args: {
		base: string;
		staged: string;
		unstaged: string;
		current: string;
		rootKind?: "plain_text" | "rich_text";
	}) {
		const t = test_convex();
		const rootKind = args.rootKind ?? "plain_text";
		const path = rootKind === "rich_text" ? "/saved-proposal.md" : "/saved-proposal.txt";
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: args.base }));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await read_seeded_pending_row(t, seeded);
		const currentAssetId = await save_as_member({ t, seeded, text: args.current });
		expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
		expect(original.contentNeedsRebase).toBeUndefined();
		const prepareArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, currentAssetId, prepareArgs, rootKind };
	}

	test.each(["plain_text", "rich_text"] as const)(
		"merges saved %s text and keeps accepted and proposed changes separate",
		async (rootKind) => {
			const base = "first\n\nsecond\n\nlast\n";
			const staged = base.replace("first", "FIRST");
			const unstaged = staged.replace("second", "SECOND");
			const current = base.replace("last", "LAST");
			const { t, seeded, asUser, original, currentAssetId, prepareArgs } = await seed_stale_proposal({
				base,
				staged,
				unstaged,
				current,
				rootKind,
			});
			await test_drain_billing_usage_event_outbox(t);
			const savesBefore = file_save_events().length;

			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared._id).toBe(original._id);
			expect(prepared.content?.base).toEqual({ kind: "asset", assetId: currentAssetId });
			expect(prepared.content?.baseStateId).not.toBe(original.content?.baseStateId);
			expect(prepared.contentNeedsRebase).toBeUndefined();
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: current,
					stagedMarkdown: staged.replace("last", "LAST"),
					unstagedMarkdown: unstaged.replace("last", "LAST"),
				},
			);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(current);
			await test_drain_billing_usage_event_outbox(t);
			expect(file_save_events()).toHaveLength(savesBefore);

			// A second Review does not replace a family that is already current.
			expect(
				await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs),
			).toEqual(result);

			expect(
				(
					await test_save_file_pending_update(asUser, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(staged.replace("last", "LAST"));
			const remaining = await read_seeded_pending_row(t, seeded);
			expect(
				(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind })))
					.unstagedMarkdown,
			).toBe(unstaged.replace("last", "LAST"));
		},
	);

	test.each(["plain_text", "rich_text"] as const)(
		"keeps accepted and proposed %s text on overlap without publishing it",
		async (rootKind) => {
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base: "old\n",
				staged: "accepted\n",
				unstaged: "proposed\n",
				current: "saved\n",
				rootKind,
			});
			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared._id).toBe(original._id);
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: "saved\n",
					stagedMarkdown: "accepted\n",
					unstagedMarkdown: "proposed\n",
				},
			);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);

	test.each(["plain_text", "rich_text"] as const)(
		"settles already saved %s changes without another file save",
		async (rootKind) => {
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base: "old\n",
				staged: "saved\n",
				unstaged: "saved\n",
				current: "saved\n",
				rootKind,
			});
			await test_drain_billing_usage_event_outbox(t);
			const savesBefore = file_save_events().length;
			expect(
				await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs),
			).toEqual({ _yay: { pendingUpdate: null } });
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", original._id))).toBeNull();
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
			await test_drain_billing_usage_event_outbox(t);
			expect(file_save_events()).toHaveLength(savesBefore);
		},
	);

	test.each(["write", "refresh", "settle"] as const)("refuses a stale %s and preserves the proposal", async (phase) => {
		const { t, seeded, original } = await seed_stale_proposal({
			base: "base\n",
			staged: "base\n",
			unstaged: "proposal\n",
			current: "saved\n",
		});
		const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));

		if (phase === "write") {
			const result = await upsert_file_pending_update_internal_for_test({
				t,
				...seeded,
				pendingUpdateId: original._id,
				unstagedMarkdown: "new proposal\n",
			});
			expect(result._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		} else {
			const batch = await t.mutation(
				internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
				{
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					target: { kind: "saved", id: seeded.nodeId },
				},
			);
			if (batch._nay) throw new Error(batch._nay.message);
			const args = {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: batch._yay.operationBatchId,
				pendingUpdateId: original._id,
				expectedRevision: original.revision,
			};
			const result =
				phase === "refresh"
					? await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, args)
					: await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, args);
			expect(result._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		}

		expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
		expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
	});

	test.each(["changed text", "same text"] as const)(
		"refuses preparation if a second save publishes %s before commit",
		async (secondSave) => {
			const current = "base\n\nsaved\n";
			const { t, seeded, asUser, original, currentAssetId, prepareArgs } = await seed_stale_proposal({
				base: "base\n\nlast\n",
				staged: "BASE\n\nlast\n",
				unstaged: "BASE\n\nlast\n",
				current,
			});
			if (!original.content) throw new Error("Expected content branches");
			const family = await seal_output_family_for_test(t, seeded);
			const nextText = secondSave === "same text" ? current : "base\n\nnewer save\n";
			await save_as_member({ t, seeded, text: nextText });

			const result = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: prepareArgs.pendingUpdateId,
				operationBatchId: family.operationBatchId,
				expectedRevision: original.revision,
				base: { kind: "asset", expectedAssetId: currentAssetId },
				preparation: {
					sourceBaseStateId: original.content.baseStateId,
					sourceStagedStateId: original.content.stagedStateId,
					sourceUnstagedStateId: original.content.unstagedStateId,
					rootKind: "plain_text",
					hasChanges: true,
				},
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "BASE\n\nsaved\n",
			});

			expect(result._nay?.message).toBe(
				"Pending update base is stale and must be rebuilt from the latest live file state",
			);
			expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(nextText);

			// This test calls the final mutation directly. Its owning action retires refused output.
			await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId: family.operationBatchId,
			});
		},
	);

	test.each(["staged", "unstaged"] as const)(
		"keeps a stale proposal when merged %s text exceeds the limit",
		async (branch) => {
			const base = "first\nlast\n";
			const proposed = `${"a".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n${base}`;
			const current = `${base}${"z".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n`;
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base,
				staged: branch === "staged" ? proposed : base,
				unstaged: proposed,
				current,
			});
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));
			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay?.message).toBe(`Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`);
			expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(current);
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);
});

describe("prepare_file_pending_update_for_review", () => {
	async function seed_marked_proposal(args: {
		base: string;
		staged: string;
		unstaged: string;
		current?: string;
		rootKind?: "plain_text" | "rich_text";
		target?: "yjs" | "asset";
		ordinaryMember?: boolean;
	}) {
		const t = test_convex();
		const rootKind = args.rootKind ?? "plain_text";
		const path = rootKind === "rich_text" ? "/prepare.md" : "/prepare.txt";
		const file = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: args.base }));
		const member = args.ordinaryMember
			? await t.run(async (ctx) => {
					const userId = await ctx.db.insert("users", { clerkUserId: "clerk_preparation_member" });
					await seed_billing_snapshot_for_user(ctx, userId);
					const membershipId = await ctx.db.insert("organizations_workspaces_users", {
						organizationId: file.organizationId,
						workspaceId: file.workspaceId,
						userId,
						active: true,
						pendingOrganizationRemoval: false,
						updatedAt: Date.now(),
					});
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: file.organizationId,
						workspaceId: file.workspaceId,
						userId,
						role: "member",
						now: Date.now(),
					});
					return { userId, membershipId };
				})
			: null;
		const seeded = member ? { ...file, ...member } : file;
		r2Objects.set(`content-snapshot${path}`, args.base);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!original) throw new Error("Expected the original proposal");
		if (args.current !== undefined) await save_as_member({ t, seeded, text: args.current });
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: seeded.membershipId,
					nodeId: seeded.nodeId,
				})
			)._nay,
		).toBeUndefined();
		if (args.target === "asset") {
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
		}
		const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", original._id));
		if (!marked) throw new Error("Expected the proposal after the toggle");
		expect(marked.contentNeedsRebase).toBe(true);
		const prepareArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, marked, prepareArgs, rootKind, ownerUserId: file.userId };
	}

	test.each(["staged", "unstaged"] as const)("keeps the proposal when merged %s text exceeds a cap", async (branch) => {
		const fields = (prefix: string) =>
			Array.from(
				{ length: Math.floor(files_metadata_MAX_FRONTMATTER_FIELDS / 2) },
				(_, index) => `${prefix}${index}: value\n`,
			).join("");
		const markdownBase = "---\nfirst: base\nmiddle: base\nlast: base\n---\n\nbody\n";

		for (const fixture of [
			{
				rootKind: "plain_text" as const,
				base: "first\nlast\n",
				proposed: `${"a".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\nfirst\nlast\n`,
				current: `first\nlast\n${"z".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n`,
				message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`,
			},
			{
				rootKind: "rich_text" as const,
				base: markdownBase,
				proposed: markdownBase.replace("first: base\n", `first: base\n${fields("proposed")}`),
				current: markdownBase.replace("last: base\n", `last: base\n${fields("current")}`),
				message: "Too many frontmatter fields",
			},
		]) {
			const { t, seeded, asUser, marked, prepareArgs } = await seed_marked_proposal({
				...fixture,
				staged: branch === "staged" ? fixture.proposed : fixture.base,
				unstaged: fixture.proposed,
				target: "asset",
			});
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }));
			await test_drain_billing_usage_event_outbox(t);
			const eventsBefore = file_save_events().length;

			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay?.message).toBe(fixture.message);

			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }))).toEqual(bytes);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
			await test_drain_billing_usage_event_outbox(t);
			expect(file_save_events()).toHaveLength(eventsBefore);
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches).toHaveLength(1);
			expect(batches[0]?.expiresAt).toBe(0);
		}
	});

	test.each(["plain_text", "rich_text"] as const)(
		"keeps exact %s text across partial save, live edit, and second save",
		async (rootKind) => {
			const base = "title\n\nfirst\n\nsecond\n\nlast\n";
			const staged = base.replace("first", "FIRST");
			const unstaged = staged.replace("second", "SECOND");
			const { t, seeded, asUser, prepareArgs } = await seed_marked_proposal({ base, staged, unstaged, rootKind });

			const prepared = await asUser.action(
				api.files_pending_updates.prepare_file_pending_update_for_review,
				prepareArgs,
			);
			expect(prepared._nay).toBeUndefined();
			const pendingUpdate = prepared._yay?.pendingUpdate;
			if (!pendingUpdate) throw new Error("Expected the prepared proposal");
			expect(pendingUpdate.content?.base).toMatchObject({ kind: "yjs", sequence: 0 });
			expect(pendingUpdate.contentNeedsRebase).toBeUndefined();
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind }))).toEqual({
				baseMarkdown: base,
				stagedMarkdown: staged,
				unstagedMarkdown: unstaged,
			});

			expect(
				(
					await test_save_file_pending_update(asUser, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();
			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(staged);

			const live = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
			const beforeDoc = files_yjs_doc_create_from_array_buffer_update(live.yjsUpdate);
			const editedDoc = files_yjs_doc_clone({ yjsDoc: beforeDoc });
			expect(
				files_yjs_doc_update_from_text({ mut_yjsDoc: editedDoc, text: staged.replace("last", "LAST"), rootKind })._nay,
			).toBeUndefined();
			const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: editedDoc, yjsBeforeDoc: beforeDoc });
			if (!update) throw new Error("Expected the live edit update");
			expect(
				(
					await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
						update: files_u8_to_array_buffer(update),
						sessionId: "preparation-intervening-edit",
					})
				)._nay,
			).toBeUndefined();
			beforeDoc.destroy();
			editedDoc.destroy();

			const remaining = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!remaining) throw new Error("Expected the unaccepted second change");
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...prepareArgs,
						nodeId: prepareArgs.target.id,
						reviewedRevision: remaining.revision,
						stagedMarkdown: unstaged,
						unstagedMarkdown: unstaged,
					})
				)._nay,
			).toBeUndefined();

			expect(
				(
					await test_save_file_pending_update(asUser, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(
				unstaged.replace("last", "LAST"),
			);
			expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();
		},
	);

	test.each([
		{
			name: "disjoint edits",
			base: "a\nb\nc\n",
			staged: "A\nb\nc\n",
			unstaged: "A\nb\nC\n",
			current: "a\nB\nc\n",
			mergedStaged: "A\nB\nc\n",
			mergedUnstaged: "A\nB\nC\n",
		},
		{
			name: "identical overlaps",
			base: "a\nb\n",
			staged: "A\nb\n",
			unstaged: "A\nB\n",
			current: "A\nb\n",
			mergedStaged: "A\nb\n",
			mergedUnstaged: "A\nB\n",
		},
		{
			name: "overlapping Unicode lines with the accepted line kept",
			base: "😀 old\nlast\n",
			staged: "😃 old\nlast\n",
			unstaged: "😃 old\nlast!\n",
			current: "😀 new\nlast\n",
			mergedStaged: "😃 old\nlast\n",
			mergedUnstaged: "😃 old\nlast!\n",
		},
	])("merges $name without publishing text", async (fixture) => {
		const { t, asUser, seeded, prepareArgs } = await seed_marked_proposal({ ...fixture, target: "asset" });
		await test_drain_billing_usage_event_outbox(t);
		const eventsBefore = file_save_events().length;

		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result._nay).toBeUndefined();
		const pendingUpdate = result._yay?.pendingUpdate;
		if (!pendingUpdate) throw new Error("Expected the merged proposal");

		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: fixture.current,
			stagedMarkdown: fixture.mergedStaged,
			unstagedMarkdown: fixture.mergedUnstaged,
		});
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test.each([
		{ base: "old\n", staged: "proposal\n", unstaged: "proposal\n", current: "other\n" },
		{ base: "start end\n", staged: "start Aend\n", unstaged: "start Aend\n", current: "start Bend\n" },
	])("keeps the proposed line on an overlap ($base)", async (fixture) => {
		const { t, seeded, asUser, prepareArgs } = await seed_marked_proposal({ ...fixture, target: "asset" });
		await test_drain_billing_usage_event_outbox(t);
		const eventsBefore = file_save_events().length;
		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result._nay).toBeUndefined();
		const pendingUpdate = result._yay?.pendingUpdate;
		if (!pendingUpdate) throw new Error("Expected the prepared proposal");
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: fixture.current,
			stagedMarkdown: fixture.staged,
			unstagedMarkdown: fixture.unstaged,
		});
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches).toHaveLength(0);
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test("settles an identical proposal without a file save", async () => {
		const { t, asUser, prepareArgs } = await seed_marked_proposal({
			base: "old\n",
			staged: "new\n",
			unstaged: "new\n",
			current: "new\n",
		});
		await test_drain_billing_usage_event_outbox(t);
		const eventsBefore = file_save_events().length;
		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result).toEqual({ _yay: { pendingUpdate: null } });
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", prepareArgs.pendingUpdateId))).toBeNull();
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test("refuses direct writes before preparation and from an old pane after preparation", async () => {
		const { t, asUser, marked, prepareArgs } = await seed_marked_proposal({
			base: "base\n",
			staged: "base\n",
			unstaged: "proposed\n",
		});
		const oldWrite = {
			...prepareArgs,
			nodeId: prepareArgs.target.id,
			reviewedRevision: marked.revision,
			stagedMarkdown: "proposed\n",
			unstagedMarkdown: "proposed\n",
		};
		expect((await upsert_file_pending_update_public_for_test(asUser, oldWrite))._nay?.message).toContain(
			"Update the proposal",
		);
		expect(
			(
				await test_save_file_pending_update(asUser, {
					...prepareArgs,
					...(await reviewed_pending_for_test(t, prepareArgs)),
				})
			)._nay?.message,
		).toContain("Update the proposal");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);
		const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(prepared._nay).toBeUndefined();
		expect((await upsert_file_pending_update_public_for_test(asUser, oldWrite))._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(prepared._yay?.pendingUpdate);
	});

	test.each([
		"live edit",
		"no-change live edit",
		"mode cycle",
		"discard",
		"replacement proposal",
		"lock",
		"membership loss",
		"write access loss",
	] as const)("refuses a %s while preparation is in flight", async (race) => {
		const noChange = race === "no-change live edit";
		const { t, asUser, seeded, marked, prepareArgs, ownerUserId } = await seed_marked_proposal({
			base: "base\n",
			staged: "proposal\n",
			unstaged: "proposal\n",
			current: noChange ? "proposal\n" : undefined,
			ordinaryMember: race === "write access loss",
		});

		const normalFetch = globalThis.fetch;
		let release: (() => void) | undefined;
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		let announce: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announce?.();
					await paused;
				}
				return await normalFetch(input, init);
			}),
		);

		const preparing = asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		await started;

		let replacementId: Id<"files_pending_updates"> | undefined;
		try {
			if (race === "mode cycle") {
				const beforePointers = await test_get_file_yjs_pointers(t, seeded.nodeId);
				expect(
					(
						await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							acknowledgeDropCollaborativeHistory: true,
						})
					)._nay,
				).toBeUndefined();
				expect(
					(
						await asUser.action(api.files_nodes_content.set_file_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
						})
					)._nay,
				).toBeUndefined();
				expect((await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId).not.toBe(
					beforePointers.yjsLastSequenceId,
				);
			} else if (race === "discard" || race === "replacement proposal") {
				expect(
					(
						await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
							...prepareArgs,
							...(await reviewed_pending_for_test(t, prepareArgs)),
						})
					)._nay,
				).toBeUndefined();
				if (race === "replacement proposal") {
					// A stalled preparation can lose its batch to the existing idle takeover.
					vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 1000 + 1);
					expect(
						(
							await upsert_file_pending_update_public_for_test(asUser, {
								membershipId: seeded.membershipId,
								nodeId: seeded.nodeId,
								unstagedMarkdown: "replacement\n",
							})
						)._nay,
					).toBeUndefined();
					replacementId = (await t.run((ctx) => read_pending_update_row({ ctx, ...seeded })))?._id;
					expect(replacementId).not.toBe(marked._id);
				}
			} else if (race === "lock") {
				await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
			} else if (race === "membership loss") {
				await t.run((ctx) => ctx.db.delete("organizations_workspaces_users", seeded.membershipId));
			} else if (race === "write access loss") {
				const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: ownerUserId, name: "Owner" });
				expect(
					(
						await asOwner.mutation(api.access_control.set_user_role, {
							organizationId: seeded.organizationId,
							workspaceId: seeded.workspaceId,
							userId: seeded.userId,
							role: "viewer",
						})
					)._nay,
				).toBeUndefined();
			} else {
				const state = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
				const before = files_yjs_doc_create_from_array_buffer_update(state.yjsUpdate);
				const after = files_yjs_doc_clone({ yjsDoc: before });
				expect(
					files_yjs_doc_update_from_text({ mut_yjsDoc: after, rootKind: "plain_text", text: "newer live text\n" })._nay,
				).toBeUndefined();
				const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: after, yjsBeforeDoc: before });
				if (!update) throw new Error("Expected the intervening live edit");
				expect(
					(
						await asUser.mutation(api.files_nodes.yjs_push_update, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
							update: files_u8_to_array_buffer(update),
							sessionId: "preparation-race",
						})
					)._nay,
				).toBeUndefined();
				before.destroy();
				after.destroy();
			}
		} finally {
			release?.();
		}

		const result = await preparing;
		expect(result._nay).toBeDefined();
		if (race === "lock") expect(result._nay?.name).toBe("read_only");
		if (race === "membership loss") expect(result._nay?.message).toBe("Unauthorized");
		if (race === "write access loss") expect(result._nay?.message).toBe("Permission denied");
		if (race === "discard" || race === "replacement proposal") {
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toBeNull();
			if (replacementId)
				expect(
					(await t.run((ctx) => ctx.db.get("files_pending_updates", replacementId)))?.contentNeedsRebase,
				).toBeUndefined();
		} else expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);

		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches).toHaveLength(1);
		expect(batches[0]?.expiresAt).toBe(0);
	});

	test.each(["plain_text", "rich_text"] as const)(
		"keeps and prepares a %s proposal after turning collaboration off",
		async (rootKind) => {
			const t = test_convex();
			const seeded = await t.run(async (ctx) => {
				const file = await seed_signed_in_file_with_markdown({
					ctx,
					path: "/prepare-off",
					name: "prepare-off",
					markdown: "base\n",
					rootKind,
				});
				await seed_committed_chunks_for_file({ ctx, ...file, path: "/prepare-off", markdown: file.baseMarkdown });
				return file;
			});
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });

			const proposed = "base\n\nproposed\n";
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...seeded,
						stagedMarkdown: proposed,
						unstagedMarkdown: proposed,
					})
				)._nay,
			).toBeUndefined();

			const before = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!before) throw new Error("Expected the proposal before turning collaboration off");
			const beforeBytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: before }));

			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
			const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", before._id));
			expect(marked).toMatchObject({ ...before, revision: before.revision + 1, contentNeedsRebase: true });
			if (!marked) throw new Error("Expected the proposal to survive the toggle");
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }))).toEqual(beforeBytes);

			const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: before._id,
			});
			expect(prepared._nay).toBeUndefined();
			expect(prepared._yay?.pendingUpdate).toMatchObject({ _id: before._id });
			expect(prepared._yay?.pendingUpdate?.contentNeedsRebase).toBeUndefined();
			expect(prepared._yay?.pendingUpdate?.content?.base).toEqual({ kind: "asset", assetId: expect.any(String) });

			expect(
				(
					await test_save_file_pending_update(asUser, {
						membershipId: seeded.membershipId,
						target: { kind: "saved", id: seeded.nodeId },
						...(await reviewed_pending_for_test(t, {
							membershipId: seeded.membershipId,
							target: { kind: "saved", id: seeded.nodeId },
							pendingUpdateId: before._id,
						})),
						pendingUpdateId: before._id,
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(proposed);
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", before._id))).toBeNull();
		},
	);
});

describe("persist_file_pending_update_rebased_state", () => {
	test("persist_file_pending_update_rebased_state stores the rebased doc as the new authoritative pending state", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-rebased",
				name: "pending-edits-persist-rebased",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const remoteMarkdown = `${seeded.baseMarkdown}\n\nRemote drift`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: remoteMarkdown,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);

		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${remoteMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to create unstaged rebased branch while testing pending update persistence");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}
		if (!persistResult._yay || !("pendingUpdate" in persistResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update row");
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();
		expect(persistResult._yay.pendingUpdate!.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });

		const pendingAfterPersist = await t.run(async (ctx) =>
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
		expect(pendingAfterPersist).not.toBeNull();

		const pendingAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingAfterPersist! }),
		);
		expect(pendingAfterPersistMarkdownState.baseMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.stagedMarkdown).toBe(pendingAfterPersistMarkdownState.baseMarkdown);
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Unresolved only");
	});

	test("persist_file_pending_update_rebased_state rejects a mismatched pendingUpdateId from another file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) => {
			const fileA = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-a",
				name: "pending-edits-persist-mismatch-a",
				markdown: "# File A",
			});
			const fileB = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-b",
				name: "pending-edits-persist-mismatch-b",
				markdown: "# File B",
				membership: fileA,
			});

			return {
				membershipId: fileA.membershipId,
				organizationId: fileA.organizationId,
				workspaceId: fileA.workspaceId,
				userId: fileA.userId,
				fileAId: fileA.nodeId,
				fileABaseMarkdown: fileA.baseMarkdown,
				fileBId: fileB.nodeId,
				fileBBaseMarkdown: fileB.baseMarkdown,
			};
		});
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
			nodeId: seeded.fileAId,
			stagedMarkdown: seeded.fileABaseMarkdown,
			unstagedMarkdown: `${seeded.fileABaseMarkdown}\n\nFile A current`,
		});
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileBId,
			stagedMarkdown: seeded.fileBBaseMarkdown,
			unstagedMarkdown: `${seeded.fileBBaseMarkdown}\n\nFile B current`,
		});

		const [fileAPendingRow, fileBPendingRow] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileBId),
					)
					.first(),
			]),
		);
		if (!fileAPendingRow || !fileBPendingRow) {
			throw new Error("Missing pending docs while testing mismatched rebase pendingUpdateId");
		}

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.fileAId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.fileABaseMarkdown}\n\nFile A rebased`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build rebased branch while testing mismatched pendingUpdateId");
		}

		// The synced id must match the row the mutation resolves: a foreign id means the
		// client's view is stale, so the persist refuses instead of patching either row.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.fileAId,
			pendingUpdateId: fileBPendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		const [fileAPendingRowAfterPersist, fileBPendingRowAfterPersist] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileBId),
					)
					.first(),
			]),
		);
		expect(fileAPendingRowAfterPersist).not.toBeNull();
		expect(fileAPendingRowAfterPersist!._id).toBe(fileAPendingRow._id);
		expect(fileBPendingRowAfterPersist).not.toBeNull();

		const fileAPendingRowAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: fileAPendingRowAfterPersist! }),
		);
		expect(fileAPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File A current");

		const fileBPendingRowAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: fileBPendingRowAfterPersist! }),
		);
		expect(fileBPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File B current");
	});

	test("persist_file_pending_update_rebased_state clears the pending doc when the rebased branches match the live base", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-clear",
				name: "pending-edits-persist-clear",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const clearResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: latestFileState.yjsUpdate,
		});
		if (clearResult._nay) {
			throw new Error(clearResult._nay.message);
		}
		if (!clearResult._yay || !("pendingUpdate" in clearResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update result");
		}
		expect(clearResult._yay.pendingUpdate).toBeNull();

		const pendingAfterClear = await t.run(async (ctx) =>
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
		expect(pendingAfterClear).toBeNull();
	});

	test("persist_file_pending_update_rebased_state rejects stale live bases", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale",
				name: "pending-edits-persist-stale",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const staleFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const stalePersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: staleFileState.yjsSequence,
			baseYjsUpdate: staleFileState.yjsUpdate,
			stagedBranchYjsUpdate: staleFileState.yjsUpdate,
			unstagedBranchYjsUpdate: staleFileState.yjsUpdate,
		});
		expect(stalePersistResult._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);
	});

	test("persist_file_pending_update_rebased_state does not recreate a discarded row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-discarded",
				name: "pending-edits-persist-discarded",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Another tab discards the proposal while this tab's sync is in flight.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", pendingRow._id),
			]);
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build stale sync branch while testing the discarded row");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The discarded proposal must stay dead: no row and no pending chunks reappear.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
			const textChunks = await ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(textChunks.filter((chunk) => chunk.sourceKind === "pending")).toHaveLength(0);
		});
	});

	test("persist_file_pending_update_rebased_state does not patch a newer proposal on the same file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-replaced",
				name: "pending-edits-persist-replaced",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
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
			throw new Error("Missing first pending row before the in-flight sync");
		}

		// Another tab discards the first proposal, then the agent creates a NEW proposal on
		// the same file while this tab's sync is still in flight.
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
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent proposal two`,
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
			throw new Error("Missing second pending row before the stale sync lands");
		}
		const secondRowUnstagedBytes = (
			await t.run(async (ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowBefore }))
		).unstagedBytes;

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build stale sync branch while testing the replaced row");
		}

		// The stale sync still carries the FIRST row's id and branches.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The new proposal must be untouched: same row id, same unstaged branch bytes.
			const secondRowAfter = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!secondRowAfter || !files_pending_update_has_yjs_content(secondRowAfter)) {
				throw new Error("Missing second pending row after the stale sync");
			}
			expect(secondRowAfter._id).toBe(secondRowBefore._id);
			const secondRowAfterBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowAfter });
			expect(new Uint8Array(secondRowAfterBytes.unstagedBytes)).toEqual(new Uint8Array(secondRowUnstagedBytes));
		});
	});

	test("commit_file_pending_update_rebase_in_db rejects a stale base after a save advanced the row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale-base",
				name: "pending-edits-persist-stale-base",
				markdown: "# Persist stale base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Tab A's sync action reads this live base before tab B's save lands.
		const originalFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		// Tab B's partial save rebases the row to the new sequence with fresh unresolved content.
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
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing the stale persist base");
		}
		expect(saveResult._yay.newSequence).toBe(1);

		const rowAfterSave = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowAfterSave || !files_pending_update_has_yjs_content(rowAfterSave)) {
			throw new Error("Missing rebased pending row after the save");
		}
		expect(rowAfterSave.content.base).toMatchObject({ kind: "yjs", sequence: 1 });
		const rowAfterSaveBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: rowAfterSave }),
		);

		// Tab A's delayed commit still carries branches rebased onto the OLD captured base.
		const staleBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(originalFileState.yjsUpdate);
		const staleUnstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: staleBaseYjsDoc,
		});
		const staleUnstagedProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: staleUnstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nStale sync content`,
		});
		if (staleUnstagedProjection._nay) {
			throw new Error("Failed to build the stale sync branch while testing the stale persist base");
		}

		const staleFamily = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: originalFileState.yjsUpdate,
			stagedBranchYjsUpdate: originalFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(staleUnstagedBranchYjsDoc)),
		});
		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.commit_file_pending_update_rebase_in_db,
			{
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: pendingRow._id,
				operationBatchId: staleFamily.operationBatchId,
				expectedRevision: rowAfterSave.revision,
				base: {
					kind: "yjs",
					baseYjsSequence: originalFileState.yjsSequence,
					baseLineageGeneration: 0,
					expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
				},
				baseStateId: staleFamily.base.stateId,
				stagedStateId: staleFamily.staged.stateId,
				unstagedStateId: staleFamily.unstaged.stateId,
				baseStateDigest: staleFamily.base.digest,
				stagedStateDigest: staleFamily.staged.digest,
				unstagedStateDigest: staleFamily.unstaged.digest,
				unstagedText: `${seeded.baseMarkdown}\n\nStale sync content`,
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Stale save");

		await t.run(async (ctx) => {
			// The post-save row must be untouched: same base sequence and branch bytes.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row || !files_pending_update_has_yjs_content(row)) {
				throw new Error("Missing pending row after the stale persist");
			}
			expect(row.content.base).toMatchObject({ kind: "yjs", sequence: 1 });
			const rowBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: row });
			expect(new Uint8Array(rowBytes.baseBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.baseBytes));
			expect(new Uint8Array(rowBytes.stagedBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.stagedBytes));
			expect(new Uint8Array(rowBytes.unstagedBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.unstagedBytes));
		});
	});

	test("commit_file_pending_update_rebase_in_db does not resurrect content on a row degraded to a pure move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-degraded.md",
				name: "pending-edits-persist-degraded.md",
				markdown: "# Persist degraded base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nMixed content`,
		});
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-edits-persist-degraded-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const mixedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!mixedRow || !files_pending_update_has_yjs_content(mixedRow)) {
			throw new Error("Missing mixed pending row before the revert");
		}
		const capturedBaseYjsSequence = mixedRow.content.base.sequence;
		const capturedBytes = await t.run(async (ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: mixedRow }));

		// Another tab reverts the content: the row degrades to a pure move with no yjs fields.
		const reverted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (reverted._nay) {
			throw new Error(reverted._nay.message);
		}
		const degradedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(degradedRow?._id).toBe(mixedRow._id);
		expect(degradedRow?.content).toBeUndefined();

		// The in-flight sync still carries the reverted content branches with the old captured base.
		const staleFamily = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: capturedBytes.baseBytes,
			stagedBranchYjsUpdate: capturedBytes.stagedBytes,
			unstagedBranchYjsUpdate: capturedBytes.unstagedBytes,
		});
		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.commit_file_pending_update_rebase_in_db,
			{
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: mixedRow._id,
				operationBatchId: staleFamily.operationBatchId,
				expectedRevision: mixedRow.revision,
				base: {
					kind: "yjs",
					baseYjsSequence: capturedBaseYjsSequence,
					baseLineageGeneration: 0,
					expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
				},
				baseStateId: staleFamily.base.stateId,
				stagedStateId: staleFamily.staged.stateId,
				unstagedStateId: staleFamily.unstaged.stateId,
				baseStateDigest: staleFamily.base.digest,
				stagedStateDigest: staleFamily.staged.digest,
				unstagedStateDigest: staleFamily.unstaged.digest,
				unstagedText: `${seeded.baseMarkdown}\n\nMixed content`,
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The pure-move row must stay content-free: resurrecting the branches would revive
			// a proposal the user already reverted.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?._id).toBe(mixedRow._id);
			expect(row?.pendingMove?.destName).toBe("pending-edits-persist-degraded-dest.md");
			expect(row?.content).toBeUndefined();
		});
	});

	test("an identical persist refreshes the pending update lifetime", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-identical-ttl",
				name: "pending-edits-persist-identical-ttl",
				markdown: "# Persist identical TTL base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build the unstaged branch while testing identical persist TTL refresh");
		}
		const persistArgs = {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		};

		const firstPersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, persistArgs);
		if (firstPersistResult._nay) {
			throw new Error(firstPersistResult._nay.message);
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
			throw new Error("Missing pending row after the first persist");
		}
		expect(firstRow.expiresAt).toBe(firstRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		await new Promise((resolve) => setTimeout(resolve, 2));

		// A retried sync persists the exact same bytes: the row content does not change, but
		// the 4h lifetime must still restart or the old expiry removes the proposal.
		const secondPersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, persistArgs);
		if (secondPersistResult._nay) {
			throw new Error(secondPersistResult._nay.message);
		}
		if (!secondPersistResult._yay || !("pendingUpdate" in secondPersistResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update row");
		}
		expect(secondPersistResult._yay.pendingUpdate).not.toBeNull();

		const secondRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRow) {
			throw new Error("Missing pending row after the identical persist");
		}
		expect(secondRow._id).toBe(firstRow._id);
		expect(secondRow.updatedAt).toBeGreaterThan(firstRow.updatedAt);

		expect(secondRow.expiresAt).toBe(secondRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(secondRow.expiresAt).toBeGreaterThan(firstRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
	});

	test("persist_file_pending_update_rebased_state returns a message-only nay when branch comparison fails", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-poisoned-branch",
				name: "pending-edits-persist-poisoned-branch",
				markdown: "# Persist poisoned branch",
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
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nPending chunk`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow || !files_pending_update_has_yjs_content(pendingRow)) {
			throw new Error("Missing pending row content before the failing persist");
		}
		const pendingRowBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: pendingRow }),
		);

		// Stage and seal valid inputs first: the seal reads markdown too, and the mock below must
		// fail the ACTION's first comparison read instead.
		const family = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: pendingRowBytes.baseBytes,
			stagedBranchYjsUpdate: pendingRowBytes.stagedBytes,
			unstagedBranchYjsUpdate: pendingRowBytes.unstagedBytes,
		});

		// Fail the action's first markdown read with the real producer's cause-carrying shape.
		filesYjsDocGetMarkdownMock.mockReturnValueOnce({
			_nay: {
				name: "nay",
				message: "Error while extracting markdown from Y.Doc",
				cause: new Error("serializer exploded"),
			},
		});

		const persisted = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			operationBatchId: family.operationBatchId,
			baseYjsSequence: pendingRow.content.base.sequence,
		});

		// The `_nay` must stay message-only: an extra `cause` field would fail the action's
		// strict `v_result` returns validator in a real deployment.
		expect(persisted).toEqual({
			_nay: { message: "Failed to compare rebased pending update branches with base" },
		});
	});
});

describe("expire_file_pending_updates saved drafts", () => {
	test("a check at the old expiry keeps a draft that a newer edit moved later", async () => {
		vi.useFakeTimers();
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-stale",
				name: "pending-edits-cleanup-stale",
				markdown: "# Cleanup stale base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending first`;
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
		if (!firstPendingRow?.expiresAt) {
			throw new Error("Missing first pending doc while testing stale expiry");
		}

		vi.setSystemTime(Date.now() + 60_000);

		const secondMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending second`;
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		// The check was scheduled for the first expiry. The newer edit moved the draft's expiry later,
		// so this run keeps the draft and waits for the new expiry.
		vi.setSystemTime(firstPendingRow.expiresAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});

		const pendingAfterStaleCleanup = await t.run(async (ctx) =>
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
		expect(pendingAfterStaleCleanup?._id).toBe(firstPendingRow._id);
		expect(pendingAfterStaleCleanup?.expiresAt).toBe(pendingAfterStaleCleanup!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(pendingAfterStaleCleanup?.expiresAt).toBeGreaterThan(firstPendingRow.expiresAt);
		const check = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(check?.nextCheckAt).toBe(pendingAfterStaleCleanup?.expiresAt);
	});

	test("expire_file_pending_updates deletes due saved drafts and then its check", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-expired",
				name: "pending-edits-cleanup-expired",
				markdown: "# Cleanup expired base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nCleanup expired`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

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
			throw new Error("Missing pending doc while testing expired cleanup");
		}

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		const pendingAfterCleanup = await t.run(async (ctx) =>
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
		expect(pendingAfterCleanup).toBeNull();
		expect(await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }))).toBeNull();
	});
});

describe("membership scoped pending updates", () => {
	test("pending update APIs reject cross-user membership ids", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-membership-unauthorized",
				name: "pending-edits-membership-unauthorized",
				markdown: "# Base",
			}),
		);

		const otherUserId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: null,
			}),
		);
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: otherUserId,
			name: "Other User",
		});

		const unauthorizedUpsert = await upsert_file_pending_update_public_for_test(asOtherUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnauthorized`,
		});
		if (!unauthorizedUpsert._nay) {
			throw new Error("Expected upsert_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedUpsert._nay.message).toBe("Unauthorized");

		const unauthorizedPending = await asOtherUser.query(api.ai_chat.get_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(unauthorizedPending).toBeNull();

		const unauthorizedLastSaved = await asOtherUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(unauthorizedLastSaved).toBeNull();

		const proposalId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);
		const unauthorizedSave = await test_save_file_pending_update(asOtherUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: proposalId,
			reviewedRevision: 1,
		});
		if (!unauthorizedSave._nay) {
			throw new Error("Expected save_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedSave._nay.message).toBe("Unauthorized");

		const unauthorizedPersist = await persist_file_pending_update_rebased_state_for_test(asOtherUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate: new ArrayBuffer(0),
			stagedBranchYjsUpdate: new ArrayBuffer(0),
			unstagedBranchYjsUpdate: new ArrayBuffer(0),
		});
		if (!unauthorizedPersist._nay) {
			throw new Error("Expected persist_file_pending_update_rebased_state to reject cross-user membership");
		}
		expect(unauthorizedPersist._nay.message).toBe("Unauthorized");
	});
});
