/**
 * Plugin run execution. Life of a run: enqueued (upload event or manual request) → picked up by
 * the workpool executor → claimed by start_event_run, which issues a per-run `plr_` API token →
 * executed by POSTing to the plugin runner → settled by finish_event_run. While running, the
 * plugin authenticates against the public `/api/v1/*` machine API as a `plugin_run` service
 * principal (resolved in public_api.ts) to download its source file and write Markdown outputs.
 *
 * Three credentials: PLUGIN_RUNNER_SECRET authenticates Convex → runner requests; the per-run
 * `plr_` token (stored hashed on the run) authenticates plugin → public API calls; and the
 * runner-internal /api/internal/plugins/host/* routes below additionally require
 * PLUGIN_RUNNER_HOST_SECRET, so plugin code can never forge the runner-only secret and outbound
 * telemetry calls.
 */
import { Workpool } from "@convex-dev/workpool";
import { doc } from "convex-helpers/validators";
import type { RegisteredMutation, RouteSpec } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";

import { components, internal } from "./_generated/api.js";
import { httpAction, internalAction, internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import type { RouterForConvexModules } from "./http.ts";
import { type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import { type api_schemas_BuildResponseSpecFromHandler, type pluginRunnerApiSchema } from "common/api-schemas.ts";
import { Result, Result_try_promise } from "common/errors-as-values-utils.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_node_has_editable_yjs_state } from "../server/files.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { crypto_random_hex, crypto_sha256_hex, crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import type { plugins_decrypt_secret_for_runtime_Result } from "./plugins.ts";
// Type-only import: public_api.ts value-imports this module, so a value import here would be a
// runtime cycle.
import type { public_api_resolve_principal_Result } from "./public_api.ts";
import { plugins_validate_secret_name } from "../shared/plugins.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

// 10 minutes. The real execution ceiling is the Convex action timeout plus the runner request
// timeout below; the TTL only needs to cover queue wait on top of that. Runs past it are
// refused at start or failed by the expiry cron.
const RUN_TTL_MS = 10 * 60 * 1000;
// 3 minutes.
const RUNNER_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
// One shared transactional quota across every plugin-consuming call, whatever the route.
const MAX_API_CALLS = 20;
const RUNNER_ERROR_MESSAGE_MAX_CHARS = 500;
// 30 days.
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_EXPIRY_BATCH_SIZE = 50;
const RUN_CLEANUP_BATCH_SIZE = 50;

const UPLOAD_COMPLETED_EVENT_TYPE = "files.upload.completed" as const;
const RUN_REQUESTED_EVENT_TYPE = "files.run.requested" as const;

/**
 * Finite attempts on purpose: the executor catches everything and finishes the run failed, so a
 * retry only fires on a genuine crash (OOM/timeout) — the retried attempt then fails fast because
 * start_event_run refuses a run that is already "running".
 */
const plugin_event_execution_workpool = new Workpool(components.plugins_runtime_workpool, {
	maxParallelism: 4,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 1000,
		base: 2,
		maxAttempts: 3,
	} as const,
});

if (!process.env.PLUGIN_RUNNER_URL) {
	throw new Error("PLUGIN_RUNNER_URL is not set in Convex env");
}
const PLUGIN_RUNNER_URL = process.env.PLUGIN_RUNNER_URL;

if (!process.env.PLUGIN_RUNNER_SECRET) {
	throw new Error("PLUGIN_RUNNER_SECRET is not set in Convex env");
}
const PLUGIN_RUNNER_SECRET = process.env.PLUGIN_RUNNER_SECRET;

// Distinct from PLUGIN_RUNNER_SECRET on purpose: this one proves a host call came from the
// trusted runner shell (not from plugin code holding only its run token), so the two secrets
// must be rotatable independently.
if (!process.env.PLUGIN_RUNNER_HOST_SECRET) {
	throw new Error("PLUGIN_RUNNER_HOST_SECRET is not set in Convex env");
}
const PLUGIN_RUNNER_HOST_SECRET = process.env.PLUGIN_RUNNER_HOST_SECRET;

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
}
const HOST_ORIGIN = process.env.VITE_CONVEX_HTTP_URL;

function get_bearer_token(request: Request) {
	const header = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) {
		return null;
	}
	return header.slice(prefix.length);
}

/**
 * Cached SHA-256 of the secret: the auth check compares this fixed-length digest against the
 * digest of the presented token so the constant-time compare leaks nothing about secret length.
 */
const get_plugin_runner_host_secret_hash = ((/* iife */) => {
	let hashPromise: Promise<string> | undefined;

	return function get_plugin_runner_host_secret_hash() {
		hashPromise ??= crypto_sha256_hex(PLUGIN_RUNNER_HOST_SECRET);
		return hashPromise;
	};
})();

/**
 * Convex db.patch treats an explicit `undefined` value as "unset this field", so an optional
 * patch field that may already hold a value written earlier must be omitted entirely rather
 * than passed as undefined. Inserts and function args don't need this: the serializer drops
 * undefined fields there.
 */
function pick_defined_props<T extends Record<string, unknown>>(obj: T) {
	return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as {
		[K in keyof T]?: Exclude<T[K], undefined>;
	};
}

/**
 * The single decision point for plugin dispatch on a finalized upload: checks eligibility itself
 * and enqueues one run per enabled installation subscribed to the upload's content type.
 * Ineligible uploads (non-file node, reserved tenant scope, missing content type, nothing
 * subscribed, already-dispatched event) are a normal `enqueued: 0` outcome, not an error. The
 * upload's own pipeline state (`processingWorkId`) is the caller's concern, not this function's.
 */
