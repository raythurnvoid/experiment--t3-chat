import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import {
	mock_plugins_review,
	user_identity,
	register_media_plugin,
	media_plugin_consent,
} from "./plugins.setup.test.ts";
import { plugins_db_schedule_sandbox_rebuild } from "./plugins_service_accounts.ts";

type Grant = {
	resource: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> };
	level: "read" | "write" | "manage";
};

beforeEach(() => {
	mock_plugins_review();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const version = await register_media_plugin({ t, userId: membership.userId, events: [] });
	const asOwner = t.withIdentity(user_identity(membership.userId));

	async function folder(path: string) {
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: membership.membershipId,
			parentId: files_ROOT_ID,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	}

	async function install(serviceAccountGrants: Grant[]) {
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: version.pluginVersionId,
			...media_plugin_consent,
			serviceAccountGrants,
		});
		if (installed._nay) throw new Error(installed._nay.message);
		return (await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installed._yay.installationId)))!;
	}

	async function set_grant(
		serviceAccountId: Id<"access_control_service_accounts">,
		nodeId: Id<"files_nodes">,
		level: "read" | "write" | "manage" | null,
	) {
		// Grant writes share a rate limit.
		vi.advanceTimersByTime(60_000);
		return level === null
			? await asOwner.mutation(api.access_control.remove_service_account_grant, {
					membershipId: membership.membershipId,
					serviceAccountId,
					resource: { kind: "file", nodeId },
				})
			: await asOwner.mutation(api.access_control.set_service_account_grant, {
					membershipId: membership.membershipId,
					serviceAccountId,
					resource: { kind: "file", nodeId },
					level,
				});
	}

	const sandbox = async (installationId: Id<"plugins_workspace_installations">) =>
		(await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))!.sandbox;

	return { t, membership, asOwner, folder, install, set_grant, sandbox };
}

