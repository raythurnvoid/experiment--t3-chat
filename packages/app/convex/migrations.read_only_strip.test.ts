import { expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { create_private_text_for_test, mock_pending_updates_storage } from "./files_pending_updates.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
	test_spy_handler,
} from "./setup.test.ts";

async function setup() {
	const t = test_convex();
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-strip-test" });
		return test_mocks_fill_db_with.membership(ctx, { userId });
	});
	const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, owner };
}

test("strip keeps the current decision, content fields and timestamps on a migrated node", async () => {
	const { t, db, owner } = await setup();
	const created = await owner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "kept",
	});
	if (created._nay) throw new Error(created._nay.message);
	const nodeId = created._yay.nodeId;
	expect(await owner.mutation(api.files_nodes.read_only_set, {
		membershipId: db.membershipId, nodeId, readOnly: true,
	})).toEqual({ _yay: null });
	const before = await t.run(async (ctx) => {
		await ctx.db.patch("files_nodes", nodeId, {
			writePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
			newChildWritePolicy: { mode: "read_only" },
		});
		return await ctx.db.get("files_nodes", nodeId);
	});
	if (!before) throw new Error("Missing test node");
	const { writePolicy: _writePolicy, newChildWritePolicy: _newChildWritePolicy, ...expected } = before;
	await expect(t.mutation(internal.migrations.preview_read_only_strip, {
		migration: "nodes", cursor: null, batchSize: 25,
	})).rejects.toThrow(/READ_ONLY_STRIP_PREVIEW/);
	expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	for (let attempt = 0; attempt < 2; attempt++) {
		await t.mutation(internal.migrations.strip_read_only_nodes, {
			oneBatchOnly: true, dryRun: false, cursor: null, batchSize: 25,
		});
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(expected);
	}
});

test("Save cannot copy old policy fields back after review items were stripped", async () => {
	const { t, db, owner } = await setup();
	const source = await owner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId, parentId: "root", path: "source",
	});
	if (source._nay) throw new Error(source._nay.message);
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
		kind: "folder", path: "/copy",
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder");
	const pendingUpdateId = created._yay.pendingUpdateId;
	const copiedFrom = {
		target: { kind: "saved" as const, id: source._yay.nodeId }, path: "/source", sourceReadOnly: true,
	};
	const proposal = await t.run(async (ctx) => {
		await ctx.db.patch("files_pending_updates", pendingUpdateId, {
			copiedFrom: { ...copiedFrom, sourceWritePolicy: { mode: "read_only" }, sourceNewChildWritePolicy: null },
		});
		return await ctx.db.get("files_pending_updates", pendingUpdateId);
	});
	if (!proposal) throw new Error("Missing test proposal");
	await t.mutation(internal.migrations.strip_read_only_review_items, {
		oneBatchOnly: true, dryRun: false, cursor: null, batchSize: 25,
	});
	const started = await owner.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId, requestId: "save-after-strip", kind: "accept", expectedItemCount: 1,
		items: [{ pendingUpdateId, reviewedRevision: proposal.revision, selectedContentStateId: null }],
	});
	if (started._nay) throw new Error(started._nay.message);
	const item = await t.run((ctx) => ctx.db.query("files_pending_update_run_items").unique());
	expect(item?.reviewHeader?.copiedFrom).toEqual(copiedFrom);
	expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toEqual(proposal);
});

