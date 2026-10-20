import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file, test_move_nodes, test_run_with_flush, test_spy_handler } from "./setup.test.ts";
import { get_node_share_state } from "./files_sharing.ts";
import { expect_under_convex_limits, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { access_control_ADDED_PEOPLE_LEVEL_MESSAGE } from "../shared/access-control.ts";
import {
	access_control_db_can_act_on_file_node,
	access_control_db_has_permission,
	type access_control_Subject,
} from "./access_control.ts";
import {
	apply_binding,
	fixture,
	insert_installation,
	link_on,
	mock_share_storage,
	read_links,
	reset_rate_limits,
	type Fixture,
} from "./files_share_links.setup.test.ts";

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

function can(
	f: Fixture,
	subject: access_control_Subject,
	nodeId: Id<"files_nodes">,
	permission: "content.read" | "content.write" = "content.read",
) {
	return f.t.run(async (ctx) =>
		access_control_db_can_act_on_file_node(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			subject,
			fileNode: (await ctx.db.get("files_nodes", nodeId))!,
			permission,
		}),
	);
}

/** The owner adds the member, or the member role, with one level. */
async function share_with(
	f: Fixture,
	nodeId: Id<"files_nodes">,
	level: "read" | "write" | "manage",
	principal: { kind: "user"; userId: Id<"users"> } | { kind: "role"; role: "member" } = {
		kind: "user",
		userId: f.memberId,
	},
) {
	await reset_rate_limits(f.t, [f.db.userId]);
	return await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
		membershipId: f.db.membershipId,
		nodeId,
		principal,
		level,
	});
}

async function unshare(
	f: Fixture,
	nodeId: Id<"files_nodes">,
	principal:
		| { kind: "user"; userId: Id<"users"> }
		| { kind: "service_account"; serviceAccountId: Id<"access_control_service_accounts"> },
) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const result = await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, {
		membershipId: f.db.membershipId,
		nodeId,
		principal,
	});
	expect(result._nay).toBeUndefined();
}

/** `/r` restricted by the owner, so the member reads nothing in it, and the file `/r/d/x.md`. */
async function seed_restricted(f: Fixture) {
	const restrictedId = await seed_folder(f, "/r");
	const folderId = await seed_folder(f, "/r/d");
	const fileId = (await f.t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.filter((q) => q.eq(q.field("path"), "/r/d/x.md"))
			.first(),
	))!._id;
	const otherId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/r/other.md" });
	await set_restricted(f, restrictedId, true);
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	return { restrictedId, folderId, fileId, otherId };
}

const member = (f: Fixture) => ({ kind: "user", userId: f.memberId, plugin: null }) as const;

test("adding a person to a folder inside a restricted folder lets them read everything inside it", async () => {
	const f = await fixture();
	const { restrictedId, folderId, fileId, otherId } = await seed_restricted(f);
	expect(await can(f, member(f), fileId)).toBe(false);

	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();

	expect(await can(f, member(f), folderId)).toBe(true);
	expect(await can(f, member(f), fileId)).toBe(true);
	expect(await can(f, member(f), fileId, "content.write")).toBe(false);
	expect(await can(f, member(f), restrictedId)).toBe(false);
	expect(await can(f, member(f), otherId)).toBe(false);
});

test("adding a role to a file inside a restricted folder lets it read only that file", async () => {
	const f = await fixture();
	const { fileId, otherId } = await seed_restricted(f);

	expect((await share_with(f, otherId, "write", { kind: "role", role: "member" }))._nay).toBeUndefined();

	expect(await get_node(f, otherId)).toMatchObject({ extendedScopeNodeId: otherId, parentExtendedScopeNodeId: null });
	expect(await can(f, member(f), otherId, "content.write")).toBe(true);
	expect(await can(f, member(f), fileId)).toBe(false);
});

test("a restricted folder inside an extended folder stops the added person", async () => {
	const f = await fixture();
	const { folderId } = await seed_restricted(f);
	const innerId = await seed_folder(f, "/r/d/s");
	const innerFileId = (await f.t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.filter((q) => q.eq(q.field("path"), "/r/d/s/x.md"))
			.first(),
	))!._id;
	await set_restricted(f, innerId, true);

	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	expect(await can(f, member(f), innerId)).toBe(false);
	expect(await can(f, member(f), innerFileId)).toBe(false);
});

