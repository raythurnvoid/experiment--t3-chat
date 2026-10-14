// Shared database bodies. Keep editor and action work on their current owners.

import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { Workpool } from "@convex-dev/workpool";
import type { Infer } from "convex/values";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_content_version_validator } from "./schema.ts";
import { files_saved_placement_db_get_sequence } from "../server/files-saved-placement.ts";
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
		lastSequenceId: sequenceDoc._id,
		lineageGeneration: sequenceDoc.lineageGeneration,
		sequence: sequenceDoc.lastSequence,
		contentType: fileNode.contentType,
		textKind: fileNode.textKind,
		collaborationEnabled: true,
	};
}
