// Read-only plugin trees behind /api/v1/volumes/*. The run owns every tenant and asset id.
import { v, type Infer } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import {
	billing_db_check_credits,
	billing_db_emit_plugin_volume_file_writes,
	billing_pick_billed_user_id,
} from "./billing_db.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { files_nodes_db_insert_file_content_docs } from "./files_nodes_content.ts";
import { plugins_volumes_db_retire_generation, plugins_volumes_db_schedule_volume_drain } from "./plugins_volumes.ts";
import { public_api_db_revalidate_live_plugin_run } from "./public_api.ts";
import { public_api_authorize_request, public_api_settle_plugin_call_best_effort } from "./public_api_http_auth.ts";
import { rate_limiter_get_plugin_volume_daily_files_left, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2, r2_create_asset_key, r2_put_object, r2_UNFINALIZED_ASSET_TTL_MS } from "./r2_client.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_get_utf8_byte_size, files_ROOT_ID } from "../server/files.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

export const experimental_reuseContext = true;

const LIMITS = {
	fileBytes: 900_000,
	copyFiles: 5_000,
	copyBytes: 30_000_000,
	installationFiles: 20_000,
	installationBytes: 200_000_000,
	dailyFiles: 10_000,
	volumesPerMount: 32,
	volumesPerInstallation: 128,
} as const;
const STAGING_TTL_MS = 26 * 60 * 60 * 1000;
const CHUNK_MAX_BYTES = 2_000_000;
const CHUNK_MAX_FILES = 25;
const TRANSACTION_BYTES = 12_000_000;
const TRANSACTION_DOCUMENTS = 12_000;
const VOLUME_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const CONTROL_REGEX = /\p{Cc}/u;
const run_context_validator = {
	runId: v.id("plugins_event_runs"),
	callId: v.id("plugins_event_run_calls"),
	tokenHash: v.string(),
};
const failure_data_validator = v.object({
	status: v.union(
		v.literal(400),
		v.literal(401),
		v.literal(402),
		v.literal(403),
		v.literal(404),
		v.literal(409),
		v.literal(429),
		v.literal(500),
	),
	errorCode: v.string(),
	retryAfterMs: v.optional(v.number()),
});
const file_error_validator = v.object({ path: v.string(), errorCode: v.string(), message: v.string() });
const written_validator = v.object({ path: v.string(), bytes: v.number() });
type RunContext = { runId: Id<"plugins_event_runs">; callId: Id<"plugins_event_run_calls">; tokenHash: string };
type FailureStatus = Infer<typeof failure_data_validator>["status"];

function failure(args: { status: FailureStatus; message: string; errorCode: string; retryAfterMs?: number }) {
	const { retryAfterMs, errorCode, message, status } = args;

	return Result({
		_nay: { message, data: { status, errorCode, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } },
	});
}

async function db_authorize_run(
	args: RunContext & {
		ctx: QueryCtx | MutationCtx;
		route: string;
	},
) {
	const { ctx, route } = args;

	const storedRun = await ctx.db.get("plugins_event_runs", args.runId);
	if (!storedRun || storedRun.apiTokenHash !== args.tokenHash)
		return failure({ status: 401, message: "Unauthenticated", errorCode: "unauthenticated" });
	const live = await public_api_db_revalidate_live_plugin_run(ctx, {
		organizationId: storedRun.organizationId,
		workspaceId: storedRun.workspaceId,
		runId: storedRun._id,
		now: Date.now(),
		requiredScope: "volumes:write",
	});
	if (live._nay)
		return live._nay.message === "Permission denied"
			? failure({ status: 403, message: "Permission denied", errorCode: "permission_denied" })
			: failure({ status: 401, message: "Unauthenticated", errorCode: "unauthenticated" });
	const { pluginRun, installation } = live._yay;
	const [call, actor, organization, membership] = await Promise.all([
		ctx.db.get("plugins_event_run_calls", args.callId),
		ctx.db.get("users", pluginRun.actorUserId),
		ctx.db.get("organizations", pluginRun.organizationId),
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", pluginRun.actorUserId)
					.eq("organizationId", pluginRun.organizationId)
					.eq("workspaceId", pluginRun.workspaceId),
			)
			.first(),
	]);
	if (
		!call ||
		call.status !== "started" ||
		call.kind !== "api_request" ||
		call.route !== route ||
		call.runId !== pluginRun._id ||
		call.organizationId !== pluginRun.organizationId ||
		call.workspaceId !== pluginRun.workspaceId ||
		call.installationId !== installation._id ||
		call.pluginVersionId !== pluginRun.pluginVersionId ||
		!actor ||
		actor.deletedAt !== undefined ||
		!membership ||
		membership.pendingOrganizationRemoval === true ||
		!organization
	)
		return failure({ status: 401, message: "Unauthenticated", errorCode: "unauthenticated" });
	if (
		!pluginRun.acceptedCapabilities.includes("workspace.volumes.write") ||
		!installation.acceptedCapabilities.includes("workspace.volumes.write")
	)
		return failure({ status: 403, message: "Permission denied", errorCode: "permission_denied" });
	if (!organization.defaultWorkspaceId)
		throw should_never_happen("organization.defaultWorkspaceId is not set", { organizationId: organization._id });
	if (
		!(await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: pluginRun.workspaceId,
			defaultWorkspaceId: organization.defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "plugin_installation", id: installation._id },
			permission: "workspace.plugins.manage",
			userId: actor._id,
		}))
	)
		return failure({ status: 403, message: "Permission denied", errorCode: "permission_denied" });
	if (pluginRun.fileNodeId !== undefined) {
		const source = await ctx.db.get("files_nodes", pluginRun.fileNodeId);
		if (
			!source ||
			source.organizationId !== organization._id ||
			source.workspaceId !== pluginRun.workspaceId ||
			source.kind !== "file" ||
			source.archiveOperationId !== null
		)
			return failure({ status: 401, message: "Unauthenticated", errorCode: "unauthenticated" });
	}
	return Result({ _yay: { pluginRun, installation, organization, actor } });
}

