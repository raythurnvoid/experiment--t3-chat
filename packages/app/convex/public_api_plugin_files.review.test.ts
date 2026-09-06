import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

describe("ensure_plugin_folder", () => {
	test("rechecks workspace write permission on an unrestricted ancestor during a live invoke", async () => {
		const t = test_convex();
		const fixture = await t.run(async (ctx) => {
			const now = Date.now();
			const owner = await test_mocks_fill_db_with.membership(ctx, { workspaceName: "home" });
			const userId = await ctx.db.insert("users", { clerkUserId: "ensure-review-member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			const capabilities: plugins_Capability[] = ["plugin.backend.invoke", "workspace.files.write", "workspace.files.own-write"];
			// The publication pipeline is outside this permission test.
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "probe",
				displayName: "Probe",
				version: "0.1.0",
				description: "Folder permission probe",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/probe-plugin",
				sourceOwner: "bonobo",
				sourceRepo: "probe-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/probe/manifest.json",
				backendEntrypointFile: {
					entry: "dist/backend/worker.js",
					moduleName: "plugin.js",
					r2Key: "plugins/probe/backend/worker.js",
					sha256: `sha256:${"b".repeat(64)}`,
					compatibilityDate: "2026-07-01",
					compatibilityFlags: ["nodejs_compat"],
				},
				configuration: null,
				events: [],
				capabilities,
				pages: [],
				fileViews: [],
				endpoints: [{ id: "echo", path: "/echo", serialization: "installation" }],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: owner.userId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				pluginVersionId,
				pluginName: "probe",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: capabilities,
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: owner.userId,
				updatedBy: owner.userId,
				updatedAt: now,
			});
			const parentId = await ctx.db.insert("files_nodes", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				parentId: files_ROOT_ID,
				name: "tagged",
				path: "/tagged",
				treePath: "/tagged/",
				pathDepth: 1,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: owner.userId,
				updatedBy: owner.userId,
				updatedAt: now,
			});
			return { owner, userId, membershipId, pluginVersionId, installationId, parentId };
		});
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			subject: `clerk-${fixture.owner.userId}`,
			external_id: fixture.owner.userId,
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "ensure-review-member",
			external_id: fixture.userId,
		});
		expect(
			await asMember.mutation(api.files_metadata.set_entries, {
				membershipId: fixture.membershipId,
				fileNodeId: fixture.parentId,
				metadataYaml: "plugin-name: probe",
			}),
		).toEqual({ _yay: null });
		const apiToken = `plr_${"d".repeat(64)}`;
		const started = await t.mutation(internal.plugins_runtime.start_invoke_run, {
			organizationId: fixture.owner.organizationId,
			workspaceId: fixture.owner.workspaceId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			userId: fixture.userId,
			endpointId: "echo",
			callerSerializationKey: null,
			apiTokenHash: await crypto_sha256_hex(apiToken),
		});
		if (started._nay) throw new Error(started._nay.message);

		expect(
			await asOwner.mutation(api.access_control.set_user_role, {
				organizationId: fixture.owner.organizationId,
				workspaceId: fixture.owner.workspaceId,
				userId: fixture.userId,
				role: "viewer",
			}),
		).toEqual({ _yay: null });
		const before = await t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			metadata: await ctx.db.query("files_metadata_docs").collect(),
		}));
		expect(before.nodes).toEqual([
			expect.objectContaining({ _id: fixture.parentId, path: "/tagged" }),
		]);
		expect(before.nodes[0]!.restrictedScopeNodeId).toBeUndefined();
		expect(before.nodes[0]!.readOnlyScopeNodeId).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("organizations_workspaces_users", fixture.membershipId))).toMatchObject({
			active: true,
		});
		expect(await t.run((ctx) => ctx.db.get("plugins_event_runs", started._yay.pluginRun._id))).toMatchObject({
			status: "running",
			actorUserId: fixture.userId,
		});
		const request = {
			method: "POST",
			headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/tagged/new" }),
		};
		const refused = await t.fetch("/api/v1/files/plugin-folders/ensure", request);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: "Permission denied" });
		expect(
			await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				metadata: await ctx.db.query("files_metadata_docs").collect(),
			})),
		).toEqual(before);

		expect(
			await asOwner.mutation(api.access_control.set_user_role, {
				organizationId: fixture.owner.organizationId,
				workspaceId: fixture.owner.workspaceId,
				userId: fixture.userId,
				role: "member",
			}),
		).toEqual({ _yay: null });
		const accepted = await t.fetch("/api/v1/files/plugin-folders/ensure", request);
		expect(accepted.status).toBe(200);
		const created = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.owner.organizationId)
						.eq("workspaceId", fixture.owner.workspaceId)
						.eq("path", "/tagged/new")
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		expect(created).toMatchObject({ parentId: fixture.parentId, kind: "folder", createdBy: fixture.userId });
		expect(await accepted.json()).toEqual({ nodeId: created!._id, path: "/tagged/new", created: true });
	});
});
