import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_create_saved_text_file, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	access_control_db_ensure_role_assignment,
	access_control_db_set_service_account_grant,
} from "./access_control.ts";
import {
	files_nodes_db_get_content_version,
	files_nodes_db_move_nodes,
	files_nodes_db_set_restricted_scope,
} from "./files_nodes.ts";
import {
	files_share_links_create_cleanup_state,
	files_share_links_db_delete_for_roots,
	files_share_links_MAX_PER_WORKSPACE,
} from "./files_share_links_db.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import { organizations_db_create_workspace } from "./organizations.ts";
import {
	plugins_data_db_apply_file_access_binding,
	plugins_data_db_prepare_file_access_binding,
} from "./plugins_data.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";

// Record the cleanup state that each link delete gets, so a batch test can check that the batch loads the
// workspace links only once.
vi.mock("./files_share_links_db.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("./files_share_links_db.ts")>();
	return {
		...original,
		files_share_links_db_delete_for_roots: vi.fn(original.files_share_links_db_delete_for_roots),
	};
});

beforeEach(() => {
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
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

type TestConvex = ReturnType<typeof test_convex>;

/**
 * An organization owner with one saved Markdown file, plus a second member with the `member` role.
 */
async function fixture(args: { memberRole?: "member" | "admin" } = {}) {
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
async function reset_rate_limits(t: TestConvex, userIds: Id<"users">[]) {
	await t.run(async (ctx) => {
		for (const userId of userIds) {
			for (const name of ["files_sharing_write", "files_tree_write", "roles_write"]) {
				await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name, key: userId });
			}
		}
	});
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A plugin installation in the fixture workspace with one private space `team`, for binding tests.
 */
async function insert_installation(f: Fixture) {
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
		}),
	);
	return installationId;
}

/**
 * Bind a folder to a private space, or detach it with `null`, through the same prepare step as the plugin API.
 */
function apply_binding(
	f: Fixture,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		folderId: Id<"files_nodes">;
		readScopeId: string | null;
	},
) {
	return f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", args.installationId))!;
		const prepared = await plugins_data_db_prepare_file_access_binding(ctx, {
			installation,
			nodeId: args.folderId,
			readScopeId: args.readScopeId,
		});
		expect(prepared._nay).toBeUndefined();
		await plugins_data_db_apply_file_access_binding(ctx, {
			installation,
			node: (await ctx.db.get("files_nodes", args.folderId))!,
			prepared: prepared._yay!,
			userId: f.db.userId,
		});
	});
}

/**
 * Make `/big/zz.md` with `siblingCount` sibling folders. The file sorts after every sibling, so a job
 * step that stops before the last sibling does not reach it.
 */
