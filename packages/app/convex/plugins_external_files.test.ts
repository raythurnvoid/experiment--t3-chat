import { R2 } from "@convex-dev/r2";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_rename_node, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { Id } from "./_generated/dataModel";
import type { plugins_Capability } from "../shared/plugins.ts";
import { access_control_db_can_act_on_file_node, type access_control_Subject } from "./access_control.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes_create_db.ts";
import { files_nodes_db_set_restricted_scope } from "./files_sharing_db.ts";
import { plugins_file_subject } from "./plugins_service_accounts.ts";

const SECRET = "external-files-test-secret";
const ROOT = "/chitchat-fresh-test";

async function setup(options?: { publicWriter: true }) {
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
			"workspace.files.manage-read-only",
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
			endpoints: [],
			userWritableCollections: null,
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
			force: true,
			path: rootPath,
			writer: { resourceKey: "export output, 2026", rootNodeId: null },
			access: { readOnly: true },
		}),
	});
	expect(response.status, await response.clone().text()).toBe(200);
	const body = (await response.json()) as {
		writer: {
			writerId: Id<"plugins_external_file_writers">;
			rootNodeId: Id<"files_nodes">;
			folderNodeId: Id<"files_nodes">;
			writerGeneration: number;
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
		const { t, fixture, owner, token, root, rootPath } = await setup({ publicWriter: true });
		expect(
			(
				await owner.mutation(api.files_nodes.read_only_set, {
					membershipId: fixture.membershipId,
					nodeId: root.folderNodeId,
					readOnly: false,
				})
			)._nay,
		).toBeUndefined();
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
				contentHash: await crypto_sha256_hex(content),
			},
		};

		const sent = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(sent.status, await sent.clone().text()).toBe(200);
		const saved = (await sent.json()) as {
			nodeId: Id<"files_nodes">;
			contentType: string;
			receipt: { contentRevision: string };
		};
		expect(saved.contentType).toBe("text/plain;charset=utf-8");
		const receipt = await t.run((ctx) => ctx.db.query("plugins_external_file_receipts").first());
		expect(receipt?.fingerprint).toBe(
			JSON.stringify([
				path,
				1,
				1,
				body.writer.contentHash,
				root.folderNodeId,
				null,
				null,
				"text/plain;charset=utf-8",
				true,
				false,
			]),
		);

		const replay = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...body, force: false }),
		});
		expect(replay.status, await replay.clone().text()).toBe(200);
		expect(await replay.json()).toEqual(saved);
		const omitted = await t.fetch("/api/v1/files/write", { method: "POST", headers, body: JSON.stringify(body) });
		expect(omitted.status).toBe(200);
		expect(await omitted.json()).toEqual(saved);
		// TODO(migration): delete in phase B. A Chitchat release that still sends the old null field replays too.
		const withOldField = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...body, writer: { ...body.writer, expectedReaderRevision: null } }),
		});
		expect(withOldField.status, await withOldField.clone().text()).toBe(200);
		expect(await withOldField.json()).toEqual(saved);

		for (const changed of [
			{ force: true },
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
				force: true,
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
			readOnly: false,
		});
	});

	test.each(["contentType", "nonCollaborative", "requestReadOnly", "content"])(
		"publication refuses changed %s after staging",
		async (changed) => {
			const { t, fixture, root, rootPath, credentials } = await setup({ publicWriter: true });
			const prepared = await t.mutation(internal.public_api.prepare_file_write, {
				force: true,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId: fixture.userId,
				principalRef: { kind: "plugin_service", grantId: credentials.grantId },
				path: `${rootPath}/report.txt`,
				expectedParentNodeId: root.folderNodeId,
				externalFileWrite: {
					force: true,
					tokenHash: credentials.tokenHash,
					serviceSecretHash: credentials.serviceSecretHash,
					writerId: root.writerId,
					operationId: "prepared",
					writerGeneration: 1,
					sequence: 1,
					expectedNodeId: null,
					expectedContentRevision: null,
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
			body: JSON.stringify({
				force: true,
				path: `${rootPath}/report.txt`,
				content: "Notes",
				writer: { writerId: root.writerId },
			}),
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
			"/api/v1/files/plugin-writers/advance",
		]) {
			const invalid = await t.fetch(route, { method: "POST", headers, body: "{}" });
			expect(invalid.status, await invalid.clone().text()).toBe(400);
			expect(invalid.headers.get("Cache-Control")).toBe("no-store");
		}
	});
});

