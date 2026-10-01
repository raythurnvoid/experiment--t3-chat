import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { activities_db_finish, activities_db_start } from "./activities_db.ts";
import { plugins_schedules_db_cancel, plugins_scheduled_runs_workpool } from "./plugins_schedules_db.ts";
import { plugins_runtime_db_enqueue_manual_run } from "./plugins_runtime.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import * as crypto_utils from "../server/crypto-utils.ts";
import { z } from "zod";
import type { api_schemas_Main } from "../shared/api-schemas.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 500 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

type Membership = Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;

async function fixture(
	options: {
		t?: ReturnType<typeof test_convex>;
		owner?: Membership;
		name?: string;
		workspaceName?: string;
		scopes?: NonNullable<Doc<"access_control_permission_grants">["runAs"]>["scopes"];
	} = {},
) {
	const t = options.t ?? test_convex();
	const name = options.name ?? "schedule-test";
	const owner =
		options.owner ??
		(await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: `${name}-team`,
				workspaceName: options.workspaceName,
			}),
		));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const capabilities = [
		"plugin.schedule.run",
		"workspace.files.read",
		"plugin.data.read",
		"plugin.data.write",
		"workspace.volumes.write",
		"plugin.secrets.read",
		"outbound.fetch",
	] as const;
	const pluginVersionId = await t.run((ctx) =>
		ctx.db.insert("plugins_versions", {
			name,
			displayName: "Schedule test",
			version: "0.1.0",
			description: "Scheduled test data",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: `https://github.com/example/${name}`,
			sourceOwner: "example",
			sourceRepo: name,
			sourceCommitSha: "a".repeat(40),
			manifestR2Key: `plugins/${name}/manifest.json`,
			backendEntrypointFile: {
				entry: "backend.js",
				moduleName: "backend",
				r2Key: `${name}/backend.js`,
				sha256: "a".repeat(64),
				compatibilityDate: "2026-01-01",
				compatibilityFlags: [],
			},
			configuration: { description: "Schedule", defaultYaml: "schedule:\n  everyMinutes: 15\n" },
			mounts: [],
			events: [
				{
					type: "schedule.interval.elapsed",
					contentTypes: [],
					filters: [],
					schedule: { configurationPath: ["schedule", "everyMinutes"] },
				},
			],
			capabilities: [...capabilities],
			endpoints: [],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "schedule-mcp",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: owner.userId,
			updatedAt: Date.now(),
		}),
	);
	await t.run((ctx) =>
		ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: owner.userId }),
	);
	const installed = await asOwner.mutation(api.plugins.install_version, {
		membershipId: owner.membershipId,
		pluginVersionId,
		acceptedCapabilities: [...capabilities],
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		acceptedMcpServersFingerprint: "schedule-mcp",
		acceptedSkillNames: [],
		scheduledRun: {
			kind: "me",
			scopes: options.scopes ?? [
				"files:read",
				"files:list",
				"plugin_data:read",
				"plugin_data:write",
				"volumes:write",
				"secrets:read",
				"outbound:fetch",
			],
			filesReadProof: { kind: "workspace" },
		},
	});
	if (installed._nay) throw new Error(installed._nay.message);
	const installationId = installed._yay.installationId;
	const handler = await t.run((ctx) =>
		ctx.db
			.query("plugins_workspace_event_handlers")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.unique(),
	);
	if (!handler) throw new Error("Expected schedule handler");
	await t.run((ctx) => ctx.db.patch("plugins_workspace_event_handlers", handler._id, { nextRunAt: Date.now() }));
	return { t, owner, asOwner, installationId, pluginVersionId, handlerId: handler._id, name };
}

async function root_run(f: Awaited<ReturnType<typeof fixture>>) {
	await f.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
	const run = await f.t.run((ctx) =>
		ctx.db
			.query("plugins_event_runs")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", f.owner.organizationId).eq("workspaceId", f.owner.workspaceId),
			)
			.first(),
	);
	if (!run) throw new Error("Expected scheduled root run");
	return run;
}

async function assign_member(
	f: Awaited<ReturnType<typeof fixture>>,
	options: {
		management?: "user" | "role";
		scopes?: NonNullable<Doc<"access_control_permission_grants">["runAs"]>["scopes"];
	} = {},
) {
	const member = await f.t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asMember = f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
	expect(
		await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			userIdToAdd: member.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await f.t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", f.owner.workspaceId).eq("userId", member.userId).eq("active", true),
			)
			.unique(),
	);
	if (!membership) throw new Error("Expected member workspace");
	if (options.management) {
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.owner.userId }),
		);
		expect(
			await f.asOwner.mutation(api.plugins_access.update_installation_access, {
				membershipId: f.owner.membershipId,
				installationId: f.installationId,
				mode: "selected",
				principals:
					options.management === "role"
						? [{ kind: "role", role: "member" }]
						: [{ kind: "user", userId: member.userId }],
			}),
		).toEqual({ _yay: null });
	}
	const grant = await asMember.mutation(api.plugins_access.grant_run_as_me, {
		membershipId: membership._id,
		installationId: f.installationId,
		scopes: options.scopes ?? ["plugin_data:read"],
	});
	if (grant._nay) throw new Error(grant._nay.message);
	await f.t.run((ctx) =>
		ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.owner.userId }),
	);
	expect(
		await f.asOwner.mutation(api.plugins_access.set_scheduled_run_user, {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			userId: member.userId,
			grantId: grant._yay.grantId,
		}),
	).toEqual({ _yay: null });
	return { member, membership, asMember, grantId: grant._yay.grantId };
}

async function start_run(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"plugins_event_runs">) {
	const token = `plr_${await crypto_sha256_hex(runId)}`;
	const tokenHash = await crypto_sha256_hex(token);
	const started = await f.t.mutation(internal.plugins_runtime.start_event_run, { runId, apiTokenHash: tokenHash });
	if (started._nay) throw new Error(started._nay.message);
	return { token, tokenHash, run: started._yay.pluginRun };
}

async function follow_up(f: Awaited<ReturnType<typeof fixture>>, token: string, state: string) {
	return await f.t.fetch("/api/v1/plugin-runs/follow-up", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ state }),
	});
}

