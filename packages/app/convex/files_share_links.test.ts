import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file, test_mocks, test_mocks_fill_db_with, test_move_nodes } from "./setup.test.ts";
import { access_control_db_set_service_account_grant } from "./access_control.ts";
import { files_nodes_db_set_restricted_scope } from "./files_nodes.ts";
import { files_share_links_db_delete_for_scope, files_share_links_MAX_PER_WORKSPACE } from "./files_share_links_db.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import { organizations_db_create_workspace } from "./organizations.ts";
import { plugins_data_db_prepare_file_access_binding } from "./plugins_data.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_node_view,
} from "../server/files-saved-placement.ts";
import {
	mock_share_storage,
	fixture,
	reset_rate_limits,
	insert_installation,
	apply_binding,
	seed_big_folder,
	read_links,
	link_on,
	insert_restricted_folder,
	create_restricted_folder,
	restrict_and_bind,
	view_of,
	type Fixture,
} from "./files_share_links.setup.test.ts";

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
		const turn_on = async (nodeId: Id<"files_nodes">) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			return await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
				membershipId: f.db.membershipId,
				nodeId,
				enabled: true,
			});
		};

		// A plugin can bind one file, not only a folder.
		const installationId = await restrict_and_bind(f, f.nodeId);
		expect((await turn_on(f.nodeId))._nay?.message).toBe(
			"A plugin decides who can read this file, so it cannot have a public link",
		);

		await restrict_and_bind(f, folderId);
		expect((await turn_on(nodeId))._nay?.message).toBe(
			"A plugin decides who can read this file, so it cannot have a public link",
		);

		// A detach keeps the folder restricted, and the plugin no longer decides its readers.
		await apply_binding(f, { installationId, folderId: f.nodeId, readScopeId: null });
		expect(await turn_on(f.nodeId)).toEqual({ _yay: null });
		expect((await read_links(f.t, f.nodeId))[0]?.restrictedScopeNodeId).toBe(f.nodeId);
	});

	test("refuses a file in a plugin's external folder until a human sharing change detaches it", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/out/report.md" });
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const folderId = node!.parentId as Id<"files_nodes">;
		// The plugin's external folder writer makes a new restricted folder for its binding.
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: folderId }))
				._nay,
		).toBeUndefined();
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

	test("refuses while the file stores a folder that is no longer restricted, and Off still works", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const args = { membershipId: f.db.membershipId, nodeId: folderId };
		expect((await f.asOwner.mutation(api.files_sharing.restrict_node, args))._nay).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);

		// The unrestrict job stops before the file, so the file still stores the old restricted folder.
		await reset_rate_limits(f.t, [f.db.userId]);
		expect((await f.asOwner.mutation(api.files_sharing.unrestrict_node, args))._nay).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBe(folderId);

		await reset_rate_limits(f.t, [f.db.userId]);
		const fileArgs = { membershipId: f.db.membershipId, nodeId };
		const refused = await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...fileArgs, enabled: true });
		expect(refused._nay?.message).toBe("Wait until the access change of a folder above finishes");
		expect(await read_links(f.t, nodeId)).toHaveLength(0);
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_link, { ...fileArgs, enabled: false })).toEqual({
			_yay: null,
		});

		// Control: once the job reaches the file, the same file gets its link.
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		await link_on(f, nodeId);
	});

	test("allows a link on a file that a restrict job has not reached yet, and the job ends it", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		expect(
			(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: folderId }))
				._nay,
		).toBeUndefined();
		// The file still stores the open scope. Its link works until the job writes the file.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBeNull();
		const link = await link_on(f, nodeId);
		expect(link.restrictedScopeNodeId).toBeNull();

		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBe(folderId);
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await view_of(f, link.token)).toBeNull();
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

	test("works under 100 folders", async () => {
		const f = await fixture();
		// A chain of 100 folders, `/d00/d01/.../d99`. Seeded directly, because only the depth matters here.
		const folderIds = await f.t.run(async (ctx) => {
			const ids: Id<"files_nodes">[] = [];
			let parentId: Id<"files_nodes"> | "root" = "root";
			let path = "";
			for (let index = 0; index < 100; index++) {
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
		await place_under(f.nodeId, folderIds[99]!);

		// No check walks the folders above, so the depth does not matter.
		const link = await link_on(f, f.nodeId);
		expect(await view_of(f, link.token)).not.toBeNull();
	});
});

describe("files_nodes_db_set_restricted_scope", () => {
	test("opening a restricted folder ends the links inside before its job reaches them, and restricting it again does not bring them back", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const args = { membershipId: f.db.membershipId, nodeId: folderId };
		expect((await f.asOwner.mutation(api.files_sharing.restrict_node, args))._nay).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		const link = await link_on(f, nodeId);
		expect(link.restrictedScopeNodeId).toBe(folderId);
		const outside = await link_on(f, f.nodeId);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect((await f.asOwner.mutation(api.files_sharing.unrestrict_node, args))._nay).toBeUndefined();
		// The job has not reached the file yet, so only the folder's own scope change can have deleted the link.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBe(folderId);
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
		expect(await view_of(f, link.token)).toBeNull();

		// Restricting again makes the stored scope live again. A link that survived would show.
		await reset_rate_limits(f.t, [f.db.userId]);
		expect((await f.asOwner.mutation(api.files_sharing.restrict_node, args))._nay).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId).toBe(folderId);
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await view_of(f, link.token)).toBeNull();

		// Control: a new link on the same file shows, so the old token is dead only because its doc is gone.
		const fresh = await link_on(f, nodeId);
		expect(await view_of(f, fresh.token)).not.toBeNull();
	});

	test("a scope write that changes nothing keeps the link, and a real change ends it", async () => {
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
				}),
			);

		await set_scope(null);
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);

		await set_scope(f.nodeId);
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});
});

