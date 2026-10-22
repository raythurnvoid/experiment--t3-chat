import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_MOVE_WAIT_CODE, type files_PendingParent } from "../shared/files.ts";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	mock_pending_updates_storage,
	read_file_markdown_from_yjs,
	seed_chat_thread,
	upsert_file_pending_update_internal_for_test,
	upsert_file_pending_update_public_for_test,
} from "./files_pending_updates.setup.test.ts";
import { files_db_get_pending_update } from "../server/files.ts";
import { files_pending_updates_action_prepare_content } from "./files_pending_updates.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_pending_updates_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(collaborative = true) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "f2-mover" });
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
	const mover = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "f2-editor" }));
	await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId, plan: "Free" }));
	expect(
		await mover.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userIdToAdd: userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("userId", userId).eq("active", true),
			)
			.unique(),
	);
	if (!membership) throw new Error("Expected the invited editor");
	const editor = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId };
	const folder = async (path: string) => {
		vi.setSystemTime(Date.now() + 10_000);
		const created = await mover.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const sourceId = await folder("source");
	const destinationId = await folder("destination");
	const otherId = await folder("other");
	const created = await mover.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: sourceId,
		path: "child.txt",
	});
	if (created._nay) throw new Error(created._nay.message);
	const nodeId = created._yay.nodeId;
	if (!collaborative)
		expect(
			await mover.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
	const target = { kind: "saved" as const, id: nodeId };
	const proposal = () => t.run((ctx) => files_db_get_pending_update(ctx, { ...scope, target }));
	const edit = async (stagedMarkdown?: string, unstagedMarkdown = "draft\n") => {
		vi.setSystemTime(Date.now() + 10_000);
		return await upsert_file_pending_update_internal_for_test({
			t,
			...scope,
			nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
	};
	const move = (destParent: files_PendingParent, destName = "child.txt") =>
		t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...scope,
			target,
			destParent,
			destName,
		});
	const archive = () =>
		t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, { ...scope, target });
	const copy = async (
		beforeWorker?: () => Promise<void>,
		afterWorker?: (runId: Id<"files_transfer_runs">) => Promise<void>,
	) => {
		const source = await mover.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: otherId,
			path: "replacement.txt",
		});
		if (source._nay) throw new Error(source._nay.message);
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...scope }));
		const started = await t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: membership._id,
			threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: crypto.randomUUID(),
			kind: "copy",
			expectedSourceCount: 1,
			sources: [{ kind: "saved", id: source._yay.nodeId }],
			targetParent: { kind: "saved", id: sourceId },
			targetPath: "/source",
			targetName: "child.txt",
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: membership._id,
				threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 12; step++) {
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.first(),
			);
			if (item?.workId) {
				await beforeWorker?.();
				beforeWorker = undefined;
				await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
				await t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "success", returnValue: null },
				});
				await afterWorker?.(started._yay.runId);
				afterWorker = undefined;
				if (await proposal()) break;
			}
		}
		expect((await proposal())?.pendingReplacement, "native Copy produces the replacement").toBeDefined();
		await test_finish_transfer_run(editor, started._yay.runId);
	};
	const snapshot = () =>
		t.run(async (ctx) => ({
			proposal: await files_db_get_pending_update(ctx, { ...scope, target }),
			file: await ctx.db.get("files_nodes", nodeId),
			assets: await ctx.db.query("files_r2_assets").collect(),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			chunks: await ctx.db.query("files_text_chunks").collect(),
		}));
	const start = async (movingId = sourceId) => {
		const overlay = await import("../server/files-pending-overlay.ts");
		const canJoin = overlay.files_pending_overlay_db_can_join_step;
		// Stop between native steps so the parent is reached before its child.
		const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, factor) => {
			const allowed = await canJoin(ctx, factor);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique();
			return allowed && !slot?.cohortId;
		});
		const started = await mover.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [movingId],
			targetParentId: destinationId,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await mover.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId }),
		).toEqual({ _yay: null });
		for (let step = 0; step < 100; step++) {
			const source = await t.run((ctx) =>
				ctx.db
					.query("files_move_source_reservations")
					.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", movingId))
					.unique(),
			);
			if (source) {
				expect(source.mode, "the native Move closes the direct child set").toBe("children");
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("files_move_source_reservations")
							.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", nodeId))
							.unique(),
					),
					"the child has not been captured",
				).toBeNull();
				return async (stop = false) => {
					if (stop)
						expect(
							await mover.mutation(api.files_transfer.stop, {
								membershipId: db.membershipId,
								runId: started._yay.runId,
							}),
						).toEqual({ _yay: null });
					join.mockRestore();
					await test_finish_transfer_run(mover, started._yay.runId);
				};
			}
			const cohort = await t.run((ctx) =>
				ctx.db
					.query("files_move_cohorts")
					.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", started._yay.runId))
					.first(),
			);
			if (cohort)
				await t.action(internal.files_move_run.run, {
					cohortId: cohort._id,
					step: cohort.step,
					runGeneration: cohort.runJob?.generation ?? null,
					mode: "step",
				});
			else await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		}
		throw new Error("Move did not reach the source folder");
	};
	return {
		t,
		db,
		mover,
		editor,
		scope,
		membership,
		nodeId,
		target,
		sourceId,
		otherId,
		proposal,
		edit,
		move,
		archive,
		copy,
		snapshot,
		start,
	};
}

