import { R2 } from "@convex-dev/r2";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { Id } from "./_generated/dataModel";
import type { plugins_Capability } from "../shared/plugins.ts";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";

const SECRET = "external-files-test-secret";
const ROOT = "/chitchat-fresh-test";

async function setup(options?: { publicWriter: true; privateRoot?: boolean }) {
	const t = test_convex();
	const pluginName = options?.publicWriter ? "project-notes" : "chitchat";
	const rootPath = options?.publicWriter ? "/project-notes" : ROOT;
	const fixture = await t.run(async (ctx) => {
		const membership = await test_mocks_fill_db_with.membership(ctx, { workspaceName: "home" });
		const now = Date.now();
		const capabilities: plugins_Capability[] = [
			"plugin.service.connect",
			"workspace.files.write",
			"workspace.files.own-write",
			"workspace.files.own-access",
		];
		const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			name: pluginName,
			createdBy: membership.userId,
			createdAt: now,
			updatedAt: now,
			revokedAt: null,
		});
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: pluginName,
			displayName: pluginName,
			version: "1.0.0",
			description: "Chat",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}`,
			sourceOwner: "bonobo",
			sourceRepo: pluginName,
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: `plugins/${pluginName}/manifest.json`,
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
		await ctx.db.insert("plugins_service_account_bindings", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginName,
			publisherUserId: membership.userId,
			sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}`,
			serviceAccountId,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			serviceAccountId,
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
		await ctx.db.insert("plugins_service_registrations", {
			pluginName,
			exchangeSecretHash: await crypto_sha256_hex(SECRET),
			scopes: ["files:write"],
			createdBy: membership.userId,
			updatedAt: now,
		});
		return { ...membership, serviceAccountId, pluginVersionId, installationId };
	});
	const owner = t.withIdentity({
		issuer: "https://clerk.test",
		subject: `clerk-${fixture.userId}`,
		external_id: fixture.userId,
	});
	expect(
		(
			await owner.mutation(api.access_control.set_service_account_grant, {
				membershipId: fixture.membershipId,
				serviceAccountId: fixture.serviceAccountId,
				resource: { kind: "workspace" },
				level: "manage",
			})
		)._nay,
	).toBeUndefined();
	const minted = await t.mutation(internal.public_api.create_plugin_service_grant, {
		organizationId: fixture.organizationId,
		workspaceId: fixture.workspaceId,
		installationId: fixture.installationId,
		actorUserId: fixture.userId,
		requestedScopes: ["files:write"],
		destinationPathPrefix: rootPath,
		phase: "processing",
		now: Date.now(),
	});
	if (minted._nay) throw new Error(minted._nay.message);
	const token = minted._yay.token;
	const credentials = {
		grantId: minted._yay.grantId,
		tokenHash: await crypto_sha256_hex(token),
		serviceSecretHash: await crypto_sha256_hex(SECRET),
	};
	const response = await t.fetch("/api/v1/files/plugin-folders/ensure", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			path: rootPath,
			writer: { resourceKey: "export output, 2026", rootNodeId: null },
			access: { readOnly: true, ...(options?.privateRoot ? { readers: [] } : {}) },
		}),
	});
	expect(response.status, await response.clone().text()).toBe(200);
	const body = (await response.json()) as {
		writer: {
			writerId: Id<"plugins_external_file_writers">;
			rootNodeId: Id<"files_nodes">;
			folderNodeId: Id<"files_nodes">;
			writerGeneration: number;
			readerRevision: number | null;
			detached: boolean;
		};
		created: boolean;
	};
	return { t, fixture, owner, token, credentials, root: { ...body.writer, created: body.created }, rootPath };
}

function install_object_uploads() {
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("public conditional file writes", () => {
	test("an unrelated plugin writes plain text above 100 KB with exact receipts and read bounds", async () => {
		const { t, token, root, rootPath } = await setup({ publicWriter: true });
		install_object_uploads();
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};
		const path = `${rootPath}/report.txt`;
		const content = "Project notes\n".repeat(8000);
		const body = {
			path,
			content: `\uFEFF${content.replaceAll("\n", "\r\n")}`,
			contentType: "text/plain",
			nonCollaborative: true,
			expectedParentNodeId: root.folderNodeId,
			writer: {
				writerId: root.writerId,
				operationId: "report-write",
				writerGeneration: 1,
				sequence: 1,
				expectedNodeId: null,
				expectedContentRevision: null,
				expectedReaderRevision: null,
				contentHash: await crypto_sha256_hex(content),
			},
		};

		const sent = await t.fetch("/api/v1/files/write", { method: "POST", headers, body: JSON.stringify(body) });
		expect(sent.status, await sent.clone().text()).toBe(200);
		const saved = (await sent.json()) as {
			nodeId: Id<"files_nodes">;
			contentType: string;
			receipt: { contentRevision: string };
		};
		expect(saved.contentType).toBe("text/plain;charset=utf-8");

		const replay = await t.fetch("/api/v1/files/write", { method: "POST", headers, body: JSON.stringify(body) });
		expect(replay.status, await replay.clone().text()).toBe(200);
		expect(await replay.json()).toEqual(saved);

		for (const changed of [
			{ contentType: "application/json" },
			{ nonCollaborative: false },
			{ access: { readOnly: true } },
		]) {
			const conflict = await t.fetch("/api/v1/files/write", {
				method: "POST",
				headers,
				body: JSON.stringify({ ...body, ...changed }),
			});
			expect(conflict.status, await conflict.clone().text()).toBe(409);
		}

		for (const maxBytes of [100_000, 200_000]) {
			const inspected = await t.fetch("/api/v1/files/plugin-writers/inspect", {
				method: "POST",
				headers,
				body: JSON.stringify({ writerId: root.writerId, path, maxBytes }),
			});
			expect(inspected.status, await inspected.clone().text()).toBe(maxBytes === 100_000 ? 409 : 200);
			if (maxBytes === 200_000)
				expect(await inspected.json()).toMatchObject({
					nodeId: saved.nodeId,
					content,
					contentType: saved.contentType,
					contentRevision: saved.receipt.contentRevision,
				});
		}
		expect(await t.run(async (ctx) => await ctx.db.query("plugins_external_file_receipts").collect())).toHaveLength(1);

		const updatedContent = "Updated project notes\n";
		const updated = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...body,
				content: updatedContent,
				nonCollaborative: false,
				access: { readOnly: true },
				writer: {
					...body.writer,
					operationId: "report-update",
					sequence: 2,
					expectedNodeId: saved.nodeId,
					expectedContentRevision: saved.receipt.contentRevision,
					contentHash: await crypto_sha256_hex(updatedContent),
				},
			}),
		});
		expect(updated.status, await updated.clone().text()).toBe(200);
		expect(await updated.json()).toMatchObject({ nodeId: saved.nodeId });
		expect(await t.run(async (ctx) => await ctx.db.get("files_nodes", saved.nodeId))).toMatchObject({
			collaborationEnabled: false,
			writePolicy: null,
		});
	});

	test.each(["contentType", "nonCollaborative", "requestReadOnly", "content"])(
		"publication refuses changed %s after staging",
		async (changed) => {
			const { t, fixture, root, rootPath, credentials } = await setup({ publicWriter: true });
			const prepared = await t.mutation(internal.public_api.prepare_file_write, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId: fixture.userId,
				principalRef: { kind: "plugin_service", grantId: credentials.grantId },
				path: `${rootPath}/report.txt`,
				expectedParentNodeId: root.folderNodeId,
				externalFileWrite: {
					tokenHash: credentials.tokenHash,
					serviceSecretHash: credentials.serviceSecretHash,
					writerId: root.writerId,
					operationId: "prepared",
					writerGeneration: 1,
					sequence: 1,
					expectedNodeId: null,
					expectedContentRevision: null,
					expectedReaderRevision: null,
					contentHash: await crypto_sha256_hex("Notes"),
					contentType: "text/plain;charset=utf-8",
					nonCollaborative: true,
					requestReadOnly: false,
				},
				overwrite: "fail",
				contentSize: 5,
				yjsSnapshotSize: 0,
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
			});
			if (prepared._nay) throw new Error(prepared._nay.message);

			if (changed === "contentType")
				await t.run(
					async (ctx) =>
						await ctx.db.patch("public_api_file_write_stages", prepared._yay.stageId, {
							contentType: "application/json;charset=utf-8",
						}),
				);

			const result = await t.mutation(internal.public_api.publish_file_write, {
				stageId: prepared._yay.stageId,
				targetAnchor: prepared._yay.targetAnchor,
				content: changed === "content" ? "Other" : "Notes",
				nonCollaborative: changed !== "nonCollaborative",
				requestReadOnly: changed === "requestReadOnly",
			});
			expect(result._nay?.name).toBe("stale_write");
			expect(await t.run(async (ctx) => await ctx.db.query("plugins_external_file_receipts").collect())).toHaveLength(
				0,
			);
			expect(
				await t.run(async (ctx) =>
					(await ctx.db.query("files_nodes").collect()).filter((node) => node.kind === "file"),
				),
			).toHaveLength(0);
		},
	);

	test("public writer requests reject invalid IDs and incomplete write conditions", async () => {
		const { t, token, root, rootPath } = await setup({ publicWriter: true });
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};

		const incomplete = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ path: `${rootPath}/report.txt`, content: "Notes", writer: { writerId: root.writerId } }),
		});
		expect(incomplete.status, await incomplete.clone().text()).toBe(400);

		const malformed = await t.fetch("/api/v1/files/plugin-writers/inspect", {
			method: "POST",
			headers,
			body: JSON.stringify({ writerId: "invalid", path: `${rootPath}/report.txt`, maxBytes: 100 }),
		});
		expect(malformed.status, await malformed.clone().text()).toBe(400);
		expect(malformed.headers.get("Cache-Control")).toBe("no-store");

		for (const route of [
			"/api/v1/files/write",
			"/api/v1/files/plugin-folders/ensure",
			"/api/v1/files/plugin-access/set",
			"/api/v1/files/plugin-archive",
			"/api/v1/files/plugin-access/undo",
			"/api/v1/files/plugin-writers/advance",
		]) {
			const invalid = await t.fetch(route, { method: "POST", headers, body: "{}" });
			expect(invalid.status, await invalid.clone().text()).toBe(400);
			expect(invalid.headers.get("Cache-Control")).toBe("no-store");
		}
	});
});

