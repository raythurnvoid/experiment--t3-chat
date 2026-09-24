import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import schema from "./schema.ts";
import { activities_db_require_by_source_id, activities_is_active } from "./activities_db.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const HOLD_BATCH_SIZE = 32;
const SOURCE_HOLD_READ_LIMIT = 8;
const MAX_PRIVATE_ANCESTORS = 256;
const OUTPUT_REVIEW_MS = 4 * 60 * 60 * 1000;

async function db_get_producer(ctx: MutationCtx, producer: Doc<"files_pending_holds">["producer"]) {
	const run =
		producer.kind === "files_transfer_run"
			? await ctx.db.get("files_transfer_runs", producer.id)
			: await ctx.db.get("files_pending_update_runs", producer.id);
	if (!run) return null;
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	return {
		userId: run.userId,
		activity,
		sourceScope: "sourceScope" in run ? run.sourceScope : run,
		destinationScope: "destinationScope" in run ? run.destinationScope : run,
		outputReviewUntil: run.outputReviewUntil,
	};
}

async function db_matches_identity(
	ctx: MutationCtx,
	identity: Pick<
		Doc<"files_pending_holds">,
		"organizationId" | "workspaceId" | "userId" | "target" | "privateGeneration"
	>,
	proposal: Doc<"files_pending_updates">,
) {
	if (
		identity.organizationId !== proposal.organizationId ||
		identity.workspaceId !== proposal.workspaceId ||
		identity.userId !== proposal.userId ||
		identity.target.kind !== proposal.target.kind ||
		identity.target.id !== proposal.target.id
	)
		return false;
	if (identity.target.kind === "saved") return identity.privateGeneration === null;
	const node = await ctx.db.get("files_pending_nodes", identity.target.id);
	return node?.state === "active" && node.creationGeneration === identity.privateGeneration;
}

function terminal_deadline(producer: NonNullable<Awaited<ReturnType<typeof db_get_producer>>>) {
	if (producer.activity.finishedAt === undefined || producer.outputReviewUntil === undefined)
		throw should_never_happen("Terminal proposal producer has no review deadline", {
			source: producer.activity.source,
		});
	return producer.outputReviewUntil;
}

function keeps_terminal_output(role: Doc<"files_pending_holds">["role"]) {
	return role === "output" || role === "destination_parent" || role === "review";
}

/**
 * Holds only delay expiry. Callers still check access and the exact selected work.
 */
export async function files_pending_holds_db_acquire(
	ctx: MutationCtx,
	args: {
		producer: Doc<"files_pending_holds">["producer"];
		pendingUpdateId: Id<"files_pending_updates">;
		target: Doc<"files_pending_holds">["target"];
		privateGeneration: number | null;
		expectedRevision: number;
		role: Doc<"files_pending_holds">["role"];
	},
) {
	const producer = await db_get_producer(ctx, args.producer);
	const proposal = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
	if (
		!producer ||
		!proposal ||
		!activities_is_active(producer.activity.status) ||
		producer.userId !== proposal.userId ||
		(args.producer.kind === "files_pending_update_run") !== (args.role === "review")
	)
		return Result({ _nay: { name: "target_changed", message: "The proposal job is no longer current" } });
	const scope = args.role === "source" ? producer.sourceScope : producer.destinationScope;
	const identity = {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		userId: producer.userId,
		target: args.target,
		privateGeneration: args.privateGeneration,
	};
	if (proposal.revision !== args.expectedRevision || !(await db_matches_identity(ctx, identity, proposal)))
		return Result({ _nay: { name: "target_changed", message: "This draft changed. Review it again" } });
	const existing = await ctx.db
		.query("files_pending_holds")
		.withIndex("by_producer_pendingUpdate_role", (q) =>
			q
				.eq("producer.kind", args.producer.kind)
				.eq("producer.id", args.producer.id)
				.eq("pendingUpdateId", proposal._id)
				.eq("role", args.role),
		)
		.unique();
	if (existing) {
		if (!(await db_matches_identity(ctx, existing, proposal)))
			return Result({ _nay: { name: "target_changed", message: "This draft changed. Review it again" } });
	} else {
		await ctx.db.insert("files_pending_holds", {
			...identity,
			pendingUpdateId: proposal._id,
			producer: args.producer,
			role: args.role,
		});
	}
	if (args.role === "output") {
		// Ready output replaces only its preparation hold, not source or parent roles.
		const preparing = await ctx.db
			.query("files_pending_holds")
			.withIndex("by_producer_pendingUpdate_role", (q) =>
				q
					.eq("producer.kind", args.producer.kind)
					.eq("producer.id", args.producer.id)
					.eq("pendingUpdateId", proposal._id)
					.eq("role", "preparing_output"),
			)
			.unique();
		if (preparing) await ctx.db.delete("files_pending_holds", preparing._id);
	}
	return Result({ _yay: null });
}

