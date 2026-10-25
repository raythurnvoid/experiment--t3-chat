import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { plugins_schedules_db_cancel } from "./plugins_schedules_db.ts";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 500;

/**
 * The index key of one feed scope. A plugin service reads the feed of its installation through these
 * keys, so keep this the only place that builds them.
 */
export function access_control_changes_scope_key(scope: Doc<"access_control_changes">["scope"]) {
	switch (scope.kind) {
		case "plugin":
			return `plugin:${scope.pluginName}`;
		case "organization":
			return `organization:${scope.organizationId}`;
		case "workspace":
			return `workspace:${scope.workspaceId}`;
		case "installation":
			return `installation:${scope.installationId}`;
		case "service_account":
			return `service_account:${scope.serviceAccountId}`;
	}
}

// Record access changes in the same transaction as the source change.
export async function access_control_changes_db_record(
	ctx: MutationCtx,
	events: Array<Pick<Doc<"access_control_changes">, "scope" | "event">>,
) {
	if (events.length === 0) return;
	// Local scheduled runs must stop even before the external change feed starts.
	for (const { scope, event } of events) {
		if (
			event.kind !== "revoked" &&
			!(event.kind === "refresh" && (event.reason === "permissions" || event.reason === "account"))
		)
			continue;
		await plugins_schedules_db_cancel(
			ctx,
			scope.kind === "plugin"
				? { pluginName: scope.pluginName }
				: scope.kind === "organization"
					? { organizationId: scope.organizationId }
					: scope.kind === "workspace"
						? { organizationId: scope.organizationId, workspaceId: scope.workspaceId }
						: scope.kind === "installation"
							? { installationId: scope.installationId }
							: { serviceAccountId: scope.serviceAccountId },
		);
	}

	const state = await ctx.db
		.query("access_control_change_state")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();
	// Before the first lease there is no remote authority to invalidate.
	if (!state) return;

	const now = Date.now();
	const headByScopeKey = new Map<string, number>();
	await Promise.all(
		events.map((event, index) => {
			const scopeKey = access_control_changes_scope_key(event.scope);
			const revision = state.revision + index + 1;
			headByScopeKey.set(scopeKey, revision);
			return ctx.db.insert("access_control_changes", { ...event, scopeKey, revision, createdAt: now });
		}),
	);
	await ctx.db.patch("access_control_change_state", state._id, { revision: state.revision + events.length });

	// Writers serialize on the state doc above, so the heads add no new write conflict.
	await Promise.all(
		[...headByScopeKey].map(async ([scopeKey, revision]) => {
			const head = await ctx.db
				.query("access_control_change_scope_heads")
				.withIndex("by_scopeKey", (q) => q.eq("scopeKey", scopeKey))
				.first();
			if (head) await ctx.db.patch("access_control_change_scope_heads", head._id, { revision });
			else await ctx.db.insert("access_control_change_scope_heads", { scopeKey, revision });
		}),
	);

	// Start the notice dispatcher unless it already runs. It finds the receivers of these docs later.
	const dispatcher = await ctx.db
		.query("plugins_service_event_dispatcher")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();
	const job = dispatcher?.jobId ? await ctx.db.system.get("_scheduled_functions", dispatcher.jobId) : null;
	if (job?.state.kind === "pending" || job?.state.kind === "inProgress") return;

	const afterRevision = dispatcher?.dispatchedRevision ?? state.revision;
	const jobId = await ctx.scheduler.runAfter(0, internal.plugins_service_events.dispatch, {
		afterRevision,
		receiverCursor: null,
	});
	if (dispatcher) await ctx.db.patch("plugins_service_event_dispatcher", dispatcher._id, { jobId });
	else
		await ctx.db.insert("plugins_service_event_dispatcher", { key: "main", jobId, dispatchedRevision: afterRevision });
}

/**
 * Delete the scope heads of a deleted entity.
 *
 * No live installation reads the key of a deleted installation, workspace, organization, plugin, or
 * service account. So a missing head can never hide a lost change, and the retention doc stays as is.
 */
export async function access_control_changes_db_delete_scope_heads(
	ctx: MutationCtx,
	scopes: Array<Doc<"access_control_changes">["scope"]>,
) {
	await Promise.all(
		scopes.map(async (scope) => {
			const scopeKey = access_control_changes_scope_key(scope);
			const head = await ctx.db
				.query("access_control_change_scope_heads")
				.withIndex("by_scopeKey", (q) => q.eq("scopeKey", scopeKey))
				.first();
			if (head) await ctx.db.delete("access_control_change_scope_heads", head._id);
		}),
	);
}

/**
 * Delete feed docs older than 30 days. Keep every doc the notice dispatcher has not passed yet, so a
 * plugin service still gets a notice for it.
 *
 * Revisions grow with time, so the job reads the oldest revisions first and stops at the first doc it
 * must keep.
 */
export const delete_old_changes = internalMutation({
	args: {
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [retention, dispatcher] = await Promise.all([
			ctx.db
				.query("access_control_change_retention")
				.withIndex("by_key", (q) => q.eq("key", "main"))
				.first(),
			ctx.db
				.query("plugins_service_event_dispatcher")
				.withIndex("by_key", (q) => q.eq("key", "main"))
				.first(),
		]);
		if (!retention || !dispatcher) return null;

		const cutoff = Date.now() - RETENTION_MS;
		const changes = await ctx.db
			.query("access_control_changes")
			.withIndex("by_revision", (q) =>
				q.gte("revision", retention.oldestRevision).lte("revision", dispatcher.dispatchedRevision),
			)
			.take(RETENTION_BATCH_SIZE);
		const youngIndex = changes.findIndex((change) => change.createdAt >= cutoff);
		const oldChanges = youngIndex === -1 ? changes : changes.slice(0, youngIndex);
		if (oldChanges.length === 0) return null;

		await Promise.all(oldChanges.map((change) => ctx.db.delete("access_control_changes", change._id)));
		await ctx.db.patch("access_control_change_retention", retention._id, {
			oldestRevision: oldChanges.at(-1)!.revision + 1,
		});

		if (oldChanges.length === RETENTION_BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.access_control_changes.delete_old_changes, {});
		}
		return null;
	},
});
