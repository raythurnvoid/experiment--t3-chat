import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { RegisteredAction, RegisteredMutation, RegisteredQuery } from "convex/server";
import { omit } from "convex-helpers";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import { createPatch } from "diff";

import type { Doc, Id } from "./_generated/dataModel";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import app_convex_schema from "./schema.ts";
import { Result } from "common/errors-as-values-utils.ts";
import type { ai_chat_ModelId } from "../shared/ai-chat.ts";
import {
	plugins_MAX_ARTIFACT_BYTES,
	plugins_RUNTIME_VERSION,
	plugins_dist_review_mechanical_findings,
	plugins_parse_github_repository_url,
	plugins_validate_manifest,
	plugins_validate_secret_name,
} from "../shared/plugins.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
} from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { v_result } from "../server/convex-utils.ts";
import { github_fetch_repo_head, github_fetch_with_retry, github_raw_url } from "../server/github.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { crypto_decrypt_secret_value, crypto_encrypt_secret_value, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_delete_object, r2_fetch_object_from_bucket, r2_put_object } from "./r2.ts";
import { files_nodes_db_delete_subtree_batch } from "./files_nodes.ts";
import type { files_nodes_create_file_node_internal_Result } from "./files_nodes.ts";
import { plugins_runtime_db_enqueue_manual_run } from "./plugins_runtime.ts";
import { public_api_db_cleanup_file_write_stage } from "./public_api.ts";

const PLUGIN_SECRETS_MAX_BATCH_SIZE = 50;
const ARTIFACT_DOWNLOAD_CONCURRENCY = 4;
const ARTIFACT_UPLOAD_CONCURRENCY = 4;
/** How long cleanup waits before deleting an interrupted publish's uploads, so a concurrent publish of the same artifact can finish. */
const PUBLISH_CLEANUP_GRACE_MS = 60 * 60 * 1000;
const PUBLISH_CLEANUP_KEYS_PER_RUN = 10;
const PUBLISH_CLEANUP_RETRY_MS = 5 * 60 * 1000;
const PUBLISH_CLEANUP_CRON_BATCH_SIZE = 10;

/**
 * Workpool handle for plugin event-run executions.
 *
 * Hard plugin deletes cancel queued runs through it before deleting their tracking docs.
 */
const plugins_runtime_workpool = new Workpool(components.plugins_runtime_workpool, {
	maxParallelism: 4,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 1000,
		base: 2,
		maxAttempts: 3,
	} as const,
});

type PluginResult<T> = { _yay: T; _nay?: undefined } | { _nay: { message: string }; _yay?: undefined };

async function db_authorize_plugin_management(
	ctx: Parameters<typeof organizations_db_get_membership>[0],
	args: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> },
) {
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const organization = await ctx.db.get("organizations", membership.organizationId);
	if (!organization?.defaultWorkspaceId) {
		const errorMessage = "organization.defaultWorkspaceId is not set";
		const errorData = {
			organizationId: membership.organizationId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const hasPermission = await access_control_db_has_permission(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resourceKind: "workspace",
		resourceId: String(membership.workspaceId),
		permission: "workspace.plugins.manage",
		userId: args.userId,
	});
	if (!hasPermission) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: { membership } });
}

function version_r2_keys(version: Doc<"plugins_versions">) {
	const r2Keys = new Set<string>([version.manifestR2Key]);
	if (version.backendEntrypointFile) {
		r2Keys.add(version.backendEntrypointFile.r2Key);
	}
	for (const file of version.files) {
		r2Keys.add(file.r2Key);
	}
	return r2Keys;
}

// #region github import

/**
 * Streams a response body and gives up as soon as the bytes read exceed `maxBytes`, so an
 * oversized body never fully buffers in memory. Returns null when the body is too big.
 */
async function read_response_body_bounded(response: Response, maxBytes: number) {
	if (!response.body) {
		const buffer = await response.arrayBuffer();
		return buffer.byteLength > maxBytes ? null : buffer;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

async function fetch_github_text(args: {
	owner: string;
	repo: string;
	commitSha: string;
	path: string;
}): Promise<PluginResult<string>> {
	const response = await github_fetch_with_retry(github_raw_url(args));
	if (response._nay) {
		return Result({ _nay: { message: `GitHub file "${args.path}" request failed: ${response._nay.message}` } });
	}

	const bytes = await read_response_body_bounded(response._yay, files_MAX_TEXT_CONTENT_BYTES);
	if (bytes === null) {
		return Result({ _nay: { message: `GitHub file "${args.path}" is too large` } });
	}

	return { _yay: text_decoder.decode(bytes) };
}

async function fetch_github_bytes(args: {
	owner: string;
	repo: string;
	commitSha: string;
	path: string;
	maxBytes: number;
}): Promise<PluginResult<ArrayBuffer>> {
	const response = await github_fetch_with_retry(github_raw_url(args));
	if (response._nay) {
		return Result({ _nay: { message: `GitHub file "${args.path}" request failed: ${response._nay.message}` } });
	}

	const bytes = await read_response_body_bounded(response._yay, args.maxBytes);
	if (bytes === null) {
		return Result({ _nay: { message: `GitHub file "${args.path}" is too large` } });
	}

	return Result({ _yay: bytes });
}

// #endregion github import

// #region version registration

export const register_plugin_version = internalAction({
	args: {
		name: doc(app_convex_schema, "plugins_versions").fields.name,
		displayName: doc(app_convex_schema, "plugins_versions").fields.displayName,
		version: doc(app_convex_schema, "plugins_versions").fields.version,
		description: doc(app_convex_schema, "plugins_versions").fields.description,
		reviewStatus: doc(app_convex_schema, "plugins_versions").fields.reviewStatus,
		artifactHash: doc(app_convex_schema, "plugins_versions").fields.artifactHash,
		sourceRepositoryUrl: doc(app_convex_schema, "plugins_versions").fields.sourceRepositoryUrl,
		sourceOwner: doc(app_convex_schema, "plugins_versions").fields.sourceOwner,
		sourceRepo: doc(app_convex_schema, "plugins_versions").fields.sourceRepo,
		sourceCommitSha: doc(app_convex_schema, "plugins_versions").fields.sourceCommitSha,
		manifestR2Key: doc(app_convex_schema, "plugins_versions").fields.manifestR2Key,
		backendEntrypointFile: doc(app_convex_schema, "plugins_versions").fields.backendEntrypointFile,
		events: doc(app_convex_schema, "plugins_versions").fields.events,
		pages: doc(app_convex_schema, "plugins_versions").fields.pages,
		capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
		outboundOrigins: doc(app_convex_schema, "plugins_versions").fields.outboundOrigins,
		files: doc(app_convex_schema, "plugins_versions").fields.files,
		createdBy: doc(app_convex_schema, "plugins_versions").fields.createdBy,
		sourceFiles: v.array(v.object({ path: v.string(), rawText: v.string() })),
	},
	returns: v_result({ _yay: v.object({ pluginVersionId: v.id("plugins_versions") }) }),
	handler: async (ctx, args): Promise<PluginResult<{ pluginVersionId: Id<"plugins_versions"> }>> => {
		const { sourceFiles, ...versionArgs } = args;

		// Upsert the version doc first: its id is the opaque root of the source tree in GLOBAL/PLUGINS.
		const registered = (await ctx.runMutation(internal.plugins.upsert_plugin, versionArgs)) as upsert_plugin_Result;
		if (registered._nay) {
			return Result({ _nay: { message: registered._nay.message } });
		}
		const pluginVersionId = registered._yay.pluginVersionId;

		for (const sourceFile of sourceFiles) {
			// Re-publish of the same (name, version, artifactHash) reuses the version doc, so existing
			// file rows hit the "This file already exists." continue branch and stay shared.
			const created = (await ctx.runAction(internal.files_nodes.create_file_node_internal, {
				workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
				path: `/${pluginVersionId}/${sourceFile.path}`,
				rawText: sourceFile.rawText,
			})) as files_nodes_create_file_node_internal_Result;
			if (created._nay) {
				if (created._nay.message === "This file already exists.") {
					continue;
				}
				await ctx.runMutation(internal.plugins.patch_version_source_status, {
					pluginVersionId,
					sourceStatus: "error",
					sourceLastError: created._nay.message,
				});
				return Result({ _nay: { message: created._nay.message } });
			}
		}

		await ctx.runMutation(internal.plugins.patch_version_source_status, {
			pluginVersionId,
			sourceStatus: "ready",
			sourceLastError: null,
		});

		return Result({ _yay: { pluginVersionId } });
	},
});

type register_plugin_version_Result =
	typeof register_plugin_version extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const upsert_plugin = internalMutation({
	args: {
		name: doc(app_convex_schema, "plugins_versions").fields.name,
		displayName: doc(app_convex_schema, "plugins_versions").fields.displayName,
		version: doc(app_convex_schema, "plugins_versions").fields.version,
		description: doc(app_convex_schema, "plugins_versions").fields.description,
		reviewStatus: doc(app_convex_schema, "plugins_versions").fields.reviewStatus,
		artifactHash: doc(app_convex_schema, "plugins_versions").fields.artifactHash,
		sourceRepositoryUrl: doc(app_convex_schema, "plugins_versions").fields.sourceRepositoryUrl,
		sourceOwner: doc(app_convex_schema, "plugins_versions").fields.sourceOwner,
		sourceRepo: doc(app_convex_schema, "plugins_versions").fields.sourceRepo,
		sourceCommitSha: doc(app_convex_schema, "plugins_versions").fields.sourceCommitSha,
		manifestR2Key: doc(app_convex_schema, "plugins_versions").fields.manifestR2Key,
		backendEntrypointFile: doc(app_convex_schema, "plugins_versions").fields.backendEntrypointFile,
		events: doc(app_convex_schema, "plugins_versions").fields.events,
		pages: doc(app_convex_schema, "plugins_versions").fields.pages,
		capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
		outboundOrigins: doc(app_convex_schema, "plugins_versions").fields.outboundOrigins,
		files: doc(app_convex_schema, "plugins_versions").fields.files,
		createdBy: doc(app_convex_schema, "plugins_versions").fields.createdBy,
	},
	returns: v_result({ _yay: v.object({ pluginVersionId: v.id("plugins_versions") }) }),
	handler: async (ctx, args) => {
		// All four lookups key off args alone, so they batch into one round trip; the guards below
		// still apply in order.
		const [existingNamed, existingSameArtifact, existingVersion, previousLatest] = await Promise.all([
			ctx.db
				.query("plugins_versions")
				.withIndex("by_name", (q) => q.eq("name", args.name))
				.first(),
			ctx.db
				.query("plugins_versions")
				.withIndex("by_name_version_artifactHash", (q) =>
					q.eq("name", args.name).eq("version", args.version).eq("artifactHash", args.artifactHash),
				)
				.first(),
			ctx.db
				.query("plugins_versions")
				.withIndex("by_name_version", (q) => q.eq("name", args.name).eq("version", args.version))
				.first(),
			ctx.db
				.query("plugins_versions")
				.withIndex("by_isLatest_name", (q) => q.eq("isLatest", true).eq("name", args.name))
				.first(),
		]);

		// A plugin name is bound to the user that first published it.
		if (existingNamed && existingNamed.createdBy !== args.createdBy) {
			return Result({ _nay: { message: "Plugin name is already owned by another publisher" } });
		}

		if (existingSameArtifact) {
			// Spreading name/createdBy is a same-value no-op: the index lookup matched name and the
			// ownership guard above matched createdBy.
			await ctx.db.patch("plugins_versions", existingSameArtifact._id, { ...args, updatedAt: Date.now() });
			return Result({ _yay: { pluginVersionId: existingSameArtifact._id } });
		}

		if (existingVersion) {
			return Result({ _nay: { message: "Plugin name and version already exist with a different artifact hash" } });
		}

		// Move the latest-version marker to the new doc: publish order stands in for version
		// order, and the gallery reads latest versions straight off by_isLatest_name.
		if (previousLatest) {
			await ctx.db.patch("plugins_versions", previousLatest._id, { isLatest: false });
		}

		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			...args,
			runtimeVersion: plugins_RUNTIME_VERSION,
			isLatest: true,
			// Source files are written after this insert; register_plugin_version patches the
			// final status, so a crash mid-publish leaves an honest incomplete-snapshot error.
			sourceStatus: "error",
			sourceLastError: "Source snapshot incomplete",
			updatedAt: Date.now(),
		});

		return Result({ _yay: { pluginVersionId } });
	},
});

