import { describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";

import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const SEAL_PROCESSING_PATH = "/api/internal/plugins/service-grants/seal-processing";
const RESERVE_PATH = "/api/v1/files/service-uploads/reserve";
const CREATE_TARGET_PATH = "/api/v1/files/service-uploads/create-target";
const REMINT_PATH = "/api/v1/files/service-uploads/remint";
const FINALIZE_PATH = "/api/v1/files/service-uploads/finalize";
const RELEASE_PATH = "/api/v1/files/service-uploads/release";
const DELETE_PATH = "/api/v1/files/service-uploads/delete";
const ARCHIVE_PATH = "/api/v1/files/service-uploads/archive-destination";

/** The value `setup-env.test.ts` puts in the environment for the whole convex project. */
const EXCHANGE_SECRET = "COUNCIL_SERVICE_EXCHANGE_SECRET_TEST";

const MIB = 1024 * 1024;

const COUNCIL_CAPABILITIES: plugins_Capability[] = [
	"plugin.service.connect",
	"plugin.data.read",
	"plugin.data.write",
	"workspace.files.write",
];

/**
 * Insert a ready plugin version and one enabled installation directly, the same way
 * `plugins_service.test.ts` does. The publish pipeline is not what these tests exercise.
 */
async function seed_installation(
	t: ReturnType<typeof test_convex>,
	args: {
		acceptedCapabilities?: plugins_Capability[];
		organizationName?: string;
		workspaceName?: string;
	} = {},
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, {
			...(args.organizationName === undefined ? {} : { organizationName: args.organizationName }),
			...(args.workspaceName === undefined ? {} : { workspaceName: args.workspaceName }),
		});
		const capabilities = args.acceptedCapabilities ?? COUNCIL_CAPABILITIES;
		const pluginName = "council";
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: pluginName,
			displayName: "Council",
			version: "0.1.0",
			description: "Meetings with named transcripts",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/bonobo/council-plugin",
			sourceOwner: "bonobo",
			sourceRepo: "council-plugin",
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: "plugins/council/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			events: [],
			capabilities,
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: membership.userId,
			updatedAt: now,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginVersionId,
			pluginName,
			status: "enabled",
			configurationYaml: null,
			acceptedCapabilities: capabilities,
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			installedBy: membership.userId,
			updatedBy: membership.userId,
			updatedAt: now,
		});
		return { ...membership, pluginVersionId, installationId } as const;
	});
}

async function seed_page_token(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	actorUserId = fixture.userId,
) {
	const token = `plu_${crypto_random_hex(32)}`;
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			userId: actorUserId,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt: now + 30 * 60 * 1000,
		});
	});
	return token;
}