async function db_get_mount(args: {
	ctx: QueryCtx | MutationCtx;
	installation: Doc<"plugins_workspace_installations">;
	mountId: string;
}) {
	const { ctx, installation, mountId } = args;

	const mount = await ctx.db
		.query("plugins_mounts")
		.withIndex("by_installation_mountId", (q) => q.eq("installationId", installation._id).eq("mountId", mountId))
		.unique();
	return mount?.organizationId === installation.organizationId && mount.workspaceId === installation.workspaceId
		? mount
		: null;
}

function db_get_usage(ctx: QueryCtx | MutationCtx, installation: Doc<"plugins_workspace_installations">) {
	return ctx.db
		.query("plugins_volume_usage")
		.withIndex("by_organization_workspace_installation", (q) =>
			q
				.eq("organizationId", installation.organizationId)
				.eq("workspaceId", installation.workspaceId)
				.eq("installationId", installation._id),
		)
		.unique();
}

function daily_key(installation: Doc<"plugins_workspace_installations">) {
	return `${installation.organizationId}:${installation.workspaceId}:${installation.pluginName}`;
}

async function db_get_staging(args: {
	ctx: QueryCtx | MutationCtx;
	installation: Doc<"plugins_workspace_installations">;
	stagingId: string;
}) {
	const { ctx, installation, stagingId } = args;

	const id = ctx.db.normalizeId("plugins_volume_generations", stagingId);
	const generation = id ? await ctx.db.get("plugins_volume_generations", id) : null;
	if (
		!generation ||
		generation.installationId !== installation._id ||
		generation.organizationId !== installation.organizationId ||
		generation.workspaceId !== installation.workspaceId
	)
		return failure({ status: 404, message: "Not found", errorCode: "not_found" });
	const volume = await ctx.db.get("plugins_volumes", generation.volumeId);
	if (
		!volume ||
		volume.installationId !== installation._id ||
		volume.organizationId !== installation.organizationId ||
		volume.workspaceId !== installation.workspaceId ||
		!(await db_get_mount({ ctx, installation, mountId: volume.mountId }))
	)
		return failure({ status: 404, message: "Not found", errorCode: "not_found" });
	if (volume.deleteRequestedAt !== null)
		return failure({ status: 409, message: "Volume deletion is in progress", errorCode: "volume_deleting" });
	if (generation.status !== "staging" || generation.expiresAt === null || generation.expiresAt <= Date.now())
		return failure({ status: 409, message: "Staging copy is unavailable", errorCode: "staging_unavailable" });
	return Result({ _yay: { generation, volume } });
}

function db_get_node(args: { ctx: QueryCtx | MutationCtx; volume: Doc<"plugins_volumes">; path: string }) {
	const { ctx, volume, path } = args;

	return ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", volume.organizationId)
				.eq("workspaceId", volume._id)
				.eq("path", path)
				.eq("archiveOperationId", null),
		)
		.unique();
}

async function db_check_path(args: {
	ctx: QueryCtx | MutationCtx;
	volume: Doc<"plugins_volumes">;
	generationId: Id<"plugins_volume_generations">;
	path: string;
}) {
	const { ctx, volume, generationId, path } = args;

	const storedPath = `/${generationId}${path}`;
	const node = await db_get_node({ ctx, volume, path: storedPath });
	if (node?.kind === "folder") return Result({ _nay: { message: "A folder already uses this path" } });
	let slash = storedPath.lastIndexOf("/");
	while (slash > 0) {
		const parent = await db_get_node({ ctx, volume, path: storedPath.slice(0, slash) });
		if (parent?.kind === "file") return Result({ _nay: { message: "A parent path is a file" } });
		slash = storedPath.lastIndexOf("/", slash - 1);
	}
	return Result({ _yay: node });
}

async function db_check_credits(args: {
	ctx: QueryCtx | MutationCtx;
	context: NonNullable<Awaited<ReturnType<typeof db_authorize_run>>["_yay"]>;
	count: number;
}) {
	const { ctx, context, count } = args;

	// Scheduled work bills the current owner, even when the workspace bills people separately.
	const billedUserId =
		context.pluginRun.event === "schedule.interval.elapsed"
			? context.organization.ownerUserId
			: billing_pick_billed_user_id({ userId: context.actor._id, organization: context.organization });
	const billedUser = billedUserId === context.actor._id ? context.actor : await ctx.db.get("users", billedUserId);
	if (!billedUser || billedUser.deletedAt !== undefined)
		return failure({ status: 402, message: "Insufficient funds", errorCode: "insufficient_funds" });
	const credits = await billing_db_check_credits(ctx, { userId: billedUser._id, minimumRequiredCents: count * 0.5 });
	return credits.hasCredits
		? Result({ _yay: billedUser })
		: failure({ status: 402, message: "Insufficient funds", errorCode: "insufficient_funds" });
}

// Bound both old reads/deletes and new chunk inserts. A replacement can be much smaller than its old file.
function file_budget(args: { bytes: number; chunks: number; path: string }) {
	const { bytes, chunks, path } = args;

	return { bytes: 3 * bytes + chunks * (1_200 + files_get_utf8_byte_size(path)) + 64_000, documents: 2 * chunks + 80 };
}
function old_file_budget(node: Doc<"files_nodes"> | null) {
	const bytes = node?.contentByteSize ?? 0;
	return node
		? file_budget({ bytes, chunks: bytes === 0 ? 0 : Math.ceil(bytes / 600) + 2, path: node.path })
		: { bytes: 0, documents: 0 };
}

function invalid_path(path: string) {
	if (!path.startsWith("/") || path.length > 1_024 || path.includes("\\") || CONTROL_REGEX.test(path)) return true;
	const segments = path.slice(1).split("/");
	return (
		segments.length > 32 ||
		segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.length > 255)
	);
}
function invalid_content(content: string) {
	return !content.isWellFormed() || files_get_utf8_byte_size(content) > LIMITS.fileBytes;
}

// #region registered volume doors

