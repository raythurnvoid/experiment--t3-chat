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
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
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
// refused/reaped.
const RUN_TTL_MS = 10 * 60 * 1000;
// 3 minutes.
const RUNNER_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_HOST_CALLS = 20;
const RUNNER_ERROR_MESSAGE_MAX_CHARS = 500;
// 30 days.
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_REAP_BATCH_SIZE = 50;
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
		const existingRun = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_asset_event_installation", (q) =>
				q
					.eq("assetId", args.asset._id)
					.eq("event", UPLOAD_COMPLETED_EVENT_TYPE)
					.eq("installationId", candidate.installation._id),
			)
			.first();
		if (existingRun) {
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
		const recentRuns = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_asset_event_installation", (q) =>
				q.eq("assetId", args.asset._id).eq("event", event).eq("installationId", args.installation._id),
			)
			.order("desc")
			.take(5);
		if (recentRuns.some((run) => (run.status === "queued" || run.status === "running") && run.expiresAt > now)) {
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
			run: doc(app_convex_schema, "plugins_event_runs"),
			asset: doc(app_convex_schema, "files_r2_assets"),
			fileNode: doc(app_convex_schema, "files_nodes"),
			installation: doc(app_convex_schema, "plugins_workspace_installations"),
			version: doc(app_convex_schema, "plugins_versions"),
			outboundOrigins: v.array(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("plugins_event_runs", args.runId);
		if (!run) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (run.status !== "queued") {
			// A "running" run here means a previous executor attempt crashed mid-run and the
			// workpool retried; the retry must not restart the run.
			return Result({ _nay: { message: run.status === "running" ? "Run was interrupted" : "Not found" } });
		}
		if (run.expiresAt <= Date.now()) {
			return Result({ _nay: { message: "Run expired" } });
		}

		const [asset, fileNode, installation, version] = await Promise.all([
			ctx.db.get("files_r2_assets", run.assetId),
			ctx.db.get("files_nodes", run.fileNodeId),
			ctx.db.get("plugins_workspace_installations", run.installationId),
			ctx.db.get("plugins_versions", run.pluginVersionId),
		]);
		if (!asset || !fileNode || !installation || !version || !version.backendEntrypointFile) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Per-run egress allowlist: consented artifact origins plus the secret origins of the
		// version's source repository claim (no claim contributes no extra origins).
		const repository = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_repositoryUrl", (q) => q.eq("repositoryUrl", version.sourceRepositoryUrl))
			.first();
		const publisherSecrets = repository
			? await ctx.db
					.query("plugins_publisher_repository_secrets")
					.withIndex("by_repository_name", (q) => q.eq("repositoryId", repository._id))
					.take(100)
			: [];
		const outboundOrigins = [
			...new Set([
				...installation.acceptedOutboundOrigins,
				...publisherSecrets.flatMap((secret) => secret.allowedOrigins),
			]),
		];

		const now = Date.now();
		await ctx.db.patch("plugins_event_runs", run._id, {
			status: "running",
			hostTokenHash: args.hostTokenHash,
			// The host token stays valid for the life of the run; a shorter TTL would silently cut
			// off host access mid-run for plugins that outlive it.
			hostTokenExpiresAt: run.expiresAt,
			startedAt: now,
			updatedAt: now,
		});

		const patchedRun = await ctx.db.get("plugins_event_runs", run._id);
		if (!patchedRun) {
			return Result({ _nay: { message: "Not found" } });
		}

		return Result({
			_yay: {
				run: patchedRun,
				asset,
				fileNode,
				installation,
				version,
				outboundOrigins,
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
		const run = await ctx.db.get("plugins_event_runs", args.runId);
		if (!run || (run.status !== "queued" && run.status !== "running")) {
			return null;
		}

		const now = Date.now();
		if (args.outcome.kind === "failed") {
			console.error("Plugin event run failed", { runId: run._id, errorMessage: args.outcome.errorMessage });
			await ctx.db.patch("plugins_event_runs", run._id, {
				status: "failed",
				errorMessage: args.outcome.errorMessage,
				finishedAt: now,
				updatedAt: now,
			});
			if (run.outputAssetId) {
				await ctx.db.patch("files_r2_assets", run.outputAssetId, {
					processingWorkId: null,
					updatedAt: now,
				});
			}
			return null;
		}

		const outcome = args.outcome;
		const calls = await ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", run._id))
			.take(MAX_HOST_CALLS);
		const succeededWriteCount = calls.filter(
			(call) => call.operation === "writeMarkdown" && call.status === "succeeded",
		).length;
		const startedCallCount = calls.filter((call) => call.status === "started").length;
		const pluginStatusIsOk =
			outcome.pluginStatus === undefined || (outcome.pluginStatus >= 200 && outcome.pluginStatus < 300);
		const succeeded =
			outcome.runnerOk &&
			outcome.bodyStatus === "succeeded" &&
			succeededWriteCount > 0 &&
			startedCallCount === 0 &&
			pluginStatusIsOk;
		const errorMessage = succeeded
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
		if (!succeeded) {
			console.error("Plugin event run failed", { runId: run._id, errorMessage });
		}
		await ctx.db.patch("plugins_event_runs", run._id, {
			status: succeeded ? "succeeded" : "failed",
			errorMessage,
			runnerHttpStatus: outcome.runnerHttpStatus,
			runnerElapsedMs: outcome.runnerElapsedMs,
			pluginStatus: outcome.pluginStatus,
			runnerOutputBytes: outcome.runnerOutputBytes,
			runnerOutputTruncated: outcome.runnerOutputTruncated,
			finishedAt: now,
			updatedAt: now,
		});
		if (!succeeded && run.outputAssetId) {
			await ctx.db.patch("files_r2_assets", run.outputAssetId, {
				processingWorkId: null,
				updatedAt: now,
			});
		}

		return null;
	},
});

export const reap_expired_event_runs = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		reapedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const batchSize = Math.max(1, Math.min(args.batchSize ?? RUN_REAP_BATCH_SIZE, RUN_REAP_BATCH_SIZE));
		let reapedCount = 0;
		for (const status of ["queued", "running"] as const) {
			if (reapedCount >= batchSize) {
				break;
			}
			const expiredRuns = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_status_expiresAt", (q) => q.eq("status", status).lte("expiresAt", now))
				.take(batchSize - reapedCount);
			for (const run of expiredRuns) {
				if (run.workId) {
					await plugin_event_execution_workpool.cancel(ctx, run.workId);
				}
				await ctx.db.patch("plugins_event_runs", run._id, {
					status: "failed",
					errorMessage: "Run expired",
					finishedAt: now,
					updatedAt: now,
				});
				if (run.outputAssetId) {
					await ctx.db.patch("files_r2_assets", run.outputAssetId, {
						processingWorkId: null,
						updatedAt: now,
					});
				}
			}
			reapedCount += expiredRuns.length;
		}
		const done = reapedCount < batchSize;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_runtime.reap_expired_event_runs, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}
		return { reapedCount, done };
	},
});

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
			const oldRuns = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_status_expiresAt", (q) => q.eq("status", status).lte("expiresAt", cutoff))
				.take(batchSize - deletedCount);
			for (const run of oldRuns) {
				const calls = await ctx.db
					.query("plugins_event_run_calls")
					.withIndex("by_run_sequence", (q) => q.eq("runId", run._id))
					.take(MAX_HOST_CALLS);
				await Promise.all(calls.map((call) => ctx.db.delete("plugins_event_run_calls", call._id)));
				await ctx.db.delete("plugins_event_runs", run._id);
			}
			deletedCount += oldRuns.length;
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