async function db_release_hold(ctx: MutationCtx, hold: Doc<"files_pending_holds">) {
	const proposal = await ctx.db.get("files_pending_updates", hold.pendingUpdateId);
	if (proposal && (await db_matches_identity(ctx, hold, proposal))) {
		const producer = await db_get_producer(ctx, hold.producer);
		if (producer && !activities_is_active(producer.activity.status) && keeps_terminal_output(hold.role)) {
			// Install the fixed window before dropping the last producer reference. Patch only the
			// expiry, so the proposal revision and the review clock stay the same. The expiry moves
			// later, so the owner's expiry check already runs early enough.
			const expiresAt = terminal_deadline(producer);
			if (expiresAt > proposal.expiresAt) await ctx.db.patch("files_pending_updates", proposal._id, { expiresAt });
		}
	}
	await ctx.db.delete("files_pending_holds", hold._id);
}

export async function files_pending_holds_db_release(
	ctx: MutationCtx,
	args: {
		producer: Doc<"files_pending_holds">["producer"];
		pendingUpdateId: Id<"files_pending_updates">;
		role?: Doc<"files_pending_holds">["role"];
	},
) {
	const holds = await ctx.db
		.query("files_pending_holds")
		.withIndex("by_producer_pendingUpdate_role", (q) => {
			const pair = q
				.eq("producer.kind", args.producer.kind)
				.eq("producer.id", args.producer.id)
				.eq("pendingUpdateId", args.pendingUpdateId);
			return args.role === undefined ? pair : pair.eq("role", args.role);
		})
		.take(5);
	for (const hold of holds) await db_release_hold(ctx, hold);
}

/**
 * Call after Activity finish, in the same mutation. A replay never moves the window.
 */
export async function files_pending_holds_db_finish(
	ctx: MutationCtx,
	args: { producer: Doc<"files_pending_holds">["producer"] },
) {
	const producer = await db_get_producer(ctx, args.producer);
	if (!producer) return;
	if (activities_is_active(producer.activity.status) || producer.activity.finishedAt === undefined)
		throw should_never_happen("Finish the Activity before releasing proposal holds", { producer: args.producer });
	if (producer.outputReviewUntil !== undefined) return;
	const outputReviewUntil = producer.activity.finishedAt + OUTPUT_REVIEW_MS;
	if (args.producer.kind === "files_transfer_run")
		await ctx.db.patch("files_transfer_runs", args.producer.id, { outputReviewUntil });
	else await ctx.db.patch("files_pending_update_runs", args.producer.id, { outputReviewUntil });
	await ctx.scheduler.runAfter(0, internal.files_pending_holds.release_producer, args);
}

/**
 * History keeps the producer and Activity until every page has released its holds.
 */
export async function files_pending_holds_db_release_producer_batch(
	ctx: MutationCtx,
	args: { producer: Doc<"files_pending_holds">["producer"] },
) {
	const producer = await db_get_producer(ctx, args.producer);
	if (producer && activities_is_active(producer.activity.status)) return { done: false, deletedCount: 0 };
	const holds = await ctx.db
		.query("files_pending_holds")
		.withIndex("by_producer_pendingUpdate_role", (q) =>
			q.eq("producer.kind", args.producer.kind).eq("producer.id", args.producer.id),
		)
		.take(HOLD_BATCH_SIZE);
	for (const hold of holds) await db_release_hold(ctx, hold);
	return { done: holds.length < HOLD_BATCH_SIZE, deletedCount: holds.length };
}

async function db_has_ancestor_source_hold(ctx: MutationCtx, proposal: Doc<"files_pending_updates">) {
	if (proposal.target.kind !== "private") return false;
	let node = await ctx.db.get("files_pending_nodes", proposal.target.id);
	let checkedHolds = 0;
	for (let depth = 0; depth < MAX_PRIVATE_ANCESTORS; depth++) {
		if (
			!node ||
			node.state !== "active" ||
			node.userId !== proposal.userId ||
			node.organizationId !== proposal.organizationId ||
			node.workspaceId !== proposal.workspaceId
		)
			return false;
		if (depth > 0) {
			const privateNodeId = node._id;
			const remaining = SOURCE_HOLD_READ_LIMIT - checkedHolds;
			const holds = await ctx.db
				.query("files_pending_holds")
				.withIndex("by_target_role", (q) =>
					q.eq("target.kind", "private").eq("target.id", privateNodeId).eq("role", "source"),
				)
				.take(remaining);
			for (const hold of holds) {
				const parentProposal = await ctx.db.get("files_pending_updates", hold.pendingUpdateId);
				if (parentProposal && (await db_matches_identity(ctx, hold, parentProposal))) {
					const producer = await db_get_producer(ctx, hold.producer);
					if (producer && activities_is_active(producer.activity.status)) return true;
				}
				await db_release_hold(ctx, hold);
			}
			checkedHolds += holds.length;
			// Drain stale holds first. Never expire after an incomplete ancestor check.
			if (checkedHolds === SOURCE_HOLD_READ_LIMIT) return true;
		}
		if (node.parent.kind !== "private") return false;
		node = await ctx.db.get("files_pending_nodes", node.parent.id);
	}
	return true;
}

