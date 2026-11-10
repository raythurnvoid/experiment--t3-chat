import type { FunctionArgs } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { activities_db_start } from "./activities_db.ts";
import { files_archive_runs_PLUGIN_RESTORE_MESSAGES } from "./files_archive_runs.ts";
import { files_nodes_db_restore_named_nodes } from "./files_nodes.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import {
	get_plugin_restore_job,
	list_plugin_trash_areas_page,
	list_trash_page,
	restore_items,
} from "./public_api_files_organize.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	fixture,
	add_member,
	folder,
	archive,
	run_to_end,
	read_activity,
	read_node,
	lock,
	type Fixture,
} from "./files_archive_runs.setup.test.ts";
import { insert_installation, reset_rate_limits } from "./files_share_links.setup.test.ts";
import {
	test_finish_saved_scope_jobs,
	test_mocks,
	test_move_nodes,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { expect_under_convex_limits, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_archive_operation_id_new } from "../shared/files.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function plugin(f: Fixture, options: { member?: boolean; scheduled?: boolean } = {}) {
	const person = options.member ? await add_member(f) : f.db;
	const installationId = await insert_installation(f);
	const token = `plu_${await crypto_sha256_hex(installationId)}`;
	const runToken = `plr_${await crypto_sha256_hex(installationId)}`;
	return await f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
		const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
		const pluginName = `trash-${installationId}`;
		const capabilities = ["workspace.files.read", "plugin.schedule.run"] as const;
		await ctx.db.patch("plugins_workspace_installations", installationId, {
			pluginName,
			acceptedCapabilities: [...capabilities],
		});
		await ctx.db.patch("plugins_versions", version._id, {
			name: pluginName,
			capabilities: [...capabilities],
			events: [
				{
					type: "schedule.interval.elapsed",
					contentTypes: [],
					filters: [],
					schedule: { configurationPath: ["every"] },
				},
			],
		});
		await ctx.db.insert("plugins_service_account_bindings", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			serviceAccountId: installation.serviceAccountId,
			pluginName,
			publisherUserId: version.createdBy,
			sourceRepositoryUrl: version.sourceRepositoryUrl,
		});
		const membership = (await ctx.db.get("organizations_workspaces_users", person.membershipId))!;
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		const pairId = await ctx.db.insert("plugins_file_pairs", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			userId: person.userId,
			membershipId: person.membershipId,
			membershipLifetime,
			createdAt: Date.now(),
		});
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			pluginVersionId: version._id,
			serviceAccountId: installation.serviceAccountId,
			filePairId: pairId,
			userId: person.userId,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: Date.now(),
			expiresAt: Date.now() + 60 * 60 * 1000,
		});
		const runAsGrantId = options.scheduled
			? await ctx.db.insert("access_control_permission_grants", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					resourceKind: "plugin_installation",
					resourceId: installationId,
					principalKind: "user",
					userId: person.userId,
					permission: "plugin.run_as",
					runAs: { membershipId: person.membershipId, membershipLifetime, scopes: ["files:list"] },
					createdAt: Date.now(),
					updatedAt: Date.now(),
				})
			: undefined;
		if (runAsGrantId)
			await ctx.db.patch("plugins_workspace_installations", installationId, {
				scheduledRunUserId: person.userId,
				scheduledRunGrantId: runAsGrantId,
			});
		const event = options.scheduled ? ("schedule.interval.elapsed" as const) : ("ui.invoke.requested" as const);
		const runId = await ctx.db.insert("plugins_event_runs", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			pluginVersionId: version._id,
			serviceAccountId: installation.serviceAccountId,
			filePairId: pairId,
			actorUserId: person.userId,
			event,
			eventId: "trash-test",
			...(runAsGrantId
				? { runAsGrantId, runAsMembershipId: person.membershipId, runAsMembershipLifetime: membershipLifetime }
				: {}),
			apiTokenHash: await crypto_sha256_hex(runToken),
			apiTokenExpiresAt: Date.now() + 60 * 60 * 1000,
			acceptedCapabilities: [...capabilities],
			apiCallCount: 0,
			outputWriteCount: 0,
		});
		await activities_db_start(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: person.userId,
			source: { kind: "plugin_run", id: runId, installationId, pluginName, event },
			title: "Trash test",
			targets: [],
			visibility: "shared",
			feedVisible: false,
			status: "running",
			resultKind: "plugin_result",
			deadlineAt: Date.now() + 60 * 60 * 1000,
			now: Date.now(),
		});
		return { token, runToken, runId, installationId, pairId, userId: person.userId, membershipId: person.membershipId };
	});
}

async function select(
	f: Fixture,
	pairId: Id<"plugins_file_pairs">,
	rootNodeId: Id<"files_nodes"> | null,
	areaEligible = false,
	level: "read" | "write" = "read",
) {
	const consentId = await f.t.run((ctx) =>
		ctx.db.insert("plugins_file_consents", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			pairId,
			rootNodeId,
			requestedLevel: level,
			appliedLevel: level,
			areaEligible,
			open: true,
			revision: 1,
			state: "applied",
			endedReason: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	if (rootNodeId !== null && !areaEligible) {
		await f.t.mutation(internal.files_subtree_ops.extend_node, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			nodeId: rootNodeId,
		});
		while (true) {
			const walk = await f.t.run((ctx) => ctx.db.query("files_subtree_op_walks").first());
			if (!walk) break;
			await f.t.mutation(internal.files_subtree_ops.advance, { opId: walk.opId, step: walk.step });
		}
		await finish_path_jobs(f);
		await test_finish_saved_scope_jobs(f.t);
	}
	return consentId;
}

async function finish_path_jobs(f: Fixture) {
	while (true) {
		const job = await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_jobs").first());
		if (!job) return;
		await f.t.mutation(internal.files_subtree_ops.path_index_advance, {
			jobId: job._id,
			generation: job.generation,
			step: job.step,
		});
	}
}

async function post(f: Fixture, token: string, route: "list" | "areas" | "restore" | "jobs/get", body: unknown = {}) {
	const response = await f.t.fetch(
		`/api/v1/files/${route === "list" || route === "areas" ? `trash/${route}` : route}`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return {
		status: response.status,
		body: (await response.json()) as {
			message?: string;
			errorCode?: string;
			cursor?: string | null;
			isDone?: boolean;
			areas?: Array<{ areaNodeId: string | null; path: string }>;
			items?: Array<{ nodeId: string; path: string; changedBy: string | null; locked: boolean }>;
			jobIds?: Array<Id<"activities">>;
			refused?: Array<{ nodeId?: string; path: string | null; message: string }>;
			// `files/jobs/get`
			jobId?: Id<"activities">;
			status?: string;
			errorMessage?: string | null;
			renamed?: Array<{ path: string | null; newPath: string | null }>;
			refusedCursor?: string | null;
			dryRun?: true;
			complete?: boolean;
			jobs?: Array<{
				status: string;
				errorMessage: string | null;
				refused: Array<{ nodeId?: string; path: string | null; message: string }>;
				renamed: Array<{ path: string | null; newPath: string | null }>;
				hasMoreItems: boolean;
			}>;
		},
	};
}

function calls_of(f: Fixture, runId: Id<"plugins_event_runs">) {
	return f.t.run((ctx) =>
		ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", runId))
			.collect(),
	);
}

async function file(f: Fixture, parentId: Id<"files_nodes"> | "root", path: string) {
	const name = path.split("/").at(-1)!;
	return await test_run_with_flush(f.t, (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			parentId,
			kind: "file",
			name,
			sortName: name,
			path,
			treePath: path,
			pathDepth: path.split("/").length - 1,
		}),
	);
}

// More files than one request restores, so the restore goes on in scheduled steps.
async function folder_with_files(f: Fixture, path: string) {
	const folderId = await folder(f, path);
	for (let index = 0; index < 40; index++) await file(f, folderId, `${path}/f${String(index).padStart(2, "0")}.md`);
	return folderId;
}

async function to_trash(f: Fixture, nodeIds: Array<Id<"files_nodes">>) {
	const archived = await archive(f, nodeIds);
	expect(archived._nay).toBeUndefined();
	if (archived._yay) expect((await run_to_end(f, archived._yay)).activity.status).toBe("succeeded");
}

async function count_restored(f: Fixture, treePath: string) {
	const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
	return nodes.filter((node) => node.treePath.startsWith(treePath) && node.archiveOperationId === null).length;
}

test.each(["token", "runToken"] as const)(
	"%s lists a selected folder in Trash and keeps narrow boundaries",
	async (credential) => {
		const f = await fixture();
		const p = await plugin(f);
		const root = await folder(f, "/selected");
		const other = await folder(f, "/other");
		await select(f, p.pairId, root);
		const children = await Promise.all(["a", "b", "c", "d", "e"].map((name) => folder(f, `/selected/${name}`)));
		expect(await archive(f, children)).toEqual({ _yay: null });
		const pages = [];
		let cursor: string | null = null;
		do {
			const result = await post(f, p[credential], "list", { folderNodeId: root, limit: 2, cursor });
			expect(result.status, "a plugin can list its selected folder").toBe(200);
			pages.push(result.body.items!);
			cursor = result.body.cursor ?? null;
		} while (cursor);
		expect(
			pages.map((page) => page.length),
			"folder pages stay full",
		).toEqual([2, 2, 1]);
		expect(new Set(pages.flat().map((row) => row.nodeId))).toEqual(new Set(children));
		expect(pages.flat(), "readable Trash rows keep changedBy").toEqual(
			expect.arrayContaining([expect.objectContaining({ changedBy: f.db.userId, locked: false })]),
		);
		expect((await post(f, p[credential], "list")).status, "a pair has no open area").toBe(403);
		expect(
			(await post(f, p[credential], "list", { folderNodeId: other })).status,
			"unselected folders stay locked",
		).toBe(403);
		expect((await post(f, p[credential], "areas")).body.areas, "ordinary folders use folder mode").toEqual([]);
		expect(
			(await post(f, p[credential], "restore", { paths: ["/selected/a"] })).status,
			"read consent alone does not restore",
		).toBe(403);
		await finish_path_jobs(f);
		const archived = await archive(f, [root]);
		expect(archived._nay).toBeUndefined();
		if (archived._yay) expect((await run_to_end(f, archived._yay)).activity.status).toBe("succeeded");
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", root)))!.archiveOperationId).not.toBeNull();
		expect(
			(await post(f, p[credential], "list", { folderNodeId: root })).status,
			"selected folders work while in Trash",
		).toBe(200);
		if (credential === "runToken") {
			const calls = await f.t.run((ctx) =>
				ctx.db
					.query("plugins_event_run_calls")
					.withIndex("by_run_sequence", (q) => q.eq("runId", p.runId))
					.collect(),
			);
			expect(calls.length).toBeGreaterThan(0);
			expect(
				calls.every((call) => call.status !== "started"),
				"every Trash call is settled",
			).toBe(true);
		}
	},
);

test.each(["list", "areas"] as const)("%s keeps the failed call's cursor error code", async (route) => {
	const f = await fixture();
	const p = await plugin(f);
	const response = await post(f, p.runToken, route, { cursor: "wrong" });
	expect(response.status).toBe(400);
	expect(response.body.errorCode).toBe("invalid_cursor");
	const call = await f.t.run((ctx) =>
		ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", p.runId))
			.first(),
	);
	expect(call, "Trash cursor failures keep their call error code").toMatchObject({
		status: "failed",
		responseStatus: 400,
		errorCode: "invalid_cursor",
		errorMessage: response.body.message,
	});
});

test.each(["token", "runToken"] as const)(
	"%s uses workspace Trash consent without crossing restricted areas",
	async (credential) => {
		const f = await fixture();
		const p = await plugin(f);
		const workspaceConsent = await select(f, p.pairId, null, true);
		const selected = await folder(f, "/selected");
		const hidden = await folder(f, "/hidden");
		for (const nodeId of [selected, hidden]) {
			await reset_rate_limits(f.t, [f.db.userId]);
			expect(
				(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId }))._nay,
			).toBeUndefined();
		}
		await test_finish_saved_scope_jobs(f.t);
		await select(f, p.pairId, selected, true);
		const selectedChild = await folder(f, "/selected/child");
		const hiddenChild = await folder(f, "/hidden/child");
		const openChildren: Id<"files_nodes">[] = [];
		for (const name of ["a", "b", "c", "d", "e"]) openChildren.push(await folder(f, `/open-${name}`));
		const archived = await archive(f, [...openChildren, selectedChild, hiddenChild]);
		expect(archived._nay).toBeUndefined();
		if (archived._yay) expect((await run_to_end(f, archived._yay)).activity.status).toBe("succeeded");
		const areas = [];
		let cursor: string | null = null;
		do {
			const page = await post(f, p[credential], "areas", { limit: 1, cursor });
			expect(page.status, "workspace and saved areas share one native page").toBe(200);
			expect(page.body.areas!.length, "a one-area page does not prepend an extra workspace").toBe(1);
			areas.push(...page.body.areas!);
			cursor = page.body.cursor ?? null;
		} while (cursor);
		expect(areas, "workspace and saved areas appear once in consent order").toEqual([
			{ areaNodeId: null, path: "/" },
			{ areaNodeId: selected, path: "/selected" },
		]);
		const items = [];
		const sizes: number[] = [];
		do {
			const page = await post(f, p[credential], "list", { areaNodeId: null, limit: 2, cursor });
			expect(page.status, "workspace consent opens the root Trash area").toBe(200);
			items.push(...page.body.items!);
			sizes.push(page.body.items!.length);
			cursor = page.body.cursor ?? null;
		} while (cursor);
		expect(sizes, "open Trash fills more than one page").toEqual([2, 2, 1]);
		expect(new Set(items.map((item) => item.nodeId)), "root Trash excludes restricted contents").toEqual(
			new Set(openChildren),
		);
		expect(
			items.every((item) => item.changedBy === f.db.userId && !item.locked),
			"open Trash keeps changedBy",
		).toBe(true);
		expect(
			(await post(f, p[credential], "list", { areaNodeId: hidden })).status,
			"workspace consent cannot open a restricted Trash area",
		).toBe(403);
		expect(
			(await post(f, p[credential], "list", { areaNodeId: selected })).body.items?.map((item) => item.nodeId),
		).toEqual([selectedChild]);
		expect(
			(await post(f, p[credential], "restore", { paths: ["/open-a"] })).status,
			"workspace consent without the Restore capability does not restore",
		).toBe(403);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_file_consents", workspaceConsent, {
				open: false,
				appliedLevel: null,
				areaEligible: false,
				state: "ended",
			}),
		);
		expect((await post(f, p[credential], "list")).status, "removing workspace consent closes root Trash").toBe(403);
		expect(
			(await post(f, p[credential], "areas")).body.areas,
			"the saved restricted area survives workspace removal",
		).toEqual([{ areaNodeId: selected, path: "/selected" }]);
		expect((await post(f, p[credential], "list", { areaNodeId: selected })).status).toBe(200);
	},
);

