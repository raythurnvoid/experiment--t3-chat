import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { quotas_db_ensure } from "./quotas.ts";
import {
	fixture,
	add_member,
	seed_tree,
	read_node,
	read_activity,
	run_to_end,
	step,
	archive_to_end,
	restore,
	lock,
	with_scope_repair,
	type Fixture,
} from "./files_archive_runs.setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function key(f: Fixture, member?: Awaited<ReturnType<typeof add_member>>) {
	const userId = member?.userId ?? f.db.userId;
	const membershipId = member?.membershipId ?? f.db.membershipId;
	await f.t.run(async (ctx) => {
		await ctx.db.patch("users", userId, { clerkUserId: `force-${userId}` });
		await quotas_db_ensure(ctx, {
			quotaName: "active_api_credentials",
			userId,
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			now: Date.now(),
		});
	});
	const created = await (member?.asUser ?? f.asOwner).mutation(api.public_api.api_credential_create, {
		serviceAccountId: null,
		membershipId,
		name: "Force key",
		scopes: ["files:list", "files:write", "files:read-only"],
	});
	if (created._nay) throw new Error(created._nay.message);
	return created._yay;
}

async function force_archive(f: Fixture, credential: string, path: string) {
	const response = await f.t.fetch("/api/v1/files/delete", {
		method: "POST",
		headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
		body: JSON.stringify({ paths: [path], force: true }),
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { jobId: Id<"activities"> | null };
	if (!body.jobId) throw new Error("Expected an archive job");
	const activity = await read_activity(f, body.jobId);
	return { activityId: body.jobId, runId: activity.source.id as Id<"files_archive_runs"> };
}

describe("archive parent child list", () => {
	test.each([
		["fast", "read_only"],
		["fast", "permission"],
		["slow", "read_only"],
		["slow", "permission"],
	] as const)("%s check refuses a writable file with a %s parent", async (mode, refusal) => {
		const f = await fixture();
		const member = await add_member(f);
		const tree = await seed_tree(f, { name: "parent-list", folderCount: 1, filesPerFolder: 1 });
		const parentId = tree.folderIds[0]!;
		const fileId = tree.fileIds[0]!;
		const deny_parent = async () => {
			if (refusal === "read_only") {
				await lock({ f, nodeId: parentId, locked: true });
				return;
			}
			await f.t.run(async (ctx) => {
				for (const nodeId of [parentId, fileId]) {
					await ctx.db.patch("files_nodes", nodeId, {
						restrictedScopeNodeId: nodeId,
						isRestrictedScopeRoot: true,
						parentScopeNodeId: nodeId === parentId ? null : parentId,
					});
					for (const permission of nodeId === parentId
						? (["content.read"] as const)
						: (["content.read", "content.write"] as const))
						await ctx.db.insert("access_control_permission_grants", {
							organizationId: f.db.organizationId,
							workspaceId: f.db.workspaceId,
							resourceKind: "file",
							resourceId: nodeId,
							principalKind: "user",
							userId: member.userId,
							permission,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						});
				}
			});
		};
		const request = (nodeIds: Id<"files_nodes">[]) =>
			member.asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: member.membershipId,
				nodeIds,
			});
		if (mode === "fast") {
			await deny_parent();
			const result = await request([fileId]);
			expect(result._nay?.message, "the fast check refuses a parent child-list change").toBe(
				refusal === "read_only"
					? 'The folder "/parent-list/d0" is read-only. Unlock it before archiving items inside it.'
					: "Permission denied",
			);
		} else {
			const first = await seed_tree(f, { name: "first", folderCount: 1, filesPerFolder: 151 });
			const result = await with_scope_repair(f, () => request([first.topId, fileId]));
			expect(result._nay).toBeUndefined();
			expect(result._yay?.isChecking).toBe(true);
			// The job has not checked this second named item yet.
			await deny_parent();
			const ended = await run_to_end(f, result._yay!);
			expect(ended.activity.status, "the full check refuses a parent child-list change").toBe("partial");
			expect((await read_node(f, first.topId)).archiveOperationId).not.toBeNull();
		}
		expect((await read_node(f, fileId)).archiveOperationId).toBeNull();
	});
});

