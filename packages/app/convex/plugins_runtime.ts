/**
 * Plugin run execution. Life of a run: enqueued (upload event or manual request) → picked up by
 * the workpool executor → claimed by start_event_run, which issues a per-run host token →
 * executed by POSTing to the plugin runner → settled by finish_event_run. While running, the
 * plugin calls back into the host HTTP routes below to write output, fetch its source file, and
 * read secrets.
 *
 * Two credentials: PLUGIN_RUNNER_SECRET authenticates Convex → runner requests; the per-run host
 * token (stored hashed on the run) authenticates plugin → host calls back into Convex.
 */
import { Workpool } from "@convex-dev/workpool";
import { doc } from "convex-helpers/validators";
import type { RegisteredAction, RegisteredMutation, RouteSpec } from "convex/server";
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
import { files_normalize_name } from "../shared/files.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
} from "../server/files.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	create_generated_markdown_output_node,
	type r2_finalize_uploaded_media_markdown_outputs_Result,
	r2_get_download_url,
	write_uploaded_media_markdown_output_objects,
} from "./r2.ts";
import type { plugins_decrypt_secret_for_runtime_Result } from "./plugins.ts";
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
const MAX_HOST_CALLS = 20;
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

function parse_markdown_output_name(path: string | undefined) {
	if (!path) {
		return Result({ _nay: { message: "Output is not available" } });
	}
	if (
		path !== path.trim() ||
		path.includes("/") ||
		path.includes("\\") ||
		path.startsWith(".") ||
		!path.toLowerCase().endsWith(".md")
	) {
		return Result({ _nay: { message: "Output path is invalid" } });
	}

	const normalized = files_normalize_name("file", path);
	if (normalized._nay) {
		return Result({ _nay: { message: "Output path is invalid" } });
	}

	return Result({ _yay: normalized._yay });
}

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
			hostCallCount: 0,
			hostWriteCount: 0,
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
		hostCallCount: 0,
		hostWriteCount: 0,
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
		hostTokenHash: v.string(),
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
			hostTokenHash: args.hostTokenHash,
			// The host token stays valid for the life of the run; a shorter TTL would silently cut
			// off host access mid-run for plugins that outlive it.
			hostTokenExpiresAt: pluginRun.expiresAt,
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