test("file-only selection gives no Trash area or parent list", async () => {
	const f = await fixture();
	const p = await plugin(f);
	const parentId = await folder(f, "/parent");
	const nodeId = await test_run_with_flush(f.t, (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			parentId,
			kind: "file",
			name: "file.md",
			sortName: "file.md",
			path: "/parent/file.md",
			treePath: "/parent/file.md",
			pathDepth: 2,
		}),
	);
	await select(f, p.pairId, nodeId);
	expect((await post(f, p.token, "areas")).body.areas, "file-only consent has no area").toEqual([]);
	expect(
		(await post(f, p.token, "list", { folderNodeId: parentId })).status,
		"file-only consent does not list its parent",
	).toBe(403);
	expect((await post(f, p.token, "list", { folderNodeId: nodeId })).status).toBe(400);
});

test("areas page only the pair's applied rows without a live human filter or access scan", async () => {
	const f = await fixture();
	const p = await plugin(f, { member: true });
	const other = await plugin(f);
	const roots: Array<Id<"files_nodes"> | null> = [];
	for (let i = 0; i < 7; i++) {
		if (i === 2) {
			await select(f, p.pairId, null, true);
			roots.push(null);
		}
		const nodeId = await folder(f, `/area-${6 - i}`);
		await reset_rate_limits(f.t, [f.db.userId]);
		await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId });
		await test_finish_saved_scope_jobs(f.t);
		const principal = { kind: "user", userId: p.userId } as const;
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId,
					principal,
					level: "read",
				})
			)._nay,
		).toBeUndefined();
		roots.push(nodeId);
		await select(f, p.pairId, nodeId, true);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId,
					principal,
				})
			)._nay,
		).toBeUndefined();
	}
	// The real share removal has not reached the consent worker yet.
	const costs: ReturnType<typeof transaction_cost>[] = [];
	test_spy_handler(list_plugin_trash_areas_page, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		costs.push(transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});
	const first = await post(f, p.token, "areas", { limit: 3 });
	expect(first.status, "a narrow pair can list areas").toBe(200);
	expect(
		first.body.areas?.map((area) => area.areaNodeId),
		"applied area rows survive newer human restrictions",
	).toEqual(roots.slice(0, 3));
	const baseline = costs.at(-1)!;
	await f.t.run(async (ctx) => {
		for (let i = 0; i < 80; i++) {
			const name = `unrelated-${i}`;
			const rootNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: "root",
				kind: "folder",
				name,
				sortName: name,
				path: `/${name}`,
				treePath: `/${name}/`,
				pathDepth: 1,
			});
			await ctx.db.patch("files_nodes", rootNodeId, { isRestrictedScopeRoot: true, restrictedScopeNodeId: rootNodeId });
			await ctx.db.insert("plugins_file_consents", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				pairId: i % 2 ? p.pairId : other.pairId,
				rootNodeId,
				requestedLevel: "read",
				appliedLevel: i % 2 ? null : "read",
				areaEligible: i % 2 === 0,
				open: true,
				revision: 1,
				state: i % 2 ? "pending" : "applied",
				endedReason: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
	});
	const repeated = await post(f, p.token, "areas", { limit: 3 });
	expect(repeated.body.areas, "unrelated consent cannot shorten a page").toEqual(first.body.areas);
	expect(costs.at(-1), "unrelated consent adds no query or document reads").toEqual(baseline);
	const ids = repeated.body.areas!.map((row) => row.areaNodeId);
	let cursor = repeated.body.cursor;
	while (cursor) {
		const page = await post(f, p.token, "areas", { limit: 3, cursor });
		expect(page.status).toBe(200);
		ids.push(...page.body.areas!.map((row) => row.areaNodeId));
		cursor = page.body.cursor;
	}
	expect(ids, "all applied areas appear once in consent order").toEqual(roots);
	expect(
		(await post(f, other.token, "areas", { limit: 3, cursor: first.body.cursor })).body.errorCode,
		"area cursors stay with their pair",
	).toBe("invalid_cursor");
	expect((await post(f, p.token, "areas", { cursor: "wrong" })).body.errorCode).toBe("invalid_cursor");
});