function service_headers(bearer: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${bearer}`,
		"X-Bonobo-Service-Authorization": `Bearer ${EXCHANGE_SECRET}`,
	};
}

/** Exchange a fresh page token for an interactive grant, failing loudly on refusal. */
async function exchange_token(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	actorUserId = fixture.userId,
) {
	const pageToken = await seed_page_token(t, fixture, actorUserId);
	const response = await t.fetch("/api/internal/plugins/service-grants/exchange", {
		method: "POST",
		headers: service_headers(pageToken),
		body: JSON.stringify({}),
	});
	if (response.status !== 200) {
		throw new Error(`Exchange failed with ${response.status}: ${await response.text()}`);
	}
	return ((await response.json()) as { token: string }).token;
}

/** Seal a processing grant for the destination, failing loudly on refusal. */
async function seal_token(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	destinationPathPrefix = "/meetings",
	actorUserId = fixture.userId,
) {
	const interactive = await exchange_token(t, fixture, actorUserId);
	const response = await t.fetch(SEAL_PROCESSING_PATH, {
		method: "POST",
		headers: service_headers(interactive),
		body: JSON.stringify({ destinationPathPrefix }),
	});
	if (response.status !== 200) {
		throw new Error(`Seal failed with ${response.status}: ${await response.text()}`);
	}
	return ((await response.json()) as { token: string }).token;
}

/** The service upload routes are public API routes: bearer only, no service secret header. */
async function call(t: ReturnType<typeof test_convex>, path: string, bearer: string, body: unknown) {
	return await t.fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
		body: JSON.stringify(body),
	});
}

function reserve_body(args: { idempotencyKey?: string; reservedBytes?: number; expiresAt?: number } = {}) {
	return {
		idempotencyKey: args.idempotencyKey ?? "meeting-1",
		reservedBytes: args.reservedBytes ?? 10 * MIB,
		expiresAt: args.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
	};
}

function target_body(
	args: { idempotencyKey?: string; targetKey?: string; path?: string; contentType?: string; size?: number } = {},
) {
	return {
		idempotencyKey: args.idempotencyKey ?? "meeting-1",
		targetKey: args.targetKey ?? "recording",
		path: args.path ?? "/meetings/meeting-1/recording.mp4",
		contentType: args.contentType ?? "video/mp4",
		size: args.size ?? 4 * MIB,
	};
}

async function read_quota(t: ReturnType<typeof test_convex>, fixture: Awaited<ReturnType<typeof seed_installation>>) {
	return await t.run(async (ctx) => {
		return await ctx.db
			.query("quotas")
			.withIndex("by_workspace_quotaName", (q) =>
				q.eq("workspaceId", fixture.workspaceId).eq("quotaName", "plugin_service_storage_bytes"),
			)
			.first();
	});
}

async function read_reservations(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => await ctx.db.query("plugin_service_storage_reservations").collect());
}

async function read_targets(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => await ctx.db.query("plugin_service_storage_targets").collect());
}

/**
 * Play the R2 finalizer: the staged object was copied to the canonical `assets/<assetId>` key and
 * Convex records it, exactly like `/api/r2/event` does after a real PUT.
 */
async function simulate_finalizer(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	target: Doc<"plugin_service_storage_targets">,
	args: { size: number },
) {
	const asset = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", target.assetId));
	if (!asset?.uploadStagingR2Key) {
		throw new Error("Expected a staged upload asset for the target");
	}
	const canonicalKey = `organizations/${fixture.organizationId}/workspaces/${fixture.workspaceId}/assets/${target.assetId}`;
	await t.mutation(internal.r2.process_uploaded_asset_event, {
		assetId: target.assetId,
		r2Key: canonicalKey,
		uploadStagingR2Key: asset.uploadStagingR2Key,
		size: args.size,
		etag: "etag-service-upload",
		eventId: `service-upload-test-${String(target._id)}`,
	});
	return canonicalKey;
}

describe("service upload authorization", () => {
	test("refuses a page token on every service upload route", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		for (const [path, body] of [
			[RESERVE_PATH, reserve_body()],
			[CREATE_TARGET_PATH, target_body()],
			[REMINT_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[FINALIZE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[RELEASE_PATH, { idempotencyKey: "meeting-1" }],
			[DELETE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[ARCHIVE_PATH, {}],
		] as const) {
			const response = await call(t, path, pageToken, body);
			expect(response.status, path).toBe(403);
		}
		expect(await read_reservations(t)).toHaveLength(0);
	});

	test("refuses an interactive grant even when it somehow carries files:write and a prefix", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		// Forge the exact doc the exchange refuses to mint: an interactive grant with the write scope
		// and a destination. Only the phase is wrong, so this pins the phase check itself rather than
		// the scope narrowing in front of it.
		const token = `psg_${crypto_random_hex(32)}`;
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("plugin_service_grants", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "council",
				actorUserId: fixture.userId,
				tokenHash: await crypto_sha256_hex(token),
				scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
				principalKey: `plugin_service:${fixture.organizationId}:${fixture.workspaceId}:${fixture.installationId}`,
				phase: "interactive",
				destinationPathPrefix: "/meetings",
				expiresAt: now + 60 * 60 * 1000,
				updatedAt: now,
			});
		});

		const response = await call(t, RESERVE_PATH, token, reserve_body());
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await read_reservations(t)).toHaveLength(0);
	});

	test("refuses a processing grant once workspace.files.write is taken back", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.service.connect", "plugin.data.read", "plugin.data.write"],
			});
		});

		const response = await call(t, RESERVE_PATH, sealed, reserve_body());
		expect(response.status).toBe(403);
		expect(await read_reservations(t)).toHaveLength(0);
	});

	test("refuses a processing grant whose installation was disabled", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});

		const response = await call(t, RESERVE_PATH, sealed, reserve_body());
		expect(response.status).toBe(401);
		expect(await read_reservations(t)).toHaveLength(0);
	});

	test("refuses a processing grant after the actor loses the workspace", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false });
		});

		const response = await call(t, RESERVE_PATH, sealed, reserve_body());
		expect(response.status).toBe(401);
		expect(await read_reservations(t)).toHaveLength(0);
	});

	test("refuses an expired processing grant", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		await t.run(async (ctx) => {
			const grants = await ctx.db.query("plugin_service_grants").collect();
			const processing = grants.find((grant) => grant.phase === "processing")!;
			await ctx.db.patch("plugin_service_grants", processing._id, { expiresAt: Date.now() - 1000 });
		});

		const response = await call(t, RESERVE_PATH, sealed, reserve_body());
		expect(response.status).toBe(401);
		expect(await read_reservations(t)).toHaveLength(0);
	});

	test("refuses a target path outside the sealed destination", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		const reserved = await call(t, RESERVE_PATH, sealed, reserve_body());
		expect(reserved.status).toBe(200);

		// Outside entirely, a sibling that only shares the prefix string, and the destination folder
		// itself. Each one must refuse and create nothing.
		for (const path of ["/elsewhere/recording.mp4", "/meetingsevil/recording.mp4", "/meetings"]) {
			const response = await call(t, CREATE_TARGET_PATH, sealed, target_body({ path }));
			expect(response.status, path).toBe(403);
			expect(await response.json(), path).toEqual({ message: "Path is outside this grant's destination" });
		}
		expect(await read_targets(t)).toHaveLength(0);
		const nodes = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(nodes).toHaveLength(0);
	});

	test("a grant from workspace A cannot touch workspace B's reservation", async () => {
		const t = test_convex();
		const fixtureA = await seed_installation(t, { organizationName: "org-a", workspaceName: "ws-a" });
		const fixtureB = await seed_installation(t, { organizationName: "org-b", workspaceName: "ws-b" });
		const sealedA = await seal_token(t, fixtureA);
		const sealedB = await seal_token(t, fixtureB);

		const reservedB = await call(t, RESERVE_PATH, sealedB, reserve_body({ idempotencyKey: "meeting-b" }));
		expect(reservedB.status).toBe(200);

		// A's grant naming B's idempotency key finds nothing: reservations are keyed inside A's own
		// installation, so B's meeting is not reachable, let alone spendable.
		const crossTarget = await call(t, CREATE_TARGET_PATH, sealedA, target_body({ idempotencyKey: "meeting-b" }));
		expect(crossTarget.status).toBe(404);
		const crossRelease = await call(t, RELEASE_PATH, sealedA, { idempotencyKey: "meeting-b" });
		expect(crossRelease.status).toBe(404);

		// Only B's workspace quota was charged.
		const quotaA = await read_quota(t, fixtureA);
		const quotaB = await read_quota(t, fixtureB);
		expect(quotaA?.usedCount ?? 0).toBe(0);
		expect(quotaB?.usedCount).toBe(10 * MIB);
	});
});

describe("service upload reservations and quota", () => {
	test("reserve charges the workspace quota once, and a replay answers from the live reservation", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);

		const body = reserve_body();
		const first = await call(t, RESERVE_PATH, sealed, body);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { reservationId: string; remainingBytes: number };
		expect(firstBody.remainingBytes).toBe(10 * MIB);

		const replay = await call(t, RESERVE_PATH, sealed, body);
		expect(replay.status).toBe(200);
		const replayBody = (await replay.json()) as { reservationId: string; remainingBytes: number };
		expect(replayBody.reservationId).toBe(firstBody.reservationId);

		expect(await read_reservations(t)).toHaveLength(1);
		expect((await read_quota(t, fixture))?.usedCount).toBe(10 * MIB);

		// The same key with different fields is a different request, not a replay.
		const conflicting = await call(t, RESERVE_PATH, sealed, { ...body, reservedBytes: 12 * MIB });
		expect(conflicting.status).toBe(409);
	});

	test("refuses a reservation that would cross the workspace quota, and charges nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		const first = await call(t, RESERVE_PATH, sealed, reserve_body());
		expect(first.status).toBe(200);
		// Push the counter to one byte under the ceiling so any real envelope must refuse.
		await t.run(async (ctx) => {
			const quota = await ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", fixture.workspaceId).eq("quotaName", "plugin_service_storage_bytes"),
				)
				.first();
			await ctx.db.patch("quotas", quota!._id, { usedCount: quota!.maxCount - 1 });
		});

		const refused = await call(
			t,
			RESERVE_PATH,
			sealed,
			reserve_body({ idempotencyKey: "meeting-2", reservedBytes: MIB }),
		);
		expect(refused.status).toBe(403);
		expect(await read_reservations(t)).toHaveLength(1);
		expect((await read_quota(t, fixture))?.usedCount).toBe((await read_quota(t, fixture))!.maxCount - 1);
	});

	test("release refunds the unspent envelope, cleans pending uploads, and answers a replay the same", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		const created = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(created.status).toBe(200);
		const target = (await read_targets(t))[0]!;

		const released = await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" });
		expect(released.status).toBe(200);
		// 6 MiB the targets never claimed plus the 4 MiB pending upload that will never finish.
		expect(await released.json()).toEqual({ releasedBytes: 10 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		// The pending upload's placeholder file and asset doc are gone, and the exact keys the signed
		// URL could still write to have deletion jobs.
		const node = await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId));
		expect(node).toBeNull();
		const asset = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", target.assetId));
		expect(asset).toBeNull();
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", destinationNodeId: expect.any(String) });
		const jobs = await t.run(async (ctx) => await ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.length).toBeGreaterThanOrEqual(1);

		const replay = await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" });
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ releasedBytes: 10 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
	});

	test("release keeps a pending upload while its placeholder is read-only", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", target.nodeId, { readOnlyScopeNodeId: target.nodeId });
		});

		const refused = await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });
		expect((await read_reservations(t))[0]).toMatchObject({ state: "live", remainingBytes: 6 * MIB });
		expect((await read_targets(t))[0]).toMatchObject({ state: "pending" });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).not.toBeNull();
		expect((await read_quota(t, fixture))?.usedCount).toBe(10 * MIB);

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", target.nodeId, { readOnlyScopeNodeId: undefined });
		});
		expect((await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" })).status).toBe(200);
	});

	test("the expiry cron releases a live reservation whose deadline passed", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		await t.run(async (ctx) => {
			const reservation = (await ctx.db.query("plugin_service_storage_reservations").collect())[0]!;
			await ctx.db.patch("plugin_service_storage_reservations", reservation._id, { expiresAt: Date.now() - 1000 });
		});

		await t.mutation(internal.public_api_service_uploads.cleanup_expired_service_upload_reservations, {
			_test_disableReschedule: true,
		});

		const reservations = await read_reservations(t);
		expect(reservations[0]!.state).toBe("released");
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
	});
});

describe("service upload targets", () => {
	test("creates a target with a forced-skipProcessing asset and answers a replay without charging twice", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);

		const body = target_body();
		const first = await call(t, CREATE_TARGET_PATH, sealed, body);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			state: string;
			path: string;
			nodeId: string;
			uploadUrl: string;
			headers: Record<string, string>;
		};
		expect(firstBody.state).toBe("pending");
		expect(firstBody.uploadUrl).toContain("upload-staging");
		expect(firstBody.headers).toEqual({ "Content-Type": "video/mp4" });

		// The conversion/plugin pipeline is suppressed at the asset itself, not by a caller flag.
		const targets = await read_targets(t);
		expect(targets).toHaveLength(1);
		expect(targets[0]).toMatchObject({
			destinationPath: "/meetings",
			destinationNodeId: expect.any(String),
		});
		const asset = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", targets[0]!.assetId));
		expect(asset?.processingWorkId).toBeNull();

		const reservations = await read_reservations(t);
		expect(reservations[0]!.remainingBytes).toBe(6 * MIB);

		const replay = await call(t, CREATE_TARGET_PATH, sealed, body);
		expect(replay.status).toBe(200);
		const replayBody = (await replay.json()) as { state: string; nodeId: string };
		expect(replayBody.state).toBe("pending");
		expect(replayBody.nodeId).toBe(firstBody.nodeId);
		expect(await read_targets(t)).toHaveLength(1);
		expect((await read_reservations(t))[0]!.remainingBytes).toBe(6 * MIB);

		// The same target key describing a different file is a conflict, not a second file.
		const conflicting = await call(t, CREATE_TARGET_PATH, sealed, { ...body, size: 5 * MIB });
		expect(conflicting.status).toBe(409);
	});

	test("a markdown target runs the upload conversion and still settles committed", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);

		const created = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({
				targetKey: "transcript_markdown",
				path: "/meetings/meeting-1/transcript.md",
				contentType: "text/markdown",
				size: 1024,
			}),
		);
		expect(created.status).toBe(200);

		// The editable-text name leaves the processing marker unset, so the R2 event finalizer
		// starts the same conversion a member upload gets. Non-text targets stay forced to null.
		const target = (await read_targets(t))[0]!;
		const asset = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", target.assetId));
		expect(asset?.processingWorkId).toBeUndefined();

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_service_transcript" as never);
		try {
			await simulate_finalizer(t, fixture, target, { size: 1024 });
			expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
			expect(enqueueActionSpy.mock.calls[0]![2]).toMatchObject({ assetId: target.assetId });
		} finally {
			enqueueActionSpy.mockRestore();
		}
		const converting = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", target.assetId));
		expect(converting?.processingWorkId).toBe("work_service_transcript");

		// The books do not wait for the conversion: finalize answers committed from the canonical
		// object alone.
		const finalized = await call(t, FINALIZE_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "transcript_markdown",
		});
		expect(finalized.status).toBe(200);
		expect(await finalized.json()).toMatchObject({ state: "committed", actualBytes: 1024 });
	});

	test("refuses a target larger than the reservation's remaining bytes", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body({ reservedBytes: 3 * MIB }))).status).toBe(200);

		const response = await call(t, CREATE_TARGET_PATH, sealed, target_body({ size: 4 * MIB }));
		expect(response.status).toBe(403);
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("remint reissues a URL for the same staging key without new nodes, assets, or charges", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const targetBefore = (await read_targets(t))[0]!;
		const assetBefore = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", targetBefore.assetId));

		const response = await call(t, REMINT_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { state: string; nodeId: string; uploadUrl: string };
		expect(body.state).toBe("pending");
		expect(body.nodeId).toBe(String(targetBefore.nodeId));
		expect(body.uploadUrl).toContain(assetBefore!.uploadStagingR2Key!);

		// Nothing new was created and nothing more was charged.
		expect(await read_targets(t)).toHaveLength(1);
		const assets = await t.run(async (ctx) => await ctx.db.query("files_r2_assets").collect());
		expect(assets).toHaveLength(1);
		expect((await read_reservations(t))[0]!.remainingBytes).toBe(6 * MIB);
		// The URL window moved forward so the next PUT fits inside it.
		expect(assets[0]!.uploadUrlExpiresAt).toBeGreaterThanOrEqual(assetBefore!.uploadUrlExpiresAt!);
	});

	test("finalize answers pending before the object is confirmed, then settles the actual bytes once", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);

		const early = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(early.status).toBe(200);
		expect(((await early.json()) as { state: string }).state).toBe("pending");

		// The finalizer confirms a 3 MiB object against a 4 MiB declaration.
		const target = (await read_targets(t))[0]!;
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });

		const settled = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(settled.status).toBe(200);
		expect(await settled.json()).toMatchObject({ state: "committed", actualBytes: 3 * MIB });

		// The 1 MiB the file never used went back into the envelope.
		expect((await read_reservations(t))[0]!.remainingBytes).toBe(7 * MIB);

		// Settling is idempotent: a replay answers the same and moves no bytes.
		const replay = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ state: "committed", actualBytes: 3 * MIB });
		expect((await read_reservations(t))[0]!.remainingBytes).toBe(7 * MIB);

		// Remint after canonicalization also answers committed instead of minting a useless URL.
		const remint = await call(t, REMINT_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(remint.status).toBe(200);
		expect(await remint.json()).toMatchObject({ state: "committed", actualBytes: 3 * MIB });

		// After release, only the stored file stays charged.
		const released = await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" });
		expect(released.status).toBe(200);
		expect(await released.json()).toEqual({ releasedBytes: 7 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
	});

	test("only deleting the charged canonical object gives the stored bytes back", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const canonicalKey = await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		expect((await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" })).status).toBe(200);
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);

		// R2 confirms the canonical object is physically gone; that settlement is what releases the
		// stored bytes, exactly once.
		const jobId = await t.run(async (ctx) => {
			return await ctx.db.insert("files_r2_object_deletion_jobs", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				r2Key: canonicalKey,
				reason: "untracked_asset_event",
				generation: 1,
				attempts: 0,
				nextAttemptAt: Date.now(),
			});
		});
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId,
			generation: 1,
			deletedAt: Date.now(),
		});

		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
		// The charged target doc is consumed by the settlement, so it cannot refund twice.
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("an upload that expired before finishing is released instead of staying charged", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		// The unfinalized-asset cleanup gave up on this upload and deleted its asset doc.
		await t.run(async (ctx) => {
			await ctx.db.delete("files_r2_assets", target.assetId);
		});

		const finalized = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(finalized.status).toBe(200);
		expect(((await finalized.json()) as { state: string }).state).toBe("released");
		// The declared bytes went back into the envelope for a retried target under a new key.
		expect((await read_reservations(t))[0]!.remainingBytes).toBe(10 * MIB);

		const reminted = await call(t, REMINT_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(reminted.status).toBe(409);
	});
});

describe("service upload delete", () => {
	test("deletes a committed file under a newly sealed grant and refunds only at physical settlement", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const canonicalKey = await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		expect((await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" })).status).toBe(200);
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);

		// Days later the meeting is deleted under a brand new grant sealed to the same destination.
		const laterSealed = await seal_token(t, fixture);
		const body = { idempotencyKey: "delete-meeting-1", targetKey: "recording" };
		const first = await call(t, DELETE_PATH, laterSealed, body);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ state: "deleting", paths: ["/meetings/meeting-1/recording.mp4"] });

		// The file left the workspace and the canonical key has a deletion job, but the stored bytes
		// stay charged until R2 confirms the object is physically gone.
		expect(await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId))).toBeNull();
		expect(await t.run(async (ctx) => await ctx.db.get("files_r2_assets", target.assetId))).toBeNull();
		const job = await t.run(
			async (ctx) =>
				await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
					.first(),
		);
		expect(job).toMatchObject({ generation: 1 });
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
		const marked = (await read_targets(t))[0]!;
		expect(marked.state).toBe("committed");
		expect(marked.deleteRequestedAt).toBeTypeOf("number");

		// A replay answers the same and does not touch the deletion job again.
		const replay = await call(t, DELETE_PATH, laterSealed, body);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ state: "deleting", paths: ["/meetings/meeting-1/recording.mp4"] });
		const jobAfterReplay = await t.run(
			async (ctx) =>
				await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
					.first(),
		);
		expect(jobAfterReplay).toMatchObject({ generation: 1 });

		// R2 confirms the delete: the stored bytes come back exactly once and the target becomes a
		// tombstone that keeps answering replays as deleted.
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job!._id,
			generation: job!.generation,
			deletedAt: Date.now(),
		});
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
		expect((await read_targets(t))[0]!.state).toBe("released");

		const afterSettle = await call(t, DELETE_PATH, laterSealed, body);
		expect(afterSettle.status).toBe(200);
		expect(await afterSettle.json()).toEqual({ state: "deleted", paths: ["/meetings/meeting-1/recording.mp4"] });
	});

	test("refuses to delete a target that is still uploading", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);

		const response = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" });
		expect(response.status).toBe(409);

		// The unfinished upload and its placeholder file are untouched; release owns pending targets.
		const target = (await read_targets(t))[0]!;
		expect(target.state).toBe("pending");
		expect(target.deleteRequestedAt).toBeUndefined();
		expect(await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
	});

	test("a read-only file refuses the hard delete and keeps the node", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		expect((await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" })).status).toBe(200);

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", target.nodeId, { readOnlyScopeNodeId: target.nodeId });
		});

		const laterSealed = await seal_token(t, fixture);
		const response = await call(t, DELETE_PATH, laterSealed, {
			idempotencyKey: "delete-1",
			targetKey: "recording",
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This item is read-only." });
		expect(await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
		expect((await read_targets(t))[0]!.deleteRequestedAt).toBeUndefined();
	});

	test("a grant sealed to another destination cannot see the target", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);

		// The stored path is under /meetings, so a grant sealed to /other must not even learn that the
		// target key exists.
		const foreign = await seal_token(t, fixture, "/other");
		const response = await call(t, DELETE_PATH, foreign, { idempotencyKey: "delete-1", targetKey: "recording" });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: "Not found" });
		expect(await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
		expect((await read_targets(t))[0]!.deleteRequestedAt).toBeUndefined();
	});

	test("an unknown target key answers not found", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);

		const response = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: "Not found" });
	});
});

describe("service upload archive", () => {
	test("archives the destination folder with its whole subtree and keeps the stored bytes charged", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const canonicalKey = await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		expect((await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" })).status).toBe(200);
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);

		// A member put their own notes in the meeting folder. The archive sweeps the subtree, so their
		// file and its folder travel with the meeting folder instead of being left behind.
		await t.run(async (ctx) => {
			await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				parentId: files_ROOT_ID,
				path: "/meetings/meeting-1/notes/member.txt",
				kind: "file",
				contentType: "text/plain",
				now: Date.now(),
			});
		});

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 4 });

		// One operation id covers the folder and everything under it, which is what lets a member
		// restore the exact set this call took.
		const nodes = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		const archived = nodes.filter((node) => node.archiveOperationId !== undefined);
		expect(archived.map((node) => node.path).sort()).toEqual([
			"/meetings/meeting-1",
			"/meetings/meeting-1/notes",
			"/meetings/meeting-1/notes/member.txt",
			"/meetings/meeting-1/recording.mp4",
		]);
		expect(new Set(archived.map((node) => node.archiveOperationId)).size).toBe(1);
		// The folder above the destination is not this grant's to touch. Check it is still there and
		// active: a door that deleted it would pass an `undefined` read just as well.
		const parent = nodes.find((node) => node.path === "/meetings");
		expect(parent).toBeDefined();
		expect(parent?.archiveOperationId).toBeUndefined();

		// The files still exist, so the books do not move and no object is deleted.
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
		expect((await read_targets(t))[0]!.state).toBe("committed");
		expect((await read_targets(t))[0]!.deleteRequestedAt).toBeUndefined();
		expect(
			await t.run(
				async (ctx) =>
					await ctx.db
						.query("files_r2_object_deletion_jobs")
						.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
						.first(),
			),
		).toBeNull();

		// A replay finds nothing active at the destination and archives nothing more. Read the nodes
		// again: the first call's operation id must survive, so a member restoring the set still gets
		// exactly what the delete took.
		const replay = await call(t, ARCHIVE_PATH, sealed, {});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ archivedNodes: 0 });
		const afterReplay = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(
			afterReplay
				.filter((node) => node.archiveOperationId !== undefined)
				.map((node) => node.path)
				.sort(),
		).toEqual(archived.map((node) => node.path).sort());
		expect(new Set(afterReplay.map((node) => node.archiveOperationId).filter(Boolean)).size).toBe(1);
	});

	test("a grant archives its own destination and leaves the sibling meeting alone", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const first = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, first, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, first, target_body())).status).toBe(200);

		// A second meeting, stored the same way. Both folders exist, so the refusal below cannot come
		// from an empty path — only the seal decides which one this grant reaches.
		const second = await seal_token(t, fixture, "/meetings/meeting-2");
		expect((await call(t, RESERVE_PATH, second, reserve_body({ idempotencyKey: "meeting-2" }))).status).toBe(200);
		expect(
			(
				await call(
					t,
					CREATE_TARGET_PATH,
					second,
					target_body({ idempotencyKey: "meeting-2", path: "/meetings/meeting-2/recording.mp4" }),
				)
			).status,
		).toBe(200);

		const response = await call(t, ARCHIVE_PATH, second, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 2 });

		const nodes = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(
			nodes
				.filter((node) => node.archiveOperationId !== undefined)
				.map((node) => node.path)
				.sort(),
		).toEqual(["/meetings/meeting-2", "/meetings/meeting-2/recording.mp4"]);
	});

	test("archives the same destination after a member renames the folder", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		if (!target.destinationNodeId) {
			throw new Error("Expected the upload target to keep its destination folder id");
		}
		// An older target can sort first by file path. The archive lookup must prefer the current
		// destination-id index instead of falling back to this unbackfilled doc.
		await t.run(async (ctx) => {
			await ctx.db.insert("plugin_service_storage_targets", {
				organizationId: target.organizationId,
				workspaceId: target.workspaceId,
				installationId: target.installationId,
				reservationId: target.reservationId,
				targetKey: "legacy-target",
				requestFingerprint: "legacy-target",
				path: "/meetings/meeting-1/aaa-old.mp4",
				contentType: target.contentType,
				declaredBytes: target.declaredBytes,
				actualBytes: target.actualBytes,
				nodeId: target.nodeId,
				assetId: target.assetId,
				state: target.state,
				createdBy: target.createdBy,
				updatedAt: target.updatedAt,
			});
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: fixture.membershipId,
			nodeId: target.destinationNodeId,
			path: "renamed-meeting",
		});
		expect(renamed).toEqual({ _yay: null });

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 2 });
		const destination = await t.run(async (ctx) => ctx.db.get("files_nodes", target.destinationNodeId!));
		expect(destination).toMatchObject({ path: "/meetings/renamed-meeting", archiveOperationId: expect.any(String) });
	});

	test("keeps the destination identity after releasing a pending upload", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		if (!target.destinationNodeId) {
			throw new Error("Expected the upload target to keep its destination folder id");
		}

		expect((await call(t, RELEASE_PATH, sealed, { idempotencyKey: "meeting-1" })).status).toBe(200);
		expect((await read_targets(t))[0]).toMatchObject({
			state: "released",
			destinationNodeId: target.destinationNodeId,
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				nodeId: target.destinationNodeId,
				path: "renamed-after-release",
			}),
		).toEqual({ _yay: null });

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 1 });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.destinationNodeId!))).toMatchObject({
			path: "/meetings/renamed-after-release",
			archiveOperationId: expect.any(String),
		});
	});

	test("refuses before reading past the 256-node archive limit, including archived children", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		if (!target.destinationNodeId) {
			throw new Error("Expected the upload target to keep its destination folder id");
		}
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let index = 0; index < 255; index += 1) {
				const path = `/meetings/meeting-1/old-${index}`;
				await ctx.db.insert("files_nodes", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					path,
					treePath: `${path}/`,
					pathDepth: 3,
					lowercaseExtension: null,
					name: `old-${index}`,
					kind: "folder",
					archiveOperationId: "older-archive",
					parentId: target.destinationNodeId!,
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			}
		});

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			message: "A destination archives at most 256 files and folders; move some out and try again",
		});
	});

	test("a destination the grant never created archives nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const owned = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, owned, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, owned, target_body())).status).toBe(200);

		// The seal names a folder nobody made. It must not fall back to anything that does exist.
		const foreign = await seal_token(t, fixture, "/other");
		const response = await call(t, ARCHIVE_PATH, foreign, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 0 });

		const nodes = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(nodes.every((node) => node.archiveOperationId === undefined)).toBe(true);
	});

	test("a restricted destination the actor was never granted refuses the archive", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const owned = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, owned, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, owned, target_body())).status).toBe(200);

		// The organization owner passes every restricted scope, so this refusal only means something
		// with a plain member as the actor. Give the workspace a second member: they hold workspace
		// `content.write` like everyone else, and nobody granted them this folder.
		const memberUserId = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				role: "member",
				now,
			});

			// Somebody restricted the meeting folder. The scope stamps the whole subtree, exactly as
			// restricting a folder in the file tree does.
			const nodes = await ctx.db.query("files_nodes").collect();
			const destination = nodes.find((node) => node.path === "/meetings/meeting-1")!;
			for (const node of nodes.filter((node) => node.path.startsWith("/meetings/meeting-1"))) {
				await ctx.db.patch("files_nodes", node._id, { restrictedScopeNodeId: destination._id });
			}

			return userId;
		});

		const sealed = await seal_token(t, fixture, "/meetings/meeting-1", memberUserId);
		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });

		const nodes = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(nodes.every((node) => node.archiveOperationId === undefined)).toBe(true);
	});

	test("a read-only file inside the destination refuses the whole archive", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, RESERVE_PATH, sealed, reserve_body())).status).toBe(200);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", target.nodeId, { readOnlyScopeNodeId: target.nodeId });
		});

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This item is read-only." });

		// All or nothing: the lock keeps the folder above it active too.
		const nodes = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(nodes.every((node) => node.archiveOperationId === undefined)).toBe(true);
	});
});