const successful_outcome = {
	kind: "runner_response",
	runnerOk: true,
	runnerHttpStatus: 200,
	bodyStatus: "succeeded",
	runnerErrorMessage: null,
	pluginStatus: 200,
} as const;

describe("dispatch_due_schedules", () => {
	test("queues a hidden root with exact consent and membership pins", async () => {
		const f = await fixture();
		const run = await root_run(f);
		const saved = await f.t.run(async (ctx) => ({
			installation: await ctx.db.get("plugins_workspace_installations", f.installationId),
			activity: await ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", run._id))
				.unique(),
			handler: await ctx.db.get("plugins_workspace_event_handlers", f.handlerId),
		}));
		expect(run).toMatchObject({
			event: "schedule.interval.elapsed",
			eventId: `schedule:${f.installationId}:${Date.now()}`,
			actorUserId: f.owner.userId,
			runAsGrantId: saved.installation?.scheduledRunGrantId,
			runAsMembershipId: f.owner.membershipId,
			runAsMembershipLifetime: 1,
			chainRootRunId: run._id,
			chainIndex: 0,
			chainInputState: null,
			scheduleIntervalMinutes: 15,
			scheduleDueAt: Date.now(),
			serializationKey: "schedule",
		});
		expect(run.assetId).toBeUndefined();
		expect(run.fileNodeId).toBeUndefined();
		expect(run.workId).toBeDefined();
		expect(saved.activity).toMatchObject({
			status: "queued",
			userId: f.owner.userId,
			visibility: "requester",
			feedVisible: false,
			targets: [],
			deadlineAt: Date.now() + 10 * 60_000,
		});
		expect(saved.handler?.nextRunAt).toBeGreaterThanOrEqual(Date.now() + 15 * 60_000);
		expect(saved.handler?.nextRunAt).toBeLessThan(Date.now() + 16.5 * 60_000);
	});

	test("refuses registry-fenced work outside the first disable batch", async () => {
		const f = await fixture({ name: "registry-test" });
		const owner = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "registry-tail" }),
		);
		const version = await f.t.run((ctx) => ctx.db.get("plugins_versions", f.pluginVersionId));
		if (!version) throw new Error("Expected schedule version");
		const installed = await f.t
			.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId })
			.mutation(api.plugins.install_version, {
				membershipId: owner.membershipId,
				pluginVersionId: f.pluginVersionId,
				acceptedCapabilities: version.capabilities,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				acceptedMcpServersFingerprint: version.mcpServersFingerprint,
				acceptedSkillNames: [],
				scheduledRun: { kind: "me", scopes: ["plugin_data:read"] },
			});
		if (installed._nay) throw new Error(installed._nay.message);
		await f.t.run(async (ctx) => {
			const handler = await ctx.db
				.query("plugins_workspace_event_handlers")
				.withIndex("by_installation", (q) => q.eq("installationId", installed._yay.installationId))
				.unique();
			if (!handler) throw new Error("Expected second schedule handler");
			await ctx.db.patch("plugins_workspace_event_handlers", handler._id, { nextRunAt: Date.now() });
		});
		expect(
			await f.t.mutation(internal.plugins.hard_delete_plugin_from_registry, {
				pluginName: f.name,
				_test_batchSize: 1,
			}),
		).toEqual({ done: false, deleted: 1 });
		const remaining = await f.t.run(async (ctx) => {
			expect(
				await ctx.db
					.query("plugins_registry_deletion_fences")
					.withIndex("by_pluginName", (q) => q.eq("pluginName", f.name))
					.unique(),
			).not.toBeNull();
			return await ctx.db
				.query("plugins_workspace_installations")
				.withIndex("by_pluginName_status", (q) => q.eq("pluginName", f.name).eq("status", "enabled"))
				.unique();
		});
		if (!remaining) throw new Error("Expected an installation outside the first disable batch");
		await f.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("plugins_event_runs")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", remaining.organizationId).eq("workspaceId", remaining.workspaceId),
					)
					.collect(),
			),
			"a registry fence must prevent a new root outside the first disable batch",
		).toEqual([]);
	});

	test("moves twenty disabled handlers so a later valid handler runs on the next tick", async () => {
		const t = test_convex();
		let owner: Membership | undefined;
		const disabled: Awaited<ReturnType<typeof fixture>>[] = [];
		for (let i = 0; i < 21; i += 1) {
			const f = await fixture({ t, owner, name: `disabled-${i}` });
			owner ??= f.owner;
			await t.run(async (ctx) => {
				await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
				await ctx.db.patch("plugins_workspace_event_handlers", f.handlerId, { nextRunAt: Date.now() - 1000 + i });
			});
			disabled.push(f);
		}
		const valid = await fixture({ t, owner, name: "valid-tail" });
		await t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		expect(await t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toEqual([]);
		const first = await t.run((ctx) => ctx.db.get("plugins_workspace_event_handlers", disabled[0]!.handlerId));
		const last = await t.run((ctx) => ctx.db.get("plugins_workspace_event_handlers", disabled[20]!.handlerId));
		expect(first?.nextRunAt, "disabled handlers must leave the oldest due page").toBe(Date.now() + 15 * 60_000);
		expect(last?.nextRunAt).toBeLessThan(Date.now());
		await t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(
			runs.map((run) => run.installationId),
			"the valid tail must become reachable",
		).toEqual([valid.installationId]);
	});

	test("admits four organizations and leaves the next valid handler due", async () => {
		const t = test_convex();
		const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
		for (let i = 0; i < 5; i += 1) fixtures.push(await fixture({ t, name: `team-${i}` }));
		await t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toHaveLength(4);
		const untouched = await t.run((ctx) => ctx.db.get("plugins_workspace_event_handlers", fixtures[4]!.handlerId));
		expect(untouched?.nextRunAt, "a full deployment must keep the oldest valid handler due").toBe(Date.now());
	});

	test("delays another installation in the same organization for one minute", async () => {
		const f = await fixture();
		const second = await fixture({ t: f.t, owner: f.owner, name: "second-schedule" });
		await f.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		expect(await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(1);
		expect((await f.t.run((ctx) => ctx.db.get("plugins_workspace_event_handlers", second.handlerId)))?.nextRunAt).toBe(
			Date.now() + 60_000,
		);
		await f.t.run((ctx) => ctx.db.patch("plugins_workspace_event_handlers", f.handlerId, { nextRunAt: Date.now() }));
		await f.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		expect((await f.t.run((ctx) => ctx.db.get("plugins_workspace_event_handlers", f.handlerId)))?.nextRunAt).toBe(
			Date.now() + 60_000,
		);
	});

	test("expired histories do not hide a free admission slot", async () => {
		const f = await fixture();
		const root = await root_run(f);
		await f.t.run(async (ctx) => {
			const activity = await ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique();
			if (!activity) throw new Error("Expected root Activity");
			await ctx.db.patch("activities", activity._id, { deadlineAt: Date.now() - 1 });
			const { _id, _creationTime, workId, ...copy } = root;
			for (let i = 0; i < 50; i += 1) {
				const id = await ctx.db.insert("plugins_event_runs", { ...copy, eventId: `expired:${i}` });
				await activities_db_start(ctx, {
					organizationId: f.owner.organizationId,
					workspaceId: f.owner.workspaceId,
					userId: f.owner.userId,
					source: {
						kind: "plugin_run",
						id,
						installationId: f.installationId,
						pluginName: f.name,
						event: "schedule.interval.elapsed",
						serializationKey: "schedule",
					},
					title: "Expired schedule",
					targets: [],
					visibility: "requester",
					feedVisible: false,
					status: "queued",
					resultKind: "plugin_result",
					deadlineAt: Date.now() - 1,
					now: Date.now() - 10 * 60_000,
				});
			}
			await ctx.db.patch("plugins_workspace_event_handlers", f.handlerId, { nextRunAt: Date.now() });
		});
		await f.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		const live = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_kind_event_status_deadline_organization", (q) =>
					q
						.eq("source.kind", "plugin_run")
						.eq("source.event", "schedule.interval.elapsed")
						.eq("status", "queued")
						.gt("deadlineAt", Date.now()),
				)
				.collect(),
		);
		expect(live, "expired Activities must not consume the live chain cap").toHaveLength(1);
	});
});