export const finish_event_run = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		// "failed" reports a hard failure the executor already classified (start refused, backend
		// missing, runner unreachable). "runner_response" hands over the raw runner outcome and the
		// success/failure classification happens here, in the same transaction that reads the host
		// calls — the executor must not classify from a completion-state query that can go stale
		// between read and write.
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
			const calls = await ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", pluginRun._id))
				.take(MAX_HOST_CALLS);
			const succeededWriteCount = calls.filter(
				(call) => call.operation === "writeMarkdown" && call.status === "succeeded",
			).length;
			const startedCallCount = calls.filter((call) => call.status === "started").length;
			const pluginStatusIsOk =
				outcome.pluginStatus === undefined || (outcome.pluginStatus >= 200 && outcome.pluginStatus < 300);

			// A clean runner exit is not enough: the plugin must also have written at least one
			// Markdown output and left no host call unfinished.
			succeeded =
				outcome.runnerOk &&
				outcome.bodyStatus === "succeeded" &&
				succeededWriteCount > 0 &&
				startedCallCount === 0 &&
				pluginStatusIsOk;

			errorMessage = succeeded
				? null
				: outcome.pluginStatus !== undefined && (outcome.pluginStatus < 200 || outcome.pluginStatus >= 300)
					? `Plugin returned status ${outcome.pluginStatus}`
					: outcome.runnerErrorMessage
						? outcome.runnerErrorMessage
						: startedCallCount
							? "Plugin left host calls unfinished"
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
			// Settle the failed run's output placeholder so the file stops showing as processing.
			...(!succeeded && pluginRun.outputAssetId
				? [ctx.db.patch("files_r2_assets", pluginRun.outputAssetId, { processingWorkId: null, updatedAt: now })]
				: []),
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
						finishedAt: now,
						updatedAt: now,
					}),
					// Settle the failed run's output placeholder so the file stops showing as processing.
					...(pluginRun.outputAssetId
						? [ctx.db.patch("files_r2_assets", pluginRun.outputAssetId, { processingWorkId: null, updatedAt: now })]
						: []),
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
 * Daily cron: deletes terminal (succeeded/failed) runs and their host-call telemetry rows past
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
					// take(MAX_HOST_CALLS) is exact, not a truncation: start_host_call refuses over-quota
					// claims before inserting, so a run can never have more call rows than that.
					const calls = await ctx.db
						.query("plugins_event_run_calls")
						.withIndex("by_run_sequence", (q) => q.eq("runId", pluginRun._id))
						.take(MAX_HOST_CALLS);
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
		const hostToken = crypto_random_hex(32);
		const startResult = (await ctx.runMutation(internal.plugins_runtime.start_event_run, {
			runId: args.runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
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
					// Where the plugin calls back into this host, and the plaintext token it must present
					// there. This is the token's only copy outside the runner; Convex keeps just its hash.
					host: {
						origin: HOST_ORIGIN,
						token: hostToken,
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

// #region host calls

async function db_get_running_run_by_host_token(
	ctx: MutationCtx,
	args: { hostTokenHash: string; pluginRunId: string },
) {
	const pluginRun = await ctx.db
		.query("plugins_event_runs")
		.withIndex("by_hostTokenHash", (q) => q.eq("hostTokenHash", args.hostTokenHash))
		.unique();
	if (
		!pluginRun ||
		pluginRun.status !== "running" ||
		!pluginRun.hostTokenExpiresAt ||
		pluginRun.hostTokenExpiresAt <= Date.now()
	) {
		return null;
	}

	// The token hash already resolves the run uniquely; this only binds the caller's claimed run id
	// to the token it presented.
	if (String(pluginRun._id) !== args.pluginRunId) {
		return null;
	}

	return pluginRun;
}

export const start_host_call = internalMutation({
	args: {
		hostTokenHash: v.string(),
		pluginRunId: v.string(),
		requiredCapabilities: doc(app_convex_schema, "plugins_workspace_installations").fields.acceptedCapabilities,
		operation: v.union(
			v.literal("writeMarkdown"),
			v.literal("sourceTemporaryUrl"),
			v.literal("secretGet"),
			v.literal("outboundFetch"),
		),
		outputPath: v.optional(v.string()),
		outputOverwrite: v.optional(v.union(v.literal("replace"), v.literal("fail"))),
		markdownBytes: v.optional(v.number()),
		expiresInSeconds: v.optional(v.number()),
		secretName: v.optional(v.string()),
		systemBytes: v.optional(v.number()),
		promptBytes: v.optional(v.number()),
		includeSourceImage: v.optional(v.boolean()),
		maxOutputTokens: v.optional(v.number()),
		requestBytes: v.optional(v.number()),
	},
	returns: v_result({
		_yay: v.object({
			pluginRun: doc(app_convex_schema, "plugins_event_runs"),
			asset: doc(app_convex_schema, "files_r2_assets"),
			fileNode: doc(app_convex_schema, "files_nodes"),
			outputFileNode: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
			outputAssetId: v.union(v.id("files_r2_assets"), v.null()),
			callId: v.id("plugins_event_run_calls"),
		}),
	}),
	handler: async (ctx, args) => {
		const pluginRun = await db_get_running_run_by_host_token(ctx, args);
		if (!pluginRun) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const now = Date.now();
		if (pluginRun.hostCallCount >= MAX_HOST_CALLS) {
			return Result({ _nay: { message: "Plugin host call limit exceeded" } });
		}
		const sequence = pluginRun.hostCallCount + 1;

		// A failed claim still records a telemetry row and consumes a sequence slot toward
		// MAX_HOST_CALLS: failed attempts burn quota too.
		const fail_claim = async (message: string) => {
			await ctx.db.insert("plugins_event_run_calls", {
				organizationId: pluginRun.organizationId,
				workspaceId: pluginRun.workspaceId,
				runId: pluginRun._id,
				installationId: pluginRun.installationId,
				pluginVersionId: pluginRun.pluginVersionId,
				sequence,
				operation: args.operation,
				status: "failed",
				outputPath: args.outputPath,
				outputOverwrite: args.outputOverwrite,
				markdownBytes: args.markdownBytes,
				expiresInSeconds: args.expiresInSeconds,
				secretName: args.secretName,
				systemBytes: args.systemBytes,
				promptBytes: args.promptBytes,
				includeSourceImage: args.includeSourceImage,
				maxOutputTokens: args.maxOutputTokens,
				requestBytes: args.requestBytes,
				errorMessage: message,
				startedAt: now,
				finishedAt: now,
				elapsedMs: 0,
				updatedAt: now,
			});
			await ctx.db.patch("plugins_event_runs", pluginRun._id, {
				hostCallCount: sequence,
				updatedAt: now,
			});
			return Result({ _nay: { message } });
		};

		for (const capability of args.requiredCapabilities) {
			if (!pluginRun.acceptedCapabilities.includes(capability)) {
				return await fail_claim("Permission denied");
			}
		}

		const outputName = args.operation === "writeMarkdown" ? parse_markdown_output_name(args.outputPath) : null;
		if (outputName?._nay) {
			return await fail_claim(outputName._nay.message);
		}
		const outputPath = outputName?._yay;

		const [asset, fileNode] = await Promise.all([
			ctx.db.get("files_r2_assets", pluginRun.assetId),
			ctx.db.get("files_nodes", pluginRun.fileNodeId),
		]);
		if (
			!asset ||
			!fileNode ||
			asset.organizationId !== pluginRun.organizationId ||
			asset.workspaceId !== pluginRun.workspaceId ||
			fileNode.organizationId !== pluginRun.organizationId ||
			fileNode.workspaceId !== pluginRun.workspaceId
		) {
			return await fail_claim("Not found");
		}

		let writableOutputFileNode: Doc<"files_nodes"> | null = null;
		let writableOutputAssetId: Id<"files_r2_assets"> | null = null;
		if (args.operation === "writeMarkdown") {
			if (!outputPath) {
				return await fail_claim("Output is not available");
			}
			const output = await create_generated_markdown_output_node(ctx, {
				fileNode,
				name: outputPath,
				overwrite: args.outputOverwrite,
				now,
			});
			if (output._nay) {
				return await fail_claim(output._nay.message);
			}
			writableOutputFileNode = await ctx.db.get("files_nodes", output._yay.nodeId);
			if (!writableOutputFileNode) {
				// Unreachable: the node was inserted in this same transaction.
				throw should_never_happen("writeMarkdown output node missing after create", { nodeId: output._yay.nodeId });
			}
			writableOutputAssetId = output._yay.assetId;
		}

		const callId = await ctx.db.insert("plugins_event_run_calls", {
			organizationId: pluginRun.organizationId,
			workspaceId: pluginRun.workspaceId,
			runId: pluginRun._id,
			installationId: pluginRun.installationId,
			pluginVersionId: pluginRun.pluginVersionId,
			sequence,
			operation: args.operation,
			status: "started",
			outputPath: args.operation === "writeMarkdown" ? outputPath : args.outputPath,
			outputOverwrite: args.outputOverwrite,
			markdownBytes: args.markdownBytes,
			expiresInSeconds: args.expiresInSeconds,
			secretName: args.secretName,
			systemBytes: args.systemBytes,
			promptBytes: args.promptBytes,
			includeSourceImage: args.includeSourceImage,
			maxOutputTokens: args.maxOutputTokens,
			requestBytes: args.requestBytes,
			errorMessage: null,
			startedAt: now,
			updatedAt: now,
		});

		await ctx.db.patch("plugins_event_runs", pluginRun._id, {
			hostCallCount: sequence,
			hostWriteCount: pluginRun.hostWriteCount + (args.operation === "writeMarkdown" ? 1 : 0),
			// Park the output ids on the run so the failure paths (finish_event_run,
			// fail_expired_event_runs) can settle the output placeholder's processingWorkId.
			...(args.operation === "writeMarkdown" && writableOutputFileNode && writableOutputAssetId
				? {
						outputFileNodeId: writableOutputFileNode._id,
						outputAssetId: writableOutputAssetId,
					}
				: {}),
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
				outputFileNode: writableOutputFileNode,
				outputAssetId: writableOutputAssetId,
				callId,
			},
		});
	},
});

type start_host_call_Result =
	typeof start_host_call extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const finish_host_call = internalMutation({
	args: {
		callId: v.id("plugins_event_run_calls"),
		status: v.union(v.literal("succeeded"), v.literal("failed")),
		errorMessage: v.union(v.string(), v.null()),
		temporaryUrlExpiresAt: v.optional(v.number()),
		secretFound: v.optional(v.boolean()),
		secretTier: v.optional(v.union(v.literal("installation"), v.literal("publisher"))),
		modelId: v.optional(v.string()),
		sourceBytes: v.optional(v.number()),
		requestBytes: v.optional(v.number()),
		responseBytes: v.optional(v.number()),
		responseStatus: v.optional(v.number()),
		outputTextBytes: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const call = await ctx.db.get("plugins_event_run_calls", args.callId);
		if (!call) {
			return null;
		}

		const now = Date.now();
		await ctx.db.patch("plugins_event_run_calls", call._id, {
			status: args.status,
			errorMessage: args.errorMessage,
			...pick_defined_props({
				temporaryUrlExpiresAt: args.temporaryUrlExpiresAt,
				secretFound: args.secretFound,
				secretTier: args.secretTier,
				modelId: args.modelId,
				sourceBytes: args.sourceBytes,
				requestBytes: args.requestBytes,
				responseBytes: args.responseBytes,
				responseStatus: args.responseStatus,
				outputTextBytes: args.outputTextBytes,
			}),
			finishedAt: now,
			elapsedMs: now - call.startedAt,
			updatedAt: now,
		});

		return null;
	},
});

export const finish_runner_host_call = internalMutation({
	args: {
		hostTokenHash: v.string(),
		pluginRunId: v.string(),
		callId: v.string(),
		status: v.union(v.literal("succeeded"), v.literal("failed")),
		errorMessage: v.union(v.string(), v.null()),
		modelId: v.optional(v.string()),
		sourceBytes: v.optional(v.number()),
		requestBytes: v.optional(v.number()),
		responseBytes: v.optional(v.number()),
		responseStatus: v.optional(v.number()),
		outputTextBytes: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const pluginRun = await db_get_running_run_by_host_token(ctx, args);
		if (!pluginRun) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const callId = ctx.db.normalizeId("plugins_event_run_calls", args.callId);
		if (!callId) {
			return Result({ _nay: { message: "Not found" } });
		}
		const call = await ctx.db.get("plugins_event_run_calls", callId);
		if (!call || call.runId !== pluginRun._id || call.status !== "started") {
			return Result({ _nay: { message: "Not found" } });
		}

		const now = Date.now();
		await ctx.db.patch("plugins_event_run_calls", call._id, {
			status: args.status,
			errorMessage: args.errorMessage,
			...pick_defined_props({
				modelId: args.modelId,
				sourceBytes: args.sourceBytes,
				requestBytes: args.requestBytes,
				responseBytes: args.responseBytes,
				responseStatus: args.responseStatus,
				outputTextBytes: args.outputTextBytes,
			}),
			finishedAt: now,
			elapsedMs: now - call.startedAt,
			updatedAt: now,
		});

		return Result({ _yay: null });
	},
});

type finish_runner_host_call_Result =
	typeof finish_runner_host_call extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const host_write_markdown = internalAction({
	args: {
		hostToken: v.string(),
		pluginRunId: v.string(),
		markdown: v.string(),
		path: v.optional(v.string()),
		overwrite: v.optional(v.union(v.literal("replace"), v.literal("fail"))),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const markdownBytes = files_get_utf8_byte_size(args.markdown);
		if (args.markdown.length === 0 || files_MAX_TEXT_CONTENT_BYTES < markdownBytes) {
			return Result({ _nay: { message: "Markdown output is too large" } });
		}

		const started = (await ctx.runMutation(internal.plugins_runtime.start_host_call, {
			hostTokenHash: await crypto_sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: [],
			operation: "writeMarkdown",
			outputPath: args.path,
			outputOverwrite: args.overwrite,
			markdownBytes,
		})) as start_host_call_Result;
		if (started._nay) {
			return Result({ _nay: { message: started._nay.message } });
		}
		if (!started._yay.outputFileNode || !started._yay.outputAssetId) {
			return Result({ _nay: { message: "Output is not available" } });
		}

		try {
			const output = await write_uploaded_media_markdown_output_objects(ctx, {
				fileNode: started._yay.fileNode,
				outputFileNode: started._yay.outputFileNode,
				outputAssetId: started._yay.outputAssetId,
				markdownContent: args.markdown,
			});

			const finalized = (await ctx.runMutation(internal.r2.finalize_uploaded_media_markdown_outputs, {
				pluginRunId: started._yay.pluginRun._id,
				organizationId: started._yay.pluginRun.organizationId,
				workspaceId: started._yay.pluginRun.workspaceId,
				userId: started._yay.pluginRun.actorUserId,
				assetId: started._yay.pluginRun.assetId,
				outputs: [output],
			})) as r2_finalize_uploaded_media_markdown_outputs_Result;
			if (finalized._nay) {
				await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
					callId: started._yay.callId,
					status: "failed",
					errorMessage: finalized._nay.message,
				});
				return Result({ _nay: { message: finalized._nay.message } });
			}

			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: started._yay.callId,
				status: "succeeded",
				errorMessage: null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: started._yay.callId,
				status: "failed",
				errorMessage: message,
			});
			return Result({ _nay: { message } });
		}

		return Result({ _yay: null });
	},
});