export const list = internalQuery({
	args: { ...run_context_validator, mountId: v.optional(v.string()) },
	returns: v_result({
		_yay: v.object({
			mounts: v.array(
				v.object({
					mountId: v.string(),
					name: v.string(),
					volumes: v.array(
						v.object({
							volumeKey: v.string(),
							deleting: v.boolean(),
							published: v.union(
								v.null(),
								v.object({ revision: v.string(), fileCount: v.number(), bytes: v.number(), publishedAt: v.number() }),
							),
							staging: v.union(
								v.null(),
								v.object({
									stagingId: v.id("plugins_volume_generations"),
									revision: v.string(),
									fileCount: v.number(),
									bytes: v.number(),
									expiresAt: v.number(),
								}),
							),
						}),
					),
				}),
			),
			usage: v.object({
				fileCount: v.number(),
				bytes: v.number(),
				dailyFilesLeft: v.number(),
				limits: v.object({
					fileBytes: v.number(),
					copyFiles: v.number(),
					copyBytes: v.number(),
					installationFiles: v.number(),
					installationBytes: v.number(),
					dailyFiles: v.number(),
					volumesPerMount: v.number(),
					volumesPerInstallation: v.number(),
				}),
			}),
		}),
		_nay: { data: failure_data_validator },
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_run({ ctx, ...args, route: "/api/v1/volumes/list" });
		if (authorized._nay) return authorized;
		const { installation } = authorized._yay;
		if (args.mountId !== undefined && !(await db_get_mount({ ctx, installation, mountId: args.mountId })))
			return failure({ status: 400, message: "Unknown mountId", errorCode: "invalid_input" });
		const mounts = await ctx.db
			.query("plugins_mounts")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId)
					.eq("installationId", installation._id),
			)
			.collect();
		const volumes = await ctx.db
			.query("plugins_volumes")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId)
					.eq("installationId", installation._id),
			)
			.take(LIMITS.volumesPerInstallation);
		const usage = await db_get_usage(ctx, installation);
		const result = [];
		for (const mount of mounts) {
			if (args.mountId !== undefined && mount.mountId !== args.mountId) continue;
			const listedVolumes = [];
			for (const volume of volumes
				.filter((item) => item.mountId === mount.mountId)
				.sort((a, b) => a.volumeKey.localeCompare(b.volumeKey))) {
				const published = volume.publishedGenerationId
					? await ctx.db.get("plugins_volume_generations", volume.publishedGenerationId)
					: null;
				const staging = await ctx.db
					.query("plugins_volume_generations")
					.withIndex("by_volume_status", (q) => q.eq("volumeId", volume._id).eq("status", "staging"))
					.unique();
				listedVolumes.push({
					volumeKey: volume.volumeKey,
					deleting: volume.deleteRequestedAt !== null,
					published:
						published && published.publishedAt !== null
							? {
									revision: published.revision,
									fileCount: published.fileCount,
									bytes: published.bytes,
									publishedAt: published.publishedAt,
								}
							: null,
					staging:
						staging && staging.expiresAt !== null && staging.expiresAt > Date.now()
							? {
									stagingId: staging._id,
									revision: staging.revision,
									fileCount: staging.fileCount,
									bytes: staging.bytes,
									expiresAt: staging.expiresAt,
								}
							: null,
				});
			}
			result.push({ mountId: mount.mountId, name: mount.name, volumes: listedVolumes });
		}
		return Result({
			_yay: {
				mounts: result,
				usage: {
					fileCount: usage?.fileCount ?? 0,
					bytes: usage?.bytes ?? 0,
					dailyFilesLeft: await rate_limiter_get_plugin_volume_daily_files_left(ctx, {
						key: daily_key(installation),
						now: Date.now(),
					}),
					limits: LIMITS,
				},
			},
		});
	},
});

export const stage = internalMutation({
	args: { ...run_context_validator, mountId: v.string(), volumeKey: v.string(), revision: v.string() },
	returns: v_result({
		_yay: v.object({
			stagingId: v.id("plugins_volume_generations"),
			abandonedStagingId: v.union(v.id("plugins_volume_generations"), v.null()),
		}),
		_nay: { data: failure_data_validator },
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_run({ ctx, ...args, route: "/api/v1/volumes/stage" });
		if (authorized._nay) return authorized;
		const { installation } = authorized._yay;
		if (
			!(await db_get_mount({ ctx, installation, mountId: args.mountId })) ||
			!VOLUME_KEY_REGEX.test(args.volumeKey) ||
			args.volumeKey === "tmp" ||
			args.revision.length < 1 ||
			args.revision.length > 200 ||
			CONTROL_REGEX.test(args.revision)
		)
			return failure({ status: 400, message: "Invalid mountId, volumeKey, or revision", errorCode: "invalid_input" });
		const volume = await ctx.db
			.query("plugins_volumes")
			.withIndex("by_installation_mountId_volumeKey", (q) =>
				q.eq("installationId", installation._id).eq("mountId", args.mountId).eq("volumeKey", args.volumeKey),
			)
			.unique();
		if (volume && volume.deleteRequestedAt !== null)
			return failure({ status: 409, message: "Volume deletion is in progress", errorCode: "volume_deleting" });
		if (!volume) {
			// Dropped mount ids keep deleting volumes until their worker finishes.
			const installationVolumes = await ctx.db
				.query("plugins_volumes")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", installation.organizationId)
						.eq("workspaceId", installation.workspaceId)
						.eq("installationId", installation._id),
				)
				.take(LIMITS.volumesPerInstallation);
			if (installationVolumes.length >= LIMITS.volumesPerInstallation)
				return failure({ status: 409, message: "Installation has 128 volumes", errorCode: "volume_cap_reached" });
			const volumes = await ctx.db
				.query("plugins_volumes")
				.withIndex("by_installation_mountId_volumeKey", (q) =>
					q.eq("installationId", installation._id).eq("mountId", args.mountId),
				)
				.take(LIMITS.volumesPerMount);
			if (volumes.length >= LIMITS.volumesPerMount)
				return failure({ status: 409, message: "Mount has 32 volumes", errorCode: "volume_cap_reached" });
		}
		const rate = await rate_limiter_limit_by_key(ctx, { name: "plugins_volume_control", key: installation._id });
		if (rate)
			return failure({
				status: 429,
				message: rate.message,
				errorCode: "rate_limit_exceeded",
				retryAfterMs: rate.retryAfterMs,
			});
		const now = Date.now();
		const tenant = {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			installationId: installation._id,
		};
		const volumeId =
			volume?._id ??
			(await ctx.db.insert("plugins_volumes", {
				...tenant,
				mountId: args.mountId,
				volumeKey: args.volumeKey,
				publishedGenerationId: null,
				createdAt: now,
				deleteRequestedAt: null,
				drainScheduledUntil: null,
			}));
		const oldStaging = volume
			? await ctx.db
					.query("plugins_volume_generations")
					.withIndex("by_volume_status", (q) => q.eq("volumeId", volume._id).eq("status", "staging"))
					.unique()
			: null;
		if (oldStaging) await plugins_volumes_db_retire_generation(ctx, { generationId: oldStaging._id });
		const stagingId = await ctx.db.insert("plugins_volume_generations", {
			...tenant,
			volumeId,
			status: "staging",
			revision: args.revision,
			fileCount: 0,
			bytes: 0,
			createdAt: now,
			lastWriteAt: now,
			publishedAt: null,
			expiresAt: now + STAGING_TTL_MS,
			drainScheduledUntil: null,
		});
		if (!(await db_get_usage(ctx, installation)))
			await ctx.db.insert("plugins_volume_usage", { ...tenant, fileCount: 0, bytes: 0 });
		return Result({ _yay: { stagingId, abandonedStagingId: oldStaging?._id ?? null } });
	},
});

