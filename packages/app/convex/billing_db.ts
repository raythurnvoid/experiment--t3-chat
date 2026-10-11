// Lean billing helpers for modules that only check credits or enqueue usage events.
//
// Lives outside `billing.ts` because that module imports `@convex-dev/polar` and the Polar SDK,
// which cost ~100ms of module evaluation on every cold Convex call. File mutations that bill
// saves (yjs pushes, snapshot restores, pending updates) import this module instead, and the
// Polar product lookup goes through the generated component reference directly.

import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { billing_PRODUCTS } from "../shared/billing.ts";
// Keep this a type-only import. `server/billing.ts` loads the Polar SDK at module top level,
// and a value import here would put that ~100ms cold-start cost on every module that imports
// these lean helpers.
import type { billing_Event } from "../server/billing.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";

const billing_workpool_usage_event = new Workpool(components.billing_workpool_usage_event, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

/**
 * Polar answers 429 at about 100 calls a minute in sandbox and 500 in production. So mutations do
 * not send signed-in events one by one: they wait in `billing_usage_event_outbox`, and one drainer
 * chain sends at most one batch per run. A run that took a full batch runs again after 1 second,
 * otherwise after 2 seconds. That is at most 60 Polar calls a minute and about 500 events a second
 * for the whole deployment. A batch of 500 is about 330 KB, far below the 1 MB workpool payload doc.
 */
const OUTBOX_DRAIN_INTERVAL_MS = 2000;
const OUTBOX_FULL_BATCH_INTERVAL_MS = 1000;
const OUTBOX_BATCH_SIZE = 500;

/**
 * A run takes only events older than this, so a save that commits during the run rarely makes the
 * run conflict.
 */
const OUTBOX_CUTOFF_MS = 1000;

/**
 * The chain ends only after this long with nothing to send, so a slow trickle of saves does not
 * insert and delete the marker for each save.
 */
const OUTBOX_IDLE_END_MS = 30 * 1000;

/**
 * A run stamps `lastRunAt` on the marker at most this often. Savers read the marker, so each stamp
 * makes the saves in flight retry once.
 */
const OUTBOX_HEARTBEAT_MS = 60 * 1000;

/**
 * The recovery cron restarts the chain when the marker's `lastRunAt` is older than this, or when an
 * event this old waits with no marker.
 */
const OUTBOX_RECOVERY_MS = 5 * 60 * 1000;

export function billing_pick_billed_user_id(args: {
	userId: Id<"users">;
	organization: Pick<Doc<"organizations">, "default" | "billingMode" | "ownerUserId">;
}) {
	if (!args.organization.default && args.organization.billingMode === "organization_owner")
		return args.organization.ownerUserId;
	return args.userId;
}

export async function billing_db_check_credits(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		minimumRequiredCents: number;
	},
) {
	const hasCredits = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.first()
		.then(async (usageSnapshot) => {
			if (!usageSnapshot?.subscription) {
				return false;
			}

			// Same lookup as `billing_polar.getProduct`, without loading the Polar SDK module.
			const product = await ctx.runQuery(components.polar.lib.getProduct, {
				id: usageSnapshot.subscription.productId,
			});
			if (!product) return false;

			const meterBalanceCents = usageSnapshot.meter?.balance ?? 0;

			if (
				product.name === ("Free" satisfies keyof typeof billing_PRODUCTS) &&
				meterBalanceCents < args.minimumRequiredCents
			) {
				return false;
			}

			return true;
		});

	return { hasCredits };
}

/**
 * Answer whether this user pays for usage at all, for doors that are closed to `Free`.
 *
 * A credit balance cannot answer this. `Free` comes with credits every month, and a door that only
 * looked at the balance would open for a plan that never pays. An anonymous user holds a synthetic
 * snapshot carrying the real Free product id, so this refuses them through the same comparison.
 * No billing state at all means no known plan, which is not a paid one.
 */
export async function billing_db_check_paid_plan(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
	},
) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.first();
	if (!usageSnapshot?.subscription) {
		return { hasPaidPlan: false };
	}

	// Same lookup as `billing_polar.getProduct`, without loading the Polar SDK module.
	const product = await ctx.runQuery(components.polar.lib.getProduct, {
		id: usageSnapshot.subscription.productId,
	});
	if (!product) {
		return { hasPaidPlan: false };
	}

	return { hasPaidPlan: product.name !== ("Free" satisfies keyof typeof billing_PRODUCTS) };
}

