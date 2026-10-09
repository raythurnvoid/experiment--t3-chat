import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_get_utf8_byte_size, files_ROOT_ID } from "../server/files.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import type { api_schemas_Main } from "../shared/api-schemas.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { files_nodes_db_insert_file_content_docs } from "./files_nodes_content.ts";
import { public_api_http_read_file } from "./public_api.ts";
import { public_api_files_list_http_routes } from "./public_api_files_list_http.ts";
import { getFunctionName } from "convex/server";
import * as server from "./_generated/server.js";
import { r2_create_asset_key } from "./r2_client.ts";
import { plugins_data_http_write } from "./plugins_data_http.ts";

const objects = new Map<string, string>();
let onPut: ((key: string) => Promise<void>) | null = null;
let maxPuts = 0;
let activePuts = 0;
let billingCalls: Array<readonly unknown[]> = [];

beforeEach(() => {
	vi.useFakeTimers();
	objects.clear();
	onPut = null;
	maxPuts = 0;
	activePuts = 0;
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "test") => ({
		key,
		url: `https://r2.test/put?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	billingCalls = vi.spyOn(Workpool.prototype, "enqueueAction").mock.calls;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (url.origin !== "https://r2.test" || init?.method !== "PUT") return new Response(null, { status: 404 });
			const key = url.searchParams.get("key");
			if (!key || typeof init.body !== "string") throw new Error("Expected a text PUT");
			activePuts += 1;
			maxPuts = Math.max(maxPuts, activePuts);
			try {
				await onPut?.(key);
				objects.set(key, init.body);
				return new Response(null, { status: 200 });
			} finally {
				activePuts -= 1;
			}
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(
	options: {
		transactionLimits?: boolean;
		name?: string;
		t?: ReturnType<typeof test_convex>;
		scheduled?: boolean;
		scheduledScopes?: NonNullable<Doc<"access_control_permission_grants">["runAs"]>["scopes"];
	} = {},
) {
	const t = options.t ?? test_convex({ transactionLimits: options.transactionLimits });
	const name = options.name ?? "volume-writer";
	const owner = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: `${name}-owner` });
		return await test_mocks_fill_db_with.membership(ctx, { userId, organizationName: `${name}-team` });
	});
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const capabilities = options.scheduled
		? ([
				"workspace.volumes.write",
				"plugin.backend.invoke",
				"plugin.schedule.run",
				"workspace.files.read",
				"plugin.data.read",
				"plugin.data.write",
				"plugin.secrets.read",
				"outbound.fetch",
			] as const)
		: (["workspace.volumes.write", "plugin.backend.invoke"] as const);
	const pluginVersionId = await t.run((ctx) =>
		ctx.db.insert("plugins_versions", {
			name,
			displayName: "Volume writer",
			version: "0.1.0",
			description: "External records",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: `https://github.com/example/${name}`,
			sourceOwner: "example",
			sourceRepo: name,
			sourceCommitSha: "a".repeat(40),
			manifestR2Key: `${name}/manifest.json`,
			backendEntrypointFile: {
				entry: "backend.js",
				moduleName: "backend",
				r2Key: `${name}/backend.js`,
				sha256: "a".repeat(64),
				compatibilityDate: "2026-01-01",
				compatibilityFlags: [],
			},
			configuration: {
				description: "Mount name",
				defaultYaml: `mount:\n  name: ${name}\nschedule:\n  minutes: 1440\n`,
			},
			mounts: [{ id: "sources", description: "External records", configurationPath: ["mount", "name"] }],
			events: options.scheduled
				? [
						{
							type: "schedule.interval.elapsed",
							contentTypes: [],
							filters: [],
							schedule: { configurationPath: ["schedule", "minutes"] },
						},
					]
				: [],
			capabilities: [...capabilities],
			endpoints: [{ id: "refresh", path: "/refresh", serialization: "installation" }],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "volume-mcp",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: owner.userId,
			updatedAt: Date.now(),
			secrets: [],
			userWritableCollections: null,
		}),
	);
	const installed = await asOwner.mutation(api.plugins.install_version, {
		membershipId: owner.membershipId,
		pluginVersionId,
		acceptedCapabilities: [...capabilities],
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		acceptedMcpServersFingerprint: "volume-mcp",
		acceptedSkillNames: [],
		...(options.scheduled
			? {
					scheduledRun: {
						kind: "me" as const,
						scopes: options.scheduledScopes ?? [
							"files:list" as const,
							"files:read" as const,
							"plugin_data:read" as const,
							"plugin_data:write" as const,
							"volumes:write" as const,
							"secrets:read" as const,
							"outbound:fetch" as const,
						],
						filesReadProof: { kind: "workspace" as const },
					},
				}
			: {}),
	});
	if (installed._nay) throw new Error(installed._nay.message);
	const installationId = installed._yay.installationId;
	const installation = await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId));
	if (!installation) throw new Error("Expected installation");
	const token = `plr_${await crypto_sha256_hex(installationId)}`;
	const tokenHash = await crypto_sha256_hex(token);
	const runId = options.scheduled
		? await start_scheduled_run({ t, asOwner, owner, installationId, tokenHash })
		: await (async () => {
				const started = await t.mutation(internal.plugins_runtime.start_invoke_run, {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					serviceAccountId: installation.serviceAccountId,
					installationId,
					pluginVersionId,
					userId: owner.userId,
					endpointId: "refresh",
					callerSerializationKey: null,
					apiTokenHash: tokenHash,
				});
				if (started._nay) throw new Error(started._nay.message);
				return started._yay.pluginRun._id;
			})();
	return {
		t,
		owner,
		asOwner,
		installationId,
		installation,
		pluginVersionId,
		name,
		token,
		tokenHash,
		runId,
	};
}

async function start_scheduled_run(args: {
	t: ReturnType<typeof test_convex>;
	asOwner: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
	owner: {
		membershipId: Id<"organizations_workspaces_users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
	};
	installationId: Id<"plugins_workspace_installations">;
	tokenHash: string;
}) {
	const requested = await args.asOwner.mutation(api.plugins.run_schedule_now, {
		membershipId: args.owner.membershipId,
		installationId: args.installationId,
	});
	if (requested._nay) throw new Error(requested._nay.message);
	await args.t.mutation(internal.plugins_runtime.dispatch_due_schedules, {});
	const run = await args.t.run(async (ctx) => {
		const runs = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", args.owner.organizationId).eq("workspaceId", args.owner.workspaceId),
			)
			.order("desc")
			.collect();
		return runs.find(
			(item) => item.installationId === args.installationId && item.event === "schedule.interval.elapsed",
		);
	});
	if (!run) throw new Error("Expected the real dispatcher to enqueue a run");
	const started = await args.t.mutation(internal.plugins_runtime.start_event_run, {
		runId: run._id,
		apiTokenHash: args.tokenHash,
	});
	if (started._nay) throw new Error(started._nay.message);
	return run._id;
}

async function invited_member(f: Awaited<ReturnType<typeof fixture>>) {
	const member = await f.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "scheduled-member" });
		return await test_mocks_fill_db_with.membership(ctx, {
			userId,
			organizationName: "personal",
			workspaceName: "home",
			plan: "Free",
		});
	});
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
	if (!membership) throw new Error("Expected invited membership");
	return {
		...member,
		membershipId: membership._id,
		asMember: f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }),
	};
}

