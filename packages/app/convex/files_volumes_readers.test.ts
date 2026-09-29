import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import { db_insert_file_text_content } from "./files_nodes_content.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "volume-readers",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const agentSource = {
		...db,
		threadId: created._yay.threadId,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	const saved = await t.run(async (ctx) => {
		const now = Date.now();
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "repo-reader",
			displayName: "Repo Reader",
			version: "1.0.0",
			description: "",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: "hash",
			sourceRepositoryUrl: "https://github.test/acme/repo-reader",
			sourceOwner: "acme",
			sourceRepo: "repo-reader",
			sourceCommitSha: "sha",
			manifestR2Key: "manifest",
			backendEntrypointFile: null,
			configuration: null,
			mounts: [],
			events: [],
			pages: [],
			fileViews: [],
			capabilities: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "mcp-servers-hash",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: db.userId,
			updatedAt: now,
		});
		const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			name: "repo-reader",
			createdBy: db.userId,
			createdAt: now,
			updatedAt: now,
			revokedAt: null,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			serviceAccountId,
			pluginVersionId,
			pluginName: "repo-reader",
			status: "enabled",
			managementAccess: "selected",
			configurationYaml: null,
			acceptedCapabilities: [],
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
			installedBy: db.userId,
			updatedBy: db.userId,
			updatedAt: now,
		});
		const volumeId = await ctx.db.insert("plugins_volumes", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			installationId,
			mountId: "repos",
			volumeKey: "acme/repo",
			publishedGenerationId: null,
			createdAt: now,
			deleteRequestedAt: null,
			drainScheduledUntil: null,
		});
		const nodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: volumeId,
			parentId: "root",
			name: "note.md",
			sortName: "note.md",
			path: "/note.md",
			treePath: "/note.md",
			kind: "file",
			lowercaseExtension: "md",
			contentType: "text/markdown",
			textKind: null,
			collaborationEnabled: null,
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
		});
		const content = await db_insert_file_text_content(ctx, {
			organizationId: db.organizationId,
			workspaceId: volumeId,
			nodeId,
			path: "/note.md",
			rootKind: "plain_text",
			textContent: "Saved volume content\n",
		});
		if (content._nay) throw new Error(content._nay.message);
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		if (!fileNode) throw new Error("Expected a saved volume file");
		await files_metadata_db_write_entries(ctx, {
			fileNode,
			entries: [
				{ key: "source", value: "plugin-volume" },
				{ key: "volume-path", value: "note.md" },
			],
		});
		return { volumeId, installationId, nodeId };
	});
	const readArgs = {
		organizationId: db.organizationId,
		workspaceId: saved.volumeId,
		userId: db.userId,
		agentSource,
	};
	const listArgs = {
		organizationId: db.organizationId,
		workspaceId: saved.volumeId,
		visibilityUserId: db.userId,
		overlayUserId: db.userId,
		agentSource,
		folderPath: "/",
		mode: "children" as const,
		numItems: 10,
		cursor: null,
	};
	return { t, db, ...saved, readArgs, listArgs };
}

describe("internal_list volume reads", () => {
	test("forwards the original source to saved pages and ignores the owner overlay", async () => {
		const f = await fixture();
		const result = await f.t.query(internal.files_visible.internal_list, f.listArgs);
		expect(result._yay?.items).toMatchObject([{ target: { kind: "saved", id: f.nodeId }, path: "/note.md" }]);
		expect(result._yay?.isDone).toBe(true);
		for (const kind of ["private", "moved"] as const) {
			const page = await f.t.query(internal.files_visible.internal_page, {
				organizationId: f.db.organizationId,
				workspaceId: f.volumeId,
				visibilityUserId: f.db.userId,
				agentSource: f.readArgs.agentSource,
				kind,
				parent: { kind: "root" },
				cursor: null,
				timeOrder: false,
				order: "asc",
			});
			expect(page).toEqual({ target: null, savedNode: null, cursor: "", done: true });
		}
	});

	test("refuses a missing source and an installation disabled between pages", async () => {
		const f = await fixture();
		expect(
			await f.t.query(internal.files_visible.internal_list, { ...f.listArgs, agentSource: undefined }),
		).toEqual({ _yay: { items: [], continueCursor: null, isDone: true } });
		const first = await f.t.query(internal.files_visible.internal_list, { ...f.listArgs, numItems: 1 });
		expect(first._yay?.items).toHaveLength(1);
		await f.t.run((ctx) => ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" }));
		expect(
			await f.t.query(internal.files_visible.internal_list, { ...f.listArgs, cursor: first._yay!.continueCursor }),
		).toEqual({ _yay: { items: [], continueCursor: null, isDone: true } });
	});
});

describe("get_by_path volume metadata", () => {
	test("reads committed fields only with the original live chat source", async () => {
		const f = await fixture();
		const args = { ...f.readArgs, path: "/note.md" };
		expect(await f.t.query(internal.files_metadata.get_by_path, args)).toMatchObject({
			target: { kind: "saved", id: f.nodeId },
			sourceKind: "committed",
			values: [
				{ fieldPath: "metadata.source", valueKind: "string", stringValue: "plugin-volume" },
				{ fieldPath: "metadata.volume-path", valueKind: "string", stringValue: "note.md" },
			],
		});
		expect(await f.t.query(internal.files_metadata.get_by_path, { ...args, agentSource: undefined })).toBeNull();
		expect(
			await f.t.query(internal.files_metadata.get_by_path, {
				...args,
				agentSource: { ...args.agentSource, membershipLifetime: args.agentSource.membershipLifetime + 1 },
			}),
		).toBeNull();
		await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", args.agentSource.threadId, { archived: true }));
		expect(await f.t.query(internal.files_metadata.get_by_path, args)).toBeNull();
	});
});

describe("search volume metadata", () => {
	test("checks volume authority before resolving saved search hits", async () => {
		const f = await fixture();
		const args = {
			...f.readArgs,
			plan: { op: "eq" as const, fieldPath: "metadata.source", value: "plugin-volume" },
			numItems: 10,
			cursor: null,
		};
		expect((await f.t.query(internal.files_metadata.search, args)).items).toMatchObject([
			{
				target: { kind: "saved", id: f.nodeId },
				path: "/note.md",
				sourceKind: "committed",
				fieldPath: "metadata.source",
				stringValue: "plugin-volume",
			},
		]);
		expect(await f.t.query(internal.files_metadata.search, { ...args, agentSource: undefined })).toEqual({
			items: [],
			continueCursor: "",
			isDone: true,
		});
		await f.t.run((ctx) => ctx.db.patch("plugins_volumes", f.volumeId, { deleteRequestedAt: Date.now() }));
		expect(await f.t.query(internal.files_metadata.search, args)).toEqual({ items: [], continueCursor: "", isDone: true });
	});
});
