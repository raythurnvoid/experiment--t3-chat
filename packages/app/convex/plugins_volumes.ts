import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { files_nodes_db_delete_subtree_batch } from "./files_nodes.ts";
import { r2 } from "./r2_client.ts";

const DRAIN_BATCH_SIZE = 200;
const DRAIN_LEASE_MS = 10 * 60 * 1000;
const RETIRED_RETENTION_MS = 10 * 60 * 1000;

async function db_release_generation_usage(ctx: MutationCtx, generation: Doc<"plugins_volume_generations">) {
	const usage = await ctx.db
		.query("plugins_volume_usage")
		.withIndex("by_organization_workspace_installation", (q) =>
			q
				.eq("organizationId", generation.organizationId)
				.eq("workspaceId", generation.workspaceId)
				.eq("installationId", generation.installationId),
		)
		.unique();
	// Uninstall removes its accounting doc before the files finish draining.
	if (!usage) return;
	await ctx.db.patch("plugins_volume_usage", usage._id, {
		fileCount: usage.fileCount - generation.fileCount,
		bytes: usage.bytes - generation.bytes,
	});
}

async function db_schedule_generation_drain(ctx: MutationCtx, generation: Doc<"plugins_volume_generations">) {
	const now = Date.now();
	if (generation.drainScheduledUntil !== null && generation.drainScheduledUntil > now) return;
	const leaseUntil = now + DRAIN_LEASE_MS;
	await ctx.db.patch("plugins_volume_generations", generation._id, { drainScheduledUntil: leaseUntil });
	await ctx.scheduler.runAfter(Math.max(0, generation.expiresAt! - now), internal.plugins_volumes.drain_generation, {
		generationId: generation._id,
		leaseUntil,
	});
}

async function db_retire_generation(args: {
	ctx: MutationCtx;
	generation: Doc<"plugins_volume_generations">;
	expiresAt: number;
}) {
	let { ctx, generation, expiresAt} = args;

	if (generation.status !== "retired") {
		await db_release_generation_usage(ctx, generation);
		await ctx.db.patch("plugins_volume_generations", generation._id, {
			status: "retired",
			expiresAt,
			drainScheduledUntil: null,
		});
		generation = { ...generation, status: "retired", expiresAt, drainScheduledUntil: null };
	}
	await db_schedule_generation_drain(ctx, generation);
}

// The caller swaps its published/staging pointer in this same transaction.
export async function plugins_volumes_db_retire_generation(
	ctx: MutationCtx,
	args: { generationId: Id<"plugins_volume_generations"> },
) {
	const generation = await ctx.db.get("plugins_volume_generations", args.generationId);
	if (!generation) return;
	await db_retire_generation({ ctx, generation, expiresAt: Date.now() + RETIRED_RETENTION_MS });
}

export async function plugins_volumes_db_schedule_volume_drain(
	ctx: MutationCtx,
	args: { volumeId: Id<"plugins_volumes"> },
) {
	const volume = await ctx.db.get("plugins_volumes", args.volumeId);
	if (!volume) return;
	const now = Date.now();
	if (volume.deleteRequestedAt === null) await ctx.db.patch("plugins_volumes", volume._id, { deleteRequestedAt: now });
	if (volume.drainScheduledUntil !== null && volume.drainScheduledUntil > now) return;
	const leaseUntil = now + DRAIN_LEASE_MS;
	await ctx.db.patch("plugins_volumes", volume._id, { drainScheduledUntil: leaseUntil });
	await ctx.scheduler.runAfter(0, internal.plugins_volumes.drain_volume, { volumeId: volume._id, leaseUntil });
}

/**
 * One bounded step. The caller keeps the scope after deleting an installation.
 */
export async function plugins_volumes_db_drain_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations"> | null;
		volumeId: Id<"plugins_volumes"> | null;
		batchSize: number;
	},
) {
	const volume = args.volumeId
		? await ctx.db.get("plugins_volumes", args.volumeId)
		: await ctx.db
				.query("plugins_volumes")
				.withIndex("by_organization_workspace_installation", (q) => {
					const tenant = q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId);
					return args.installationId ? tenant.eq("installationId", args.installationId) : tenant;
				})
				.first();
	if (
		!volume ||
		volume.organizationId !== args.organizationId ||
		volume.workspaceId !== args.workspaceId ||
		(args.installationId !== null && volume.installationId !== args.installationId)
	)
		return { done: true, deletedCount: 0 };

	const now = Date.now();
	await ctx.db.patch("plugins_volumes", volume._id, {
		deleteRequestedAt: volume.deleteRequestedAt ?? now,
		drainScheduledUntil: now + DRAIN_LEASE_MS,
	});
	const batchSize = Math.max(2, Math.min(DRAIN_BATCH_SIZE, Math.floor(args.batchSize)));
	const files = await files_nodes_db_delete_subtree_batch(ctx, {
		organizationId: volume.organizationId,
		workspaceId: volume._id,
		treePathPrefix: "/",
		batchSize,
	});
	if (!files.done || files.deletedCount > 0) return { done: false, deletedCount: files.deletedCount };

	const assets = await ctx.db
		.query("files_r2_assets")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", volume.organizationId).eq("workspaceId", volume._id),
		)
		.take(batchSize);
	if (assets.length > 0) {
		for (const asset of assets) {
			if (asset.r2Key) await r2.deleteObject(ctx, asset.r2Key);
			await ctx.db.delete("files_r2_assets", asset._id);
		}
		return { done: false, deletedCount: assets.length };
	}

	// Keep the volume until every file scope table is empty.
	for (const tableName of ["files_plain_text_chunks", "files_text_chunks"] as const) {
		const docs = await ctx.db
			.query(tableName)
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", volume.organizationId).eq("workspaceId", volume._id),
			)
			.take(batchSize);
		if (docs.length > 0) {
			for (const doc of docs) await ctx.db.delete(tableName, doc._id);
			return { done: false, deletedCount: docs.length };
		}
	}
	const metadata = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
			q.eq("organizationId", volume.organizationId).eq("workspaceId", volume._id),
		)
		.take(batchSize);
	if (metadata.length > 0) {
		for (const doc of metadata) await ctx.db.delete("files_metadata_docs", doc._id);
		return { done: false, deletedCount: metadata.length };
	}
	const stats = await ctx.db
		.query("file_stats")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", volume.organizationId).eq("workspaceId", volume._id),
		)
		.take(batchSize);
	if (stats.length > 0) {
		for (const doc of stats) await ctx.db.delete("file_stats", doc._id);
		return { done: false, deletedCount: stats.length };
	}

	const generations = await ctx.db
		.query("plugins_volume_generations")
		.withIndex("by_volume_status", (q) => q.eq("volumeId", volume._id))
		.take(batchSize);
	if (generations.length > 0) {
		for (const generation of generations) {
			if (generation.status !== "retired") await db_release_generation_usage(ctx, generation);
			await ctx.db.delete("plugins_volume_generations", generation._id);
		}
		return { done: false, deletedCount: generations.length };
	}
	await ctx.db.delete("plugins_volumes", volume._id);
	// A workspace/installation caller may still have more volumes to visit.
	return { done: args.volumeId !== null, deletedCount: 1 };
}

