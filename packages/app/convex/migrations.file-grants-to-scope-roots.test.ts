import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file } from "./setup.test.ts";
import {
	fixture as share_fixture,
	insert_installation,
	mock_share_storage,
	reset_rate_limits,
	type Fixture,
} from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

type Grant = Doc<"access_control_permission_grants">;

async function fixture() {
	const f = await share_fixture();
	f.t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	return f;
}

function get_node(f: Fixture, nodeId: Id<"files_nodes">) {
	return f.t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))!);
}

/** Make the folder at `path` with one file in it, and return both ids. */
async function seed_folder(f: Fixture, path: string) {
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: `${path}/x.md` });
	return { folderId: (await get_node(f, fileId)).parentId as Id<"files_nodes">, fileId };
}

/** Insert grant docs the way the old writers left them, with no extended root. */
function insert_grants(
	f: Fixture,
	nodeId: Id<"files_nodes">,
	principal:
		| { principalKind: "user"; userId: Id<"users"> }
		| { principalKind: "role"; role: "member" }
		| { principalKind: "service_account"; serviceAccountId: Id<"access_control_service_accounts"> },
	permissions: Grant["permission"][],
) {
	return f.t.run(async (ctx) => {
		for (const permission of permissions) {
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				resourceKind: "file",
				resourceId: String(nodeId),
				...principal,
				permission,
				createdAt: 1,
				updatedAt: 1,
			});
		}
	});
}

async function create_account(f: Fixture) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const created = await f.asOwner.mutation(api.access_control.create_service_account, {
		membershipId: f.db.membershipId,
		name: "Writer",
	});
	return created._yay!.serviceAccountId;
}

function permissions_on(f: Fixture, nodeId: Id<"files_nodes">, principalKind: Grant["principalKind"]) {
	return f.t.run(async (ctx) =>
		(
			await ctx.db
				.query("access_control_permission_grants")
				.filter((q) => q.and(q.eq(q.field("resourceId"), nodeId), q.eq(q.field("principalKind"), principalKind)))
				.collect()
		)
			.map((grant) => grant.permission)
			.sort(),
	);
}

