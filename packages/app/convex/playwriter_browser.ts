import { v, type Infer } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { browser_web_normalize_url } from "common/browser-web-url.ts";
import type { PlaywriterBrowserRuntime } from "common/playwriter-browser.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import app_schema, {
	ai_chat_workspaces_source_validator,
	ai_chat_browser_source_validator,
	ai_chat_run_fence_validator,
	ai_chat_browser_resource_validator,
	ai_chat_browser_result_validator,
	browser_intent_validator,
} from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import {
	crypto_decrypt_secret_value,
	crypto_encrypt_secret_value,
	crypto_hmac_sha256_hex,
} from "../server/crypto-utils.ts";
import { playwriter_runner_call } from "../server/playwriter-browser.ts";
import { playwriter_parse_share } from "../shared/playwriter-browser.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import {
	files_browser_action_set_choice,
	files_browser_db_get_preferences,
	files_browser_db_check_agent_intent,
} from "./files_browser.ts";
import {
	ai_chat_files_db_authorize_file_output,
	ai_chat_files_db_begin_browser_invocation,
	ai_chat_files_db_finish_browser_invocation,
} from "./ai_chat_files.ts";
import {
	files_ingestion_db_finalize_file,
	files_ingestion_db_prepare_file,
	files_ingestion_file_validator,
	files_ingestion_finalize_args_validator,
	files_ingestion_prepare_args_validator,
	files_ingestion_prepare_result_validator,
	files_ingestion_scope_validator,
} from "./files_ingestion.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

const IDLE_MS = 10 * 60 * 1000;
const TOTAL_MS = 60 * 60 * 1000;
const KEY_NAME = "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY";

const runtime_validator = v.object({
	generation: v.number(),
	state: v.union(
		v.literal("connecting"),
		v.literal("awaiting_confirmation"),
		v.literal("connected"),
		v.literal("paused"),
		v.literal("needs_human"),
		v.literal("expired"),
		v.literal("disconnected"),
		v.literal("failed"),
	),
	targets: v.array(v.object({ targetId: v.string(), title: v.string(), url: v.string() })),
	confirmedTargetId: v.union(v.string(), v.null()),
	targetRevision: v.number(),
	inventoryRevision: v.number(),
	navRevision: v.number(),
	controlRevision: v.number(),
	policyRevision: v.number(),
	selectionRevision: v.number(),
	agentAccess: v.boolean(),
	operations: v.number(),
	idleExpiresAt: v.number(),
	totalExpiresAt: v.number(),
	sessionId: v.string(),
});

const public_target_validator = v.object({ handle: v.string(), title: v.string(), url: v.string() });
const connection_result_validator = v_result({ _yay: v.object({ connectionId: v.id("playwriter_connections") }) });

function allowed_versions() {
	return (process.env.BROWSER_PLAYWRITER_ALLOWED_VERSIONS ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length <= 32 && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(item))
		.slice(0, 16);
}

function enabled() {
	return (
		process.env.AI_CHAT_BROWSER_ENABLED === "true" &&
		process.env.AI_CHAT_PLAYWRITER_ENABLED === "true" &&
		Boolean(process.env.BROWSER_RUNNER_URL && process.env.BROWSER_RUNNER_SECRET && process.env[KEY_NAME]) &&
		allowed_versions().length > 0
	);
}

async function member(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> },
	use: boolean,
) {
	const user = await ctx.db.get("users", args.userId);
	if (!user || user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthenticated" } });

	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) return Result({ _nay: { message: "Unauthorized" } });

	const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
	if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined)
		return Result({ _nay: { message: "Unauthorized" } });

	if (use) {
		const allowed = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: "workspace.browser.use",
		});
		if (allowed._nay) return allowed;
	}

	return Result({ _yay: membership });
}

async function connection_access(ctx: QueryCtx | MutationCtx, connection: Doc<"playwriter_connections">, use: boolean) {
	const checked = await member(ctx, { userId: connection.ownerId, membershipId: connection.membershipId }, use);
	if (checked._nay) return checked;
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, {
		userId: connection.ownerId,
		workspaceId: connection.workspaceId,
	});
	if (
		!lifetime?.active ||
		lifetime.lifetime !== connection.membershipLifetime ||
		lifetime.membershipId !== connection.membershipId ||
		checked._yay.organizationId !== connection.organizationId ||
		checked._yay.workspaceId !== connection.workspaceId
	) {
		return Result({ _nay: { message: "Unauthorized" } });
	}
	return checked;
}

async function current_user(ctx: ActionCtx | QueryCtx) {
	const auth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!auth) throw convex_error({ message: "Unauthenticated" });
	return auth.id;
}

function scope(connection: Doc<"playwriter_connections">) {
	return {
		connectionId: connection._id,
		ownerId: connection.ownerId,
		organizationId: connection.organizationId,
		workspaceId: connection.workspaceId,
	};
}

function secret_scope(connection: Doc<"playwriter_connections">) {
	return JSON.stringify([
		"playwriter-share",
		connection._id,
		connection.ownerId,
		connection.organizationId,
		connection.workspaceId,
	]);
}

function target_url(value: string) {
	if (value === "about:blank") return value;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
	} catch {
		return "";
	}
}

export const remote_browser_available = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.object({ enabled: v.boolean(), hasSavedConnection: v.boolean() }),
	handler: async (ctx, args) => {
		const userId = await current_user(ctx);
		const checked = await member(ctx, { ...args, userId }, false);
		if (checked._nay) {
			if (checked._nay.message === "Unauthenticated") throw convex_error(checked._nay);
			return { enabled: false, hasSavedConnection: false };
		}
		const saved = await ctx.db
			.query("playwriter_connections")
			.withIndex("by_owner_organization_workspace", (q) =>
				q
					.eq("ownerId", userId)
					.eq("organizationId", checked._yay.organizationId)
					.eq("workspaceId", checked._yay.workspaceId),
			)
			.order("desc")
			.first();
		const allowed = await member(ctx, { ...args, userId }, true);
		return { enabled: enabled() && !allowed._nay, hasSavedConnection: Boolean(saved?.encryptedShareId) };
	},
});

export const current_connection = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(
		v.null(),
		v.object({
			connectionId: v.id("playwriter_connections"),
			connectionGeneration: v.number(),
			controlRevision: v.number(),
			state: app_schema.tables.playwriter_connections.validator.fields.state,
			target: v.union(public_target_validator, v.null()),
			targets: v.array(public_target_validator),
			idleExpiresAt: v.number(),
			totalExpiresAt: v.union(v.number(), v.null()),
			pauseReason: v.union(v.string(), v.null()),
			operations: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const userId = await current_user(ctx);
		const checked = await member(ctx, { ...args, userId }, false);
		if (checked._nay) {
			if (checked._nay.message === "Unauthenticated") throw convex_error(checked._nay);
			return null;
		}
		const connection = await ctx.db
			.query("playwriter_connections")
			.withIndex("by_owner_organization_workspace", (q) =>
				q
					.eq("ownerId", userId)
					.eq("organizationId", checked._yay.organizationId)
					.eq("workspaceId", checked._yay.workspaceId),
			)
			.order("desc")
			.first();
		if (!connection) return null;
		const targets = connection.targets.map(({ handle, title, url }) => ({ handle, title, url }));
		return {
			connectionId: connection._id,
			connectionGeneration: connection.connectionGeneration,
			controlRevision: connection.controlRevision,
			state: connection.state,
			target: targets.find((target) => target.handle === connection.confirmedTargetHandle) ?? null,
			targets,
			idleExpiresAt: connection.idleExpiresAt,
			totalExpiresAt: connection.totalExpiresAt,
			pauseReason: connection.pauseReason,
			operations: connection.operations,
		};
	},
});

export const load_connection = internalQuery({
	args: {
		connectionId: v.id("playwriter_connections"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		requireBrowserPermission: v.optional(v.boolean()),
	},
	returns: v_result({ _yay: doc(app_schema, "playwriter_connections") }),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		if (!connection || connection.ownerId !== args.userId || connection.membershipId !== args.membershipId)
			return Result({ _nay: { message: "Not found" } });
		const allowed = await connection_access(ctx, connection, args.requireBrowserPermission === true);
		return allowed._nay ? allowed : Result({ _yay: connection });
	},
});
type load_connection_Result =
	typeof load_connection extends RegisteredQuery<infer _V, infer _A, infer R> ? Awaited<R> : never;

/**
 * Forget the credential first. Socket cleanup can retry without the source docs.
 */