describe("start_event_run scheduled assignment", () => {
	test("starts a fileless run and pins the first-start clock", async () => {
		const f = await fixture();
		const run = await root_run(f);
		vi.setSystemTime(Date.now() + 2 * 60_000);
		const started = await start_run(f, run._id);
		expect(started.run.chainStartedAt).toBe(Date.now());
		expect(started.run.apiTokenExpiresAt).toBe(run.scheduleDueAt! + 10 * 60_000);
	});

	test("refuses a replaced consent pin before issuing a token", async () => {
		const f = await fixture();
		const run = await root_run(f);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", f.installationId, { scheduledRunGrantId: undefined }),
		);
		const result = await f.t.mutation(internal.plugins_runtime.start_event_run, {
			runId: run._id,
			apiTokenHash: "old-grant",
		});
		expect(result._nay, "a queued run must not start after its selected consent disappears").toBeDefined();
		expect((await f.t.run((ctx) => ctx.db.get("plugins_event_runs", run._id)))?.apiTokenHash).toBeUndefined();
	});
});

describe("consume_run_api_call scheduled scopes", () => {
	test("refuses missing consent and baseline Files write without allocating a call", async () => {
		const f = await fixture({ scopes: [] });
		const run = await root_run(f);
		await start_run(f, run._id);
		for (const requiredScope of [
			"outbound:fetch",
			"secrets:read",
			"files:write",
			"files:download",
			"activities:write",
		] as const) {
			expect(
				(
					await f.t.mutation(internal.plugins_runtime.consume_run_api_call, {
						runId: run._id,
						kind: "api_request",
						route: "test",
						requiredScope,
					})
				)._nay?.message,
			).toBe("Permission denied");
		}
		expect(await f.t.run((ctx) => ctx.db.query("plugins_event_run_calls").collect())).toEqual([]);
		expect(
			(
				await f.t.mutation(internal.plugins_runtime.consume_run_api_call, {
					runId: run._id,
					kind: "api_request",
					route: "test",
					requiredScope: "runs:follow_up",
				})
			)._yay?.sequence,
		).toBe(1);
	});

	test("keeps the same twenty-call budget across mixed scheduled routes", async () => {
		const f = await fixture();
		const run = await root_run(f);
		await start_run(f, run._id);
		for (let i = 0; i < 20; i += 1) {
			const consumed = await f.t.mutation(internal.plugins_runtime.consume_run_api_call, {
				runId: run._id,
				kind: i % 2 ? "outbound_fetch" : "api_request",
				route: i % 2 ? "outbound" : "/api/v1/plugin-data/read",
				requiredScope: i % 2 ? "outbound:fetch" : "plugin_data:read",
			});
			expect(consumed._yay?.sequence).toBe(i + 1);
		}
		expect(
			(
				await f.t.mutation(internal.plugins_runtime.consume_run_api_call, {
					runId: run._id,
					kind: "api_request",
					route: "follow-up",
					requiredScope: "runs:follow_up",
				})
			)._nay?.message,
		).toBe("Plugin API call limit exceeded");
	});
});