async function seed_big_folder(f: Fixture, siblingCount: number) {
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

function read_links(t: TestConvex, nodeId: Id<"files_nodes">) {
	return t.run((ctx) =>
		ctx.db
			.query("files_share_links")
			.filter((q) => q.eq(q.field("nodeId"), nodeId))
			.collect(),
	);
}

describe("set_node_share_link", () => {
	test("On makes a token, a second On keeps it, and Off then On makes a new one", async () => {
		const f = await fixture();
		const args = { membershipId: f.db.membershipId, nodeId: f.nodeId };

		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: true })).toEqual({
			_yay: null,
		});
		const first = await f.asOwner.query(api.files_sharing.get_node_share_state, args);
		expect(first?.link?.token).toMatch(/^[0-9a-f]{64}$/);
		expect(first?.link?.createdBy).toBe(f.db.userId);

		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: true })).toEqual({
			_yay: null,
		});
		const again = await f.asOwner.query(api.files_sharing.get_node_share_state, args);
		expect(again?.link?.token).toBe(first?.link?.token);
		expect(await read_links(f.t, f.nodeId)).toHaveLength(1);

		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: false })).toEqual({
			_yay: null,
		});
		expect((await f.asOwner.query(api.files_sharing.get_node_share_state, args))?.link).toBeNull();
		expect(await read_links(f.t, f.nodeId)).toHaveLength(0);

		// Off without a link is still a success.
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: false })).toEqual({
			_yay: null,
		});

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: true })).toEqual({
			_yay: null,
		});
		const fresh = await f.asOwner.query(api.files_sharing.get_node_share_state, args);
		expect(fresh?.link?.token).toMatch(/^[0-9a-f]{64}$/);
		expect(fresh?.link?.token).not.toBe(first?.link?.token);

		const [link] = await read_links(f.t, f.nodeId);
		expect(link).toMatchObject({
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			restrictedScopeNodeId: null,
			ancestorNodeIds: [],
		});
	});

	test("a reader without manage sharing cannot change the link and never gets the token", async () => {
		const f = await fixture();

		const refused = await f.asMember.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.memberMembershipId,
			nodeId: f.nodeId,
			enabled: true,
		});
		expect(refused._nay?.message).toBe("Permission denied");
		expect(await read_links(f.t, f.nodeId)).toHaveLength(0);

		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: true,
		});
		const memberState = await f.asMember.query(api.files_sharing.get_node_share_state, {
			membershipId: f.memberMembershipId,
			nodeId: f.nodeId,
		});
		// Control: the member reads the rest of the dialog, so the null below is the token rule.
		expect(memberState?.nodeId).toBe(f.nodeId);
		expect(memberState?.link).toBeNull();

		const refusedOff = await f.asMember.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.memberMembershipId,
			nodeId: f.nodeId,
			enabled: false,
		});
		expect(refusedOff._nay?.message).toBe("Permission denied");
		expect(await read_links(f.t, f.nodeId)).toHaveLength(1);
	});

	test("an admin manages the link of an open file", async () => {
		const f = await fixture({ memberRole: "admin" });
		const args = { membershipId: f.memberMembershipId, nodeId: f.nodeId };

		expect(await f.asMember.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: true })).toEqual({
			_yay: null,
		});
		const state = await f.asMember.query(api.files_sharing.get_node_share_state, args);
		expect(state?.link?.createdBy).toBe(f.memberId);
	});

	test("an anonymous manager cannot turn a link on but can turn it off", async () => {
		const f = await fixture();
		const asAnonymousOwner = f.t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: f.db.userId });
		const args = { membershipId: f.db.membershipId, nodeId: f.nodeId };

		const refused = await asAnonymousOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: true });
		expect(refused._nay?.message).toBe("Sign in to create a public link");
		expect(await read_links(f.t, f.nodeId)).toHaveLength(0);

		await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: true });
		expect(await asAnonymousOwner.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: false })).toEqual(
			{ _yay: null },
		);
		expect(await read_links(f.t, f.nodeId)).toHaveLength(0);
	});

	test("refuses a node of another workspace", async () => {
		const f = await fixture();
		const other = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org", workspaceName: "other" }),
		);
		const otherNodeId = await test_create_saved_text_file(f.t, { membershipId: other.membershipId, path: "/x.md" });

		const refused = await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: otherNodeId,
			enabled: true,
		});
		expect(refused._nay?.message).toBe("Not found");
		expect(await read_links(f.t, otherNodeId)).toHaveLength(0);
	});

	test("refuses a manager who cannot read the file", async () => {
		const f = await fixture();
		// Roles made before "manage sharing includes view" can still be stored like this.
		await f.t.run(async (ctx) => {
			const now = Date.now();
			const roleId = await ctx.db.insert("access_control_roles", {
				organizationId: f.db.organizationId,
				name: "Old curator",
				normalizedName: "old curator",
				description: "",
				permissions: ["content.permissions.manage"],
				createdBy: f.db.userId,
				createdAt: now,
				updatedAt: now,
			});
			const assignment = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId).eq("userId", f.memberId),
				)
				.first();
			await ctx.db.patch("access_control_role_assignments", assignment!._id, { role: roleId });
		});

		const refused = await f.asMember.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.memberMembershipId,
			nodeId: f.nodeId,
			enabled: true,
		});
		expect(refused._nay?.message).toBe('You need "View workspace content" on this file to create a public link');
		expect(await read_links(f.t, f.nodeId)).toHaveLength(0);
	});

	test("refuses folders, stored text blobs, and unfinished uploads", async () => {
		const f = await fixture();
		const on = (nodeId: Id<"files_nodes">) =>
			f.asOwner.mutation(api.files_sharing.set_node_share_link, {
				membershipId: f.db.membershipId,
				nodeId,
				enabled: true,
			});

		const folder = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "folder",
		});
		expect((await on(folder._yay!.nodeId))._nay?.message).toBe("Only a file can have a public link");

		// A text type stored as plain bytes has no committed text for the public reader.
		await f.t.run((ctx) => ctx.db.patch("files_nodes", f.nodeId, { textKind: null }));
		expect((await on(f.nodeId))._nay?.message).toBe("This type of file cannot have a public link");
		await f.t.run((ctx) => ctx.db.patch("files_nodes", f.nodeId, { textKind: "rich_text" }));

		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId));
		await f.t.run((ctx) =>
			ctx.db.patch("files_r2_assets", node!.assetId!, { unfinalizedExpiresAt: Date.now() + 1000 }),
		);
		await reset_rate_limits(f.t, [f.db.userId]);
		expect((await on(f.nodeId))._nay?.message).toBe("Wait until this file finishes uploading");
		expect(await read_links(f.t, f.nodeId)).toHaveLength(0);

		// Control: the same file with a finished upload gets its link.
		await f.t.run((ctx) => ctx.db.patch("files_r2_assets", node!.assetId!, { unfinalizedExpiresAt: undefined }));
		expect(await on(f.nodeId)).toEqual({ _yay: null });
	});

	test("refuses a file a plugin controls, on the file or on a folder above it", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/team/notes.md" });
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const folderId = node!.parentId as Id<"files_nodes">;
		const installationId = await insert_installation(f);
		const bindingId = await f.t.run(async (ctx) => {
			return await ctx.db.insert("plugins_file_access_bindings", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId,
				scopeId: "team",
				nodeId,
				updatedAt: Date.now(),
			});
		});
		const turn_on = () =>
			f.asOwner.mutation(api.files_sharing.set_node_share_link, {
				membershipId: f.db.membershipId,
				nodeId,
				enabled: true,
			});

		// A plugin can bind one file, not only a folder.
		expect((await turn_on())._nay?.message).toBe(
			"A plugin decides who can read this file, so it cannot have a public link",
		);

		await f.t.run((ctx) => ctx.db.patch("plugins_file_access_bindings", bindingId, { nodeId: folderId }));
		expect((await turn_on())._nay?.message).toBe(
			"A plugin decides who can read this file, so it cannot have a public link",
		);

		await f.t.run((ctx) => ctx.db.delete("plugins_file_access_bindings", bindingId));
		expect(await turn_on()).toEqual({ _yay: null });
		expect((await read_links(f.t, nodeId))[0]?.ancestorNodeIds).toEqual([folderId]);
	});

	test("refuses a file in a plugin's external folder until a human sharing change detaches it", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/out/report.md" });
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const folderId = node!.parentId as Id<"files_nodes">;
		const installationId = await insert_installation(f);
		const bindingId = await f.t.run(async (ctx) => {
			const writerId = await ctx.db.insert("plugins_external_file_writers", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId,
				resourceKey: "out",
				rootNodeId: folderId,
				folderNodeId: folderId,
				rootPath: "/out",
				path: "/out",
				generation: 1,
				updatedAt: Date.now(),
			});
			return await ctx.db.insert("plugins_external_file_bindings", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId,
				writerId,
				nodeId: folderId,
				revision: 1,
				detachedAt: null,
				updatedAt: Date.now(),
			});
		});
		const turn_on = () =>
			f.asOwner.mutation(api.files_sharing.set_node_share_link, {
				membershipId: f.db.membershipId,
				nodeId,
				enabled: true,
			});

		expect((await turn_on())._nay?.message).toBe(
			"A plugin decides who can read this file, so it cannot have a public link",
		);

		// A detached binding keeps its doc, but the plugin no longer decides the readers.
		await f.t.run((ctx) => ctx.db.patch("plugins_external_file_bindings", bindingId, { detachedAt: Date.now() }));
		expect(await turn_on()).toEqual({ _yay: null });
	});

	test("refuses while this workspace or organization is being deleted, not another workspace", async () => {
		const f = await fixture();
		const on = () =>
			f.asOwner.mutation(api.files_sharing.set_node_share_link, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				enabled: true,
			});
		const otherWorkspaceId = await f.t.run(async (ctx) => {
			const created = await organizations_db_create_workspace(ctx, {
				userId: f.db.userId,
				organizationId: f.db.organizationId,
				name: "other",
				description: "",
				now: Date.now(),
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.workspaceId;
		});

		for (const workspaceId of [undefined, f.db.workspaceId]) {
			const requestId = await f.t.run((ctx) =>
				ctx.db.insert("data_deletion_requests", {
					userId: f.db.userId,
					organizationId: f.db.organizationId,
					workspaceId,
					scope: workspaceId ? "workspace" : "organization",
					eligibleAt: Date.now(),
				}),
			);
			expect((await on())._nay?.message).toBe("This workspace is being deleted");
			await f.t.run((ctx) => ctx.db.delete("data_deletion_requests", requestId));
		}
		expect(await read_links(f.t, f.nodeId)).toHaveLength(0);

		await f.t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				userId: f.db.userId,
				organizationId: f.db.organizationId,
				workspaceId: otherWorkspaceId,
				scope: "workspace",
				eligibleAt: Date.now(),
			}),
		);
		expect(await on()).toEqual({ _yay: null });
	});

	test("uses the live scope while a restrict op still runs, and Off still works", async () => {
		const f = await fixture({ memberRole: "admin" });
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);

		const restricted = await f.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: folderId,
		});
		expect(restricted._nay).toBeUndefined();
		// The file still stores the old open scope. Only the live walk sees the restricted folder.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBeNull();

		const args = { membershipId: f.memberMembershipId, nodeId };
		const refused = await f.asMember.mutation(api.files_sharing.set_node_share_link, { ...args, enabled: true });
		expect(refused._nay?.message).toBe("Permission denied");

		await reset_rate_limits(f.t, [f.db.userId]);
		const ownerArgs = { membershipId: f.db.membershipId, nodeId };
		const busy = await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...ownerArgs, enabled: true });
		expect(busy._nay?.message).toBe("Wait until the running file job finishes");
		expect(await read_links(f.t, nodeId)).toHaveLength(0);

		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...ownerArgs, enabled: false })).toEqual({
			_yay: null,
		});
	});

	test("refuses past the workspace link limit", async () => {
		const f = await fixture();
		const firstFillerId = await f.t.run(async (ctx) => {
			let firstId: Id<"files_share_links"> | null = null;
			for (let index = 0; index < files_share_links_MAX_PER_WORKSPACE; index++) {
				const id = await ctx.db.insert("files_share_links", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					nodeId: f.nodeId,
					token: `filler-${index}`,
					restrictedScopeNodeId: null,
					ancestorNodeIds: [],
					createdBy: f.db.userId,
					createdAt: Date.now(),
				});
				firstId ??= id;
			}
			return firstId!;
		});
		const otherNodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/other.md" });
		const args = { membershipId: f.db.membershipId, nodeId: otherNodeId, enabled: true };

		const refused = await f.asOwner.mutation(api.files_sharing.set_node_share_link, args);
		expect(refused._nay?.message).toBe(
			`One workspace can have at most ${files_share_links_MAX_PER_WORKSPACE} public links. Turn off a link you no longer need.`,
		);

		await f.t.run((ctx) => ctx.db.delete("files_share_links", firstFillerId));
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, args)).toEqual({ _yay: null });
	});

	test("works under 64 folders, refuses under 65, shows a shallower image after a too-deep one, and restricting the top folder ends the deep link", async () => {
		const f = await fixture();
		// A chain of 65 folders, `/d00/d01/.../d64`. Seeded directly, because only the depth matters here.
		const folderIds = await f.t.run(async (ctx) => {
			const ids: Id<"files_nodes">[] = [];
			let parentId: Id<"files_nodes"> | "root" = "root";
			let path = "";
			for (let index = 0; index < 65; index++) {
				const name = `d${String(index).padStart(2, "0")}`;
				path = `${path}/${name}`;
				const folderId: Id<"files_nodes"> = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId,
					name,
					sortName: files_sort_text_key(name),
					path,
					treePath: `${path}/`,
					pathDepth: index + 1,
				});
				ids.push(folderId);
				parentId = folderId;
			}
			return ids;
		});
		const place_under = (nodeId: Id<"files_nodes">, folderId: Id<"files_nodes">) =>
			f.t.run(async (ctx) => {
				const folder = (await ctx.db.get("files_nodes", folderId))!;
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				const path = `${folder.path}/${node.name}`;
				await ctx.db.patch("files_nodes", nodeId, {
					parentId: folderId,
					path,
					treePath: path,
					pathDepth: folder.pathDepth + 1,
				});
			});
		const deeperId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/deeper.md" });
		await place_under(f.nodeId, folderIds[63]!);
		await place_under(deeperId, folderIds[64]!);

		const link = await link_on(f, f.nodeId);
		expect(link.ancestorNodeIds).toHaveLength(64);
		expect(await view_of(f, link.token)).not.toBeNull();

		// The live scope walk stops past 64 folders, so the file looks missing.
		const refused = await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: deeperId,
			enabled: true,
		});
		expect(refused._nay?.message).toBe("Not found");
		expect(await read_links(f.t, deeperId)).toEqual([]);

		// The too-deep image is read first. It must not hide a shallower image in the same folders.
		const insert_image = async (folderId: Id<"files_nodes">, name: string) => {
			const folder = (await f.t.run((ctx) => ctx.db.get("files_nodes", folderId)))!;
			return await insert_media_file(f, {
				parentId: folderId,
				path: `${folder.path}/${name}`,
				contentType: "image/png",
			});
		};
		const deepImageId = await insert_image(folderIds[64]!, "deep.png");
		const shallowImageId = await insert_image(folderIds[10]!, "shallow.png");
		const galleryId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/gallery.md",
			textContent: `![a](bonobo-file://${deepImageId})\n\n![b](bonobo-file://${shallowImageId})`,
		});
		const gallery = await view_of(f, (await link_on(f, galleryId)).token);
		expect(gallery?.media.map((item) => item.available)).toEqual([false, true]);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: folderIds[0]!,
				})
			)._nay,
		).toBeUndefined();
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
		expect(await view_of(f, link.token)).toBeNull();
	});
});

