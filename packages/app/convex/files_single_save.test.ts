import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_finish_pending_update_run, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_saved_content_collect, files_saved_content_db_text_chunks } from "../server/files-saved-content.ts";
import { files_saved_placement_db_get_slot } from "../server/files-saved-placement.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import { files_db_patch_pending_update } from "../server/files.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_record,
} from "./organizations_membership_lifetimes.ts";

const objects = new Map<string, string | ArrayBuffer>();

beforeEach(() => {
	vi.useFakeTimers();
	objects.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
			const key = parsed.searchParams.get("key")!;
			if (parsed.pathname === "/upload") {
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(path = "/draft.txt", kind: "file" | "folder" = "file") {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { userId: undefined, plan: "Pay As You Go" }),
	);
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, { ...scope, path, kind });
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private draft");
	if (kind === "file") {
		if (!created._yay.operationBatchId) throw new Error("Expected a text batch");
		for (const role of ["staged", "unstaged"] as const) {
			const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...scope,
				operationBatchId: created._yay.operationBatchId,
				role,
				text: "accepted plain text",
			});
			if (staged._nay) throw new Error(staged._nay.message);
		}
		const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			...scope,
			target: created._yay.target,
			pendingUpdateId: created._yay.pendingUpdateId,
			operationBatchId: created._yay.operationBatchId,
		});
		if (ready._nay) throw new Error(ready._nay.message);
	}
	const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
	if (!proposal) throw new Error("Expected a ready proposal");
	const args = {
		membershipId: db.membershipId,
		target: proposal.target,
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
	};
	return { t, db, scope, asUser, proposal, args };
}

test("private plain Save queues once and publishes through the real cohort worker", async () => {
	const f = await fixture();
	const queued = await f.asUser.action(api.files_pending_updates.save_file_pending_update, f.args);
	if (queued._nay || !("kind" in queued._yay)) throw new Error("Expected queued Save");
	const work = queued._yay;
	expect(queued._yay.kind, "private Save returns queued work, never completed success").toBe("queued");
	expect(
		await f.asUser.action(api.files_pending_updates.save_file_pending_update, f.args),
		"lost Save reply reuses the same durable request",
	).toEqual(queued);
	expect(
		await f.t.run((ctx) =>
			files_saved_placement_db_get_slot(ctx.db, { ...f.scope, parentId: "root", name: "draft.txt" }),
		),
	).toBeNull();
	await test_finish_pending_update_run(f.asUser, queued._yay.runId);
	const activity = await f.t.run((ctx) => ctx.db.get("activities", work.activityId));
	expect(activity?.status, "the public Save job completes the file").toBe("succeeded");
	expect(
		await f.asUser.action(api.files_pending_updates.save_file_pending_update, f.args),
		"a lost completed reply reuses the successful run",
	).toEqual(queued);
	const receipt = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_node_publish_receipts")
			.withIndex("by_privateNode", (q) => q.eq("privateNodeId", f.proposal.target.id as Id<"files_pending_nodes">))
			.first(),
	);
	if (!receipt) throw new Error("Expected the saved identity");
	const chunks = await f.t.run(
		async (ctx) =>
			await files_saved_content_collect(
				files_saved_content_db_text_chunks(ctx.db, { ...f.scope, nodeId: receipt.savedNodeId }),
			),
	);
	expect(chunks.map((chunk) => chunk.textChunk).join(""), "the queued Save publishes the accepted body").toBe(
		"accepted plain text",
	);
}, 120_000);

test("saved structural Save queues the same cohort flow before changing the saved path", async () => {
	const f = await fixture();
	const first = await f.asUser.action(api.files_pending_updates.save_file_pending_update, f.args);
	if (first._nay || !("kind" in first._yay)) throw new Error("Expected queued private Save");
	await test_finish_pending_update_run(f.asUser, first._yay.runId);
	const receipt = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_node_publish_receipts")
			.withIndex("by_privateNode", (q) => q.eq("privateNodeId", f.proposal.target.id as Id<"files_pending_nodes">))
			.first(),
	);
	if (!receipt) throw new Error("Expected the saved output");
	const target = { kind: "saved" as const, id: receipt.savedNodeId };
	const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		...f.scope,
		target,
		destParent: { kind: "root" },
		destName: "moved.txt",
	});
	if (moved._nay) throw new Error(moved._nay.message);
	const proposal = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", f.scope.organizationId)
					.eq("workspaceId", f.scope.workspaceId)
					.eq("userId", f.scope.userId)
					.eq("target.kind", "saved")
					.eq("target.id", target.id),
			)
			.unique(),
	);
	if (!proposal) throw new Error("Expected the pending Move");
	const queued = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
		membershipId: f.db.membershipId,
		target,
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
	});
	if (queued._nay || !("kind" in queued._yay)) throw new Error("Expected queued structural Save");
	const work = queued._yay;
	expect(queued._yay.kind, "saved structural Save returns queued work").toBe("queued");
	expect(
		await f.t.run((ctx) =>
			files_saved_placement_db_get_slot(ctx.db, { ...f.scope, parentId: "root", name: "draft.txt" }),
		),
		"the saved identity stays at its old name before the job runs",
	).toMatchObject({ _id: target.id });
	await test_finish_pending_update_run(f.asUser, queued._yay.runId);
	expect((await f.t.run((ctx) => ctx.db.get("activities", work.activityId)))?.status).toBe("succeeded");
	expect(
		await f.t.run((ctx) =>
			files_saved_placement_db_get_slot(ctx.db, { ...f.scope, parentId: "root", name: "moved.txt" }),
		),
		"the same saved identity reaches its accepted name",
	).toMatchObject({ _id: target.id });
}, 120_000);