test("Add people offers view and edit only; manage is refused on an Add-people item", async () => {
	const f = await fixture();
	const { folderId } = await seed_restricted(f);

	const refused = await share_with(f, folderId, "manage");

	expect(refused._nay?.message).toBe(access_control_ADDED_PEOPLE_LEVEL_MESSAGE);
	// Refused before any write, so no extended root is left behind.
	expect((await get_node(f, folderId)).parentExtendedScopeNodeId).toBeUndefined();
	expect(await can(f, member(f), folderId)).toBe(false);
});

test("adding a person keeps everyone who had access before", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/open");
	const serviceAccountId = await create_account(f);

	expect((await share_with_account(f, folderId, serviceAccountId, "read"))._nay).toBeUndefined();

	// The member reads open content through their role, and still does.
	expect(await can(f, member(f), folderId, "content.write")).toBe(true);
});

test("removing the last added person un-extends the folder after the job", async () => {
	const f = await fixture();
	const { folderId, fileId } = await seed_restricted(f);
	const serviceAccountId = await create_account(f);
	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	expect((await share_with_account(f, folderId, serviceAccountId, "read"))._nay).toBeUndefined();

	await unshare(f, folderId, { kind: "user", userId: f.memberId });
	// The account is still added here.
	expect((await get_node(f, folderId)).parentExtendedScopeNodeId).toBe(null);
	expect(await can(f, member(f), fileId)).toBe(false);

	await unshare(f, folderId, { kind: "service_account", serviceAccountId });
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	const folder = await get_node(f, folderId);
	expect(folder.parentExtendedScopeNodeId).toBeUndefined();
	expect(folder.extendedScopeNodeId).toBe(null);
	expect((await get_node(f, fileId)).extendedScopeNodeId).toBe(null);
});

test("restricting an extended folder starts with only the restricter", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/open");
	const serviceAccountId = await create_account(f);
	expect((await share_with(f, folderId, "write"))._nay).toBeUndefined();
	expect((await share_with_account(f, folderId, serviceAccountId, "write"))._nay).toBeUndefined();

	await set_restricted(f, folderId, true);

	const grants = await f.t.run((ctx) =>
		ctx.db
			.query("access_control_permission_grants")
			.filter((q) => q.eq(q.field("resourceId"), folderId))
			.collect(),
	);
	// The owner restricted it and holds no grants.
	expect(grants).toEqual([]);
	expect(await get_node(f, folderId)).toMatchObject({ restrictedScopeNodeId: folderId, extendedScopeNodeId: null });
	expect(await can(f, member(f), folderId)).toBe(false);
	expect(await can(f, { kind: "service_account", serviceAccountId }, folderId)).toBe(false);
});

test("an extended folder appears in Shared with you for the added person, and follows its changes", async () => {
	const f = await fixture();
	const { folderId } = await seed_restricted(f);
	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	const shared = async () =>
		(
			await f.asMember.query(api.files_tree.list_tree_shared_roots, {
				membershipId: f.memberMembershipId,
				archived: false,
				principalIndex: 0,
				paginationOpts: { numItems: 50, cursor: null },
			})
		).page.map((node) => node.path);

	expect(await shared()).toEqual(["/r/d"]);

	await reset_rate_limits(f.t, [f.db.userId]);
	const renamed = await f.asOwner.mutation(api.files_nodes.rename_node, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		nodeId: folderId,
		path: "e",
	});
	expect(renamed._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	expect(await shared()).toEqual(["/r/e"]);

	// A direct write to a copied field, like a content save, syncs the row too. A stale copy is dropped.
	await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", folderId, { updatedAt: 42 }));
	expect(await shared()).toEqual(["/r/e"]);
});

test("the share dialog says where access comes from", async () => {
	const f = await fixture();
	const { restrictedId, folderId, fileId } = await seed_restricted(f);
	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	const state = (as: typeof f.asOwner, membershipId: Id<"organizations_workspaces_users">, nodeId: Id<"files_nodes">) =>
		as.query(api.files_sharing.get_node_share_state, { membershipId, nodeId });

	const onFolder = await state(f.asOwner, f.db.membershipId, folderId);
	expect(onFolder).toMatchObject({ access: "extended_root", canAddPeople: true });
	expect(onFolder?.entries.map((entry) => entry.principal)).toEqual([{ kind: "user", userId: f.memberId }]);
	expect(onFolder?.inheritedFrom).toEqual({
		restricted: { nodeId: restrictedId, name: "r", path: "/r", entries: [] },
		extended: [],
	});

	const onFile = await state(f.asOwner, f.db.membershipId, fileId);
	expect(onFile).toMatchObject({ access: "inherits", entries: [] });
	expect(onFile?.inheritedFrom.extended.map((line) => [line.path, line.entries?.length])).toEqual([["/r/d", 1]]);

	// The member reads the file only through its added people, so the lines carry no names.
	const asMember = await state(f.asMember, f.memberMembershipId, fileId);
	expect(asMember).toMatchObject({ canAddPeople: false });
	expect(asMember?.inheritedFrom.restricted?.entries).toBe(null);
	expect(asMember?.inheritedFrom.extended.map((line) => line.entries)).toEqual([null]);

	// A reader of the whole restricted folder sees the names, as before.
	expect((await share_with(f, restrictedId, "read"))._nay).toBeUndefined();
	const asReader = await state(f.asMember, f.memberMembershipId, fileId);
	expect(asReader).toMatchObject({ canAddPeople: false });
	expect(asReader?.inheritedFrom.restricted?.entries?.map((entry) => entry.principal)).toEqual([
		{ kind: "user", userId: f.memberId },
	]);
	expect(asReader?.inheritedFrom.extended.map((line) => line.entries?.length)).toEqual([1]);
});

