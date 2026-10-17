// Move, archive, delete, structural row and read-only tests, split from files_pending_updates.test.ts so the
// files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_finish_saved_scope_jobs,
	test_apply_file_pending_move,
	test_convex,
	test_rename_node,
	test_move_nodes,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import {
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import { files_yjs_doc_clone, files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import {
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_get_utf8_byte_size,
	files_pending_update_index_revision,
} from "../shared/files.ts";
import { Doc as YDoc, XmlElement as YXmlElement, encodeStateAsUpdate, encodeStateAsUpdateV2 } from "yjs";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	build_file_diff_update_from_snapshot,
	create_private_text_for_test,
	expect_consumed_pending_content_cleanup_for_test,
	expire_pending_update_for_test,
	list_pending_update_plain_text_chunks,
	list_pending_update_text_chunks,
	mock_pending_updates_storage,
	normalize_pending_update_markdown,
	persist_file_pending_update_rebased_state_for_test,
	r2Objects,
	read_committed_text,
	read_file_markdown_from_yjs,
	read_file_yjs_state,
	read_pending_review_state_for_test,
	read_pending_row_markdown_state,
	read_pending_update_expiry_check,
	read_pending_update_row,
	read_seeded_pending_row,
	reviewed_pending_for_test,
	save_pending_review_for_test,
	seal_output_family_for_test,
	seed_billing_snapshot_for_user,
	seed_chat_thread,
	seed_committed_chunks_for_file,
	seed_file_with_markdown,
	seed_folder_node,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	set_pending_test_read_only,
	set_pending_test_writable,
	stage_and_seal_input_family_for_test,
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

describe("upsert_file_pending_move_in_db", () => {
	test("creates a pure-move row and replaces the proposal on a second mv", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-upsert-src.md",
				name: "move-upsert-src.md",
				markdown: "# Move upsert base",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-upsert-dest",
				name: "move-upsert-dest",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "moved.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay).toEqual({
			fromPath: "/move-upsert-src.md",
			destPath: "/move-upsert-dest/moved.md",
			replacesExistingOccupant: false,
			cancelledExistingMove: false,
			appliedImmediately: false,
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
			throw new Error("Missing pending row after move upsert");
		}
		expect(pendingRow.pendingMove).toEqual({
			destParent: { kind: "saved", id: destFolderId },
			destName: "moved.md",
			fromPath: "/move-upsert-src.md",
		});
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(false);
		expect(pendingRow.size).toBe(0);

		expect(pendingRow.expiresAt).toBe(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const expiryCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(expiryCheck?.nextCheckAt).toBeLessThanOrEqual(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		const replaced = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}

		const replacedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(replacedRow?._id).toBe(pendingRow._id);
		expect(replacedRow?.pendingMove?.destName).toBe("renamed.md");
	});

	test("a rename may change the extension because the stored type stays", async () => {
		const t = test_convex();

		// Direct mutation calls stand in for any future caller that skips the bash command's own
		// checks: the proposal mutation itself must not judge the name against the type.
		const markdownSeeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/typed-rich.md",
				name: "typed-rich.md",
				markdown: "# Typed rich",
			}),
		);
		const renamedToJson = await upsert_file_pending_move_for_test({
			t,
			organizationId: markdownSeeded.organizationId,
			workspaceId: markdownSeeded.workspaceId,
			userId: markdownSeeded.userId,
			nodeId: markdownSeeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "typed-rich.json",
		});
		expect(renamedToJson._nay).toBeUndefined();

		// A stored file follows the same rule: the name is free, the type stays.
		const uploadNodeId = await t.run(async (ctx) =>
			ctx.db.insert("files_nodes", {
				organizationId: markdownSeeded.organizationId,
				workspaceId: markdownSeeded.workspaceId,
				path: "/typed-photo.png",
				treePath: "/typed-photo.png",
				pathDepth: 1,
				name: "typed-photo.png",
				sortName: files_sort_text_key("typed-photo.png"),
				kind: "file",
				lowercaseExtension: "png",
				contentType: "image/png",
				parentId: files_ROOT_ID,
				createdBy: markdownSeeded.userId,
				updatedBy: markdownSeeded.userId,
				updatedAt: Date.now(),
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

				archiveOperationId: null,
				newChildWritePolicy: null,
			}),
		);
		const relabeled = await upsert_file_pending_move_for_test({
			t,
			organizationId: markdownSeeded.organizationId,
			workspaceId: markdownSeeded.workspaceId,
			userId: markdownSeeded.userId,
			nodeId: uploadNodeId,
			destParentId: files_ROOT_ID,
			destName: "typed-movie.mp4",
		});
		expect(relabeled._nay).toBeUndefined();
	});

	test("makes a mixed row when mv follows a pending content edit", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-mixed-src.md",
				name: "move-mixed-src.md",
				markdown: "# Mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nMixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-mixed-renamed.md",
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
		if (!mixedRow) {
			throw new Error("Missing mixed pending row");
		}
		expect(mixedRow.pendingMove?.destName).toBe("move-mixed-renamed.md");
		expect(files_pending_update_has_yjs_content(mixedRow)).toBe(true);
		const mixedRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: mixedRow }),
		);
		expect(mixedRowMarkdownState.unstagedMarkdown).toContain("Mixed change");
		const pendingChunks = await t.run((ctx) => list_pending_update_text_chunks({ ctx, pendingUpdateId: mixedRow._id }));
		expect(pendingChunks.length).toBeGreaterThan(0);
	});

	test("rejects invalid move targets with short literal errors", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-src.md",
				name: "move-validate-src.md",
				markdown: "# Validate base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const sibling = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-sibling.md",
				name: "move-validate-sibling.md",
				markdown: "# Sibling base",
				membership,
			}),
		);

		// Destination parent must be an active folder or root.
		const destParentIsFile = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: sibling.nodeId,
			destName: "moved.md",
		});
		expect(destParentIsFile._nay?.message).toBe("Destination folder is missing");

		// Same source and destination path.
		const samePath = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-src.md",
		});
		expect(samePath._nay?.message).toBe("Source and destination are the same");

		// A name over the limit is refused, so no draft doc stores it.
		const longName = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: `${"n".repeat(253)}.md`,
		});
		expect(longName._nay?.message).toBe("Names can have at most 255 characters.");

		// Active sibling already owns the destination name.
		const siblingConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-sibling.md",
		});
		expect(siblingConflict._nay?.message).toBe("Path already exists");

		// Folder cannot move into its own subtree.
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-validate-folder",
				name: "move-validate-folder",
			}),
		);
		const subFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderId,
				path: "/move-validate-folder/sub",
				name: "sub",
			}),
		);
		const folderIntoItself = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: subFolderId,
			destName: "move-validate-folder",
		});
		expect(folderIntoItself._nay?.message).toBe("Cannot move a folder into itself");

		// Archived source nodes are not movable.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-validate" });
		});
		const archivedSource = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "moved.md",
		});
		expect(archivedSource._nay?.message).toBe("Not found");
	});

	test("records the replace target only with the replace opt-in", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-src.md",
				name: "move-replace-src.md",
				markdown: "# Replace source base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-dest.md",
				name: "move-replace-dest.md",
				markdown: "# Replace dest base",
				membership,
			}),
		);

		// Without the opt-in the occupied destination stays a conflict.
		const withoutReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
		});
		expect(withoutReplace._nay?.message).toBe("Path already exists");

		const withReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
			replace: true,
		});
		if (withReplace._nay) {
			throw new Error(withReplace._nay.message);
		}
		expect(withReplace._yay).toEqual({
			fromPath: "/move-replace-src.md",
			destPath: "/move-replace-dest.md",
			replacesExistingOccupant: true,
			cancelledExistingMove: false,
			appliedImmediately: false,
		});

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove).toMatchObject({
			destParent: { kind: "root" },
			destName: "move-replace-dest.md",
			fromPath: "/move-replace-src.md",
			replacesTarget: { kind: "saved", id: occupant.nodeId },
		});

		// A file never replaces a folder occupant, even with the opt-in.
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-replace-folder",
				name: "move-replace-folder",
			}),
		);
		const folderConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-folder",
			replace: true,
		});
		expect(folderConflict._nay?.message).toBe("Path already exists");
	});

	test("accepts a destination vacated by the proposer's own pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-src.md",
				name: "vacated-src.md",
				markdown: "# Vacated base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-other.md",
				name: "vacated-other.md",
				markdown: "# Vacated other base",
				membership,
			}),
		);

		// The first proposal vacates /vacated-src.md in the proposer's visible tree.
		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// The committed sibling moved away for this user, so its path is free to claim.
		const reuseMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-src.md",
		});
		if (reuseMove._nay) {
			throw new Error(reuseMove._nay.message);
		}
		expect(reuseMove._yay.destPath).toBe("/vacated-src.md");
		expect(reuseMove._yay.replacesExistingOccupant).toBe(false);
	});

	test("rejects a destination already claimed by another pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-a.md",
				name: "claim-a.md",
				markdown: "# Claim a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-b.md",
				name: "claim-b.md",
				markdown: "# Claim b base",
				membership,
			}),
		);

		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// One visible path, one proposal: the second claim is rejected, replace or not.
		const doubleBooked = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		expect(doubleBooked._nay?.message).toBe("Path already exists");
		const doubleBookedReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
			replace: true,
		});
		expect(doubleBookedReplace._nay?.message).toBe("Path already exists");
	});

	test("rejects a folder parent cycle across two pending moves", async () => {
		const t = test_convex();

		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const folderAId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-a",
				name: "parent-cycle-a",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-b",
				name: "parent-cycle-b",
			}),
		);
		const folderCId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-c",
				name: "parent-cycle-c",
			}),
		);

		// Folder A moves into folder B: A shows at /parent-cycle-b/x.
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderAId,
			destParentId: folderBId,
			destName: "x",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Folder B into the moved folder A: the visible destination sits inside B itself, a
		// parent cycle across two rows that would drop both rows from the overlay.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderBId,
			destParentId: folderAId,
			destName: "inside",
		});
		expect(moveB._nay?.message).toBe("Cannot move a folder into itself");

		// A legitimate move of an unrelated folder into the moved folder A still passes.
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderCId,
			destParentId: folderAId,
			destName: "c",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		expect(moveC._yay.destPath).toBe("/parent-cycle-a/c");
	});

	test("rejects a folder replace proposal onto a non-empty folder", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-full/keep.md",
				name: "keep.md",
				markdown: "# Edr proposal keep base",
			}),
		);
		const { folderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-src",
				name: "edr-p-src",
			});
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-full",
				name: "edr-p-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return { folderId };
		});

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-full",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("rejects replacing an empty folder occupant that a pending move targets into", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-into-file.md",
				name: "edr-p-into-file.md",
				markdown: "# Edr into base",
			}),
		);
		const { folderId, emptyFolderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into-src",
				name: "edr-p-into-src",
			});
			const emptyFolderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into",
				name: "edr-p-into",
			});
			return { folderId, emptyFolderId };
		});

		// The user proposes moving a file INTO the empty folder: replacing the folder would
		// break that proposal's destination, so the folder no longer counts as empty.
		const movedIn = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: emptyFolderId,
			destName: "moved.md",
		});
		if (movedIn._nay) {
			throw new Error(movedIn._nay.message);
		}
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-into",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("keeps a file replace proposal onto an empty folder rejected", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-file-src.md",
				name: "edr-p-file-src.md",
				markdown: "# Edr file src base",
			}),
		);
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-dstdir",
				name: "edr-p-dstdir",
			}),
		);

		// rename() fails EISDIR here: a file never replaces a folder, empty or not.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-dstdir",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Path already exists");
	});

	test("mv back to the original path cancels a pure pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-move-src.md",
				name: "cancel-move-src.md",
				markdown: "# Cancel move base",
			}),
		);

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing pending move row before cancel");
		}

		// mv back to the source path cancels the proposal instead of failing validation.
		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay).toEqual({
			fromPath: "/cancel-move-src.md",
			destPath: "/cancel-move-src.md",
			replacesExistingOccupant: false,
			cancelledExistingMove: true,
			appliedImmediately: false,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(row).toBeNull();
		});

		// Without a pending move the same-path mv keeps the current rejection.
		const samePathWithoutRow = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		expect(samePathWithoutRow._nay?.message).toBe("Source and destination are the same");
	});

	test("mv back to the original path keeps the content of a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-mixed-src.md",
				name: "cancel-mixed-src.md",
				markdown: "# Cancel mixed base",
			}),
		);

		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCancel mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay.cancelledExistingMove).toBe(true);

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
			throw new Error("Expected the content proposal to survive the cancelled move");
		}
		expect(row.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
		const rowMarkdownState = await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: row }));
		expect(rowMarkdownState.unstagedMarkdown).toContain("Cancel mixed change");
	});
});

