import { v } from "convex/values";
import { z } from "zod";
import { type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api.js";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { Result } from "common/errors-as-values-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_authorize_node } from "./access_control.ts";
import {
	files_editable_text_content_type_of,
	files_get_utf8_byte_size,
	files_node_has_editable_text_content,
	files_u8_to_array_buffer,
	files_db_load_pending_update_yjs_state_bytes,
} from "../server/files.ts";
import type { files_nodes_get_visible_entry_by_path_Result } from "./files_nodes.ts";
import app_convex_schema from "./schema.ts";
import { files_pending_update_content_is_stale, files_pending_update_has_content } from "../shared/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { files_browser_runner_call, files_browser_runner_viewer_url } from "../server/files-browser.ts";
import {
	r2,
	r2_create_asset_key,
	r2_db_finalize_browser_result_asset,
	r2_enqueue_object_deletion_job,
	r2_fetch_object_from_bucket,
} from "./r2_client.ts";
import { files_nodes_reconstruct_latest_file_content_from_materialization_state } from "./files_nodes_reconstruct_content.ts";
import type { files_nodes_get_file_text_content_db_state_by_path_Result } from "./files_nodes_content.ts";

// Shared cloud browser: one live HTML page per selected file, watched and driven together by the
// user and the agent. Convex owns authorization, source snapshots, session metadata, and private
// results. The trusted runner owns the provider browser, snippet isolation, leases, and deadlines.
//
// Source reads mirror the local Preview choice exactly: Saved content comes from current committed
// state, Proposed changes from the actor's own unstaged branch, and Your draft from an explicit
// editor capture. An explicit Proposed request fails on a stale or absent proposal; it never
// silently shows Saved content. Access and identity are checked before and after every slow read.

const BROWSER_HTML_MAX_BYTES = 900_000;

const BROWSER_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const BROWSER_CAPTURE_TTL_MS = 5 * 60 * 1000;

const BROWSER_STARTING_TTL_MS = 2 * 60 * 1000;

// Daily per-workspace brakes against start/end and capture loops. Generous for humans; tune
// after the smoke test. Per-minute metering is separate future work.
const BROWSER_DAILY_STARTS_MAX = 30;
const BROWSER_DAILY_CAPTURES_MAX = 100;

const browser_agent_lease_validator = v.object({
	controlGen: v.number(),
	loadGen: v.number(),
	navGen: v.number(),
});

// Runner response shapes. Every consumed field is validated; nothing is trusted by shape alone.
const files_browser_runner_session_schema = z.object({
	sessionId: z.string(),
	nodeId: z.string(),
	navGen: z.number(),
	loadGen: z.number(),
	controlGen: z.number(),
	control: z.string(),
	sourceKind: z.string(),
	sourceVersion: z.string(),
	sourceHash: z.string(),
	pageNonce: z.string().nullable(),
	commandCount: z.number(),
	loadCount: z.number(),
});

const files_browser_runner_open_schema = z.object({
	ok: z.literal(true),
	session: files_browser_runner_session_schema,
});

// Pending identity: revision plus the state ids that the read resolved. Compared before and after
// every slow read so a changed proposal is refused instead of served stale.
function pending_content_key(pending: {
	_id: Id<"files_pending_updates">;
	target: { kind: string; id: string };
	revision: number;
	content?: {
		baseStateId?: Id<"files_pending_update_yjs_states">;
		stagedStateId?: Id<"files_pending_update_yjs_states">;
		unstagedStateId?: Id<"files_pending_update_yjs_states">;
		base?: unknown;
	} | null;
}) {
	return JSON.stringify([
		pending._id,
		pending.target.kind,
		pending.target.id,
		pending.revision,
		pending.content?.baseStateId,
		pending.content?.stagedStateId,
		pending.content?.unstagedStateId,
		pending.content?.base,
	]);
}

function html_unavailable() {
	return Result({ _nay: { message: "Choose an available source." } });
}

// The authorized snapshot payload, kept broad on purpose: the derived
// `authorize_browser_source_Result` type mirrors the handler's inferred returns, and template
// literals or narrow unions here would leak into every caller. Keep in sync with the
// `authorize_browser_source` returns validator below.
type BrowserSourceSnapshot = {
	version: string;
	snapshotKey: string;
	targetKind: "saved" | "private";
	text?: string;
};

/**
 * Authorize one browser source and resolve its identity. Mirrors the local Preview choice:
 * Saved content from committed state, Proposed changes from the actor's own unstaged branch.
 * An explicit Proposed request fails on a stale or absent proposal; it never shows Saved.
 *
 * Proposed text resolves here because pending Yjs states are Convex docs. Saved bytes resolve
 * in the calling action through the committed reader. Access and identity are checked before
 * and after every slow read by comparing `snapshotKey`.
 */
export const authorize_browser_source = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.string(),
		path: v.string(),
		sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
		// Identity-only callers (session lookup, version badge, lease checks) skip the byte
		// loads; Start and Reload pass true because they load the page from the text.
		includeText: v.optional(v.boolean()),
	},
	returns: v_result({
		_yay: v.object({
			version: v.string(),
			snapshotKey: v.string(),
			targetKind: v.union(v.literal("saved"), v.literal("private")),
			text: v.optional(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const entry = (await ctx.runQuery(internal.files_nodes.get_visible_entry_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
			visibilityUserId: args.userId,
			overlayUserId: args.userId,
		})) as files_nodes_get_visible_entry_by_path_Result;
		if (!entry || entry.node.kind !== "file" || String(entry.node._id) !== args.nodeId) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (entry.kind === "private") {
			// A pending-created file has no saved text and no editor draft: its proposal is the
			// only source, exactly like the local Preview. Owner access is the whole check.
			if (args.sourceKind !== "proposed") {
				return html_unavailable();
			}
			const pendingUpdate = entry.pendingUpdate;
			const intent = pendingUpdate.createIntent;
			if (
				entry.node.userId !== args.userId ||
				intent?.kind !== "text" ||
				intent.textKind !== "plain_text" ||
				files_editable_text_content_type_of(intent.contentType) !== "text/html;charset=utf-8" ||
				!files_pending_update_has_content(pendingUpdate) ||
				pendingUpdate.target.kind !== "private" ||
				pendingUpdate.target.id !== entry.node._id
			) {
				return html_unavailable();
			}
			if (!pendingUpdate.content || pendingUpdate.content.base.kind !== "new") {
				return html_unavailable();
			}

			const stateDoc = await ctx.db.get("files_pending_update_yjs_states", pendingUpdate.content.unstagedStateId);
			if (!stateDoc?.sealed) {
				return html_unavailable();
			}
			const pendingKey = pending_content_key(pendingUpdate);
			const sourceSnapshot: BrowserSourceSnapshot = {
				version: `private:${entry.node._id}:${entry.node.creationGeneration}:${pendingUpdate.revision}:${pendingUpdate.content.unstagedStateId}`,
				snapshotKey: JSON.stringify([args.userId, entry.node._id, pendingKey]),
				targetKind: "private",
			};
			if (!args.includeText) {
				return Result({ _yay: sourceSnapshot });
			}
			const bytes = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc });
			if (bytes._nay) {
				return Result({ _nay: { message: "Not found" } });
			}
			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(bytes._yay));
			let html: string;
			try {
				const text = files_yjs_doc_get_text({ yjsDoc, rootKind: "plain_text" });
				if (text._nay) {
					return Result({ _nay: { message: "Not found" } });
				}
				html = text._yay;
			} finally {
				yjsDoc.destroy();
			}
			if (files_get_utf8_byte_size(html) > BROWSER_HTML_MAX_BYTES) {
				return Result({ _nay: { message: "HTML exceeds the 900,000-byte preview limit." } });
			}
			sourceSnapshot.text = html;
			return Result({ _yay: sourceSnapshot });
		}

		const fileNode = entry.node;
		const savedNodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
		if (!savedNodeId || savedNodeId !== fileNode._id) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: savedNodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return authorized;
		}

		if (
			fileNode.textKind !== "plain_text" ||
			files_editable_text_content_type_of(fileNode.contentType) !== "text/html;charset=utf-8" ||
			!files_node_has_editable_text_content(fileNode) ||
			fileNode.archiveOperationId !== null
		) {
			return html_unavailable();
		}
		const nodeKey = [
			fileNode._id,
			fileNode.textKind,
			fileNode.contentType,
			fileNode.collaborationEnabled,
			fileNode.yjsLastSequenceId,
			fileNode.collaborationEnabled ? null : fileNode.assetId,
		];

		if (args.sourceKind === "draft") {
			const sourceSnapshot: BrowserSourceSnapshot = {
				version: `draft-basis:${fileNode.yjsLastSequenceId ?? fileNode.assetId}`,
				snapshotKey: JSON.stringify([args.userId, ...nodeKey]),
				targetKind: "saved",
			};
			return Result({ _yay: sourceSnapshot });
		}

		if (args.sourceKind === "saved") {
			let version = `asset:${fileNode.assetId}`;
			// The pointer stays fixed during edits. The sequence and history generation
			// identify the bytes that Start and Reload must keep stable across their read.
			if (fileNode.collaborationEnabled && fileNode.yjsLastSequenceId) {
				const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
				if (!lastSequenceDoc) {
					return html_unavailable();
				}
				version = `yjs:${fileNode.yjsLastSequenceId}:${lastSequenceDoc.lineageGeneration}:${lastSequenceDoc.lastSequence}`;
			}
			const sourceSnapshot: BrowserSourceSnapshot = {
				version,
				snapshotKey: JSON.stringify([args.userId, ...nodeKey, version]),
				targetKind: "saved",
			};
			return Result({ _yay: sourceSnapshot });
		}

		const pendingUpdate = (await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_internal, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			target: { kind: "saved", id: fileNode._id },
		})) as Doc<"files_pending_updates"> | null;
		if (
			!files_pending_update_has_content(pendingUpdate) ||
			pendingUpdate.target.kind !== "saved" ||
			pendingUpdate.target.id !== fileNode._id ||
			!pendingUpdate.content ||
			files_pending_update_content_is_stale(pendingUpdate, fileNode)
		) {
			return html_unavailable();
		}

		// A stale-generation proposal was built against a replaced document history. The commit
		// gate refuses it, so its text must not serve here either. Non-collaborative files have
		// no sequence doc; the asset check inside the staleness helper screens them instead.
		if (fileNode.yjsLastSequenceId) {
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
			if (
				!lastSequenceDoc ||
				pendingUpdate.content.base.kind !== "yjs" ||
				lastSequenceDoc.lineageGeneration !== pendingUpdate.content.base.lineageGeneration
			) {
				return html_unavailable();
			}
		}

		const stateDoc = await ctx.db.get("files_pending_update_yjs_states", pendingUpdate.content.unstagedStateId);
		if (!stateDoc?.sealed) {
			return html_unavailable();
		}
		const pendingKey = pending_content_key(pendingUpdate);
		const sourceSnapshot: BrowserSourceSnapshot = {
			version: `pending:${pendingUpdate._id}:${pendingUpdate.revision}:${pendingUpdate.content.unstagedStateId}`,
			snapshotKey: JSON.stringify([args.userId, ...nodeKey, pendingKey]),
			targetKind: "saved",
		};
		if (!args.includeText) {
			return Result({ _yay: sourceSnapshot });
		}
		const bytes = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc });
		if (bytes._nay) {
			return Result({ _nay: { message: "Not found" } });
		}
		const yjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(bytes._yay));
		let html: string;
		try {
			const text = files_yjs_doc_get_text({ yjsDoc, rootKind: "plain_text" });
			if (text._nay) {
				return Result({ _nay: { message: "Not found" } });
			}
			html = text._yay;
		} finally {
			yjsDoc.destroy();
		}
		if (files_get_utf8_byte_size(html) > BROWSER_HTML_MAX_BYTES) {
			return Result({ _nay: { message: "HTML exceeds the 900,000-byte preview limit." } });
		}
		sourceSnapshot.text = html;
		return Result({ _yay: sourceSnapshot });
	},
});