describe("forced archive", () => {
	test("a named allowed child is not refused when its named parent stays active", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const credential = await key(f, member);
		const tree = await seed_tree(f, { name: "named-child", folderCount: 2, filesPerFolder: 1 });
		await f.t.run(async (ctx) => {
			for (const nodeId of [tree.folderIds[0]!, tree.fileIds[0]!])
				await ctx.db.patch("files_nodes", nodeId, {
					restrictedScopeNodeId: tree.folderIds[0]!,
					isRestrictedScopeRoot: nodeId === tree.folderIds[0],
					parentScopeNodeId: null,
				});
		});
		const response = await f.t.fetch("/api/v1/files/delete", {
			method: "POST",
			headers: { Authorization: `Bearer ${credential.credential}`, "Content-Type": "application/json" },
			body: JSON.stringify({ paths: ["/named-child", "/named-child/d1/f000.md"], force: true }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { refused: Array<{ path: string }> };
		expect((await read_node(f, tree.fileIds[1]!)).archiveOperationId).not.toBeNull();
		expect(body.refused.map((item) => item.path)).not.toContain("/named-child/d1/f000.md");
	});

	test("keeps a denied branch and its parents, archives allowed siblings, and pages private outcomes", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const credential = await key(f, member);
		const tree = await seed_tree(f, { name: "partial", folderCount: 2, filesPerFolder: 2 });
		await f.t.run(async (ctx) => {
			for (const nodeId of [tree.folderIds[0]!, ...tree.fileIds.slice(0, 2)]) {
				await ctx.db.patch("files_nodes", nodeId, {
					restrictedScopeNodeId: tree.folderIds[0]!,
					isRestrictedScopeRoot: nodeId === tree.folderIds[0],
					parentScopeNodeId: null,
				});
			}
			await ctx.db.patch("files_nodes", tree.topId, { readOnly: true, readOnlyDecisionId: "kept-decision" });
		});
		const job = await force_archive(f, credential.credential, "/partial");
		expect((await read_node(f, tree.topId)).archiveOperationId, "a denied child keeps its parent active").toBeNull();
		expect((await run_to_end(f, job)).activity).toMatchObject({
			status: "partial",
			progress: { completed: 3, blocked: 2, total: 5 },
		});
		expect(await read_node(f, tree.topId)).toMatchObject({
			archiveOperationId: null,
			readOnly: true,
			readOnlyDecisionId: "kept-decision",
		});
		for (const nodeId of [tree.folderIds[0]!, ...tree.fileIds.slice(0, 2)])
			expect((await read_node(f, nodeId)).archiveOperationId).toBeNull();
		for (const nodeId of [tree.folderIds[1]!, ...tree.fileIds.slice(2)])
			expect((await read_node(f, nodeId)).archiveOperationId).not.toBeNull();
		const first = await member.asUser.query(api.files_archive_runs.list_outcomes, {
			membershipId: member.membershipId,
			runId: job.runId,
			paginationOpts: { cursor: null, numItems: 1 },
		});
		expect(first.page).toEqual([{ order: 0, kind: "refused", path: null, message: "Permission denied" }]);
		expect(first.isDone).toBe(false);
		const last = await member.asUser.query(api.files_archive_runs.list_outcomes, {
			membershipId: member.membershipId,
			runId: job.runId,
			paginationOpts: { cursor: first.continueCursor, numItems: 1 },
		});
		expect(last.page).toMatchObject([{ kind: "retained_folder", path: "/partial" }]);
		expect(last.isDone).toBe(true);
	});

	test("waits for a running scope repair and skips a queued child that moved out", async () => {
		const f = await fixture();
		const credential = await key(f);
		const tree = await seed_tree(f, { name: "moving", folderCount: 1, filesPerFolder: 70 });
		const repairId = await f.t.run((ctx) =>
			ctx.db.insert("files_subtree_ops", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				kind: "scope",
				status: "running",
				rootNodeIds: [],
				treePaths: [],
				blockedByOpId: null,
			}),
		);
		const job = await force_archive(f, credential.credential, "/moving");
		expect((await read_activity(f, job.activityId)).progress!.completed).toBe(0);
		await step(f, job.runId);
		expect((await read_activity(f, job.activityId)).progress!.completed).toBe(0);
		await f.t.run((ctx) => ctx.db.delete("files_subtree_ops", repairId));
		await step(f, job.runId);
		const movedId = tree.fileIds[45]!;
		expect((await read_node(f, movedId)).archiveOperationId).toBeNull();
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", movedId, {
				parentId: "root",
				path: "/moved.md",
				treePath: "/moved.md",
				name: "moved.md",
				pathDepth: 1,
			});
			for (const doc of await ctx.db.query("files_plain_text_chunks").collect()) {
				if (doc.sourceKind === "committed" && doc.fileNodeId === movedId)
					await ctx.db.patch("files_plain_text_chunks", doc._id, { path: "/moved.md" });
			}
			for (const doc of await ctx.db.query("files_metadata_docs").collect()) {
				if (doc.sourceKind === "committed" && doc.fileNodeId === movedId)
					await ctx.db.patch("files_metadata_docs", doc._id, { path: "/moved.md", treePath: "/moved.md" });
			}
		});
		// The queue still names it, but its current parent no longer matches the accepted walk.
		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("partial");
		expect((await read_node(f, movedId)).archiveOperationId).toBeNull();
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		const outcomes = await f.asOwner.query(api.files_archive_runs.list_outcomes, {
			membershipId: f.db.membershipId,
			runId: job.runId,
			paginationOpts: { cursor: null, numItems: 10 },
		});
		expect(outcomes.page).toMatchObject([
			{ path: "/moved.md", kind: "refused", message: "This item moved or changed. Try again from its current folder." },
		]);
	});

	test("waits for running Restore, then proceeds when that Restore queues behind it", async () => {
		const f = await fixture();
		const credential = await key(f);
		const returning = await seed_tree(f, { name: "returning", folderCount: 1, filesPerFolder: 151 });
		await archive_to_end(f, returning.topId);
		const restoreJob = (await restore(f, [returning.topId]))._yay!;
		const deleting = await seed_tree(f, { name: "deleting", folderCount: 1, filesPerFolder: 70 });
		const job = await force_archive(f, credential.credential, "/deleting");
		expect((await read_activity(f, job.activityId)).progress!.completed).toBe(0);
		await f.t.run(async (ctx) => {
			const restoreOp = (await ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", restoreJob.runId))
				.unique())!;
			const archiveOp = (await ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
				.unique())!;
			await ctx.db.patch("files_subtree_ops", restoreOp._id, { status: "queued", blockedByOpId: archiveOp._id });
		});
		await step(f, job.runId);
		expect((await read_activity(f, job.activityId)).progress!.completed).toBeGreaterThan(0);
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect((await read_node(f, deleting.topId)).archiveOperationId).not.toBeNull();
		expect((await run_to_end(f, restoreJob)).activity.status).toBe("succeeded");
	});

	test.each(["stop", "revoke"] as const)(
		"%s keeps completed children and leaves every unfinished parent active",
		async (action) => {
			const f = await fixture();
			const credential = await key(f);
			const tree = await seed_tree(f, { name: action, folderCount: 1, filesPerFolder: 151 });
			const job = await force_archive(f, credential.credential, `/${action}`);
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();
			expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
			const before = (await read_activity(f, job.activityId)).progress!.completed;
			if (action === "stop") {
				expect(
					await f.asOwner.mutation(api.activities.request_stop, {
						membershipId: f.db.membershipId,
						activityId: job.activityId,
					}),
				).toEqual({ _yay: null });
			} else {
				await f.t.run((ctx) =>
					ctx.db.patch("api_credentials", credential.credentialId, { scopes: ["files:list", "files:write"] }),
				);
			}
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe(action === "stop" ? "canceled" : "failed");
			expect(ended.activity.progress!.completed).toBe(before);
			expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBeNull();
			expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).toBeNull();
		},
	);
});

