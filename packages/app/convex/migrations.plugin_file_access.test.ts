import { afterEach, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import { activities_db_start } from "./activities_db.ts";
import { fixture, seed_tree } from "./files_archive_runs.setup.test.ts";
import { insert_installation } from "./files_share_links.setup.test.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { switch_plugin_file_access } from "./migrations.ts";
import { test_mocks, test_spy_handler } from "./setup.test.ts";
import { plugins_file_grants_db_ensure_pair } from "../server/plugins-file-grants.ts";

afterEach(() => vi.restoreAllMocks());

async function audited_installation() {
	const f = await fixture();
	const installationId = await insert_installation(f);
	const expected = await f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
		const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
		const membership = (await ctx.db.get("organizations_workspaces_users", f.db.membershipId))!;
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		const pair = await plugins_file_grants_db_ensure_pair(ctx, { installation, membership, membershipLifetime });
		const bindingId = await ctx.db.insert("plugins_service_account_bindings", {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			pluginName: version.name,
			publisherUserId: version.createdBy,
			sourceRepositoryUrl: version.sourceRepositoryUrl,
			serviceAccountId: installation.serviceAccountId,
		});
		const consentId = await ctx.db.insert("plugins_file_consents", {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			pairId: pair._id,
			rootNodeId: null,
			requestedLevel: "write",
			appliedLevel: "write",
			areaEligible: true,
			open: true,
			revision: 1,
			state: "applied",
			endedReason: null,
			createdAt: 1,
			updatedAt: 1,
		});
		return {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			pluginVersionId: installation.pluginVersionId,
			serviceAccountId: installation.serviceAccountId,
			installationUpdatedAt: installation.updatedAt,
			bindingId,
			pairId: pair._id,
			userId: membership.userId,
			membershipId: membership._id,
			membershipLifetime,
			consents: [{ consentId, consentRevision: 1, rootNodeId: null, level: "write" as const }],
		};
	});
	return { ...f, args: { installationId, expected } };
}

test("the access switch waits for every live run state without changing old credentials", async () => {
	const f = await audited_installation();
	const { installationId } = f.args;
	const { runId, activityId } = await f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
		const runId = await ctx.db.insert("plugins_event_runs", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			pluginVersionId: installation.pluginVersionId,
			serviceAccountId: installation.serviceAccountId,
			actorUserId: f.db.userId,
			event: "ui.invoke.requested",
			eventId: "personal-file-switch-test",
			acceptedCapabilities: [],
			apiCallCount: 0,
			outputWriteCount: 0,
		});
		const activityId = await activities_db_start(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			source: {
				kind: "plugin_run",
				id: runId,
				installationId,
				pluginName: installation.pluginName,
				event: "ui.invoke.requested",
			},
			title: "Personal file switch test",
			targets: [],
			visibility: "shared",
			feedVisible: false,
			status: "running",
			resultKind: "plugin_result",
			deadlineAt: Date.now() + 60 * 60 * 1000,
			now: Date.now(),
		});
		return { runId, activityId };
	});
	for (const status of ["queued", "running", "awaiting_input", "stopping"] as const) {
		await f.t.run((ctx) => ctx.db.patch("activities", activityId, { status }));
		expect(
			(await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args))._nay,
			`the switch waits for ${status} work`,
		).toBeDefined();
	}
	await f.t.run((ctx) => ctx.db.patch("activities", activityId, { status: "succeeded" }));
	expect(
		await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args),
		"settled runs allow the switch",
	).toEqual({ _yay: null });
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.fileAccessModel,
		"the switch selects personal consent",
	).toBe("personal");
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_event_runs", runId)))?.filePairId,
		"the switch never gives an old credential a new pair",
	).toBeUndefined();
});

test("the access switch refuses consent removed after the audit", async () => {
	const f = await audited_installation();
	expect(
		await f.asOwner.mutation(api.plugins_access.revoke_file_access_as_me, {
			membershipId: f.db.membershipId,
			installationId: f.args.installationId,
			consentId: f.args.expected.consents[0].consentId,
		}),
	).toEqual({ _yay: null });
	expect(
		(await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args))._nay?.message,
		"a revoke after the audit must stop the switch",
	).toBe("File consent changed. Audit it again before switching.");
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.args.installationId)))?.fileAccessModel,
		"refused consent must leave the old model in place",
	).toBeUndefined();
});

test.each([
	{ revision: 2 },
	{ requestedLevel: "read" as const },
	{ appliedLevel: "read" as const },
	{ state: "pending" as const },
	{ areaEligible: false },
])("the access switch refuses changed consent: %j", async (change) => {
	const f = await audited_installation();
	await f.t.run((ctx) => ctx.db.patch("plugins_file_consents", f.args.expected.consents[0].consentId, change));
	expect(
		(await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args))._nay?.message,
		"the switch must use the audited applied consent",
	).toBe("File consent changed. Audit it again before switching.");
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.args.installationId)))?.fileAccessModel,
	).toBeUndefined();
});