export async function plugins_runtime_db_enqueue_upload_completed_runs(
	ctx: MutationCtx,
	args: {
		asset: Doc<"files_r2_assets">;
		fileNode: Doc<"files_nodes">;
		eventId: string;
	},
) {
	if (
		args.fileNode.assetId !== args.asset._id ||
		args.fileNode.kind !== "file" ||
		files_node_has_editable_yjs_state(args.fileNode)
	) {
		return { enqueued: 0 };
	}

	if (!args.asset.r2Key) {
		const errorMessage = "asset.r2Key is not set for plugin upload event";
		console.error(errorMessage, { assetId: args.asset._id });
		throw should_never_happen(errorMessage, { assetId: args.asset._id });
	}

	// Plugin runs fire only for real tenant uploads: assets in the global organization, in a
	// reserved workspace (e.g. plugin source mounts), or created by the system are not user uploads.
	const { organizationId, workspaceId, createdBy } = args.asset;
	if (
		organizationId === organizations_GLOBAL_ORGANIZATION_ID ||
		organizations_is_reserved_workspace_id(workspaceId) ||
		createdBy === users_SYSTEM_AUTHOR
	) {
		return { enqueued: 0 };
	}

	const contentType = args.fileNode.contentType;
	if (!contentType) {
		return { enqueued: 0 };
	}

	// Check what installed plugins can be triggered on this upload.
	const handlers = await ctx.db
		.query("plugins_workspace_event_handlers")
		.withIndex("by_scope_event_contentType_createdAt_name", (q) =>
			q
				.eq("organizationId", organizationId)
				.eq("workspaceId", workspaceId)
				.eq("event", UPLOAD_COMPLETED_EVENT_TYPE)
				.eq("contentType", contentType),
		)
		.collect();

	// Load each handler's installation and version and drop the ones that can no longer run
	// (disabled installation, version without a backend).
	const candidateReads = await Promise.all(
		handlers.map(async (handler) => {
			const [installation, version] = await Promise.all([
				ctx.db.get("plugins_workspace_installations", handler.installationId),
				ctx.db.get("plugins_versions", handler.pluginVersionId),
			]);
			return { installation, version };
		}),
	);

	const candidates: Array<{
		installation: Doc<"plugins_workspace_installations">;
		version: Doc<"plugins_versions">;
	}> = [];
	for (const { installation, version } of candidateReads) {
		if (!installation || !version || installation.status !== "enabled" || !version.backendEntrypointFile) {
			continue;
		}
		candidates.push({ installation, version });
	}

	const now = Date.now();
	let enqueued = 0;

	for (const candidate of candidates) {
		// Skip if this installation already ran for this upload: an asset is uploaded only once, so
		// a second upload-completed event can only be an R2 redelivery (with a fresh event id).
		// Note: this dedupe on (asset, installation) only works for once-per-asset events; a
		// repeatable event (e.g. a future file edit) must dedupe on a per-occurrence key instead.
		const existingPluginRun = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_asset_event_installation", (q) =>
				q
					.eq("assetId", args.asset._id)
					.eq("event", UPLOAD_COMPLETED_EVENT_TYPE)
					.eq("installationId", candidate.installation._id),
			)
			.first();
		if (existingPluginRun) {
			continue;
		}

		// Create a run with a work id that allows the queued work to be cancelled later.
		const runId = await ctx.db.insert("plugins_event_runs", {
			organizationId,
			workspaceId,
			assetId: args.asset._id,
			fileNodeId: args.fileNode._id,
			actorUserId: createdBy,
			installationId: candidate.installation._id,
			pluginVersionId: candidate.version._id,
			event: UPLOAD_COMPLETED_EVENT_TYPE,
			eventId: composite_id("plugin", "upload_completed", args.eventId, String(candidate.installation._id)),
			status: "queued",
			acceptedCapabilities: candidate.installation.acceptedCapabilities,
			expiresAt: now + RUN_TTL_MS,
			apiCallCount: 0,
			outputWriteCount: 0,
			errorMessage: null,
			updatedAt: now,
		});

		const workId = await plugin_event_execution_workpool.enqueueAction(
			ctx,
			internal.plugins_runtime.execute_upload_completed_event_run,
			{
				runId,
			},
		);
		await ctx.db.patch("plugins_event_runs", runId, {
			workId,
			updatedAt: now,
		});

		enqueued += 1;
	}

	return { enqueued };
}