test.each(["agent", "human"] as const)("first %s proposal waits for its direct parent", async (kind) => {
	const f = await fixture();
	const finish = await f.start();
	const result =
		kind === "agent"
			? await f.edit()
			: await upsert_file_pending_update_public_for_test(f.editor, {
					membershipId: f.membership._id,
					nodeId: f.nodeId,
					unstagedMarkdown: "draft\n",
				});
	expect(result, "first proposal returns typed busy before publishing its content").toMatchObject({
		_nay: { name: "move_busy" },
	});
	expect(await f.proposal()).toBeNull();
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect())).toMatchObject([
		{ expiresAt: 0 },
	]);
	await finish();
	expect((await f.edit())._nay).toBeUndefined();
});

test.each(["full", "content", "move", "archive"] as const)(
	"%s Discard keeps held membership unchanged",
	async (kind) => {
		const f = await fixture();
		if (kind === "move") expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
		else if (kind === "archive") expect((await f.archive())._nay).toBeUndefined();
		else expect((await f.edit())._nay).toBeUndefined();
		const finish = await f.start();
		const before = await f.snapshot();
		if (!before.proposal) throw new Error("Expected the proposal");
		const door =
			kind === "full"
				? api.files_pending_updates.discard_file_pending_update
				: kind === "content"
					? api.files_pending_updates.discard_file_pending_content
					: api.files_pending_updates.discard_file_pending_structural;
		await expect(
			f.editor.mutation(door, {
				membershipId: f.membership._id,
				target: f.target,
				pendingUpdateId: before.proposal._id,
				reviewedRevision: before.proposal.revision,
			}),
			"Discard returns typed busy before any cleanup",
		).resolves.toMatchObject({ _nay: { name: "move_busy" } });
		expect(await f.snapshot(), "busy Discard keeps assets, states, chunks and revisions").toEqual(before);
		await finish();
		const current = await f.proposal();
		if (!current) throw new Error("Expected the kept proposal");
		expect(
			await f.editor.mutation(door, {
				membershipId: f.membership._id,
				target: f.target,
				pendingUpdateId: current._id,
				reviewedRevision: current.revision,
			}),
		).toEqual({ _yay: null });
		expect(await f.proposal()).toBeNull();
	},
);

test.each(["staged", "move", "archive"] as const)(
	"content Discard keeps surviving %s membership writable",
	async (kind) => {
		const f = await fixture();
		expect((await f.edit(kind === "staged" ? "staged\n" : undefined))._nay).toBeUndefined();
		if (kind === "move") expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
		if (kind === "archive") expect((await f.archive())._nay).toBeUndefined();
		const finish = await f.start();
		const proposal = await f.proposal();
		if (!proposal) throw new Error("Expected the proposal");
		expect(
			await f.editor.mutation(api.files_pending_updates.discard_file_pending_content, {
				membershipId: f.membership._id,
				target: f.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			}),
			"surviving content Discard uses exact holds only",
		).toEqual({ _yay: null });
		expect((await f.proposal())?._id).toBe(proposal._id);
		await finish();
	},
);

test("Archive on a content proposal waits for its direct parent", async () => {
	const f = await fixture();
	expect((await f.edit())._nay).toBeUndefined();
	const finish = await f.start();
	const before = await f.snapshot();
	const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
	await expect(f.archive(), "Archive returns typed busy before changing membership").resolves.toMatchObject({
		_nay: { name: "move_busy" },
	});
	expect(await f.snapshot(), "busy Archive keeps the proposal and content").toEqual(before);
	expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect()), "busy Archive keeps children").toEqual(nodes);
	await finish(true);
	expect((await f.archive())._nay).toBeUndefined();
	expect((await f.proposal())?.pendingArchive).toEqual({ fromPath: "/source/child.txt" });
});