type authorize_browser_source_Result =
	typeof authorize_browser_source extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

function live_session_control(control: string) {
	return control === "starting" || control === "ready" || control === "human" || control === "pausing";
}

/**
 * Count one daily browser use (a fresh start or a draft capture) for the workspace. Returns
 * false at the cap. Reattached starts and refusals before admission are free. A start that
 * fails after admission still counts.
 */
async function browser_daily_use_count(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		kind: "starts" | "captures";
		now: number;
	},
) {
	const day = new Date(args.now).toISOString().slice(0, 10);
	const dailyUse = await ctx.db
		.query("files_browser_daily_use")
		.withIndex("by_workspace_day", (q) => q.eq("workspaceId", args.workspaceId).eq("day", day))
		.first();
	const cap = args.kind === "starts" ? BROWSER_DAILY_STARTS_MAX : BROWSER_DAILY_CAPTURES_MAX;
	const used = dailyUse?.[args.kind] ?? 0;
	if (used >= cap) {
		return false;
	}
	if (!dailyUse) {
		await ctx.db.insert("files_browser_daily_use", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			day,
			starts: args.kind === "starts" ? 1 : 0,
			captures: args.kind === "captures" ? 1 : 0,
			updatedAt: args.now,
		});
		return true;
	}
	await ctx.db.patch("files_browser_daily_use", dailyUse._id, {
		[args.kind]: used + 1,
		updatedAt: args.now,
	});
	return true;
}

/**
 * Claim the owner's workspace browser slot and record a starting session. A starting doc that
 * never commits expires fast; ending the file invalidates it before the runner session exists.
 */
export const create_starting_browser_session = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		targetKind: v.union(v.literal("saved"), v.literal("private")),
		nodeId: v.string(),
		path: v.string(),
		sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
		navigationGeneration: v.number(),
		navigationClientId: v.string(),
		viewportWidth: v.number(),
		viewportHeight: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			sessionId: v.id("files_browser_sessions"),
			reattached: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (
			!membership ||
			membership.organizationId !== args.organizationId ||
			membership.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (
			!Number.isInteger(args.navigationGeneration) ||
			args.navigationGeneration < 1 ||
			args.navigationClientId.length === 0 ||
			args.navigationClientId.length > 128 ||
			!Number.isInteger(args.viewportWidth) ||
			!Number.isInteger(args.viewportHeight) ||
			args.viewportWidth < 320 ||
			args.viewportHeight < 320 ||
			args.viewportWidth > 2560 ||
			args.viewportHeight > 1440
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const now = Date.now();
		const existing = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_owner_organization_workspace", (q) =>
				q.eq("ownerId", args.userId).eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
			)
			.collect();
		for (const session of existing) {
			if (!live_session_control(session.control)) {
				continue;
			}
			if (session.control === "starting" && (session.startingExpiresAt ?? 0) <= now) {
				await ctx.db.delete("files_browser_sessions", session._id);
				continue;
			}
			// Repeated starts for the same live file and source reattach after fresh checks.
			// Anything else needs an explicit End first.
			if (
				session.targetKind === args.targetKind &&
				session.nodeId === args.nodeId &&
				session.sourceKind === args.sourceKind &&
				session.navigationGeneration === args.navigationGeneration
			) {
				return Result({ _yay: { sessionId: session._id, reattached: true } });
			}
			return Result({ _nay: { message: "Browser busy" } });
		}

		const counted = await browser_daily_use_count(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "starts",
			now,
		});
		if (!counted) {
			return Result({ _nay: { message: "Daily browser start limit reached." } });
		}

		const sessionId = await ctx.db.insert("files_browser_sessions", {
			ownerId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			targetKind: args.targetKind,
			nodeId: args.nodeId,
			path: args.path,
			navigationClientId: args.navigationClientId,
			navigationGeneration: args.navigationGeneration,
			sourceKind: args.sourceKind,
			sourceVersion: "",
			sourceHash: "",
			loadGen: 0,
			controlGen: 0,
			control: "starting",
			startingExpiresAt: now + BROWSER_STARTING_TTL_MS,
			createdAt: now,
			updatedAt: now,
		});
		return Result({ _yay: { sessionId, reattached: false } });
	},
});

type create_starting_browser_session_Result =
	typeof create_starting_browser_session extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Commit a starting session to its live runner session. Refuses when the file moved on while the
 * runner was opening; the caller then closes the orphan runner session at once.
 */
export const commit_live_browser_session = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		navigationGeneration: v.number(),
		sourceVersion: v.string(),
		sourceHash: v.string(),
		loadGen: v.number(),
		controlGen: v.number(),
		runnerSessionId: v.string(),
		idleUntil: v.number(),
		totalUntil: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (!session || session.control !== "starting" || session.navigationGeneration !== args.navigationGeneration) {
			return Result({ _nay: { message: "Not found" } });
		}
		await ctx.db.patch("files_browser_sessions", args.sessionId, {
			sourceVersion: args.sourceVersion,
			sourceHash: args.sourceHash,
			loadGen: args.loadGen,
			controlGen: args.controlGen,
			control: "ready",
			runnerSessionId: args.runnerSessionId,
			idleUntil: args.idleUntil,
			totalUntil: args.totalUntil,
			startingExpiresAt: undefined,
			updatedAt: Date.now(),
		});
		return Result({ _yay: null });
	},
});

type commit_live_browser_session_Result =
	typeof commit_live_browser_session extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Drop a starting session that never went live: failed snapshot, refused runner open, or an
 * invalidated file change. Best effort; the expiry sweep covers crashes.
 */
export const delete_starting_browser_session = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (session && session.control === "starting") {
			await ctx.db.delete("files_browser_sessions", args.sessionId);
		}
		return null;
	},
});

/**
 * Load one browser session for its owner, or the current live session when no id is given.
 * Every session door starts here: membership, owner, and liveness are checked in one place.
 */
export const load_browser_session = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.optional(v.string()),
	},
	returns: v_result({ _yay: doc(app_convex_schema, "files_browser_sessions") }),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (
			!membership ||
			membership.organizationId !== args.organizationId ||
			membership.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const sessionId = args.sessionId ? ctx.db.normalizeId("files_browser_sessions", args.sessionId) : null;
		let session = sessionId ? await ctx.db.get("files_browser_sessions", sessionId) : null;
		if (args.sessionId === undefined) {
			const sessions = await ctx.db
				.query("files_browser_sessions")
				.withIndex("by_owner_organization_workspace", (q) =>
					q.eq("ownerId", args.userId).eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect();
			session = sessions.find((candidate) => live_session_control(candidate.control)) ?? null;
		}
		if (
			!session ||
			session.ownerId !== args.userId ||
			session.organizationId !== args.organizationId ||
			session.workspaceId !== args.workspaceId ||
			session.control === "closed"
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		return Result({ _yay: session });
	},
});

