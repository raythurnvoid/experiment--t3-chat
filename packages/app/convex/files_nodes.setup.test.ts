// Fixtures shared by the files_nodes test files.
import type { FunctionReturnType } from "convex/server";
import { expect } from "vitest";
import { api, internal } from "./_generated/api.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type { files_metadata_Entry } from "../shared/files-metadata.ts";
import { files_sort_compare, files_sort_text_key, type files_sort_Clause } from "../shared/files-sort.ts";
import type { files_table_Filter } from "../shared/files-table.ts";

/**
 * Insert one node for the tree query tests. `scope: "self"` makes the node its own restricted scope.
 */
export async function insert_tree_node(args: {
	ctx: MutationCtx;
	owner: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> };
	parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
	path: string;
	kind: "folder" | "file";
	scope?: Id<"files_nodes"> | "self";
	archiveOperationId?: string;
}) {
	const { ctx, owner } = args;
	const name = args.path.slice(args.path.lastIndexOf("/") + 1);

	const nodeId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		createdBy: owner.userId,
		updatedBy: owner.userId,
		parentId: args.parentId,
		name,
		sortName: files_sort_text_key(name),
		kind: args.kind,
		path: args.path,
		treePath: args.kind === "folder" ? `${args.path}/` : args.path,
		pathDepth: args.path.split("/").length - 1,
		lowercaseExtension: args.kind === "file" ? "md" : null,
		restrictedScopeNodeId: args.scope && args.scope !== "self" ? args.scope : null,
		archiveOperationId: args.archiveOperationId ?? null,
	});
	if (args.scope === "self") {
		await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId, isRestrictedScopeRoot: true });
	}
	return nodeId;
}

/**
 * A workspace seen by three people: the owner, an admin, and a grant-only member.
 *
 * The admin has workspace read through a workspace `admin` role, and `member` as organization role.
 * The grant-only member has no role, so they read only what is shared with them.
 * `/top/hidden` and `/box/secret` are restricted and shared with nobody. Scopes inside `/top/hidden`
 * are shared with the admin or the grant-only member.
 */
