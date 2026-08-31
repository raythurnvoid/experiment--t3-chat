import { describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";

import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { public_api_service_uploads_db_drain_batch } from "./public_api_service_uploads.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { files_MAX_UPLOADS_BYTES, files_ROOT_ID } from "../server/files.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const SEAL_PROCESSING_PATH = "/api/internal/plugins/service-grants/seal-processing";
const CREATE_TARGET_PATH = "/api/v1/files/service-uploads/create-target";
const REMINT_PATH = "/api/v1/files/service-uploads/remint";
const FINALIZE_PATH = "/api/v1/files/service-uploads/finalize";
const DELETE_PATH = "/api/v1/files/service-uploads/delete";
const ARCHIVE_PATH = "/api/v1/files/service-uploads/archive-destination";

/** The value `setup-env.test.ts` puts in the environment for the whole convex project. */
const EXCHANGE_SECRET = "SERVICE_EXCHANGE_SECRET_TEST";

const MIB = 1024 * 1024;

const SERVICE_CAPABILITIES: plugins_Capability[] = [
	"plugin.service.connect",
	"plugin.data.read",
	"plugin.data.write",
	"workspace.files.write",
	"workspace.files.create-read-only",
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
		/** Service uploads are closed to `Free`, so the fixture pays by default. `null` leaves the payer with no billing state at all. */
		plan?: keyof typeof billing_PRODUCTS | null;
	} = {},
) {
	const installation = await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, {
			...(args.organizationName === undefined ? {} : { organizationName: args.organizationName }),
			...(args.workspaceName === undefined ? {} : { workspaceName: args.workspaceName }),
			plan: args.plan,
		});
		const capabilities = args.acceptedCapabilities ?? SERVICE_CAPABILITIES;
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
		// The exchange proves the presented service secret against the plugin's registration row.
		await ctx.db.insert("plugins_service_registrations", {
			pluginName,
			exchangeSecretHash: await crypto_sha256_hex(EXCHANGE_SECRET),
			scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
			createdBy: membership.userId,
			updatedAt: now,
		});
		return { ...membership, pluginVersionId, installationId } as const;
	});

	return installation;
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

function target_body(
	args: {
		idempotencyKey?: string;
		targetKey?: string;
		path?: string;
		contentType?: string;
		size?: number;
		readOnly?: boolean;
		nonCollaborative?: boolean;
	} = {},
) {
	return {
		idempotencyKey: args.idempotencyKey ?? "meeting-1",
		targetKey: args.targetKey ?? "recording",
		path: args.path ?? "/meetings/meeting-1/recording.mp4",
		contentType: args.contentType ?? "video/mp4",
		size: args.size ?? 4 * MIB,
		readOnly: args.readOnly ?? false,
		nonCollaborative: args.nonCollaborative ?? false,
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

async function set_quota_used(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	usedCount: number,
) {
	const quota = await read_quota(t, fixture);
	await t.run(async (ctx) => await ctx.db.patch("quotas", quota!._id, { usedCount }));
}

async function read_targets(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => await ctx.db.query("plugin_service_storage_targets").collect());
}

/** The fixture payer is anonymous, so every billing charge lands on this snapshot meter. */
async function read_meter(t: ReturnType<typeof test_convex>, fixture: Awaited<ReturnType<typeof seed_installation>>) {
	return await t.run(async (ctx) => {
		const snapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", fixture.userId))
			.first();
		if (!snapshot?.meter) {
			throw new Error("Expected a seeded usage snapshot");
		}
		return snapshot.meter;
	});
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
			[CREATE_TARGET_PATH, target_body()],
			[REMINT_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[FINALIZE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[DELETE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[ARCHIVE_PATH, {}],
		] as const) {
			const response = await call(t, path, pageToken, body);
			expect(response.status, path).toBe(403);
		}
		expect(await read_targets(t)).toHaveLength(0);
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

		const response = await call(t, CREATE_TARGET_PATH, token, target_body());
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await read_targets(t)).toHaveLength(0);
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

		const response = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(response.status).toBe(403);
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("refuses a processing grant whose installation was disabled", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});

		const response = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(response.status).toBe(401);
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("refuses a processing grant after the actor loses the workspace", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false });
		});

		const response = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(response.status).toBe(401);
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("does not restore an old grant after hard deletion, same-email recovery, and reinvite", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const actor = await t.run(async (ctx) => {
			const seeded = await test_mocks_fill_db_with.membership(ctx, {
				organizationName: "deleted-actor",
			});
			const anagraphicId = await ctx.db.insert("users_anagraphics", {
				userId: seeded.userId,
				displayName: "Deleted Service Actor",
				email: "deleted-service-actor@test.local",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", seeded.userId, {
				clerkUserId: "clerk-deleted-service-actor",
				anagraphic: anagraphicId,
			});
			return seeded;
		});
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Service Owner",
		});
		expect(
			await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userIdToAdd: actor.userId,
			}),
		).toEqual({ _yay: null });

		const oldGrant = await seal_token(t, fixture, "/meetings", actor.userId);
		const created = await call(t, CREATE_TARGET_PATH, oldGrant, target_body());
		expect(created.status).toBe(200);

		let prepared = false;
		for (let pass = 0; pass < 20 && !prepared; pass += 1) {
			prepared = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
					userId: actor.userId,
					_test_batchSize: 1,
				}),
			);
		}
		expect(prepared).toBe(true);

		let finalized = false;
		for (let pass = 0; pass < 30 && !finalized; pass += 1) {
			finalized = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: actor.userId,
					deleteUserAuth: true,
					_test_batchSize: 1,
				}),
			);
		}
		expect(finalized).toBe(true);
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("plugin_service_grants")
					.withIndex("by_actorUser", (q) => q.eq("actorUserId", actor.userId))
					.first(),
			),
		).toBeNull();

		const recovered = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-deleted-service-actor-again",
				email: "deleted-service-actor@test.local",
				displayName: "Deleted Service Actor Again",
			}),
		);
		expect(recovered._yay?.userId).toBe(actor.userId);
		expect(
			await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userIdToAdd: actor.userId,
			}),
		).toEqual({ _yay: null });

		const replay = await call(t, CREATE_TARGET_PATH, oldGrant, target_body());
		expect(replay.status).toBe(401);
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

		const response = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(response.status).toBe(401);
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("refuses a target path outside the sealed destination", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);

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

	test("a grant from workspace A cannot touch workspace B's upload target", async () => {
		const t = test_convex();
		const fixtureA = await seed_installation(t, { organizationName: "org-a", workspaceName: "ws-a" });
		const fixtureB = await seed_installation(t, { organizationName: "org-b", workspaceName: "ws-b" });
		const sealedA = await seal_token(t, fixtureA);
		const sealedB = await seal_token(t, fixtureB);

		const createdB = await call(t, CREATE_TARGET_PATH, sealedB, target_body({ idempotencyKey: "meeting-b" }));
		expect(createdB.status).toBe(200);

		// A's grant naming B's keys finds nothing: targets are keyed inside A's own installation, so
		// B's file is not reachable, let alone reusable.
		const crossRemint = await call(t, REMINT_PATH, sealedA, { idempotencyKey: "meeting-b", targetKey: "recording" });
		expect(crossRemint.status).toBe(404);
		const crossDelete = await call(t, DELETE_PATH, sealedA, { idempotencyKey: "meeting-b", targetKey: "recording" });
		expect(crossDelete.status).toBe(404);

		// B's stored bytes are charged to B alone, and B still holds its one file.
		await simulate_finalizer(t, fixtureB, (await read_targets(t))[0]!, { size: 3 * MIB });
		const quotaA = await read_quota(t, fixtureA);
		const quotaB = await read_quota(t, fixtureB);
		expect(quotaA?.usedCount ?? 0).toBe(0);
		expect(quotaB?.usedCount).toBe(3 * MIB);
		expect(await read_targets(t)).toHaveLength(1);
	});

	test("a grant for another destination cannot remint or inspect a target in the same installation", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const meetingGrant = await seal_token(t, fixture, "/meetings");
		expect((await call(t, CREATE_TARGET_PATH, meetingGrant, target_body())).status).toBe(200);
		const otherGrant = await seal_token(t, fixture, "/exports");

		for (const [path, body] of [
			[REMINT_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[FINALIZE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
		] as const) {
			const response = await call(t, path, otherGrant, body);
			expect(response.status, path).toBe(404);
			expect(await response.json(), path).toEqual({ message: "Not found" });
		}
	});

	test("an archived placeholder cannot receive a fresh URL or expose target state", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		expect((await call(t, ARCHIVE_PATH, sealed, {})).status).toBe(200);

		for (const [path, body] of [
			[CREATE_TARGET_PATH, target_body()],
			[REMINT_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[FINALIZE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
		] as const) {
			const response = await call(t, path, sealed, body);
			expect(response.status, path).toBe(404);
			expect(await response.json(), path).toEqual({ message: "Not found" });
		}
	});
});