type load_browser_session_Result =
	typeof load_browser_session extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Re-check one session before a browser command: membership, owner, liveness, and live
 * source-node access. Returns the current lease for the runner call. Every check runs on
 * every command; a stale lease is refused instead of rebound.
 */
export const check_browser_source_access = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
	},
	returns: v.union(
		v.object({
			ok: v.literal(true),
			control: v.string(),
			controlGen: v.number(),
			loadGen: v.number(),
			navGen: v.number(),
			runnerSessionId: v.string(),
			targetKind: v.union(v.literal("saved"), v.literal("private")),
			nodeId: v.string(),
			sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
			sourceVersion: v.string(),
			sourceHash: v.string(),
		}),
		v.object({ ok: v.literal(false), reason: v.string() }),
	),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (
			!membership ||
			membership.organizationId !== args.organizationId ||
			membership.workspaceId !== args.workspaceId
		) {
			return { ok: false as const, reason: "Unauthorized" };
		}

		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (
			!session ||
			session.ownerId !== args.userId ||
			session.organizationId !== args.organizationId ||
			session.workspaceId !== args.workspaceId ||
			session.control === "closed" ||
			session.control === "closing" ||
			!session.runnerSessionId
		) {
			return { ok: false as const, reason: "closed" };
		}

		if (session.targetKind === "saved") {
			const nodeId = ctx.db.normalizeId("files_nodes", session.nodeId);
			if (!nodeId) {
				return { ok: false as const, reason: "Not found" };
			}
			const authorized = await access_control_db_authorize_node(ctx, {
				userAuth: { id: args.userId },
				membership,
				nodeId,
				permission: "content.read",
			});
			if (authorized._nay) {
				return { ok: false as const, reason: "denied" };
			}
			const node = await ctx.db.get("files_nodes", nodeId);
			if (
				!node ||
				node.archiveOperationId !== null ||
				node.textKind !== "plain_text" ||
				files_editable_text_content_type_of(node.contentType) !== "text/html;charset=utf-8"
			) {
				return { ok: false as const, reason: "denied" };
			}
		} else {
			const pendingNodeId = ctx.db.normalizeId("files_pending_nodes", session.nodeId);
			const pendingNode = pendingNodeId ? await ctx.db.get("files_pending_nodes", pendingNodeId) : null;
			if (!pendingNode || pendingNode.userId !== args.userId || pendingNode.state !== "active") {
				return { ok: false as const, reason: "denied" };
			}
		}

		return {
			ok: true as const,
			control: session.control,
			controlGen: session.controlGen,
			loadGen: session.loadGen,
			navGen: session.navigationGeneration,
			runnerSessionId: session.runnerSessionId,
			targetKind: session.targetKind,
			nodeId: session.nodeId,
			sourceKind: session.sourceKind,
			sourceVersion: session.sourceVersion,
			sourceHash: session.sourceHash,
		};
	},
});

function session_public_meta(session: Doc<"files_browser_sessions">) {
	return {
		sessionId: session._id,
		targetKind: session.targetKind,
		nodeId: session.nodeId,
		path: session.path,
		navigationGeneration: session.navigationGeneration,
		sourceKind: session.sourceKind,
		sourceVersion: session.sourceVersion,
		sourceHash: session.sourceHash,
		loadGen: session.loadGen,
		controlGen: session.controlGen,
		control: session.control,
		idleUntil: session.idleUntil ?? null,
		totalUntil: session.totalUntil ?? null,
	};
}

/**
 * Read current committed text through the same state the agent reader uses, without pending
 * content. Saved-only by construction: pending branches resolve in `authorize_browser_source`.
 */
async function read_saved_snapshot_text(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		path: string;
	},
) {
	const contentState = (await ctx.runQuery(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		path: args.path,
		includePending: false,
		overlayUserId: args.userId,
		maxBytes: BROWSER_HTML_MAX_BYTES,
	})) as files_nodes_get_file_text_content_db_state_by_path_Result;
	if (!contentState) {
		return Result({ _nay: { message: "Not found" } });
	 }

	const materializationState = contentState.materializationState;
	let content: string;
	if (contentState.content !== undefined) {
		content = contentState.content;
	} else if (
		materializationState &&
		materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
	) {
		const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
			state: materializationState,
		});
		if (reconstructed._nay) {
			throw convex_error({
				message: "Failed to reconstruct latest file content",
				cause: reconstructed._nay,
			});
		}
		content = reconstructed._yay.text;
	} else {
		const asset = contentState.asset;
		if (!asset?.r2Key) {
			return Result({ _nay: { message: "Not found" } });
		}
		content = await r2_fetch_object_from_bucket({ key: asset.r2Key }).then((response) => response.text());
	 }

	return Result({ _yay: content });
}

/**
 * Read and validate one explicit editor-draft capture. The bytes were uploaded by the initiating
 * editor; the hash binds them to this capture, and the after-revision proves no edit landed
 * mid-capture. Consumed by start, which deletes the capture and its blob on success.
 */
async function read_draft_capture_blob(
	ctx: ActionCtx,
	args: {
		captureId: Id<"files_browser_draft_captures">;
		storageId: string;
		revisionAfter: number | undefined;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: string;
		navigationGeneration: number;
	},
) {
	const capture = (await ctx.runQuery(internal.files_browser.get_draft_capture, {
		captureId: args.captureId,
	})) as get_draft_capture_Result;
	if (
		!capture ||
		capture.ownerId !== args.userId ||
		capture.organizationId !== args.organizationId ||
		capture.workspaceId !== args.workspaceId ||
		capture.nodeId !== args.nodeId ||
		capture.navigationGeneration !== args.navigationGeneration ||
		capture.expiresAt <= Date.now() ||
		!capture.storageId ||
		String(capture.storageId) !== args.storageId
	) {
		return Result({ _nay: { message: "Choose an available source." } });
	}
	if (args.revisionAfter === undefined || args.revisionAfter !== capture.revision) {
		return Result({ _nay: { message: "The draft changed while loading. Refresh to try again." } });
	}
	if (capture.byteSize > BROWSER_HTML_MAX_BYTES) {
		return Result({ _nay: { message: "HTML exceeds the 900,000-byte preview limit." } });
	}

	const blob = await ctx.storage.get(capture.storageId);
	if (!blob) {
		return Result({ _nay: { message: "Choose an available source." } });
	}
	if (blob.size > BROWSER_HTML_MAX_BYTES) {
		return Result({ _nay: { message: "HTML exceeds the 900,000-byte preview limit." } });
	}
	const text = await blob.text();
	const hash = await crypto_sha256_hex(text);
	if (hash !== capture.hash) {
		return Result({ _nay: { message: "Choose an available source." } });
	}

	return Result({ _yay: { text, version: `draft:${args.captureId}:${capture.revision}` } });
}

/**
 * Mint one explicit draft capture: validate the file and editor basis, record the expected bytes,
 * and hand back an upload URL. The editor uploads, then start binds the bytes by hash.
 */
export const capture_browser_draft = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.string(),
		path: v.string(),
		revision: v.number(),
		basisKind: v.string(),
		basisVersion: v.string(),
		navigationGeneration: v.number(),
		byteSize: v.number(),
		hash: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			captureId: v.id("files_browser_draft_captures"),
			uploadUrl: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		if (
			!Number.isInteger(args.revision) ||
			args.revision < 1 ||
			!Number.isInteger(args.navigationGeneration) ||
			args.navigationGeneration < 1 ||
			!Number.isInteger(args.byteSize) ||
			args.byteSize <= 0 ||
			args.byteSize > BROWSER_HTML_MAX_BYTES ||
			!/^[0-9a-f]{64}$/.test(args.hash) ||
			args.basisKind.length === 0 ||
			args.basisVersion.length === 0
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Drafts capture from saved-file editors only; pending-created files edit their proposal.
		const authorized = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			path: args.path,
			sourceKind: "draft",
		})) as authorize_browser_source_Result;
		if (authorized._nay) {
			return authorized;
		}

		const now = Date.now();
		const counted = await browser_daily_use_count(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			kind: "captures",
			now,
		});
		if (!counted) {
			return Result({ _nay: { message: "Daily browser capture limit reached." } });
		}
		const captureId = await ctx.db.insert("files_browser_draft_captures", {
			ownerId: user._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			revision: args.revision,
			basisKind: args.basisKind,
			basisVersion: args.basisVersion,
			navigationGeneration: args.navigationGeneration,
			byteSize: args.byteSize,
			hash: args.hash,
			createdAt: now,
			expiresAt: now + BROWSER_CAPTURE_TTL_MS,
		});
		const uploadUrl = await ctx.storage.generateUploadUrl();
		return Result({ _yay: { captureId, uploadUrl } });
	},
});

/**
 * Bind an uploaded blob to its capture. Runs right after the editor upload so the expiry sweep
 * can delete the bytes of an abandoned capture.
 */
