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

	test.each(["read", "write"] as const)("refuses a new %s choice in Trash without changing consent", async (level) => {
		const f = await fixture();
		const before = await f.t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", f.nodes.archivedFolderId),
			pairs: await ctx.db.query("plugins_file_pairs").collect(),
			consents: await ctx.db.query("plugins_file_consents").collect(),
			ops: await ctx.db.query("files_subtree_ops").collect(),
		}));
		const granted = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			rootNodeId: f.nodes.archivedFolderId,
			level,
		});
		expect(granted._nay?.message, "a Trash choice must ask the person to restore it first").toBe(
			`${before.node!.path} is in Trash. Restore it before you choose it for a plugin.`,
		);
		expect(
			await f.t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", f.nodes.archivedFolderId),
				pairs: await ctx.db.query("plugins_file_pairs").collect(),
				consents: await ctx.db.query("plugins_file_consents").collect(),
				ops: await ctx.db.query("files_subtree_ops").collect(),
			})),
			"a refused Trash choice must change no file, pair, consent or scope job",
		).toEqual(before);
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

	test("workspace consent needs the person's workspace Read and Edit", async () => {
		const f = await fixture();
		const args = {
			membershipId: f.grantOnly.membershipId,
			installationId: f.installationId,
			rootNodeId: null,
		};
		expect(
			(await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "read" }))._nay
				?.message,
			"a folder-only reader cannot grant the whole workspace",
		).toBe("You cannot read this item. Ask for Can view access first.");
		await f.t.run((ctx) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				resourceKind: "workspace",
				resourceId: f.owner.workspaceId,
				principalKind: "user",
				userId: f.grantOnly.userId,
				permission: "content.read",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const granted = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			level: "read",
		});
		expect(granted._yay, "a workspace reader can choose workspace View").toBeDefined();
		await f.reset(f.grantOnly.userId);
		expect(
			(await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "write" }))._nay
				?.message,
			"workspace View cannot become Edit without human Write",
		).toBe("You cannot edit /. Ask for Can edit access first.");
	});

	test("refuses a new choice past the per-plugin limit but still changes an existing one", async () => {
		const f = await fixture();
		const args = { membershipId: f.owner.membershipId, installationId: f.installationId };
		const first = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			rootNodeId: null,
			level: "read",
		});
		if (first._nay) throw new Error(first._nay.message);
		await f.t.run(async (ctx) => {
			const { _id, _creationTime, ...template } = (await ctx.db.get("plugins_file_consents", first._yay.consentId))!;
			for (let index = 1; index < 100; index++) {
				await ctx.db.insert("plugins_file_consents", { ...template, rootNodeId: f.nodes.openId });
			}
		});
		await f.reset(f.owner.userId);
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
					...args,
					rootNodeId: f.nodes.grantedId,
					level: "read",
				})
			)._nay?.message,
			"the 101st open choice is refused",
		).toBe(
			"You already chose 100 files and folders for file-consent, which is the most you can choose. Remove one, or choose a folder above them or the whole workspace.",
		);
		await f.reset(f.owner.userId);
		expect(
			await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
				...args,
				rootNodeId: null,
				level: "write",
			}),
			"changing the level of an existing choice is not a new choice",
		).toEqual(first);
	});

	test("workspace choices keep their target, applied access and ended history", async () => {
		const f = await fixture();
		const args = { membershipId: f.owner.membershipId, installationId: f.installationId, rootNodeId: null };
		const first = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "write" });
		expect(first._yay, "workspace Edit creates pending consent").toBeDefined();
		if (first._nay) throw new Error(first._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_consents", first._yay.consentId))).toMatchObject({
			rootNodeId: null,
			requestedLevel: "write",
			appliedLevel: null,
			areaEligible: false,
			state: "pending",
		});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await f.t.run((ctx) => ctx.db.get("plugins_file_consents", first._yay.consentId)),
			"the worker applies workspace Edit and its Trash area",
		).toMatchObject({ appliedLevel: "write", areaEligible: true, state: "applied" });
		expect(await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "read" })).toEqual(
			first,
		);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_consents", first._yay.consentId))).toMatchObject({
			rootNodeId: null,
			requestedLevel: "read",
			appliedLevel: "write",
			state: "pending",
		});
		await f.reset(f.owner.userId);
		const saved = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			rootNodeId: f.nodes.grantedId,
			level: "read",
		});
		expect(saved._yay?.consentId, "a saved target must not replace workspace consent").not.toBe(first._yay.consentId);
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		await expect(
			f.asOwner.mutation(api.plugins_access.revoke_file_access_as_me, {
				membershipId: args.membershipId,
				installationId: args.installationId,
				consentId: first._yay.consentId,
			}),
			"workspace consent can be removed without a saved anchor",
		).resolves.toEqual({ _yay: null });
		const fresh = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "read" });
		expect(fresh._yay?.consentId, "workspace regrant creates a new consent").not.toBe(first._yay.consentId);
		const history = await f.asOwner.query(api.plugins_access.list_my_file_grants, {
			membershipId: args.membershipId,
			installationId: args.installationId,
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(history.page, "workspace history preserves the ended choice and separate saved grant").toMatchObject([
			{ consentId: first._yay.consentId, rootNodeId: null, path: "/", open: false, appliedLevel: null },
			{ consentId: saved._yay!.consentId, rootNodeId: f.nodes.grantedId, open: true, appliedLevel: "read" },
			{ consentId: fresh._yay!.consentId, rootNodeId: null, path: "/", state: "pending" },
		]);
	});

	test("workspace consent stays with its person, installation, tenant and membership lifetime", async () => {
		const f = await fixture();
		const args = { membershipId: f.owner.membershipId, installationId: f.installationId, rootNodeId: null };
		const granted = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "read" });
		if (granted._nay) throw new Error(granted._nay.message);
		expect(
			(await f.asAdmin.mutation(api.plugins_access.grant_file_access_as_me, { ...args, level: "read" }))._nay?.message,
			"another person cannot choose workspace consent for the owner",
		).toBe("Unauthorized");
		expect(
			(
				await f.asAdmin.mutation(api.plugins_access.revoke_file_access_as_me, {
					membershipId: f.admin.membershipId,
					installationId: args.installationId,
					consentId: granted._yay.consentId,
				})
			)._nay?.message,
			"another person cannot remove workspace consent",
		).toBe("Not found");
		for (const [actor, membershipId, installationId] of [
			[f.asAdmin, f.admin.membershipId, f.installationId],
			[f.asOwner, f.owner.membershipId, f.otherInstallationId],
		] as const) {
			expect(
				(
					await actor.query(api.plugins_access.list_my_file_grants, {
						membershipId,
						installationId,
						paginationOpts: { numItems: 20, cursor: null },
					})
				).page,
				"workspace consent belongs only to its pair",
			).toEqual([]);
		}
		const foreignInstallationId = await f.t.run(async (ctx) => {
			const foreign = (await ctx.db.get("files_nodes", f.nodes.foreignFolderId))!;
			const { _id, _creationTime, ...installation } = (await ctx.db.get(
				"plugins_workspace_installations",
				f.installationId,
			))!;
			return await ctx.db.insert("plugins_workspace_installations", {
				...installation,
				organizationId: ctx.db.normalizeId("organizations", foreign.organizationId)!,
				workspaceId: ctx.db.normalizeId("organizations_workspaces", foreign.workspaceId)!,
			});
		});
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
					...args,
					installationId: foreignInstallationId,
					level: "read",
				})
			)._nay?.message,
			"null targets still require a same-tenant installation",
		).toBe("Not found");
		await f.t.run(async (ctx) => {
			const membership = (await ctx.db.get("organizations_workspaces_users", args.membershipId))!;
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: true }]);
		});
		expect(
			(
				await f.asOwner.query(api.plugins_access.list_my_file_grants, {
					membershipId: args.membershipId,
					installationId: args.installationId,
					paginationOpts: { numItems: 20, cursor: null },
				})
			).page,
			"membership rejoin does not restore old workspace consent",
		).toEqual([]);
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
		expect(
			(
				await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
					...args,
					membershipId: f.grantOnly.membershipId,
				})
			)._nay?.message,
			"an unreadable upload must not reveal its path or upload state",
		).toBe("You cannot read this item. Ask for Can view access first.");
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
			await ctx.db.patch("files_nodes", f.nodes.hiddenId, { purgeRunId: run._id });
		});
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					rootNodeId: f.nodes.hiddenId,
					level: "read",
				})
			)._nay?.message,
			"a deleting node cannot gain new personal consent",
		).toContain("is being deleted");
		expect(
			(
				await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
					membershipId: f.grantOnly.membershipId,
					installationId: f.installationId,
					rootNodeId: f.nodes.hiddenId,
					level: "read",
				})
			)._nay?.message,
			"an unreadable deleting item must not reveal its path or deletion state",
		).toBe("You cannot read this item. Ask for Can view access first.");
	});

	test("keeps ended consent without revealing later names inside a locked folder", async () => {
		const f = await fixture();
		const args = { membershipId: f.grantOnly.membershipId, installationId: f.installationId };
		const granted = await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			rootNodeId: f.nodes.grantedFileId,
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		const list = () =>
			f.asGrantOnly.query(api.plugins_access.list_my_file_grants, {
				...args,
				paginationOpts: { numItems: 20, cursor: null },
			});
		expect((await list()).page[0]).toMatchObject({
			path: "/top/hidden/granted/doc.md",
			kind: "file",
			state: "applied",
		});
		expect(
			await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, {
				membershipId: f.owner.membershipId,
				nodeId: f.nodes.grantedId,
				principal: { kind: "user", userId: f.grantOnly.userId },
			}),
		).toEqual({ _yay: null });
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await list()).page[0]).toMatchObject({ state: "ended", appliedLevel: null });
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.rename_node, {
					membershipId: f.owner.membershipId,
					requestId: crypto.randomUUID(),
					nodeId: f.nodes.grantedFileId,
					path: "private-name.md",
				})
			)._nay,
		).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodes.grantedFileId)))?.path).toBe(
			"/top/hidden/granted/private-name.md",
		);
		expect((await list()).page, "ended consent must keep its history without current file details").toMatchObject([
			{ consentId: granted._yay.consentId, path: null, kind: null, state: "ended" },
		]);
		expect(
			(
				await f.asGrantOnly.mutation(api.plugins_access.grant_file_access_as_me, {
					...args,
					rootNodeId: f.nodes.grantedFileId,
					level: "read",
				})
			)._nay?.message,
			"a refused grant must not reveal a renamed file inside a locked folder",
		).toBe("You cannot read this item. Ask for Can view access first.");
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

	test.each([false, true])("removing consent keeps only a frozen anchor (Trash: %s)", async (inTrash) => {
		const f = await fixture();
		const args = { membershipId: f.owner.membershipId, installationId: f.installationId };
		const selected = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
			...args,
			rootNodeId: f.nodes.openSubId,
			level: "read",
		});
		if (selected._nay) throw new Error(selected._nay.message);
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		if (inTrash) {
			expect(
				(
					await f.asOwner.mutation(api.files_nodes.archive_nodes, {
						membershipId: args.membershipId,
						nodeIds: [String(f.nodes.openSubId)],
					})
				)._nay,
			).toBeUndefined();
			await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		}
		const before = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodes.openSubId));
		expect(before).toMatchObject({ extendedScopeNodeId: f.nodes.openSubId, parentExtendedScopeNodeId: null });
		expect(
			await f.asOwner.mutation(api.plugins_access.revoke_file_access_as_me, {
				...args,
				consentId: selected._yay.consentId,
			}),
		).toEqual({ _yay: null });
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_consents", selected._yay.consentId))).toMatchObject({
			open: false,
			appliedLevel: null,
			state: "ended",
		});
		const after = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodes.openSubId));
		if (inTrash) {
			expect(after, "removing consent must keep the Trash item's frozen pointers").toEqual(before);
		} else {
			expect(after?.parentExtendedScopeNodeId, "an empty live anchor still retires").toBeUndefined();
			expect(after?.extendedScopeNodeId).toBeNull();
		}
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
				const rootNodeId =
					i === 20 || i === 21
						? null
						: await insert_tree_node({
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
					rootNodeId: i === 21 ? f.nodes.openId : rootNodeId,
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
		let workspaceChoices = 0;
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
			for (const grant of page.page) {
				if (grant.rootNodeId !== null) continue;
				workspaceChoices++;
				expect(grant.path, "open and ended workspace choices keep their label").toBe("/");
			}
			cursor = page.continueCursor;
			expect(page.isDone).toBe(expectedLength === 1);
		}
		expect(found).toEqual(expected);
		expect(new Set(found).size).toBe(41);
		expect(workspaceChoices, "mixed history pages include open and ended workspace choices").toBe(2);
	});
});
