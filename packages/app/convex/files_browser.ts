import { v, type Infer } from "convex/values";
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
import { files_visible_db_create_reader } from "./files_visible.ts";
import {
	files_ingestion_db_prepare_file,
	files_ingestion_db_finalize_file,
	files_ingestion_scope_validator,
	files_ingestion_prepare_args_validator,
	files_ingestion_prepare_result_validator,
	files_ingestion_finalize_args_validator,
	files_ingestion_file_validator,
} from "./files_ingestion.ts";
import { ai_chat_files_db_authorize_file_output } from "./ai_chat_files.ts";
import app_convex_schema, { ai_chat_workspaces_source_validator } from "./schema.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { files_pending_update_content_is_stale, files_pending_update_has_content } from "../shared/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import {
	files_browser_refresh_session,
	files_browser_runner_call,
	files_browser_runner_session_schema,
	files_browser_runner_viewer_url,
} from "../server/files-browser.ts";
import { r2_fetch_object_from_bucket } from "./r2_client.ts";
import { files_nodes_reconstruct_latest_file_content_from_materialization_state } from "./files_nodes_reconstruct_content.ts";
import type { files_nodes_get_file_text_content_db_state_by_path_Result } from "./files_nodes_content.ts";

// Shared cloud browser: one live HTML page per selected file, watched and driven together by the
// user and the agent. Convex owns source access, snapshots, sessions, and capture authorization.
// Files owns output storage. The trusted runner owns the browser, snippet isolation, and leases.
//
// Source reads mirror the local Preview choice exactly: Saved content comes from current committed
// state, Proposed changes from the actor's own unstaged branch, and Your draft from an explicit
// editor capture. An explicit Proposed request fails on a stale or absent proposal; it never
// silently shows Saved content. Access and identity are checked before and after every slow read.

const BROWSER_HTML_MAX_BYTES = 900_000;

const BROWSER_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
	typeof create_starting_browser_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
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
	typeof commit_live_browser_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
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
 * source-node access. Returns the current lease for the runner call.
 *
 * Every check runs on every command; a stale lease is refused instead of rebound.
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

		// A saved source has its own node to authorize. A private draft has none, so the reader
		// answers only for the user's own active drafts and `canRead` checks the nearest saved
		// parent folder.
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
			const reader = await files_visible_db_create_reader(ctx, { ...args, readLimit: 2048 });
			const source = pendingNodeId ? await reader.resolve({ kind: "private", id: pendingNodeId }) : null;
			if (!source || source.entry.kind !== "private" || !(await reader.canRead(source.accessNode))) {
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
			const checked = await files_browser_refresh_session(ctx, existing._yay);
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

		const committed = (await ctx.runMutation(internal.files_browser.commit_live_browser_session, {
			sessionId: created._yay.sessionId,
			navigationGeneration: args.navigationGeneration,
			sourceVersion: parsed.data.session.sourceVersion,
			sourceHash: parsed.data.session.sourceHash,
			loadGen: parsed.data.session.loadGen,
			controlGen: parsed.data.session.controlGen,
			runnerSessionId: parsed.data.session.sessionId,
			idleUntil: parsed.data.session.idleUntil,
			totalUntil: parsed.data.session.totalUntil,
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
	typeof begin_close_browser_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
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
			controlGen: v.number(),
			navGen: v.number(),
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

		const parsed = files_browser_runner_open_schema.safeParse(reloaded._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser did not reload" } });
		}
		const updated = (await ctx.runMutation(internal.files_browser.sync_browser_session, {
			sessionId: args.sessionId,
			runner: parsed.data.session,
		})) as files_browser_sync_browser_session_Result;
		if (updated._nay) {
			return updated;
		}
		if (!updated._yay) return Result({ _nay: { message: "Not found" } });

		if (session.sourceKind === "draft" && args.draftCaptureId && args.draftStorageId) {
			await ctx.runMutation(internal.files_browser.delete_draft_capture, {
				captureId: args.draftCaptureId,
				storageId: args.draftStorageId,
			});
		}

		return Result({
			_yay: {
				loadGen: parsed.data.session.loadGen,
				controlGen: parsed.data.session.controlGen,
				navGen: parsed.data.session.navGen,
				sourceVersion: parsed.data.session.sourceVersion,
				sourceHash: parsed.data.session.sourceHash,
			},
		});
	},
});

function control_reply_is_current(
	session: Pick<Doc<"files_browser_sessions">, "control" | "controlGen">,
	reply: { control: "ready" | "human" | "pausing"; controlGen: number },
) {
	return (
		reply.controlGen > session.controlGen ||
		(reply.controlGen === session.controlGen &&
			(reply.control === session.control ||
				(session.control === "pausing" && (reply.control === "human" || reply.control === "ready"))))
	);
}

export const sync_browser_session = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		runner: v.object({
			sessionId: v.string(),
			nodeId: v.string(),
			navGen: v.number(),
			loadGen: v.number(),
			controlGen: v.number(),
			control: v.union(v.literal("agent"), doc(app_convex_schema, "files_browser_sessions").fields.control),
			sourceKind: doc(app_convex_schema, "files_browser_sessions").fields.sourceKind,
			sourceVersion: v.string(),
			sourceHash: v.string(),
			idleUntil: v.number(),
			totalUntil: v.number(),
		}),
	},
	returns: v_result({ _yay: v.union(doc(app_convex_schema, "files_browser_sessions"), v.null()) }),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (!session || session.control === "closed" || session.control === "closing") {
			return Result({ _yay: null });
		}
		const runner = args.runner;
		if (
			runner.sessionId !== session.runnerSessionId ||
			runner.nodeId !== session.nodeId ||
			runner.navGen !== session.navigationGeneration ||
			runner.sourceKind !== session.sourceKind ||
			runner.control === "starting" ||
			runner.control === "closing" ||
			runner.control === "closed"
		) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		const patch: Partial<Doc<"files_browser_sessions">> = {};
		// Source and control advance separately. A late reload must not undo a newer take.
		if (runner.loadGen > session.loadGen) {
			patch.loadGen = runner.loadGen;
			patch.sourceVersion = runner.sourceVersion;
			patch.sourceHash = runner.sourceHash;
		}
		// The runner owns the command lock; Convex mirrors only stable control states.
		const control = runner.control === "agent" ? "ready" : runner.control;
		if (
			control_reply_is_current(session, { control, controlGen: runner.controlGen }) &&
			(control !== session.control || runner.controlGen !== session.controlGen)
		) {
			patch.control = control;
			patch.controlGen = runner.controlGen;
		}
		if (runner.idleUntil > (session.idleUntil ?? 0)) patch.idleUntil = runner.idleUntil;
		if (session.totalUntil !== runner.totalUntil) patch.totalUntil = runner.totalUntil;
		if (Object.keys(patch).length > 0) {
			patch.updatedAt = Date.now();
			await ctx.db.patch("files_browser_sessions", args.sessionId, patch);
		}
		return Result({ _yay: { ...session, ...patch } });
	},
});