async function db_has_copying_retry(ctx: MutationCtx, proposal: Doc<"files_pending_updates">) {
	let privateGeneration: number | null = null;
	if (proposal.target.kind === "private") {
		const node = await ctx.db.get("files_pending_nodes", proposal.target.id);
		if (
			!node ||
			node.state !== "active" ||
			node.userId !== proposal.userId ||
			node.organizationId !== proposal.organizationId ||
			node.workspaceId !== proposal.workspaceId
		)
			return false;
		privateGeneration = node.creationGeneration;
	}
	// Bind the frozen output, not a later proposal or replacement on the same saved node.
	const item = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_outputProposal_pendingUpdate", (q) => q.eq("outputProposal.pendingUpdateId", proposal._id))
		.order("desc")
		.first();
	if (
		!item ||
		item.state !== "completed" ||
		item.outputTarget?.kind !== proposal.target.kind ||
		item.outputTarget.id !== proposal.target.id ||
		item.outputProposal?.privateGeneration !== privateGeneration ||
		item.outputProposal.replacementAssetId !== (proposal.pendingReplacement?.assetId ?? null)
	)
		return false;
	const previous = await ctx.db.get("files_transfer_runs", item.runId);
	if (
		!previous ||
		previous.kind !== "copy" ||
		previous.publication !== "proposal" ||
		previous.userId !== proposal.userId ||
		previous.destinationScope.organizationId !== proposal.organizationId ||
		previous.destinationScope.workspaceId !== proposal.workspaceId
	)
		return false;
	const retry = await ctx.db
		.query("files_transfer_runs")
		.withIndex("by_retryOf", (q) => q.eq("retryOf", previous._id).eq("step", "retry"))
		.first();
	if (
		!retry ||
		retry.kind !== "copy" ||
		retry.publication !== "proposal" ||
		retry.userId !== proposal.userId ||
		retry.destinationScope.organizationId !== proposal.organizationId ||
		retry.destinationScope.workspaceId !== proposal.workspaceId
	)
		return false;
	// Stop finishes manifest cloning too. Per-output holds take over as each page lands.
	return activities_is_active((await activities_db_require_by_source_id(ctx, retry._id)).status);
}

export async function files_pending_holds_db_check_expiry(
	ctx: MutationCtx,
	args: { pendingUpdate: Doc<"files_pending_updates"> },
) {
	const holds = await ctx.db
		.query("files_pending_holds")
		.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", args.pendingUpdate._id))
		.take(HOLD_BATCH_SIZE);
	let expiresAt: number | null = null;
	for (const hold of holds) {
		if (await db_matches_identity(ctx, hold, args.pendingUpdate)) {
			const producer = await db_get_producer(ctx, hold.producer);
			if (producer && activities_is_active(producer.activity.status)) return { held: true, expiresAt };
			if (producer && keeps_terminal_output(hold.role))
				expiresAt = Math.max(expiresAt ?? 0, terminal_deadline(producer));
		}
		await db_release_hold(ctx, hold);
	}
	// More holds may include a live producer. Drain another page before deleting anything.
	return {
		held:
			holds.length === HOLD_BATCH_SIZE ||
			(await db_has_ancestor_source_hold(ctx, args.pendingUpdate)) ||
			(await db_has_copying_retry(ctx, args.pendingUpdate)),
		expiresAt,
	};
}

export const release_producer = internalMutation({
	args: { producer: doc(schema, "files_pending_holds").fields.producer },
	returns: v.null(),
	handler: async (ctx, args) => {
		const producer = await db_get_producer(ctx, args.producer);
		if (producer && activities_is_active(producer.activity.status)) return null;
		if (!(await files_pending_holds_db_release_producer_batch(ctx, args)).done)
			await ctx.scheduler.runAfter(0, internal.files_pending_holds.release_producer, args);
		return null;
	},
});

/**
 * Backstop for interrupted releases and stale identities.
 */
export const recover = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("files_pending_holds")
			.paginate({ cursor: args.cursor ?? null, numItems: HOLD_BATCH_SIZE });
		for (const hold of page.page) {
			const proposal = await ctx.db.get("files_pending_updates", hold.pendingUpdateId);
			const producer = await db_get_producer(ctx, hold.producer);
			if (
				!proposal ||
				!producer ||
				!activities_is_active(producer.activity.status) ||
				!(await db_matches_identity(ctx, hold, proposal))
			)
				await db_release_hold(ctx, hold);
		}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.files_pending_holds.recover, { cursor: page.continueCursor });
		return null;
	},
});