describe("public plugin writer access", () => {
	test("undoes a private root's reader operation with a new grant after an upgrade", async () => {
		const { t, fixture, owner, root, token, rootPath } = await setup({ publicWriter: true, privateRoot: true });
		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: root.rootNodeId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};

		const applied = await t.fetch("/api/v1/files/plugin-access/set", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path: rootPath,
				access: { readers: [] },
				writer: {
					writerId: root.writerId,
					operationId: "root-readers",
					writerGeneration: 1,
					expectedReaderRevision: 1,
				},
			}),
		});
		expect(applied.status, await applied.clone().text()).toBe(200);

		await t.run(async (ctx) => {
			const version = await ctx.db.get("plugins_versions", fixture.pluginVersionId);
			const { _id: _oldId, _creationTime: _oldTime, ...fields } = version!;
			const versionId = await ctx.db.insert("plugins_versions", { ...fields, version: "2.0.0" });
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { pluginVersionId: versionId });
		});
		const minted = await t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			actorUserId: fixture.userId,
			requestedScopes: ["files:write"],
			destinationPathPrefix: rootPath,
			phase: "processing",
			now: Date.now(),
		});
		if (minted._nay) throw new Error(minted._nay.message);

		const undo = await t.fetch("/api/v1/files/plugin-access/undo", {
			method: "POST",
			headers: { ...headers, Authorization: `Bearer ${minted._yay.token}` },
			body: JSON.stringify({
				writerId: root.writerId,
				operationId: "root-undo",
				writerGeneration: 1,
				originalReaderOperationId: "root-readers",
			}),
		});
		expect(undo.status, await undo.clone().text()).toBe(200);
		expect(await undo.json()).toMatchObject({ restored: true, readerRevision: 3, detached: false });
	});

	test("two plugins in one workspace cannot use each other's writer or service proof", async () => {
		const { t, fixture, owner, root, token, rootPath } = await setup({ publicWriter: true });
		const other = await t.run(async (ctx) => {
			const version = await ctx.db.get("plugins_versions", fixture.pluginVersionId);
			const { _id: _versionId, _creationTime: _versionTime, ...versionFields } = version!;
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				...versionFields,
				name: "daily-reports",
				displayName: "Daily reports",
				sourceRepositoryUrl: "https://github.com/bonobo/daily-reports",
				sourceRepo: "daily-reports",
			});
			const account = await ctx.db.get("access_control_service_accounts", fixture.serviceAccountId);
			const { _id: _accountId, _creationTime: _accountTime, ...accountFields } = account!;
			const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
				...accountFields,
				name: "Daily reports",
			});
			await ctx.db.insert("plugins_service_account_bindings", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginName: "daily-reports",
				publisherUserId: fixture.userId,
				sourceRepositoryUrl: "https://github.com/bonobo/daily-reports",
				serviceAccountId,
			});
			const installation = await ctx.db.get("plugins_workspace_installations", fixture.installationId);
			const { _id: _installationId, _creationTime: _installationTime, ...installationFields } = installation!;
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				...installationFields,
				pluginVersionId,
				serviceAccountId,
				pluginName: "daily-reports",
			});
			await ctx.db.insert("plugins_service_registrations", {
				pluginName: "daily-reports",
				exchangeSecretHash: await crypto_sha256_hex("report-service-secret"),
				scopes: ["files:write"],
				createdBy: fixture.userId,
				updatedAt: Date.now(),
			});
			return { installationId, serviceAccountId };
		});

		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: other.serviceAccountId,
					resource: { kind: "workspace" },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();
		const minted = await t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: other.installationId,
			actorUserId: fixture.userId,
			requestedScopes: ["files:write"],
			destinationPathPrefix: "/daily-reports",
			phase: "processing",
			now: Date.now(),
		});
		if (minted._nay) throw new Error(minted._nay.message);
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};
		const otherHeaders = {
			...headers,
			Authorization: `Bearer ${minted._yay.token}`,
			"X-Bonobo-Service-Authorization": "Bearer report-service-secret",
		};

		const ensured = await t.fetch("/api/v1/files/plugin-folders/ensure", {
			method: "POST",
			headers: otherHeaders,
			body: JSON.stringify({ path: "/daily-reports", writer: { resourceKey: "report output", rootNodeId: null } }),
		});
		expect(ensured.status, await ensured.clone().text()).toBe(200);
		const otherRoot = (await ensured.json()) as { writer: { writerId: string } };

		for (const request of [
			{ headers, writerId: otherRoot.writer.writerId, path: `${rootPath}/report.txt`, status: 403 },
			{ headers: otherHeaders, writerId: root.writerId, path: "/daily-reports/report.txt", status: 403 },
			{
				headers: { ...headers, "X-Bonobo-Service-Authorization": otherHeaders["X-Bonobo-Service-Authorization"] },
				writerId: root.writerId,
				path: `${rootPath}/report.txt`,
				status: 401,
			},
			{
				headers: { ...otherHeaders, "X-Bonobo-Service-Authorization": headers["X-Bonobo-Service-Authorization"] },
				writerId: otherRoot.writer.writerId,
				path: "/daily-reports/report.txt",
				status: 401,
			},
		]) {
			const result = await t.fetch("/api/v1/files/plugin-writers/inspect", {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify({ writerId: request.writerId, path: request.path, maxBytes: 1000 }),
			});
			expect(result.status, await result.clone().text()).toBe(request.status);
		}
	});

	test("creates a private writer, recovers its exact folder, changes readers and undoes after an upgrade", async () => {
		const { t, fixture, root, token, rootPath } = await setup({ publicWriter: true });
		install_object_uploads();
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};
		const path = `${rootPath}/restricted`;
		const reader = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "project-member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				active: true,
			});
			await ctx.db.insert("organizations_membership_lifetimes", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				membershipId,
				active: true,
				lifetime: 1,
			});
			return { userId, membershipLifetime: 1 };
		});
		const ensureBody = {
			path,
			writer: { resourceKey: "restricted project notes", rootNodeId: root.rootNodeId },
			access: { readers: [reader], readOnly: true },
		};

		const ensured = await t.fetch("/api/v1/files/plugin-folders/ensure", {
			method: "POST",
			headers,
			body: JSON.stringify(ensureBody),
		});
		expect(ensured.status, await ensured.clone().text()).toBe(200);
		const ensuredFolder = (await ensured.json()) as {
			nodeId: Id<"files_nodes">;
			writer: { writerId: Id<"plugins_external_file_writers"> };
		};

		const retry = await t.fetch("/api/v1/files/plugin-folders/ensure", {
			method: "POST",
			headers,
			body: JSON.stringify(ensureBody),
		});
		expect(retry.status, await retry.clone().text()).toBe(200);
		expect(await retry.json()).toMatchObject({ nodeId: ensuredFolder.nodeId, created: false });

		const filePath = `${path}/notes.txt`;
		const inspected = await t.fetch("/api/v1/files/plugin-writers/inspect", {
			method: "POST",
			headers,
			body: JSON.stringify({ writerId: ensuredFolder.writer.writerId, path: filePath, maxBytes: 1000 }),
		});
		expect(inspected.status, await inspected.clone().text()).toBe(200);
		expect(await inspected.json()).toMatchObject({
			nodeId: null,
			expectedParentNodeId: ensuredFolder.nodeId,
			readerRevision: 1,
		});

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path: filePath,
				content: "Private project notes",
				contentType: "text/plain",
				nonCollaborative: true,
				expectedParentNodeId: ensuredFolder.nodeId,
				writer: {
					writerId: ensuredFolder.writer.writerId,
					operationId: "private-notes",
					writerGeneration: 1,
					sequence: 1,
					expectedNodeId: null,
					expectedContentRevision: null,
					expectedReaderRevision: 1,
					contentHash: await crypto_sha256_hex("Private project notes"),
				},
			}),
		});
		expect(written.status, await written.clone().text()).toBe(200);
		const savedFile = (await written.json()) as { nodeId: Id<"files_nodes"> };

		const savedAccess = await t.run(async (ctx) => ({
			file: await ctx.db.get("files_nodes", savedFile.nodeId),
			grants: (await ctx.db.query("access_control_permission_grants").collect())
				.filter((grant) => grant.resourceId === ensuredFolder.nodeId)
				.map((grant) => ({
					principalKind: grant.principalKind,
					userId: grant.userId,
					serviceAccountId: grant.serviceAccountId,
					permission: grant.permission,
				})),
		}));
		expect(savedAccess.file?.restrictedScopeNodeId).toBe(ensuredFolder.nodeId);
		expect(savedAccess.grants).toEqual(
			expect.arrayContaining([
				{ principalKind: "user", userId: reader.userId, serviceAccountId: undefined, permission: "content.read" },
				...(["content.read", "content.write", "content.permissions.manage"] as const).map((permission) => ({
					principalKind: "service_account",
					userId: undefined,
					serviceAccountId: fixture.serviceAccountId,
					permission,
				})),
			]),
		);
		expect(savedAccess.grants).toHaveLength(4);

		const access = await t.fetch("/api/v1/files/plugin-access/set", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path,
				access: { readers: [] },
				writer: {
					writerId: ensuredFolder.writer.writerId,
					operationId: "remove-reader",
					writerGeneration: 1,
					expectedReaderRevision: 1,
				},
			}),
		});
		expect(access.status, await access.clone().text()).toBe(200);
		const applied = (await access.json()) as { receipt: { _id: string } };

		await t.run(async (ctx) => {
			const version = await ctx.db.get("plugins_versions", fixture.pluginVersionId);
			const { _id: _oldId, _creationTime: _oldTime, ...fields } = version!;
			const versionId = await ctx.db.insert("plugins_versions", { ...fields, version: "2.0.0" });
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { pluginVersionId: versionId });
		});
		const minted = await t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			actorUserId: fixture.userId,
			requestedScopes: ["files:write"],
			destinationPathPrefix: rootPath,
			phase: "processing",
			now: Date.now(),
		});
		if (minted._nay) throw new Error(minted._nay.message);
		const currentHeaders = { ...headers, Authorization: `Bearer ${minted._yay.token}` };
		const undoBody = {
			writerId: ensuredFolder.writer.writerId,
			operationId: "undo-readers",
			writerGeneration: 1,
			receiptId: applied.receipt._id,
		};

		const undo = await t.fetch("/api/v1/files/plugin-access/undo", {
			method: "POST",
			headers: currentHeaders,
			body: JSON.stringify(undoBody),
		});
		expect(undo.status, await undo.clone().text()).toBe(200);
		expect(await undo.json()).toMatchObject({ restored: true, readerRevision: 3, detached: false });

		const advance = await t.fetch("/api/v1/files/plugin-writers/advance", {
			method: "POST",
			headers: currentHeaders,
			body: JSON.stringify({
				writerId: ensuredFolder.writer.writerId,
				operationId: "restart-export",
				writerGeneration: 1,
				nextGeneration: 2,
			}),
		});
		expect(advance.status, await advance.clone().text()).toBe(200);
		expect(await advance.json()).toMatchObject({ writerGeneration: 2 });
	});
});

