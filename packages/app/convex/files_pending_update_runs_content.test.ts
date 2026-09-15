import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";

const r2Objects = new Map<string, string | ArrayBuffer>();
let uploadDurationMs = 0;

beforeEach(() => {
	vi.useFakeTimers();
	r2Objects.clear();
	uploadDurationMs = 0;
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "review-test-upload") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key");
			if (url.origin !== "https://r2.test" || !key) return new Response(null, { status: 404 });
			if (url.pathname === "/upload") {
				vi.setSystemTime(Date.now() + uploadDurationMs);
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) r2Objects.set(key, body);
				else if (body instanceof Uint8Array) r2Objects.set(key, files_u8_to_array_buffer(body));
				else throw new Error("Expected text or bytes in the upload");
				return new Response(null, { status: 200 });
			}
			const body = r2Objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(anonymous = false) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: anonymous ? null : "clerk_review_content" });
		const membership = await test_mocks_fill_db_with.membership(ctx, {
			userId,
			organizationName: "personal",
			workspaceName: "home",
			plan: "Free",
		});
		if (anonymous) {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique();
			if (snapshot) await ctx.db.delete("billing_usage_snapshots", snapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now: Date.now() });
		}
		return membership;
	});
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity(
		anonymous
			? { issuer: process.env.VITE_CONVEX_HTTP_URL, subject: db.userId }
			: { issuer: "https://clerk.test", external_id: db.userId },
	);
	return { t, db, scope, asUser };
}

async function stage_text(
	f: Awaited<ReturnType<typeof fixture>>,
	target: Doc<"files_pending_updates">["target"],
	operationBatchId: Id<"files_pending_update_operation_batches">,
	text: string,
	pendingUpdateId?: Id<"files_pending_updates">,
) {
	for (const role of ["staged", "unstaged"] as const) {
		const staged = await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...f.scope,
			operationBatchId,
			role,
			text,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const ready = await f.asUser.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...f.scope,
		target,
		operationBatchId,
		pendingUpdateId,
	});
	if (ready._nay) throw new Error(ready._nay.message);
	const proposal = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", f.scope.organizationId)
					.eq("workspaceId", f.scope.workspaceId)
					.eq("userId", f.scope.userId)
					.eq("target.kind", target.kind)
					.eq("target.id", target.id),
			)
			.unique(),
	);
	if (!proposal) throw new Error("Expected the text proposal");
	return proposal;
}

async function private_node(f: Awaited<ReturnType<typeof fixture>>, path: string, text?: string) {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		path,
		kind: text === undefined ? "folder" : "file",
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private proposal");
	const { target, operationBatchId, pendingUpdateId } = created._yay;
	if (text !== undefined) {
		if (!operationBatchId) throw new Error("Expected the text batch");
		return await stage_text(f, target, operationBatchId, text, pendingUpdateId);
	}
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!proposal) throw new Error("Expected the folder proposal");
	return proposal;
}

async function start_review(f: Awaited<ReturnType<typeof fixture>>, proposals: Doc<"files_pending_updates">[]) {
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: proposals.length,
		items: proposals.map((proposal) => ({
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: proposal.content?.unstagedStateId ?? null,
		})),
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(
		await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
	).toEqual({ _yay: null });
	await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
	return runId;
}

async function finish_review(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_pending_update_runs">) {
	for (let pass = 0; pass < 20; pass++) {
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step === "finished")
			return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
				.first(),
		);
		if (!unit) throw new Error("Expected a review worker");
		await f.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
	}
	throw new Error("Review did not finish");
}

async function saved_text(f: Awaited<ReturnType<typeof fixture>>, nodeId: Id<"files_nodes">) {
	return await f.t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", nodeId);
		if (!node?.yjsSnapshotId) throw new Error("Expected the saved Yjs snapshot");
		const snapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
		if (!snapshot) throw new Error("Expected the snapshot");
		const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
		const bytes = asset?.r2Key ? r2Objects.get(asset.r2Key) : null;
		if (!(bytes instanceof ArrayBuffer)) throw new Error("Expected snapshot bytes");
		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId).eq("fileNodeId", nodeId),
			)
			.order("asc")
			.collect();
		const yjsDoc = files_yjs_doc_create_from_array_buffer_update(bytes, {
			additionalIncrementalArrayBufferUpdates: updates
				.filter((update) => update.sequence > snapshot.sequence)
				.map((update) => update.update),
		});
		const text = files_yjs_doc_get_text({ yjsDoc, rootKind: "plain_text" });
		if (text._nay) throw new Error(text._nay.message);
		return text._yay;
	});
}

