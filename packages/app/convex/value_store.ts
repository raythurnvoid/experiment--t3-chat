import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import { convex_error } from "../server/convex-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

// Deletes read the old value too. A full-value scan needs half the batch size.
const CLEANUP_BATCH_SIZE = 10;
const REMOVE_ALL_BATCH_SIZE = 5;

async function delete_value(ctx: MutationCtx, value: Doc<"value_store">) {
	if (value.metadataId !== null) {
		await ctx.db.delete("value_store_metadata", value.metadataId);
	}
	await ctx.db.delete("value_store", value._id);
}

export const put = internalMutation({
	args: {
		value: v.string(),
		/**
		 * Lifetime in milliseconds. Null keeps the value until it is removed.
		 */
		ttl: v.union(v.number(), v.null()),
	},
	returns: v.id("value_store"),
	handler: async (ctx, args) => {
		if (args.ttl !== null && (!Number.isFinite(args.ttl) || args.ttl < 0)) {
			throw convex_error({ message: "TTL must be a finite non-negative number or null" });
		}

		const expiresAt = args.ttl === null ? null : Date.now() + args.ttl;
		const valueId = await ctx.db.insert("value_store", {
			value: args.value,
			expiresAt,
			metadataId: null,
		});
		if (expiresAt !== null) {
			const metadataId = await ctx.db.insert("value_store_metadata", { valueId, expiresAt });
			await ctx.db.patch("value_store", valueId, { metadataId });
		}
		return valueId;
	},
});

export const get = internalQuery({
	args: {
		id: v.string(),
	},
	returns: v.union(
		v.object({
			value: v.string(),
			createdAt: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const id = ctx.db.normalizeId("value_store", args.id);
		if (!id) {
			return null;
		}

		const doc = await ctx.db.get("value_store", id);
		if (!doc) {
			return null;
		}

		if (doc.expiresAt !== null && doc.expiresAt <= Date.now()) {
			return null;
		}

		return {
			value: doc.value,
			createdAt: doc._creationTime,
		};
	},
});

export const remove = internalMutation({
	args: {
		id: v.id("value_store"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const value = await ctx.db.get("value_store", args.id);
		if (value) {
			await delete_value(ctx, value);
		}
		return null;
	},
});

/**
 * Remove values in batches. Values in later batches remain readable until removed.
 */
export const remove_all = internalMutation({
	args: {
		before: v.optional(v.number()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const before = args.before ?? Date.now();
		const values = await ctx.db
			.query("value_store")
			.withIndex("by_creation_time", (q) => q.lte("_creationTime", before))
			.take(REMOVE_ALL_BATCH_SIZE);
		await Promise.all(values.map((value) => delete_value(ctx, value)));

		const done = values.length < REMOVE_ALL_BATCH_SIZE;
		// Keep the first cutoff so later batches leave newer values alone.
		if (!done) {
			await ctx.scheduler.runAfter(0, internal.value_store.remove_all, { before });
		}
		return { deletedCount: values.length, done };
	},
});

export const cleanup_expired = internalMutation({
	args: {
		expiresAt: v.optional(v.number()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const expiresAt = args.expiresAt ?? Date.now();
		const expired = await ctx.db
			.query("value_store_metadata")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", expiresAt))
			.take(CLEANUP_BATCH_SIZE);
		await Promise.all(
			expired.map(async (metadata) => {
				await ctx.db.delete("value_store", metadata.valueId);
				await ctx.db.delete("value_store_metadata", metadata._id);
			}),
		);

		const done = expired.length < CLEANUP_BATCH_SIZE;
		if (!done) {
			await ctx.scheduler.runAfter(0, internal.value_store.cleanup_expired, { expiresAt });
		}
		return { deletedCount: expired.length, done };
	},
});