test("a public link survives adding people", async () => {
	const f = await fixture();
	const link = await link_on(f, f.nodeId);

	expect((await share_with(f, f.nodeId, "read"))._nay).toBeUndefined();

	expect((await read_links(f.t, f.nodeId)).map((doc) => doc._id)).toEqual([link._id]);
});

test("the extended chain stops after 8 dead hops", async () => {
	const f = await fixture();
	const { folderId } = await seed_restricted(f);
	// Nine folders inside the extended folder. Each is a dead root: it points on to the next one up.
	const dead: Id<"files_nodes">[] = [];
	let path = "/r/d";
	for (let index = 0; index < 9; index++) {
		path += `/${index}`;
		dead.unshift(await seed_folder(f, path));
	}
	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const deepFileId = await f.t.run(async (ctx) => {
		for (const [index, nodeId] of dead.entries()) {
			await ctx.db.patch("files_nodes", nodeId, { extendedScopeNodeId: dead[index + 1] ?? folderId });
		}
		const deepFile = await ctx.db
			.query("files_nodes")
			.filter((q) => q.eq(q.field("path"), `${path}/x.md`))
			.first();
		await ctx.db.patch("files_nodes", deepFile!._id, { extendedScopeNodeId: dead[0] });
		return deepFile!._id;
	});

	// The file inside the deepest folder walks 9 dead hops, the folder itself 8.
	expect(await can(f, member(f), deepFileId)).toBe(false);
	expect(await can(f, member(f), dead[0]!)).toBe(true);
});

/**
 * The member added on `/r/d`, and 500 folders nested under it, each an extended root with one user
 * grant and two role grants that do not name the member. Inserted directly: the access check reads
 * only these fields. Returns the deepest folder.
 */
async function seed_deep_chain(f: Fixture) {
	const { folderId } = await seed_restricted(f);
	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	return await f.t.run(async (ctx) => {
		const { _id, _creationTime, ...template } = (await ctx.db.get("files_nodes", folderId))!;
		const strangerId = await ctx.db.insert("users", { clerkUserId: null });
		const grant = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, resourceKind: "file" as const };
		let parent = { _id, path: template.path };
		for (let depth = 0; depth < 500; depth++) {
			const path = `${parent.path}/a`;
			const nodeId = await ctx.db.insert("files_nodes", {
				...template,
				parentId: parent._id,
				path,
				treePath: `${path}/`,
				parentExtendedScopeNodeId: parent._id,
			});
			await ctx.db.patch("files_nodes", nodeId, { extendedScopeNodeId: nodeId });
			for (const principal of [
				{ principalKind: "user" as const, userId: strangerId },
				{ principalKind: "role" as const, role: "admin" as const },
			]) {
				for (const permission of ["content.read", "content.write"] as const) {
					if (principal.principalKind === "user" && permission === "content.write") continue;
					await ctx.db.insert("access_control_permission_grants", {
						...grant,
						resourceId: String(nodeId),
						...principal,
						permission,
						createdAt: 1,
						updatedAt: 1,
					});
				}
			}
			parent = { _id: nodeId, path };
		}
		return parent._id;
	});
}