/**
 * Send the one-cent `file_save` usage event for a file write that just committed.
 * Call it inside the same mutation as the write, after the write succeeded, so a rolled-back
 * write emits nothing and a committed write emits exactly once.
 *
 * The one-cent amount lives here on purpose: public workspace-file write doors use this helper.
 * Mount writes use their own event and price. The five
 * app save doors keep their own inline literal (see the billing-system skill).
 */
export async function billing_db_emit_file_save(
	ctx: MutationCtx,
	args: {
		billedUser: Doc<"users">;
		actorUserId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		/**
		 * Unique per save: a version snapshot asset id or a target id here. See the `file_save`
		 * tuple in `AppCompositeIds` for the collaborative form.
		 */
		version: string;
	},
) {
	// Declare the event against the type instead of calling `billing_event(...)`, so this module
	// never value-imports `server/billing.ts` (see the import note above).
	const event: billing_Event = {
		name: "file_save",
		externalCustomerId: args.billedUser._id,
		externalMemberId: args.actorUserId,
		externalId: composite_id(
			"billing",
			"file_save",
			args.billedUser._id,
			args.actorUserId,
			args.organizationId,
			args.workspaceId,
			args.nodeId,
			args.version,
		),
		metadata: {
			amount: 1,
			actorUserId: args.actorUserId,
			billedUserId: args.billedUser._id,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			version: args.version,
		},
	};

	await billing_ingest_events(ctx, {
		billedUserEvents: [{ billedUser: args.billedUser, event }],
	});
}

export async function billing_db_emit_file_upload(
	ctx: MutationCtx,
	args: {
		billedUser: Doc<"users">;
		actorUserId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes"> | null;
		assetId: Id<"files_r2_assets">;
		chargeKey: string;
		amount: number;
		bytes: number;
	},
) {
	const event: billing_Event = {
		name: "file_upload",
		externalCustomerId: args.billedUser._id,
		externalMemberId: args.actorUserId,
		externalId: composite_id(
			"billing",
			"file_upload",
			args.billedUser._id,
			args.actorUserId,
			args.organizationId,
			args.workspaceId,
			args.chargeKey,
		),
		metadata: {
			amount: args.amount,
			actorUserId: args.actorUserId,
			billedUserId: args.billedUser._id,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			assetId: args.assetId,
			bytes: args.bytes,
		},
	};
	await billing_ingest_events(ctx, { billedUserEvents: [{ billedUser: args.billedUser, event }] });
}

export async function billing_db_emit_plugin_volume_file_writes(
	ctx: MutationCtx,
	args: {
		billedUser: Doc<"users">;
		actorUserId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetIds: Id<"files_r2_assets">[];
	},
) {
	// New asset ids make retries unique without sending private paths to Polar.
	const billedUserEvents = args.assetIds.map((assetId) => {
		const event: billing_Event = {
			name: "plugin_volume_file_write",
			externalCustomerId: args.billedUser._id,
			externalMemberId: args.actorUserId,
			externalId: composite_id(
				"billing",
				"plugin_volume_file_write",
				args.billedUser._id,
				args.actorUserId,
				args.organizationId,
				args.workspaceId,
				assetId,
			),
			metadata: {
				amount: 0.5,
				actorUserId: args.actorUserId,
				billedUserId: args.billedUser._id,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId,
			},
		};
		return { billedUser: args.billedUser, event };
	});
	await billing_ingest_events(ctx, { billedUserEvents });
}

/**
 * Route app-owned billing events by billed user row: the Polar outbox for signed-in payers, local
 * snapshot updates for anonymous payers. An action has no db, so it enqueues its signed-in events on
 * the usage pool directly; only the admin `grant_credit` does that.
 */
