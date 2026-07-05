import { Workpool } from "@convex-dev/workpool";
import { doc } from "convex-helpers/validators";
import type { RouteSpec } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

import { components, internal } from "./_generated/api.js";
import {
	httpAction,
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import type { RouterForConvexModules } from "./http.ts";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_is_path_under_system_root, files_normalize_name } from "../shared/files.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
} from "../server/files.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import {
	MEDIA_DESCRIPTION_MODEL_ID,
	create_generated_markdown_output_node,
	get_billed_user_for_media_processing,
	ingest_media_ai_usage_event,
	r2_fetch_object_from_bucket,
	r2_get_download_url,
	write_uploaded_media_markdown_output_objects,
} from "./r2.ts";
import { plugins_secret_name_validate } from "../shared/plugins.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

const plugin_runtime_host_token_ttl_ms = 15 * 60 * 1000;
const plugin_runtime_run_ttl_ms = 30 * 60 * 1000;
const plugin_runtime_max_host_calls = 20;
const plugin_runtime_upload_event_settle_delay_ms = 15 * 1000;
const plugin_runtime_multimodal_generate_text_model_id = "gpt-4.1-mini" as const;

const upload_completed_event_type = "files.upload.completed" as const;

function real_upload_source_scope(sourceAsset: Doc<"files_r2_assets">) {
	const { organizationId, workspaceId, createdBy } = sourceAsset;
	if (
		organizationId === organizations_GLOBAL_ORGANIZATION_ID ||
		workspaceId === organizations_GLOBAL_GITHUB_WORKSPACE_ID ||
		createdBy === users_SYSTEM_AUTHOR
	) {
		return null;
	}
	return { organizationId, workspaceId, createdBy };
}

const plugin_event_execution_workpool = new Workpool(components.files_upload_conversion_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

function normalize_external_base_url(value: string) {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function plugin_runner_url() {
	if (!process.env.PLUGIN_RUNNER_URL) {
		throw new Error("PLUGIN_RUNNER_URL is not set in Convex env");
	}
	return normalize_external_base_url(process.env.PLUGIN_RUNNER_URL);
}

function plugin_runner_secret() {
	if (!process.env.PLUGIN_RUNNER_SECRET) {
		throw new Error("PLUGIN_RUNNER_SECRET is not set in Convex env");
	}
	return process.env.PLUGIN_RUNNER_SECRET;
}

function plugin_runtime_host_origin() {
	if (!process.env.VITE_CONVEX_HTTP_URL) {
		throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
	}
	return normalize_external_base_url(process.env.VITE_CONVEX_HTTP_URL);
}

function normalize_content_type(value: string | undefined) {
	return value?.split(";")[0]?.trim().toLowerCase() ?? null;
}

function backend_artifact_hash(version: Doc<"plugins_versions">) {
	if (!version.backend) {
		return null;
	}

	return (
		version.files.find((file) => file.r2Key === version.backend?.r2Key)?.sha256 ??
		version.files.find((file) => file.path === version.backend?.entry)?.sha256 ??
		version.artifactHash
	);
}

async function sha256_hex(input: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function create_host_token() {
	return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}

function bearer_token(request: Request) {
	const header = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) {
		return null;
	}
	return header.slice(prefix.length);
}

function plugin_markdown_output_name(path: string | undefined) {
	if (!path) {
		return Result({ _nay: { message: "Output is not available" } });
	}
	if (
		path !== path.trim() ||
		path.includes("/") ||
		path.includes("\\") ||
		path.startsWith(".") ||
		!path.toLowerCase().endsWith(".md") ||
		files_is_path_under_system_root(`/${path}`)
	) {
		return Result({ _nay: { message: "Output path is invalid" } });
	}
	const normalized = files_normalize_name("file", path);
	if (normalized._nay) {
		return Result({ _nay: { message: "Output path is invalid" } });
	}
	return Result({ _yay: normalized._yay });
}

async function clear_run_processing_assets(ctx: MutationCtx, run: Doc<"plugins_event_runs">) {
	const now = Date.now();
	if (run.outputAssetId) {
		await ctx.db.patch("files_r2_assets", run.outputAssetId, {
			conversionWorkId: null,
			updatedAt: now,
		});
	}
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
		...(args.outputPath === undefined ? {} : { outputPath: args.outputPath }),
		...(args.outputOverwrite === undefined ? {} : { outputOverwrite: args.outputOverwrite }),
		...(args.markdownBytes === undefined ? {} : { markdownBytes: args.markdownBytes }),
		...(args.expiresInSeconds === undefined ? {} : { expiresInSeconds: args.expiresInSeconds }),
		...(args.secretName === undefined ? {} : { secretName: args.secretName }),
		...(args.systemBytes === undefined ? {} : { systemBytes: args.systemBytes }),
		...(args.promptBytes === undefined ? {} : { promptBytes: args.promptBytes }),
		...(args.includeSourceImage === undefined ? {} : { includeSourceImage: args.includeSourceImage }),
		...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: args.maxOutputTokens }),
		...(args.requestBytes === undefined ? {} : { requestBytes: args.requestBytes }),
		errorMessage: args.errorMessage,
		startedAt: args.now,
		...(args.status === "started" ? {} : { finishedAt: args.now, elapsedMs: 0 }),
		createdAt: args.now,
		updatedAt: args.now,
	});
}