export async function plugins_runtime_db_enqueue_manual_run(
	ctx: MutationCtx,
	args: {
		asset: Doc<"files_r2_assets">;
		fileNode: Doc<"files_nodes">;
		installation: Doc<"plugins_workspace_installations">;
	},
) {
	const version = await ctx.db.get("plugins_versions", args.installation.pluginVersionId);
	if (!version) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (!version.backendEntrypointFile) {
		return Result({ _nay: { message: "Plugin cannot process files" } });
	}

	// Manual runs never dedupe by eventId, but at most one live run may exist per
	// installation+file across both trigger sources. Expired queued/running docs
	// (start_event_run refuses them) must not block a re-run forever.
	const now = Date.now();
	for (const event of [UPLOAD_COMPLETED_EVENT_TYPE, RUN_REQUESTED_EVENT_TYPE] as const) {
		const recentPluginRuns = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_asset_event_installation", (q) =>
				q.eq("assetId", args.asset._id).eq("event", event).eq("installationId", args.installation._id),
			)
			.order("desc")
			.take(5);
		if (
			recentPluginRuns.some(
				(pluginRun) => (pluginRun.status === "queued" || pluginRun.status === "running") && pluginRun.expiresAt > now,
			)
		) {
			return Result({ _nay: { message: "A run for this plugin is already pending for this file" } });
		}
	}

	const runId = await ctx.db.insert("plugins_event_runs", {
		organizationId: args.installation.organizationId,
		workspaceId: args.installation.workspaceId,
		assetId: args.asset._id,
		fileNodeId: args.fileNode._id,
		// Unlike the upload path (asset creator), admin-triggered manual runs attribute output writes
		// to the plugin's installer.
		actorUserId: args.installation.installedBy,
		installationId: args.installation._id,
		pluginVersionId: version._id,
		event: RUN_REQUESTED_EVENT_TYPE,
		eventId: composite_id("plugin", "run_requested", crypto.randomUUID(), String(args.installation._id)),
		status: "queued",
		acceptedCapabilities: args.installation.acceptedCapabilities,
		expiresAt: now + RUN_TTL_MS,
		apiCallCount: 0,
		outputWriteCount: 0,
		errorMessage: null,
		updatedAt: now,
	});

	const workId = await plugin_event_execution_workpool.enqueueAction(
		ctx,
		internal.plugins_runtime.execute_upload_completed_event_run,
		{
			runId,
		},
	);
	await ctx.db.patch("plugins_event_runs", runId, {
		workId,
		updatedAt: now,
	});

	return Result({ _yay: { runId } });
}

export const start_event_run = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		apiTokenHash: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			pluginRun: doc(app_convex_schema, "plugins_event_runs"),
			asset: doc(app_convex_schema, "files_r2_assets"),
			fileNode: doc(app_convex_schema, "files_nodes"),
			installation: doc(app_convex_schema, "plugins_workspace_installations"),
			version: doc(app_convex_schema, "plugins_versions"),
			outboundOrigins: v.array(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const pluginRun = await ctx.db.get("plugins_event_runs", args.runId);
		if (!pluginRun) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (pluginRun.status !== "queued") {
			// A "running" run here means a previous executor attempt crashed mid-run and the
			// workpool retried; the retry must not restart the run.
			return Result({ _nay: { message: pluginRun.status === "running" ? "Run was interrupted" : "Not found" } });
		}
		if (pluginRun.expiresAt <= Date.now()) {
			return Result({ _nay: { message: "Run expired" } });
		}

		const [asset, fileNode, installation, version] = await Promise.all([
			ctx.db.get("files_r2_assets", pluginRun.assetId),
			ctx.db.get("files_nodes", pluginRun.fileNodeId),
			ctx.db.get("plugins_workspace_installations", pluginRun.installationId),
			ctx.db.get("plugins_versions", pluginRun.pluginVersionId),
		]);
		if (!asset || !fileNode || !installation || !version || !version.backendEntrypointFile) {
			return Result({ _nay: { message: "Not found" } });
		}

		const now = Date.now();
		await ctx.db.patch("plugins_event_runs", pluginRun._id, {
			status: "running",
			apiTokenHash: args.apiTokenHash,
			// The API token stays valid for the life of the run; a shorter TTL would silently cut
			// off API access mid-run for plugins that outlive it.
			apiTokenExpiresAt: pluginRun.expiresAt,
			startedAt: now,
			updatedAt: now,
		});

		const patchedPluginRun = await ctx.db.get("plugins_event_runs", pluginRun._id);
		if (!patchedPluginRun) {
			// Unreachable: the run was patched in this same transaction.
			throw should_never_happen("plugins_event_runs doc missing right after patch", { runId: pluginRun._id });
		}

		return Result({
			_yay: {
				pluginRun: patchedPluginRun,
				asset,
				fileNode,
				installation,
				version,
				// The origins the installer consented to are the only ones the plugin may fetch from;
				// a version can only change them through a new install/update consent.
				outboundOrigins: installation.acceptedOutboundOrigins,
			},
		});
	},
});

type start_event_run_Result =
	typeof start_event_run extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Terminalization side effects shared by finish_event_run and the expiry cron: any call the
 * plugin left started is settled failed, and any write stage it left unpublished is scheduled for
 * cleanup. Bounded by the 20-call invariant (calls and stages both descend from consumed
 * call slots).
 */
async function db_terminalize_run_leftovers(ctx: MutationCtx, args: { runId: Id<"plugins_event_runs">; now: number }) {
	const [calls, stages] = await Promise.all([
		ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
			.take(MAX_API_CALLS),
		ctx.db
			.query("public_api_file_write_stages")
			.withIndex("by_run", (q) => q.eq("runId", args.runId))
			.collect(),
	]);
	await Promise.all([
		...calls
			.filter((call) => call.status === "started")
			.map((call) =>
				ctx.db.patch("plugins_event_run_calls", call._id, {
					status: "failed",
					errorCode: "run_ended",
					errorMessage: "Run ended before the call finished",
					finishedAt: args.now,
					elapsedMs: args.now - call.startedAt,
					updatedAt: args.now,
				}),
			),
		...stages.map((stage) =>
			ctx.scheduler.runAfter(0, internal.public_api.cleanup_file_write_stage, { stageId: stage._id }),
		),
	]);
}

