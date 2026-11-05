import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import { activities_db_start } from "./activities_db.ts";
import { fixture, folder } from "./files_archive_runs.setup.test.ts";
import { insert_installation, mock_share_storage } from "./files_share_links.setup.test.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { test_create_saved_text_file, test_finish_file_index, test_finish_saved_scope_jobs } from "./setup.test.ts";
import { plugins_file_grants_db_ensure_pair } from "../server/plugins-file-grants.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";

beforeEach(mock_share_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function setup(personal = true) {
	const f = await fixture();
	const installationId = await insert_installation(f);
	const token = `plr_${"a".repeat(64)}`;
	const rootNodeId = await folder(f, "/output");
	const sourceNodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/output/source.md",
		textContent: "Source",
	});
	const data = await f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
		const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
		const capabilities = ["workspace.files.read", "workspace.files.write", "workspace.files.own-write"] as const;
		await ctx.db.patch("plugins_workspace_installations", installationId, {
			fileAccessModel: personal ? "personal" : undefined,
			acceptedCapabilities: [...capabilities],
		});
		await ctx.db.insert("plugins_service_account_bindings", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			serviceAccountId: installation.serviceAccountId,
			pluginName: installation.pluginName,
			publisherUserId: version.createdBy,
			sourceRepositoryUrl: version.sourceRepositoryUrl,
		});
		const membership = (await ctx.db.get("organizations_workspaces_users", f.db.membershipId))!;
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		const pair = await plugins_file_grants_db_ensure_pair(ctx, { installation, membership, membershipLifetime });
		const runId = await ctx.db.insert("plugins_event_runs", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			pluginVersionId: version._id,
			serviceAccountId: installation.serviceAccountId,
			filePairId: personal ? pair._id : undefined,
			actorUserId: f.db.userId,
			event: "ui.invoke.requested",
			eventId: "personal-file-test",
			fileNodeId: sourceNodeId,
			apiTokenHash: await crypto_sha256_hex(token),
			apiTokenExpiresAt: Date.now() + 60 * 60 * 1000,
			acceptedCapabilities: [...capabilities],
			apiCallCount: 0,
			outputWriteCount: 0,
		});
		await activities_db_start(ctx, {
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
			title: "Personal file test",
			targets: [],
			visibility: "shared",
			feedVisible: false,
			status: "running",
			resultKind: "plugin_result",
			deadlineAt: Date.now() + 60 * 60 * 1000,
			now: Date.now(),
		});
		const callId = await ctx.db.insert("plugins_event_run_calls", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			runId,
			installationId,
			pluginVersionId: version._id,
			sequence: 1,
			kind: "api_request",
			route: "/api/v1/files/write",
			status: "started",
			errorMessage: null,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		return { pairId: pair._id, runId, callId, serviceAccountId: installation.serviceAccountId };
	});
	expect(
		(
			await f.asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: f.db.membershipId,
				fileNodeId: rootNodeId,
				metadataYaml: "plugin-name: chat",
			})
		)._nay,
	).toBeUndefined();
	await test_finish_file_index(f.t, rootNodeId);
	if (!personal)
		expect(
			(
				await f.asOwner.mutation(api.access_control.set_service_account_grant, {
					membershipId: f.db.membershipId,
					serviceAccountId: data.serviceAccountId,
					resource: { kind: "workspace" },
					level: "write",
				})
			)._nay,
		).toBeUndefined();
	const select = async (nodeId = rootNodeId) => {
		const result = await f.asOwner.mutation(api.plugins_access.grant_file_access_as_me, {
			membershipId: f.db.membershipId,
			installationId,
			rootNodeId: nodeId,
			level: "write",
		});
		if (result._nay) throw new Error(result._nay.message);
		while (true) {
			await test_finish_saved_scope_jobs(f.t);
			const job = await f.t.run((ctx) => ctx.db.query("plugins_file_grant_jobs").first());
			if (!job) break;
			await f.t.mutation(internal.plugins_file_grants.advance, { jobId: job._id, step: job.step, phase: job.phase });
		}
		return result._yay.consentId;
	};
	const prepare = (path = "/output/new.md") =>
		f.t.mutation(internal.public_api.prepare_file_write, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			principalRef: { kind: "plugin_run", runId: data.runId, callId: data.callId },
			path,
			overwrite: "fail",
			contentSize: 4,
			yjsSnapshotSize: 4,
			contentType: "text/markdown",
			yjsRootKind: "rich_text",
		});
	return { ...f, ...data, installationId, rootNodeId, sourceNodeId, token, select, prepare };
}