export async function playwriter_browser_db_disconnect(
	ctx: MutationCtx,
	connection: Doc<"playwriter_connections">,
	reason: string,
) {
	if (
		!connection.encryptedShareId &&
		!connection.active &&
		(connection.state === "closing" || connection.state === "closed")
	)
		return;
	await ctx.db.patch("playwriter_connections", connection._id, {
		encryptedShareId: null,
		shareNonce: null,
		linkFingerprint: null,
		active: false,
		state: "closing",
		pauseReason: reason,
		controlRevision: connection.controlRevision + 1,
		connectAttemptId: crypto.randomUUID(),
		targets: [],
		updatedAt: Date.now(),
	});
	const preference = await ctx.db
		.query("files_browser_preferences")
		.withIndex("by_owner_organization_workspace", (q) =>
			q
				.eq("ownerId", connection.ownerId)
				.eq("organizationId", connection.organizationId)
				.eq("workspaceId", connection.workspaceId),
		)
		.first();
	if (
		preference?.webChoice.provider === "playwriter" &&
		preference.webChoice.connectionId === connection._id &&
		preference.webChoice.confirmedTargetHandle === connection.confirmedTargetHandle
	) {
		await ctx.db.patch("files_browser_preferences", preference._id, {
			webChoice: { provider: "none" },
			selectionRevision: preference.selectionRevision + 1,
			updatedAt: Date.now(),
		});
	}
	const cleanup = await ctx.db
		.query("playwriter_connection_cleanups")
		.withIndex("by_connectionId", (q) => q.eq("connectionId", connection._id))
		.first();
	if (cleanup)
		await ctx.db.patch("playwriter_connection_cleanups", cleanup._id, {
			forgetCredential: true,
			nextAttemptAt: Date.now(),
		});
	else
		await ctx.db.insert("playwriter_connection_cleanups", {
			...scope(connection),
			generation: connection.connectionGeneration,
			forgetCredential: true,
			attempts: 0,
			nextAttemptAt: Date.now(),
		});
	await ctx.scheduler.runAfter(0, internal.playwriter_browser.process_cleanups, {});
}

/**
 * Capacity stays held while cleanup is pending, even after the connection doc is gone.
 */
async function occupied_connections(ctx: MutationCtx, excludedId?: Id<"playwriter_connections">) {
	const active = await ctx.db
		.query("playwriter_connections")
		.withIndex("by_active", (q) => q.eq("active", true))
		.take(11);
	const connections = new Map(
		active
			.filter((connection) => connection._id !== excludedId)
			.map(
				(connection) =>
					[
						String(connection._id),
						{
							ownerId: connection.ownerId,
							organizationId: connection.organizationId,
							workspaceId: connection.workspaceId,
						},
					] as const,
			),
	);
	let previousId: string | undefined;
	// Skip duplicate jobs for each ID. Ten slots plus the replaced ID bound this read.
	while (connections.size < 10) {
		const cleanup = await ctx.db
			.query("playwriter_connection_cleanups")
			.withIndex("by_connectionId", (q) => (previousId === undefined ? q : q.gt("connectionId", previousId)))
			.first();
		if (!cleanup) break;
		previousId = cleanup.connectionId;
		if (cleanup.connectionId !== excludedId)
			connections.set(cleanup.connectionId, {
				ownerId: cleanup.ownerId,
				organizationId: cleanup.organizationId,
				workspaceId: cleanup.workspaceId,
			});
	}
	return [...connections.values()];
}

