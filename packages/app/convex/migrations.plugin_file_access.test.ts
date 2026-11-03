import { expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import { test_run_with_flush } from "./setup.test.ts";
import { seed_folder_table } from "./files_nodes.setup.test.ts";

// TODO(migration): one-time. Delete this file with the erase migrations in `migrations.ts`.
test("the erase deletes a grant of an ended membership and untags a live one", async () => {
	const { t, db, insert_children, add_member } = await seed_folder_table();
	const member = await add_member("clerk_lifetime_member", null);
	const [liveNodeId, oldNodeId] = await insert_children([
		{ name: "live", kind: "folder", updatedAt: 1, restricted: true },
		{ name: "old", kind: "folder", updatedAt: 2, restricted: true },
	]);

	// The member is in lifetime 2 now. A plugin grant from lifetime 1 belongs to an ended membership.
	const grantIds = await test_run_with_flush(t, async (ctx) => {
		await ctx.db.insert("organizations_membership_lifetimes", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: member.userId,
			membershipId: member.membershipId,
			lifetime: 2,
			active: true,
		});
		const insert = (nodeId: typeof liveNodeId, lifetime: number) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				resourceKind: "file",
				resourceId: String(nodeId),
				principalKind: "user",
				userId: member.userId,
				externalPluginMembershipLifetime: lifetime,
				permission: "content.read",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		return { live: await insert(liveNodeId!, 2), old: await insert(oldNodeId!, 1) };
	});
	// Old share rows copied the grant's tag.
	await t.run(async (ctx) => {
		for (const row of await ctx.db.query("files_share_rows").collect()) {
			await ctx.db.patch("files_share_rows", row._id, { externalPluginMembershipLifetime: 2 });
		}
	});

	const args = { oneBatchOnly: true, cursor: null, batchSize: 100, dryRun: false };
	await t.mutation(internal.migrations.erase_access_control_permission_grants_externalPluginMembershipLifetime, args);
	await t.mutation(internal.migrations.erase_files_share_rows_externalPluginMembershipLifetime, args);

	const after = await t.run(async (ctx) => ({
		live: await ctx.db.get("access_control_permission_grants", grantIds.live),
		old: await ctx.db.get("access_control_permission_grants", grantIds.old),
		shareRows: await ctx.db.query("files_share_rows").collect(),
	}));
	expect(after.old, "the grant of the ended membership is deleted").toBeNull();
	expect(after.live, "the live grant stays").not.toBeNull();
	expect(after.live?.externalPluginMembershipLifetime).toBeUndefined();
	expect(after.shareRows.map((row) => row.nodeId)).toEqual([liveNodeId]);
	expect(after.shareRows[0]?.externalPluginMembershipLifetime).toBeUndefined();
});
