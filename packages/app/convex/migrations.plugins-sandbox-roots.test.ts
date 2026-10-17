import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import {
	mock_plugins_review,
	user_identity,
	register_media_plugin,
	media_plugin_consent,
} from "./plugins.setup.test.ts";

beforeEach(() => {
	mock_plugins_review();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/**
 * One installation from before the backfill: its account holds a workspace grant, a folder grant and
 * a grant on its own output folder, and the installation has no `sandbox` field.
 */
async function fixture() {
	const t = test_convex({ transactionLimits: true });
	t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const version = await register_media_plugin({ t, userId: membership.userId, events: [] });
	const asOwner = t.withIdentity(user_identity(membership.userId));
	const folder = async (path: string) => {
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: membership.membershipId,
			parentId: files_ROOT_ID,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const reports = await folder("reports");
	const output = await folder("transcripts");
	const installed = await asOwner.mutation(api.plugins.install_version, {
		membershipId: membership.membershipId,
		pluginVersionId: version.pluginVersionId,
		...media_plugin_consent,
		serviceAccountGrants: [
			{ resource: { kind: "workspace" }, level: "write" },
			{ resource: { kind: "file", nodeId: reports }, level: "read" },
			{ resource: { kind: "file", nodeId: output }, level: "manage" },
		],
	});
	if (installed._nay) throw new Error(installed._nay.message);
	const installationId = installed._yay.installationId;
	await t.run(async (ctx) => {
		const writerId = await ctx.db.insert("plugins_external_file_writers", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId,
			resourceKey: "transcripts",
			rootNodeId: output,
			folderNodeId: output,
			rootPath: "/transcripts",
			path: "/transcripts",
			generation: 1,
			updatedAt: Date.now(),
		});
		await ctx.db.insert("plugins_external_file_bindings", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId,
			writerId,
			nodeId: output,
			revision: 1,
			detachedAt: null,
			updatedAt: Date.now(),
		});
		await ctx.db.patch("plugins_workspace_installations", installationId, { sandbox: undefined });
	});
	return { t, installationId, reports, output };
}

async function audit(t: ReturnType<typeof test_convex>) {
	const installations = [];
	for (let cursor: string | null = null, done = false; !done;) {
		const page: FunctionReturnType<typeof internal.migrations.audit_plugins_sandbox_roots_page> = await t.query(
			internal.migrations.audit_plugins_sandbox_roots_page,
			{ cursor },
		);
		installations.push(...page.page);
		cursor = page.continueCursor;
		done = page.isDone;
	}
	const grants = [];
	for (let cursor: string | null = null, done = false; !done;) {
		const page: FunctionReturnType<typeof internal.migrations.audit_plugins_sandbox_grants_page> = await t.query(
			internal.migrations.audit_plugins_sandbox_grants_page,
			{ cursor },
		);
		grants.push(...page.page);
		cursor = page.continueCursor;
		done = page.isDone;
	}
	return { installations, missing: grants.flatMap((grant) => grant.missingIn) };
}

test("the backfill builds roots from account grants and skips the plugin output folder", async () => {
	const { t, installationId, reports } = await fixture();

	const status = await t.action((ctx) =>
		runToCompletion(ctx, components.migrations, internal.migrations.backfill_plugins_sandbox_roots),
	);
	expect(status.isDone).toBe(true);
	await t.finishAllScheduledFunctions(() => vi.runAllTimers());

	expect((await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.sandbox).toEqual({
		roots: expect.arrayContaining([
			{ target: { kind: "open" }, level: "write" },
			{ target: { kind: "folder", nodeId: reports }, level: "read" },
		]),
		rebuild: null,
	});
	expect(await audit(t)).toEqual({
		installations: [expect.objectContaining({ installationId, rebuildStatus: "ready", rootCount: 2, wrongRoots: [] })],
		missing: [],
	});
});

test("the audit reports a missing root and a root with the wrong level", async () => {
	const { t, installationId, reports } = await fixture();
	await t.run((ctx) =>
		ctx.db.patch("plugins_workspace_installations", installationId, {
			sandbox: { roots: [{ target: { kind: "folder", nodeId: reports }, level: "manage" }], rebuild: null },
		}),
	);

	const result = await audit(t);

	expect(result.installations).toEqual([expect.objectContaining({ rebuildStatus: "ready", wrongRoots: [reports] })]);
	// The workspace grant has no root (two permission docs), and the folder root has the wrong level.
	expect(result.missing).toEqual([installationId, installationId, installationId]);
});

test("the audit shows an installation that is not backfilled", async () => {
	const { t, installationId } = await fixture();
	expect((await audit(t)).installations).toEqual([
		expect.objectContaining({ installationId, rebuildStatus: "missing", rootCount: 0 }),
	]);
});

test("the preview rolls back", async () => {
	const { t, installationId } = await fixture();
	const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
	const before = await scheduled();

	const error = await t.mutation(internal.migrations.preview_plugins_sandbox_roots, { cursor: null }).catch((e) => e);

	expect(error).toBeInstanceOf(ConvexError);
	expect(error.data).toMatchObject({ data: { processed: 1, isDone: true } });
	expect(
		(await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.sandbox,
	).toBeUndefined();
	expect(await scheduled(), "the rebuild job is rolled back too").toEqual(before);
});
