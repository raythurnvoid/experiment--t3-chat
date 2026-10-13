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
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
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
 * Raw policy fields stay private. They are write authority, and a writer choice names accounts
 * the reader may not see. Return the actor's write access and only the local rule kind.
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
	// Leave writePolicy and newChildWritePolicy out. They name accounts a reader may not see.
	// Leave sortName, isRestrictedScopeRoot, contentTypeEssence, contentTypeFamily and ancestor1..12 out too.
	// Only the server indexes read them.
	archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
	createdBy: doc(app_convex_schema, "files_nodes").fields.createdBy,
	updatedBy: doc(app_convex_schema, "files_nodes").fields.updatedBy,
	updatedAt: doc(app_convex_schema, "files_nodes").fields.updatedAt,
	_id: doc(app_convex_schema, "files_nodes").fields._id,
	_creationTime: doc(app_convex_schema, "files_nodes").fields._creationTime,
	canWrite: v.boolean(),
	writeBlockedReason: v.union(v.null(), v.literal("permission"), v.literal("read_only")),
	writePolicyState: v.union(v.literal("none"), v.literal("read_only"), v.literal("writer")),
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
		writePolicy,
		newChildWritePolicy: _newChildWritePolicy,
		sortName: _sortName,
		isRestrictedScopeRoot: _isRestrictedScopeRoot,
		moveCohortId: _moveCohortId,
		contentTypeEssence: _contentTypeEssence,
		contentTypeFamily: _contentTypeFamily,
		archivedPathLength: _archivedPathLength,
		...fields
	} = fileNode;
	// Leave `ancestor1..12` out too. Only the name search index reads them.
	const rest = Object.fromEntries(
		Object.entries(fields).filter(([field]) => !files_is_ancestor_field(field)),
	) as typeof fields;

	// Keep these values as exact literals so they match the return validator.
	const writePolicyState =
		writePolicy === null
			? ("none" as const)
			: writePolicy.mode === "read_only"
				? ("read_only" as const)
				: ("writer" as const);

	return {
		...rest,
		canWrite: writeBlockedReason === null,
		writeBlockedReason,
		writePolicyState,
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
	};
}

/**
 * Load one node of the reader's workspace, or `null` when it is missing, in another workspace, or
 * hidden from the reader. All three cases give the same answer, so a caller cannot learn that a
 * hidden node exists.
 *
 * It does not use `files_metadata_db_get_table_node`: it keeps archived nodes, and it checks access
 * with the tree's list filter, so an open node costs no extra read, like the tree pages.
 */
export async function files_tree_db_get_readable_node(
	ctx: QueryCtx,
	args: {
		reader: {
			userAuth: { id: Id<"users"> };
			membership: Doc<"organizations_workspaces_users">;
			hasWorkspaceRead: boolean;
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

	const readable = await access_control_db_filter_readable_file_nodes(ctx, {
		organizationId: args.reader.membership.organizationId,
		workspaceId: args.reader.membership.workspaceId,
		userId: args.reader.userAuth.id,
		nodes: [fileNode],
		hasWorkspaceRead: args.reader.hasWorkspaceRead,
	});
	return readable.length > 0 ? fileNode : null;
}

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
		canWriteContentByScope?: Map<Id<"files_nodes"> | null, Promise<boolean>>;
	},
) {
	const canWriteContentByScope = args.canWriteContentByScope ?? new Map<Id<"files_nodes"> | null, Promise<boolean>>();
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

			let canWriteContent = canWriteContentByScope.get(fileNode.restrictedScopeNodeId);
			if (!canWriteContent) {
				canWriteContent = access_control_db_authorize_membership(ctx, {
					userAuth: args.userAuth,
					membership: args.membership,
					permission: "content.write",
					fileNode,
				}).then((result) => !result._nay);
				canWriteContentByScope.set(fileNode.restrictedScopeNodeId, canWriteContent);
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