async function assign_scheduled_user(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	member: Awaited<ReturnType<typeof invited_member>>;
	scopes: NonNullable<Doc<"access_control_permission_grants">["runAs"]>["scopes"];
	filesReadProof?: { kind: "file"; nodeId: Id<"files_nodes"> };
}) {
	const { f, member, filesReadProof, scopes } = args;

	const granted = await member.asMember.mutation(api.plugins_access.grant_run_as_me, {
		membershipId: member.membershipId,
		installationId: f.installationId,
		scopes,
		...(filesReadProof ? { filesReadProof } : {}),
	});
	if (granted._nay) throw new Error(granted._nay.message);
	await reset_manage_limit(f);
	expect(
		await f.asOwner.mutation(api.plugins_access.set_scheduled_run_user, {
			membershipId: f.owner.membershipId,
			installationId: f.installationId,
			userId: member.userId,
			grantId: granted._yay.grantId,
		}),
	).toEqual({ _yay: null });
	const installation = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.installationId));
	if (!installation) throw new Error("Expected assigned installation");
	f.installation = installation;
	f.runId = await start_scheduled_run(f);
}

async function post(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	route: "list" | "stage" | "write-many" | "publish" | "delete";
	body: unknown;
}) {
	const { f, route, body } = args;

	return await f.t.fetch(`/api/v1/volumes/${route}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readable_file(f: Awaited<ReturnType<typeof fixture>>, path = "/note.txt") {
	const saved = await f.t.run(async (ctx) => {
		const scope = { organizationId: f.owner.organizationId, workspaceId: f.owner.workspaceId };
		const assetId = await ctx.db.insert("files_r2_assets", {
			...scope,
			kind: "content",
			r2Bucket: "test",
			size: 4,
			createdBy: f.owner.userId,
			updatedAt: Date.now(),
		});
		await ctx.db.patch("files_r2_assets", assetId, { r2Key: r2_create_asset_key({ ...scope, assetId }) });
		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			...scope,
			userId: f.owner.userId,
			parentId: files_ROOT_ID,
			path,
			kind: "file",
			contentType: "text/plain",
			assetId,
			expectsTextContent: true,
			now: Date.now(),
		});
		if (created._nay) throw new Error(created._nay.message);
		await ctx.db.patch("files_nodes", created._yay, { textKind: "plain_text", collaborationEnabled: false });
		await files_nodes_db_insert_file_content_docs(ctx, {
			...scope,
			nodeId: created._yay,
			path,
			contentType: "text/plain",
			rootKind: "plain_text",
			textContent: "read",
			readOnly: false,
			nonCollaborative: true,
			userId: f.owner.userId,
			now: Date.now(),
		});
		return { nodeId: created._yay, assetId, path };
	});
	const allowed = await f.asOwner.mutation(api.access_control.set_service_account_grant, {
		membershipId: f.owner.membershipId,
		serviceAccountId: f.installation.serviceAccountId,
		resource: { kind: "file", nodeId: saved.nodeId },
		level: "read",
	});
	if (allowed._nay) throw new Error(allowed._nay.message);
	return saved;
}

function api_request(args: { f: Awaited<ReturnType<typeof fixture>>; path: string; body: unknown }) {
	const { f, path, body } = args;

	return new Request(`https://api.test${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function is_api_function(reference: Parameters<typeof getFunctionName>[0], name: string) {
	try {
		return getFunctionName(reference) === name;
	} catch {
		// Component calls have no app function name.
		return false;
	}
}

async function read_after_io(f: Awaited<ReturnType<typeof fixture>>, afterIo: () => Promise<void>) {
	return await f.t.action(async (ctx) =>
		public_api_http_read_file({
			ctx: {
				...ctx,
				runAction: async (...args) => {
					const result = await ctx.runAction(...args);
					if (is_api_function(args[0], "files_nodes_content:get_file_last_available_text_content_by_path"))
						await afterIo();
					return result;
				},
			},
			request: api_request({ f, path: "/api/v1/files/read", body: { path: "/note.txt" } }),
			path: "/api/v1/files/read",
		}),
	);
}

async function list_after_io(f: Awaited<ReturnType<typeof fixture>>, afterIo: () => Promise<void>) {
	const captured: { handler?: Parameters<typeof server.httpAction>[0] } = {};
	const original = server.httpAction;
	const registered = vi.spyOn(server, "httpAction").mockImplementation((handler) => {
		captured.handler = handler;
		return original(handler);
	});
	public_api_files_list_http_routes({ route: () => {} });
	registered.mockRestore();
	const handler = captured.handler;
	if (!handler) throw new Error("Expected the real list HTTP handler");
	return await f.t.action(async (ctx) => {
		const response = await handler(
			{
				...ctx,
				runQuery: async (...args) => {
					const result = await ctx.runQuery(...args);
					if (is_api_function(args[0], "r2:get_assets_ready_states")) await afterIo();
					return result;
				},
			},
			api_request({ f, path: "/api/v1/files/list", body: {} }),
		);
		return { status: response.status, body: await response.text() };
	});
}
async function stage(args: { f: Awaited<ReturnType<typeof fixture>>; volumeKey?: string; revision?: string }) {
	const { f, volumeKey = "records", revision = "revision-1" } = args;

	const response = await post({ f, route: "stage", body: { mountId: "sources", volumeKey, revision } });
	expect(response.status).toBe(200);
	return z.object({ stagingId: z.string(), abandonedStagingId: z.string().nullable() }).parse(await response.json());
}
async function write(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	stagingId: string;
	files: Array<{ path: string; content: string }>;
}) {
	const { f, files, stagingId } = args;

	const response = await post({ f, route: "write-many", body: { stagingId, files } });
	return { response, body: (await response.json()) as unknown };
}
async function volume_nodes(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run(async (ctx) => {
		const volume = await ctx.db
			.query("plugins_volumes")
			.withIndex("by_installation_mountId_volumeKey", (q) => q.eq("installationId", f.installationId))
			.unique();
		if (!volume) return [];
		return await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation", (q) =>
				q.eq("organizationId", f.owner.organizationId).eq("workspaceId", volume._id).eq("moveCohortId", undefined).eq("archiveOperationId", null),
			)
			.collect();
	});
}
function events() {
	return billingCalls.flatMap((call) => {
		const parsed = z
			.object({
				events: z.array(
					z.object({
						name: z.string(),
						externalId: z.string(),
						externalCustomerId: z.string(),
						externalMemberId: z.string(),
						metadata: z.object({ amount: z.number() }),
					}),
				),
			})
			.safeParse(call[2]);
		return parsed.success ? parsed.data.events.filter((event) => event.name === "plugin_volume_file_write") : [];
	});
}
async function calls(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run((ctx) =>
		ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", f.runId))
			.collect(),
	);
}
async function unused_assets(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run(async (ctx) =>
		(await ctx.db.query("files_r2_assets").collect()).filter(
			(asset) => asset.createdBy === users_SYSTEM_AUTHOR && asset.unfinalizedExpiresAt !== undefined,
		),
	);
}
async function reset_manage_limit(f: Awaited<ReturnType<typeof fixture>>) {
	await f.t.run((ctx) =>
		ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.owner.userId }),
	);
}

async function restart_run(f: Awaited<ReturnType<typeof fixture>>, userId: Id<"users"> = f.owner.userId) {
	await f.t.mutation(internal.plugins_runtime.finish_event_run, {
		runId: f.runId,
		outcome: { kind: "failed", errorMessage: "Fixture starts another run" },
	});
	const installation = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.installationId));
	if (!installation) throw new Error("Expected installation");
	const started = await f.t.mutation(internal.plugins_runtime.start_invoke_run, {
		organizationId: f.owner.organizationId,
		workspaceId: f.owner.workspaceId,
		serviceAccountId: installation.serviceAccountId,
		installationId: installation._id,
		pluginVersionId: f.pluginVersionId,
		userId,
		endpointId: "refresh",
		callerSerializationKey: null,
		apiTokenHash: f.tokenHash,
	});
	if (started._nay) throw new Error(started._nay.message);
	f.runId = started._yay.pluginRun._id;
	f.installation = installation;
}