test("structural Discard of Archive with content waits for its direct parent", async () => {
	const f = await fixture();
	expect((await f.edit())._nay).toBeUndefined();
	expect((await f.archive())._nay).toBeUndefined();
	const finish = await f.start();
	expect((await f.archive())._nay, "repeating the same Archive keeps membership unchanged").toBeUndefined();
	const before = await f.snapshot();
	if (!before.proposal) throw new Error("Expected the Archive proposal");
	const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
	await expect(
		f.editor.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: f.membership._id,
			target: f.target,
			pendingUpdateId: before.proposal._id,
			reviewedRevision: before.proposal.revision,
		}),
		"Archive Discard returns typed busy before changing membership",
	).resolves.toMatchObject({ _nay: { name: "move_busy" } });
	expect(await f.snapshot(), "busy Archive Discard keeps the proposal and content").toEqual(before);
	expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect()), "busy Archive Discard keeps children").toEqual(
		nodes,
	);
	await finish(true);
	const proposal = await f.proposal();
	if (!proposal) throw new Error("Expected the kept Archive proposal");
	expect(
		await f.editor.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: f.membership._id,
			target: f.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		}),
	).toEqual({ _yay: null });
	expect((await f.proposal())?.pendingArchive).toBeUndefined();
	expect((await f.proposal())?.content).toBeDefined();
});

test("structural Discard of content only stays a no-op", async () => {
	const f = await fixture();
	expect((await f.edit())._nay).toBeUndefined();
	const finish = await f.start();
	const before = await f.snapshot();
	if (!before.proposal) throw new Error("Expected the proposal");
	expect(
		await f.editor.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: f.membership._id,
			target: f.target,
			pendingUpdateId: before.proposal._id,
			reviewedRevision: before.proposal.revision,
		}),
	).toEqual({ _yay: null });
	expect(await f.snapshot()).toEqual(before);
	await finish();
});

test.each([true, false].flatMap((collaborative) => [false, true].map((surviving) => ({ collaborative, surviving }))))(
	"prepared Save checks removal, collaborative $collaborative, surviving Move $surviving",
	async ({ collaborative, surviving }) => {
		const f = await fixture(collaborative);
		expect((await f.edit("draft\n"))._nay).toBeUndefined();
		if (surviving) expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
		const proposal = await f.proposal();
		if (!proposal?.content) throw new Error("Expected content to prepare");
		const prepared = await f.t.action((ctx) =>
			files_pending_updates_action_prepare_content(ctx, {
				userId: f.scope.userId,
				membershipId: f.membership._id,
				target: f.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: proposal.content!.unstagedStateId,
				reviewedPrivateParentIds: [],
			}),
		);
		if (prepared._nay) throw new Error(prepared._nay.message);
		if (prepared._yay.kind === "private") throw new Error("Expected saved content");
		const finish = await f.start();
		const before = await f.snapshot();
		const saved = await f.t.mutation(internal.files_pending_updates.commit_prepared_content, {
			userId: f.scope.userId,
			prepared: prepared._yay,
		});
		if (surviving) {
			expect(saved._nay, "Save keeping its Move uses exact holds only").toBeUndefined();
			expect((await f.proposal())?.pendingMove).toBeDefined();
		} else {
			expect(saved, "full Save returns typed busy before publishing text").toMatchObject({
				_nay: { name: "move_busy" },
			});
			expect(await f.snapshot()).toEqual(before);
		}
		await finish();
	},
);

test("public Save refuses proposal removal before publishing saved text", async () => {
	const f = await fixture();
	expect((await f.edit("draft\n"))._nay).toBeUndefined();
	const finish = await f.start();
	const before = await f.snapshot();
	if (!before.proposal) throw new Error("Expected a proposal");
	await expect(
		f.editor.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.membership._id,
			target: f.target,
			pendingUpdateId: before.proposal._id,
			reviewedRevision: before.proposal.revision,
		}),
		"the public Save action returns typed busy",
	).resolves.toMatchObject({ _nay: { name: "move_busy" } });
	const after = await f.snapshot();
	expect(after.proposal).toEqual(before.proposal);
	expect(after.file).toEqual(before.file);
	expect(after.chunks).toEqual(before.chunks);
	await finish();
	const proposal = await f.proposal();
	if (!proposal) throw new Error("Expected the kept proposal");
	expect(
		(
			await f.editor.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: f.membership._id,
				target: f.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			})
		)._nay,
	).toBeUndefined();
});

