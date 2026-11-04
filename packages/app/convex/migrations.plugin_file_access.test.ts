import { expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import { test_run_with_flush } from "./setup.test.ts";
import { seed_folder_table } from "./files_nodes.setup.test.ts";
import { insert_installation } from "./files_share_links.setup.test.ts";

// TODO(migration): one-time. Delete this file with the erase migrations in `migrations.ts`.
test("the erase opens a plugin-bound folder and deletes every plugin reader grant", async () => {
	const { t, db, insert_children, add_member } = await seed_folder_table();
	const member = await add_member("clerk_reader_member", null);
	const [boundNodeId, otherNodeId, takenNodeId] = await insert_children([
		{ name: "bound", kind: "folder", updatedAt: 1, restricted: true },
		{ name: "other", kind: "folder", updatedAt: 2, restricted: true },
		{ name: "taken", kind: "folder", updatedAt: 3, restricted: true },
	]);
	const installationId = await insert_installation({ t, db });

	// The plugin bound /bound and gave the member a reader grant. Another tagged grant sits on /other.
	// A person took over /taken: its binding is detached and its grant has no tag.
	await test_run_with_flush(t, async (ctx) => {
		const insert = (nodeId: typeof boundNodeId, tagged: boolean) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				resourceKind: "file",
				resourceId: String(nodeId),
				principalKind: "user",
				userId: member.userId,
				...(tagged ? { externalPluginMembershipLifetime: 1 } : {}),
				permission: "content.read",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		await insert(boundNodeId!, true);
		await insert(otherNodeId!, true);
		await insert(takenNodeId!, false);
		await ctx.db.insert("plugins_file_access_bindings", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			installationId,
			scopeId: "p/scope",
			nodeId: boundNodeId!,
			updatedAt: Date.now(),
		});
		await ctx.db.insert("plugins_external_file_bindings", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			installationId,
			writerId: await ctx.db.insert("plugins_external_file_writers", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				installationId,
				resourceKey: "channel",
				rootNodeId: takenNodeId!,
				folderNodeId: takenNodeId!,
				rootPath: "/taken",
				path: "/taken",
				generation: 1,
				updatedAt: 1,
			}),
			nodeId: takenNodeId!,
			revision: 2,
			detachedAt: 1,
			updatedAt: 1,
		});
	});
	// Old share rows copied the grant's tag.
	await t.run(async (ctx) => {
		for (const row of await ctx.db.query("files_share_rows").collect()) {
			if (row.nodeId === takenNodeId) continue;
			await ctx.db.patch("files_share_rows", row._id, { externalPluginMembershipLifetime: 1 });
		}
	});

	const args = { oneBatchOnly: true, cursor: null, batchSize: 100, dryRun: false };
	await t.mutation(internal.migrations.erase_plugins_file_access_bindings, args);
	await t.mutation(internal.migrations.erase_plugins_external_file_bindings, args);
	await t.mutation(internal.migrations.erase_access_control_permission_grants_externalPluginMembershipLifetime, args);
	await t.mutation(internal.migrations.erase_files_share_rows_externalPluginMembershipLifetime, args);

	const after = await t.run(async (ctx) => ({
		bound: await ctx.db.get("files_nodes", boundNodeId!),
		other: await ctx.db.get("files_nodes", otherNodeId!),
		taken: await ctx.db.get("files_nodes", takenNodeId!),
		grants: await ctx.db.query("access_control_permission_grants").collect(),
		bindings: await ctx.db.query("plugins_file_access_bindings").collect(),
		externalBindings: await ctx.db.query("plugins_external_file_bindings").collect(),
		shareRows: await ctx.db.query("files_share_rows").collect(),
	}));
	expect(after.bound?.restrictedScopeNodeId, "the bound folder gets its parent's access").toBeNull();
	expect(after.other?.restrictedScopeNodeId, "a folder the plugin did not bind stays restricted").toBe(otherNodeId);
	expect(after.taken?.restrictedScopeNodeId, "a folder a person took over keeps its access").toBe(takenNodeId);
	expect(
		after.grants.filter((grant) => grant.resourceKind === "file").map((grant) => grant.resourceId),
		"only the grant a person owns is left",
	).toEqual([String(takenNodeId)]);
	expect(after.bindings).toEqual([]);
	expect(after.externalBindings).toEqual([]);
	expect(after.shareRows.map((row) => row.nodeId)).toEqual([takenNodeId]);
});

test("the erase removes own-access from a policy allowlist and keeps the other capabilities", async () => {
	const { t, db } = await seed_folder_table();
	const policyId = await t.run((ctx) =>
		ctx.db.insert("organizations_integration_policies", {
			organizationId: db.organizationId,
			plugins: {
				mode: "allowlist",
				allowlist: [
					{
						pluginName: "chitchat",
						publisherUserId: db.userId,
						sourceRepositoryUrl: "https://github.com/example/chitchat",
						capabilities: ["workspace.files.write", "workspace.files.own-access", "workspace.files.own-write"],
						outboundOrigins: [],
						uiOutboundOrigins: [],
						serviceEventsOrigins: [],
						mcpServers: [],
						addedBy: db.userId,
						addedAt: 1,
						updatedAt: 1,
					},
				],
			},
			mcpServers: { mode: "allowlist", allowlist: [] },
			updatedBy: db.userId,
			updatedAt: 1,
		}),
	);

	await t.mutation(internal.migrations.erase_organizations_integration_policies_own_access, {
		oneBatchOnly: true,
		cursor: null,
		batchSize: 100,
		dryRun: false,
	});

	const policy = await t.run((ctx) => ctx.db.get("organizations_integration_policies", policyId));
	expect(policy?.plugins.allowlist[0]?.capabilities).toEqual(["workspace.files.write", "workspace.files.own-write"]);
});