export const finish_event_run = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		// "failed" reports a hard failure the executor already classified (start refused, backend
		// missing, runner unreachable). "runner_response" hands over the raw runner outcome and the
		// success/failure classification happens here, in the same transaction that reads the run's
		// calls — the executor must not classify from a completion-state query that can go
		// stale between read and write.
		outcome: v.union(
			v.object({
				kind: v.literal("failed"),
				errorMessage: v.string(),
			}),
			v.object({
				kind: v.literal("runner_response"),
				runnerOk: v.boolean(),
				runnerHttpStatus: v.number(),
				bodyStatus: v.union(v.literal("succeeded"), v.literal("errored")),
				runnerErrorMessage: v.union(v.string(), v.null()),
				pluginStatus: v.optional(v.number()),
				runnerElapsedMs: v.optional(v.number()),
				runnerOutputBytes: v.optional(v.number()),
				runnerOutputTruncated: v.optional(v.boolean()),
			}),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const pluginRun = await ctx.db.get("plugins_event_runs", args.runId);
		// A run that is no longer live was already settled (the expiry cron or a duplicate finish won);
		// finishing is a no-op, not an error. "queued" is live too: a refused start still settles here.
		if (!pluginRun || (pluginRun.status !== "queued" && pluginRun.status !== "running")) {
			return null;
		}

		const now = Date.now();
		const outcome = args.outcome;
		let succeeded = false;
		let errorMessage: string | null = null;

		if (outcome.kind === "failed") {
			errorMessage = outcome.errorMessage;
		} else {
			const [calls, stages] = await Promise.all([
				ctx.db
					.query("plugins_event_run_calls")
					.withIndex("by_run_sequence", (q) => q.eq("runId", pluginRun._id))
					.take(MAX_API_CALLS),
				ctx.db
					.query("public_api_file_write_stages")
					.withIndex("by_run", (q) => q.eq("runId", pluginRun._id))
					.collect(),
			]);
			const startedCallCount = calls.filter((call) => call.status === "started").length;
			const pluginStatusIsOk =
				outcome.pluginStatus === undefined || (outcome.pluginStatus >= 200 && outcome.pluginStatus < 300);

			// A clean runner exit is not enough: the plugin must also have published at least one
			// output, left no API call unfinished, and left no staged write unpublished.
			succeeded =
				outcome.runnerOk &&
				outcome.bodyStatus === "succeeded" &&
				pluginRun.outputWriteCount > 0 &&
				startedCallCount === 0 &&
				stages.length === 0 &&
				pluginStatusIsOk;

			errorMessage = succeeded
				? null
				: outcome.pluginStatus !== undefined && (outcome.pluginStatus < 200 || outcome.pluginStatus >= 300)
					? `Plugin returned status ${outcome.pluginStatus}`
					: outcome.runnerErrorMessage
						? outcome.runnerErrorMessage
						: startedCallCount
							? "Plugin left API calls unfinished"
							: stages.length
								? "Plugin left an output write unpublished"
								: outcome.runnerOk && outcome.bodyStatus === "succeeded"
									? "Plugin produced no Markdown output"
									: `Plugin runner failed with status ${outcome.runnerHttpStatus}`;
		}

		if (!succeeded) {
			console.error("Plugin event run failed", { runId: pluginRun._id, errorMessage });
		}

		await Promise.all([
			ctx.db.patch("plugins_event_runs", pluginRun._id, {
				status: succeeded ? "succeeded" : "failed",
				errorMessage,
				// Terminal runs must not authenticate: explicit undefined unsets both token fields.
				apiTokenHash: undefined,
				apiTokenExpiresAt: undefined,
				...(outcome.kind === "runner_response"
					? {
							runnerHttpStatus: outcome.runnerHttpStatus,
							runnerElapsedMs: outcome.runnerElapsedMs,
							pluginStatus: outcome.pluginStatus,
							runnerOutputBytes: outcome.runnerOutputBytes,
							runnerOutputTruncated: outcome.runnerOutputTruncated,
						}
					: {}),
				finishedAt: now,
				updatedAt: now,
			}),
			db_terminalize_run_leftovers(ctx, { runId: pluginRun._id, now }),
		]);

		return null;
	},
});

/**
 * Hourly cron: marks expired queued/running runs as failed. A run normally settles through
 * finish_event_run, but that requires its executor to survive — a crash, a deploy, or a workpool
 * item that never fires leaves the run live forever. Expired runs can never execute anyway
 * (start_event_run refuses them); this settles what they leave behind.
 */
export const fail_expired_event_runs = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		failedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const batchSize = Math.max(1, Math.min(args.batchSize ?? RUN_EXPIRY_BATCH_SIZE, RUN_EXPIRY_BATCH_SIZE));
		let failedCount = 0;

		// Both live statuses can expire: "queued" when the workpool item never fired, "running"
		// when the executor died mid-run.
		for (const status of ["queued", "running"] as const) {
			if (failedCount >= batchSize) {
				break;
			}

			const expiredPluginRuns = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_status_expiresAt", (q) => q.eq("status", status).lte("expiresAt", now))
				.take(batchSize - failedCount);
			await Promise.all(
				expiredPluginRuns.flatMap((pluginRun) => [
					// start_event_run would refuse the queued work anyway; cancelling also frees the
					// workpool slot.
					...(pluginRun.workId ? [plugin_event_execution_workpool.cancel(ctx, pluginRun.workId)] : []),
					ctx.db.patch("plugins_event_runs", pluginRun._id, {
						status: "failed",
						errorMessage: "Run expired",
						// Terminal runs must not authenticate: explicit undefined unsets both token fields.
						apiTokenHash: undefined,
						apiTokenExpiresAt: undefined,
						finishedAt: now,
						updatedAt: now,
					}),
					db_terminalize_run_leftovers(ctx, { runId: pluginRun._id, now }),
				]),
			);

			failedCount += expiredPluginRuns.length;
		}

		const done = failedCount < batchSize;
		if (!done && !args._test_disableReschedule) {
			// A full batch means more may be waiting; keep draining instead of waiting an hour.
			await ctx.scheduler.runAfter(0, internal.plugins_runtime.fail_expired_event_runs, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}

		return { failedCount, done };
	},
});

