// Load a file's live Yjs document: the last snapshot, the update log after it, and the last
// sequence. Only what a file open waits on lives here. Edits such as yjs_push_update stay in
// files_nodes.ts, because they need its heavy imports.
//
// Keep the imports of this module small. On a cold call, and on every action call, Convex loads
// every file that this module imports, even the unused ones. files_nodes.ts loads about 5 MB, which
// adds about 200ms to each cold file open. For the same reason, sign the snapshot URL with
// r2_get_url.ts, not r2_client.ts, which loads the AWS SDK.

import { v } from "convex/values";
import type { RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { internal } from "./_generated/api.js";
import { action, internalQuery, query } from "./_generated/server.js";
import app_convex_schema, { file_content_materialization_state_validator } from "./schema.ts";
import { access_control_db_authorize_membership, access_control_db_authorize_node } from "./access_control.ts";
import { db_get_file_content_materialization_db_state } from "./files_nodes_db.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { r2_get_url } from "./r2_get_url.ts";
import { convex_error } from "../server/convex-utils.ts";
import { files_node_has_editable_yjs_state } from "../server/files.ts";
import { files_saved_content_collect, files_saved_content_db_yjs_updates } from "../server/files-saved-content.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_sequence,
} from "../server/files-saved-placement.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Reuse the loaded module between calls. Keep request state inside each function.
export const experimental_reuseContext = true;

export const get_file_last_yjs_sequence = query({
	args: { membershipId: v.id("organizations_workspaces_users"), nodeId: v.id("files_nodes") },
	returns: v.union(
		v.object({
			yjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			lastSequence: v.number(),
			pendingContentVersion: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
		if (
			!files_node_has_editable_yjs_state(fileNode) ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		const lastYjsSequenceDoc = await files_saved_placement_db_get_sequence(ctx.db, fileNode).then((doc) => {
			if (!doc || doc.organizationId !== fileNode.organizationId || doc.workspaceId !== fileNode.workspaceId)
				return null;
			return doc;
		});

		if (!lastYjsSequenceDoc) {
			const errorMessage =
				"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
			const errorData = {
				organizationId: fileNode.organizationId,
				workspaceId: fileNode.workspaceId,
				nodeId: args.nodeId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			yjsLastSequenceId: lastYjsSequenceDoc._id,
			lastSequence: lastYjsSequenceDoc.lastSequence,
			pendingContentVersion: fileNode.pendingContentVersion,
		};
	},
});

export const yjs_get_incremental_updates = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			yjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			pendingContentVersion: v.number(),
			updates: v.array(doc(app_convex_schema, "files_yjs_updates")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.kind !== "file"
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		if (!fileNode.yjsLastSequenceId) {
			return null;
		}

		const sequence = await files_saved_placement_db_get_sequence(ctx.db, fileNode);
		if (!sequence) return null;
		const updates = await files_saved_content_collect(
			files_saved_content_db_yjs_updates(ctx.db, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				order: "desc",
				throughSequence: sequence.lastSequence,
			}),
		);

		// Return the exact lineage even when the log is empty. Clients fetch the snapshot and update
		// log separately, so they need this token to refuse a mixed-lineage read.
		return {
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
			pendingContentVersion: fileNode.pendingContentVersion,
			updates,
		};
	},
});

export const get_data_for_yjs_prepare_doc_last_snapshot = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(file_content_materialization_state_validator, v.null()),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		return await db_get_file_content_materialization_db_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
		});
	},
});

type get_data_for_yjs_prepare_doc_last_snapshot_Result =
	typeof get_data_for_yjs_prepare_doc_last_snapshot extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const yjs_prepare_doc_last_snapshot = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			snapshot: doc(app_convex_schema, "files_yjs_snapshots"),
			snapshotUrl: v.string(),
			yjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			pendingContentVersion: v.number(),
			// A live document always has an editable text shape.
			textKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const data = (await ctx.runQuery(internal.files_yjs_load.get_data_for_yjs_prepare_doc_last_snapshot, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		})) as get_data_for_yjs_prepare_doc_last_snapshot_Result;
		if (!data) {
			return null;
		}

		if (!data.yjsSnapshotAsset.r2Key) {
			const errorMessage = "yjsSnapshotAsset.r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				assetId: data.yjsSnapshotAsset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			snapshot: data.yjsSnapshotDoc,
			snapshotUrl: await r2_get_url(data.yjsSnapshotAsset.r2Key, {
				expiresIn: 15 * 60,
			}),
			yjsLastSequenceId: data.yjsLastSequenceDoc._id,
			pendingContentVersion: data.fileNode.pendingContentVersion,
			textKind: data.fileNode.textKind,
		};
	},
});