export const attach_draft_capture_blob = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		captureId: v.id("files_browser_draft_captures"),
		storageId: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const capture = await ctx.db.get("files_browser_draft_captures", args.captureId);
		if (!capture || capture.ownerId !== user._id || capture.expiresAt <= Date.now()) {
			return Result({ _nay: { message: "Not found" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (
			!membership ||
			membership.organizationId !== capture.organizationId ||
			membership.workspaceId !== capture.workspaceId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const storageId = ctx.db.system.normalizeId("_storage", args.storageId);
		if (!storageId) {
			return Result({ _nay: { message: "Not found" } });
		}
		await ctx.db.patch("files_browser_draft_captures", args.captureId, { storageId });
		return Result({ _yay: null });
	},
});

export const get_draft_capture = internalQuery({
	args: {
		captureId: v.id("files_browser_draft_captures"),
	},
	returns: v.union(doc(app_convex_schema, "files_browser_draft_captures"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db.get("files_browser_draft_captures", args.captureId);
	},
});

type get_draft_capture_Result =
	typeof get_draft_capture extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Delete one consumed capture and its blob. Runs after a successful start; the expiry sweep
 * covers abandoned captures.
 */
export const delete_draft_capture = internalMutation({
	args: {
		captureId: v.id("files_browser_draft_captures"),
		storageId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.delete("files_browser_draft_captures", args.captureId);
		const storageId = ctx.db.system.normalizeId("_storage", args.storageId);
		if (storageId) {
			await ctx.storage.delete(storageId);
		}
		return null;
	},
});

/**
 * Confirm runner liveness without extending idle time. Only confirmed loss retires the doc;
 * transport failures leave it intact so a slow runner cannot close a live human session.
 */
async function refresh_browser_session_liveness(ctx: ActionCtx, session: Doc<"files_browser_sessions">) {
	const checked = await files_browser_runner_call({
		route: "status",
		body: {
			sessionId: session.runnerSessionId,
			ownerId: session.ownerId,
			organizationId: session.organizationId,
			workspaceId: session.workspaceId,
		},
	});
	if (checked._nay) {
		return checked;
	}
	const parsed = z.object({ ok: z.literal(true), alive: z.boolean() }).safeParse(checked._yay);
	if (!parsed.success) {
		return Result({ _nay: { message: "Browser request failed" } });
	}
	// A mirrored idle deadline may lag behind human input. Only the runner can confirm loss.
	if (!parsed.data.alive) {
		await ctx.runMutation(internal.files_browser.finish_close_browser_session, { sessionId: session._id });
	}
	return Result({ _yay: parsed.data.alive });
}

/**
 * Start one shared cloud browser for the selected file and source. Saved and proposed bytes
 * resolve server-side with Preview parity; draft bytes arrive through a capture upload.
 *
 * Repeated starts for the same live file and source reattach after fresh access checks.
 * An ended runner frees the slot; switching a live session needs an explicit End first.
 */
export const start_browser = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		targetKind: v.union(v.literal("saved"), v.literal("private")),
		nodeId: v.string(),
		path: v.string(),
		sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
		navigationGeneration: v.number(),
		navigationClientId: v.string(),
		viewport: v.object({ width: v.number(), height: v.number() }),
		draftCaptureId: v.optional(v.id("files_browser_draft_captures")),
		draftStorageId: v.optional(v.string()),
		draftRevisionAfter: v.optional(v.number()),
	},
	returns: v_result({
		_yay: v.object({
			sessionId: v.id("files_browser_sessions"),
			targetKind: v.union(v.literal("saved"), v.literal("private")),
			nodeId: v.string(),
			path: v.string(),
			navigationGeneration: v.number(),
			sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
			sourceVersion: v.string(),
			sourceHash: v.string(),
			loadGen: v.number(),
			controlGen: v.number(),
			control: v.string(),
			idleUntil: v.union(v.number(), v.null()),
			totalUntil: v.union(v.number(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		if (args.sourceKind === "draft" && (!args.draftCaptureId || !args.draftStorageId)) {
			return Result({ _nay: { message: "Choose an available source." } });
		}

		const existing = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
		})) as load_browser_session_Result;
		if (existing._yay?.runnerSessionId) {
			const checked = await refresh_browser_session_liveness(ctx, existing._yay);
			if (checked._nay) {
				return checked;
			}
		}

		const created = (await ctx.runMutation(internal.files_browser.create_starting_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			targetKind: args.targetKind,
			nodeId: args.nodeId,
			path: args.path,
			sourceKind: args.sourceKind,
			navigationGeneration: args.navigationGeneration,
			navigationClientId: args.navigationClientId,
			viewportWidth: args.viewport.width,
			viewportHeight: args.viewport.height,
		})) as create_starting_browser_session_Result;
		if (created._nay) {
			return created;
		}

		const discardStarting = async () => {
			await ctx.runMutation(internal.files_browser.delete_starting_browser_session, {
				sessionId: created._yay.sessionId,
			});
		};

		const authorized = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			path: args.path,
			sourceKind: args.sourceKind,
			includeText: true,
		})) as authorize_browser_source_Result;
		if (authorized._nay) {
			if (!created._yay.reattached) {
				await discardStarting();
			}
			return authorized;
		}

		// Reattach keeps the loaded page after fresh access checks. The UI compares its
		// loaded version with the source to offer Reload when edits are available.
		if (created._yay.reattached) {
			const live = (await ctx.runQuery(internal.files_browser.load_browser_session, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				membershipId: args.membershipId,
				sessionId: created._yay.sessionId,
			})) as load_browser_session_Result;
			if (live._nay) {
				return live;
			}
			return Result({ _yay: session_public_meta(live._yay) });
		}

		let html: string;
		if (authorized._yay.text !== undefined) {
			html = authorized._yay.text;
		} else if (args.sourceKind === "draft") {
			const draftCaptureId = args.draftCaptureId;
			const draftStorageId = args.draftStorageId;
			if (!draftCaptureId || !draftStorageId) {
				await discardStarting();
				return Result({ _nay: { message: "Choose an available source." } });
			}
			const draft = await read_draft_capture_blob(ctx, {
				captureId: draftCaptureId,
				storageId: draftStorageId,
				revisionAfter: args.draftRevisionAfter,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				nodeId: args.nodeId,
				navigationGeneration: args.navigationGeneration,
			});
			if (draft._nay) {
				await discardStarting();
				return draft;
			}
			html = draft._yay.text;
		} else {
			const saved = await read_saved_snapshot_text(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				path: args.path,
			});
			if (saved._nay) {
				await discardStarting();
				return saved;
			}
			html = saved._yay;
		}

		if (files_get_utf8_byte_size(html) > BROWSER_HTML_MAX_BYTES) {
			await discardStarting();
			return Result({ _nay: { message: "HTML exceeds the 900,000-byte preview limit." } });
		}

		// Re-verify identity after the slow read: bytes and label must match at load time.
		const rechecked = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			path: args.path,
			sourceKind: args.sourceKind,
		})) as authorize_browser_source_Result;
		if (
			rechecked._nay ||
			rechecked._yay.version !== authorized._yay.version ||
			rechecked._yay.snapshotKey !== authorized._yay.snapshotKey
		) {
			await discardStarting();
			return Result({ _nay: { message: "The source changed while loading. Refresh to try again." } });
		}

		const hash = await crypto_sha256_hex(html);
		const opened = await files_browser_runner_call({
			route: "open",
			body: {
				attemptId: crypto.randomUUID(),
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				navGen: args.navigationGeneration,
				sourceKind: args.sourceKind,
				sourceVersion: authorized._yay.version,
				sourceHash: hash,
				html,
				viewport: args.viewport,
			},
		});
		if (opened._nay) {
			await discardStarting();
			console.error("Browser open failed", { code: opened._nay.message });
			return Result({ _nay: { message: "Browser did not start" } });
		}
		const parsed = files_browser_runner_open_schema.safeParse(opened._yay);
		if (!parsed.success) {
			await discardStarting();
			console.error("Browser open returned an invalid response", {});
			return Result({ _nay: { message: "Browser did not start" } });
		}

		const now = Date.now();
		const committed = (await ctx.runMutation(internal.files_browser.commit_live_browser_session, {
			sessionId: created._yay.sessionId,
			navigationGeneration: args.navigationGeneration,
			sourceVersion: authorized._yay.version,
			sourceHash: hash,
			loadGen: 1,
			controlGen: 1,
			runnerSessionId: parsed.data.session.sessionId,
			idleUntil: now + 5 * 60 * 1000,
			totalUntil: now + 20 * 60 * 1000,
		})) as commit_live_browser_session_Result;
		if (committed._nay) {
			// The file moved on while the runner was opening. Close the orphan at once.
			await files_browser_runner_call({
				route: "close",
				body: {
					sessionId: parsed.data.session.sessionId,
					ownerId: user._id,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
				},
			});
			await discardStarting();
			return Result({ _nay: { message: "The file changed. Refresh to try again." } });
		}

		// Draft bytes are one-shot: the open consumed them.
		if (args.sourceKind === "draft" && args.draftCaptureId && args.draftStorageId) {
			await ctx.runMutation(internal.files_browser.delete_draft_capture, {
				captureId: args.draftCaptureId,
				storageId: args.draftStorageId,
			});
		}

		const live = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: created._yay.sessionId,
		})) as load_browser_session_Result;
		if (live._nay) {
			return live;
		}
		return Result({ _yay: session_public_meta(live._yay) });
	},
});

/**
 * Mark one session closing and hand back its runner identity. Ends from the owning file tab and
 * explicit Ends elsewhere share this door.
 */