describe("apply_file_pending_move", () => {
	test("applies a pure file move and patches denormalized paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-src.md",
				name: "apply-src.md",
				markdown: "# Apply base",
			}),
		);
		const destFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-dest",
				name: "apply-dest",
			}),
		);
		const { plainTextChunkId } = await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const metadataDocId = await t.run((ctx) =>
			ctx.db.insert("files_metadata_docs", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				fileNodeId: seeded.nodeId,
				sourceKind: "committed",
				path: "/apply-src.md",
				treePath: "/apply-src.md",
				fieldPath: "meta.topic",
				docKind: "field",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing pending move row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.parentId).toBe(destFolderId);
			expect(node?.name).toBe("renamed.md");
			expect(node?.path).toBe("/apply-dest/renamed.md");
			expect(node?.treePath).toBe("/apply-dest/renamed.md");

			const plainTextChunk = await ctx.db.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", q => q.eq("organizationId", seeded.organizationId)
					.eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined)).unique();
			expect(plainTextChunk?._id, "a pure file Move keeps its original plain chunk").toBe(plainTextChunkId);
			expect(plainTextChunk).not.toHaveProperty("moveView");
			expect(plainTextChunk?.textChunk).toBe(seeded.baseMarkdown);
			expect(plainTextChunk?.plainTextChunk).toBe(seeded.baseMarkdown);
			expect(plainTextChunk?.path).toBe("/apply-dest/renamed.md");

			expect(await ctx.db.get("files_metadata_docs", metadataDocId)).toBeNull();
			const metadataDoc = await ctx.db.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", q => q.eq("organizationId", seeded.organizationId)
					.eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined).eq("fieldPath", "meta.topic")).first();
			expect(metadataDoc?.path).toBe("/apply-dest/renamed.md");
			expect(metadataDoc?.treePath).toBe("/apply-dest/renamed.md");

			const rowAfterApply = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterApply).toBeNull();
		});
	});

	test("accepting a rename keeps the stored type", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/subtype-src.json",
				name: "subtype-src.json",
				markdown: '{"a": 1}\n',
				rootKind: "plain_text",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "subtype-renamed.yaml",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		// json→yaml readback: the name and the extension index move, the stored type does not.
		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.name).toBe("subtype-renamed.yaml");
		expect(node?.path).toBe("/subtype-renamed.yaml");
		expect(node?.lowercaseExtension).toBe("yaml");
		expect(node?.contentType).toBe("text/plain;charset=utf-8");
		expect(node?.textKind).toBe("plain_text");
	});

	test("applies a folder move and cascades descendant paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-folder/child.md",
				name: "child.md",
				markdown: "# Folder child base",
			}),
		);
		const { folderId, destFolderId, childChunkIds } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder",
				name: "apply-folder",
			});
			await ctx.db.patch("files_nodes", seeded.nodeId, { parentId: folderId });
			const destFolderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder-dest",
				name: "apply-folder-dest",
			});
			const childChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-folder/child.md",
				markdown: seeded.baseMarkdown,
			});
			return { folderId, destFolderId, childChunkIds };
		});

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: destFolderId,
			destName: "apply-folder",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/apply-folder-dest/apply-folder");
			expect(folder?.treePath).toBe("/apply-folder-dest/apply-folder/");
			expect(folder?.parentId).toBe(destFolderId);

			const child = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(child?.path).toBe("/apply-folder-dest/apply-folder/child.md");

			const childChunk = await ctx.db.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", q => q.eq("organizationId", seeded.organizationId)
					.eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined)).unique();
			expect(childChunk?._id, "a pure folder Move keeps its child's original plain chunk").toBe(
				childChunkIds.plainTextChunkId,
			);
			expect(childChunk).not.toHaveProperty("moveView");
			expect(childChunk?.textChunkId).toBe(childChunkIds.textChunkId);
			expect(childChunk?.textChunk).toBe(seeded.baseMarkdown);
			expect(childChunk?.plainTextChunk).toBe(seeded.baseMarkdown);
			expect(childChunk?.path).toBe("/apply-folder-dest/apply-folder/child.md");
		});
	});

	test("one review publishes a move and collaborative content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-mixed-src.md",
				name: "apply-mixed-src.md",
				markdown: "# Apply mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-mixed-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

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
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/apply-mixed-renamed.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(
				normalize_pending_update_markdown(changedMarkdown),
			);
			expect(await read_pending_update_row({ ctx, ...seeded })).toBeNull();
		});
	});

	test.each(["none", "content", "another user's Move"] as const)(
		"refuses a newcomer file that was not reviewed (proposal: %s)",
		async (proposalKind) => {
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				seed_file_with_markdown({
					ctx,
					path: "/apply-conflict-src.md",
					name: "apply-conflict-src.md",
					markdown: "# Apply conflict base",
				}),
			);
			const created = await upsert_file_pending_move_for_test({
				t,
				...seeded,
				destParentId: files_ROOT_ID,
				destName: "apply-conflict-dest.md",
			});
			if (created._nay) throw new Error(created._nay.message);

			// A new occupant needs a fresh review.
			const occupant = await t.run((ctx) =>
				seed_file_with_markdown({
					ctx,
					membership: seeded,
					path: "/apply-conflict-dest.md",
					name: "apply-conflict-dest.md",
					markdown: "# Occupant",
				}),
			);
			if (proposalKind === "content") {
				const content = await upsert_file_pending_update_internal_for_test({
					t,
					...occupant,
					unstagedMarkdown: "# Occupant draft",
				});
				if (content._nay) throw new Error(content._nay.message);
			} else if (proposalKind === "another user's Move") {
				const userId = await t.run(async (ctx) => {
					const userId = await ctx.db.insert("users", { clerkUserId: "clerk_unreviewed_occupant" });
					await seed_billing_snapshot_for_user(ctx, userId);
					await ctx.db.insert("organizations_workspaces_users", {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userId,
						active: true,
						pendingOrganizationRemoval: false,
						updatedAt: Date.now(),
					});
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userId,
						role: "member",
						now: Date.now(),
					});
					return userId;
				});
				const move = await upsert_file_pending_move_for_test({
					t,
					...occupant,
					userId,
					destParentId: files_ROOT_ID,
					destName: "other-user-destination.md",
				});
				if (move._nay) throw new Error(move._nay.message);
			}
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId });
			const beforeReview = await read_pending_review_state_for_test(t);
			const refused = await test_apply_file_pending_move(asUser, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				...(await reviewed_pending_for_test(t, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
				})),
			});
			expect(refused._nay?.name).toBe("destination_changed");
			expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
			const run = await t.run((ctx) =>
				ctx.db
					.query("files_pending_update_runs")
					.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
					.unique(),
			);
			if (!run) throw new Error("Expected the review run");
			const review = await asUser.query(api.files_pending_update_runs.get, {
				membershipId: seeded.membershipId,
				runId: run._id,
			});
			expect(review?.run.needsReviewIds, "a plain occupant does not reveal other proposals").toEqual([]);
		},
	);

	test("archives the replaced file when applying a replace move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-src.md",
				name: "apply-replace-src.md",
				markdown: "# Apply replace base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-dest.md",
				name: "apply-replace-dest.md",
				markdown: "# Apply replace dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-dest.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The replaced file is archived (recoverable), never hard-deleted.
			const replacedNode = await ctx.db.get("files_nodes", occupant.nodeId);
			expect(replacedNode?.archiveOperationId).toBeDefined();

			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-replace-dest.md");
			expect(node?.archiveOperationId).toBeNull();

			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("requires review of a destination's pending content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-saved-src.md",
				name: "apply-replace-saved-src.md",
				markdown: "# Replace saved source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-saved-dst.md",
				name: "apply-replace-saved-dst.md",
				markdown: "# Replace saved dest",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);
		// The destination has this user's pending content.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: occupant.organizationId,
			workspaceId: occupant.workspaceId,
			userId: occupant.userId,
			nodeId: occupant.nodeId,
			unstagedMarkdown: `${occupant.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const occupantRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: occupant.organizationId,
				workspaceId: occupant.workspaceId,
				userId: occupant.userId,
				nodeId: occupant.nodeId,
			}),
		);
		if (!occupantRow) {
			throw new Error("Missing the occupant's saved row");
		}

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-saved-dst.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay.replacesExistingOccupant).toBe(true);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires review of a destination's shared pending work", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-shared-src.md",
				name: "apply-replace-shared-src.md",
				markdown: "# Replace shared source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-shared-dst.md",
				name: "apply-replace-shared-dst.md",
				markdown: "# Replace shared dest",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: occupant.organizationId,
			workspaceId: occupant.workspaceId,
			userId: occupant.userId,
			nodeId: occupant.nodeId,
			unstagedMarkdown: `${occupant.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// The replacement must also protect another member's pending content.
		await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: occupant.organizationId,
				workspaceId: occupant.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_apply_saved_guard" }),
				target: { kind: "saved", id: occupant.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-shared-dst.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses an unreviewed folder at the destination", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-src.md",
				name: "apply-replace-conflict-src.md",
				markdown: "# Replace conflict base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
				markdown: "# Replace conflict dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-conflict-dest.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A different occupant needs a fresh review.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", occupant.nodeId, { archiveOperationId: "archive-op-replaced-away" });
			await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires review when the source was archived after the proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archived-src.md",
				name: "apply-archived-src.md",
				markdown: "# Apply archived base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-archived-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-apply" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay?.message).toBe("A reviewed source changed. Review it again.");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("apply-archived-dest.md");
	});

	test("requires one review for connected moves", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-a.md",
				name: "chain-a.md",
				markdown: "# Chain a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-b.md",
				name: "chain-b.md",
				markdown: "# Chain b base",
				membership,
			}),
		);

		// Move B vacates /chain-b.md in the proposer's visible tree, so move A may claim it.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}
		const pendingRowA = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRowA) {
			throw new Error("Missing pending move row for move A before apply");
		}

		// Accepting A first must not archive B: B still sits at /chain-b.md only because its own
		// pending move is not accepted yet, so accept must ask for B's move first.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts chained moves in dependency order", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-a.md",
				name: "chain-order-a.md",
				markdown: "# Chain order a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-b.md",
				name: "chain-order-b.md",
				markdown: "# Chain order b base",
				membership,
			}),
		);

		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Accepting B first frees /chain-order-b.md, so accepting A afterwards is a plain move.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const appliedB = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: other.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: other.nodeId },
			})),
		});
		if (appliedB._nay) {
			throw new Error(appliedB._nay.message);
		}
		const appliedA = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (appliedA._nay) {
			throw new Error(appliedA._nay.message);
		}

		await t.run(async (ctx) => {
			const nodeB = await ctx.db.get("files_nodes", other.nodeId);
			expect(nodeB?.path).toBe("/chain-order-c.md");
			expect(nodeB?.archiveOperationId).toBeNull();

			const nodeA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(nodeA?.path).toBe("/chain-order-b.md");
			expect(nodeA?.archiveOperationId).toBeNull();
		});
	});

	test("requires one review for a two-file swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-a.md",
				name: "swap-a.md",
				markdown: "# Swap a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-b.md",
				name: "swap-b.md",
				markdown: "# Swap b base",
				membership,
			}),
		);

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a cycle (A: a→b, B: b→a) that no single accept order can resolve.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Saving one proposal must ask to review the other proposal first.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
		const unselected = await t.run((ctx) => read_pending_update_row({ ctx, ...other }));
		if (!unselected) throw new Error("Expected the unselected Move");
		const run = await t.run((ctx) =>
			ctx.db
				.query("files_pending_update_runs")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique(),
		);
		if (!run) throw new Error("Expected the review run");
		const review = await asUser.query(api.files_pending_update_runs.get, {
			membershipId: seeded.membershipId,
			runId: run._id,
		});
		expect(review?.run.needsReviewIds, "the review names only the unselected swap partner").toEqual([unselected._id]);
	});

	test.each([
		{ selected: false, withContent: false },
		{ selected: true, withContent: false },
		{ selected: true, withContent: true },
	])("requires a destination delete in the review (selected: $selected, content: $withContent)", async ({ selected, withContent }) => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-before-delete.md",
				name: "move-before-delete.md",
				markdown: "# Move",
			}),
		);
		const occupant = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				membership: seeded,
				path: "/delete-before-move.md",
				name: "delete-before-move.md",
				markdown: "# Delete",
			}),
		);
		const committedBefore = await t.run((ctx) => read_committed_text({ ctx, ...occupant }));
		if (withContent) {
			const edited = await upsert_file_pending_update_internal_for_test({
				t,
				...occupant,
				stagedMarkdown: "# Draft delete\n",
				unstagedMarkdown: "# Draft delete\n",
			});
			if (edited._nay) throw new Error(edited._nay.message);
		}
		const deleted = await upsert_file_pending_archive_for_test({ t, ...occupant });
		if (deleted._nay) throw new Error(deleted._nay.message);
		const moved = await upsert_file_pending_move_for_test({
			t,
			...seeded,
			destParentId: files_ROOT_ID,
			destName: "delete-before-move.md",
		});
		if (moved._nay) throw new Error(moved._nay.message);
		const moveProposal = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		const deleteProposal = await t.run((ctx) => read_pending_update_row({ ctx, ...occupant }));
		if (!moveProposal || !deleteProposal) throw new Error("Expected the Move and Delete proposals");
		if (withContent) expect(deleteProposal.content, "the selected Delete keeps its draft until review").toBeDefined();
		const originalDeleteContent = deleteProposal.content;
		const beforeReview = await read_pending_review_state_for_test(t);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId });
		const review = await save_pending_review_for_test(
			{ t, asUser, membershipId: seeded.membershipId },
			selected ? [moveProposal, deleteProposal] : [moveProposal],
		);
		if (selected) {
			expect(review?.activity, "the selected delete frees the Move destination").toMatchObject({
				status: "succeeded",
				progress: { completed: 2, blocked: 0 },
			});
			expect(review?.run.unitCount, "the Move and destination delete publish together").toBe(1);
			expect((await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))?.path).toBe("/delete-before-move.md");
			expect((await t.run((ctx) => ctx.db.get("files_nodes", occupant.nodeId)))?.archiveOperationId).not.toBeNull();
			expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();
			expect(
				await t.run((ctx) => read_pending_update_row({ ctx, ...occupant })),
				"the selected Delete removes its pending content proposal",
			).toBeNull();
			expect(await t.run((ctx) => read_committed_text({ ctx, ...occupant })), "Delete does not save its draft text").toBe(
				committedBefore,
			);
			if (withContent)
				await expect_consumed_pending_content_cleanup_for_test(
					t,
					originalDeleteContent!,
					"The selected Delete retires its original draft states",
				);
		} else {
			expect(review?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 1 } });
			expect(review?.run.needsReviewIds, "the review names only the unselected destination delete").toEqual([
				deleteProposal._id,
			]);
			expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
		}
	});

	test("keeps a restricted swap partner unchanged before review", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/cyc-a.md", name: "cyc-a.md", markdown: "# Cycle a" }),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/cyc-b.md", name: "cyc-b.md", markdown: "# Cycle b", membership }),
		);

		// The seeded user owns the organization and bypasses every check, so the accept has to be made
		// by somebody else. This one holds ordinary workspace write and nothing on the restricted file.
		const mover = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_cycle_perm" });
			await seed_billing_snapshot_for_user(ctx, userId);
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now,
			});
			return { userId, membershipId };
		});

		// mv a→tmp, mv b→a, mv a→b leaves the two rows that form the cycle.
		for (const move of [
			{ nodeId: seeded.nodeId, destName: "cyc-tmp.md" },
			{ nodeId: other.nodeId, destName: "cyc-a.md" },
			{ nodeId: seeded.nodeId, destName: "cyc-b.md" },
		]) {
			const proposed = await upsert_file_pending_move_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: mover.userId,
				nodeId: move.nodeId,
				destParentId: files_ROOT_ID,
				destName: move.destName,
			});
			if (proposed._nay) {
				throw new Error(proposed._nay.message);
			}
		}

		// Only now is the swap partner closed off. The proposal outlived the access that made it.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", other.nodeId, { restrictedScopeNodeId: other.nodeId });
		});

		const asMover = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: mover.userId,
			name: "Mover",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asMover, {
			membershipId: mover.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: mover.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for content within a swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-a.md",
				name: "swap-mixed-a.md",
				markdown: "# Swap mixed a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-b.md",
				name: "swap-mixed-b.md",
				markdown: "# Swap mixed b base",
				membership,
			}),
		);

		// B carries a content edit, so its row stays mixed through the swap.
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			stagedMarkdown: other.baseMarkdown,
			unstagedMarkdown: `${other.baseMarkdown}\n\nSwap mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the mixed row's side: the cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: other.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: other.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a long file rotation", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/rotate-1.md",
				name: "rotate-1.md",
				markdown: "# Rotate 1 base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const fileCount = 14;
		const rotated = [seeded];
		for (let index = 2; index <= fileCount; index++) {
			const file = await t.run(async (ctx) =>
				seed_file_with_markdown({
					ctx,
					path: `/rotate-${index}.md`,
					name: `rotate-${index}.md`,
					markdown: `# Rotate ${index} base`,
					membership,
				}),
			);
			rotated.push(file);
		}

		// mv f1→tmp frees /rotate-1.md, each next mv shifts a file down one slot, and the final
		// mv replaces f1's tmp proposal: the rows form one rotation cycle of 14 files.
		const movedToTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "rotate-tmp.md",
		});
		if (movedToTmp._nay) {
			throw new Error(movedToTmp._nay.message);
		}
		for (const [index, file] of rotated.entries()) {
			if (index === 0) {
				continue;
			}
			const moved = await upsert_file_pending_move_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: file.nodeId,
				destParentId: files_ROOT_ID,
				destName: `rotate-${index}.md`,
			});
			if (moved._nay) {
				throw new Error(moved._nay.message);
			}
		}
		const movedToLast = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: `rotate-${fileCount}.md`,
		});
		if (movedToLast._nay) {
			throw new Error(movedToLast._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a two-folder swap", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc swap a child base",
			}),
		);
		const membership = {
			userId: childA.userId,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			membershipId: childA.membershipId,
		};
		const childB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-b/b-child.md",
				name: "b-child.md",
				markdown: "# Fsc swap b child base",
				membership,
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-a",
				name: "fsc-swap-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-b",
				name: "fsc-swap-b",
			});
			await ctx.db.patch("files_nodes", childB.nodeId, { parentId: folderBId });
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-swap-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a folder swap cycle (A: a→b, B: b→a).
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting either row applies the whole cycle inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a file and folder swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-mix-a.md",
				name: "fsc-mix-a.md",
				markdown: "# Fsc mix a base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-mix-b",
				name: "fsc-mix-b",
			}),
		);

		// The file and the folder trade paths through a temp name.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the mixed cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("keeps content and move cycle members unchanged before review", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-cnm-a.md",
				name: "fsc-cnm-a.md",
				markdown: "# Fsc cnm base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-cnm-b",
				name: "fsc-cnm-b",
			}),
		);

		// The file carries a content proposal, then joins the swap: its doc is content-plus-move.
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nCnm change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the file is the NON-clicked cycle member.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a three-folder rotation", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-rot-a/rot-child.md",
				name: "rot-child.md",
				markdown: "# Fsc rot child base",
			}),
		);
		const { folderAId, folderBId, folderCId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-a",
				name: "fsc-rot-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-b",
				name: "fsc-rot-b",
			});
			const folderCId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-c",
				name: "fsc-rot-c",
			});
			return { folderAId, folderBId, folderCId };
		});

		// A→tmp frees a, B claims a, C claims b, and the final move replaces A's tmp
		// row: the three rows form the A→c, B→a, C→b rotation.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderCId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-b",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-c",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review when a cycle parent also moves", async () => {
		const t = test_convex();

		// M=/fsc-nest-m holds C=child.md; K=/fsc-nest-k.md is a file with committed chunks.
		const childC = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-m/child.md",
				name: "child.md",
				markdown: "# Fsc nest child base",
			}),
		);
		const membership = {
			userId: childC.userId,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			membershipId: childC.membershipId,
		};
		const fileK = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-k.md",
				name: "fsc-nest-k.md",
				markdown: "# Fsc nest k base",
				membership,
			}),
		);
		const { folderMId } = await t.run(async (ctx) => {
			const folderMId = await seed_folder_node({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				userId: childC.userId,
				path: "/fsc-nest-m",
				name: "fsc-nest-m",
			});
			await ctx.db.patch("files_nodes", childC.nodeId, { parentId: folderMId });
			const fileKChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				nodeId: fileK.nodeId,
				path: "/fsc-nest-k.md",
				markdown: fileK.baseMarkdown,
			});
			return { folderMId, fileKChunkIds };
		});

		// C→tmp frees child.md, K claims it INSIDE M, M claims K's path, and the final
		// move replaces C's tmp row: the cycle is C→/fsc-nest-m, M→/fsc-nest-k.md,
		// K→(M)/child.md — K's destination parent M moves in the same cycle.
		const moveCTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-tmp.md",
		});
		if (moveCTmp._nay) {
			throw new Error(moveCTmp._nay.message);
		}
		const moveK = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: fileK.nodeId,
			destParentId: folderMId,
			destName: "child.md",
		});
		if (moveK._nay) {
			throw new Error(moveK._nay.message);
		}
		const moveM = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: folderMId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-k.md",
		});
		if (moveM._nay) {
			throw new Error(moveM._nay.message);
		}
		const moveCFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-m",
		});
		if (moveCFinal._nay) {
			throw new Error(moveCFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childC.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childC.membershipId,
			target: { kind: "saved", id: childC.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childC.membershipId,
				target: { kind: "saved", id: childC.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("keeps a changed parent loop unchanged before review", async () => {
		const t = test_convex();

		// A=/fsc-loop-q/a and B=/fsc-loop-b swap; Q is A's committed parent.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-loop-file.md",
				name: "fsc-loop-file.md",
				markdown: "# Fsc loop base",
			}),
		);
		const { folderQId, folderAId, folderBId } = await t.run(async (ctx) => {
			const folderQId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-q",
				name: "fsc-loop-q",
			});
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderQId,
				path: "/fsc-loop-q/a",
				name: "a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-b",
				name: "fsc-loop-b",
			});
			return { folderQId, folderAId, folderBId };
		});

		// The swap cycle: A→/fsc-loop-b, B→(Q)/a.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: folderQId,
			destName: "a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Another user commits Q under B after the proposals: the final tree would nest
		// B under Q and Q under B — a parent loop.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folderQId, {
				parentId: folderBId,
				path: "/fsc-loop-b/fsc-loop-q",
				treePath: "/fsc-loop-b/fsc-loop-q/",
				pathDepth: 2,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a folder swap with an empty occupant", async () => {
		const t = test_convex();

		// A holds a child (with chunks); B is EMPTY, so A's destination occupant is
		// replaceable on its own — the cycle must still swap, never archive B.
		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-empty-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc empty a child base",
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-a",
				name: "fsc-empty-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-b",
				name: "fsc-empty-b",
			});
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-empty-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts a folder move that replaces an empty folder occupant", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-src/child.md",
				name: "child.md",
				markdown: "# Edr child base",
			}),
		);
		const { folderId, occupantId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-src",
				name: "edr-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-dst",
				name: "edr-dst",
			});
			return { folderId, occupantId };
		});

		// rename() semantics: a folder may replace an EMPTY folder occupant.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-dst",
			replace: true,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		expect(proposed._yay.replacesExistingOccupant).toBe(true);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: child.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: child.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The empty occupant is archived (never hard-deleted), the mover owns the path.
			const occupant = await ctx.db.get("files_nodes", occupantId);
			expect(occupant?.archiveOperationId).toBeDefined();
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/edr-dst");
			expect(folder?.archiveOperationId).toBeNull();
			const movedChild = await ctx.db.get("files_nodes", child.nodeId);
			expect(movedChild?.path).toBe("/edr-dst/child.md");

			const row = await read_pending_update_row({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				nodeId: folderId,
			});
			expect(row).toBeNull();
		});
	});

	test("refuses an empty folder that was not reviewed", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-new-src/child.md",
				name: "child.md",
				markdown: "# Edr newcomer child base",
			}),
		);
		const folderId = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new-src",
				name: "edr-new-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return folderId;
		});

		// Propose while the destination is free, then an empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-new",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new",
				name: "edr-new",
			}),
		);

		// The empty folder was not part of the review.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: child.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: child.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses a hidden newcomer parent and the move that would replace it", async () => {
		const t = test_convex();

		const file = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-claim-file.md",
				name: "edr-claim-file.md",
				markdown: "# Edr claim base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim-src",
				name: "edr-claim-src",
			}),
		);

		// The owner's folder proposal hides a later saved occupant at the same path.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-claim",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const newcomerId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim",
				name: "edr-claim",
			}),
		);
		const beforeReview = await read_pending_review_state_for_test(t);
		const movedInto = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: file.nodeId,
			destParentId: newcomerId,
			destName: "into.md",
		});
		expect(movedInto._nay?.message).toBe("Destination folder is missing");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: file.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: file.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: file.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(applied._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses a nonempty folder that was not reviewed", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-full/keep.md",
				name: "keep.md",
				markdown: "# Edr keep base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full-src",
				name: "edr-full-src",
			}),
		);

		// Propose while the destination is free, then a NON-empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-full",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		await t.run(async (ctx) => {
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full",
				name: "edr-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return occupantId;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: occupantChild.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: occupantChild.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: occupantChild.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts mixed content after a manual move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-idem-src.md",
				name: "apply-idem-src.md",
				markdown: "# Apply idem base",
			}),
		);

		const destParentId = await t.run((ctx) =>
			seed_folder_node({ ctx, ...seeded, path: "/apply-idem-dest", name: "apply-idem-dest" }),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply idem change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId,
			destName: "apply-idem-src.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing mixed pending row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const manualMove = await test_move_nodes(t, asUser, {
			membershipId: seeded.membershipId,
			itemIds: [seeded.nodeId],
			targetParentId: destParentId,
		});
		expect(manualMove._nay).toBeUndefined();
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
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/apply-idem-dest/apply-idem-src.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(
				normalize_pending_update_markdown(changedMarkdown),
			);
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("accepts a pure move whose rename the UI already performed", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-renamed-src.md",
				name: "apply-ui-renamed-src.md",
				markdown: "# Apply ui renamed base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-ui-renamed-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A committed rename lands the node at the proposed destination before the accept.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await test_rename_node(t, asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-renamed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		// The move is already applied, so accept is a success no-op that settles the row.
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-ui-renamed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("accepts mixed content after a manual rename", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-mixed-src.md",
				name: "apply-ui-mixed-src.md",
				markdown: "# Apply ui mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nUi mixed change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-ui-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await test_rename_node(t, asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-mixed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}
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
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/apply-ui-mixed-dest.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(changedMarkdown);
			expect(await read_pending_update_row({ ctx, ...seeded })).toBeNull();
		});
	});
});