export async function billing_ingest_events(
	ctx: ActionCtx | MutationCtx,
	args: {
		billedUserEvents: Array<{
			event: billing_Event;
			billedUser: Doc<"users">;
		}>;
	},
) {
	const anonymousUserEvents: typeof args.billedUserEvents = [];
	const signedInEvents: Array<billing_Event> = [];

	for (const userEvent of args.billedUserEvents) {
		if (userEvent.billedUser.clerkUserId == null) {
			anonymousUserEvents.push(userEvent);
			continue;
		}

		signedInEvents.push(userEvent.event);
	}

	await Promise.all([
		signedInEvents.length === 0
			? Promise.resolve()
			: "db" in ctx
				? db_insert_outbox_events(ctx, signedInEvents)
				: billing_workpool_usage_event.enqueueAction(ctx, internal.billing.ingest_events, {
						events: signedInEvents,
					}),
		anonymousUserEvents.length === 0
			? Promise.resolve()
			: "db" in ctx
				? billing_db_ingest_anonymous_user_events(ctx, {
						billedUserEvents: anonymousUserEvents,
					})
				: ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
						billedUserEvents: anonymousUserEvents,
					}),
	]);
}

/**
 * Insert the events into the outbox. When no drainer marker exists, insert one and schedule a run.
 *
 * Savers only insert events and read the marker, so parallel saves do not conflict, except one retry
 * when the chain starts (two savers insert a marker). A save in flight also retries once when the
 * drainer stamps the marker (at most once a minute) or ends the chain; it then inserts a new marker.
 */
async function db_insert_outbox_events(ctx: MutationCtx, events: billing_Event[]) {
	for (const event of events) await ctx.db.insert("billing_usage_event_outbox", { event });
	if (await ctx.db.query("billing_usage_event_outbox_drainers").first()) return;
	const markerId = await ctx.db.insert("billing_usage_event_outbox_drainers", { lastRunAt: Date.now() });
	await ctx.scheduler.runAfter(OUTBOX_DRAIN_INTERVAL_MS, internal.billing.drain_usage_event_outbox, { markerId });
}

/**
 * One drainer run: send up to `OUTBOX_BATCH_SIZE` old events as one `ingest_events` job on the usage
 * pool and delete them, then schedule the next run. The chain ends after `OUTBOX_IDLE_END_MS` with
 * nothing to send; `idleSince` carries that time from run to run. A missing marker ends the chain.
 *
 * The job and the deletes commit together, so each event reaches the pool once. The pool retries a
 * failed batch (429, 5xx, network) as a whole. Polar skips each event whose `externalId` it already
 * has, so a retry never counts an event twice. A batch Polar refuses (422) is split in `ingest_events`.
 */
export async function billing_db_drain_usage_event_outbox(
	ctx: MutationCtx,
	args: { markerId: Id<"billing_usage_event_outbox_drainers">; idleSince?: number },
) {
	const marker = await ctx.db.get("billing_usage_event_outbox_drainers", args.markerId);
	if (!marker) return;
	const now = Date.now();
	if (marker.lastRunAt < now - OUTBOX_HEARTBEAT_MS)
		await ctx.db.patch("billing_usage_event_outbox_drainers", marker._id, { lastRunAt: now });

	// Each run reads from the oldest event, so an event that commits late with an old creation time
	// is still sent by a later run.
	const docs = await ctx.db
		.query("billing_usage_event_outbox")
		.withIndex("by_creation_time", (q) => q.lt("_creationTime", now - OUTBOX_CUTOFF_MS))
		.take(OUTBOX_BATCH_SIZE);
	if (docs.length > 0) {
		await billing_db_enqueue_usage_events(ctx, { events: docs.map((doc) => doc.event) });
		for (const doc of docs) await ctx.db.delete("billing_usage_event_outbox", doc._id);
		await ctx.scheduler.runAfter(
			docs.length === OUTBOX_BATCH_SIZE ? OUTBOX_FULL_BATCH_INTERVAL_MS : OUTBOX_DRAIN_INTERVAL_MS,
			internal.billing.drain_usage_event_outbox,
			{ markerId: marker._id },
		);
		return;
	}

	// Before ending, read young events too: a save that committed after the read above saw the
	// marker, so it scheduled no run of its own.
	const idleSince = args.idleSince ?? now;
	if (now - idleSince < OUTBOX_IDLE_END_MS || (await ctx.db.query("billing_usage_event_outbox").first()))
		await ctx.scheduler.runAfter(OUTBOX_DRAIN_INTERVAL_MS, internal.billing.drain_usage_event_outbox, {
			markerId: marker._id,
			idleSince,
		});
	else await ctx.db.delete("billing_usage_event_outbox_drainers", marker._id);
}

/**
 * Restart a stopped drainer chain. A chain stops after a run that throws: the marker stays, so savers
 * schedule no new run. A live chain, even a slow one, stamps `lastRunAt` at least once a minute, so
 * only a stale stamp replaces the marker. The new marker stops the old chain if it still runs, so only
 * one chain sends. An old event with no marker at all also gets a new chain.
 */