describe("public plugin writer archive", () => {
	test("archives 261 saved files separately and never archives a replacement at a saved path", async () => {
		const { t, fixture, root, token, rootPath } = await setup({ publicWriter: true });
		const files = await t.run(async (ctx) => {
			const nodes: { nodeId: Id<"files_nodes">; path: string }[] = [];
			for (let index = 0; index < 261; index++) {
				const path = `${rootPath}/report-${index}.txt`;
				const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId: fixture.userId,
					parentId: root.folderNodeId,
					path: `report-${index}.txt`,
					kind: "file",
					createdNodesMetadata: [
						{ key: "source", value: "plugin" },
						{ key: "plugin-name", value: "project-notes" },
					],
					writeContext: {
						writer: { kind: "service_account", serviceAccountId: fixture.serviceAccountId },
						actorUserId: fixture.userId,
						policyReach: "ancestors",
						resourceScope: { kind: "create", parentNodeId: root.folderNodeId, path },
					},
					now: Date.now(),
				});
				if (created._nay) throw new Error(created._nay.message);
				nodes.push({ nodeId: created._yay, path });
			}
			return nodes;
		});
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};

		for (const [index, file] of files.entries()) {
			// The public_api_principal bucket holds 20 tokens; resetting every 15 keeps the loop under the cap.
			if (index % 15 === 0)
				await t.run(
					async (ctx) =>
						await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
							name: "public_api_principal",
							key: `plugin_service:plugin_service:${fixture.organizationId}:${fixture.workspaceId}:${fixture.installationId}:/api/v1/files/plugin-archive`,
						}),
				);
			const archived = await t.fetch("/api/v1/files/plugin-archive", {
				method: "POST",
				headers,
				body: JSON.stringify({
					path: file.path,
					writer: {
						writerId: root.writerId,
						operationId: `archive-${index}`,
						writerGeneration: 1,
						sequence: 1,
						nodeId: file.nodeId,
					},
				}),
			});
			expect(archived.status, await archived.clone().text()).toBe(200);
			expect(await archived.json()).toMatchObject({ archivedNodes: 1, receipt: { nodeId: file.nodeId } });
		}

		const first = files[0]!;
		const replacementId = await t.run(async (ctx) => {
			const archived = await ctx.db.get("files_nodes", first.nodeId);
			const { _id: _nodeId, _creationTime: _nodeTime, ...fields } = archived!;
			return await ctx.db.insert("files_nodes", { ...fields, archiveOperationId: null });
		});

		const replay = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path: first.path,
				writer: {
					writerId: root.writerId,
					operationId: "archive-0",
					writerGeneration: 1,
					sequence: 1,
					nodeId: first.nodeId,
				},
			}),
		});
		expect(replay.status, await replay.clone().text()).toBe(200);

		expect(await t.run(async (ctx) => (await ctx.db.get("files_nodes", replacementId))?.archiveOperationId)).toBeNull();
		expect(
			await t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.archiveOperationId !== null),
			),
		).toHaveLength(261);
	}, 30_000);
});

describe("external file writes", () => {
	test("creates an output root once and does not adopt it for another resource", async () => {
		const { t, credentials, root } = await setup();

		expect(
			await t.mutation(internal.plugins_external_files.ensure_writer, {
				...credentials,
				path: ROOT,
				readOnly: true,
				resourceKey: "export output, 2026",
				rootNodeId: null,
			}),
		).toEqual({ _yay: { ...root, created: false } });

		expect(
			(
				await t.mutation(internal.plugins_external_files.ensure_writer, {
					...credentials,
					path: ROOT,
					readOnly: true,
					resourceKey: "other output root",
					rootNodeId: null,
				})
			)._nay?.name,
		).toBe("stale_write");

		expect(await t.run(async (ctx) => (await ctx.db.query("plugins_external_file_writers").collect()).length)).toBe(1);
	});

	test("publishes content and its receipt once, and preserves the file ID on the next save", async () => {
		const { t, credentials, root, token } = await setup();
		install_object_uploads();
		const path = `${ROOT}/general.md`;
		const request = {
			path,
			expectedParentNodeId: root.folderNodeId,
			content: "# general\n\nHello\n",
			nonCollaborative: true,
			writer: {
				writerId: root.writerId,
				operationId: "write-1",
				writerGeneration: 1,
				sequence: 1,
				expectedNodeId: null,
				expectedContentRevision: null,
				expectedReaderRevision: null,
				contentHash: await crypto_sha256_hex("# general\n\nHello\n"),
			},
		};
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};

		const sent = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify(request),
		});
		expect(sent.status, await sent.clone().text()).toBe(200);
		const receipt = (await sent.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

		const replay = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify(request),
		});
		expect(replay.status, await replay.clone().text()).toBe(200);
		expect((await replay.json()).receipt).toEqual(receipt);
		expect(await t.run(async (ctx) => (await ctx.db.query("plugins_external_file_receipts").collect()).length)).toBe(1);

		const second = {
			...request,
			content: "# general\n\nUpdated\n",
			writer: {
				...request.writer,
				operationId: "write-2",
				sequence: 2,
				expectedNodeId: receipt.nodeId,
				expectedContentRevision: receipt.contentRevision,
				contentHash: await crypto_sha256_hex("# general\n\nUpdated\n"),
			},
		};
		const saved = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify(second),
		});
		expect(saved.status, await saved.clone().text()).toBe(200);
		expect((await saved.json()).receipt).toMatchObject({ nodeId: receipt.nodeId, sequence: 2 });

		const snapshot = await t.query(internal.plugins_external_files.inspect, {
			...credentials,
			writerId: root.writerId,
			path,
		});
		expect(snapshot._yay?.node?._id).toBe(receipt.nodeId);
		expect(snapshot._yay?.contentRevision).not.toBe(receipt.contentRevision);

		const stale = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...second, writer: { ...second.writer, operationId: "stale-content", sequence: 3 } }),
		});
		expect(stale.status).toBe(409);

		expect(
			(
				await t.mutation(internal.plugins_external_files.change_scope, {
					...credentials,
					writerId: root.writerId,
					operationId: "stale-archive",
					writerGeneration: 1,
					change: { kind: "archive", path, nodeId: receipt.nodeId, sequence: 1 },
				})
			)._nay?.name,
		).toBe("stale_write");

		const untouched = await t.query(internal.plugins_external_files.inspect, {
			...credentials,
			writerId: root.writerId,
			path,
		});
		expect(untouched._yay?.node?.archiveOperationId).toBeNull();
		expect(untouched._yay?.contentRevision).toBe(snapshot._yay?.contentRevision);
	});

	test.each([100, 10])("a new writer generation can rebuild at source sequence %i", async (sequence) => {
		const { t, root, token } = await setup();
		install_object_uploads();
		const path = `${ROOT}/general.md`;
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};
		const request = {
			path,
			expectedParentNodeId: root.folderNodeId,
			content: "# general\n\nOriginal\n",
			nonCollaborative: true,
			writer: {
				writerId: root.writerId,
				operationId: "first-write",
				writerGeneration: 1,
				sequence: 100,
				expectedNodeId: null,
				expectedContentRevision: null,
				expectedReaderRevision: null,
				contentHash: await crypto_sha256_hex("# general\n\nOriginal\n"),
			},
		};

		const first = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify(request),
		});
		expect(first.status, await first.clone().text()).toBe(200);
		const firstReceipt = (await first.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

		const fence = await t.fetch("/api/v1/files/plugin-writers/advance", {
			method: "POST",
			headers,
			body: JSON.stringify({ writerId: root.writerId, operationId: "fence-2", writerGeneration: 1, nextGeneration: 2 }),
		});
		expect(fence.status, await fence.clone().text()).toBe(200);

		const replacement = {
			...request,
			content: "# general\n\nRebuilt\n",
			writer: {
				...request.writer,
				operationId: "rebuild",
				writerGeneration: 2,
				sequence,
				expectedNodeId: firstReceipt.nodeId,
				expectedContentRevision: firstReceipt.contentRevision,
				contentHash: await crypto_sha256_hex("# general\n\nRebuilt\n"),
			},
		};

		const old = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...replacement,
				writer: { ...replacement.writer, operationId: "old-generation", writerGeneration: 1, sequence: 101 },
			}),
		});
		expect(old.status).toBe(409);

		const rebuilt = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify(replacement),
		});
		expect(rebuilt.status, await rebuilt.clone().text()).toBe(200);
		const rebuiltReceipt = (await rebuilt.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };
		expect(rebuiltReceipt.nodeId).toBe(firstReceipt.nodeId);
		expect(rebuiltReceipt.contentRevision).not.toBe(firstReceipt.contentRevision);

		const changedArchive = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path,
				writer: {
					writerId: root.writerId,
					operationId: "changed-archive",
					writerGeneration: 2,
					nodeId: firstReceipt.nodeId,
					sequence: sequence + 1,
					expectedContentRevision: firstReceipt.contentRevision,
				},
			}),
		});
		expect(changedArchive.status, await changedArchive.clone().text()).toBe(409);

		const stale = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...replacement,
				writer: {
					...replacement.writer,
					operationId: "same-generation-stale",
					expectedContentRevision: rebuiltReceipt.contentRevision,
				},
			}),
		});
		expect(stale.status).toBe(409);

		const staleArchive = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path,
				writer: {
					writerId: root.writerId,
					operationId: "same-generation-archive",
					writerGeneration: 2,
					nodeId: firstReceipt.nodeId,
					sequence,
				},
			}),
		});
		expect(staleArchive.status).toBe(409);

		const nextFence = await t.fetch("/api/v1/files/plugin-writers/advance", {
			method: "POST",
			headers,
			body: JSON.stringify({ writerId: root.writerId, operationId: "fence-3", writerGeneration: 2, nextGeneration: 3 }),
		});
		expect(nextFence.status, await nextFence.clone().text()).toBe(200);

		const oldArchive = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path,
				writer: {
					writerId: root.writerId,
					operationId: "old-generation-archive",
					writerGeneration: 2,
					nodeId: firstReceipt.nodeId,
					sequence: 101,
				},
			}),
		});
		expect(oldArchive.status).toBe(409);

		const archived = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path,
				writer: {
					writerId: root.writerId,
					operationId: "rebuild-archive",
					writerGeneration: 3,
					nodeId: firstReceipt.nodeId,
					sequence: 1,
				},
			}),
		});
		expect(archived.status, await archived.clone().text()).toBe(200);
		expect(
			await t.run(async (ctx) => (await ctx.db.get("files_nodes", firstReceipt.nodeId))?.archiveOperationId),
		).not.toBeNull();
	});

	test("replays a committed write after a reader change but refuses a new stale-reader write", async () => {
		const { t, fixture, credentials, owner, token, root } = await setup();
		install_object_uploads();
		const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
			...credentials,
			path: `${ROOT}/team`,
			readOnly: true,
			readers: [],
			resourceKey: "private",
			rootNodeId: root.rootNodeId,
		});
		if (ensured._nay) throw new Error(ensured._nay.message);
		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: ensured._yay.folderNodeId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};
		const request = {
			path: `${ROOT}/team/team.md`,
			expectedParentNodeId: ensured._yay.folderNodeId,
			content: "Hello\n",
			nonCollaborative: true,
			writer: {
				writerId: ensured._yay.writerId,
				operationId: "saved-write",
				writerGeneration: 1,
				sequence: 1,
				expectedNodeId: null,
				expectedContentRevision: null,
				expectedReaderRevision: 1,
				contentHash: await crypto_sha256_hex("Hello\n"),
			},
		};
		const options = { method: "POST", headers, body: JSON.stringify(request) };

		const sent = await t.fetch("/api/v1/files/write", options);
		expect(sent.status, await sent.clone().text()).toBe(200);
		const receipt = (await sent.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

		const readers = await t.fetch("/api/v1/files/plugin-access/set", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path: `${ROOT}/team`,
				access: { readers: [] },
				writer: {
					writerId: ensured._yay.writerId,
					operationId: "readers",
					writerGeneration: 1,
					expectedReaderRevision: 1,
				},
			}),
		});
		expect(readers.status, await readers.clone().text()).toBe(200);

		const saved = await t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			receipts: await ctx.db.query("plugins_external_file_receipts").collect(),
		}));
		const replayed = await t.fetch("/api/v1/files/write", options);
		expect(replayed.status, await replayed.clone().text()).toBe(200);
		expect((await replayed.json()).receipt).toEqual(receipt);

		const stale = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...request,
				writer: {
					...request.writer,
					operationId: "new-stale-write",
					sequence: 2,
					expectedNodeId: receipt.nodeId,
					expectedContentRevision: receipt.contentRevision,
				},
			}),
		});
		expect(stale.status, await stale.clone().text()).toBe(409);
		expect(await stale.json()).toEqual({ message: "The file readers changed" });

		expect(
			await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				receipts: await ctx.db.query("plugins_external_file_receipts").collect(),
			})),
		).toEqual(saved);
	});

	test("a writer fence rejects an already prepared write without publishing content", async () => {
		const { t, fixture, credentials, root } = await setup();
		const path = `${ROOT}/general.md`;
		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			principalRef: { kind: "plugin_service", grantId: credentials.grantId },
			path,
			expectedParentNodeId: root.folderNodeId,
			externalFileWrite: {
				tokenHash: credentials.tokenHash,
				serviceSecretHash: credentials.serviceSecretHash,
				writerId: root.writerId,
				writerGeneration: 1,
				operationId: "old-write",
				sequence: 1,
				contentHash: await crypto_sha256_hex("old"),
				expectedNodeId: null,
				expectedContentRevision: null,
				expectedReaderRevision: null,
				contentType: "text/markdown;charset=utf-8",
				nonCollaborative: true,
				requestReadOnly: false,
			},
			overwrite: "fail",
			contentSize: 3,
			yjsSnapshotSize: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
		});
		if (prepared._nay) throw new Error(prepared._nay.message);

		expect(
			(
				await t.mutation(internal.plugins_external_files.change_scope, {
					...credentials,
					writerId: root.writerId,
					operationId: "repair",
					writerGeneration: 1,
					change: { kind: "fence", nextGeneration: 2 },
				})
			)._nay,
		).toBeUndefined();

		const published = await t.mutation(internal.public_api.publish_file_write, {
			stageId: prepared._yay.stageId,
			targetAnchor: prepared._yay.targetAnchor,
			content: "old",
			nonCollaborative: true,
		});
		expect(published._nay?.name).toBe("stale_write");

		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", fixture.organizationId)
							.eq("workspaceId", fixture.workspaceId)
							.eq("path", path)
							.eq("archiveOperationId", null),
					)
					.first(),
			),
		).toBeNull();
		expect(await t.run(async (ctx) => (await ctx.db.query("public_api_file_write_stages").collect()).length)).toBe(0);
	});
});