describe("upsert_file_pending_archive_in_db", () => {
	test("creates a delete row, sets its expiry, and is idempotent", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-upsert.md",
				name: "archive-upsert.md",
				markdown: "# Archive upsert base",
			}),
		);

		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay).toEqual({
			fromPath: "/archive-upsert.md",
			nodeKind: "file",
			outcome: "proposed",
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
			throw new Error("Missing pending row after archive upsert");
		}
		expect(pendingRow.pendingArchive).toEqual({ fromPath: "/archive-upsert.md" });
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(false);
		expect(pendingRow.size).toBe(0);

		expect(pendingRow.expiresAt).toBe(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const expiryCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(expiryCheck?.nextCheckAt).toBeLessThanOrEqual(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		const repeated = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(repeated._yay?.outcome).toBe("proposed");
		const repeatedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(repeatedRow?._id).toBe(pendingRow._id);
		expect(repeatedRow?.pendingArchive).toEqual({ fromPath: "/archive-upsert.md" });
	});

	test("supersedes a pending move, keeps content branches, and dedupes threadIds", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-supersede.md",
				name: "archive-supersede.md",
				markdown: "# Archive supersede base",
			}),
		);
		const threadId = await t.run((ctx) =>
			seed_chat_thread({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
			}),
		);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nDelete me later`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "archive-supersede-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		for (let i = 0; i < 2; i++) {
			const archived = await upsert_file_pending_archive_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				threadId,
			});
			if (archived._nay) {
				throw new Error(archived._nay.message);
			}
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
		if (!pendingRow) {
			throw new Error("Missing pending row after archive supersede");
		}
		expect(pendingRow.pendingArchive).toEqual({ fromPath: "/archive-supersede.md" });
		expect(pendingRow.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(true);
		expect(pendingRow.threadIds).toEqual([threadId]);
	});

	test("rejects missing or archived nodes", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-rejected.md",
				name: "archive-rejected.md",
				markdown: "# Archive rejected base",
			}),
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: crypto.randomUUID() }));

		const rejected = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(rejected._nay?.message).toBe("Not found");
	});
});

describe("apply_file_pending_archive", () => {
	test("archives the file, patches chunk scope, and removes the doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive.md",
				name: "apply-archive.md",
				markdown: "# Apply archive base",
			}),
		);
		const { plainTextChunkId } = await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-archive.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing pending delete row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}
		await test_finish_saved_scope_jobs(t);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBeDefined();
			const plainTextChunk = await ctx.db.get("files_plain_text_chunks", plainTextChunkId);
			expect(plainTextChunk?.archiveOperationId).toBe(node?.archiveOperationId);
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});

		// Re-accept after settle is a quiet no-op (bulk retries).
		const reApplied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: pendingRow._id,
			reviewedRevision: pendingRow.revision,
		});
		expect(reApplied._yay).toBe(null);
	});

	test("archives a folder subtree with one operation id and settles only the acting user's docs", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-folder/child.md",
				name: "child.md",
				markdown: "# Folder child base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-archive-folder",
				name: "apply-archive-folder",
			}),
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { parentId: folderId }));
		const outsiderSeeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-outsider.md",
				name: "apply-archive-outsider.md",
				markdown: "# Outsider base",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);

		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		// The acting user also has their own doc on the child: accept removes it too.
		const childDelete = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (childDelete._nay) {
			throw new Error(childDelete._nay.message);
		}
		// Another user's doc on the child must survive the accept untouched. They are a real member with a
		// real role, because proposing a delete asks the node whether this user may write it.
		const otherUserId = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_apply_archive_other" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now,
			});
			return userId;
		});
		const otherDoc = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: otherUserId,
			nodeId: seeded.nodeId,
		});
		if (otherDoc._nay) {
			throw new Error(otherDoc._nay.message);
		}
		// A file committed into the folder AFTER the proposal is archived too.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const lateFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: seeded.membershipId,
			parentId: folderId,
			path: "late.md",
		});
		if (lateFile._nay) throw new Error(lateFile._nay.message);
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folder = await ctx.db.get("files_nodes", folderId);
			const child = await ctx.db.get("files_nodes", seeded.nodeId);
			const late = await ctx.db.get("files_nodes", lateFile._yay.nodeId);
			expect(folder?.archiveOperationId).toBeDefined();
			expect(child?.archiveOperationId).toBe(folder?.archiveOperationId);
			expect(late?.archiveOperationId).toBe(folder?.archiveOperationId);
			const outsider = await ctx.db.get("files_nodes", outsiderSeeded.nodeId);
			expect(outsider?.archiveOperationId).toBeNull();

			const actingFolderRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: folderId,
			});
			expect(actingFolderRow).toBeNull();
			const actingChildRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(actingChildRow).toBeNull();
			const otherChildRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: otherUserId,
				nodeId: seeded.nodeId,
			});
			expect(otherChildRow?.pendingArchive).toBeDefined();
		});
	});

	test("ignores a locked archived tree when a new active folder reuses its path", async () => {
		const t = test_convex();
		const membership = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const archivedTree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-reused-docs",
				name: "pending-reused-docs",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-reused-docs/secret",
				name: "secret",
			});
			return { rootId, childId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Pending Path Reuse User",
		});
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: membership.membershipId,
			nodeIds: [archivedTree.rootId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		const archivedOperationId = (await t.run((ctx) => ctx.db.get("files_nodes", archivedTree.rootId)))
			?.archiveOperationId;
		expect(archivedOperationId).toBeDefined();

		const activeTree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-reused-docs",
				name: "pending-reused-docs",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-reused-docs/current",
				name: "current",
			});
			return { rootId, childId };
		});
		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: activeTree.rootId,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}

		// The lock arrives after the proposal. Accept must still use node lineage rather than
		// mistaking the archived `/pending-reused-docs` tree for this active one.
		await set_pending_test_read_only({ asUser, membershipId: membership.membershipId, nodeId: archivedTree.childId });
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: membership.membershipId,
			target: { kind: "saved", id: activeTree.rootId },
			...(await reviewed_pending_for_test(t, {
				membershipId: membership.membershipId,
				target: { kind: "saved", id: activeTree.rootId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const activeRoot = await ctx.db.get("files_nodes", activeTree.rootId);
			const activeChild = await ctx.db.get("files_nodes", activeTree.childId);
			expect(activeRoot?.archiveOperationId).toBeDefined();
			expect(activeChild?.archiveOperationId).toBe(activeRoot?.archiveOperationId);
			expect((await ctx.db.get("files_nodes", archivedTree.rootId))?.archiveOperationId).toBe(archivedOperationId);
			expect((await ctx.db.get("files_nodes", archivedTree.childId))?.archiveOperationId).toBe(archivedOperationId);
		});
	});

	test("a true archived descendant still blocks a pending folder archive at accept time", async () => {
		const t = test_convex();
		const membership = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const tree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-true-archived",
				name: "pending-true-archived",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-true-archived/child",
				name: "child",
			});
			return { rootId, childId };
		});
		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: tree.rootId,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Pending True Descendant User",
		});
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: membership.membershipId,
			nodeIds: [tree.childId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: membership.membershipId, nodeId: tree.childId });

		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: membership.membershipId,
			target: { kind: "saved", id: tree.rootId },
			...(await reviewed_pending_for_test(t, {
				membershipId: membership.membershipId,
				target: { kind: "saved", id: tree.rootId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_nodes", tree.rootId)))?.archiveOperationId).toBeNull();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: membership.userId,
					nodeId: tree.rootId,
				}),
			),
		).not.toBeNull();
	});

	test("drops the doc quietly when the node was already archived", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-raced.md",
				name: "apply-archive-raced.md",
				markdown: "# Raced base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		// The sidebar Archive action (or another accept) archived the node first.
		const sidebarOperationId = crypto.randomUUID();
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: sidebarOperationId }));

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._yay).toBe(null);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBe(sidebarOperationId);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});
});

describe("pending delete discard, save, expiry, and overlay reads", () => {
	test("discard clears the delete and keeps the content proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-delete-content.md",
				name: "discard-delete-content.md",
				markdown: "# Discard delete base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nStill wanted`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
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

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", seeded.nodeId)).not.toBeNull();
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.pendingArchive).toBeUndefined();
			expect(row && files_pending_update_has_yjs_content(row)).toBe(true);
		});
	});

	test("discard removes a delete-only doc and never touches the node", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-delete-only.md",
				name: "discard-delete-only.md",
				markdown: "# Discard delete-only base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing delete-only row before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
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

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("save is rejected while a delete pends", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-behind-delete.md",
				name: "save-behind-delete.md",
				markdown: "# Save behind delete base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nStaged change`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nStaged change`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const rowWithDelete = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowWithDelete) {
			throw new Error("Missing pending row while testing save behind a pending delete");
		}
		const saved = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			pendingUpdateId: rowWithDelete._id,
			expectedRevision: rowWithDelete.revision,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
		});
		expect(saved._nay?.message).toBe("File has a pending delete");
	});

	test("an expired delete-only doc is removed and the node stays", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-delete.md",
				name: "expire-delete.md",
				markdown: "# Expire delete base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing delete-only row before expiry");
		}
		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node).not.toBeNull();
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("get_by_path hides a pending-deleted file for the proposer only", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-delete.md",
				name: "overlay-delete.md",
				markdown: "# Overlay delete base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const forProposer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-delete.md",
			overlayUserId: seeded.userId,
		});
		expect(forProposer).toBeNull();

		const committed = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-delete.md",
		});
		expect(committed?._id).toBe(seeded.nodeId);
	});

	test("get_by_path hides a deleted folder's descendants", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-delete-folder/child.md",
				name: "child.md",
				markdown: "# Overlay folder child base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/overlay-delete-folder",
				name: "overlay-delete-folder",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const childForProposer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-delete-folder/child.md",
			overlayUserId: seeded.userId,
		});
		expect(childForProposer).toBeNull();

		const childCommitted = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-delete-folder/child.md",
		});
		expect(childCommitted?._id).toBe(seeded.nodeId);
	});
});

