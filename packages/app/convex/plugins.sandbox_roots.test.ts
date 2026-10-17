import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_nodes_db_hard_delete_node } from "./files_nodes.ts";
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

	async function bind_output_folder(installationId: Id<"plugins_workspace_installations">, nodeId: Id<"files_nodes">) {
		await t.run(async (ctx) => {
			const writerId = await ctx.db.insert("plugins_external_file_writers", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				installationId,
				resourceKey: String(nodeId),
				rootNodeId: nodeId,
				folderNodeId: nodeId,
				rootPath: "/out",
				path: "/out",
				generation: 1,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("plugins_external_file_bindings", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				installationId,
				writerId,
				nodeId,
				revision: 1,
				detachedAt: null,
				updatedAt: Date.now(),
			});
		});
	}

	const sandbox = async (installationId: Id<"plugins_workspace_installations">) =>
		(await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))!.sandbox;

	return { t, membership, asOwner, folder, install, set_grant, bind_output_folder, sandbox };
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
		await f.bind_output_folder(installation._id, output);
		expect(await f.set_grant(installation.serviceAccountId, output, "write")).toEqual({ _yay: null });
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
			extra: await ctx.db.get("files_nodes", extra),
		}));

		expect((await f.set_grant(installation.serviceAccountId, extra, "read"))._nay?.message).toBe(
			"A plugin can use at most 20 folders. Remove one on the plugin page first.",
		);
		// The open folder would become an extended root, so the refusal must come first.
		expect(
			await f.t.run(async (ctx) => ({
				installation: await ctx.db.get("plugins_workspace_installations", installation._id),
				grants: await ctx.db.query("access_control_permission_grants").collect(),
				extra: await ctx.db.get("files_nodes", extra),
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
		await f.set_grant(other, reports, "write");

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
			roots: [{ target: { kind: "folder", nodeId: reports }, level: "write" }],
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

		await f.t.mutation(internal.plugins_service_accounts.recover_sandbox_rebuilds, {});
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());

		expect(await f.sandbox(installation._id)).toEqual({
			roots: [{ target: { kind: "folder", nodeId: reports }, level: "read" }],
			rebuild: null,
		});
	});

	test("a rebuild step with an old lease does nothing", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		await f.set_grant(installation.serviceAccountId, await f.folder("reports"), "read");
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", installation._id, {
				sandbox: { roots: [], rebuild: { status: "running", leaseUntil: Date.now() + 60_000 } },
			}),
		);
		const before = await f.sandbox(installation._id);

		await f.t.mutation(internal.plugins_service_accounts.sandbox_rebuild_step, {
			installationId: installation._id,
			leaseUntil: Date.now() + 1,
			cursor: null,
		});

		expect(await f.sandbox(installation._id)).toEqual(before);
	});

	test("a grant change while a rebuild runs ends with the current grant", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const reports = await f.folder("reports");
		expect(await f.set_grant(installation.serviceAccountId, reports, "write")).toEqual({ _yay: null });
		await f.t.run((ctx) => plugins_db_schedule_sandbox_rebuild(ctx, { installationId: installation._id }));

		// The sync writes into the running rebuild before its first page.
		await f.set_grant(installation.serviceAccountId, reports, "read");
		expect((await f.sandbox(installation._id))?.roots).toEqual([
			{ target: { kind: "folder", nodeId: reports }, level: "read" },
		]);
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());

		expect(await f.sandbox(installation._id)).toEqual({
			roots: [{ target: { kind: "folder", nodeId: reports }, level: "read" }],
			rebuild: null,
		});
	});

	test("detaching an output folder makes its account grant a root, and restricting it removes the account", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const output = await f.folder("transcripts");
		await f.bind_output_folder(installation._id, output);
		await f.set_grant(installation.serviceAccountId, output, "write");
		expect((await f.sandbox(installation._id))?.roots).toEqual([]);

		vi.advanceTimersByTime(60_000);
		// Adding people is a manual sharing change, so it detaches the folder.
		expect(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.membership.membershipId,
				nodeId: output,
				principal: { kind: "role", role: "member" },
				level: "read",
			}),
		).toEqual({ _yay: null });

		expect((await f.sandbox(installation._id))?.roots).toEqual([
			{ target: { kind: "folder", nodeId: output }, level: "write" },
		]);

		// A restrict starts with only the person restricting it.
		vi.advanceTimersByTime(60_000);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.membership.membershipId,
				nodeId: output,
			}),
		).toEqual({ _yay: null });
		expect((await f.sandbox(installation._id))?.roots).toEqual([]);
	});

	test("detaching an output folder when the plugin has 20 folders keeps the share and skips the root", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		for (let index = 0; index < 20; index += 1) {
			await f.set_grant(installation.serviceAccountId, await f.folder(`f${index}`), "read");
		}
		const output = await f.folder("transcripts");
		await f.bind_output_folder(installation._id, output);
		await f.set_grant(installation.serviceAccountId, output, "write");
		const warn = vi.spyOn(console, "warn");

		vi.advanceTimersByTime(60_000);
		// Adding people is a manual sharing change, so it detaches the folder.
		expect(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.membership.membershipId,
				nodeId: output,
				principal: { kind: "role", role: "member" },
				level: "read",
			}),
		).toEqual({ _yay: null });

		expect((await f.sandbox(installation._id))?.roots).toHaveLength(20);
		expect(warn).toHaveBeenCalledWith("Skipped a sandbox root past the plugin folder cap", {
			nodeId: output,
			serviceAccountId: installation.serviceAccountId,
		});
	});

	test("deleting a node frees its root slot", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const fileId = await test_create_saved_text_file(f.t, { membershipId: f.membership.membershipId, path: "/a.md" });
		await f.set_grant(installation.serviceAccountId, fileId, "read");
		expect((await f.sandbox(installation._id))?.roots).toHaveLength(1);

		await f.t.run((ctx) =>
			files_nodes_db_hard_delete_node(ctx, {
				organizationId: f.membership.organizationId,
				workspaceId: f.membership.workspaceId,
				nodeId: fileId,
			}),
		);

		expect((await f.sandbox(installation._id))?.roots).toEqual([]);
	});

	test("an upgrade that changes the account rebuilds the roots", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const created = await f.asOwner.mutation(api.access_control.create_service_account, {
			membershipId: f.membership.membershipId,
			name: "Other",
		});
		if (created._nay) throw new Error(created._nay.message);
		const reports = await f.folder("reports");
		await f.set_grant(created._yay.serviceAccountId, reports, "write");
		const next = await register_media_plugin({ t: f.t, userId: f.membership.userId, version: "0.2.0", events: [] });

		vi.advanceTimersByTime(60_000);
		const upgraded = await f.asOwner.mutation(api.plugins.install_version, {
			membershipId: f.membership.membershipId,
			pluginVersionId: next.pluginVersionId,
			...media_plugin_consent,
			serviceAccountId: created._yay.serviceAccountId,
			serviceAccountGrants: [],
		});
		expect(upgraded).toEqual({ _yay: { installationId: installation._id } });
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());

		expect(await f.sandbox(installation._id)).toEqual({
			roots: [{ target: { kind: "folder", nodeId: reports }, level: "write" }],
			rebuild: null,
		});
	});

	test("a reinstall that reuses the old account rebuilds its roots", async () => {
		const f = await fixture();
		const installation = await f.install([]);
		const reports = await f.folder("reports");
		await f.set_grant(installation.serviceAccountId, reports, "read");
		vi.advanceTimersByTime(60_000);
		await f.asOwner.mutation(api.plugins.uninstall_version, {
			membershipId: f.membership.membershipId,
			installationId: installation._id,
		});
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());

		vi.advanceTimersByTime(60_000);
		const reinstalled = await f.install([]);
		expect(reinstalled.serviceAccountId).toBe(installation.serviceAccountId);
		await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());

		expect(await f.sandbox(reinstalled._id)).toEqual({
			roots: [{ target: { kind: "folder", nodeId: reports }, level: "read" }],
			rebuild: null,
		});
	});
});