describe("volumes stage, write, and publish", () => {
	test("keeps exact SDK response types at the public routes", () => {
		type WriteResponse = api_schemas_Main["/api/v1/volumes/write-many"]["POST"]["response"];
		type StageResponse = api_schemas_Main["/api/v1/volumes/stage"]["POST"]["response"];
		type ListResponse = api_schemas_Main["/api/v1/volumes/list"]["POST"]["response"];
		type PublishResponse = api_schemas_Main["/api/v1/volumes/publish"]["POST"]["response"];
		type DeleteResponse = api_schemas_Main["/api/v1/volumes/delete"]["POST"]["response"];
		expectTypeOf<WriteResponse[200]["body"]>().toMatchTypeOf<{
			written: Array<{ path: string; bytes: number }>;
			errors: Array<{ path: string; errorCode: string; message: string }>;
		}>();
		expectTypeOf<StageResponse[200]["body"]>().toMatchTypeOf<{
			stagingId: Id<"plugins_volume_generations">;
			abandonedStagingId: Id<"plugins_volume_generations"> | null;
		}>();
		expectTypeOf<ListResponse[200]["body"]>().toMatchTypeOf<{
			mounts: Array<{ mountId: string; name: string; volumes: Array<{ volumeKey: string; deleting: boolean }> }>;
			usage: { fileCount: number; bytes: number; dailyFilesLeft: number };
		}>();
		expectTypeOf<PublishResponse[200]["body"]>().toMatchTypeOf<{
			volumeKey: string;
			revision: string;
			fileCount: number;
			bytes: number;
			publishedAt: number;
		}>();
		expectTypeOf<DeleteResponse[200]["body"]>().toMatchTypeOf<{ deleted: true }>();
	});

	test("stores read-only files and publishes through the public routes", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		const content = "---\ntitle: exact text\n---\nUnicode: café 🐒\nNo final newline";
		const result = await write({
			f,
			stagingId: staged.stagingId,
			files: [
				{ path: "/README.md", content },
				{ path: "/empty.txt", content: "" },
			],
		});
		expect(result.response.status).toBe(200);
		expect(result.response.headers.get("Cache-Control")).toBe("no-store");
		expect(result.body).toEqual({
			written: [
				{ path: "/README.md", bytes: files_get_utf8_byte_size(content) },
				{ path: "/empty.txt", bytes: 0 },
			],
			errors: [],
		});
		const nodes = (await volume_nodes(f)).filter((node) => node.kind === "file");
		expect(nodes).toHaveLength(2);
		for (const node of nodes)
			expect(node).toMatchObject({
				createdBy: users_SYSTEM_AUTHOR,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
			});
		const note = nodes.find((node) => node.name === "README.md")!;
		const saved = await f.t.run(async (ctx) => ({
			text: (
				await ctx.db
					.query("files_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", f.owner.organizationId)
							.eq("workspaceId", note.workspaceId)
							.eq("fileNodeId", note._id),
					)
					.collect()
			)
				.map((row) => row.textChunk)
				.join(""),
			metadata: await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", f.owner.organizationId).eq("workspaceId", note.workspaceId).eq("fileNodeId", note._id),
				)
				.collect(),
		}));
		expect(saved.text).toBe(content);
		expect(saved.metadata.some((row) => row.fieldPath.startsWith("frontmatter."))).toBe(false);
		expect(saved.metadata).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ fieldPath: "metadata.source", stringValue: "plugin-volume" }),
				expect.objectContaining({ fieldPath: "metadata.volume-path", stringValue: "README.md" }),
			]),
		);
		expect(await unused_assets(f)).toEqual([]);
		const published = await post({ f, route: "publish", body: { stagingId: staged.stagingId } });
		expect(published.status).toBe(200);
		expect(await published.json()).toMatchObject({
			volumeKey: "records",
			revision: "revision-1",
			fileCount: 2,
			bytes: files_get_utf8_byte_size(content),
		});
		const listed = await post({ f, route: "list", body: {} });
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({
			mounts: [
				{
					mountId: "sources",
					name: f.name,
					volumes: [{ volumeKey: "records", deleting: false, staging: null, published: { fileCount: 2 } }],
				},
			],
			usage: { fileCount: 2, dailyFilesLeft: 9_998 },
		});
		expect((await calls(f)).map((call) => call.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
	});

	test("an unrelated structured-data plugin uses the same doors", async () => {
		const f = await fixture({ name: "record-export" });
		const staged = await stage({ f, volumeKey: "export" });
		const content = JSON.stringify({ id: 1, value: "hello" });
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/records/item-1.json", content }] })).body,
		).toEqual({
			written: [{ path: "/records/item-1.json", bytes: content.length }],
			errors: [],
		});
		expect((await post({ f, route: "publish", body: { stagingId: staged.stagingId } })).status).toBe(200);
	});

	test("emits N events for N new files and charges no replacement", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		const files = [
			{ path: "/one.txt", content: "one" },
			{ path: "/two.txt", content: "two" },
		];
		expect((await write({ f, stagingId: staged.stagingId, files })).response.status).toBe(200);
		expect(events(), "N events for N files").toHaveLength(2);
		expect(events().map((event) => event.metadata.amount)).toEqual([0.5, 0.5]);
		expect(new Set(events().map((event) => event.externalId)).size).toBe(2);
		const prior = (await volume_nodes(f)).filter((node) => node.kind === "file");
		expect((await write({ f, stagingId: staged.stagingId, files })).response.status).toBe(200);
		expect(events(), "retry must not charge a replacement").toHaveLength(2);
		const next = (await volume_nodes(f)).filter((node) => node.kind === "file");
		expect(next).toHaveLength(2);
		for (const node of prior) expect(await f.t.run((ctx) => ctx.db.get("files_nodes", node._id))).toBeNull();
		const listed = await post({ f, route: "list", body: {} });
		expect(await listed.json()).toMatchObject({ usage: { fileCount: 2, dailyFilesLeft: 9_998 } });
	});

	test("preinserts canonical R2 keys before an upload event arrives", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		let seen = false;
		onPut = async (key) => {
			const asset = await f.t.run(async (ctx) =>
				(await ctx.db.query("files_r2_assets").collect()).find((item) => item.r2Key === key),
			);
			expect(asset).toMatchObject({ kind: "content", createdBy: users_SYSTEM_AUTHOR, r2Key: key, size: 5 });
			expect(asset?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());
			seen = true;
		};
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/one", content: "hello" }] })).response.status,
		).toBe(200);
		expect(seen).toBe(true);
	});

	test("caps concurrent PUTs at sixteen", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		const files = Array.from({ length: 40 }, (_, i) => ({ path: `/file-${i}`, content: "text" }));
		expect((await write({ f, stagingId: staged.stagingId, files })).response.status).toBe(200);
		expect(maxPuts).toBe(16);
	});

	test("a failed PUT cleans its asset and preserves successful items", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		let count = 0;
		onPut = async () => {
			if (count++ === 0) throw new Error("Provider detail must stay private");
		};
		const result = await write({
			f,
			stagingId: staged.stagingId,
			files: [
				{ path: "/failed", content: "failed" },
				{ path: "/saved", content: "saved" },
			],
		});
		expect(result.response.status).toBe(200);
		expect(result.body).toEqual({
			written: [{ path: "/saved", bytes: 5 }],
			errors: [{ path: "/failed", errorCode: "storage_failure", message: "Failed to store volume file" }],
		});
		expect(await unused_assets(f)).toEqual([]);
		expect(events()).toHaveLength(1);
		expect((await calls(f)).at(-1)?.status).toBe("succeeded");
	});

	test("abandon and publish release the old copy only once", async () => {
		const f = await fixture();
		const first = await stage({ f });
		await write({ f, stagingId: first.stagingId, files: [{ path: "/one", content: "old" }] });
		const second = await stage({ f, volumeKey: "records", revision: "revision-2" });
		expect(second.abandonedStagingId).toBe(first.stagingId);
		expect((await post({ f, route: "publish", body: { stagingId: first.stagingId } })).status).toBe(409);
		await write({ f, stagingId: second.stagingId, files: [{ path: "/one", content: "second" }] });
		expect((await post({ f, route: "publish", body: { stagingId: second.stagingId } })).status).toBe(200);
		const third = await stage({ f, volumeKey: "records", revision: "revision-3" });
		await write({ f, stagingId: third.stagingId, files: [{ path: "/one", content: "new" }] });
		expect((await post({ f, route: "publish", body: { stagingId: third.stagingId } })).status).toBe(200);
		expect(await (await post({ f, route: "list", body: {} })).json()).toMatchObject({
			usage: { fileCount: 1, bytes: 3 },
		});
	});
});

