import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { files_MAX_UPLOADS_BYTES } from "../shared/files.ts";
import { quotas } from "../shared/quotas.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { billing_db_check_paid_plan, billing_db_emit_file_upload, billing_pick_billed_user_id } from "./billing_db.ts";
import { quotas_db_ensure } from "./quotas.ts";

// Starting price, chosen on 2026-09-27. This one-time charge covers about three years of R2 storage.
const UPLOAD_PRICE_BLOCK_BYTES = 20 * 1024 * 1024;
const UPLOAD_PRICE_CENTS_PER_BLOCK = 1;

export function files_stored_uploads_cost_cents(bytes: number) {
	return Math.max(1, Math.ceil(bytes / UPLOAD_PRICE_BLOCK_BYTES)) * UPLOAD_PRICE_CENTS_PER_BLOCK;
}

export async function files_stored_uploads_db_admit(
	ctx: QueryCtx | MutationCtx,
	args: {
		organization: Doc<"organizations">;
		actorUserId: Id<"users">;
		workspaceId: Id<"organizations_workspaces">;
		declaredBytes: readonly number[];
		/**
		 * Copy and review jobs keep the payer they already pinned.
		 */
		billedUserId?: Id<"users">;
	},
) {
	const billedUserId =
		args.billedUserId ?? billing_pick_billed_user_id({ userId: args.actorUserId, organization: args.organization });
	const { hasPaidPlan } = await billing_db_check_paid_plan(ctx, { userId: billedUserId });
	if (!hasPaidPlan) {
		return Result({ _nay: { name: "plan_required", message: "This workspace's plan does not include file uploads" } });
	}
	let totalBytes = 0;
	for (const bytes of args.declaredBytes) {
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > files_MAX_UPLOADS_BYTES) {
			return Result({ _nay: { name: "file_too_large", message: "File too large" } });
		}
		totalBytes += bytes;
	}
	const quota = await ctx.db
		.query("quotas")
		.withIndex("by_workspace_quotaName", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("quotaName", "stored_file_bytes"),
		)
		.first();
	if ((quota?.usedCount ?? 0) + totalBytes > (quota?.maxCount ?? quotas.stored_file_bytes.maxCount)) {
		return Result({ _nay: { name: "storage_full", message: quotas.stored_file_bytes.disabledReason } });
	}
	return Result({ _yay: { billedUserId } });
}

/**
 * Call only behind the caller's publication guard. That guard also prevents counting a retry twice.
 */
export async function files_stored_uploads_db_settle(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetId: Id<"files_r2_assets">;
		declaredBytes: number;
		actualBytes: number;
		actorUserId: Id<"users">;
		billedUserId: Id<"users">;
		nodeId: Id<"files_nodes"> | null;
		chargeKey: string;
		chargeable: boolean;
	},
) {
	if (args.actualBytes > args.declaredBytes) {
		return Result({ _nay: { name: "larger_than_declared", message: "The stored file is larger than declared" } });
	}
	if (!args.chargeable) return Result({ _yay: null });
	const billedUser = await ctx.db.get("users", args.billedUserId);
	if (!billedUser) {
		const errorMessage = "Upload payer not found";
		const errorData = { billedUserId: args.billedUserId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	const now = Date.now();
	const quotaId = await quotas_db_ensure(ctx, {
		quotaName: "stored_file_bytes",
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		now,
	});
	const quota = await ctx.db.get("quotas", quotaId);
	if (!quota) {
		const errorMessage = "Stored-file quota not found";
		const errorData = { quotaId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	// Accepted bytes may settle after another upload fills the cap.
	await ctx.db.patch("quotas", quotaId, { usedCount: quota.usedCount + args.actualBytes, updatedAt: now });
	await billing_db_emit_file_upload(ctx, {
		billedUser,
		actorUserId: args.actorUserId,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		assetId: args.assetId,
		chargeKey: args.chargeKey,
		amount: files_stored_uploads_cost_cents(args.actualBytes),
		bytes: args.actualBytes,
	});
	return Result({ _yay: null });
}