describe("request_follow_up", () => {
	test("refuses an expired token before storing state or a call", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token, run } = await start_run(f, root._id);
		if (run.apiTokenExpiresAt === undefined) throw new Error("Expected a live run token deadline");
		vi.setSystemTime(run.apiTokenExpiresAt);
		expect((await follow_up(f, token, '{"cursor":1}')).status, "an expired follow-up token must return 401").toBe(401);
		const saved = await f.t.run((ctx) => ctx.db.get("plugins_event_runs", root._id));
		expect(saved?.followUpState).toBeUndefined();
		expect(saved?.apiCallCount).toBe(0);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_event_run_calls").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(1);
	});

	test("keeps one private outgoing state and creates a fresh child only after success", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect((await follow_up(f, token, '{"page":2}')).status).toBe(200);
		const duplicate = await follow_up(f, token, '{"page":3}');
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json(), "duplicate refusal must expose follow_up_already_requested").toEqual({
			message: "A follow-up is already requested",
			errorCode: "follow_up_already_requested",
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("plugins_event_run_calls")
					.withIndex("by_run_sequence", (q) => q.eq("runId", root._id).eq("sequence", 2))
					.unique(),
			),
		).toMatchObject({ status: "failed", errorCode: "follow_up_already_requested", responseStatus: 409 });
		await f.t.mutation(internal.plugins_runtime.finish_event_run, { runId: root._id, outcome: successful_outcome });
		const runs = await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toHaveLength(2);
		const parent = runs.find((run) => run._id === root._id)!;
		const child = runs.find((run) => run._id !== root._id)!;
		expect(child).toMatchObject({
			eventId: `follow_up:${root._id}`,
			actorUserId: root.actorUserId,
			runAsGrantId: root.runAsGrantId,
			chainRootRunId: root._id,
			chainIndex: 1,
			chainStartedAt: Date.now(),
			chainInputState: '{"page":2}',
			apiCallCount: 0,
		});
		expect(child.followUpState).toBeUndefined();
		expect(parent.chainInputState).toBeUndefined();
		expect(parent.followUpState).toBeUndefined();
		expect(parent.apiTokenHash).toBeUndefined();
		const startedChild = await start_run(f, child._id);
		expect(startedChild.run.chainStartedAt).toBe(Date.now());
		await f.t.mutation(internal.plugins_runtime.finish_event_run, { runId: child._id, outcome: successful_outcome });
		expect(
			await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect()),
			"incoming state must not create another child",
		).toHaveLength(2);
	});

	test.each(["{", JSON.stringify("é".repeat(8192))])(
		"refuses invalid or oversized JSON text (case %#)",
		async (state) => {
			const f = await fixture();
			const root = await root_run(f);
			const { token } = await start_run(f, root._id);
			expect((await follow_up(f, token, state)).status).toBe(400);
			expect((await f.t.run((ctx) => ctx.db.get("plugins_event_runs", root._id)))?.followUpState).toBeUndefined();
		},
	);

	test("accepts JSON null text as an explicit outgoing request", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect((await follow_up(f, token, "null")).status).toBe(200);
		await f.t.mutation(internal.plugins_runtime.finish_event_run, { runId: root._id, outcome: successful_outcome });
		const runs = await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs.find((run) => run._id !== root._id)?.chainInputState).toBe("null");
	});

	test("refuses a twenty-first run and does not consume incoming state after failure", async () => {
		const f = await fixture();
		const root = await root_run(f);
		let current = root;
		for (let i = 0; i < 19; i += 1) {
			const { token } = await start_run(f, current._id);
			expect((await follow_up(f, token, JSON.stringify({ cursor: i + 1 }))).status).toBe(200);
			await f.t.mutation(internal.plugins_runtime.finish_event_run, {
				runId: current._id,
				outcome: successful_outcome,
			});
			const child = await f.t.run((ctx) =>
				ctx.db
					.query("plugins_event_runs")
					.filter((q) => q.eq(q.field("eventId"), `follow_up:${current._id}`))
					.unique(),
			);
			if (!child) throw new Error("Expected next chain run");
			current = child;
		}
		const { token } = await start_run(f, current._id);
		expect(current.chainIndex).toBe(19);
		const exhausted = await follow_up(f, token, "{}");
		expect(exhausted.status, "the chain must stop at twenty runs").toBe(409);
		expect(await exhausted.json()).toEqual({ message: "Plugin run chain limit exceeded", errorCode: "chain_limit" });
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("plugins_event_run_calls")
					.withIndex("by_run_sequence", (q) => q.eq("runId", current._id).eq("sequence", 1))
					.unique(),
			),
		).toMatchObject({ status: "failed", errorCode: "chain_limit", responseStatus: 409 });
		await f.t.mutation(internal.plugins_runtime.finish_event_run, {
			runId: current._id,
			outcome: { kind: "failed", errorMessage: "Runner failed" },
		});
		const run = await f.t.run((ctx) => ctx.db.get("plugins_event_runs", current._id));
		expect(run?.chainInputState).toBeUndefined();
		expect(run?.followUpState).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(20);
	});

	test("discards an accepted outgoing request when the runner fails", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect((await follow_up(f, token, '{"cursor":1}')).status).toBe(200);
		await f.t.mutation(internal.plugins_runtime.finish_event_run, {
			runId: root._id,
			outcome: { kind: "failed", errorMessage: "Runner failed" },
		});
		expect((await f.t.run((ctx) => ctx.db.get("plugins_event_runs", root._id)))?.followUpState).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(1);
	});

	test("rechecks consent at successful child enqueue", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect((await follow_up(f, token, "{}")).status).toBe(200);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", f.installationId, { scheduledRunGrantId: undefined }),
		);
		const finished = await f.t.mutation(internal.plugins_runtime.finish_event_run, {
			runId: root._id,
			outcome: successful_outcome,
		});
		expect(finished._yay?.status, "a changed assignment must refuse the child").toBe("failed");
		expect(await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(1);
		expect((await f.t.run((ctx) => ctx.db.get("plugins_event_runs", root._id)))?.followUpState).toBeUndefined();
	});

	test("caps child queue deadlines at thirty minutes from the first start", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", root._id, { chainStartedAt: Date.now() - 29 * 60_000 }));
		expect((await follow_up(f, token, "{}")).status).toBe(200);
		await f.t.mutation(internal.plugins_runtime.finish_event_run, { runId: root._id, outcome: successful_outcome });
		const child = (await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).find(
			(run) => run._id !== root._id,
		)!;
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", child._id))
				.unique(),
		);
		expect(activity?.deadlineAt).toBe(Date.now() + 60_000);
		vi.setSystemTime(Date.now() + 60_000);
		expect(
			(await f.t.mutation(internal.plugins_runtime.start_event_run, { runId: child._id, apiTokenHash: "late-child" }))
				._nay,
		).toBeDefined();
	});
});

