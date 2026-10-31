// Saved tree access and public node fields. Keep editor handlers out of this module.

import type { QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { PaginationResult } from "convex/server";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { v } from "convex/values";
import { should_never_happen } from "../shared/shared-utils.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import app_convex_schema from "./schema.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { doc } from "convex-helpers/validators";
import { convex_error } from "../server/convex-utils.ts";
import { access_control_create_file_checker, access_control_db_authorize_membership } from "./access_control.ts";
import { files_is_ancestor_field } from "../shared/files.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";

/**
 * Whether a page must split before its per-doc reads. Reactive pages can grow beyond numItems.
 * Only a page with a splitCursor can split. Each guard uses the worst doc's measured read cost.
 */
export function files_tree_db_page_needs_split(result: PaginationResult<unknown>, guard: number) {
	return !!result.splitCursor && (result.page.length > guard || !!result.pageStatus);
}

export function files_tree_db_page_split_required(result: PaginationResult<unknown>) {
	return {
		page: [],
		isDone: result.isDone,
		continueCursor: result.continueCursor,
		splitCursor: result.splitCursor,
		pageStatus: "SplitRequired" as const,
	};
}

/**
 * Fields for a node returned by public queries.
 *
 * Return the local flag and current write access. Decision IDs stay on the server.
 */
export const files_node_public_doc_fields = {
	organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
	publishedFromPrivateNodeId: doc(app_convex_schema, "files_nodes").fields.publishedFromPrivateNodeId,
	parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
	kind: doc(app_convex_schema, "files_nodes").fields.kind,
	name: doc(app_convex_schema, "files_nodes").fields.name,
	path: doc(app_convex_schema, "files_nodes").fields.path,
	treePath: doc(app_convex_schema, "files_nodes").fields.treePath,
	pathDepth: doc(app_convex_schema, "files_nodes").fields.pathDepth,
	lowercaseExtension: doc(app_convex_schema, "files_nodes").fields.lowercaseExtension,
	contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
	assetId: doc(app_convex_schema, "files_nodes").fields.assetId,
	pendingContentVersion: doc(app_convex_schema, "files_nodes").fields.pendingContentVersion,
	contentByteSize: doc(app_convex_schema, "files_nodes").fields.contentByteSize,
	textKind: doc(app_convex_schema, "files_nodes").fields.textKind,
	collaborationEnabled: doc(app_convex_schema, "files_nodes").fields.collaborationEnabled,
	yjsSnapshotId: doc(app_convex_schema, "files_nodes").fields.yjsSnapshotId,
	yjsLastSequenceId: doc(app_convex_schema, "files_nodes").fields.yjsLastSequenceId,
	statsId: doc(app_convex_schema, "files_nodes").fields.statsId,
	contentTooLargeByteSize: doc(app_convex_schema, "files_nodes").fields.contentTooLargeByteSize,
	contentShapeMismatchAt: doc(app_convex_schema, "files_nodes").fields.contentShapeMismatchAt,
	contentYjsStateTooLargeByteSize: doc(app_convex_schema, "files_nodes").fields.contentYjsStateTooLargeByteSize,
	contentFrontmatterTooLargeFieldCount: doc(app_convex_schema, "files_nodes").fields
		.contentFrontmatterTooLargeFieldCount,
	contentFrontmatterTooLargeIndexDocumentCount: doc(app_convex_schema, "files_nodes").fields
		.contentFrontmatterTooLargeIndexDocumentCount,
	restrictedScopeNodeId: doc(app_convex_schema, "files_nodes").fields.restrictedScopeNodeId,
	readOnly: doc(app_convex_schema, "files_nodes").fields.readOnly,
	// Leave readOnlyDecisionId out. Only server copy/Restore receipts use it.
	// Leave sortName, isRestrictedScopeRoot, parentScopeNodeId, scopeOpId, extendedScopeNodeId,
	// parentExtendedScopeNodeId, isPublic, contentTypeEssence, contentTypeFamily and
	// ancestor1..12 out too. Only the server reads them.
	archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
	createdBy: doc(app_convex_schema, "files_nodes").fields.createdBy,
	updatedBy: doc(app_convex_schema, "files_nodes").fields.updatedBy,
	updatedAt: doc(app_convex_schema, "files_nodes").fields.updatedAt,
	_id: doc(app_convex_schema, "files_nodes").fields._id,
	_creationTime: doc(app_convex_schema, "files_nodes").fields._creationTime,
	canWrite: v.boolean(),
	writeBlockedReason: v.union(v.null(), v.literal("permission"), v.literal("read_only")),
};

/**
 * A row of the tree lists for a child the caller cannot open. Every child of a folder the caller can
 * open is listed, so this row shows only what the folder shows of it: name, type, size and dates.
 * The client merges rows by `_id`, `name` and `archiveOperationId`, and opens the item by `path`,
 * which shows the access screen.
 */
export const files_tree_locked_row_fields = {
	_id: doc(app_convex_schema, "files_nodes").fields._id,
	_creationTime: doc(app_convex_schema, "files_nodes").fields._creationTime,
	parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
	name: doc(app_convex_schema, "files_nodes").fields.name,
	path: doc(app_convex_schema, "files_nodes").fields.path,
	kind: doc(app_convex_schema, "files_nodes").fields.kind,
	contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
	lowercaseExtension: doc(app_convex_schema, "files_nodes").fields.lowercaseExtension,
	contentByteSize: doc(app_convex_schema, "files_nodes").fields.contentByteSize,
	updatedAt: doc(app_convex_schema, "files_nodes").fields.updatedAt,
	archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
	locked: v.literal(true),
};

/**
 * Build the public write access fields for one node.
 * The state names the node's own rule only. A parent lock never marks a child.
 */
export function files_tree_db_get_public_node_fields(
	fileNode: Doc<"files_nodes">,
	writeBlockedReason: "permission" | "read_only" | null,
) {
	const {
		readOnlyDecisionId: _readOnlyDecisionId,
		sortName: _sortName,
		isRestrictedScopeRoot: _isRestrictedScopeRoot,
		parentScopeNodeId: _parentScopeNodeId,
		scopeOpId: _scopeOpId,
		extendedScopeNodeId: _extendedScopeNodeId,
		parentExtendedScopeNodeId: _parentExtendedScopeNodeId,
		isPublic: _isPublic,
		moveCohortId: _moveCohortId,
		contentHeadId: _contentHeadId,
		contentTypeEssence: _contentTypeEssence,
		contentTypeFamily: _contentTypeFamily,
		archivedPathLength: _archivedPathLength,
		purgeRunId: _purgeRunId,
		...fields
	} = fileNode;
	// Leave `ancestor1..12` out too. Only the name search index reads them.
	const rest = Object.fromEntries(
		Object.entries(fields).filter(([field]) => !files_is_ancestor_field(field)),
	) as typeof fields;

	return {
		...rest,
		canWrite: writeBlockedReason === null,
		writeBlockedReason,
	};
}

/**
 * Resolve the member who reads the Files tree, or `null` when they may read nothing.
 *
 * A failed workspace read check does not always end the read. Somebody whose role gives no
 * workspace-wide read can still have been given one folder, and showing them that folder is the
 * whole point of sharing. Only "Permission denied" means this grant-only mode. Other permission
 * refusals return `null`. Missing current-user auth throws before membership is read.
 *
 * The public link list uses it too, so it answers the same members as the tree.
 */
export async function files_nodes_db_get_tree_reader(
	ctx: QueryCtx,
	args: { membershipId: Id<"organizations_workspaces_users"> },
) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
	if (!userAuth || !user || (userAuth.kind === "anonymous" && user.deletedAt !== undefined)) {
		throw convex_error({ message: "Unauthenticated" });
	}
	const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
	if (!membership || membership.userId !== userAuth.id || membership.active === false) {
		return null;
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth,
		membership,
		permission: "content.read",
	});
	if (authorized._nay && authorized._nay.message !== "Permission denied") {
		return null;
	}

	// "Permission denied" does not return the organization, so load it here. The check above already
	// refused an organization without a default workspace; the guard only narrows the type.
	const organization = await ctx.db.get("organizations", membership.organizationId);
	if (!organization?.defaultWorkspaceId) {
		return null;
	}

	return {
		userAuth,
		membership,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		isOwner: organization.ownerUserId === userAuth.id,
		hasWorkspaceRead: !authorized._nay,
		// One checker for the whole query: the folder check and the row checks then read each node and
		// each "Add people" root once, also under a deep chain.
		checker: access_control_create_file_checker(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			subject: { kind: "user", userId: userAuth.id, plugin: null },
		}),
	};
}