async function run_migrations(f: Fixture) {
	for (const migration of [
		internal.migrations.backfill_files_nodes_extended_scope,
		internal.migrations.migrate_file_grants_to_scope_roots,
	]) {
		const status = await f.t.action((ctx) => runToCompletion(ctx, components.migrations, migration));
		expect(status.state).toBe("success");
	}
	// The scope jobs of big folders finish in later steps.
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function audit(f: Fixture) {
	const nodes = await f.t.query(internal.migrations.audit_files_nodes_extended_scope, { cursor: null });
	const grants = await f.t.query(internal.migrations.audit_file_grants_on_scope_roots, { cursor: null });
	return [...nodes.page, ...grants.page];
}

test("the backfill sets a null extended scope", async () => {
	const f = await fixture();
	const { folderId } = await seed_folder(f, "/a");
	await f.t.run((ctx) => ctx.db.patch("files_nodes", folderId, { extendedScopeNodeId: undefined }));

	await run_migrations(f);

	expect((await get_node(f, folderId)).extendedScopeNodeId).toBe(null);
	expect(await audit(f)).toEqual([]);
});

test("user, role and account grants on open nodes become extended roots", async () => {
	const f = await fixture();
	const serviceAccountId = await create_account(f);
	const user = await seed_folder(f, "/u");
	const role = await seed_folder(f, "/r");
	const account = await seed_folder(f, "/s");
	await insert_grants(f, user.folderId, { principalKind: "user", userId: f.memberId }, ["content.read"]);
	await insert_grants(f, role.folderId, { principalKind: "role", role: "member" }, ["content.read"]);
	await insert_grants(f, account.folderId, { principalKind: "service_account", serviceAccountId }, [
		"content.read",
		"content.write",
	]);
	expect((await audit(f)).map((problem) => problem.problem)).toContain("grant_not_on_root");

	await run_migrations(f);

	for (const { folderId, fileId } of [user, role, account]) {
		expect(await get_node(f, folderId)).toMatchObject({
			extendedScopeNodeId: folderId,
			parentExtendedScopeNodeId: null,
		});
		expect((await get_node(f, fileId)).extendedScopeNodeId).toBe(folderId);
	}
	expect(await permissions_on(f, user.folderId, "user")).toEqual(["content.read"]);
	expect(await permissions_on(f, role.folderId, "role")).toEqual(["content.read"]);
	expect(await permissions_on(f, account.folderId, "service_account")).toEqual(["content.read", "content.write"]);
	expect(await audit(f)).toEqual([]);
});

test("a dormant account grant inside a restricted folder is deleted and its root removed", async () => {
	const f = await fixture();
	const installationId = await insert_installation(f);
	const installation = (await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))!;
	const outer = await seed_folder(f, "/p");
	const inner = await seed_folder(f, "/p/c");
	await reset_rate_limits(f.t, [f.db.userId]);
	expect(
		(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: outer.folderId,
			})
		)._nay,
	).toBeUndefined();
	// Before the restrict this was the plugin's folder. The old restrict kept the grant and the root.
	await insert_grants(
		f,
		inner.folderId,
		{ principalKind: "service_account", serviceAccountId: installation.serviceAccountId },
		["content.read"],
	);
	await insert_grants(f, inner.folderId, { principalKind: "user", userId: f.memberId }, ["content.read"]);
	await f.t.run((ctx) =>
		ctx.db.patch("plugins_workspace_installations", installationId, {
			sandbox: { roots: [{ target: { kind: "folder", nodeId: inner.folderId }, level: "read" }], rebuild: null },
		}),
	);

	expect((await audit(f)).map((problem) => problem.problem)).toEqual(["dormant_grant", "dormant_grant"]);

	await run_migrations(f);

	expect(await permissions_on(f, inner.folderId, "service_account")).toEqual([]);
	expect(await permissions_on(f, inner.folderId, "user")).toEqual([]);
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.sandbox.roots,
	).toEqual([]);
	expect((await get_node(f, inner.folderId)).parentExtendedScopeNodeId).toBeUndefined();
	expect(await audit(f)).toEqual([]);
});

test("a grant whose scope is still changing is skipped", async () => {
	const f = await fixture();
	const outer = await seed_folder(f, "/p");
	const inner = await seed_folder(f, "/p/c");
	await insert_grants(f, inner.folderId, { principalKind: "user", userId: f.memberId }, ["content.read"]);
	// A restrict whose job has not reached the child yet: the root flag is set, the child still stores null.
	await f.t.run((ctx) =>
		ctx.db.patch("files_nodes", outer.folderId, { isRestrictedScopeRoot: true, restrictedScopeNodeId: outer.folderId }),
	);

	await run_migrations(f);

	expect((await get_node(f, inner.folderId)).parentExtendedScopeNodeId).toBeUndefined();
	expect(await permissions_on(f, inner.folderId, "user")).toEqual(["content.read"]);
});

test("a manage grant on an open node is lowered to write", async () => {
	const f = await fixture();
	const serviceAccountId = await create_account(f);
	const { folderId } = await seed_folder(f, "/m");
	const manage: Grant["permission"][] = ["content.read", "content.write", "content.permissions.manage"];
	await insert_grants(f, folderId, { principalKind: "user", userId: f.memberId }, manage);
	await insert_grants(f, folderId, { principalKind: "service_account", serviceAccountId }, manage);

	await run_migrations(f);

	expect(await permissions_on(f, folderId, "user")).toEqual(["content.read", "content.write"]);
	expect(await permissions_on(f, folderId, "service_account")).toEqual(["content.read", "content.write"]);
	expect((await get_node(f, folderId)).parentExtendedScopeNodeId).toBe(null);
	expect(await audit(f)).toEqual([]);
});
