import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";

import { api, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { insert_tree_node, seed_tree_access_fixture } from "./files_nodes.setup.test.ts";
import { transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { organizations_membership_lifetimes_db_record } from "./organizations_membership_lifetimes.ts";
import { mock_plugins_review, register_media_plugin } from "./plugins.setup.test.ts";
import { test_convex, test_run_with_flush } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_plugins_review();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const tree = await seed_tree_access_fixture(t);
	const install = async (name: string) => {
		const version = await register_media_plugin({
			t,
			userId: tree.owner.userId,
			name,
			capabilities: ["workspace.files.read"],
			events: [],
		});
		const result = await tree.asOwner.mutation(api.plugins.install_version, {
			membershipId: tree.owner.membershipId,
			pluginVersionId: version.pluginVersionId,
			acceptedCapabilities: ["workspace.files.read"],
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
			serviceAccountGrants: [],
		});
		if (result._nay) throw new Error(result._nay.message);
		return result._yay.installationId;
	};
	const installationId = await install("file-consent");
	const otherInstallationId = await install("other-file-consent");
	const reset = (userId: Id<"users">) =>
		t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: userId }),
		);
	await reset(tree.owner.userId);
	return { t, ...tree, installationId, otherInstallationId, reset };
}

describe("personal plugin file grants", () => {
	test("allows consent while disabled, then blocks new consent during registry deletion", async () => {
		const f = await fixture();
		await f.t.run((ctx) => ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" }));
		const args = {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.grantedId,
			level: "read" as const,
		};
		const granted = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, args);
		if (granted._nay) throw new Error(granted._nay.message);
		await f.t.run((ctx) =>
			ctx.db.insert("plugins_registry_deletion_fences", { pluginName: "file-consent", createdAt: Date.now() }),
		);
		expect(
			(await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, args))._nay?.message,
			"registry deletion must block new personal consent",
		).toBe("file-consent is being removed. Choose another plugin.");
		expect(
			await f.asOwner.mutation(api.plugins_access.revoke_file_access_as_me, {
				membershipId: args.membershipId,
				installationId: args.installationId,
				consentId: granted._yay.consentId,
			}),
			"registry deletion must still allow removal",
		).toEqual({ _yay: null });
	});

	test("accepts a narrow read grant and refuses edit without the person's write access", async () => {
		const f = await fixture();
		const args = {
			membershipId: f.grantOnly.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.grantedId,
		};
		const granted = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_consents", granted._yay.consentId))).toMatchObject({
			requestedLevel: "read",
			appliedLevel: null,
			open: true,
			state: "pending",
			areaEligible: false,
		});
		const refused = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			level: "write",
		});
		expect(refused._nay?.message, "read access must not give the plugin edit access").toContain("Ask for Can edit");
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_consents", granted._yay.consentId))).toMatchObject({
			requestedLevel: "read",
		});
	});

	test("refuses unreadable and foreign roots before creating personal consent", async () => {
		const f = await fixture();
		for (const rootNodeId of [f.nodes.hiddenId, f.nodes.foreignFolderId]) {
			const result = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
				membershipId: f.grantOnly.membershipId,
				installationId: f.installationId,
				rootNodeId,
				level: "read",
			});
			expect(result._nay, "an unreadable or foreign root cannot become consent").toBeDefined();
		}
		expect(await f.t.run((ctx) => ctx.db.query("plugins_file_pairs").collect())).toEqual([]);
	});

	test("refuses an unfinished upload until its stored bytes arrive", async () => {
		const f = await fixture();
		const assetId = await test_run_with_flush(f.t, async (ctx) => {
			const id = await ctx.db.insert("files_r2_assets", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				kind: "upload",
				r2Bucket: "test",
				size: 10,
				createdBy: f.owner.userId,
				updatedAt: Date.now(),
			});
			await ctx.db.patch("files_nodes", f.nodes.openFileId, { assetId: id });
			return id;
		});
		const args = {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.openFileId,
			level: "read" as const,
		};
		expect(
			(await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, args))._nay?.message,
			"an unfinished upload cannot hold plugin consent",
		).toContain("still uploading");
		await f.t.run((ctx) => ctx.db.patch("files_r2_assets", assetId, { r2Key: "finished-upload" }));
		expect((await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, args))._yay).toBeDefined();
	});

	test("refuses consent once permanent deletion has started", async () => {
		const f = await fixture();
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.archive_nodes, {
					membershipId: f.owner.membershipId,
					nodeIds: [f.nodes.openId],
				})
			)._nay,
		).toBeUndefined();
		await f.t.run(async (ctx) => {
			const run = await ctx.db.query("files_archive_runs").first();
			if (!run) throw new Error("Expected an archive run");
			await ctx.db.patch("files_nodes", f.nodes.grantedId, { purgeRunId: run._id });
		});
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					rootNodeId: f.nodes.grantedId,
					level: "read",
				})
			)._nay?.message,
			"a deleting node cannot gain new personal consent",
		).toContain("is being deleted");
	});

	test("keeps personal consent separate from other people, installations and run consent", async () => {
		const f = await fixture();
		const granted = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			membershipId: f.grantOnly.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.grantedId,
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);
		const ownerGrant = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.grantedId,
			level: "write",
		});
		if (ownerGrant._nay) throw new Error(ownerGrant._nay.message);
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
					membershipId: f.grantOnly.membershipId,
					installationId: f.installationId,
					rootNodeId: f.nodes.grantedId,
					level: "write",
				})
			)._nay?.message,
			"a manager cannot grant another person's consent",
		).toBe("Unauthorized");
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.revoke_file_access_as_me, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					consentId: granted._yay.consentId,
				})
			)._nay?.message,
			"a manager cannot remove another person's consent",
		).toBe("Not found");
		expect(
			(
				await f.asGrantOnly.query(api.plugins_access.list_my_file_grants, {
					membershipId: f.grantOnly.membershipId,
					installationId: f.otherInstallationId,
					paginationOpts: { numItems: 20, cursor: null },
				})
			).page,
			"a second installation must not inherit this selection",
		).toEqual([]);
		expect(
			(
				await f.asOwner.query(api.plugins_access.list_my_file_grants, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					paginationOpts: { numItems: 20, cursor: null },
				})
			).page.map((grant) => grant.consentId),
		).toEqual([ownerGrant._yay.consentId]);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_resource_permission", (q) =>
						q
							.eq("organizationId", f.owner.organizationId)
							.eq("workspaceId", f.owner.workspaceId)
							.eq("resourceKind", "plugin_installation")
							.eq("resourceId", f.installationId)
							.eq("permission", "plugin.run_as"),
					)
					.collect(),
			),
		).toEqual([]);
	});

	test("keeps applied access while a new choice is pending and does not reopen ended consent", async () => {
		const f = await fixture();
		const args = {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.grantedId,
		};
		const first = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "write" });
		if (first._nay) throw new Error(first._nay.message);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_file_consents", first._yay.consentId, {
				appliedLevel: "write",
				state: "applied",
				areaEligible: true,
			}),
		);
		expect(await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "read" })).toEqual(
			first,
		);
		expect(
			await f.t.run((ctx) => ctx.db.get("plugins_file_consents", first._yay.consentId)),
			"a pending choice must keep the previously applied access",
		).toMatchObject({
			requestedLevel: "read",
			appliedLevel: "write",
			state: "pending",
			revision: 2,
			areaEligible: true,
		});
		expect(
			await f.asOwner.mutation(api.plugins_access.revoke_file_access_as_me, {
				membershipId: args.membershipId,
				installationId: args.installationId,
				consentId: first._yay.consentId,
			}),
		).toEqual({ _yay: null });
		await f.reset(f.owner.userId);
		const fresh = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "read" });
		expect(fresh._yay?.consentId, "fresh consent must not reopen an ended selection").not.toBe(first._yay.consentId);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_consents", first._yay.consentId))).toMatchObject({
			open: false,
			appliedLevel: null,
			areaEligible: false,
			state: "ended",
		});
	});

	test("allows removal after the person loses read access", async () => {
		const f = await fixture();
		const args = { membershipId: f.grantOnly.membershipId, installationId: f.installationId };
		const granted = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			rootNodeId: f.nodes.grantedId,
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);
		await f.t.run(async (ctx) => {
			const grants = await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_resource_permission", (q) =>
					q
						.eq("organizationId", f.owner.organizationId)
						.eq("workspaceId", f.owner.workspaceId)
						.eq("resourceKind", "file")
						.eq("resourceId", f.nodes.grantedId)
						.eq("permission", "content.read"),
				)
				.collect();
			for (const grant of grants) await ctx.db.delete("access_control_permission_grants", grant._id);
		});
		expect(
			(
				await f.asGrantOnly.query(api.plugins_access.list_my_file_grants, {
					...args,
					paginationOpts: { numItems: 20, cursor: null },
				})
			).page.map((grant) => grant.consentId),
			"unreadable selections must remain removable",
		).toEqual([granted._yay.consentId]);
		expect(
			await f.asGrantOnly.mutation(api.plugins_access.revoke_file_access_as_me, {
				...args,
				consentId: granted._yay.consentId,
			}),
			"removing consent must not ask for current read access",
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_consents", granted._yay.consentId))).toMatchObject({
			open: false,
			appliedLevel: null,
			state: "ended",
			areaEligible: false,
		});
	});

	test("does not revive consent when a workspace membership starts again", async () => {
		const f = await fixture();
		const args = { membershipId: f.grantOnly.membershipId, installationId: f.installationId };
		const granted = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			rootNodeId: f.nodes.grantedId,
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);
		await f.t.run(async (ctx) => {
			const membership = (await ctx.db.get("organizations_workspaces_users", args.membershipId))!;
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: true }]);
		});
		expect(
			(
				await f.asGrantOnly.query(api.plugins_access.list_my_file_grants, {
					...args,
					paginationOpts: { numItems: 20, cursor: null },
				})
			).page,
			"a new membership lifetime must not expose the old consent",
		).toEqual([]);
		expect(
			(
				await f.asGrantOnly.mutation(api.plugins_access.revoke_file_access_as_me, {
					...args,
					consentId: granted._yay.consentId,
				})
			)._nay?.message,
		).toBe("Not found");
	});

	test("pages every personal selection without dropping unreadable or ended items", async () => {
		const f = await fixture();
		const args = { membershipId: f.grantOnly.membershipId, installationId: f.installationId };
		const first = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			rootNodeId: f.nodes.grantedId,
			level: "read",
		});
		if (first._nay) throw new Error(first._nay.message);
		const other = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.grantedId,
			level: "read",
		});
		if (other._nay) throw new Error(other._nay.message);
		const expected = await f.t.run(async (ctx) => {
			const original = (await ctx.db.get("plugins_file_consents", first._yay.consentId))!;
			const unrelated = (await ctx.db.get("plugins_file_consents", other._yay.consentId))!;
			const ids = [original._id];
			for (let i = 0; i < 40; i++) {
				const rootNodeId = await insert_tree_node({
					ctx,
					owner: f.owner,
					parentId: "root",
					path: `/consent-${i}`,
					kind: "folder",
					scope: "self",
				});
				ids.push(
					await ctx.db.insert("plugins_file_consents", {
						organizationId: original.organizationId,
						workspaceId: original.workspaceId,
						pairId: original.pairId,
						rootNodeId,
						requestedLevel: "read",
						appliedLevel: null,
						areaEligible: false,
						open: i % 2 === 0,
						revision: 1,
						state: i % 2 === 0 ? "pending" : "ended",
						endedReason: i % 2 === 0 ? null : "Access ended.",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					}),
				);
				await ctx.db.insert("plugins_file_consents", {
					organizationId: unrelated.organizationId,
					workspaceId: unrelated.workspaceId,
					pairId: unrelated.pairId,
					rootNodeId,
					requestedLevel: "read",
					appliedLevel: "read",
					areaEligible: true,
					open: true,
					revision: 1,
					state: "applied",
					endedReason: null,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
			return ids;
		});
		const found: Id<"plugins_file_consents">[] = [];
		let cursor: string | null = null;
		for (const expectedLength of [20, 20, 1]) {
			const result = await f.asGrantOnly.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const page: FunctionReturnType<typeof api.plugins_access.list_my_file_grants> = await ctx.runQuery(
					api.plugins_access.list_my_file_grants,
					{
						...args,
						paginationOpts: { numItems: 20, cursor },
					},
				);
				return { page, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
			});
			const page: FunctionReturnType<typeof api.plugins_access.list_my_file_grants> = result.page;
			expect(page.page, "each page must keep unreadable and ended selections").toHaveLength(expectedLength);
			expect(result.cost.documentsRead, "a page must not read the other person's selections").toBeLessThan(50);
			found.push(...page.page.map((grant) => grant.consentId));
			cursor = page.continueCursor;
			expect(page.isDone).toBe(expectedLength === 1);
		}
		expect(found).toEqual(expected);
		expect(new Set(found).size).toBe(41);
	});
});
