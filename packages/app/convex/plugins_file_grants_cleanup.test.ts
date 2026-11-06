import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { fixture, insert_installation, mock_share_storage, type Fixture } from "./files_share_links.setup.test.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { test_create_saved_text_file } from "./setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function seed(
	f: Fixture,
	args: {
		count: number;
		membershipId?: Id<"organizations_workspaces_users">;
		rootNodeId?: Id<"files_nodes">;
		withWorkspace?: boolean;
	},
) {
	const installationId = await insert_installation(f);
	const pairId = await f.t.run(async (ctx) => {
		const membership = (await ctx.db.get("organizations_workspaces_users", args.membershipId ?? f.db.membershipId))!;
		const pairId = await ctx.db.insert("plugins_file_pairs", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId,
			userId: membership.userId,
			membershipId: membership._id,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
			createdAt: Date.now(),
		});
		for (let i = 0; i < args.count; i++) {
			await ctx.db.insert("plugins_file_consents", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				pairId,
				rootNodeId: args.withWorkspace && i % 2 === 0 ? null : (args.rootNodeId ?? f.nodeId),
				requestedLevel: "read",
				appliedLevel: i === 0 ? "read" : null,
				areaEligible: false,
				open: i === 0,
				revision: 1,
				state: i === 0 ? "applied" : "ended",
				endedReason: i === 0 ? null : "Removed",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
		return pairId;
	});
	return { installationId, pairId };
}

test("uninstall drains several pages of mixed workspace and saved consents before their pair", async () => {
	const f = await fixture();
	const selected = await seed(f, { count: 201, withWorkspace: true });
	const kept = await seed(f, { count: 1 });
	await f.t.run((ctx) => ctx.db.delete("plugins_workspace_installations", selected.installationId));
	const args = { ...f.db, installationId: selected.installationId, _test_disableReschedule: true };
	const drain = () =>
		f.t.mutation(internal.plugins_data.drain_uninstalled_installation, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			_test_disableReschedule: true,
		});
	const first = await drain();
	expect(first.done, "uninstall must keep draining while consent pages remain").toBe(false);
	expect(await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", selected.pairId))).not.toBeNull();
	let done = first.done;
	for (let i = 0; i < 20 && !done; i++) done = (await drain()).done;
	expect(done).toBe(true);
	const anchors = await f.t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).filter(
			(job) => job.name === "plugins_file_grants_cleanup:retire_anchor",
		),
	);
	expect(anchors.length, "saved choices still schedule anchor cleanup").toBeGreaterThan(0);
	for (const anchor of anchors)
		expect(anchor.args[0], "workspace choices must not schedule a null saved anchor").toMatchObject({
			nodeId: f.nodeId,
		});
	expect(
		await f.t.run((ctx) =>
			ctx.db
				.query("plugins_file_consents")
				.withIndex("by_pair", (q) => q.eq("pairId", selected.pairId))
				.collect(),
		),
		"all selected installation consents must be deleted",
	).toEqual([]);
	expect(await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", selected.pairId))).toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", kept.pairId))).not.toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)), "uninstall keeps saved Files").not.toBeNull();
});

test("registry deletion drains personal grants before the installation", async () => {
	const f = await fixture();
	const selected = await seed(f, { count: 17, withWorkspace: true });
	for (let i = 0; i < 30; i++) {
		const pair = await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", selected.pairId));
		if (!pair) break;
		expect(
			await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", selected.installationId)),
			"registry deletion must keep the installation while personal grants drain",
		).not.toBeNull();
		await f.t.mutation(internal.plugins.hard_delete_plugin_from_registry, { pluginName: "chat", _test_batchSize: 4 });
	}
	expect(
		await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", selected.pairId)),
		"registry deletion must drain personal plugin pairs",
	).toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId))).not.toBeNull();
});

test("user cleanup drains their consents before removing their membership", async () => {
	const f = await fixture();
	const selected = await seed(f, { count: 17, membershipId: f.memberMembershipId, withWorkspace: true });
	const kept = await seed(f, { count: 1 });
	for (let i = 0; i < 30; i++) {
		const before = await f.t.run((ctx) =>
			ctx.db
				.query("plugins_file_consents")
				.withIndex("by_pair", (q) => q.eq("pairId", selected.pairId))
				.collect(),
		);
		if (before.length === 0) break;
		await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
			userId: f.memberId,
			_test_batchSize: 4,
			_test_disableReschedule: true,
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.memberMembershipId)),
			"the membership must stay while its plugin grants drain",
		).not.toBeNull();
	}
	expect(
		await f.t.run((ctx) =>
			ctx.db
				.query("plugins_file_consents")
				.withIndex("by_pair", (q) => q.eq("pairId", selected.pairId))
				.collect(),
		),
		"the deleted person's consents must drain",
	).toEqual([]);
	expect(await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", kept.pairId))).not.toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId))).not.toBeNull();
});

test("workspace cleanup removes pairs and grants before the installation", async () => {
	const f = await fixture();
	const selected = await seed(f, { count: 17, withWorkspace: true });
	const requestId = await f.t.run((ctx) =>
		data_deletion_db_request(ctx, {
			userId: f.db.userId,
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			scope: "workspace",
			eligibleAt: Date.now(),
		}),
	);
	for (let i = 0; i < 100; i++) {
		const pair = await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", selected.pairId));
		if (!pair) break;
		expect(
			await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", selected.installationId)),
			"the installation must stay while its pairs drain",
		).not.toBeNull();
		await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 4 });
	}
	expect(
		await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", selected.pairId)),
		"workspace cleanup must remove personal plugin pairs",
	).toBeNull();
	expect(
		await f.t.run((ctx) =>
			ctx.db
				.query("plugins_file_consents")
				.withIndex("by_pair", (q) => q.eq("pairId", selected.pairId))
				.collect(),
		),
	).toEqual([]);
});

test("anchor cleanup waits for the last open consent", async () => {
	const f = await fixture();
	const childId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/selected/doc.md" });
	const child = await f.t.run((ctx) => ctx.db.get("files_nodes", childId));
	const rootNodeId = child!.parentId as Id<"files_nodes">;
	const selected = await seed(f, { count: 1, rootNodeId });
	await f.t.mutation(internal.files_subtree_ops.extend_node, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		nodeId: rootNodeId,
	});
	const args = { nodeId: rootNodeId, userId: f.db.userId };
	await f.t.mutation(internal.plugins_file_grants_cleanup.retire_anchor, args);
	expect(
		(await f.t.run((ctx) => ctx.db.get("files_nodes", rootNodeId)))?.extendedScopeNodeId,
		"an open consent must keep its inheritance root",
	).toBe(rootNodeId);
	await f.t.run(async (ctx) => {
		const consent = (await ctx.db
			.query("plugins_file_consents")
			.withIndex("by_pair", (q) => q.eq("pairId", selected.pairId))
			.first())!;
		await ctx.db.patch("plugins_file_consents", consent._id, { open: false, appliedLevel: null, state: "ended" });
	});
	await f.t.mutation(internal.plugins_file_grants_cleanup.retire_anchor, args);
	expect(
		(await f.t.run((ctx) => ctx.db.get("files_nodes", rootNodeId)))?.extendedScopeNodeId,
		"an empty inheritance root must retire",
	).toBeNull();
});
