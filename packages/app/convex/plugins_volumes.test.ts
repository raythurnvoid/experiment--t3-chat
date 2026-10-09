import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_ROOT_ID, files_get_utf8_byte_size } from "../server/files.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { api, internal } from "./_generated/api.js";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { files_nodes_db_insert_file_content_docs } from "./files_nodes_content.ts";
import { r2 } from "./r2_client.ts";
import { test_convex, test_create_saved_text_file, test_meta_search, test_mocks_fill_db_with } from "./setup.test.ts";

const volume_text = "# unfinished [markdown\nZorptelemetry marker.\nUnicode: café 🐒\nLast line without newline";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function create_volume_fixture() {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "volume-team" }));
	const reader = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: reader.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", reader.userId).eq("active", true),
			)
			.unique(),
	);
	if (!membership) throw new Error("Expected invited membership");
	const asReader = t.withIdentity({ issuer: "https://clerk.test", external_id: reader.userId });
	const created = await asReader.mutation(api.ai_chat.thread_create, {
		membershipId: membership._id,
		clientGeneratedId: "volume-read-test",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: reader.userId,
		membershipId: membership._id,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const agentSource = {
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		userId: reader.userId,
		threadId: created._yay.threadId,
		membershipId: membership._id,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	const stored = await t.run(async (ctx) => {
		const now = Date.now();
		const tenant = { organizationId: owner.organizationId, workspaceId: owner.workspaceId };
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "volume-test",
			displayName: "Volume test",
			version: "0.1.0",
			description: "Read test",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/example/volume-test",
			sourceOwner: "example",
			sourceRepo: "volume-test",
			sourceCommitSha: "a".repeat(40),
			manifestR2Key: "plugins/volume-test/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			mounts: [],
			events: [],
			capabilities: [],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "volume-test-mcp",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: owner.userId,
			updatedAt: now,
			secrets: [],
			endpoints: [],
			userWritableCollections: null,
		});
		const serviceAccountId = await test_mocks_fill_db_with.plugin_service_account(ctx, {
			...tenant,
			pluginVersionId,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			...tenant,
			serviceAccountId,
			pluginVersionId,
			pluginName: "volume-test",
			status: "enabled",
			managementAccess: "selected",
			configurationYaml: null,
			acceptedCapabilities: [],
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "volume-test-mcp",
			acceptedSkillNames: [],
			installedBy: owner.userId,
			updatedBy: owner.userId,
			updatedAt: now,
		});
		const byteSize = files_get_utf8_byte_size(volume_text);
		const volumeId = await ctx.db.insert("plugins_volumes", {
			...tenant,
			installationId,
			mountId: "sources",
			volumeKey: "repo",
			publishedGenerationId: null,
			createdAt: now,
			deleteRequestedAt: null,
			drainScheduledUntil: null,
		});
		const generationId = await ctx.db.insert("plugins_volume_generations", {
			...tenant,
			volumeId,
			installationId,
			status: "published",
			revision: "rev-1",
			fileCount: 1,
			bytes: byteSize,
			createdAt: now,
			lastWriteAt: now,
			publishedAt: now,
			expiresAt: null,
			drainScheduledUntil: null,
		});
		await ctx.db.patch("plugins_volumes", volumeId, { publishedGenerationId: generationId });
		await ctx.db.insert("plugins_volume_usage", { ...tenant, installationId, fileCount: 1, bytes: byteSize });
		const scope = { organizationId: owner.organizationId, workspaceId: volumeId };
		const rootPath = `/${generationId}`;
		const path = `${rootPath}/notes.md`;
		const nodeFields = {
			...scope,
			assetId: null,
			contentByteSize: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			isRestrictedScopeRoot: false,
			writePolicy: null,
			newChildWritePolicy: null,
			archiveOperationId: null,
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
			updatedAt: now,
		} as const;
		const rootId = await ctx.db.insert("files_nodes", {
			...nodeFields,
			parentId: files_ROOT_ID,
			path: rootPath,
			treePath: `${rootPath}/`,
			pathDepth: 1,
			lowercaseExtension: "",
			name: generationId,
			sortName: files_sort_text_key(generationId),
			kind: "folder",
			contentType: null,
		});
		const nodeId = await ctx.db.insert("files_nodes", {
			...nodeFields,
			parentId: rootId,
			path,
			treePath: path,
			pathDepth: 2,
			lowercaseExtension: "md",
			name: "notes.md",
			sortName: files_sort_text_key("notes.md"),
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
		});
		const assetId = await ctx.db.insert("files_r2_assets", {
			...scope,
			kind: "content",
			r2Bucket: r2.config.bucket,
			size: byteSize,
			createdBy: users_SYSTEM_AUTHOR,
			updatedAt: now,
		});
		const r2Key = `organizations/${scope.organizationId}/workspaces/${volumeId}/assets/${assetId}`;
		await ctx.db.patch("files_r2_assets", assetId, { r2Key });
		const statsId = await ctx.db.insert("file_stats", {
			...scope,
			fileNodeId: nodeId,
			lineCount: 3,
			wordCount: volume_text.trim().split(/\s+/u).length,
			charCount: Array.from(volume_text).length,
		});
		await ctx.db.patch("files_nodes", nodeId, { assetId, statsId });
		const chunks = files_chunk_plain_text(volume_text);
		for (const [index, chunk] of chunks.entries()) {
			const textChunkId = await ctx.db.insert("files_text_chunks", {
				...scope,
				fileNodeId: nodeId,
				sourceKind: "committed",
				chunkIndex: chunk.chunkIndex,
				textChunk: chunk.textChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
			});
			await ctx.db.insert("files_plain_text_chunks", {
				...scope,
				...chunk,
				fileNodeId: nodeId,
				sourceKind: "committed",
				textChunkId,
				path,
				hasChunkAbove: index > 0,
				hasChunkBelow: index < chunks.length - 1,
			});
		}
		for (const docKind of ["field", "value"] as const) {
			await ctx.db.insert("files_metadata_docs", {
				...scope,
				fileNodeId: nodeId,
				sourceKind: "committed",
				path,
				treePath: path,
				fieldPath: "metadata.status",
				docKind,
				valueKind: "string",
				stringValue: "published",
			});
		}
		return { scope, volumeId, generationId, installationId, rootId, rootPath, path, nodeId, assetId, r2Key };
	});
	return { t, owner, reader, asOwner, asReader, agentSource, ...stored };
}