test.each(["applied", "revoked", "wrong_root"] as const)(
	"the access switch checks each workspace and folder choice: %s",
	async (change) => {
		const f = await audited_installation();
		const folder = await seed_tree(f, { name: "chosen", folderCount: 0, filesPerFolder: 0 });
		const otherFolder = await seed_tree(f, { name: "other", folderCount: 0, filesPerFolder: 0 });
		const workspaceChoice = f.args.expected.consents[0];
		const consentId = await f.t.run(async (ctx) => {
			const consent = (await ctx.db.get("plugins_file_consents", workspaceChoice.consentId))!;
			await ctx.db.patch("plugins_file_consents", consent._id, { requestedLevel: "read", appliedLevel: "read" });
			const { _id, _creationTime, ...fields } = consent;
			return await ctx.db.insert("plugins_file_consents", {
				...fields,
				rootNodeId: folder.topId,
				areaEligible: false,
			});
		});
		const args = {
			...f.args,
			expected: {
				...f.args.expected,
				consents: [
					{ ...workspaceChoice, level: "read" as const },
					{
						consentId,
						consentRevision: 1,
						rootNodeId: change === "wrong_root" ? otherFolder.topId : folder.topId,
						level: "write" as const,
					},
				],
			},
		};
		if (change === "revoked") {
			expect(
				await f.asOwner.mutation(api.plugins_access.revoke_file_access_as_me, {
					membershipId: f.db.membershipId,
					installationId: args.installationId,
					consentId,
				}),
			).toEqual({ _yay: null });
		}
		const before = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", args.installationId));
		const result = await f.t.mutation(internal.migrations.switch_plugin_file_access, args);
		const after = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", args.installationId));
		if (change === "applied") {
			expect(result, "workspace View and ordinary-folder Edit allow the switch together").toEqual({ _yay: null });
			expect(after, "mixed consent changes only the access marker").toEqual({ ...before, fileAccessModel: "personal" });
		} else {
			expect(result._nay?.message, `the switch must reject the second choice when ${change}`).toBe(
				"File consent changed. Audit it again before switching.",
			);
			expect(after, "a refused later choice must leave the full installation unchanged").toEqual(before);
		}
	},
);

test("the access switch refuses an empty consent audit", async () => {
	const f = await audited_installation();
	const before = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.args.installationId));
	expect(
		(
			await f.t.mutation(internal.migrations.switch_plugin_file_access, {
				...f.args,
				expected: { ...f.args.expected, consents: [] },
			})
		)._nay?.message,
		"an empty audit must not switch file access",
	).toBe("Choose file consent and audit it before switching.");
	expect(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.args.installationId))).toEqual(before);
});

test.each(["installation", "version", "account", "binding", "membership", "lifetime"] as const)(
	"the access switch refuses a changed %s after the audit",
	async (change) => {
		const f = await audited_installation();
		const { expected, installationId } = f.args;
		await f.t.run(async (ctx) => {
			switch (change) {
				case "installation":
					await ctx.db.patch("plugins_workspace_installations", installationId, {
						updatedAt: expected.installationUpdatedAt + 1,
					});
					break;
				case "version": {
					const version = (await ctx.db.get("plugins_versions", expected.pluginVersionId))!;
					const { _id, _creationTime, ...fields } = version;
					const pluginVersionId = await ctx.db.insert("plugins_versions", { ...fields, version: "2.0.0" });
					await ctx.db.patch("plugins_workspace_installations", installationId, { pluginVersionId });
					break;
				}
				case "account":
					await ctx.db.patch("access_control_service_accounts", expected.serviceAccountId, { revokedAt: Date.now() });
					break;
				case "binding":
					await ctx.db.patch("plugins_service_account_bindings", expected.bindingId, {
						sourceRepositoryUrl: "https://github.test/other/chat",
					});
					break;
				case "membership":
					await ctx.db.patch("organizations_workspaces_users", expected.membershipId, { active: false });
					break;
				case "lifetime": {
					const lifetime = await ctx.db
						.query("organizations_membership_lifetimes")
						.withIndex("by_workspace_user", (q) =>
							q.eq("workspaceId", expected.workspaceId).eq("userId", expected.userId),
						)
						.first();
					await ctx.db.patch("organizations_membership_lifetimes", lifetime!._id, { lifetime: 2 });
					break;
				}
			}
		});
		const before = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId));
		expect(
			(await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args))._nay,
			`the switch must reject the changed ${change}`,
		).toBeDefined();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId))).toEqual(before);
	},
);