describe("discard_file_pending_content", () => {
	test("copies staged content into unstaged content without saving it", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content.md",
				name: "discard-content.md",
				markdown: "# Discard content base",
			}),
		);
		const stagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAccepted change`);
		const unstagedMarkdown = normalize_pending_update_markdown(`${stagedMarkdown}\n\nUnresolved change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const pendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingDoc) {
			throw new Error("Missing pending content doc before discard");
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
				pendingUpdateId: pendingDoc._id,
			})),
			pendingUpdateId: pendingDoc._id,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		const docAfterDiscard = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingDoc._id));
		if (!docAfterDiscard) {
			throw new Error("Expected accepted staged content to keep the pending doc");
		}
		expect(
			await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: docAfterDiscard })),
		).toEqual({
			baseMarkdown: seeded.baseMarkdown,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
	});

	test("rejects a stale pendingUpdateId instead of discarding the replacement doc", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content-stale-id.md",
				name: "discard-content-stale-id.md",
				markdown: "# Discard stale content base",
			}),
		);

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFirst draft`,
		});
		const stalePendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!stalePendingDoc) {
			throw new Error("Missing stale pending content doc before replacement");
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
		const currentStagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nCurrent staged`);
		const currentUnstagedMarkdown = normalize_pending_update_markdown(`${currentStagedMarkdown}\n\nCurrent draft`);
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: currentStagedMarkdown,
			unstagedMarkdown: currentUnstagedMarkdown,
		});
		const currentPendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!currentPendingDoc) {
			throw new Error("Missing replacement pending content doc");
		}
		expect(currentPendingDoc._id).not.toBe(stalePendingDoc._id);

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
				pendingUpdateId: stalePendingDoc._id,
			})),
			pendingUpdateId: stalePendingDoc._id,
		});
		expect(discarded._nay?.message).toBe("Not found");

		const docAfterDiscard = await t.run((ctx) => ctx.db.get("files_pending_updates", currentPendingDoc._id));
		expect(docAfterDiscard).not.toBeNull();
		expect(
			await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: docAfterDiscard! })),
		).toEqual({
			baseMarkdown: seeded.baseMarkdown,
			stagedMarkdown: currentStagedMarkdown,
			unstagedMarkdown: currentUnstagedMarkdown,
		});
	});
});

describe("discard_file_pending_structural", () => {
	test("deletes a pure-move row and leaves the node untouched", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-move-src.md",
				name: "discard-move-src.md",
				markdown: "# Discard move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing pending move row before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
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

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/discard-move-src.md");
			const rowAfterDiscard = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterDiscard).toBeNull();
		});
	});

	test("refuses replacement after a swap partner was discarded", async () => {
		const t = test_convex();

		// Two EMPTY folders swap; discarding one side turns the other accept into a
		// plain empty-folder replacement of the now-stationary occupant.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-disc-file.md",
				name: "edr-disc-file.md",
				markdown: "# Edr disc base",
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-a",
				name: "edr-disc-a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-b",
				name: "edr-disc-b",
			});
			return { folderAId, folderBId };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("drops the move and keeps the content on a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-mixed-src.md",
				name: "discard-mixed-src.md",
				markdown: "# Discard mixed base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDiscard mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
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

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the content proposal to survive the structural discard");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks.length).toBeGreaterThan(0);
		});
	});

	test("keeps the destination node when discarding a copy row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-source.md",
				name: "discard-copy-source.md",
				markdown: "# Copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-dest.md",
				name: "discard-copy-dest.md",
				markdown: "# Copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// cp onto an existing file: the destination node was NOT created by the proposal.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Only the proposal row is dropped; the pre-existing node keeps its committed content.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps both the source and the destination when discarding a copy row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-keep-source.md",
				name: "discard-copy-keep-source.md",
				markdown: "# Copy keep source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-keep-dest.md",
				name: "discard-copy-keep-dest.md",
				markdown: "# Copy keep dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// cp onto an existing file: the copy lives on the TARGET row and names its source.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-keep-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Nothing moved and nothing was archived: only the proposal row is dropped.
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeNull();
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBeNull();
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when content was committed since the copy was proposed", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-source.md",
				name: "discard-copy-committed-source.md",
				markdown: "# Committed guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-dest.md",
				name: "discard-copy-committed-dest.md",
				markdown: "# Committed guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-committed-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Someone commits real content to the destination node through the regular Yjs flow.
		await t.run(async (ctx) => {
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			if (!destNode?.yjsLastSequenceId) {
				throw new Error("Missing destination yjsLastSequenceId while advancing committed state");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", destNode.yjsLastSequenceId, { lastSequence: 1 });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Discard removes the proposal and keeps the saved file.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-committed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when a rebase re-aligns the row base after a commit", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-source.md",
				name: "discard-copy-rebase-source.md",
				markdown: "# Rebase guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-dest.md",
				name: "discard-copy-rebase-dest.md",
				markdown: "# Rebase guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-rebase-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});

		// A remote edit lands before the client rebases the copied content.
		const remoteMarkdown = `${dest.baseMarkdown}\n\nRemote commit`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: dest.nodeId,
				markdown: remoteMarkdown,
			}),
		);
		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, dest.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${remoteMarkdown}\n\nCopied content`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build the rebased copy branch");
		}
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row?.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });
			expect(row?.copiedFrom).toEqual({
				target: { kind: "saved", id: source.nodeId },
				path: "/discard-copy-rebase-source.md",
			});
		});

		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Discard keeps the saved file after the copied content was rebased.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-rebase-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when another user has a pending row on it", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-source.md",
				name: "discard-copy-otheruser-source.md",
				markdown: "# Other user guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-dest.md",
				name: "discard-copy-otheruser-dest.md",
				markdown: "# Other user guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-otheruser-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Another user drafts on the destination node; hard delete would destroy their draft.
		const otherUserRowId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_pending_guard" }),
				target: { kind: "saved", id: dest.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-otheruser-dest.md");
			const otherUserRow = await ctx.db.get("files_pending_updates", otherUserRowId);
			expect(otherUserRow).not.toBeNull();
			const proposerRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(proposerRow).toBeNull();
		});
	});

	test("keeps a saved node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-saved-renamed-dest.md",
				name: "discard-saved-renamed-dest.md",
				markdown: "# Saved renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing saved row before discard");
		}

		// Another member renames the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_saved_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await test_rename_node(t, asOtherUser, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "discard-saved-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The other user's rename must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-saved-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("keeps a saved node that another user moved with move_nodes since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-saved-moved-dest.md",
				name: "discard-saved-moved-dest.md",
				markdown: "# Saved moved base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing saved row before discard");
		}

		// Another member moves the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_saved_moved_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				path: "/discard-saved-moved-folder",
				name: "discard-saved-moved-folder",
			});
			return { otherUserId, otherMembershipId, folderId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const moved = await test_move_nodes(t, asOtherUser, {
				membershipId: other.otherMembershipId,
				itemIds: [dest.nodeId],
				targetParentId: other.folderId,
			});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The other user's move must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-saved-moved-folder/discard-saved-moved-dest.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("no-ops on content-only rows and keeps the content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content-src.md",
				name: "discard-content-src.md",
				markdown: "# Discard content base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nContent only`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		// No structural aspect on the row: the discard is an idempotent no-op success.
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(discarded._nay).toBeUndefined();

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});
});