test.each(["token", "runToken"] as const)(
	"%s returns full 100-area pages within transaction limits",
	async (credential) => {
		const f = await fixture({ transactionLimits: true });
		const p = await plugin(f);
		const roots: Array<Id<"files_nodes"> | null> = [];
		for (let i = 0; i < 105; i++) {
			if (i === 52) {
				await select(f, p.pairId, null, true);
				roots.push(null);
			}
			const nodeId = await folder(f, `/full-area-${i}`);
			await f.t.run((ctx) =>
				ctx.db.patch("files_nodes", nodeId, {
					isRestrictedScopeRoot: true,
					restrictedScopeNodeId: nodeId,
				}),
			);
			await select(f, p.pairId, nodeId, true);
			roots.push(nodeId);
		}
		test_spy_handler(list_plugin_trash_areas_page, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			expect_under_convex_limits(transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const ids: Array<string | null> = [];
		const sizes: number[] = [];
		let cursor: string | null = null;
		do {
			const page = await post(f, p[credential], "areas", { limit: 100, cursor });
			expect(page.status, "a full plugin area page succeeds").toBe(200);
			ids.push(...page.body.areas!.map((area) => area.areaNodeId));
			sizes.push(page.body.areas!.length);
			cursor = page.body.cursor ?? null;
		} while (cursor);
		expect(sizes, "area pages fill the supported limit").toEqual([100, 6]);
		expect(ids, "full area pages return every consent once").toEqual(roots);
	},
);

test("full folder Trash pages use the published Move before physical cleanup", async () => {
	const f = await fixture({ transactionLimits: true });
	const p = await plugin(f);
	const root = await folder(f, "/before/folder");
	const target = await folder(f, "/after");
	await select(f, p.pairId, root);
	const children: Id<"files_nodes">[] = [];
	for (let i = 0; i < 205; i++) {
		children.push(await folder(f, `/before/folder/item-${String(i).padStart(3, "0")}`));
	}
	const archived = await archive(f, children);
	expect(archived._nay).toBeUndefined();
	if (archived._yay) expect((await run_to_end(f, archived._yay)).activity.status).toBe("succeeded");
	await finish_path_jobs(f);
	await test_finish_saved_scope_jobs(f.t);
	test_spy_handler(list_trash_page, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		expect_under_convex_limits(transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});
	const check_pages = async (prefix: string) => {
		for (const credential of [p.token, p.runToken]) {
			const items = [];
			const sizes: number[] = [];
			let cursor: string | null = null;
			do {
				const page = await post(f, credential, "list", { folderNodeId: root, limit: 100, cursor });
				expect(page.status, "a full plugin folder page succeeds").toBe(200);
				items.push(...page.body.items!);
				sizes.push(page.body.items!.length);
				cursor = page.body.cursor ?? null;
			} while (cursor);
			expect(sizes, "folder pages fill the supported limit during Move").toEqual([100, 100, 5]);
			expect(
				items.map((item) => item.nodeId),
				"folder pages return every child once during Move",
			).toEqual([...children].reverse());
			expect(
				items.map((item) => item.path),
				"folder Trash uses published paths during Move",
			).toEqual(children.map((_, i) => `${prefix}/item-${String(i).padStart(3, "0")}`).reverse());
		}
	};
	await check_pages("/before/folder");
	let checked = false;
	const moved = await test_move_nodes(f.t, f.asOwner, {
		membershipId: f.db.membershipId,
		itemIds: [root],
		targetParentId: target,
		onStep: async () => {
			if (checked) return;
			const placement = await f.t.run(async (ctx) => ({
				physical: await ctx.db.get("files_nodes", root),
				saved: await files_saved_placement_db_get_node(ctx.db, root),
			}));
			if (placement.physical?.path !== "/before/folder" || placement.saved?.path !== "/after/folder") return;
			await check_pages("/after/folder");
			checked = true;
		},
	});
	expect(moved._nay).toBeUndefined();
	expect(checked, "full folder pages were checked before physical cleanup").toBe(true);
});

test("area paths use the published Move before physical cleanup", async () => {
	const f = await fixture();
	const p = await plugin(f);
	const root = await folder(f, "/before/area");
	const target = await folder(f, "/after");
	expect(
		(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: root,
			})
		)._nay,
	).toBeUndefined();
	await select(f, p.pairId, root, true);
	let checked = false;
	const moved = await test_move_nodes(f.t, f.asOwner, {
		membershipId: f.db.membershipId,
		itemIds: [root],
		targetParentId: target,
		onStep: async () => {
			const placement = await f.t.run(async (ctx) => ({
				physical: await ctx.db.get("files_nodes", root),
				saved: await files_saved_placement_db_get_node(ctx.db, root),
			}));
			if (placement.physical?.path !== "/before/area" || placement.saved?.path !== "/after/area") return;
			checked = true;
			expect((await post(f, p.token, "areas")).body.areas, "area labels use the published saved path").toEqual([
				{ areaNodeId: root, path: "/after/area" },
			]);
		},
	});
	expect(moved._nay).toBeUndefined();
	expect(checked, "the real Move published before physical cleanup").toBe(true);
});

test.each(["list", "areas"] as const)(
	"%s refuses guests, null-pair runs, missing capability and scheduled runs",
	async (route) => {
		const f = await fixture();
		const guest = await plugin(f, { member: true });
		const root = await folder(f, "/guest-folder");
		await select(f, guest.pairId, root);
		await select(f, guest.pairId, null, true);
		await f.asOwner.mutation(api.access_control.set_user_role, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: guest.userId,
			role: null,
		});
		expect(
			(await post(f, guest.token, route, { ...(route === "list" ? { folderNodeId: root } : {}) })).status,
			"guests have no Trash even with applied consent",
		).toBe(403);
		const noPair = await plugin(f);
		await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", noPair.runId, { filePairId: null }));
		expect((await post(f, noPair.runToken, route)).status, "a null-pair run cannot read Trash").toBe(401);
		const scheduled = await plugin(f, { scheduled: true });
		await select(f, scheduled.pairId, null, true);
		expect(await post(f, scheduled.runToken, route), "scheduled Trash gives a clear refusal").toMatchObject({
			status: 403,
			body: { message: "Scheduled plugin runs cannot use Trash yet." },
		});
		const noCapability = await plugin(f);
		await select(f, noCapability.pairId, null, true);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", noCapability.installationId, { acceptedCapabilities: [] }),
		);
		expect((await post(f, noCapability.token, route)).status, "file read capability is required").toBe(403);
	},
);

test("files/restore gives a plugin run the Restore scope only with Restore consent", async () => {
	const f = await fixture();
	const body = { paths: ["/restore-me"], requestId: "scope-matrix" };
	const accept = (p: Awaited<ReturnType<typeof plugin>>, capabilities: plugins_Capability[]) =>
		f.t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", p.installationId, { acceptedCapabilities: capabilities });
			await ctx.db.patch("plugins_event_runs", p.runId, { acceptedCapabilities: capabilities });
		});

	const restorer = await plugin(f);
	await accept(restorer, ["workspace.files.read", "workspace.files.write", "workspace.files.restore"]);
	expect(
		await post(f, restorer.runToken, "restore", body),
		"a run with Restore consent passes the scope checks",
	).toMatchObject({
		status: 200,
		// The run chose no files, so its pair cannot open the path.
		body: { jobIds: [], refused: [{ path: "/restore-me", message: "Permission denied" }] },
	});
	expect(await calls_of(f, restorer.runId), "the plugin answer closes its call").toEqual([
		expect.objectContaining({ status: "succeeded", responseStatus: 200 }),
	]);
	expect((await post(f, restorer.token, "restore", body)).status, "plugin pages cannot restore").toBe(403);
	await f.t.run((ctx) =>
		ctx.db.patch("plugins_workspace_installations", restorer.installationId, {
			acceptedCapabilities: ["workspace.files.read", "workspace.files.write"],
		}),
	);
	expect(await post(f, restorer.runToken, "restore", body), "the installation must accept Restore too").toMatchObject({
		status: 403,
		body: { message: "Permission denied" },
	});

	// An upload run gets `files:write` for its sibling outputs. That scope must not open Restore.
	const uploader = await plugin(f);
	const sourceId = await test_run_with_flush(f.t, (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			parentId: "root",
			kind: "file",
			name: "source.md",
			sortName: "source.md",
			path: "/source.md",
			treePath: "/source.md",
			pathDepth: 1,
		}),
	);
	await f.t.run((ctx) =>
		ctx.db.patch("plugins_event_runs", uploader.runId, { event: "files.upload.completed", fileNodeId: sourceId }),
	);
	expect(
		await post(f, uploader.runToken, "restore", body),
		"an upload run's files:write does not restore",
	).toMatchObject({ status: 403, body: { message: "Permission denied" } });

	const scheduled = await plugin(f, { scheduled: true });
	await accept(scheduled, [
		"workspace.files.read",
		"workspace.files.write",
		"workspace.files.restore",
		"plugin.schedule.run",
	]);
	expect(
		await post(f, scheduled.runToken, "restore", body),
		"a scheduled run cannot restore even with Restore consent",
	).toMatchObject({ status: 403, body: { message: "Scheduled plugin runs cannot use Trash yet." } });

	for (const runId of [restorer.runId, uploader.runId, scheduled.runId]) {
		expect(
			(await calls_of(f, runId)).every((call) => call.status !== "started"),
			"every Restore call is settled",
		).toBe(true);
	}

	// A key keeps its `files:write` rule.
	await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-restore-scope-owner" }));
	vi.advanceTimersByTime(60_000);
	const key = await f.asOwner.mutation(api.public_api.api_credential_create, {
		serviceAccountId: null,
		membershipId: f.db.membershipId,
		name: "Restore key",
		scopes: ["files:list", "files:write"],
	});
	if (key._nay) throw new Error(key._nay.message);
	const trashed = await folder(f, "/restore-me");
	const archived = await archive(f, [trashed]);
	expect(archived._nay).toBeUndefined();
	if (archived._yay) expect((await run_to_end(f, archived._yay)).activity.status).toBe("succeeded");
	expect((await post(f, key._yay.credential, "restore", body)).status, "a key with files:write still restores").toBe(
		200,
	);
});

test("a restricted child stays locked inside a selected folder", async () => {
	const f = await fixture();
	const p = await plugin(f);
	const root = await folder(f, "/selected");
	const child = await folder(f, "/selected/private");
	expect(
		(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: child,
			})
		)._nay,
	).toBeUndefined();
	await select(f, p.pairId, root);
	expect(await archive(f, [child])).toEqual({ _yay: null });
	const listed = await post(f, p.token, "list", { folderNodeId: root });
	expect(listed.status, "the selected parent is readable").toBe(200);
	expect(listed.body.items, "a locked child is visible with limited fields").toEqual([
		expect.objectContaining({ nodeId: child, locked: true, changedBy: null }),
	]);
	expect(
		(await post(f, p.token, "list", { folderNodeId: child })).status,
		"a parent selection cannot open a restricted child",
	).toBe(403);
	expect(
		(await post(f, p.token, "list", { areaNodeId: child })).status,
		"a parent selection cannot open the child's area",
	).toBe(403);
});

