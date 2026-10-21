import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { create_file_upload_targets } from "./public_api.ts";
import * as overlay from "../server/files-pending-overlay.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("a full upload batch keeps 1,024-character paths during an unrelated Move", async () => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("upload-paths" as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "upload-paths" });
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const key = await asUser.mutation(api.public_api.api_credential_create, {
		membershipId: db.membershipId,
		serviceAccountId: null,
		name: "Upload paths",
		scopes: ["files:write"],
	});
	if (key._nay) throw new Error(key._nay.message);
	async function folder(parentId: Id<"files_nodes"> | "root", name: string) {
		vi.setSystemTime(Date.now() + 10_000);
		const result = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId,
			path: name,
		});
		if (result._nay) throw new Error(result._nay.message);
		return result._yay.nodeId;
	}
	const movingId = await folder("root", "moving");
	const targetId = await folder("root", "target");
	const paths: string[] = [];
	// Real folder intake builds every path. No Move holds or selected places are seeded.
	for (let branch = 0; branch < 20; branch++) {
		const name = String.fromCharCode(97 + branch);
		let parentId = await folder("root", name);
		let path = `/${name}`;
		for (let depth = 1; depth < 509; depth++) {
			parentId = await folder(parentId, "a");
			path += "/a";
		}
		paths.push(path);
	}
	expect(
		paths.every((path) => `${path}/d.bin`.length === 1024),
		"every upload uses the full path limit",
	).toBe(true);
	const costs: Array<{ databaseQueries: number; documentsRead: number; bytesRead: number; documentsWritten: number }> =
		[];
	test_spy_handler(create_file_upload_targets, async (handler, ctx, args) => {
		const result = await handler(ctx, args);
		// The registered handler includes the mutation wrapper and its final overlay flush.
		const metrics = await ctx.meta.getTransactionMetrics();
		costs.push({
			databaseQueries: metrics.databaseQueries.used,
			documentsRead: metrics.documentsRead.used,
			bytesRead: metrics.bytesRead.used,
			documentsWritten: metrics.documentsWritten.used,
		});
		return result;
	});
	const upload = (name: string) =>
		t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: { Authorization: `Bearer ${key._yay.credential}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				files: paths.map((path) => ({ path: `${path}/${name}`, contentType: "application/octet-stream", size: 1 })),
			}),
		});
	const before = await upload("d.bin");
	expect(before.status).toBe(200);
	expect((await before.json()).files).toHaveLength(20);
	vi.setSystemTime(Date.now() + 60_000);
	const canJoin = overlay.files_pending_overlay_db_can_join_step;
	vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, factor) => {
		const allowed = await canJoin(ctx, factor);
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
			.unique();
		return allowed && !slot?.cohortId;
	});
	const start = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: "upload-paths-move",
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [movingId],
		targetParentId: targetId,
	});
	if (start._nay) throw new Error(start._nay.message);
	let cohortId: Id<"files_move_cohorts"> | null = null;
	for (let step = 0; step < 100 && !cohortId; step++) {
		await t.mutation(internal.files_transfer.advance, { runId: start._yay.runId });
		cohortId =
			(
				await t.run((ctx) =>
					ctx.db
						.query("files_move_workspace_slots")
						.withIndex("by_workspace", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
						)
						.unique(),
				)
			)?.cohortId ?? null;
	}
	expect(cohortId, "native Move has selected its Before view").not.toBeNull();
	expect((await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId!)))?.visibleView).toBe("before");
	const during = upload("e.bin");
	await expect(during, "all 20 upload targets fit during an unrelated Move").resolves.toHaveProperty("status", 200);
	expect((await (await during).json()).files).toHaveLength(20);
	expect(costs).toHaveLength(2);
	for (const cost of costs) expect(cost.databaseQueries).toBeLessThan(4096);
	console.info("Full upload request costs, before and during Move", costs);
}, 240_000);