export type files_browser_sync_browser_session_Result =
	typeof sync_browser_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
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

		const parsed = z.object({ ok: z.literal(true), idleUntil: z.number() }).safeParse(kept._yay);
		if (!parsed.success) return Result({ _nay: { message: "Browser request failed" } });
		const idleUntil = parsed.data.idleUntil;
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
		if (
			session &&
			session.control !== "closed" &&
			session.control !== "closing" &&
			args.idleUntil > (session.idleUntil ?? 0)
		) {
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
			const checked = await files_browser_refresh_session(ctx, loaded._yay);
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
			const checked = await files_browser_refresh_session(ctx, loaded._yay);
			if (checked._nay) {
				console.error("Browser status check failed", { message: checked._nay.message });
			}
			return renewed;
		}
		const parsed = z
			.object({
				ok: z.literal(true),
				grantedUntil: z.number(),
				session: files_browser_runner_session_schema,
			})
			.safeParse(renewed._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		const updated = (await ctx.runMutation(internal.files_browser.sync_browser_session, {
			sessionId: args.sessionId,
			runner: parsed.data.session,
		})) as files_browser_sync_browser_session_Result;
		if (updated._nay) return updated;
		if (!updated._yay) return Result({ _nay: { message: "Not found" } });
		return Result({
			_yay: {
				grantedUntil: parsed.data.grantedUntil,
				control: updated._yay.control,
				controlGen: updated._yay.controlGen,
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
		// A finished handoff can reach human or ready if its viewer detached.
		if (
			session &&
			session.control !== "closed" &&
			session.control !== "closing" &&
			control_reply_is_current(session, args)
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
		const parsed = z.object({ ok: z.literal(true), control: z.string(), controlGen: z.number() }).safeParse(taken._yay);
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

// #region browser file outputs
const file_output_scope_validator = v.object({
	...files_ingestion_scope_validator.fields,
	agentSource: ai_chat_workspaces_source_validator,
	threadId: v.id("ai_chat_threads"),
	modeId: v.union(v.literal("ask"), v.literal("agent")),
	sessionId: v.id("files_browser_sessions"),
	expectedAgentLease: browser_agent_lease_validator,
	expectedSource: v.object({
		targetKind: v.union(v.literal("saved"), v.literal("private")),
		nodeId: v.string(),
		sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
		sourceVersion: v.string(),
		sourceHash: v.string(),
	}),
});

/**
 * Refuse a capture whose page is no longer the one the agent ran against, or whose HTML source the
 * user can no longer read. Both checks run again at finalize, because the upload happens in between.
 */
async function authorize_browser_file_source(ctx: MutationCtx, args: Infer<typeof file_output_scope_validator>) {
	const chat = await ai_chat_files_db_authorize_file_output(ctx, args);
	if (chat._nay) return chat;
	const session = await ctx.db.get("files_browser_sessions", args.sessionId);

	// The capture belongs to this loaded page and control lease, not just this session id.
	if (
		!session ||
		session.ownerId !== args.userId ||
		session.control !== "ready" ||
		!session.runnerSessionId ||
		(session.totalUntil !== undefined && session.totalUntil <= Date.now()) ||
		session.controlGen !== args.expectedAgentLease.controlGen ||
		session.loadGen !== args.expectedAgentLease.loadGen ||
		session.navigationGeneration !== args.expectedAgentLease.navGen ||
		session.targetKind !== args.expectedSource.targetKind ||
		session.nodeId !== args.expectedSource.nodeId ||
		session.sourceKind !== args.expectedSource.sourceKind ||
		session.sourceVersion !== args.expectedSource.sourceVersion ||
		session.sourceHash !== args.expectedSource.sourceHash
	)
		return Result({ _nay: { message: "Browser session changed. Run the capture again." } });
	const sourceScope = {
		agentSource: args.agentSource,
		organizationId: session.organizationId,
		workspaceId: session.workspaceId,
		userId: args.userId,
	};
	const sourceAccess = await ai_chat_workspaces_db_authorize_file_scope(ctx, sourceScope);
	if (sourceAccess._nay) return sourceAccess;

	// The session stores its node id as a plain string, so it needs the table back before a read.
	const sourceId =
		session.targetKind === "private"
			? ctx.db.normalizeId("files_pending_nodes", session.nodeId)
			: ctx.db.normalizeId("files_nodes", session.nodeId);
	if (!sourceId) return Result({ _nay: { message: "Source unavailable" } });

	const reader = await files_visible_db_create_reader(ctx, { ...sourceScope, readLimit: 2048 });
	const source = await reader.resolve(
		session.targetKind === "private"
			? { kind: "private", id: sourceId as Id<"files_pending_nodes"> }
			: { kind: "saved", id: sourceId as Id<"files_nodes"> },
	);
	if (!source || !(await reader.canRead(source.accessNode))) return Result({ _nay: { message: "Source unavailable" } });

	// Only an HTML file can be the source of a browser session. A draft that is not text yet has
	// no content type to check, so it is refused too.
	const sourceType =
		source.entry.kind === "saved"
			? source.entry.node.contentType
			: source.entry.pendingUpdate.createIntent?.kind === "text"
				? source.entry.pendingUpdate.createIntent.contentType
				: null;
	if (files_editable_text_content_type_of(sourceType) !== "text/html;charset=utf-8")
		return Result({ _nay: { message: "Source unavailable" } });

	return Result({ _yay: null });
}

/**
 * Prepare and finalize one browser output file. Both still need the same browser source and the
 * same lease this run started with.
 *
 * A retry whose receipt already completed returns the existing Files target instead. That path
 * returns before this check runs, so a lease that went stale cannot hide a file the run already
 * created.
 */
export const prepare_file_output = internalMutation({
	args: {
		...files_ingestion_prepare_args_validator.fields,
		...file_output_scope_validator.fields,
	},
	returns: v_result({ _yay: files_ingestion_prepare_result_validator }),
	handler: (ctx, args) => files_ingestion_db_prepare_file(ctx, args, () => authorize_browser_file_source(ctx, args)),
});

export const finalize_file_output = internalMutation({
	args: {
		...files_ingestion_finalize_args_validator.fields,
		...file_output_scope_validator.fields,
	},
	returns: v_result({ _yay: files_ingestion_file_validator }),
	handler: (ctx, args) => files_ingestion_db_finalize_file(ctx, args, () => authorize_browser_file_source(ctx, args)),
});
// #endregion browser file outputs

const BROWSER_SWEEP_BATCH_SIZE = 50;

/**
 * Sweep draft captures with their blobs, unfinished starts, old daily-use counters, and closed
 * sessions.
 */
export const cleanup_expired_browser_docs = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		let reschedule = false;

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

		const closedCutoff = now - BROWSER_SESSION_RETENTION_MS;
		const closedSessions = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_control_closedAt", (q) => q.eq("control", "closed").lt("closedAt", closedCutoff))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const session of closedSessions) {
			await ctx.db.delete("files_browser_sessions", session._id);
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
 * Purge one workspace batch of browser sessions. Runner sessions orphaned here die on their
 * idle alarm within minutes.
 */
export async function files_browser_db_purge_workspace_batch(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; batchSize: number },
) {
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
 * Drain one user's browser sessions and draft captures, including their stored blobs.
 */
export async function files_browser_db_delete_user_batch(
	ctx: MutationCtx,
	args: { userId: Id<"users">; batchSize: number },
) {
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