describe("create_upload_nodes", () => {
	test("a replacing batch ends the replaced links, and a locked file keeps its link", async () => {
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
	});
});

describe("create_file_upload_targets", () => {
	test("a replacing API batch ends the replaced links", async () => {
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

describe("files_share_links_db_delete_for_scope", () => {
	test("deletes every link a workspace may hold in one scope, and only that scope", async () => {
		const f = await fixture();
		const folderId = await insert_restricted_folder(f, "team");
		const kept = await link_on(f, f.nodeId);
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
					createdBy: f.db.userId,
					createdAt: Date.now(),
				});
			}
		});

		await f.t.run((ctx) =>
			files_share_links_db_delete_for_scope(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				scopeNodeId: folderId,
			}),
		);
		expect(await f.t.run((ctx) => ctx.db.query("files_share_links").collect())).toEqual([kept]);
	});
});

describe("plugins_data_db_prepare_file_access_binding", () => {
	async function prepare_for(f: Fixture) {
		const installationId = await insert_installation(f);
		return (nodeId: Id<"files_nodes">) =>
			f.t.run(async (ctx) => {
				const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
				const { parentId } = (await ctx.db.get("files_nodes", nodeId))!;
				return await plugins_data_db_prepare_file_access_binding(ctx, { installation, nodeId, parentId, readScopeId: "team" });
			});
	}

	test("binds only a restricted node whose job has ended and that holds no other restricted folder", async () => {
		const f = await fixture();
		const prepare = await prepare_for(f);

		// A file holds nothing, so it binds in one step.
		expect((await prepare(f.nodeId))._nay).toBeUndefined();
		const open = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "open",
		});
		expect((await prepare(open._yay!.nodeId))._nay?.message).toBe(
			"Restrict this item first, then a plugin can decide who reads it",
		);

		const big = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: big.folderId,
				})
			)._nay,
		).toBeUndefined();
		expect((await prepare(big.folderId))._nay?.message).toBe("Wait until the access change of this folder finishes");
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await prepare(big.folderId))._nay).toBeUndefined();

		const team = await create_restricted_folder(f, "/team");
		await create_restricted_folder(f, "/team/inner");
		expect((await prepare(team.folderId))._nay?.message).toBe(
			"An item inside has its own restricted access, so a plugin cannot decide who reads this folder",
		);
	});

	test("refuses a file or a new node inside an area that a plugin already decides", async () => {
		const f = await fixture();
		const prepare = await prepare_for(f);
		const team = await create_restricted_folder(f, "/team");
		const installationId = await restrict_and_bind(f, team.folderId);
		const prepare_new = (parentId: Doc<"files_nodes">["parentId"]) =>
			f.t.run(async (ctx) => {
				const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
				return await plugins_data_db_prepare_file_access_binding(ctx, {
					installation,
					nodeId: null,
					parentId,
					readScopeId: "team",
				});
			});
		const message = "A plugin already decides who can read the folder around this item";

		expect((await prepare(team.fileId))._nay?.message).toBe(message);
		expect((await prepare_new(team.folderId))._nay?.message).toBe(message);
		// Control: the same new node outside the bound folder passes.
		expect((await prepare_new("root"))._nay).toBeUndefined();
	});

	// A Move holds its folders only in the "before" and "after" views until it ends.
	test("sees a restricted folder that a Move holds, on the way in and on the way out", async () => {
		const f = await fixture();
		const prepare = await prepare_for(f);
		const team = await create_restricted_folder(f, "/team");
		const moving = await create_restricted_folder(f, "/a/private");
		const message = "An item inside has its own restricted access, so a plugin cannot decide who reads this folder";
		let heldSteps = 0;
		const move = async (targetParentId: Doc<"files_nodes">["parentId"]) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			return await test_move_nodes(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				itemIds: [moving.folderId],
				targetParentId,
				onStep: async () => {
					if ((await f.t.run((ctx) => ctx.db.get("files_nodes", moving.folderId)))?.moveCohortId === undefined) return;
					heldSteps++;
					expect((await prepare(team.folderId))._nay?.message).toBe(message);
				},
			});
		};

		expect((await prepare(team.folderId))._nay).toBeUndefined();
		expect(await move(team.folderId)).toEqual({ _yay: null });
		expect(heldSteps).toBeGreaterThan(0);
		expect((await prepare(team.folderId))._nay?.message).toBe(message);

		heldSteps = 0;
		expect(await move("root")).toEqual({ _yay: null });
		expect(heldSteps).toBeGreaterThan(0);
		expect((await prepare(team.folderId))._nay).toBeUndefined();
	});
});