describe("volumes write-many validation", () => {
	test.each(["../bad", "tmp"])("delete refuses invalid volume key %s", async (volumeKey) => {
		const f = await fixture();
		const response = await post({ f, route: "delete", body: { mountId: "sources", volumeKey } });
		expect(response.status, "invalid delete keys must return 400").toBe(400);
		expect(await response.json()).toMatchObject({ errorCode: "invalid_input" });
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volumes").collect())).toEqual([]);
	});

	test("delete keeps 404 for a valid missing volume key", async () => {
		const f = await fixture();
		expect((await post({ f, route: "delete", body: { mountId: "sources", volumeKey: "missing" } })).status).toBe(404);
	});
	test("refuses traversal and invalid items while preserving exact valid names", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		const invalid = [
			"/../escape",
			"/a/./b",
			"/a//b",
			"/a\\b",
			"/control\u0000",
			"/",
			"relative",
			`/${"x".repeat(256)}`,
			`/${Array(33).fill("x").join("/")}`,
		];
		const result = await write({
			f,
			stagingId: staged.stagingId,
			files: [
				...invalid.map((path) => ({ path, content: "bad" })),
				{ path: "/bad-unicode", content: "\ud800" },
				{ path: "/too-large", content: "x".repeat(900_001) },
				{ path: "/MiXeD/AGENTS.md", content: "kept" },
			],
		});
		expect(result.response.status).toBe(200);
		const body = z
			.object({
				written: z.array(z.object({ path: z.string(), bytes: z.number() })),
				errors: z.array(z.object({ path: z.string(), errorCode: z.string() })),
			})
			.parse(result.body);
		expect(body.errors.find((item) => item.path === "/../escape")?.errorCode, "traversal must be refused").toBe(
			"invalid_path",
		);
		expect(body.errors.filter((item) => item.errorCode === "invalid_path")).toHaveLength(invalid.length);
		expect(body.errors.filter((item) => item.errorCode === "invalid_content")).toHaveLength(2);
		expect(body.written).toEqual([{ path: "/MiXeD/AGENTS.md", bytes: 4 }]);
		expect((await volume_nodes(f)).some((node) => node.path.endsWith("/MiXeD/AGENTS.md"))).toBe(true);
	});

	test.each(
		[
			[
				{ path: "/one", content: "a" },
				{ path: "/one", content: "b" },
			],
			[
				{ path: "/a", content: "a" },
				{ path: "/a-foo", content: "b" },
				{ path: "/a/b", content: "c" },
			],
			Array.from({ length: 101 }, (_, i) => ({ path: `/file-${i}`, content: "a" })),
		].map((files) => ({ files })),
	)("refuses bad whole-request paths or count before upload %#", async ({ files }) => {
		const f = await fixture();
		const staged = await stage({ f });
		expect((await write({ f, stagingId: staged.stagingId, files })).response.status).toBe(400);
		expect(objects.size).toBe(0);
		expect(await volume_nodes(f)).toEqual([]);
		expect((await calls(f)).at(-1)).toMatchObject({ status: "failed", responseStatus: 400 });
	});

	test.each([
		{ mountId: "missing", volumeKey: "ok", revision: "revision" },
		{ mountId: "sources", volumeKey: "../bad", revision: "revision" },
		{ mountId: "sources", volumeKey: "tmp", revision: "revision" },
		{ mountId: "sources", volumeKey: "ok", revision: "" },
		{ mountId: "sources", volumeKey: "ok", revision: "bad\nrevision" },
		{ mountId: "sources", volumeKey: "ok", revision: "x".repeat(201) },
	])("refuses bad stage input %#", async (body) => {
		const f = await fixture();
		expect((await post({ f, route: "stage", body })).status).toBe(400);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volumes").collect())).toEqual([]);
		expect((await calls(f)).at(-1)?.status).toBe("failed");
	});

	test("bounds request bytes and settles a failed body", async () => {
		const f = await fixture();
		const response = await f.t.fetch("/api/v1/volumes/write-many", {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
			body: "x".repeat(8_000_001),
		});
		expect(response.status).toBe(400);
		expect((await calls(f)).at(-1)).toMatchObject({ status: "failed", responseStatus: 400 });
	});

	test("settles malformed JSON and a failed request stream", async () => {
		const f = await fixture();
		for (const body of [
			"bad-json",
			new ReadableStream({
				start(controller) {
					controller.error(new Error("Interrupted request"));
				},
			}),
		]) {
			const init = {
				method: "POST",
				headers: { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" },
				body,
				duplex: "half",
			};
			const response = await f.t.fetch("/api/v1/volumes/list", init);
			expect(response.status).toBe(400);
			expect((await calls(f)).at(-1)).toMatchObject({ status: "failed", responseStatus: 400 });
		}
	});

	test("refuses a folder target and a file parent without partial folders", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		await write({
			f,
			stagingId: staged.stagingId,
			files: [
				{ path: "/folder/file", content: "ok" },
				{ path: "/leaf", content: "ok" },
			],
		});
		const result = await write({
			f,
			stagingId: staged.stagingId,
			files: [
				{ path: "/folder", content: "bad" },
				{ path: "/leaf/new/file", content: "bad" },
			],
		});
		expect(result.body).toMatchObject({
			written: [],
			errors: [{ errorCode: "path_conflict" }, { errorCode: "path_conflict" }],
		});
		expect((await volume_nodes(f)).some((node) => node.path.endsWith("/leaf/new"))).toBe(false);
	});

	test("another installation staging id and malformed ids are 404", async () => {
		const f = await fixture();
		const other = await fixture({ name: "other-plugin", t: f.t });
		const own = await stage({ f });
		const otherStage = await stage({ f: other });
		for (const id of ["bad-id", otherStage.stagingId])
			expect((await write({ f, stagingId: id, files: [{ path: "/bad", content: "bad" }] })).response.status).toBe(404);
		expect(
			(await write({ f, stagingId: own.stagingId, files: [{ path: "/ok", content: "ok" }] })).response.status,
		).toBe(200);
	});
});