export const begin_close_browser_session = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		expectedAgentLease: v.optional(browser_agent_lease_validator),
	},
	returns: v_result({
		_yay: v.object({
			runnerSessionId: v.union(v.string(), v.null()),
			ownerId: v.id("users"),
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
		}),
	}),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (
			!membership ||
			membership.organizationId !== args.organizationId ||
			membership.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (
			!session ||
			session.ownerId !== args.userId ||
			session.organizationId !== args.organizationId ||
			session.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (session.control === "closed") {
			return Result({
				_yay: {
					runnerSessionId: null,
					ownerId: session.ownerId,
					organizationId: session.organizationId,
					workspaceId: session.workspaceId,
				},
			});
		}

		const expectedAgentLease = args.expectedAgentLease;
		if (
			expectedAgentLease &&
			(session.control !== "ready" ||
				session.controlGen !== expectedAgentLease.controlGen ||
				session.loadGen !== expectedAgentLease.loadGen ||
				session.navigationGeneration !== expectedAgentLease.navGen)
		) {
			return Result({ _nay: { message: "Browser control changed" } });
		}
		// Agent close must win its runner lease check before changing the app session.
		if (!expectedAgentLease) {
			await ctx.db.patch("files_browser_sessions", args.sessionId, {
				control: "closing",
				updatedAt: Date.now(),
			});
		}
		return Result({
			_yay: {
				runnerSessionId: session.runnerSessionId ?? null,
				ownerId: session.ownerId,
				organizationId: session.organizationId,
				workspaceId: session.workspaceId,
			},
		});
	},
});

type begin_close_browser_session_Result =
	typeof begin_close_browser_session extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const finish_close_browser_session = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (session && session.control !== "closed") {
			const now = Date.now();
			await ctx.db.patch("files_browser_sessions", args.sessionId, {
				control: "closed",
				closedAt: now,
				updatedAt: now,
			});
		}
		return null;
	},
});

/**
 * End one browser session: retire every lease, close the provider browser, and mark the doc
 * closed. Human End also closes the doc after a runner failure; its idle alarm reaps the
 * orphan. Agent End preserves the session when its frozen lease is refused.
 */
export const end_browser = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		expectedAgentLease: v.optional(browser_agent_lease_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const begun = (await ctx.runMutation(internal.files_browser.begin_close_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
			expectedAgentLease: args.expectedAgentLease,
		})) as begin_close_browser_session_Result;
		if (begun._nay) {
			return begun;
		}

		if (begun._yay.runnerSessionId) {
			const closed = await files_browser_runner_call({
				route: "close",
				body: {
					sessionId: begun._yay.runnerSessionId,
					ownerId: begun._yay.ownerId,
					organizationId: begun._yay.organizationId,
					workspaceId: begun._yay.workspaceId,
					expectedAgentLease: args.expectedAgentLease,
				},
			});
			if (closed._nay) {
				if (args.expectedAgentLease) {
					return closed;
				}
				console.error("Browser close failed", { message: closed._nay.message });
			}
		}

		await ctx.runMutation(internal.files_browser.finish_close_browser_session, {
			sessionId: args.sessionId,
		});
		return Result({ _yay: null });
	},
});

/**
 * The live path of one pending node, or null when it is gone. Walks the parent chain:
 * pending parents recurse, a saved parent contributes its stored path, root ends it.
 */
async function get_pending_node_current_path(
	ctx: QueryCtx,
	args: { nodeId: Id<"files_pending_nodes"> },
): Promise<string | null> {
	const segments: Array<string> = [];
	let parent: { kind: string; id?: unknown } | null = null;
	let nodeId: Id<"files_pending_nodes"> | null = args.nodeId;
	for (let depth = 0; depth < 64 && nodeId; depth++) {
		const node = await ctx.db.get("files_pending_nodes", nodeId);
		if (!node || node.state !== "active") {
			return null;
		}
		segments.unshift(node.name);
		parent = node.parent as { kind: string; id?: unknown };
		if (parent.kind !== "pending" || typeof parent.id !== "string") {
			break;
		}
		nodeId = ctx.db.normalizeId("files_pending_nodes", parent.id);
	}
	if (!parent) {
		return null;
	}
	if (parent.kind === "root") {
		return `/${segments.join("/")}`;
	}
	if (parent.kind === "saved" && typeof parent.id === "string") {
		const savedId = ctx.db.normalizeId("files_nodes", parent.id);
		const saved = savedId ? await ctx.db.get("files_nodes", savedId) : null;
		if (!saved) {
			return null;
		}
		return `${saved.path}/${segments.join("/")}`;
	}

	return null;
}

/**
 * The live path behind one browser session, or null when the node is gone. Sessions outlive
 * renames: authorizing with the frozen start path would hide or end them after a move.
 */
export const get_browser_session_live_path = internalQuery({
	args: {
		targetKind: v.union(v.literal("saved"), v.literal("private")),
		nodeId: v.string(),
		fallbackPath: v.string(),
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		if (args.targetKind === "saved") {
			const nodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
			const node = nodeId ? await ctx.db.get("files_nodes", nodeId) : null;
			return node?.path ?? args.fallbackPath;
		}
		const pendingId = ctx.db.normalizeId("files_pending_nodes", args.nodeId);
		if (!pendingId) {
			return args.fallbackPath;
		}
		return (await get_pending_node_current_path(ctx, { nodeId: pendingId })) ?? args.fallbackPath;
	},
});

/**
 * Reload the live page from a newer snapshot of the same file and source kind. Drafts always
 * need a fresh capture; switching kinds is a user Start choice, never an agent reload.
 */
export const reload_browser = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		path: v.string(),
		expectedAgentLease: v.optional(browser_agent_lease_validator),
		draftCaptureId: v.optional(v.id("files_browser_draft_captures")),
		draftStorageId: v.optional(v.string()),
		draftRevisionAfter: v.optional(v.number()),
	},
	returns: v_result({
		_yay: v.object({
			loadGen: v.number(),
			sourceVersion: v.string(),
			sourceHash: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
		})) as load_browser_session_Result;
		if (loaded._nay) {
			return loaded;
		}
		const session = loaded._yay;
		if (!session.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Resolve the live path from the node id: a rename since Start must not break reload.
		const path = (await ctx.runQuery(internal.files_browser.get_browser_session_live_path, {
			targetKind: session.targetKind,
			nodeId: session.nodeId,
			fallbackPath: args.path,
		})) as string;

		const authorized = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			nodeId: session.nodeId,
			path,
			sourceKind: session.sourceKind,
			includeText: true,
		})) as authorize_browser_source_Result;
		if (authorized._nay) {
			return authorized;
		}

		let html: string;
		if (authorized._yay.text !== undefined) {
			html = authorized._yay.text;
		} else if (session.sourceKind === "draft") {
			const draftCaptureId = args.draftCaptureId;
			const draftStorageId = args.draftStorageId;
			if (!draftCaptureId || !draftStorageId) {
				return Result({ _nay: { message: "Choose an available source." } });
			}
			const draft = await read_draft_capture_blob(ctx, {
				captureId: draftCaptureId,
				storageId: draftStorageId,
				revisionAfter: args.draftRevisionAfter,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				nodeId: session.nodeId,
				navigationGeneration: session.navigationGeneration,
			});
			if (draft._nay) {
				return draft;
			}
			html = draft._yay.text;
		} else {
			const saved = await read_saved_snapshot_text(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				path,
			});
			if (saved._nay) {
				return saved;
			}
			html = saved._yay;
		}

		if (files_get_utf8_byte_size(html) > BROWSER_HTML_MAX_BYTES) {
			return Result({ _nay: { message: "HTML exceeds the 900,000-byte preview limit." } });
		}

		// Re-verify identity after the slow read, like Start does: bytes and label must match
		// at load time, so a mid-read edit cannot land under a fresh version.
		const rechecked = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			nodeId: session.nodeId,
			path,
			sourceKind: session.sourceKind,
		})) as authorize_browser_source_Result;
		if (
			rechecked._nay ||
			rechecked._yay.version !== authorized._yay.version ||
			rechecked._yay.snapshotKey !== authorized._yay.snapshotKey
		) {
			return Result({ _nay: { message: "The source changed while loading. Refresh to try again." } });
		}

		const reloaded = await files_browser_runner_call({
			route: "reload",
			body: {
				sessionId: session.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				navGen: session.navigationGeneration,
				expectedAgentLease: args.expectedAgentLease,
				sourceKind: session.sourceKind,
				sourceVersion: authorized._yay.version,
				sourceHash: await crypto_sha256_hex(html),
				html,
			},
		});
		if (reloaded._nay) {
			console.error("Browser reload failed", { message: reloaded._nay.message });
			return Result({ _nay: { message: "Browser did not reload" } });
		}

		const updated = (await ctx.runMutation(internal.files_browser.commit_browser_reload, {
			sessionId: args.sessionId,
			sourceVersion: authorized._yay.version,
			sourceHash: await crypto_sha256_hex(html),
		})) as commit_browser_reload_Result;
		if (updated._nay) {
			return updated;
		}

		if (session.sourceKind === "draft" && args.draftCaptureId && args.draftStorageId) {
			await ctx.runMutation(internal.files_browser.delete_draft_capture, {
				captureId: args.draftCaptureId,
				storageId: args.draftStorageId,
			});
		}

		return Result({ _yay: updated._yay });
	},
});