type upsert_plugin_Result =
	typeof upsert_plugin extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const patch_version_source_status = internalMutation({
	args: {
		pluginVersionId: v.id("plugins_versions"),
		sourceStatus: v.union(v.literal("ready"), v.literal("error")),
		sourceLastError: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { pluginVersionId, ...sourceFields } = args;
		await ctx.db.patch("plugins_versions", pluginVersionId, {
			...sourceFields,
			updatedAt: Date.now(),
		});
		return null;
	},
});

export const get_owned_publisher_repository = internalQuery({
	args: {
		userId: v.id("users"),
		repositoryId: v.id("plugins_publisher_repositories"),
	},
	returns: v_result({
		_yay: v.object({
			userId: v.id("users"),
			owner: v.string(),
			repo: v.string(),
			repositoryUrl: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (repository.ownerUserId !== args.userId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		return Result({
			_yay: {
				userId: args.userId,
				owner: repository.owner,
				repo: repository.repo,
				repositoryUrl: repository.repositoryUrl,
			},
		});
	},
});

type get_owned_publisher_repository_Result =
	typeof get_owned_publisher_repository extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion version registration

// #region ai review

const REVIEW_MODEL_ID = "gpt-5.4-mini" as const satisfies ai_chat_ModelId;

type PluginVersionReviewResult = PluginResult<{
	status: "passed" | "rejected" | "flagged";
	mechanicalFindings: string[];
	aiFindings: string[];
}>;

// Kept as a spy-able object so tests can stub the verdict without mocking OpenAI HTTP responses.
export const plugins_ai_review = {
	generate_verdict: async (args: { prompt: string }) => {
		const result = await generateObject({
			model: openai(REVIEW_MODEL_ID),
			temperature: 0,
			schema: z.object({
				verdict: z.enum(["passed", "rejected", "flagged"]),
				findings: z.array(z.string()),
			}),
			prompt: args.prompt,
		});
		return result.object;
	},
};

function review_prompt(args: {
	distSource: string;
	capabilities: string[];
	outboundOrigins: string[];
	secretNames: string[];
	diff: { baseArtifactHash: string; patch: string } | null;
}) {
	return (
		"You review the backend dist of a workspace plugin before it is registered.\n" +
		"Verdict rules:\n" +
		'- "rejected": the code sends secret values to origins other than the declared outbound origins, ' +
		"writes secret values into file outputs, is obfuscated or dynamically assembled, " +
		"or clearly does something outside its declared capabilities.\n" +
		'- "flagged": suspicious but not clearly malicious — especially module-level mutable state that ' +
		"outlives one run (a module-level cache can be legitimate, but state shared across runs " +
		"deserves a manual look).\n" +
		'- "passed": none of the above. Apply these rules strictly: when no rejected or flagged ' +
		'condition holds, the verdict is "passed" even if findings note secret usage.\n' +
		'"Secret values" means the raw injected values of the secrets listed below — not content derived ' +
		"from user files or model responses. Writing derived content to file outputs is normal: " +
		"writing outputs is intrinsic to a plugin run.\n" +
		"Secrets that hold a host-configured URL or base URL count as declared outbound origins: " +
		"the host enforces a runtime egress allowlist, so requests built from such secrets " +
		"are not exfiltration by themselves.\n" +
		"The secret-names list below may be empty or incomplete: publishers can configure secrets " +
		"after publishing, and reading a name that is not configured simply yields nothing at runtime, " +
		"so secret reads beyond the list are not violations by themselves.\n" +
		"List one finding per concern; findings are shown to the plugin publisher.\n" +
		"\n" +
		`Declared capabilities: ${JSON.stringify(args.capabilities)}\n` +
		`Declared outbound origins: ${JSON.stringify(args.outboundOrigins)}\n` +
		"Secret names the plugin can read at runtime (values are injected by the host): " +
		JSON.stringify(args.secretNames) +
		"\n" +
		(args.diff
			? "\n" +
				`A previous version of this plugin already passed review (artifact ${args.diff.baseArtifactHash}). ` +
				"Focus on the changed lines in this unified diff:\n" +
				args.diff.patch +
				"\n"
			: "") +
		"\n" +
		"Full dist source:\n" +
		args.distSource
	);
}

/**
 * Review-cache lookup: returns the stored AI review verdict for an exact build (the dist/bonobo.plugin.json
 * text hash fingerprints the whole build), or null when this content was never reviewed. Lets a
 * re-publish of identical content reuse the verdict instead of paying for new model calls.
 */
export const get_version_review_by_artifact_json_hash = internalQuery({
	args: { artifactHash: v.string() },
	returns: v.union(doc(app_convex_schema, "plugins_version_reviews"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("plugins_version_reviews")
			.withIndex("by_artifactHash", (q) => q.eq("artifactHash", args.artifactHash))
			.first();
	},
});

type get_version_review_by_artifact_json_hash_Result =
	typeof get_version_review_by_artifact_json_hash extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Gathers the inputs a fresh AI review needs (the review action has no db access): the publisher
 * repository's secret names for the prompt, and the latest passed version's artifact hash + backend
 * entrypoint file R2 key as the diff baseline. Only queried on a review-cache miss.
 */
export const get_ai_review_inputs = internalQuery({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
		pluginName: v.string(),
	},
	returns: v.object({
		secretNames: v.array(v.string()),
		previousPassed: v.union(
			v.object({
				artifactHash: doc(app_convex_schema, "plugins_versions").fields.artifactHash,
				backendEntrypointFileR2Key: v.union(v.string(), v.null()),
			}),
			v.null(),
		),
	}),
	handler: async (ctx, args) => {
		const [secrets, previousPassed] = await Promise.all([
			// by_repository_name already yields the secrets ordered by name, keeping the prompt deterministic.
			ctx.db
				.query("plugins_publisher_repository_secrets")
				.withIndex("by_repository_name", (q) => q.eq("repositoryId", args.repositoryId))
				.collect(),
			// by_name ends with _creationTime, so desc = newest publish first; publish order stands in for version order.
			ctx.db
				.query("plugins_versions")
				.withIndex("by_name", (q) => q.eq("name", args.pluginName))
				.order("desc")
				.filter((q) => q.eq(q.field("reviewStatus"), "passed"))
				.first(),
		]);

		return {
			secretNames: secrets.map((secret) => secret.name),
			previousPassed: previousPassed
				? {
						artifactHash: previousPassed.artifactHash,
						backendEntrypointFileR2Key: previousPassed.backendEntrypointFile?.r2Key ?? null,
					}
				: null,
		};
	},
});

type get_ai_review_inputs_Result =
	typeof get_ai_review_inputs extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Verdicts are unique per artifact hash: a fresh verdict overwrites any existing doc. The
 * overwrite is load-bearing — cached rejections are never reused, so a re-review after a
 * rejection must replace the old verdict, and updatedAt is the verdict's time, not the doc's.
 */
export const upsert_version_review = internalMutation({
	args: {
		createdBy: doc(app_convex_schema, "plugins_version_reviews").fields.createdBy,
		artifactHash: doc(app_convex_schema, "plugins_version_reviews").fields.artifactHash,
		pluginName: doc(app_convex_schema, "plugins_version_reviews").fields.pluginName,
		version: doc(app_convex_schema, "plugins_version_reviews").fields.version,
		status: doc(app_convex_schema, "plugins_version_reviews").fields.status,
		mechanicalFindings: doc(app_convex_schema, "plugins_version_reviews").fields.mechanicalFindings,
		aiFindings: doc(app_convex_schema, "plugins_version_reviews").fields.aiFindings,
		model: doc(app_convex_schema, "plugins_version_reviews").fields.model,
		diffBaseArtifactHash: doc(app_convex_schema, "plugins_version_reviews").fields.diffBaseArtifactHash,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("plugins_version_reviews")
			.withIndex("by_artifactHash", (q) => q.eq("artifactHash", args.artifactHash))
			.first();
		const review = { ...args, updatedAt: Date.now() };

		if (existing) {
			await ctx.db.patch("plugins_version_reviews", existing._id, review);
			return null;
		}

		await ctx.db.insert("plugins_version_reviews", review);

		return null;
	},
});

/**
 * Runs the pre-registration security review of a version's backend dist against its declared
 * capabilities and origins, and persists the verdict. Cheap outcomes short-circuit in order:
 * cached passed/flagged verdict for the same dist/bonobo.plugin.json hash (rejections re-review), no
 * backend dist (auto-pass), mechanical findings (reject). Only then does the single system-billed,
 * per-user rate-limited AI review run, diffed against the latest passed version when one exists.
 */
export const run_version_review = internalAction({
	args: {
		pluginName: v.string(),
		version: v.string(),
		artifactHash: v.string(),
		/** Backend dist source, or null when the artifact ships no backend. */
		distSource: v.union(v.string(), v.null()),
		capabilities: v.array(v.string()),
		outboundOrigins: v.array(v.string()),
		/** Publishing repository claim; its secrets are the names the reviewed code can read at runtime. */
		repositoryId: v.id("plugins_publisher_repositories"),
		/** Publishing user requesting the review; owns the reviews, and fresh system-billed AI reviews are rate limited per this user. */
		requestedBy: v.id("users"),
	},
	returns: v_result({
		_yay: v.object({
			status: doc(app_convex_schema, "plugins_version_reviews").fields.status,
			mechanicalFindings: v.array(v.string()),
			aiFindings: v.array(v.string()),
		}),
	}),
	handler: async (ctx, args): Promise<PluginVersionReviewResult> => {
		const cached = (await ctx.runQuery(internal.plugins.get_version_review_by_artifact_json_hash, {
			artifactHash: args.artifactHash,
		})) as get_version_review_by_artifact_json_hash_Result;
		// Reuse only passed/flagged verdicts: a cached rejection can be model flakiness and must not
		// permanently block this artifact, so re-review it (the per-user fresh-review rate limit bounds
		// the cost) and let upsert_version_review overwrite the old doc with the new verdict.
		if (cached && cached.status !== "rejected") {
			return Result({
				_yay: { status: cached.status, mechanicalFindings: cached.mechanicalFindings, aiFindings: cached.aiFindings },
			});
		}

		if (args.distSource === null) {
			// Nothing runs server-side without a backend dist; there is no code to review.
			await ctx.runMutation(internal.plugins.upsert_version_review, {
				createdBy: args.requestedBy,
				artifactHash: args.artifactHash,
				pluginName: args.pluginName,
				version: args.version,
				status: "passed",
				mechanicalFindings: [],
				aiFindings: [],
				model: "none",
			});
			return Result({ _yay: { status: "passed", mechanicalFindings: [] as string[], aiFindings: [] as string[] } });
		}

		// The static dist scan rejects deterministically before any model call is spent.
		const mechanicalFindings = plugins_dist_review_mechanical_findings(args.distSource);
		if (mechanicalFindings.length > 0) {
			await ctx.runMutation(internal.plugins.upsert_version_review, {
				createdBy: args.requestedBy,
				artifactHash: args.artifactHash,
				pluginName: args.pluginName,
				version: args.version,
				status: "rejected",
				mechanicalFindings,
				aiFindings: [],
				model: "none",
			});
			return Result({ _yay: { status: "rejected", mechanicalFindings, aiFindings: [] as string[] } });
		}

		// Only fresh verdicts cost a system-billed model call; cached hashes returned above stay free.
		// The inputs read is independent of the rate-limit consume, so both run in one round trip.
		const [rateLimit, context] = await Promise.all([
			rate_limiter_limit_by_key(ctx, { name: "plugins_publish_review", key: args.requestedBy }),
			ctx.runQuery(internal.plugins.get_ai_review_inputs, {
				repositoryId: args.repositoryId,
				pluginName: args.pluginName,
			}) as Promise<get_ai_review_inputs_Result>,
		]);
		if (rateLimit) {
			return Result({
				_nay: {
					message: `Plugin AI review rate limit exceeded; try again in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s`,
				},
			});
		}

		// Diff against the latest passed version's backend entrypoint dist from R2 so the model can focus on the changed lines.
		let diff: { baseArtifactHash: string; patch: string } | null = null;
		if (context.previousPassed?.backendEntrypointFileR2Key) {
			const previousBackendEntrypointDist = await r2_fetch_object_from_bucket({
				key: context.previousPassed.backendEntrypointFileR2Key,
			});
			diff = {
				baseArtifactHash: context.previousPassed.artifactHash,
				patch: createPatch("dist.js", await previousBackendEntrypointDist.text(), args.distSource),
			};
		}

		const prompt = review_prompt({
			distSource: args.distSource,
			capabilities: args.capabilities,
			outboundOrigins: args.outboundOrigins,
			secretNames: context.secretNames,
			diff,
		});

		let verdict: Awaited<ReturnType<typeof plugins_ai_review.generate_verdict>>;
		try {
			verdict = await plugins_ai_review.generate_verdict({ prompt });
		} catch (error) {
			console.error("Plugin AI review failed", { artifactHash: args.artifactHash, error });
			return Result({ _nay: { message: "Plugin AI review is unavailable; the version was not registered" } });
		}

		// Persist the fresh verdict keyed by the dist/bonobo.plugin.json hash so identical re-publishes hit the cache.
		await ctx.runMutation(internal.plugins.upsert_version_review, {
			createdBy: args.requestedBy,
			artifactHash: args.artifactHash,
			pluginName: args.pluginName,
			version: args.version,
			status: verdict.verdict,
			mechanicalFindings: [],
			aiFindings: verdict.findings,
			model: REVIEW_MODEL_ID,
			diffBaseArtifactHash: diff?.baseArtifactHash,
		});
		return Result({
			_yay: { status: verdict.verdict, mechanicalFindings: [] as string[], aiFindings: verdict.findings },
		});
	},
});

type run_version_review_Result =
	typeof run_version_review extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion ai review

// #region publishing

const text_decoder = new TextDecoder();

function r2_key(args: { name: string; version: string; commitSha: string; path: string }) {
	return `plugins/${args.name}/${args.version}/${args.commitSha}/${args.path}`;
}

/**
 * Records the outcome of a publish attempt on the repository claim so publishers get durable
 * feedback that outlives the publish toast. Stamps `at` with the current time; no-ops when the
 * claim was deleted while the publish was in flight.
 */
export const update_last_publish_attempt = internalMutation({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
		status: doc(app_convex_schema, "plugins_publisher_repositories").fields.lastPublishAttempt.fields.status,
		message: doc(app_convex_schema, "plugins_publisher_repositories").fields.lastPublishAttempt.fields.message,
		commitSha: doc(app_convex_schema, "plugins_publisher_repositories").fields.lastPublishAttempt.fields.commitSha,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { repositoryId, ...attempt } = args;
		const repository = await ctx.db.get("plugins_publisher_repositories", repositoryId);
		// remove_repository can delete the claim while a publish is still in flight; nothing to record then.
		if (!repository) {
			return null;
		}
		await ctx.db.patch("plugins_publisher_repositories", repositoryId, {
			lastPublishAttempt: { ...attempt, at: Date.now() },
		});
		return null;
	},
});

/**
 * Deletes the bucket files left behind by a publish that never registered its version. It only
 * runs after the grace deadline. If a matching version did get registered, the keys that version
 * owns are live files and are skipped; everything else gets deleted, at most
 * PUBLISH_CLEANUP_KEYS_PER_RUN keys per run, rescheduling itself until none are left. If a delete
 * fails, the current batch is kept and retried later.
 */
export const run_publish_artifact_cleanup_attempt = internalMutation({
	args: {
		attemptId: v.id("plugins_publish_artifact_cleanup_attempts"),
	},
	returns: v.object({ done: v.boolean(), deletedCount: v.number() }),
	handler: async (ctx, args) => {
		const attempt = await ctx.db.get("plugins_publish_artifact_cleanup_attempts", args.attemptId);
		// A concurrent run or the registration path can remove the attempt first.
		if (!attempt) {
			return { done: true, deletedCount: 0 };
		}

		// Too early: the grace period gives a concurrent publish of the same artifact time to finish.
		// The cron fallback picks this attempt up again after the deadline.
		if (attempt.cleanupAt > Date.now()) {
			return { done: false, deletedCount: 0 };
		}

		const registeredVersion = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name_version_artifactHash", (q) =>
				q.eq("name", attempt.pluginName).eq("version", attempt.version).eq("artifactHash", attempt.artifactHash),
			)
			.first();
		const ownedKeys = registeredVersion ? version_r2_keys(registeredVersion) : new Set<string>();
		const unownedKeys = attempt.r2Keys.filter((r2Key) => !ownedKeys.has(r2Key));
		if (unownedKeys.length === 0) {
			// Every remaining key belongs to the registered version: a publish of the same artifact
			// completed, so the files are live and there is nothing to delete.
			await ctx.db.delete("plugins_publish_artifact_cleanup_attempts", attempt._id);
			return { done: true, deletedCount: 0 };
		}

		const batch = unownedKeys.slice(0, PUBLISH_CLEANUP_KEYS_PER_RUN);
		try {
			for (const r2Key of batch) {
				await r2_delete_object(ctx, r2Key);
			}
		} catch (error) {
			// Keep the whole batch and retry later; deleting an already-deleted key again is harmless.
			console.error("Publish artifact cleanup failed; retrying", { attemptId: attempt._id, error });
			await ctx.scheduler.runAfter(PUBLISH_CLEANUP_RETRY_MS, internal.plugins.run_publish_artifact_cleanup_attempt, {
				attemptId: attempt._id,
			});
			return { done: false, deletedCount: 0 };
		}

		// Owned keys are dropped from the list too, on purpose: they are live files that must never be deleted.
		const remainingKeys = unownedKeys.slice(batch.length);
		if (remainingKeys.length > 0) {
			await ctx.db.patch("plugins_publish_artifact_cleanup_attempts", attempt._id, {
				r2Keys: remainingKeys,
				updatedAt: Date.now(),
			});
			await ctx.scheduler.runAfter(0, internal.plugins.run_publish_artifact_cleanup_attempt, {
				attemptId: attempt._id,
			});
			return { done: false, deletedCount: batch.length };
		}

		await ctx.db.delete("plugins_publish_artifact_cleanup_attempts", attempt._id);
		return { done: true, deletedCount: batch.length };
	},
});

/**
 * A publish first uploads its files to the bucket, then registers the version. If it crashes in
 * between, those files would sit in the bucket forever. So before uploading, the publish records
 * here the keys it is about to write and schedules a cleanup run for them. When the publish
 * succeeds, remove_publish_artifact_cleanup_attempt cancels the cleanup.
 */
export const create_publish_artifact_cleanup_attempt = internalMutation({
	args: {
		repositoryId: doc(app_convex_schema, "plugins_publish_artifact_cleanup_attempts").fields.repositoryId,
		pluginName: doc(app_convex_schema, "plugins_publish_artifact_cleanup_attempts").fields.pluginName,
		version: doc(app_convex_schema, "plugins_publish_artifact_cleanup_attempts").fields.version,
		artifactHash: doc(app_convex_schema, "plugins_publish_artifact_cleanup_attempts").fields.artifactHash,
		r2Keys: doc(app_convex_schema, "plugins_publish_artifact_cleanup_attempts").fields.r2Keys,
	},
	returns: v.id("plugins_publish_artifact_cleanup_attempts"),
	handler: async (ctx, args) => {
		// Insert and schedule in one transaction so the cleanup run exists before the first upload.
		const now = Date.now();
		const attemptId = await ctx.db.insert("plugins_publish_artifact_cleanup_attempts", {
			...args,
			cleanupAt: now + PUBLISH_CLEANUP_GRACE_MS,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(PUBLISH_CLEANUP_GRACE_MS, internal.plugins.run_publish_artifact_cleanup_attempt, {
			attemptId,
		});
		return attemptId;
	},
});

type create_publish_artifact_cleanup_attempt_Result =
	typeof create_publish_artifact_cleanup_attempt extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Called after a publish registers its version: its objects are live now, so the cleanup attempt
 * is no longer needed. Deletes the attempt only when the registered version owns every key in it;
 * if the keys differ (a concurrent publish registered from a different commit), the attempt stays
 * so its objects still get cleaned up.
 */
export const remove_publish_artifact_cleanup_attempt = internalMutation({
	args: {
		attemptId: v.id("plugins_publish_artifact_cleanup_attempts"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const attempt = await ctx.db.get("plugins_publish_artifact_cleanup_attempts", args.attemptId);
		if (!attempt) {
			return null;
		}
		const registeredVersion = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name_version_artifactHash", (q) =>
				q.eq("name", attempt.pluginName).eq("version", attempt.version).eq("artifactHash", attempt.artifactHash),
			)
			.first();
		if (!registeredVersion) {
			return null;
		}
		const ownedKeys = version_r2_keys(registeredVersion);
		if (attempt.r2Keys.every((r2Key) => ownedKeys.has(r2Key))) {
			await ctx.db.delete("plugins_publish_artifact_cleanup_attempts", attempt._id);
		}
		return null;
	},
});

/**
 * Cron fallback. Each attempt normally cleans up through the run scheduled when it was created;
 * this catches attempts whose scheduled run never happened (crash, failed retry). Schedules at
 * most PUBLISH_CLEANUP_CRON_BATCH_SIZE attempts per pass.
 */
export const schedule_due_publish_artifact_cleanup_attempts = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const due = await ctx.db
			.query("plugins_publish_artifact_cleanup_attempts")
			.withIndex("by_cleanupAt", (q) => q.lte("cleanupAt", Date.now()))
			.take(PUBLISH_CLEANUP_CRON_BATCH_SIZE);
		for (const attempt of due) {
			await ctx.scheduler.runAfter(0, internal.plugins.run_publish_artifact_cleanup_attempt, {
				attemptId: attempt._id,
			});
		}
		return null;
	},
});

async function publish_version_from_github(
	ctx: ActionCtx,
	args: {
		repositoryId: Id<"plugins_publisher_repositories">;
		source: NonNullable<get_owned_publisher_repository_Result["_yay"]>;
	},
) {
	const source = args.source;

	// Publishing always builds from the default-branch HEAD; every GitHub fetch below is pinned to that commit.
	const head = await github_fetch_repo_head({ owner: source.owner, repo: source.repo });
	if (head._nay) {
		return Result({ _nay: { message: head._nay.message } });
	}

	const sourceCommitSha = head._yay.commitSha;

	// dist/bonobo.plugin.json declares the plugin identity and describes the build output (backend,
	// shipped files); it is the single file the publish reads besides what it lists.
	const manifestText = await fetch_github_text({
		owner: source.owner,
		repo: source.repo,
		commitSha: sourceCommitSha,
		path: "dist/bonobo.plugin.json",
	});
	if (manifestText._nay) {
		return Result({ _nay: { message: manifestText._nay.message } });
	}
	let manifestJson: unknown;
	try {
		manifestJson = JSON.parse(manifestText._yay);
	} catch {
		return Result({ _nay: { message: "Plugin manifest is invalid JSON" } });
	}
	const manifest = plugins_validate_manifest(manifestJson);
	if (manifest._nay) {
		return Result({ _nay: { message: manifest._nay.message } });
	}

	// The dist/bonobo.plugin.json text fingerprints the release: the review cache and the registered version key off this hash.
	const artifactHash = `sha256:${await crypto_sha256_hex(manifestText._yay)}`;
	const manifestR2Key = r2_key({
		name: manifest._yay.name,
		version: manifest._yay.version,
		commitSha: sourceCommitSha,
		path: "dist/bonobo.plugin.json",
	});

	// Download each build file dist/bonobo.plugin.json lists (backend dist, assets), verify its
	// pinned hash and byte size, and stage it for upload. At most ARTIFACT_DOWNLOAD_CONCURRENCY
	// downloads run at once, each streamed read stops at the declared file size, and a running
	// total caps the whole artifact.
	const files: Array<{
		path: string;
		sha256: string;
		bytes: number;
		contentType: string;
		r2Key: string;
		body: ArrayBuffer;
	}> = [];
	let downloadFailure: { message: string } | undefined;
	{
		let nextFileIndex = 0;
		let downloadedArtifactBytes = 0;
		await Promise.all(
			Array.from({ length: ARTIFACT_DOWNLOAD_CONCURRENCY }, async () => {
				for (;;) {
					const fileIndex = nextFileIndex;
					nextFileIndex += 1;
					const file = manifest._yay.files.at(fileIndex);
					if (!file || downloadFailure) {
						return;
					}
					const fileBytes = await fetch_github_bytes({
						owner: source.owner,
						repo: source.repo,
						commitSha: sourceCommitSha,
						path: file.path,
						maxBytes: file.bytes,
					});
					if (fileBytes._nay) {
						downloadFailure ??= fileBytes._nay;
						return;
					}
					downloadedArtifactBytes += fileBytes._yay.byteLength;
					if (downloadedArtifactBytes > plugins_MAX_ARTIFACT_BYTES) {
						downloadFailure ??= { message: "Plugin artifact files exceed the 16 MiB size limit" };
						return;
					}
					const fileHash = `sha256:${await crypto_sha256_hex(fileBytes._yay)}`;
					if (fileHash !== file.sha256) {
						downloadFailure ??= { message: `Artifact file hash mismatch for "${file.path}"` };
						return;
					}
					if (fileBytes._yay.byteLength !== file.bytes) {
						downloadFailure ??= { message: `Artifact file byte size mismatch for "${file.path}"` };
						return;
					}
					files[fileIndex] = {
						...file,
						r2Key: r2_key({
							name: manifest._yay.name,
							version: manifest._yay.version,
							commitSha: sourceCommitSha,
							path: file.path,
						}),
						body: fileBytes._yay,
					};
				}
			}),
		);
	}
	if (downloadFailure) {
		return Result({ _nay: { message: downloadFailure.message } });
	}

	// The manifest backend entry must resolve to one listed dist file; that file's source is what the review reads.
	const backendEntrypoint = manifest._yay.backend;
	let backendEntrypointFile: (NonNullable<typeof manifest._yay.backend> & { r2Key: string; sha256: string }) | null =
		null;
	let backendEntrypointDistSource: string | null = null;
	if (backendEntrypoint) {
		const backendEntrypointListedFile = files.find((file) => file.path === backendEntrypoint.entry);
		if (!backendEntrypointListedFile) {
			return Result({ _nay: { message: "Plugin backend entrypoint file is missing from artifact files" } });
		}
		backendEntrypointFile = {
			...backendEntrypoint,
			r2Key: backendEntrypointListedFile.r2Key,
			sha256: backendEntrypointListedFile.sha256,
		};
		backendEntrypointDistSource = text_decoder.decode(backendEntrypointListedFile.body);
	}

	// Review the dist before anything is uploaded or registered; "rejected" blocks the publish.
	const review = (await ctx.runAction(internal.plugins.run_version_review, {
		pluginName: manifest._yay.name,
		version: manifest._yay.version,
		artifactHash,
		distSource: backendEntrypointDistSource,
		capabilities: manifest._yay.capabilities,
		outboundOrigins: manifest._yay.outboundOrigins,
		repositoryId: args.repositoryId,
		requestedBy: source.userId,
	})) as run_version_review_Result;
	if (review._nay) {
		return Result({ _nay: { message: review._nay.message } });
	}
	if (review._yay.status === "rejected") {
		const reasons = [...review._yay.mechanicalFindings, ...review._yay.aiFindings];
		// The name tags this exit so publish_version records the attempt as "rejected", not "failed".
		return Result({
			_nay: { name: "review_rejected", message: `Plugin review rejected this version: ${reasons.join(" | ")}` },
		});
	}

	// The browsable source mount is the dist snapshot itself: the manifest plus every text build
	// file already downloaded above. Binary dist assets are uploaded and served but not mounted.
	const sourceFiles: Array<{ path: string; rawText: string }> = [
		{ path: "dist/bonobo.plugin.json", rawText: manifestText._yay },
	];
	for (const file of files) {
		if (
			file.contentType.startsWith("text/") ||
			file.contentType === "application/javascript" ||
			file.contentType === "application/json"
		) {
			sourceFiles.push({ path: file.path, rawText: text_decoder.decode(file.body) });
		}
	}

	// The snapshot is passed as arguments to the registration action; cap the total so the
	// payload stays within Convex argument limits.
	let sourceFilesBytes = 0;
	for (const sourceFile of sourceFiles) {
		sourceFilesBytes += files_get_utf8_byte_size(sourceFile.rawText);
	}
	if (sourceFilesBytes > files_MAX_TEXT_CONTENT_BYTES) {
		return Result({ _nay: { message: "Plugin source snapshot is too large" } });
	}

	// If the publish crashes between the uploads below and registration, the uploaded files must
	// not stay in the bucket forever. So before the first upload, one mutation records the exact
	// keys and schedules their cleanup. A failed publish leaves the record until the grace
	// deadline instead of cleaning up right away, so a concurrent publish of the same artifact
	// that reuses the same keys does not have its files deleted mid-upload.
	const cleanupAttemptId = (await ctx.runMutation(internal.plugins.create_publish_artifact_cleanup_attempt, {
		repositoryId: args.repositoryId,
		pluginName: manifest._yay.name,
		version: manifest._yay.version,
		artifactHash,
		r2Keys: [manifestR2Key, ...files.map((file) => file.r2Key)],
	})) as create_publish_artifact_cleanup_attempt_Result;

	// The review allowed the publish: upload dist/bonobo.plugin.json and the build files to R2,
	// with at most ARTIFACT_UPLOAD_CONCURRENCY uploads running at once.
	const uploads: Array<{ key: string; body: BodyInit; contentType: string }> = [
		{ key: manifestR2Key, body: manifestText._yay, contentType: "application/json" },
		...files.map((file) => ({ key: file.r2Key, body: file.body, contentType: file.contentType })),
	];
	{
		let nextUploadIndex = 0;
		await Promise.all(
			Array.from({ length: ARTIFACT_UPLOAD_CONCURRENCY }, async () => {
				for (;;) {
					const upload = uploads.at(nextUploadIndex);
					nextUploadIndex += 1;
					if (!upload) {
						return;
					}
					await r2_put_object(ctx, upload);
				}
			}),
		);
	}

	// Registration writes the version docs and the source snapshot tree, making the version visible.
	const registered = (await ctx.runAction(internal.plugins.register_plugin_version, {
		name: manifest._yay.name,
		displayName: manifest._yay.displayName,
		version: manifest._yay.version,
		description: manifest._yay.description,
		reviewStatus: review._yay.status,
		artifactHash,
		sourceRepositoryUrl: source.repositoryUrl,
		sourceOwner: source.owner,
		sourceRepo: source.repo,
		sourceCommitSha,
		manifestR2Key,
		backendEntrypointFile,
		events: manifest._yay.events,
		pages: (manifest._yay.pages ?? []).map((page) => ({
			id: page.id,
			title: page.title,
			entry: page.entry,
			navItem: page.navItem ? { label: page.navItem.label, icon: page.navItem.icon ?? null } : null,
		})),
		capabilities: manifest._yay.capabilities,
		outboundOrigins: manifest._yay.outboundOrigins,
		files: files.map((file) => omit(file, ["body"])),
		createdBy: source.userId,
		sourceFiles,
	})) as register_plugin_version_Result;
	if (registered._nay) {
		return Result({ _nay: { message: registered._nay.message } });
	}

	// The registered version owns the exact keys now, so the cleanup attempt has nothing left to do.
	await ctx.runMutation(internal.plugins.remove_publish_artifact_cleanup_attempt, {
		attemptId: cleanupAttemptId,
	});

	return Result({
		_yay: {
			pluginVersionId: registered._yay.pluginVersionId,
			sourceCommitSha,
		},
	});
}

export const publish_version = action({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
	},
	returns: v_result({
		_yay: v.object({
			pluginVersionId: v.id("plugins_versions"),
			sourceCommitSha: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "Sign in to publish plugins" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = (await ctx.runQuery(internal.plugins.get_owned_publisher_repository, {
			userId: userAuth.id,
			repositoryId: args.repositoryId,
		})) as get_owned_publisher_repository_Result;
		if (authorized._nay) {
			return Result({ _nay: { message: authorized._nay.message } });
		}

		let published: Awaited<ReturnType<typeof publish_version_from_github>>;
		try {
			published = await publish_version_from_github(ctx, {
				repositoryId: args.repositoryId,
				source: authorized._yay,
			});
		} catch (error) {
			published = Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		// Publish feedback must outlive the ~4s toast (a first-publish rejection has no plugin page
		// yet), so record every post-authorization outcome on the claim.
		await ctx.runMutation(internal.plugins.update_last_publish_attempt, {
			repositoryId: args.repositoryId,
			...(published._nay
				? {
						status: published._nay.name === "review_rejected" ? ("rejected" as const) : ("failed" as const),
						message: published._nay.message,
						commitSha: null,
					}
				: {
						status: "succeeded" as const,
						message: `Published commit ${published._yay.sourceCommitSha.slice(0, 8)}`,
						commitSha: published._yay.sourceCommitSha,
					}),
		});
		return published;
	},
});

// #endregion publishing

// #region publisher repositories and secrets

export const list_user_published_repositories = query({
	args: {},
	returns: v.array(
		v.object({
			repository: doc(app_convex_schema, "plugins_publisher_repositories"),
			latestVersion: v.union(
				v.object({
					name: doc(app_convex_schema, "plugins_versions").fields.name,
					displayName: doc(app_convex_schema, "plugins_versions").fields.displayName,
					description: doc(app_convex_schema, "plugins_versions").fields.description,
					version: doc(app_convex_schema, "plugins_versions").fields.version,
					reviewStatus: doc(app_convex_schema, "plugins_versions").fields.reviewStatus,
				}),
				v.null(),
			),
		}),
	),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return [];
		}

		// The by_ownerUser_repositoryUrl index already yields the claims in repository URL order.
		const repositories = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_ownerUser_repositoryUrl", (q) => q.eq("ownerUserId", userAuth.id))
			.collect();
		const docs = await Promise.all(
			repositories.map(async (repository) => {
				// Publish order stands in for version order: the newest-created version is the latest.
				const latest = await ctx.db
					.query("plugins_versions")
					.withIndex("by_sourceRepositoryUrl", (q) => q.eq("sourceRepositoryUrl", repository.repositoryUrl))
					.order("desc")
					.first();
				return {
					repository,
					latestVersion: latest
						? {
								name: latest.name,
								displayName: latest.displayName,
								description: latest.description,
								version: latest.version,
								reviewStatus: latest.reviewStatus,
							}
						: null,
				};
			}),
		);
		return docs;
	},
});

export const claim_repository = mutation({
	args: {
		repositoryUrl: v.string(),
	},
	returns: v_result({
		_yay: v.object({ repositoryId: v.id("plugins_publisher_repositories"), repositoryUrl: v.string() }),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "Sign in to publish plugins" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const repository = plugins_parse_github_repository_url(args.repositoryUrl);
		if (repository._nay) {
			return Result({ _nay: { message: repository._nay.message } });
		}

		const claimed = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_repositoryUrl", (q) => q.eq("repositoryUrl", repository._yay.repositoryUrl))
			.first();
		if (claimed) {
			if (claimed.ownerUserId === userAuth.id) {
				return Result({ _yay: { repositoryId: claimed._id, repositoryUrl: claimed.repositoryUrl } });
			}
			return Result({ _nay: { message: "Repository is already claimed by another user" } });
		}

		const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
			ownerUserId: userAuth.id,
			repositoryUrl: repository._yay.repositoryUrl,
			owner: repository._yay.owner,
			repo: repository._yay.repo,
		});
		return Result({ _yay: { repositoryId, repositoryUrl: repository._yay.repositoryUrl } });
	},
});

export const remove_repository = mutation({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "Sign in to publish plugins" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (repository.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// Secrets belong to the claim; removing the claim removes them.
		const secrets = await ctx.db
			.query("plugins_publisher_repository_secrets")
			.withIndex("by_repository_name", (q) => q.eq("repositoryId", args.repositoryId))
			.collect();
		await Promise.all([
			...secrets.map((secret) => ctx.db.delete("plugins_publisher_repository_secrets", secret._id)),
			ctx.db.delete("plugins_publisher_repositories", args.repositoryId),
		]);

		return Result({ _yay: null });
	},
});

export const get_publisher_plugin = query({
	args: {
		pluginName: v.string(),
	},
	returns: v.union(
		v.object({
			repository: doc(app_convex_schema, "plugins_publisher_repositories"),
			versions: v.array(doc(app_convex_schema, "plugins_versions")),
			reviews: v.array(doc(app_convex_schema, "plugins_version_reviews")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return null;
		}

		// The reviews read is keyed on the caller and plugin name only, so it does not have to wait
		// for the versions; the repository gate below does (it needs the latest version's repo URL).
		const [versions, reviews] = await Promise.all([
			ctx.db
				.query("plugins_versions")
				.withIndex("by_name", (q) => q.eq("name", args.pluginName))
				.order("desc")
				.collect(),
			ctx.db
				.query("plugins_version_reviews")
				.withIndex("by_createdBy_pluginName", (q) => q.eq("createdBy", userAuth.id).eq("pluginName", args.pluginName))
				.order("desc")
				.collect(),
		]);
		// Publish order stands in for version order: the newest-created version is the latest.
		const latest = versions.at(0);
		if (!latest) {
			return null;
		}

		// The publisher panel is gated on owning the claim behind the latest version's repository.
		const repository = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_repositoryUrl", (q) => q.eq("repositoryUrl", latest.sourceRepositoryUrl))
			.first();
		if (!repository || repository.ownerUserId !== userAuth.id) {
			return null;
		}

		return { repository, versions, reviews };
	},
});

export const list_publisher_repository_secrets = query({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_publisher_repository_secrets"),
			name: doc(app_convex_schema, "plugins_publisher_repository_secrets").fields.name,
			valuePreview: doc(app_convex_schema, "plugins_publisher_repository_secrets").fields.valuePreview,
			updatedAt: doc(app_convex_schema, "plugins_publisher_repository_secrets").fields.updatedAt,
			lastUsedAt: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return [];
		}
		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository || repository.ownerUserId !== userAuth.id) {
			return [];
		}

		// The by_repository_name index already yields the secrets in name order.
		const secrets = await ctx.db
			.query("plugins_publisher_repository_secrets")
			.withIndex("by_repository_name", (q) => q.eq("repositoryId", args.repositoryId))
			.collect();

		return secrets.map((secret) => ({
			_id: secret._id,
			name: secret.name,
			valuePreview: secret.valuePreview,
			updatedAt: secret.updatedAt,
			lastUsedAt: secret.lastUsedAt ?? null,
		}));
	},
});