type host_write_markdown_Result =
	typeof host_write_markdown extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const host_source_temporary_url = internalAction({
	args: {
		hostToken: v.string(),
		pluginRunId: v.string(),
		expiresInSeconds: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ url: v.string(), expiresAt: v.number() }) }),
	handler: async (ctx, args) => {
		const expiresIn = Math.min(Math.max(args.expiresInSeconds ?? 15 * 60, 1), 15 * 60);

		const started = (await ctx.runMutation(internal.plugins_runtime.start_host_call, {
			hostTokenHash: await crypto_sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: [],
			operation: "sourceTemporaryUrl",
			expiresInSeconds: expiresIn,
		})) as start_host_call_Result;
		if (started._nay) {
			return Result({ _nay: { message: started._nay.message } });
		}
		if (!started._yay.asset.r2Key) {
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: started._yay.callId,
				status: "failed",
				errorMessage: "Source upload is not available",
			});
			return Result({ _nay: { message: "Source upload is not available" } });
		}

		try {
			const url = await r2_get_download_url({
				key: started._yay.asset.r2Key,
				options: { expiresIn },
			});
			const expiresAt = Date.now() + expiresIn * 1000;
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: started._yay.callId,
				status: "succeeded",
				errorMessage: null,
				temporaryUrlExpiresAt: expiresAt,
			});
			return Result({ _yay: { url, expiresAt } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: started._yay.callId,
				status: "failed",
				errorMessage: message,
			});
			return Result({ _nay: { message } });
		}
	},
});