test("Move capture keeps copied draft fields without old policy keys", async () => {
	vi.useFakeTimers();
	mock_pending_updates_storage();
	try {
		const { t, db, owner } = await setup();
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId, path: "/source.txt", textContent: "copied text",
		});
		expect(await owner.mutation(api.files_nodes.read_only_set, {
			membershipId: db.membershipId, nodeId: sourceId, readOnly: true,
		})).toEqual({ _yay: null });
		const draft = await create_private_text_for_test(
			{ path: "/copy.txt", staged: "copied text" }, { t, membershipId: db.membershipId },
		);
		const copiedFrom = {
			target: { kind: "saved" as const, id: sourceId }, path: "/source.txt", sourceReadOnly: true,
		};
		// A mapped copy still has its old captured fields until the proposal strip reaches it.
		await t.run((ctx) => ctx.db.patch("files_pending_updates", draft.pendingUpdateId, {
			copiedFrom: { ...copiedFrom, sourceWritePolicy: { mode: "read_only" }, sourceNewChildWritePolicy: null },
		}));
		await t.mutation(internal.migrations.strip_read_only_move_items, {
			oneBatchOnly: true, dryRun: false, cursor: null, batchSize: 25,
		});
		const captured: NonNullable<Doc<"files_move_cohort_items">["afterProposal"]>[] = [];
		test_spy_handler(advance_cohort, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			const { cohortId } = args as { cohortId: Doc<"files_move_cohorts">["_id"] };
			const item = await ctx.db.query("files_move_cohort_items")
				.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohortId))
				.first();
			if (!captured.length && item?.pendingUpdateId === draft.pendingUpdateId && item.afterProposal)
				captured.push(item.afterProposal);
			return result;
		});
		const started = await owner.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId, requestId: "move-after-strip", kind: "accept", expectedItemCount: 1,
			items: [{
				pendingUpdateId: draft.pendingUpdateId, reviewedRevision: draft.proposal.revision,
				selectedContentStateId: draft.proposal.content!.stagedStateId,
			}],
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(await owner.mutation(api.files_pending_update_runs.seal, {
			membershipId: db.membershipId, runId: started._yay.runId,
		})).toEqual({ _yay: null });
		await test_finish_pending_update_run(owner, started._yay.runId, { stepwise: true });
		expect(captured).toHaveLength(1);
		expect(captured[0]!.copiedFrom).toEqual(copiedFrom);
		const { _id: _id, _creationTime: _time, moveCohortId: _cohort, ...header } = draft.proposal;
		expect(captured[0]).toEqual({
			...header, copiedFrom, pendingMove: undefined, pendingArchive: undefined, revision: draft.proposal.revision + 1,
		});
		expect(await t.run((ctx) => ctx.db.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) => q
				.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId)
				.eq("moveCohortId", undefined).eq("path", "/copy.txt").eq("archiveOperationId", null))
			.unique())).toMatchObject({ readOnly: true });
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});

test("an old prepare cannot lose the Read-only intent that its old publisher sends later", async () => {
	const { t, db, owner } = await setup();
	const key = await owner.mutation(api.public_api.api_credential_create, {
		membershipId: db.membershipId, serviceAccountId: null, name: "Migration test",
		scopes: ["files:write", "files:read-only"],
	});
	if (key._nay) throw new Error(key._nay.message);
	// The old action has no writeFormat or requestReadOnly at prepare time.
	const oldPrepare = makeFunctionReference<"mutation">("public_api:prepare_file_write");
	await expect(t.mutation(oldPrepare, {
		organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
		principalRef: { kind: "user_api_key", credentialId: key._yay.credentialId },
		path: "/old-request.md", overwrite: "fail", contentSize: 4, yjsSnapshotSize: 4,
		contentType: "text/markdown", yjsRootKind: "rich_text",
	})).rejects.toThrow(/writeFormat/);
	expect(await t.run((ctx) => ctx.db.query("public_api_file_write_stages").collect())).toEqual([]);
	const prepared = await t.mutation(internal.public_api.prepare_file_write, {
		writeFormat: "read_only",
		organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
		principalRef: { kind: "user_api_key", credentialId: key._yay.credentialId },
		path: "/new-request.md", overwrite: "fail", contentSize: 4, yjsSnapshotSize: 4,
		contentType: "text/markdown", yjsRootKind: "rich_text", requestReadOnly: true,
	});
	if (prepared._nay) throw new Error(prepared._nay.message);
	expect(await t.run((ctx) => ctx.db.get("public_api_file_write_stages", prepared._yay.stageId)))
		.toMatchObject({ requestReadOnly: true, force: false });
	const oldPublish = makeFunctionReference<"mutation">("public_api:publish_file_write");
	await expect(t.mutation(oldPublish, {
		stageId: prepared._yay.stageId, content: "text", targetAnchor: prepared._yay.targetAnchor,
		requestReadOnly: true,
	})).rejects.toThrow(/writeFormat/);
	expect(await t.run((ctx) => ctx.db.get("public_api_file_write_stages", prepared._yay.stageId))).not.toBeNull();
});