test("the worst chain check stays under the limits at 500 levels", async () => {
	const f = await fixture();
	const deepestId = await seed_deep_chain(f);

	const { allowed, cost } = await f.t.run(async (ctx) => {
		const fileNode = (await ctx.db.get("files_nodes", deepestId))!;
		const before = await ctx.meta.getTransactionMetrics();
		const allowed = await access_control_db_can_act_on_file_node(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			subject: member(f),
			fileNode,
			permission: "content.read",
		});
		const after = await ctx.meta.getTransactionMetrics();
		return { allowed, cost: transaction_cost(before, after) };
	});
	console.info("Chain check at 500 levels", cost);

	// Only the top root names the member, so the check walks the whole chain.
	expect(allowed).toBe(true);
	expect_under_convex_limits(cost);
	expect(cost.documentsRead).toBeGreaterThan(500);
	expect(cost.databaseQueries).toBeLessThan(3_000);
}, 120_000);

test("the share dialog stays under the limits at 500 levels", async () => {
	const f = await fixture();
	const deepestId = await seed_deep_chain(f);

	let cost: ReturnType<typeof transaction_cost> | null = null;
	test_spy_handler(get_node_share_state, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
		return result;
	});
	const state = await f.asMember.query(api.files_sharing.get_node_share_state, {
		membershipId: f.memberMembershipId,
		nodeId: deepestId,
	});
	console.info("Share dialog at 500 levels", cost);
	expect(state?.inheritedFrom.extended).toHaveLength(500);
	expect_under_convex_limits(cost!);
	expect(cost!.databaseQueries).toBeLessThan(3_000);

	// The owner manages every level, so the dialog also loads each level's list.
	const asOwner = await f.asOwner.query(api.files_sharing.get_node_share_state, {
		membershipId: f.db.membershipId,
		nodeId: deepestId,
	});
	console.info("Share dialog at 500 levels, as the owner", cost);
	expect(asOwner?.inheritedFrom.extended.filter((line) => line.entries?.length === 2)).toHaveLength(499);
	expect_under_convex_limits(cost!);
}, 120_000);

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

test("an account grant on an open folder reaches the items inside", async () => {
	const f = await fixture();
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/a/x.md" });
	const folderId = (await get_node(f, fileId)).parentId as Id<"files_nodes">;
	const serviceAccountId = await create_account(f);
	const subject = { kind: "service_account", serviceAccountId } as const;

	expect((await share_with_account(f, folderId, serviceAccountId, "read"))._nay).toBeUndefined();

	expect(await can(f, subject, folderId)).toBe(true);
	expect(await can(f, subject, fileId)).toBe(true);
	expect(await can(f, subject, f.nodeId)).toBe(false);
	// The single-node check answers the same.
	expect(
		await f.t.run(async (ctx) => {
			const organization = (await ctx.db.get("organizations", f.db.organizationId))!;
			return await access_control_db_has_permission(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId!,
				organizationOwnerUserId: organization.ownerUserId,
				serviceAccountId,
				resource: { kind: "file", id: fileId, restrictedScopeNodeId: null },
				permission: "content.read",
			});
		}),
	).toBe(true);
});

test("an account grant on an item inside a restricted folder makes it an extended root", async () => {
	const f = await fixture();
	const { folderId, fileId, otherId } = await seed_restricted(f);
	const serviceAccountId = await create_account(f);
	const subject = { kind: "service_account", serviceAccountId } as const;

	expect((await share_with_account(f, folderId, serviceAccountId, "read"))._nay).toBeUndefined();

	expect((await get_node(f, folderId)).parentExtendedScopeNodeId).toBe(null);
	expect(await can(f, subject, fileId)).toBe(true);
	expect(await can(f, subject, otherId)).toBe(false);
});