/**
 * Load one node of the reader's workspace, or `null` when it is missing, in another workspace, or
 * not readable by the reader. All three cases give the same answer, so a caller cannot learn that a
 * node it cannot open exists.
 *
 * It does not use `files_metadata_db_get_table_node`: it keeps archived nodes, and it checks access
 * with the tree's list filter, so an open node costs no extra read, like the tree pages.
 */
export async function files_tree_db_get_readable_node(
	ctx: QueryCtx,
	args: {
		reader: {
			membership: Doc<"organizations_workspaces_users">;
			hasWorkspaceRead: boolean;
			checker: files_tree_db_FileChecker;
		};
		nodeId: Id<"files_nodes">;
	},
) {
	const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.reader.membership.organizationId ||
		fileNode.workspaceId !== args.reader.membership.workspaceId
	) {
		return null;
	}

	return (await args.reader.checker.can(fileNode, "content.read")) ? fileNode : null;
}

export type files_tree_db_FileChecker = ReturnType<typeof access_control_create_file_checker>;

/**
 * Build the public tree rows for nodes the caller may read.
 * Filter the nodes with `access_control_db_filter_readable_file_nodes` first.
 */
export async function files_tree_db_get_rows(
	ctx: QueryCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		fileNodes: Doc<"files_nodes">[];
		/** Keyed by the restricted and extended scope pair: added people change access inside a scope. */
		canWriteContentByScope?: Map<string, Promise<boolean>>;
		/** The query's checker, so the write checks reuse the reads of its read checks. */
		checker?: files_tree_db_FileChecker;
	},
) {
	const canWriteContentByScope = args.canWriteContentByScope ?? new Map<string, Promise<boolean>>();
	// The caller resolved the reader (live user, active membership), so this answers like
	// `access_control_db_authorize_membership` for `content.write`.
	const checker =
		args.checker ??
		access_control_create_file_checker(ctx, {
			organizationId: args.membership.organizationId,
			workspaceId: args.membership.workspaceId,
			subject: { kind: "user", userId: args.userAuth.id, plugin: null },
		});
	return await Promise.all(
		args.fileNodes.map(async (fileNode) => {
			if (fileNode.createdBy === users_SYSTEM_AUTHOR || fileNode.updatedBy === users_SYSTEM_AUTHOR) {
				const errorMessage = "Reserved SYSTEM author reached visible file tree";
				const errorData = {
					fileNodeId: fileNode._id,
					createdBy: fileNode.createdBy,
					updatedBy: fileNode.updatedBy,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			const scopeKey = `${fileNode.restrictedScopeNodeId ?? ""}:${fileNode.extendedScopeNodeId ?? ""}`;
			let canWriteContent = canWriteContentByScope.get(scopeKey);
			if (!canWriteContent) {
				canWriteContent = checker.can(fileNode, "content.write");
				canWriteContentByScope.set(scopeKey, canWriteContent);
			}

			// Each node's rule is local, so each row needs its own answer. The check reads
			// only the node doc in hand, so no cache key helps here.
			const policyWritable = await files_nodes_db_require_user_writable(ctx, {
				node: fileNode,
				userId: args.userAuth.id,
			});

			const writeBlockedReason = !(await canWriteContent) ? "permission" : !policyWritable._nay ? null : "read_only";

			return {
				...files_tree_db_get_public_node_fields(fileNode, writeBlockedReason),
				organizationId: args.membership.organizationId,
				workspaceId: args.membership.workspaceId,
				createdBy: fileNode.createdBy,
				updatedBy: fileNode.updatedBy,
			};
		}),
	);
}

/**
 * The children in one page of a folder list that the subject cannot open. `folder` is the folder,
 * already checked as readable, or `null` for the workspace root.
 *
 * A child shares the folder's access when it has the folder's pair (restricted area and "Add people"
 * root), or its own "Add people" root on top of that pair, so it needs no read. Every other child
 * gets the full check: a restricted child (its own area), and a child the scope job has not reached
 * yet. One checker serves the query, so each area and each "Add people" root is read once. The tree
 * queries pass the reader's checker, which is always a person with no plugin.
 */
export async function files_tree_db_get_locked_node_ids(args: {
	checker: files_tree_db_FileChecker;
	folder: Pick<Doc<"files_nodes">, "restrictedScopeNodeId" | "extendedScopeNodeId"> | null;
	fileNodes: Doc<"files_nodes">[];
}) {
	const restricted = args.folder?.restrictedScopeNodeId ?? null;
	const extended = args.folder?.extendedScopeNodeId ?? null;
	const toCheck = args.fileNodes.filter(
		(node) =>
			node.restrictedScopeNodeId !== restricted ||
			(node.extendedScopeNodeId !== extended &&
				!(node.extendedScopeNodeId === node._id && node.parentExtendedScopeNodeId === extended)),
	);
	const lockedIds = new Set<Id<"files_nodes">>();
	for (const node of toCheck) {
		if (!(await args.checker.can(node, "content.read"))) {
			lockedIds.add(node._id);
		}
	}
	return lockedIds;
}

/**
 * The rows of one page of a folder list: the rows of `files_tree_db_get_rows` with `locked: false`,
 * and a locked row for each child the caller cannot open. A locked row reads nothing more: no write
 * access and no write rule.
 */
export async function files_tree_db_get_list_rows(
	ctx: QueryCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		checker: files_tree_db_FileChecker;
		folder: Pick<Doc<"files_nodes">, "restrictedScopeNodeId" | "extendedScopeNodeId"> | null;
		fileNodes: Doc<"files_nodes">[];
	},
) {
	const lockedIds = await files_tree_db_get_locked_node_ids(args);
	const openRows = await files_tree_db_get_rows(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		checker: args.checker,
		fileNodes: args.fileNodes.filter((node) => !lockedIds.has(node._id)),
	});
	let nextOpenRow = 0;
	return args.fileNodes.map((node) =>
		lockedIds.has(node._id)
			? {
					_id: node._id,
					_creationTime: node._creationTime,
					parentId: node.parentId,
					name: node.name,
					path: node.path,
					kind: node.kind,
					contentType: node.contentType,
					lowercaseExtension: node.lowercaseExtension,
					contentByteSize: node.contentByteSize,
					updatedAt: node.updatedAt,
					archiveOperationId: node.archiveOperationId,
					locked: true as const,
				}
			: { ...openRows[nextOpenRow++]!, locked: false as const },
	);
}
