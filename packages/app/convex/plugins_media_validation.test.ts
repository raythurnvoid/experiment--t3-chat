import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

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
			"workspace.files.own-access",
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
	const minted = await t.mutation(internal.public_api.create_plugin_service_grant, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		installationId: db.installationId,
		actorUserId: db.userId,
		requestedScopes: ["files:write"],
		destinationPathPrefix: ROOT,
		phase: "processing",
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
		bindings: await ctx.db.query("plugins_file_access_bindings").collect(),
		externalBindings: await ctx.db.query("plugins_external_file_bindings").collect(),
	}));
}

async function expect_clock(
	f: Awaited<ReturnType<typeof fixture>>,
	before: Awaited<ReturnType<typeof snapshot>>,
	changed: boolean,
) {
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

async function store_fixture() {
	const f = await fixture();
	const runToken = `plr_${"d".repeat(64)}`;
	const started = await f.t.mutation(internal.plugins_runtime.start_invoke_run, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		serviceAccountId: f.db.serviceAccountId,
		installationId: f.db.installationId,
		pluginVersionId: f.db.pluginVersionId,
		userId: f.db.userId,
		endpointId: "echo",
		callerSerializationKey: null,
		apiTokenHash: await crypto_sha256_hex(runToken),
	});
	if (started._nay) throw new Error(started._nay.message);
	const nodeId = await f.t.run(async (ctx) => {
		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			parentId: "root",
			path: ROOT,
			kind: "folder",
			now: Date.now(),
			createdNodesMetadata: [{ key: "plugin-name", value: "reader-probe" }],
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay;
	});
	expect(
		await f.owner.mutation(api.access_control.set_service_account_grant, {
			membershipId: f.db.membershipId,
			serviceAccountId: f.db.serviceAccountId,
			resource: { kind: "file", nodeId },
			level: "manage",
		}),
	).toEqual({ _yay: null });
	expect(
		(
			await f.page.mutation(api.plugins_data.user_manage_scope, {
				action: { kind: "create", scopeId: "private", collections: ["notes"], keyPrefix: "private/" },
			})
		)._nay,
	).toBeUndefined();
	return { ...f, nodeId, runToken };
}