describe("scheduled cancellation and retention", () => {
	test("self-revocation clears credentials, both states and started calls in the same transaction", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect((await follow_up(f, token, '{"private":true}')).status).toBe(200);
		const consumed = await f.t.mutation(internal.plugins_runtime.consume_run_api_call, {
			runId: root._id,
			kind: "outbound_fetch",
			route: "outbound",
			requiredScope: "outbound:fetch",
		});
		if (consumed._nay) throw new Error(consumed._nay.message);
		await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", root._id, { chainInputState: '{"privateInput":true}' }));
		expect(
			await f.asOwner.mutation(api.plugins_access.revoke_run_as_me, {
				membershipId: f.owner.membershipId,
				installationId: f.installationId,
			}),
		).toEqual({ _yay: null });
		const saved = await f.t.run(async (ctx) => ({
			run: await ctx.db.get("plugins_event_runs", root._id),
			call: await ctx.db.get("plugins_event_run_calls", consumed._yay.callId),
			activity: await ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		}));
		expect(saved.run?.apiTokenHash).toBeUndefined();
		expect(saved.run?.apiTokenExpiresAt).toBeUndefined();
		expect(saved.run?.chainInputState).toBeUndefined();
		expect(saved.run?.followUpState).toBeUndefined();
		expect(saved.call?.status).toBe("failed");
		expect(saved.activity?.status).toBe("canceled");
		expect(saved.activity?.expiresAt).toBeUndefined();
		expect(await f.t.run((ctx) => plugins_schedules_db_cancel(ctx, { installationId: f.installationId }))).toEqual({
			canceledCount: 0,
		});
	});

	test("member self-revocation refuses the old token at the KV and follow-up HTTP doors", async () => {
		const f = await fixture();
		const member = await assign_member(f);
		const root = await root_run(f);
		expect(root.actorUserId).toBe(member.member.userId);
		expect(root.runAsGrantId).toBe(member.grantId);
		const { token } = await start_run(f, root._id);
		const request = {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ collection: "progress", key: "sync" }),
		};
		const read = await f.t.fetch("/api/v1/plugin-data/read", request);
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({ document: null });
		const calls = await f.t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", root._id))
				.collect(),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ route: "/api/v1/plugin-data/read", status: "succeeded", responseStatus: 200 });
		expect(
			await member.asMember.mutation(api.plugins_access.revoke_run_as_me, {
				membershipId: member.membership._id,
				installationId: f.installationId,
			}),
		).toEqual({ _yay: null });
		const staleRead = await f.t.fetch("/api/v1/plugin-data/read", request);
		expect(staleRead.status, "revoked_member_token_cannot_read_kv").toBe(401);
		expect(await staleRead.json()).toEqual({ message: "Unauthenticated" });
		const staleFollowUp = await follow_up(f, token, '{"late":true}');
		expect(staleFollowUp.status, "revoked_member_token_cannot_request_follow_up").toBe(401);
		expect(await staleFollowUp.json()).toEqual({ message: "Unauthenticated" });
		const saved = await f.t.run(async (ctx) => ({
			run: await ctx.db.get("plugins_event_runs", root._id),
			grant: await ctx.db.get("access_control_permission_grants", member.grantId),
			calls: await ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", root._id))
				.collect(),
			runs: await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", f.owner.organizationId).eq("workspaceId", f.owner.workspaceId),
				)
				.collect(),
		}));
		expect(saved.grant).toBeNull();
		expect(saved.run?.apiTokenHash).toBeUndefined();
		expect(saved.run?.apiTokenExpiresAt).toBeUndefined();
		expect(saved.run?.chainInputState).toBeUndefined();
		expect(saved.run?.followUpState).toBeUndefined();
		expect(saved.run?.apiCallCount).toBe(1);
		expect(saved.calls).toEqual(calls);
		expect(saved.runs.map((run) => run._id), "revoked requests must not create a child run").toEqual([root._id]);
	});

	test("timeouts cancel the scheduled pool and preserve scheduled history forever", async () => {
		const f = await fixture();
		const root = await root_run(f);
		await start_run(f, root._id);
		const cancel = vi.spyOn(Workpool.prototype, "cancel");
		vi.setSystemTime(Date.now() + 10 * 60_000);
		await f.t.mutation(internal.activities.recover_expired, { _test_disableReschedule: true });
		expect(cancel).toHaveBeenCalled();
		expect(cancel.mock.contexts).toContain(plugins_scheduled_runs_workpool);
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		);
		expect(activity?.status).toBe("timed_out");
		expect(activity?.expiresAt, "scheduled history must have no automatic expiry").toBeUndefined();
		await f.t.mutation(internal.activities.cleanup_history, {
			_test_now: Date.now() + 365 * 24 * 60 * 60_000,
			_test_disableReschedule: true,
		});
		expect(await f.t.run((ctx) => ctx.db.get("plugins_event_runs", root._id))).not.toBeNull();
	});

	test("ordinary plugin runs retain their thirty-day history limit", async () => {
		const f = await fixture();
		const root = await root_run(f);
		await f.t.run(async (ctx) => {
			const activity = await ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique();
			if (!activity || activity.source.kind !== "plugin_run") throw new Error("Expected Activity");
			await ctx.db.patch("activities", activity._id, {
				source: { ...activity.source, event: "users.account.deleted" },
			});
			await activities_db_finish(ctx, { sourceId: root._id, status: "succeeded", errorMessage: null, now: Date.now() });
		});
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		);
		expect(activity?.expiresAt).toBe(Date.now() + 30 * 24 * 60 * 60_000);
	});
});