export const prepare_connect = internalMutation({
	args: { userId: v.id("users"), membershipId: v.id("organizations_workspaces_users"), linkFingerprint: v.string() },
	returns: v_result({ _yay: v.object({ connection: doc(app_schema, "playwriter_connections"), reused: v.boolean() }) }),
	handler: async (ctx, args) => {
		if (!enabled()) return Result({ _nay: { message: "Browser unavailable" } });

		const checked = await member(ctx, args, true);
		if (checked._nay) return checked;

		const now = Date.now();
		if (!/^[a-f0-9]{64}$/.test(args.linkFingerprint))
			return Result({ _nay: { message: "Invalid browser link", name: "invalid_share" } });

		const reserved = await ctx.db
			.query("playwriter_connections")
			.withIndex("by_linkFingerprint", (q) => q.eq("linkFingerprint", args.linkFingerprint))
			.first();
		if (reserved && reserved.idleExpiresAt > now) {
			if (
				reserved.ownerId === args.userId &&
				reserved.organizationId === checked._yay.organizationId &&
				reserved.workspaceId === checked._yay.workspaceId &&
				reserved.encryptedShareId
			)
				return Result({ _yay: { connection: reserved, reused: true } });
			return Result({
				_nay: {
					message: "This browser link is already connected. Disconnect its current connection first.",
					name: "link_reserved",
				},
			});
		}
		if (reserved) await playwriter_browser_db_disconnect(ctx, reserved, "idle_expired");

		const existing = await ctx.db
			.query("playwriter_connections")
			.withIndex("by_owner_organization_workspace", (q) =>
				q
					.eq("ownerId", args.userId)
					.eq("organizationId", checked._yay.organizationId)
					.eq("workspaceId", checked._yay.workspaceId),
			)
			.order("desc")
			.first();
		if (existing?.encryptedShareId || existing?.active || existing?.state === "closing")
			return Result({ _nay: { message: "Disconnect the current browser and wait for it to finish.", name: "busy" } });

		const limit = await rate_limiter_limit_by_key(ctx, { name: "playwriter_connect", key: args.userId });
		if (limit) return Result({ _nay: { message: limit.message, name: "rate_limit" } });

		const day = new Date(now).toISOString().slice(0, 10);
		const daily = await ctx.db
			.query("playwriter_user_daily_use")
			.withIndex("by_user_day", (q) => q.eq("userId", args.userId).eq("day", day))
			.first();
		if ((daily?.starts ?? 0) >= 50)
			return Result({ _nay: { message: "Daily browser connection limit reached.", name: "limit" } });

		const active = await occupied_connections(ctx);
		if (
			active.length >= 10 ||
			active.filter((item) => item.ownerId === args.userId).length >= 2 ||
			active.filter((item) => item.workspaceId === checked._yay.workspaceId).length >= 2 ||
			active.filter((item) => item.organizationId === checked._yay.organizationId).length >= 4
		) {
			return Result({ _nay: { message: "Browser connection limit reached.", name: "limit" } });
		}

		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, checked._yay);
		const id = await ctx.db.insert("playwriter_connections", {
			ownerId: args.userId,
			organizationId: checked._yay.organizationId,
			workspaceId: checked._yay.workspaceId,
			membershipId: checked._yay._id,
			membershipLifetime,
			encryptedShareId: null,
			shareNonce: null,
			linkFingerprint: args.linkFingerprint,
			state: "connecting",
			connectionGeneration: 0,
			controlRevision: 0,
			targetRevision: 0,
			inventoryRevision: 0,
			navRevision: 0,
			confirmedTargetId: null,
			confirmedTargetHandle: null,
			targets: [],
			pauseReason: null,
			connectAttemptId: crypto.randomUUID(),
			sessionId: crypto.randomUUID(),
			operations: 0,
			idleExpiresAt: now + IDLE_MS,
			totalExpiresAt: now + TOTAL_MS,
			unresolvedCommand: null,
			pendingAcknowledgement: null,
			createdAt: now,
			updatedAt: now,
			active: true,
		});

		if (daily) await ctx.db.patch("playwriter_user_daily_use", daily._id, { starts: daily.starts + 1 });
		else await ctx.db.insert("playwriter_user_daily_use", { userId: args.userId, day, starts: 1 });
		await ctx.scheduler.runAt(now + IDLE_MS, internal.playwriter_browser.sweep_connections, {});

		return Result({ _yay: { connection: (await ctx.db.get("playwriter_connections", id))!, reused: false } });
	},
});
type prepare_connect_Result =
	typeof prepare_connect extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const store_credential = internalMutation({
	args: {
		connectionId: v.id("playwriter_connections"),
		attemptId: v.string(),
		encryptedShareId: v.bytes(),
		shareNonce: v.bytes(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		if (!connection?.active || connection.connectAttemptId !== args.attemptId || connection.idleExpiresAt <= Date.now())
			return false;
		await ctx.db.patch("playwriter_connections", connection._id, {
			encryptedShareId: args.encryptedShareId,
			shareNonce: args.shareNonce,
		});
		return true;
	},
});

export const commit_runtime = internalMutation({
	args: {
		connectionId: v.id("playwriter_connections"),
		attemptId: v.string(),
		expectedControlRevision: v.number(),
		runtime: runtime_validator,
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		if (
			!connection?.active ||
			connection.connectAttemptId !== args.attemptId ||
			connection.controlRevision !== args.expectedControlRevision ||
			connection.idleExpiresAt <= Date.now()
		)
			return false;
		const allowed = await connection_access(ctx, connection, false);
		if (allowed._nay) return false;
		if (
			args.runtime.generation < connection.connectionGeneration ||
			args.runtime.sessionId !== connection.sessionId ||
			args.runtime.controlRevision !== connection.controlRevision ||
			(args.runtime.generation === connection.connectionGeneration &&
				(args.runtime.targetRevision < connection.targetRevision ||
					args.runtime.navRevision < connection.navRevision ||
					args.runtime.inventoryRevision < connection.inventoryRevision))
		)
			return false;
		const targets = args.runtime.targets.slice(0, 64).map((target) => ({
			targetId: target.targetId,
			handle:
				connection.targets.find((existing) => existing.targetId === target.targetId)?.handle ?? crypto.randomUUID(),
			title: target.title.slice(0, 256),
			url: target_url(target.url),
		}));
		const confirmed = targets.find((target) => target.targetId === args.runtime.confirmedTargetId);
		const states = {
			connecting: "connecting",
			awaiting_confirmation: "needs_confirmation",
			connected: "ready",
			paused: "paused",
			needs_human: "needs_human",
			expired: "limit_reached",
			disconnected: "offline",
			failed: "offline",
		} as const;
		await ctx.db.patch("playwriter_connections", connection._id, {
			connectionGeneration: args.runtime.generation,
			// A newer runner generation no longer holds the old receipt.
			pendingAcknowledgement:
				connection.pendingAcknowledgement && args.runtime.generation > connection.pendingAcknowledgement.generation
					? null
					: connection.pendingAcknowledgement,
			state:
				connection.pauseReason === "human" && ["connected", "paused"].includes(args.runtime.state)
					? "paused"
					: states[args.runtime.state],
			pauseReason:
				connection.pauseReason === "human" || args.runtime.state !== "connected" ? connection.pauseReason : null,
			targets,
			confirmedTargetId: args.runtime.confirmedTargetId,
			confirmedTargetHandle: confirmed?.handle ?? connection.confirmedTargetHandle,
			targetRevision: args.runtime.targetRevision,
			navRevision: args.runtime.navRevision,
			inventoryRevision: args.runtime.inventoryRevision,
			operations: Math.max(connection.operations, args.runtime.operations),
			updatedAt: Date.now(),
		});
		return true;
	},
});

async function mirror(ctx: ActionCtx, connection: Doc<"playwriter_connections">, runtime: PlaywriterBrowserRuntime) {
	return await ctx.runMutation(internal.playwriter_browser.commit_runtime, {
		connectionId: connection._id,
		attemptId: connection.connectAttemptId,
		expectedControlRevision: connection.controlRevision,
		runtime,
	});
}

export const get_preferences = internalQuery({
	args: { userId: v.id("users"), organizationId: v.id("organizations"), workspaceId: v.id("organizations_workspaces") },
	returns: v.object({
		webAgentAccess: v.boolean(),
		agentBlockedHosts: v.array(v.string()),
		policyRevision: v.number(),
		selectionRevision: v.number(),
	}),
	handler: async (ctx, args) => {
		const preferences = await files_browser_db_get_preferences(ctx, args);
		return {
			webAgentAccess: preferences.webAgentAccess,
			agentBlockedHosts: preferences.agentBlockedHosts,
			policyRevision: preferences.policyRevision,
			selectionRevision: preferences.selectionRevision,
		};
	},
});

async function dial(
	ctx: ActionCtx,
	connection: Doc<"playwriter_connections">,
	shareId: string,
	transition: { route: "connect" | "recover" } | { route: "reconnect"; previousSessionId: string },
	timeoutMs = 15_000,
) {
	const preference = await ctx.runQuery(internal.playwriter_browser.get_preferences, {
		userId: connection.ownerId,
		organizationId: connection.organizationId,
		workspaceId: connection.workspaceId,
	});
	// Check after the decrypt and preference reads. Older attempts cannot dial.
	const current = (await ctx.runQuery(internal.playwriter_browser.load_connection, {
		connectionId: connection._id,
		userId: connection.ownerId,
		membershipId: connection.membershipId,
		requireBrowserPermission: true,
	})) as load_connection_Result;
	if (current._nay) return current;
	if (
		!current._yay.active ||
		current._yay.connectAttemptId !== connection.connectAttemptId ||
		current._yay.sessionId !== connection.sessionId ||
		current._yay.controlRevision !== connection.controlRevision ||
		current._yay.connectionGeneration !== connection.connectionGeneration ||
		current._yay.confirmedTargetId !== connection.confirmedTargetId ||
		current._yay.confirmedTargetHandle !== connection.confirmedTargetHandle ||
		current._yay.targetRevision !== connection.targetRevision ||
		current._yay.navRevision !== connection.navRevision
	)
		return Result({ _nay: { message: "Browser connection changed", name: "stale" } });
	// The saved link may outlast this session.
	const totalExpiresAt = connection.totalExpiresAt ?? Date.now() + TOTAL_MS;
	const response = await playwriter_runner_call({
		route: transition.route,
		timeoutMs,
		body: {
			...scope(connection),
			...(transition.route === "reconnect" ? { previousSessionId: transition.previousSessionId } : {}),
			shareId,
			attemptId: connection.connectAttemptId,
			expectedTargetId: connection.confirmedTargetId,
			paused: connection.pauseReason === "human",
			agentAccess: preference.webAgentAccess,
			agentBlockedHosts: preference.agentBlockedHosts,
			policyRevision: preference.policyRevision,
			selectionRevision: preference.selectionRevision,
			controlRevision: connection.controlRevision,
			sessionId: connection.sessionId,
			idleExpiresAt: Math.min(connection.idleExpiresAt, totalExpiresAt),
			totalExpiresAt,
			operations: connection.operations,
			allowedVersions: allowed_versions(),
		},
	});
	if (response._nay) return response;
	const committed = await mirror(ctx, connection, response._yay.runtime);
	if (!committed) {
		await playwriter_runner_call({
			route: "disconnect",
			body: { ...scope(connection), generation: response._yay.runtime.generation },
		});
		return Result({ _nay: { message: "Browser connection changed", name: "stale" } });
	}
	return Result({ _yay: { connectionId: connection._id } });
}

export const connect_tab = action({
	args: { membershipId: v.id("organizations_workspaces_users"), share: v.string() },
	returns: connection_result_validator,
	handler: async (ctx, args) => {
		const userId = await current_user(ctx);
		const shareId = playwriter_parse_share(args.share);
		if (!shareId || args.share.length > 256)
			return Result({
				_nay: { message: "Paste the Playwriter ID or its official share link.", name: "invalid_share" },
			});
		if (!enabled()) return Result({ _nay: { message: "Browser unavailable" } });
		const linkFingerprint = await crypto_hmac_sha256_hex(shareId, "playwriter-link", KEY_NAME);
		const prepared = (await ctx.runMutation(internal.playwriter_browser.prepare_connect, {
			userId,
			membershipId: args.membershipId,
			linkFingerprint,
		})) as prepare_connect_Result;
		if (prepared._nay) return prepared;
		const connection = prepared._yay.connection;
		if (prepared._yay.reused) return Result({ _yay: { connectionId: connection._id } });
		try {
			const encrypted = await crypto_encrypt_secret_value(shareId, secret_scope(connection), KEY_NAME);
			const stored = await ctx.runMutation(internal.playwriter_browser.store_credential, {
				connectionId: connection._id,
				attemptId: connection.connectAttemptId,
				encryptedShareId: encrypted.ciphertext,
				shareNonce: encrypted.nonce,
			});
			if (!stored) return Result({ _nay: { message: "Browser connection changed", name: "stale" } });
			const connected = await dial(ctx, connection, shareId, { route: "connect" });
			if (connected._nay)
				await ctx.runMutation(internal.playwriter_browser.forget_connection, {
					connectionId: connection._id,
					userId,
					attemptId: connection.connectAttemptId,
					controlRevision: connection.controlRevision,
					reason: "connect_failed",
				});
			return connected;
		} catch {
			await ctx.runMutation(internal.playwriter_browser.forget_connection, {
				connectionId: connection._id,
				userId,
				attemptId: connection.connectAttemptId,
				controlRevision: connection.controlRevision,
				reason: "connect_failed",
			});
			return Result({ _nay: { message: "The browser connection could not finish.", name: "connect_failed" } });
		}
	},
});

export const forget_connection = internalMutation({
	args: {
		connectionId: v.id("playwriter_connections"),
		userId: v.id("users"),
		attemptId: v.string(),
		controlRevision: v.number(),
		reason: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		if (
			!connection ||
			connection.ownerId !== args.userId ||
			connection.connectAttemptId !== args.attemptId ||
			connection.controlRevision !== args.controlRevision
		)
			return false;
		await playwriter_browser_db_disconnect(ctx, connection, args.reason);
		return true;
	},
});
type forget_connection_Result =
	typeof forget_connection extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const prepare_control = internalMutation({
	args: {
		connectionId: v.id("playwriter_connections"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		operation: v.union(
			v.literal("pause"),
			v.literal("reconnect"),
			v.literal("disconnect"),
			v.object({ kind: v.literal("resume"), connectionGeneration: v.number(), controlRevision: v.number() }),
		),
	},
	returns: v_result({ _yay: doc(app_schema, "playwriter_connections") }),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		if (!connection || connection.ownerId !== args.userId || connection.membershipId !== args.membershipId)
			return Result({ _nay: { message: "Not found" } });
		const operation = typeof args.operation === "string" ? args.operation : args.operation.kind;
		// An old Resume must leave a newer Pause in place.
		if (
			typeof args.operation !== "string" &&
			(connection.connectionGeneration !== args.operation.connectionGeneration ||
				connection.controlRevision !== args.operation.controlRevision)
		)
			return Result({ _nay: { message: "The browser control changed. Check it and try again.", name: "stale" } });
		if (operation === "disconnect") {
			const user = await ctx.db.get("users", args.userId);
			if (!user || user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthenticated" } });
			await playwriter_browser_db_disconnect(ctx, connection, "disconnected");
			return Result({ _yay: connection });
		}
		const checked = await connection_access(ctx, connection, operation !== "pause");
		if (checked._nay) return checked;
		if (operation !== "pause" && !enabled()) return Result({ _nay: { message: "Browser unavailable" } });
		if (!connection.encryptedShareId || !connection.shareNonce || connection.idleExpiresAt <= Date.now())
			return Result({ _nay: { message: "The browser link expired. Connect again.", name: "expired" } });
		if (operation === "pause" && !connection.active)
			return Result({ _nay: { message: "Reconnect the browser before pausing.", name: "needs_human" } });
		if (operation === "resume" && (!connection.active || connection.state !== "paused"))
			return Result({ _nay: { message: "Reconnect the browser before resuming.", name: "needs_human" } });
		if (operation === "reconnect") {
			if (connection.unresolvedCommand)
				return Result({ _nay: { message: "The last browser command is still settling.", name: "busy" } });
			if (
				await ctx.db
					.query("playwriter_connection_cleanups")
					.withIndex("by_connectionId", (q) => q.eq("connectionId", connection._id))
					.first()
			)
				return Result({ _nay: { message: "The last browser session is still closing.", name: "busy" } });
			const rate = await rate_limiter_limit_by_key(ctx, { name: "playwriter_connect", key: args.userId });
			if (rate) return Result({ _nay: { message: rate.message, name: "rate_limit" } });
			const now = Date.now();
			const day = new Date(now).toISOString().slice(0, 10);
			const daily = await ctx.db
				.query("playwriter_user_daily_use")
				.withIndex("by_user_day", (q) => q.eq("userId", args.userId).eq("day", day))
				.first();
			if ((daily?.starts ?? 0) >= 50)
				return Result({ _nay: { message: "Daily browser connection limit reached.", name: "limit" } });
			const newSession = !connection.active || connection.operations >= 120 || (connection.totalExpiresAt ?? 0) <= now;
			if (newSession) {
				const active = await occupied_connections(ctx, connection._id);
				if (
					active.length >= 10 ||
					active.filter((item) => item.ownerId === connection.ownerId).length >= 2 ||
					active.filter((item) => item.workspaceId === connection.workspaceId).length >= 2 ||
					active.filter((item) => item.organizationId === connection.organizationId).length >= 4
				)
					return Result({ _nay: { message: "Browser connection limit reached.", name: "limit" } });
			}
			if (daily) await ctx.db.patch("playwriter_user_daily_use", daily._id, { starts: daily.starts + 1 });
			else await ctx.db.insert("playwriter_user_daily_use", { userId: args.userId, day, starts: 1 });
			await ctx.db.patch("playwriter_connections", connection._id, {
				state: "recovering",
				active: true,
				connectAttemptId: crypto.randomUUID(),
				updatedAt: now,
				...(newSession ? { sessionId: crypto.randomUUID(), operations: 0, totalExpiresAt: now + TOTAL_MS } : {}),
			});
		} else {
			await ctx.db.patch("playwriter_connections", connection._id, {
				controlRevision: connection.controlRevision + 1,
				pauseReason: operation === "pause" ? "human" : null,
				state: operation === "pause" ? "paused" : "recovering",
				updatedAt: Date.now(),
			});
		}
		return Result({ _yay: (await ctx.db.get("playwriter_connections", connection._id))! });
	},
});
type prepare_control_Result =
	typeof prepare_control extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

async function control(
	ctx: ActionCtx,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		connectionId: Id<"playwriter_connections">;
	} & (
		| { operation: "resume"; connectionGeneration: number; controlRevision: number }
		| { operation: "pause" | "reconnect" | "disconnect" }
	),
) {
	const userId = await current_user(ctx);
	const operation = args.operation;
	const prepared = (await ctx.runMutation(internal.playwriter_browser.prepare_control, {
		membershipId: args.membershipId,
		connectionId: args.connectionId,
		userId,
		operation:
			args.operation === "resume"
				? { kind: "resume", connectionGeneration: args.connectionGeneration, controlRevision: args.controlRevision }
				: args.operation,
	})) as prepare_control_Result;
	if (prepared._nay) return prepared;
	const connection = prepared._yay;
	if (operation === "reconnect") {
		const status = await playwriter_runner_call({ route: "status", body: scope(connection) });
		if (status._nay && status._nay.name !== "not_connected") {
			const markedOffline = (await ctx.runMutation(internal.playwriter_browser.mark_offline, {
				connectionId: connection._id,
				attemptId: connection.connectAttemptId,
				generation: connection.connectionGeneration,
				controlRevision: connection.controlRevision,
			})) as mark_offline_Result;
			return markedOffline ? status : Result({ _nay: { message: "Browser connection changed", name: "stale" } });
		}
		if (
			status._nay ||
			status._yay.runtime.confirmedTargetId !== connection.confirmedTargetId ||
			(status._yay.runtime.sessionId !== connection.sessionId &&
				!["disconnected", "expired", "failed"].includes(status._yay.runtime.state) &&
				status._yay.runtime.operations < 120 &&
				status._yay.runtime.totalExpiresAt > Date.now())
		) {
			const forgotten = (await ctx.runMutation(internal.playwriter_browser.forget_connection, {
				connectionId: connection._id,
				userId,
				attemptId: connection.connectAttemptId,
				controlRevision: connection.controlRevision,
				reason: "connect_again",
			})) as forget_connection_Result;
			return Result({
				_nay: forgotten
					? { message: "The saved browser could not be checked. Connect again.", name: "connect_again" }
					: { message: "Browser connection changed", name: "stale" },
			});
		}
		try {
			const shareId = await crypto_decrypt_secret_value(
				{ ciphertext: connection.encryptedShareId!, nonce: connection.shareNonce! },
				secret_scope(connection),
				KEY_NAME,
			);
			// Only human Reconnect may start a new budget after the old work drains.
			return await dial(
				ctx,
				connection,
				shareId,
				status._yay.runtime.sessionId === connection.sessionId
					? { route: "recover" }
					: { route: "reconnect", previousSessionId: status._yay.runtime.sessionId },
			);
		} catch {
			await ctx.runMutation(internal.playwriter_browser.forget_connection, {
				connectionId: connection._id,
				userId,
				attemptId: connection.connectAttemptId,
				controlRevision: connection.controlRevision,
				reason: "key_unavailable",
			});
			return Result({ _nay: { message: "The saved link could not be read. Connect again.", name: "key_unavailable" } });
		}
	}
	const called = await playwriter_runner_call({
		route: operation,
		body: {
			...scope(connection),
			...(operation === "disconnect"
				? {}
				: { generation: connection.connectionGeneration, controlRevision: connection.controlRevision }),
		},
	});
	if (called._nay) {
		if (operation === "resume")
			await ctx.runMutation(internal.playwriter_browser.restore_failed_resume, {
				connectionId: connection._id,
				attemptId: connection.connectAttemptId,
				generation: connection.connectionGeneration,
				controlRevision: connection.controlRevision,
			});
		// Disconnect has already removed authority and queued safe cleanup.
		return operation === "disconnect" ? Result({ _yay: { connectionId: connection._id } }) : called;
	}
	if (operation !== "disconnect" && !(await mirror(ctx, connection, called._yay.runtime)))
		return Result({ _nay: { message: "Browser connection changed", name: "stale" } });
	return Result({ _yay: { connectionId: connection._id } });
}

export const pause_connection = action({
	args: { membershipId: v.id("organizations_workspaces_users"), connectionId: v.id("playwriter_connections") },
	returns: connection_result_validator,
	handler: async (ctx, args) => await control(ctx, { ...args, operation: "pause" }),
});

export const resume_connection = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		connectionId: v.id("playwriter_connections"),
		connectionGeneration: v.number(),
		controlRevision: v.number(),
	},
	returns: connection_result_validator,
	handler: async (ctx, args) => await control(ctx, { ...args, operation: "resume" }),
});

