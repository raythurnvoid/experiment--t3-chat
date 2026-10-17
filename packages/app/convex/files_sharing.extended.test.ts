import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file } from "./setup.test.ts";
import { access_control_ADDED_PEOPLE_LEVEL_MESSAGE } from "../shared/access-control.ts";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import { fixture, mock_share_storage, reset_rate_limits, type Fixture } from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function get_node(f: Fixture, nodeId: Id<"files_nodes">) {
	return f.t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))!);
}

/** Make the folder at `path` with one file in it, and return the folder id. */
async function seed_folder(f: Fixture, path: string) {
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: `${path}/x.md` });
	return (await get_node(f, fileId)).parentId as Id<"files_nodes">;
}

async function create_account(f: Fixture) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const created = await f.asOwner.mutation(api.access_control.create_service_account, {
		membershipId: f.db.membershipId,
		name: "Writer",
	});
	return created._yay!.serviceAccountId;
}

async function share_with_account(
	f: Fixture,
	nodeId: Id<"files_nodes">,
	serviceAccountId: Id<"access_control_service_accounts">,
	level: "read" | "write" | "manage",
) {
	await reset_rate_limits(f.t, [f.db.userId]);
	return await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
		membershipId: f.db.membershipId,
		nodeId,
		principal: { kind: "service_account", serviceAccountId },
		level,
	});
}

async function set_restricted(f: Fixture, nodeId: Id<"files_nodes">, restricted: boolean) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const result = await f.asOwner.mutation(
		restricted ? api.files_sharing.restrict_node : api.files_sharing.unrestrict_node,
		{ membershipId: f.db.membershipId, nodeId },
	);
	expect(result._nay).toBeUndefined();
}

function account_levels(f: Fixture, nodeId: Id<"files_nodes">) {
	return f.t.run(async (ctx) =>
		(
			await ctx.db
				.query("access_control_permission_grants")
				.filter((q) => q.and(q.eq(q.field("resourceId"), nodeId), q.eq(q.field("principalKind"), "service_account")))
				.collect()
		)
			.map((grant) => grant.permission)
			.sort(),
	);
}

test("an account grant on a plain open folder makes it an extended root at once", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/a");
	const innerId = await seed_folder(f, "/a/b");
	const serviceAccountId = await create_account(f);

	expect((await share_with_account(f, folderId, serviceAccountId, "write"))._nay).toBeUndefined();

	const root = await get_node(f, folderId);
	expect(root.parentExtendedScopeNodeId).toBe(null);
	expect(root.extendedScopeNodeId).toBe(folderId);
	// The small folder's op ends in the same call, so the items inside already point at the root.
	expect((await get_node(f, innerId)).extendedScopeNodeId).toBe(folderId);
});

test("an account grant on an open folder does not reach the items inside yet", async () => {
	const f = await fixture();
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/a/x.md" });
	const folderId = (await get_node(f, fileId)).parentId as Id<"files_nodes">;
	const serviceAccountId = await create_account(f);
	const can = (nodeId: Id<"files_nodes">) =>
		f.t.run(async (ctx) =>
			access_control_db_can_act_on_file_node(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				subject: { kind: "service_account", serviceAccountId },
				fileNode: (await ctx.db.get("files_nodes", nodeId))!,
				permission: "content.read",
			}),
		);

	expect((await share_with_account(f, folderId, serviceAccountId, "read"))._nay).toBeUndefined();

	// The checks do not read the new chain yet, so the grant still works on the folder alone.
	expect(await can(folderId)).toBe(true);
	expect(await can(fileId)).toBe(false);
});

