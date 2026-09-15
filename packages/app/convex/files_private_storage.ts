import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import { quotas } from "../shared/quotas.ts";
import { quotas_db_ensure } from "./quotas.ts";

// One maximum-size text publication needs 12 MiB of states, 4 MiB of Yjs, and 900 kB of text.
const PUBLICATION_HEADROOM_BYTES = 20 * 1024 * 1024;
const PUBLICATION_HEADROOM_MAX_RESOURCES = 128;

/**
 * Reserve a physical resource before storing its payload or starting an R2 write. The caller
 * owns access checks and removes any empty allocation if admission refuses. Growing a state
 * family reserves its new total in the same mutation that appends its pages. Replacing a text
 * input can shrink its hold in the transaction that replaces the value. Reserve resources
 * in sequence within one mutation because they update the same counters.
 */
export async function files_private_storage_db_reserve(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		resource: Doc<"files_private_storage_reservations">["resource"];
		byteCount: number;
		publicationBatchId?: Id<"files_pending_update_operation_batches">;
	},
) {
	const now = Date.now();
	const existing = await ctx.db
		.query("files_private_storage_reservations")
		.withIndex("by_resource", (q) => q.eq("resource.kind", args.resource.kind).eq("resource.id", args.resource.id))
		.unique();
	if (existing && existing.settlement.kind !== "held") {
		return Result({ _nay: { name: "target_changed", message: "This pending resource has already been settled" } });
	}
	if (
		(existing &&
			(existing.organizationId !== args.organizationId ||
				existing.workspaceId !== args.workspaceId ||
				existing.userId !== args.userId ||
				existing.publicationBatchId !== args.publicationBatchId ||
				(existing.resource.kind === "asset" &&
					args.resource.kind === "asset" &&
					existing.resource.r2Key !== args.resource.r2Key))) ||
		!Number.isSafeInteger(args.byteCount) ||
		args.byteCount < 0 ||
		(args.resource.kind !== "text_input" && args.byteCount < (existing?.byteCount ?? 0)) ||
		(args.resource.kind === "node" && args.byteCount !== 0)
	) {
		throw should_never_happen("Invalid private storage reservation", { resourceId: args.resource.id });
	}

	const additionalCount =
		args.resource.kind === "node" ? (existing ? 0 : 1) : args.byteCount - (existing?.byteCount ?? 0);
	if (existing && additionalCount === 0) {
		return Result({ _yay: existing._id });
	}

	if (args.publicationBatchId) {
		const batch = await ctx.db.get("files_pending_update_operation_batches", args.publicationBatchId);
		const proposal = batch?.expectedPendingUpdateId
			? await ctx.db.get("files_pending_updates", batch.expectedPendingUpdateId)
			: null;
		if (
			!batch?.publication ||
			batch.expiresAt <= now ||
			batch.organizationId !== args.organizationId ||
			batch.workspaceId !== args.workspaceId ||
			batch.userId !== args.userId ||
			!proposal ||
			proposal.revision !== batch.expectedRevision ||
			proposal.target.kind !== batch.target.kind ||
			proposal.target.id !== batch.target.id
		) {
			return Result({ _nay: { name: "target_changed", message: "This Save preparation is no longer current" } });
		}

		if (batch.target.kind === "private") {
			const node = await ctx.db.get("files_pending_nodes", batch.target.id);
			if (
				!node ||
				node.state !== "active" ||
				!batch.expectedPrivateVersion ||
				node.creationGeneration !== batch.expectedPrivateVersion.creationGeneration ||
				node.structuralRevision !== batch.expectedPrivateVersion.structuralRevision
			) {
				return Result({ _nay: { name: "target_changed", message: "This draft has changed during Save" } });
			}
		}

		if (args.resource.kind === "asset") {
			if (
				batch.publication.kind !== "assets" ||
				(args.resource.id !== batch.publication.contentAssetId &&
					args.resource.id !== batch.publication.yjsSnapshotAssetId &&
					args.resource.id !== batch.publication.backupAssetId)
			) {
				throw should_never_happen("Save headroom used for an unrelated asset", { resourceId: args.resource.id });
			}
		} else if (args.resource.kind === "trusted_stage") {
			if (batch.publication.kind !== "update" || args.resource.id !== batch.publication.trustedStageId) {
				throw should_never_happen("Save headroom used for an unrelated update", { resourceId: args.resource.id });
			}
		} else if (args.resource.kind === "state") {
			const state = await ctx.db.get("files_pending_update_yjs_states", args.resource.id);
			if (
				state?.owner.kind !== "temporary" ||
				state.owner.operationBatchId !== batch._id ||
				state.owner.phase !== "output"
			) {
				throw should_never_happen("Save headroom used for an unrelated state", { resourceId: args.resource.id });
			}
		} else if (args.resource.kind === "text_input") {
			const textInput = await ctx.db.get("files_pending_update_text_inputs", args.resource.id);
			if (
				!textInput ||
				textInput.operationBatchId !== batch._id ||
				textInput.userId !== batch.userId ||
				textInput.target.kind !== batch.target.kind ||
				textInput.target.id !== batch.target.id
			) {
				throw should_never_happen("Save headroom used for an unrelated text", { resourceId: args.resource.id });
			}
		} else {
			throw should_never_happen("Save headroom used for an input resource", { resourceId: args.resource.id });
		}
	}

	const userQuotaId =
		existing?.userQuotaId ??
		(await quotas_db_ensure(ctx, {
			quotaName: args.resource.kind === "node" ? "files_private_nodes" : "files_private_user_bytes",
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			now,
		}));
	const workspaceQuotaId =
		args.resource.kind === "node"
			? null
			: (existing?.workspaceQuotaId ??
				(await quotas_db_ensure(ctx, {
					quotaName: "files_private_workspace_bytes",
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					now,
				})));
	const userQuota = await ctx.db.get("quotas", userQuotaId);
	const workspaceQuota = workspaceQuotaId ? await ctx.db.get("quotas", workspaceQuotaId) : null;
	if (!userQuota || (workspaceQuotaId && !workspaceQuota)) {
		throw should_never_happen("Missing private storage quota", { userQuotaId, workspaceQuotaId });
	}
	const fullQuota = [userQuota, workspaceQuota].find(
		(quota) => quota && additionalCount > 0 && quota.usedCount + additionalCount > quota.maxCount,
	);
	if (fullQuota) {
		if (!args.publicationBatchId || !workspaceQuota) {
			return Result({ _nay: { name: "storage_full", message: quotas[fullQuota.quotaName].disabledReason } });
		}
		// Failed attempts stay in this allowance until their physical cleanup settles.
		const heldPublications = await ctx.db
			.query("files_private_storage_reservations")
			.withIndex("by_workspaceQuota_settlement_publicationBatch", (q) =>
				q.eq("workspaceQuotaId", workspaceQuota._id).eq("settlement.kind", "held").gt("publicationBatchId", undefined),
			)
			.take(PUBLICATION_HEADROOM_MAX_RESOURCES);
		if (
			heldPublications.length === PUBLICATION_HEADROOM_MAX_RESOURCES ||
			heldPublications.reduce((sum, reservation) => sum + reservation.byteCount, 0) + additionalCount >
				PUBLICATION_HEADROOM_BYTES
		) {
			return Result({
				_nay: { name: "storage_full", message: "Save preparation space is full. Try again after cleanup finishes" },
			});
		}
	}

	await ctx.db.patch("quotas", userQuotaId, { usedCount: userQuota.usedCount + additionalCount, updatedAt: now });
	if (workspaceQuota) {
		await ctx.db.patch("quotas", workspaceQuota._id, {
			usedCount: workspaceQuota.usedCount + additionalCount,
			updatedAt: now,
		});
	}
	if (existing) {
		await ctx.db.patch("files_private_storage_reservations", existing._id, { byteCount: args.byteCount });
		return Result({ _yay: existing._id });
	}
	return Result({
		_yay: await ctx.db.insert("files_private_storage_reservations", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			resource: args.resource,
			byteCount: args.byteCount,
			...(args.publicationBatchId ? { publicationBatchId: args.publicationBatchId } : {}),
			userQuotaId,
			workspaceQuotaId,
			createdAt: now,
			settlement: { kind: "held" },
		}),
	});
}