async function link_on(f: Fixture, nodeId: Id<"files_nodes">) {
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

describe("files_nodes_db_set_restricted_scope", () => {
	test("restricting a folder ends the links below it before its job reaches them, and opening it again does not bring them back", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const link = await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);

		await reset_rate_limits(f.t, [f.db.userId]);
		const args = { membershipId: f.db.membershipId, nodeId: folderId };
		expect((await f.asOwner.mutation(api.files_sharing.restrict_node, args))._nay).toBeUndefined();
		// The job has not reached the file yet, so only the folder root hook can have deleted the link.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBeNull();
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
		expect(await view_of(f, link.token)).toBeNull();

		// Opening the folder again before the job reaches the file does not bring the old link back.
		await reset_rate_limits(f.t, [f.db.userId]);
		expect((await f.asOwner.mutation(api.files_sharing.unrestrict_node, args))._nay).toBeUndefined();
		expect(await read_links(f.t, nodeId)).toEqual([]);

		// Both jobs reach the file later and find an open folder, so they do not change its scope. The old
		// token must still show nothing.
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBeNull();
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await view_of(f, link.token)).toBeNull();

		// Control: a new link on the same file shows, so the old token is dead only because its doc is gone.
		const fresh = await link_on(f, nodeId);
		expect(await view_of(f, fresh.token)).not.toBeNull();
	});

	test("a scope write that changes nothing keeps the link", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);
		const set_scope = (restrictedScopeNodeId: Id<"files_nodes"> | null) =>
			f.t.run((ctx) =>
				files_nodes_db_set_restricted_scope({
					ctx,
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					nodeId: f.nodeId,
					restrictedScopeNodeId,
					shareLinkCleanup: files_share_links_create_cleanup_state(),
				}),
			);

		await set_scope(null);
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);

		await set_scope(f.nodeId);
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});
});

describe("files_nodes_db_apply_move", () => {
	test("a rename in the same folder keeps the link, and a move to another folder ends it", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);
		const rename = async (path: string) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			return await f.asOwner.mutation(api.files_nodes.rename_node, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				path,
			});
		};

		expect(await rename("/renamed.md")).toEqual({ _yay: null });
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);

		// A refused move changes nothing.
		await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/taken.md" });
		expect((await rename("/taken.md"))._nay).toBeDefined();
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);

		await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "dest",
		});
		expect(await rename("/dest/renamed.md")).toEqual({ _yay: null });
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});

	test("a move into a folder the move creates ends the link", async () => {
		const f = await fixture();
		await link_on(f, f.nodeId);

		// The new folder has no id while the move is planned, so the plan uses its parent key.
		expect(
			await f.asOwner.mutation(api.files_nodes.rename_node, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				path: "/new-folder/doc.md",
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.path).toBe("/new-folder/doc.md");
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});

	test("moving a folder ends the links below it", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/a/b/x.md" });
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const innerFolder = await f.t.run((ctx) => ctx.db.get("files_nodes", node!.parentId as Id<"files_nodes">));
		await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);
		const dest = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "dest",
		});

		expect(
			await f.asOwner.mutation(api.files_nodes.move_nodes, {
				membershipId: f.db.membershipId,
				itemIds: [innerFolder!.parentId as Id<"files_nodes">],
				targetParentId: dest._yay!.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
	});

	test("renaming a folder in the same parent keeps the links below it, also after its job gives them the new path", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const link = await link_on(f, nodeId);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await f.asOwner.mutation(api.files_nodes.rename_node, {
				membershipId: f.db.membershipId,
				nodeId: folderId,
				path: "/renamed",
			}),
		).toEqual({ _yay: null });
		// The job has not reached the file yet, so it still has the old path.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/big/zz.md");
		expect(await read_links(f.t, nodeId)).toEqual([link]);

		// The job gives the file its new path with `files_nodes_db_rebuild_node`. A new path alone keeps the link.
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/renamed/zz.md");
		expect(await read_links(f.t, nodeId)).toEqual([link]);
		expect(await view_of(f, link.token)).not.toBeNull();
	});

	test("a move to the same folder with the same name keeps the link", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await f.asOwner.mutation(api.files_nodes.move_nodes, {
				membershipId: f.db.membershipId,
				itemIds: [f.nodeId],
				targetParentId: "root",
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.path).toBe("/doc.md");
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);
	});

	test("a folder moved into another folder keeps its old links dead after that folder is restricted and opened again", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const link = await link_on(f, nodeId);
		const dest = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "dest",
		});
		const destId = dest._yay!.nodeId;
		// Fill the new parent with folders that sort before `big`. Then the first step of each scope job
		// does not reach `big`, and both jobs reach it only after the folder is open again.
		await f.t.run(async (ctx) => {
			for (let index = 0; index <= files_subtree_ops_STEP_MAX_NODES; index++) {
				const name = `a${String(index).padStart(3, "0")}`;
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: destId,
					name,
					sortName: files_sort_text_key(name),
					path: `/dest/${name}`,
					treePath: `/dest/${name}/`,
					pathDepth: 2,
				});
			}
		});

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await f.asOwner.mutation(api.files_nodes.move_nodes, {
				membershipId: f.db.membershipId,
				itemIds: [folderId],
				targetParentId: destId,
			}),
		).toEqual({ _yay: null });
		expect(await read_links(f.t, nodeId)).toEqual([]);

		// The link doc named only `big` as an ancestor, not `dest`. So only the move hook can end it.
		for (const door of [api.files_sharing.restrict_node, api.files_sharing.unrestrict_node]) {
			await reset_rate_limits(f.t, [f.db.userId]);
			expect(
				(await f.asOwner.mutation(door, { membershipId: f.db.membershipId, nodeId: destId }))._nay,
			).toBeUndefined();
		}
		// No job has given the file its new path yet.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/big/zz.md");

		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			path: "/dest/big/zz.md",
			restrictedScopeNodeId: null,
		});
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await view_of(f, link.token)).toBeNull();

		// Control: a new link on the same file shows, so the old token is dead only because its doc is gone.
		const fresh = await link_on(f, nodeId);
		expect(await view_of(f, fresh.token)).not.toBeNull();
	});

	test("a move that replaces a file ends the replaced file's link", async () => {
		const f = await fixture();
		await link_on(f, f.nodeId);
		const sourceId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/src/doc.md" });

		const moved = await f.t.run(async (ctx) => {
			const membership = await ctx.db.get("organizations_workspaces_users", f.db.membershipId);
			const occupant = await ctx.db.get("files_nodes", f.nodeId);
			const contentVersion = await files_nodes_db_get_content_version(ctx, occupant!);
			return await files_nodes_db_move_nodes(ctx, {
				userAuth: { id: f.db.userId },
				membership: membership!,
				items: [{ nodeId: sourceId, replacement: { nodeId: f.nodeId, contentVersion } }],
				targetParentId: "root",
			});
		});
		expect(moved._nay).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.archiveOperationId).not.toBeNull();
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});
});