export const reconnect_connection = action({
	args: { membershipId: v.id("organizations_workspaces_users"), connectionId: v.id("playwriter_connections") },
	returns: connection_result_validator,
	handler: async (ctx, args) => await control(ctx, { ...args, operation: "reconnect" }),
});

export const disconnect_connection = action({
	args: { membershipId: v.id("organizations_workspaces_users"), connectionId: v.id("playwriter_connections") },
	returns: connection_result_validator,
	handler: async (ctx, args) => await control(ctx, { ...args, operation: "disconnect" }),
});

export const mark_offline = internalMutation({
	args: {
		connectionId: v.id("playwriter_connections"),
		attemptId: v.string(),
		generation: v.number(),
		controlRevision: v.number(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		if (
			connection?.active &&
			connection.connectAttemptId === args.attemptId &&
			connection.connectionGeneration === args.generation &&
			connection.controlRevision === args.controlRevision &&
			connection.pauseReason !== "human"
		) {
			await ctx.db.patch("playwriter_connections", connection._id, { state: "offline", updatedAt: Date.now() });
			return true;
		}
		return false;
	},
});

export const restore_failed_resume = internalMutation({
	args: {
		connectionId: v.id("playwriter_connections"),
		attemptId: v.string(),
		generation: v.number(),
		controlRevision: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		// A failed old Resume must not undo a newer human control.
		if (
			connection?.active &&
			connection.connectAttemptId === args.attemptId &&
			connection.connectionGeneration === args.generation &&
			connection.controlRevision === args.controlRevision &&
			connection.state === "recovering"
		)
			await ctx.db.patch("playwriter_connections", connection._id, {
				state: "needs_human",
				pauseReason: "human",
				// The restored Pause must be newer than the attempted Resume.
				controlRevision: connection.controlRevision + 1,
				updatedAt: Date.now(),
			});
		return null;
	},
});
type mark_offline_Result =
	typeof mark_offline extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const refresh_connection_status = action({
	args: { membershipId: v.id("organizations_workspaces_users"), connectionId: v.id("playwriter_connections") },
	returns: connection_result_validator,
	handler: async (ctx, args) => {
		const userId = await current_user(ctx);
		const loaded = (await ctx.runQuery(internal.playwriter_browser.load_connection, {
			...args,
			userId,
		})) as load_connection_Result;
		if (loaded._nay) return loaded;
		const response = await playwriter_runner_call({ route: "status", body: scope(loaded._yay) });
		if (response._nay)
			await ctx.runMutation(internal.playwriter_browser.mark_offline, {
				connectionId: args.connectionId,
				attemptId: loaded._yay.connectAttemptId,
				generation: loaded._yay.connectionGeneration,
				controlRevision: loaded._yay.controlRevision,
			});
		else await mirror(ctx, loaded._yay, response._yay.runtime);
		return Result({ _yay: { connectionId: args.connectionId } });
	},
});

export const confirm_tab = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		connectionId: v.id("playwriter_connections"),
		targetHandle: v.string(),
	},
	returns: connection_result_validator,
	handler: async (ctx, args) => {
		const userId = await current_user(ctx);
		const loaded = (await ctx.runQuery(internal.playwriter_browser.load_connection, {
			connectionId: args.connectionId,
			membershipId: args.membershipId,
			userId,
			requireBrowserPermission: true,
		})) as load_connection_Result;
		if (loaded._nay) return loaded;
		if (!enabled()) return Result({ _nay: { message: "Browser unavailable" } });
		const connection = loaded._yay;
		const target = connection.targets.find((item) => item.handle === args.targetHandle);
		if (!target)
			return Result({ _nay: { message: "The shared tab changed. Refresh and choose it again.", name: "stale" } });
		const preference = await ctx.runQuery(internal.playwriter_browser.get_preferences, {
			userId,
			organizationId: connection.organizationId,
			workspaceId: connection.workspaceId,
		});
		if (target.url !== "about:blank" && !browser_web_normalize_url(target.url, preference.agentBlockedHosts).ok)
			return Result({ _nay: { message: "This site is blocked for the agent.", name: "agent_blocked_site" } });
		const response = await playwriter_runner_call({
			route: "confirm",
			body: {
				...scope(connection),
				generation: connection.connectionGeneration,
				targetId: target.targetId,
				inventoryRevision: connection.inventoryRevision,
			},
		});
		if (response._nay) return response;
		if (!(await mirror(ctx, connection, response._yay.runtime)))
			return Result({ _nay: { message: "Browser connection changed", name: "stale" } });
		const selected = await files_browser_action_set_choice(ctx, {
			membershipId: args.membershipId,
			webChoice: { provider: "playwriter", connectionId: connection._id, confirmedTargetHandle: target.handle },
		});
		if (selected._nay) return selected;
		return Result({ _yay: { connectionId: connection._id } });
	},
});