test("binding a folder with added people to a private space needs a restrict first, which removes them", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/b");
	const serviceAccountId = await create_account(f);
	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	expect((await share_with_account(f, folderId, serviceAccountId, "write"))._nay).toBeUndefined();
	const installationId = await insert_installation(f);

	// A plugin binds only a restricted folder.
	await set_restricted(f, folderId, true);
	await apply_binding(f, { installationId, folderId, readScopeId: "team" });

	// The private space has no members yet, so nobody is left on the folder.
	expect(await account_levels(f, folderId)).toEqual([]);
	expect(await can(f, member(f), folderId)).toBe(false);
	expect(await get_node(f, folderId)).toMatchObject({ restrictedScopeNodeId: folderId, extendedScopeNodeId: null });
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

test.each([
	{ from: "an open folder", extendedPath: "/e" },
	{ from: "the same restricted folder", extendedPath: "/r/e" },
])("a published Move into a restricted folder from $from drops the added people at once", async ({ extendedPath }) => {
	const f = await fixture();
	const restrictedId = await seed_folder(f, "/r");
	await set_restricted(f, restrictedId, true);
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const extendedId = await seed_folder(f, extendedPath);
	const subId = await seed_folder(f, `${extendedPath}/sub`);
	// Enough children that the Move repairs their stored fields in later steps.
	const childId = await f.t.run(async (ctx) => {
		const { _id, _creationTime, ...sub } = (await ctx.db.get("files_nodes", subId))!;
		let lastId: Id<"files_nodes"> | null = null;
		for (let index = 0; index < 150; index += 1) {
			lastId = await ctx.db.insert("files_nodes", {
				...sub,
				parentId: subId,
				name: `child-${index}`,
				sortName: `child-${index}`,
				path: `${sub.path}/child-${index}`,
				treePath: `${sub.treePath}child-${index}/`,
				pathDepth: sub.pathDepth + 1,
			});
		}
		return lastId!;
	});
	expect((await share_with(f, extendedId, "read"))._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const read_child = () =>
		f.asMember.query(api.files_tree.get_file_node_for_membership, {
			membershipId: f.memberMembershipId,
			fileNodeId: String(childId),
		});
	expect(await read_child()).not.toBeNull();

	let observed = false;
	await reset_rate_limits(f.t, [f.db.userId]);
	const moved = await test_move_nodes(f.t, f.asOwner, {
		membershipId: f.db.membershipId,
		itemIds: [subId],
		targetParentId: restrictedId,
		onStep: async () => {
			if (observed) return;
			const stored = await get_node(f, childId);
			const cohort = stored.moveCohortId
				? await f.t.run((ctx) => ctx.db.get("files_move_cohorts", stored.moveCohortId!))
				: null;
			if (!cohort || cohort.publishedAt === null || !stored.treePath.startsWith(`${extendedPath}/`)) return;
			observed = true;
			expect(await read_child(), "The stored node still points at the old extended folder").toBeNull();
			// A caller that passes only the id and the scope makes the checker read the node itself.
			expect(
				await f.t.run((ctx) =>
					access_control_db_can_act_on_file_node(ctx, {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						subject: member(f),
						fileNode: { _id: childId, restrictedScopeNodeId: restrictedId },
						permission: "content.read",
					}),
				),
				"The checker reads the node as the Move shows it",
			).toBe(false);
		},
	});

	expect(moved._nay).toBeUndefined();
	expect(observed, "The test sees the Move published before the child is repaired").toBe(true);
	expect(await read_child()).toBeNull();
});

test("restricting a folder above keeps the added people of an item inside it", async () => {
	const f = await fixture();
	const parentId = await seed_folder(f, "/p");
	const childId = await seed_folder(f, "/p/c");
	const ownerFileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/p/y.md" });
	expect((await share_with(f, childId, "read"))._nay).toBeUndefined();

	await set_restricted(f, parentId, true);
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	expect(await get_node(f, childId)).toMatchObject({ restrictedScopeNodeId: parentId, extendedScopeNodeId: childId });
	expect(await can(f, member(f), childId)).toBe(true);
	expect(await can(f, member(f), ownerFileId)).toBe(false);
});

test("Can edit lets an added person create inside the item, and Can view does not", async () => {
	const f = await fixture();
	const { folderId } = await seed_restricted(f);
	const create = (path: string) =>
		f.asMember.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.memberMembershipId,
			parentId: folderId,
			path,
		});

	expect((await share_with(f, folderId, "read"))._nay).toBeUndefined();
	expect((await create("viewer-made"))._nay).toBeDefined();

	expect((await share_with(f, folderId, "write"))._nay).toBeUndefined();
	expect((await create("editor-made"))._nay).toBeUndefined();
});

test("a chain whose roots point at each other stops instead of looping", async () => {
	const f = await fixture();
	const { folderId } = await seed_restricted(f);
	const innerId = await seed_folder(f, "/r/d/s");
	// Two roots that name each other as the next one up. Only a bad write could leave this.
	await f.t.run(async (ctx) => {
		await ctx.db.patch("files_nodes", folderId, { extendedScopeNodeId: folderId, parentExtendedScopeNodeId: innerId });
		await ctx.db.patch("files_nodes", innerId, { extendedScopeNodeId: innerId, parentExtendedScopeNodeId: folderId });
	});

	expect(await can(f, member(f), innerId)).toBe(false);
	const { restrictedScopeNodeId } = await get_node(f, innerId);
	expect(
		await f.t.run(async (ctx) =>
			access_control_db_has_permission(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				defaultWorkspaceId: f.db.workspaceId,
				organizationOwnerUserId: f.db.userId,
				userId: f.memberId,
				resource: { kind: "file", id: innerId, restrictedScopeNodeId },
				permission: "content.read",
			}),
		),
	).toBe(false);
});
