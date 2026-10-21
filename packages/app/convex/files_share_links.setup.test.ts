// Fixtures shared by the files_share_links test files.
import { expect, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_create_saved_text_file, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	plugins_data_db_apply_file_access_binding,
	plugins_data_db_prepare_file_access_binding,
} from "./plugins_data.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

// Each test file calls this in `beforeEach`.
export function mock_share_storage() {
	// Keep scheduled subtree op steps from running, so a test can look at a folder while its op runs.
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
}

export type TestConvex = ReturnType<typeof test_convex>;

/**
 * An organization owner with one saved Markdown file, plus a second member with the `member` role.
 */
export async function fixture(args: { memberRole?: "member" | "admin" } = {}) {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const memberId = await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId: null });
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			role: args.memberRole ?? "member",
			now,
		});
		return userId;
	});
	const memberMembershipId = await t.run(async (ctx) => {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", db.workspaceId).eq("userId", memberId))
			.first();
		return membership!._id;
	});
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/doc.md",
		textContent: "Hi",
	});
	return {
		t,
		db,
		nodeId,
		memberId,
		memberMembershipId,
		asOwner: t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId }),
		asMember: t.withIdentity({ issuer: "https://clerk.test", external_id: memberId }),
	};
}

/**
 * Each refused call still costs a rate-limit token, so reset them between calls.
 */
export async function reset_rate_limits(t: TestConvex, userIds: Id<"users">[]) {
	await t.run(async (ctx) => {
		for (const userId of userIds) {
			for (const name of ["files_sharing_write", "files_tree_write", "roles_write"]) {
				await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name, key: userId });
			}
		}
	});
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A plugin installation in the fixture workspace with one private space `team`, for binding tests.
 */
export async function insert_installation(f: Fixture) {
	const installationId = await f.t.run(async (ctx) =>
		ctx.db.insert("plugins_workspace_installations", {
			serviceAccountId: await ctx.db.insert("access_control_service_accounts", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				name: "Chat",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			pluginVersionId: await ctx.db.insert("plugins_versions", {
				name: "chat",
				displayName: "Chat",
				version: "1.0.0",
				description: "",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: "hash",
				sourceRepositoryUrl: "https://github.test/acme/chat",
				sourceOwner: "acme",
				sourceRepo: "chat",
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
				createdBy: f.db.userId,
				updatedAt: Date.now(),
				secrets: [],
				endpoints: [],
				userWritableCollections: null,
			}),
			pluginName: "chat",
			status: "enabled",
			managementAccess: "selected",
			configurationYaml: null,
			acceptedCapabilities: [],
			capabilitiesAcceptedAt: Date.now(),
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
			outboundOriginsAcceptedAt: Date.now(),
			sandbox: { roots: [], rebuild: null },
			installedBy: f.db.userId,
			updatedBy: f.db.userId,
			updatedAt: Date.now(),
		}),
	);
	await f.t.run((ctx) =>
		ctx.db.insert("plugins_data_scopes", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			scopeId: "team",
			collection: "messages",
			keyPrefix: "team/",
			createdByUserId: f.db.userId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastAppend: null,
			appendSequence: 0,
		}),
	);
	return installationId;
}

/**
 * Bind a folder to a private space, or detach it with `null`, through the same prepare step as the plugin API.
 */
export function apply_binding(
	f: Fixture,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		folderId: Id<"files_nodes">;
		readScopeId: string | null;
	},
) {
	return f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", args.installationId))!;
		const node = (await ctx.db.get("files_nodes", args.folderId))!;
		const prepared = await plugins_data_db_prepare_file_access_binding(ctx, {
			installation,
			nodeId: node._id,
			parentId: node.parentId,
			readScopeId: args.readScopeId,
		});
		expect(prepared._nay).toBeUndefined();
		await plugins_data_db_apply_file_access_binding(ctx, {
			installation,
			node,
			prepared: prepared._yay!,
			userId: f.db.userId,
		});
	});
}

/**
 * Bind a node like the plugin API allows it: restrict it, let its scope job end, then bind it to `team`.
 */
export async function restrict_and_bind(f: Fixture, nodeId: Id<"files_nodes">) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const restricted = await f.asOwner.mutation(api.files_sharing.restrict_node, {
		membershipId: f.db.membershipId,
		nodeId,
	});
	expect(restricted._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const installationId = await insert_installation(f);
	await apply_binding(f, { installationId, folderId: nodeId, readScopeId: "team" });
	return installationId;
}