test("uses applied personal write consent without the owner's workspace or account shortcut", async () => {
	const f = await setup();
	expect(
		(
			await f.asOwner.mutation(api.access_control.set_service_account_grant, {
				membershipId: f.db.membershipId,
				serviceAccountId: f.serviceAccountId,
				resource: { kind: "workspace" },
				level: "write",
			})
		)._nay,
	).toBeUndefined();
	expect((await f.prepare())._nay?.message, "an owner token without personal consent cannot write").toBe(
		"Permission denied",
	);
	expect(
		(
			await f.asOwner.mutation(api.access_control.remove_service_account_grant, {
				membershipId: f.db.membershipId,
				serviceAccountId: f.serviceAccountId,
				resource: { kind: "workspace" },
			})
		)._nay,
	).toBeUndefined();
	const consentId = await f.select();
	const prepared = await f.prepare();
	expect(prepared._nay, "selected output allows writes without account grants").toBeUndefined();
	if (prepared._nay) throw new Error(prepared._nay.message);
	expect(
		(await f.t.run((ctx) => ctx.db.get("public_api_file_write_stages", prepared._yay.stageId)))?.filePairId,
		"accepted work keeps its credential pair",
	).toBe(f.pairId);
	expect((await f.prepare("/unselected.md"))._nay?.message, "personal consent stays inside its selected root").toBe(
		"Permission denied",
	);
	await f.t.run((ctx) => ctx.db.patch("plugins_file_consents", consentId, { appliedLevel: "read" }));
	const published = await f.t.mutation(internal.public_api.publish_file_write, {
		stageId: prepared._yay.stageId,
		content: "Text",
		targetAnchor: prepared._yay.targetAnchor,
		nonCollaborative: true,
		addedFileRefs: [],
	});
	expect(published._nay?.message, "publication rechecks the applied grant").toBe("Permission denied");
});

test("lets accepted legacy work finish but refuses new work after the switch", async () => {
	const f = await setup(false);
	const prepared = await f.prepare();
	if (prepared._nay) throw new Error(prepared._nay.message);
	await f.t.run((ctx) =>
		ctx.db.patch("plugins_workspace_installations", f.installationId, { fileAccessModel: "personal" }),
	);
	expect(
		(await f.prepare("/output/later.md"))._nay?.message,
		"old credentials cannot accept new writes after the switch",
	).toBe("Permission denied");
	const published = await f.t.mutation(internal.public_api.publish_file_write, {
		stageId: prepared._yay.stageId,
		content: "Text",
		targetAnchor: prepared._yay.targetAnchor,
		nonCollaborative: true,
		addedFileRefs: [],
	});
	expect(published._nay, "an accepted legacy write can still publish").toBeUndefined();
});

test("rejects a changed stage pair and never replaces an old membership pin", async () => {
	const f = await setup();
	await f.select();
	const prepared = await f.prepare();
	if (prepared._nay) throw new Error(prepared._nay.message);
	await f.t.run((ctx) =>
		ctx.db.patch("public_api_file_write_stages", prepared._yay.stageId, { filePairId: undefined }),
	);
	expect(
		(
			await f.t.mutation(internal.public_api.publish_file_write, {
				stageId: prepared._yay.stageId,
				content: "Text",
				targetAnchor: prepared._yay.targetAnchor,
				nonCollaborative: true,
				addedFileRefs: [],
			})
		)._nay?.message,
		"publication requires the original pair",
	).toBe("Permission denied");
	await f.t.run(async (ctx) => {
		const lifetime = await ctx.db
			.query("organizations_membership_lifetimes")
			.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.db.workspaceId).eq("userId", f.db.userId))
			.first();
		await ctx.db.patch("organizations_membership_lifetimes", lifetime!._id, { lifetime: lifetime!.lifetime + 1 });
	});
	expect(
		(await f.t.query(internal.public_api.resolve_principal, { presented: f.token }))._nay?.message,
		"a token cannot follow a replacement membership",
	).toBe("Unauthenticated");
});

test("a selected source file does not let an upload run write siblings", async () => {
	const f = await setup();
	await f.select(f.sourceNodeId);
	await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", f.runId, { event: "files.upload.completed" }));
	expect((await f.prepare())._nay?.message, "source-only consent cannot create a sibling").toBe("Permission denied");
	await f.select();
	expect((await f.prepare())._nay, "parent consent allows the sibling").toBeUndefined();
});

test("publishes readable media with the stage's personal consent", async () => {
	const f = await setup();
	await f.select();
	const prepared = await f.prepare();
	if (prepared._nay) throw new Error(prepared._nay.message);
	const ref = `bonobo-file://${f.sourceNodeId}`;
	const published = await f.t.mutation(internal.public_api.publish_file_write, {
		stageId: prepared._yay.stageId,
		content: `[Source](${ref})`,
		targetAnchor: prepared._yay.targetAnchor,
		nonCollaborative: true,
		addedFileRefs: [ref],
	});
	expect(published._nay, "publication passes the stage pair to media read checks").toBeUndefined();
});