export const publish = internalMutation({
	args: { ...run_context_validator, stagingId: v.string() },
	returns: v_result({
		_yay: v.object({
			volumeKey: v.string(),
			revision: v.string(),
			fileCount: v.number(),
			bytes: v.number(),
			publishedAt: v.number(),
		}),
		_nay: { data: failure_data_validator },
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_run({ ctx, ...args, route: "/api/v1/volumes/publish" });
		if (authorized._nay) return authorized;
		const staging = await db_get_staging({
			ctx,
			installation: authorized._yay.installation,
			stagingId: args.stagingId,
		});
		if (staging._nay) return staging;
		const { generation, volume } = staging._yay;
		if (generation.fileCount === 0)
			return failure({ status: 409, message: "Cannot publish an empty copy", errorCode: "empty_copy" });
		const rate = await rate_limiter_limit_by_key(ctx, {
			name: "plugins_volume_control",
			key: authorized._yay.installation._id,
		});
		if (rate)
			return failure({
				status: 429,
				message: rate.message,
				errorCode: "rate_limit_exceeded",
				retryAfterMs: rate.retryAfterMs,
			});
		if (volume.publishedGenerationId)
			await plugins_volumes_db_retire_generation(ctx, { generationId: volume.publishedGenerationId });
		const now = Date.now();
		await ctx.db.patch("plugins_volume_generations", generation._id, {
			status: "published",
			publishedAt: now,
			expiresAt: null,
		});
		await ctx.db.patch("plugins_volumes", volume._id, { publishedGenerationId: generation._id });
		return Result({
			_yay: {
				volumeKey: volume.volumeKey,
				revision: generation.revision,
				fileCount: generation.fileCount,
				bytes: generation.bytes,
				publishedAt: now,
			},
		});
	},
});

export const delete_volume = internalMutation({
	args: { ...run_context_validator, mountId: v.string(), volumeKey: v.string() },
	returns: v_result({ _yay: v.object({ deleted: v.literal(true) }), _nay: { data: failure_data_validator } }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_run({ ctx, ...args, route: "/api/v1/volumes/delete" });
		if (authorized._nay) return authorized;
		const { installation } = authorized._yay;
		if (!(await db_get_mount({ ctx, installation, mountId: args.mountId })))
			return failure({ status: 400, message: "Unknown mountId", errorCode: "invalid_input" });
		if (!VOLUME_KEY_REGEX.test(args.volumeKey) || args.volumeKey === "tmp")
			return failure({ status: 400, message: "Invalid volumeKey", errorCode: "invalid_input" });
		const volume = await ctx.db
			.query("plugins_volumes")
			.withIndex("by_installation_mountId_volumeKey", (q) =>
				q.eq("installationId", installation._id).eq("mountId", args.mountId).eq("volumeKey", args.volumeKey),
			)
			.unique();
		if (!volume) return failure({ status: 404, message: "Not found", errorCode: "not_found" });
		if (volume.deleteRequestedAt !== null)
			return failure({ status: 409, message: "Volume deletion is in progress", errorCode: "volume_deleting" });
		const rate = await rate_limiter_limit_by_key(ctx, { name: "plugins_volume_control", key: installation._id });
		if (rate)
			return failure({
				status: 429,
				message: rate.message,
				errorCode: "rate_limit_exceeded",
				retryAfterMs: rate.retryAfterMs,
			});
		await plugins_volumes_db_schedule_volume_drain(ctx, { volumeId: volume._id });
		return Result({ _yay: { deleted: true as const } });
	},
});

const write_item_validator = v.object({ path: v.string(), bytes: v.number(), chunkCount: v.number() });

export const prepare_write = internalMutation({
	args: {
		...run_context_validator,
		stagingId: v.string(),
		requestFileCount: v.number(),
		files: v.array(write_item_validator),
	},
	returns: v_result({
		_yay: v.object({
			organizationId: v.id("organizations"),
			volumeId: v.id("plugins_volumes"),
			generationId: v.id("plugins_volume_generations"),
			files: v.array(
				v.object({
					...write_item_validator.fields,
					assetId: v.id("files_r2_assets"),
					key: v.string(),
					oldBytes: v.number(),
					oldDocuments: v.number(),
				}),
			),
			errors: v.array(file_error_validator),
		}),
		_nay: { data: failure_data_validator },
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_run({ ctx, ...args, route: "/api/v1/volumes/write-many" });
		if (authorized._nay) return authorized;
		const { installation } = authorized._yay;
		const staging = await db_get_staging({ ctx, installation, stagingId: args.stagingId });
		if (staging._nay) return staging;
		const credit = await db_check_credits({ ctx, context: authorized._yay, count: args.requestFileCount });
		if (credit._nay) return credit;
		const rate = await rate_limiter_limit_by_key(ctx, {
			name: "plugins_volume_write_bulk",
			key: installation._id,
			count: args.requestFileCount,
		});
		if (rate)
			return failure({
				status: 429,
				message: rate.message,
				errorCode: "rate_limit_exceeded",
				retryAfterMs: rate.retryAfterMs,
			});
		const { generation, volume } = staging._yay;
		const usage = await db_get_usage(ctx, installation);
		if (!usage) throw should_never_happen("Volume usage is missing", { installationId: installation._id });
		let dailyFilesLeft = await rate_limiter_get_plugin_volume_daily_files_left(ctx, {
			key: daily_key(installation),
			now: Date.now(),
		});
		let fileCount = generation.fileCount;
		let bytes = generation.bytes;
		let installationFiles = usage.fileCount;
		let installationBytes = usage.bytes;
		const prepared = [];
		const errors = [];
		for (const file of args.files) {
			const checked = await db_check_path({ ctx, volume, generationId: generation._id, path: file.path });
			if (checked._nay) {
				errors.push({ path: file.path, errorCode: "path_conflict", message: checked._nay.message });
				continue;
			}
			const node = checked._yay;
			const delta = file.bytes - (node?.contentByteSize ?? 0);
			const added = node ? 0 : 1;
			const errorCode =
				fileCount + added > LIMITS.copyFiles || bytes + delta > LIMITS.copyBytes
					? "copy_cap_reached"
					: installationFiles + added > LIMITS.installationFiles || installationBytes + delta > LIMITS.installationBytes
						? "installation_cap_reached"
						: added > dailyFilesLeft
							? "daily_cap_reached"
							: null;
			if (errorCode) {
				errors.push({ path: file.path, errorCode, message: "Volume file limit reached" });
				continue;
			}
			fileCount += added;
			bytes += delta;
			installationFiles += added;
			installationBytes += delta;
			dailyFilesLeft -= added;
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: volume.organizationId,
				workspaceId: volume._id,
				kind: "content",
				r2Bucket: r2.config.bucket,
				size: file.bytes,
				createdBy: users_SYSTEM_AUTHOR,
				unfinalizedExpiresAt: Date.now() + r2_UNFINALIZED_ASSET_TTL_MS,
				updatedAt: Date.now(),
			});
			const key = r2_create_asset_key({ organizationId: volume.organizationId, workspaceId: volume._id, assetId });
			// The upload event must find an owned key even if it arrives before final node creation.
			await ctx.db.patch("files_r2_assets", assetId, { r2Key: key });
			const old = old_file_budget(node);
			prepared.push({ ...file, assetId, key, oldBytes: old.bytes, oldDocuments: old.documents });
		}
		return Result({
			_yay: {
				organizationId: volume.organizationId,
				volumeId: volume._id,
				generationId: generation._id,
				files: prepared,
				errors,
			},
		});
	},
});