describe("files_nodes_db_restore_named_nodes", () => {
	const PLUGIN_LOST = "The plugin that started this job was updated or removed, or it lost access to these files.";

	// The person is the owner, who passes every check. So only the plugin's own access can stop a job.
	async function restorer(f: Fixture) {
		const p = await plugin(f);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", p.installationId, {
				acceptedCapabilities: ["workspace.files.read", "workspace.files.write", "workspace.files.restore"],
			}),
		);
		return p;
	}

	// Restore as the plugin run, with the pins the installation has now.
	async function restore_as(
		f: Fixture,
		p: Awaited<ReturnType<typeof plugin>>,
		nodeIds: Array<Id<"files_nodes">>,
		options: { force?: boolean; onConflict?: "keep_both" | "skip" } = {},
	) {
		const onConflict = options.onConflict ?? "keep_both";
		return await test_run_with_flush(f.t, async (ctx) => {
			const installation = (await ctx.db.get("plugins_workspace_installations", p.installationId))!;
			const nodes = [];
			for (const nodeId of nodeIds) nodes.push((await ctx.db.get("files_nodes", nodeId))!);
			return await files_nodes_db_restore_named_nodes(ctx, {
				userAuth: { id: p.userId },
				membership: (await ctx.db.get("organizations_workspaces_users", p.membershipId))!,
				nodes,
				credentialId: null,
				plugin: {
					installationId: installation._id,
					filePairId: p.pairId,
					pluginVersionId: installation.pluginVersionId,
					serviceAccountId: installation.serviceAccountId,
					capabilitiesAcceptedAt: installation.capabilitiesAcceptedAt,
				},
				force: options.force,
				applyToRemaining: { file: onConflict, folder: onConflict },
				stopAtRefusal: false,
			});
		});
	}

	test("a folder choice restores every item of a multi-step job", async () => {
		const f = await fixture();
		const p = await restorer(f);
		const chosen = await folder(f, "/chosen");
		await select(f, p.pairId, chosen, false, "write");
		const big = await folder_with_files(f, "/chosen/big");
		await to_trash(f, [big]);

		const restored = await restore_as(f, p, [big]);
		expect(restored.refusals).toEqual([]);
		const ended = await run_to_end(f, restored.jobs[0]!);
		expect(await count_restored(f, "/chosen/big/"), "restores every item of a multi-step job").toBe(41);
		expect(ended.steps, "the job runs more than one step").toBeGreaterThan(1);
		expect(ended.activity.status).toBe("succeeded");
	});

	test("a later job checks each item against the plugin's choices at that step", async () => {
		const f = await fixture();
		const p = await restorer(f);
		const big = await folder_with_files(f, "/a-big");
		await select(f, p.pairId, big, false, "write");
		const x = await file(f, "root", "/b-x.md");
		const y = await file(f, "root", "/b-y.md");
		// Skip the "Add people" marks, so both files share one scope key. Only the choices tell them apart.
		await select(f, p.pairId, x, true, "write");
		const yConsent = await select(f, p.pairId, y, true, "write");
		await to_trash(f, [big]);
		await to_trash(f, [x, y]);

		// The first job does not end in the request, so the second one waits for it.
		const restored = await restore_as(f, p, [big, x, y]);
		expect(restored.refusals).toEqual([]);
		expect(restored.jobs).toHaveLength(2);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_file_consents", yConsent, { open: false, appliedLevel: null, state: "ended" }),
		);
		expect((await run_to_end(f, restored.jobs[0]!)).activity.status).toBe("succeeded");
		const second = await run_to_end(f, restored.jobs[1]!);
		expect((await read_node(f, y)).archiveOperationId, "the removed choice refuses the second root").not.toBeNull();
		expect(second.activity).toMatchObject({ status: "failed", errorCode: "permission_denied" });
	});

	test.each<[string, (f: Fixture, p: Awaited<ReturnType<typeof plugin>>) => Promise<unknown>]>([
		[
			"an upgrade",
			(f, p) =>
				f.t.run(async (ctx) => {
					const installation = (await ctx.db.get("plugins_workspace_installations", p.installationId))!;
					const { _id, _creationTime, ...version } = (await ctx.db.get(
						"plugins_versions",
						installation.pluginVersionId,
					))!;
					await ctx.db.patch("plugins_workspace_installations", p.installationId, {
						pluginVersionId: await ctx.db.insert("plugins_versions", { ...version, version: "2.0.0" }),
						capabilitiesAcceptedAt: installation.capabilitiesAcceptedAt + 1,
					});
				}),
		],
		[
			"an upgrade and a downgrade back to the same version",
			(f, p) =>
				f.t.run(async (ctx) => {
					const installation = (await ctx.db.get("plugins_workspace_installations", p.installationId))!;
					await ctx.db.patch("plugins_workspace_installations", p.installationId, {
						capabilitiesAcceptedAt: installation.capabilitiesAcceptedAt + 2,
					});
				}),
		],
		["an uninstall", (f, p) => f.t.run((ctx) => ctx.db.delete("plugins_workspace_installations", p.installationId))],
		["a lost file pair", (f, p) => f.t.run((ctx) => ctx.db.delete("plugins_file_pairs", p.pairId))],
		[
			"a leave and re-join",
			(f, p) =>
				f.t.run(async (ctx) => {
					const { _id, _creationTime, ...membership } = (await ctx.db.get(
						"organizations_workspaces_users",
						p.membershipId,
					))!;
					await ctx.db.patch("organizations_workspaces_users", p.membershipId, { active: false });
					const membershipId = await ctx.db.insert("organizations_workspaces_users", membership);
					await organizations_membership_lifetimes_db_ensure(
						ctx,
						(await ctx.db.get("organizations_workspaces_users", membershipId))!,
					);
				}),
		],
	])("%s stops the job before its next write", async (_, change) => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const top = await folder_with_files(f, "/fence");
		await to_trash(f, [top]);

		const restored = await restore_as(f, p, [top]);
		const restoredCount = await count_restored(f, "/fence/");
		expect(restoredCount, "the request restores part of the folder").toBeGreaterThan(0);
		await change(f, p);
		const ended = await run_to_end(f, restored.jobs[0]!);

		// The owner may write every item, so a job that acted as the person would succeed.
		expect(ended.activity, "the job stops on its plugin's pins").toMatchObject({
			status: "failed",
			errorCode: "stopped",
			errorMessage: expect.stringContaining(PLUGIN_LOST),
		});
		expect(await count_restored(f, "/fence/"), "restored items stay, and nothing more is restored").toBe(restoredCount);
		const left = await f.t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			const entryNodeIds = new Set((await ctx.db.query("files_trash_entries").collect()).map((entry) => entry.nodeId));
			const live = new Set(nodes.filter((node) => node.archiveOperationId === null).map((node) => node._id));
			return nodes
				.filter((node) => node.archiveOperationId !== null && live.has(node.parentId as Id<"files_nodes">))
				.map((node) => entryNodeIds.has(node._id));
		});
		expect(left.length).toBeGreaterThan(0);
		expect(left, "each item left in a restored folder gets its Trash entry").not.toContain(false);
	});

	test("a forced restore into a read-only folder needs Read-only management", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const readOnly = await folder(f, "/ro");
		const item = await file(f, readOnly, "/ro/item.md");
		await to_trash(f, [item]);
		await lock({ f, nodeId: readOnly, locked: true });

		expect((await restore_as(f, p, [item])).refusals, "the refusal names no folder").toEqual([
			expect.objectContaining({
				nay: { name: "read_only", message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.read_only },
			}),
		]);
		expect(await restore_as(f, p, [item], { force: true }), "force needs Read-only management").toEqual({
			jobs: [],
			refusals: [expect.objectContaining({ nay: { message: "Permission denied" } })],
		});
		expect((await read_node(f, item)).archiveOperationId).not.toBeNull();

		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", p.installationId, {
				acceptedCapabilities: [
					"workspace.files.read",
					"workspace.files.write",
					"workspace.files.restore",
					"workspace.files.manage-read-only",
				],
			}),
		);
		await restore_as(f, p, [item], { force: true });
		expect((await read_node(f, item)).archiveOperationId, "force with Read-only management restores").toBeNull();
	});

	test("a name clash never waits for an answer", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const kept = await file(f, "root", "/kept.md");
		const skipped = await file(f, "root", "/skipped.md");
		const full = await file(f, "root", "/full.md");
		for (const nodeId of [kept, skipped, full]) await to_trash(f, [nodeId]);
		for (const path of ["/kept.md", "/skipped.md", "/full.md"]) await file(f, "root", path);
		for (let counter = 2; counter <= 100; counter++) await file(f, "root", `/full-${counter}.md`);

		const read_job = async (job: { runId: Id<"files_archive_runs">; activityId: Id<"activities"> }) => ({
			status: (await read_activity(f, job.activityId)).status,
			items: await f.t.run((ctx) =>
				ctx.db
					.query("files_archive_run_items")
					.withIndex("by_run_order", (q) => q.eq("runId", job.runId))
					.collect(),
			),
		});
		const keptBoth = await restore_as(f, p, [kept]);
		expect(await read_job(keptBoth.jobs[0]!), "Keep both lists the new name").toMatchObject({
			status: "succeeded",
			items: [{ kind: "plugin_restore", nodeId: kept, path: "/kept.md", newPath: "/kept-2.md" }],
		});
		const skip = await restore_as(f, p, [skipped], { onConflict: "skip" });
		expect(await read_job(skip.jobs[0]!), "Skip lists the item it leaves in the Trash").toMatchObject({
			status: "succeeded",
			items: [{ kind: "plugin_restore", nodeId: skipped, path: "/skipped.md", newPath: null }],
		});
		expect(await restore_as(f, p, [full]), "no free name fails at once with the fixed message").toEqual({
			jobs: [],
			refusals: [
				expect.objectContaining({
					nay: { name: "name_conflict", message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.name_conflict },
				}),
			],
		});
	});

	test("a small plugin restore keeps its job and pins", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const item = await file(f, "root", "/small.md");
		await to_trash(f, [item]);

		const restored = await restore_as(f, p, [item]);
		expect(restored.jobs, "the job ends in the request").toEqual([expect.objectContaining({ isDone: true })]);
		const job = restored.jobs[0]!;
		const installation = (await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", p.installationId)))!;
		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)), "the job keeps its pins").toMatchObject(
			{
				plugin: {
					installationId: p.installationId,
					filePairId: p.pairId,
					pluginVersionId: installation.pluginVersionId,
					serviceAccountId: installation.serviceAccountId,
					capabilitiesAcceptedAt: installation.capabilitiesAcceptedAt,
				},
			},
		);
		expect((await read_activity(f, job.activityId)).status).toBe("succeeded");
	});
});