export async function seed_tree_access_fixture(t: ReturnType<typeof test_convex>) {
	// The flush writes the share rows of the grants below.
	const db = await test_run_with_flush(t, async (ctx) => {
		const owner = await test_mocks_fill_db_with.membership(ctx);
		const foreign = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" });
		const organization = await ctx.db.get("organizations", owner.organizationId);
		if (!organization?.defaultWorkspaceId) {
			throw new Error("Expected the organization default workspace");
		}
		const now = Date.now();

		const add_member = async (clerkUserId: string) => {
			const userId = await ctx.db.insert("users", { clerkUserId });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			return { userId, membershipId };
		};
		const admin = await add_member("clerk_tree_admin");
		const grantOnly = await add_member("clerk_tree_grant_only");
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: admin.userId,
			role: "admin",
			now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: owner.organizationId,
			workspaceId: organization.defaultWorkspaceId,
			userId: admin.userId,
			role: "member",
			now,
		});

		const grant = async (
			nodeId: Id<"files_nodes">,
			principal: { userId: Id<"users">; externalPluginMembershipLifetime?: number } | { role: "admin" | "member" },
		) => {
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				resourceKind: "file",
				resourceId: String(nodeId),
				...("role" in principal
					? { principalKind: "role" as const, ...principal }
					: { principalKind: "user" as const, ...principal }),
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
		};

		const node = (args: Omit<Parameters<typeof insert_tree_node>[0], "ctx" | "owner">) =>
			insert_tree_node({ ctx, owner, ...args });
		const openId = await node({ parentId: files_ROOT_ID, path: "/open", kind: "folder" });
		const openFileId = await node({ parentId: openId, path: "/open/a.md", kind: "file" });
		const openSubId = await node({ parentId: openId, path: "/open/sub", kind: "folder" });
		const deepFileId = await node({ parentId: openSubId, path: "/open/sub/deep.md", kind: "file" });
		const archivedFileId = await node({
			parentId: openId,
			path: "/open/gone-file.md",
			kind: "file",
			archiveOperationId: "archive-operation-tree",
		});
		const archivedFolderId = await node({
			parentId: openId,
			path: "/open/gone-folder",
			kind: "folder",
			archiveOperationId: "archive-operation-tree",
		});

		const boxId = await node({ parentId: files_ROOT_ID, path: "/box", kind: "folder" });
		const boxSecretId = await node({ parentId: boxId, path: "/box/secret", kind: "folder", scope: "self" });

		const topId = await node({ parentId: files_ROOT_ID, path: "/top", kind: "folder" });
		const hiddenId = await node({ parentId: topId, path: "/top/hidden", kind: "folder", scope: "self" });
		const grantedId = await node({ parentId: hiddenId, path: "/top/hidden/granted", kind: "folder", scope: "self" });
		const grantedFileId = await node({
			parentId: grantedId,
			path: "/top/hidden/granted/doc.md",
			kind: "file",
			scope: grantedId,
		});
		const innerId = await node({
			parentId: grantedId,
			path: "/top/hidden/granted/inner",
			kind: "folder",
			scope: "self",
		});
		const teamId = await node({ parentId: hiddenId, path: "/top/hidden/team", kind: "folder", scope: "self" });
		const opsId = await node({ parentId: hiddenId, path: "/top/hidden/ops", kind: "folder", scope: "self" });
		const pluginId = await node({ parentId: hiddenId, path: "/top/hidden/plugin", kind: "folder", scope: "self" });
		const oldId = await node({
			parentId: hiddenId,
			path: "/top/hidden/old",
			kind: "folder",
			scope: "self",
			archiveOperationId: "archive-operation-old",
		});

		const sharedId = await node({ parentId: files_ROOT_ID, path: "/shared", kind: "folder", scope: "self" });
		const sharedFileId = await node({ parentId: sharedId, path: "/shared/note.md", kind: "file", scope: sharedId });

		await grant(grantedId, { userId: admin.userId });
		await grant(grantedId, { userId: grantOnly.userId });
		await grant(innerId, { userId: admin.userId });
		// `member` is the admin's organization role and `admin` their workspace role. Both must count.
		await grant(teamId, { role: "member" });
		await grant(opsId, { role: "admin" });
		// A plugin-managed grant from an older membership lifetime no longer gives access.
		await grant(pluginId, { userId: admin.userId, externalPluginMembershipLifetime: 1 });
		await ctx.db.insert("organizations_membership_lifetimes", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: admin.userId,
			membershipId: admin.membershipId,
			lifetime: 2,
			active: true,
		});
		await grant(oldId, { userId: admin.userId });
		await grant(sharedId, { userId: admin.userId });
		await grant(sharedId, { userId: grantOnly.userId });

		const foreignFolderId = await insert_tree_node({
			ctx,
			owner: foreign,
			parentId: files_ROOT_ID,
			path: "/foreign",
			kind: "folder",
		});
		const missingNodeId = await node({ parentId: files_ROOT_ID, path: "/missing", kind: "folder" });
		await ctx.db.delete("files_nodes", missingNodeId);

		return {
			owner,
			admin,
			grantOnly,
			nodes: {
				openId,
				openFileId,
				openSubId,
				deepFileId,
				archivedFileId,
				archivedFolderId,
				boxId,
				boxSecretId,
				topId,
				hiddenId,
				grantedId,
				grantedFileId,
				innerId,
				teamId,
				opsId,
				pluginId,
				oldId,
				sharedId,
				sharedFileId,
				foreignFolderId,
				missingNodeId,
			},
		};
	});

	const as = (userId: Id<"users">) => t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	return {
		...db,
		asOwner: as(db.owner.userId),
		asAdmin: as(db.admin.userId),
		asGrantOnly: as(db.grantOnly.userId),
	};
}

export type Page = FunctionReturnType<typeof api.files_nodes.list_tree_children_sorted>;

/**
 * A folder `/table` for the folder table queries, with helpers that add children and read its sorted pages.
 */
