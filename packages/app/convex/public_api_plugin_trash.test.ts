import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { activities_db_start } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { list_plugin_trash_areas_page } from "./public_api_files_organize.ts";
import { fixture, add_member, folder, archive, run_to_end, type Fixture } from "./files_archive_runs.setup.test.ts";
import { insert_installation, reset_rate_limits } from "./files_share_links.setup.test.ts";
import {
	test_finish_saved_scope_jobs,
	test_mocks,
	test_move_nodes,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function plugin(f: Fixture, options: { member?: boolean; legacy?: boolean; scheduled?: boolean } = {}) {
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
			fileAccessModel: options.legacy ? undefined : "personal",
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
		const pin = options.legacy ? {} : { filePairId: pairId };
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			pluginVersionId: version._id,
			serviceAccountId: installation.serviceAccountId,
			...pin,
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
			...pin,
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
	rootNodeId: Id<"files_nodes">,
	areaEligible = false,
) {
	const consentId = await f.t.run((ctx) =>
		ctx.db.insert("plugins_file_consents", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			pairId,
			rootNodeId,
			requestedLevel: "read",
			appliedLevel: "read",
			areaEligible,
			open: true,
			revision: 1,
			state: "applied",
			endedReason: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	if (!areaEligible) {
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

async function post(f: Fixture, token: string, route: "list" | "areas" | "restore", body: unknown = {}) {
	const response = await f.t.fetch(`/api/v1/files/${route === "restore" ? route : `trash/${route}`}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as {
			message?: string;
			errorCode?: string;
			cursor?: string | null;
			isDone?: boolean;
			areas?: Array<{ areaNodeId: string | null; path: string }>;
			items?: Array<{ nodeId: string; changedBy: string | null; locked: boolean }>;
		},
	};
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
			"plugin Restore remains closed",
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
	const roots: Id<"files_nodes">[] = [];
	for (let i = 0; i < 7; i++) {
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
	"%s refuses guests, legacy plugins, missing capability and scheduled runs",
	async (route) => {
		const f = await fixture();
		const guest = await plugin(f, { member: true });
		const root = await folder(f, "/guest-folder");
		await select(f, guest.pairId, root);
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
		const legacy = await plugin(f, { legacy: true });
		expect(
			(await post(f, legacy.token, route)).body.message,
			"legacy credentials get a clear migration message",
		).toContain("personal file permissions");
		const scheduled = await plugin(f, { scheduled: true });
		expect(await post(f, scheduled.runToken, route), "scheduled Trash gives a clear refusal").toMatchObject({
			status: 403,
			body: { message: "Scheduled plugin runs cannot use Trash yet." },
		});
		const noCapability = await plugin(f);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", noCapability.installationId, { acceptedCapabilities: [] }),
		);
		expect((await post(f, noCapability.token, route)).status, "file read capability is required").toBe(403);
	},
);

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