describe("structural rows on content collapse", () => {
	test("content collapse on a mixed row degrades it to a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/degrade-mixed-src.md",
				name: "degrade-mixed-src.md",
				markdown: "# Degrade base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDegrade change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "degrade-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the content to base would normally delete the row; the move must survive.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a degraded pure-move row after content collapse");
			}
			expect(row.pendingMove?.destName).toBe("degrade-mixed-dest.md");
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(row.size).toBe(0);
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks).toHaveLength(0);
			expect(row.expiresAt).toBe(row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
			expect((await read_pending_update_expiry_check({ ctx, ...seeded }))?.nextCheckAt).toBeLessThanOrEqual(
				row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS,
			);
		});
	});

	test.each([false, true])("content collapse keeps a delete when collaboration off is %s", async (nonCollaborative) => {
		const t = test_convex();
		const baseMarkdown = normalize_pending_update_markdown("# Delete base");
		const seeded = await t.run(async (ctx) =>
			nonCollaborative
				? seed_non_collaborative_file({ ctx, path: "/degrade-delete.md", text: baseMarkdown })
				: seed_file_with_markdown({
						ctx,
						path: "/degrade-delete.md",
						name: "degrade-delete.md",
						markdown: baseMarkdown,
					}),
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
			stagedMarkdown: baseMarkdown,
			unstagedMarkdown: `${baseMarkdown}\n\nAgent line`,
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test(ids);
		expect(archived._nay).toBeUndefined();
		const beforeCollapse = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(beforeCollapse?.content?.unstagedStateId).toBeDefined();

		// Discard all sends both branches back to the base. The delete still needs review.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const collapsed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: baseMarkdown,
			unstagedMarkdown: baseMarkdown,
		});
		expect(collapsed._nay).toBeUndefined();
		await t.run(async (ctx) => {
			const pendingUpdate = await read_pending_update_row({ ctx, ...seeded });
			expect(pendingUpdate).not.toBeNull();
			expect(pendingUpdate?.pendingArchive).toEqual({ fromPath: "/degrade-delete.md" });
			expect(pendingUpdate?.content).toBeUndefined();
			expect(pendingUpdate?.size).toBe(0);
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingUpdate!._id })).toHaveLength(0);
			expect(pendingUpdate!.expiresAt).toBe(pendingUpdate!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
			expect((await read_pending_update_expiry_check({ ctx, ...seeded }))?.nextCheckAt).toBeLessThanOrEqual(
				pendingUpdate!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS,
			);
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.archiveOperationId).toBeNull();
		});
	});

	test("content collapse degrades a copy row with a move to a pure move", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-source.md",
				name: "collapse-replace-source.md",
				markdown: "# Collapse replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-dest.md",
				name: "collapse-replace-dest.md",
				markdown: "# Collapse replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/collapse-replace-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			destParentId: files_ROOT_ID,
			destName: "collapse-replace-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the copied content keeps only the pending move.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: dest.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
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
		if (!row) {
			throw new Error("Expected the degraded pure-move row to survive the content collapse");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(row.pendingMove?.destName).toBe("collapse-replace-renamed.md");
		expect(files_pending_update_has_yjs_content(row)).toBe(false);
	});
});

describe("save with structural rows", () => {
	test("Save accepts a pure move without changing its content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-move-src.md",
				name: "save-move-src.md",
				markdown: "# Save move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saved._nay).toBeUndefined();

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/save-move-dest.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(seeded.baseMarkdown);
		});
	});

	test("full Save publishes mixed content and its move together", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-mixed-src.md",
				name: "save-mixed-src.md",
				markdown: "# Save mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSave mixed change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const pendingRow = await read_seeded_pending_row(t, seeded);
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const committedMarkdown = await t.run((ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(committedMarkdown).toContain("Save mixed change");

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/save-mixed-dest.md");
		});
	});

	test("partial save clears copiedFrom and keeps the remaining content", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-source.md",
				name: "save-copy-source.md",
				markdown: "# Save copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-dest.md",
				name: "save-copy-dest.md",
				markdown: "# Save copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// Staged stays at base while unstaged carries the copied content, so a save is partial.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/save-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
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
		if (!row) {
			throw new Error("Expected the pending row to survive a partial save");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});

	test("save onto an archived target publishes the content and settles the row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-source.md",
				name: "save-archived-target-source.md",
				markdown: "# Archived target source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-dest.md",
				name: "save-archived-target-dest.md",
				markdown: "# Archived target dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const replacementMarkdown = normalize_pending_update_markdown(
			`${source.baseMarkdown}\n\nArchived target replacement`,
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-archived-target-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Any user archives the target file before the proposer accepts.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", dest.nodeId, { archiveOperationId: "archive-op-save-target" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		expect(saved._yay.newSequence).not.toBeNull();

		await t.run(async (ctx) => {
			// The save published the proposal onto the still-archived node and settled the row;
			// unarchiving later shows the saved text.
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBe("archive-op-save-target");
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeNull();
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			});
			expect(committedMarkdown).toBe(replacementMarkdown);
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});
});

describe("expire_file_pending_updates structural rows", () => {
	test("expiry keeps a saved node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-saved-renamed-dest.md",
				name: "expire-saved-renamed-dest.md",
				markdown: "# Expire saved renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing saved row before expiry");
			}
			return pendingRow;
		});

		// Another member renames the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_expire_saved_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await test_rename_node(t, asOtherUser, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "expire-saved-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			// The other user's rename must survive expiry: keep the node, drop only the row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-saved-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("expiry deletes a copy row but keeps the node", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-source.md",
				name: "expire-copy-source.md",
				markdown: "# Expire copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-dest.md",
				name: "expire-copy-dest.md",
				markdown: "# Expire copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/expire-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing copy row before expiry");
			}
			return pendingRow;
		});

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			// The row expires like a plain content row; the pre-existing node is never hard-deleted.
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-copy-dest.md");
		});
	});

	test("expiry deletes a pure-move row but keeps the node", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-move-src.md",
				name: "expire-move-src.md",
				markdown: "# Expire move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "expire-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing pending move row before expiry");
			}
			return pendingRow;
		});

		// A check run before the draft's expiry must not delete the proposal.
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});
		const rowAfterStaleRun = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id));
		expect(rowAfterStaleRun).not.toBeNull();

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/expire-move-src.md");
		});
	});
});

describe("reads behind a pure-move row", () => {
	test("committed content stays readable behind a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/read-move-src.md",
				name: "read-move-src.md",
				markdown: "# Read move base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/read-move-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "read-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing pending move row before reads");
		}

		// Chunk reads must fall through to the committed chunks, not return an empty pending view.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/read-move-src.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read returns the committed content but still reports the
		// structural row's id, so write_file/edit_file mix onto it.
		const markdownState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/read-move-src.md",
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);
	});
});

describe("pending path overlay reads", () => {
	test("get_by_path resolves through the proposer's pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-src.md",
				name: "overlay-src.md",
				markdown: "# Overlay base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "overlay-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// The claimed destination presents the moved node with its doc UNCHANGED.
		const atDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(atDest?._id).toBe(seeded.nodeId);
		expect(atDest?.path).toBe("/overlay-src.md");

		// The vacated source reads as missing for the proposer.
		const atSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(atSource).toBeNull();

		// Without `overlayUserId` the committed lookup is unchanged (other users' view).
		const committedSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-src.md",
		});
		expect(committedSource?._id).toBe(seeded.nodeId);
		const committedDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-dest.md",
		});
		expect(committedDest).toBeNull();

		// Another user commits a rename of the source node and a newcomer file takes the old
		// path. The newcomer is untouched by the overlay, so it stays visible to the proposer.
		const newcomerNodeId = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, {
				path: "/overlay-moved-away.md",
				treePath: "/overlay-moved-away.md",
				name: "overlay-moved-away.md",
			});
			return await ctx.db.insert("files_nodes", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				path: "/overlay-src.md",
				treePath: "/overlay-src.md",
				pathDepth: 1,
				lowercaseExtension: "md",
				name: "overlay-src.md",
				sortName: files_sort_text_key("overlay-src.md"),
				kind: "file",
				parentId: files_ROOT_ID,
				createdBy: seeded.userId,
				updatedBy: seeded.userId,
				updatedAt: Date.now(),
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

				archiveOperationId: null,
				newChildWritePolicy: null,
			});
		});
		const newcomer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(newcomer?._id).toBe(newcomerNodeId);
	});

	test("content reads at the claimed destination serve the moved file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-content-src.md",
				name: "overlay-content-src.md",
				markdown: "# Overlay content base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/overlay-content-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "overlay-content-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing pending move row before reads");
		}

		// Chunk reads translate the claimed destination to the moved file's content.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.target).toEqual({ kind: "saved", id: seeded.nodeId });
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read composes with the structural row: content resolves from the
		// committed tree and the row's id is still reported for mixing.
		const markdownState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);

		// The vacated source path serves nothing for the proposer.
		const vacatedRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/overlay-content-src.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(vacatedRead).toBeNull();
	});
});

// #region door 2 shape checks
describe("create_file_pending_update_operation_batch", () => {
	test("refuses an old batch after a new proposal reuses revision one", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/batch-replaced.md",
				name: "batch-replaced.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_move_for_test({
					t,
					...seeded,
					destParentId: files_ROOT_ID,
					destName: "first-move.md",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!before) throw new Error("Expected the first proposal");
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
					...(await reviewed_pending_for_test(t, {
						membershipId: seeded.membershipId,
						target: { kind: "saved", id: seeded.nodeId },
					})),
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await upsert_file_pending_move_for_test({
					t,
					...seeded,
					destParentId: files_ROOT_ID,
					destName: "second-move.md",
				})
			)._nay,
		).toBeUndefined();
		const after = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(after?._id).not.toBe(before._id);
		expect(after?.revision).toBe(before.revision);
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "old input",
		});
		expect(staged._nay?.name).toBe("target_changed");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect())).toEqual([]);
	});

	test("rejects sealed outputs after a same-time proposal change and keeps index revisions current", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/revision-base.md", text: "# Base" }),
		);
		r2Objects.set("content-snapshot/revision-base.md", "# Base");
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			...seeded,
			unstagedMarkdown: "---\ntopic: draft\n---\n# Proposed",
		});
		if (proposed._nay) throw new Error(proposed._nay.message);
		const before = await read_seeded_pending_row(t, seeded);
		if (!before) throw new Error("Expected the proposal");
		const beforeIndexes = await t.run(async (ctx) => ({
			text: await list_pending_update_text_chunks({ ctx, pendingUpdateId: before._id }),
			plain: await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: before._id }),
			metadata: await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", before._id))
				.collect(),
		}));
		const family = await seal_output_family_for_test(t, seeded);
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", family.operationBatchId)),
		).toMatchObject({ target: before.target, expectedRevision: before.revision, expectedPrivateVersion: null });

		// Two writes can share a millisecond. The revision must still reject the old batch.
		vi.spyOn(Date, "now").mockReturnValue(before.updatedAt);
		const moved = await upsert_file_pending_move_for_test({
			t,
			...seeded,
			destParentId: files_ROOT_ID,
			destName: "revision-moved.md",
		});
		expect(moved._nay).toBeUndefined();
		const after = await read_seeded_pending_row(t, seeded);
		if (!after) throw new Error("Expected the moved proposal");
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(after.revision).toBe(before.revision + 1);
		expect(after.content).toEqual(before.content);
		// The docs keep their revision. The proposal points its new revision at it.
		expect(files_pending_update_index_revision(after)).toBe(before.revision);
		await t.run(async (ctx) => {
			for (const rows of Object.values(beforeIndexes)) {
				expect(rows.length).toBeGreaterThan(0);
				expect(rows.every((row) => row.sourceKind === "pending" && row.proposalRevision === before.revision)).toBe(true);
			}
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: before._id })).toEqual(beforeIndexes.text);
			expect(await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: before._id })).toEqual(
				beforeIndexes.plain,
			);
			expect(
				await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", before._id))
					.collect(),
			).toEqual(beforeIndexes.metadata);
		});

		const committed = await t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: before._id,
			operationBatchId: family.operationBatchId,
			expectedRevision: before.revision,
			base: { kind: "asset", expectedAssetId: seeded.assetId },
			baseStateId: family.base.stateId,
			stagedStateId: family.staged.stateId,
			unstagedStateId: family.unstaged.stateId,
			baseStateDigest: family.base.digest,
			stagedStateDigest: family.staged.digest,
			unstagedStateDigest: family.unstaged.digest,
			unstagedText: "old output",
			unstagedBranchChanged: true,
		});
		expect(committed._nay?.name).toBe("target_changed");
		expect(await read_seeded_pending_row(t, seeded)).toEqual(after);
		expect(await t.run((ctx) => ctx.db.get("files_pending_update_yjs_states", family.base.stateId))).toMatchObject({
			owner: { kind: "temporary", operationBatchId: family.operationBatchId },
		});
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: family.operationBatchId,
		});
	});

	test.each(["creationGeneration", "structuralRevision", "state"] as const)(
		"refuses more private text after %s changes",
		async (field) => {
			const t = test_convex();
			const seeded = await t.run(async (ctx) => {
				const membership = await test_mocks_fill_db_with.membership(ctx);
				const { organizationId, workspaceId, userId } = membership;
				const nodeId = await ctx.db.insert("files_pending_nodes", {
					organizationId,
					workspaceId,
					userId,
					kind: "file",
					name: "private.txt",
					parent: { kind: "root" },
					creationGeneration: 1,
					structuralRevision: 1,
					state: "active",
					closedAt: null,
				});
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
					organizationId,
					workspaceId,
					userId,
					target: { kind: "private", id: nodeId },
					revision: 1,
					size: 0,
					updatedAt: Date.now(),
					expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
				});
				const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
					organizationId,
					workspaceId,
					userId,
					target: { kind: "private", id: nodeId },
					expectedPendingUpdateId: pendingUpdateId,
					expectedRevision: 1,
					expectedPrivateVersion: { creationGeneration: 1, structuralRevision: 1 },
					expiresAt: Date.now() + 60_000,
					updatedAt: Date.now(),
					lastActivityAt: Date.now(),
				});
				await ctx.db.patch(
					"files_pending_nodes",
					nodeId,
					field === "state" ? { state: "discarded", closedAt: Date.now() } : { [field]: 2 },
				);
				return { organizationId, workspaceId, userId, operationBatchId };
			});
			const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...seeded,
				role: "unstaged",
				text: "late text",
			});
			expect(staged._nay?.name).toBe("target_changed");
			expect(await t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect())).toEqual([]);
		},
	);

	test("refuses a second batch while one is already active for the same user and file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-admission",
				name: "pending-batch-admission",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(first._nay).toBeUndefined();

		// Two interleaved operations on one proposal would tear each other's staging, so the
		// second admission is a visible refusal instead of a silent queue.
		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay?.message).toBe("A pending update operation for this file is already in progress");
	});

	test("takes over the same user's batch once it sits idle past the takeover window", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-takeover",
				name: "pending-batch-takeover",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstBatchId = first._yay.operationBatchId;

		// A crashed client stages nothing, so only time passes. Age the liveness stamp past the
		// takeover window instead of waiting.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_operation_batches", firstBatchId, {
				lastActivityAt: Date.now() - 3 * 60 * 1000,
			});
		});

		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay).toBeUndefined();

		// The idle batch was retired by the takeover, not left active beside the new one.
		const firstBatch = await t.run(async (ctx) => ctx.db.get("files_pending_update_operation_batches", firstBatchId));
		expect(firstBatch?.expiresAt).toBe(0);
	});

	test("staging activity refreshes the liveness stamp, so an active client's batch is not taken over", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-active",
				name: "pending-batch-active",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstBatchId = first._yay.operationBatchId;

		// The batch looks idle, but the client then stages a text input, which refreshes the
		// liveness stamp.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_operation_batches", firstBatchId, {
				lastActivityAt: Date.now() - 3 * 60 * 1000,
			});
		});
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: firstBatchId,
			role: "unstaged",
			text: "# Still typing",
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}

		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay?.message).toBe("A pending update operation for this file is already in progress");
	});
});