async function read_volume(
	f: Awaited<ReturnType<typeof create_volume_fixture>>,
	source: typeof f.agentSource | null = f.agentSource,
) {
	const args = { ...f.scope, userId: f.reader.userId, agentSource: source ?? undefined };
	const visibleArgs = {
		...f.scope,
		visibilityUserId: f.reader.userId,
		agentSource: source ?? undefined,
	};
	const matchArgs = {
		...args,
		target: { kind: "saved" as const, id: f.nodeId },
		pattern: "Zorptelemetry",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	};
	return {
		entry: await f.t.query(internal.files_nodes.get_visible_entry_by_path, { ...visibleArgs, path: f.path }),
		children: await f.t.query(internal.files_nodes.list_children, {
			...visibleArgs,
			parentId: f.rootId,
			orderBy: "name",
			numItems: 10,
			cursor: null,
		}),
		subtree: await f.t.query(internal.files_nodes.list_subtree, {
			...visibleArgs,
			folderPath: f.rootPath,
			numItems: 10,
			cursor: null,
		}),
		paths: await f.t.query(internal.files_nodes.search_paths, {
			...visibleArgs,
			pathQuery: f.path,
			numItems: 10,
			cursor: null,
		}),
		full: await f.t.query(internal.files_nodes.read_file_content_from_chunks, {
			...args,
			path: f.path,
			mode: { kind: "full", maxBytes: 100_000 },
		}),
		lines: await f.t.query(internal.files_nodes.read_committed_file_chunks_line_range, {
			...args,
			path: f.path,
			startLine: 2,
			maxLines: 1,
			fromEnd: false,
		}),
		stats: await f.t.query(internal.files_nodes.read_committed_file_chunk_stats, { ...args, path: f.path }),
		matches: await f.t.query(internal.files_nodes.match_text_file_lines, { ...matchArgs, before: 0, after: 0 }),
		plainMatches: await f.t.query(internal.files_nodes.match_plain_text_file_lines, matchArgs),
		search: await f.t.query(internal.files_nodes.text_search_files, {
			...args,
			hasWorkspaceRead: true,
			query: "Zorptelemetry",
			numItems: 10,
			cursor: null,
		}),
		metadata: await f.t.query(internal.files_metadata.get_by_path, { ...args, path: f.path }),
		metadataSearch: await test_meta_search(f.t, {
			...args,
			plan: { op: "eq", fieldPath: "metadata.status", value: "published" },
		}),
		head: await f.t.action(internal.files_nodes_content.read_file_line_range, {
			...args,
			path: f.path,
			startLine: 1,
			maxLines: 1,
		}),
		tail: await f.t.action(internal.files_nodes_content.read_file_tail_lines, { ...args, path: f.path, maxLines: 1 }),
		wc: await f.t.action(internal.files_nodes_content.read_file_content_stats, { ...args, path: f.path }),
	};
}

