// Shared database bodies. Keep editor and action work on their current owners.

import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { Workpool } from "@convex-dev/workpool";
import type { Infer } from "convex/values";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_content_version_validator } from "./schema.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_sequence,
} from "../server/files-saved-placement.ts";
import { files_saved_content_db_yjs_updates } from "../server/files-saved-content.ts";
import { files_saved_content_apply_header, files_saved_content_db_get_head } from "../server/files-saved-content-head.ts";
import { files_node_has_editable_yjs_state } from "../server/files.ts";
import { components, internal } from "./_generated/api.js";

export const files_content_materialization_workpool = new Workpool(components.files_content_materialization_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

export async function files_nodes_db_resume_file_content_materialization(
	ctx: MutationCtx,
	args: { jobId: Id<"files_content_materialization_jobs">; userId: Id<"users"> },
) {
	const job = await ctx.db.get("files_content_materialization_jobs", args.jobId);
	if (!job) return;
	const jobId = await files_content_materialization_workpool.enqueueAction(
		ctx,
		internal.files_nodes_content.materialize_file_content,
		{
			organizationId: job.organizationId,
			workspaceId: job.workspaceId,
			nodeId: job.fileNodeId,
			userId: args.userId,
			targetSequence: job.targetSequence,
		},
		{ runAfter: 0 },
	);
	// Keep the accepted job identity while replacing its completed workpool attempt.
	await ctx.db.patch("files_content_materialization_jobs", job._id, { jobId });
}

/**
 * Read the saved content version without loading snapshots or the update log. Content error
 * markers do not prevent a move or archive. Callers that read bytes check those markers.
 */
export async function files_nodes_db_get_content_version(
	ctx: QueryCtx | MutationCtx,
	fileNode: Doc<"files_nodes">,
): Promise<Infer<typeof files_content_version_validator> | null> {
	fileNode = files_saved_content_apply_header(fileNode, await files_saved_content_db_get_head(ctx.db, fileNode));
	if (fileNode.kind !== "file" || fileNode.assetId === null || fileNode.contentType === null) {
		return null;
	}

	if (fileNode.collaborationEnabled !== true) {
		return {
			kind: "asset",
			assetId: fileNode.assetId,
			contentType: fileNode.contentType,
			textKind: fileNode.textKind,
			collaborationEnabled: fileNode.collaborationEnabled,
		};
	}

	if (fileNode.textKind === null || fileNode.yjsLastSequenceId === null) {
		const errorMessage = "fileNode.textKind or fileNode.yjsLastSequenceId is not set";
		const errorData = {
			nodeId: fileNode._id,
			textKind: fileNode.textKind,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const sequenceDoc = await files_saved_placement_db_get_sequence(ctx.db, fileNode);
	if (
		!sequenceDoc ||
		sequenceDoc.organizationId !== fileNode.organizationId ||
		sequenceDoc.workspaceId !== fileNode.workspaceId ||
		sequenceDoc.fileNodeId !== fileNode._id
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = { nodeId: fileNode._id, yjsLastSequenceId: fileNode.yjsLastSequenceId, sequenceDoc };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	return {
		kind: "yjs",
		pendingContentVersion: fileNode.pendingContentVersion,
		lastSequenceId: sequenceDoc._id,
		lineageGeneration: sequenceDoc.lineageGeneration,
		sequence: sequenceDoc.lastSequence,
		contentType: fileNode.contentType,
		textKind: fileNode.textKind,
		collaborationEnabled: true,
	};
}

export async function db_get_file_content_materialization_db_state(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; nodeId: Id<"files_nodes"> },
) {
	const header = await db_get_file_content_materialization_header(ctx, args);
	if (!header) {
		return null;
	}

	const yjsUpdatesDocs: Doc<"files_yjs_updates">[] = [];
	for await (const update of files_saved_content_db_yjs_updates(ctx.db, {
		...args,
		throughSequence: header.yjsLastSequenceDoc.lastSequence,
	}))
		yjsUpdatesDocs.push(update);

	return {
		fileNode: header.fileNode,
		yjsSnapshotDoc: header.yjsSnapshotDoc,
		yjsLastSequenceDoc: header.yjsLastSequenceDoc,
		yjsUpdatesDocs,
		asset: header.asset,
		yjsSnapshotAsset: header.yjsSnapshotAsset,
	};
}

/**
 * The header half of the materialization state: every doc except the update log. The
 * materialization action reads the log one update doc at a time through
 * `get_file_next_yjs_update` instead of collecting it, because one allowed doc may itself be
 * 930,000 bytes.
 */
export async function db_get_file_content_materialization_header(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; nodeId: Id<"files_nodes"> },
) {
	const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
		return null;
	}

	if (!files_node_has_editable_yjs_state(fileNode)) {
		return null;
	}

	const [asset, yjsSnapshotDoc, yjsLastSequenceDoc] = await Promise.all([
		ctx.db.get("files_r2_assets", fileNode.assetId),
		ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
		files_saved_placement_db_get_sequence(ctx.db, fileNode),
	]);

	// Do not check the asset kind here. node.assetId always holds the file's current bytes, but
	// the kind can vary: usually the newest version snapshot, or an old content row without an
	// r2Key (old data) until a materialization points the node at a fresh snapshot.
	if (!asset || asset.organizationId !== args.organizationId || asset.workspaceId !== args.workspaceId) {
		const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			assetId: fileNode.assetId,
			asset,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.organizationId !== args.organizationId ||
		yjsSnapshotDoc.workspaceId !== args.workspaceId ||
		yjsSnapshotDoc.fileNodeId !== args.nodeId
	) {
		const errorMessage = "fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
			yjsSnapshotDoc,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.organizationId !== args.organizationId ||
		yjsLastSequenceDoc.workspaceId !== args.workspaceId ||
		yjsLastSequenceDoc.fileNodeId !== args.nodeId
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
			yjsLastSequenceDoc,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const yjsSnapshotAsset = await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId);
	if (
		!yjsSnapshotAsset ||
		yjsSnapshotAsset.organizationId !== args.organizationId ||
		yjsSnapshotAsset.workspaceId !== args.workspaceId ||
		yjsSnapshotAsset.kind !== "yjs_snapshot"
	) {
		const errorMessage = "yjsSnapshotDoc.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			assetId: yjsSnapshotDoc.assetId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	return {
		fileNode,
		yjsSnapshotDoc,
		yjsLastSequenceDoc,
		asset,
		yjsSnapshotAsset,
	};
}

/**
 * Whether a plugin decides who reads this node: a reader binding, or an attached external folder
 * binding. A public link or a restricted folder inside its area would go around that list. Reads 2 docs.
 */
export async function files_nodes_db_has_plugin_binding(ctx: QueryCtx | MutationCtx, nodeId: Id<"files_nodes">) {
	return (await files_nodes_db_get_plugin_binding_installation_id(ctx, nodeId)) !== null;
}

/**
 * The installation of the plugin that decides who reads this node, or `null`. Same bindings as
 * `files_nodes_db_has_plugin_binding`.
 */
export async function files_nodes_db_get_plugin_binding_installation_id(
	ctx: QueryCtx | MutationCtx,
	nodeId: Id<"files_nodes">,
) {
	const binding = await ctx.db
		.query("plugins_file_access_bindings")
		.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
		.first();
	if (binding) {
		return binding.installationId;
	}

	const externalBinding = await ctx.db
		.query("plugins_external_file_bindings")
		.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
		.first();
	return externalBinding && externalBinding.detachedAt === null ? externalBinding.installationId : null;
}