export const drain_volume = internalMutation({
	args: { volumeId: v.id("plugins_volumes"), leaseUntil: v.number() },
	returns: v.object({ done: v.boolean() }),
	handler: async (ctx, args): Promise<{ done: boolean }> => {
		const volume = await ctx.db.get("plugins_volumes", args.volumeId);
		if (!volume || volume.deleteRequestedAt === null || volume.drainScheduledUntil !== args.leaseUntil)
			return { done: true };
		const result = await plugins_volumes_db_drain_batch(ctx, {
			organizationId: volume.organizationId,
			workspaceId: volume.workspaceId,
			installationId: volume.installationId,
			volumeId: volume._id,
			batchSize: DRAIN_BATCH_SIZE,
		});
		if (!result.done) {
			const leaseUntil = Date.now() + DRAIN_LEASE_MS;
			await ctx.db.patch("plugins_volumes", volume._id, { drainScheduledUntil: leaseUntil });
			await ctx.scheduler.runAfter(0, internal.plugins_volumes.drain_volume, { volumeId: volume._id, leaseUntil });
		}
		return { done: result.done };
	},
});

export const drain_generation = internalMutation({
	args: { generationId: v.id("plugins_volume_generations"), leaseUntil: v.number() },
	returns: v.object({ done: v.boolean() }),
	handler: async (ctx, args): Promise<{ done: boolean }> => {
		const generation = await ctx.db.get("plugins_volume_generations", args.generationId);
		if (!generation || generation.status !== "retired" || generation.drainScheduledUntil !== args.leaseUntil)
			return { done: true };
		const volume = await ctx.db.get("plugins_volumes", generation.volumeId);
		if (!volume || volume.deleteRequestedAt !== null || generation.expiresAt! > Date.now()) return { done: true };
		const leaseUntil = Date.now() + DRAIN_LEASE_MS;
		await ctx.db.patch("plugins_volume_generations", generation._id, { drainScheduledUntil: leaseUntil });
		const files = await files_nodes_db_delete_subtree_batch(ctx, {
			organizationId: generation.organizationId,
			workspaceId: generation.volumeId,
			treePathPrefix: `/${generation._id}/`,
			batchSize: DRAIN_BATCH_SIZE,
		});
		if (!files.done || files.deletedCount >= DRAIN_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.plugins_volumes.drain_generation, {
				generationId: generation._id,
				leaseUntil,
			});
			return { done: false };
		}
		await ctx.db.delete("plugins_volume_generations", generation._id);
		return { done: true };
	},
});

// The jobs do their own next steps. The cron only recovers an expired lease.
export const gc_expired = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const volumes = await ctx.db
			.query("plugins_volumes")
			.withIndex("by_drainScheduledUntil", (q) => q.gt("drainScheduledUntil", null).lte("drainScheduledUntil", now))
			.take(20);
		for (const volume of volumes) await plugins_volumes_db_schedule_volume_drain(ctx, { volumeId: volume._id });
		// Reserve work for each kind. Live leases never hide an expired lease.
		const staging = await ctx.db
			.query("plugins_volume_generations")
			.withIndex("by_status_expiresAt", (q) => q.eq("status", "staging").gt("expiresAt", null).lte("expiresAt", now))
			.take(15);
		for (const generation of staging) {
			// Expired staging copies have already waited 26 hours. They drain at once.
			await db_retire_generation({ ctx, generation, expiresAt: now });
		}
		const retired = await ctx.db
			.query("plugins_volume_generations")
			.withIndex("by_status_drainScheduledUntil", (q) =>
				q.eq("status", "retired").gt("drainScheduledUntil", null).lte("drainScheduledUntil", now),
			)
			.take(15);
		for (const generation of retired) await db_schedule_generation_drain(ctx, generation);
		return null;
	},
});