async function db_upsert_publisher_repository_secret(
	ctx: MutationCtx,
	args: {
		repository: Doc<"plugins_publisher_repositories">;
		name: string;
		value: string;
		now: number;
	},
) {
	const encrypted = await crypto_encrypt_secret_value(args.value, `${args.repository.ownerUserId}:${args.name}`);
	const existing = await ctx.db
		.query("plugins_publisher_repository_secrets")
		.withIndex("by_repository_name", (q) => q.eq("repositoryId", args.repository._id).eq("name", args.name))
		.first();

	if (existing) {
		await ctx.db.patch("plugins_publisher_repository_secrets", existing._id, {
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			valuePreview: "configured",
			updatedAt: args.now,
		});

		return existing._id;
	}

	return await ctx.db.insert("plugins_publisher_repository_secrets", {
		ownerUserId: args.repository.ownerUserId,
		repositoryId: args.repository._id,
		name: args.name,
		ciphertext: encrypted.ciphertext,
		nonce: encrypted.nonce,
		valuePreview: "configured",
		updatedAt: args.now,
	});
}

export const upsert_publisher_repository_secret = mutation({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
		name: v.string(),
		value: v.string(),
	},
	returns: v_result({ _yay: v.object({ secretId: v.id("plugins_publisher_repository_secrets") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "Sign in to publish plugins" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const name = plugins_validate_secret_name(args.name);
		if (name._nay) {
			return name;
		}

		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (repository.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		let secretId: Id<"plugins_publisher_repository_secrets">;
		try {
			secretId = await db_upsert_publisher_repository_secret(ctx, {
				repository,
				name: name._yay,
				value: args.value,
				now: Date.now(),
			});
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { secretId } });
	},
});

export const upsert_publisher_repository_secrets = mutation({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
		secrets: v.array(v.object({ name: v.string(), value: v.string() })),
	},
	returns: v_result({ _yay: v.object({ count: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "Sign in to publish plugins" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		if (args.secrets.length === 0 || args.secrets.length > PLUGIN_SECRETS_MAX_BATCH_SIZE) {
			return Result({ _nay: { message: "Secret batch size is invalid" } });
		}

		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (repository.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// Dedupe by name (last one wins) so the parallel upserts below never race on the same doc.
		const secrets = new Map<string, string>();
		for (const input of args.secrets) {
			const name = plugins_validate_secret_name(input.name);
			if (name._nay) {
				return name;
			}

			secrets.set(name._yay, input.value);
		}

		const now = Date.now();
		try {
			await Promise.all(
				[...secrets].map(([name, value]) =>
					db_upsert_publisher_repository_secret(ctx, {
						repository,
						name,
						value,
						now,
					}),
				),
			);
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { count: secrets.size } });
	},
});

export const delete_publisher_repository_secret = mutation({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
		name: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "Sign in to publish plugins" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (repository.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const existing = await ctx.db
			.query("plugins_publisher_repository_secrets")
			.withIndex("by_repository_name", (q) => q.eq("repositoryId", args.repositoryId).eq("name", args.name))
			.first();
		if (existing) {
			await ctx.db.delete("plugins_publisher_repository_secrets", existing._id);
		}
		return Result({ _yay: null });
	},
});

// #endregion publisher repositories and secrets

// #region installations and marketplace

export const install_version = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginVersionId: v.id("plugins_versions"),
		acceptedCapabilities: doc(app_convex_schema, "plugins_workspace_installations").fields.acceptedCapabilities,
		acceptedOutboundOrigins: doc(app_convex_schema, "plugins_workspace_installations").fields.acceptedOutboundOrigins,
	},
	returns: v_result({
		_yay: v.object({ installationId: v.id("plugins_workspace_installations") }),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return authorization;
		}
		const installationScope = {
			userId: userAuth.id,
			organizationId: authorization._yay.membership.organizationId,
			workspaceId: authorization._yay.membership.workspaceId,
		};

		const pluginVersion = await ctx.db.get("plugins_versions", args.pluginVersionId);
		if (!pluginVersion) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (pluginVersion.reviewStatus === "rejected" || pluginVersion.reviewStatus === "flagged") {
			return Result({ _nay: { message: "Plugin version failed review and cannot be installed" } });
		}

		// Consent must exactly cover what the version declares; anything else is a stale or partial consent screen.
		const acceptedCapabilities = new Set(args.acceptedCapabilities);
		if (
			pluginVersion.capabilities.length !== acceptedCapabilities.size ||
			pluginVersion.capabilities.some((capability) => !acceptedCapabilities.has(capability))
		) {
			return Result({ _nay: { message: "Install must accept exactly the capabilities the plugin declares" } });
		}
		const acceptedOutboundOrigins = new Set(args.acceptedOutboundOrigins);
		if (
			pluginVersion.outboundOrigins.length !== acceptedOutboundOrigins.size ||
			pluginVersion.outboundOrigins.some((origin) => !acceptedOutboundOrigins.has(origin))
		) {
			return Result({ _nay: { message: "Install must accept exactly the outbound origins the plugin declares" } });
		}

		const now = Date.now();
		const existingInstallation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginName", (q) =>
				q
					.eq("organizationId", installationScope.organizationId)
					.eq("workspaceId", installationScope.workspaceId)
					.eq("pluginName", pluginVersion.name),
			)
			.first();

		let installationId: Id<"plugins_workspace_installations">;
		let installationCreatedAt: number;
		if (existingInstallation) {
			const existingVersion = await ctx.db.get("plugins_versions", existingInstallation.pluginVersionId);
			if (!existingVersion || existingVersion.sourceRepositoryUrl !== pluginVersion.sourceRepositoryUrl) {
				return Result({ _nay: { message: "Plugin name already installed from a different source" } });
			}
			installationId = existingInstallation._id;
			installationCreatedAt = existingInstallation._creationTime;

			// Only an upgrade has previous-version handlers to clear; a fresh install starts empty.
			const existingHandlers = await ctx.db
				.query("plugins_workspace_event_handlers")
				.withIndex("by_installation", (q) => q.eq("installationId", existingInstallation._id))
				.collect();
			await Promise.all([
				ctx.db.patch("plugins_workspace_installations", existingInstallation._id, {
					pluginVersionId: pluginVersion._id,
					status: "enabled",
					acceptedCapabilities: pluginVersion.capabilities,
					capabilitiesAcceptedAt: now,
					acceptedOutboundOrigins: pluginVersion.outboundOrigins,
					outboundOriginsAcceptedAt: now,
					updatedBy: installationScope.userId,
					updatedAt: now,
				}),
				...existingHandlers.map((handler) => ctx.db.delete("plugins_workspace_event_handlers", handler._id)),
			]);
		} else {
			installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: installationScope.organizationId,
				workspaceId: installationScope.workspaceId,
				pluginVersionId: pluginVersion._id,
				pluginName: pluginVersion.name,
				status: "enabled",
				acceptedCapabilities: pluginVersion.capabilities,
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: pluginVersion.outboundOrigins,
				outboundOriginsAcceptedAt: now,
				installedBy: installationScope.userId,
				updatedBy: installationScope.userId,
				updatedAt: now,
			});
			const installation = await ctx.db.get("plugins_workspace_installations", installationId);
			// Inserted in this same transaction, so the read back cannot miss.
			if (!installation) {
				throw should_never_happen("plugins_workspace_installations doc missing right after insert", {
					installationId,
				});
			}
			installationCreatedAt = installation._creationTime;
		}

		await Promise.all(
			pluginVersion.events.flatMap((event) =>
				event.contentTypes.map((contentType) =>
					ctx.db.insert("plugins_workspace_event_handlers", {
						organizationId: installationScope.organizationId,
						workspaceId: installationScope.workspaceId,
						installationId,
						pluginVersionId: pluginVersion._id,
						pluginName: pluginVersion.name,
						event: event.type,
						contentType,
						installationCreatedAt,
						updatedAt: now,
					}),
				),
			),
		);

		return Result({ _yay: { installationId } });
	},
});