/**
 * Restrict the folder of a new file at `${path}/notes.md` and let its scope job end.
 */
export async function create_restricted_folder(f: Fixture, path: string) {
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: `${path}/notes.md` });
	const folderId = (await f.t.run((ctx) => ctx.db.get("files_nodes", fileId)))!.parentId as Id<"files_nodes">;
	await reset_rate_limits(f.t, [f.db.userId]);
	expect(
		(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: folderId }))
			._nay,
	).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	return { fileId, folderId };
}

/**
 * Make `/big/zz.md` with `siblingCount` sibling folders. The file sorts after every sibling, so a job
 * step that stops before the last sibling does not reach it.
 */
export async function seed_big_folder(f: Fixture, siblingCount: number) {
	const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/big/zz.md" });
	const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	const folderId = node!.parentId as Id<"files_nodes">;
	await f.t.run(async (ctx) => {
		for (let index = 0; index < siblingCount; index++) {
			const name = `f${String(index).padStart(3, "0")}`;
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: folderId,
				name,
				sortName: files_sort_text_key(name),
				path: `/big/${name}`,
				treePath: `/big/${name}/`,
				pathDepth: 2,
			});
		}
	});
	return { nodeId, folderId };
}

export function read_links(t: TestConvex, nodeId: Id<"files_nodes">) {
	return t.run((ctx) =>
		ctx.db
			.query("files_share_links")
			.filter((q) => q.eq(q.field("nodeId"), nodeId))
			.collect(),
	);
}

export async function link_on(f: Fixture, nodeId: Id<"files_nodes">) {
	await reset_rate_limits(f.t, [f.db.userId]);
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId,
			enabled: true,
		}),
	).toEqual({ _yay: null });
	const [link] = await read_links(f.t, nodeId);
	return link!;
}

/**
 * Turn "Anyone on the web" on or off as the owner, and let the scope job of a folder end.
 */
export async function set_public(f: Fixture, nodeId: Id<"files_nodes">, enabled = true) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const result = await f.asOwner.mutation(api.files_sharing.set_node_public, {
		membershipId: f.db.membershipId,
		nodeId,
		enabled,
	});
	expect(result._nay).toBeUndefined();
	// Only a folder starts a scope job. A file schedules nothing, so the jobs of other writes keep waiting.
	const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	if (node?.kind === "folder") {
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	}
	return result._yay!;
}

/**
 * A finished image or video file. Seeded directly, because the public view only reads it.
 */
export function insert_media_file(
	f: Fixture,
	args: {
		parentId: Id<"files_nodes"> | "root";
		path: string;
		contentType: string;
		/** Make it a public root itself, like "Anyone on the web" on the file. */
		public?: true;
	},
) {
	return f.t.run(async (ctx) => {
		const name = args.path.split("/").at(-1)!;
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			kind: "upload",
			r2Bucket: "test",
			r2Key: `test${args.path}`,
			size: 4,
			createdBy: f.db.userId,
			updatedAt: Date.now(),
		});
		const nodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			parentId: args.parentId,
			kind: "file",
			name,
			sortName: files_sort_text_key(name),
			path: args.path,
			treePath: args.path,
			pathDepth: args.path.split("/").length - 1,
			lowercaseExtension: name.split(".").at(-1)!,
			contentType: args.contentType,
			assetId,
			contentByteSize: 4,
		});
		if (args.public) {
			await ctx.db.patch("files_nodes", nodeId, { publicScopeNodeId: nodeId });
		}
		return nodeId;
	});
}

/**
 * A restricted folder at the workspace root. Seeded directly, so no restrict job runs.
 */
export function insert_restricted_folder(f: Fixture, name: string) {
	return f.t.run(async (ctx) => {
		const folderId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			parentId: "root",
			name,
			sortName: files_sort_text_key(name),
			path: `/${name}`,
			treePath: `/${name}/`,
			pathDepth: 1,
			isRestrictedScopeRoot: true,
		});
		await ctx.db.patch("files_nodes", folderId, { restrictedScopeNodeId: folderId });
		return folderId;
	});
}

export function view_of(f: Fixture, token: string) {
	return f.t.query(api.files_share_links.get_share_link_view, { token });
}