export const commit_browser_reload = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		sourceVersion: v.string(),
		sourceHash: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			loadGen: v.number(),
			sourceVersion: v.string(),
			sourceHash: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (!session || session.control === "closed" || session.control === "closing") {
			return Result({ _nay: { message: "Not found" } });
		}
		const loadGen = session.loadGen + 1;
		await ctx.db.patch("files_browser_sessions", args.sessionId, {
			sourceVersion: args.sourceVersion,
			sourceHash: args.sourceHash,
			loadGen,
			updatedAt: Date.now(),
		});
		return Result({ _yay: { loadGen, sourceVersion: args.sourceVersion, sourceHash: args.sourceHash } });
	},
});

type commit_browser_reload_Result =
	typeof commit_browser_reload extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Re-check live file access for viewer-side doors, and close the session promptly when it is
 * gone. Watching, taking, resuming, or extending must not survive a revoke, archive, delete,
 * or type change; the agent lease check refuses the same way without closing.
 */
async function authorize_live_browser_source(
	ctx: ActionCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		userId: Id<"users">;
		session: Doc<"files_browser_sessions">;
	},
): Promise<{ ok: true } | { ok: false; message: string }> {
	const path = (await ctx.runQuery(internal.files_browser.get_browser_session_live_path, {
		targetKind: args.session.targetKind,
		nodeId: args.session.nodeId,
		fallbackPath: args.session.path,
	})) as string;
	const authorized = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		userId: args.userId,
		membershipId: args.membership._id,
		nodeId: args.session.nodeId,
		path,
		sourceKind: args.session.sourceKind,
	})) as authorize_browser_source_Result;
	if (authorized._nay) {
		await ctx.runAction(api.files_browser.end_browser, {
			membershipId: args.membership._id,
			sessionId: args.session._id,
		});
		return { ok: false, message: authorized._nay.message };
	}
	return { ok: true };
}

/**
 * Extend the idle deadline after explicit user attention. Never extends the total cap.
 */
export const keep_open_browser = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
	},
	returns: v_result({ _yay: v.object({ idleUntil: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
		})) as load_browser_session_Result;
		if (loaded._nay) {
			return loaded;
		}
		if (!loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_source(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		const kept = await files_browser_runner_call({
			route: "keep-open",
			body: {
				sessionId: loaded._yay.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				navGen: loaded._yay.navigationGeneration,
			},
		});
		if (kept._nay) {
			return kept;
		}

		const idleUntil = Date.now() + 5 * 60 * 1000;
		await ctx.runMutation(internal.files_browser.touch_browser_session_idle, {
			sessionId: args.sessionId,
			idleUntil,
		});
		return Result({ _yay: { idleUntil } });
	},
});

export const touch_browser_session_idle = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		idleUntil: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (session && session.control !== "closed") {
			await ctx.db.patch("files_browser_sessions", args.sessionId, {
				idleUntil: args.idleUntil,
				updatedAt: Date.now(),
			});
		}
		return null;
	},
});

/**
 * Mint one single-use viewer grant for an authorized session. No thread needed: watching the
 * live page is a file operation, not a chat operation. Shared chat access never grants it.
 */
export const grant_browser_viewer = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
	},
	returns: v_result({ _yay: v.object({ grantId: v.string(), expiresAt: v.number(), viewerUrl: v.string() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
		})) as load_browser_session_Result;
		if (loaded._nay) {
			return loaded;
		}
		if (!loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const viewerUrl = files_browser_runner_viewer_url();
		if (!viewerUrl) {
			return Result({ _nay: { message: "Browser unavailable" } });
		}

		const source = await authorize_live_browser_source(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		const granted = await files_browser_runner_call({
			route: "viewer-grant",
			body: {
				sessionId: loaded._yay.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				navGen: loaded._yay.navigationGeneration,
			},
		});
		if (granted._nay) {
			const checked = await refresh_browser_session_liveness(ctx, loaded._yay);
			if (checked._nay) {
				console.error("Browser status check failed", { message: checked._nay.message });
			}
			return granted;
		}
		const parsed = z
			.object({ ok: z.literal(true), grantId: z.string(), expiresAt: z.number() })
			.safeParse(granted._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		return Result({ _yay: { grantId: parsed.data.grantId, expiresAt: parsed.data.expiresAt, viewerUrl } });
	},
});

/**
 * Renew one live viewer after re-checking access. The app calls this on a timer; a revoked
 * member is refused here and the runner ends their socket at the grant deadline.
 */
export const renew_browser_viewer = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		viewerId: v.string(),
	},
	returns: v_result({
		_yay: v.object({ grantedUntil: v.number(), control: v.string(), controlGen: v.number() }),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
		})) as load_browser_session_Result;
		if (loaded._nay) {
			return loaded;
		}
		if (!loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_source(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		const renewed = await files_browser_runner_call({
			route: "viewer-renew",
			body: {
				sessionId: loaded._yay.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				viewerId: args.viewerId,
			},
		});
		if (renewed._nay) {
			const checked = await refresh_browser_session_liveness(ctx, loaded._yay);
			if (checked._nay) {
				console.error("Browser status check failed", { message: checked._nay.message });
			}
			return renewed;
		}
		const parsed = z
			.object({
				ok: z.literal(true),
				grantedUntil: z.number(),
				control: z.string(),
				controlGen: z.number(),
				idleUntil: z.number(),
			})
			.safeParse(renewed._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		// The runner owns the idle deadline: human input extends it without touching the doc,
		// so mirror it for the countdown display.
		if (loaded._yay.idleUntil !== parsed.data.idleUntil) {
			await ctx.runMutation(internal.files_browser.touch_browser_session_idle, {
				sessionId: args.sessionId,
				idleUntil: parsed.data.idleUntil,
			});
		}
		// Mirror runner-led control changes the doc cannot see: a detach that released human
		// input, or a finish that completed a pausing handoff. Take and resume sync both sides
		// themselves; anything else is left alone so a racing take always wins.
		const docControl = loaded._yay.control;
		const docGen = loaded._yay.controlGen;
		const runnerControl = parsed.data.control;
		const runnerGen = parsed.data.controlGen;
		if (
			(runnerControl === "ready" &&
				(docControl === "human" || docControl === "pausing") &&
				runnerGen > docGen) ||
			(runnerControl === "human" && docControl === "pausing" && runnerGen === docGen)
		) {
			await ctx.runMutation(internal.files_browser.set_browser_control, {
				sessionId: args.sessionId,
				control: runnerControl as "ready" | "human",
				controlGen: runnerGen,
			});
		}
		return Result({
			_yay: {
				grantedUntil: parsed.data.grantedUntil,
				control: parsed.data.control,
				controlGen: parsed.data.controlGen,
			},
		});
	},
});

export const set_browser_control = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		control: v.union(v.literal("ready"), v.literal("human"), v.literal("pausing")),
		controlGen: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		// Replies may arrive out of order. Only pausing -> human can advance within one
		// generation; an older take or renew must not undo that handoff or reopen End.
		if (
			session &&
			session.control !== "closed" &&
			session.control !== "closing" &&
			(args.controlGen > session.controlGen ||
				(args.controlGen === session.controlGen &&
					(args.control === session.control || (session.control === "pausing" && args.control === "human"))))
		) {
			await ctx.db.patch("files_browser_sessions", args.sessionId, {
				control: args.control,
				controlGen: args.controlGen,
				updatedAt: Date.now(),
			});
		}
		return null;
	},
});

/**
 * Hand control to one attached viewer. A running command finishes first (pausing) and the
 * handoff completes at its finish; new agent commands are refused meanwhile.
 */
export const take_browser_control = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		viewerId: v.string(),
	},
	returns: v_result({ _yay: v.object({ control: v.string(), controlGen: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
		})) as load_browser_session_Result;
		if (loaded._nay) {
			return loaded;
		}
		if (!loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_source(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		const taken = await files_browser_runner_call({
			route: "control-take",
			body: {
				sessionId: loaded._yay.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				navGen: loaded._yay.navigationGeneration,
				viewerId: args.viewerId,
			},
		});
		if (taken._nay) {
			return taken;
		}
		const parsed = z
			.object({ ok: z.literal(true), control: z.string(), controlGen: z.number() })
			.safeParse(taken._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		if (parsed.data.control === "human" || parsed.data.control === "pausing") {
			await ctx.runMutation(internal.files_browser.set_browser_control, {
				sessionId: args.sessionId,
				control: parsed.data.control,
				controlGen: parsed.data.controlGen,
			});
		}
		return Result({ _yay: { control: parsed.data.control, controlGen: parsed.data.controlGen } });
	},
});

/**
 * Hand control back to the agent side for the exact paused thread. The caller proves the thread;
 * the runner atomically ends human input and readies a fresh request lease.
 */
export const resume_browser_agent = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		threadId: v.id("ai_chat_threads"),
	},
	returns: v_result({ _yay: v.object({ control: v.string(), controlGen: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
		})) as load_browser_session_Result;
		if (loaded._nay) {
			return loaded;
		}

		const thread = await ctx.runQuery(api.ai_chat.thread_get, {
			membershipId: args.membershipId,
			threadId: args.threadId,
		});
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_source(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		const resumed = await files_browser_runner_call({
			route: "control-resume",
			body: {
				sessionId: loaded._yay.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				navGen: loaded._yay.navigationGeneration,
			},
		});
		if (resumed._nay) {
			return resumed;
		}
		const parsed = z
			.object({ ok: z.literal(true), control: z.string(), controlGen: z.number() })
			.safeParse(resumed._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		if (parsed.data.control === "ready") {
			await ctx.runMutation(internal.files_browser.set_browser_control, {
				sessionId: args.sessionId,
				control: "ready",
				controlGen: parsed.data.controlGen,
			});
		}
		return Result({ _yay: { control: parsed.data.control, controlGen: parsed.data.controlGen } });
	},
});