describe("scheduled human changes", () => {
	test("organization leave and rejoin do not revive the old run or consent", async () => {
		const f = await fixture();
		const member = await assign_member(f);
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect(
			await member.asMember.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userIdToRemove: member.member.userId,
			}),
		).toEqual({ _yay: null });
		for (let i = 0; i < 10; i += 1) {
			const pending = await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", member.membership._id));
			if (!pending?.pendingOrganizationRemoval) break;
			await f.t.mutation(internal.organizations.continue_remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userId: member.member.userId,
			});
		}
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userIdToAdd: member.member.userId,
			}),
		).toEqual({ _yay: null });
		const rejoined = await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", f.owner.workspaceId).eq("userId", member.member.userId).eq("active", true),
				)
				.unique(),
		);
		expect(rejoined).not.toBeNull();
		expect(rejoined?._id).not.toBe(member.membership._id);
		expect(
			(await f.t.query(internal.public_api.resolve_principal, { presented: token }))._nay,
			"rejoining must not revive an old scheduled token",
		).toBeDefined();
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.owner.userId }),
		);
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.set_scheduled_run_user, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					userId: member.member.userId,
					grantId: member.grantId,
				})
			)._nay,
			"rejoining needs a new self-grant",
		).toBeDefined();
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		);
		expect(activity?.status).toBe("canceled");
	});

	test("account restore keeps the membership id but requires fresh consent", async () => {
		const f = await fixture();
		const member = await assign_member(f);
		await f.t.run(async (ctx) => {
			const anagraphic = await ctx.db.insert("users_anagraphics", {
				userId: member.member.userId,
				displayName: "Scheduled member",
				email: "scheduled-member@test.local",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", member.member.userId, { anagraphic });
		});
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect(await member.asMember.action(api.users.delete_current_user_account, {})).toEqual({ _yay: null });
		expect(
			await f.t.mutation(internal.users.resolve_user, {
				clerkUserId: "restored-scheduled-member",
				email: "scheduled-member@test.local",
				displayName: "Scheduled member restored",
			}),
		).toEqual({ _yay: { userId: member.member.userId, restoredDeletedAccount: true } });
		const restored = await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", member.membership._id));
		expect(restored).toMatchObject({ _id: member.membership._id, active: true });
		expect(
			(await f.t.query(internal.public_api.resolve_principal, { presented: token }))._nay,
			"same-id restoration must not revive an old scheduled token",
		).toBeDefined();
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.owner.userId }),
		);
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.set_scheduled_run_user, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					userId: member.member.userId,
					grantId: member.grantId,
				})
			)._nay,
			"same-id restoration needs a new self-grant",
		).toBeDefined();
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		);
		expect(activity?.status).toBe("canceled");
	});

	test("management revoke and restore do not revive old credentials", async () => {
		const f = await fixture();
		const member = await assign_member(f, { management: "user", scopes: ["outbound:fetch"] });
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		const args = { membershipId: f.owner.membershipId, installationId: f.installationId };
		expect(
			await f.asOwner.mutation(api.plugins_access.update_installation_access, {
				...args,
				mode: "owner",
				principals: [],
			}),
		).toEqual({ _yay: null });
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.owner.userId }),
		);
		expect(
			await f.asOwner.mutation(api.plugins_access.update_installation_access, {
				...args,
				mode: "selected",
				principals: [{ kind: "user", userId: member.member.userId }],
			}),
		).toEqual({ _yay: null });
		expect(
			(await f.t.query(internal.public_api.resolve_principal, { presented: token }))._nay,
			"restoring management must not revive old scheduled credentials",
		).toBeDefined();
		expect((await f.t.run((ctx) => ctx.db.get("plugins_event_runs", root._id)))?.apiTokenHash).toBeUndefined();
	});

	test("role downgrade and restore cancel a role-selected manager's old chain", async () => {
		const f = await fixture({ workspaceName: "home" });
		const member = await assign_member(f, { management: "role", scopes: ["outbound:fetch"] });
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		const args = {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			userId: member.member.userId,
		};
		expect(await f.asOwner.mutation(api.access_control.set_user_role, { ...args, role: "viewer" })).toEqual({
			_yay: null,
		});
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "roles_write", key: f.owner.userId }),
		);
		expect(await f.asOwner.mutation(api.access_control.set_user_role, { ...args, role: "member" })).toEqual({
			_yay: null,
		});
		expect((await f.t.query(internal.public_api.resolve_principal, { presented: token }))._nay).toBeDefined();
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		);
		expect(activity?.status, "restoring a role must not restart the old chain").toBe("canceled");
	});

	test("reassignment cancels old work and the next root uses the replacement user", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		const member = await assign_member(f);
		expect((await f.t.query(internal.public_api.resolve_principal, { presented: token }))._nay).toBeDefined();
		await f.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
		const runs = await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		const next = runs.find((run) => run._id !== root._id);
		expect(next).toMatchObject({
			actorUserId: member.member.userId,
			runAsGrantId: member.grantId,
			chainIndex: 0,
			chainInputState: null,
		});
	});

	test("Disable cancels a run even when its old assignment is invalid", async () => {
		const f = await fixture();
		const root = await root_run(f);
		await start_run(f, root._id);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", f.installationId, { scheduledRunGrantId: undefined }),
		);
		expect(
			await f.asOwner.mutation(api.plugins.disable_installation, {
				membershipId: f.owner.membershipId,
				installationId: f.installationId,
			}),
		).toEqual({ _yay: null });
		const run = await f.t.run((ctx) => ctx.db.get("plugins_event_runs", root._id));
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		);
		expect(run?.apiTokenHash).toBeUndefined();
		expect(activity?.status).toBe("canceled");
	});

	test("a valid YAML save keeps the chain and its original schedule envelope", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect(
			await f.asOwner.mutation(api.plugins.update_installation_configuration, {
				membershipId: f.owner.membershipId,
				installationId: f.installationId,
				configurationYaml: "schedule:\n  everyMinutes: 30\n",
			}),
		).toEqual({ _yay: null });
		expect((await f.t.query(internal.public_api.resolve_principal, { presented: token }))._yay?.kind).toBe(
			"plugin_run",
		);
		expect((await follow_up(f, token, "{}")).status).toBe(200);
		await f.t.mutation(internal.plugins_runtime.finish_event_run, { runId: root._id, outcome: successful_outcome });
		const runs = await f.t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs.find((run) => run._id !== root._id)).toMatchObject({
			scheduleIntervalMinutes: 15,
			scheduleDueAt: root.scheduleDueAt,
			chainRootRunId: root._id,
		});
		expect((await f.t.run((ctx) => ctx.db.get("plugins_workspace_event_handlers", f.handlerId)))?.nextRunAt).toBe(
			Date.now(),
		);
	});
});