/**
 * Daily cron: deletes terminal (succeeded/failed) runs and their call telemetry docs past
 * the 30-day retention window. Output files are user data and are kept. Only terminal runs are
 * eligible, so this relies on fail_expired_event_runs to settle stuck runs — without it, a
 * crashed run would stay live forever and escape retention.
 */
export const cleanup_old_event_runs = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		// expiresAt is enqueue time + RUN_TTL_MS, which makes it a fine age proxy for retention.
		const cutoff = now - RUN_RETENTION_MS;
		const batchSize = Math.max(1, Math.min(args.batchSize ?? RUN_CLEANUP_BATCH_SIZE, RUN_CLEANUP_BATCH_SIZE));
		let deletedCount = 0;

		for (const status of ["succeeded", "failed"] as const) {
			if (deletedCount >= batchSize) {
				break;
			}

			const oldPluginRuns = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_status_expiresAt", (q) => q.eq("status", status).lte("expiresAt", cutoff))
				.take(batchSize - deletedCount);
			await Promise.all(
				oldPluginRuns.map(async (pluginRun) => {
					// take(MAX_API_CALLS) is exact, not a truncation: consume_run_api_call refuses
					// over-quota claims before inserting, so a run can never have more call docs.
					const calls = await ctx.db
						.query("plugins_event_run_calls")
						.withIndex("by_run_sequence", (q) => q.eq("runId", pluginRun._id))
						.take(MAX_API_CALLS);
					await Promise.all(calls.map((call) => ctx.db.delete("plugins_event_run_calls", call._id)));
					await ctx.db.delete("plugins_event_runs", pluginRun._id);
				}),
			);

			deletedCount += oldPluginRuns.length;
		}

		const done = deletedCount < batchSize;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_runtime.cleanup_old_event_runs, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}

		return { deletedCount, done };
	},
});

/**
 * Executes both upload-triggered and manually requested runs.
 */