async function db_delete_exact_file(ctx: MutationCtx, node: Doc<"files_nodes">) {
	const scope = { organizationId: node.organizationId, workspaceId: node.workspaceId };
	const [text, plain, metadata, stats] = await Promise.all([
		ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("file_stats")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("fileNodeId", node._id),
			)
			.unique(),
	]);
	const deletes = [
		...text.map((row) => () => ctx.db.delete("files_text_chunks", row._id)),
		...plain.map((row) => () => ctx.db.delete("files_plain_text_chunks", row._id)),
		...metadata.map((row) => () => ctx.db.delete("files_metadata_docs", row._id)),
	];
	for (let start = 0; start < deletes.length; start += 100)
		await Promise.all(deletes.slice(start, start + 100).map((run) => run()));
	if (stats) await ctx.db.delete("file_stats", stats._id);
	if (node.assetId) {
		const asset = await ctx.db.get("files_r2_assets", node.assetId);
		if (asset?.r2Key) await r2.deleteObject(ctx, asset.r2Key);
		await ctx.db.delete("files_r2_assets", node.assetId);
	}
	await ctx.db.delete("files_nodes", node._id);
}

export const finalize_write = internalMutation({
	args: {
		...run_context_validator,
		stagingId: v.string(),
		files: v.array(v.object({ path: v.string(), content: v.string(), assetId: v.id("files_r2_assets") })),
	},
	returns: v_result({
		_yay: v.object({ written: v.array(written_validator), errors: v.array(file_error_validator), split: v.boolean() }),
		_nay: { data: failure_data_validator },
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_run({ ctx, ...args, route: "/api/v1/volumes/write-many" });
		if (authorized._nay) return authorized;
		const { installation } = authorized._yay;
		const staging = await db_get_staging({ ctx, installation, stagingId: args.stagingId });
		if (staging._nay) return staging;
		const { generation, volume } = staging._yay;
		const usage = await db_get_usage(ctx, installation);
		if (!usage) throw should_never_happen("Volume usage is missing", { installationId: installation._id });
		const ready = [];
		const errors = [];
		let addedCount = 0;
		let bytesDelta = 0;
		let newBytes = 0;
		let readBudget = 0;
		let writeBudget = 0;
		let documents = 0;
		let dailyFilesLeft = await rate_limiter_get_plugin_volume_daily_files_left(ctx, {
			key: daily_key(installation),
			now: Date.now(),
		});
		for (const file of args.files) {
			const bytes = files_get_utf8_byte_size(file.content);
			if (invalid_path(file.path) || invalid_content(file.content))
				return failure({ status: 400, message: "Invalid file", errorCode: "invalid_input" });
			const asset = await ctx.db.get("files_r2_assets", file.assetId);
			if (
				!asset ||
				asset.organizationId !== volume.organizationId ||
				asset.workspaceId !== volume._id ||
				asset.kind !== "content" ||
				asset.createdBy !== users_SYSTEM_AUTHOR ||
				asset.size !== bytes ||
				asset.unfinalizedExpiresAt === undefined ||
				asset.unfinalizedExpiresAt <= Date.now() ||
				asset.r2Key !==
					r2_create_asset_key({ organizationId: volume.organizationId, workspaceId: volume._id, assetId: asset._id })
			)
				return failure({ status: 409, message: "Staged asset is unavailable", errorCode: "staging_unavailable" });
			const checked = await db_check_path({ ctx, volume, generationId: generation._id, path: file.path });
			if (checked._nay) {
				errors.push({ path: file.path, errorCode: "path_conflict", message: checked._nay.message });
				continue;
			}
			const node = checked._yay;
			const added = node ? 0 : 1;
			const delta = bytes - (node?.contentByteSize ?? 0);
			const errorCode =
				generation.fileCount + addedCount + added > LIMITS.copyFiles ||
				generation.bytes + bytesDelta + delta > LIMITS.copyBytes
					? "copy_cap_reached"
					: usage.fileCount + addedCount + added > LIMITS.installationFiles ||
						  usage.bytes + bytesDelta + delta > LIMITS.installationBytes
						? "installation_cap_reached"
						: added > dailyFilesLeft
							? "daily_cap_reached"
							: null;
			if (errorCode) {
				errors.push({ path: file.path, errorCode, message: "Volume file limit reached" });
				continue;
			}
			const old = old_file_budget(node);
			const next = file_budget({
				bytes,
				chunks: files_chunk_plain_text(file.content).length,
				path: `/${generation._id}${file.path}`,
			});
			readBudget += old.bytes;
			writeBudget += next.bytes + old.documents * 160;
			documents += old.documents + next.documents;
			newBytes += bytes;
			addedCount += added;
			bytesDelta += delta;
			dailyFilesLeft -= added;
			ready.push({ ...file, bytes, node });
		}
		// A retry may now see a larger old file. Split before deleting any old content.
		if (
			args.files.length > CHUNK_MAX_FILES ||
			newBytes > CHUNK_MAX_BYTES ||
			readBudget > TRANSACTION_BYTES ||
			writeBudget > TRANSACTION_BYTES ||
			documents > TRANSACTION_DOCUMENTS
		)
			return Result({ _yay: { written: [], errors: [], split: true } });
		const credit = await db_check_credits({ ctx, context: authorized._yay, count: addedCount });
		if (credit._nay) return credit;
		if (addedCount > 0) {
			const daily = await rate_limiter_limit_by_key(ctx, {
				name: "plugins_volume_daily_files",
				key: daily_key(installation),
				count: addedCount,
			});
			if (daily)
				return failure({ status: 409, message: "Daily volume file limit reached", errorCode: "daily_cap_reached" });
		}
		const written = [];
		const billedAssets = [];
		const now = Date.now();
		for (const file of ready) {
			if (file.node) await db_delete_exact_file(ctx, file.node);
			const path = `/${generation._id}${file.path}`;
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: users_SYSTEM_AUTHOR,
				organizationId: volume.organizationId,
				workspaceId: volume._id,
				parentId: files_ROOT_ID,
				path,
				kind: "file",
				contentType: "text/plain",
				assetId: file.assetId,
				expectsTextContent: true,
				metadata: [
					{ key: "source", value: "plugin-volume" },
					{ key: "volume-path", value: file.path.slice(1) },
				],
				now,
			});
			if (created._nay) throw convex_error({ message: created._nay.message });
			await files_nodes_db_insert_file_content_docs(ctx, {
				organizationId: volume.organizationId,
				workspaceId: volume._id,
				nodeId: created._yay,
				path,
				contentType: "text/plain",
				rootKind: "plain_text",
				textContent: file.content,
				readOnly: true,
				userId: users_SYSTEM_AUTHOR,
				now,
			});
			await ctx.db.patch("files_r2_assets", file.assetId, { unfinalizedExpiresAt: undefined, updatedAt: now });
			if (!file.node) billedAssets.push(file.assetId);
			written.push({ path: file.path, bytes: file.bytes });
		}
		await ctx.db.patch("plugins_volume_generations", generation._id, {
			fileCount: generation.fileCount + addedCount,
			bytes: generation.bytes + bytesDelta,
			lastWriteAt: now,
			expiresAt: now + STAGING_TTL_MS,
		});
		await ctx.db.patch("plugins_volume_usage", usage._id, {
			fileCount: usage.fileCount + addedCount,
			bytes: usage.bytes + bytesDelta,
		});
		if (billedAssets.length > 0)
			await billing_db_emit_plugin_volume_file_writes(ctx, {
				billedUser: credit._yay,
				actorUserId: authorized._yay.actor._id,
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				assetIds: billedAssets,
			});
		return Result({ _yay: { written, errors, split: false } });
	},
});