describe("plugins_data_db_apply_file_access_binding", () => {
	test("binding a restricted folder ends the links in its area and keeps the others", async () => {
		const f = await fixture();
		const team = await create_restricted_folder(f, "/team");
		const other = await create_restricted_folder(f, "/other");
		await link_on(f, team.fileId);
		const outside = await link_on(f, f.nodeId);
		const otherLink = await link_on(f, other.fileId);
		const installationId = await insert_installation(f);

		await apply_binding(f, { installationId, folderId: team.folderId, readScopeId: "team" });
		expect(await read_links(f.t, team.fileId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
		expect(await read_links(f.t, other.fileId)).toEqual([otherLink]);

		await reset_rate_limits(f.t, [f.db.userId]);
		const refused = await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: team.fileId,
			enabled: true,
		});
		expect(refused._nay?.message).toBe("A plugin decides who can read this file, so it cannot have a public link");
	});

	test("a detach after binding a restricted folder does not bring the old link back", async () => {
		const f = await fixture();
		const { fileId: nodeId, folderId } = await create_restricted_folder(f, "/team");
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

describe("restrict_node", () => {
	test("refuses inside a bound folder", async () => {
		const f = await fixture();
		const team = await create_restricted_folder(f, "/team");
		const inner = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: team.folderId,
			path: "inner",
		});
		const innerId = inner._yay!.nodeId;
		await restrict_and_bind(f, team.folderId);

		await reset_rate_limits(f.t, [f.db.userId]);
		const refused = await f.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: innerId,
		});
		expect(refused._nay?.message).toBe(
			"A plugin decides who can read this item, so it cannot be restricted on its own",
		);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", innerId)))?.restrictedScopeNodeId).toBe(team.folderId);

		// Control: a folder outside a bound area gets restricted.
		await create_restricted_folder(f, "/open");
	});

	// The Move checks each item when it stages it, and shows the new place only when all are staged. A
	// restrict in between must check where the item lands.
	test("refuses a folder that a Move has staged into a bound folder", async () => {
		const f = await fixture();
		const team = await create_restricted_folder(f, "/team");
		await restrict_and_bind(f, team.folderId);
		// Enough items that the Move stages them over several steps.
		const big = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		let stagedSteps = 0;

		await reset_rate_limits(f.t, [f.db.userId]);
		const moved = await test_move_nodes(f.t, f.asOwner, {
			membershipId: f.db.membershipId,
			itemIds: [big.folderId],
			targetParentId: team.folderId,
			onStep: async () => {
				// Staged: the old place still shows, and the new place is in the bound folder.
				const staged = await f.t.run(async (ctx) => {
					const view = await files_saved_placement_db_get_node_view(ctx.db, big.folderId);
					if (view?.view !== "before") return false;
					const after = await files_saved_placement_db_get_node(ctx.db, big.folderId, {
						cohortId: view.cohortId,
						view: "after",
					});
					return after?.restrictedScopeNodeId === team.folderId;
				});
				if (!staged) return;
				stagedSteps++;
				await reset_rate_limits(f.t, [f.db.userId]);
				const refused = await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: big.folderId,
				});
				expect(refused._nay?.message).toBe(
					"A plugin decides who can read this item, so it cannot be restricted on its own",
				);
			},
		});
		expect(moved).toEqual({ _yay: null });
		expect(stagedSteps).toBeGreaterThan(0);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", big.folderId))).toMatchObject({
			path: "/team/big",
			restrictedScopeNodeId: team.folderId,
		});
	});
});