describe("public plugin writer access", () => {
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
			body: JSON.stringify({
				force: true,
				path: "/daily-reports",
				writer: { resourceKey: "report output", rootNodeId: null },
			}),
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
});

describe("public plugin writer archive", () => {
	test("archives saved files separately in a 261-file folder and never archives a replacement at a saved path", async () => {
		const { t, fixture, owner, root, token, rootPath } = await setup({ publicWriter: true });
		expect(
			(
				await owner.mutation(api.files_nodes.read_only_set, {
					membershipId: fixture.membershipId,
					nodeId: root.folderNodeId,
					readOnly: false,
				})
			)._nay,
		).toBeUndefined();
		const files = await test_run_with_flush(t, async (ctx) => {
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
						subject: { kind: "user", userId: fixture.userId, plugin: null },
						actorUserId: fixture.userId,
						force: true,
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

		// The folder holds more files than the 256-node folder archive cap. A one-file archive must not
		// walk the folder, so archiving its first and last file is enough.
		for (const index of [0, files.length - 1]) {
			const file = files[index]!;
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
			const receipt = await t.run((ctx) =>
				ctx.db
					.query("plugins_external_file_receipts")
					.withIndex("by_writer_operationId", (q) =>
						q.eq("writerId", root.writerId).eq("operationId", `archive-${index}`),
					)
					.first(),
			);
			expect(receipt?.fingerprint).toBe(
				JSON.stringify([
					1,
					{
						kind: "archive",
						nodeId: file.nodeId,
						path: file.path,
						sequence: 1,
					},
				]),
			);
			for (const force of [undefined, false, true]) {
				const repeated = await t.fetch("/api/v1/files/plugin-archive", {
					method: "POST",
					headers,
					body: JSON.stringify({
						path: file.path,
						force,
						writer: {
							writerId: root.writerId,
							operationId: `archive-${index}`,
							writerGeneration: 1,
							sequence: 1,
							nodeId: file.nodeId,
						},
					}),
				});
				expect(repeated.status, await repeated.clone().text()).toBe(force === true ? 409 : 200);
			}
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
				force: false,
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
		).toHaveLength(2);
	});
});

describe("external file writes", () => {
	test("creates an output root once and does not adopt it for another resource", async () => {
		const { t, credentials, root } = await setup();

		expect(
			await t.mutation(internal.plugins_external_files.ensure_writer, {
				force: true,
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
					force: true,
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
			body: JSON.stringify({ force: true, ...request }),
		});
		expect(sent.status, await sent.clone().text()).toBe(200);
		const receipt = (await sent.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

		const replay = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ force: true, ...request }),
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
			body: JSON.stringify({ force: true, ...second }),
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
			body: JSON.stringify({
				force: true,
				...second,
				writer: { ...second.writer, operationId: "stale-content", sequence: 3 },
			}),
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
				contentHash: await crypto_sha256_hex("# general\n\nOriginal\n"),
			},
		};

		const first = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ force: true, ...request }),
		});
		expect(first.status, await first.clone().text()).toBe(200);
		const firstReceipt = (await first.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

		const fence = await t.fetch("/api/v1/files/plugin-writers/advance", {
			method: "POST",
			headers,
			body: JSON.stringify({ writerId: root.writerId, operationId: "fence-2", writerGeneration: 1, nextGeneration: 2 }),
		});
		expect(fence.status, await fence.clone().text()).toBe(200);
		const fenceReceipt = await t.run((ctx) =>
			ctx.db
				.query("plugins_external_file_receipts")
				.withIndex("by_writer_operationId", (q) => q.eq("writerId", root.writerId).eq("operationId", "fence-2"))
				.first(),
		);
		expect(fenceReceipt?.fingerprint).toBe(JSON.stringify([1, { kind: "fence", nextGeneration: 2 }]));
		for (const force of [undefined, false, true]) {
			const repeated = await t.fetch("/api/v1/files/plugin-writers/advance", {
				method: "POST",
				headers,
				body: JSON.stringify({
					writerId: root.writerId,
					operationId: "fence-2",
					writerGeneration: 1,
					nextGeneration: 2,
					force,
				}),
			});
			expect(repeated.status, await repeated.clone().text()).toBe(force === undefined ? 200 : 400);
		}

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
				force: true,
				...replacement,
				writer: { ...replacement.writer, operationId: "old-generation", writerGeneration: 1, sequence: 101 },
			}),
		});
		expect(old.status).toBe(409);

		const rebuilt = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ force: true, ...replacement }),
		});
		expect(rebuilt.status, await rebuilt.clone().text()).toBe(200);
		const rebuiltReceipt = (await rebuilt.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };
		expect(rebuiltReceipt.nodeId).toBe(firstReceipt.nodeId);
		expect(rebuiltReceipt.contentRevision).not.toBe(firstReceipt.contentRevision);

		const changedArchive = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({
				force: true,
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
				force: true,
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
				force: true,
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
				force: true,
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
				force: true,
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

	test("a writer fence rejects an already prepared write without publishing content", async () => {
		const { t, fixture, credentials, root } = await setup();
		const path = `${ROOT}/general.md`;
		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			force: true,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			principalRef: { kind: "plugin_service", grantId: credentials.grantId },
			path,
			expectedParentNodeId: root.folderNodeId,
			externalFileWrite: {
				force: true,
				tokenHash: credentials.tokenHash,
				serviceSecretHash: credentials.serviceSecretHash,
				writerId: root.writerId,
				writerGeneration: 1,
				operationId: "old-write",
				sequence: 1,
				contentHash: await crypto_sha256_hex("old"),
				expectedNodeId: null,
				expectedContentRevision: null,
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
							.eq("moveCohortId", undefined)
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
				contentHash: await crypto_sha256_hex("# general\n\nSaved\n"),
			},
		};

		const published = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ force: true, ...write }),
		});
		expect(published.status, await published.clone().text()).toBe(200);
		const file = (await published.json()).receipt as { nodeId: Id<"files_nodes">; contentRevision: string };

		expect(
			(
				await owner.mutation(api.files_nodes.read_only_set, {
					membershipId: fixture.membershipId,
					nodeId: root.folderNodeId,
					readOnly: false,
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
				body: JSON.stringify({
					force: true,
					...write,
					writer: { ...write.writer, operationId: "write-2", sequence: 2 },
				}),
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
			body: JSON.stringify({
				force: true,
				...archive,
				writer: { ...archive.writer, expectedContentRevision: "older-revision" },
			}),
		});
		expect(changed.status, await changed.clone().text()).toBe(409);
		expect(await changed.json()).toEqual({ message: "The file changed" });

		const response = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({ force: true, ...archive }),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		const receipt = (await response.json()).receipt;
		expect(receipt).toMatchObject({ nodeId: file.nodeId, operation: "archive", sequence: 3 });

		const replay = await t.fetch("/api/v1/files/plugin-archive", {
			method: "POST",
			headers,
			body: JSON.stringify({ force: true, ...archive }),
		});
		expect(replay.status, await replay.clone().text()).toBe(200);
		expect((await replay.json()).receipt).toEqual(receipt);

		expect(await t.run(async (ctx) => await ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test.each(["account grant", "file policy", "parent policy"] as const)(
		"%s decides an archived-file acknowledgement",
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
					force: true,
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
				body: JSON.stringify({ force: true, ...archive }),
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
						await owner.mutation(api.files_nodes.read_only_set, {
							membershipId: fixture.membershipId,
							nodeId: condition === "file policy" ? file.nodeId : root.folderNodeId,
							readOnly: true,
						})
					)._nay,
				).toBeUndefined();
			}

			const before = await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				receipts: await ctx.db.query("plugins_external_file_receipts").collect(),
			}));
			if (condition === "parent policy" || condition === "file policy") {
				const allowed = await t.fetch("/api/v1/files/plugin-archive", {
					method: "POST",
					headers,
					body: JSON.stringify({ force: true, ...archive }),
				});
				expect(allowed.status, await allowed.clone().text()).toBe(200);
				return;
			}
			for (const request of [
				archive,
				{ ...archive, writer: { ...archive.writer, operationId: "archive-3", sequence: 3 } },
			]) {
				const blocked = await t.fetch("/api/v1/files/plugin-archive", {
					method: "POST",
					headers,
					body: JSON.stringify({ force: true, ...request }),
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
			force: true,
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
					force: true,
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
					force: true,
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
						await owner.mutation(api.files_nodes.read_only_set, {
							membershipId: fixture.membershipId,
							nodeId: file.nodeId,
							readOnly: true,
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
					force: true,
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
			if (target.nodeId === folder.folderNodeId) {
				expect(blocked.status, await blocked.clone().text()).toBe(409);
				expect(await blocked.json()).toEqual({ message: target.message });
			} else expect(blocked.status, await blocked.clone().text()).toBe(200);
		}

		expect(await t.run(async (ctx) => await ctx.db.query("files_nodes").collect())).toEqual(before);
		expect(before.find((node) => node._id === folder.folderNodeId)?.archiveOperationId).toBeNull();
	});
});