test("manage is refused for an account on an Add-people item", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/a");
	const serviceAccountId = await create_account(f);

	const refused = await share_with_account(f, folderId, serviceAccountId, "manage");

	expect(refused._nay?.message).toBe(access_control_ADDED_PEOPLE_LEVEL_MESSAGE);
	const node = await get_node(f, folderId);
	expect(node.parentExtendedScopeNodeId).toBeUndefined();
	expect(node.extendedScopeNodeId).toBe(null);
	expect(node.scopeOpId).toBeUndefined();
	expect(await account_levels(f, folderId)).toEqual([]);
});

test("unrestrict keeps service account grants as an extended root", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/a");
	const innerId = await seed_folder(f, "/a/b");
	const serviceAccountId = await create_account(f);
	await set_restricted(f, folderId, true);
	expect((await share_with_account(f, folderId, serviceAccountId, "read"))._nay).toBeUndefined();

	await set_restricted(f, folderId, false);

	const root = await get_node(f, folderId);
	expect(root.isRestrictedScopeRoot).toBe(false);
	expect(root.restrictedScopeNodeId).toBe(null);
	expect(root.parentExtendedScopeNodeId).toBe(null);
	expect(root.extendedScopeNodeId).toBe(folderId);
	expect(await get_node(f, innerId)).toMatchObject({ restrictedScopeNodeId: null, extendedScopeNodeId: folderId });
	expect(await account_levels(f, folderId)).toEqual(["content.read"]);
});

test("unrestrict lowers a kept account manage grant to edit", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/a");
	const serviceAccountId = await create_account(f);
	await set_restricted(f, folderId, true);
	expect((await share_with_account(f, folderId, serviceAccountId, "manage"))._nay).toBeUndefined();

	await set_restricted(f, folderId, false);

	expect(await account_levels(f, folderId)).toEqual(["content.read", "content.write"]);
	expect((await get_node(f, folderId)).parentExtendedScopeNodeId).toBe(null);
});

test("unrestrict with no account grants makes no extended root", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/a");
	await set_restricted(f, folderId, true);

	await set_restricted(f, folderId, false);

	const node = await get_node(f, folderId);
	expect(node.parentExtendedScopeNodeId).toBeUndefined();
	expect(node.extendedScopeNodeId).toBe(null);
});

test("the scope job does not walk into restricted children", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/a");
	const restrictedId = await seed_folder(f, "/a/r");
	const deepId = await seed_folder(f, "/a/r/deep");
	await set_restricted(f, restrictedId, true);
	// Put a wrong chain on an item inside the restricted folder. A walk that reached it would fix it.
	await f.t.run((ctx) => ctx.db.patch("files_nodes", deepId, { extendedScopeNodeId: restrictedId }));
	const serviceAccountId = await create_account(f);

	expect((await share_with_account(f, folderId, serviceAccountId, "write"))._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	// The restricted root itself is a child of the folder, so the job rebuilds it, but not its items.
	expect((await get_node(f, restrictedId)).extendedScopeNodeId).toBe(null);
	expect((await get_node(f, deepId)).extendedScopeNodeId).toBe(restrictedId);
});

test("restoring an item from an extended folder points at the area where it lands", async () => {
	const f = await fixture();
	const parentId = await seed_folder(f, "/p");
	const childId = await seed_folder(f, "/p/c");
	const serviceAccountId = await create_account(f);
	expect((await share_with_account(f, parentId, serviceAccountId, "read"))._nay).toBeUndefined();
	expect((await get_node(f, childId)).extendedScopeNodeId).toBe(parentId);

	// Archive the child first, so it can come back alone. Its parent stays archived, so it lands at the top.
	for (const nodeId of [childId, parentId]) {
		await reset_rate_limits(f.t, [f.db.userId]);
		const archived = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [String(nodeId)],
		});
		expect(archived._nay).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	}

	await reset_rate_limits(f.t, [f.db.userId]);
	const restored = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: f.db.membershipId,
		nodeIds: [String(childId)],
	});
	expect(restored._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	const node = await get_node(f, childId);
	expect(node.parentId).toBe("root");
	expect(node.extendedScopeNodeId).toBe(null);
});