test.each(["cancel", "change", "discard"] as const)("%s checks the old pending Move destination", async (kind) => {
	const f = await fixture();
	expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
	const finish = await f.start(f.otherId);
	const before = await f.snapshot();
	if (!before.proposal) throw new Error("Expected a proposal");
	const result =
		kind === "discard"
			? await f.editor.mutation(api.files_pending_updates.discard_file_pending_structural, {
					membershipId: f.membership._id,
					target: f.target,
					pendingUpdateId: before.proposal._id,
					reviewedRevision: before.proposal.revision,
				})
			: await f.move({ kind: "saved", id: f.sourceId }, kind === "cancel" ? "child.txt" : "renamed.txt");
	expect(result, "old destination membership returns typed busy").toMatchObject({ _nay: { name: "move_busy" } });
	expect(await f.snapshot()).toEqual(before);
	await finish();
});

test("expiry waits without changing an uncaptured proposal", async () => {
	const f = await fixture();
	expect((await f.edit())._nay).toBeUndefined();
	const proposal = await f.proposal();
	if (!proposal) throw new Error("Expected a proposal");
	vi.setSystemTime(proposal.expiresAt);
	const finish = await f.start();
	const before = await f.snapshot();
	await expect(
		f.t.mutation(internal.files_pending_updates.expire_file_pending_updates, f.scope),
		"expiry parks instead of reaching the raw membership guard",
	).resolves.toBeNull();
	expect(await f.snapshot()).toEqual(before);
	const check = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_update_expiry_checks")
			.withIndex("by_organization_workspace_user", (q) =>
				q
					.eq("organizationId", f.scope.organizationId)
					.eq("workspaceId", f.scope.workspaceId)
					.eq("userId", f.scope.userId),
			)
			.unique(),
	);
	expect(check?.nextCheckAt).toBe(Date.now() + 60_000);
	await finish();
	vi.setSystemTime(Date.now() + 60_000);
	await f.t.mutation(internal.files_pending_updates.expire_file_pending_updates, f.scope);
	expect(await f.proposal()).toBeNull();
});

test.each([false, true])("no-change settlement checks removal, surviving Move %s", async (surviving) => {
	const f = await fixture();
	const base = await f.t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...f.scope, nodeId: f.nodeId }));
	expect((await f.edit())._nay).toBeUndefined();
	if (surviving) expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
	const finish = await f.start();
	const before = await f.snapshot();
	const result = await f.edit(base, base);
	if (surviving) {
		expect(result._nay, "a no-change edit keeping its Move stays writable").toBeUndefined();
		expect((await f.proposal())?.content).toBeUndefined();
	} else {
		expect(result, "no-change removal returns typed busy").toMatchObject({ _nay: { name: "move_busy" } });
		const after = await f.snapshot();
		expect(after.proposal).toEqual(before.proposal);
		expect(after.file).toEqual(before.file);
		expect(after.chunks).toEqual(before.chunks);
		const batch = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_operation_batches")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", f.scope.organizationId)
						.eq("workspaceId", f.scope.workspaceId)
						.eq("userId", f.scope.userId)
						.eq("target.kind", "saved")
						.eq("target.id", f.nodeId),
				)
				.order("desc")
				.first(),
		);
		expect(batch?.expiresAt, "the action retires its unused staging after busy").toBe(0);
	}
	await finish();
});

test("no-change commit checks removal before expiring its batch", async () => {
	const f = await fixture();
	expect((await f.edit())._nay).toBeUndefined();
	const proposal = await f.proposal();
	if (!proposal) throw new Error("Expected a proposal");
	const created = await f.t.mutation(
		internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
		{
			...f.scope,
			target: f.target,
		},
	);
	if (created._nay) throw new Error(created._nay.message);
	const operationBatchId = created._yay.operationBatchId;
	const finish = await f.start();
	const before = await f.snapshot();
	const batch = await f.t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", operationBatchId));
	await expect(
		f.t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			...f.scope,
			nodeId: f.nodeId,
			operationBatchId,
			pendingUpdateId: proposal._id,
			expectedRevision: proposal.revision,
		}),
		"no-change commit returns busy before consuming staging",
	).resolves.toMatchObject({ _nay: { name: "move_busy" } });
	expect(await f.snapshot()).toEqual(before);
	expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", operationBatchId))).toEqual(batch);
	await finish();
});