describe("files/restore for a plugin run", () => {
	const RESTORE: plugins_Capability[] = ["workspace.files.read", "workspace.files.write", "workspace.files.restore"];

	// A run whose installation and run both accept `capabilities`.
	async function restorer(f: Fixture, options: { member?: boolean; capabilities?: plugins_Capability[] } = {}) {
		const p = await plugin(f, { member: options.member });
		await f.t.run(async (ctx) => {
			const capabilities = options.capabilities ?? RESTORE;
			await ctx.db.patch("plugins_workspace_installations", p.installationId, { acceptedCapabilities: capabilities });
			await ctx.db.patch("plugins_event_runs", p.runId, { acceptedCapabilities: capabilities });
		});
		return p;
	}

	// A later run of the same installation for the same person, with its own token.
	async function second_run(f: Fixture, p: Awaited<ReturnType<typeof plugin>>) {
		const runToken = `plr_${await crypto_sha256_hex(`${p.runId}:again`)}`;
		const runId = await f.t.run(async (ctx) => {
			const installation = (await ctx.db.get("plugins_workspace_installations", p.installationId))!;
			const { _id, _creationTime, ...run } = (await ctx.db.get("plugins_event_runs", p.runId))!;
			const runId = await ctx.db.insert("plugins_event_runs", {
				...run,
				pluginVersionId: installation.pluginVersionId,
				acceptedCapabilities: installation.acceptedCapabilities,
				eventId: "trash-test-again",
				apiTokenHash: await crypto_sha256_hex(runToken),
				apiCallCount: 0,
			});
			await activities_db_start(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: p.userId,
				source: {
					kind: "plugin_run",
					id: runId,
					installationId: p.installationId,
					pluginName: installation.pluginName,
					event: run.event,
				},
				title: "Trash test again",
				targets: [],
				visibility: "shared",
				feedVisible: false,
				status: "running",
				resultKind: "plugin_result",
				deadlineAt: Date.now() + 60 * 60 * 1000,
				now: Date.now(),
			});
			return runId;
		});
		return { ...p, runToken, runId };
	}

	async function job_of(f: Fixture, activityId: Id<"activities">) {
		return { runId: (await read_activity(f, activityId)).source.id, activityId };
	}

	// Claim a call like the HTTP auth does, so a test can call the mutation with other inputs.
	async function claim(f: Fixture, p: Awaited<ReturnType<typeof plugin>>, route = "/api/v1/files/restore") {
		const claimed = await f.t.mutation(internal.plugins_runtime.consume_run_api_call, {
			runId: p.runId,
			kind: "api_request",
			route,
			requiredScope: route === "/api/v1/files/restore" ? "files:restore" : "files:list",
		});
		if (claimed._nay) throw new Error(claimed._nay.message);
		return claimed._yay.callId;
	}

	async function admit(
		f: Fixture,
		p: Awaited<ReturnType<typeof plugin>>,
		args: { callId: Id<"plugins_event_run_calls">; paths: string[]; tokenHash?: string },
	) {
		return await f.t
			.mutation(internal.public_api_files_organize.restore_items, {
				principal: {
					kind: "plugin_run",
					runId: p.runId,
					callId: args.callId,
					tokenHash: args.tokenHash ?? (await crypto_sha256_hex(p.runToken)),
				},
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: p.userId,
				paths: args.paths,
				nodes: [],
				onConflict: "keep_both",
				requestId: crypto.randomUUID(),
			})
			.then(
				(result) => ({ status: 200, jobIds: result.jobIds }),
				(error: unknown) => {
					if (!(error instanceof ConvexError)) throw error;
					return { status: (error.data as { data: { status: number } }).data.status };
				},
			);
	}

	async function restore_runs(f: Fixture) {
		return (await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).filter(
			(run) => run.kind === "restore",
		);
	}

	test("a run with Restore restores an unlabelled item and closes its call", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const item = await file(f, "root", "/unlabelled.md");
		await to_trash(f, [item]);

		const restored = await post(f, p.runToken, "restore", { paths: ["/unlabelled.md"], requestId: "one" });
		expect(restored).toEqual({ status: 200, body: { jobIds: [expect.any(String)], isDone: true, refused: [] } });
		expect((await read_node(f, item)).archiveOperationId, "the item is back").toBeNull();
		const job = await job_of(f, restored.body.jobIds![0]!);
		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)), "the job keeps its pins").toMatchObject(
			{
				plugin: { installationId: p.installationId, filePairId: p.pairId },
				apiRequest: { requestId: `plugin:${p.installationId}:${p.pairId}:one` },
			},
		);
		expect(await calls_of(f, p.runId)).toEqual([
			expect.objectContaining({ route: "/api/v1/files/restore", status: "succeeded", responseStatus: 200 }),
		]);
	});

	test("a file-only choice restores a root file but not a file whose folder the plugin cannot edit", async () => {
		const f = await fixture();
		const p = await restorer(f);
		const rootFile = await file(f, "root", "/granted.md");
		const parent = await folder(f, "/parent");
		const childFile = await file(f, parent, "/parent/granted.md");
		await select(f, p.pairId, rootFile, false, "write");
		await select(f, p.pairId, childFile, false, "write");
		await to_trash(f, [rootFile]);
		await to_trash(f, [childFile]);

		const nodes = [];
		for (const nodeId of [rootFile, childFile]) {
			nodes.push({ nodeId, archiveOperationId: (await read_node(f, nodeId)).archiveOperationId! });
		}
		expect(await post(f, p.runToken, "restore", { nodes, requestId: "file-only" })).toEqual({
			status: 200,
			body: {
				jobIds: [expect.any(String)],
				isDone: true,
				refused: [{ nodeId: childFile, path: null, message: "Permission denied" }],
			},
		});
		expect((await read_node(f, rootFile)).archiveOperationId, "the root file comes back in place").toBeNull();
		expect((await read_node(f, childFile)).archiveOperationId, "its folder needs Edit").not.toBeNull();
	});

	test("a guest's run cannot restore", async () => {
		const f = await fixture();
		const p = await restorer(f, { member: true });
		await select(f, p.pairId, null, true, "write");
		const item = await file(f, "root", "/guest.md");
		await to_trash(f, [item]);
		await f.asOwner.mutation(api.access_control.set_user_role, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: p.userId,
			role: null,
		});

		expect(
			await post(f, p.runToken, "restore", { paths: ["/guest.md"], requestId: "guest" }),
			"guests have no Trash",
		).toMatchObject({ status: 403, body: { message: "Permission denied" } });
		expect((await read_node(f, item)).archiveOperationId).not.toBeNull();
	});

	test("a folder choice restores every item of a multi-step job", async () => {
		const f = await fixture();
		const p = await restorer(f);
		const chosen = await folder(f, "/chosen");
		await select(f, p.pairId, chosen, false, "write");
		const big = await folder_with_files(f, "/chosen/big");
		await to_trash(f, [big]);

		const restored = await post(f, p.runToken, "restore", { paths: ["/chosen/big"], requestId: "big" });
		expect(restored).toMatchObject({ status: 200, body: { jobIds: [expect.any(String)], isDone: false, refused: [] } });
		const ended = await run_to_end(f, await job_of(f, restored.body.jobIds![0]!));
		expect(ended.steps, "the job runs more than one step").toBeGreaterThan(1);
		expect(ended.activity.status).toBe("succeeded");
		expect(await count_restored(f, "/chosen/big/"), "every item comes back").toBe(41);
	});

	test("an upload run needs its source when the restore is accepted, not later", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const source = await file(f, "root", "/source.md");
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_event_runs", p.runId, { event: "files.upload.completed", fileNodeId: source }),
		);
		const big = await folder_with_files(f, "/big");
		const item = await file(f, "root", "/item.md");
		await to_trash(f, [big]);
		await to_trash(f, [item]);

		const restored = await post(f, p.runToken, "restore", { paths: ["/big"], requestId: "big" });
		expect(restored).toMatchObject({ status: 200, body: { isDone: false, refused: [] } });
		await to_trash(f, [source]);
		const ended = await run_to_end(f, await job_of(f, restored.body.jobIds![0]!));
		expect(ended.activity.status, "an accepted job goes on without the source").toBe("succeeded");
		expect(await count_restored(f, "/big/")).toBe(41);

		// The HTTP auth checks the source too. Claim the call directly, so only the mutation's check can refuse.
		expect(await admit(f, p, { callId: await claim(f, p), paths: ["/item.md"] }), "no new work").toEqual({
			status: 401,
		});
		expect((await read_node(f, item)).archiveOperationId, "nothing is restored").not.toBeNull();
		expect(await restore_runs(f), "no job and no receipt").toHaveLength(1);
	});

	test("the restore checks the token hash, the claimed call and Restore consent again", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const item = await file(f, "root", "/item.md");
		await to_trash(f, [item]);
		const withoutRestore: plugins_Capability[] = ["workspace.files.read", "workspace.files.write"];

		// Consent can change after the HTTP auth checked it.
		const runCallId = await claim(f, p);
		await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", p.runId, { acceptedCapabilities: withoutRestore }));
		expect(await admit(f, p, { callId: runCallId, paths: ["/item.md"] }), "the run must still accept Restore").toEqual({
			status: 403,
		});
		await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", p.runId, { acceptedCapabilities: RESTORE }));
		const installationCallId = await claim(f, p);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", p.installationId, { acceptedCapabilities: withoutRestore }),
		);
		expect(
			await admit(f, p, { callId: installationCallId, paths: ["/item.md"] }),
			"the installation must still accept Restore",
		).toEqual({ status: 403 });
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", p.installationId, { acceptedCapabilities: RESTORE }),
		);

		expect(
			await admit(f, p, {
				callId: await claim(f, p),
				paths: ["/item.md"],
				tokenHash: await crypto_sha256_hex("plr_wrong"),
			}),
			"a wrong token hash is refused",
		).toEqual({ status: 401 });
		expect(
			await admit(f, p, { callId: await claim(f, p, "/api/v1/files/trash/list"), paths: ["/item.md"] }),
			"a call claimed for another route is refused",
		).toEqual({ status: 401 });
		expect(await restore_runs(f)).toEqual([]);
		expect(
			(await admit(f, p, { callId: await claim(f, p), paths: ["/item.md"] })).status,
			"the right token and call restore",
		).toBe(200);
	});

	test("a later run gets the same jobs for the same requestId", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const item = await file(f, "root", "/item.md");
		await to_trash(f, [item]);
		const body = { paths: ["/item.md"], requestId: "again" };

		const first = await post(f, p.runToken, "restore", body);
		expect(first.body.jobIds).toHaveLength(1);
		const later = await second_run(f, p);
		expect(await post(f, later.runToken, "restore", body), "the retry names the same jobs").toEqual(first);
		expect(await calls_of(f, later.runId)).toEqual([expect.objectContaining({ status: "succeeded" })]);
	});

	test("a changed body with the same requestId gets 409", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const item = await file(f, "root", "/item.md");
		await to_trash(f, [item]);

		expect((await post(f, p.runToken, "restore", { paths: ["/item.md"], requestId: "same" })).status).toBe(200);
		expect(
			await post(f, p.runToken, "restore", { paths: ["/item.md"], onConflict: "skip", requestId: "same" }),
			"another body cannot reuse the requestId",
		).toMatchObject({ status: 409 });
	});

	test("a retry after a new delete does not restore again", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const item = await file(f, "root", "/item.md");
		await to_trash(f, [item]);
		const body = { paths: ["/item.md"], requestId: "once" };

		const first = await post(f, p.runToken, "restore", body);
		await to_trash(f, [item]);
		expect(await post(f, p.runToken, "restore", body), "the retry answers the first jobs").toEqual(first);
		expect((await read_node(f, item)).archiveOperationId, "the new delete stays").not.toBeNull();
	});

	// A request that refused every item starts no job, so no job holds its receipt. Its retry runs again.
	test("a request that refused every item saves nothing to retry", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");
		const body = { paths: ["/later.md"], requestId: "all-refused" };

		expect(await post(f, p.runToken, "restore", body), "a plugin hears that nothing is in the Trash").toEqual({
			status: 200,
			body: {
				jobIds: [],
				isDone: true,
				refused: [{ path: "/later.md", message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.not_in_trash }],
			},
		});
		const item = await file(f, "root", "/later.md");
		await to_trash(f, [item]);
		expect(await post(f, p.runToken, "restore", body), "the retry runs again").toMatchObject({
			status: 200,
			body: { jobIds: [expect.any(String)], refused: [] },
		});
	});

	test("after an upgrade drops Read-only management, an old forced request still answers", async () => {
		const f = await fixture();
		const p = await restorer(f, { capabilities: [...RESTORE, "workspace.files.manage-read-only"] });
		await select(f, p.pairId, null, true, "write");
		const readOnly = await folder(f, "/ro");
		const item = await file(f, readOnly, "/ro/item.md");
		await to_trash(f, [item]);
		await lock({ f, nodeId: readOnly, locked: true });
		const body = { paths: ["/ro/item.md"], force: true, requestId: "forced" };

		const first = await post(f, p.runToken, "restore", body);
		expect(first).toMatchObject({ status: 200, body: { jobIds: [expect.any(String)], refused: [] } });

		// The new version does not ask for Read-only management. A run of it retries.
		await f.t.run(async (ctx) => {
			const installation = (await ctx.db.get("plugins_workspace_installations", p.installationId))!;
			const { _id, _creationTime, ...version } = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
			await ctx.db.patch("plugins_workspace_installations", p.installationId, {
				pluginVersionId: await ctx.db.insert("plugins_versions", { ...version, version: "2.0.0" }),
				capabilitiesAcceptedAt: installation.capabilitiesAcceptedAt + 1,
				acceptedCapabilities: RESTORE,
			});
		});
		const upgraded = await second_run(f, p);
		expect(await post(f, upgraded.runToken, "restore", body), "the old forced request keeps its jobs").toEqual(first);
		expect(
			await post(f, upgraded.runToken, "restore", { ...body, requestId: "forced-again" }),
			"a new forced request needs Read-only management",
		).toMatchObject({ status: 403, body: { message: "Permission denied" } });
	});

	test("answers name only the paths the plugin sent and can read now", async () => {
		const f = await fixture();
		const p = await restorer(f);
		const chosen = await folder(f, "/chosen");
		const consentId = await select(f, p.pairId, chosen, false, "write");
		const readOnly = await folder(f, "/chosen/ro");
		const blocked = await file(f, readOnly, "/chosen/ro/blocked.md");
		const kept = await file(f, chosen, "/chosen/kept.md");
		const changed = await file(f, chosen, "/chosen/changed.md");
		const secret = await file(f, "root", "/secret.md");
		for (const nodeId of [blocked, kept, changed, secret]) await to_trash(f, [nodeId]);
		await lock({ f, nodeId: readOnly, locked: true });

		const byNodes = await post(f, p.runToken, "restore", {
			nodes: [
				{ nodeId: changed, archiveOperationId: "an-older-delete" },
				{ nodeId: secret, archiveOperationId: (await read_node(f, secret)).archiveOperationId! },
			],
			requestId: "by-nodes",
		});
		expect(byNodes.body, "a node never gets a path").toEqual({
			jobIds: [],
			isDone: true,
			refused: [
				{ nodeId: changed, path: null, message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.changed },
				{ nodeId: secret, path: null, message: "Permission denied" },
			],
		});
		expect(JSON.stringify(byNodes.body)).not.toMatch(/\/chosen|\/secret/u);

		const body = { paths: ["/chosen/ro/blocked.md", "/chosen/kept.md", "/chosen/missing.md"], requestId: "by-paths" };
		const first = await post(f, p.runToken, "restore", body);
		expect(first.body, "a path is only the one the plugin sent").toEqual({
			jobIds: [expect.any(String)],
			isDone: true,
			refused: [
				{ path: "/chosen/missing.md", message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.not_in_trash },
				{
					nodeId: blocked,
					path: "/chosen/ro/blocked.md",
					message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.read_only,
				},
			],
		});

		await f.t.run((ctx) =>
			ctx.db.patch("plugins_file_consents", consentId, { open: false, appliedLevel: null, state: "ended" }),
		);
		const retry = await post(f, p.runToken, "restore", body);
		expect(retry.body, "a retry hides the paths the plugin cannot read now").toEqual({
			jobIds: first.body.jobIds,
			isDone: true,
			refused: [
				{ path: null, message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.not_in_trash },
				{ nodeId: blocked, path: null, message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.read_only },
			],
		});
		expect(JSON.stringify(retry.body)).not.toMatch(/\/chosen/u);
	});

	test("an item that another job is restoring answers busy only when the plugin can read it", async () => {
		const f = await fixture();
		const p = await restorer(f);
		const area = await folder(f, "/area");
		await select(f, p.pairId, area, false, "write");
		const big = await folder_with_files(f, "/area/big");
		const other = await file(f, "root", "/other.md");
		// One delete, so both items wait for the same restore job.
		await to_trash(f, [big, other]);

		const restoring = await post(f, p.runToken, "restore", { paths: ["/area/big"], requestId: "big" });
		const job = await job_of(f, restoring.body.jobIds![0]!);
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))?.phase).toBe("apply");
		const child = (await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).find(
			(node) => node.treePath.startsWith("/area/big/") && node.archiveOperationId !== null,
		)!;

		const operationId = child.archiveOperationId!;
		expect(
			await post(f, p.runToken, "restore", {
				nodes: [
					{ nodeId: child._id, archiveOperationId: operationId },
					{ nodeId: other, archiveOperationId: operationId },
				],
				requestId: "during",
			}),
			"only the item the plugin can read says busy",
		).toEqual({
			status: 200,
			body: {
				jobIds: [],
				isDone: true,
				// Access refusals come first. "Busy" comes from the job start, which runs after them.
				refused: [
					{ nodeId: other, path: null, message: "Permission denied" },
					{ nodeId: child._id, path: null, message: files_archive_runs_PLUGIN_RESTORE_MESSAGES.busy },
				],
			},
		});
	});

	test("a dry run undoes everything and needs no file read capability", async () => {
		const f = await fixture();
		const p = await restorer(f, { capabilities: ["workspace.files.write", "workspace.files.restore"] });
		await select(f, p.pairId, null, true, "write");
		const clash = await file(f, "root", "/clash.md");
		const big = await folder_with_files(f, "/big");
		await to_trash(f, [clash]);
		await to_trash(f, [big]);
		await file(f, "root", "/clash.md");
		const count_saved = () =>
			f.t.run(async (ctx) => ({
				runs: (await ctx.db.query("files_archive_runs").collect()).length,
				activities: (await ctx.db.query("activities").collect()).length,
				scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
			}));
		const before = await count_saved();

		expect(await post(f, p.runToken, "restore", { paths: ["/clash.md"], dryRun: true })).toEqual({
			status: 200,
			body: {
				dryRun: true,
				complete: true,
				refused: [],
				jobs: [
					expect.objectContaining({
						status: "succeeded",
						refused: [],
						renamed: [{ path: "/clash.md", newPath: "/clash-2.md" }],
						hasMoreItems: false,
					}),
				],
			},
		});
		expect(await post(f, p.runToken, "restore", { paths: ["/big"], dryRun: true }), "a big delete").toMatchObject({
			status: 200,
			body: { complete: false },
		});
		expect(await count_saved(), "no job, Activity or step is saved").toEqual(before);
		expect((await read_node(f, clash)).archiveOperationId).not.toBeNull();
		expect(await count_restored(f, "/big/")).toBe(0);
		expect(await calls_of(f, p.runId), "each dry run closes its call").toEqual([
			expect.objectContaining({ status: "succeeded", responseStatus: 200 }),
			expect.objectContaining({ status: "succeeded", responseStatus: 200 }),
		]);
	});

	test("every claimed call is closed, also on early answers and errors", async () => {
		const f = await fixture();
		const p = await restorer(f);
		await select(f, p.pairId, null, true, "write");

		expect((await post(f, p.runToken, "restore", { requestId: "no-items" })).status).toBe(400);
		await f.t.run(async (ctx) => {
			while (!(await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: p.userId })));
		});
		expect((await post(f, p.runToken, "restore", { paths: ["/a.md"], requestId: "limited" })).status).toBe(429);
		await reset_rate_limits(f.t, [p.userId]);
		test_spy_handler(restore_items, async () => {
			throw new Error("Restore broke");
		});
		await f.t
			.fetch("/api/v1/files/restore", {
				method: "POST",
				headers: { Authorization: `Bearer ${p.runToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ paths: ["/a.md"], requestId: "broken" }),
			})
			.catch(() => null);

		expect(await calls_of(f, p.runId), "each call is closed with its answer").toEqual([
			expect.objectContaining({ status: "failed", responseStatus: 400, errorCode: "invalid_input" }),
			expect.objectContaining({ status: "failed", responseStatus: 429, errorCode: "rate_limited" }),
			expect.objectContaining({ status: "failed", responseStatus: 500, errorCode: "internal_error" }),
		]);
	});

	test("100 items for a member's pair fit in one answer", async () => {
		const f = await fixture();
		const p = await restorer(f, { member: true });
		await select(f, p.pairId, null, true, "write");
		// Each path comes from its own delete, so each one starts its own job.
		const paths = [];
		for (let index = 0; index < 100; index++) {
			const name = `m${String(index).padStart(3, "0")}.md`;
			await test_run_with_flush(f.t, (ctx) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: "root",
					kind: "file",
					name,
					sortName: name,
					path: `/${name}`,
					treePath: `/${name}`,
					pathDepth: 1,
					archiveOperationId: crypto.randomUUID(),
					archivedPath: `/${name}`,
				}),
			);
			paths.push(`/${name}`);
		}

		let cost: ReturnType<typeof transaction_cost> | null = null;
		test_spy_handler(restore_items, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
			expect_under_convex_limits(cost);
			return result;
		});
		const response = await post(f, p.runToken, "restore", { paths, requestId: "most" });
		expect(response).toMatchObject({ status: 200, body: { refused: [] } });
		expect(response.body.jobIds).toHaveLength(100);
		// The request checks the pins once, not once per job: about 1,400 queries instead of 3,200. Keep it
		// under 2,048 like a member's key, so items in restricted folders still have room.
		expect(cost!.databaseQueries, "a pair checks its pins once per request").toBeLessThan(2048);
	});

	describe("jobs/get", () => {
		// Restore one item as `p` and return its job id. The pair needs Edit on `parentId`.
		async function restored_job(
			f: Fixture,
			p: Awaited<ReturnType<typeof plugin>>,
			parentId: Id<"files_nodes"> | "root",
			path: string,
		) {
			const item = await file(f, parentId, path);
			await to_trash(f, [item]);
			const restored = await post(f, p.runToken, "restore", { paths: [path], requestId: path });
			expect(restored.body.jobIds, "the restore starts one job").toHaveLength(1);
			return restored.body.jobIds![0]!;
		}

		test("a page and a later run read the job, and a foreign job looks not found", async () => {
			const f = await fixture();
			const p = await restorer(f);
			await select(f, p.pairId, null, true, "write");
			const jobId = await restored_job(f, p, "root", "/mine.md");
			const later = await second_run(f, p);
			for (const token of [p.token, later.runToken]) {
				expect(await post(f, token, "jobs/get", { jobId }), "the pair's page and later run read its job").toEqual({
					status: 200,
					body: expect.objectContaining({
						jobId,
						kind: "restore",
						status: "succeeded",
						refused: [],
						refusedCursor: null,
					}),
				});
			}

			// Each job differs from the caller's own in one pin only.
			const other = await plugin(f);
			const member = await add_member(f);
			const installationJob = await restored_job(f, p, "root", "/installation.md");
			const pairJob = await restored_job(f, p, "root", "/pair.md");
			const personJob = await restored_job(f, p, "root", "/person.md");
			const appJob = await restored_job(f, p, "root", "/app.md");
			for (const [activityId, change] of [
				[installationJob, { installationId: other.installationId }],
				[pairJob, { filePairId: other.pairId }],
				[personJob, {}],
				[appJob, null],
			] as const) {
				const { runId } = await job_of(f, activityId);
				await f.t.run(async (ctx) => {
					const run = (await ctx.db.get("files_archive_runs", runId))!;
					await ctx.db.patch("files_archive_runs", runId, {
						plugin: change ? { ...run.plugin!, ...change } : undefined,
						...(activityId === personJob ? { userId: member.userId } : {}),
					});
				});
			}
			// A big folder, so the delete runs as a job.
			const deleted = await archive(f, [await folder_with_files(f, "/deleted")]);
			for (const [name, foreignJobId] of [
				["another installation", installationJob],
				["another pair", pairJob],
				["another person", personJob],
				["the app or a key", appJob],
				["a delete", deleted._yay!.activityId],
				["no such id", "not-an-id"],
			] as const) {
				expect(await post(f, later.runToken, "jobs/get", { jobId: foreignJobId }), `${name}: not found`).toEqual({
					status: 404,
					body: { message: "Job not found" },
				});
			}
			expect(
				(await calls_of(f, later.runId)).every((call) => call.status !== "started"),
				"every job read closes its call",
			).toBe(true);
		});

		test("a stopped job of an older version stays readable with a fixed message", async () => {
			const f = await fixture();
			const p = await restorer(f);
			await select(f, p.pairId, null, true, "write");
			const big = await folder_with_files(f, "/big");
			await to_trash(f, [big]);
			const restored = await post(f, p.runToken, "restore", { paths: ["/big"], requestId: "big" });
			const jobId = restored.body.jobIds![0]!;

			await f.t.run(async (ctx) => {
				const installation = (await ctx.db.get("plugins_workspace_installations", p.installationId))!;
				const { _id, _creationTime, ...version } = (await ctx.db.get(
					"plugins_versions",
					installation.pluginVersionId,
				))!;
				await ctx.db.patch("plugins_workspace_installations", p.installationId, {
					pluginVersionId: await ctx.db.insert("plugins_versions", { ...version, version: "2.0.0" }),
					capabilitiesAcceptedAt: installation.capabilitiesAcceptedAt + 1,
				});
			});
			expect((await run_to_end(f, await job_of(f, jobId))).activity.status, "the upgrade stops the job").toBe("failed");

			const upgraded = await second_run(f, p);
			expect(await post(f, upgraded.runToken, "jobs/get", { jobId }), "the new version reads the old job").toEqual({
				status: 200,
				body: expect.objectContaining({
					status: "failed",
					// The Activity's own message names the plugin. A plugin gets the fixed message of the code.
					errorMessage: files_archive_runs_PLUGIN_RESTORE_MESSAGES.stopped,
					refused: [
						{ path: expect.stringMatching(/^\/big\//u), message: expect.stringContaining("still in the Trash") },
					],
				}),
			});
		});

		test("outcomes page 100 at a time, with locked rows kept and sealed cursors", async () => {
			const f = await fixture();
			const p = await restorer(f);
			const chosen = await folder(f, "/chosen");
			await select(f, p.pairId, chosen, false, "write");
			const seen = await file(f, chosen, "/chosen/seen.md");
			const hidden = await file(f, "root", "/hidden.md");
			const jobId = await restored_job(f, p, chosen, "/chosen/item.md");
			const otherJobId = await restored_job(f, p, chosen, "/chosen/other.md");

			// 205 outcomes. The first 110 name an item the pair cannot read. Even orders are Keep both.
			const name_of = (order: number) => (order < 110 ? `/hidden-${order}.md` : `/chosen/seen-${order}.md`);
			const { runId } = await job_of(f, jobId);
			await f.t.run(async (ctx) => {
				for (let order = 0; order < 205; order++) {
					await ctx.db.insert("files_archive_run_items", {
						runId,
						order,
						kind: "plugin_restore",
						nodeId: order < 110 ? hidden : seen,
						path: name_of(order),
						newPath: order % 2 ? null : `${name_of(order)}-2`,
					});
				}
			});

			const pages = [];
			const cursors: Array<string | null> = [null];
			for (const token of [p.runToken, p.token, (await second_run(f, p)).runToken]) {
				const page = await post(f, token, "jobs/get", { jobId, cursor: cursors.at(-1) });
				expect(page.status, "the pair's run, page and later run go on reading").toBe(200);
				pages.push(page.body);
				cursors.push(page.body.refusedCursor ?? null);
			}
			expect(cursors.at(-1), "three pages hold every outcome").toBeNull();
			expect(
				pages.map((page) => page.refused!.length + page.renamed!.length),
				"each page holds 100 outcomes",
			).toEqual([100, 100, 5]);
			expect(pages[0]!.renamed, "a locked Keep both still counts as renamed").toEqual(
				Array(50).fill({ path: null, newPath: null }),
			);
			expect(pages[0]!.refused, "locked rows keep their place with null paths").toEqual(
				Array(50).fill({ path: null, message: expect.any(String) }),
			);
			const named = pages.flatMap((page) => [...page.refused!, ...page.renamed!].flatMap((row) => row.path ?? []));
			expect(named.sort(), "every readable outcome comes once").toEqual(
				Array.from({ length: 95 }, (_, index) => name_of(110 + index)).sort(),
			);
			expect(JSON.stringify(pages)).not.toMatch(/hidden/u);

			const other = await restorer(f);
			for (const [name, token, body] of [
				["a cursor of another job", p.runToken, { jobId: otherJobId, cursor: cursors[1] }],
				["a cursor read by another pair", other.runToken, { jobId, cursor: cursors[1] }],
				["a key's cursor", p.runToken, { jobId, cursor: "items:99" }],
			] as const) {
				expect(await post(f, token, "jobs/get", body), `${name} is refused`).toEqual({
					status: 400,
					body: { message: "This job cursor changed. Start a new page.", errorCode: "invalid_cursor" },
				});
			}
			expect((await calls_of(f, p.runId)).at(-1), "the call keeps the cursor error code").toMatchObject({
				status: "failed",
				responseStatus: 400,
				errorCode: "invalid_cursor",
			});
		});

		test("the job read checks the caller again in its own snapshot", async () => {
			const f = await fixture();
			const p = await restorer(f);
			await select(f, p.pairId, null, true, "write");
			const jobId = await restored_job(f, p, "root", "/item.md");
			const read = async (
				principal: FunctionArgs<typeof internal.public_api_files_organize.get_plugin_restore_job>["principal"],
				now = Date.now(),
			) =>
				(
					await f.t.query(internal.public_api_files_organize.get_plugin_restore_job, {
						principal,
						now,
						jobId,
						cursor: null,
					})
				).status;
			// Claim a call like the HTTP auth does, so only the query's own checks can refuse.
			const run = async () => ({
				kind: "plugin_run" as const,
				runId: p.runId,
				callId: await claim(f, p, "/api/v1/files/jobs/get"),
				tokenHash: await crypto_sha256_hex(p.runToken),
			});

			expect(await read(await run()), "the right token and call read the job").toBe("found");
			expect(
				await read({ ...(await run()), tokenHash: await crypto_sha256_hex("plr_wrong") }),
				"a wrong run token hash is refused",
			).toBe("unauthenticated");
			expect(
				await read({ ...(await run()), callId: await claim(f, p) }),
				"a call claimed for another route is refused",
			).toBe("unauthenticated");
			const withoutRead: plugins_Capability[] = ["workspace.files.write", "workspace.files.restore"];
			const claimed = await run();
			await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", p.runId, { acceptedCapabilities: withoutRead }));
			expect(await read(claimed), "the run must still accept file reads").toBe("permission_denied");
			await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", p.runId, { acceptedCapabilities: RESTORE }));

			const session = (await f.t.run((ctx) => ctx.db.query("plugins_ui_sessions").collect())).find(
				(row) => row.filePairId === p.pairId,
			)!;
			const page = { kind: "plugin_ui" as const, sessionId: session._id, tokenHash: await crypto_sha256_hex(p.token) };
			expect(await read(page), "the page reads the job").toBe("found");
			expect(await read(page, session.expiresAt), "the clock from the HTTP action ends the session").toBe(
				"unauthenticated",
			);
			// A refresh rotates the token on the same session and moves its expiry later.
			const rotatedHash = await crypto_sha256_hex("plu_rotated");
			await f.t.run((ctx) =>
				ctx.db.patch("plugins_ui_sessions", session._id, {
					tokenHash: rotatedHash,
					expiresAt: session.expiresAt + 1000,
				}),
			);
			expect(await read(page), "the token from before the refresh is refused").toBe("unauthenticated");
			const rotated = { ...page, tokenHash: rotatedHash };
			expect(await read(rotated), "the new token reads the job").toBe("found");
			await f.t.run((ctx) =>
				ctx.db.patch("plugins_workspace_installations", p.installationId, { acceptedCapabilities: withoutRead }),
			);
			expect(await read(rotated), "the installation must still accept file reads").toBe("permission_denied");
			await f.t.run((ctx) =>
				ctx.db.patch("plugins_workspace_installations", p.installationId, { acceptedCapabilities: RESTORE }),
			);

			// An upload run's authority ends with its source file.
			const source = await file(f, "root", "/source.md");
			await f.t.run((ctx) =>
				ctx.db.patch("plugins_event_runs", p.runId, { event: "files.upload.completed", fileNodeId: source }),
			);
			expect(await read(await run()), "an upload run with its source reads the job").toBe("found");
			// Claim first: the HTTP auth refuses a new call once the source is gone.
			const lateCall = await run();
			await to_trash(f, [source]);
			expect(await read(lateCall), "an upload run without its source is refused").toBe("unauthenticated");
		});

		test("a guest's page cannot read Trash jobs", async () => {
			const f = await fixture();
			const p = await restorer(f, { member: true });
			await select(f, p.pairId, null, true, "write");
			const jobId = await restored_job(f, p, "root", "/guest.md");
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: p.userId,
				role: null,
			});

			expect(await post(f, p.token, "jobs/get", { jobId }), "guests have no Trash").toEqual({
				status: 403,
				body: { message: "Permission denied" },
			});
		});

		test("every claimed call is closed, also on early answers and errors", async () => {
			const f = await fixture();
			const p = await restorer(f);
			await select(f, p.pairId, null, true, "write");
			const jobId = await restored_job(f, p, "root", "/item.md");
			const reader = await second_run(f, p);

			expect((await post(f, reader.runToken, "jobs/get", {})).status).toBe(400);
			expect((await post(f, reader.runToken, "jobs/get", { jobId: "not-an-id" })).status).toBe(404);
			expect((await post(f, reader.runToken, "jobs/get", { jobId })).status).toBe(200);
			test_spy_handler(get_plugin_restore_job, async () => {
				throw new Error("Job read broke");
			});
			await f.t
				.fetch("/api/v1/files/jobs/get", {
					method: "POST",
					headers: { Authorization: `Bearer ${reader.runToken}`, "Content-Type": "application/json" },
					body: JSON.stringify({ jobId }),
				})
				.catch(() => null);

			expect(await calls_of(f, reader.runId), "each call is closed with its answer").toEqual([
				expect.objectContaining({ status: "failed", responseStatus: 400, errorCode: "invalid_input" }),
				expect.objectContaining({ status: "failed", responseStatus: 404, errorCode: "not_found" }),
				expect.objectContaining({ status: "succeeded", responseStatus: 200 }),
				expect.objectContaining({ status: "failed", responseStatus: 500, errorCode: "internal_error" }),
			]);
		});

		// R2-9: the largest first page. 100 outcomes, 100 refusals saved by the request and 100 selected roots
		// to search for an unfinished item, all on items the member's pair cannot read. Each item sits at the
		// bottom of its own chain of 64 folders, and each folder is its own delete.
		test("the largest status page fits in one transaction", async () => {
			const f = await fixture();
			const p = await restorer(f, { member: true });
			const seed = await folder(f, "/seed");
			await select(f, p.pairId, seed, false, "write");
			const jobId = await restored_job(f, p, seed, "/seed/item.md");

			const chains: Array<{
				top: Id<"files_nodes">;
				topTreePath: string;
				outcome: Id<"files_nodes">;
				refusal: Id<"files_nodes">;
				path: string;
			}> = [];
			for (let chain = 0; chain < 100; chain++) {
				chains.push(
					await test_run_with_flush(f.t, async (ctx) => {
						const base = {
							...test_mocks.files.base(),
							organizationId: f.db.organizationId,
							workspaceId: f.db.workspaceId,
							createdBy: f.db.userId,
							updatedBy: f.db.userId,
						};
						const insert = (
							parentId: Id<"files_nodes"> | "root",
							kind: "file" | "folder",
							path: string,
							pathDepth: number,
						) => {
							const name = path.split("/").at(-1)!;
							return ctx.db.insert("files_nodes", {
								...base,
								parentId,
								kind,
								name,
								sortName: name,
								path,
								treePath: kind === "folder" ? `${path}/` : path,
								pathDepth,
								// Its own delete: its folder was deleted by another one.
								archiveOperationId: files_archive_operation_id_new(Date.now()),
								archivedPath: path,
							});
						};
						let parentId: Id<"files_nodes"> | "root" = "root";
						let path = "";
						let top: Id<"files_nodes"> | null = null;
						for (let level = 1; level <= 64; level++) {
							path += level === 1 ? `/c${chain}` : "/x";
							parentId = await insert(parentId, "folder", path, level);
							top ??= parentId;
						}
						return {
							top: top!,
							topTreePath: `/c${chain}/`,
							outcome: await insert(parentId, "file", `${path}/outcome.md`, 65),
							refusal: await insert(parentId, "file", `${path}/refusal.md`, 65),
							path,
						};
					}),
				);
			}
			const { runId, activityId } = await job_of(f, jobId);
			await f.t.run(async (ctx) => {
				const run = (await ctx.db.get("files_archive_runs", runId))!;
				await ctx.db.patch("files_archive_runs", runId, {
					restoreRoots: chains.map((chain) => ({ nodeId: chain.top, treePath: chain.topTreePath })),
					apiRequest: {
						...run.apiRequest!,
						refused: chains.map((chain) => ({
							nodeId: chain.refusal,
							path: `${chain.path}/refusal.md`,
							message: "Permission denied",
						})),
					},
				});
				for (const [order, chain] of chains.entries()) {
					await ctx.db.insert("files_archive_run_items", {
						runId,
						order,
						kind: "plugin_restore",
						nodeId: chain.outcome,
						path: `${chain.path}/outcome.md`,
						newPath: order % 2 ? null : `${chain.path}/outcome-2.md`,
					});
				}
				// Only a stopped job searches its selected roots for an unfinished item.
				await ctx.db.patch("activities", activityId, {
					status: "failed",
					errorCode: "stopped",
					errorMessage: "Stopped",
				});
			});

			let cost: ReturnType<typeof transaction_cost> | null = null;
			test_spy_handler(get_plugin_restore_job, async (handler, ctx, args) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await handler(ctx, args);
				cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
				return result;
			});
			const response = await post(f, p.runToken, "jobs/get", { jobId });
			expect(response.status).toBe(200);
			expect(
				[...response.body.refused!, ...response.body.renamed!].every((row) => row.path === null),
				"no row names an item the pair cannot read",
			).toBe(true);
			expect(response.body.refused, "100 refusals and 50 skipped items").toHaveLength(150);
			expect(response.body.renamed, "50 renamed items").toHaveLength(50);
			expect_under_convex_limits(cost!);
			// Measured on 2026-11-10: 1,345 queries, 1,042 docs and 1.2 MB. Keep half of the 4,096 query limit
			// free, so a slower check shows here before it reaches the limit.
			expect(cost!.databaseQueries, "the largest status page stays far below the query limit").toBeLessThan(2048);
		});
	});
});