function expect_refused(read: Awaited<ReturnType<typeof read_volume>>) {
	expect(read.entry).toBeNull();
	expect(read.children.items).toEqual([]);
	expect(read.subtree.page).toEqual([]);
	expect(read.paths.items).toEqual([]);
	expect(read.full).toBeNull();
	expect(read.lines).toEqual({ usable: false });
	expect(read.stats).toEqual({ usable: false });
	expect(read.matches).toBeNull();
	expect(read.plainMatches).toBeNull();
	expect(read.search.items).toEqual([]);
	expect(read.metadata).toBeNull();
	expect(read.metadataSearch.items).toEqual([]);
	expect(read.head).toBeNull();
	expect(read.tail).toBeNull();
	expect(read.wc).toBeNull();
}

describe("volume reads", () => {
	test("reads raw SYSTEM-authored text and indexes through the original real workspace", async () => {
		const f = await create_volume_fixture();
		const read = await read_volume(f);
		expect(read.entry).toMatchObject({ kind: "saved", node: { _id: f.nodeId, createdBy: users_SYSTEM_AUTHOR } });
		expect(read.children.items).toMatchObject([{ path: f.path }]);
		expect(read.subtree.page).toMatchObject([{ _id: f.rootId }, { _id: f.nodeId }]);
		expect(read.paths.items).toMatchObject([{ path: f.path }]);
		expect(read.full?.content).toBe(volume_text);
		expect(read.lines).toMatchObject({ usable: true, content: "Zorptelemetry marker.\n" });
		expect(read.stats).toMatchObject({ usable: true, lineCount: 3, byteCount: files_get_utf8_byte_size(volume_text) });
		expect(read.matches).toMatchObject({ selectedCount: 1 });
		expect(read.plainMatches).toMatchObject({ selectedCount: 1 });
		expect(read.search.items).toMatchObject([{ path: f.path }]);
		expect(read.metadata).toMatchObject({ fields: ["metadata.status"] });
		expect(read.metadataSearch.items).toMatchObject([{ path: f.path }]);
		expect(read.head?.content).toBe("# unfinished [markdown\n");
		// Line tools add a display newline; the full read keeps the original bytes.
		expect(read.tail?.content).toBe("Last line without newline\n");
		expect(read.wc).toMatchObject({ exact: true, lineCount: 3, byteCount: files_get_utf8_byte_size(volume_text) });
		expect(await f.t.run((ctx) => ctx.db.query("files_yjs_snapshots").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test.each([
		"deleting volume",
		"disabled installation",
		"missing membership",
		"deleted thread",
		"purge fence",
		"deleted reader",
	] as const)("refuses all read doors after %s", async (state) => {
		const f = await create_volume_fixture();
		expect((await read_volume(f)).full?.content).toBe(volume_text);
		await f.t.run(async (ctx) => {
			if (state === "deleting volume")
				await ctx.db.patch("plugins_volumes", f.volumeId, { deleteRequestedAt: Date.now() });
			else if (state === "disabled installation")
				await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
			else if (state === "missing membership")
				await ctx.db.delete("organizations_workspaces_users", f.agentSource.membershipId);
			else if (state === "deleted thread") await ctx.db.delete("ai_chat_threads", f.agentSource.threadId);
			else if (state === "purge fence")
				await ctx.db.patch("organizations_workspaces", f.owner.workspaceId, { pluginDataPurgeStartedAt: Date.now() });
			else await ctx.db.patch("users", f.reader.userId, { deletedAt: Date.now() });
		});
		expect_refused(await read_volume(f));
	});

	test("refuses all read doors after a role change removes content access", async () => {
		const f = await create_volume_fixture();
		expect((await read_volume(f)).full?.content).toBe(volume_text);
		const defaultWorkspaceId = await f.t.run(
			async (ctx) => (await ctx.db.get("organizations", f.owner.organizationId))?.defaultWorkspaceId,
		);
		if (!defaultWorkspaceId) throw new Error("Expected the organization default workspace");
		const role = await f.asOwner.mutation(api.access_control.create_role, {
			organizationId: f.owner.organizationId,
			name: "Workspace maker",
			description: "",
			permissions: ["workspace.create"],
		});
		if (role._nay) throw new Error(role._nay.message);
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.owner.organizationId,
				workspaceId: defaultWorkspaceId,
				userId: f.reader.userId,
				role: role._yay.roleId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.agentSource.membershipId)),
		).toMatchObject({ active: true });
		expect_refused(await read_volume(f));
	});

	test("refuses an old source after leaving and rejoining, while a fresh source reads", async () => {
		const f = await create_volume_fixture();
		expect((await read_volume(f)).full?.content).toBe(volume_text);
		vi.setSystemTime(Date.now() + 5000);
		expect(
			await f.asReader.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userIdToRemove: f.reader.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userIdToAdd: f.reader.userId,
			}),
		).toEqual({ _yay: null });
		expect_refused(await read_volume(f));
		const rejoined = await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", f.owner.workspaceId).eq("userId", f.reader.userId).eq("active", true),
				)
				.unique(),
		);
		if (!rejoined) throw new Error("Expected rejoined membership");
		const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
			userId: f.reader.userId,
			membershipId: rejoined._id,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const source = {
			...f.agentSource,
			membershipId: rejoined._id,
			membershipLifetime: captured._yay.membershipLifetime,
		};
		expect((await read_volume(f, source)).full?.content).toBe(volume_text);
	});

	test("requires the original source and matching reader, tenant, and owning workspace", async () => {
		const f = await create_volume_fixture();
		expect((await read_volume(f)).full?.content).toBe(volume_text);
		expect_refused(await read_volume(f, null));
		expect_refused(await read_volume(f, { ...f.agentSource, userId: f.owner.userId }));
		expect_refused(await read_volume(f, { ...f.agentSource, organizationId: f.reader.organizationId }));
		expect_refused(await read_volume(f, { ...f.agentSource, workspaceId: f.reader.workspaceId }));
	});

	test("keeps a pinned retired generation readable before its files are drained", async () => {
		const f = await create_volume_fixture();
		await f.t.run(async (ctx) => {
			await ctx.db.patch("plugins_volume_generations", f.generationId, {
				status: "retired",
				expiresAt: Date.now() + 10 * 60_000,
			});
			await ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: null });
		});
		expect((await read_volume(f)).full?.content).toBe(volume_text);
	});
});