test.each(["full", "structural", "content"] as const)(
	"%s Discard remains allowed after source access loss",
	async (kind) => {
		const f = await fixture();
		if (kind === "structural") expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
		else expect((await f.edit())._nay).toBeUndefined();
		expect(
			await f.mover.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: f.nodeId }),
		).toEqual({ _yay: null });
		expect(
			await f.editor.query(api.files_pending_target.get_file_pending_target, {
				membershipId: f.membership._id,
				target: f.target,
			}),
		).toBeNull();
		const finish = await f.start();
		const before = await f.snapshot();
		if (!before.proposal) throw new Error("Expected a proposal");
		const door =
			kind === "full"
				? api.files_pending_updates.discard_file_pending_update
				: kind === "structural"
					? api.files_pending_updates.discard_file_pending_structural
					: api.files_pending_updates.discard_file_pending_content;
		await expect(
			f.editor.mutation(door, {
				membershipId: f.membership._id,
				target: f.target,
				pendingUpdateId: before.proposal._id,
				reviewedRevision: before.proposal.revision,
			}),
			"owned Discard still checks holds after access loss",
		).resolves.toMatchObject({ _nay: { name: "move_busy" } });
		expect(await f.snapshot()).toEqual(before);
		await finish();
		const proposal = await f.proposal();
		if (!proposal) throw new Error("Expected the kept proposal");
		expect(
			await f.editor.mutation(door, {
				membershipId: f.membership._id,
				target: f.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			}),
			"access loss does not strand the owner's draft after release",
		).toEqual({ _yay: null });
	},
);

test.each(["full", "structural", "content"] as const)("%s Discard keeps a held replacement asset", async (kind) => {
	const f = await fixture();
	await f.copy();
	const finish = await f.start();
	const before = await f.snapshot();
	if (!before.proposal) throw new Error("Expected a replacement proposal");
	const door =
		kind === "full"
			? api.files_pending_updates.discard_file_pending_update
			: kind === "structural"
				? api.files_pending_updates.discard_file_pending_structural
				: api.files_pending_updates.discard_file_pending_content;
	await expect(
		f.editor.mutation(door, {
			membershipId: f.membership._id,
			target: f.target,
			pendingUpdateId: before.proposal._id,
			reviewedRevision: before.proposal.revision,
		}),
		"replacement Discard checks removal before releasing its asset",
	).resolves.toMatchObject({ _nay: { name: "move_busy" } });
	expect(await f.snapshot()).toEqual(before);
	await finish();
	const proposal = await f.proposal();
	if (!proposal) throw new Error("Expected the held replacement");
	expect(
		await f.editor.mutation(door, {
			membershipId: f.membership._id,
			target: f.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		}),
	).toEqual({ _yay: null });
});

test.each([false, true])("replacement Accept checks removal, surviving Move %s", async (surviving) => {
	const f = await fixture();
	await f.copy();
	if (surviving) expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
	const proposal = await f.proposal();
	if (!proposal) throw new Error("Expected a replacement proposal");
	const prepared = await f.t.action((ctx) =>
		files_pending_updates_action_prepare_content(ctx, {
			userId: f.scope.userId,
			membershipId: f.membership._id,
			target: f.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			reviewedPrivateParentIds: [],
		}),
	);
	if (prepared._nay) throw new Error(prepared._nay.message);
	if (prepared._yay.kind !== "replacement") throw new Error("Expected replacement content");
	const finish = await f.start();
	const before = await f.snapshot();
	const saved = await f.t.mutation(internal.files_pending_updates.commit_prepared_content, {
		userId: f.scope.userId,
		prepared: prepared._yay,
	});
	if (surviving) expect(saved._nay, "replacement preserving membership stays writable").toBeUndefined();
	else {
		expect(saved, "replacement removal returns typed busy before asset and history writes").toMatchObject({
			_nay: { name: "move_busy" },
		});
		expect(await f.snapshot()).toEqual(before);
	}
	await finish();
});