export async function billing_db_recover_usage_event_outbox(ctx: MutationCtx) {
	const now = Date.now();
	const marker = await ctx.db.query("billing_usage_event_outbox_drainers").first();
	if (marker) {
		if (marker.lastRunAt >= now - OUTBOX_RECOVERY_MS) return;
		await ctx.db.delete("billing_usage_event_outbox_drainers", marker._id);
	} else {
		const oldest = await ctx.db.query("billing_usage_event_outbox").first();
		if (!oldest || oldest._creationTime >= now - OUTBOX_RECOVERY_MS) return;
	}
	const markerId = await ctx.db.insert("billing_usage_event_outbox_drainers", { lastRunAt: now });
	await ctx.scheduler.runAfter(0, internal.billing.drain_usage_event_outbox, { markerId });
}

/**
 * Move up to one batch of refused events from `billing_usage_event_rejected` back to the outbox.
 * Returns how many moved. Polar skips an event it already has, so a resend never counts twice.
 */
export async function billing_db_resend_rejected_usage_events(ctx: MutationCtx) {
	const docs = await ctx.db.query("billing_usage_event_rejected").take(OUTBOX_BATCH_SIZE);
	if (docs.length === 0) return 0;
	for (const doc of docs) await ctx.db.delete("billing_usage_event_rejected", doc._id);
	await db_insert_outbox_events(ctx, docs.map((doc) => doc.event));
	return docs.length;
}

/**
 * Enqueue one batch of signed-in usage events as one `ingest_events` job on the usage pool. When the
 * batch holds `ai_usage` events, the job's `onComplete` records their delivery on the model call
 * receipts. `runAfter` delays the job, for a Polar 429.
 */
export async function billing_db_enqueue_usage_events(
	ctx: ActionCtx | MutationCtx,
	args: { events: billing_Event[]; runAfter?: number },
) {
	const { events, runAfter } = args;
	const receipts = events.flatMap((event) =>
		event.name === "ai_usage"
			? [{ modelCallId: event.metadata.modelCallId, imageCallId: event.metadata.imageCallId }]
			: [],
	);
	// A plain batch needs no options.
	if (receipts.length === 0 && runAfter === undefined) {
		await billing_workpool_usage_event.enqueueAction(ctx, internal.billing.ingest_events, { events });
		return;
	}
	await billing_workpool_usage_event.enqueueAction(
		ctx,
		internal.billing.ingest_events,
		{ events },
		receipts.length === 0
			? { runAfter }
			: { runAfter, onComplete: internal.ai_model_call_receipts.on_batch_delivery_complete, context: { receipts } },
	);
}

/**
 * Debit an anonymous user's local credit snapshot. Returns `false` when the user has no snapshot
 * with a meter, for example after sign-in deleted it.
 */
export async function billing_db_debit_anonymous_snapshot(
	ctx: MutationCtx,
	args: { userId: Id<"users">; amount: number },
) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.first();
	if (!usageSnapshot || usageSnapshot.meter === null) return false;

	await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
		meter: {
			...usageSnapshot.meter,
			consumedUnits: usageSnapshot.meter.consumedUnits + args.amount,
			balance: usageSnapshot.meter.balance - args.amount,
		},
		lastSyncedAt: Date.now(),
	});
	return true;
}

/**
 * Use the caller's DB context so a mixed Save counts these writes in its budget.
 */
export async function billing_db_ingest_anonymous_user_events(
	ctx: MutationCtx,
	args: { billedUserEvents: Array<{ event: billing_Event; billedUser: Doc<"users"> }> },
) {
	// Several files can bill the same payer in one transaction. Each debit sees the last one.
	for (const { event, billedUser } of args.billedUserEvents) {
		if (billedUser.clerkUserId != null) {
			console.error("Anonymous billing ingest received a signed-in user doc", { billedUserId: billedUser._id, event });
			continue;
		}
		if (event.metadata.amount === 0) continue;
		const debited = await billing_db_debit_anonymous_snapshot(ctx, {
			userId: billedUser._id,
			amount: event.metadata.amount,
		});
		if (!debited) {
			throw should_never_happen("Anonymous user usage snapshot not found or has no meter", {
				userId: billedUser._id,
				event,
			});
		}
	}
}