export const enqueue_upload_completed_runs = internalMutation({
	args: {
		sourceAssetId: v.id("files_r2_assets"),
		sourceFileNodeId: v.id("files_nodes"),
		eventId: v.string(),
		contentType: v.string(),
	},
	returns: v_result({ _yay: v.object({ enqueued: v.number() }) }),
	handler: async (ctx, args) => {
		const [sourceAsset, sourceFileNode] = await Promise.all([
			ctx.db.get("files_r2_assets", args.sourceAssetId),
			ctx.db.get("files_nodes", args.sourceFileNodeId),
		]);
		if (
			!sourceAsset ||
			!sourceFileNode ||
			sourceFileNode.assetId !== sourceAsset._id ||
			sourceFileNode.kind !== "file" ||
			files_node_has_editable_yjs_state(sourceFileNode)
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!sourceAsset.r2Key) {
			const errorMessage = "sourceAsset.r2Key is not set for plugin upload event";
			console.error(errorMessage, { sourceAssetId: sourceAsset._id });
			throw should_never_happen(errorMessage, { sourceAssetId: sourceAsset._id });
		}
		const sourceScope = real_upload_source_scope(sourceAsset);
		if (!sourceScope) {
			return Result({ _nay: { message: "Not found" } });
		}

		const contentType = normalize_content_type(args.contentType);
		if (!contentType) {
			await ctx.db.patch("files_r2_assets", sourceAsset._id, { conversionWorkId: null, updatedAt: Date.now() });
			return Result({ _yay: { enqueued: 0 } });
		}

		const handlers = await ctx.db
			.query("plugins_workspace_event_handlers")
			.withIndex("by_scope_event_status_contentType_createdAt_name", (q) =>
				q
					.eq("organizationId", sourceScope.organizationId)
					.eq("workspaceId", sourceScope.workspaceId)
					.eq("event", upload_completed_event_type)
					.eq("status", "enabled")
					.eq("contentType", contentType),
			)
			.collect();

		const candidates: Array<{
			handler: Doc<"plugins_workspace_event_handlers">;
			installation: Doc<"plugins_workspace_installations">;
			version: Doc<"plugins_versions">;
			artifactHash: string;
		}> = [];
		for (const handler of handlers) {
			const [installation, version] = await Promise.all([
				ctx.db.get("plugins_workspace_installations", handler.installationId),
				ctx.db.get("plugins_versions", handler.pluginVersionId),
			]);
			if (
				!installation ||
				!version ||
				installation.status !== "enabled" ||
				!version.backend ||
				!installation.acceptedCapabilities.includes("files.markdown.write")
			) {
				continue;
			}
			const artifactHash = backend_artifact_hash(version);
			if (!artifactHash) {
				console.error("Enabled upload plugin version has no executable backend artifact hash", {
					pluginVersionId: version._id,
				});
				continue;
			}
			candidates.push({ handler, installation, version, artifactHash });
		}

		if (candidates.length === 0) {
			console.error("No enabled plugin handler found for upload event", {
				sourceAssetId: sourceAsset._id,
				contentType,
			});
			await ctx.db.patch("files_r2_assets", sourceAsset._id, { conversionWorkId: null, updatedAt: Date.now() });
			return Result({ _yay: { enqueued: 0 } });
		}

		const now = Date.now();
		let enqueued = 0;
		for (const candidate of candidates) {
			const existingRun = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_sourceAsset_event_installation", (q) =>
					q
						.eq("sourceAssetId", sourceAsset._id)
						.eq("event", upload_completed_event_type)
						.eq("installationId", candidate.installation._id),
				)
				.first();
			if (existingRun) {
				continue;
			}

			const runId = await ctx.db.insert("plugins_event_runs", {
				organizationId: sourceScope.organizationId,
				workspaceId: sourceScope.workspaceId,
				sourceAssetId: sourceAsset._id,
				sourceFileNodeId: sourceFileNode._id,
				actorUserId: sourceScope.createdBy,
				installationId: candidate.installation._id,
				pluginVersionId: candidate.version._id,
				event: upload_completed_event_type,
				eventId: composite_id("plugin", "upload_completed", args.eventId, String(candidate.installation._id)),
				status: "queued",
				acceptedCapabilities: candidate.installation.acceptedCapabilities,
				expiresAt: now + plugin_runtime_run_ttl_ms,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				createdAt: now,
				updatedAt: now,
			});

			const workId = await plugin_event_execution_workpool.enqueueAction(
				ctx,
				internal.plugins_runtime.execute_upload_completed_event_run,
				{
					runId,
				},
				{ runAfter: plugin_runtime_upload_event_settle_delay_ms },
			);
			await ctx.db.patch("plugins_event_runs", runId, {
				workId,
				updatedAt: now,
			});
			enqueued += 1;
		}

		await ctx.db.patch("files_r2_assets", sourceAsset._id, { conversionWorkId: null, updatedAt: now });

		return Result({ _yay: { enqueued } });
	},
});