describe("service upload plan gate", () => {
	const PLAN_REFUSAL = "This workspace's plan does not include plugin service file storage";

	test("refuses a target when the payer is on Free, and writes nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: "Free" });
		const sealed = await seal_token(t, fixture);

		const refused = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: PLAN_REFUSAL });

		// A refusing mutation still commits whatever it wrote before returning, so the gate has to run
		// before the quota doc is seeded and before any file exists.
		expect(await read_targets(t)).toHaveLength(0);
		expect(await read_quota(t, fixture)).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_assets").collect())).toHaveLength(0);
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", fixture.organizationId)
							.eq("workspaceId", fixture.workspaceId)
							.eq("path", "/meetings/meeting-1/recording.mp4")
							.eq("archiveOperationId", undefined),
					)
					.first(),
			),
		).toBeNull();
	});

	test("refuses a target when the payer has no billing state at all", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: null });
		const sealed = await seal_token(t, fixture);

		const refused = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: PLAN_REFUSAL });
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("refuses a target for an anonymous payer's synthetic Free snapshot", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: null });
		// An anonymous user carries the real Free product id with null Polar ids. Seed that exact shape
		// instead of the signed-in one, because it is the only billing state an anonymous payer has.
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: fixture.userId, plan: "Free" }));
		await t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", fixture.userId))
				.first();
			await ctx.db.patch("billing_usage_snapshots", snapshot!._id, {
				polarCustomerId: null,
				subscription: { ...snapshot!.subscription!, id: null },
				meter: { ...snapshot!.meter!, id: null },
			});
		});
		const sealed = await seal_token(t, fixture);

		const refused = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: PLAN_REFUSAL });
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("an owner-billed organization reads the owner's plan, not the acting member's", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: "Free" });
		const ownerUserId = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				active: true,
			});
			// Ownership carries every permission, so the acting member needs a role of their own once the
			// organization belongs to someone else. `admin` is the role that has everything except billing.
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId: fixture.userId,
				role: "admin",
				now,
			});
			await ctx.db.patch("organizations", fixture.organizationId, {
				billingMode: "organization_owner",
				ownerUserId: userId,
			});
			return userId;
		});
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: ownerUserId, plan: "Pro" }));
		const sealed = await seal_token(t, fixture);

		// The member is on Free and the owner pays, so the upload is allowed.
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);

		// Move the owner to Free. The member's own plan never changed, so a refusal here can only come
		// from reading the owner.
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: ownerUserId, plan: "Free" }));
		const refused = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({ targetKey: "slides", path: "/meetings/meeting-1/slides.pdf", contentType: "application/pdf" }),
		);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: PLAN_REFUSAL });
		expect(await read_targets(t)).toHaveLength(1);
	});

	test("an accepted upload still remints and finalizes after the plan drops to Free", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;

		// Creating the target accepted the upload. A later downgrade must not strand a half-written
		// file, the same way a later read-only lock does not cancel it.
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: fixture.userId, plan: "Free" }));
		expect((await call(t, REMINT_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		const finalized = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(finalized.status).toBe(200);
		expect(await finalized.json()).toMatchObject({ state: "committed", actualBytes: 3 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);

		// A new target under the same grant is a new upload, so it answers to the current plan.
		const refused = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({ targetKey: "slides", path: "/meetings/meeting-1/slides.pdf", contentType: "application/pdf" }),
		);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: PLAN_REFUSAL });
	});
});

describe("service upload quota", () => {
	test("creating a target charges nothing and refuses only a workspace that is already full", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		// The size in the request is only the service's guess, so this door bills nothing for it.
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		// One byte of room is still room. This door stops the next file, not the current one, so a
		// declared size that would cross the ceiling is accepted.
		const ceiling = (await read_quota(t, fixture))!.maxCount;
		await set_quota_used(t, fixture, ceiling - 1);
		expect(
			(
				await call(
					t,
					CREATE_TARGET_PATH,
					sealed,
					target_body({
						targetKey: "slides",
						path: "/meetings/meeting-1/slides.pdf",
						contentType: "application/pdf",
						size: MIB,
					}),
				)
			).status,
		).toBe(200);

		await set_quota_used(t, fixture, ceiling);
		const refused = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({
				targetKey: "notes",
				path: "/meetings/meeting-1/notes.pdf",
				contentType: "application/pdf",
				size: MIB,
			}),
		);
		expect(refused.status).toBe(403);
		// Council's `convex-api.ts` matches this exact text by equality to tell the storage ceiling
		// apart from other 403s and stop retrying, so a reword here would break its fail-fast.
		expect(await refused.json()).toEqual({ message: "This workspace has used its plugin service storage" });
		expect(await read_targets(t)).toHaveLength(2);
		expect((await read_quota(t, fixture))?.usedCount).toBe(ceiling);
	});

	test("a stored object bigger than declared is charged in full, even past the ceiling", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;

		// A signed PUT does not bind the object's length, so the service can always store more than
		// it declared. Sit one byte under the ceiling to prove the settle charges the stored bytes
		// instead of refusing them: the quota is a budget, not a guard.
		const ceiling = (await read_quota(t, fixture))!.maxCount;
		await set_quota_used(t, fixture, ceiling - 1);
		const meterBefore = await read_meter(t, fixture);
		const canonicalKey = await simulate_finalizer(t, fixture, target, { size: 6 * MIB });

		// The R2 event owns settlement. The service does not need to make another API call for the
		// target or quota to become correct.
		expect((await read_targets(t))[0]).toMatchObject({ state: "committed", actualBytes: 6 * MIB });
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).toMatchObject({
			r2Key: canonicalKey,
			size: 6 * MIB,
		});
		expect((await read_quota(t, fixture))?.usedCount).toBe(ceiling - 1 + 6 * MIB);
		const meterSettled = await read_meter(t, fixture);
		expect(meterSettled.balance).toBe(meterBefore.balance - 1);

		// A later event can only describe the mutable staging object. It must not change the immutable
		// canonical size or charge the target again, in bytes or in money.
		await simulate_finalizer(t, fixture, target, { size: 9 * MIB });
		expect((await read_targets(t))[0]).toMatchObject({ state: "committed", actualBytes: 6 * MIB });
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).toMatchObject({
			r2Key: canonicalKey,
			size: 6 * MIB,
		});
		expect((await read_quota(t, fixture))?.usedCount).toBe(ceiling - 1 + 6 * MIB);
		expect(await read_meter(t, fixture)).toEqual(meterSettled);

		const settled = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(settled.status).toBe(200);
		expect(await settled.json()).toMatchObject({ state: "committed", actualBytes: 6 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(ceiling - 1 + 6 * MIB);
	});
});

describe("service upload drain", () => {
	test("uninstalling the plugin leaves every service-uploaded file alone", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);

		// One committed file, one placeholder whose upload never finished, and one placeholder a
		// member locked. Uninstalling must leave all three exactly where they are.
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		for (const targetKey of ["slides", "notes"]) {
			const created = await call(
				t,
				CREATE_TARGET_PATH,
				sealed,
				target_body({
					targetKey,
					path: `/meetings/meeting-1/${targetKey}.pdf`,
					contentType: "application/pdf",
				}),
			);
			expect(created.status, targetKey).toBe(200);
		}
		const targets = await read_targets(t);
		expect(targets).toHaveLength(3);
		const committed = targets.find((target) => target.targetKey === "recording")!;
		const locked = targets.find((target) => target.targetKey === "notes")!;
		await simulate_finalizer(t, fixture, committed, { size: 4 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", locked.nodeId, { readOnlyScopeNodeId: locked.nodeId });
		});
		// Canonicalizing the committed upload already queued its staging key for deletion. Count the
		// jobs now so the check below measures only what the drain adds.
		const jobsBefore = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());

		let passes = 0;
		for (;;) {
			const drained = await t.mutation(internal.plugins_data.drain_uninstalled_installation, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				_test_disableReschedule: true,
			});
			if (drained.done) {
				break;
			}

			passes += 1;
			if (passes > 20) {
				throw new Error("The drain never finished");
			}
		}

		// Uninstalling a plugin is not a workspace deletion: the files belong to the workspace, so
		// every node, target and stored object survives, locked or not.
		for (const target of targets) {
			expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId)), target.targetKey).not.toBeNull();
		}
		expect(await read_targets(t)).toHaveLength(3);
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toHaveLength(
			jobsBefore.length,
		);

		// Positive control: the drain really ran. It deletes the installation's service grants, so an
		// empty grant table is what proves the assertions above are not just a no-op that never fired.
		expect(await t.run(async (ctx) => ctx.db.query("plugin_service_grants").collect())).toHaveLength(0);
	});
});