// Executes both upload-triggered and manually requested runs; keep the historical name because
// pending workpool items persist the function reference by name across deploys.
export const execute_upload_completed_event_run = internalAction({
	args: {
		runId: v.id("plugins_event_runs"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const hostToken = crypto_random_hex(32);
		const started = (await ctx.runMutation(internal.plugins_runtime.start_event_run, {
			runId: args.runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
		})) as start_event_run_Result;
		if (started._nay) {
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				outcome: { kind: "failed", errorMessage: started._nay.message },
			});
			return null;
		}

		const backendEntrypointFile = started._yay.version.backendEntrypointFile;
		if (!backendEntrypointFile) {
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				outcome: { kind: "failed", errorMessage: "Plugin backend is missing" },
			});
			return null;
		}

		// A hung runner request would otherwise hold the action until the Convex action timeout
		// kills it, which reads as a crash (workpool retry + reaper) instead of a labeled failure.
		const abortController = new AbortController();
		const abortTimer = setTimeout(() => abortController.abort(), RUNNER_REQUEST_TIMEOUT_MS);
		try {
			const runnerResponse = await fetch(`${PLUGIN_RUNNER_URL}/internal/plugin-runner/run`, {
				method: "POST",
				signal: abortController.signal,
				headers: {
					Authorization: `Bearer ${PLUGIN_RUNNER_SECRET}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					pluginId: started._yay.version.name,
					pluginName: started._yay.version.name,
					pluginVersion: started._yay.version.version,
					pluginRunId: String(started._yay.run._id),
					artifactKey: backendEntrypointFile.r2Key,
					// Runner wire field; must be the backend entrypoint file's pinned sha256 (runner
					// re-hashes the downloaded dist and refuses on mismatch), never version.artifactHash.
					artifactHash: backendEntrypointFile.sha256,
					host: {
						origin: HOST_ORIGIN,
						token: hostToken,
					},
					acceptedCapabilities: started._yay.run.acceptedCapabilities,
					outboundOrigins: started._yay.outboundOrigins,
					input: {
						event: started._yay.run.event,
						eventId: started._yay.run.eventId,
						organizationId: String(started._yay.run.organizationId),
						workspaceId: String(started._yay.run.workspaceId),
						actorUserId: String(started._yay.run.actorUserId),
						source: {
							fileNodeId: String(started._yay.fileNode._id),
							assetId: String(started._yay.asset._id),
							name: started._yay.fileNode.name,
							contentType: started._yay.fileNode.contentType ?? null,
							size: started._yay.asset.size,
						},
					},
				}),
			});
			const runnerBody = await parse_runner_response(runnerResponse);
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				outcome: {
					kind: "runner_response",
					runnerOk: runnerResponse.ok,
					runnerHttpStatus: runnerResponse.status,
					bodyStatus: runnerBody.status,
					runnerErrorMessage: runnerBody.errorMessage ?? null,
					pluginStatus: runnerBody.pluginStatus,
					runnerElapsedMs: runnerBody.elapsedMs,
					runnerOutputBytes: runnerBody.outputBytes,
					runnerOutputTruncated: runnerBody.outputTruncated,
				},
			});
			return null;
		} catch (error) {
			const timedOut = error instanceof Error && error.name === "AbortError";
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
		} finally {
			clearTimeout(abortTimer);
		}
	},
});

async function parse_runner_response(response: Response) {
	const text = await response.text();
	try {
		const json = JSON.parse(text);
		const parsed = z
			.object({
				status: z.union([z.literal("succeeded"), z.literal("errored")]),
				pluginStatus: z.number().optional(),
				elapsedMs: z.number().optional(),
				outputBytes: z.number().optional(),
				outputTruncated: z.boolean().optional(),
				error: z
					.object({
						message: z.string(),
					})
					.optional(),
			})
			.safeParse(json);
		if (!parsed.success) {
			const errorOnly = z.object({ error: z.object({ message: z.string() }) }).safeParse(json);
			if (errorOnly.success) {
				return {
					status: "errored" as const,
					errorMessage: errorOnly.data.error.message.slice(0, RUNNER_ERROR_MESSAGE_MAX_CHARS),
				};
			}
			return { status: "errored" as const, errorMessage: "Plugin runner returned an invalid response" };
		}
		return {
			status: parsed.data.status,
			// The plugin's own truncated error message is persisted for workspace admins; plugin
			// authors own the risk of secrets embedded in their exception messages.
			errorMessage: parsed.data.error ? parsed.data.error.message.slice(0, RUNNER_ERROR_MESSAGE_MAX_CHARS) : undefined,
			pluginStatus: parsed.data.pluginStatus,
			elapsedMs: parsed.data.elapsedMs,
			outputBytes: parsed.data.outputBytes,
			outputTruncated: parsed.data.outputTruncated,
		};
	} catch {
		return { status: "errored" as const, errorMessage: "Plugin runner returned invalid JSON" };
	}
}

// #region host calls

async function db_get_running_run_by_host_token(
	ctx: MutationCtx,
	args: { hostTokenHash: string; pluginRunId: string },
) {
	const run = await ctx.db
		.query("plugins_event_runs")
		.withIndex("by_hostTokenHash", (q) => q.eq("hostTokenHash", args.hostTokenHash))
		.unique();
	if (!run || run.status !== "running" || !run.hostTokenExpiresAt || run.hostTokenExpiresAt <= Date.now()) {
		return null;
	}
	if (String(run._id) !== args.pluginRunId) {
		return null;
	}
	return run;
}

async function insert_host_call(
	ctx: MutationCtx,
	args: {
		run: Doc<"plugins_event_runs">;
		sequence: number;
		operation: Doc<"plugins_event_run_calls">["operation"];
		status: Doc<"plugins_event_run_calls">["status"];
		errorMessage: string | null;
		now: number;
		outputPath?: string;
		outputOverwrite?: "replace" | "fail";
		markdownBytes?: number;
		expiresInSeconds?: number;
		secretName?: string;
		systemBytes?: number;
		promptBytes?: number;
		includeSourceImage?: boolean;
		maxOutputTokens?: number;
		requestBytes?: number;
	},
) {
	return await ctx.db.insert("plugins_event_run_calls", {
		organizationId: args.run.organizationId,
		workspaceId: args.run.workspaceId,
		runId: args.run._id,
		installationId: args.run.installationId,
		pluginVersionId: args.run.pluginVersionId,
		sequence: args.sequence,
		operation: args.operation,
		status: args.status,
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
		errorMessage: args.errorMessage,
		startedAt: args.now,
		...(args.status === "started" ? {} : { finishedAt: args.now, elapsedMs: 0 }),
		updatedAt: args.now,
	});
}

async function patch_host_call_finished(
	ctx: MutationCtx,
	call: Doc<"plugins_event_run_calls">,
	args: {
		status: "succeeded" | "failed";
		errorMessage: string | null;
		temporaryUrlExpiresAt?: number;
		secretFound?: boolean;
		secretTier?: "installation" | "publisher";
		modelId?: string;
		sourceBytes?: number;
		requestBytes?: number;
		responseBytes?: number;
		responseStatus?: number;
		outputTextBytes?: number;
	},
) {
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
}

export const claim_host_call = internalMutation({
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
			run: doc(app_convex_schema, "plugins_event_runs"),
			asset: doc(app_convex_schema, "files_r2_assets"),
			fileNode: doc(app_convex_schema, "files_nodes"),
			outputFileNode: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
			outputAssetId: v.union(v.id("files_r2_assets"), v.null()),
			callId: v.id("plugins_event_run_calls"),
		}),
	}),
	handler: async (ctx, args) => {
		const run = await db_get_running_run_by_host_token(ctx, args);
		if (!run) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const now = Date.now();
		if (run.hostCallCount >= MAX_HOST_CALLS) {
			return Result({ _nay: { message: "Plugin host call limit exceeded" } });
		}
		const sequence = run.hostCallCount + 1;
		const fail_claim = async (message: string) => {
			await insert_host_call(ctx, {
				run,
				sequence,
				operation: args.operation,
				status: "failed",
				errorMessage: message,
				now,
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
			});
			await ctx.db.patch("plugins_event_runs", run._id, {
				hostCallCount: sequence,
				updatedAt: now,
			});
			return Result({ _nay: { message } });
		};
		for (const capability of args.requiredCapabilities) {
			if (!run.acceptedCapabilities.includes(capability)) {
				return await fail_claim("Permission denied");
			}
		}
		const outputName = args.operation === "writeMarkdown" ? parse_markdown_output_name(args.outputPath) : null;
		if (outputName?._nay) {
			return await fail_claim(outputName._nay.message);
		}
		const outputPath = outputName?._yay;

		const [asset, fileNode] = await Promise.all([
			ctx.db.get("files_r2_assets", run.assetId),
			ctx.db.get("files_nodes", run.fileNodeId),
		]);
		if (
			!asset ||
			!fileNode ||
			asset.organizationId !== run.organizationId ||
			asset.workspaceId !== run.workspaceId ||
			fileNode.organizationId !== run.organizationId ||
			fileNode.workspaceId !== run.workspaceId
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

		const callId = await insert_host_call(ctx, {
			run,
			sequence,
			operation: args.operation,
			status: "started",
			errorMessage: null,
			now,
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
		});

		await ctx.db.patch("plugins_event_runs", run._id, {
			hostCallCount: sequence,
			hostWriteCount: run.hostWriteCount + (args.operation === "writeMarkdown" ? 1 : 0),
			...(args.operation === "writeMarkdown" && writableOutputFileNode && writableOutputAssetId
				? {
						outputFileNodeId: writableOutputFileNode._id,
						outputAssetId: writableOutputAssetId,
					}
				: {}),
			updatedAt: now,
		});

		const patchedRun = await ctx.db.get("plugins_event_runs", run._id);
		if (!patchedRun) {
			return Result({ _nay: { message: "Not found" } });
		}

		return Result({
			_yay: {
				run: patchedRun,
				asset,
				fileNode,
				outputFileNode: writableOutputFileNode,
				outputAssetId: writableOutputAssetId,
				callId,
			},
		});
	},
});

type claim_host_call_Result =
	typeof claim_host_call extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
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

		await patch_host_call_finished(ctx, call, {
			status: args.status,
			errorMessage: args.errorMessage,
			temporaryUrlExpiresAt: args.temporaryUrlExpiresAt,
			secretFound: args.secretFound,
			secretTier: args.secretTier,
			modelId: args.modelId,
			sourceBytes: args.sourceBytes,
			requestBytes: args.requestBytes,
			responseBytes: args.responseBytes,
			responseStatus: args.responseStatus,
			outputTextBytes: args.outputTextBytes,
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
		const run = await db_get_running_run_by_host_token(ctx, args);
		if (!run) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const callId = ctx.db.normalizeId("plugins_event_run_calls", args.callId);
		if (!callId) {
			return Result({ _nay: { message: "Not found" } });
		}
		const call = await ctx.db.get("plugins_event_run_calls", callId);
		if (!call || call.runId !== run._id || call.status !== "started") {
			return Result({ _nay: { message: "Not found" } });
		}

		await patch_host_call_finished(ctx, call, {
			status: args.status,
			errorMessage: args.errorMessage,
			modelId: args.modelId,
			sourceBytes: args.sourceBytes,
			requestBytes: args.requestBytes,
			responseBytes: args.responseBytes,
			responseStatus: args.responseStatus,
			outputTextBytes: args.outputTextBytes,
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

		const claimed = (await ctx.runMutation(internal.plugins_runtime.claim_host_call, {
			hostTokenHash: await crypto_sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: [],
			operation: "writeMarkdown",
			outputPath: args.path,
			outputOverwrite: args.overwrite,
			markdownBytes,
		})) as claim_host_call_Result;
		if (claimed._nay) {
			return Result({ _nay: { message: claimed._nay.message } });
		}
		if (!claimed._yay.outputFileNode || !claimed._yay.outputAssetId) {
			return Result({ _nay: { message: "Output is not available" } });
		}

		try {
			const output = await write_uploaded_media_markdown_output_objects(ctx, {
				fileNode: claimed._yay.fileNode,
				outputFileNode: claimed._yay.outputFileNode,
				outputAssetId: claimed._yay.outputAssetId,
				markdownContent: args.markdown,
			});
			const finalized = (await ctx.runMutation(internal.r2.finalize_uploaded_media_markdown_outputs, {
				pluginRunId: claimed._yay.run._id,
				organizationId: claimed._yay.run.organizationId,
				workspaceId: claimed._yay.run.workspaceId,
				userId: claimed._yay.run.actorUserId,
				assetId: claimed._yay.run.assetId,
				outputs: [output],
			})) as r2_finalize_uploaded_media_markdown_outputs_Result;
			if (finalized._nay) {
				await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
					callId: claimed._yay.callId,
					status: "failed",
					errorMessage: finalized._nay.message,
				});
				return Result({ _nay: { message: finalized._nay.message } });
			}
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
				status: "succeeded",
				errorMessage: null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
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
		const claimed = (await ctx.runMutation(internal.plugins_runtime.claim_host_call, {
			hostTokenHash: await crypto_sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: [],
			operation: "sourceTemporaryUrl",
			expiresInSeconds: expiresIn,
		})) as claim_host_call_Result;
		if (claimed._nay) {
			return Result({ _nay: { message: claimed._nay.message } });
		}
		if (!claimed._yay.asset.r2Key) {
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
				status: "failed",
				errorMessage: "Source upload is not available",
			});
			return Result({ _nay: { message: "Source upload is not available" } });
		}

		try {
			const url = await r2_get_download_url({
				key: claimed._yay.asset.r2Key,
				options: { expiresIn },
			});
			const expiresAt = Date.now() + expiresIn * 1000;
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
				status: "succeeded",
				errorMessage: null,
				temporaryUrlExpiresAt: expiresAt,
			});
			return Result({ _yay: { url, expiresAt } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
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

		const claimed = (await ctx.runMutation(internal.plugins_runtime.claim_host_call, {
			hostTokenHash: await crypto_sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: ["plugin.secrets.read"],
			operation: "secretGet",
			secretName: name._yay,
		})) as claim_host_call_Result;
		if (claimed._nay) {
			return Result({ _nay: { message: claimed._nay.message } });
		}

		const resolved = await ctx.runMutation(internal.plugins.get_secret_for_runtime, {
			organizationId: claimed._yay.run.organizationId,
			workspaceId: claimed._yay.run.workspaceId,
			installationId: claimed._yay.run.installationId,
			name: name._yay,
		});
		if (!resolved) {
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
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
				callId: claimed._yay.callId,
				status: "failed",
				errorMessage: decrypted._nay.message,
				secretFound: true,
				secretTier: resolved.tier,
			});
			return Result({ _nay: { message: decrypted._nay.message } });
		}
		await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
			callId: claimed._yay.callId,
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
							const result = (await ctx.runMutation(internal.plugins_runtime.claim_host_call, {
								hostTokenHash: await crypto_sha256_hex(auth.token),
								pluginRunId: auth.body.pluginRunId,
								requiredCapabilities: ["outbound.fetch"],
								operation: auth.body.operation,
								requestBytes: auth.body.requestBytes,
							})) as claim_host_call_Result;
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