describe("Move into a bound folder", () => {
	test("refuses a restricted folder, also one inside a moved folder, and moves a plain folder", async () => {
		const f = await fixture();
		const team = await create_restricted_folder(f, "/team");
		await restrict_and_bind(f, team.folderId);
		const restricted = await create_restricted_folder(f, "/a/private");
		const plainId = (await f.t.run((ctx) => ctx.db.get("files_nodes", restricted.folderId)))!
			.parentId as Id<"files_nodes">;
		const move = async (itemId: Id<"files_nodes">) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			return await test_move_nodes(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				itemIds: [itemId],
				targetParentId: team.folderId,
			});
		};
		const message = "A plugin decides who can read the destination, so a restricted item cannot move there.";

		expect((await move(restricted.folderId))._nay?.message).toBe(message);
		expect((await move(plainId))._nay?.message).toBe(message);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", plainId)))?.path).toBe("/a");

		// Control: a plain folder with no restricted folder inside moves in.
		const loose = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "loose",
		});
		expect(await move(loose._yay!.nodeId)).toEqual({ _yay: null });
	});

	// Data from before the bind rules can hold a restricted folder inside a bound folder. A Move into it
	// does not move that folder, so it must not refuse.
	test("moves a file into a restricted folder that already sits in a bound folder", async () => {
		const f = await fixture();
		const team = await create_restricted_folder(f, "/team");
		const inner = await create_restricted_folder(f, "/team/inner");
		const installationId = await insert_installation(f);
		await f.t.run((ctx) =>
			ctx.db.insert("plugins_file_access_bindings", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId,
				scopeId: "team",
				nodeId: team.folderId,
				updatedAt: Date.now(),
			}),
		);
		const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/x.md" });

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await test_move_nodes(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				itemIds: [fileId],
				targetParentId: inner.folderId,
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", fileId)))?.path).toBe("/team/inner/x.md");
	});
});

describe("restore into a bound folder", () => {
	test("refuses a restricted folder that comes back into a bound folder", async () => {
		const f = await fixture();
		const team = await create_restricted_folder(f, "/team");
		const inner = await create_restricted_folder(f, "/team/inner");
		const archived = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [inner.folderId],
		});
		expect(archived._nay).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		// An archived folder is not in the area, so the bind is allowed.
		await restrict_and_bind(f, team.folderId);

		await reset_rate_limits(f.t, [f.db.userId]);
		const started = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [inner.folderId],
		});
		expect(started._nay?.message).toBe(
			"A plugin decides who can read the folder it comes back to, so a restricted item cannot be restored there.",
		);
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", inner.folderId)))?.archiveOperationId).not.toBeNull();
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