describe("service upload targets", () => {
	test("refuses a declared size over the 2 GiB upload cap and accepts the cap itself", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);

		// Pin the number the host and Council both name. A silent revert to 500 MiB would pass
		// every other size test, because those tests read this constant instead of 2 GiB.
		expect(files_MAX_UPLOADS_BYTES).toBe(2 * 1024 * 1024 * 1024);
		// The service upload path is one signed PUT. R2 refuses a single PUT above 5 GiB.
		expect(files_MAX_UPLOADS_BYTES).toBeLessThanOrEqual(5 * 1024 * 1024 * 1024);

		const atCap = await call(t, CREATE_TARGET_PATH, sealed, target_body({ size: files_MAX_UPLOADS_BYTES }));
		expect(atCap.status, await atCap.clone().text()).toBe(200);

		const overCap = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({
				targetKey: "too-large",
				path: "/meetings/meeting-1/too-large.mp4",
				size: files_MAX_UPLOADS_BYTES + 1,
			}),
		);
		expect(overCap.status).toBe(400);
		expect(await overCap.json()).toEqual({ message: "File too large" });
		expect(await read_targets(t)).toHaveLength(1);
	});

	test("requires both mode flags and rejects non-collaborative binary targets", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		const { readOnly: _readOnly, nonCollaborative: _nonCollaborative, ...missingFlags } = target_body();

		const missing = await call(t, CREATE_TARGET_PATH, sealed, missingFlags);
		expect(missing.status).toBe(400);
		const binary = await call(t, CREATE_TARGET_PATH, sealed, target_body({ nonCollaborative: true }));
		expect(binary.status).toBe(400);
		expect(await binary.json()).toEqual({ message: "Only editable text files can be non-collaborative" });
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("creates a read-only target with exact provenance and fingerprints both mode flags", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		const body = target_body({ readOnly: true });
		const created = await call(t, CREATE_TARGET_PATH, sealed, body);
		expect(created.status).toBe(200);

		const target = (await read_targets(t))[0]!;
		expect(target).toMatchObject({ readOnly: true, nonCollaborative: false });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).toMatchObject({
			readOnlyScopeNodeId: target.nodeId,
			readOnlyPluginServiceTargetId: target._id,
		});
		expect((await call(t, CREATE_TARGET_PATH, sealed, body)).status).toBe(200);
		await simulate_finalizer(t, fixture, target, { size: 2 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);

		const changedMode = await call(t, CREATE_TARGET_PATH, sealed, { ...body, readOnly: false });
		expect(changedMode.status).toBe(409);
		expect(await read_targets(t)).toHaveLength(1);
	});

	test("requires the read-only capability and live manage permission before writing a target", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: SERVICE_CAPABILITIES.filter(
					(capability) => capability !== "workspace.files.create-read-only",
				),
			});
		});
		const missingCapability = await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }));
		expect(missingCapability.status).toBe(403);
		expect(await read_targets(t)).toHaveLength(0);

		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: SERVICE_CAPABILITIES,
			});
		});
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
			return userId;
		});
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: memberUserId, plan: "Pro" }));
		const memberSealed = await seal_token(t, fixture, "/meetings", memberUserId);
		const writable = await call(t, CREATE_TARGET_PATH, memberSealed, target_body({ readOnly: false }));
		expect(writable.status, await writable.clone().text()).toBe(200);
		expect(await read_targets(t)).toHaveLength(1);

		const missingManage = await call(
			t,
			CREATE_TARGET_PATH,
			memberSealed,
			target_body({ path: "/meetings/meeting-1/locked.mp4", targetKey: "locked", readOnly: true }),
		);
		expect(missingManage.status).toBe(403);
		expect(await missingManage.json()).toEqual({ message: "Permission denied" });
		expect(await read_targets(t)).toHaveLength(1);
	});

	test("allows 16 targets per upload run, including exact replays, and refuses a seventeenth", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		const bodies = Array.from({ length: 16 }, (_, index) =>
			target_body({
				targetKey: `file-${index}`,
				path: `/meetings/meeting-1/file-${index}.bin`,
				contentType: "application/octet-stream",
				size: 1,
			}),
		);

		for (const body of bodies) {
			expect((await call(t, CREATE_TARGET_PATH, sealed, body)).status).toBe(200);
		}
		expect(await read_targets(t)).toHaveLength(16);
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		// The limit bounds new targets, not idempotent retries of a target already inside the run.
		expect((await call(t, CREATE_TARGET_PATH, sealed, bodies[15])).status).toBe(200);
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		const refused = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({
				targetKey: "file-16",
				path: "/meetings/meeting-1/file-16.bin",
				contentType: "application/octet-stream",
				size: 1,
			}),
		);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ message: "An upload run holds at most 16 targets" });
		expect(await read_targets(t)).toHaveLength(16);
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_assets").collect())).toHaveLength(16);
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", fixture.organizationId)
							.eq("workspaceId", fixture.workspaceId)
							.eq("path", "/meetings/meeting-1/file-16.bin")
							.eq("archiveOperationId", undefined),
					)
					.first(),
			),
		).toBeNull();
	});

	test("creates a target with a forced-skipProcessing asset and answers a replay with the same file", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);

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

		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		const replay = await call(t, CREATE_TARGET_PATH, sealed, body);
		expect(replay.status).toBe(200);
		const replayBody = (await replay.json()) as { state: string; nodeId: string };
		expect(replayBody.state).toBe("pending");
		expect(replayBody.nodeId).toBe(firstBody.nodeId);
		expect(await read_targets(t)).toHaveLength(1);
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		// The same target key describing a different file is a conflict, not a second file.
		const conflicting = await call(t, CREATE_TARGET_PATH, sealed, { ...body, size: 5 * MIB });
		expect(conflicting.status).toBe(409);
	});

	test("stamps the plugin source, the original name and the plugin name on a created target", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);

		const target = (await read_targets(t))[0]!;
		const metadataDocs = await t.run(async (ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("fileNodeId", target.nodeId),
				)
				.collect(),
		);
		expect(
			Object.fromEntries(
				metadataDocs.filter((doc) => doc.docKind === "value").map((doc) => [doc.qualifiedField, doc.stringValue]),
			),
		).toEqual({
			"metadata.source": "plugin",
			"metadata.original-name": "recording.mp4",
			"metadata.plugin-name": "council",
		});
	});

	test("a markdown target runs the upload conversion and still settles committed", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);

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

	test("remint reissues a URL for the same staging key without new nodes, assets, or charges", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const targetBefore = (await read_targets(t))[0]!;
		const assetBefore = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", targetBefore.assetId));

		const response = await call(t, REMINT_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { state: string; nodeId: string; uploadUrl: string };
		expect(body.state).toBe("pending");
		expect(body.nodeId).toBe(String(targetBefore.nodeId));
		expect(body.uploadUrl).toContain(assetBefore!.uploadStagingR2Key!);

		// Nothing new was created, and creating a target never charges.
		expect(await read_targets(t)).toHaveLength(1);
		const assets = await t.run(async (ctx) => await ctx.db.query("files_r2_assets").collect());
		expect(assets).toHaveLength(1);
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
		// The URL window moved forward so the next PUT fits inside it.
		expect(assets[0]!.uploadUrlExpiresAt).toBeGreaterThanOrEqual(assetBefore!.uploadUrlExpiresAt!);
	});

	test("finalize reports the R2 event settlement and replays it without another charge", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);

		const early = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(early.status).toBe(200);
		expect(((await early.json()) as { state: string }).state).toBe("pending");

		// The finalizer confirms a 3 MiB object against a 4 MiB declaration.
		const target = (await read_targets(t))[0]!;
		const meterBefore = await read_meter(t, fixture);
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });

		const settled = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(settled.status).toBe(200);
		expect(await settled.json()).toMatchObject({ state: "committed", actualBytes: 3 * MIB });

		// The stored size is charged, not the 4 MiB the service declared. The guess never reaches the
		// books; only what R2 confirmed does.
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);

		// The commit also billed one file save. The anonymous meter stores no externalId, so the
		// event's externalId grammar is pinned in billing.test.ts instead.
		const meterSettled = await read_meter(t, fixture);
		expect(meterSettled.balance).toBe(meterBefore.balance - 1);
		expect(meterSettled.consumedUnits).toBe(meterBefore.consumedUnits + 1);

		// A finalize replay answers the same, moves no bytes, and charges nothing again.
		const replay = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ state: "committed", actualBytes: 3 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
		expect(await read_meter(t, fixture)).toEqual(meterSettled);

		// Remint after canonicalization also answers committed instead of minting a useless URL.
		const remint = await call(t, REMINT_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(remint.status).toBe(200);
		expect(await remint.json()).toMatchObject({ state: "committed", actualBytes: 3 * MIB });
	});

	test("a purged payer makes the R2 settlement reject instead of committing for free", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;

		// Deleting the payer between create-target and the R2 event models a purge race. The billing
		// emit throws, which rolls back the whole settlement so the R2 event retries instead of
		// committing a save nobody paid for.
		await t.run(async (ctx) => {
			await ctx.db.delete("users", fixture.userId);
		});

		await expect(simulate_finalizer(t, fixture, target, { size: 3 * MIB })).rejects.toThrow(
			"billedUserId points to a missing users doc",
		);

		expect((await read_targets(t))[0]).toMatchObject({ state: "pending", actualBytes: null });
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
	});

	test("deleting the stored object retires the target and keeps its bytes charged", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const canonicalKey = await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);

		// R2 confirms the canonical object is physically gone. The target doc is consumed, but the
		// bytes it charged stay charged.
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

		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
		// Nothing asked for this delete, so the settlement consumes the doc instead of keeping a
		// tombstone.
		expect(await read_targets(t)).toHaveLength(0);
	});

	test("a pending target whose asset is missing is released and charges nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		// Simulate a pending target whose associated asset no longer exists.
		await t.run(async (ctx) => {
			await ctx.db.delete("files_r2_assets", target.assetId);
		});

		const finalized = await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(finalized.status).toBe(200);
		expect(((await finalized.json()) as { state: string }).state).toBe("released");
		// The upload never produced a file and no bytes reached R2, so this target charged nothing.
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		const reminted = await call(t, REMINT_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" });
		expect(reminted.status).toBe(409);
	});

	test("keeps an abandoned service placeholder after staging cleanup and remints only after cleanup settles", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const assetBefore = await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId));
		if (!assetBefore?.uploadStagingR2Key || assetBefore.uploadUrlExpiresAt === undefined) {
			throw new Error("Expected a staged service upload asset");
		}
		const recoveryStartedAt = assetBefore.uploadUrlExpiresAt - 15 * 60 * 1000;
		const cleanupNow = recoveryStartedAt + 8 * 24 * 60 * 60 * 1000;

		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: cleanupNow,
			_test_disableReschedule: true,
		});
		expect(swept).toEqual({ deletedCount: 0, done: true });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).toMatchObject({
			unfinalizedExpiresAt: expect.any(Number),
		});
		expect((await read_targets(t))[0]).toMatchObject({ state: "pending" });
		// No bytes ever reached R2, so this target never charged anything.
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		const jobs = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			r2Key: assetBefore.uploadStagingR2Key,
			reason: "upload_staging",
			assetId: target.assetId,
		});

		const blockedReplay = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(blockedReplay.status).toBe(409);
		expect(await blockedReplay.json()).toEqual({ message: "This target's previous upload is still being cleaned up" });

		const blockedRemint = await call(t, REMINT_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(blockedRemint.status).toBe(409);
		expect(await blockedRemint.json()).toEqual({ message: "This target's previous upload is still being cleaned up" });

		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: jobs[0]!._id,
			generation: jobs[0]!.generation,
			deletedAt: Math.max(cleanupNow, jobs[0]!.putMayArriveUntil ?? 0),
		});
		expect(
			(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId)))?.unfinalizedExpiresAt,
		).toBeUndefined();
		const reminted = await call(t, REMINT_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(reminted.status).toBe(200);
		const assetAfterRemint = await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId));
		const targetAfterRemint = (await read_targets(t))[0]!;
		// There is no resume, so the retry sends the whole file again to the same staging key. The
		// finished cleanup had cleared the unfinalized marker, and the remint arms it again.
		expect(targetAfterRemint.assetId).toBe(target.assetId);
		expect(assetAfterRemint).toMatchObject({
			uploadStagingR2Key: assetBefore.uploadStagingR2Key,
			unfinalizedExpiresAt: expect.any(Number),
		});
		expect(targetAfterRemint).toMatchObject({ state: "pending", actualBytes: null });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).toMatchObject({
			assetId: target.assetId,
		});
		// The settled cleanup left no deletion job, so nothing is queued to delete what the retry writes.
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual([]);

		// The retry finishes. The stored size R2 confirmed is charged once, here.
		await simulate_finalizer(t, fixture, targetAfterRemint, { size: 6 * MIB });
		expect((await read_targets(t))[0]).toMatchObject({ state: "committed", actualBytes: 6 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(6 * MIB);

		// Workspace deletion removes destination fences before targets, in bounded passes.
		const drainResults = [];
		for (let pass = 0; pass < 3; pass += 1) {
			drainResults.push(
				await t.run(async (ctx) =>
					public_api_service_uploads_db_drain_batch(ctx, {
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						installationId: null,
						batchSize: 1,
					}),
				),
			);
		}
		expect(drainResults).toEqual([
			{ done: false, deletedCount: 1 },
			{ done: false, deletedCount: 1 },
			{ done: true, deletedCount: 0 },
		]);
		expect(await t.run(async (ctx) => ctx.db.query("plugin_service_storage_destinations").collect())).toEqual([]);
		expect(await read_targets(t)).toEqual([]);
	});

	test("defers stale staging cleanup while a service placeholder is read-only", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId));
		if (asset?.uploadUrlExpiresAt === undefined) {
			throw new Error("Expected a staged service upload asset");
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", target.nodeId, { readOnlyScopeNodeId: target.nodeId });
		});

		const recoveryStartedAt = asset.uploadUrlExpiresAt - 15 * 60 * 1000;
		const swept = await t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: recoveryStartedAt + 8 * 24 * 60 * 60 * 1000,
			_test_disableReschedule: true,
		});
		expect(swept).toEqual({ deletedCount: 0, done: true });
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toHaveLength(0);
		expect((await read_targets(t))[0]).toMatchObject({ state: "pending" });

		// The lock must not cancel an upload the member already accepted. Both retry doors stay open.
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		expect(
			(
				await call(t, REMINT_PATH, sealed, {
					idempotencyKey: "meeting-1",
					targetKey: "recording",
				})
			).status,
		).toBe(200);
		expect((await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId)))?.uploadStagingR2Key).toBe(
			asset.uploadStagingR2Key,
		);
	});
});