async function set_binding(f: Awaited<ReturnType<typeof store_fixture>>, readScopeId: string | null) {
	return await f.t.fetch("/api/v1/files/plugin-access/set", {
		method: "POST",
		headers: { Authorization: `Bearer ${f.runToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ path: ROOT, access: { readScopeId } }),
	});
}

async function external_writer(
	f: Awaited<ReturnType<typeof fixture>>,
	readers: { userId: Id<"users">; membershipLifetime: number }[] = [],
) {
	const result = await f.t.mutation(internal.plugins_external_files.ensure_writer, {
		...f.credentials,
		path: ROOT,
		resourceKey: "output",
		rootNodeId: null,
		readOnly: false,
		readers,
	});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay;
}

describe("plugin file media validation clocks", () => {
	test("advances the workspace clock for a leaf restriction with no new reader grant", async () => {
		const f = await store_fixture();
		// Member cleanup removes scope grants before its queued stranded-scope cleanup.
		await f.t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", f.db.readerMembershipId, { active: false });
			await ctx.db.insert("plugins_data_scopes", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId: f.db.installationId,
				scopeId: "empty",
				collection: "notes",
				keyPrefix: "empty/",
				createdByUserId: f.db.readerId,
				lastAppend: null,
				appendSequence: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const before = await snapshot(f);
		const response = await set_binding(f, "empty");
		expect(response.status, await response.clone().text()).toBe(200);
		const after = await snapshot(f);
		expect(after.nodes.find((node) => node._id === f.nodeId)?.restrictedScopeNodeId).toBe(f.nodeId);
		expect(after.nodes).toHaveLength(1);
		expect(file_grants(after, f.nodeId)).toEqual(file_grants(before, f.nodeId));
		expect(after.bindings).toMatchObject([{ nodeId: f.nodeId, scopeId: "empty" }]);
		await expect_clock(f, before, true);
	});

	test("advances the workspace clock for initial mirrored readers and preserves account grants", async () => {
		const f = await store_fixture();
		const before = await snapshot(f);
		const response = await set_binding(f, "private");
		expect(response.status, await response.clone().text()).toBe(200);
		const grants = file_grants(await snapshot(f), f.nodeId);
		expect(grants.filter((grant) => grant.principalKind === "user")).toMatchObject([
			{ userId: f.db.userId, permission: "content.read" },
		]);
		expect(grants.filter((grant) => grant.principalKind === "service_account")).toEqual(file_grants(before, f.nodeId));
		await expect_clock(f, before, true);
	});

	test.each(["add", "remove"])("advances the workspace clock for grant-only binding %s", async (change) => {
		const f = await store_fixture();
		expect(
			(
				await f.page.mutation(api.plugins_data.user_manage_scope, {
					action: { kind: "create", scopeId: "second", collections: ["notes"], keyPrefix: "second/" },
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.page.mutation(api.plugins_data.user_manage_scope, {
					action: { kind: "set_principal", scopeId: "second", userId: f.db.readerId, level: "member" },
				})
			)._nay,
		).toBeUndefined();
		expect((await set_binding(f, change === "add" ? "private" : "second")).status).toBe(200);
		const before = await snapshot(f);
		const response = await set_binding(f, change === "add" ? "second" : "private");
		expect(response.status, await response.clone().text()).toBe(200);
		const after = await snapshot(f);
		expect(after.nodes).toEqual(before.nodes);
		const grants = file_grants(after, f.nodeId);
		expect(
			grants
				.filter((grant) => grant.principalKind === "user")
				.map((grant) => grant.userId)
				.sort(),
		).toEqual((change === "add" ? [f.db.userId, f.db.readerId] : [f.db.userId]).sort());
		expect(grants.filter((grant) => grant.principalKind === "service_account")).toEqual(
			file_grants(before, f.nodeId).filter((grant) => grant.principalKind === "service_account"),
		);
		await expect_clock(f, before, true);
	});

	test.each(["same", "detach", "absent", "denied", "missing-scope"])(
		"keeps the workspace clock for %s binding access",
		async (change) => {
			const f = await store_fixture();
			if (change !== "absent") expect((await set_binding(f, "private")).status).toBe(200);
			if (change === "denied")
				await f.t.run((ctx) =>
					ctx.db.patch("plugins_workspace_installations", f.db.installationId, { status: "disabled" }),
				);
			const before = await snapshot(f);
			const response = await set_binding(
				f,
				change === "detach" || change === "absent" ? null : change === "missing-scope" ? "missing" : "private",
			);
			expect(response.status).toBe(change === "denied" ? 401 : change === "missing-scope" ? 404 : 200);
			const after = await snapshot(f);
			expect(after.nodes).toEqual(before.nodes);
			expect(after.grants).toEqual(before.grants);
			if (change === "detach" || change === "absent") expect(after.bindings).toEqual([]);
			await expect_clock(f, before, false);
		},
	);

	test.each(["add", "remove", "delete", "leave", "cleanup"])(
		"advances the workspace clock for bound scope %s",
		async (change) => {
			const f = await store_fixture();
			if (change === "remove")
				expect(
					(
						await f.page.mutation(api.plugins_data.user_manage_scope, {
							action: { kind: "set_principal", scopeId: "private", userId: f.db.readerId, level: "member" },
						})
					)._nay,
				).toBeUndefined();
			expect((await set_binding(f, "private")).status).toBe(200);
			if (change === "cleanup")
				await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
			const before = await snapshot(f);
			if (change === "cleanup") {
				await f.t.mutation(internal.plugins_data.cleanup_stranded_scopes, {
					scopes: [{ installationId: f.db.installationId, scopeId: "private" }],
				});
			} else {
				const result = await f.page.mutation(api.plugins_data.user_manage_scope, {
					action:
						change === "add"
							? { kind: "set_principal", scopeId: "private", userId: f.db.readerId, level: "member" }
							: change === "delete"
								? { kind: "delete", scopeId: "private" }
								: {
										kind: "remove_principal",
										scopeId: "private",
										userId: change === "leave" ? f.db.userId : f.db.readerId,
									},
				});
				expect(result._nay).toBeUndefined();
			}
			const after = await snapshot(f);
			const users = file_grants(after, f.nodeId)
				.filter((grant) => grant.principalKind === "user")
				.map((grant) => grant.userId);
			expect(users.sort()).toEqual(
				(change === "add" ? [f.db.userId, f.db.readerId] : change === "remove" ? [f.db.userId] : []).sort(),
			);
			expect(after.nodes).toEqual(before.nodes);
			if (["delete", "leave", "cleanup"].includes(change)) expect(after.bindings).toEqual([]);
			await expect_clock(f, before, true);
		},
	);

	test.each(["level", "absent-reader", "unbound", "denied"])(
		"keeps the workspace clock for a %s scope edit",
		async (change) => {
			const f = await store_fixture();
			if (change !== "unbound") expect((await set_binding(f, "private")).status).toBe(200);
			const before = await snapshot(f);
			const result = await f.page.mutation(api.plugins_data.user_manage_scope, {
				action:
					change === "absent-reader"
						? { kind: "remove_principal", scopeId: "private", userId: f.db.readerId }
						: {
								kind: "set_principal",
								scopeId: "private",
								userId: change === "unbound" ? f.db.readerId : f.db.userId,
								level: change === "denied" || change === "unbound" ? "member" : "manage",
							},
			});
			if (change === "denied") expect(result._nay?.message).toBe("You cannot lower your own private space access");
			else expect(result._nay).toBeUndefined();
			const after = await snapshot(f);
			expect(file_grants(after, f.nodeId)).toEqual(file_grants(before, f.nodeId));
			expect(after.nodes).toEqual(before.nodes);
			await expect_clock(f, before, false);
		},
	);

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
		await expect_clock(f, before, false);
	});

	test("initial external leaf restriction advances the workspace clock beyond the ordinary create", async () => {
		const deltas = [];
		for (const privateRoot of [false, true]) {
			const f = await fixture();
			const before = await snapshot(f);
			const result = await f.t.mutation(internal.plugins_external_files.ensure_writer, {
				...f.credentials,
				path: ROOT,
				resourceKey: "output",
				rootNodeId: null,
				readOnly: false,
				...(privateRoot ? { readers: [] } : {}),
			});
			expect(result._nay).toBeUndefined();
			const after = await snapshot(f);
			expect(after.nodes).toHaveLength(1);
			expect(after.nodes[0]?.restrictedScopeNodeId).toBe(privateRoot ? result._yay!.folderNodeId : null);
			expect(file_grants(after, result._yay!.folderNodeId).filter((grant) => grant.principalKind === "user")).toEqual(
				[],
			);
			expect(after.externalBindings).toHaveLength(privateRoot ? 1 : 0);
			await expect_clock(f, before, true);
			deltas.push(
				after.clocks.find((clock) => clock.workspaceId === f.db.workspaceId)!.revision -
					before.clocks.find((clock) => clock.workspaceId === f.db.workspaceId)!.revision,
			);
		}
		// Creation already advances the workspace clock. The root restriction needs its own writer hook.
		expect(deltas[1]).toBeGreaterThan(deltas[0]!);
	});

	test.each(["add", "remove", "same"])("advances the workspace clock when external readers %s", async (change) => {
		const f = await fixture();
		const writer = await external_writer(f, change === "add" ? [] : [f.reader]);
		const before = await snapshot(f);
		const result = await f.t.mutation(internal.plugins_external_files.change_scope, {
			...f.credentials,
			writerId: writer.writerId,
			operationId: "readers",
			writerGeneration: 1,
			change: { kind: "readers", expectedReaderRevision: 1, readers: change === "remove" ? [] : [f.reader] },
		});
		expect(result._yay).toMatchObject({ operation: "readers", readerRevision: 2 });
		const after = await snapshot(f);
		const grants = file_grants(after, writer.folderNodeId);
		expect(
			grants
				.filter((grant) => grant.principalKind === "user")
				.map((grant) => ({ userId: grant.userId, lifetime: grant.externalPluginMembershipLifetime })),
		).toEqual(change === "remove" ? [] : [{ userId: f.reader.userId, lifetime: 1 }]);
		const oldGrants = file_grants(before, writer.folderNodeId);
		expect(grants.filter((grant) => grant.principalKind === "service_account")).toEqual(
			oldGrants.filter((grant) => grant.principalKind === "service_account"),
		);
		if (change === "same")
			expect(grants.filter((grant) => grant.principalKind === "user")[0]?._id).not.toBe(
				oldGrants.find((grant) => grant.principalKind === "user")?._id,
			);
		await expect_clock(f, before, true);
	});

	test.each(["empty", "replay", "denied", "stale-lifetime", "ensure-replay"])(
		"keeps the workspace clock for external %s",
		async (change) => {
			const f = await fixture();
			const writer = await external_writer(f);
			const args = {
				...f.credentials,
				writerId: writer.writerId,
				operationId: "readers",
				writerGeneration: 1,
				change: {
					kind: "readers" as const,
					expectedReaderRevision: 1,
					readers: change === "stale-lifetime" ? [{ ...f.reader, membershipLifetime: 2 }] : [],
				},
			};
			if (change === "replay")
				expect((await f.t.mutation(internal.plugins_external_files.change_scope, args))._nay).toBeUndefined();
			const before = await snapshot(f);
			const result =
				change === "ensure-replay"
					? await f.t.mutation(internal.plugins_external_files.ensure_writer, {
							...f.credentials,
							path: ROOT,
							resourceKey: "output",
							rootNodeId: null,
							readOnly: false,
							readers: [],
						})
					: await f.t.mutation(internal.plugins_external_files.change_scope, {
							...args,
							...(change === "denied" ? { serviceSecretHash: "wrong" } : {}),
						});
			if (change === "denied" || change === "stale-lifetime") expect(result._nay).toBeDefined();
			else expect(result._nay).toBeUndefined();
			const after = await snapshot(f);
			expect(after.grants).toEqual(before.grants);
			expect(after.nodes).toEqual(before.nodes);
			await expect_clock(f, before, false);
		},
	);

	test("denied external setup leaves files, grants and the workspace clock unchanged", async () => {
		const f = await fixture();
		const before = await snapshot(f);
		const result = await f.t.mutation(internal.plugins_external_files.ensure_writer, {
			...f.credentials,
			path: ROOT,
			resourceKey: "output",
			rootNodeId: null,
			readOnly: false,
			readers: [{ ...f.reader, membershipLifetime: 2 }],
		});
		expect(result._nay?.message).toBe("The file readers changed");
		const after = await snapshot(f);
		expect(after.nodes).toEqual(before.nodes);
		expect(after.grants).toEqual(before.grants);
		expect(after.externalBindings).toEqual(before.externalBindings);
		await expect_clock(f, before, false);
	});

	test.each(["cancel", "denied"])("keeps the workspace clock for reader rollback %s", async (change) => {
		const f = await fixture();
		const writer = await external_writer(f, [f.reader]);
		const before = await snapshot(f);
		const result = await f.t.mutation(internal.plugins_external_file_readers.rollback, {
			writerId: writer.writerId,
			operationId: "undo",
			writerGeneration: 1,
			originalReaderOperationId: "unseen",
			tokenHash: f.credentials.tokenHash,
			serviceSecretHash: change === "denied" ? "wrong" : f.credentials.serviceSecretHash,
		});
		if (change === "denied") expect(result._nay?.message).toBe("Unauthenticated");
		else {
			expect(result._yay).toMatchObject({ readerRevision: 1, restored: true });
			expect(await f.t.run((ctx) => ctx.db.query("plugins_external_file_receipts").collect())).toMatchObject([
				{ operation: "cancel_readers", operationId: "unseen" },
				{ operation: "rollback_readers", operationId: "undo" },
			]);
		}
		const after = await snapshot(f);
		expect(after.nodes).toEqual(before.nodes);
		expect(after.grants).toEqual(before.grants);
		expect(after.externalBindings).toEqual(before.externalBindings);
		await expect_clock(f, before, false);
	});

	test("rollback restores human readers, keeps account grants, and advances the workspace clock once per real undo", async () => {
		const f = await fixture();
		const writer = await external_writer(f, [f.reader]);
		const removed = await f.t.mutation(internal.plugins_external_files.change_scope, {
			...f.credentials,
			writerId: writer.writerId,
			operationId: "remove",
			writerGeneration: 1,
			change: { kind: "readers", expectedReaderRevision: 1, readers: [] },
		});
		if (removed._nay) throw new Error(removed._nay.message);
		const args = {
			writerId: writer.writerId,
			operationId: "undo",
			writerGeneration: 1,
			receiptId: removed._yay._id,
			tokenHash: f.credentials.tokenHash,
			serviceSecretHash: f.credentials.serviceSecretHash,
		};
		const before = await snapshot(f);
		const result = await f.t.mutation(internal.plugins_external_file_readers.rollback, args);
		expect(result._yay).toMatchObject({ readerRevision: 3, detached: false, restored: true });
		const after = await snapshot(f);
		const grants = file_grants(after, writer.folderNodeId);
		expect(grants.filter((grant) => grant.principalKind === "user")).toMatchObject([
			{ userId: f.reader.userId, externalPluginMembershipLifetime: 1 },
		]);
		expect(grants.filter((grant) => grant.principalKind === "service_account")).toEqual(
			file_grants(before, writer.folderNodeId),
		);
		await expect_clock(f, before, true);
		expect(await f.t.mutation(internal.plugins_external_file_readers.rollback, args)).toEqual(result);
		expect((await snapshot(f)).grants).toEqual(after.grants);
		await expect_clock(f, after, false);
	});
});