type host_source_temporary_url_Result =
	typeof host_source_temporary_url extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const host_secret_get = internalAction({
	args: {
		hostToken: v.string(),
		pluginRunId: v.string(),
		name: v.string(),
	},
	returns: v_result({ _yay: v.union(v.string(), v.null()) }),
	handler: async (ctx, args) => {
		const name = plugins_validate_secret_name(args.name);
		if (name._nay) {
			return Result({ _nay: { message: name._nay.message } });
		}

		const started = (await ctx.runMutation(internal.plugins_runtime.start_host_call, {
			hostTokenHash: await crypto_sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: ["plugin.secrets.read"],
			operation: "secretGet",
			secretName: name._yay,
		})) as start_host_call_Result;
		if (started._nay) {
			return Result({ _nay: { message: started._nay.message } });
		}

		const resolved = await ctx.runMutation(internal.plugins.get_secret_for_runtime, {
			organizationId: started._yay.pluginRun.organizationId,
			workspaceId: started._yay.pluginRun.workspaceId,
			installationId: started._yay.pluginRun.installationId,
			name: name._yay,
		});
		if (!resolved) {
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: started._yay.callId,
				status: "succeeded",
				errorMessage: null,
				secretFound: false,
			});
			return Result({ _yay: null });
		}

		const decrypted = (await ctx.runAction(internal.plugins.decrypt_secret_for_runtime, {
			resolved,
		})) as plugins_decrypt_secret_for_runtime_Result;
		if (decrypted._nay) {
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: started._yay.callId,
				status: "failed",
				errorMessage: decrypted._nay.message,
				secretFound: true,
				secretTier: resolved.tier,
			});
			return Result({ _nay: { message: decrypted._nay.message } });
		}

		await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
			callId: started._yay.callId,
			status: "succeeded",
			errorMessage: null,
			secretFound: true,
			secretTier: resolved.tier,
		});
		return Result({ _yay: decrypted._yay });
	},
});