describe("service upload delete", () => {
	test("cleans up its exact read-only lock but refuses member-recreated and wrong-target provenance", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		for (const [targetKey, path] of [
			["first", "/meetings/meeting-1/first.txt"],
			["second", "/meetings/meeting-1/second.txt"],
		] as const) {
			expect(
				(
					await call(
						t,
						CREATE_TARGET_PATH,
						sealed,
						target_body({ targetKey, path, contentType: "text/plain", size: 1, readOnly: true }),
					)
				).status,
			).toBe(200);
		}
		const [first, second] = await read_targets(t);
		if (!first || !second) {
			throw new Error("Expected two service targets");
		}

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", first.nodeId, { readOnlyPluginServiceTargetId: second._id });
		});
		const wrongTarget = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete", targetKey: "first" });
		expect(wrongTarget.status).toBe(409);
		const crossInstallationTargetId = await t.run(async (ctx) => {
			const now = Date.now();
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "council-other-installation",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: SERVICE_CAPABILITIES,
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});
			return await ctx.db.insert("plugin_service_storage_targets", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId,
				idempotencyKey: "cross-installation",
				targetKey: "first",
				requestFingerprint: "cross-installation",
				readOnly: true,
				nonCollaborative: false,
				destinationPath: first.destinationPath,
				destinationNodeId: first.destinationNodeId,
				destinationEpoch: first.destinationEpoch,
				path: first.path,
				contentType: first.contentType,
				declaredBytes: first.declaredBytes,
				actualBytes: null,
				nodeId: first.nodeId,
				assetId: first.assetId,
				state: "pending",
				createdBy: fixture.userId,
				updatedAt: now,
			});
		});
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", first.nodeId, {
				readOnlyPluginServiceTargetId: crossInstallationTargetId,
			});
		});
		const crossInstallation = await call(t, DELETE_PATH, sealed, {
			idempotencyKey: "delete",
			targetKey: "first",
		});
		expect(crossInstallation.status).toBe(409);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.set_node_writable, {
				membershipId: fixture.membershipId,
				nodeId: first.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(
			await asUser.mutation(api.files_nodes.set_node_read_only, {
				membershipId: fixture.membershipId,
				nodeId: first.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", first.nodeId))).toMatchObject({
			readOnlyScopeNodeId: first.nodeId,
		});
		expect(
			(await t.run(async (ctx) => ctx.db.get("files_nodes", first.nodeId)))?.readOnlyPluginServiceTargetId,
		).toBeUndefined();
		const memberRelock = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete", targetKey: "first" });
		expect(memberRelock.status).toBe(409);

		const exactCleanup = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete", targetKey: "second" });
		expect(exactCleanup.status).toBe(200);
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", second.nodeId))).toBeNull();
	});

	test("refuses the read-only cleanup exception after the capability is removed", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }))).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: SERVICE_CAPABILITIES.filter(
					(capability) => capability !== "workspace.files.create-read-only",
				),
			});
		});

		const refused = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete", targetKey: "recording" });
		expect(refused.status).toBe(409);
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
	});

	test("refuses the read-only cleanup exception after its destination epoch closes", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }))).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await t.run(async (ctx) => {
			const destination = await ctx.db
				.query("plugin_service_storage_destinations")
				.withIndex("by_organization_workspace_installation_destinationPath", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId)
						.eq("destinationPath", target.destinationPath),
				)
				.unique();
			if (!destination) {
				throw new Error("Expected a service destination epoch");
			}
			await ctx.db.patch("plugin_service_storage_destinations", destination._id, {
				closedEpoch: target.destinationEpoch ?? 1,
			});
		});

		const refused = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete", targetKey: "recording" });
		expect(refused.status).toBe(404);
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
	});

	test("archives a committed file under a newly sealed grant and keeps its content and bytes", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const canonicalKey = await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		const finalizedAsset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId));
		if (!finalizedAsset?.uploadStagingR2Key) {
			throw new Error("Expected the committed target's staging key");
		}
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
		const metadataId = await t.run((ctx) =>
			ctx.db.insert("files_metadata_docs", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				fileNodeId: target.nodeId,
				sourceKind: "committed",
				yjsSequence: 0,
				path: target.path,
				treePath: target.path,
				qualifiedField: "service.recording",
				docKind: "field",
			}),
		);

		// Days later the meeting is deleted under a brand new grant sealed to the same destination.
		const laterSealed = await seal_token(t, fixture);
		const body = { idempotencyKey: "delete-meeting-1", targetKey: "recording" };
		const first = await call(t, DELETE_PATH, laterSealed, body);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ state: "deleted", paths: ["/meetings/meeting-1/recording.mp4"] });

		// A committed upload is a real member file. Delete archives it and preserves every dependent
		// row instead of running the placeholder-only hard delete helper over normal file history.
		const archived = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", target.nodeId),
			asset: await ctx.db.get("files_r2_assets", target.assetId),
			metadata: await ctx.db.get("files_metadata_docs", metadataId),
			canonicalJob: await ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
				.first(),
		}));
		expect(archived.node?.archiveOperationId).toBeTypeOf("string");
		expect(archived.asset).toMatchObject({ r2Key: canonicalKey, size: 3 * MIB });
		expect(archived.metadata).not.toBeNull();
		expect(archived.canonicalJob).toBeNull();
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
		const marked = (await read_targets(t))[0]!;
		expect(marked).toMatchObject({ state: "released", actualBytes: 3 * MIB });
		expect(marked.deleteRequestedAt).toBeTypeOf("number");

		// Create and remint must not claim the archived file is still committed. Finalize reports the
		// released API state while the ordinary Files restore door still owns the archived node.
		const createDuringDelete = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(createDuringDelete.status).toBe(409);
		expect(await createDuringDelete.json()).toEqual({ message: "This target was already released" });
		const remintDuringDelete = await call(t, REMINT_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(remintDuringDelete.status).toBe(409);
		expect(await remintDuringDelete.json()).toEqual({ message: "This target was already released" });
		const finalizeDuringDelete = await call(t, FINALIZE_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(finalizeDuringDelete.status).toBe(200);
		expect(await finalizeDuringDelete.json()).toMatchObject({ state: "released", actualBytes: 3 * MIB });

		// An R2 action that resolved the old staging event before archive may still finish. It cleans
		// only the staging key and cannot replace or rebill the immutable committed object.
		await t.mutation(internal.r2.process_uploaded_asset_event, {
			assetId: target.assetId,
			r2Key: canonicalKey,
			uploadStagingR2Key: finalizedAsset.uploadStagingR2Key,
			size: 8 * MIB,
			etag: "late-staging-after-archive",
			eventId: "late_staging_after_committed_delete",
		});
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", actualBytes: 3 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(3 * MIB);
		const afterLateEvent = await t.run(async (ctx) => ({
			asset: await ctx.db.get("files_r2_assets", target.assetId),
			canonicalJob: await ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
				.first(),
		}));
		expect(afterLateEvent.asset).toMatchObject({ r2Key: canonicalKey, size: 3 * MIB });
		expect(afterLateEvent.canonicalJob).toBeNull();

		// A replay answers the same without archiving the node again.
		const archiveOperationId = archived.node!.archiveOperationId;
		const replay = await call(t, DELETE_PATH, laterSealed, body);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ state: "deleted", paths: ["/meetings/meeting-1/recording.mp4"] });
		expect((await t.run((ctx) => ctx.db.get("files_nodes", target.nodeId)))?.archiveOperationId).toBe(
			archiveOperationId,
		);
	});

	test("releases the lock it archived through so a member can restore the committed file", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }))).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);

		const deleted = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-meeting-1", targetKey: "recording" });
		expect(deleted.status).toBe(200);

		// A committed match is archived, not hard-deleted, so it must stay restorable. `unarchive_nodes`
		// refuses the whole restore while any planned node is read-only.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(target.nodeId)],
			}),
		).toEqual({ _yay: null });

		const restored = await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId));
		expect(restored?.archiveOperationId).toBeUndefined();
		expect(restored?.readOnlyScopeNodeId).toBeUndefined();
		expect(restored?.readOnlyPluginServiceTargetId).toBeUndefined();
	});

	test("a member folder lock above the file refuses the whole delete and releases nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }))).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);

		// A member locks the destination folder. The cascade stops at the file, which keeps its own
		// service lock, so the member lock is visible only in the parent folder's pointer. Releasing
		// the service lock would leave the file read-only under that member lock, and archiving it
		// anyway would take a file the member said to leave alone.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		const destinationNodeId = await t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			const destination = nodes.find((node) => node.path === "/meetings");
			if (!destination) {
				throw new Error("Expected the sealed destination folder");
			}
			return destination._id;
		});
		expect(
			await asUser.mutation(api.files_nodes.set_node_read_only, {
				membershipId: fixture.membershipId,
				nodeId: destinationNodeId,
			}),
		).toEqual({ _yay: null });

		const refused = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-meeting-1", targetKey: "recording" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });

		const kept = await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId));
		expect(kept?.archiveOperationId).toBeUndefined();
		expect(kept?.readOnlyScopeNodeId).toBe(target.nodeId);
		expect(kept?.readOnlyPluginServiceTargetId).toBe(target._id);
		expect((await read_targets(t))[0]!.deleteRequestedAt).toBeUndefined();

		// Positive control: the member unlocks the folder and the same call goes through, so the
		// refusal came from that folder lock and not from something else about this target.
		expect(
			await asUser.mutation(api.files_nodes.set_node_writable, {
				membershipId: fixture.membershipId,
				nodeId: destinationNodeId,
			}),
		).toEqual({ _yay: null });
		expect(
			(await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-meeting-1", targetKey: "recording" })).status,
		).toBe(200);
		expect(await t.run(async (ctx) => (await ctx.db.get("files_nodes", target.nodeId))?.archiveOperationId)).toBeTypeOf(
			"string",
		);
	});

	test("cancels a target that is still uploading and deletes its empty placeholder", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;

		const response = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" });
		expect(response.status).toBe(200);
		// An unfinished upload has no confirmed object to wait for, so the cancel is done right away.
		expect(await response.json()).toEqual({ state: "deleted", paths: ["/meetings/meeting-1/recording.mp4"] });

		expect(await t.run(async (ctx) => await ctx.db.get("files_nodes", target.nodeId))).toBeNull();
		expect(await t.run(async (ctx) => await ctx.db.get("files_r2_assets", target.assetId))).toBeNull();
		expect((await read_targets(t))[0]).toMatchObject({ state: "released" });
		// The upload never finished, so there are no stored bytes to charge.
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);
		// The staging key the signed URL could still write to has a deletion job.
		expect(
			(await t.run(async (ctx) => await ctx.db.query("files_r2_object_deletion_jobs").collect())).length,
		).toBeGreaterThanOrEqual(1);
	});

	test("bounds cross-run cleanup and ignores released history when a later run creates the same key", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		for (let index = 0; index < 16; index += 1) {
			const response = await call(
				t,
				CREATE_TARGET_PATH,
				sealed,
				target_body({
					idempotencyKey: `run-${index}`,
					path: `/meetings/meeting-1/recording-${index}.mp4`,
					size: 1,
				}),
			);
			expect(response.status).toBe(200);
		}

		// Exact replay wins before the live-group cap, just like it wins before the per-run cap.
		expect(
			(
				await call(
					t,
					CREATE_TARGET_PATH,
					sealed,
					target_body({ idempotencyKey: "run-0", path: "/meetings/meeting-1/recording-0.mp4", size: 1 }),
				)
			).status,
		).toBe(200);
		const refused = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({ idempotencyKey: "run-16", path: "/meetings/meeting-1/recording-16.mp4", size: 1 }),
		);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({
			message: "A destination holds at most 16 live targets under one target key",
		});
		expect((await read_targets(t)).length).toBe(16);
		expect((await read_quota(t, fixture))?.usedCount).toBe(0);

		const deleted = await call(t, DELETE_PATH, sealed, { idempotencyKey: "cleanup", targetKey: "recording" });
		expect(deleted.status).toBe(200);
		const deletedBody = (await deleted.json()) as { state: string; paths: string[] };
		expect(deletedBody).toMatchObject({ state: "deleted", paths: expect.any(Array) });
		expect(deletedBody.paths).toHaveLength(16);
		expect((await read_targets(t)).every((target) => target.state === "released")).toBe(true);

		// Released tombstones do not grow the live lookup or block a later processing run.
		const afterHistory = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({ idempotencyKey: "run-17", path: "/meetings/meeting-1/recording-17.mp4", size: 1 }),
		);
		expect(afterHistory.status).toBe(200);
		expect((await read_targets(t)).filter((target) => target.state === "pending")).toHaveLength(1);
	});

	test("charges a larger late R2 object after a pending target was cancelled", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId));
		if (!asset?.uploadStagingR2Key) {
			throw new Error("Expected a staged service upload asset");
		}

		expect((await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" })).status).toBe(
			200,
		);
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", actualBytes: null });
		const canonicalKey = `organizations/${fixture.organizationId}/workspaces/${fixture.workspaceId}/assets/${target.assetId}`;
		const firstCanonicalJob = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
				.first(),
		);
		if (!firstCanonicalJob) {
			throw new Error("Expected the pending cancel's canonical cleanup job");
		}
		if (!firstCanonicalJob.putMayArriveUntil) {
			throw new Error("Expected the pending cancel's canonical cleanup window");
		}
		expect(firstCanonicalJob.putMayArriveUntil).toBeGreaterThan(Date.now());
		// Model the race where the first delete sees no canonical object, then an in-flight copy lands.
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: firstCanonicalJob._id,
			generation: firstCanonicalJob.generation,
			deletedAt: firstCanonicalJob.putMayArriveUntil - 1,
		});
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
					.first(),
			),
		).toMatchObject({
			generation: firstCanonicalJob.generation,
			nextAttemptAt: firstCanonicalJob.putMayArriveUntil,
		});

		const meterBefore = await read_meter(t, fixture);
		await t.mutation(internal.r2.record_untracked_asset_event, {
			bucket: asset.r2Bucket,
			key: asset.uploadStagingR2Key,
			size: 6 * MIB,
			eventId: "late_service_upload_1",
		});
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", actualBytes: 6 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(6 * MIB);
		const refreshedCanonicalJob = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
				.first(),
		);
		expect(refreshedCanonicalJob).toMatchObject({
			reason: "untracked_asset_event",
			generation: firstCanonicalJob.generation + 1,
			lastR2EventId: "late_service_upload_1",
		});
		expect(refreshedCanonicalJob!.putMayArriveUntil).toBeGreaterThanOrEqual(firstCanonicalJob.putMayArriveUntil);

		// A duplicate does not charge twice. A later larger PUT charges only its new excess.
		await t.mutation(internal.r2.record_untracked_asset_event, {
			bucket: asset.r2Bucket,
			key: asset.uploadStagingR2Key,
			size: 6 * MIB,
			eventId: "late_service_upload_1",
		});
		await t.mutation(internal.r2.record_untracked_asset_event, {
			bucket: asset.r2Bucket,
			key: asset.uploadStagingR2Key,
			size: 8 * MIB,
			eventId: "late_service_upload_2",
		});
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", actualBytes: 8 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(8 * MIB);

		// Late bytes on a released target never became a saved file, so no charge lands on the meter.
		expect(await read_meter(t, fixture)).toEqual(meterBefore);
	});

	test("charges a late R2 object after the member discarded the pending placeholder", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId));
		if (!asset?.uploadStagingR2Key) {
			throw new Error("Expected a staged service upload asset");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
				membershipId: fixture.membershipId,
				nodeId: target.nodeId,
			}),
		).toEqual({ _yay: { removed: true } });
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", actualBytes: null });
		const canonicalKey = `organizations/${fixture.organizationId}/workspaces/${fixture.workspaceId}/assets/${target.assetId}`;
		const canonicalJob = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", canonicalKey))
				.first(),
		);
		expect(canonicalJob?.putMayArriveUntil).toBeGreaterThan(Date.now());

		const meterBefore = await read_meter(t, fixture);
		await t.mutation(internal.r2.record_untracked_asset_event, {
			bucket: asset.r2Bucket,
			key: asset.uploadStagingR2Key,
			size: 6 * MIB,
			eventId: "late_after_member_discard",
		});
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", actualBytes: 6 * MIB });
		expect((await read_quota(t, fixture))?.usedCount).toBe(6 * MIB);

		// Late bytes on a released target never became a saved file, so no charge lands on the meter.
		expect(await read_meter(t, fixture)).toEqual(meterBefore);
	});

	test("a read-only placeholder refuses the cancel and keeps the pending target", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", target.nodeId, { readOnlyScopeNodeId: target.nodeId });
		});

		const refused = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });
		expect((await read_targets(t))[0]).toMatchObject({ state: "pending" });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).not.toBeNull();

		// Positive control: unlock the placeholder and the same call goes through, so the refusal came
		// from the lock and not from something else about a pending target.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", target.nodeId, { readOnlyScopeNodeId: undefined });
		});
		expect((await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" })).status).toBe(
			200,
		);
	});

	test("a read-only file refuses the hard delete and keeps the node", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);

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

	test("a restricted file the grant actor cannot write refuses replay, remint, finalize, and delete", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const ownerGrant = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, ownerGrant, target_body({ readOnly: true }))).status).toBe(200);
		const target = (await read_targets(t))[0]!;

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
			await ctx.db.patch("files_nodes", target.nodeId, { restrictedScopeNodeId: target.nodeId });
			return userId;
		});
		const memberGrant = await seal_token(t, fixture, "/meetings", memberUserId);
		const jobsBefore = await t.run(async (ctx) => await ctx.db.query("files_r2_object_deletion_jobs").collect());

		for (const [path, body] of [
			[CREATE_TARGET_PATH, target_body({ readOnly: true })],
			[REMINT_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[FINALIZE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
		] as const) {
			const refused = await call(t, path, memberGrant, body);
			expect(refused.status, path).toBe(403);
			expect(await refused.json(), path).toEqual({ message: "Permission denied" });
		}

		const response = await call(t, DELETE_PATH, memberGrant, {
			idempotencyKey: "delete-1",
			targetKey: "recording",
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).not.toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).not.toBeNull();
		expect((await read_targets(t))[0]!.state).toBe("pending");
		expect((await read_targets(t))[0]!.deleteRequestedAt).toBeUndefined();
		expect(await t.run(async (ctx) => await ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual(
			jobsBefore,
		);
	});

	test("a target moved outside the sealed prefix cannot be replayed, finalized, or deleted", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		const meetingsFolder = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("path", "/meetings")
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		if (!meetingsFolder) {
			throw new Error("Expected the service upload's parent folder");
		}
		expect(
			await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				nodeId: meetingsFolder._id,
				path: "private",
			}),
		).toEqual({ _yay: null });

		// Let the R2 event be the first service-side observer of the move. It must set the sticky fence
		// while it commits and charges the accepted upload.
		await simulate_finalizer(t, fixture, target, { size: 6 * MIB });
		expect((await read_targets(t))[0]).toMatchObject({
			state: "committed",
			actualBytes: 6 * MIB,
			movedOutAt: expect.any(Number),
		});
		expect((await read_quota(t, fixture))?.usedCount).toBe(6 * MIB);

		for (const [path, body] of [
			[CREATE_TARGET_PATH, target_body()],
			[REMINT_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[FINALIZE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
		] as const) {
			const refused = await call(t, path, sealed, body);
			expect(refused.status, path).toBe(404);
			expect(await refused.json(), path).toEqual({ message: "Not found" });
		}

		const response = await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: "Not found" });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).toMatchObject({
			path: "/private/meeting-1/recording.mp4",
		});
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).not.toBeNull();
		expect((await read_targets(t))[0]).toMatchObject({ state: "committed", movedOutAt: expect.any(Number) });
		expect((await read_targets(t))[0]!.deleteRequestedAt).toBeUndefined();
		expect(
			await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				nodeId: meetingsFolder._id,
				path: "meetings",
			}),
		).toEqual({ _yay: null });
		const replayAfterMoveBack = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(replayAfterMoveBack.status).toBe(404);
		expect(await replayAfterMoveBack.json()).toEqual({ message: "Not found" });
	});

	test("a moved-out target stays hidden after the member discards its placeholder", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		const meetingsFolder = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("path", "/meetings")
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		if (!meetingsFolder) {
			throw new Error("Expected the service upload's parent folder");
		}
		expect(
			await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				nodeId: meetingsFolder._id,
				path: "private",
			}),
		).toEqual({ _yay: null });
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(404);

		expect(
			await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
				membershipId: fixture.membershipId,
				nodeId: target.nodeId,
			}),
		).toEqual({ _yay: { removed: true } });
		expect((await read_targets(t))[0]).toMatchObject({ state: "released", movedOutAt: expect.any(Number) });

		for (const [path, body] of [
			[CREATE_TARGET_PATH, target_body()],
			[REMINT_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[FINALIZE_PATH, { idempotencyKey: "meeting-1", targetKey: "recording" }],
			[DELETE_PATH, { idempotencyKey: "delete-1", targetKey: "recording" }],
		] as const) {
			const refused = await call(t, path, sealed, body);
			expect(refused.status, path).toBe(404);
			expect(await refused.json(), path).toEqual({ message: "Not found" });
		}
	});

	test("an archived outside node records the sticky fence before returning not found", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		const meetingsFolder = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("path", "/meetings")
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		if (!meetingsFolder) {
			throw new Error("Expected the service upload's parent folder");
		}
		expect(
			await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				nodeId: meetingsFolder._id,
				path: "private",
			}),
		).toEqual({ _yay: null });
		expect(
			await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(meetingsFolder._id)],
			}),
		).toEqual({ _yay: null });

		const observedOutside = await call(t, REMINT_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(observedOutside.status).toBe(404);
		expect((await read_targets(t))[0]).toMatchObject({ movedOutAt: expect.any(Number) });

		expect(
			await asUser.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(meetingsFolder._id)],
			}),
		).toEqual({ _yay: null });
		expect(
			await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				nodeId: meetingsFolder._id,
				path: "meetings",
			}),
		).toEqual({ _yay: null });
		const replayAfterRestore = await call(t, REMINT_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(replayAfterRestore.status).toBe(404);
		expect(await replayAfterRestore.json()).toEqual({ message: "Not found" });
	});

	test("reconciles moved-out targets before enforcing the live-group cap", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
		for (let index = 0; index < 16; index += 1) {
			const created = await call(
				t,
				CREATE_TARGET_PATH,
				sealed,
				target_body({
					idempotencyKey: `old-run-${index}`,
					path: `/meetings/old-${index}.mp4`,
					size: 1,
				}),
			);
			expect(created.status).toBe(200);
		}
		const oldTargets = await read_targets(t);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		const meetingsFolder = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("path", "/meetings")
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		if (!meetingsFolder) {
			throw new Error("Expected the service upload's destination folder");
		}
		expect(
			await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				nodeId: meetingsFolder._id,
				path: "private",
			}),
		).toEqual({ _yay: null });

		// No replay observed the old rows. The new create must reconcile the bounded group itself,
		// free the moved slots, and recreate the old destination.
		const replacement = await call(
			t,
			CREATE_TARGET_PATH,
			sealed,
			target_body({ idempotencyKey: "replacement", path: "/meetings/replacement.mp4", size: 1 }),
		);
		expect(replacement.status).toBe(200);
		expect((await read_targets(t)).filter((candidate) => candidate.movedOutAt !== undefined)).toHaveLength(16);
		expect((await read_targets(t)).filter((candidate) => candidate.movedOutAt === undefined)).toHaveLength(1);

		const deleted = await call(t, DELETE_PATH, sealed, {
			idempotencyKey: "cleanup",
			targetKey: "recording",
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ state: "deleted", paths: ["/meetings/replacement.mp4"] });
		for (const target of oldTargets) {
			expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId))).toMatchObject({
				path: expect.stringMatching(/^\/private\//u),
			});
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", target.assetId))).not.toBeNull();
		}
	});

	test("a grant sealed to another destination cannot see the target", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture);
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
	test("archives files through only their exact service-created read-only locks", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }))).status).toBe(200);

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 2 });
		const target = (await read_targets(t))[0]!;
		expect((await t.run(async (ctx) => ctx.db.get("files_nodes", target.nodeId)))?.archiveOperationId).toBeTypeOf(
			"string",
		);
	});

	test("releases the locks it archived through so a member can restore the whole set", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }))).status).toBe(200);
		const target = (await read_targets(t))[0]!;

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 2 });

		// `unarchive_nodes` refuses the whole restore when any node in the restored subtree is
		// read-only. An archive that kept this lock would make the set it took impossible to restore.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(target.destinationNodeId)],
			}),
		).toEqual({ _yay: null });

		const restored = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(restored.every((node) => node.archiveOperationId === undefined)).toBe(true);
		const restoredFile = restored.find((node) => node._id === target.nodeId);
		expect(restoredFile?.readOnlyScopeNodeId).toBeUndefined();
		expect(restoredFile?.readOnlyPluginServiceTargetId).toBeUndefined();
	});

	test("an inherited lock refuses the whole archive and releases nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ readOnly: true }))).status).toBe(200);
		const target = (await read_targets(t))[0]!;

		// A member locks the folder above the meeting. The cascade stops at the file, which keeps its
		// own service lock, so only the destination folder ends up inheriting. An inherited lock is
		// never this door's to clear.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		const meetingsNodeId = await t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			const meetings = nodes.find((node) => node.path === "/meetings");
			if (!meetings) {
				throw new Error("Expected the folder above the destination");
			}
			return meetings._id;
		});
		expect(
			await asUser.mutation(api.files_nodes.set_node_read_only, {
				membershipId: fixture.membershipId,
				nodeId: meetingsNodeId,
			}),
		).toEqual({ _yay: null });

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This item is read-only." });

		const nodes = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		expect(nodes.every((node) => node.archiveOperationId === undefined)).toBe(true);
		expect(nodes.find((node) => node._id === target.nodeId)).toMatchObject({
			readOnlyScopeNodeId: target.nodeId,
			readOnlyPluginServiceTargetId: target._id,
		});
	});

	test("archives the destination folder with its whole subtree and keeps the stored bytes charged", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		const canonicalKey = await simulate_finalizer(t, fixture, target, { size: 3 * MIB });
		expect((await call(t, FINALIZE_PATH, sealed, { idempotencyKey: "meeting-1", targetKey: "recording" })).status).toBe(
			200,
		);
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
		expect((await call(t, CREATE_TARGET_PATH, first, target_body())).status).toBe(200);

		// A second meeting, stored the same way. Both folders exist, so the refusal below cannot come
		// from an empty path — only the seal decides which one this grant reaches.
		const second = await seal_token(t, fixture, "/meetings/meeting-2");
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

	test("archives a destination again after a later run recreates the same path", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const firstTarget = (await read_targets(t))[0]!;
		expect((await call(t, ARCHIVE_PATH, sealed, {})).status).toBe(200);

		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ idempotencyKey: "meeting-2" }))).status).toBe(200);
		const secondTarget = (await read_targets(t)).find((target) => target.idempotencyKey === "meeting-2");
		if (!firstTarget.destinationNodeId || !secondTarget?.destinationNodeId) {
			throw new Error("Expected both upload runs to keep their destination folder ids");
		}
		expect(secondTarget.destinationNodeId).not.toBe(firstTarget.destinationNodeId);

		const secondArchive = await call(t, ARCHIVE_PATH, sealed, {});
		expect(secondArchive.status).toBe(200);
		expect(await secondArchive.json()).toEqual({ archivedNodes: 2 });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", secondTarget.destinationNodeId!))).toMatchObject({
			archiveOperationId: expect.any(String),
		});

		const replay = await call(t, ARCHIVE_PATH, sealed, {});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ archivedNodes: 0 });
	});

	test("opens a new destination epoch when archive and recreate share one clock tick", async () => {
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const t = test_convex();
			const fixture = await seed_installation(t);
			const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
			expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
			expect((await call(t, ARCHIVE_PATH, sealed, {})).status).toBe(200);
			expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ idempotencyKey: "meeting-2" }))).status).toBe(
				200,
			);

			const targets = await read_targets(t);
			expect(targets.map((target) => target.destinationEpoch)).toEqual([1, 2]);
			const remint = await call(t, REMINT_PATH, sealed, {
				idempotencyKey: "meeting-2",
				targetKey: "recording",
			});
			expect(remint.status).toBe(200);
		} finally {
			dateNow.mockRestore();
		}
	});

	test("does not archive a service-archived destination after a member restores it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		expect((await call(t, ARCHIVE_PATH, sealed, {})).status).toBe(200);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(target.destinationNodeId)],
			}),
		).toEqual({ _yay: null });

		const replay = await call(t, ARCHIVE_PATH, sealed, {});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ archivedNodes: 0 });
		const restoredDestination = await t.run(async (ctx) => ctx.db.get("files_nodes", target.destinationNodeId));
		expect(restoredDestination).not.toBeNull();
		expect(restoredDestination?.archiveOperationId).toBeUndefined();
	});

	test("archives an older destination generation after a member restores it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const firstTarget = (await read_targets(t))[0]!;
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(firstTarget.destinationNodeId)],
			}),
		).toEqual({ _yay: null });

		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ idempotencyKey: "meeting-2" }))).status).toBe(200);
		const secondTarget = (await read_targets(t)).find((target) => target.idempotencyKey === "meeting-2");
		if (!secondTarget) {
			throw new Error("Expected the recreated destination target");
		}
		expect(
			await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(secondTarget.destinationNodeId)],
			}),
		).toEqual({ _yay: null });
		expect(
			await asUser.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(firstTarget.destinationNodeId)],
			}),
		).toEqual({ _yay: null });

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 2 });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", firstTarget.destinationNodeId))).toMatchObject({
			archiveOperationId: expect.any(String),
		});
	});

	test("service archive closes targets from member-archived destination generations", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const firstTarget = (await read_targets(t))[0]!;
		expect(
			(
				await call(
					t,
					CREATE_TARGET_PATH,
					sealed,
					target_body({
						idempotencyKey: "meeting-release",
						targetKey: "obsolete",
						path: "/meetings/meeting-1/obsolete.mp4",
					}),
				)
			).status,
		).toBe(200);
		expect(
			(
				await call(t, DELETE_PATH, sealed, {
					idempotencyKey: "delete-obsolete",
					targetKey: "obsolete",
				})
			).status,
		).toBe(200);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.userId,
			name: "Test User",
		});
		expect(
			await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(firstTarget.destinationNodeId)],
			}),
		).toEqual({ _yay: null });

		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body({ idempotencyKey: "meeting-2" }))).status).toBe(200);
		const archived = await call(t, ARCHIVE_PATH, sealed, {});
		expect(archived.status).toBe(200);
		expect(await archived.json()).toEqual({ archivedNodes: 2 });
		expect(
			await asUser.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: fixture.membershipId,
				nodeIds: [String(firstTarget.destinationNodeId)],
			}),
		).toEqual({ _yay: null });

		const remint = await call(t, REMINT_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(remint.status).toBe(404);
		expect(await remint.json()).toEqual({ message: "Not found" });
		const createReplay = await call(t, CREATE_TARGET_PATH, sealed, target_body());
		expect(createReplay.status).toBe(404);
		expect(await createReplay.json()).toEqual({ message: "Not found" });
		const finalize = await call(t, FINALIZE_PATH, sealed, {
			idempotencyKey: "meeting-1",
			targetKey: "recording",
		});
		expect(finalize.status).toBe(404);
		expect(await finalize.json()).toEqual({ message: "Not found" });
		const deleteReplay = await call(t, DELETE_PATH, sealed, {
			idempotencyKey: "delete-obsolete-again",
			targetKey: "obsolete",
		});
		expect(deleteReplay.status).toBe(404);
		expect(await deleteReplay.json()).toEqual({ message: "Not found" });
	});

	test("service-archived destinations do not consume the live target cap", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");

		for (let index = 0; index < 17; index += 1) {
			const created = await call(t, CREATE_TARGET_PATH, sealed, target_body({ idempotencyKey: `meeting-${index}` }));
			expect(created.status).toBe(200);
			if (index < 16) {
				const archived = await call(t, ARCHIVE_PATH, sealed, {});
				expect(archived.status).toBe(200);
				expect(await archived.json()).toEqual({ archivedNodes: 2 });
			}
		}

		const targets = await read_targets(t);
		expect(targets.filter((target) => target.movedOutAt !== undefined)).toHaveLength(16);
		expect(targets.filter((target) => target.movedOutAt === undefined)).toHaveLength(1);
	});

	test("archives the same destination after a member renames the folder", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		if (!target.destinationNodeId) {
			throw new Error("Expected the upload target to keep its destination folder id");
		}
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

	test("keeps the destination identity after cancelling a pending upload", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
		expect((await call(t, CREATE_TARGET_PATH, sealed, target_body())).status).toBe(200);
		const target = (await read_targets(t))[0]!;
		if (!target.destinationNodeId) {
			throw new Error("Expected the upload target to keep its destination folder id");
		}

		expect((await call(t, DELETE_PATH, sealed, { idempotencyKey: "delete-1", targetKey: "recording" })).status).toBe(
			200,
		);
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
				path: "renamed-after-cancel",
			}),
		).toEqual({ _yay: null });

		const response = await call(t, ARCHIVE_PATH, sealed, {});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ archivedNodes: 1 });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", target.destinationNodeId!))).toMatchObject({
			path: "/meetings/renamed-after-cancel",
			archiveOperationId: expect.any(String),
		});
	});

	test("refuses before reading past the 256-node archive limit, including archived children", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const sealed = await seal_token(t, fixture, "/meetings/meeting-1");
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