test.each([false, true])("no-change rebase checks removal, surviving Move %s", async (surviving) => {
	const f = await fixture(false);
	expect((await f.edit())._nay).toBeUndefined();
	if (surviving) expect((await f.move({ kind: "saved", id: f.otherId }))._nay).toBeUndefined();
	expect(
		(
			await f.mover.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				text: "draft\n",
			})
		)._nay,
	).toBeUndefined();
	const finish = await f.start();
	const before = await f.snapshot();
	if (!before.proposal) throw new Error("Expected a stale proposal");
	const prepared = await f.editor.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
		membershipId: f.membership._id,
		target: f.target,
		pendingUpdateId: before.proposal._id,
	});
	if (surviving) {
		expect(prepared._nay, "rebase preserving the Move stays writable").toBeUndefined();
		expect((await f.proposal())?.content).toBeUndefined();
	} else {
		expect(prepared, "no-change rebase returns typed busy before removing its proposal").toMatchObject({
			_nay: { name: "move_busy" },
		});
		const after = await f.snapshot();
		expect(after.proposal).toEqual(before.proposal);
		expect(after.file).toEqual(before.file);
		expect(after.chunks).toEqual(before.chunks);
	}
	await finish();
});

test("user finalization waits before deleting a held proposal's child data", async () => {
	const f = await fixture();
	expect((await f.edit())._nay).toBeUndefined();
	const finish = await f.start();
	const before = await f.snapshot();
	for (let step = 0; step < 8; step++) {
		await expect(
			f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: f.scope.userId,
				_test_disableReschedule: true,
			}),
			"user finalization waits instead of reaching the raw membership guard",
		).resolves.toBe(false);
		expect(await f.snapshot(), "the held proposal keeps its content before finalization retries").toEqual(before);
	}
	await finish();
	let done = false;
	for (let step = 0; step < 100 && !done; step++) {
		done = await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
			userId: f.scope.userId,
			_test_disableReschedule: true,
		});
	}
	expect(done, "user finalization resumes after release").toBe(true);
	expect(await f.proposal()).toBeNull();
});

test("private cleanup waits after Discard when its parent is later held", async () => {
	const f = await fixture();
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		kind: "folder",
		path: "/source/private",
	});
	if (created._nay || created._yay.target.kind !== "private" || !created._yay.pendingUpdateId)
		throw new Error("Expected a private folder");
	const { target, pendingUpdateId } = created._yay;
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!proposal) throw new Error("Expected the private proposal");
	expect(
		await f.editor.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: f.membership._id,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		}),
	).toEqual({ _yay: null });
	const finish = await f.start();
	const before = await f.t.run(async (ctx) => ({
		node: await ctx.db.get("files_pending_nodes", target.id),
		proposal: await ctx.db.get("files_pending_updates", pendingUpdateId),
	}));
	await expect(
		f.t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: target.id }),
		"private cleanup parks before removing membership",
	).resolves.toBeNull();
	expect(
		await f.t.run(async (ctx) => ({
			node: await ctx.db.get("files_pending_nodes", target.id),
			proposal: await ctx.db.get("files_pending_updates", pendingUpdateId),
		})),
	).toEqual(before);
	const task = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_node_cleanup_tasks")
			.withIndex("by_privateNode", (q) => q.eq("privateNodeId", target.id))
			.unique(),
	);
	expect(task?.nextAttemptAt).toBe(Date.now() + 60_000);
	await finish();
	vi.setSystemTime(Date.now() + 60_000);
	await f.t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: target.id });
	expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toBeNull();
});

test("accepted Copy keeps its capture and resumes after a parent hold", async () => {
	const f = await fixture();
	let release: (() => Promise<void>) | undefined;
	await f.copy(
		async () => {
			const finish = await f.start();
			release = () => finish(true);
		},
		async (runId) => {
			const waiting = await f.editor.query(api.files_transfer_status.get, { membershipId: f.membership._id, runId });
			expect(waiting?.activity, "accepted Copy waits instead of failing on move_busy").toMatchObject({
				status: "running",
				errorCode: files_MOVE_WAIT_CODE,
			});
			const item = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.first(),
			);
			expect(item?.state).toBe("pending");
			expect(item?.capture?.artifact, "the waiting Copy keeps prepared content").not.toBeNull();
			for (let step = 0; step < 4; step++) await f.t.mutation(internal.files_transfer.advance, { runId });
			expect(
				await f.t.run((ctx) => ctx.db.get("files_transfer_items", item!._id)),
				"waiting does not consume more worker attempts",
			).toEqual(item);
			if (!release) throw new Error("Expected the held parent");
			await release();
		},
	);
});