export const start_event_run = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		hostTokenHash: v.string(),
		hostTokenExpiresAt: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			run: doc(app_convex_schema, "plugins_event_runs"),
			sourceAsset: doc(app_convex_schema, "files_r2_assets"),
			sourceFileNode: doc(app_convex_schema, "files_nodes"),
			installation: doc(app_convex_schema, "plugins_workspace_installations"),
			version: doc(app_convex_schema, "plugins_versions"),
			artifactHash: v.string(),
			outboundOrigins: v.array(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("plugins_event_runs", args.runId);
		if (!run || run.status !== "queued" || run.expiresAt <= Date.now()) {
			return Result({ _nay: { message: "Not found" } });
		}

		const [sourceAsset, sourceFileNode, installation, version] = await Promise.all([
			ctx.db.get("files_r2_assets", run.sourceAssetId),
			ctx.db.get("files_nodes", run.sourceFileNodeId),
			ctx.db.get("plugins_workspace_installations", run.installationId),
			ctx.db.get("plugins_versions", run.pluginVersionId),
		]);
		if (!sourceAsset || !sourceFileNode || !installation || !version || !version.backend) {
			return Result({ _nay: { message: "Not found" } });
		}
		const artifactHash = backend_artifact_hash(version);
		if (!artifactHash) {
			return Result({ _nay: { message: "Plugin backend artifact hash is missing" } });
		}

		// Per-run egress allowlist: consented artifact origins plus the publishing user's secret origins.
		const publisherSecrets = await ctx.db
			.query("plugins_publisher_secrets")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", version.createdBy))
			.take(100);
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
			hostTokenExpiresAt: args.hostTokenExpiresAt,
			startedAt: now,
			updatedAt: now,
		});

		const patchedRun = await ctx.db.get("plugins_event_runs", run._id);
		if (!patchedRun) {
			return Result({ _nay: { message: "Not found" } });
		}

		return Result({
			_yay: { run: patchedRun, sourceAsset, sourceFileNode, installation, version, artifactHash, outboundOrigins },
		});
	},
});

export const finish_event_run = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		status: v.union(v.literal("succeeded"), v.literal("failed")),
		errorMessage: v.union(v.string(), v.null()),
		runnerHttpStatus: v.optional(v.number()),
		runnerElapsedMs: v.optional(v.number()),
		pluginStatus: v.optional(v.number()),
		runnerOutputBytes: v.optional(v.number()),
		runnerOutputTruncated: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("plugins_event_runs", args.runId);
		if (!run) {
			return null;
		}

		const now = Date.now();
		await ctx.db.patch("plugins_event_runs", run._id, {
			status: args.status,
			errorMessage: args.errorMessage,
			...(args.runnerHttpStatus === undefined ? {} : { runnerHttpStatus: args.runnerHttpStatus }),
			...(args.runnerElapsedMs === undefined ? {} : { runnerElapsedMs: args.runnerElapsedMs }),
			...(args.pluginStatus === undefined ? {} : { pluginStatus: args.pluginStatus }),
			...(args.runnerOutputBytes === undefined ? {} : { runnerOutputBytes: args.runnerOutputBytes }),
			...(args.runnerOutputTruncated === undefined ? {} : { runnerOutputTruncated: args.runnerOutputTruncated }),
			finishedAt: now,
			updatedAt: now,
		});
		if (args.status === "failed") {
			await clear_run_processing_assets(ctx, run);
		}

		return null;
	},
});