describe("list_run_history", () => {
	test("pages original chain pins without credentials or state and labels a deleted actor", async () => {
		const f = await fixture();
		const member = await assign_member(f);
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		expect((await follow_up(f, token, '{"cursor":"private-chain-state"}')).status).toBe(200);
		vi.setSystemTime(Date.now() + 1_000);
		await f.t.mutation(internal.plugins_runtime.finish_event_run, { runId: root._id, outcome: successful_outcome });
		const child = await f.t.run((ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.filter((q) => q.neq(q.field("_id"), root._id))
				.unique(),
		);
		if (!child) throw new Error("Expected follow-up child");
		vi.setSystemTime(Date.now() + 1_000);
		const childStarted = await start_run(f, child._id);
		const args = { membershipId: f.owner.membershipId, installationId: f.installationId };
		const first = await f.asOwner.query(api.plugins.list_run_history, {
			...args,
			paginationOpts: { cursor: null, numItems: 1 },
		});
		const second = await f.asOwner.query(api.plugins.list_run_history, {
			...args,
			paginationOpts: { cursor: first.continueCursor, numItems: 1 },
		});
		expect(first.isDone).toBe(false);
		expect(second.isDone).toBe(true);
		expect(first.page).toMatchObject([
			{
				_id: child._id,
				actorUserId: member.member.userId,
				runAsGrantId: member.grantId,
				chainRootRunId: root._id,
				chainIndex: 1,
				status: "running",
				file: null,
			},
		]);
		expect(second.page).toMatchObject([
			{
				_id: root._id,
				actorUserId: member.member.userId,
				runAsGrantId: member.grantId,
				chainRootRunId: root._id,
				chainIndex: 0,
				status: "succeeded",
				file: null,
			},
		]);
		for (const run of [...first.page, ...second.page]) {
			for (const field of ["apiTokenHash", "apiTokenExpiresAt", "chainInputState", "followUpState"])
				expect(run).not.toHaveProperty(field);
		}
		expect(JSON.stringify(first)).not.toContain(childStarted.tokenHash);
		expect(JSON.stringify(first)).not.toContain("private-chain-state");
		const other = await fixture({ t: f.t, owner: f.owner, name: "other-history" });
		expect(
			(
				await f.asOwner.query(api.plugins.list_run_history, {
					...args,
					installationId: other.installationId,
					paginationOpts: { cursor: null, numItems: 25 },
				})
			).page,
		).toEqual([]);
		expect(
			await f.asOwner.query(api.plugins.list_run_calls, {
				...args,
				installationId: other.installationId,
				runId: root._id,
			}),
		).toEqual([]);
		expect(await member.asMember.action(api.users.delete_current_user_account, {})).toEqual({ _yay: null });
		const ownGrant = await f.asOwner.mutation(api.plugins_access.grant_run_as_me, {
			...args,
			scopes: ["plugin_data:read"],
		});
		if (ownGrant._nay) throw new Error(ownGrant._nay.message);
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.owner.userId }),
		);
		expect(
			await f.asOwner.mutation(api.plugins_access.set_scheduled_run_user, {
				...args,
				userId: f.owner.userId,
				grantId: ownGrant._yay.grantId,
			}),
		).toEqual({ _yay: null });
		const deleted = await f.asOwner.query(api.plugins.list_run_history, {
			...args,
			paginationOpts: { cursor: null, numItems: 25 },
		});
		expect(deleted.page).toHaveLength(2);
		for (const run of deleted.page)
			expect(run).toMatchObject({
				actorUserId: member.member.userId,
				actorName: "Deleted user",
				runAsGrantId: member.grantId,
				chainRootRunId: root._id,
			});
	});

	test("keeps ordinary source metadata hidden from a manager without that file", async () => {
		const f = await fixture();
		const member = await assign_member(f, { management: "user" });
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
			key: key ?? "test-upload-key",
			url: "https://files.test/upload",
		}));
		const upload = await f.asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			filename: "private.png",
			contentType: "image/png",
			size: 1_024,
		});
		if (upload._nay) throw new Error(upload._nay.message);
		const enqueued = await f.t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", f.installationId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const fileNode = await ctx.db.get("files_nodes", upload._yay.nodeId);
			if (!installation || !asset || !fileNode) throw new Error("Expected source file and installation");
			return await plugins_runtime_db_enqueue_manual_run(ctx, { installation, asset, fileNode });
		});
		if (enqueued._nay) throw new Error(enqueued._nay.message);
		const args = { installationId: f.installationId, paginationOpts: { cursor: null, numItems: 25 } };
		expect(
			(await member.asMember.query(api.plugins.list_run_history, { ...args, membershipId: member.membership._id }))
				.page[0],
		).toMatchObject({
			_id: enqueued._yay.runId,
			event: "files.run.requested",
			file: { name: "private.png", path: "/private.png", size: 1_024 },
		});
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: upload._yay.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(
			(await member.asMember.query(api.plugins.list_run_history, { ...args, membershipId: member.membership._id }))
				.page[0],
		).toMatchObject({ _id: enqueued._yay.runId, file: null });
		expect(
			(await f.asOwner.query(api.plugins.list_run_history, { ...args, membershipId: f.owner.membershipId })).page[0]
				?.file,
		).toMatchObject({ name: "private.png", path: "/private.png", size: 1_024 });
	});
});

describe("get_installation_schedule", () => {
	test("shows the latest root and child and keeps an invalid assignment visible for repair", async () => {
		const f = await fixture();
		const args = { membershipId: f.owner.membershipId, installationId: f.installationId };
		const root = await root_run(f);
		expect(await f.asOwner.query(api.plugins.get_installation_schedule, args)).toMatchObject({
			intervalMinutes: 15,
			payerUserId: f.owner.userId,
			assignmentError: null,
			lastRun: { runId: root._id, status: "queued" },
		});
		const { token } = await start_run(f, root._id);
		expect((await f.asOwner.query(api.plugins.get_installation_schedule, args))?.lastRun).toMatchObject({
			runId: root._id,
			status: "running",
		});
		expect((await follow_up(f, token, "{}")).status).toBe(200);
		vi.setSystemTime(Date.now() + 1_000);
		await f.t.mutation(internal.plugins_runtime.finish_event_run, { runId: root._id, outcome: successful_outcome });
		const child = await f.t.run((ctx) =>
			ctx.db
				.query("plugins_event_runs")
				.filter((q) => q.neq(q.field("_id"), root._id))
				.unique(),
		);
		if (!child) throw new Error("Expected follow-up child");
		vi.setSystemTime(Date.now() + 1_000);
		await start_run(f, child._id);
		expect((await f.asOwner.query(api.plugins.get_installation_schedule, args))?.lastRun).toMatchObject({
			runId: child._id,
			status: "running",
		});
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", f.installationId, { scheduledRunGrantId: undefined }),
		);
		expect(await f.asOwner.mutation(api.plugins.disable_installation, args)).toEqual({ _yay: null });
		const repair = await f.asOwner.query(api.plugins.get_installation_schedule, args);
		expect(repair).toMatchObject({
			status: "disabled",
			userId: f.owner.userId,
			grantId: null,
			lastRun: { runId: child._id, status: "canceled" },
		});
		expect(repair?.assignmentError).toBeTypeOf("string");
	});
});