test("the access switch waits for a text write started after the audit", async () => {
	const f = await audited_installation();
	const stageId = await f.t.run(async (ctx) => {
		const asset = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			r2Bucket: "test-bucket",
			size: 12,
			createdBy: f.db.userId,
			updatedAt: 1,
		};
		return await ctx.db.insert("public_api_file_write_stages", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			force: false,
			requestReadOnly: false,
			path: "/pending.md",
			overwrite: "fail",
			contentType: "text/markdown",
			yjsRootKind: "rich_text",
			yjsSnapshotAssetId: await ctx.db.insert("files_r2_assets", { ...asset, kind: "yjs_snapshot" }),
			contentSnapshotAssetId: await ctx.db.insert("files_r2_assets", { ...asset, kind: "content_snapshot" }),
			expiresAt: Date.now() + 60_000,
			updatedAt: 1,
		});
	});
	expect(
		(await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args))._nay?.message,
		"a new text stage must stop the switch",
	).toBe("Wait for this workspace's text writes to finish, then try again.");
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.args.installationId)))?.fileAccessModel,
	).toBeUndefined();
	await f.t.run((ctx) => ctx.db.delete("public_api_file_write_stages", stageId));
	const before = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.args.installationId));
	for (let attempt = 0; attempt < 2; attempt++) {
		expect(await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args)).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.args.installationId))).toEqual({
			...before,
			fileAccessModel: "personal",
		});
	}
});

test("the access switch finds pending uploads without reading settled history", async () => {
	const f = await audited_installation();
	const otherInstallationId = await insert_installation(f);
	const { installationId } = f.args;
	const add_target = (name: string, state: "pending" | "committed" | "released", ownInstallationId = installationId) =>
		f.t.run(async (ctx) => {
			const tenant = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId };
			const installation = (await ctx.db.get("plugins_workspace_installations", ownInstallationId))!;
			const assetId = await ctx.db.insert("files_r2_assets", {
				...tenant,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 12,
				createdBy: f.db.userId,
				updatedAt: 1,
			});
			const destinationNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				...tenant,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				path: `/${name}`,
				name,
			});
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				...tenant,
				kind: "file",
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: destinationNodeId,
				path: `/${name}/image.png`,
				name: "image.png",
				assetId,
			});
			return await ctx.db.insert("plugin_service_storage_targets", {
				...tenant,
				installationId: ownInstallationId,
				serviceAccountId: installation.serviceAccountId,
				idempotencyKey: name,
				targetKey: name,
				requestFingerprint: name,
				force: false,
				readOnly: false,
				nonCollaborative: false,
				destinationPath: `/${name}`,
				destinationNodeId,
				destinationEpoch: 1,
				path: `/${name}/image.png`,
				contentType: "image/png",
				declaredBytes: 12,
				actualBytes: state === "pending" ? null : 12,
				chargedBytes: state === "pending" ? 0 : 12,
				nodeId,
				assetId,
				state,
				createdBy: f.db.userId,
				updatedAt: 1,
			});
		});
	const pendingId = await add_target("zz-pending", "pending");
	const costs: ReturnType<typeof transaction_cost>[] = [];
	test_spy_handler(switch_plugin_file_access, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		costs.push(transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});
	const measure = async () => {
		const result = await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args);
		return { result, cost: costs.at(-1)! };
	};
	const small = await measure();
	expect(small.cost.documentsRead, "the switch cost must include its reads").toBeGreaterThan(0);
	expect(small.result._nay?.message, "a new upload must stop the switch").toBe(
		"Wait for this plugin's uploads to finish, then try again.",
	);
	for (let index = 0; index < 65; index++) {
		await add_target(`settled-${index}`, index % 2 === 0 ? "committed" : "released");
	}
	const large = await measure();
	expect(large.result).toEqual(small.result);
	expect(large.cost.documentsRead, "settled upload history must add no switch reads").toBe(small.cost.documentsRead);
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.fileAccessModel,
	).toBeUndefined();
	await f.t.run((ctx) => ctx.db.patch("plugin_service_storage_targets", pendingId, { state: "released" }));
	await add_target("other-pending", "pending", otherInstallationId);
	const settled = await f.t.run((ctx) => ctx.db.get("plugin_service_storage_targets", pendingId));
	expect(
		await f.t.mutation(internal.migrations.switch_plugin_file_access, f.args),
		"settled targets and another plugin's upload must allow the switch",
	).toEqual({ _yay: null });
	expect(await f.t.run((ctx) => ctx.db.get("plugin_service_storage_targets", pendingId))).toEqual(settled);
});
