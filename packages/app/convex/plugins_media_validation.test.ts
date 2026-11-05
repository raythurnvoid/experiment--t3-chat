import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { plugins_file_grants_db_ensure_pair } from "../server/plugins-file-grants.ts";
import { files_media_refs_db_check_plugin_added } from "../server/files-media-refs.ts";

const ROOT = "/reader-probe";
const SECRET = "media-clock-test-secret";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) => {
		const membership = await test_mocks_fill_db_with.membership(ctx);
		const now = Date.now();
		const capabilities: plugins_Capability[] = [
			"plugin.service.connect",
			"plugin.backend.invoke",
			"plugin.data.read",
			"plugin.data.write",
			"plugin.data.user-write",
			"workspace.files.write",
			"workspace.files.own-write",
		];
		const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			name: "Reader probe",
			createdBy: membership.userId,
			createdAt: now,
			updatedAt: now,
			revokedAt: null,
		});
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "reader-probe",
			displayName: "Reader probe",
			version: "1.0.0",
			description: "Reader clock tests",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/bonobo/reader-probe",
			sourceOwner: "bonobo",
			sourceRepo: "reader-probe",
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: "plugins/reader-probe/manifest.json",
			backendEntrypointFile: {
				entry: "dist/backend/worker.js",
				moduleName: "plugin.js",
				r2Key: "plugins/reader-probe/worker.js",
				sha256: `sha256:${"b".repeat(64)}`,
				compatibilityDate: "2026-07-01",
				compatibilityFlags: ["nodejs_compat"],
			},
			endpoints: [{ id: "echo", path: "/echo", serialization: "installation" }],
			configuration: null,
			mounts: [],
			events: [],
			capabilities,
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "mcp-servers-hash",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: membership.userId,
			updatedAt: now,
			secrets: [],
			userWritableCollections: null,
		});
		await ctx.db.insert("plugins_service_account_bindings", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginName: "reader-probe",
			publisherUserId: membership.userId,
			sourceRepositoryUrl: "https://github.com/bonobo/reader-probe",
			serviceAccountId,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			serviceAccountId,
			pluginVersionId,
			pluginName: "reader-probe",
			status: "enabled",
			managementAccess: "selected",
			configurationYaml: null,
			acceptedCapabilities: capabilities,
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
			outboundOriginsAcceptedAt: now,
			installedBy: membership.userId,
			updatedBy: membership.userId,
			updatedAt: now,
		});
		await ctx.db.insert("plugins_service_registrations", {
			pluginName: "reader-probe",
			exchangeSecretHash: await crypto_sha256_hex(SECRET),
			scopes: ["files:write"],
			createdBy: membership.userId,
			updatedAt: now,
		});
		const sessionId = await ctx.db.insert("plugins_ui_sessions", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId,
			pluginVersionId,
			serviceAccountId,
			userId: membership.userId,
			tokenHash: "reader-clock-session",
			createdAt: now,
			expiresAt: now + 30 * 60 * 1000,
		});
		const readerId = await ctx.db.insert("users", { clerkUserId: "reader" });
		const readerMembershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: readerId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
			displayName: "",
			sortDisplayName: "",
		});
		await ctx.db.insert("organizations_membership_lifetimes", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: readerId,
			membershipId: readerMembershipId,
			active: true,
			lifetime: 1,
		});
		const organization = (await ctx.db.get("organizations", membership.organizationId))!;
		if (!organization.defaultWorkspaceId) throw new Error("Expected the default workspace");
		for (const workspaceId of [null, membership.workspaceId, organization.defaultWorkspaceId]) {
			await files_media_validation_db_advance_version(ctx, { organizationId: membership.organizationId, workspaceId });
		}
		return {
			...membership,
			serviceAccountId,
			pluginVersionId,
			installationId,
			sessionId,
			readerId,
			readerMembershipId,
		};
	});
	const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const page = t.withIdentity({ issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`, subject: db.sessionId });
	expect(
		await owner.mutation(api.access_control.set_service_account_grant, {
			membershipId: db.membershipId,
			serviceAccountId: db.serviceAccountId,
			resource: { kind: "workspace" },
			level: "manage",
		}),
	).toEqual({ _yay: null });
	const sourceToken = `psg_${"1".repeat(64)}`;
	await t.run(async (ctx) => {
		await ctx.db.insert("plugin_service_grants", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			serviceAccountId: db.serviceAccountId,
			installationId: db.installationId,
			pluginVersionId: db.pluginVersionId,
			pluginName: "reader-probe",
			actorUserId: db.userId,
			tokenHash: await crypto_sha256_hex(sourceToken),
			scopes: [],
			principalKey: `plugin_service:${db.installationId}`,
			phase: "interactive",
			destinationPathPrefix: null,
			expiresAt: Date.now() + 60_000,
			updatedAt: Date.now(),
		});
	});
	const minted = await t.mutation(internal.public_api.create_plugin_service_grant, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		installationId: db.installationId,
		actorUserId: db.userId,
		requestedScopes: ["files:write"],
		destinationPathPrefix: ROOT,
		phase: "processing",
		lifecycle: { presented: sourceToken, serviceSecretHash: await crypto_sha256_hex(SECRET) },
		now: Date.now(),
	});
	if (minted._nay) throw new Error(minted._nay.message);
	const credentials = {
		grantId: minted._yay.grantId,
		tokenHash: await crypto_sha256_hex(minted._yay.token),
		serviceSecretHash: await crypto_sha256_hex(SECRET),
	};
	return { t, db, owner, page, credentials, reader: { userId: db.readerId, membershipLifetime: 1 } };
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run(async (ctx) => ({
		clocks: await ctx.db.query("files_media_validation_versions").collect(),
		grants: await ctx.db.query("access_control_permission_grants").collect(),
		nodes: await ctx.db.query("files_nodes").collect(),
	}));
}

async function expect_clock(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	before: Awaited<ReturnType<typeof snapshot>>;
	changed: boolean;
}) {
	const { f, before, changed } = args;

	const after = await snapshot(f);
	const previous = before.clocks.find((clock) => clock.workspaceId === f.db.workspaceId)!;
	const current = after.clocks.find((clock) => clock._id === previous._id)!;
	if (changed) expect(current.revision).toBeGreaterThan(previous.revision);
	else expect(current).toEqual(previous);
	expect(after.clocks.filter((clock) => clock._id !== previous._id)).toEqual(
		before.clocks.filter((clock) => clock._id !== previous._id),
	);
}

function file_grants(records: Awaited<ReturnType<typeof snapshot>>, nodeId: Id<"files_nodes">) {
	return records.grants.filter((grant) => grant.resourceKind === "file" && grant.resourceId === String(nodeId));
}

describe("plugin file media validation clocks", () => {
	test("a personal pair needs read consent even for an upload source reference", async () => {
		const f = await fixture();
		const saved = await test_run_with_flush(f.t, async (ctx) => {
			const installation = (await ctx.db.get("plugins_workspace_installations", f.db.installationId))!;
			const membership = (await ctx.db.get("organizations_workspaces_users", f.db.membershipId))!;
			const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
			const pair = await plugins_file_grants_db_ensure_pair(ctx, { installation, membership, membershipLifetime });
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				kind: "file",
				name: "source.png",
				path: "/source.png",
				treePath: "/source.png/",
				contentType: "image/png",
			});
			return { installation, pair, nodeId };
		});
		const check = () =>
			f.t.run((ctx) =>
				files_media_refs_db_check_plugin_added(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					installation: saved.installation,
					userId: f.db.userId,
					filePairId: saved.pair._id,
					sourceNodeId: saved.nodeId,
					addedFileRefs: [`bonobo-file://${saved.nodeId}`],
				}),
			);
		expect((await check())._nay?.name, "source identity alone grants no pair read").toBe("file_reference_denied");
		await f.t.run((ctx) =>
			ctx.db.insert("plugins_file_consents", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				pairId: saved.pair._id,
				rootNodeId: saved.nodeId,
				requestedLevel: "read",
				appliedLevel: "read",
				areaEligible: false,
				open: true,
				revision: 1,
				state: "applied",
				endedReason: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		expect(await check(), "applied read permits the source reference").toEqual({ _yay: null });
	});

	test("keeps the workspace clock for a plugin-store-only document write", async () => {
		const f = await fixture();
		const before = await snapshot(f);
		const result = await f.page.mutation(api.plugins_data.user_put_document, {
			collection: "notes",
			key: "public-note",
			value: { text: "Only in the plugin store" },
		});
		expect(result._nay).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("plugins_data").collect())).toMatchObject([
			{ collection: "notes", key: "public-note", value: { text: "Only in the plugin store" } },
		]);
		const after = await snapshot(f);
		expect(after.nodes).toEqual(before.nodes);
		expect(after.grants).toEqual(before.grants);
		await expect_clock({ f, before, changed: false });
	});

	test("an external folder create keeps the content and access clocks", async () => {
		const f = await fixture();
		const before = await snapshot(f);
		const content_revision = () =>
			f.t.run(
				async (ctx) =>
					(
						await ctx.db
							.query("files_content_versions")
							.withIndex("by_organization_workspace", (q) =>
								q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
							)
							.first()
					)?.revision ?? 0,
			);
		const beforeContentRevision = await content_revision();
		const result = await f.t.mutation(internal.plugins_external_files.ensure_writer, {
			...f.credentials,
			path: ROOT,
			resourceKey: "output",
			rootNodeId: null,
			readOnly: false,
		});
		expect(result._nay).toBeUndefined();
		const after = await snapshot(f);
		expect(after.nodes).toHaveLength(1);
		expect(after.nodes[0]?.restrictedScopeNodeId).toBeNull();
		expect(file_grants(after, result._yay!.folderNodeId)).toEqual([]);
		expect(await content_revision(), "External folder creation keeps its content clock").toBe(beforeContentRevision);
		await expect_clock({ f, before, changed: false });
	});
});