describe("archive_nodes", () => {
	test("an archive job ends the links below its folder only after its check ends", async () => {
		const f = await fixture();
		// One check step reads at most 500 nodes, so this check needs more than one step.
		const { nodeId, folderId } = await seed_big_folder(f, 600);
		await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);

		const started = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [folderId],
		});
		const run = await f.t.run((ctx) => ctx.db.get("files_archive_runs", started._yay!.runId));
		expect(run?.phase).toBe("check");
		expect(await read_links(f.t, nodeId)).toHaveLength(1);

		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).not.toBeNull();
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
	});

	test("the step that ends the check ends the links before it stamps the files inside", async () => {
		const f = await fixture();
		// One check step reads at most 500 nodes, and one apply step stamps at most 75. The file sorts last.
		const { nodeId, folderId } = await seed_big_folder(f, 600);
		const link = await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);

		const started = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [folderId],
		});
		const runId = started._yay!.runId;
		const read_run = () => f.t.run((ctx) => ctx.db.get("files_archive_runs", runId));
		expect((await read_run())?.phase).toBe("check");

		// Run the steps the scheduler would run, one at a time, until the check ends.
		for (let count = 0; (await read_run())?.phase === "check"; count++) {
			expect(count).toBeLessThan(10);
			expect(await read_links(f.t, nodeId)).toEqual([link]);
			const { opId, step } = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
					.unique();
				const walk = await ctx.db
					.query("files_subtree_op_walks")
					.withIndex("by_op", (q) => q.eq("opId", op!._id))
					.unique();
				return { opId: op!._id, step: walk!.step };
			});
			await f.t.mutation(internal.files_subtree_ops.advance, { opId, step });
		}
		expect((await read_run())?.phase).toBe("apply");

		// The apply stamps the named folder first. It has not stamped the file yet, but the link is already gone.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", folderId)))?.archiveOperationId).not.toBeNull();
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).toBeNull();
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
		expect(await view_of(f, link.token)).toBeNull();

		await reset_rate_limits(f.t, [f.db.userId]);
		const refused = await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId,
			enabled: true,
		});
		expect(refused._nay?.message).toBe("This file is archived");
		expect(await read_links(f.t, nodeId)).toEqual([]);
	});

	test("a named item that the check refuses keeps its link", async () => {
		const f = await fixture();
		const otherId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/other.md" });
		await link_on(f, f.nodeId);
		const kept = await link_on(f, otherId);
		expect(
			await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: otherId,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });

		const started = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [f.nodeId, otherId],
		});
		expect(started._yay?.notArchivedNodeIds).toEqual([otherId]);
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
		expect(await read_links(f.t, otherId)).toEqual([kept]);
	});
});

describe("unarchive_nodes", () => {
	test("restore Replace ends the replaced file's link, and restoring that file does not bring it back", async () => {
		const f = await fixture();
		const restore = async (nodeId: Id<"files_nodes">) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			const started = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: f.db.membershipId,
				nodeIds: [nodeId],
			});
			return started._yay!;
		};
		const resolve = async (runId: Id<"files_archive_runs">, choice: "replace" | "keep_both") => {
			await reset_rate_limits(f.t, [f.db.userId]);
			const run = await f.t.run((ctx) => ctx.db.get("files_archive_runs", runId));
			expect(
				await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
					membershipId: f.db.membershipId,
					runId,
					revision: run!.revision,
					choice,
					applyToRemaining: { file: null, folder: null },
				}),
			).toEqual({ _yay: null });
			await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		};

		const archived = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [f.nodeId],
		});
		expect(archived._nay).toBeUndefined();
		const occupantId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/doc.md" });
		await link_on(f, occupantId);

		await resolve((await restore(f.nodeId)).runId, "replace");
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", occupantId)))?.archiveOperationId).not.toBeNull();
		expect(await read_links(f.t, occupantId)).toEqual([]);

		await resolve((await restore(occupantId)).runId, "keep_both");
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", occupantId)))?.archiveOperationId).toBeNull();
		expect(await read_links(f.t, occupantId)).toEqual([]);
	});
});

describe("create_upload_nodes", () => {
	test("a replacing batch ends the replaced links with one cleanup, and a locked file keeps its link", async () => {
		const f = await fixture();
		const otherId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/other.md" });
		const lockedId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/locked.md" });
		await link_on(f, f.nodeId);
		await link_on(f, otherId);
		const kept = await link_on(f, lockedId);
		expect(
			await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: lockedId,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });
		await reset_rate_limits(f.t, [f.db.userId]);
		const deleteForRoots = vi.mocked(files_share_links_db_delete_for_roots);
		deleteForRoots.mockClear();

		const uploaded = await f.asOwner.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: f.db.membershipId,
			parentId: "root",
			onConflict: "replace",
			items: ["doc.md", "locked.md", "other.md"].map((relativePath) => ({
				relativePath,
				contentType: "text/markdown",
				size: 3,
			})),
		});
		expect(uploaded._yay?.skipped).toEqual([{ relativePath: "locked.md", reason: "conflict" }]);
		expect(await f.t.run((ctx) => ctx.db.query("files_share_links").collect())).toEqual([kept]);
		expect(new Set(deleteForRoots.mock.calls.map(([call]) => call.state)).size).toBe(1);
		expect(deleteForRoots).toHaveBeenCalledTimes(2);
	});
});

describe("create_file_upload_targets", () => {
	test("a replacing API batch ends the replaced links with one cleanup", async () => {
		const f = await fixture();
		const otherId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/other.md" });
		await link_on(f, f.nodeId);
		await link_on(f, otherId);
		// Only a signed-in account may create an API key.
		await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-share-owner" }));
		const key = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId: null,
			name: "Importer",
			scopes: ["files:write"],
		});
		if (key._nay) {
			throw new Error(key._nay.message);
		}
		const deleteForRoots = vi.mocked(files_share_links_db_delete_for_roots);
		deleteForRoots.mockClear();

		const created = await f.t.mutation(internal.public_api.create_file_upload_targets, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			principalRef: { kind: "user_api_key", credentialId: key._yay.credentialId },
			items: ["/doc.md", "/other.md"].map((path) => ({ path, contentType: "text/markdown", size: 3 })),
			skipProcessing: false,
			overwrite: "replace",
		});
		expect(created._nay).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("files_share_links").collect())).toEqual([]);
		expect(new Set(deleteForRoots.mock.calls.map(([call]) => call.state)).size).toBe(1);
		expect(deleteForRoots).toHaveBeenCalledTimes(2);
	});
});

describe("create_upload_node", () => {
	test("a replacing upload ends the old link", async () => {
		const f = await fixture();
		await link_on(f, f.nodeId);

		const uploaded = await f.asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			filename: "doc.md",
			contentType: "text/markdown",
			size: 3,
		});
		expect(uploaded._nay).toBeUndefined();
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});
});

describe("files_share_links_db_delete_for_roots", () => {
	test("loads the workspace links once per cleanup state and skips scopes that cannot have links", async () => {
		const f = await fixture();
		const otherId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/other.md" });
		await link_on(f, f.nodeId);
		await link_on(f, otherId);

		const linkQueries = await f.t.run(async (ctx) => {
			const query = vi.spyOn(ctx.db, "query");
			const state = files_share_links_create_cleanup_state();
			const tenant = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId };
			await files_share_links_db_delete_for_roots({ ctx, ...tenant, rootNodeIds: [f.nodeId], state });
			await files_share_links_db_delete_for_roots({ ctx, ...tenant, rootNodeIds: [f.nodeId, otherId], state });
			await files_share_links_db_delete_for_roots({
				ctx,
				organizationId: organizations_GLOBAL_ORGANIZATION_ID,
				workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
				rootNodeIds: [f.nodeId],
				state: files_share_links_create_cleanup_state(),
			});
			return query.mock.calls.filter(([table]) => table === "files_share_links").length;
		});
		expect(linkQueries).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.query("files_share_links").collect())).toEqual([]);
	});

	test("reads every link a workspace may hold", async () => {
		const f = await fixture();
		const folderId = await insert_restricted_folder(f, "team");
		// Seeded directly: 500 links through `set_node_share_link` would also pay its rate limit.
		await f.t.run(async (ctx) => {
			for (let index = 0; index < files_share_links_MAX_PER_WORKSPACE; index++) {
				const name = `f${index}.md`;
				const nodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: folderId,
					kind: "file",
					name,
					sortName: files_sort_text_key(name),
					path: `/team/${name}`,
					treePath: `/team/${name}`,
					pathDepth: 2,
					restrictedScopeNodeId: folderId,
				});
				await ctx.db.insert("files_share_links", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					nodeId,
					token: index.toString(16).padStart(64, "0"),
					restrictedScopeNodeId: folderId,
					ancestorNodeIds: [folderId],
					createdBy: f.db.userId,
					createdAt: Date.now(),
				});
			}
		});

		await f.t.run((ctx) =>
			files_share_links_db_delete_for_roots({
				ctx,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				rootNodeIds: [folderId],
				state: files_share_links_create_cleanup_state(),
			}),
		);
		expect(await f.t.run((ctx) => ctx.db.query("files_share_links").collect())).toEqual([]);
	});
});