export const get_run_completion_state = internalQuery({
	args: {
		runId: v.id("plugins_event_runs"),
	},
	returns: v.union(
		v.object({
			status: doc(app_convex_schema, "plugins_event_runs").fields.status,
			hostWriteCount: v.number(),
			succeededWriteCount: v.number(),
			startedCallCount: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("plugins_event_runs", args.runId);
		if (!run) {
			return null;
		}
		const calls = await ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", run._id))
			.take(plugin_runtime_max_host_calls);
		return {
			status: run.status,
			hostWriteCount: run.hostWriteCount,
			succeededWriteCount: calls.filter((call) => call.operation === "writeMarkdown" && call.status === "succeeded")
				.length,
			startedCallCount: calls.filter((call) => call.status === "started").length,
		};
	},
});

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
		...(args.temporaryUrlExpiresAt === undefined ? {} : { temporaryUrlExpiresAt: args.temporaryUrlExpiresAt }),
		...(args.secretFound === undefined ? {} : { secretFound: args.secretFound }),
		...(args.secretTier === undefined ? {} : { secretTier: args.secretTier }),
		...(args.modelId === undefined ? {} : { modelId: args.modelId }),
		...(args.sourceBytes === undefined ? {} : { sourceBytes: args.sourceBytes }),
		...(args.requestBytes === undefined ? {} : { requestBytes: args.requestBytes }),
		...(args.responseBytes === undefined ? {} : { responseBytes: args.responseBytes }),
		...(args.responseStatus === undefined ? {} : { responseStatus: args.responseStatus }),
		...(args.outputTextBytes === undefined ? {} : { outputTextBytes: args.outputTextBytes }),
		finishedAt: now,
		elapsedMs: now - call.startedAt,
		updatedAt: now,
	});
}

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
		const run = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_hostTokenHash", (q) => q.eq("hostTokenHash", args.hostTokenHash))
			.unique();
		const now = Date.now();
		if (!run || run.status !== "running" || !run.hostTokenExpiresAt || run.hostTokenExpiresAt <= now) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (String(run._id) !== args.pluginRunId) {
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

export const claim_host_call = internalMutation({
	args: {
		hostTokenHash: v.string(),
		pluginRunId: v.string(),
		requiredCapabilities: doc(app_convex_schema, "plugins_workspace_installations").fields.acceptedCapabilities,
		operation: v.union(
			v.literal("writeMarkdown"),
			v.literal("generateText"),
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
			sourceAsset: doc(app_convex_schema, "files_r2_assets"),
			sourceFileNode: doc(app_convex_schema, "files_nodes"),
			outputFileNode: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
			outputAssetId: v.union(v.id("files_r2_assets"), v.null()),
			callId: v.id("plugins_event_run_calls"),
		}),
	}),
	handler: async (ctx, args) => {
		const run = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_hostTokenHash", (q) => q.eq("hostTokenHash", args.hostTokenHash))
			.unique();
		const now = Date.now();
		if (!run || run.status !== "running" || !run.hostTokenExpiresAt || run.hostTokenExpiresAt <= now) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (String(run._id) !== args.pluginRunId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (run.hostCallCount >= plugin_runtime_max_host_calls) {
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
		const outputName = args.operation === "writeMarkdown" ? plugin_markdown_output_name(args.outputPath) : null;
		if (outputName?._nay) {
			return await fail_claim(outputName._nay.message);
		}
		const outputPath = outputName?._yay;

		const [sourceAsset, sourceFileNode] = await Promise.all([
			ctx.db.get("files_r2_assets", run.sourceAssetId),
			ctx.db.get("files_nodes", run.sourceFileNodeId),
		]);
		if (
			!sourceAsset ||
			!sourceFileNode ||
			sourceAsset.organizationId !== run.organizationId ||
			sourceAsset.workspaceId !== run.workspaceId ||
			sourceFileNode.organizationId !== run.organizationId ||
			sourceFileNode.workspaceId !== run.workspaceId
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
				sourceFileNode,
				name: outputPath,
				overwrite: args.outputOverwrite,
				now,
			});
			if (output._nay) {
				return await fail_claim(output._nay.message);
			}
			writableOutputFileNode = await ctx.db.get("files_nodes", output._yay.nodeId);
			writableOutputAssetId = output._yay.assetId;
		}

		if (
			args.operation === "writeMarkdown" &&
			(!writableOutputFileNode ||
				!writableOutputAssetId ||
				writableOutputFileNode.organizationId !== run.organizationId ||
				writableOutputFileNode.workspaceId !== run.workspaceId ||
				writableOutputFileNode.kind !== "file" ||
				writableOutputFileNode.assetId !== writableOutputAssetId)
		) {
			return await fail_claim("Not found");
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
				sourceAsset,
				sourceFileNode,
				outputFileNode: writableOutputFileNode,
				outputAssetId: writableOutputAssetId,
				callId,
			},
		});
	},
});

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
			hostTokenHash: await sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: ["files.markdown.write"],
			operation: "writeMarkdown",
			outputPath: args.path,
			outputOverwrite: args.overwrite,
			markdownBytes,
		})) as {
			_yay?: {
				run: Doc<"plugins_event_runs">;
				sourceAsset: Doc<"files_r2_assets">;
				sourceFileNode: Doc<"files_nodes">;
				outputFileNode: Doc<"files_nodes"> | null;
				outputAssetId: Id<"files_r2_assets"> | null;
				callId: Id<"plugins_event_run_calls">;
			};
			_nay?: { message: string };
		};
		if (claimed._nay) {
			return Result({ _nay: { message: claimed._nay.message } });
		}
		if (!claimed._yay?.outputFileNode || !claimed._yay.outputAssetId) {
			return Result({ _nay: { message: "Output is not available" } });
		}

		try {
			const output = await write_uploaded_media_markdown_output_objects(ctx, {
				sourceFileNode: claimed._yay.sourceFileNode,
				outputFileNode: claimed._yay.outputFileNode,
				outputAssetId: claimed._yay.outputAssetId,
				markdownContent: args.markdown,
			});
			const finalized = (await ctx.runMutation(internal.r2.finalize_uploaded_media_markdown_outputs, {
				organizationId: claimed._yay.run.organizationId,
				workspaceId: claimed._yay.run.workspaceId,
				userId: claimed._yay.run.actorUserId,
				sourceAssetId: claimed._yay.run.sourceAssetId,
				outputs: [output],
			})) as { _yay?: null; _nay?: { message: string } };
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
			hostTokenHash: await sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: ["files.source.temporaryUrl"],
			operation: "sourceTemporaryUrl",
			expiresInSeconds: expiresIn,
		})) as {
			_yay?: {
				sourceAsset: Doc<"files_r2_assets">;
				callId: Id<"plugins_event_run_calls">;
			};
			_nay?: { message: string };
		};
		if (claimed._nay) {
			return Result({ _nay: { message: claimed._nay.message } });
		}
		if (!claimed._yay?.sourceAsset.r2Key) {
			if (claimed._yay) {
				await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
					callId: claimed._yay.callId,
					status: "failed",
					errorMessage: "Source upload is not available",
				});
			}
			return Result({ _nay: { message: "Source upload is not available" } });
		}

		try {
			const url = await r2_get_download_url({
				key: claimed._yay.sourceAsset.r2Key,
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

export const host_secret_get = internalAction({
	args: {
		hostToken: v.string(),
		pluginRunId: v.string(),
		name: v.string(),
	},
	returns: v_result({ _yay: v.union(v.string(), v.null()) }),
	handler: async (ctx, args) => {
		const name = plugins_secret_name_validate(args.name);
		if (name._nay) {
			return Result({ _nay: { message: name._nay.message } });
		}

		const claimed = (await ctx.runMutation(internal.plugins_runtime.claim_host_call, {
			hostTokenHash: await sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities: ["plugin.secrets.read"],
			operation: "secretGet",
			secretName: name._yay,
		})) as {
			_yay?: {
				run: Doc<"plugins_event_runs">;
				callId: Id<"plugins_event_run_calls">;
			};
			_nay?: { message: string };
		};
		if (claimed._nay || !claimed._yay) {
			return Result({ _nay: { message: claimed._nay?.message ?? "Unauthorized" } });
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
		})) as { _yay?: string | null; _nay?: { message: string } };
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
		return Result({ _yay: decrypted._yay ?? null });
	},
});

export const host_generate_text = internalAction({
	args: {
		hostToken: v.string(),
		pluginRunId: v.string(),
		system: v.string(),
		prompt: v.string(),
		includeSourceImage: v.optional(v.boolean()),
		maxOutputTokens: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ text: v.string() }) }),
	handler: async (ctx, args) => {
		const requiredCapabilities: Array<"uploads.source.read" | "ai.generateText"> =
			args.includeSourceImage === false ? ["ai.generateText"] : ["uploads.source.read", "ai.generateText"];
		const systemBytes = files_get_utf8_byte_size(args.system);
		const promptBytes = files_get_utf8_byte_size(args.prompt);
		const claimed = (await ctx.runMutation(internal.plugins_runtime.claim_host_call, {
			hostTokenHash: await sha256_hex(args.hostToken),
			pluginRunId: args.pluginRunId,
			requiredCapabilities,
			operation: "generateText",
			systemBytes,
			promptBytes,
			includeSourceImage: args.includeSourceImage,
			maxOutputTokens: args.maxOutputTokens,
		})) as {
			_yay?: {
				run: Doc<"plugins_event_runs">;
				sourceAsset: Doc<"files_r2_assets">;
				sourceFileNode: Doc<"files_nodes">;
				callId: Id<"plugins_event_run_calls">;
			};
			_nay?: { message: string };
		};
		if (claimed._nay) {
			return Result({ _nay: { message: claimed._nay.message } });
		}
		if (!claimed._yay) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const sourceImageR2Key = args.includeSourceImage === false ? null : claimed._yay.sourceAsset.r2Key;
		if (args.includeSourceImage !== false && !sourceImageR2Key) {
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
				status: "failed",
				errorMessage: "Source upload is not available",
			});
			return Result({ _nay: { message: "Source upload is not available" } });
		}

		const billedUser = await get_billed_user_for_media_processing(ctx, claimed._yay.sourceFileNode);
		if (!billedUser) {
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
				status: "failed",
				errorMessage: "Insufficient credits",
			});
			return Result({ _nay: { message: "Insufficient credits" } });
		}

		let result: Awaited<ReturnType<typeof generateText>>;
		let sourceImageBytes: Uint8Array | null = null;
		let modelId = MEDIA_DESCRIPTION_MODEL_ID;
		try {
			sourceImageBytes = sourceImageR2Key
				? new Uint8Array(await (await r2_fetch_object_from_bucket({ key: sourceImageR2Key })).arrayBuffer())
				: null;
			modelId = sourceImageBytes ? plugin_runtime_multimodal_generate_text_model_id : MEDIA_DESCRIPTION_MODEL_ID;
			result = await generateText({
				model: openai(modelId),
				system: args.system,
				messages: [
					{
						role: "user",
						content: sourceImageBytes
							? [
									{ type: "text", text: args.prompt },
									{
										type: "image",
										image: sourceImageBytes,
										mediaType: claimed._yay.sourceFileNode.contentType,
									},
								]
							: args.prompt,
					},
				],
				maxOutputTokens: args.maxOutputTokens ?? 900,
			});
			await ingest_media_ai_usage_event(ctx, {
				sourceFileNode: claimed._yay.sourceFileNode,
				billedUser,
				modelId,
				operationId: composite_id(
					"plugin",
					"generate_text",
					String(claimed._yay.run._id),
					String(claimed._yay.run.hostCallCount),
				),
				inputTokens: result.totalUsage.inputTokens ?? 0,
				outputTokens: result.totalUsage.outputTokens ?? 0,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
				callId: claimed._yay.callId,
				status: "failed",
				errorMessage: message,
				modelId,
				...(sourceImageBytes ? { sourceBytes: sourceImageBytes.byteLength } : {}),
			});
			return Result({
				_nay: {
					message,
				},
			});
		}

		await ctx.runMutation(internal.plugins_runtime.finish_host_call, {
			callId: claimed._yay.callId,
			status: "succeeded",
			errorMessage: null,
			modelId,
			...(sourceImageBytes ? { sourceBytes: sourceImageBytes.byteLength } : {}),
			outputTextBytes: files_get_utf8_byte_size(result.text),
		});

		return Result({ _yay: { text: result.text } });
	},
});