describe("scheduled public API authority", () => {
	test("scopes intersect consent and capabilities without baseline writes or downloads", async () => {
		const f = await fixture({ scheduled: true, scheduledScopes: ["files:read", "plugin_data:read"] });
		const resolved = await f.t.query(internal.public_api.resolve_principal, { presented: f.token });
		expect(resolved._yay?.scopes).toEqual(["plugin_data:read", "files:read", "runs:follow_up"]);
		const file = await readable_file(f);
		for (const [path, body] of [
			["/api/v1/volumes/list", {}],
			["/api/v1/files/write", { path: "/new.md", content: "denied" }],
			["/api/v1/files/download-urls", { fileNodeIds: [file.nodeId] }],
			["/api/v1/activities/start", {}],
		] as const) {
			const response = await f.t.fetch(path, {
				method: "POST",
				headers: { Authorization: `Bearer ${f.token}` },
				body: JSON.stringify(body),
			});
			expect(response.status, `${path} must not get a baseline scope`).toBe(403);
		}
	});

	test.each(["grant", "assignment", "lifetime", "account", "owner"] as const)(
		"token resolution refuses a changed %s",
		async (change) => {
			const f = await fixture({ scheduled: true });
			await f.t.run(async (ctx) => {
				if (change === "grant")
					await ctx.db.delete("access_control_permission_grants", f.installation.scheduledRunGrantId!);
				if (change === "assignment")
					await ctx.db.patch("plugins_workspace_installations", f.installationId, { scheduledRunGrantId: undefined });
				if (change === "lifetime") {
					const lifetime = await ctx.db
						.query("organizations_membership_lifetimes")
						.withIndex("by_workspace_user", (q) =>
							q.eq("workspaceId", f.owner.workspaceId).eq("userId", f.owner.userId),
						)
						.unique();
					if (!lifetime) throw new Error("Expected membership lifetime");
					await ctx.db.patch("organizations_membership_lifetimes", lifetime._id, { lifetime: lifetime.lifetime + 1 });
				}
				if (change === "account")
					await ctx.db.patch("access_control_service_accounts", f.installation.serviceAccountId, {
						revokedAt: Date.now(),
					});
				if (change === "owner") await ctx.db.patch("users", f.owner.userId, { deletedAt: Date.now() });
			});
			expect(await f.t.query(internal.public_api.resolve_principal, { presented: f.token })).toEqual({
				_nay: { message: "Unauthenticated" },
			});
		},
	);

	test("KV repeats scope consent inside the write transaction", async () => {
		const f = await fixture({ scheduled: true });
		const response = await f.t.action(async (ctx) =>
			plugins_data_http_write({
				ctx: {
					...ctx,
					runMutation: async (...args) => {
						if (is_api_function(args[0], "plugins_data:write_document")) {
							await f.t.run(async (dbCtx) => {
								const grantId = f.installation.scheduledRunGrantId!;
								const grant = await dbCtx.db.get("access_control_permission_grants", grantId);
								if (!grant?.runAs) throw new Error("Expected direct consent");
								await dbCtx.db.patch("access_control_permission_grants", grantId, {
									runAs: { ...grant.runAs, scopes: ["plugin_data:read"] },
								});
							});
						}
						return await ctx.runMutation(...args);
					},
				},
				request: api_request({
					f,
					path: "/api/v1/plugin-data/write",
					body: {
						collection: "records",
						key: "one",
						value: { message: "denied" },
					},
				}),
				path: "/api/v1/plugin-data/write",
			}),
		);
		expect(response.status, "KV writes must repeat direct scope consent").toBe(403);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_data").collect())).toEqual([]);
		expect((await calls(f)).at(-1)?.status).toBe("failed");
	});

	test("scheduled volume writes work with direct consent", async () => {
		const f = await fixture({ scheduled: true });
		const staged = await stage({ f });
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/record", content: "saved" }] })).response.status,
		).toBe(200);
		expect(events()).toHaveLength(1);
	});

	test.each(["actor", "owner"] as const)(
		"scheduled writes use owner credit when the %s has no funds",
		async (empty) => {
			const f = await fixture({ scheduled: true });
			const member = await invited_member(f);
			await reset_manage_limit(f);
			expect(
				await f.asOwner.mutation(api.plugins_access.update_installation_access, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					mode: "selected",
					principals: [{ kind: "user", userId: member.userId }],
				}),
			).toEqual({ _yay: null });
			await assign_scheduled_user({ f, member, scopes: ["volumes:write"] });
			await f.t.run(async (ctx) => {
				await ctx.db.patch("organizations", f.owner.organizationId, { billingMode: "user" });
				const userId = empty === "owner" ? f.owner.userId : member.userId;
				await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Free" });
				const snapshot = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", userId))
					.unique();
				if (!snapshot?.meter) throw new Error("Expected payer meter");
				await ctx.db.patch("billing_usage_snapshots", snapshot._id, { meter: { ...snapshot.meter, balance: 0 } });
			});
			const staged = await stage({ f });
			const result = await write({ f, stagingId: staged.stagingId, files: [{ path: "/record", content: "saved" }] });
			expect(result.response.status, "scheduled writes must use the current owner credit").toBe(
				empty === "owner" ? 402 : 200,
			);
			if (empty === "owner") {
				expect(events()).toEqual([]);
				expect(objects.size).toBe(0);
			} else {
				expect(events()).toMatchObject([{ externalCustomerId: f.owner.userId, externalMemberId: member.userId }]);
			}
		},
	);

	test("scheduled volume writes repeat direct consent after PUT", async () => {
		const f = await fixture({ scheduled: true });
		const staged = await stage({ f });
		onPut = async () => {
			onPut = null;
			await f.t.run(async (ctx) => {
				const grantId = f.installation.scheduledRunGrantId!;
				const grant = await ctx.db.get("access_control_permission_grants", grantId);
				if (!grant?.runAs) throw new Error("Expected direct consent");
				await ctx.db.patch("access_control_permission_grants", grantId, { runAs: { ...grant.runAs, scopes: [] } });
			});
		};
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/record", content: "denied" }] })).response
				.status,
			"volume finalization must repeat direct scope consent",
		).toBe(403);
		expect(await volume_nodes(f)).toEqual([]);
		expect(events()).toEqual([]);
		expect(await unused_assets(f)).toEqual([]);
	});
});

