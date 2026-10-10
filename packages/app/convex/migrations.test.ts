import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { describe, expect, test } from "vitest";
import { components, internal } from "./_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";

describe("backfill_files_share_rows_tree_path", () => {
	test("gives old share rows their treePath and service account grants their rows", async () => {
		const t = test_convex();
		component.register(t);
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
		await test_run_with_flush(t, async (ctx) => {
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				...scope,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: "root",
				name: "s",
				sortName: "s",
				path: "/s",
				treePath: "/s/",
			});
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId, isRestrictedScopeRoot: true });
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
				...scope,
				name: "bot",
				createdBy: db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			});
			for (const principal of [
				{ principalKind: "user" as const, userId },
				{ principalKind: "service_account" as const, serviceAccountId },
			])
				await ctx.db.insert("access_control_permission_grants", {
					...scope,
					resourceKind: "file",
					resourceId: String(nodeId),
					...principal,
					permission: "content.read",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
		});
		// Rows written before this change: no `treePath`, and no row for a service account.
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("files_share_rows").collect()) {
				if (row.principalKey.startsWith("service_account:")) await ctx.db.delete("files_share_rows", row._id);
				else await ctx.db.patch("files_share_rows", row._id, { treePath: undefined });
			}
		});
		const audit = async () => {
			const differences: string[] = [];
			let cursor: string | null = null;
			do {
				const page: { differences: string[]; cursor: string | null } = await t.query(
					internal.files_pending_overlay.check_share_rows,
					{ ...scope, cursor },
				);
				differences.push(...page.differences);
				cursor = page.cursor;
			} while (cursor);
			return differences;
		};
		// The missing service account row once, and the user row in both the grant and the row pass.
		expect(await audit()).toHaveLength(3);

		// One grant per batch, so the pass resumes from the cursor of each batch.
		await t.run((ctx) =>
			runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_share_rows_tree_path, {
				batchSize: 1,
			}),
		);

		expect(await audit()).toEqual([]);
		expect(
			(await t.run((ctx) => ctx.db.query("files_share_rows").collect())).map((row) => row.treePath),
		).toEqual(["/s/", "/s/"]);
	});
});