export const uninstall_version = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return authorization;
		}
		const membership = authorization._yay.membership;

		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== membership.organizationId ||
			installation.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Event runs and run calls stay as history; the admin hard-delete flow sweeps them.
		// UI sessions are deleted together with their installation. Their tokens already stopped
		// working (the resolver rechecks the installation on every call); this just removes the docs.
		const [handlers, secrets, uiSessions] = await Promise.all([
			ctx.db
				.query("plugins_workspace_event_handlers")
				.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
				.collect(),
			ctx.db
				.query("plugins_workspace_installation_secrets")
				.withIndex("by_installation_name", (q) => q.eq("installationId", installation._id))
				.collect(),
			ctx.db
				.query("plugins_ui_sessions")
				.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
				.collect(),
		]);
		await Promise.all([
			...handlers.map((handler) => ctx.db.delete("plugins_workspace_event_handlers", handler._id)),
			...secrets.map((secret) => ctx.db.delete("plugins_workspace_installation_secrets", secret._id)),
			...uiSessions.map((session) => ctx.db.delete("plugins_ui_sessions", session._id)),
			ctx.db.delete("plugins_workspace_installations", installation._id),
		]);

		return Result({ _yay: null });
	},
});

/**
 * The single gate for agent access to plugin sources: bash mounts `/.plugins/<pluginName>` only for
 * plugins with an enabled installation in the current workspace, targeting that installation's
 * version-keyed source tree in GLOBAL/PLUGINS.
 */