describe("scheduled Files response authority", () => {
	test("a file-only reader can consent and read without workspace read permission", async () => {
		const f = await fixture({ scheduled: true });
		const file = await readable_file(f);
		await readable_file(f, "/private.txt");
		const member = await invited_member(f);
		const role = await f.asOwner.mutation(api.access_control.create_role, {
			organizationId: f.owner.organizationId,
			name: "File only",
			description: "",
			permissions: ["workspace.mcp.use"],
		});
		if (role._nay) throw new Error(role._nay.message);
		const organization = await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId));
		if (!organization?.defaultWorkspaceId) throw new Error("Expected organization home");
		for (const workspaceId of [organization.defaultWorkspaceId, f.owner.workspaceId]) {
			expect(
				await f.asOwner.mutation(api.access_control.set_user_role, {
					organizationId: f.owner.organizationId,
					workspaceId,
					userId: member.userId,
					role: workspaceId === organization.defaultWorkspaceId ? role._yay.roleId : null,
				}),
			).toEqual({ _yay: null });
		}
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: file.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.owner.membershipId,
				nodeId: file.nodeId,
				principal: { kind: "user", userId: member.userId },
				level: "read",
			}),
		).toEqual({ _yay: null });
		await assign_scheduled_user({
			f,
			member,
			scopes: ["files:read", "files:list"],
			filesReadProof: { kind: "file", nodeId: file.nodeId },
		});
		expect(
			await member.asMember.query(api.access_control.get_current_user_workspace_permission, {
				membershipId: member.membershipId,
				permission: "content.read",
			}),
		).toBe(false);
		const read = await f.t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}` },
			body: JSON.stringify({ path: file.path }),
		});
		expect(read.status, "the saved file proof must not add a workspace read gate").toBe(200);
		expect(await read.json()).toMatchObject({ content: "read" });
		const listed = await f.t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}` },
			body: JSON.stringify({}),
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ items: [{ path: file.path }] });
		const denied = await f.t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: { Authorization: `Bearer ${f.token}` },
			body: JSON.stringify({ path: "/private.txt" }),
		});
		expect(denied.status, "consent must not grant another file").toBe(404);
	});

	test("registered Files routes read with the user and account", async () => {
		const f = await fixture({ scheduled: true });
		await readable_file(f);
		for (const [path, body] of [
			["/api/v1/files/read", { path: "/note.txt" }],
			["/api/v1/files/list", {}],
		] as const) {
			const response = await f.t.fetch(path, {
				method: "POST",
				headers: { Authorization: `Bearer ${f.token}` },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			expect((await calls(f)).at(-1)).toMatchObject({ status: "succeeded", responseStatus: 200 });
		}
	});

	test.each(["read", "list"] as const)(
		"%s refuses consent revoked after I/O before success settlement",
		async (kind) => {
			const f = await fixture({ scheduled: true });
			await readable_file(f);
			let sawIo = false;
			const afterIo = async () => {
				sawIo = true;
				expect((await calls(f)).at(-1)?.status).toBe("started");
				await f.asOwner.mutation(api.plugins_access.revoke_run_as_me, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
				});
			};
			const response = kind === "read" ? await read_after_io(f, afterIo) : await list_after_io(f, afterIo);
			expect(sawIo, "the response test must reach content or asset I/O").toBe(true);
			expect(response.status, "scheduled Files responses must refuse consent revoked after I/O").toBe(404);
			expect((await calls(f)).at(-1)?.status).toBe("failed");
		},
	);

	test.each(["read", "list"] as const)("%s rechecks the exact returned path after I/O", async (kind) => {
		const f = await fixture({ scheduled: true });
		const file = await readable_file(f);
		const afterIo = async () => {
			await f.t.run((ctx) => ctx.db.patch("files_nodes", file.nodeId, { path: "/renamed.txt" }));
		};
		const response = kind === "read" ? await read_after_io(f, afterIo) : await list_after_io(f, afterIo);
		expect(response.status, "scheduled Files responses must repeat the returned path check").toBe(404);
		expect((await calls(f)).at(-1)?.status).toBe("failed");
	});

	test.each(["read", "list"] as const)("%s rechecks the account's file permission after I/O", async (kind) => {
		const f = await fixture({ scheduled: true });
		const file = await readable_file(f);
		const afterIo = async () => {
			await f.t.run(async (ctx) => {
				const grants = await ctx.db.query("access_control_permission_grants").collect();
				for (const grant of grants)
					if (grant.serviceAccountId === f.installation.serviceAccountId && grant.resourceId === file.nodeId)
						await ctx.db.delete("access_control_permission_grants", grant._id);
			});
		};
		const response = kind === "read" ? await read_after_io(f, afterIo) : await list_after_io(f, afterIo);
		expect(response.status, "scheduled Files responses must repeat live account permission").toBe(404);
		expect((await calls(f)).at(-1)?.status).toBe("failed");
	});
});