/**
 * The owner's live browser session for this workspace, if any. Safe metadata only: the runner
 * session id never leaves the server.
 */
export const current_browser_session = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.union(
		v.object({
			sessionId: v.id("files_browser_sessions"),
			targetKind: v.union(v.literal("saved"), v.literal("private")),
			nodeId: v.string(),
			path: v.string(),
			navigationGeneration: v.number(),
			sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
			sourceVersion: v.string(),
			sourceHash: v.string(),
			loadGen: v.number(),
			controlGen: v.number(),
			control: v.string(),
			idleUntil: v.union(v.number(), v.null()),
			totalUntil: v.union(v.number(), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const session = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_owner_organization_workspace", (q) =>
				q
					.eq("ownerId", user._id)
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId),
			)
			.filter((q) =>
				q.or(
					q.eq(q.field("control"), "starting"),
					q.eq(q.field("control"), "ready"),
					q.eq(q.field("control"), "human"),
					q.eq(q.field("control"), "pausing"),
				),
			)
			.first();
		if (!session) {
			return null;
		}
		// Hide sessions whose file is no longer accessible. The next viewer door closes the
		// session itself; a query cannot do that.
		const path = (await ctx.runQuery(internal.files_browser.get_browser_session_live_path, {
			targetKind: session.targetKind,
			nodeId: session.nodeId,
			fallbackPath: session.path,
		})) as string;
		const authorized = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			nodeId: session.nodeId,
			path,
			sourceKind: session.sourceKind,
		})) as authorize_browser_source_Result;
		if (authorized._nay) {
			return null;
		}
		return session_public_meta(session);
	},
});

/**
 * The current loadable version of one HTML source, without its bytes. The Files panel compares
 * this against the loaded session version to show Updates available. Version strings compare
 * equal only for the exact same bytes and basis.
 */
export const browser_source_current_version = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.string(),
		path: v.string(),
		sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
	},
	returns: v.union(v.object({ version: v.string(), snapshotKey: v.string() }), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const authorized = (await ctx.runQuery(internal.files_browser.authorize_browser_source, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			path: args.path,
			sourceKind: args.sourceKind,
		})) as authorize_browser_source_Result;
		if (authorized._nay) {
			return null;
		}
		return { version: authorized._yay.version, snapshotKey: authorized._yay.snapshotKey };
	},
});

/**
 * The file behind one stored browser result, for chat links. Creator-only like the result
 * itself: a null means the result was deleted or belongs to someone else, and the chat then
 * shows status text without a link. Expired results keep their file pointer with a flag, so
 * the chat can suggest a rerun instead of going silent.
 */
export const browser_result_file = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		resultId: v.id("ai_chat_browser_results"),
	},
	returns: v.union(
		v.object({
			nodeId: v.string(),
			targetKind: v.union(v.literal("saved"), v.literal("private")),
			expired: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const checked = (await ctx.runQuery(internal.files_browser.get_authorized_browser_result, {
			userId: user._id,
			membershipId: args.membershipId,
			resultId: args.resultId,
		})) as get_authorized_browser_result_Result;
		if (checked) {
			return { nodeId: checked.result.nodeId, targetKind: checked.result.targetKind, expired: false };
		}

		// Distinguish "expired" from "never yours": the file pointer stays useful for a rerun,
		// and Files authorizes the file itself when the link opens.
		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		const result = await ctx.db.get("ai_chat_browser_results", args.resultId);
		if (
			!membership ||
			!result ||
			result.ownerId !== user._id ||
			result.organizationId !== membership.organizationId ||
			result.workspaceId !== membership.workspaceId ||
			result.expiresAt > Date.now()
		) {
			return null;
		}
		return { nodeId: result.nodeId, targetKind: result.targetKind, expired: true };
	},
});

/**
 * Recent live results of one chat for the Files panel. Creator-only, newest first. Expired
 * results drop out of the list; the chat link covers the rerun hint.
 */
export const list_browser_results = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
	},
	returns: v.array(
		v.object({
			resultId: v.id("ai_chat_browser_results"),
			createdAt: v.number(),
			sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
			sourceVersion: v.string(),
			sourceHash: v.string(),
			loadGen: v.number(),
			imageCount: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (
			!thread ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId
		) {
			return [];
		}

		const now = Date.now();
		const results = await ctx.db
			.query("ai_chat_browser_results")
			.withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
			.filter((q) =>
				q.and(
					q.eq(q.field("ownerId"), user._id),
					q.eq(q.field("organizationId"), membership.organizationId),
					q.eq(q.field("workspaceId"), membership.workspaceId),
					q.gt(q.field("expiresAt"), now),
				),
			)
			.order("desc")
			.take(20);
		// Same node gate as the read path: metadata must not outlive file access.
		const visible = await Promise.all(
			results.map(async (result) => {
				if (result.targetKind === "saved") {
					const nodeId = ctx.db.normalizeId("files_nodes", result.nodeId);
					if (!nodeId) {
						return null;
					}
					const authorized = await access_control_db_authorize_node(ctx, {
						userAuth: { id: user._id },
						membership,
						nodeId,
						permission: "content.read",
					});
					if (authorized._nay) {
						return null;
					}
				} else {
					const pendingNodeId = ctx.db.normalizeId("files_pending_nodes", result.nodeId);
					const pendingNode = pendingNodeId ? await ctx.db.get("files_pending_nodes", pendingNodeId) : null;
					if (!pendingNode || pendingNode.userId !== user._id) {
						return null;
					}
				}
				return {
					resultId: result._id,
					createdAt: result.createdAt,
					sourceKind: result.sourceKind,
					sourceVersion: result.sourceVersion,
					sourceHash: result.sourceHash,
					loadGen: result.loadGen,
					imageCount: result.images.length,
				};
			}),
		);
		return visible.filter((entry) => entry !== null);
	},
});

/**
 * Store one private browser capture. Called by the server tool right after a run, with R2
 * assets already uploaded: the text JSON and every image. Creator-only by construction.
 */
export const store_browser_result = internalMutation({
	args: {
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		threadId: v.id("ai_chat_threads"),
		sessionId: v.id("files_browser_sessions"),
		targetKind: v.union(v.literal("saved"), v.literal("private")),
		nodeId: v.string(),
		sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
		sourceVersion: v.string(),
		sourceHash: v.string(),
		loadGen: v.number(),
		runId: v.string(),
		toolCallId: v.string(),
		commandId: v.string(),
		textAssetId: v.id("files_r2_assets"),
		images: v.array(
			v.object({
				assetId: v.id("files_r2_assets"),
				mime: v.string(),
				width: v.number(),
				height: v.number(),
			}),
		),
		textBytes: v.number(),
		imageBytes: v.number(),
	},
	returns: v.id("ai_chat_browser_results"),
	handler: async (ctx, args) => {
		for (const image of args.images) {
			if (
				(image.mime !== "image/png" && image.mime !== "image/jpeg") ||
				!Number.isInteger(image.width) ||
				!Number.isInteger(image.height) ||
				image.width <= 0 ||
				image.height <= 0
			) {
				throw convex_error({ message: "Invalid browser result image" });
			}
		}

		const now = Date.now();
		const resultId = await ctx.db.insert("ai_chat_browser_results", {
			ownerId: args.ownerId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			threadId: args.threadId,
			sessionId: args.sessionId,
			targetKind: args.targetKind,
			nodeId: args.nodeId,
			sourceKind: args.sourceKind,
			sourceVersion: args.sourceVersion,
			sourceHash: args.sourceHash,
			loadGen: args.loadGen,
			runId: args.runId,
			toolCallId: args.toolCallId,
			commandId: args.commandId,
			textAssetId: args.textAssetId,
			images: args.images,
			textBytes: args.textBytes,
			imageBytes: args.imageBytes,
			expiresAt: now + BROWSER_RESULT_TTL_MS,
			createdAt: now,
		});

		await r2_db_finalize_browser_result_asset(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: args.textAssetId,
		});
		for (const image of args.images) {
			await r2_db_finalize_browser_result_asset(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: image.assetId,
			});
		}
		return resultId;
	},
});

/**
 * Authorize one result read: creator-only, thread-scoped, with live source access. A removed
 * proposal does not revoke an old capture; node access does.
 */
async function authorize_browser_result_read(
	ctx: QueryCtx,
	args: {
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		resultId: Id<"ai_chat_browser_results">;
	},
): Promise<{ result: Doc<"ai_chat_browser_results">; membership: Doc<"organizations_workspaces_users"> } | null> {
	const membership = await organizations_db_get_membership(ctx, {
		userId: args.userId,
		membershipId: args.membershipId,
	});
	if (!membership) {
		return null;
	}

	const result = await ctx.db.get("ai_chat_browser_results", args.resultId);
	if (
		!result ||
		result.ownerId !== args.userId ||
		result.organizationId !== membership.organizationId ||
		result.workspaceId !== membership.workspaceId ||
		result.expiresAt <= Date.now()
	) {
		return null;
	}

	const thread = await ctx.db.get("ai_chat_threads", result.threadId);
	if (
		!thread ||
		thread.organizationId !== membership.organizationId ||
		thread.workspaceId !== membership.workspaceId
	) {
		return null;
	}

	if (result.targetKind === "saved") {
		const nodeId = ctx.db.normalizeId("files_nodes", result.nodeId);
		if (!nodeId) {
			return null;
		}
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}
	} else {
		const pendingNodeId = ctx.db.normalizeId("files_pending_nodes", result.nodeId);
		const pendingNode = pendingNodeId ? await ctx.db.get("files_pending_nodes", pendingNodeId) : null;
		if (!pendingNode || pendingNode.userId !== args.userId) {
			return null;
		}
	}

	// No proposal-ownership check: results are creator-only, so the reader always owns any
	// live proposal on the source. A proposal accepted or discarded since the capture keeps its
	// history readable under node access alone.
	return { result, membership };
}