describe("ensure_writer", () => {
	test("changes Read-only without changing grants on a locked writer root", async () => {
		const { t, credentials, root } = await setup({ publicWriter: true });
		const grantsBefore = await t.run((ctx) => ctx.db.query("access_control_permission_grants").collect());
		const request = {
			...credentials,
			writerId: root.writerId,
			operationId: "unlock-root",
			writerGeneration: 1,
			change: { kind: "read_only" as const, readOnly: false },
		};
		const changed = await t.mutation(internal.plugins_external_files.change_scope, request);
		expect(changed._nay).toBeUndefined();
		expect(await t.mutation(internal.plugins_external_files.change_scope, request)).toEqual(changed);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", root.folderNodeId))).toMatchObject({
			readOnly: false,
			readOnlyDecisionId: null,
		});
		expect(await t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual(grantsBefore);
	});

	test("recovers a lost setup response without new rows", async () => {
		const { t, token, root } = await setup();
		const request = {
			path: `${ROOT}/private/team`,
			force: true,
			access: { readOnly: true },
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

		const saved = await t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			writers: await ctx.db.query("plugins_external_file_writers").collect(),
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
			},
		});

		expect(
			await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				writers: await ctx.db.query("plugins_external_file_writers").collect(),
				grants: await ctx.db.query("access_control_permission_grants").collect(),
			})),
		).toEqual(saved);
	});

	test.each(["moved", "replaced"])("refuses recovery after the folder becomes %s", async (change) => {
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
				access: { readOnly: false },
				force: true,
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
				await owner.mutation(api.files_nodes.read_only_set, {
					membershipId: fixture.membershipId,
					nodeId: root.rootNodeId,
					readOnly: false,
				})
			)._nay,
		).toBeUndefined();
		// Finish the background jobs of the steps above first. A search index run holds the workspace's
		// Move slot, so a rename that starts while it runs waits, and the rename helper stops with
		// "Transfer made no progress". On a slow machine the index run is often still running here.
		vi.useFakeTimers();
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();

		expect(
			(
				await test_rename_node(t, owner, {
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

		const before = await t.run(async (ctx) => await ctx.db.query("files_nodes").collect());
		const repeated = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(repeated.status, await repeated.clone().text()).toBe(change === "moved" ? 409 : 403);

		expect(await t.run(async (ctx) => await ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test("refuses setup recovery when the sponsor is deleted", async () => {
		const { t, token, fixture, root } = await setup();
		const options = {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				path: `${ROOT}/team`,
				access: { readOnly: true },
				force: true,
				writer: { resourceKey: "private", rootNodeId: root.rootNodeId },
			}),
		};

		const sent = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(sent.status, await sent.clone().text()).toBe(200);

		await t.mutation(internal.data_deletion.init_user_deletion, { userId: fixture.userId, nowTs: Date.now() });

		const repeated = await t.fetch("/api/v1/files/plugin-folders/ensure", options);
		expect(repeated.status, await repeated.clone().text()).toBe(401);
	});

	/**
	 * Make `${ROOT}/private` a restricted folder and give the plugin's account Can edit on it. The
	 * account's workspace grant from `setup` does not reach inside a restricted folder.
	 *
	 * The folder carries the plugin's name, like a folder the plugin made. The plugin writes only
	 * below folders with its name.
	 */
	async function seed_private_area(f: Awaited<ReturnType<typeof setup>>) {
		const { t, fixture, owner, root } = f;
		const privateId = await test_run_with_flush(t, async (ctx) => {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId: fixture.userId,
				parentId: root.folderNodeId,
				path: "private",
				kind: "folder",
				createdNodesMetadata: [
					{ key: "source", value: "plugin" },
					{ key: "plugin-name", value: "chitchat" },
				],
				now: Date.now(),
				// The writer root is read-only, so the owner sets the folder up with force.
				writeContext: {
					subject: { kind: "user", userId: fixture.userId, plugin: null },
					actorUserId: fixture.userId,
					resourceScope: { kind: "workspace" },
					force: true,
				},
			});
			if (created._nay) throw new Error(created._nay.message);
			await files_nodes_db_set_restricted_scope({
				ctx,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				nodeId: created._yay,
				restrictedScopeNodeId: created._yay,
			});
			return created._yay;
		});
		expect(
			(
				await owner.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: privateId },
					level: "write",
				})
			)._nay,
		).toBeUndefined();
		return privateId;
	}

	test("a plugin and a key of its account open a folder the account has a grant on, also one ensure made", async () => {
		const f = await setup();
		const { t, fixture, credentials, token, root } = f;
		install_object_uploads();
		await seed_private_area(f);

		const ensured = await t.mutation(internal.plugins_external_files.ensure_writer, {
			force: true,
			...credentials,
			path: `${ROOT}/private/team`,
			readOnly: false,
			resourceKey: "private",
			rootNodeId: root.rootNodeId,
		});
		expect(ensured._nay, "the plugin may create a folder where its account has a grant").toBeUndefined();
		const writer = ensured._yay!;

		const content = "# team\n";
		const sent = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				force: true,
				path: `${ROOT}/private/team/team.md`,
				expectedParentNodeId: writer.folderNodeId,
				content,
				nonCollaborative: true,
				writer: {
					writerId: writer.writerId,
					operationId: "first",
					writerGeneration: 1,
					sequence: 1,
					expectedNodeId: null,
					expectedContentRevision: null,
					contentHash: await crypto_sha256_hex(content),
				},
			}),
		});
		expect(sent.status, await sent.clone().text()).toBe(200);
		const fileNodeId = ((await sent.json()).receipt as { nodeId: Id<"files_nodes"> }).nodeId;

		const can = (subject: access_control_Subject, nodeId: Id<"files_nodes">) =>
			t.run(async (ctx) =>
				access_control_db_can_act_on_file_node(ctx, {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					subject,
					fileNode: await ctx.db.get("files_nodes", nodeId),
					permission: "content.read",
				}),
			);
		const installation = (await t.run((ctx) => ctx.db.get("plugins_workspace_installations", fixture.installationId)))!;
		expect(await can(plugins_file_subject(installation, fixture.userId), writer.folderNodeId)).toBe(true);
		expect(await can({ kind: "service_account", serviceAccountId: fixture.serviceAccountId }, fileNodeId)).toBe(true);
	});

	test("a folder ensure makes gets its parent's access", async () => {
		const f = await setup();
		const { t, credentials, root } = f;
		const privateId = await seed_private_area(f);
		const grantsBefore = await t.run((ctx) => ctx.db.query("access_control_permission_grants").collect());

		const ensure = (path: string, resourceKey: string) =>
			t.mutation(internal.plugins_external_files.ensure_writer, {
				force: true,
				...credentials,
				path,
				readOnly: false,
				resourceKey,
				rootNodeId: root.rootNodeId,
			});
		const node = (nodeId: Id<"files_nodes">) => t.run((ctx) => ctx.db.get("files_nodes", nodeId));

		const inRestricted = await ensure(`${ROOT}/private/team`, "private");
		if (inRestricted._nay) throw new Error(inRestricted._nay.message);
		expect(await node(inRestricted._yay.folderNodeId), "the new folder is inside the restricted folder").toMatchObject({
			restrictedScopeNodeId: privateId,
			isRestrictedScopeRoot: false,
		});

		const inOpen = await ensure(`${ROOT}/open-team`, "open");
		if (inOpen._nay) throw new Error(inOpen._nay.message);
		expect(await node(inOpen._yay.folderNodeId)).toMatchObject({ restrictedScopeNodeId: null });
		expect(await t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual(grantsBefore);
	});
});

describe("workspace content purge", () => {
	test("drains external file writer and grant receipt docs", async () => {
		const { t, fixture, credentials, root } = await setup();
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
			"plugins_external_file_writers",
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
});
