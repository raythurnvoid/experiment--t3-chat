// Quota holds of stored tool outputs. Each `ai_chat_output_objects` doc holds its bytes and one
// object on three counters, from the reservation until its R2 deletion settles.
//
// Lives outside `ai_chat_outputs.ts` because `r2_client.ts` settles the hold, and that lean module
// must not load the chat door modules on every cold R2 call.

import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import { quotas } from "../shared/quotas.ts";
import { quotas_db_ensure } from "./quotas.ts";

/**
 * The bytes an object holds: its reserved size until the upload shrinks it to the real size.
 */
function held_bytes(object: Doc<"ai_chat_output_objects">) {
	return object.state.kind === "reserved" ? object.state.reservedBytes : (object.byteCount ?? 0);
}

/**
 * Hold `bytes` and one object on the three chat output counters. All three must fit before any
 * of them changes. The first use of a scope seeds its counters.
 */
export async function ai_chat_outputs_storage_db_reserve(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		bytes: number;
		now: number;
	},
) {
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, now: args.now };
	const quotaIds = {
		workspaceBytes: await quotas_db_ensure(ctx, { quotaName: "ai_chat_output_workspace_bytes", ...scope }),
		userBytes: await quotas_db_ensure(ctx, {
			quotaName: "ai_chat_output_user_bytes",
			userId: args.userId,
			...scope,
		}),
		workspaceObjects: await quotas_db_ensure(ctx, { quotaName: "ai_chat_output_workspace_objects", ...scope }),
	};

	const charges = [
		{ quotaId: quotaIds.workspaceBytes, count: args.bytes },
		{ quotaId: quotaIds.userBytes, count: args.bytes },
		{ quotaId: quotaIds.workspaceObjects, count: 1 },
	];
	const quotaDocs = await Promise.all(charges.map((charge) => ctx.db.get("quotas", charge.quotaId)));
	for (const [index, quota] of quotaDocs.entries()) {
		if (!quota) {
			throw should_never_happen("Missing chat output quota", { quotaId: charges[index]!.quotaId });
		}
		if (quota.usedCount + charges[index]!.count > quota.maxCount) {
			return Result({ _nay: { name: "storage_full", message: quotas[quota.quotaName].disabledReason } });
		}
	}

	// Patch in sequence: the three counters are separate docs, but keep the same order as release.
	for (const [index, quota] of quotaDocs.entries()) {
		await ctx.db.patch("quotas", quota!._id, {
			usedCount: quota!.usedCount + charges[index]!.count,
			updatedAt: args.now,
		});
	}
	return Result({ _yay: quotaIds });
}

/**
 * Give back part of a byte hold, when the upload knows the real size.
 */
export async function ai_chat_outputs_storage_db_shrink(
	ctx: MutationCtx,
	args: { quotaIds: Doc<"ai_chat_output_objects">["quotaIds"]; bytes: number; now: number },
) {
	for (const quotaId of [args.quotaIds.workspaceBytes, args.quotaIds.userBytes]) {
		const quota = await ctx.db.get("quotas", quotaId);
		if (!quota || quota.usedCount < args.bytes) {
			throw should_never_happen("Invalid chat output quota balance", { quotaId });
		}
		await ctx.db.patch("quotas", quotaId, { usedCount: quota.usedCount - args.bytes, updatedAt: args.now });
	}
}

/**
 * Delete the object doc and give its whole hold back. A counter that account or workspace
 * deletion retired is deleted with its last hold.
 */
export async function ai_chat_outputs_storage_db_release(ctx: MutationCtx, object: Doc<"ai_chat_output_objects">) {
	const now = Date.now();
	const bytes = held_bytes(object);
	await ctx.db.delete("ai_chat_output_objects", object._id);

	// The object doc is gone already, so any doc these find is another hold. Every object of a
	// workspace holds both workspace counters, so one read answers for both.
	const otherWorkspaceHold = await ctx.db
		.query("ai_chat_output_objects")
		.withIndex("by_workspaceObjectsQuota", (q) => q.eq("quotaIds.workspaceObjects", object.quotaIds.workspaceObjects))
		.first();
	const otherUserHold = await ctx.db
		.query("ai_chat_output_objects")
		.withIndex("by_userBytesQuota", (q) => q.eq("quotaIds.userBytes", object.quotaIds.userBytes))
		.first();

	for (const [quotaId, count, otherHold] of [
		[object.quotaIds.workspaceBytes, bytes, otherWorkspaceHold],
		[object.quotaIds.userBytes, bytes, otherUserHold],
		[object.quotaIds.workspaceObjects, 1, otherWorkspaceHold],
	] as const) {
		const quota = await ctx.db.get("quotas", quotaId);
		if (!quota || quota.usedCount < count) {
			throw should_never_happen("Invalid chat output quota balance", { objectId: object._id, quotaId });
		}
		if (quota.retiredAt !== undefined && !otherHold) {
			await ctx.db.delete("quotas", quotaId);
			continue;
		}
		await ctx.db.patch("quotas", quotaId, { usedCount: quota.usedCount - count, updatedAt: now });
	}
}