describe("plugins_data_db_apply_file_access_binding", () => {
	test("binding an already restricted folder ends the links below it", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/team/notes.md" });
		const folderId = (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!.parentId as Id<"files_nodes">;
		const restricted = await f.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: folderId,
		});
		expect(restricted._nay).toBeUndefined();
		await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);
		const installationId = await insert_installation(f);

		await apply_binding(f, { installationId, folderId, readScopeId: "team" });
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
	});

	test("a detach after binding an already restricted folder does not bring the old link back", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/team/notes.md" });
		const folderId = (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!.parentId as Id<"files_nodes">;
		const restricted = await f.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: folderId,
		});
		expect(restricted._nay).toBeUndefined();
		const link = await link_on(f, nodeId);
		const installationId = await insert_installation(f);

		await apply_binding(f, { installationId, folderId, readScopeId: "team" });
		expect(await read_links(f.t, nodeId)).toEqual([]);

		// The folder stays restricted with the same scope after the detach, so a surviving link would show.
		await apply_binding(f, { installationId, folderId, readScopeId: null });
		expect(await f.t.run((ctx) => ctx.db.query("plugins_file_access_bindings").collect())).toEqual([]);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", folderId)))?.restrictedScopeNodeId).toBe(folderId);
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await view_of(f, link.token)).toBeNull();

		// Control: a new link on the same file shows, so the old token is dead only because its doc is gone.
		const fresh = await link_on(f, nodeId);
		expect(await view_of(f, fresh.token)).not.toBeNull();
	});
});

describe("access_control_db_set_service_account_grant", () => {
	test("removing or lowering a file write grant ends the file's link", async () => {
		const f = await fixture();
		const serviceAccountId = await f.t.run((ctx) =>
			ctx.db.insert("access_control_service_accounts", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				name: "Importer",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
		);
		const set_grant = (
			resource: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> },
			level: "read" | "write" | null,
		) =>
			f.t.run(async (ctx) => {
				const result = await access_control_db_set_service_account_grant(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					serviceAccountId,
					resource,
					level,
				});
				expect(result._nay).toBeUndefined();
			});
		const file = { kind: "file", nodeId: f.nodeId } as const;

		await set_grant(file, "write");
		await set_grant({ kind: "workspace" }, "write");
		const link = await link_on(f, f.nodeId);

		// A workspace grant is not the file's own writer list, so removing it keeps the link.
		await set_grant({ kind: "workspace" }, null);
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);

		await set_grant(file, "read");
		expect(await read_links(f.t, f.nodeId)).toEqual([]);

		// A new link after the change stays while the account only reads.
		const fresh = await link_on(f, f.nodeId);
		await set_grant(file, null);
		expect(await read_links(f.t, f.nodeId)).toEqual([fresh]);
	});
});

/**
 * A finished image or video file. Seeded directly, because the public view only reads it.
 */
function insert_media_file(
	f: Fixture,
	args: { parentId: Id<"files_nodes"> | "root"; path: string; contentType: string },
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
		return await ctx.db.insert("files_nodes", {
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
	});
}

/**
 * A restricted folder at the workspace root. Seeded directly, so no restrict job runs.
 */
function insert_restricted_folder(f: Fixture, name: string) {
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

/**
 * A queued scope job on `treePath`. Seeded directly, so its step never runs.
 */
function insert_subtree_op(f: Fixture, treePath: string) {
	return f.t.run((ctx) =>
		ctx.db.insert("files_subtree_ops", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			status: "queued",
			blockedByOpId: null,
			rootNodeIds: [],
			treePaths: [treePath],
			kind: "scope",
		}),
	);
}

function view_of(f: Fixture, token: string) {
	return f.t.query(api.files_share_links.get_share_link_view, { token });
}

