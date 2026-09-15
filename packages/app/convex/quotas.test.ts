import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { quotas_db_ensure } from "./quotas.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

describe("get", () => {
	test.each([
		["files_private_user_bytes", 1024 ** 3],
		["files_private_workspace_bytes", 5 * 1024 ** 3],
		["files_private_nodes", 10_000],
	] as const)("reads %s only through the caller's active membership", async (quotaName, maxCount) => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const other = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		const args = { quotaName, membershipId: db.membershipId };
		expect(await asUser.query(api.quotas.get, args)).toBeNull();
		await t.run(async (ctx) => {
			await quotas_db_ensure(ctx, {
				...(quotaName === "files_private_workspace_bytes" ? { quotaName } : { quotaName, userId: db.userId }),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				now: Date.now(),
			});
		});
		expect(await asUser.query(api.quotas.get, args)).toMatchObject({ quotaName, maxCount, usedCount: 0 });
		expect(await asOther.query(api.quotas.get, args)).toBeNull();
		expect(await asUser.query(api.quotas.get, { quotaName, membershipId: other.membershipId })).toBeNull();
		await t.run(async (ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { active: false }));
		expect(await asUser.query(api.quotas.get, args)).toBeNull();
	});
});
