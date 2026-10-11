import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_set_service_account_grant } from "./access_control.ts";
import { files_nodes_db_set_restricted_scope } from "./files_nodes.ts";
import {
	files_share_links_create_cleanup_state,
	files_share_links_db_delete_for_roots,
	files_share_links_MAX_PER_WORKSPACE,
} from "./files_share_links_db.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import { organizations_db_create_workspace } from "./organizations.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";
import {
	mock_share_storage,
	fixture,
	reset_rate_limits,
	insert_installation,
	apply_binding,
	seed_big_folder,
	read_links,
	link_on,
	insert_media_file,
	insert_restricted_folder,
	view_of,
} from "./files_share_links.setup.test.ts";

// Record the cleanup state that each link delete gets, so a batch test can check that the batch loads the
// workspace links only once.
vi.mock("./files_share_links_db.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("./files_share_links_db.ts")>();
	return {
		...original,
		files_share_links_db_delete_for_roots: vi.fn(original.files_share_links_db_delete_for_roots),
	};
});

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

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
				pendingOrganizationRemoval: false,
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