export const list_bash_source_mounts = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.array(
		v.object({
			pluginName: v.string(),
			pluginVersionId: v.id("plugins_versions"),
		}),
	),
	handler: async (ctx, args) => {
		// The status+pluginName index yields enabled installations already in plugin-name order.
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("status", "enabled"),
			)
			.collect();
		return installations.map((installation) => ({
			pluginName: installation.pluginName,
			pluginVersionId: installation.pluginVersionId,
		}));
	},
});

export type plugins_list_bash_source_mounts_Result =
	typeof list_bash_source_mounts extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const list_installations = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			installation: doc(app_convex_schema, "plugins_workspace_installations"),
			version: doc(app_convex_schema, "plugins_versions"),
			handlers: v.array(doc(app_convex_schema, "plugins_workspace_event_handlers")),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return [];
		}
		const membership = authorization._yay.membership;

		// The by_organization_workspace_pluginName index already yields the installations in plugin-name order.
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginName", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId),
			)
			.collect();

		const docs = await Promise.all(
			installations.map(async (installation) => {
				const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
				if (!version) {
					return null;
				}
				const handlers = await ctx.db
					.query("plugins_workspace_event_handlers")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.collect();
				return { installation, version, handlers };
			}),
		);

		return docs.filter((doc) => doc !== null);
	},
});