export const sync_policy = internalAction({
	args: {
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		webAgentAccess: v.boolean(),
		agentBlockedHosts: v.array(v.string()),
		selectionRevision: v.number(),
		policyRevision: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const connections = await ctx.runQuery(internal.playwriter_browser.list_scope_connections, {
			ownerId: args.ownerId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		});
		for (const connection of connections) {
			if (connection.connectionGeneration === 0) continue;
			const status = await playwriter_runner_call({ route: "status", body: scope(connection), timeoutMs: 5_000 });
			if (status._nay) {
				if (status._nay.name === "not_connected" || status._nay.name === "connection_forgotten") continue;
				return status;
			}
			// Offline sessions have no dispatch. The next dial reads the current saved policy.
			if (["disconnected", "expired", "failed"].includes(status._yay.runtime.state)) continue;
			if (status._yay.runtime.sessionId !== connection.sessionId)
				return Result({ _nay: { message: "Browser session changed", name: "stale" } });
			const called = await playwriter_runner_call({
				route: "agent-access",
				body: {
					...scope(connection),
					generation: status._yay.runtime.generation,
					agentAccess: args.webAgentAccess,
					agentBlockedHosts: args.agentBlockedHosts,
					policyRevision: args.policyRevision,
					selectionRevision: args.selectionRevision,
				},
			});
			if (called._nay) return called;
			if (
				called._yay.runtime.sessionId !== connection.sessionId ||
				called._yay.runtime.generation !== status._yay.runtime.generation ||
				called._yay.runtime.policyRevision !== args.policyRevision ||
				called._yay.runtime.selectionRevision !== args.selectionRevision ||
				called._yay.runtime.agentAccess !== args.webAgentAccess
			)
				return Result({ _nay: { message: "Browser policy update failed", name: "stale_policy" } });
		}
		return Result({ _yay: null });
	},
});