describe("get_share_link_view", () => {
	test("shows the saved text to a visitor without an account, and nothing for a bad or old token", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		const view = await view_of(f, link.token);
		expect(view).toMatchObject({
			name: "doc.md",
			textKind: "rich_text",
			media: [],
			content: { kind: "rich_text" },
		});
		expect(view?.content.kind === "rich_text" && JSON.parse(view.content.json)).toMatchObject({
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
		});
		expect(view?.revision).toMatch(/^[0-9a-f]{64}$/);
		// The page never receives the token or the file's private IDs.
		const body = JSON.stringify(view);
		for (const secret of [link.token, f.nodeId, f.db.organizationId, f.db.workspaceId]) {
			expect(body).not.toContain(secret);
		}

		// The same saved state gives the same revision.
		expect((await view_of(f, link.token))?.revision).toBe(view?.revision);

		for (const token of ["", "abc", link.token.toUpperCase(), `${link.token}0`, "0".repeat(64)]) {
			expect(await view_of(f, token)).toBeNull();
		}

		await reset_rate_limits(f.t, [f.db.userId]);
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: false,
		});
		expect(await view_of(f, link.token)).toBeNull();
	});

	test("shows an empty file, which stores no text, and nothing for a non-empty file with no text", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/empty.md",
			textContent: "",
		});
		const link = await link_on(f, nodeId);

		expect(await view_of(f, link.token)).toMatchObject({ name: "empty.md", content: { kind: "rich_text" } });

		const fullLink = await link_on(f, f.nodeId);
		await f.t.run(async (ctx) => {
			for (const chunk of await ctx.db.query("files_text_chunks").collect()) {
				if (chunk.sourceKind === "committed" && chunk.fileNodeId === f.nodeId) {
					await ctx.db.delete("files_text_chunks", chunk._id);
				}
			}
		});
		expect(await view_of(f, fullLink.token)).toBeNull();
	});

	test("reads the live folders above the file, not the link's stored state", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/team/notes.md" });
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const folderId = node!.parentId as Id<"files_nodes">;
		const link = await link_on(f, nodeId);
		expect(await view_of(f, link.token)).not.toBeNull();

		// Each change below skips the file lifecycle, like a job that has not reached the file yet.
		const changes = [
			{ restrictedScopeNodeId: folderId, isRestrictedScopeRoot: true },
			{ archiveOperationId: "archive-op" },
		];
		for (const change of changes) {
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", folderId));
			await f.t.run((ctx) => ctx.db.patch("files_nodes", folderId, change));
			expect(await view_of(f, link.token)).toBeNull();
			await f.t.run((ctx) => ctx.db.replace("files_nodes", folderId, before!));
			expect(await view_of(f, link.token)).not.toBeNull();
		}

		const installationId = await insert_installation(f);
		const bindingId = await f.t.run((ctx) =>
			ctx.db.insert("plugins_file_access_bindings", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId,
				scopeId: "team",
				nodeId: folderId,
				updatedAt: Date.now(),
			}),
		);
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run((ctx) => ctx.db.delete("plugins_file_access_bindings", bindingId));
		expect(await view_of(f, link.token)).not.toBeNull();
	});

	test("shows nothing while a file job or a deletion covers the file", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		// A later job on another path must not clear the block of an earlier job.
		const opId = await insert_subtree_op(f, "/");
		const otherOpId = await insert_subtree_op(f, "/other/");
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run(async (ctx) => {
			await ctx.db.delete("files_subtree_ops", opId);
			await ctx.db.delete("files_subtree_ops", otherOpId);
		});
		expect(await view_of(f, link.token)).not.toBeNull();

		// A data-only reset of the workspace leaves no deletion request. Its purge flag alone hides the page.
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces", f.db.workspaceId, { pluginDataPurgeStartedAt: Date.now() }),
		);
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces", f.db.workspaceId, { pluginDataPurgeStartedAt: undefined }),
		);
		expect(await view_of(f, link.token)).not.toBeNull();

		const requestId = await f.t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				userId: f.db.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				scope: "workspace",
				eligibleAt: Date.now(),
			}),
		);
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run((ctx) => ctx.db.delete("data_deletion_requests", requestId));
		expect(await view_of(f, link.token)).not.toBeNull();
	});

	test("shows an image with the same audience and hides every other image", async () => {
		const f = await fixture();
		const privateFolderId = await insert_restricted_folder(f, "private");
		const openImageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const privateImageId = await insert_media_file(f, {
			parentId: privateFolderId,
			path: "/private/secret.png",
			contentType: "image/png",
		});
		const svgImageId = await insert_media_file(f, {
			parentId: "root",
			path: "/logo.svg",
			contentType: "image/svg+xml",
		});
		const busyImageId = await insert_media_file(f, { parentId: "root", path: "/busy.png", contentType: "image/png" });
		// An image restricted by itself, with no restricted folder above it.
		const selfRestrictedImageId = await insert_media_file(f, {
			parentId: "root",
			path: "/restricted.png",
			contentType: "image/png",
		});
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", selfRestrictedImageId, {
				isRestrictedScopeRoot: true,
				restrictedScopeNodeId: selfRestrictedImageId,
			});
		});
		// An image at the root of another workspace. Only the tenant check can refuse it.
		const otherImageId = await insert_media_file(f, { parentId: "root", path: "/other.png", contentType: "image/png" });
		await f.t.run(async (ctx) => {
			const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other" });
			const image = await ctx.db.get("files_nodes", otherImageId);
			const tenant = { organizationId: other.organizationId, workspaceId: other.workspaceId };
			await ctx.db.patch("files_nodes", otherImageId, tenant);
			await ctx.db.patch("files_r2_assets", image!.assetId!, tenant);
		});
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: [
				`![Photo](bonobo-file://${openImageId})`,
				`![Secret](bonobo-file://${privateImageId})`,
				`![Logo](bonobo-file://${svgImageId})`,
				`![Busy](bonobo-file://${busyImageId})`,
				"![Missing](bonobo-file://not-a-real-id)",
				`![Other](bonobo-file://${otherImageId})`,
				// A video tag that points at an image.
				`<video src="bonobo-file://${openImageId}"></video>`,
				`![Restricted](bonobo-file://${selfRestrictedImageId})`,
			].join("\n\n"),
		});
		const link = await link_on(f, nodeId);
		await insert_subtree_op(f, "/busy.png");

		const view = await view_of(f, link.token);
		expect(view?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: false },
			{ index: 2, available: false },
			{ index: 3, available: false },
			{ index: 4, available: false },
			{ index: 5, available: false },
			{ index: 6, available: false },
			{ index: 7, available: false },
		]);
		// Only the shown image keeps its alt text. The editor often fills alt with a private file name.
		const json = view?.content.kind === "rich_text" ? view.content.json : "";
		expect(json).toContain('"alt":"Photo"');
		for (const hidden of [
			"Secret",
			"Logo",
			"Busy",
			"Missing",
			"Other",
			"Restricted",
			"bonobo-file",
			openImageId,
			privateImageId,
		]) {
			expect(json).not.toContain(hidden);
		}
	});

	test("shows an image of a restricted file's own scope and hides open and deeper restricted images", async () => {
		const f = await fixture();
		const teamId = await insert_restricted_folder(f, "team");
		// `/team/assets` belongs to the team scope. `/team/private` is its own restricted scope.
		const [assetsId, privateId] = await f.t.run(async (ctx) => {
			const insert_folder = (name: string, restricted: boolean) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: teamId,
					name,
					sortName: files_sort_text_key(name),
					path: `/team/${name}`,
					treePath: `/team/${name}/`,
					pathDepth: 2,
					isRestrictedScopeRoot: restricted,
					restrictedScopeNodeId: teamId,
				});
			const privateFolderId = await insert_folder("private", true);
			await ctx.db.patch("files_nodes", privateFolderId, { restrictedScopeNodeId: privateFolderId });
			return [await insert_folder("assets", false), privateFolderId];
		});
		const teamImageId = await insert_media_file(f, {
			parentId: assetsId,
			path: "/team/assets/a.png",
			contentType: "image/png",
		});
		const openImageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const privateImageId = await insert_media_file(f, {
			parentId: privateId,
			path: "/team/private/b.png",
			contentType: "image/png",
		});
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", teamImageId, { restrictedScopeNodeId: teamId });
			await ctx.db.patch("files_nodes", privateImageId, { restrictedScopeNodeId: privateId });
		});
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/team/doc.md",
			textContent: [teamImageId, openImageId, privateImageId].map((id) => `![a](bonobo-file://${id})`).join("\n\n"),
		});
		const link = await link_on(f, nodeId);

		// The team image reuses the folder walk of the file, so this also covers the cached walk.
		expect((await view_of(f, link.token))?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: false },
			{ index: 2, available: false },
		]);
	});

	test("shows a file that is restricted by itself", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", f.nodeId, { isRestrictedScopeRoot: true, restrictedScopeNodeId: f.nodeId });
		});
		const link = await link_on(f, f.nodeId);

		expect(await view_of(f, link.token)).not.toBeNull();
	});

	test("hides an open image from a writer account that cannot read it", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${imageId})`,
		});
		const link = await link_on(f, nodeId);
		const serviceAccountId = await f.t.run((ctx) =>
			ctx.db.insert("access_control_service_accounts", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				name: "Importer",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
		);
		const set_grant = (
			resource: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> },
			level: "read" | "write" | null,
		) =>
			f.t.run(async (ctx) => {
				const result = await access_control_db_set_service_account_grant(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					serviceAccountId,
					resource,
					level,
				});
				expect(result._nay).toBeUndefined();
			});
		const available = async () => (await view_of(f, link.token))?.media[0]?.available;

		expect(await available()).toBe(true);
		const shown = await view_of(f, link.token);

		await set_grant({ kind: "file", nodeId }, "write");
		expect(await available()).toBe(false);
		// The hidden image changes the revision, so an old signing request is refused.
		expect((await view_of(f, link.token))?.revision).not.toBe(shown?.revision);

		await set_grant({ kind: "file", nodeId: imageId }, "read");
		expect(await available()).toBe(true);

		await set_grant({ kind: "file", nodeId: imageId }, null);
		await set_grant({ kind: "workspace" }, "read");
		expect(await available()).toBe(true);

		await set_grant({ kind: "workspace" }, null);
		await set_grant({ kind: "file", nodeId: imageId }, "read");
		// A revoked account keeps its grants. It is never skipped, so the image stays hidden.
		await f.t.run((ctx) =>
			ctx.db.patch("access_control_service_accounts", serviceAccountId, { revokedAt: Date.now() }),
		);
		expect(await available()).toBe(false);
	});

	test("shows a draft image only through the saved file it became", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const privateNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_pending_nodes", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				kind: "file",
				name: "photo.png",
				parent: { kind: "root" },
				structuralRevision: 0,
				creationGeneration: 0,
				state: "published",
				closedAt: null,
			}),
		);
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](${files_media_build_private_src(privateNodeId)})`,
		});
		const link = await link_on(f, nodeId);

		// The draft was not published as a saved file yet.
		expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);

		await f.t.run((ctx) => ctx.db.patch("files_nodes", imageId, { publishedFromPrivateNodeId: privateNodeId }));
		expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: true, kind: "image" }]);
	});

	test("hides media past the first 50", async () => {
		const f = await fixture();
		const imageIds: Id<"files_nodes">[] = [];
		for (let index = 0; index < 51; index++) {
			imageIds.push(
				await insert_media_file(f, { parentId: "root", path: `/photo-${index}.png`, contentType: "image/png" }),
			);
		}
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: imageIds.map((imageId, index) => `![Photo ${index}](bonobo-file://${imageId})`).join("\n\n"),
		});
		const link = await link_on(f, nodeId);

		const view = await view_of(f, link.token);
		expect(view?.media).toHaveLength(50);
		expect(view?.media.every((item) => item.available)).toBe(true);
		const json = view?.content.kind === "rich_text" ? view.content.json : "";
		expect(json).toContain('"alt":"Photo 49"');
		expect(json).not.toContain("Photo 50");
	});

	test("shows the file when checking its media spends the read limits", async () => {
		const f = await fixture();
		// Put each image under its own chain of 30 folders. The view reads every folder above each image, so
		// 50 images need more read calls than one view may use.
		const images = await f.t.run(async (ctx) => {
			const result: Array<{ parentId: Id<"files_nodes"> | "root"; path: string }> = [];
			for (let chain = 0; chain < 50; chain++) {
				let parentId: Id<"files_nodes"> | "root" = "root";
				let path = "";
				for (let depth = 0; depth < 30; depth++) {
					const name = `c${chain}-${depth}`;
					path += `/${name}`;
					parentId = await ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						createdBy: f.db.userId,
						updatedBy: f.db.userId,
						parentId,
						name,
						sortName: files_sort_text_key(name),
						path,
						treePath: `${path}/`,
						pathDepth: depth + 1,
					});
				}
				result.push({ parentId, path: `${path}/photo.png` });
			}
			return result;
		});
		const imageIds: Id<"files_nodes">[] = [];
		for (const image of images) {
			imageIds.push(await insert_media_file(f, { ...image, contentType: "image/png" }));
		}
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: imageIds.map((imageId, index) => `![Photo ${index}](bonobo-file://${imageId})`).join("\n\n"),
		});
		const link = await link_on(f, nodeId);

		const view = await view_of(f, link.token);
		expect(view?.media).toHaveLength(50);
		expect(view?.media[0].available).toBe(true);
		expect(view?.media[49].available).toBe(false);
	});

	test("shows nothing when the workspace has more file jobs than one view reads", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		// Jobs on other paths do not block the file, but a view reads at most 500 of them.
		for (let index = 0; index < 500; index++) {
			await insert_subtree_op(f, `/other-${index}/`);
		}
		expect(await view_of(f, link.token)).not.toBeNull();

		await insert_subtree_op(f, "/other-500/");
		expect(await view_of(f, link.token)).toBeNull();
	});
});