test.each([
	{ count: 45, core: false },
	{ count: 256, core: true },
])(
	"single Save recovers its exact $count-node chain (core fixture: $core)",
	async ({ count, core }) => {
		const f = await fixture("/p", "folder");
		let proposal = f.proposal;
		let path = "/p";
		// The existing write rule allows 256 private nodes in one chain, including the leaf.
		for (let depth = 1; depth < count; depth++) {
			path += "/p";
			if (core) {
				// Native deep-create overlay work already fails at depth 46. This isolates Save intake.
				const parentId = proposal.target.id as Id<"files_pending_nodes">;
				proposal = await f.t.run(async (ctx) => {
					const created = await files_pending_nodes_db_create(ctx, {
						...f.scope,
						parent: { kind: "private", id: parentId },
						name: "p",
						kind: "folder",
					});
					if (created._nay) throw new Error(created._nay.message);
					await files_db_patch_pending_update({
						ctx,
						pendingUpdateId: created._yay.pendingUpdateId,
						value: { createIntent: { kind: "folder", metadata: [] } },
					});
					return (await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId))!;
				});
			} else {
				const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
					...f.scope,
					path,
					kind: "folder",
				});
				if (created._nay || !created._yay.pendingUpdateId) throw new Error(`Expected private depth ${depth}`);
				proposal = (await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!)))!;
			}
		}
		const queued = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			...f.args,
			target: proposal.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		if (queued._nay || !("kind" in queued._yay)) throw new Error("Expected queued chain Save");
		const runId = queued._yay.runId;
		const input = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		expect(
			input?.singleSaveInput?.items,
			"the durable manifest includes every supported private ancestor",
		).toHaveLength(count);
		const progressed = Math.min(110, count - 2);
		for (let pass = 0; pass < progressed; pass++) {
			const run = (await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))!;
			await f.t.mutation(internal.files_pending_update_runs.append_single_save_input, {
				runId,
				fence: run.fence,
				offset: run.itemCount,
			});
		}
		await f.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.name === "files_pending_update_runs:append_single_save_input" && job.state.kind === "pending")
					await ctx.scheduler.cancel(job._id);
		});
		vi.setSystemTime(Date.now() + 6 * 60_000);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		const recovered = (await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))!;
		expect(recovered.itemCount).toBe(progressed + 1);
		expect(
			await f.t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect()).some(
					(job) =>
						job.name === "files_pending_update_runs:append_single_save_input" &&
						job.state.kind === "pending" &&
						job.args[0]?.offset === progressed + 1,
				),
			),
			"recovery schedules the durable intake cursor after a lost worker",
		).toBe(true);
		for (let pass = 0; pass < 256; pass++) {
			const run = (await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))!;
			if (run.step !== "uploading") break;
			await f.t.mutation(internal.files_pending_update_runs.append_single_save_input, {
				runId,
				fence: run.fence,
				offset: run.itemCount,
			});
		}
		const sealed = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		expect(sealed, "all stored parents reach the normal planner without a new selection cap").toMatchObject({
			step: "planning",
			itemCount: count,
		});
		expect(sealed?.singleSaveInput, "sealing retires the durable intake manifest").toBeUndefined();
	},
	300_000,
);

test.each(["stop", "membership", "reinvite"] as const)(
	"single Save fences an unfinished intake after %s",
	async (reason) => {
		const f = await fixture("/parent/child", "folder");
		const queued = await f.asUser.action(api.files_pending_updates.save_file_pending_update, f.args);
		if (queued._nay || !("kind" in queued._yay)) throw new Error("Expected queued Save");
		const work = queued._yay;
		if (reason === "stop")
			await f.asUser.mutation(api.activities.request_stop, {
				membershipId: f.db.membershipId,
				activityId: queued._yay.activityId,
			});
		else if (reason === "membership")
			await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		else
			await f.t.run(async (ctx) => {
				const membership = await ctx.db.get("organizations_workspaces_users", f.db.membershipId);
				if (!membership) throw new Error("Expected the current membership");
				await ctx.db.patch("organizations_workspaces_users", membership._id, { active: false });
				await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
				await ctx.db.patch("organizations_workspaces_users", membership._id, { active: true });
				expect(await organizations_membership_lifetimes_db_ensure(ctx, membership)).toBe(2);
			});
		await f.t.mutation(internal.files_pending_update_runs.append_single_save_input, {
			runId: queued._yay.runId,
			fence: 0,
			offset: 1,
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", work.runId)),
			"stopped or revoked intake accepts no later reviewed item",
		).toMatchObject({ step: "finished", itemCount: 1 });
		expect((await f.t.run((ctx) => ctx.db.get("activities", work.activityId)))?.status).toBe("canceled");
	},
);