export const list_scope_connections = internalQuery({
	args: {
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.array(doc(app_schema, "playwriter_connections")),
	handler: async (ctx, args) =>
		await ctx.db
			.query("playwriter_connections")
			.withIndex("by_owner_organization_workspace_active", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("active", true),
			)
			.take(2),
});

export const cleanup_batch = internalQuery({
	args: {},
	returns: v.array(doc(app_schema, "playwriter_connection_cleanups")),
	handler: async (ctx) =>
		await ctx.db
			.query("playwriter_connection_cleanups")
			.withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", Date.now()))
			.take(20),
});

export const finish_cleanup = internalMutation({
	args: {
		cleanupId: v.id("playwriter_connection_cleanups"),
		forgetCredential: v.boolean(),
		success: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const cleanup = await ctx.db.get("playwriter_connection_cleanups", args.cleanupId);
		if (!cleanup) return null;
		// A later disconnect (member removal, human Disconnect, idle expiry, or deletion) can upgrade a pending
		// exact-generation cleanup to Forget while its old Disconnect reply waits. That old reply proves nothing
		// about Forget. Leave the upgraded cleanup for the next cleanup run, with no delay.
		if (cleanup.forgetCredential !== args.forgetCredential) return null;
		if (args.success) {
			const connectionId = ctx.db.normalizeId("playwriter_connections", cleanup.connectionId);
			const connection = connectionId ? await ctx.db.get("playwriter_connections", connectionId) : null;
			if (
				connection?.unresolvedCommand &&
				(cleanup.forgetCredential || connection.unresolvedCommand.generation === cleanup.generation)
			) {
				const slot = connection.unresolvedCommand;
				const finished = await ai_chat_files_db_finish_browser_invocation(ctx, {
					invocationId: slot.invocationId,
					operationHash: slot.operationHash,
					commandId: slot.commandId,
					result: { status: "unknown", reason: "disconnected" },
				});
				if (finished._nay)
					console.warn("Browser call finish failed", {
						invocationId: slot.invocationId,
						reason: finished._nay.name ?? "finish_failed",
					});
			}
			if (
				connection &&
				!connection.active &&
				(cleanup.forgetCredential || connection.connectionGeneration === cleanup.generation)
			) {
				await ctx.db.patch("playwriter_connections", connection._id, {
					state: cleanup.forgetCredential ? "closed" : "offline",
					unresolvedCommand: null,
					pendingAcknowledgement: null,
					updatedAt: Date.now(),
				});
			}
			await ctx.db.delete("playwriter_connection_cleanups", cleanup._id);
		} else {
			await ctx.db.patch("playwriter_connection_cleanups", cleanup._id, {
				attempts: cleanup.attempts + 1,
				nextAttemptAt: Date.now() + Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(cleanup.attempts, 9)),
			});
		}
		return null;
	},
});

export const process_cleanups = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const cleanups = await ctx.runQuery(internal.playwriter_browser.cleanup_batch, {});
		for (const cleanup of cleanups) {
			const response = await playwriter_runner_call({
				route: "disconnect",
				body: {
					connectionId: cleanup.connectionId,
					ownerId: cleanup.ownerId,
					organizationId: cleanup.organizationId,
					workspaceId: cleanup.workspaceId,
					...(cleanup.forgetCredential ? {} : { generation: cleanup.generation }),
				},
				timeoutMs: 5_000,
			});
			await ctx.runMutation(internal.playwriter_browser.finish_cleanup, {
				cleanupId: cleanup._id,
				forgetCredential: cleanup.forgetCredential,
				// This fixed code proves only this authenticated Disconnect scope.
				success:
					response._nay?.name === "connection_forgotten" ||
					(!cleanup.forgetCredential && !response._nay && response._yay.runtime.generation > cleanup.generation),
			});
		}
		return null;
	},
});

async function retire_connection_session(
	ctx: MutationCtx,
	connection: Doc<"playwriter_connections">,
	reason: "agent_closed" | "limit",
) {
	await ctx.db.patch("playwriter_connections", connection._id, {
		active: false,
		state: reason === "limit" ? "limit_reached" : "offline",
		pauseReason: connection.pauseReason === "human" ? "human" : reason,
		controlRevision: connection.controlRevision + 1,
		updatedAt: Date.now(),
	});
	await ctx.db.insert("playwriter_connection_cleanups", {
		...scope(connection),
		generation: connection.connectionGeneration,
		forgetCredential: false,
		attempts: 0,
		nextAttemptAt: Date.now(),
	});
	await ctx.scheduler.runAfter(0, internal.playwriter_browser.process_cleanups, {});
}

export const sweep_connections = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const active = await ctx.db
			.query("playwriter_connections")
			.withIndex("by_active", (q) => q.eq("active", true))
			.take(50);
		for (const connection of active) {
			const access = await connection_access(ctx, connection, true);
			if (!enabled() || connection.idleExpiresAt <= Date.now() || access._nay)
				await playwriter_browser_db_disconnect(
					ctx,
					connection,
					!enabled() ? "unavailable" : access._nay ? "access_lost" : "idle_expired",
				);
			else if (connection.operations >= 120 || (connection.totalExpiresAt ?? 0) <= Date.now())
				await retire_connection_session(ctx, connection, "limit");
		}
		// Closed history must not fill the saved-link expiry batch.
		for (const state of ["offline", "limit_reached", "paused"] as const) {
			const expired = await ctx.db
				.query("playwriter_connections")
				.withIndex("by_active_state_idleExpiresAt", (q) =>
					q.eq("active", false).eq("state", state).lte("idleExpiresAt", Date.now()),
				)
				.take(50);
			for (const connection of expired) await playwriter_browser_db_disconnect(ctx, connection, "idle_expired");
			if (expired.length === 50) await ctx.scheduler.runAfter(0, internal.playwriter_browser.sweep_connections, {});
		}
		return null;
	},
});

const remote_resource_validator = ai_chat_browser_resource_validator.members[1];
const command_identity_validator =
	app_schema.tables.playwriter_connections.validator.fields.unresolvedCommand.members[0];

function remote_resource(connection: Doc<"playwriter_connections">) {
	return {
		provider: "playwriter" as const,
		connectionId: connection._id,
		connectionGeneration: connection.connectionGeneration,
		targetRevision: connection.targetRevision,
		controlRevision: connection.controlRevision,
		navRevision: connection.navRevision,
		confirmedTargetHandle: connection.confirmedTargetHandle!,
	};
}

async function remote_lease(
	ctx: QueryCtx | MutationCtx,
	args: {
		source: Infer<typeof ai_chat_browser_source_validator>;
		browserIntent: Infer<typeof browser_intent_validator>;
	},
) {
	const checked = await files_browser_db_check_agent_intent(ctx, args);
	if (checked._nay) return checked;
	const choice = args.browserIntent.webChoice;
	if (choice.provider !== "playwriter")
		return Result({ _nay: { message: "No shared tab is selected.", name: "unavailable" } });
	const connectionId = ctx.db.normalizeId("playwriter_connections", choice.connectionId);
	const connection = connectionId ? await ctx.db.get("playwriter_connections", connectionId) : null;
	if (
		!connection ||
		connection.ownerId !== args.source.userId ||
		connection.organizationId !== args.source.organizationId ||
		connection.workspaceId !== args.source.workspaceId ||
		connection.confirmedTargetHandle !== choice.confirmedTargetHandle
	)
		return Result({ _nay: { message: "Shared browser changed", name: "stale" } });
	if (!enabled()) return Result({ _nay: { message: "Browser unavailable", name: "unavailable" } });
	const access = await connection_access(ctx, connection, true);
	if (access._nay) return access;
	if (!connection.active || connection.idleExpiresAt <= Date.now() || (connection.totalExpiresAt ?? 0) <= Date.now())
		return Result({ _nay: { message: "The browser session ended. Reconnect in Browser settings.", name: "limit" } });
	if (connection.pauseReason === "human" || connection.state === "paused")
		return Result({ _nay: { message: "The user paused the shared browser.", name: "paused" } });
	if (connection.state !== "ready" || !connection.confirmedTargetId || !connection.confirmedTargetHandle)
		return Result({
			_nay: {
				message: "The shared browser is offline or needs attention.",
				name: connection.state === "offline" ? "offline" : "unavailable",
			},
		});
	return Result({ _yay: remote_resource(connection) });
}

export const get_remote_lease = internalQuery({
	args: { source: ai_chat_browser_source_validator, browserIntent: browser_intent_validator },
	returns: v_result({ _yay: remote_resource_validator }),
	handler: (ctx, args) => remote_lease(ctx, args),
});

const file_output_scope_validator = v.object({
	...files_ingestion_scope_validator.fields,
	agentSource: ai_chat_workspaces_source_validator,
	threadId: v.id("ai_chat_threads"),
	modeId: v.union(v.literal("ask"), v.literal("agent")),
	source: ai_chat_browser_source_validator,
	browserIntent: browser_intent_validator,
	expectedLease: remote_resource_validator,
});