describe("pending update state seal door 2", () => {
	function encode_doc(build: (yjsDoc: YDoc) => void) {
		const yjsDoc = new YDoc();
		yjsDoc.transact(() => build(yjsDoc));
		return files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));
	}

	async function seed_plain_text_pending_fixture(t: ReturnType<typeof test_convex>, path: string) {
		return await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path,
				name: path.slice(1),
				markdown: "",
				rootKind: "plain_text",
			}),
		);
	}

	// Control 8's named assertion: door 2 must NOT run door 1's content whitelist. A plain-text
	// document that also carries a real Tiptap `default` root encodes ContentType structs, so
	// the whitelist would refuse it forever — while parity on the plain root answers allow.
	test("accepts a branch state whose plain-text root is intact but which also carries a default root, and the pending row is patched", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-both-roots");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Both Roots User",
		});

		// Create the pending row through the real flow first: the rebase commit is update-only.
		const initialUpsert = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "line one\nline two\n",
			unstagedMarkdown: "line one\nline two\n",
		});
		if (initialUpsert._nay) {
			throw new Error(initialUpsert._nay.message);
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
		if (!pendingRow) {
			throw new Error("Missing pending row before the both-roots rebase");
		}

		// The both-roots branches: real content under plain_text, a stale tab's Tiptap paragraph
		// beside it. The client base is a clone of the live state.
		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const liveBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const stagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: liveBaseYjsDoc });
		stagedBranchYjsDoc.transact(() => {
			stagedBranchYjsDoc.getText("plain_text").insert(0, "line one\nline two\n");
			stagedBranchYjsDoc.getXmlFragment("default").insert(0, [new YXmlElement("paragraph")]);
		});
		const unstagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: liveBaseYjsDoc });
		unstagedBranchYjsDoc.transact(() => {
			unstagedBranchYjsDoc.getText("plain_text").insert(0, "line one\nline two\nline three\n");
			unstagedBranchYjsDoc.getXmlFragment("default").insert(0, [new YXmlElement("paragraph")]);
		});

		// Door 2 runs at the seal inside this helper: all three states must be accepted.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(stagedBranchYjsDoc)),
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(`Expected door 2 to accept the both-roots branch: ${persistResult._nay.message}`);
		}
		if (!persistResult._yay || !("pendingUpdate" in persistResult._yay)) {
			throw new Error("Expected the rebase action result while testing the both-roots branch");
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();

		// Save projects only the file's plain text onto the live document.
		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingRow._id,
			})),
			pendingUpdateId: pendingRow._id,
		});
		expect(saveResult._nay).toBeUndefined();
		const savedState = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
		const savedDoc = files_yjs_doc_create_from_array_buffer_update(savedState.yjsUpdate);
		expect(savedDoc.getText("plain_text").toString()).toBe("line one\nline two\n");
		expect(savedDoc.getXmlFragment("default").length).toBe(0);
		savedDoc.destroy();
		const remaining = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!remaining) throw new Error("Expected the unaccepted third line");
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: "line one\nline two\n",
			stagedMarkdown: "line one\nline two\n",
			unstagedMarkdown: "line one\nline two\nline three\n",
		});

		const discardResult = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingRow._id,
			})),
			pendingUpdateId: pendingRow._id,
		});
		expect(discardResult._nay).toBeUndefined();
	});

	test("refuses a branch state whose plain root is a Y.Map at the seal, before any write", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-map-root");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Map Root User",
		});

		// Parity is vacuously true on this state (a map's content is invisible to toString and
		// length); only the root-scoped `_map.size === 0` line refuses it. The refusal happens at
		// the first (base) seal, so no pending row and no canonical state is ever written.
		const mapRootState = encode_doc((d) => {
			d.getMap("plain_text").set("k", "v");
		});

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate: mapRootState,
			stagedBranchYjsUpdate: mapRootState,
			unstagedBranchYjsUpdate: mapRootState,
		});
		expect(persistResult._nay?.message).toBe("Update does not match the file shape");

		const row = await t.run((ctx) =>
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

	test("refuses malformed, V2-encoded, and zero-byte states with their named messages", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-encodings");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Encoding User",
		});
		const legalState = encode_doc((d) => {
			d.getText("plain_text").insert(0, "legal");
		});

		const persist_with_unstaged = async (unstaged: ArrayBuffer) =>
			await persist_file_pending_update_rebased_state_for_test(asUser, {
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				baseYjsSequence: 0,
				baseYjsUpdate: legalState,
				stagedBranchYjsUpdate: legalState,
				unstagedBranchYjsUpdate: unstaged,
			});

		const v2Doc = new YDoc();
		v2Doc.getText("plain_text").insert(0, "v2");
		expect((await persist_with_unstaged(files_u8_to_array_buffer(encodeStateAsUpdateV2(v2Doc))))._nay?.message).toBe(
			"Unsupported update encoding",
		);
		expect((await persist_with_unstaged(files_u8_to_array_buffer(new Uint8Array([255, 255, 255]))))._nay?.message).toBe(
			"Malformed update",
		);
		// Zero bytes must be a refusal, never a crash. The paged pipeline refuses it twice over:
		// a zero-byte page cannot be staged, and a role with no staged pages cannot be sealed
		// (the helper stages no page for zero bytes, so its seal finds no state).
		expect((await persist_with_unstaged(files_u8_to_array_buffer(new Uint8Array(0))))._nay?.message).toBe("Not found");
		const emptyPage = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (emptyPage._nay) {
			throw new Error(emptyPage._nay.message);
		}
		const stagedEmptyPage = await asUser.mutation(api.files_pending_updates.stage_file_pending_update_state_page, {
			membershipId: seeded.membershipId,
			operationBatchId: emptyPage._yay.operationBatchId,
			role: "unstaged",
			pageIndex: 0,
			bytes: files_u8_to_array_buffer(new Uint8Array(0)),
		});
		expect(stagedEmptyPage._nay?.message).toBe("Empty state page");
	});

	test("refuses a state page over the wire cap before any page insert", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-page-cap");

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}

		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: batch._yay.operationBatchId,
			phase: "input",
			role: "unstaged",
			pageIndex: 0,
			bytes: files_u8_to_array_buffer(new Uint8Array(files_MAX_YJS_WIRE_BYTES + 1)),
		});
		expect(staged._nay?.message).toBe(`State page exceeds ${files_MAX_YJS_WIRE_BYTES}-byte limit`);

		// The cap runs before the insert: no page row was written.
		const pages = await t.run(async (ctx) => ctx.db.query("files_pending_update_yjs_state_pages").collect());
		expect(pages).toHaveLength(0);
	});

	test("seals a legal multi-page tombstone-heavy state and refuses one over the 4 MiB cap", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-state-caps");

		// A legal state can be far larger than its visible text: a gc-disabled client doc keeps
		// deleted characters in its encoded state, so the size rule must come from the state
		// bytes, never the visible text.
		function tombstone_heavy_state(args: { cycles: number; cycleChars: number }) {
			const yjsDoc = new YDoc({ gc: false });
			const ytext = yjsDoc.getText("plain_text");
			for (let i = 0; i < args.cycles; i++) {
				ytext.insert(0, "a".repeat(args.cycleChars));
				ytext.delete(0, args.cycleChars);
			}
			ytext.insert(0, "kept\n");
			return files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));
		}

		// One batch for both roles (one active batch per user/node): the legal state seals under
		// the "unstaged" role, the over-cap one refuses under "staged".
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const operationBatchId = batch._yay.operationBatchId;

		async function stage_and_seal(role: "staged" | "unstaged", state: ArrayBuffer) {
			const bytes = new Uint8Array(state);
			for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
				const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
				const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					operationBatchId,
					phase: "input",
					role,
					pageIndex,
					bytes: files_u8_to_array_buffer(bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES)),
				});
				if (staged._nay) {
					throw new Error(staged._nay.message);
				}
			}
			return await t.mutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				operationBatchId,
				phase: "input",
				role,
				expectedTotalBytes: state.byteLength,
			});
		}

		// ~3.16 MB across four pages (the plan's round-13 legal full state, approximated): seals.
		const legalState = tombstone_heavy_state({ cycles: 4, cycleChars: 790_000 });
		expect(legalState.byteLength).toBeGreaterThan(2 * files_MAX_YJS_WIRE_BYTES);
		expect(legalState.byteLength).toBeLessThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
		const legalSealed = await stage_and_seal("unstaged", legalState);
		expect(legalSealed._nay).toBeUndefined();
		if (legalSealed._nay) {
			throw new Error(legalSealed._nay.message);
		}
		const sealedStateDoc = await t.run(async (ctx) =>
			ctx.db.get("files_pending_update_yjs_states", legalSealed._yay.stateId),
		);
		expect(sealedStateDoc).toMatchObject({ sealed: true, totalBytes: legalState.byteLength, pageCount: 4 });

		// One past 4 MiB: the seal refuses on the recorded byte total.
		const overState = tombstone_heavy_state({ cycles: 5, cycleChars: 850_000 });
		expect(overState.byteLength).toBeGreaterThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
		const overSealed = await stage_and_seal("staged", overState);
		expect(overSealed._nay?.message).toBe(`State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit`);
	});
});
// #endregion door 2 shape checks

// #region pending state TTL sweep
describe("stage_trusted_yjs_update", () => {
	test("a public_fill stage holds no bytes, expires in 5 minutes, and a restage replaces it", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/stage-fill", name: "stage-fill", markdown: "# Stage" }),
		);
		const stage = async () => {
			const staged = await t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				kind: "public_fill",
				update: files_u8_to_array_buffer(new Uint8Array([1, 2, 3])),
			});
			if (staged._nay) throw new Error(staged._nay.message);
			return staged._yay.stageId;
		};

		const before = Date.now();
		const firstStageId = await stage();
		// The second call replaces the first stage. The first stage has no hold to release.
		const secondStageId = await stage();

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_yjs_trusted_update_stages", firstStageId)).toBeNull();
			const secondStage = await ctx.db.get("files_yjs_trusted_update_stages", secondStageId);
			expect(secondStage!.expiresAt!).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
			expect(secondStage!.expiresAt!).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
			expect(await ctx.db.query("files_private_storage_reservations").collect()).toEqual([]);
		});
	});
});