/**
 * Settle only after the owning mutation has handed the resource to saved storage or deleted it.
 * R2 calls this after its generation and late-PUT checks. Retired state pages remain held until
 * their final page is gone. The retained quota IDs also work after account or tenant deletion.
 * Release resources in sequence within one mutation, just like reservation.
 */
export async function files_private_storage_db_release(
	ctx: MutationCtx,
	args: {
		reservationId: Id<"files_private_storage_reservations">;
		settlement: Exclude<Doc<"files_private_storage_reservations">["settlement"], { kind: "held" }>;
	},
) {
	const reservation = await ctx.db.get("files_private_storage_reservations", args.reservationId);
	if (!reservation) {
		throw should_never_happen("Missing private storage reservation", { reservationId: args.reservationId });
	}
	if (reservation.settlement.kind !== "held") {
		return;
	}
	if (
		(args.settlement.kind === "saved" &&
			reservation.resource.kind !== "asset" &&
			reservation.resource.kind !== "node") ||
		(args.settlement.kind === "deleted" &&
			(args.settlement.proof.kind === "r2") !== (reservation.resource.kind === "asset"))
	) {
		throw should_never_happen("Invalid private storage settlement", { reservationId: args.reservationId });
	}

	const count = reservation.resource.kind === "node" ? 1 : reservation.byteCount;
	const quotaIds = [reservation.userQuotaId, ...(reservation.workspaceQuotaId ? [reservation.workspaceQuotaId] : [])];
	await ctx.db.patch("files_private_storage_reservations", reservation._id, { settlement: args.settlement });
	for (const quotaId of quotaIds) {
		const quota = await ctx.db.get("quotas", quotaId);
		if (!quota || quota.usedCount < count) {
			throw should_never_happen("Invalid private storage quota balance", {
				reservationId: args.reservationId,
				quotaId,
			});
		}
		// A zero-byte resource does not change usedCount, so an empty balance does not prove this
		// was the last reservation. Look for a remaining held reservation before deleting the quota.
		if (quota.retiredAt !== undefined && quota.usedCount === count) {
			const held =
				quotaId === reservation.userQuotaId
					? await ctx.db
							.query("files_private_storage_reservations")
							.withIndex("by_userQuota_settlement", (q) => q.eq("userQuotaId", quotaId).eq("settlement.kind", "held"))
							.first()
					: await ctx.db
							.query("files_private_storage_reservations")
							.withIndex("by_workspaceQuota_settlement", (q) =>
								q.eq("workspaceQuotaId", quotaId).eq("settlement.kind", "held"),
							)
							.first();
			if (!held) {
				await ctx.db.delete("quotas", quotaId);
				continue;
			}
		}
		await ctx.db.patch("quotas", quotaId, { usedCount: quota.usedCount - count, updatedAt: args.settlement.settledAt });
	}
}