export async function seed_folder_table(options: Parameters<typeof test_convex>[0] = {}) {
	const t = test_convex(options);
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/table",
	});
	if (created._nay) throw new Error(created._nay.message);
	const parentId = created._yay.nodeId;

	type Child = {
		name: string;
		kind: "file" | "folder";
		updatedAt: number;
		lowercaseExtension?: string;
		contentByteSize?: number;
		/**
		 * Make the child its own restricted root, like `files_sharing.restrict_node`.
		 */
		restricted?: boolean;
	};
	const db_insert_child = async (ctx: MutationCtx, args: Child) => {
		const nodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: args.updatedAt,
			parentId,
			name: args.name,
			sortName: files_sort_text_key(args.name),
			kind: args.kind,
			path: `/table/${args.name}`,
			treePath: args.kind === "folder" ? `/table/${args.name}/` : `/table/${args.name}`,
			pathDepth: 2,
			lowercaseExtension: args.lowercaseExtension ?? null,
			contentByteSize: args.contentByteSize ?? null,
			isRestrictedScopeRoot: args.restricted ?? false,
		});
		if (args.restricted) await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
		return nodeId;
	};
	const insert_child = (args: Child) => t.run((ctx) => db_insert_child(ctx, args));
	const insert_children = (children: Child[]) =>
		t.run(async (ctx) => {
			const nodeIds: Array<Id<"files_nodes">> = [];
			for (const child of children) nodeIds.push(await db_insert_child(ctx, child));
			return nodeIds;
		});

	/**
	 * Write committed metadata on saved children. Write it after `restricted` is set: the field docs
	 * copy the node's flag.
	 */
	const set_metadata = (entries: Array<[Id<"files_nodes">, files_metadata_Entry[]]>) =>
		t.run(async (ctx) => {
			for (const [nodeId, nodeEntries] of entries) {
				await files_metadata_db_write_entries(ctx, {
					fileNode: (await ctx.db.get("files_nodes", nodeId))!,
					entries: nodeEntries,
				});
			}
		});

	type Stream = {
		as?: typeof asOwner;
		membershipId?: Id<"organizations_workspaces_users">;
		kind: "file" | "folder";
		sort: files_sort_Clause;
		segment?: "value" | "missing";
		filter?: files_table_Filter | null;
		namePrefix?: string | null;
		restricted?: boolean;
		/**
		 * Read this principal's share stream (`list_tree_children_shared`) instead.
		 */
		principalIndex?: 0 | 1 | 2;
	};
	type PageArgs = Stream & { paginationOpts: { numItems: number; cursor: string | null; endCursor?: string } };
	const page_query_args = (args: PageArgs) => ({
		membershipId: args.membershipId ?? db.membershipId,
		parentId,
		kind: args.kind,
		sort: [args.sort],
		filter: args.filter ?? null,
		namePrefix: args.namePrefix ?? null,
		restricted: args.restricted ?? false,
		segment: args.segment ?? "value",
		paginationOpts: args.paginationOpts,
	});
	const shared_query_args = (args: PageArgs, principalIndex: 0 | 1 | 2) => ({
		membershipId: args.membershipId ?? db.membershipId,
		parentId,
		kind: args.kind,
		archived: false,
		principalIndex,
		sort: [args.sort],
		filter: args.filter ?? null,
		namePrefix: args.namePrefix ?? null,
		segment: args.segment ?? "value",
		paginationOpts: args.paginationOpts,
	});
	const read_page = (args: PageArgs) =>
		args.principalIndex === undefined
			? (args.as ?? asOwner).query(api.files_nodes.list_tree_children_sorted, page_query_args(args))
			: (args.as ?? asOwner).query(
					api.files_nodes.list_tree_children_shared,
					shared_query_args(args, args.principalIndex),
				);

	/**
	 * Read one page inside a transaction and return what it cost: index ranges (`databaseQueries`)
	 * and documents read, from `ctx.meta.getTransactionMetrics()`.
	 */
	const read_page_cost = (args: PageArgs) =>
		(args.as ?? asOwner).run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result =
				args.principalIndex === undefined
					? await ctx.runQuery(api.files_nodes.list_tree_children_sorted, page_query_args(args))
					: await ctx.runQuery(api.files_nodes.list_tree_children_shared, shared_query_args(args, args.principalIndex));
			const after = await ctx.meta.getTransactionMetrics();
			return {
				rows: result.page.length,
				ranges: after.databaseQueries.used - before.databaseQueries.used,
				documents: after.documentsRead.used - before.documentsRead.used,
			};
		});

	/**
	 * Read one stream to its end. Every page but the last must be full, and the rows must come in
	 * `sortKey` order.
	 */
	const walk = async (args: Stream & { numItems: number }) => {
		const pages: Page["page"][] = [];
		let cursor: string | null = null;
		for (let index = 0; index < 200; index++) {
			const result: Page = await read_page({ ...args, paginationOpts: { numItems: args.numItems, cursor } });
			pages.push(result.page);
			if (result.isDone) {
				expect(pages.slice(0, -1).every((page) => page.length === args.numItems)).toBe(true);
				const rows = pages.flat();
				expect(
					rows.every(
						(row, rowIndex) =>
							rowIndex === 0 ||
							files_sort_compare({ a: rows[rowIndex - 1]!.sortKey, b: row.sortKey, sort: [args.sort] }) <= 0,
					),
				).toBe(true);
				return pages;
			}
			cursor = result.continueCursor;
		}
		throw new Error("Expected the stream to end");
	};

	/**
	 * The names in display order, like the browser: folders, then files. In each kind the value
	 * segment comes before the missing one, and each segment merges the open and the restricted
	 * stream by `sortKey`. For a `member` it merges the open stream and their 3 share streams
	 * instead, and keeps a node shared twice once.
	 */
	const read_table = async (
		sort: files_sort_Clause,
		options: {
			filter?: files_table_Filter | null;
			namePrefix?: string | null;
			numItems?: number;
			member?: { as: typeof asOwner; membershipId: Id<"organizations_workspaces_users"> };
		} = {},
	) => {
		const { member, ...pageOptions } = options;
		const streams: Array<Pick<Stream, "restricted" | "principalIndex">> = member
			? [{ restricted: false }, { principalIndex: 0 }, { principalIndex: 1 }, { principalIndex: 2 }]
			: [{ restricted: false }, { restricted: true }];
		const names: string[] = [];
		for (const kind of ["folder", "file"] as const) {
			for (const segment of ["value", "missing"] as const) {
				const rows = new Map<Id<"files_nodes">, Page["page"][number]>();
				for (const stream of streams) {
					const pages = await walk({
						...pageOptions,
						...stream,
						...member,
						kind,
						sort,
						segment,
						numItems: options.numItems ?? 2,
					});
					for (const row of pages.flat()) rows.set(row._id, row);
				}
				names.push(
					...[...rows.values()]
						.sort((a, b) => files_sort_compare({ a: a.sortKey, b: b.sortKey, sort: [sort] }))
						.map((row) => row.name),
				);
			}
		}
		return names;
	};

	/**
	 * Add a member of the workspace. A member with no role reads only what is shared with them.
	 */
	const add_member = async (clerkUserId: string, role: "member" | null) => {
		const member = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			if (role) {
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role,
					now,
				});
			}
			return { userId, membershipId };
		});
		return { ...member, as: t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }) };
	};

	/**
	 * Give a user or a role the grant doc of a Can view share on each node, and write its share row.
	 * Many shares through the sharing mutation would run into its rate limit.
	 */
	const grant_read = (
		principal: { userId: Id<"users">; externalPluginMembershipLifetime?: number } | { role: "member" },
		nodeIds: Array<Id<"files_nodes">>,
	) =>
		test_run_with_flush(t, async (ctx) => {
			for (const nodeId of nodeIds) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					resourceKind: "file",
					resourceId: String(nodeId),
					...("role" in principal
						? { principalKind: "role" as const, ...principal }
						: { principalKind: "user" as const, ...principal }),
					permission: "content.read",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});

	return {
		t,
		db,
		asOwner,
		parentId,
		insert_child,
		insert_children,
		set_metadata,
		read_page,
		read_page_cost,
		walk,
		read_table,
		add_member,
		grant_read,
	};
}