describe("volume tenant API isolation", () => {
	test.each(["API key", "short grant"] as const)("keeps %s file routes inside the real workspace", async (kind) => {
		const f = await create_volume_fixture();
		expect((await read_volume(f)).full?.content).toBe(volume_text);
		await f.t.run((ctx) => ctx.db.patch("users", f.owner.userId, { clerkUserId: "clerk-volume-api-owner" }));
		const objects = new Map<string, BodyInit>();
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
			const key = customKey ?? "test-upload-key";
			return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
		});
		const getUrl = vi
			.spyOn(R2.prototype, "getUrl")
			.mockImplementation(async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`);
		vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const value = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
				const key = new URL(value).searchParams.get("key");
				if (value.startsWith("https://r2.test/upload?") && init?.method === "PUT" && key) {
					objects.set(key, init.body ?? "");
					return new Response(null, { status: 200 });
				}
				const body = key ? objects.get(key) : undefined;
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
			}),
		);
		const tenantPath = "/tenant-visible.md";
		const tenantId = await test_create_saved_text_file(f.t, {
			membershipId: f.owner.membershipId,
			path: tenantPath,
			textContent: "Tenant visible content.\n",
		});
		let token: string;
		if (kind === "API key") {
			const credential = await f.asOwner.mutation(api.public_api.api_credential_create, {
				membershipId: f.owner.membershipId,
				serviceAccountId: null,
				name: "Mount isolation",
				scopes: ["files:list", "files:read", "files:download"],
			});
			if (credential._nay) throw new Error(credential._nay.message);
			token = credential._yay.credential;
		} else {
			token = "8".repeat(64);
			await f.t.mutation(internal.public_api.create_grant, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.owner.userId,
				threadId: null,
				principalKey: "grant-volume-api-test",
				tokenHash: await crypto_sha256_hex(token),
				scopes: ["files:list", "files:read", "files:download"],
				pathPrefix: null,
				now: Date.now(),
			});
		}
		const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
		const root = await f.t.fetch("/api/v1/files/list", {
			method: "POST",
			headers,
			body: JSON.stringify({ path: "/", recursive: true }),
		});
		expect(root.status).toBe(200);
		expect(await root.json()).toMatchObject({ items: [{ path: tenantPath }] });
		const visible = await f.t.fetch("/api/v1/files/read", {
			method: "POST",
			headers,
			body: JSON.stringify({ path: tenantPath }),
		});
		expect(visible.status).toBe(200);
		expect(await visible.json()).toMatchObject({ content: expect.stringContaining("Tenant visible") });
		for (const path of [f.rootPath, "/.mounts/sources/repo"]) {
			const response = await f.t.fetch("/api/v1/files/list", {
				method: "POST",
				headers,
				body: JSON.stringify({ path, recursive: true }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ items: [] });
		}
		const volumePaths = [f.path, "/.mounts/sources/repo/notes.md"];
		for (const path of volumePaths) {
			const text = await f.t.fetch("/api/v1/files/read", {
				method: "POST",
				headers,
				body: JSON.stringify({ path }),
			});
			expect(text.status).toBe(404);
			const bytes = await f.t.fetch("/api/v1/files/read-bytes", {
				method: "POST",
				headers,
				body: JSON.stringify({ path, offset: 0, length: 20, revision: null }),
			});
			expect(bytes.status).toBe(404);
		}
		const many = await f.t.fetch("/api/v1/files/read-many", {
			method: "POST",
			headers,
			body: JSON.stringify({ paths: [tenantPath, ...volumePaths] }),
		});
		expect(many.status).toBe(200);
		const manyBody = (await many.json()) as { files: Array<{ path: string }>; errors: Array<{ path: string }> };
		expect(manyBody.files.map((file) => file.path)).toEqual([tenantPath]);
		expect(manyBody.errors.map((error) => error.path)).toEqual(volumePaths);
		expect(JSON.stringify(manyBody)).not.toContain("Zorptelemetry");
		getUrl.mockClear();
		const download = await f.t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers,
			body: JSON.stringify({ fileNodeIds: [tenantId, f.nodeId] }),
		});
		if (kind === "API key") {
			expect(download.status).toBe(200);
			expect(await download.json()).toMatchObject({
				items: [{ fileNodeId: tenantId }],
				errors: [{ fileNodeId: f.nodeId, message: "Not found" }],
			});
			expect(getUrl.mock.calls.some(([key]) => key === f.r2Key)).toBe(false);
		} else {
			expect(download.status).toBe(403);
			expect(getUrl).not.toHaveBeenCalled();
		}
	});

	test("keeps tenant search and metadata queries outside volume storage", async () => {
		const f = await create_volume_fixture();
		const read = await read_volume(f);
		expect(read.search.items).toMatchObject([{ path: f.path }]);
		expect(read.metadataSearch.items).toMatchObject([{ path: f.path }]);
		const args = {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			userId: f.owner.userId,
		};
		expect(
			await f.t.query(internal.files_nodes.text_search_files, {
				...args,
				hasWorkspaceRead: true,
				query: "Zorptelemetry",
				numItems: 10,
				cursor: null,
			}),
		).toMatchObject({ items: [] });
		expect(
			await test_meta_search(f.t, {
				...args,
				plan: { op: "eq", fieldPath: "metadata.status", value: "published" },
			}),
		).toMatchObject({ items: [] });
		for (const path of [f.path, "/.mounts/sources/repo/notes.md"]) {
			expect(await f.t.query(internal.files_metadata.get_by_path, { ...args, path })).toBeNull();
		}
	});
});

describe("volume action final checks", () => {
	for (const action of ["full", "head", "tail", "wc"] as const) {
		test.each(["disable", "replace"] as const)(`${action} refuses bytes after %s during R2 I/O`, async (change) => {
			const f = await create_volume_fixture();
			// Force the R2 branch, so the test reaches the final check instead of a chunk query.
			await f.t.run(async (ctx) => {
				for (const table of ["files_text_chunks", "files_plain_text_chunks"] as const) {
					const chunks = await ctx.db.query(table).collect();
					for (const chunk of chunks) await ctx.db.delete(table, chunk._id);
				}
				await ctx.db.patch("files_nodes", f.nodeId, { statsId: null });
			});
			const fetch = vi.fn(async () => new Response(volume_text));
			vi.stubGlobal("fetch", fetch);
			const args = { ...f.scope, userId: f.reader.userId, path: f.path, agentSource: f.agentSource };
			const read = () => {
				if (action === "full")
					return f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, args);
				if (action === "head")
					return f.t.action(internal.files_nodes_content.read_file_line_range, { ...args, startLine: 1, maxLines: 1 });
				if (action === "tail")
					return f.t.action(internal.files_nodes_content.read_file_tail_lines, { ...args, maxLines: 1 });
				return f.t.action(internal.files_nodes_content.read_file_content_stats, args);
			};
			expect(await read()).not.toBeNull();
			expect(fetch).toHaveBeenCalledOnce();
			fetch.mockClear();
			let changed = false;
			fetch.mockImplementation(async () => {
				await f.t.run(async (ctx) => {
					if (change === "disable") {
						await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
					} else {
						const node = (await ctx.db.get("files_nodes", f.nodeId))!;
						const { _id, _creationTime, ...fields } = node;
						await ctx.db.delete("files_nodes", _id);
						await ctx.db.insert("files_nodes", fields);
					}
				});
				changed = true;
				return new Response(volume_text);
			});
			expect(await read()).toBeNull();
			expect(changed).toBe(true);
			expect(fetch).toHaveBeenCalledOnce();
		});
	}
});

describe("volume content storage", () => {
	test("stores large plain text within the concurrent I/O limit", async () => {
		const f = await create_volume_fixture();
		const text = `${"x".repeat(600)}\n`.repeat(1_490);
		let mostPendingInserts = 0;
		const path = `${f.rootPath}/large.txt`;
		await f.t.run(async (ctx) => {
			const insert = ctx.db.insert.bind(ctx.db);
			let pendingInserts = 0;
			ctx.db.insert = async (table, document) => {
				pendingInserts += 1;
				mostPendingInserts = Math.max(mostPendingInserts, pendingInserts);
				try {
					return await insert(table, document);
				} finally {
					pendingInserts -= 1;
				}
			};
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				...f.scope,
				userId: users_SYSTEM_AUTHOR,
				parentId: f.rootId,
				path: "large.txt",
				kind: "file",
				contentType: "text/plain;charset=utf-8",
				assetId: f.assetId,
				expectsTextContent: true,
				now: Date.now(),
			});
			if (created._nay) throw new Error(created._nay.message);
			await files_nodes_db_insert_file_content_docs(ctx, {
				...f.scope,
				nodeId: created._yay,
				path,
				parentId: f.rootId,
				contentType: "text/plain;charset=utf-8",
				rootKind: "plain_text",
				textContent: text,
				readOnly: true,
				userId: users_SYSTEM_AUTHOR,
				now: Date.now(),
			});
		});
		expect(mostPendingInserts, "large text must stay within 1,000 concurrent I/O calls").toBeLessThanOrEqual(1_000);
		const read = await f.t.query(internal.files_nodes.read_file_content_from_chunks, {
			...f.scope,
			userId: f.reader.userId,
			agentSource: f.agentSource,
			path,
			mode: { kind: "full", maxBytes: 900_000 },
		});
		expect(read?.content).toBe(text);
	});

	test("creates and materializes SYSTEM text through trusted helpers after the reader leaves", async () => {
		const f = await create_volume_fixture();
		const created = await f.t.run(async (ctx) => {
			await ctx.db.delete("organizations_workspaces_users", f.agentSource.membershipId);
			const result = await files_nodes_db_create_node_recursively_at_path(ctx, {
				...f.scope,
				userId: users_SYSTEM_AUTHOR,
				parentId: f.rootId,
				path: "created.md",
				kind: "file",
				contentType: "text/markdown;charset=utf-8",
				assetId: f.assetId,
				expectsTextContent: true,
				now: Date.now(),
			});
			if (result._nay) throw new Error(result._nay.message);
			await files_nodes_db_insert_file_content_docs(ctx, {
				...f.scope,
				nodeId: result._yay,
				path: `${f.rootPath}/created.md`,
				parentId: f.rootId,
				contentType: "text/markdown;charset=utf-8",
				rootKind: "plain_text",
				textContent: volume_text,
				readOnly: true,
				userId: users_SYSTEM_AUTHOR,
				now: Date.now(),
			});
			return {
				node: await ctx.db.get("files_nodes", result._yay),
				chunks: await ctx.db
					.query("files_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.volumeId).eq("fileNodeId", result._yay),
					)
					.collect(),
			};
		});
		expect(created.node).toMatchObject({
			createdBy: users_SYSTEM_AUTHOR,
			textKind: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
		});
		expect(created.chunks.map((chunk) => chunk.textChunk).join("")).toBe(volume_text);
		expect(created.chunks.every((chunk) => chunk.sourceKind === "committed" && chunk.yjsSequence === undefined)).toBe(
			true,
		);
		expect(await f.t.run((ctx) => ctx.db.query("files_yjs_snapshots").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("refuses editable content in a volume", async () => {
		const f = await create_volume_fixture();
		await expect(
			f.t.run((ctx) =>
				files_nodes_db_insert_file_content_docs(ctx, {
					...f.scope,
					nodeId: f.nodeId,
					path: f.path,
					contentType: "text/markdown;charset=utf-8",
					rootKind: "plain_text",
					textContent: volume_text,
					readOnly: false,
					userId: users_SYSTEM_AUTHOR,
					now: Date.now(),
				}),
			),
		).rejects.toThrow("Editable text content requires a real workspaceId");
	});

	test("skips a volume media clock while keeping organization-wide null scope", async () => {
		const f = await create_volume_fixture();
		const clocks = await f.t.run(async (ctx) => {
			const before = await ctx.db.query("files_media_validation_versions").collect();
			await files_media_validation_db_advance_version(ctx, f.scope);
			const afterVolume = await ctx.db.query("files_media_validation_versions").collect();
			await files_media_validation_db_advance_version(ctx, {
				organizationId: f.scope.organizationId,
				workspaceId: null,
			});
			const organizationClock = await ctx.db
				.query("files_media_validation_versions")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", f.scope.organizationId).eq("workspaceId", null),
				)
				.unique();
			return { before, afterVolume, organizationClock };
		});
		expect(clocks.afterVolume).toEqual(clocks.before);
		expect(clocks.organizationClock?.revision).toBeGreaterThan(0);
	});
});

describe("volume R2 cleanup", () => {
	test("deletes an expired volume asset inline without a real-workspace job", async () => {
		const f = await create_volume_fixture();
		const deleteObject = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const assetId = await f.t.run((ctx) =>
			ctx.db.insert("files_r2_assets", {
				...f.scope,
				kind: "content",
				r2Bucket: r2.config.bucket,
				size: 64,
				createdBy: users_SYSTEM_AUTHOR,
				unfinalizedExpiresAt: Date.now() - 1,
				updatedAt: Date.now(),
			}),
		);
		const swept = await f.t.mutation(internal.r2.cleanup_expired_unfinalized_assets, { _test_now: Date.now() });
		expect(swept.deletedCount).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId))).toBeNull();
		expect(deleteObject).toHaveBeenCalledWith(
			expect.anything(),
			`organizations/${f.scope.organizationId}/workspaces/${f.volumeId}/assets/${assetId}`,
		);
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual([]);
	});

	test("deletes only a late volume event key and preserves live or foreign-scope assets", async () => {
		const f = await create_volume_fixture();
		const deleteObject = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const event = { bucket: r2.config.bucket, size: 20, eventId: "volume-late-put" };
		expect(await f.t.mutation(internal.r2.record_untracked_asset_event, { ...event, key: f.r2Key })).toBe("ignored");
		expect(
			await f.t.mutation(internal.r2.record_untracked_asset_event, {
				...event,
				key: `organizations/${f.scope.organizationId}/workspaces/${f.owner.workspaceId}/assets/${f.assetId}`,
			}),
		).toBe("ignored");
		expect(deleteObject).not.toHaveBeenCalled();
		await f.t.run((ctx) => ctx.db.delete("files_r2_assets", f.assetId));
		expect(await f.t.mutation(internal.r2.record_untracked_asset_event, { ...event, key: f.r2Key })).toBe("recorded");
		expect(deleteObject).toHaveBeenCalledWith(expect.anything(), f.r2Key);
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual([]);
	});
});