/**
 * The caller has deleted the payload. A retired state still needs all of its pages removed.
 */
export async function files_private_storage_db_release_deleted_resource(
	ctx: MutationCtx,
	resource: Exclude<Doc<"files_private_storage_reservations">["resource"], { kind: "asset" }>,
) {
	const reservation = await ctx.db
		.query("files_private_storage_reservations")
		.withIndex("by_resource", (q) => q.eq("resource.kind", resource.kind).eq("resource.id", resource.id))
		.unique();
	if (!reservation) {
		throw should_never_happen("Deleted private resource has no storage reservation", { resourceId: resource.id });
	}
	await files_private_storage_db_release(ctx, {
		reservationId: reservation._id,
		settlement: { kind: "deleted", settledAt: Date.now(), proof: { kind: "database" } },
	});
}

/**
 * Purge has removed these DB payloads. Remote assets stay held until their deletion job settles.
 */
export async function files_private_storage_db_release_purged_resources(
	ctx: MutationCtx,
	args: { batchSize: number } & (
		| { userId: Id<"users"> }
		| { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> }
	),
) {
	const reservations =
		"userId" in args
			? await ctx.db
					.query("files_private_storage_reservations")
					.withIndex("by_user_settlement_resource", (q) =>
						q.eq("userId", args.userId).eq("settlement.kind", "held").gt("resource.kind", "asset"),
					)
					.take(args.batchSize)
			: await ctx.db
					.query("files_private_storage_reservations")
					.withIndex("by_organization_workspace_settlement_resource", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("settlement.kind", "held")
							.gt("resource.kind", "asset"),
					)
					.take(args.batchSize);
	for (const reservation of reservations) {
		const resource = reservation.resource;
		const payload =
			resource.kind === "node"
				? await ctx.db.get("files_pending_nodes", resource.id)
				: resource.kind === "state"
					? await ctx.db.get("files_pending_update_yjs_states", resource.id)
					: resource.kind === "text_input"
						? await ctx.db.get("files_pending_update_text_inputs", resource.id)
						: resource.kind === "trusted_stage"
							? await ctx.db.get("files_yjs_trusted_update_stages", resource.id)
							: reservation;
		if (payload) {
			const errorData = { reservationId: reservation._id, resource };
			console.error("Private purge left a payload before releasing its storage", errorData);
			throw should_never_happen("Private purge left a payload before releasing its storage", errorData);
		}
		await files_private_storage_db_release(ctx, {
			reservationId: reservation._id,
			settlement: { kind: "deleted", settledAt: Date.now(), proof: { kind: "database" } },
		});
	}
	return reservations.length;
}