export const execute_upload_completed_event_run = internalAction({
	args: {
		runId: v.id("plugins_event_runs"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// The `plr_` prefix routes the token to the plugin-run arm of the public API resolver; the
		// complete token is hashed, so a leaked hash is useless without the prefix-bearing original.
		const apiToken = `plr_${crypto_random_hex(32)}`;
		const startResult = (await ctx.runMutation(internal.plugins_runtime.start_event_run, {
			runId: args.runId,
			apiTokenHash: await crypto_sha256_hex(apiToken),
		})) as start_event_run_Result;
		if (startResult._nay) {
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				outcome: { kind: "failed", errorMessage: startResult._nay.message },
			});
			return null;
		}

		const backendEntrypointFile = startResult._yay.version.backendEntrypointFile;
		if (!backendEntrypointFile) {
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				outcome: { kind: "failed", errorMessage: "Plugin backend is missing" },
			});
			return null;
		}

		try {
			// The runner downloads the plugin bundle, executes it, and only then responds: this one
			// request spans the whole plugin execution, and its response body is the run's result.
			const runnerResponse = await fetch(`${PLUGIN_RUNNER_URL}/internal/plugin-runner/run`, {
				method: "POST",
				// A hung runner request would otherwise hold the action until the Convex action timeout
				// kills it, which reads as a crash (workpool retry + expiry cron) instead of a labeled failure.
				signal: AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS),
				headers: {
					Authorization: `Bearer ${PLUGIN_RUNNER_SECRET}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					// Runner wire fields; the plugin's name doubles as its id.
					pluginId: startResult._yay.version.name,
					pluginName: startResult._yay.version.name,
					pluginVersion: startResult._yay.version.version,
					pluginRunId: String(startResult._yay.pluginRun._id),
					artifactKey: backendEntrypointFile.r2Key,
					// Runner wire field; must be the backend entrypoint file's pinned sha256 (runner
					// re-hashes the downloaded dist and refuses on mismatch), never version.artifactHash.
					artifactHash: backendEntrypointFile.sha256,
					// Where the plugin calls back into this host's public API, and the plaintext token it
					// must present there. This is the token's only copy outside the runner; Convex keeps
					// just its hash.
					host: {
						origin: HOST_ORIGIN,
						token: apiToken,
					},
					// The rules the runner enforces while the plugin executes: what it may do, and the
					// only origins it may fetch from.
					acceptedCapabilities: startResult._yay.pluginRun.acceptedCapabilities,
					outboundOrigins: startResult._yay.outboundOrigins,
					// The event as the plugin sees it. Source carries metadata only: the plugin downloads
					// the file content itself through a host call.
					input: {
						event: startResult._yay.pluginRun.event,
						eventId: startResult._yay.pluginRun.eventId,
						organizationId: String(startResult._yay.pluginRun.organizationId),
						workspaceId: String(startResult._yay.pluginRun.workspaceId),
						actorUserId: String(startResult._yay.pluginRun.actorUserId),
						source: {
							fileNodeId: String(startResult._yay.fileNode._id),
							assetId: String(startResult._yay.asset._id),
							name: startResult._yay.fileNode.name,
							// Absolute path so plugins can construct exact sibling output paths for
							// /api/v1/files/write.
							path: startResult._yay.fileNode.path,
							contentType: startResult._yay.fileNode.contentType ?? null,
							size: startResult._yay.asset.size,
						},
					},
				} satisfies pluginRunnerApiSchema["/internal/plugin-runner/run"]["POST"]["body"]),
			});

			// A plugin failure still arrives as HTTP 200 + _nay (run metrics under data); a non-200
			// status means the runner itself failed. The _yay metrics are validated because
			// finish_event_run consumes them; the _nay arm is trusted beyond name and message.
			const bodyValidator = z.union([
				z.object({
					_yay: z.looseObject({
						pluginStatus: z.number(),
						elapsedMs: z.number(),
						outputBytes: z.number(),
						outputTruncated: z.boolean(),
					}),
					_nay: z.undefined().optional(),
				}),
				z.object({
					_yay: z.undefined().optional(),
					_nay: z.looseObject({
						name: z.string(),
						message: z.string(),
						data: z
							.looseObject({
								pluginStatus: z.number().optional(),
								elapsedMs: z.number().optional(),
								outputBytes: z.number().optional(),
								outputTruncated: z.boolean().optional(),
							})
							.optional(),
					}),
				}),
			]);
			const runnerJson = await Result_try_promise<unknown>(runnerResponse.json());
			const runnerParsed = bodyValidator.safeParse(runnerJson._yay);
			const runnerResult = runnerJson._nay
				? Result({ _nay: { name: "invalid_response", message: "Plugin runner returned invalid JSON" } })
				: runnerParsed.success
					? runnerParsed.data
					: Result({ _nay: { name: "invalid_response", message: "Plugin runner returned an invalid response" } });

			const runMetrics = runnerResult._nay ? runnerResult._nay.data : runnerResult._yay;

			// Hand over the raw facts; finish_event_run classifies success or failure.
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				outcome: {
					kind: "runner_response",
					runnerOk: runnerResponse.ok,
					runnerHttpStatus: runnerResponse.status,
					bodyStatus: runnerResult._nay ? "errored" : "succeeded",
					// The plugin's own truncated error message is persisted for workspace admins; plugin
					// authors own the risk of secrets embedded in their exception messages.
					runnerErrorMessage: runnerResult._nay
						? runnerResult._nay.message.slice(0, RUNNER_ERROR_MESSAGE_MAX_CHARS)
						: null,
					pluginStatus: runMetrics?.pluginStatus,
					runnerElapsedMs: runMetrics?.elapsedMs,
					runnerOutputBytes: runMetrics?.outputBytes,
					runnerOutputTruncated: runMetrics?.outputTruncated,
				},
			});
			return null;
		} catch (error) {
			// A network error — or our own timeout aborting the fetch — still settles the run as
			// failed. Only a real crash of this action leaves the run live for the workpool retry
			// and, failing that, the expiry cron.
			// AbortSignal.timeout aborts with "TimeoutError"; some runtimes surface it as "AbortError".
			const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			console.error("Plugin event run threw", {
				runId: args.runId,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				outcome: {
					kind: "failed",
					errorMessage: timedOut ? "Plugin runner request timed out" : "Plugin runner request failed",
				},
			});
			return null;
		}
	},
});

// #region run calls

/**
 * The single transactional gate for the shared 20-call plugin quota: revalidates the live run and
 * its installation, allocates the next sequence, and inserts the started call atomically, so
 * concurrent mixed-route calls can never exceed the quota or reuse a sequence.
 *
 * Source-node archival is deliberately NOT rechecked here (resolve_principal covers it): an
 * archive landing in the resolve→consume gap lets at most one in-flight ephemeral call through.
 * Only durable output needs the transactional archival recheck, which publish_file_write does.
 */
export const consume_run_api_call = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		kind: doc(app_convex_schema, "plugins_event_run_calls").fields.kind,
		route: v.string(),
		requestBytes: v.optional(v.number()),
	},
	returns: v_result({
		_yay: v.object({
			callId: v.id("plugins_event_run_calls"),
			sequence: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const pluginRun = await ctx.db.get("plugins_event_runs", args.runId);
		if (
			!pluginRun ||
			pluginRun.status !== "running" ||
			!pluginRun.apiTokenExpiresAt ||
			pluginRun.apiTokenExpiresAt <= now
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const installation = await ctx.db.get("plugins_workspace_installations", pluginRun.installationId);
		if (
			!installation ||
			installation.status !== "enabled" ||
			installation.pluginVersionId !== pluginRun.pluginVersionId
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		if (pluginRun.apiCallCount >= MAX_API_CALLS) {
			return Result({ _nay: { message: "Plugin API call limit exceeded" } });
		}

		const sequence = pluginRun.apiCallCount + 1;
		const callId = await ctx.db.insert("plugins_event_run_calls", {
			organizationId: pluginRun.organizationId,
			workspaceId: pluginRun.workspaceId,
			runId: pluginRun._id,
			installationId: pluginRun.installationId,
			pluginVersionId: pluginRun.pluginVersionId,
			sequence,
			kind: args.kind,
			route: args.route,
			status: "started",
			...(args.requestBytes === undefined ? {} : { requestBytes: args.requestBytes }),
			errorMessage: null,
			startedAt: now,
			updatedAt: now,
		});
		await ctx.db.patch("plugins_event_runs", pluginRun._id, {
			apiCallCount: sequence,
			updatedAt: now,
		});

		return Result({ _yay: { callId, sequence } });
	},
});

export type plugins_runtime_consume_run_api_call_Result =
	typeof consume_run_api_call extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/** Trusted-caller settle for call ids this backend minted itself (no run binding check). */
export const finish_run_call = internalMutation({
	args: {
		callId: v.id("plugins_event_run_calls"),
		status: v.union(v.literal("succeeded"), v.literal("failed")),
		errorCode: v.optional(v.string()),
		errorMessage: v.union(v.string(), v.null()),
		responseStatus: v.optional(v.number()),
		requestBytes: v.optional(v.number()),
		responseBytes: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const call = await ctx.db.get("plugins_event_run_calls", args.callId);
		// A late or duplicate finish is a no-op: only a started call settles.
		if (!call || call.status !== "started") {
			return null;
		}

		const now = Date.now();
		await ctx.db.patch("plugins_event_run_calls", call._id, {
			status: args.status,
			errorMessage: args.errorMessage,
			...pick_defined_props({
				errorCode: args.errorCode,
				responseStatus: args.responseStatus,
				requestBytes: args.requestBytes,
				responseBytes: args.responseBytes,
			}),
			finishedAt: now,
			elapsedMs: now - call.startedAt,
			updatedAt: now,
		});

		return null;
	},
});

/** Wire-facing settle: the call id arrives from the runner, so it must belong to the run. */
export const finish_runner_call = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		callId: v.string(),
		status: v.union(v.literal("succeeded"), v.literal("failed")),
		errorMessage: v.union(v.string(), v.null()),
		requestBytes: v.optional(v.number()),
		responseBytes: v.optional(v.number()),
		responseStatus: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const callId = ctx.db.normalizeId("plugins_event_run_calls", args.callId);
		if (!callId) {
			return Result({ _nay: { message: "Not found" } });
		}
		const call = await ctx.db.get("plugins_event_run_calls", callId);
		if (!call || call.runId !== args.runId) {
			return Result({ _nay: { message: "Not found" } });
		}

		// A late or duplicate finish is a no-op: only a started call settles.
		if (call.status === "started") {
			const now = Date.now();
			await ctx.db.patch("plugins_event_run_calls", call._id, {
				status: args.status,
				errorMessage: args.errorMessage,
				...pick_defined_props({
					responseStatus: args.responseStatus,
					requestBytes: args.requestBytes,
					responseBytes: args.responseBytes,
				}),
				finishedAt: now,
				elapsedMs: now - call.startedAt,
				updatedAt: now,
			});
		}

		return Result({ _yay: null });
	},
});

type finish_runner_call_Result =
	typeof finish_runner_call extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion run calls

// #region runner host routes

/** Route label persisted on outbound-fetch calls (there is no public API path to record). */
const OUTBOUND_CALL_ROUTE = "outbound";

function get_runner_authorization_token(request: Request) {
	const header = request.headers.get("X-Bonobo-Runner-Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) {
		return null;
	}
	const token = header.slice(prefix.length).trim();
	return token.length > 0 ? token : null;
}

/**
 * Dual auth for the runner-internal host routes: the trusted runner shell proves itself with
 * PLUGIN_RUNNER_HOST_SECRET — checked in constant time BEFORE the plugin bearer is resolved, so
 * plugin code holding only its run token can neither reach these routes nor probe them — and the
 * `plr_` bearer identifies the plugin_run principal through the shared public API resolver.
 * Every auth failure is the fixed "Unauthorized" literal; any other `_nay` message is a
 * body-validation error. Callers own the status mapping (401 / 400).
 */
async function authorize_runner_host_request<Body>(ctx: ActionCtx, request: Request, bodyValidator: z.ZodSchema<Body>) {
	const runnerToken = get_runner_authorization_token(request);
	if (
		!runnerToken ||
		!crypto_timing_safe_equal(await crypto_sha256_hex(runnerToken), await get_plugin_runner_host_secret_hash())
	) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const token = get_bearer_token(request);
	if (!token) {
		return Result({ _nay: { message: "Unauthorized" } });
	}
	const resolved: public_api_resolve_principal_Result = await ctx.runQuery(internal.public_api.resolve_principal, {
		presented: token,
	});
	if (resolved._nay || resolved._yay.kind !== "plugin_run") {
		return Result({ _nay: { message: "Unauthorized" } });
	}
	// Expiry verdict applied inline (the import-cycle note above rules out
	// public_api_resolve_live_principal here); this route only accepts plugin_run.
	if (resolved._yay.apiTokenExpiresAt <= Date.now()) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const body = await server_request_json_parse_and_validate(request, bodyValidator);
	if (body._nay) {
		return Result({ _nay: { message: body._nay.message } });
	}

	return Result({ _yay: { principal: resolved._yay, body: body._yay } });
}

/**
 * Runner-internal routes, callable only by the runner shell (dual auth: PLUGIN_RUNNER_HOST_SECRET
 * plus the run's `plr_` bearer). Plugins themselves talk to the public /api/v1/* routes instead:
 * these three exist for telemetry bracketing around a plugin's outbound fetch and for secret
 * resolution, which never leaves the runner shell. The fetch itself never touches this backend,
 * hence the bracket: claim consumes the quota slot BEFORE the shell performs the fetch (plugin
 * code can't race past the limit), and finish settles the ledger row with the outcome after.
 */
export function plugins_runtime_http_routes(router: RouterForConvexModules) {
	return {
		...((path = "/api/internal/plugins/host/claim-runner-call" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: (() => {
						const bodyValidator = z
							.object({
								requestBytes: z.number().int().min(0).optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_runner_host_request(ctx, request, bodyValidator);
							if (auth._nay) {
								if (auth._nay.message === "Unauthorized") {
									return { status: 401, body: { message: auth._nay.message } } as const;
								}
								return { status: 400, body: { message: auth._nay.message } } as const;
							}

							const consumed: plugins_runtime_consume_run_api_call_Result = await ctx.runMutation(
								internal.plugins_runtime.consume_run_api_call,
								{
									runId: auth._yay.principal.runId,
									kind: "outbound_fetch",
									route: OUTBOUND_CALL_ROUTE,
									requestBytes: auth._yay.body.requestBytes,
								},
							);
							if (consumed._nay) {
								if (consumed._nay.message === "Plugin API call limit exceeded") {
									return { status: 429, body: { message: consumed._nay.message } } as const;
								}
								return { status: 401, body: { message: consumed._nay.message } } as const;
							}

							if (!auth._yay.principal.scopes.includes("outbound:fetch")) {
								await ctx.runMutation(internal.plugins_runtime.finish_run_call, {
									callId: consumed._yay.callId,
									status: "failed",
									errorCode: "permission_denied",
									errorMessage: "Permission denied",
									responseStatus: 403,
								});
								return { status: 403, body: { message: "Permission denied" } } as const;
							}

							return { status: 200, body: { callId: String(consumed._yay.callId) } } as const;
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: {};
							searchParams: {};
							headers: { Authorization: string; "X-Bonobo-Runner-Authorization": string };
							body: z.infer<typeof bodyValidator>;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
		...((path = "/api/internal/plugins/host/finish-runner-call" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: (() => {
						const bodyValidator = z
							.object({
								callId: z.string().min(1),
								status: z.union([z.literal("succeeded"), z.literal("failed")]),
								errorMessage: z.string().max(1000).nullable().optional(),
								requestBytes: z.number().int().min(0).optional(),
								responseBytes: z.number().int().min(0).optional(),
								responseStatus: z.number().int().min(100).max(599).optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_runner_host_request(ctx, request, bodyValidator);
							if (auth._nay) {
								if (auth._nay.message === "Unauthorized") {
									return { status: 401, body: { message: auth._nay.message } } as const;
								}
								return { status: 400, body: { message: auth._nay.message } } as const;
							}

							// Settling an already-claimed call consumes no quota slot.
							const result: finish_runner_call_Result = await ctx.runMutation(
								internal.plugins_runtime.finish_runner_call,
								{
									runId: auth._yay.principal.runId,
									callId: auth._yay.body.callId,
									status: auth._yay.body.status,
									errorMessage: auth._yay.body.errorMessage ?? null,
									requestBytes: auth._yay.body.requestBytes,
									responseBytes: auth._yay.body.responseBytes,
									responseStatus: auth._yay.body.responseStatus,
								},
							);
							if (result._nay) {
								return { status: 404, body: { message: result._nay.message } } as const;
							}

							return { status: 200, body: { ok: true } } as const;
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: {};
							searchParams: {};
							headers: { Authorization: string; "X-Bonobo-Runner-Authorization": string };
							body: z.infer<typeof bodyValidator>;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
		...((path = "/api/internal/plugins/host/secret-get" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: (() => {
						const bodyValidator = z
							.object({
								name: z.string().min(1).max(128),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_runner_host_request(ctx, request, bodyValidator);
							if (auth._nay) {
								if (auth._nay.message === "Unauthorized") {
									return { status: 401, body: { message: auth._nay.message } } as const;
								}
								return { status: 400, body: { message: auth._nay.message } } as const;
							}

							const consumed: plugins_runtime_consume_run_api_call_Result = await ctx.runMutation(
								internal.plugins_runtime.consume_run_api_call,
								{
									runId: auth._yay.principal.runId,
									kind: "api_request",
									route: path,
								},
							);
							if (consumed._nay) {
								if (consumed._nay.message === "Plugin API call limit exceeded") {
									return { status: 429, body: { message: consumed._nay.message } } as const;
								}
								return { status: 401, body: { message: consumed._nay.message } } as const;
							}

							const finish = async (finishArgs: {
								status: "succeeded" | "failed";
								responseStatus: number;
								errorCode?: string;
								errorMessage: string | null;
							}) => {
								await ctx.runMutation(internal.plugins_runtime.finish_run_call, {
									callId: consumed._yay.callId,
									status: finishArgs.status,
									errorCode: finishArgs.errorCode,
									errorMessage: finishArgs.errorMessage,
									responseStatus: finishArgs.responseStatus,
								});
							};

							if (!auth._yay.principal.scopes.includes("secrets:read")) {
								await finish({
									status: "failed",
									responseStatus: 403,
									errorCode: "permission_denied",
									errorMessage: "Permission denied",
								});
								return { status: 403, body: { message: "Permission denied" } } as const;
							}

							const name = plugins_validate_secret_name(auth._yay.body.name);
							if (name._nay) {
								await finish({
									status: "failed",
									responseStatus: 400,
									errorCode: "invalid_input",
									errorMessage: name._nay.message,
								});
								return { status: 400, body: { message: name._nay.message } } as const;
							}

							const resolved = await ctx.runMutation(internal.plugins.get_secret_for_runtime, {
								organizationId: auth._yay.principal.organizationId,
								workspaceId: auth._yay.principal.workspaceId,
								installationId: auth._yay.principal.installationId,
								name: name._yay,
							});
							if (!resolved) {
								// A missing secret is a successful lookup, not a failure.
								await finish({ status: "succeeded", responseStatus: 200, errorMessage: null });
								return { status: 200, body: { value: null } } as const;
							}

							const decrypted = (await ctx.runAction(internal.plugins.decrypt_secret_for_runtime, {
								resolved,
							})) as plugins_decrypt_secret_for_runtime_Result;
							if (decrypted._nay) {
								// Curated literal: raw decrypt errors never reach the call or the plugin.
								await finish({
									status: "failed",
									responseStatus: 500,
									errorCode: "storage_failure",
									errorMessage: "Failed to read secret",
								});
								return { status: 500, body: { message: "Failed to read secret" } } as const;
							}

							await finish({ status: "succeeded", responseStatus: 200, errorMessage: null });
							return { status: 200, body: { value: decrypted._yay } } as const;
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: {};
							searchParams: {};
							headers: { Authorization: string; "X-Bonobo-Runner-Authorization": string };
							body: z.infer<typeof bodyValidator>;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}

// #endregion runner host routes