describe("archive", () => {
	test.each([false, true])("acknowledges an archived exact file with replacement %s", async (replace) => {
		const { t, fixture, owner, token, root } = await setup();
		install_object_uploads();
		const path = `${ROOT}/general.md`;
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};
		const write = {
			path,
			expectedParentNodeId: root.folderNodeId,
			content: "# general\n\nSaved\n",
			nonCollaborative: true,
			writer: {
				writerId: root.writerId,
				operationId: "write-1",
				writerGeneration: 1,
				sequence: 1,
				expectedNodeId: null,
				expectedContentRevision: null,
				expectedReaderRevision: null,
				contentHash: await crypto_sha256_hex("# general\n\nSaved\n"),
			},
		};

		const published = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify(write),
		});
		expect(published.status, await published.clone().text()).toBe(200);
		const file = (await published.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

		expect(
			(
				await owner.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: fixture.membershipId,
					nodeId: root.folderNodeId,
					writePolicy: null,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await owner.mutation(api.files_nodes.archive_nodes, {
					membershipId: fixture.membershipId,
					nodeIds: [file.nodeId],
				})
			)._nay,
		).toBeUndefined();

		if (replace) {
			const replacement = await t.fetch("/api/v1/files/write", {
				method: "POST",
				headers,
				body: JSON.stringify({ ...write, writer: { ...write.writer, operationId: "write-2", sequence: 2 } }),
			});
			expect(replacement.status, await replacement.clone().text()).toBe(200);
		}

		const before = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		const archive = {
			path,
			writer: {
				writerId: root.writerId,
				operationId: "archive-3",
				writerGeneration: 1,
				nodeId: file.nodeId,
				sequence: 3,
				expectedContentRevision: file.contentRevision,
			},
		};

		const changed = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...archive, writer: { ...archive.writer, expectedContentRevision: "older-revision" } }),
		});
		expect(changed.status, await changed.clone().text()).toBe(409);
		expect(await changed.json()).toEqual({ message: "The file changed" });

		const response = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify(archive),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		const receipt = (await response.json()).receipt;
		expect(receipt).toMatchObject({ nodeId: file.nodeId, operation: "archive", sequence: 3 });

		const replay = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify(archive),
		});
		expect(replay.status, await replay.clone().text()).toBe(200);
		expect((await replay.json()).receipt).toEqual(receipt);

		expect(await t.run(async (ctx) => await ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test.each(["account grant", "file policy", "parent policy"] as const)(
		"checks the current %s before acknowledging an archived file",
		async (condition) => {
			const { t, fixture, owner, token, root } = await setup();
			install_object_uploads();
			const path = `${ROOT}/general.md`;
			const headers = {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			};

			const published = await t.fetch("/api/v1/files/write", {
				method: "POST",
				headers,
				body: JSON.stringify({
					path,
					expectedParentNodeId: root.folderNodeId,
					content: "Saved",
					nonCollaborative: true,
					writer: {
						writerId: root.writerId,
						operationId: "write-1",
						writerGeneration: 1,
						sequence: 1,
						expectedNodeId: null,
						expectedContentRevision: null,
						expectedReaderRevision: null,
						contentHash: await crypto_sha256_hex("Saved"),
					},
				}),
			});
			expect(published.status, await published.clone().text()).toBe(200);
			const file = (await published.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

			const archive = {
				path,
				writer: {
					writerId: root.writerId,
					operationId: "archive-2",
					writerGeneration: 1,
					nodeId: file.nodeId,
					sequence: 2,
					expectedContentRevision: file.contentRevision,
				},
			};
			const archived = await t.fetch("/api/v1/files/plugin-archive", {
				method: "POST",
				headers,
				body: JSON.stringify(archive),
			});
			expect(archived.status, await archived.clone().text()).toBe(200);

			if (condition === "account grant") {
				expect(
					(
						await owner.mutation(api.access_control.remove_service_account_grant, {
							membershipId: fixture.membershipId,
							serviceAccountId: fixture.serviceAccountId,
							resource: { kind: "workspace" },
						})
					)._nay,
				).toBeUndefined();
			} else {
				expect(
					(
						await owner.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: fixture.membershipId,
							nodeId: condition === "file policy" ? file.nodeId : root.folderNodeId,
							writePolicy: { mode: "read_only" },
						})
					)._nay,
				).toBeUndefined();
			}

			const before = await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				receipts: await ctx.db.query("plugins_external_file_receipts").collect(),
			}));
			for (const request of [
				archive,
				{ ...archive, writer: { ...archive.writer, operationId: "archive-3", sequence: 3 } },
			]) {
				const blocked = await t.fetch("/api/v1/files/plugin-archive", {
					method: "POST",
					headers,
					body: JSON.stringify(request),
				});
				expect(blocked.status, await blocked.clone().text()).toBe(condition === "account grant" ? 403 : 409);
				if (condition !== "account grant") expect(await blocked.json()).toEqual({ message: "This item is read-only." });
			}

			expect(
				await t.run(async (ctx) => ({
					nodes: await ctx.db.query("files_nodes").collect(),
					receipts: await ctx.db.query("plugins_external_file_receipts").collect(),
				})),
			).toEqual(before);
		},
	);

	test("keeps a protected archived file unchanged and refuses a folder archive", async () => {
		const { t, fixture, owner, token, credentials, root } = await setup();
		install_object_uploads();
		const folderPath = `${ROOT}/team`;
		const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
			...credentials,
			path: folderPath,
			readOnly: true,
			resourceKey: "team",
			rootNodeId: root.rootNodeId,
		});
		if (ensured._nay) throw new Error(ensured._nay.message);
		const folder = ensured._yay;
		const headers = {
			Authorization: `Bearer ${token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
			"Content-Type": "application/json",
		};

		for (const name of ["protected", "current"]) {
			const path = `${folderPath}/${name}.md`;
			const published = await t.fetch("/api/v1/files/write", {
				method: "POST",
				headers,
				body: JSON.stringify({
					path,
					expectedParentNodeId: folder.folderNodeId,
					content: name,
					nonCollaborative: true,
					writer: {
						writerId: folder.writerId,
						operationId: `write-${name}`,
						writerGeneration: 1,
						sequence: 1,
						expectedNodeId: null,
						expectedContentRevision: null,
						expectedReaderRevision: null,
						contentHash: await crypto_sha256_hex(name),
					},
				}),
			});
			expect(published.status, await published.clone().text()).toBe(200);
			const file = (await published.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };
			const archived = await t.fetch("/api/v1/files/plugin-archive", {
				method: "POST",
				headers,
				body: JSON.stringify({
					path,
					writer: {
						writerId: folder.writerId,
						operationId: `archive-${name}`,
						writerGeneration: 1,
						sequence: 2,
						nodeId: file.nodeId,
						expectedContentRevision: file.contentRevision,
					},
				}),
			});
			expect(archived.status, await archived.clone().text()).toBe(200);
			if (name === "protected")
				expect(
					(
						await owner.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: fixture.membershipId,
							nodeId: file.nodeId,
							writePolicy: { mode: "read_only" },
						})
					)._nay,
				).toBeUndefined();
		}

		const before = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		for (const target of [
			{ path: folderPath, nodeId: folder.folderNodeId, message: "The file changed" },
			{
				path: `${folderPath}/protected.md`,
				nodeId: before.find((node) => node.path === `${folderPath}/protected.md`)!._id,
				message: "This item is read-only.",
			},
		]) {
			const blocked = await t.fetch("/api/v1/files/plugin-archive", {
				method: "POST",
				headers,
				body: JSON.stringify({
					path: target.path,
					writer: {
						writerId: folder.writerId,
						operationId: `archive-${target.nodeId}`,
						writerGeneration: 1,
						sequence: 3,
						nodeId: target.nodeId,
					},
				}),
			});
			expect(blocked.status, await blocked.clone().text()).toBe(409);
			expect(await blocked.json()).toEqual({ message: target.message });
		}

		expect(await t.run(async (ctx) => await ctx.db.query("files_nodes").collect())).toEqual(before);
		expect(before.find((node) => node._id === folder.folderNodeId)?.archiveOperationId).toBeNull();
	});
});

describe("ensure_writer", () => {
	test.each(["workspace.service_accounts.manage", "content.permissions.manage", "content.read"])(
		"refuses private setup without the actor's %s before creating anything",
		async (missingPermission) => {
			const { t, fixture, token, root, rootPath } = await setup({ publicWriter: true });
			await t.run(async (ctx) => {
				const nextOwnerId = await ctx.db.insert("users", { clerkUserId: "next-owner" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId: nextOwnerId,
					active: true,
				});
				await ctx.db.patch("organizations", fixture.organizationId, { ownerUserId: nextOwnerId });
				const roleId = await ctx.db.insert("access_control_roles", {
					organizationId: fixture.organizationId,
					name: "File setup",
					normalizedName: "file setup",
					description: "File setup permissions",
					permissions: (
						[
							"workspace.service_accounts.manage",
							"content.read",
							"content.write",
							"content.permissions.manage",
						] as const
					).filter((permission) => permission !== missingPermission),
					createdBy: nextOwnerId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				await ctx.db.insert("access_control_role_assignments", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId: fixture.userId,
					role: roleId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			});

			const before = await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				writers: await ctx.db.query("plugins_external_file_writers").collect(),
				bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
				grants: await ctx.db.query("access_control_permission_grants").collect(),
			}));
			const denied = await t.fetch("/api/v1/files/plugin-folders/ensure", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					path: `${rootPath}/private/team`,
					writer: { resourceKey: "private-team", rootNodeId: root.rootNodeId },
					access: { readers: [], readOnly: true },
				}),
			});
			expect(denied.status, await denied.clone().text()).toBe(403);

			expect(
				await t.run(async (ctx) => ({
					nodes: await ctx.db.query("files_nodes").collect(),
					writers: await ctx.db.query("plugins_external_file_writers").collect(),
					bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
					grants: await ctx.db.query("access_control_permission_grants").collect(),
				})),
			).toEqual(before);
		},
	);

	test("recovers a lost private setup response without restoring a removed account grant", async () => {
		const { t, fixture, owner, token, credentials, root } = await setup();
		const request = {
			path: `${ROOT}/private/team`,
			access: { readOnly: true, readers: [] },
			writer: { resourceKey: "private", rootNodeId: root.rootNodeId },
		};
		const options = {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
		};

		const sent = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(sent.status, await sent.clone().text()).toBe(200);
		const created = (await sent.json()) as { nodeId: Id<"files_nodes"> };

		expect(
			(
				await owner.mutation(api.access_control.remove_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: created.nodeId },
				})
			)._nay,
		).toBeUndefined();
		const saved = await t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			writers: await ctx.db.query("plugins_external_file_writers").collect(),
			bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
			grants: await ctx.db.query("access_control_permission_grants").collect(),
		}));
		const writer = saved.writers.find((writer) => writer.resourceKey === "private")!;

		// The worker retries its saved request without using the lost response's IDs.
		const repeated = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(repeated.status, await repeated.clone().text()).toBe(200);
		expect(await repeated.json()).toEqual({
			nodeId: writer.folderNodeId,
			path: request.path,
			created: false,
			writer: {
				writerId: writer._id,
				rootNodeId: writer.rootNodeId,
				folderNodeId: writer.folderNodeId,
				writerGeneration: 1,
				readerRevision: 1,
				detached: false,
			},
		});

		expect(
			await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				writers: await ctx.db.query("plugins_external_file_writers").collect(),
				bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
				grants: await ctx.db.query("access_control_permission_grants").collect(),
			})),
		).toEqual(saved);

		expect(
			(
				await t.query(internal.plugins_external_files.inspect, {
					...credentials,
					writerId: writer._id,
					path: `${request.path}/team.md`,
				})
			)._nay?.message,
		).toBe("Permission denied");
	});

	test.each(["moved", "replaced", "nonempty"])("refuses recovery after the folder becomes %s", async (change) => {
		const { t, token, fixture, owner, root } = await setup();
		const path = `${ROOT}/team`;
		const options = {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				path,
				access: { readOnly: false, readers: [] },
				writer: { resourceKey: "private", rootNodeId: root.rootNodeId },
			}),
		};

		const sent = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(sent.status, await sent.clone().text()).toBe(200);

		const writer = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_external_file_writers")
					.withIndex("by_installation_resourceKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("resourceKey", "private"),
					)
					.first(),
		);
		expect(
			(
				await owner.mutation(api.access_control.remove_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: writer!.folderNodeId },
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await owner.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: fixture.membershipId,
					nodeId: root.rootNodeId,
					writePolicy: null,
				})
			)._nay,
		).toBeUndefined();

		if (change === "nonempty") {
			expect(
				(
					await owner.mutation(api.files_nodes.create_folder_node, {
						membershipId: fixture.membershipId,
						parentId: writer!.folderNodeId,
						path: "manual-folder",
					})
				)._nay,
			).toBeUndefined();
		} else {
			expect(
				(
					await owner.mutation(api.files_nodes.rename_node, {
						membershipId: fixture.membershipId,
						nodeId: writer!.folderNodeId,
						path: `${ROOT}/moved-team`,
					})
				)._nay,
			).toBeUndefined();
			if (change === "replaced") {
				expect(
					(
						await owner.mutation(api.files_nodes.create_folder_node, {
							membershipId: fixture.membershipId,
							parentId: root.rootNodeId,
							path: "team",
						})
					)._nay,
				).toBeUndefined();
			}
		}

		const before = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		const repeated = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(repeated.status, await repeated.clone().text()).toBe(change === "moved" ? 409 : 403);

		expect(await t.run(async (ctx) => await ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test.each(["deleted", "read access lost"])("refuses setup recovery when the sponsor is %s", async (change) => {
		const { t, token, fixture, owner, root } = await setup();
		const options = {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				path: `${ROOT}/team`,
				access: { readOnly: true, readers: [] },
				writer: { resourceKey: "private", rootNodeId: root.rootNodeId },
			}),
		};

		const sent = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(sent.status, await sent.clone().text()).toBe(200);

		if (change === "deleted") {
			await t.mutation(internal.data_deletion.init_user_deletion, { userId: fixture.userId, nowTs: Date.now() });
		} else {
			const nextOwner = await t.run(
				async (ctx) => await test_mocks_fill_db_with.membership(ctx, { organizationName: "next-owner" }),
			);
			expect(
				(
					await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						userIdToAdd: nextOwner.userId,
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await owner.mutation(api.access_control.transfer_organization_ownership, {
						organizationId: fixture.organizationId,
						newOwnerUserId: nextOwner.userId,
					})
				)._nay,
			).toBeUndefined();
			expect(
				await t.run(async (ctx) => (await ctx.db.get("organizations_workspaces_users", fixture.membershipId))?.active),
			).toBe(true);
		}

		const repeated = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(repeated.status, await repeated.clone().text()).toBe(change === "deleted" ? 401 : 403);
	});
});

describe("rollback_readers", () => {
	test.each(["applied", "unseen", "manual", "write-only", "expired", "wrong-root", "newer-readers", "policy"])(
		"uses current authority after an upgrade with %s reader work",
		async (condition) => {
			const { t, fixture, owner, credentials, token, root } = await setup();
			const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
				...credentials,
				path: `${ROOT}/team`,
				readOnly: true,
				readers: [],
				resourceKey: "private",
				rootNodeId: root.rootNodeId,
			});
			if (ensured._nay) throw new Error(ensured._nay.message);
			const folder = ensured._yay;
			expect(
				(
					await owner.mutation(api.access_control.set_service_account_grant, {
						membershipId: fixture.membershipId,
						serviceAccountId: fixture.serviceAccountId,
						resource: { kind: "file", nodeId: folder.folderNodeId },
						level: "manage",
					})
				)._nay,
			).toBeUndefined();

			if (condition !== "unseen") {
				expect(
					(
						await t.mutation(internal.plugins_external_files.change_scope, {
							...credentials,
							writerId: folder.writerId,
							operationId: "before-upgrade",
							writerGeneration: 1,
							change: { kind: "readers", expectedReaderRevision: 1, readers: [] },
						})
					)._nay,
				).toBeUndefined();
			}

			const next = await t.run(async (ctx) => {
				const version = (await ctx.db.get("plugins_versions", fixture.pluginVersionId))!;
				const { _id, _creationTime, ...fields } = version;
				return {
					id: await ctx.db.insert("plugins_versions", { ...fields, version: "1.0.1" }),
					capabilities: fields.capabilities,
				};
			});
			expect(
				(
					await owner.mutation(api.plugins.install_version, {
						membershipId: fixture.membershipId,
						pluginVersionId: next.id,
						acceptedCapabilities: next.capabilities,
						acceptedOutboundOrigins: [],
						acceptedUiOutboundOrigins: [],
					})
				)._nay,
			).toBeUndefined();

			const current = await t.mutation(internal.public_api.create_plugin_service_grant, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				actorUserId: fixture.userId,
				requestedScopes: ["files:write"],
				destinationPathPrefix: condition === "wrong-root" ? `${ROOT}/other` : ROOT,
				phase: "processing",
				now: Date.now(),
			});
			if (current._nay) throw new Error(current._nay.message);
			const headers = {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			};
			const options = {
				method: "POST",
				headers,
				body: JSON.stringify({
					writerId: folder.writerId,
					writerGeneration: 1,
					operationId: "undo-upgrade",
					originalReaderOperationId: "before-upgrade",
				}),
			};

			const old = await t.fetch("/api/v1/files/plugin-access/undo", options);
			expect(old.status, await old.clone().text()).toBe(401);
			expect(await old.json()).toEqual({ message: "Unauthenticated", code: "reader_proof_mismatch" });

			if (condition === "manual") {
				const reader = await t.run(
					async (ctx) => await test_mocks_fill_db_with.membership(ctx, { organizationName: "manual-reader" }),
				);
				expect(
					(
						await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
							organizationId: fixture.organizationId,
							workspaceId: fixture.workspaceId,
							userIdToAdd: reader.userId,
						})
					)._nay,
				).toBeUndefined();
				expect(
					(
						await owner.mutation(api.files_sharing.set_node_share_grant, {
							membershipId: fixture.membershipId,
							nodeId: folder.folderNodeId,
							principal: { kind: "user", userId: reader.userId },
							level: "write",
						})
					)._nay,
				).toBeUndefined();
			} else if (condition === "write-only") {
				expect(
					(
						await owner.mutation(api.access_control.set_service_account_grant, {
							membershipId: fixture.membershipId,
							serviceAccountId: fixture.serviceAccountId,
							resource: { kind: "file", nodeId: folder.folderNodeId },
							level: "write",
						})
					)._nay,
				).toBeUndefined();
			} else if (condition === "newer-readers") {
				expect(
					(
						await t.mutation(internal.plugins_external_files.change_scope, {
							grantId: current._yay.grantId,
							tokenHash: await crypto_sha256_hex(current._yay.token),
							serviceSecretHash: credentials.serviceSecretHash,
							writerId: folder.writerId,
							operationId: "newer-readers",
							writerGeneration: 1,
							change: { kind: "readers", expectedReaderRevision: 2, readers: [] },
						})
					)._nay,
				).toBeUndefined();
			} else if (condition === "policy") {
				expect(
					(
						await owner.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: fixture.membershipId,
							nodeId: folder.folderNodeId,
							writePolicy: { mode: "writer", writer: { kind: "user", userId: fixture.userId } },
						})
					)._nay,
				).toBeUndefined();
			} else if (condition === "expired") {
				vi.spyOn(Date, "now").mockReturnValue(current._yay.expiresAt + 1);
			}

			const before = await t.run(async (ctx) => ({
				grants: await ctx.db.query("access_control_permission_grants").collect(),
				bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
			}));
			headers.Authorization = `Bearer ${current._yay.token}`;

			const result = await t.fetch("/api/v1/files/plugin-access/undo", options);
			const expectedStatus =
				condition === "expired"
					? 401
					: condition === "write-only" || condition === "wrong-root"
						? 403
						: condition === "newer-readers" || condition === "policy"
							? 409
							: 200;
			expect(result.status, await result.clone().text()).toBe(expectedStatus);
			if (expectedStatus !== 200 || condition === "manual" || condition === "unseen") {
				expect(
					await t.run(async (ctx) => ({
						grants: await ctx.db.query("access_control_permission_grants").collect(),
						bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
					})),
				).toEqual(before);
			}

			if (expectedStatus === 200) {
				const receipt = await result.json();
				expect(receipt).toMatchObject({
					detached: condition === "manual",
					restored: condition !== "manual",
					readerRevision: condition === "unseen" ? 1 : 3,
				});
				const repeated = await t.fetch("/api/v1/files/plugin-access/undo", options);
				expect(repeated.status, await repeated.clone().text()).toBe(200);
				expect(await repeated.json()).toEqual(receipt);
			}
		},
	);

	test.each(["receipt", "operation"])(
		"restores readers by %s after sponsor access and bearer expiry",
		async (lookup) => {
			const { t, fixture, owner, credentials, token, root } = await setup();
			const readers = await t.run(async (ctx) => {
				const readers: { userId: Id<"users">; membershipLifetime: number }[] = [];
				for (const name of ["before", "added"]) {
					const userId = await ctx.db.insert("users", { clerkUserId: name });
					const membershipId = await ctx.db.insert("organizations_workspaces_users", {
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						userId,
						active: true,
					});
					await ctx.db.insert("organizations_membership_lifetimes", {
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						userId,
						membershipId,
						active: true,
						lifetime: 1,
					});
					readers.push({ userId, membershipLifetime: 1 });
				}
				return readers;
			});

			const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
				...credentials,
				path: `${ROOT}/team`,
				readOnly: true,
				readers: readers.slice(0, 1),
				resourceKey: "private",
				rootNodeId: root.rootNodeId,
			});
			if (ensured._nay) throw new Error(ensured._nay.message);
			const nodeId = ensured._yay.folderNodeId;
			expect(
				(
					await owner.mutation(api.access_control.set_service_account_grant, {
						membershipId: fixture.membershipId,
						serviceAccountId: fixture.serviceAccountId,
						resource: { kind: "file", nodeId },
						level: "manage",
					})
				)._nay,
			).toBeUndefined();
			const headers = {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			};

			const changed = await t.fetch("/api/v1/files/plugin-access/set", {
				method: "POST",
				headers,
				body: JSON.stringify({
					path: `${ROOT}/team`,
					access: { readers },
					writer: {
						writerId: ensured._yay.writerId,
						operationId: "add-reader",
						writerGeneration: 1,
						expectedReaderRevision: 1,
					},
				}),
			});
			expect(changed.status, await changed.clone().text()).toBe(200);
			const receipt = (await changed.json()).receipt as { _id: string; readerRevision: number };

			const rotated = await t.mutation(internal.public_api.rotate_plugin_service_grant, {
				presented: token,
				now: Date.now(),
			});
			if (rotated._nay) throw new Error(rotated._nay.message);
			const nextOwner = await t.run(
				async (ctx) => await test_mocks_fill_db_with.membership(ctx, { organizationName: "next-owner" }),
			);
			expect(
				(
					await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						userIdToAdd: nextOwner.userId,
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await owner.mutation(api.access_control.transfer_organization_ownership, {
						organizationId: fixture.organizationId,
						newOwnerUserId: nextOwner.userId,
					})
				)._nay,
			).toBeUndefined();

			const ordinary = await t.fetch("/api/v1/files/plugin-access/set", {
				method: "POST",
				headers: { ...headers, Authorization: `Bearer ${rotated._yay.token}` },
				body: JSON.stringify({
					path: `${ROOT}/team`,
					access: { readers: readers.slice(0, 1) },
					writer: {
						writerId: ensured._yay.writerId,
						operationId: "ordinary-rollback",
						writerGeneration: 1,
						expectedReaderRevision: receipt.readerRevision,
					},
				}),
			});
			expect(ordinary.status, await ordinary.clone().text()).toBe(403);

			vi.spyOn(Date, "now").mockReturnValue(rotated._yay.expiresAt + 1);
			const options = {
				method: "POST",
				headers,
				body: JSON.stringify({
					writerId: ensured._yay.writerId,
					operationId: "rollback",
					writerGeneration: 1,
					...(lookup === "receipt" ? { receiptId: receipt._id } : { originalReaderOperationId: "add-reader" }),
				}),
			};

			const rolledBack = await t.fetch("/api/v1/files/plugin-access/undo", options);
			expect(rolledBack.status, await rolledBack.clone().text()).toBe(200);
			expect(await rolledBack.json()).toMatchObject({
				restored: true,
				detached: false,
				readerRevision: receipt.readerRevision + 1,
			});

			const grants = await t.run(
				async (ctx) =>
					await ctx.db
						.query("access_control_permission_grants")
						.withIndex("by_organization_workspace_resource_user_permission", (q) =>
							q
								.eq("organizationId", fixture.organizationId)
								.eq("workspaceId", fixture.workspaceId)
								.eq("resourceKind", "file")
								.eq("resourceId", String(nodeId)),
						)
						.collect(),
			);
			expect(grants.filter((grant) => grant.principalKind === "user").map((grant) => grant.userId)).toEqual([
				readers[0]!.userId,
			]);
			expect(grants.filter((grant) => grant.principalKind === "service_account")).toHaveLength(3);

			const repeated = await t.fetch("/api/v1/files/plugin-access/undo", options);
			expect(repeated.status, await repeated.clone().text()).toBe(200);
			expect(await repeated.json()).toMatchObject({ restored: true, readerRevision: receipt.readerRevision + 1 });
		},
	);

	test.each(["live", "rotated", "policy"])(
		"cancels an unseen reader operation with %s credentials before a delayed apply",
		async (condition) => {
			const { t, fixture, owner, credentials, token, root } = await setup();
			const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
				...credentials,
				path: `${ROOT}/team`,
				readOnly: true,
				readers: [],
				resourceKey: "private",
				rootNodeId: root.rootNodeId,
			});
			if (ensured._nay) throw new Error(ensured._nay.message);
			expect(
				(
					await owner.mutation(api.access_control.set_service_account_grant, {
						membershipId: fixture.membershipId,
						serviceAccountId: fixture.serviceAccountId,
						resource: { kind: "file", nodeId: ensured._yay.folderNodeId },
						level: "manage",
					})
				)._nay,
			).toBeUndefined();

			const headers = {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			};
			const before = await t.run(async (ctx) => ({
				grants: await ctx.db.query("access_control_permission_grants").collect(),
				bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
			}));
			const options = {
				method: "POST",
				headers,
				body: JSON.stringify({
					writerId: ensured._yay.writerId,
					operationId: "cancel",
					writerGeneration: 1,
					originalReaderOperationId: "delayed-readers",
				}),
			};

			if (condition === "rotated") {
				const rotated = await t.mutation(internal.public_api.rotate_plugin_service_grant, {
					presented: token,
					now: Date.now(),
				});
				if (rotated._nay) throw new Error(rotated._nay.message);
				const unknown = await t.fetch("/api/v1/files/plugin-access/undo", options);
				expect(unknown.status, await unknown.clone().text()).toBe(401);
				expect(await unknown.json()).toEqual({ message: "Unauthenticated", code: "reader_proof_mismatch" });
				headers.Authorization = `Bearer ${rotated._yay.token}`;
			} else if (condition === "policy") {
				expect(
					(
						await owner.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: fixture.membershipId,
							nodeId: ensured._yay.rootNodeId,
							writePolicy: { mode: "writer", writer: { kind: "user", userId: fixture.userId } },
						})
					)._nay,
				).toBeUndefined();
				const blocked = await t.fetch("/api/v1/files/plugin-access/undo", options);
				expect(blocked.status, await blocked.clone().text()).toBe(409);
				expect(await blocked.json()).toEqual({ message: "This item is read-only." });
				expect(
					await t.run(async (ctx) => await ctx.db.query("plugins_external_file_reader_changes").collect()),
				).toEqual([]);
				expect(
					(
						await owner.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: fixture.membershipId,
							nodeId: ensured._yay.rootNodeId,
							writePolicy: {
								mode: "writer",
								writer: { kind: "service_account", serviceAccountId: fixture.serviceAccountId },
							},
						})
					)._nay,
				).toBeUndefined();
			}

			const cancelled = await t.fetch("/api/v1/files/plugin-access/undo", options);
			expect(cancelled.status, await cancelled.clone().text()).toBe(200);
			const acknowledgement = await cancelled.json();
			expect(acknowledgement).toMatchObject({ restored: true, detached: false, readerRevision: 1 });

			const delayed = await t.fetch("/api/v1/files/plugin-access/set", {
				method: "POST",
				headers,
				body: JSON.stringify({
					path: `${ROOT}/team`,
					access: { readers: [] },
					writer: {
						writerId: ensured._yay.writerId,
						operationId: "delayed-readers",
						writerGeneration: 1,
						expectedReaderRevision: 1,
					},
				}),
			});
			expect(delayed.status, await delayed.clone().text()).toBe(409);
			expect(
				await t.run(async (ctx) => ({
					grants: await ctx.db.query("access_control_permission_grants").collect(),
					bindings: await ctx.db.query("plugins_external_file_bindings").collect(),
				})),
			).toEqual(before);

			const repeated = await t.fetch("/api/v1/files/plugin-access/undo", options);
			expect(repeated.status, await repeated.clone().text()).toBe(200);
			expect(await repeated.json()).toEqual(acknowledgement);
		},
	);

	test.each([
		"manual",
		"newer-readers",
		"newer-writer",
		"wrong-token",
		"wrong-secret",
		"wrong-token-and-secret",
		"revoked-account",
		"uninstalled",
		"old-lifetime",
		"target-policy",
		"ancestor-policy",
	])("keeps reader rollback bounded after %s", async (change) => {
		const { t, fixture, owner, credentials, token, root } = await setup();
		const reader = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "prior-reader" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				active: true,
			});
			const lifetimeId = await ctx.db.insert("organizations_membership_lifetimes", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				membershipId,
				active: true,
				lifetime: 1,
			});
			return { userId, lifetimeId };
		});

		const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
			...credentials,
			path: `${ROOT}/team`,
			readOnly: true,
			readers: [{ userId: reader.userId, membershipLifetime: 1 }],
			resourceKey: "private",
			rootNodeId: root.rootNodeId,
		});
		if (ensured._nay) throw new Error(ensured._nay.message);
		const nodeId = ensured._yay.folderNodeId;
		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();

		const applied = await t.mutation(internal.plugins_external_files.change_scope, {
			...credentials,
			writerId: ensured._yay.writerId,
			operationId: "remove-reader",
			writerGeneration: 1,
			change: { kind: "readers", expectedReaderRevision: 1, readers: [] },
		});
		if (applied._nay) throw new Error(applied._nay.message);

		if (change === "manual") {
			expect(
				(
					await owner.mutation(api.files_sharing.set_node_share_grant, {
						membershipId: fixture.membershipId,
						nodeId,
						principal: { kind: "user", userId: reader.userId },
						level: "write",
					})
				)._nay,
			).toBeUndefined();
		} else if (change === "newer-readers") {
			expect(
				(
					await t.mutation(internal.plugins_external_files.change_scope, {
						...credentials,
						writerId: ensured._yay.writerId,
						operationId: "later-reader-change",
						writerGeneration: 1,
						change: { kind: "readers", expectedReaderRevision: 2, readers: [] },
					})
				)._nay,
			).toBeUndefined();
		} else if (change === "newer-writer") {
			expect(
				(
					await t.mutation(internal.plugins_external_files.change_scope, {
						...credentials,
						writerId: ensured._yay.writerId,
						operationId: "fence",
						writerGeneration: 1,
						change: { kind: "fence", nextGeneration: 2 },
					})
				)._nay,
			).toBeUndefined();
		} else if (change === "old-lifetime") {
			await t.run(
				async (ctx) => await ctx.db.patch("organizations_membership_lifetimes", reader.lifetimeId, { lifetime: 2 }),
			);
		} else if (change === "revoked-account") {
			expect(
				(
					await owner.mutation(api.access_control.revoke_service_account, {
						membershipId: fixture.membershipId,
						serviceAccountId: fixture.serviceAccountId,
					})
				)._nay,
			).toBeUndefined();
		} else if (change === "uninstalled") {
			expect(
				(
					await owner.mutation(api.plugins.uninstall_version, {
						membershipId: fixture.membershipId,
						installationId: fixture.installationId,
					})
				)._nay,
			).toBeUndefined();
		} else if (change === "target-policy" || change === "ancestor-policy") {
			expect(
				(
					await owner.mutation(api.files_nodes.set_node_write_policy, {
						membershipId: fixture.membershipId,
						nodeId: change === "target-policy" ? nodeId : ensured._yay.rootNodeId,
						writePolicy: { mode: "writer", writer: { kind: "user", userId: fixture.userId } },
					})
				)._nay,
			).toBeUndefined();
		}

		const before = await t.run(async (ctx) => await ctx.db.query("access_control_permission_grants").collect());
		const result = await t.fetch("/api/v1/files/plugin-access/undo", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${change.startsWith("wrong-token") ? "psg_wrong" : token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${change.endsWith("secret") ? "wrong" : SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				writerId: ensured._yay.writerId,
				operationId: "undo",
				writerGeneration: 1,
				receiptId: applied._yay._id,
			}),
		});

		const expectedStatus =
			change === "manual" || change === "old-lifetime"
				? 200
				: change.startsWith("wrong-") || change === "revoked-account" || change === "uninstalled"
					? 401
					: 409;
		expect(result.status, await result.clone().text()).toBe(expectedStatus);
		if (expectedStatus === 401)
			expect(await result.json()).toEqual({
				message: "Unauthenticated",
				...(change === "wrong-token" ? { code: "reader_proof_mismatch" } : {}),
			});
		if (change === "manual") expect(await result.json()).toMatchObject({ restored: false, detached: true, _id: null });
		if (change === "old-lifetime") expect(await result.json()).toMatchObject({ restored: true, detached: false });
		if (change === "target-policy" || change === "ancestor-policy")
			expect(await result.json()).toEqual({ message: "This item is read-only." });
		expect(await t.run(async (ctx) => await ctx.db.query("access_control_permission_grants").collect())).toEqual(
			before,
		);
	});
});

describe("external file readers", () => {
	test("reserves one own-account slot beside 50 attached readers and keeps the normal sharing cap", async () => {
		const { t, fixture, credentials, owner, root } = await setup();
		const readers = await t.run(async (ctx) => {
			const readers: { userId: Id<"users">; membershipLifetime: number }[] = [];
			for (let index = 0; index < 51; index++) {
				const userId = await ctx.db.insert("users", { clerkUserId: `reader-${index}` });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId,
					active: true,
				});
				await ctx.db.insert("organizations_membership_lifetimes", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId,
					membershipId,
					lifetime: 1,
					active: true,
				});
				readers.push({ userId, membershipLifetime: 1 });
			}
			return readers;
		});
		const privateScope = await t.mutation(internal.plugins_external_files.ensure_writer, {
			...credentials,
			path: `${ROOT}/private/team`,
			readOnly: true,
			readers: readers.slice(0, 50),
			resourceKey: "large-private",
			rootNodeId: root.rootNodeId,
		});
		if (privateScope._nay) throw new Error(privateScope._nay.message);
		const nodeId = privateScope._yay.folderNodeId;

		const otherAccount = await t.run(
			async (ctx) =>
				await ctx.db.insert("access_control_service_accounts", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					name: "Other",
					createdBy: fixture.userId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					revokedAt: null,
				}),
		);
		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: otherAccount,
					resource: { kind: "file", nodeId },
					level: "read",
				})
			)._nay,
		).toBeDefined();

		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();

		expect(
			(
				await owner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: fixture.membershipId,
					nodeId,
					principal: { kind: "user", userId: readers[50]!.userId },
					level: "read",
				})
			)._nay,
		).toBeDefined();

		expect(
			(
				await owner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: fixture.membershipId,
					nodeId,
					principal: { kind: "user", userId: readers[0]!.userId },
					level: "write",
				})
			)._nay,
		).toBeUndefined();

		const grants = await t.run(
			async (ctx) =>
				await ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_workspace_resource_user_permission", (q) =>
						q
							.eq("organizationId", fixture.organizationId)
							.eq("workspaceId", fixture.workspaceId)
							.eq("resourceKind", "file")
							.eq("resourceId", String(nodeId)),
					)
					.collect(),
		);
		expect(
			grants.filter((grant) => grant.principalKind === "user" && grant.permission === "content.read"),
		).toHaveLength(50);
		expect(grants.filter((grant) => grant.principalKind === "service_account")).toHaveLength(3);

		for (const reader of readers.slice(0, 50)) {
			// files_sharing_write holds 8 tokens, so 50 sequential shares need a reset per call.
			await t.run(
				async (ctx) =>
					await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
						name: "files_sharing_write",
						key: fixture.userId,
					}),
			);
			expect(
				(
					await owner.mutation(api.files_sharing.set_node_share_grant, {
						membershipId: fixture.membershipId,
						nodeId,
						principal: { kind: "user", userId: reader.userId },
						level: "manage",
					})
				)._nay,
			).toBeUndefined();
		}

		const promoted = await t.run(
			async (ctx) =>
				await ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_workspace_resource_user_permission", (q) =>
						q
							.eq("organizationId", fixture.organizationId)
							.eq("workspaceId", fixture.workspaceId)
							.eq("resourceKind", "file")
							.eq("resourceId", String(nodeId)),
					)
					.collect(),
		);
		expect(promoted).toHaveLength(153);
		const lastUserId = promoted.filter((grant) => grant.principalKind === "user").at(-1)!.userId!;

		expect(
			(
				await owner.mutation(api.files_sharing.remove_node_share_grant, {
					membershipId: fixture.membershipId,
					nodeId,
					principal: { kind: "user", userId: lastUserId },
				})
			)._nay,
		).toBeUndefined();
		expect(
			await t.run(
				async (ctx) =>
					await ctx.db
						.query("access_control_permission_grants")
						.withIndex("by_organization_workspace_resource_user_permission", (q) =>
							q
								.eq("organizationId", fixture.organizationId)
								.eq("workspaceId", fixture.workspaceId)
								.eq("resourceKind", "file")
								.eq("resourceId", String(nodeId))
								.eq("principalKind", "user")
								.eq("userId", lastUserId),
						)
						.collect(),
			),
		).toEqual([]);

		// A detached folder uses the normal cap, including the remaining account.
		expect(
			(
				await owner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: fixture.membershipId,
					nodeId,
					principal: { kind: "user", userId: lastUserId },
					level: "read",
				})
			)._nay,
		).toBeDefined();

		expect(
			(
				await owner.mutation(api.access_control.remove_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId },
				})
			)._nay,
		).toBeUndefined();

		expect(
			(
				await owner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: fixture.membershipId,
					nodeId,
					principal: { kind: "user", userId: lastUserId },
					level: "read",
				})
			)._nay,
		).toBeUndefined();

		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId },
					level: "manage",
				})
			)._nay,
		).toBeDefined();
	});

	test("workspace content purge drains external file and grant receipt docs", async () => {
		const { t, fixture, credentials, root, owner } = await setup();
		const privateScope = await t.mutation(internal.plugins_external_files.ensure_writer, {
			...credentials,
			path: `${ROOT}/private/team`,
			readOnly: true,
			readers: [],
			resourceKey: "private",
			rootNodeId: root.rootNodeId,
		});
		if (privateScope._nay) throw new Error(privateScope._nay.message);
		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: privateScope._yay.folderNodeId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await t.mutation(internal.plugins_external_files.change_scope, {
					...credentials,
					writerId: privateScope._yay.writerId,
					operationId: "reader-proof",
					writerGeneration: 1,
					change: { kind: "readers", expectedReaderRevision: 1, readers: [] },
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await t.mutation(internal.plugins_external_files.change_scope, {
					...credentials,
					writerId: root.writerId,
					operationId: "fence",
					writerGeneration: 1,
					change: { kind: "fence", nextGeneration: 2 },
				})
			)._nay,
		).toBeUndefined();

		const interactive = await t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			actorUserId: fixture.userId,
			requestedScopes: [],
			destinationPathPrefix: null,
			phase: "interactive",
			now: Date.now(),
		});
		if (interactive._nay) throw new Error(interactive._nay.message);
		expect(
			(
				await t.mutation(internal.public_api.rotate_plugin_service_grant, {
					presented: interactive._yay.token,
					now: Date.now(),
					lifecycle: { requestId: "renew", serviceSecretHash: credentials.serviceSecretHash },
				})
			)._nay,
		).toBeUndefined();

		const tables = [
			"plugins_external_file_reader_changes",
			"plugins_external_file_writers",
			"plugins_external_file_bindings",
			"plugins_external_file_receipts",
			"plugin_service_grant_requests",
		] as const;
		for (const table of tables)
			expect(await t.run(async (ctx) => (await ctx.db.query(table).collect()).length)).toBeGreaterThan(0);

		const requestId = await t.run(
			async (ctx) =>
				await data_deletion_db_request(ctx, {
					userId: fixture.userId,
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					scope: "workspace",
					eligibleAt: Date.now(),
				}),
		);
		let done = false;
		for (let pass = 0; pass < 200 && !done; pass++) {
			done = (
				await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 })
			).done;
		}
		expect(done).toBe(true);

		for (const table of tables) expect(await t.run(async (ctx) => await ctx.db.query(table).collect())).toEqual([]);
	});

	test("old readers stay refused after removal and reinvitation, while account grants stay independent", async () => {
		const { t, fixture, credentials, owner, root } = await setup();
		const user = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "external-reader" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				active: true,
			});
			const lifetimeId = await ctx.db.insert("organizations_membership_lifetimes", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				membershipId,
				active: true,
				lifetime: 1,
			});
			return { userId, membershipId, lifetimeId };
		});
		const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
			...credentials,
			path: `${ROOT}/private/team`,
			readOnly: true,
			readers: [{ userId: user.userId, membershipLifetime: 1 }],
			resourceKey: "private",
			rootNodeId: root.rootNodeId,
		});
		if (ensured._nay) throw new Error(ensured._nay.message);
		const nodeId = ensured._yay.folderNodeId;

		const canRead = async () =>
			await t.run(
				async (ctx) =>
					await access_control_db_can_act_on_file_node(ctx, {
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						userId: user.userId,
						fileNode: (await ctx.db.get("files_nodes", nodeId))!,
						permission: "content.read",
					}),
			);
		expect(await canRead()).toBe(true);

		await t.run(
			async (ctx) =>
				await ctx.db.patch("organizations_membership_lifetimes", user.lifetimeId, { active: false, lifetime: 2 }),
		);
		expect(await canRead()).toBe(false);

		await t.run(
			async (ctx) => await ctx.db.patch("organizations_membership_lifetimes", user.lifetimeId, { active: true }),
		);
		expect(await canRead()).toBe(false);

		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();

		expect(
			(
				await t.mutation(internal.plugins_external_files.change_scope, {
					...credentials,
					writerId: ensured._yay.writerId,
					operationId: "stale-readers",
					writerGeneration: 1,
					change: {
						kind: "readers",
						expectedReaderRevision: 1,
						readers: [{ userId: user.userId, membershipLifetime: 1 }],
					},
				})
			)._nay?.name,
		).toBe("stale_write");

		const binding = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_external_file_bindings")
					.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
					.first(),
		);
		expect(binding?.detachedAt).toBeNull();

		expect(
			(
				await owner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: fixture.membershipId,
					nodeId,
					principal: { kind: "user", userId: user.userId },
					level: "write",
				})
			)._nay,
		).toBeUndefined();
		expect(await canRead()).toBe(true);

		const repeated = await t.mutation(internal.plugins_external_files.ensure_writer, {
			...credentials,
			path: `${ROOT}/private/team`,
			readOnly: true,
			readers: [{ userId: user.userId, membershipLifetime: 2 }],
			resourceKey: "private",
			rootNodeId: root.rootNodeId,
		});
		expect(repeated._yay?.detached).toBe(true);

		expect(
			(
				await t.mutation(internal.plugins_external_files.change_scope, {
					...credentials,
					writerId: ensured._yay.writerId,
					operationId: "detached-readers",
					writerGeneration: 1,
					change: { kind: "readers", expectedReaderRevision: 1, readers: [] },
				})
			)._nay?.name,
		).toBe("stale_write");

		expect(await canRead()).toBe(true);
	});
});