export const cleanup_write = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		volumeId: v.id("plugins_volumes"),
		assets: v.array(v.object({ assetId: v.id("files_r2_assets"), key: v.string() })),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Cleanup remains allowed after revocation or deletion. It only owns unused exact asset keys.
		for (const item of args.assets) {
			if (
				item.key !==
				r2_create_asset_key({ organizationId: args.organizationId, workspaceId: args.volumeId, assetId: item.assetId })
			)
				continue;
			const asset = await ctx.db.get("files_r2_assets", item.assetId);
			if (
				asset &&
				(asset.organizationId !== args.organizationId ||
					asset.workspaceId !== args.volumeId ||
					asset.createdBy !== users_SYSTEM_AUTHOR ||
					asset.unfinalizedExpiresAt === undefined)
			)
				continue;
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_asset", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.volumeId).eq("assetId", item.assetId),
				)
				.first();
			if (node) continue;
			await r2.deleteObject(ctx, item.key);
			if (asset) await ctx.db.delete("files_r2_assets", item.assetId);
		}
		return null;
	},
});

// #endregion registered volume doors

const list_body_validator = z.object({ mountId: z.string().optional() });
const stage_body_validator = z.object({ mountId: z.string(), volumeKey: z.string(), revision: z.string() });
const write_many_body_validator = z.object({
	stagingId: z.string(),
	files: z
		.array(z.object({ path: z.string(), content: z.string() }))
		.min(1)
		.max(100),
});
const publish_body_validator = z.object({ stagingId: z.string() });
const delete_body_validator = z.object({ mountId: z.string(), volumeKey: z.string() });
export type public_api_volumes_http_list_Body = z.infer<typeof list_body_validator>;
export type public_api_volumes_http_stage_Body = z.infer<typeof stage_body_validator>;
export type public_api_volumes_http_write_many_Body = z.infer<typeof write_many_body_validator>;
export type public_api_volumes_http_publish_Body = z.infer<typeof publish_body_validator>;
export type public_api_volumes_http_delete_Body = z.infer<typeof delete_body_validator>;