/**
 * Make `R2.getUrl` return a fake URL that shows the key and the response headers it was signed with.
 */
function mock_signed_urls() {
	return vi
		.spyOn(R2.prototype, "getUrl")
		.mockImplementation(
			async (key, options) =>
				`https://r2.test/${key}?type=${options?.responseContentType}&disposition=${options?.responseContentDisposition}&ttl=${options?.expiresIn}`,
		);
}

function sign(
	f: Fixture,
	args: {
		token: string;
		revision: string;
		targets: Array<{ kind: "file" } | { kind: "embed"; index: number }>;
	},
) {
	return f.t.action(api.files_share_links.create_share_link_download_urls, args);
}

describe("create_share_link_download_urls", () => {
	test("signs the page's media by index, with neutral names, for the revision the page shows", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, {
			parentId: "root",
			path: "/Secret plan.png",
			contentType: "image/png",
		});
		const clipId = await insert_media_file(f, { parentId: "root", path: "/clip.mp4", contentType: "video/mp4" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})\n\n<video src="bonobo-file://${clipId}"></video>`,
		});
		const link = await link_on(f, nodeId);
		const view = await view_of(f, link.token);
		const revision = view!.revision;
		expect(view?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: true, kind: "video" },
		]);

		const signed = await sign(f, {
			token: link.token,
			revision,
			targets: [
				{ kind: "embed", index: 0 },
				{ kind: "embed", index: 1 },
			],
		});
		expect(signed._yay).toEqual({
			status: "ready",
			revision,
			urls: [
				{
					target: { kind: "embed", index: 0 },
					url: "https://r2.test/test/Secret plan.png?type=image/png&disposition=inline; filename*=UTF-8''image.png&ttl=900",
					expiresAt: expect.any(Number),
				},
				{
					target: { kind: "embed", index: 1 },
					url: "https://r2.test/test/clip.mp4?type=video/mp4&disposition=inline; filename*=UTF-8''video.mp4&ttl=900",
					expiresAt: expect.any(Number),
				},
			],
		});

		// A few of the targets prepare the same whole page, so the same revision still signs.
		const subset = await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: 1 }] });
		expect(subset._yay?.status).toBe("ready");

		// A negative index must not count from the end of the media list.
		expect(await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: -1 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});

	test("answers stale for an old revision, and refuses media that the page no longer shows", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})`,
		});
		const link = await link_on(f, nodeId);
		const shown = (await view_of(f, link.token))!.revision;

		expect(
			(await sign(f, { token: link.token, revision: "0".repeat(64), targets: [{ kind: "embed", index: 0 }] }))._yay,
		).toEqual({
			status: "stale",
		});

		// Archiving the image changes the page. The old revision is stale, and the new one has no image to sign.
		await f.t.run((ctx) => ctx.db.patch("files_nodes", photoId, { archiveOperationId: "archive-op" }));
		expect(
			(await sign(f, { token: link.token, revision: shown, targets: [{ kind: "embed", index: 0 }] }))._yay,
		).toEqual({
			status: "stale",
		});
		const current = (await view_of(f, link.token))!.revision;
		expect(current).not.toBe(shown);
		expect(await sign(f, { token: link.token, revision: current, targets: [{ kind: "embed", index: 0 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});

	test("answers stale after the file or one of its images gets new bytes", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})`,
		});
		const link = await link_on(f, nodeId);
		const targets = [{ kind: "embed" as const, index: 0 }];

		// A new version of a file gets a new asset, like an upload that replaces it in place.
		const replace_asset = (id: Id<"files_nodes">) =>
			f.t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", id);
				const { _id, _creationTime, ...asset } = (await ctx.db.get("files_r2_assets", node!.assetId!))!;
				const assetId = await ctx.db.insert("files_r2_assets", { ...asset, r2Key: `${asset.r2Key}-v2` });
				await ctx.db.patch("files_nodes", id, { assetId });
			});

		for (const id of [photoId, nodeId]) {
			const shown = (await view_of(f, link.token))!.revision;
			await replace_asset(id);
			expect((await sign(f, { token: link.token, revision: shown, targets }))._yay).toEqual({ status: "stale" });
		}
	});

	test("refuses the media of a page that shows as plain text", async () => {
		const f = await fixture();
		const signUrl = mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		// Each tab doubles in the rich JSON, so the JSON is too large and the page shows its text only.
		// This happens after the image is loaded, so only the page's media list can refuse it.
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})\n\n` + "a\t".repeat(350_000),
		});
		const link = await link_on(f, nodeId);
		const view = await view_of(f, link.token);
		expect(view?.content.kind).not.toBe("rich_text");
		expect(view?.media).toEqual([]);

		expect(
			await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "embed", index: 0 }] }),
		).toEqual({ _nay: { message: "Not found" } });
		expect(signUrl).not.toHaveBeenCalled();
	});

	test("refuses bad targets, a text file's own bytes, and a link that is off", async () => {
		const f = await fixture();
		const signUrl = mock_signed_urls();
		const link = await link_on(f, f.nodeId);
		const revision = (await view_of(f, link.token))!.revision;
		const notFound = { _nay: { message: "Not found" } };

		const refused: Array<Parameters<typeof sign>[1]> = [
			// The raw saved text is never downloaded. The page shows only its safe content.
			{ token: link.token, revision, targets: [{ kind: "file" }] },
			{ token: link.token, revision, targets: [{ kind: "embed", index: 0 }] },
			{ token: link.token, revision, targets: [] },
			{ token: link.token, revision, targets: [{ kind: "embed", index: 50 }] },
			{ token: link.token, revision, targets: [{ kind: "embed", index: 0.5 }] },
			{ token: link.token, revision, targets: Array.from({ length: 51 }, () => ({ kind: "file" as const })) },
			{ token: link.token, revision: "not-a-revision", targets: [{ kind: "file" }] },
			{ token: "0".repeat(64), revision, targets: [{ kind: "file" }] },
		];
		for (const args of refused) {
			expect(await sign(f, args)).toEqual(notFound);
		}

		await reset_rate_limits(f.t, [f.db.userId]);
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: false,
		});
		expect(await sign(f, { token: link.token, revision, targets: [{ kind: "file" }] })).toEqual(notFound);
		expect(signUrl).not.toHaveBeenCalled();
	});

	test("signs a shared image file under its own name", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const link = await link_on(f, photoId);
		const view = await view_of(f, link.token);
		expect(view?.content).toEqual({ kind: "binary" });

		const signed = await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "file" }] });
		expect(signed._yay?.status === "ready" && signed._yay.urls[0].url).toBe(
			"https://r2.test/test/photo.png?type=image/png&disposition=inline; filename*=UTF-8''photo.png&ttl=900",
		);

		// Each target counts once.
		expect(
			await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "file" }, { kind: "file" }] }),
		).toEqual({ _nay: { message: "Not found" } });
	});

	test("charges each target to the link, shared by every visitor", async () => {
		const f = await fixture();
		mock_signed_urls();
		const link = await link_on(f, f.nodeId);
		const revision = (await view_of(f, link.token))!.revision;
		const fullPage = Array.from({ length: 50 }, (_, index) => ({ kind: "embed" as const, index }));

		// A refused target still costs its charge, because the charge runs before the page is prepared.
		for (let call = 0; call < 4; call++) {
			expect(await sign(f, { token: link.token, revision, targets: fullPage })).toEqual({
				_nay: { message: "Not found" },
			});
		}
		const limited = await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: 0 }] });
		expect(limited._nay).toMatchObject({ message: "Rate limit exceeded", data: { retryAfterMs: expect.any(Number) } });

		// The bucket key is the link doc, never the token.
		const [linkDoc] = await read_links(f.t, f.nodeId);
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "files_share_link_download",
				key: linkDoc._id,
			}),
		);
		expect(await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: 0 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});

	test("publishes an image that an API key without download scope adds, and only that one", async () => {
		const f = await fixture();
		mock_signed_urls();
		// Keep uploaded objects in memory, so a second write can read back the first write's saved state.
		const objects = new Map<string, ArrayBuffer>();
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
			key: key ?? "test-upload-key",
			url: `https://r2.test/upload?key=${encodeURIComponent(key ?? "test-upload-key")}`,
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
				if (url.pathname === "/upload") {
					objects.set(url.searchParams.get("key")!, await new Response(init?.body).arrayBuffer());
					return new Response(null, { status: 200 });
				}
				// Objects saved before this store existed read as empty, like the file's default stub.
				return new Response(objects.get(decodeURIComponent(url.pathname.slice(1))) ?? null, { status: 200 });
			}),
		);
		// Create the page after the store, so every object its writes read back is kept.
		const pageId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: "Start.\n",
		});
		const privateFolderId = await insert_restricted_folder(f, "private");
		const readableId = await insert_media_file(f, {
			parentId: "root",
			path: "/readable.png",
			contentType: "image/png",
		});
		const unreadableId = await insert_media_file(f, {
			parentId: "root",
			path: "/unreadable.png",
			contentType: "image/png",
		});
		const restrictedId = await insert_media_file(f, {
			parentId: privateFolderId,
			path: "/private/restricted.png",
			contentType: "image/png",
		});
		const serviceAccountId = await f.t.run((ctx) =>
			ctx.db.insert("access_control_service_accounts", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				name: "Importer",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
		);
		await f.t.run(async (ctx) => {
			for (const [nodeId, level] of [
				[pageId, "write"],
				[readableId, "read"],
			] as const) {
				const granted = await access_control_db_set_service_account_grant(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					serviceAccountId,
					resource: { kind: "file", nodeId },
					level,
				});
				expect(granted._nay).toBeUndefined();
			}
		});
		// Only a signed-in account may create an API key.
		await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-share-owner" }));
		const key = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId,
			name: "Importer",
			scopes: ["files:write"],
		});
		if (key._nay) {
			throw new Error(key._nay.message);
		}
		const headers = { Authorization: `Bearer ${key._yay.credential}`, "Content-Type": "application/json" };
		const link = await link_on(f, pageId);

		// The owner approved this: an in-place API edit keeps the link, and its new images show when the
		// embed rules allow them, even though this key cannot download them itself.
		const written = await f.t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path: "/page.md",
				content: [readableId, unreadableId, restrictedId].map((id) => `![x](bonobo-file://${id})`).join("\n\n"),
			}),
		});
		expect(written.status).toBe(200);
		expect(await read_links(f.t, pageId)).toEqual([link]);

		const view = await view_of(f, link.token);
		expect(view?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: false },
			{ index: 2, available: false },
		]);
		const signed = await sign(f, {
			token: link.token,
			revision: view!.revision,
			targets: [{ kind: "embed", index: 0 }],
		});
		expect(signed._yay?.status).toBe("ready");
		for (const index of [1, 2]) {
			expect(
				await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "embed", index }] }),
			).toEqual({
				_nay: { message: "Not found" },
			});
		}

		// The key's own download door still refuses the image. A download key of the same account may.
		const download = (credential: string) =>
			f.t.fetch("/api/v1/files/download-urls", {
				method: "POST",
				headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
				body: JSON.stringify({ fileNodeIds: [readableId] }),
			});
		expect((await download(key._yay.credential)).status).toBe(403);
		const downloadKey = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId,
			name: "Downloader",
			scopes: ["files:download"],
		});
		if (downloadKey._nay) {
			throw new Error(downloadKey._nay.message);
		}
		expect((await download(downloadKey._yay.credential)).status).toBe(200);

		// Removing the reference changes the page. The old revision is stale, and the new page has no image.
		const removed = await f.t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ path: "/page.md", content: "No images now.\n" }),
		});
		expect(removed.status).toBe(200);
		expect(await read_links(f.t, pageId)).toEqual([link]);
		expect(
			(await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "embed", index: 0 }] }))._yay,
		).toEqual({ status: "stale" });
		const current = (await view_of(f, link.token))!.revision;
		expect(await sign(f, { token: link.token, revision: current, targets: [{ kind: "embed", index: 0 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});
});

describe("list_workspace_links", () => {
	test("lists only the linked files each caller can read, never the token", async () => {
		const f = await fixture();
		const privateFolderId = await insert_restricted_folder(f, "private");
		const secretId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/private/secret.md",
			textContent: "Secret",
		});

		// A member of the workspace with no role, so no workspace-wide read. The owner gives them the
		// restricted folder only.
		const grantOnly = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			return { userId, membershipId };
		});
		const asGrantOnly = f.t.withIdentity({ issuer: "https://clerk.test", external_id: grantOnly.userId });

		// An authorized member with no links gets an empty list, not null.
		expect(
			await f.asOwner.query(api.files_share_links.list_workspace_links, { membershipId: f.db.membershipId }),
		).toEqual([]);

		const openLink = await link_on(f, f.nodeId);
		const secretLink = await link_on(f, secretId);
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.db.membershipId,
				nodeId: privateFolderId,
				principal: { kind: "user", userId: grantOnly.userId },
				level: "read",
			}),
		).toEqual({ _yay: null });

		const ownerList = await f.asOwner.query(api.files_share_links.list_workspace_links, {
			membershipId: f.db.membershipId,
		});
		expect(ownerList).toHaveLength(2);
		expect(ownerList).toEqual(
			expect.arrayContaining([
				{ nodeId: f.nodeId, createdBy: f.db.userId, createdAt: openLink.createdAt },
				{ nodeId: secretId, createdBy: f.db.userId, createdAt: secretLink.createdAt },
			]),
		);
		expect(JSON.stringify(ownerList)).not.toContain(openLink.token);

		// A plain member reads the open file only.
		expect(
			await f.asMember.query(api.files_share_links.list_workspace_links, { membershipId: f.memberMembershipId }),
		).toEqual([{ nodeId: f.nodeId, createdBy: f.db.userId, createdAt: openLink.createdAt }]);

		// A member with only a folder grant reads the file in that folder only.
		expect(
			await asGrantOnly.query(api.files_share_links.list_workspace_links, { membershipId: grantOnly.membershipId }),
		).toEqual([{ nodeId: secretId, createdBy: f.db.userId, createdAt: secretLink.createdAt }]);
	});

	test("answers null for somebody else's membership and throws without sign-in", async () => {
		const f = await fixture();
		await link_on(f, f.nodeId);

		expect(
			await f.asMember.query(api.files_share_links.list_workspace_links, { membershipId: f.db.membershipId }),
		).toBe(null);
		await expect(
			f.t.query(api.files_share_links.list_workspace_links, { membershipId: f.db.membershipId }),
		).rejects.toThrow("Unauthenticated");
	});
});