describe("cleanup_expired_pending_state_rows", () => {
	async function seed_state_family(args: {
		t: ReturnType<typeof test_convex>;
		seeded: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			nodeId: Id<"files_nodes">;
		};
		owner:
			| { kind: "active"; pendingUpdateId: Id<"files_pending_updates">; role: "base" }
			| {
					kind: "temporary";
					operationBatchId: Id<"files_pending_update_operation_batches">;
					phase: "input";
					role: "base";
					expiresAt: number;
			  }
			| { kind: "retired"; cleanupTaskId: Id<"files_pending_update_state_cleanup_tasks"> };
		pageCount?: number;
	}) {
		const { t, seeded, pageCount = 1, owner } = args;

		return await t.run(async (ctx) => {
			const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				owner,
				lineageGeneration: 0,
				sealed: true,
				pageCount,
				totalBytes: pageCount * 2,
				digest: "test-digest",
			});
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "state", id: stateId },
						byteCount: pageCount * 2,
					})
				)._nay,
			).toBeUndefined();
			for (let pageIndex = 0; pageIndex < pageCount; pageIndex++)
				await ctx.db.insert("files_pending_update_yjs_state_pages", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					stateId,
					pageIndex,
					bytes: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				});
			return stateId;
		});
	}

	test("keeps the full byte charge until the last page is deleted across bounded passes", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-pages.md", name: "sweep-pages.md", markdown: "# Sweep" }),
		);
		const now = Date.now();
		const operationBatchId = await t.run((ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);
		const stateIds: Id<"files_pending_update_yjs_states">[] = [];
		for (let index = 0; index < 2; index++)
			stateIds.push(
				await seed_state_family({
					t,
					seeded,
					owner: { kind: "temporary", operationBatchId, phase: "input", role: "base", expiresAt: now - 1000 },
					pageCount: 5,
				}),
			);
		const first = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(first.done).toBe(false);
		const remaining = await t.run(async (ctx) => ({
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			holds: await ctx.db.query("files_private_storage_reservations").collect(),
		}));
		expect(remaining.pages).toHaveLength(4);
		expect(remaining.states).toHaveLength(1);
		expect(remaining.states[0]?.totalBytes).toBe(10);
		expect(remaining.holds.find((hold) => hold.resource.id === remaining.states[0]?._id)).toMatchObject({
			byteCount: 10,
			settlement: { kind: "held" },
		});
		const second = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(second.done).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_pending_update_yjs_state_pages").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toEqual([]);
			expect(await ctx.db.get("files_pending_update_operation_batches", operationBatchId)).toBeNull();
			const holds = await ctx.db.query("files_private_storage_reservations").collect();
			for (const id of stateIds)
				expect(holds.find((hold) => hold.resource.id === id)).toMatchObject({
					byteCount: 10,
					settlement: { kind: "deleted" },
				});
		});
	});

	test("sweeps expired temporary families but never active ones (the gte(0) lower bound)", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-bounds", name: "sweep-bounds", markdown: "# Sweep" }),
		);
		const now = Date.now();

		const pendingUpdateId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: now,
				expiresAt: now + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);
		const batchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: pendingUpdateId,
				expectedRevision: 1,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);

		// Docs without `owner.expiresAt` sort BEFORE every number on the index: without the
		// gte(0) lower bound the sweep would also return (and delete) this active family.
		const activeStateId = await seed_state_family({
			t,
			seeded,
			owner: {
				kind: "active",
				pendingUpdateId,
				role: "base",
			},
		});
		const expiredTemporaryStateId = await seed_state_family({
			t,
			seeded,
			owner: {
				kind: "temporary",
				operationBatchId: batchId,
				phase: "input",
				role: "base",
				expiresAt: now - 1000,
			},
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_yjs_states", activeStateId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_update_yjs_states", expiredTemporaryStateId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_operation_batches", batchId)).toBeNull();
		});
	});

	test("expired operation batches take their text inputs and temporary families with them", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-batches", name: "sweep-batches", markdown: "# Sweep" }),
		);
		const now = Date.now();
		const expiredBatchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);
		const liveBatchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now + 30 * 60 * 1000,
				lastActivityAt: now,
				updatedAt: now,
			}),
		);
		const expiredTextInputId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_text_inputs", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				operationBatchId: expiredBatchId,
				role: "staged",
				text: "staged text",
				expiresAt: now - 1000,
			}),
		);
		const expiredStageId = await t.run(async (ctx) =>
			ctx.db.insert("files_yjs_trusted_update_stages", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				fileNodeId: seeded.nodeId,
				kind: "pending_accept",
				update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				expiresAt: now - 1000,
			}),
		);
		await t.run(async (ctx) => {
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "text_input", id: expiredTextInputId },
						byteCount: files_get_utf8_byte_size("staged text"),
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "trusted_stage", id: expiredStageId },
						byteCount: 2,
					})
				)._nay,
			).toBeUndefined();
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_operation_batches", expiredBatchId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_operation_batches", liveBatchId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_update_text_inputs", expiredTextInputId)).toBeNull();
			expect(await ctx.db.get("files_yjs_trusted_update_stages", expiredStageId)).toBeNull();
		});
	});

	test("sweeps an expired public_fill stage that holds no bytes", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-fill", name: "sweep-fill", markdown: "# Sweep" }),
		);
		const now = Date.now();
		const expiredStageId = await t.run(async (ctx) =>
			ctx.db.insert("files_yjs_trusted_update_stages", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				fileNodeId: seeded.nodeId,
				kind: "public_fill",
				update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				expiresAt: now - 1000,
			}),
		);

		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_yjs_trusted_update_stages", expiredStageId)).toBeNull();
		});
	});

	test("drains retired cleanup tasks and tolerates a task whose states were already deleted", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-tasks", name: "sweep-tasks", markdown: "# Sweep" }),
		);
		const now = Date.now();

		// A task whose states user-deletion already removed: the drain must still delete the
		// task doc instead of keeping it forever as a false signal of pending work.
		const drainedTaskId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				createdAt: now,
			}),
		);
		// A task that still owns a family: the drain deletes states, pages, then the task.
		const ownedTaskId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				createdAt: now,
			}),
		);
		const retiredStateId = await seed_state_family({
			t,
			seeded,
			owner: {
				kind: "retired",
				cleanupTaskId: ownedTaskId,
			},
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", drainedTaskId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", ownedTaskId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_yjs_states", retiredStateId)).toBeNull();
		});
	});
});
// #endregion pending state TTL sweep