describe("Restore read-only decisions", () => {
	test.each([false, true, "repair_only"] as const)(
		"restores a read-only folder only with the same decision and a real receipt (%s)",
		async (changeDecision) => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "restore-ro", folderCount: 1, filesPerFolder: 151 });
			await archive_to_end(f, tree.topId);
			await f.t.run(async (ctx) => {
				for (const nodeId of [tree.topId, ...tree.folderIds, ...tree.fileIds]) {
					await ctx.db.patch("files_nodes", nodeId, { readOnly: true, readOnlyDecisionId: `decision-${nodeId}` });
				}
			});
			const result = await restore(f, [tree.topId]);
			expect(result._nay).toBeUndefined();
			const job = result._yay!;
			for (let count = 0; (await read_node(f, tree.folderIds[0]!)).archiveOperationId !== null; count++) {
				if (count === 20) throw new Error("Restore did not reach the folder");
				await step(f, job.runId);
			}
			expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).not.toBeNull();
			if (changeDecision === true) {
				await lock({ f, nodeId: tree.folderIds[0]!, locked: false });
				await lock({ f, nodeId: tree.folderIds[0]!, locked: true });
			} else if (changeDecision === "repair_only") {
				await f.t.run(async (ctx) => {
					const row = (await ctx.db.query("files_subtree_op_nodes").collect()).find(
						(item) => item.nodeId === tree.folderIds[0],
					);
					expect(row?.restoredParent).toBeDefined();
					await ctx.db.patch("files_subtree_op_nodes", row!._id, { restoredParent: undefined });
				});
			}
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe(changeDecision ? "failed" : "succeeded");
			expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId === null).toBe(!changeDecision);
			expect(await read_node(f, tree.topId)).toMatchObject({
				readOnly: true,
				readOnlyDecisionId: `decision-${tree.topId}`,
			});
			expect((await read_node(f, tree.fileIds[0]!)).readOnlyDecisionId).toBe(`decision-${tree.fileIds[0]}`);
		},
	);
});