describe("plugin sandbox roots", () => {
	test("install_version writes sandbox roots from the chosen folders", async () => {
		const f = await fixture();
		const reports = await f.folder("reports");

		const installation = await f.install([
			{ resource: { kind: "workspace" }, level: "write" },
			{ resource: { kind: "file", nodeId: reports }, level: "read" },
		]);

		expect(installation.sandbox).toEqual({
			roots: [
				{ target: { kind: "open" }, level: "write" },
				{ target: { kind: "folder", nodeId: reports }, level: "read" },
			],
			rebuild: null,
		});
	});

	test("a share grant to a plugin account adds a sandbox root, and removing it removes the root", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const reports = await f.folder("reports");

		expect(await f.set_grant(installation.serviceAccountId, reports, "write")).toEqual({ _yay: null });
		expect((await f.sandbox(installation._id))?.roots).toContainEqual({
			target: { kind: "folder", nodeId: reports },
			level: "write",
		});

		// A level change replaces the root, it does not add a second one.
		await f.set_grant(installation.serviceAccountId, reports, "read");
		expect((await f.sandbox(installation._id))?.roots).toEqual([
			{ target: { kind: "folder", nodeId: reports }, level: "read" },
		]);

		await f.set_grant(installation.serviceAccountId, reports, null);
		expect((await f.sandbox(installation._id))?.roots).toEqual([]);
	});

	test("a grant on a plugin output folder adds no root", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const output = await f.folder("transcripts");
		await f.t.run(async (ctx) => {
			const writerId = await ctx.db.insert("plugins_external_file_writers", {
				organizationId: f.membership.organizationId,
				workspaceId: f.membership.workspaceId,
				installationId: installation._id,
				resourceKey: "transcripts",
				rootNodeId: output,
				folderNodeId: output,
				rootPath: "/transcripts",
				path: "/transcripts",
				generation: 1,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("plugins_external_file_bindings", {
				organizationId: f.membership.organizationId,
				workspaceId: f.membership.workspaceId,
				installationId: installation._id,
				writerId,
				nodeId: output,
				revision: 1,
				detachedAt: null,
				updatedAt: Date.now(),
			});
		});

		expect(await f.set_grant(installation.serviceAccountId, output, "manage")).toEqual({ _yay: null });
		expect((await f.sandbox(installation._id))?.roots).toEqual([]);
	});

	test("a 21st folder for a plugin account is refused and writes nothing", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		for (let index = 0; index < 20; index += 1) {
			expect(await f.set_grant(installation.serviceAccountId, await f.folder(`f${index}`), "read")).toEqual({
				_yay: null,
			});
		}
		const extra = await f.folder("extra");
		const before = await f.t.run(async (ctx) => ({
			installation: await ctx.db.get("plugins_workspace_installations", installation._id),
			grants: await ctx.db.query("access_control_permission_grants").collect(),
		}));

		expect((await f.set_grant(installation.serviceAccountId, extra, "read"))._nay?.message).toBe(
			"A plugin can use at most 20 folders. Remove one on the plugin page first.",
		);
		expect(
			await f.t.run(async (ctx) => ({
				installation: await ctx.db.get("plugins_workspace_installations", installation._id),
				grants: await ctx.db.query("access_control_permission_grants").collect(),
			})),
		).toEqual(before);
	});

	test("rebinding a plugin to another account rebuilds its roots in a job, with no folder until it ends", async () => {
		const f = await fixture();
		const installation = await f.install([{ resource: { kind: "workspace" }, level: "write" }]);
		const created = await f.asOwner.mutation(api.access_control.create_service_account, {
			membershipId: f.membership.membershipId,
			name: "Other",
		});
		if (created._nay) throw new Error(created._nay.message);
		const other = created._yay.serviceAccountId;
		const reports = await f.folder("reports");
		await f.set_grant(other, reports, "manage");

		vi.advanceTimersByTime(60_000);
		expect(
			await f.asOwner.mutation(api.plugins.set_installation_service_account, {
				membershipId: f.membership.membershipId,
				installationId: installation._id,
				serviceAccountId: other,
			}),
		).toEqual({ _yay: null });
		expect(await f.sandbox(installation._id)).toEqual({
			roots: [],
			rebuild: { status: "running", leaseUntil: expect.any(Number) },
		});

		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
		expect(await f.sandbox(installation._id)).toEqual({
			roots: [{ target: { kind: "folder", nodeId: reports }, level: "manage" }],
			rebuild: null,
		});
	});

	test("a rebuild past 20 folders ends with too_many_folders, and a grant change starts it again", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const folders: Array<Id<"files_nodes">> = [];
		for (let index = 0; index < 21; index += 1) folders.push(await f.folder(`f${index}`));
		// Seed 21 grants directly: the writer would refuse the 21st.
		await f.t.run(async (ctx) => {
			for (const nodeId of folders) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: f.membership.organizationId,
					workspaceId: f.membership.workspaceId,
					resourceKind: "file",
					resourceId: nodeId,
					principalKind: "service_account",
					serviceAccountId: installation.serviceAccountId,
					permission: "content.read",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});
		await f.t.run((ctx) => plugins_db_schedule_sandbox_rebuild(ctx, { installationId: installation._id }));
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
		expect(await f.sandbox(installation._id)).toEqual({ roots: [], rebuild: { status: "too_many_folders" } });

		await f.set_grant(installation.serviceAccountId, folders[0], null);
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
		expect((await f.sandbox(installation._id))?.roots).toHaveLength(20);
		expect((await f.sandbox(installation._id))?.rebuild).toBeNull();
	});

	test("a rebuild whose chain stopped restarts after its lease", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const reports = await f.folder("reports");
		await f.set_grant(installation.serviceAccountId, reports, "read");
		// A running rebuild whose step never ran.
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", installation._id, {
				sandbox: { roots: [], rebuild: { status: "running", leaseUntil: Date.now() - 1 } },
			}),
		);

		await f.t.mutation(internal.plugins.recover_sandbox_rebuilds, {});
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());

		expect(await f.sandbox(installation._id)).toEqual({
			roots: [{ target: { kind: "folder", nodeId: reports }, level: "read" }],
			rebuild: null,
		});
	});

	test("a rebuild step with an old lease does nothing", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const before = await f.sandbox(installation._id);

		await f.t.mutation(internal.plugins.sandbox_rebuild_step, {
			installationId: installation._id,
			leaseUntil: 1,
			cursor: null,
		});

		expect(await f.sandbox(installation._id)).toEqual(before);
	});
});