export const execute_upload_completed_event_run = internalAction({
	args: {
		runId: v.id("plugins_event_runs"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const hostToken = create_host_token();
		const started = (await ctx.runMutation(internal.plugins_runtime.start_event_run, {
			runId: args.runId,
			hostTokenHash: await sha256_hex(hostToken),
			hostTokenExpiresAt: Date.now() + plugin_runtime_host_token_ttl_ms,
		})) as {
			_yay?: {
				run: Doc<"plugins_event_runs">;
				sourceAsset: Doc<"files_r2_assets">;
				sourceFileNode: Doc<"files_nodes">;
				installation: Doc<"plugins_workspace_installations">;
				version: Doc<"plugins_versions">;
				artifactHash: string;
				outboundOrigins: string[];
			};
			_nay?: { message: string };
		};
		if (started._nay || !started._yay) {
			console.error("Failed to start plugin event run", { runId: args.runId, message: started._nay?.message });
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				status: "failed",
				errorMessage: started._nay?.message ?? "Failed to start plugin event run",
			});
			return null;
		}

		const backend = started._yay.version.backend;
		if (!backend) {
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				status: "failed",
				errorMessage: "Plugin backend is missing",
			});
			return null;
		}

		try {
			const runnerResponse = await fetch(`${plugin_runner_url()}/internal/plugin-runner/run`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${plugin_runner_secret()}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					pluginId: started._yay.version.name,
					pluginName: started._yay.version.name,
					pluginVersion: started._yay.version.version,
					pluginRunId: String(started._yay.run._id),
					artifactKey: backend.r2Key,
					artifactHash: started._yay.artifactHash,
					host: {
						origin: plugin_runtime_host_origin(),
						token: hostToken,
					},
					acceptedCapabilities: started._yay.run.acceptedCapabilities,
					outboundOrigins: started._yay.outboundOrigins,
					input: {
						event: upload_completed_event_type,
						eventId: started._yay.run.eventId,
						organizationId: String(started._yay.run.organizationId),
						workspaceId: String(started._yay.run.workspaceId),
						actorUserId: String(started._yay.run.actorUserId),
						source: {
							fileNodeId: String(started._yay.sourceFileNode._id),
							assetId: String(started._yay.sourceAsset._id),
							name: started._yay.sourceFileNode.name,
							contentType: started._yay.sourceFileNode.contentType ?? null,
							size: started._yay.sourceAsset.size,
						},
					},
				}),
			});
			const runnerBody = await parse_runner_response(runnerResponse);
			const completionState = await ctx.runQuery(internal.plugins_runtime.get_run_completion_state, {
				runId: args.runId,
			});
			if (
				runnerResponse.ok &&
				runnerBody.status === "succeeded" &&
				completionState?.succeededWriteCount &&
				completionState.startedCallCount === 0
			) {
				const pluginStatusIsOk =
					runnerBody.pluginStatus === undefined || (runnerBody.pluginStatus >= 200 && runnerBody.pluginStatus < 300);
				if (pluginStatusIsOk) {
					await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
						runId: args.runId,
						status: "succeeded",
						errorMessage: null,
						runnerHttpStatus: runnerResponse.status,
						runnerElapsedMs: runnerBody.elapsedMs,
						pluginStatus: runnerBody.pluginStatus,
						runnerOutputBytes: runnerBody.outputBytes,
						runnerOutputTruncated: runnerBody.outputTruncated,
					});
					return null;
				}
			}

			const errorMessage =
				runnerBody.pluginStatus !== undefined && (runnerBody.pluginStatus < 200 || runnerBody.pluginStatus >= 300)
					? `Plugin returned status ${runnerBody.pluginStatus}`
					: runnerBody.errorMessage
						? runnerBody.errorMessage
						: completionState?.startedCallCount
							? "Plugin left host calls unfinished"
							: runnerResponse.ok && runnerBody.status === "succeeded"
								? "Plugin produced no Markdown output"
								: `Plugin runner failed with status ${runnerResponse.status}`;
			console.error("Plugin event run failed", { runId: args.runId, errorMessage });
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				status: "failed",
				errorMessage,
				runnerHttpStatus: runnerResponse.status,
				runnerElapsedMs: runnerBody.elapsedMs,
				pluginStatus: runnerBody.pluginStatus,
				runnerOutputBytes: runnerBody.outputBytes,
				runnerOutputTruncated: runnerBody.outputTruncated,
			});
			return null;
		} catch (error) {
			const errorMessage = "Plugin runner request failed";
			console.error("Plugin event run threw", {
				runId: args.runId,
				errorName: error instanceof Error ? error.name : typeof error,
			});
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId: args.runId,
				status: "failed",
				errorMessage,
			});
			return null;
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
				return { status: "errored" as const, errorMessage: "Plugin runner failed" };
			}
			return { status: "errored" as const, errorMessage: "Plugin runner returned an invalid response" };
		}
		return {
			status: parsed.data.status,
			errorMessage: parsed.data.error ? "Plugin execution failed" : undefined,
			pluginStatus: parsed.data.pluginStatus,
			elapsedMs: parsed.data.elapsedMs,
			outputBytes: parsed.data.outputBytes,
			outputTruncated: parsed.data.outputTruncated,
		};
	} catch {
		return { status: "errored" as const, errorMessage: "Plugin runner returned invalid JSON" };
	}
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
								operation: z.union([
									z.literal("generateText"),
									z.literal("outboundFetch"),
								]),
								systemBytes: z.number().int().min(0).optional(),
								promptBytes: z.number().int().min(0).optional(),
								includeSourceImage: z.boolean().optional(),
								maxOutputTokens: z.number().int().min(1).max(4000).optional(),
								requestBytes: z.number().int().min(0).optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const token = bearer_token(request);
							if (!token) {
								return { status: 401, body: { message: "Unauthorized" } } as const;
							}

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}
							const requiredCapabilities =
								body._yay.operation === "generateText"
									? body._yay.includeSourceImage
										? (["uploads.source.read", "ai.generateText"] as const)
										: (["ai.generateText"] as const)
									: (["outbound.fetch"] as const);
							const result = (await ctx.runMutation(internal.plugins_runtime.claim_host_call, {
								hostTokenHash: await sha256_hex(token),
								pluginRunId: body._yay.pluginRunId,
								requiredCapabilities: [...requiredCapabilities],
								operation: body._yay.operation,
								systemBytes: body._yay.systemBytes,
								promptBytes: body._yay.promptBytes,
								includeSourceImage: body._yay.includeSourceImage,
								maxOutputTokens: body._yay.maxOutputTokens,
								requestBytes: body._yay.requestBytes,
							})) as { _yay?: { callId: Id<"plugins_event_run_calls"> }; _nay?: { message: string } };
							if (result._nay || !result._yay) {
								return { status: 400, body: { message: result._nay?.message ?? "Failed to claim host call" } } as const;
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
							const token = bearer_token(request);
							if (!token) {
								return { status: 401, body: { message: "Unauthorized" } } as const;
							}

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}
							const result = (await ctx.runMutation(internal.plugins_runtime.finish_runner_host_call, {
								hostTokenHash: await sha256_hex(token),
								pluginRunId: body._yay.pluginRunId,
								callId: body._yay.callId,
								status: body._yay.status,
								errorMessage: body._yay.errorMessage ?? null,
								modelId: body._yay.modelId,
								sourceBytes: body._yay.sourceBytes,
								requestBytes: body._yay.requestBytes,
								responseBytes: body._yay.responseBytes,
								responseStatus: body._yay.responseStatus,
								outputTextBytes: body._yay.outputTextBytes,
							})) as { _yay?: null; _nay?: { message: string } };
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
		...((path = "/api/internal/plugins/host/write-markdown" as const satisfies api_schemas_Main_Path) => ({
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
							const token = bearer_token(request);
							if (!token) {
								return { status: 401, body: { message: "Unauthorized" } } as const;
							}

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}
							const result = (await ctx.runAction(internal.plugins_runtime.host_write_markdown, {
								hostToken: token,
								pluginRunId: body._yay.pluginRunId,
								markdown: body._yay.markdown,
								path: body._yay.path,
								overwrite: body._yay.overwrite,
							})) as { _yay?: null; _nay?: { message: string } };
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
		...((path = "/api/internal/plugins/host/source-temporary-url" as const satisfies api_schemas_Main_Path) => ({
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
							const token = bearer_token(request);
							if (!token) {
								return { status: 401, body: { message: "Unauthorized" } } as const;
							}

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}
							const result = (await ctx.runAction(internal.plugins_runtime.host_source_temporary_url, {
								hostToken: token,
								pluginRunId: body._yay.pluginRunId,
								expiresInSeconds: body._yay.expiresInSeconds,
							})) as { _yay?: { url: string; expiresAt: number }; _nay?: { message: string } };
							if (result._nay || !result._yay) {
								return {
									status: 400,
									body: { message: result._nay?.message ?? "Failed to create source URL" },
								} as const;
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
							const token = bearer_token(request);
							if (!token) {
								return { status: 401, body: { message: "Unauthorized" } } as const;
							}

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}
							const result = (await ctx.runAction(internal.plugins_runtime.host_secret_get, {
								hostToken: token,
								pluginRunId: body._yay.pluginRunId,
								name: body._yay.name,
							})) as { _yay?: string | null; _nay?: { message: string } };
							if (result._nay) {
								return { status: 400, body: { message: result._nay.message } } as const;
							}

							return { status: 200, body: { value: result._yay ?? null } } as const;
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
		...((path = "/api/internal/plugins/host/generate-text" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: (() => {
						const bodyValidator = z
							.object({
								pluginRunId: z.string(),
								system: z.string().min(1).max(16_000),
								prompt: z.string().min(1).max(16_000),
								includeSourceImage: z.boolean().optional(),
								maxOutputTokens: z.number().int().min(1).max(4000).optional(),
							})
							.strict();
						const handler = async (ctx: ActionCtx, request: Request) => {
							const token = bearer_token(request);
							if (!token) {
								return { status: 401, body: { message: "Unauthorized" } } as const;
							}

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}
							const result = (await ctx.runAction(internal.plugins_runtime.host_generate_text, {
								hostToken: token,
								pluginRunId: body._yay.pluginRunId,
								system: body._yay.system,
								prompt: body._yay.prompt,
								includeSourceImage: body._yay.includeSourceImage,
								maxOutputTokens: body._yay.maxOutputTokens,
							})) as { _yay?: { text: string }; _nay?: { message: string } };
							if (result._nay || !result._yay) {
								return { status: 400, body: { message: result._nay?.message ?? "Failed to generate text" } } as const;
							}

							return { status: 200, body: { text: result._yay.text } } as const;
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
