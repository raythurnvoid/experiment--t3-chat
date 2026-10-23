// Asset docs and durable cleanup handoff. Object operations stay in r2_client.ts.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";

if (!process.env.R2_BUCKET_FILES) {
	throw convex_error({ message: "R2_BUCKET_FILES is not set in Convex env" });
}

export const r2_BUCKET_FILES = process.env.R2_BUCKET_FILES;

// Reuse the loaded module between calls. Keep request state inside each handler.
export const experimental_reuseContext = true;

/**
 * Wait 24 hours before checking an unfinished asset. This is much longer than the 15-minute upload
 * URL lifetime, so cleanup does not remove a normal upload that is still finishing.
 */
export const r2_UNFINALIZED_ASSET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Wait five extra minutes after an upload URL expires. An upload may start just before the URL
 * expires. This gives it time to reach R2 before the final delete.
 */
export const r2_PUT_MAY_ARRIVE_MARGIN_MS = 5 * 60 * 1000;

export function r2_create_asset_key(args: {
	organizationId: string;
	workspaceId: string;
	assetId: Id<"files_r2_assets">;
}) {
	return `organizations/${args.organizationId}/workspaces/${args.workspaceId}/assets/${args.assetId}`;
}

/**
 * Create or update one R2 deletion job. Do this before deleting the asset or stage docs. If a crash
 * happens later, the exact R2 key still has a cleanup job.
 *
 * Increase `generation` when new bytes may have reached the key. A delete started for an older
 * generation cannot remove the newer job. Repeating the same R2 event makes no change.
 * `mode: "ensure"` creates a missing job without restarting an existing job. It may attach the
 * asset that waits for the existing job so the final delete can clear that asset's deadline.
 */
export async function r2_enqueue_object_deletion_job(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		r2Key: string;
		reason: Doc<"files_r2_object_deletion_jobs">["reason"];
		/**
		 * Set this when cleanup keeps the asset doc. The final delete clears the asset's
		 * `unfinalizedExpiresAt`.
		 */
		assetId?: Id<"files_r2_assets">;
		/**
		 * Set for a stored tool output. The final delete releases its quota hold and deletes its doc.
		 */
		chatOutputObjectId?: Id<"ai_chat_output_objects">;
		/**
		 * The last time another upload may reach this key. Before this time, keep the job after a
		 * successful delete and delete again later. Leave it empty when no later upload can arrive.
		 */
		putMayArriveUntil?: number;
		r2EventId?: string;
		mode?: "advance" | "ensure";
	},
) {
	const now = Date.now();
	const existing = await ctx.db
		.query("files_r2_object_deletion_jobs")
		.withIndex("by_r2_key", (q) => q.eq("r2Key", args.r2Key))
		.first();
	// The hold survives deletion of the asset doc, including a late R2 event handoff.
	const reservation = existing?.privateStorageReservationId
		? null
		: await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_r2_key", (q) => q.eq("resource.r2Key", args.r2Key))
				.unique();
	const privateStorageReservationId =
		existing?.privateStorageReservationId ?? (reservation?.settlement.kind === "held" ? reservation._id : undefined);

	if (!existing) {
		const jobId = await ctx.db.insert("files_r2_object_deletion_jobs", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			r2Key: args.r2Key,
			reason: args.reason,
			assetId: args.assetId,
			privateStorageReservationId,
			chatOutputObjectId: args.chatOutputObjectId,
			generation: 1,
			lastR2EventId: args.r2EventId,
			putMayArriveUntil: args.putMayArriveUntil,
			failureCount: 0,
			nextAttemptAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.r2_client.process_object_deletion_job, { jobId, generation: 1 });
		return;
	}

	if (existing.privateStorageReservationId === undefined && privateStorageReservationId !== undefined) {
		await ctx.db.patch("files_r2_object_deletion_jobs", existing._id, { privateStorageReservationId });
	}

	if (args.mode === "ensure") {
		if (existing.assetId === undefined && args.assetId !== undefined) {
			await ctx.db.patch("files_r2_object_deletion_jobs", existing._id, { assetId: args.assetId });
		}
		return;
	}

	// Ignore the same R2 event when it arrives more than once.
	if (args.r2EventId !== undefined && existing.lastR2EventId === args.r2EventId) {
		return;
	}

	const generation = existing.generation + 1;
	await ctx.db.patch("files_r2_object_deletion_jobs", existing._id, {
		generation,
		...(args.r2EventId === undefined ? {} : { lastR2EventId: args.r2EventId }),
		// A new upload may make the safe final-delete time later. Never move it earlier.
		...(args.putMayArriveUntil === undefined
			? {}
			: { putMayArriveUntil: Math.max(existing.putMayArriveUntil ?? 0, args.putMayArriveUntil) }),
		failureCount: 0,
		nextAttemptAt: now,
	});
	await ctx.scheduler.runAfter(0, internal.r2_client.process_object_deletion_job, {
		jobId: existing._id,
		generation,
	});
}

export const insert_asset = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_r2_assets").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_r2_assets").fields.workspaceId,
		kind: doc(app_convex_schema, "files_r2_assets").fields.kind,
		size: doc(app_convex_schema, "files_r2_assets").fields.size,
		createdBy: doc(app_convex_schema, "files_r2_assets").fields.createdBy,
	},
	returns: v.id("files_r2_assets"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: args.kind,
			r2Bucket: r2_BUCKET_FILES,
			size: args.size,
			createdBy: args.createdBy,
			unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
			updatedAt: now,
		});
	},
});