describe("follow-up HTTP schema", () => {
	test("keeps the public body and success response exact", () => {
		type Route = api_schemas_Main["/api/v1/plugin-runs/follow-up"]["POST"];
		expectTypeOf<Route["body"]>().toEqualTypeOf<{ state: string }>();
		expectTypeOf<Route["response"][200]["body"]>().toEqualTypeOf<{
			readonly ok: true;
			message?: undefined;
			readonly errorCode?: undefined;
		}>();
		expectTypeOf<Route["response"][409]["body"]>().toEqualTypeOf<{
			readonly message:
				| "Unauthenticated"
				| "Unauthorized"
				| "Permission denied"
				| "The scheduled user must grant access again"
				| "The scheduled user is not an active workspace member"
				| "Choose a scheduled user with their own permission grant"
				| "This schedule is not available"
				| "The scheduled assignment changed"
				| "Plugin run chain limit exceeded"
				| "A follow-up is already requested"
				| "Follow-up state must be at most 16 KiB"
				| "Follow-up state must be valid JSON";
			readonly errorCode: "follow_up_already_requested" | "chain_limit";
			readonly ok?: undefined;
		}>();
	});
});

describe("scheduled runner host calls", () => {
	test("refuses plaintext when consent changes during decryption", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		const secret = await f.asOwner.mutation(api.plugins.upsert_installation_secret, {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			name: "API_TOKEN",
			value: "private-value",
		});
		if (secret._nay) throw new Error(secret._nay.message);
		const originalDecrypt = crypto_utils.crypto_decrypt_secret_value;
		const decrypt = vi.spyOn(crypto_utils, "crypto_decrypt_secret_value").mockImplementation(async (...args) => {
			const value = await originalDecrypt(...args);
			await f.t.run((ctx) =>
				ctx.db.patch("plugins_workspace_installations", f.installationId, { scheduledRunGrantId: undefined }),
			);
			return value;
		});
		const response = await f.t.fetch("/api/internal/plugins/host/secret-get", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Runner-Authorization": `Bearer ${process.env.PLUGIN_RUNNER_HOST_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "API_TOKEN" }),
		});
		expect(decrypt).toHaveBeenCalledOnce();
		expect(response.status, "secret bytes must be refused after consent changes during decrypt").toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		const calls = await f.t.run((ctx) => ctx.db.query("plugins_event_run_calls").collect());
		expect(calls).toHaveLength(1);
		expect(calls[0]?.status).toBe("failed");
	});

	test("keeps missing secret lookups subject to the final consent check", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { tokenHash } = await start_run(f, root._id);
		const call = await f.t.mutation(internal.plugins_runtime.consume_run_api_call, {
			runId: root._id,
			kind: "api_request",
			route: "/api/internal/plugins/host/secret-get",
			requiredScope: "secrets:read",
		});
		if (call._nay) throw new Error(call._nay.message);
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", f.installationId, { scheduledRunGrantId: undefined }),
		);
		expect(
			(
				await f.t.mutation(internal.plugins_runtime.validate_runner_host_call, {
					runId: root._id,
					callId: call._yay.callId,
					apiTokenHash: tokenHash,
					requiredScope: "secrets:read",
					finish: true,
				})
			)._nay,
		).toBeDefined();
		expect((await f.t.run((ctx) => ctx.db.get("plugins_event_run_calls", call._yay.callId)))?.status).toBe("started");
	});

	test("does not give ordinary events the scheduled follow-up scope", async () => {
		const f = await fixture();
		const root = await root_run(f);
		const { token } = await start_run(f, root._id);
		await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", root._id, { event: "users.account.deleted" }));
		expect((await follow_up(f, token, "{}")).status).toBe(403);
	});
});

describe("scheduled runner envelope", () => {
	test("passes the selected actor, schedule and parsed incoming state to the runner", async () => {
		const f = await fixture();
		const root = await root_run(f);
		await f.t.run((ctx) => ctx.db.patch("plugins_event_runs", root._id, { chainInputState: '{"page":2}' }));
		const wireSchema = z.object({
			pluginRunId: z.string(),
			input: z.object({
				event: z.string(),
				actorUserId: z.string(),
				source: z.null(),
				schedule: z.object({ intervalMinutes: z.number(), dueAt: z.number() }),
				chain: z.object({ rootRunId: z.string(), index: z.number(), state: z.unknown() }),
			}),
		});
		let envelope: z.infer<typeof wireSchema>["input"] | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				if (typeof init?.body !== "string") throw new Error("Expected a runner body");
				const wire = wireSchema.parse(JSON.parse(init.body));
				envelope = wire.input;
				const body = JSON.stringify({
					_yay: { pluginRunId: wire.pluginRunId, pluginStatus: 200, elapsedMs: 10, outputBytes: 0 },
				});
				return new Response(body, {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"X-Bonobo-Runner-Kind": "event",
						"X-Bonobo-Runner-Run-Id": wire.pluginRunId,
						"X-Bonobo-Runner-Plugin-Status": "200",
						"X-Bonobo-Runner-Elapsed-Ms": "10",
						"X-Bonobo-Runner-Output-Bytes": "0",
						"X-Bonobo-Runner-Body-Bytes": String(new TextEncoder().encode(body).byteLength),
					},
				});
			}),
		);
		await f.t.action(internal.plugins_runtime.execute_upload_completed_event_run, { runId: root._id });
		expect(envelope).toEqual({
			event: "schedule.interval.elapsed",
			actorUserId: f.owner.userId,
			source: null,
			schedule: { intervalMinutes: 15, dueAt: Date.now() },
			chain: { rootRunId: root._id, index: 0, state: { page: 2 } },
		});
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", root._id))
				.unique(),
		);
		expect(activity?.status).toBe("succeeded");
	});
});