/**
 * Refuse a file from a script when the shared tab is no longer the one the script ran in, or the
 * user paused it or turned agent access off. Both prepare and finalize check it, because the
 * upload happens in between.
 */
async function authorize_file_output(ctx: MutationCtx, args: Infer<typeof file_output_scope_validator>) {
	const chat = await ai_chat_files_db_authorize_file_output(ctx, args);
	if (chat._nay) return chat;
	const lease = await remote_lease(ctx, args);
	const expected = args.expectedLease;
	if (
		lease._nay ||
		lease._yay.connectionId !== expected.connectionId ||
		lease._yay.connectionGeneration !== expected.connectionGeneration ||
		lease._yay.controlRevision !== expected.controlRevision ||
		lease._yay.targetRevision !== expected.targetRevision ||
		lease._yay.navRevision !== expected.navRevision ||
		lease._yay.confirmedTargetHandle !== expected.confirmedTargetHandle
	)
		return Result({ _nay: { message: "Browser session changed. Run the capture again." } });
	return Result({ _yay: null });
}

/**
 * Prepare and finalize one file that a script in the shared tab emitted, for example a screenshot.
 * A retry whose receipt already completed returns the existing Files target before this check runs.
 */
export const prepare_file_output = internalMutation({
	args: {
		...files_ingestion_prepare_args_validator.fields,
		...file_output_scope_validator.fields,
	},
	returns: v_result({ _yay: files_ingestion_prepare_result_validator }),
	handler: (ctx, args) => files_ingestion_db_prepare_file(ctx, args, () => authorize_file_output(ctx, args)),
});

export const finalize_file_output = internalMutation({
	args: {
		...files_ingestion_finalize_args_validator.fields,
		...file_output_scope_validator.fields,
	},
	returns: v_result({ _yay: files_ingestion_file_validator }),
	handler: (ctx, args) => files_ingestion_db_finalize_file(ctx, args, () => authorize_file_output(ctx, args)),
});

export const reserve_command = internalMutation({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		resource: remote_resource_validator,
		toolCallId: v.string(),
		operationHash: v.string(),
		run: v.optional(v.union(ai_chat_run_fence_validator, v.null())),
	},
	returns: v_result({
		_yay: v.object({
			connection: doc(app_schema, "playwriter_connections"),
			allowedVersions: v.array(v.string()),
			invocation: v.object({
				isNew: v.boolean(),
				invocationId: v.id("ai_chat_browser_invocations"),
				commandId: v.string(),
				deadlineAt: v.number(),
				receiptResolutionDeadline: v.number(),
				status: app_schema.tables.ai_chat_browser_invocations.validator.fields.status,
				resource: v.union(ai_chat_browser_resource_validator, v.null()),
				result: v.union(ai_chat_browser_result_validator, v.null()),
				resultExpired: v.boolean(),
			}),
		}),
	}),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.resource.connectionId);
		if (
			!connection ||
			connection.ownerId !== args.source.userId ||
			connection.workspaceId !== args.source.workspaceId ||
			connection.organizationId !== args.source.organizationId
		)
			return Result({ _nay: { message: "Not found" } });
		const existing = await ctx.db
			.query("ai_chat_browser_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", args.source.threadId).eq("toolCallId", args.toolCallId))
			.first();
		if (!existing) {
			if (!enabled() || !connection.active || !connection.encryptedShareId)
				return Result({ _nay: { message: "Browser unavailable", name: "unavailable" } });
			if (connection.state !== "ready" || connection.pauseReason === "human")
				return Result({ _nay: { message: "The browser is paused or offline.", name: "paused" } });
			if (connection.unresolvedCommand)
				return Result({ _nay: { message: "Another browser command is still settling.", name: "busy" } });
			if (
				connection.operations >= 120 ||
				connection.idleExpiresAt <= Date.now() ||
				(connection.totalExpiresAt ?? 0) <= Date.now()
			)
				return Result({ _nay: { message: "Browser session limit reached.", name: "limit" } });
		}
		const timeoutMs = Math.max(1, Math.min(30_000, (connection.totalExpiresAt ?? Date.now()) - Date.now()));
		const claim = await ai_chat_files_db_begin_browser_invocation(ctx, { ...args, timeoutMs });
		if (claim._nay) return claim;
		if (claim._yay.isNew) {
			const identity = {
				generation: connection.connectionGeneration,
				commandId: claim._yay.commandId,
				operationHash: args.operationHash,
				source: {
					chatId: args.source.threadId,
					sourceMessageId: args.source.sourceMessageId,
					toolCallId: args.toolCallId,
				},
				deadline: claim._yay.deadlineAt,
				receiptResolutionDeadline: claim._yay.receiptResolutionDeadline,
				invocationId: claim._yay.invocationId,
			};
			await ctx.db.patch("playwriter_connections", connection._id, {
				unresolvedCommand: identity,
				state: "running",
				operations: connection.operations + 1,
				idleExpiresAt: Date.now() + IDLE_MS,
				updatedAt: Date.now(),
			});
			await ctx.scheduler.runAt(identity.deadline, internal.playwriter_browser.resolve_command, {
				connectionId: connection._id,
				commandId: identity.commandId,
				generation: identity.generation,
			});
			await ctx.scheduler.runAt(Date.now() + IDLE_MS, internal.playwriter_browser.sweep_connections, {});
		}
		return Result({ _yay: { connection, invocation: claim._yay, allowedVersions: allowed_versions() } });
	},
});

export const finish_command = internalMutation({
	args: {
		connectionId: v.id("playwriter_connections"),
		identity: command_identity_validator,
		result: ai_chat_browser_result_validator,
		runtime: v.union(runtime_validator, v.null()),
		completedLease: v.union(
			v.object({
				generation: v.number(),
				controlRevision: v.number(),
				policyRevision: v.number(),
				selectionRevision: v.number(),
				confirmedTargetId: v.string(),
				targetRevision: v.number(),
				navRevision: v.number(),
			}),
			v.null(),
		),
		fenced: v.boolean(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		const slot = connection?.unresolvedCommand;
		if (
			!connection ||
			!slot ||
			slot.commandId !== args.identity.commandId ||
			slot.generation !== args.identity.generation ||
			slot.operationHash !== args.identity.operationHash
		)
			return false;
		if (args.result.status === "unknown" && !args.fenced) return false;
		const currentRuntime =
			args.runtime?.generation === connection.connectionGeneration &&
			args.runtime.controlRevision === connection.controlRevision &&
			args.runtime.confirmedTargetId === connection.confirmedTargetId;
		const invocation = await ctx.db.get("ai_chat_browser_invocations", slot.invocationId);
		const completed = args.completedLease;
		const resource = invocation?.resource;
		const ownedCompletion =
			completed &&
			invocation &&
			resource?.provider === "playwriter" &&
			completed.generation === resource.connectionGeneration &&
			completed.controlRevision === resource.controlRevision &&
			completed.confirmedTargetId === connection.confirmedTargetId &&
			completed.policyRevision === invocation.browserIntent.policyRevision &&
			completed.selectionRevision === invocation.browserIntent.selectionRevision;
		const finished = await ai_chat_files_db_finish_browser_invocation(ctx, {
			invocationId: slot.invocationId,
			operationHash: slot.operationHash,
			commandId: slot.commandId,
			result: args.result,
			...(ownedCompletion
				? {
						resource: {
							...resource,
							navRevision: completed.navRevision,
							targetRevision: completed.targetRevision,
						},
					}
				: {}),
		});
		if (finished._nay)
			console.warn("Browser call finish failed", {
				invocationId: slot.invocationId,
				reason: finished._nay.name ?? "finish_failed",
			});
		await ctx.db.patch("playwriter_connections", connection._id, {
			unresolvedCommand: null,
			pendingAcknowledgement: args.runtime
				? args.runtime.generation === slot.generation && connection.connectionGeneration === slot.generation
					? slot
					: null
				: connection.pendingAcknowledgement,
			state:
				connection.state === "running"
					? currentRuntime && args.runtime?.state === "connected"
						? "ready"
						: "offline"
					: connection.state,
			...(currentRuntime &&
			args.runtime!.navRevision >= connection.navRevision &&
			args.runtime!.targetRevision >= connection.targetRevision
				? { navRevision: args.runtime!.navRevision, targetRevision: args.runtime!.targetRevision }
				: {}),
			updatedAt: Date.now(),
		});
		return true;
	},
});

export const clear_acknowledgement = internalMutation({
	args: { connectionId: v.id("playwriter_connections"), commandId: v.string(), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		if (
			connection?.pendingAcknowledgement?.commandId === args.commandId &&
			connection.pendingAcknowledgement.generation === args.generation
		)
			await ctx.db.patch("playwriter_connections", connection._id, { pendingAcknowledgement: null });
		return null;
	},
});

export const get_pending_command = internalQuery({
	args: { connectionId: v.id("playwriter_connections"), commandId: v.string(), generation: v.number() },
	returns: v.union(doc(app_schema, "playwriter_connections"), v.null()),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get("playwriter_connections", args.connectionId);
		return connection?.unresolvedCommand?.commandId === args.commandId &&
			connection.unresolvedCommand.generation === args.generation
			? connection
			: null;
	},
});