async function finish_failure(args: {
	ctx: ActionCtx;
	callId: Id<"plugins_event_run_calls">;
	error: { message: string; data?: Infer<typeof failure_data_validator> };
}) {
	const { ctx, error, callId } = args;

	const data = error.data ?? { status: 500 as const, errorCode: "storage_failure" };
	await public_api_settle_plugin_call_best_effort(ctx, {
		callId,
		status: "failed",
		responseStatus: data.status,
		errorCode: data.errorCode,
		errorMessage: error.message,
	});
	return {
		status: data.status,
		body: {
			message: error.message,
			errorCode: data.errorCode,
			...(data.retryAfterMs === undefined ? {} : { retryAfterMs: data.retryAfterMs }),
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

async function finish_response<T>(args: { ctx: ActionCtx; callId: Id<"plugins_event_run_calls">; body: T }) {
	const { ctx, body, callId } = args;

	await public_api_settle_plugin_call_best_effort(ctx, { callId, status: "succeeded", responseStatus: 200 });
	return { status: 200, body, headers: { "Cache-Control": "no-store" } } as const;
}

async function authorize_request<T>(args: {
	ctx: ActionCtx;
	request: Request;
	path: string;
	validator: z.ZodType<T>;
	maxBytes?: number;
}) {
	const { ctx, request, path, validator, maxBytes = 32_000 } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "volumes:write",
		allowedKinds: ["plugin_run"],
		route: path,
	});
	if (auth._nay) return { _nay: { ...auth._nay, headers: { "Cache-Control": "no-store" } } };
	const callId = auth._yay.pluginCallId;
	if (!callId) throw should_never_happen("Volume request has no plugin call", { runId: auth._yay.principal.runId });
	const declaredBytes = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
		return {
			_nay: await finish_failure({
				ctx,
				callId,
				error: failure({ status: 400, message: "Request body is too large", errorCode: "invalid_input" })._nay,
			}),
		};
	let text = "";
	try {
		const reader = request.body?.getReader();
		if (reader) {
			const blocks = [];
			let bytes = 0;
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > maxBytes) {
					await reader.cancel();
					return {
						_nay: await finish_failure({
							ctx,
							callId,
							error: failure({ status: 400, message: "Request body is too large", errorCode: "invalid_input" })._nay,
						}),
					};
				}
				blocks.push(chunk.value);
			}
			const body = new Uint8Array(bytes);
			let offset = 0;
			for (const block of blocks) {
				body.set(block, offset);
				offset += block.byteLength;
			}
			text = new TextDecoder().decode(body);
		}
	} catch {
		return {
			_nay: await finish_failure({
				ctx,
				callId,
				error: failure({ status: 400, message: "Failed to read request body", errorCode: "invalid_input" })._nay,
			}),
		};
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return {
			_nay: await finish_failure({
				ctx,
				callId,
				error: failure({ status: 400, message: "Failed to parse request body as JSON", errorCode: "invalid_input" })
					._nay,
			}),
		};
	}
	const body = validator.safeParse(json);
	if (!body.success)
		return {
			_nay: await finish_failure({
				ctx,
				callId,
				error: failure({ status: 400, message: "Request body validation failed", errorCode: "invalid_input" })._nay,
			}),
		};
	return {
		_yay: {
			context: {
				runId: auth._yay.principal.runId,
				callId,
				tokenHash: await crypto_sha256_hex(auth._yay.presentedToken),
			},
			body: body.data,
		},
	};
}

type list_Result =
	typeof list extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue> ? Awaited<ReturnValue> : never;
type stage_Result =
	typeof stage extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
type publish_Result =
	typeof publish extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
type delete_volume_Result =
	typeof delete_volume extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
type prepare_write_Result =
	typeof prepare_write extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
type finalize_write_Result =
	typeof finalize_write extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export async function public_api_volumes_http_list(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/volumes/list";
}) {
	const { ctx, request, path } = args;

	const auth = await authorize_request({ ctx, request, path, validator: list_body_validator });
	if (auth._nay) return auth._nay;
	const { context, body } = auth._yay;
	try {
		const result = (await ctx.runQuery(internal.public_api_volumes.list, { ...context, ...body })) as list_Result;
		if (result._nay) return await finish_failure({ ctx, callId: context.callId, error: result._nay });
		return await finish_response({ ctx, callId: context.callId, body: result._yay });
	} catch (error) {
		console.error("Failed to list plugin volumes", { error, runId: context.runId });
		return await finish_failure({
			ctx,
			callId: context.callId,
			error: failure({ status: 500, message: "Failed to list volumes", errorCode: "storage_failure" })._nay,
		});
	}
}

export async function public_api_volumes_http_stage(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/volumes/stage";
}) {
	const { ctx, request, path } = args;

	const auth = await authorize_request({ ctx, request, path, validator: stage_body_validator });
	if (auth._nay) return auth._nay;
	const { context, body } = auth._yay;
	try {
		const result = (await ctx.runMutation(internal.public_api_volumes.stage, { ...context, ...body })) as stage_Result;
		if (result._nay) return await finish_failure({ ctx, callId: context.callId, error: result._nay });
		return await finish_response({ ctx, callId: context.callId, body: result._yay });
	} catch (error) {
		console.error("Failed to stage plugin volume", { error, runId: context.runId });
		return await finish_failure({
			ctx,
			callId: context.callId,
			error: failure({ status: 500, message: "Failed to stage volume", errorCode: "storage_failure" })._nay,
		});
	}
}

export async function public_api_volumes_http_publish(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/volumes/publish";
}) {
	const { ctx, request, path } = args;

	const auth = await authorize_request({ ctx, request, path, validator: publish_body_validator });
	if (auth._nay) return auth._nay;
	const { context, body } = auth._yay;
	try {
		const result = (await ctx.runMutation(internal.public_api_volumes.publish, {
			...context,
			...body,
		})) as publish_Result;
		if (result._nay) return await finish_failure({ ctx, callId: context.callId, error: result._nay });
		return await finish_response({ ctx, callId: context.callId, body: result._yay });
	} catch (error) {
		console.error("Failed to publish plugin volume", { error, runId: context.runId });
		return await finish_failure({
			ctx,
			callId: context.callId,
			error: failure({ status: 500, message: "Failed to publish volume", errorCode: "storage_failure" })._nay,
		});
	}
}