type host_secret_get_Result =
	typeof host_secret_get extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function parse_host_route_auth_and_body<Body>(request: Request, bodyValidator: z.ZodSchema<Body>) {
	const token = get_bearer_token(request);
	if (!token) {
		return { ok: false as const, response: { status: 401, body: { message: "Unauthorized" } } as const };
	}

	const body = await server_request_json_parse_and_validate(request, bodyValidator);
	if (body._nay) {
		return { ok: false as const, response: { status: 400, body: { message: body._nay.message } } as const };
	}

	return { ok: true as const, token, body: body._yay };
}

/**
 * The /api/internal/plugins/host/* routes are called by the runner itself (telemetry bracketing
 * around a plugin's outbound fetch); the /api/plugins/v1/* routes are called by the plugin SDK to
 * perform host operations.
 */
export function plugins_runtime_http_routes(router: RouterForConvexModules) {
	return {
		...((path = "/api/internal/plugins/host/claim-runner-call" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: (() => {
						const bodyValidator = z
							.object({
								pluginRunId: z.string(),
								operation: z.literal("outboundFetch"),
								requestBytes: z.number().int().min(0).optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await parse_host_route_auth_and_body(request, bodyValidator);
							if (!auth.ok) {
								return auth.response;
							}
							const result = (await ctx.runMutation(internal.plugins_runtime.start_host_call, {
								hostTokenHash: await crypto_sha256_hex(auth.token),
								pluginRunId: auth.body.pluginRunId,
								requiredCapabilities: ["outbound.fetch"],
								operation: auth.body.operation,
								requestBytes: auth.body.requestBytes,
							})) as start_host_call_Result;
							if (result._nay) {
								return { status: 400, body: { message: result._nay.message } } as const;
							}

							return { status: 200, body: { callId: String(result._yay.callId) } } as const;
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
							headers: { Authorization: string };
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
								pluginRunId: z.string(),
								callId: z.string().min(1),
								status: z.union([z.literal("succeeded"), z.literal("failed")]),
								errorMessage: z.string().max(1000).nullable().optional(),
								modelId: z.string().max(256).optional(),
								sourceBytes: z.number().int().min(0).optional(),
								requestBytes: z.number().int().min(0).optional(),
								responseBytes: z.number().int().min(0).optional(),
								responseStatus: z.number().int().min(100).max(599).optional(),
								outputTextBytes: z.number().int().min(0).optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await parse_host_route_auth_and_body(request, bodyValidator);
							if (!auth.ok) {
								return auth.response;
							}
							const result = (await ctx.runMutation(internal.plugins_runtime.finish_runner_host_call, {
								hostTokenHash: await crypto_sha256_hex(auth.token),
								pluginRunId: auth.body.pluginRunId,
								callId: auth.body.callId,
								status: auth.body.status,
								errorMessage: auth.body.errorMessage ?? null,
								modelId: auth.body.modelId,
								sourceBytes: auth.body.sourceBytes,
								requestBytes: auth.body.requestBytes,
								responseBytes: auth.body.responseBytes,
								responseStatus: auth.body.responseStatus,
								outputTextBytes: auth.body.outputTextBytes,
							})) as finish_runner_host_call_Result;
							if (result._nay) {
								return { status: 400, body: { message: result._nay.message } } as const;
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
							headers: { Authorization: string };
							body: z.infer<typeof bodyValidator>;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
		...((path = "/api/plugins/v1/write-markdown" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: (() => {
						const bodyValidator = z
							.object({
								pluginRunId: z.string(),
								markdown: z.string(),
								path: z.string().min(1).max(512).optional(),
								overwrite: z.union([z.literal("replace"), z.literal("fail")]).optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await parse_host_route_auth_and_body(request, bodyValidator);
							if (!auth.ok) {
								return auth.response;
							}
							const result = (await ctx.runAction(internal.plugins_runtime.host_write_markdown, {
								hostToken: auth.token,
								pluginRunId: auth.body.pluginRunId,
								markdown: auth.body.markdown,
								path: auth.body.path,
								overwrite: auth.body.overwrite,
							})) as host_write_markdown_Result;
							if (result._nay) {
								return { status: 400, body: { message: result._nay.message } } as const;
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
							headers: { Authorization: string };
							body: z.infer<typeof bodyValidator>;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
		...((path = "/api/plugins/v1/source-temporary-url" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: (() => {
						const bodyValidator = z
							.object({
								pluginRunId: z.string(),
								expiresInSeconds: z
									.number()
									.int()
									.min(1)
									.max(15 * 60)
									.optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await parse_host_route_auth_and_body(request, bodyValidator);
							if (!auth.ok) {
								return auth.response;
							}
							const result = (await ctx.runAction(internal.plugins_runtime.host_source_temporary_url, {
								hostToken: auth.token,
								pluginRunId: auth.body.pluginRunId,
								expiresInSeconds: auth.body.expiresInSeconds,
							})) as host_source_temporary_url_Result;
							if (result._nay) {
								return { status: 400, body: { message: result._nay.message } } as const;
							}

							return { status: 200, body: result._yay } as const;
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
							headers: { Authorization: string };
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
								pluginRunId: z.string(),
								name: z.string().min(1).max(128),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await parse_host_route_auth_and_body(request, bodyValidator);
							if (!auth.ok) {
								return auth.response;
							}
							const result = (await ctx.runAction(internal.plugins_runtime.host_secret_get, {
								hostToken: auth.token,
								pluginRunId: auth.body.pluginRunId,
								name: auth.body.name,
							})) as host_secret_get_Result;
							if (result._nay) {
								return { status: 400, body: { message: result._nay.message } } as const;
							}

							return { status: 200, body: { value: result._yay } } as const;
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
							headers: { Authorization: string };
							body: z.infer<typeof bodyValidator>;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}

// #endregion host calls