export const list_published_plugins = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			pluginVersionId: v.id("plugins_versions"),
			name: doc(app_convex_schema, "plugins_versions").fields.name,
			displayName: doc(app_convex_schema, "plugins_versions").fields.displayName,
			description: doc(app_convex_schema, "plugins_versions").fields.description,
			version: doc(app_convex_schema, "plugins_versions").fields.version,
			publisherDisplayName: v.union(v.string(), v.null()),
			reviewStatus: doc(app_convex_schema, "plugins_versions").fields.reviewStatus,
			capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
			outboundOrigins: doc(app_convex_schema, "plugins_versions").fields.outboundOrigins,
			pages: v.array(
				v.object({
					id: v.string(),
					title: v.string(),
					entry: v.string(),
					navItem: v.union(v.object({ label: v.string(), icon: v.union(v.string(), v.null()) }), v.null()),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return [];
		}

		// upsert_plugin keeps the isLatest marker on the newest-created doc per name, so this
		// reads exactly one doc per plugin, already in name order.
		const versions = await ctx.db
			.query("plugins_versions")
			.withIndex("by_isLatest_name", (q) => q.eq("isLatest", true))
			.collect();

		return await Promise.all(
			versions.map(async (version) => {
				const creator = await ctx.db.get("users", version.createdBy);
				const anagraphic = creator?.anagraphic ? await ctx.db.get("users_anagraphics", creator.anagraphic) : null;
				return {
					pluginVersionId: version._id,
					name: version.name,
					displayName: version.displayName,
					description: version.description,
					version: version.version,
					publisherDisplayName: anagraphic?.displayName ?? null,
					reviewStatus: version.reviewStatus,
					capabilities: version.capabilities,
					outboundOrigins: version.outboundOrigins,
					pages: version.pages ?? [],
				};
			}),
		);
	},
});

// #endregion installations and marketplace

// #region installation secrets

async function db_upsert_installation_secret(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		name: string;
		value: string;
		userId: Id<"users">;
		now: number;
	},
) {
	const encrypted = await crypto_encrypt_secret_value(args.value, `${args.installation._id}:${args.name}`);
	const existing = await ctx.db
		.query("plugins_workspace_installation_secrets")
		.withIndex("by_installation_name", (q) => q.eq("installationId", args.installation._id).eq("name", args.name))
		.first();

	if (existing) {
		await ctx.db.patch("plugins_workspace_installation_secrets", existing._id, {
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			valuePreview: "configured",
			updatedBy: args.userId,
			updatedAt: args.now,
		});
		return existing._id;
	}

	return await ctx.db.insert("plugins_workspace_installation_secrets", {
		organizationId: args.installation.organizationId,
		workspaceId: args.installation.workspaceId,
		installationId: args.installation._id,
		pluginName: args.installation.pluginName,
		name: args.name,
		ciphertext: encrypted.ciphertext,
		nonce: encrypted.nonce,
		valuePreview: "configured",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: args.now,
	});
}

export const list_installation_secrets = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_workspace_installation_secrets"),
			name: doc(app_convex_schema, "plugins_workspace_installation_secrets").fields.name,
			valuePreview: doc(app_convex_schema, "plugins_workspace_installation_secrets").fields.valuePreview,
			updatedAt: doc(app_convex_schema, "plugins_workspace_installation_secrets").fields.updatedAt,
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return [];
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return [];
		}

		// The by_installation_name index already yields the secrets in name order.
		const secrets = await ctx.db
			.query("plugins_workspace_installation_secrets")
			.withIndex("by_installation_name", (q) => q.eq("installationId", installation._id))
			.collect();

		return secrets.map((secret) => ({
			_id: secret._id,
			name: secret.name,
			valuePreview: secret.valuePreview,
			updatedAt: secret.updatedAt,
		}));
	},
});

export const upsert_installation_secret = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		name: v.string(),
		value: v.string(),
	},
	returns: v_result({ _yay: v.object({ secretId: v.id("plugins_workspace_installation_secrets") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return authorization;
		}

		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!installation.acceptedCapabilities.includes("plugin.secrets.read")) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const name = plugins_validate_secret_name(args.name);
		if (name._nay) {
			return name;
		}

		let secretId: Id<"plugins_workspace_installation_secrets">;
		try {
			secretId = await db_upsert_installation_secret(ctx, {
				installation,
				name: name._yay,
				value: args.value,
				userId: userAuth.id,
				now: Date.now(),
			});
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { secretId } });
	},
});

export const upsert_installation_secrets = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		secrets: v.array(v.object({ name: v.string(), value: v.string() })),
	},
	returns: v_result({ _yay: v.object({ count: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		if (args.secrets.length === 0 || args.secrets.length > PLUGIN_SECRETS_MAX_BATCH_SIZE) {
			return Result({ _nay: { message: "Secret batch size is invalid" } });
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return authorization;
		}

		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!installation.acceptedCapabilities.includes("plugin.secrets.read")) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Dedupe by name (last one wins) so repeated names collapse to a single upsert.
		const secrets = new Map<string, string>();
		for (const input of args.secrets) {
			const name = plugins_validate_secret_name(input.name);
			if (name._nay) {
				return name;
			}

			secrets.set(name._yay, input.value);
		}

		const now = Date.now();
		try {
			await Promise.all(
				[...secrets].map(([name, value]) =>
					db_upsert_installation_secret(ctx, {
						installation,
						name,
						value,
						userId: userAuth.id,
						now,
					}),
				),
			);
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { count: secrets.size } });
	},
});

export const delete_installation_secret = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		name: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return authorization;
		}

		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// No plugin.secrets.read gate here: even when an upgrade drops the capability,
		// leftover secrets must stay listable and removable.
		const existing = await ctx.db
			.query("plugins_workspace_installation_secrets")
			.withIndex("by_installation_name", (q) => q.eq("installationId", installation._id).eq("name", args.name))
			.first();
		if (existing) {
			await ctx.db.delete("plugins_workspace_installation_secrets", existing._id);
		}
		return Result({ _yay: null });
	},
});

export const get_secret_for_runtime = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		name: v.string(),
	},
	returns: v.union(
		v.object({
			tier: v.literal("installation"),
			secret: doc(app_convex_schema, "plugins_workspace_installation_secrets"),
		}),
		v.object({
			tier: v.literal("publisher"),
			secret: doc(app_convex_schema, "plugins_publisher_repository_secrets"),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const installationSecret = await ctx.db
			.query("plugins_workspace_installation_secrets")
			.withIndex("by_installation_name", (q) => q.eq("installationId", args.installationId).eq("name", args.name))
			.first();
		if (installationSecret) {
			if (
				installationSecret.organizationId !== args.organizationId ||
				installationSecret.workspaceId !== args.workspaceId
			) {
				return null;
			}
			return { tier: "installation" as const, secret: installationSecret };
		}

		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== args.organizationId ||
			installation.workspaceId !== args.workspaceId
		) {
			return null;
		}
		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version) {
			return null;
		}
		// Publisher secrets belong to the claim of the version's source repository; no claim means no secret.
		const repository = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_repositoryUrl", (q) => q.eq("repositoryUrl", version.sourceRepositoryUrl))
			.first();
		if (!repository) {
			return null;
		}
		const publisherSecret = await ctx.db
			.query("plugins_publisher_repository_secrets")
			.withIndex("by_repository_name", (q) => q.eq("repositoryId", repository._id).eq("name", args.name))
			.first();
		if (!publisherSecret) {
			return null;
		}
		await ctx.db.patch("plugins_publisher_repository_secrets", publisherSecret._id, { lastUsedAt: Date.now() });
		return { tier: "publisher" as const, secret: publisherSecret };
	},
});

