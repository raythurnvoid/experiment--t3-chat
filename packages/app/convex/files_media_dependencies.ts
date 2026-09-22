import { Result } from "common/errors-as-values-utils.ts";
import { compareValues, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";

export const files_media_dependencies_PAGE_SIZE = 50;

export async function files_media_dependencies_db_create(
	ctx: MutationCtx,
	args: Pick<
		Doc<"files_media_dependency_sets">,
		"organizationId" | "workspaceId" | "userId" | "owner" | "expectedCount"
	>,
) {
	if (!Number.isSafeInteger(args.expectedCount) || args.expectedCount < 0)
		return Result({ _nay: { message: "Invalid media selection count" } });
	const setId = await ctx.db.insert("files_media_dependency_sets", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		owner: args.owner,
		expectedCount: args.expectedCount,
		count: 0,
		generation: 0,
		sealed: false,
	});
	return Result({ _yay: setId });
}

export async function files_media_dependencies_db_append(
	ctx: MutationCtx,
	args: {
		setId: Id<"files_media_dependency_sets">;
		generation: number;
		offset: number;
		mappings: Pick<Doc<"files_media_dependencies">, "sourceSrc" | "dependency">[];
	},
) {
	const set = await ctx.db.get("files_media_dependency_sets", args.setId);
	if (!set || set.generation !== args.generation || set.owner.kind === "cleanup")
		return Result({ _nay: { message: "The media selection is no longer current" } });
	if (
		!Number.isSafeInteger(args.offset) ||
		args.offset < 0 ||
		args.offset > set.count ||
		args.mappings.length === 0 ||
		args.mappings.length > files_media_dependencies_PAGE_SIZE ||
		args.offset + args.mappings.length > set.expectedCount ||
		new Set(args.mappings.map((mapping) => mapping.sourceSrc)).size !== args.mappings.length
	)
		return Result({ _nay: { message: "Invalid media selection page" } });
	if (args.offset < set.count) {
		const rows = await ctx.db
			.query("files_media_dependencies")
			.withIndex("by_set_order", (q) =>
				q
					.eq("setId", set._id)
					.gte("order", args.offset)
					.lt("order", args.offset + args.mappings.length),
			)
			.take(files_media_dependencies_PAGE_SIZE);
		if (
			rows.length !== args.mappings.length ||
			rows.some(
				(row, index) =>
					row.sourceSrc !== args.mappings[index]!.sourceSrc ||
					compareValues(row.dependency, args.mappings[index]!.dependency) !== 0,
			)
		)
			return Result({ _nay: { message: "The media selection page changed" } });
		return Result({ _yay: null });
	}
	if (set.sealed) return Result({ _nay: { message: "The media selection is already sealed" } });
	// Check the whole page before writing. A refused page must leave the count unchanged.
	for (const mapping of args.mappings) {
		const duplicate = await ctx.db
			.query("files_media_dependencies")
			.withIndex("by_set_sourceSrc", (q) => q.eq("setId", set._id).eq("sourceSrc", mapping.sourceSrc))
			.first();
		if (duplicate) return Result({ _nay: { message: "The media selection repeats a reference" } });
	}
	for (const [index, mapping] of args.mappings.entries())
		await ctx.db.insert("files_media_dependencies", { setId: set._id, order: args.offset + index, ...mapping });
	await ctx.db.patch("files_media_dependency_sets", set._id, { count: set.count + args.mappings.length });
	return Result({ _yay: null });
}

export async function files_media_dependencies_db_seal(
	ctx: MutationCtx,
	args: { setId: Id<"files_media_dependency_sets">; generation: number },
) {
	const set = await ctx.db.get("files_media_dependency_sets", args.setId);
	if (!set || set.generation !== args.generation || set.owner.kind === "cleanup")
		return Result({ _nay: { message: "The media selection is no longer current" } });
	if (set.count !== set.expectedCount) return Result({ _nay: { message: "The media selection is incomplete" } });
	if (!set.sealed) await ctx.db.patch("files_media_dependency_sets", set._id, { sealed: true });
	return Result({ _yay: null });
}

export async function files_media_dependencies_db_retire(
	ctx: MutationCtx,
	args: {
		setId: Id<"files_media_dependency_sets">;
		generation: number;
		owner: Exclude<Doc<"files_media_dependency_sets">["owner"], { kind: "cleanup" }>;
	},
) {
	const set = await ctx.db.get("files_media_dependency_sets", args.setId);
	if (!set || set.generation !== args.generation || compareValues(set.owner, args.owner) !== 0) return;
	await ctx.db.patch("files_media_dependency_sets", set._id, {
		owner: { kind: "cleanup" },
		generation: set.generation + 1,
	});
	await ctx.scheduler.runAfter(0, internal.files_media_dependencies.cleanup_set, { setId: set._id });
}

export async function files_media_dependencies_db_adopt(
	ctx: MutationCtx,
	args: {
		set: Doc<"files_media_dependency_sets">;
		itemId: Id<"files_transfer_items">;
		pendingUpdateId: Id<"files_pending_updates">;
	},
) {
	const current = await ctx.db.get("files_media_dependency_sets", args.set._id);
	if (
		!current?.sealed ||
		current.generation !== args.set.generation ||
		current.owner.kind !== "capture" ||
		current.owner.itemId !== args.itemId
	)
		return Result({ _nay: { message: "The media selection is no longer current" } });
	await ctx.db.patch("files_media_dependency_sets", current._id, {
		owner: { kind: "proposal", pendingUpdateId: args.pendingUpdateId },
		generation: current.generation + 1,
		captureProof: undefined,
	});
	return Result({ _yay: null });
}

async function db_delete_batch(ctx: MutationCtx, setId: Id<"files_media_dependency_sets">) {
	const set = await ctx.db.get("files_media_dependency_sets", setId);
	if (!set) return true;
	if (set.owner.kind !== "cleanup") return false;
	const rows = await ctx.db
		.query("files_media_dependencies")
		.withIndex("by_set_order", (q) => q.eq("setId", setId))
		.take(files_media_dependencies_PAGE_SIZE);
	for (const row of rows) await ctx.db.delete("files_media_dependencies", row._id);
	if (rows.length === files_media_dependencies_PAGE_SIZE) return false;
	await ctx.db.delete("files_media_dependency_sets", setId);
	return true;
}

export const cleanup_set = internalMutation({
	args: { setId: v.id("files_media_dependency_sets") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const set = await ctx.db.get("files_media_dependency_sets", args.setId);
		if (!set || set.owner.kind !== "cleanup") return null;
		if (!(await db_delete_batch(ctx, set._id)))
			await ctx.scheduler.runAfter(0, internal.files_media_dependencies.cleanup_set, args);
		return null;
	},
});

export const recover_cleanup = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const sets = await ctx.db
			.query("files_media_dependency_sets")
			.withIndex("by_owner_kind", (q) => q.eq("owner.kind", "cleanup"))
			.take(16);
		for (const set of sets)
			await ctx.scheduler.runAfter(0, internal.files_media_dependencies.cleanup_set, { setId: set._id });
		return null;
	},
});