export async function public_api_volumes_http_delete(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/volumes/delete";
}) {
	const { ctx, request, path } = args;

	const auth = await authorize_request({ ctx, request, path, validator: delete_body_validator });
	if (auth._nay) return auth._nay;
	const { context, body } = auth._yay;
	try {
		const result = (await ctx.runMutation(internal.public_api_volumes.delete_volume, {
			...context,
			...body,
		})) as delete_volume_Result;
		if (result._nay) return await finish_failure({ ctx, callId: context.callId, error: result._nay });
		return await finish_response({ ctx, callId: context.callId, body: result._yay });
	} catch (error) {
		console.error("Failed to delete plugin volume", { error, runId: context.runId });
		return await finish_failure({
			ctx,
			callId: context.callId,
			error: failure({ status: 500, message: "Failed to delete volume", errorCode: "storage_failure" })._nay,
		});
	}
}

export async function public_api_volumes_http_write_many(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/volumes/write-many";
}) {
	const { ctx, request, path } = args;

	const auth = await authorize_request({
		ctx,
		request,
		path,
		validator: write_many_body_validator,
		maxBytes: 8_000_000,
	});
	if (auth._nay) return auth._nay;
	const { context, body } = auth._yay;
	const paths = body.files.map((file) => file.path).sort();
	if (
		new Set(paths).size !== paths.length ||
		paths.some((item) => paths.some((parent) => item !== parent && item.startsWith(`${parent}/`)))
	)
		return await finish_failure({
			ctx,
			callId: context.callId,
			error: failure({
				status: 400,
				message: "Paths must be unique and cannot contain another file path",
				errorCode: "invalid_input",
			})._nay,
		});
	const errors: Array<Infer<typeof file_error_validator>> = [];
	const valid: Array<{ path: string; content: string; bytes: number; chunkCount: number }> = [];
	for (const file of body.files) {
		const code = invalid_path(file.path) ? "invalid_path" : invalid_content(file.content) ? "invalid_content" : null;
		if (code)
			errors.push({
				path: file.path,
				errorCode: code,
				message: code === "invalid_path" ? "Invalid volume file path" : "Invalid volume file content",
			});
		else
			valid.push({
				...file,
				bytes: files_get_utf8_byte_size(file.content),
				chunkCount: files_chunk_plain_text(file.content).length,
			});
	}
	const written: Array<Infer<typeof written_validator>> = [];
	let prepared: NonNullable<prepare_write_Result["_yay"]> | null = null;
	try {
		const preparation = (await ctx.runMutation(internal.public_api_volumes.prepare_write, {
			...context,
			stagingId: body.stagingId,
			requestFileCount: body.files.length,
			files: valid.map(({ path: filePath, bytes, chunkCount }) => ({ path: filePath, bytes, chunkCount })),
		})) as prepare_write_Result;
		if (preparation._nay) return await finish_failure({ ctx, callId: context.callId, error: preparation._nay });
		prepared = preparation._yay;
		errors.push(...prepared.errors);
		const uploadFailures = new Set<Id<"files_r2_assets">>();
		for (let start = 0; start < prepared.files.length; start += 16) {
			const group = prepared.files.slice(start, start + 16);
			const results = await Promise.allSettled(
				group.map((item) =>
					r2_put_object(ctx, {
						key: item.key,
						body: valid.find((file) => file.path === item.path)!.content,
						contentType: "text/plain",
					}),
				),
			);
			for (const [index, result] of results.entries())
				if (result.status === "rejected") {
					uploadFailures.add(group[index]!.assetId);
					errors.push({
						path: group[index]!.path,
						errorCode: "storage_failure",
						message: "Failed to store volume file",
					});
				}
		}
		const pending = prepared.files.filter((item) => !uploadFailures.has(item.assetId));
		const chunks: (typeof pending)[] = [];
		let chunk: typeof pending = [];
		let bytes = 0;
		let reads = 0;
		let writes = 0;
		let documents = 0;
		for (const item of pending) {
			const next = file_budget({
				bytes: item.bytes,
				chunks: item.chunkCount,
				path: `/${prepared.generationId}${item.path}`,
			});
			if (
				chunk.length > 0 &&
				(chunk.length >= CHUNK_MAX_FILES ||
					bytes + item.bytes > CHUNK_MAX_BYTES ||
					reads + item.oldBytes > TRANSACTION_BYTES ||
					writes + next.bytes + item.oldDocuments * 160 > TRANSACTION_BYTES ||
					documents + item.oldDocuments + next.documents > TRANSACTION_DOCUMENTS)
			) {
				chunks.push(chunk);
				chunk = [];
				bytes = 0;
				reads = 0;
				writes = 0;
				documents = 0;
			}
			chunk.push(item);
			bytes += item.bytes;
			reads += item.oldBytes;
			writes += next.bytes + item.oldDocuments * 160;
			documents += item.oldDocuments + next.documents;
		}
		if (chunk.length > 0) chunks.push(chunk);
		while (chunks.length > 0) {
			const next = chunks.shift()!;
			const result = (await ctx.runMutation(internal.public_api_volumes.finalize_write, {
				...context,
				stagingId: body.stagingId,
				files: next.map((item) => ({
					path: item.path,
					content: valid.find((file) => file.path === item.path)!.content,
					assetId: item.assetId,
				})),
			})) as finalize_write_Result;
			if (result._nay) return await finish_failure({ ctx, callId: context.callId, error: result._nay });
			if (result._yay.split) {
				if (next.length === 1) throw new Error("One volume file exceeded the transaction budget");
				const middle = Math.ceil(next.length / 2);
				chunks.unshift(next.slice(0, middle), next.slice(middle));
				continue;
			}
			written.push(...result._yay.written);
			errors.push(...result._yay.errors);
		}
		return await finish_response({ ctx, callId: context.callId, body: { written, errors } });
	} catch (error) {
		console.error("Failed to write plugin volume", { error, runId: context.runId });
		return await finish_failure({
			ctx,
			callId: context.callId,
			error: failure({ status: 500, message: "Failed to write volume files", errorCode: "storage_failure" })._nay,
		});
	} finally {
		if (prepared) {
			try {
				await ctx.runMutation(internal.public_api_volumes.cleanup_write, {
					organizationId: prepared.organizationId,
					volumeId: prepared.volumeId,
					assets: prepared.files.map(({ assetId, key }) => ({ assetId, key })),
				});
			} catch (error) {
				console.warn("Failed to clean unused volume assets", { error, runId: context.runId });
			}
		}
	}
}