describe("volumes caps and lifecycle", () => {
	test.each(["copy_cap_reached", "installation_cap_reached", "daily_cap_reached"])(
		"reports %s before uploading refused files",
		async (code) => {
			const f = await fixture();
			const staged = await stage({ f });
			await f.t.run(async (ctx) => {
				if (code === "daily_cap_reached") {
					await rate_limiter_limit_by_key(ctx, {
						name: "plugins_volume_daily_files",
						key: `${f.owner.organizationId}:${f.owner.workspaceId}:${f.name}`,
						count: 10_000,
					});
					return;
				}
				if (code === "copy_cap_reached") {
					const id = ctx.db.normalizeId("plugins_volume_generations", staged.stagingId);
					if (!id) throw new Error("Expected staging id");
					await ctx.db.patch("plugins_volume_generations", id, { fileCount: 5_000 });
				} else {
					const usage = await ctx.db
						.query("plugins_volume_usage")
						.withIndex("by_organization_workspace_installation", (q) =>
							q
								.eq("organizationId", f.owner.organizationId)
								.eq("workspaceId", f.owner.workspaceId)
								.eq("installationId", f.installationId),
						)
						.unique();
					if (!usage) throw new Error("Expected usage");
					await ctx.db.patch("plugins_volume_usage", usage._id, { fileCount: 20_000 });
				}
			});
			const result = await write({ f, stagingId: staged.stagingId, files: [{ path: "/refused", content: "bad" }] });
			expect(result.body).toMatchObject({ written: [], errors: [{ path: "/refused", errorCode: code }] });
			expect(objects.size).toBe(0);
		},
	);

	test("daily budget skips excess uploads and still allows replacements", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		await write({ f, stagingId: staged.stagingId, files: [{ path: "/old", content: "old" }] });
		await f.t.run((ctx) =>
			rate_limiter_limit_by_key(ctx, {
				name: "plugins_volume_daily_files",
				key: `${f.owner.organizationId}:${f.owner.workspaceId}:${f.name}`,
				count: 9_998,
			}),
		);
		const before = objects.size;
		const result = await write({
			f,
			stagingId: staged.stagingId,
			files: [
				{ path: "/old", content: "new" },
				{ path: "/one", content: "one" },
				{ path: "/two", content: "two" },
			],
		});
		expect(result.body).toMatchObject({
			written: [{ path: "/old" }, { path: "/one" }],
			errors: [{ path: "/two", errorCode: "daily_cap_reached" }],
		});
		expect(objects.size - before).toBe(2);
		expect(events()).toHaveLength(2);
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
		const remaining = await f.t.run(async (ctx) => {
			const { rate_limiter_get_plugin_volume_daily_files_left } = await import("./rate_limiter.ts");
			return await rate_limiter_get_plugin_volume_daily_files_left(ctx, {
				key: `${f.owner.organizationId}:${f.owner.workspaceId}:${f.name}`,
				now: Date.now(),
			});
		});
		expect(remaining).toBe(10_000);
	});

	test("uninstall and reinstall keep the daily plugin-name budget", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		await f.t.run((ctx) =>
			rate_limiter_limit_by_key(ctx, {
				name: "plugins_volume_daily_files",
				key: `${f.owner.organizationId}:${f.owner.workspaceId}:${f.name}`,
				count: 9_999,
			}),
		);
		await write({ f, stagingId: staged.stagingId, files: [{ path: "/last", content: "last" }] });
		await reset_manage_limit(f);
		expect(
			await f.asOwner.mutation(api.plugins.uninstall_version, {
				membershipId: f.owner.membershipId,
				installationId: f.installationId,
			}),
		).toEqual({ _yay: null });
		await reset_manage_limit(f);
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			membershipId: f.owner.membershipId,
			pluginVersionId: f.pluginVersionId,
			acceptedCapabilities: ["workspace.volumes.write", "plugin.backend.invoke"],
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "volume-mcp",
			acceptedSkillNames: [],
		});
		if (installed._nay) throw new Error(installed._nay.message);
		f.installationId = installed._yay.installationId;
		await restart_run(f);
		const next = await stage({ f });
		const result = await write({ f, stagingId: next.stagingId, files: [{ path: "/refused", content: "refused" }] });
		expect(result.body).toMatchObject({ written: [], errors: [{ errorCode: "daily_cap_reached" }] });
		expect(events()).toHaveLength(1);
	});

	test.each(["copy", "installation"])("refuses the %s byte cap before PUT", async (kind) => {
		const f = await fixture();
		const staged = await stage({ f });
		await f.t.run(async (ctx) => {
			if (kind === "copy") {
				const id = ctx.db.normalizeId("plugins_volume_generations", staged.stagingId);
				if (!id) throw new Error("Expected staging id");
				await ctx.db.patch("plugins_volume_generations", id, { bytes: 30_000_000 });
			} else {
				const usage = await ctx.db
					.query("plugins_volume_usage")
					.withIndex("by_organization_workspace_installation", (q) =>
						q
							.eq("organizationId", f.owner.organizationId)
							.eq("workspaceId", f.owner.workspaceId)
							.eq("installationId", f.installationId),
					)
					.unique();
				if (!usage) throw new Error("Expected usage");
				await ctx.db.patch("plugins_volume_usage", usage._id, { bytes: 200_000_000 });
			}
		});
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/refused", content: "one" }] })).body,
		).toMatchObject({
			written: [],
			errors: [{ errorCode: kind === "copy" ? "copy_cap_reached" : "installation_cap_reached" }],
		});
		expect(objects.size).toBe(0);
	});

	test("the thirty-two volume cap includes deleting rows", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			for (let i = 0; i < 32; i++)
				await ctx.db.insert("plugins_volumes", {
					organizationId: f.owner.organizationId,
					workspaceId: f.owner.workspaceId,
					installationId: f.installationId,
					mountId: "sources",
					volumeKey: `key-${i}`,
					publishedGenerationId: null,
					createdAt: Date.now(),
					deleteRequestedAt: i === 0 ? Date.now() : null,
					drainScheduledUntil: null,
				});
		});
		const response = await post({
			f,
			route: "stage",
			body: { mountId: "sources", volumeKey: "another", revision: "r" },
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ errorCode: "volume_cap_reached" });
	});

	test("old deleting mount ids cannot exceed the installation volume cap", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			for (let i = 0; i < 128; i++)
				await ctx.db.insert("plugins_volumes", {
					organizationId: f.owner.organizationId,
					workspaceId: f.owner.workspaceId,
					installationId: f.installationId,
					mountId: `old-${Math.floor(i / 32)}`,
					volumeKey: `key-${i}`,
					publishedGenerationId: null,
					createdAt: Date.now(),
					deleteRequestedAt: Date.now(),
					drainScheduledUntil: null,
				});
		});
		const response = await post({
			f,
			route: "stage",
			body: { mountId: "sources", volumeKey: "current", revision: "r" },
		});
		expect(response.status, "dropped mount rows must still count toward 128 volumes").toBe(409);
		expect(await response.json()).toMatchObject({ errorCode: "volume_cap_reached" });
		expect(await (await post({ f, route: "list", body: {} })).json()).toMatchObject({
			mounts: [{ volumes: [] }],
			usage: { limits: { volumesPerInstallation: 128 } },
		});
	});

	test("lists deleting state and refuses controls and writes with 409", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		await write({ f, stagingId: staged.stagingId, files: [{ path: "/old", content: "old" }] });
		expect((await post({ f, route: "delete", body: { mountId: "sources", volumeKey: "records" } })).status).toBe(200);
		expect(await (await post({ f, route: "list", body: {} })).json()).toMatchObject({
			mounts: [{ volumes: [{ deleting: true }] }],
		});
		for (const [route, body] of [
			["stage", { mountId: "sources", volumeKey: "records", revision: "new" }],
			["publish", { stagingId: staged.stagingId }],
			["delete", { mountId: "sources", volumeKey: "records" }],
			["write-many", { stagingId: staged.stagingId, files: [{ path: "/new", content: "new" }] }],
		] as const) {
			const response = await post({ f, route, body });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ errorCode: "volume_deleting" });
		}
	});

	test("rejects expired and empty staging copies", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		expect((await post({ f, route: "publish", body: { stagingId: staged.stagingId } })).status).toBe(409);
		await f.t.run(async (ctx) => {
			const id = ctx.db.normalizeId("plugins_volume_generations", staged.stagingId);
			if (!id) throw new Error("Expected staging id");
			await ctx.db.patch("plugins_volume_generations", id, { expiresAt: Date.now() - 1 });
		});
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/late", content: "late" }] })).response.status,
		).toBe(409);
		expect(objects.size).toBe(0);
	});

	test("uses the installation rate bucket for controls and bulk writes", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		await f.t.run((ctx) =>
			rate_limiter_limit_by_key(ctx, { name: "plugins_volume_write_bulk", key: f.installationId, count: 1_200 }),
		);
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/rate", content: "rate" }] })).response.status,
		).toBe(429);
		await f.t.run((ctx) =>
			rate_limiter_limit_by_key(ctx, { name: "plugins_volume_control", key: f.installationId, count: 29 }),
		);
		expect(
			(await post({ f, route: "stage", body: { mountId: "sources", volumeKey: "another", revision: "r" } })).status,
		).toBe(429);
		expect(objects.size).toBe(0);
	});

	test.each(["stage", "publish", "delete"] as const)(
		"a %s during PUT cannot save into the old staging copy",
		async (control) => {
			const f = await fixture();
			const staged = await stage({ f });
			await write({ f, stagingId: staged.stagingId, files: [{ path: "/old", content: "old" }] });
			const old = (await volume_nodes(f)).find((node) => node.kind === "file")!;
			onPut = async () => {
				onPut = null;
				const body =
					control === "stage"
						? { mountId: "sources", volumeKey: "records", revision: "new" }
						: control === "publish"
							? { stagingId: staged.stagingId }
							: { mountId: "sources", volumeKey: "records" };
				expect((await post({ f, route: control, body })).status).toBe(200);
			};
			expect(
				(await write({ f, stagingId: staged.stagingId, files: [{ path: "/old", content: "replacement" }] })).response
					.status,
			).toBe(409);
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", old._id))).toEqual(old);
			expect(events()).toHaveLength(1);
			expect(await unused_assets(f)).toEqual([]);
		},
	);
});