/**
 * Read one private result: the stored text plus short signed image URLs. Re-checks access
 * after signing before returning.
 */
export const read_browser_result = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		resultId: v.id("ai_chat_browser_results"),
	},
	returns: v_result({
		_yay: v.object({
			text: v.string(),
			sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
			sourceVersion: v.string(),
			sourceHash: v.string(),
			loadGen: v.number(),
			images: v.array(
				v.object({
					url: v.string(),
					mime: v.string(),
					width: v.number(),
					height: v.number(),
				}),
			),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const checked = (await ctx.runQuery(internal.files_browser.get_authorized_browser_result, {
			userId: user._id,
			membershipId: args.membershipId,
			resultId: args.resultId,
		})) as get_authorized_browser_result_Result;
		if (!checked) {
			return Result({ _nay: { message: "Not found" } });
		}

		const textAsset = (await ctx.runQuery(internal.files_browser.get_browser_result_asset, {
			assetId: checked.result.textAssetId,
		})) as get_browser_result_asset_Result;
		if (!textAsset?.r2Key) {
			return Result({ _nay: { message: "Not found" } });
		}
		const text = await r2_fetch_object_from_bucket({ key: textAsset.r2Key }).then((response) => response.text());

		const images: Array<{ url: string; mime: string; width: number; height: number }> = [];
		for (const image of checked.result.images) {
			const asset = (await ctx.runQuery(internal.files_browser.get_browser_result_asset, {
				assetId: image.assetId,
			})) as get_browser_result_asset_Result;
			if (!asset?.r2Key) {
				return Result({ _nay: { message: "Not found" } });
			}
			const url = await r2.getUrl(asset.r2Key, {
				// 5 minutes. A URL already issued stays usable until expiry.
				expiresIn: 5 * 60,
				responseContentType: image.mime,
				responseContentDisposition: `inline; filename="browser-result-${asset._id}"`,
			});
			images.push({ url, mime: image.mime, width: image.width, height: image.height });
		}

		// Re-check access after signing, before returning anything.
		const rechecked = (await ctx.runQuery(internal.files_browser.get_authorized_browser_result, {
			userId: user._id,
			membershipId: args.membershipId,
			resultId: args.resultId,
		})) as get_authorized_browser_result_Result;
		if (!rechecked) {
			return Result({ _nay: { message: "Not found" } });
		}

		return Result({
			_yay: {
				text,
				sourceKind: checked.result.sourceKind,
				sourceVersion: checked.result.sourceVersion,
				sourceHash: checked.result.sourceHash,
				loadGen: checked.result.loadGen,
				images,
			},
		});
	},
});

export const get_authorized_browser_result = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		resultId: v.string(),
	},
	returns: v.union(
		v.object({
			result: doc(app_convex_schema, "ai_chat_browser_results"),
			membership: doc(app_convex_schema, "organizations_workspaces_users"),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const resultId = ctx.db.normalizeId("ai_chat_browser_results", args.resultId);
		if (!resultId) {
			return null;
		}
		return await authorize_browser_result_read(ctx, { ...args, resultId });
	},
});

type get_authorized_browser_result_Result =
	typeof get_authorized_browser_result extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const get_browser_result_asset = internalQuery({
	args: {
		assetId: v.id("files_r2_assets"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!asset || asset.kind !== "browser_result") {
			return null;
		}
		return asset;
	},
});

type get_browser_result_asset_Result =
	typeof get_browser_result_asset extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const BROWSER_SWEEP_BATCH_SIZE = 50;

/**
 * Delete one expired result and queue exact-key cleanup for its R2 objects. Jobs enqueue before
 * the doc dies so a crash still cleans the bucket.
 */
async function delete_browser_result_with_assets(ctx: MutationCtx, resultId: Id<"ai_chat_browser_results">) {
	const result = await ctx.db.get("ai_chat_browser_results", resultId);
	if (!result) {
		return;
	}
	const assetIds = [result.textAssetId, ...result.images.map((image) => image.assetId)];
	for (const assetId of assetIds) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset || asset.kind !== "browser_result") {
			continue;
		}
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: result.organizationId,
			workspaceId: result.workspaceId,
			r2Key:
				asset.r2Key ??
				r2_create_asset_key({
					organizationId: result.organizationId,
					workspaceId: result.workspaceId,
					assetId: asset._id,
				}),
			reason: "browser_result_cleanup",
		});
		await ctx.db.delete("files_r2_assets", asset._id);
	}
	await ctx.db.delete("ai_chat_browser_results", resultId);
}

/**
 * Sweep expired browser docs: results with their R2 objects, draft captures with their blobs,
 * starting sessions that never committed, and closed sessions whose results are gone.
 */
export const cleanup_expired_browser_docs = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		let reschedule = false;

		const results = await ctx.db
			.query("ai_chat_browser_results")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const result of results) {
			await delete_browser_result_with_assets(ctx, result._id);
		}
		if (results.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		const captures = await ctx.db
			.query("files_browser_draft_captures")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const capture of captures) {
			if (capture.storageId) {
				await ctx.storage.delete(capture.storageId);
			}
			await ctx.db.delete("files_browser_draft_captures", capture._id);
		}
		if (captures.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		const starting = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_startingExpiresAt", (q) => q.gt("startingExpiresAt", 0).lte("startingExpiresAt", now))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		// Commit clears this deadline. It can remain after End during Start, so those
		// closing or closed attempts must drain with the unfinished starts too.
		for (const session of starting) {
			await ctx.db.delete("files_browser_sessions", session._id);
		}
		if (starting.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		const dayCutoff = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const dailyUseDocs = await ctx.db
			.query("files_browser_daily_use")
			.filter((q) => q.lt(q.field("day"), dayCutoff))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const dailyUse of dailyUseDocs) {
			await ctx.db.delete("files_browser_daily_use", dailyUse._id);
		}
		if (dailyUseDocs.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		const closedCutoff = now - BROWSER_RESULT_TTL_MS;
		const closedSessions = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_control_closedAt", (q) => q.eq("control", "closed").lt("closedAt", closedCutoff))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const session of closedSessions) {
			const liveResult = await ctx.db
				.query("ai_chat_browser_results")
				.withIndex("by_session", (q) => q.eq("sessionId", session._id))
				.first();
			if (!liveResult) {
				await ctx.db.delete("files_browser_sessions", session._id);
			}
		}
		if (closedSessions.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		if (reschedule) {
			await ctx.scheduler.runAfter(0, internal.files_browser.cleanup_expired_browser_docs, {});
		}
		return null;
	},
});

/**
 * Purge one workspace batch of browser docs. R2 objects stay for the generic asset pass, which
 * is exhaustive. Runner sessions orphaned here die on their idle alarm within minutes.
 */
export async function files_browser_db_purge_workspace_batch(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; batchSize: number },
) {
	const results = await ctx.db
		.query("ai_chat_browser_results")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (results.length > 0) {
		await Promise.all(results.map((result) => ctx.db.delete("ai_chat_browser_results", result._id)));
		return { done: false, deletedCount: results.length };
	}

	const sessions = await ctx.db
		.query("files_browser_sessions")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (sessions.length > 0) {
		await Promise.all(sessions.map((session) => ctx.db.delete("files_browser_sessions", session._id)));
		return { done: false, deletedCount: sessions.length };
	}

	// Draft captures expire within minutes and the hourly sweep deletes them with their blobs,
	// so the workspace purge leaves them alone.
	return { done: true, deletedCount: 0 };
}

/**
 * Drain one user's browser docs. Unlike the workspace purge, result R2 objects are queued here:
 * the shared workspace survives, so no generic asset pass follows.
 */
export async function files_browser_db_delete_user_batch(
	ctx: MutationCtx,
	args: { userId: Id<"users">; batchSize: number },
) {
	const results = await ctx.db
		.query("ai_chat_browser_results")
		.withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
		.take(args.batchSize);
	if (results.length > 0) {
		for (const result of results) {
			await delete_browser_result_with_assets(ctx, result._id);
		}
		return { done: false, deletedCount: results.length };
	}

	const sessions = await ctx.db
		.query("files_browser_sessions")
		.withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
		.take(args.batchSize);
	if (sessions.length > 0) {
		await Promise.all(sessions.map((session) => ctx.db.delete("files_browser_sessions", session._id)));
		return { done: false, deletedCount: sessions.length };
	}

	const captures = await ctx.db
		.query("files_browser_draft_captures")
		.withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
		.take(args.batchSize);
	if (captures.length > 0) {
		for (const capture of captures) {
			if (capture.storageId) {
				await ctx.storage.delete(capture.storageId);
			}
			await ctx.db.delete("files_browser_draft_captures", capture._id);
		}
		return { done: false, deletedCount: captures.length };
	}

	return { done: true, deletedCount: 0 };
}