describe("review job content", () => {
	test.each([false, true])("checks the total connected Save cost (anonymous: %s)", async (anonymous) => {
		const f = await fixture(anonymous);
		const parent = await private_node(f, "/parent");
		const first = await private_node(f, "/parent/first.txt", "first\n");
		const second = await private_node(f, "/parent/second.txt", "second\n");
		const proposals = [parent, first, second];
		await f.t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
				.unique();
			if (!snapshot?.meter) throw new Error("Expected the Free balance");
			await ctx.db.patch("billing_usage_snapshots", snapshot._id, { meter: { ...snapshot.meter, balance: 1 } });
		});
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		const result = await finish_review(f, await start_review(f, proposals));
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 3 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
		expect(enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")).toEqual([]);
		const failedUnit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique());
		await f.t.mutation(internal.files_pending_update_runs.retire_unit_preparation, { unitId: failedUnit!._id });
		await f.t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
				.unique();
			expect(snapshot?.meter?.balance).toBe(1);
			await ctx.db.patch("billing_usage_snapshots", snapshot!._id, { meter: { ...snapshot!.meter!, balance: 2 } });
		});
		const retry = await finish_review(f, await start_review(f, proposals));
		expect(retry?.activity).toMatchObject({ status: "succeeded", progress: { completed: 3 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/parent", "/parent/first.txt", "/parent/second.txt"]);
		for (const name of ["first", "second"])
			expect(await saved_text(f, saved.find((node) => node.name === `${name}.txt`)!._id)).toBe(`${name}\n`);
		const balance = await f.t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", f.scope.userId))
				.unique(),
		);
		expect(balance?.meter?.balance).toBe(anonymous ? 0 : 2);
		expect(enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")).toHaveLength(
			anonymous ? 0 : 2,
		);
	});

	test("publishes private text before archiving its selected saved parent", async () => {
		const f = await fixture();
		const parentId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				createdBy: f.scope.userId,
				updatedBy: f.scope.userId,
				parentId: "root",
				name: "parent",
				path: "/parent",
				treePath: "/parent/",
			}),
		);
		const child = await private_node(f, "/parent/child.txt", "reviewed child\n");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...f.scope,
					target: { kind: "saved", id: parentId },
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const result = await finish_review(f, await start_review(f, proposals));
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run.unitCount).toBe(1);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/parent", "/parent/child.txt"]);
		expect(saved.every((node) => node.archiveOperationId !== null)).toBe(true);
		expect(await saved_text(f, saved.find((node) => node.path.endsWith(".txt"))!._id)).toBe("reviewed child\n");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child._id))).toBeNull();
	});

	test("keeps saved child content and its selected parent move in one unit", async () => {
		const f = await fixture();
		const parent = await private_node(f, "/parent");
		const child = await private_node(f, "/parent/child.txt", "before\n");
		expect((await finish_review(f, await start_review(f, [parent, child])))?.activity.status).toBe("succeeded");
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const savedParent = saved.find((node) => node.kind === "folder")!;
		const savedChild = saved.find((node) => node.kind === "file")!;
		const target = { kind: "saved", id: savedChild._id } as const;
		const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: f.db.membershipId,
			target,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const edited = await stage_text(f, target, batch._yay.operationBatchId, "after\n");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: { kind: "saved", id: savedParent._id },
					destParent: { kind: "root" },
					destName: "moved",
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const result = await finish_review(
			f,
			await start_review(f, [edited, ...proposals.filter((proposal) => proposal._id !== edited._id)]),
		);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run.unitCount).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedChild._id))).toMatchObject({
			path: "/moved/child.txt",
			parentId: savedParent._id,
		});
		expect(await saved_text(f, savedChild._id)).toBe("after\n");
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("publishes mixed private folders and text in parent order", async () => {
		const f = await fixture();
		const parent = await private_node(f, "/parent");
		const nested = await private_node(f, "/parent/nested");
		const sibling = await private_node(f, "/parent/sibling.txt", "sibling\n");
		const child = await private_node(f, "/parent/nested/child.txt", "child\n");
		const result = await finish_review(f, await start_review(f, [child, sibling, nested, parent]));
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 4 } });
		expect(result?.run.unitCount).toBe(1);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual([
			"/parent",
			"/parent/nested",
			"/parent/nested/child.txt",
			"/parent/sibling.txt",
		]);
		for (const node of saved.filter((node) => node.kind === "file"))
			expect(await saved_text(f, node._id)).toBe(node.name === "child.txt" ? "child\n" : "sibling\n");
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(4);
	});

	test.each([false, true])(
		"saves text above private storage caps and settles its holds (anonymous: %s)",
		async (anonymous) => {
			const f = await fixture(anonymous);
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			const proposal = await private_node(f, "/draft.txt", "selected content\n");
			const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			await f.t.run(async (ctx) => {
				for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
					const id = await quotas_db_ensure(ctx, { ...f.scope, quotaName, now: Date.now() });
					await ctx.db.patch("quotas", id, { maxCount: 0 });
				}
			});
			const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
				membershipId: f.db.membershipId,
				target: proposal.target,
			});
			if (batch._nay) throw new Error(batch._nay.message);
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
						...f.scope,
						operationBatchId: batch._yay.operationBatchId,
						role: "unstaged",
						text: "extra bytes",
					})
				)._nay?.name,
			).toBe("storage_full");
			await f.t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId: batch._yay.operationBatchId,
			});
			const runId = await start_review(f, [proposal]);
			const result = await finish_review(f, runId);
			expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
			const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").unique());
			if (!saved) throw new Error("Expected the saved text");
			expect(await saved_text(f, saved._id)).toBe("selected content\n");
			const item = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").unique());
			const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			const publicationHolds = holds.filter((hold) => hold.publicationBatchId);
			expect(publicationHolds.length).toBeGreaterThan(0);
			expect(publicationHolds.reduce((total, hold) => total + hold.byteCount, 0)).toBeLessThanOrEqual(20 * 1024 * 1024);
			for (const hold of publicationHolds) expect(item?.prepared?.operationBatchIds).toContain(hold.publicationBatchId);
			const savedAssets = publicationHolds.filter((hold) => hold.resource.kind === "asset");
			expect(savedAssets.length).toBeGreaterThan(0);
			for (const hold of savedAssets) expect(hold.settlement).toMatchObject({ kind: "saved", savedNodeId: saved._id });
			const quotas = await f.t.run((ctx) => ctx.db.query("quotas").collect());
			for (const quota of quotas.filter(
				(quota) =>
					quota.quotaName === "files_private_user_bytes" || quota.quotaName === "files_private_workspace_bytes",
			)) {
				const heldBytes = holds
					.filter(
						(hold) =>
							hold.settlement.kind === "held" &&
							hold.resource.kind !== "node" &&
							(hold.userQuotaId === quota._id || hold.workspaceQuotaId === quota._id),
					)
					.reduce((total, hold) => total + hold.byteCount, 0);
				expect(quota.usedCount).toBe(heldBytes);
			}
			const billingCalls = enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events");
			const afterBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			if (anonymous) {
				expect(billingCalls).toHaveLength(0);
				expect(afterBilling?.meter?.consumedUnits).toBe(beforeBilling!.meter!.consumedUnits + 1);
				expect(afterBilling?.meter?.balance).toBe(beforeBilling!.meter!.balance - 1);
			} else {
				expect(billingCalls).toHaveLength(1);
				expect(billingCalls[0]![2]).toMatchObject({
					events: [{ name: "file_save", metadata: { amount: 1, nodeId: saved._id } }],
				});
				expect(afterBilling).toEqual(beforeBilling);
				const index = enqueue.mock.calls.indexOf(billingCalls[0]!);
				const workId = await enqueue.mock.results[index]!.value;
				expect(
					await f.t.query((ctx) => new Workpool(components.billing_workpool_usage_event, {}).status(ctx, workId)),
				).toMatchObject({ state: "pending" });
			}
		},
	);

	test("keeps failed preparation bytes held when a connected unit fills the 20 MiB allowance", async () => {
		const f = await fixture();
		const parent = await private_node(f, "/full");
		const children = [];
		const text = "x".repeat(files_MAX_TEXT_CONTENT_BYTES);
		for (let index = 0; index < 12; index++) children.push(await private_node(f, `/full/file-${index}.txt`, text));
		const proposals = [parent, ...children];
		const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		await f.t.run(async (ctx) => {
			for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
				const id = await quotas_db_ensure(ctx, { ...f.scope, quotaName, now: Date.now() });
				await ctx.db.patch("quotas", id, { maxCount: 0 });
			}
		});
		const result = await finish_review(f, await start_review(f, proposals));
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: proposals.length } });
		expect(result?.run.unitCount).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{
				status: "blocked",
				errorCode: "storage_full",
				errorMessage: "Save preparation space is full. Try again after cleanup finishes",
			},
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
		expect(await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(beforeBilling);
		expect(enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")).toEqual([]);
		const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		const publicationHolds = holds.filter((hold) => hold.publicationBatchId && hold.settlement.kind === "held");
		const publicationBytes = publicationHolds.reduce((sum, hold) => sum + hold.byteCount, 0);
		expect(publicationBytes).toBeGreaterThan(20 * 1024 * 1024 - 2 * 1024 * 1024);
		expect(publicationBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
		expect(publicationHolds.length).toBeLessThan(128);
		expect(holds.some((hold) => hold.settlement.kind === "saved")).toBe(false);
		const quotas = await f.t.run((ctx) => ctx.db.query("quotas").collect());
		for (const quota of quotas.filter(
			(quota) => quota.quotaName === "files_private_user_bytes" || quota.quotaName === "files_private_workspace_bytes",
		)) {
			const heldBytes = holds
				.filter(
					(hold) =>
						hold.settlement.kind === "held" &&
						hold.resource.kind !== "node" &&
						(hold.userQuotaId === quota._id || hold.workspaceQuotaId === quota._id),
				)
				.reduce((sum, hold) => sum + hold.byteCount, 0);
			expect(quota.usedCount).toBe(heldBytes);
		}
	}, 120_000);

	test.each([false, true])(
		"rolls back a connected content unit above the commit budget (anonymous: %s)",
		async (anonymous) => {
			const f = await fixture(anonymous);
			const parent = await private_node(f, "/large");
			const children = [];
			for (let index = 0; index < 64; index++)
				children.push(await private_node(f, `/large/file-${index}.txt`, `file ${index}\n`));
			const proposals = [parent, ...children];
			const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			// Let preparation refill the real Save rate limit without running background jobs.
			uploadDurationMs = 1_200;
			const runId = await start_review(f, proposals);
			const startedAt = Date.now();
			const result = await finish_review(f, runId);
			expect(Date.now() - startedAt).toBeGreaterThan(0);
			expect(Date.now() - startedAt).toBeLessThan(5 * 60 * 1000);
			expect(result?.activity).toMatchObject({
				status: "failed",
				progress: { completed: 0, blocked: proposals.length },
			});
			expect(result?.run.unitCount).toBe(1);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
				{ status: "blocked", errorCode: "review_too_large" },
			]);
			expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
			expect(await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(beforeBilling);
			const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			expect(holds.some((hold) => hold.publicationBatchId)).toBe(true);
			expect(holds.some((hold) => hold.settlement.kind === "saved")).toBe(false);
			if (!anonymous) {
				const calls = enqueue.mock.calls.flatMap((call, index) =>
					getFunctionName(call[1]) === "billing:ingest_events" ? [index] : [],
				);
				// At least one write was attempted before the transaction reached its limit.
				expect(calls.length).toBeGreaterThan(0);
				for (const index of calls) {
					const workId = await enqueue.mock.results[index]!.value;
					expect(
						await f.t.query((ctx) => new Workpool(components.billing_workpool_usage_event, {}).status(ctx, workId)),
					).toEqual({ state: "finished" });
				}
			}
		},
		120_000,
	);
});