describe("pending update read-only checks", () => {
	test("a locked target refuses a new content proposal without creating a row", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-proposal.md",
				name: "pending-read-only-proposal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only proposal user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a proposal survives a lock and accepts after unlock", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-durable.md",
				name: "pending-read-only-durable.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only durable user",
		});
		const proposedMarkdown = "# Accepted after unlock";
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: proposedMarkdown,
			unstagedMarkdown: proposedMarkdown,
		});
		expect(proposed._nay).toBeUndefined();
		const pendingBeforeLock = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingBeforeLock) {
			throw new Error("Missing proposal before lock");
		}

		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		const refused = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingBeforeLock._id))).not.toBeNull();

		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		const accepted = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingBeforeLock._id))).toBeNull();
		expect(
			await t.run((ctx) =>
				read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		).toContain("Accepted after unlock");
	});

	test("a lock and unlock before the no-change final mutation still settles the batch", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-final-barrier.md",
				name: "pending-read-only-final-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only final barrier user",
		});
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const settled = await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			expectedRevision: null,
		});
		expect(settled._nay).toBeUndefined();
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId)))
				?.expiresAt,
		).toBe(0);
	});

	test("a no-change settle that read no doc leaves a doc that appeared since then", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-no-change-late-doc.md",
				name: "pending-no-change-late-doc.md",
				markdown: "# Base",
			}),
		);

		// The action read no doc. A concurrent write made one before the settle ran.
		const lateDoc = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Base\n\nLate doc",
		});
		if (lateDoc._nay) {
			throw new Error(lateDoc._nay.message);
		}
		const lateRow = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!lateRow) {
			throw new Error("expected the late doc to exist");
		}

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const settled = await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			expectedRevision: null,
		});
		expect(settled._nay?.message).toBe("Pending update changed, retry the write");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", lateRow._id))).toEqual(lateRow);
	});

	test("a lock before the no-change final mutation refuses and retires the batch", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-no-change-gap.md",
				name: "pending-read-only-no-change-gap.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only no-change gap user",
		});
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const operationBatchId = batch._yay.operationBatchId;
		const staged = await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: seeded.membershipId,
			operationBatchId,
			role: "unstaged",
			text: seeded.baseMarkdown,
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}

		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const proposing = asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			operationBatchId,
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const refused = await proposing;
		expect(refused._nay?.name).toBe("read_only");
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", operationBatchId)))?.expiresAt,
		).toBe(0);
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock and unlock before the refresh final mutation still refreshes the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-refresh-barrier.md",
				name: "pending-read-only-refresh-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only refresh barrier user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
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
			throw new Error("Missing proposal before refresh barrier");
		}
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const refreshed = await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingRow._id,
			expectedRevision: pendingRow.revision,
		});
		expect(refreshed._nay).toBeUndefined();

		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id));
		expect(rowAfter?.updatedAt).toBeGreaterThan(pendingRow.updatedAt);
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId)))
				?.expiresAt,
		).toBe(0);
	});

	test("a lock and unlock in the save action gap still saves the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-save-gap.md",
				name: "pending-read-only-save-gap.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only save gap user",
		});
		const proposalText = "# Save gap proposal";
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: proposalText,
			unstagedMarkdown: proposalText,
		});
		expect(proposed._nay).toBeUndefined();
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
			throw new Error("Missing proposal before save gap");
		}

		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const saving = test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const saved = await saving;
		expect(saved._nay).toBeUndefined();
		expect(saved._yay?.newSequence).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const trustedStages = await ctx.db
				.query("files_yjs_trusted_update_stages")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(trustedStages).toEqual([]);
			const lastSaved = await ctx.db
				.query("files_pending_updates_last_sequence_saved")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first();
			expect(lastSaved?.lastSequenceSaved).toBe(saved._yay?.newSequence);
			expect(
				await read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			).toContain("Save gap proposal");
		});
	});

	test("a lock and unlock before the rebase final mutation still rebases the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-rebase-final.md",
				name: "pending-read-only-rebase-final.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only rebase user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const [pendingRow, fileState] = await Promise.all([
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
			t.run((ctx) =>
				read_file_yjs_state({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		]);
		if (!pendingRow) {
			throw new Error("Missing proposal before rebase final");
		}
		const staged = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: fileState.yjsUpdate,
			stagedBranchYjsUpdate: fileState.yjsUpdate,
			unstagedBranchYjsUpdate: fileState.yjsUpdate,
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const rebased = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			operationBatchId: staged.operationBatchId,
			expectedRevision: pendingRow.revision,
			base: {
				kind: "yjs",
				baseYjsSequence: fileState.yjsSequence,
				baseLineageGeneration: 0,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			},
			baseStateId: staged.base.stateId,
			stagedStateId: staged.staged.stateId,
			unstagedStateId: staged.unstaged.stateId,
			baseStateDigest: staged.base.digest,
			stagedStateDigest: staged.staged.digest,
			unstagedStateDigest: staged.unstaged.digest,
			unstagedText: seeded.baseMarkdown,
		});
		expect(rebased._nay).toBeUndefined();
		expect(rebased._yay?.pendingUpdate?._id).toBe(pendingRow._id);
		expect(rebased._yay?.pendingUpdate?.updatedAt).toBeGreaterThan(pendingRow.updatedAt);
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", staged.operationBatchId)),
		).toBeNull();
	});

	test("a locked copy source stays readable", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-copy-source.md",
				name: "pending-read-only-copy-source.md",
				markdown: "# Source",
			}),
		);
		const copyDest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-copy-dest.md",
				name: "pending-read-only-copy-dest.md",
				markdown: "# Destination",
				membership: source,
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: source.userId,
			name: "Read-only copy user",
		});
		await set_pending_test_read_only({ asUser, membershipId: source.membershipId, nodeId: source.nodeId });

		// A copy only reads the source, so the source's lock does not stop it.
		const copied = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: copyDest.nodeId,
			unstagedMarkdown: source.baseMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/pending-read-only-copy-source.md" },
		});
		expect(copied._nay).toBeUndefined();
	});

	test("a locked move participant refuses proposal, while a durable move accepts after unlock", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-source.md",
				name: "pending-read-only-move-source.md",
				markdown: "# Source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-occupant.md",
				name: "pending-read-only-move-occupant.md",
				markdown: "# Occupant",
				membership: source,
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: source.userId,
			name: "Read-only move user",
		});
		await set_pending_test_read_only({ asUser, membershipId: source.membershipId, nodeId: occupant.nodeId });
		const blockedReplacement = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-occupant.md",
			replace: true,
		});
		expect(blockedReplacement._nay?.name).toBe("read_only");
		await set_pending_test_writable({ asUser, membershipId: source.membershipId, nodeId: occupant.nodeId });

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-moved.md",
		});
		expect(proposed._nay).toBeUndefined();
		await set_pending_test_read_only({ asUser, membershipId: source.membershipId, nodeId: source.nodeId });
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: source.membershipId,
			target: { kind: "saved", id: source.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: source.membershipId,
				target: { kind: "saved", id: source.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		await set_pending_test_writable({ asUser, membershipId: source.membershipId, nodeId: source.nodeId });
		const accepted = await test_apply_file_pending_move(asUser, {
			membershipId: source.membershipId,
			target: { kind: "saved", id: source.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: source.membershipId,
				target: { kind: "saved", id: source.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_nodes", source.nodeId)))?.path).toBe("/pending-read-only-moved.md");
	});

	test("a locked descendant refuses a folder archive proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-archive-folder",
				name: "pending-read-only-archive-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.childNodeId });

		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.folderId,
		});
		expect(proposed._nay?.name).toBe("read_only");
	});

	test("a locked file refuses the content batch before any Yjs state is staged", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-batch-door.md",
				name: "pending-read-only-batch-door.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only batch door user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// The editor asks for a batch before it uploads any branch state. Refusing here keeps the
		// client from uploading Yjs pages that could never be committed.
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(batch._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect())).toEqual([]);
	});

	test("a batch made on a locked file cannot commit", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-batch-lock.md", text: "# Off base" }),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only batch commit user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// The internal batch door checks nothing by design: its callers check. Only the commit can
		// still refuse this write, so a batch made after the lock must not carry a write through.
		const staged = await seal_output_family_for_test(t, seeded);
		const commit = (family: typeof staged) =>
			t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: family.operationBatchId,
				expectedRevision: null,
				base: { kind: "asset", expectedAssetId: seeded.assetId },
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "# Draft",
				unstagedBranchChanged: true,
			});

		const committed = await commit(staged);
		expect(committed._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();

		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		// The refused commit left its batch active; the retry starts over with a fresh one.
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: staged.operationBatchId,
		});
		const retry = await seal_output_family_for_test(t, seeded);
		const retried = await commit(retry);
		expect(retried._nay).toBeUndefined();
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).not.toBeNull();
	});

	test("a private draft cannot publish while its parent folder is locked", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read-only draft publish user",
		});
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/locked-parent",
				name: "locked-parent",
			}),
		);
		// The real producer accepts the draft before the parent becomes read-only.
		const draft = await create_private_text_for_test({ path: "/locked-parent/draft.txt", staged: "Saved from a private draft\n", collaborative: false }, { t, membershipId: db.membershipId });
		await set_pending_test_read_only({ asUser, membershipId: db.membershipId, nodeId: folderId });
		const publish = () => test_save_file_pending_update(asUser, {
			membershipId: db.membershipId,
			target: draft.target,
			pendingUpdateId: draft.pendingUpdateId,
			reviewedRevision: draft.proposal.revision,
		});

		const refused = await publish();
		expect(refused._nay).toBeDefined();
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_nodes", draft.target.id)).toMatchObject({ state: "active" });
			expect(await ctx.db.get("files_pending_updates", draft.pendingUpdateId)).not.toBeNull();
			expect(await ctx.db.query("files_nodes").collect()).toEqual([expect.objectContaining({ _id: folderId })]);
		});

		await set_pending_test_writable({ asUser, membershipId: db.membershipId, nodeId: folderId });
		const published = await publish();
		if (published._nay) throw new Error(published._nay.message);
		expect(published._yay.target.kind).toBe("saved");
	});

	test("a private draft cannot edit while its parent folder is locked", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx);
			const folderId = await seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/draft-parent",
				name: "draft-parent",
			});
			const created = await files_pending_nodes_db_create(ctx, {
				...db,
				parent: { kind: "saved", id: folderId },
				name: "draft.txt",
				kind: "file",
			});
			if (created._nay) throw new Error(created._nay.message);
			return { ...db, folderId, privateNodeId: created._yay.privateNodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only draft edit user",
		});
		const target = { kind: "private" as const, id: seeded.privateNodeId };
		const readTarget = () =>
			asUser.query(api.files_pending_target.get_file_pending_target, {
				membershipId: seeded.membershipId,
				target,
			});

		expect((await readTarget())?.canEdit).toBe(true);
		// The header's breadcrumb hangs the pending chain from this saved folder.
		expect((await readTarget())?.savedParentId).toBe(seeded.folderId);
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.folderId });
		expect((await readTarget())?.canEdit).toBe(false);
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.folderId });
		expect((await readTarget())?.canEdit).toBe(true);
	});

	test("the agent proposal path refuses a locked file", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-agent-path.md",
				name: "pending-read-only-agent-path.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only agent path user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// The agent creates its batch server-side, so it never passes the public batch door above.
		// An agent write is still a normal write and has to stop at the lock.
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Agent draft",
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock taken while the content action runs refuses the commit mutation", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-commit-barrier.md",
				name: "pending-read-only-commit-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only commit barrier user",
		});

		// Hold the action inside its snapshot read, then lock. The action already checked the lock,
		// so only the commit mutation can still refuse this write.
		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const proposing = upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const proposed = await proposing;

		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock before the refresh final mutation refuses and keeps the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-refresh-refusal.md",
				name: "pending-read-only-refresh-refusal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only refresh refusal user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
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
			throw new Error("Missing proposal before refresh refusal");
		}
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// A refresh rewrites the stored branches, so it is a write and the lock stops it. The
		// proposal itself stays, so the user can still read or discard it.
		const refreshed = await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingRow._id,
			expectedRevision: pendingRow.revision,
		});
		expect(refreshed._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id)))?.updatedAt).toBe(
			pendingRow.updatedAt,
		);
	});

	test("a lock before the rebase final mutation refuses and keeps the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-rebase-refusal.md",
				name: "pending-read-only-rebase-refusal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only rebase refusal user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const [pendingRow, fileState] = await Promise.all([
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
			t.run((ctx) =>
				read_file_yjs_state({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		]);
		if (!pendingRow) {
			throw new Error("Missing proposal before rebase refusal");
		}
		const staged = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: fileState.yjsUpdate,
			stagedBranchYjsUpdate: fileState.yjsUpdate,
			unstagedBranchYjsUpdate: fileState.yjsUpdate,
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// A rebase replaces the stored branch states, so it writes and the lock stops it.
		const rebased = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			operationBatchId: staged.operationBatchId,
			expectedRevision: pendingRow.revision,
			base: {
				kind: "yjs",
				baseYjsSequence: fileState.yjsSequence,
				baseLineageGeneration: 0,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			},
			baseStateId: staged.base.stateId,
			stagedStateId: staged.staged.stateId,
			unstagedStateId: staged.unstaged.stateId,
			baseStateDigest: staged.base.digest,
			stagedStateDigest: staged.staged.digest,
			unstagedStateDigest: staged.unstaged.digest,
			unstagedText: seeded.baseMarkdown,
		});
		expect(rebased._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id)))?.updatedAt).toBe(
			pendingRow.updatedAt,
		);
	});

	test("a lock taken while the save action runs refuses the save mutation", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-save-barrier.md",
				name: "pending-read-only-save-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only save barrier user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "# Save barrier draft",
			unstagedMarkdown: "# Save barrier draft",
		});
		expect(proposed._nay).toBeUndefined();

		// Hold the save action inside its snapshot read, then lock. The action already checked the
		// lock, so only the final save mutation can still refuse this write.
		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const saving = test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const saved = await saving;

		expect(saved._nay?.name).toBe("read_only");
		await t.run(async (ctx) => {
			expect(
				await read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			).not.toBeNull();
			expect(
				await read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			).not.toContain("Save barrier draft");
		});
	});

	test("a locked move source refuses the proposal, and a locked file inside a moved folder does not", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-leaf.md",
				name: "pending-read-only-move-leaf.md",
				markdown: "# Leaf",
				membership,
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-folder",
				name: "pending-read-only-move-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, leafNodeId: file.nodeId, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only move source user",
		});

		// A move renames the node itself, so a lock on the moved file refuses the proposal.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.leafNodeId });
		const refusedLeaf = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.leafNodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-leaf-renamed.md",
		});
		expect(refusedLeaf._nay?.name).toBe("read_only");

		// A writable folder may move while it holds a locked child. Rename and move check the named
		// item and its immediate parent, not descendants.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.childNodeId });
		const movedFolder = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.folderId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-folder-renamed",
		});
		expect(movedFolder._nay).toBeUndefined();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.folderId,
				}),
			),
		).not.toBeNull();
	});

	test("a locked destination refuses a proposal and a locked replacement child refuses Accept", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-dest-file.md",
				name: "pending-read-only-move-dest-file.md",
				markdown: "# Mover",
				membership,
			});
			const destFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-dest",
				name: "pending-read-only-move-dest",
			});
			const sourceFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-src-folder",
				name: "pending-read-only-move-src-folder",
			});
			const occupantFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-occupant-folder",
				name: "pending-read-only-move-occupant-folder",
			});
			const occupantChild = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-occupant-folder/child.md",
				name: "child.md",
				markdown: "# Occupant child",
				membership,
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantFolderId });
			return {
				...membership,
				fileNodeId: file.nodeId,
				destFolderId,
				sourceFolderId,
				occupantFolderId,
				occupantChildNodeId: occupantChild.nodeId,
			};
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only move destination user",
		});

		// Dropping a file into a folder adds a child entry to that folder, so a locked destination
		// refuses the proposal.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.destFolderId });
		const refusedDestination = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileNodeId,
			destParentId: seeded.destFolderId,
			destName: "pending-read-only-move-dest-file.md",
		});
		expect(refusedDestination._nay?.name).toBe("read_only");

		// Accept checks archived children before replacing the folder.
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.occupantChildNodeId],
		});
		expect(archived._nay).toBeUndefined();
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.occupantChildNodeId });
		const proposedOccupant = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.sourceFolderId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-occupant-folder",
			replace: true,
		});
		expect(proposedOccupant._nay).toBeUndefined();
		const refusedOccupant = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.sourceFolderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.sourceFolderId },
			})),
		});
		expect(refusedOccupant._nay?.name).toBe("read_only");
		expect((await t.run(ctx => ctx.db.get("files_nodes", seeded.sourceFolderId)))?.path)
			.toBe("/pending-read-only-move-src-folder");
		expect((await t.run(ctx => ctx.db.get("files_nodes", seeded.occupantFolderId)))?.archiveOperationId).toBeNull();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.sourceFolderId,
				}),
			),
		).not.toBeNull();
	});

	test("a locked file refuses its own archive proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-self.md",
				name: "pending-read-only-archive-self.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive self user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock on the file or on an active descendant refuses the archive accept", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-accept.md",
				name: "pending-read-only-archive-accept.md",
				markdown: "# Base",
				membership,
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-archive-accept-folder",
				name: "pending-read-only-archive-accept-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-accept-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, fileNodeId: file.nodeId, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive accept user",
		});
		for (const nodeId of [seeded.fileNodeId, seeded.folderId]) {
			const proposed = await upsert_file_pending_archive_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId,
			});
			if (proposed._nay) {
				throw new Error(proposed._nay.message);
			}
		}

		// Both proposals were made while everything was writable. Accept checks the current lock
		// again: once on the node itself, and once on every active file the archive would sweep.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.fileNodeId });
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.childNodeId });
		const refusedFile = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.fileNodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.fileNodeId },
			})),
		});
		expect(refusedFile._nay?.name).toBe("read_only");
		const refusedFolder = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.folderId },
			})),
		});
		expect(refusedFolder._nay?.name).toBe("read_only");
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.fileNodeId))?.archiveOperationId).toBeNull();
			expect((await ctx.db.get("files_nodes", seeded.folderId))?.archiveOperationId).toBeNull();
		});
	});
});

describe("pending file that was moved while pending", () => {
	test("accept saves content onto the moved node", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-mv-repro.md",
				name: "qa-mv-repro.md",
				markdown: "# Base",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-dest",
				name: "qa-mv-dest",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const moved = await test_move_nodes(t, asUser, {
				membershipId: seeded.membershipId,
				itemIds: [seeded.nodeId],
				targetParentId: destFolderId,
			});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.path).toBe("/qa-mv-dest/qa-mv-repro.md");

		const saved = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saved._nay).toBeUndefined();

		const row = await t.run((ctx) =>
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

	test("agent mv of a saved file with pending content onto an occupied path stays reviewable", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-mv-src2/qa-mv-saved2.md",
				name: "qa-mv-saved2.md",
				markdown: "# Base",
			}),
		);
		const srcFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-src2",
				name: "qa-mv-src2",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-dst2",
				name: "qa-mv-dst2",
			}),
		);
		// A committed occupant already owns the destination path.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { parentId: srcFolderId });
			const occupant = await seed_file_with_markdown({
				ctx,
				path: "/qa-mv-dst2/qa-mv-saved2.md",
				name: "qa-mv-saved2.md",
				markdown: "# Existing",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			});
			await ctx.db.patch("files_nodes", occupant.nodeId, { parentId: destFolderId });
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "qa-mv-saved2.md",
			replace: true,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		// The occupant's fate is reviewable, so the move stays a proposal.
		expect(proposed._yay.appliedImmediately).toBe(false);
		expect(proposed._yay.replacesExistingOccupant).toBe(true);

		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.path).toBe("/qa-mv-src2/qa-mv-saved2.md");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("qa-mv-saved2.md");
	});

	test("mv -f onto a saved occupant stays reviewable when another member has a pending row on it", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-other-src.md",
				name: "saved-other-src.md",
				markdown: "# e1",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-other-dst.md",
				name: "saved-other-dst.md",
				markdown: "# e2",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const sourceUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nAgent content`,
		});
		if (sourceUpserted._nay) {
			throw new Error(sourceUpserted._nay.message);
		}
		// Another member's draft on the destination makes it real work — no hard delete.
		const otherRowId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_saved_move_guard" }),
				target: { kind: "saved", id: dest.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "saved-other-dst.md",
			replace: true,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		expect(moved._yay.appliedImmediately).toBe(false);
		expect(moved._yay.replacesExistingOccupant).toBe(true);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", dest.nodeId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_updates", otherRowId)).not.toBeNull();
		});
	});

	test("mv -f onto a saved occupant stays reviewable after committed content landed on it", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-edited-src.md",
				name: "saved-edited-src.md",
				markdown: "# e1",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-edited-dst.md",
				name: "saved-edited-dst.md",
				markdown: "# e2",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		for (const seeded of [source, dest]) {
			const upserted = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			});
			if (upserted._nay) {
				throw new Error(upserted._nay.message);
			}
		}

		// A saved edit on the destination keeps replacement subject to review.
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			if (!node?.yjsLastSequenceId) {
				throw new Error("Expected a yjs last sequence doc on the destination");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", node.yjsLastSequenceId, { lastSequence: 1 });
		});

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "saved-edited-dst.md",
			replace: true,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		expect(moved._yay.appliedImmediately).toBe(false);
		expect(moved._yay.replacesExistingOccupant).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", dest.nodeId))).not.toBeNull();
	});
});