describe("volumes live authority and credits", () => {
	test("refuses scope when the actor cannot manage the exact installation", async () => {
		const f = await fixture();
		const member = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userIdToAdd: member.userId,
			}),
		).toEqual({ _yay: null });
		await restart_run(f, member.userId);
		const response = await post({
			f,
			route: "stage",
			body: { mountId: "sources", volumeKey: "records", revision: "r" },
		});
		expect(response.status).toBe(403);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volumes").collect())).toEqual([]);
		expect((await calls(f)).at(-1)?.status).toBe("failed");
	});

	test("refuses scope without the accepted capability", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_event_runs", f.runId, { acceptedCapabilities: ["plugin.backend.invoke"] }),
		);
		expect((await post({ f, route: "list", body: {} })).status).toBe(403);
	});

	test("refuses insufficient entry credits before PUT", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		await f.t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: f.owner.userId, plan: "Free" });
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", f.owner.userId))
				.unique();
			if (!snapshot?.meter) throw new Error("Expected meter");
			await ctx.db.patch("billing_usage_snapshots", snapshot._id, { meter: { ...snapshot.meter, balance: 0.5 } });
		});
		expect(
			(
				await write({
					f,
					stagingId: staged.stagingId,
					files: [
						{ path: "/one", content: "one" },
						{ path: "/two", content: "two" },
					],
				})
			).response.status,
		).toBe(402);
		expect(objects.size).toBe(0);
		expect(events()).toHaveLength(0);
	});

	test.each(["finished", "account", "version", "purge", "member", "token", "deadline"])(
		"refuses %s during R2 I/O before final writes",
		async (change) => {
			const f = await fixture();
			const staged = await stage({ f });
			let changed = false;
			onPut = async () => {
				if (changed) return;
				changed = true;
				await f.t.run(async (ctx) => {
					if (change === "finished" || change === "deadline") {
						const activity = await ctx.db
							.query("activities")
							.withIndex("by_source_id", (q) => q.eq("source.id", f.runId))
							.unique();
						if (!activity) throw new Error("Expected activity");
						await ctx.db.patch(
							"activities",
							activity._id,
							change === "finished" ? { status: "succeeded", finishedAt: Date.now() } : { deadlineAt: Date.now() - 1 },
						);
					} else if (change === "account")
						await ctx.db.patch("access_control_service_accounts", f.installation.serviceAccountId, {
							revokedAt: Date.now(),
						});
					else if (change === "version") {
						const version = await ctx.db.get("plugins_versions", f.pluginVersionId);
						if (!version) throw new Error("Expected version");
						const { _id: _versionId, _creationTime: _created, ...fields } = version;
						const replacement = await ctx.db.insert("plugins_versions", { ...fields, version: "0.2.0" });
						await ctx.db.patch("plugins_workspace_installations", f.installationId, { pluginVersionId: replacement });
					} else if (change === "purge")
						await ctx.db.patch("organizations_workspaces", f.owner.workspaceId, {
							pluginDataPurgeStartedAt: Date.now(),
						});
					else if (change === "member")
						await ctx.db.patch("organizations_workspaces_users", f.owner.membershipId, { active: false });
					else await ctx.db.patch("plugins_event_runs", f.runId, { apiTokenHash: undefined });
				});
			};
			expect(
				(await write({ f, stagingId: staged.stagingId, files: [{ path: "/refused", content: "refused" }] })).response
					.status,
			).toBe(401);
			expect((await volume_nodes(f)).filter((node) => node.kind === "file")).toEqual([]);
			expect(events()).toHaveLength(0);
			expect(await unused_assets(f)).toEqual([]);
			expect((await calls(f)).at(-1)).toMatchObject({ status: "failed", responseStatus: 401 });
		},
	);

	test("revoking exact management during PUT leaves the old file and sibling intact", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		await write({
			f,
			stagingId: staged.stagingId,
			files: [
				{ path: "/old", content: "old" },
				{ path: "/old-sibling", content: "sibling" },
			],
		});
		const prior = (await volume_nodes(f)).filter((node) => node.kind === "file");
		const member = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			userIdToAdd: member.userId,
		});
		await reset_manage_limit(f);
		expect(
			await f.asOwner.mutation(api.plugins_access.update_installation_access, {
				membershipId: f.owner.membershipId,
				installationId: f.installationId,
				mode: "selected",
				principals: [{ kind: "user", userId: member.userId }],
			}),
		).toEqual({ _yay: null });
		await restart_run(f, member.userId);
		onPut = async () => {
			await reset_manage_limit(f);
			expect(
				await f.asOwner.mutation(api.plugins_access.update_installation_access, {
					membershipId: f.owner.membershipId,
					installationId: f.installationId,
					mode: "owner",
					principals: [],
				}),
			).toEqual({ _yay: null });
		};
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/old", content: "changed" }] })).response.status,
		).toBe(403);
		for (const node of prior) expect(await f.t.run((ctx) => ctx.db.get("files_nodes", node._id))).toEqual(node);
		expect(events()).toHaveLength(2);
		expect(await unused_assets(f)).toEqual([]);
	});

	test("an owner transfer repeats the new payer credit check before saving", async () => {
		const f = await fixture();
		const staged = await stage({ f });
		const nextOwner = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home", plan: "Free" }),
		);
		await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			userIdToAdd: nextOwner.userId,
		});
		await reset_manage_limit(f);
		expect(
			await f.asOwner.mutation(api.plugins_access.update_installation_access, {
				membershipId: f.owner.membershipId,
				installationId: f.installationId,
				mode: "workspace",
				principals: [],
			}),
		).toEqual({ _yay: null });
		await f.t.run(async (ctx) => {
			await ctx.db.patch("organizations", f.owner.organizationId, { billingMode: "organization_owner" });
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", nextOwner.userId))
				.unique();
			if (!snapshot?.meter) throw new Error("Expected meter");
			await ctx.db.patch("billing_usage_snapshots", snapshot._id, { meter: { ...snapshot.meter, balance: 0 } });
		});
		onPut = async () => {
			await f.t.run((ctx) =>
				ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
					name: "organizations_write",
					key: f.owner.userId,
				}),
			);
			expect(
				await f.asOwner.mutation(api.access_control.transfer_organization_ownership, {
					organizationId: f.owner.organizationId,
					newOwnerUserId: nextOwner.userId,
				}),
			).toEqual({ _yay: null });
		};
		expect(
			(await write({ f, stagingId: staged.stagingId, files: [{ path: "/refused", content: "refused" }] })).response
				.status,
		).toBe(402);
		expect((await volume_nodes(f)).filter((node) => node.kind === "file")).toEqual([]);
		expect(events()).toHaveLength(0);
		expect(await (await post({ f, route: "list", body: {} })).json()).toMatchObject({
			usage: { fileCount: 0, dailyFilesLeft: 10_000 },
		});
		expect(await unused_assets(f)).toEqual([]);
	});
});

describe("volumes replacement transaction budget", () => {
	test("writes valid large multiline files and splits small replacements by old content", async () => {
		const f = await fixture({ transactionLimits: true });
		const staged = await stage({ f });
		const content = `${"x".repeat(600)}\n`.repeat(1_490);
		expect(content.length).toBeLessThan(900_000);
		const files = Array.from({ length: 5 }, (_, i) => ({ path: `/large-${i}`, content }));
		const initial = await write({ f, stagingId: staged.stagingId, files });
		expect(initial.response.status).toBe(200);
		expect(initial.body).toMatchObject({ written: files.map((file) => ({ path: file.path })), errors: [] });
		const prior = (await volume_nodes(f)).filter((node) => node.kind === "file");
		for (const node of prior) {
			const saved = await f.t.run((ctx) =>
				ctx.db
					.query("files_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", f.owner.organizationId)
							.eq("workspaceId", node.workspaceId)
							.eq("fileNodeId", node._id),
					)
					.collect(),
			);
			expect(saved.map((row) => row.textChunk).join("")).toBe(content);
		}
		const replaced = await write({
			f,
			stagingId: staged.stagingId,
			files: files.map((file) => ({ path: file.path, content: "tiny" })),
		});
		expect(replaced.response.status, "old replacement content must fit each final transaction").toBe(200);
		expect(replaced.body).toMatchObject({ written: files.map((file) => ({ path: file.path, bytes: 4 })), errors: [] });
		expect(events()).toHaveLength(5);
		for (const node of prior) expect(await f.t.run((ctx) => ctx.db.get("files_nodes", node._id))).toBeNull();
		expect(await (await post({ f, route: "list", body: {} })).json()).toMatchObject({
			usage: { fileCount: 5, bytes: 20, dailyFilesLeft: 9_995 },
		});
	}, 30_000);
});