export const decrypt_secret_for_runtime = internalAction({
	args: {
		resolved: v.union(
			v.object({
				tier: v.literal("installation"),
				secret: doc(app_convex_schema, "plugins_workspace_installation_secrets"),
			}),
			v.object({
				tier: v.literal("publisher"),
				secret: doc(app_convex_schema, "plugins_publisher_repository_secrets"),
			}),
		),
	},
	returns: v_result({ _yay: v.union(v.string(), v.null()) }),
	handler: async (_ctx, args) => {
		try {
			const additionalData =
				args.resolved.tier === "installation"
					? `${args.resolved.secret.installationId}:${args.resolved.secret.name}`
					: `${args.resolved.secret.ownerUserId}:${args.resolved.secret.name}`;
			return Result({ _yay: await crypto_decrypt_secret_value(args.resolved.secret, additionalData) });
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}
	},
});

export type plugins_decrypt_secret_for_runtime_Result =
	typeof decrypt_secret_for_runtime extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion installation secrets

// #region runs

const PLUGIN_RECENT_RUNS_LIMIT = 10;

export const list_run_calls = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		runId: v.id("plugins_event_runs"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_event_run_calls"),
			runId: doc(app_convex_schema, "plugins_event_run_calls").fields.runId,
			sequence: doc(app_convex_schema, "plugins_event_run_calls").fields.sequence,
			kind: doc(app_convex_schema, "plugins_event_run_calls").fields.kind,
			route: doc(app_convex_schema, "plugins_event_run_calls").fields.route,
			status: doc(app_convex_schema, "plugins_event_run_calls").fields.status,
			responseStatus: doc(app_convex_schema, "plugins_event_run_calls").fields.responseStatus,
			requestBytes: doc(app_convex_schema, "plugins_event_run_calls").fields.requestBytes,
			responseBytes: doc(app_convex_schema, "plugins_event_run_calls").fields.responseBytes,
			errorCode: doc(app_convex_schema, "plugins_event_run_calls").fields.errorCode,
			errorMessage: doc(app_convex_schema, "plugins_event_run_calls").fields.errorMessage,
			startedAt: doc(app_convex_schema, "plugins_event_run_calls").fields.startedAt,
			finishedAt: doc(app_convex_schema, "plugins_event_run_calls").fields.finishedAt,
			elapsedMs: doc(app_convex_schema, "plugins_event_run_calls").fields.elapsedMs,
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return [];
		}
		const [installation, pluginRun] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", args.installationId),
			ctx.db.get("plugins_event_runs", args.runId),
		]);
		if (
			!installation ||
			!pluginRun ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId ||
			pluginRun.organizationId !== installation.organizationId ||
			pluginRun.workspaceId !== installation.workspaceId ||
			pluginRun.installationId !== installation._id
		) {
			return [];
		}

		// The by_run_sequence index already yields the calls in sequence order. Calls per
		// run are capped at plugins_runtime MAX_API_CALLS, so collect() is bounded.
		const calls = await ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
			.collect();
		return calls.map((call) => ({
			_id: call._id,
			runId: call.runId,
			sequence: call.sequence,
			kind: call.kind,
			route: call.route,
			status: call.status,
			...(call.responseStatus === undefined ? {} : { responseStatus: call.responseStatus }),
			...(call.requestBytes === undefined ? {} : { requestBytes: call.requestBytes }),
			...(call.responseBytes === undefined ? {} : { responseBytes: call.responseBytes }),
			...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
			errorMessage: call.errorMessage,
			startedAt: call.startedAt,
			...(call.finishedAt === undefined ? {} : { finishedAt: call.finishedAt }),
			...(call.elapsedMs === undefined ? {} : { elapsedMs: call.elapsedMs }),
		}));
	},
});

export const list_recent_runs = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_event_runs"),
			event: doc(app_convex_schema, "plugins_event_runs").fields.event,
			eventId: doc(app_convex_schema, "plugins_event_runs").fields.eventId,
			status: doc(app_convex_schema, "plugins_event_runs").fields.status,
			apiCallCount: doc(app_convex_schema, "plugins_event_runs").fields.apiCallCount,
			outputWriteCount: doc(app_convex_schema, "plugins_event_runs").fields.outputWriteCount,
			errorMessage: doc(app_convex_schema, "plugins_event_runs").fields.errorMessage,
			runnerHttpStatus: doc(app_convex_schema, "plugins_event_runs").fields.runnerHttpStatus,
			runnerElapsedMs: doc(app_convex_schema, "plugins_event_runs").fields.runnerElapsedMs,
			pluginStatus: doc(app_convex_schema, "plugins_event_runs").fields.pluginStatus,
			runnerOutputBytes: doc(app_convex_schema, "plugins_event_runs").fields.runnerOutputBytes,
			runnerOutputTruncated: doc(app_convex_schema, "plugins_event_runs").fields.runnerOutputTruncated,
			updatedAt: doc(app_convex_schema, "plugins_event_runs").fields.updatedAt,
			startedAt: doc(app_convex_schema, "plugins_event_runs").fields.startedAt,
			finishedAt: doc(app_convex_schema, "plugins_event_runs").fields.finishedAt,
			file: v.union(
				v.object({
					name: doc(app_convex_schema, "files_nodes").fields.name,
					path: doc(app_convex_schema, "files_nodes").fields.path,
					contentType: v.union(v.string(), v.null()),
					size: doc(app_convex_schema, "files_r2_assets").fields.size,
				}),
				v.null(),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}

		const authorization = await db_authorize_plugin_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (authorization._nay) {
			return [];
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return [];
		}

		// The by_installation_updatedAt index already yields the runs in updatedAt order.
		const runs = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_installation_updatedAt", (q) => q.eq("installationId", installation._id))
			.order("desc")
			.take(PLUGIN_RECENT_RUNS_LIMIT);

		return await Promise.all(
			runs.map(async (run) => {
				const [fileNode, asset] = await Promise.all([
					ctx.db.get("files_nodes", run.fileNodeId),
					ctx.db.get("files_r2_assets", run.assetId),
				]);
				return {
					_id: run._id,
					event: run.event,
					eventId: run.eventId,
					status: run.status,
					apiCallCount: run.apiCallCount,
					outputWriteCount: run.outputWriteCount,
					errorMessage: run.errorMessage,
					...(run.runnerHttpStatus === undefined ? {} : { runnerHttpStatus: run.runnerHttpStatus }),
					...(run.runnerElapsedMs === undefined ? {} : { runnerElapsedMs: run.runnerElapsedMs }),
					...(run.pluginStatus === undefined ? {} : { pluginStatus: run.pluginStatus }),
					...(run.runnerOutputBytes === undefined ? {} : { runnerOutputBytes: run.runnerOutputBytes }),
					...(run.runnerOutputTruncated === undefined ? {} : { runnerOutputTruncated: run.runnerOutputTruncated }),
					updatedAt: run.updatedAt,
					...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
					...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
					file:
						fileNode && asset
							? {
									name: fileNode.name,
									path: fileNode.path,
									contentType: fileNode.contentType ?? null,
									size: asset.size,
								}
							: null,
				};
			}),
		);
	},
});

// #endregion runs

// #region admin
/**
 * Programmatic manual runs: enqueues an installed plugin on already-uploaded files without new
 * uploads. There is no UI for this; invoke it from the CLI against the dev deployment:
 * `pnpx convex run plugins:run_installation_on_files '{"installationId": "...", "nodeIds": ["..."]}'`.
 * Files gate independently: each entry carries either its queued runId or the reason it was skipped.
 */
export const run_installation_on_files = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		nodeIds: v.array(v.id("files_nodes")),
	},
	returns: v_result({
		_yay: v.object({
			runs: v.array(
				v.object({
					nodeId: v.id("files_nodes"),
					runId: v.union(v.id("plugins_event_runs"), v.null()),
					message: v.union(v.string(), v.null()),
				}),
			),
		}),
	}),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (!installation) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (installation.status !== "enabled") {
			return Result({ _nay: { message: "Plugin is disabled" } });
		}

		// Sequential like the upload fan-out's handler loop; it also makes a duplicated nodeId hit
		// the already-pending guard instead of racing itself.
		const runs: { nodeId: Id<"files_nodes">; runId: Id<"plugins_event_runs"> | null; message: string | null }[] = [];
		for (const nodeId of args.nodeIds) {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!fileNode || fileNode.archiveOperationId !== undefined) {
				runs.push({ nodeId, runId: null, message: "Not found" });
				continue;
			}
			if (
				fileNode.organizationId !== installation.organizationId ||
				fileNode.workspaceId !== installation.workspaceId
			) {
				runs.push({ nodeId, runId: null, message: "File and plugin installation are in different workspaces" });
				continue;
			}
			// Plugins process finished binary uploads only, matching the upload fan-out gate.
			if (fileNode.kind !== "file" || fileNode.assetId === undefined || files_node_has_editable_yjs_state(fileNode)) {
				runs.push({ nodeId, runId: null, message: "Plugin runs are only supported for uploaded files" });
				continue;
			}
			// A local is load-bearing here: the undefined-narrowing does not flow into the withIndex
			// closure through the property access.
			const contentType = fileNode.contentType;
			if (!contentType) {
				runs.push({ nodeId, runId: null, message: "Plugin does not handle this file type" });
				continue;
			}

			const [asset, handlers] = await Promise.all([
				ctx.db.get("files_r2_assets", fileNode.assetId),
				// Manual runs reuse the upload handlers' contentType subscriptions for eligibility;
				// by_scope_event_contentType_createdAt_name mirrors the upload fan-out lookup.
				ctx.db
					.query("plugins_workspace_event_handlers")
					.withIndex("by_scope_event_contentType_createdAt_name", (q) =>
						q
							.eq("organizationId", installation.organizationId)
							.eq("workspaceId", installation.workspaceId)
							.eq("event", "files.upload.completed")
							.eq("contentType", contentType),
					)
					.collect(),
			]);
			if (!asset) {
				const errorMessage = "fileNode.assetId points to a missing files_r2_assets doc";
				const errorData = { fileNodeId: fileNode._id, assetId: fileNode.assetId };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			// r2Key is only set once the upload finalizer confirmed the object, so a missing key is a
			// reachable user state (upload still in flight), not a broken link.
			if (asset.kind !== "upload" || !asset.r2Key) {
				runs.push({ nodeId, runId: null, message: "File upload is not ready" });
				continue;
			}
			if (!handlers.some((handler) => handler.installationId === installation._id)) {
				runs.push({ nodeId, runId: null, message: "Plugin does not handle this file type" });
				continue;
			}

			const enqueued = await plugins_runtime_db_enqueue_manual_run(ctx, {
				asset,
				fileNode,
				installation,
			});
			if (enqueued._nay) {
				runs.push({ nodeId, runId: null, message: enqueued._nay.message });
				continue;
			}
			runs.push({ nodeId, runId: enqueued._yay.runId, message: null });
		}

		return Result({ _yay: { runs } });
	},
});

/**
 * Delete one bounded batch of a GLOBAL/PLUGINS files tree: range-scan `files_nodes` by `treePath`
 * over `[treePathPrefix, treePathPrefix + "\uffff")`, and for each node delete its committed chunks,
 * `file_stats`, metadata docs (defensive), and R2 asset (object + doc, gated on `r2Key`) BEFORE the
 * node doc itself, so a crash never orphans children. Asset and node deletion are one budget unit
 * pair so a node never commits with a missing asset reference. Mirrors
 * `github_mounts.clear_pending_root_batch`, minus the sync-run supersede gate.
 */
/**
 * Delete one bounded batch of a plugin version's source tree (`/<pluginVersionId>/...` in the
 * reserved `GLOBAL`/`PLUGINS` scope). Drive to `done:true` by calling repeatedly.
 */