export const resolve_command = internalAction({
	args: { connectionId: v.id("playwriter_connections"), commandId: v.string(), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const connection = await ctx.runQuery(internal.playwriter_browser.get_pending_command, args);
		if (!connection?.unresolvedCommand) return null;
		const identity = connection.unresolvedCommand;
		const { invocationId: _invocationId, ...receipt } = identity;
		const body = { ...scope(connection), ...receipt };
		let response = await playwriter_runner_call({ route: "command-status", body, timeoutMs: 5_000 });
		if (
			response._nay ||
			!("status" in response._yay) ||
			response._yay.status === "in_progress" ||
			response._yay.status === "unknown"
		)
			response = await playwriter_runner_call({ route: "command-fence", body, timeoutMs: 6_000 });
		if (
			!response._nay &&
			"status" in response._yay &&
			response._yay.status !== "in_progress" &&
			response._yay.status !== "acknowledged"
		) {
			const runtime = response._yay.runtime;
			const fenced = runtime.generation > identity.generation || response._yay.result?.cleanup === "complete";
			const status =
				response._yay.status === "not_started"
					? "not_started"
					: response._yay.status === "unknown"
						? "unknown"
						: response._yay.result?.ok
							? "succeeded"
							: "errored";
			if (status !== "unknown" || fenced) {
				await ctx.runMutation(internal.playwriter_browser.finish_command, {
					connectionId: connection._id,
					identity,
					result: {
						status,
						reason:
							response._yay.result?.reason && /^[a-z0-9_]{1,64}$/.test(response._yay.result.reason)
								? response._yay.result.reason
								: null,
					},
					runtime,
					completedLease: response._yay.completedLease,
					fenced,
				});
				return null;
			}
		}
		await ctx.scheduler.runAfter(5_000, internal.playwriter_browser.resolve_command, args);
		return null;
	},
});

export const prepare_source_recovery = internalMutation({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		resource: v.optional(remote_resource_validator),
	},
	returns: v_result({ _yay: doc(app_schema, "playwriter_connections") }),
	handler: async (ctx, args) => {
		const checked = await files_browser_db_check_agent_intent(ctx, args);
		if (checked._nay) return checked;
		const choice = args.browserIntent.webChoice;
		if (!enabled() || choice.provider !== "playwriter")
			return Result({ _nay: { message: "Browser unavailable", name: "unavailable" } });
		const id = ctx.db.normalizeId("playwriter_connections", choice.connectionId);
		const connection = id ? await ctx.db.get("playwriter_connections", id) : null;
		if (
			!connection ||
			connection.confirmedTargetHandle !== choice.confirmedTargetHandle ||
			connection.ownerId !== args.source.userId ||
			connection.workspaceId !== args.source.workspaceId ||
			connection.organizationId !== args.source.organizationId
		)
			return Result({ _nay: { message: "Shared browser changed", name: "stale" } });
		const allowed = await connection_access(ctx, connection, true);
		if (allowed._nay) return allowed;
		if (
			args.resource &&
			(connection._id !== args.resource.connectionId ||
				connection.connectionGeneration !== args.resource.connectionGeneration ||
				connection.controlRevision !== args.resource.controlRevision ||
				connection.targetRevision !== args.resource.targetRevision ||
				connection.navRevision !== args.resource.navRevision ||
				connection.confirmedTargetHandle !== args.resource.confirmedTargetHandle)
		)
			return Result({ _nay: { message: "Shared browser changed", name: "stale" } });
		if (
			!connection.active ||
			!connection.encryptedShareId ||
			connection.unresolvedCommand ||
			connection.operations >= 120 ||
			connection.idleExpiresAt <= Date.now() ||
			(connection.totalExpiresAt ?? 0) <= Date.now() ||
			connection.pauseReason === "human"
		)
			return Result({ _nay: { message: "The shared browser cannot reconnect now.", name: "busy" } });
		const limit = await rate_limiter_limit_by_key(ctx, { name: "playwriter_connect", key: args.source.userId });
		if (limit) return Result({ _nay: { message: limit.message, name: "rate_limit" } });
		const day = new Date().toISOString().slice(0, 10);
		const daily = await ctx.db
			.query("playwriter_user_daily_use")
			.withIndex("by_user_day", (q) => q.eq("userId", args.source.userId).eq("day", day))
			.first();
		if ((daily?.starts ?? 0) >= 50)
			return Result({ _nay: { message: "Daily browser connection limit reached.", name: "limit" } });
		if (daily) await ctx.db.patch("playwriter_user_daily_use", daily._id, { starts: daily.starts + 1 });
		else await ctx.db.insert("playwriter_user_daily_use", { userId: args.source.userId, day, starts: 1 });
		await ctx.db.patch("playwriter_connections", connection._id, {
			state: "recovering",
			connectAttemptId: crypto.randomUUID(),
			updatedAt: Date.now(),
		});
		return Result({ _yay: (await ctx.db.get("playwriter_connections", connection._id))! });
	},
});
type prepare_source_recovery_Result =
	typeof prepare_source_recovery extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const recover_for_source = internalAction({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		resource: v.optional(remote_resource_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const end = Date.now() + 30_000;
		for (let attempt = 0; attempt < 3 && Date.now() < end; attempt++) {
			const prepared = (await ctx.runMutation(
				internal.playwriter_browser.prepare_source_recovery,
				args,
			)) as prepare_source_recovery_Result;
			if (prepared._nay) return prepared;
			const connection = prepared._yay;
			try {
				const shareId = await crypto_decrypt_secret_value(
					{ ciphertext: connection.encryptedShareId!, nonce: connection.shareNonce! },
					secret_scope(connection),
					KEY_NAME,
				);
				const result = await dial(
					ctx,
					connection,
					shareId,
					{ route: "recover" },
					Math.max(1, Math.min(15_000, end - Date.now())),
				);
				if (!result._nay) return Result({ _yay: null });
				if (result._nay.name !== "transport") return result;
			} catch {
				await ctx.runMutation(internal.playwriter_browser.forget_connection, {
					connectionId: connection._id,
					userId: connection.ownerId,
					attemptId: connection.connectAttemptId,
					controlRevision: connection.controlRevision,
					reason: "key_unavailable",
				});
				return Result({ _nay: { message: "The saved browser link cannot be read.", name: "key_unavailable" } });
			}
			await ctx.runMutation(internal.playwriter_browser.mark_offline, {
				connectionId: connection._id,
				attemptId: connection.connectAttemptId,
				generation: connection.connectionGeneration,
				controlRevision: connection.controlRevision,
			});
		}
		return Result({ _nay: { message: "The shared browser is offline.", name: "offline" } });
	},
});

export const retire_session = internalMutation({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		resource: remote_resource_validator,
	},
	returns: v_result({ _yay: doc(app_schema, "playwriter_connections") }),
	handler: async (ctx, args) => {
		const checked = await files_browser_db_check_agent_intent(ctx, args);
		if (checked._nay) return checked;
		const connection = await ctx.db.get("playwriter_connections", args.resource.connectionId);
		if (
			!connection ||
			connection.ownerId !== args.source.userId ||
			connection.organizationId !== args.source.organizationId ||
			connection.workspaceId !== args.source.workspaceId ||
			connection.connectionGeneration !== args.resource.connectionGeneration ||
			connection.controlRevision !== args.resource.controlRevision ||
			connection.navRevision !== args.resource.navRevision ||
			connection.targetRevision !== args.resource.targetRevision ||
			connection.confirmedTargetHandle !== args.resource.confirmedTargetHandle ||
			connection.unresolvedCommand ||
			connection.state !== "ready" ||
			connection.pauseReason === "human"
		)
			return Result({ _nay: { message: "Browser changed or is busy.", name: "busy" } });
		await retire_connection_session(ctx, connection, "agent_closed");
		return Result({ _yay: connection });
	},
});