export const delete_plugin_source_tree_batch = internalMutation({
	args: {
		pluginVersionId: v.id("plugins_versions"),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.object({ done: v.boolean(), deletedCount: v.number() }),
	handler: async (ctx, args) => {
		return await files_nodes_db_delete_subtree_batch(ctx, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
			treePathPrefix: `/${args.pluginVersionId}/`,
			batchSize: args._test_batchSize ?? 100,
		});
	},
});

export const preview_hard_delete_registered_plugin = internalQuery({
	args: {
		pluginName: v.string(),
	},
	returns: v.object({
		versions: v.number(),
		versionReviews: v.number(),
		sourceFileNodes: v.number(),
		installations: v.number(),
		eventHandlers: v.number(),
		installationSecrets: v.number(),
		uiSessions: v.number(),
		eventRuns: v.number(),
		eventRunCalls: v.number(),
		publisherRepositoryClaims: v.number(),
		publisherSecrets: v.number(),
		r2ObjectKeys: v.number(),
	}),
	handler: async (ctx, args) => {
		const versions = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name", (q) => q.eq("name", args.pluginName))
			.collect();

		const r2ObjectKeys = new Set<string>();
		const repositoryUrls = new Set<string>();
		let sourceFileNodes = 0;
		let installations = 0;
		let eventHandlers = 0;
		let installationSecrets = 0;
		let uiSessions = 0;
		let eventRuns = 0;
		let eventRunCalls = 0;
		for (const version of versions) {
			repositoryUrls.add(version.sourceRepositoryUrl);
			for (const r2Key of version_r2_keys(version)) {
				r2ObjectKeys.add(r2Key);
			}
			const sourceNodes = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_treePath", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_PLUGINS_WORKSPACE_ID)
						.gte("treePath", `/${version._id}/`)
						.lt("treePath", `/${version._id}/\uffff`),
				)
				.collect();
			sourceFileNodes += sourceNodes.length;
			const versionInstallations = await ctx.db
				.query("plugins_workspace_installations")
				.withIndex("by_pluginVersion", (q) => q.eq("pluginVersionId", version._id))
				.collect();
			installations += versionInstallations.length;
			for (const installation of versionInstallations) {
				const handlers = await ctx.db
					.query("plugins_workspace_event_handlers")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.collect();
				eventHandlers += handlers.length;
				const secrets = await ctx.db
					.query("plugins_workspace_installation_secrets")
					.withIndex("by_installation_name", (q) => q.eq("installationId", installation._id))
					.collect();
				installationSecrets += secrets.length;
				const sessions = await ctx.db
					.query("plugins_ui_sessions")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.collect();
				uiSessions += sessions.length;
				const runs = await ctx.db
					.query("plugins_event_runs")
					.withIndex("by_installation_updatedAt", (q) => q.eq("installationId", installation._id))
					.collect();
				eventRuns += runs.length;
				const calls = await ctx.db
					.query("plugins_event_run_calls")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.collect();
				eventRunCalls += calls.length;
			}
		}

		// A plugin name is bound to the publisher that first registered it, so that
		// publisher's createdBy scopes the plugin's reviews.
		let versionReviews = 0;
		const firstVersion = versions.at(0);
		if (firstVersion) {
			const reviews = await ctx.db
				.query("plugins_version_reviews")
				.withIndex("by_createdBy_pluginName", (q) =>
					q.eq("createdBy", firstVersion.createdBy).eq("pluginName", args.pluginName),
				)
				.collect();
			versionReviews = reviews.length;
		}

		let publisherRepositoryClaims = 0;
		let publisherSecrets = 0;
		for (const repositoryUrl of repositoryUrls) {
			const claims = await ctx.db
				.query("plugins_publisher_repositories")
				.withIndex("by_repositoryUrl", (q) => q.eq("repositoryUrl", repositoryUrl))
				.collect();
			publisherRepositoryClaims += claims.length;
			for (const claim of claims) {
				const secrets = await ctx.db
					.query("plugins_publisher_repository_secrets")
					.withIndex("by_repository_name", (q) => q.eq("repositoryId", claim._id))
					.collect();
				publisherSecrets += secrets.length;
			}
		}

		return {
			versions: versions.length,
			versionReviews,
			sourceFileNodes,
			installations,
			eventHandlers,
			installationSecrets,
			uiSessions,
			eventRuns,
			eventRunCalls,
			publisherRepositoryClaims,
			publisherSecrets,
			r2ObjectKeys: r2ObjectKeys.size,
		};
	},
});

export const hard_delete_registered_plugin_batch = internalMutation({
	args: {
		pluginName: v.string(),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.object({
		done: v.boolean(),
		deleted: v.number(),
	}),
	handler: async (ctx, args) => {
		let budget = args._test_batchSize ?? 100;
		let deleted = 0;

		const versions = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name", (q) => q.eq("name", args.pluginName))
			.collect();
		const firstVersion = versions.at(0);
		if (!firstVersion) {
			return { done: true, deleted };
		}

		// Child docs before parents: run calls -> runs (each run's unpublished write stages are
		// deleted just before the run itself) -> handlers -> installation secrets -> ui sessions ->
		// installations -> reviews -> mounts -> versions -> repo claims (each claim's publisher
		// secrets are deleted just before the claim itself).
		for (const version of versions) {
			const installations = await ctx.db
				.query("plugins_workspace_installations")
				.withIndex("by_pluginVersion", (q) => q.eq("pluginVersionId", version._id))
				.collect();
			for (const installation of installations) {
				const calls = await ctx.db
					.query("plugins_event_run_calls")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.take(budget);
				for (const call of calls) {
					await ctx.db.delete("plugins_event_run_calls", call._id);
				}
				deleted += calls.length;
				budget -= calls.length;
				if (budget <= 0) {
					return { done: false, deleted };
				}
				const pluginRuns = await ctx.db
					.query("plugins_event_runs")
					.withIndex("by_installation_updatedAt", (q) => q.eq("installationId", installation._id))
					.take(budget);
				await Promise.all(
					pluginRuns.flatMap((pluginRun) =>
						pluginRun.workId ? [plugins_runtime_workpool.cancel(ctx, pluginRun.workId)] : [],
					),
				);
				for (const pluginRun of pluginRuns) {
					// Unpublished write stages hold R2 objects with no files_nodes doc, so they must be
					// cleaned (objects included) before their run doc disappears.
					const stages = await ctx.db
						.query("public_api_file_write_stages")
						.withIndex("by_run", (q) => q.eq("runId", pluginRun._id))
						.collect();
					for (const stage of stages) {
						await public_api_db_cleanup_file_write_stage(ctx, stage);
					}
					deleted += stages.length;
					await ctx.db.delete("plugins_event_runs", pluginRun._id);
				}
				deleted += pluginRuns.length;
				budget -= pluginRuns.length;
				if (budget <= 0) {
					return { done: false, deleted };
				}
				const handlers = await ctx.db
					.query("plugins_workspace_event_handlers")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.take(budget);
				for (const handler of handlers) {
					await ctx.db.delete("plugins_workspace_event_handlers", handler._id);
				}
				deleted += handlers.length;
				budget -= handlers.length;
				if (budget <= 0) {
					return { done: false, deleted };
				}
				const secrets = await ctx.db
					.query("plugins_workspace_installation_secrets")
					.withIndex("by_installation_name", (q) => q.eq("installationId", installation._id))
					.take(budget);
				for (const secret of secrets) {
					await ctx.db.delete("plugins_workspace_installation_secrets", secret._id);
				}
				deleted += secrets.length;
				budget -= secrets.length;
				if (budget <= 0) {
					return { done: false, deleted };
				}
				const uiSessions = await ctx.db
					.query("plugins_ui_sessions")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.take(budget);
				for (const session of uiSessions) {
					await ctx.db.delete("plugins_ui_sessions", session._id);
				}
				deleted += uiSessions.length;
				budget -= uiSessions.length;
				if (budget <= 0) {
					return { done: false, deleted };
				}
				await ctx.db.delete("plugins_workspace_installations", installation._id);
				deleted += 1;
				budget -= 1;
				if (budget <= 0) {
					return { done: false, deleted };
				}
			}
		}

		// A plugin name is bound to the publisher that first registered it, so that
		// publisher's createdBy scopes the plugin's reviews.
		const reviews = await ctx.db
			.query("plugins_version_reviews")
			.withIndex("by_createdBy_pluginName", (q) =>
				q.eq("createdBy", firstVersion.createdBy).eq("pluginName", args.pluginName),
			)
			.collect();
		for (const review of reviews) {
			await ctx.db.delete("plugins_version_reviews", review._id);
			deleted += 1;
			budget -= 1;
			if (budget <= 0) {
				return { done: false, deleted };
			}
		}

		for (const version of versions) {
			// Drain the version's source tree in GLOBAL/PLUGINS before the version doc so a
			// registry hard delete never orphans reserved-scope file rows.
			const sourceTree = await files_nodes_db_delete_subtree_batch(ctx, {
				organizationId: organizations_GLOBAL_ORGANIZATION_ID,
				workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
				treePathPrefix: `/${version._id}/`,
				batchSize: budget,
			});
			deleted += sourceTree.deletedCount;
			budget -= sourceTree.deletedCount;
			if (!sourceTree.done || budget <= 0) {
				return { done: false, deleted };
			}

			// R2 deletion is best effort: a failing artifact object must not block the
			// registry delete.
			for (const r2Key of version_r2_keys(version)) {
				try {
					await r2_delete_object(ctx, r2Key);
				} catch (error) {
					console.error("Failed to delete plugin R2 object", { r2Key, error });
				}
			}
			await ctx.db.delete("plugins_versions", version._id);
			deleted += 1;
			budget -= 1;

			// Drop the repository claim once no registered version references its repo
			// anymore (a manifest rename can leave another plugin name on the same repo).
			const remainingVersion = await ctx.db
				.query("plugins_versions")
				.withIndex("by_sourceRepositoryUrl", (q) => q.eq("sourceRepositoryUrl", version.sourceRepositoryUrl))
				.first();
			if (!remainingVersion) {
				const claims = await ctx.db
					.query("plugins_publisher_repositories")
					.withIndex("by_repositoryUrl", (q) => q.eq("repositoryUrl", version.sourceRepositoryUrl))
					.collect();
				for (const claim of claims) {
					const secrets = await ctx.db
						.query("plugins_publisher_repository_secrets")
						.withIndex("by_repository_name", (q) => q.eq("repositoryId", claim._id))
						.collect();
					for (const secret of secrets) {
						await ctx.db.delete("plugins_publisher_repository_secrets", secret._id);
						deleted += 1;
					}
					await ctx.db.delete("plugins_publisher_repositories", claim._id);
					deleted += 1;
				}
			}
			if (budget <= 0) {
				return { done: false, deleted };
			}
		}

		return { done: true, deleted };
	},
});

type hard_delete_registered_plugin_batch_Result =
	typeof hard_delete_registered_plugin_batch extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const hard_delete_registered_plugin_now = internalAction({
	args: {
		pluginName: v.string(),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		let done = false;
		for (let step = 0; step < 50 && !done; step += 1) {
			const result = (await ctx.runMutation(internal.plugins.hard_delete_registered_plugin_batch, {
				pluginName: args.pluginName,
				_test_batchSize: args._test_batchSize,
			})) as hard_delete_registered_plugin_batch_Result;
			done = result.done;
		}
		if (!done) {
			throw new Error(`Hard delete of plugin "${args.pluginName}" did not finish in 50 batches; run it again`);
		}

		return null;
	},
});

// #endregion admin
