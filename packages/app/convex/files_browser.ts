import { v, type Infer } from "convex/values";
import { z } from "zod";
import { type FunctionArgs, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api.js";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { Result } from "common/errors-as-values-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_authorize_membership, access_control_db_authorize_node } from "./access_control.ts";
import { billing_db_check_paid_plan, billing_ingest_events, billing_pick_billed_user_id } from "./billing_db.ts";
import { files_stored_uploads_db_admit } from "./files_stored_uploads.ts";
// Type-only, like `billing_db.ts`: a value import would load the Polar SDK here.
import type { billing_Event } from "../server/billing.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { browser_web_canonical_host, browser_web_normalize_url } from "common/browser-web-url.ts";
import {
	files_editable_text_content_type_of,
	files_get_utf8_byte_size,
	files_node_has_editable_text_content,
	files_u8_to_array_buffer,
	files_db_load_pending_update_yjs_state_bytes,
} from "../server/files.ts";
import {
	files_UPLOAD_URL_TTL_MS,
	files_nodes_db_create_node_recursively_at_path,
	type files_nodes_get_visible_entry_by_path_Result,
} from "./files_nodes.ts";
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
import { ai_chat_files_db_delete_browser_invocations } from "./ai_chat_files.ts";
import { playwriter_browser_db_disconnect } from "./playwriter_browser.ts";
import app_convex_schema, {
	ai_chat_workspaces_source_validator,
	ai_chat_browser_source_validator,
	ai_chat_browser_resource_validator,
	browser_intent_validator,
	files_browser_session_control_validator,
	files_browser_session_source_kind_validator,
} from "./schema.ts";
import { ai_chat_workspaces_db_authorize_file_scope, ai_chat_workspaces_db_resolve } from "./ai_chat_workspaces.ts";
import {
	files_ROOT_ID,
	files_guess_content_type_from_name,
	files_normalize_browser_download_name,
	files_normalize_content_type,
	files_pending_update_content_is_stale,
	files_pending_update_has_content,
} from "../shared/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import {
	files_browser_refresh_session,
	files_browser_runner_call,
	files_browser_runner_session_schema,
	files_browser_runner_status_schema,
	files_browser_runner_upload_url,
	files_browser_runner_usage_schema,
	files_browser_runner_viewer_url,
} from "../server/files-browser.ts";
import { r2, r2_create_asset_key, r2_fetch_object_from_bucket, r2_UNFINALIZED_ASSET_TTL_MS } from "./r2_client.ts";
import { r2_action_create_signed_download_url } from "./r2.ts";
import { files_nodes_reconstruct_latest_file_content_from_materialization_state } from "./files_nodes_reconstruct_content.ts";
import type { files_nodes_get_file_text_content_db_state_by_path_Result } from "./files_nodes_content.ts";

// Shared cloud browser, watched and driven together by the user and the agent. It has two modes.
// A `file` session shows one HTML page from Files. A `web` session is an open web browser with no
// file. Convex owns access, snapshots, sessions, capture authorization, and billing. Files owns
// output storage. The trusted runner owns the browser, snippet isolation, and leases.
//
// Source reads mirror the local Preview choice exactly: Saved content comes from current committed
// state, Proposed changes from the actor's own unstaged branch, and Your draft from an explicit
// editor capture. An explicit Proposed request fails on a stale or absent proposal; it never
// silently shows Saved content. Access and identity are checked before and after every slow read.
//
// Only users on a paid plan (Pay As You Go or Pro) may start a browser, in either mode. Browser time
// is billed per started minute from the runner's own start and end times, once per session.

const BROWSER_HTML_MAX_BYTES = 900_000;

type BrowserActionResult<Value, ErrorData = never> =
	| { _yay: Value; _nay?: undefined }
	| { _yay?: undefined; _nay: { message: string; name?: string; data?: ErrorData } };

const browser_preferences_public_validator = v.object({
	policyRevision: v.number(),
	webAgentAccess: v.boolean(),
	agentBlockedHosts: v.array(v.string()),
	syncPending: v.boolean(),
});

const BROWSER_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const BROWSER_CAPTURE_TTL_MS = 5 * 60 * 1000;

const BROWSER_STARTING_TTL_MS = 2 * 60 * 1000;

// Daily per-workspace brakes for file mode against start/end and capture loops. Generous for
// humans; tune after the smoke test.
const BROWSER_DAILY_STARTS_MAX = 30;
const BROWSER_DAILY_CAPTURES_MAX = 100;

// Daily per-user brake for web starts. It stops start loops. It is not a cost brake: browser
// time is billed anyway.
const BROWSER_DAILY_WEB_STARTS_MAX = 50;

// Price of browser time in credit cents, charged per started minute (owner-approved).
const BROWSER_COST_CENTS_PER_MINUTE = 0.3;

// The runner writes its usage receipt when it closes a session. If the receipt is still missing
// this long after the session ended, the runner lost it, and the session is billed as 0.
const BROWSER_USAGE_RECEIPT_WAIT_MS = 10 * 60 * 1000;

const BROWSER_SETTLE_BATCH_SIZE = 50;

// The owner's last browser in this workspace is still closing, so its slot is not free yet. The
// Start cards show this text as it is.
const BROWSER_CLOSING_MESSAGE = "The last browser is still closing. Try again in a minute.";

// A saved profile nobody started a web browser with for this long is deleted with its logins.
// The runner deletes unused bytes by itself after 100 days, so this normally runs first.
const BROWSER_PROFILE_UNUSED_MS = 90 * 24 * 60 * 60 * 1000;

const BROWSER_PROFILE_BLOCKED_HOSTS_MAX = 50;

// Runner wipe retries wait 1 minute, then double each time, up to 6 hours. They never stop.
const BROWSER_PROFILE_WIPE_RETRY_MIN_MS = 60 * 1000;
const BROWSER_PROFILE_WIPE_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

const BROWSER_PROFILE_WIPE_BATCH_SIZE = 20;

const BROWSER_PROFILE_DELETE_BATCH_SIZE = 50;

// The runner refuses with `profile_unreadable` when the stored cookies do not decrypt. Only Clear
// all fixes that, so the Manage saved data dialog shows this text as it is.
const BROWSER_PROFILE_UNREADABLE_MESSAGE = "Saved data could not be read. Clear all to start fresh.";

const BROWSER_DOWNLOADS_FOLDER_PATH = "/.system/downloads";

// The runner fills a file chooser with at most this many bytes in total.
const BROWSER_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const BROWSER_UPLOAD_MAX_FILES = 10;

// The runner reads the signed GET URLs within its 120-second fill budget. Signing takes time
// too, so a URL signed first must still work at the end of that budget.
const BROWSER_UPLOAD_URL_TTL_SECONDS = 5 * 60;

const browser_agent_lease_validator = v.object({
	controlGen: v.number(),
	loadGen: v.number(),
	navGen: v.number(),
	tabId: v.optional(v.string()),
	tabGen: v.optional(v.number()),
	policyRevision: v.optional(v.number()),
});

type FileBrowserSession = Extract<Doc<"files_browser_sessions">, { mode: "file" }>;
type WebBrowserSession = Extract<Doc<"files_browser_sessions">, { mode: "web" }>;

/**
 * The runner's session metadata, as `files_browser_runner_session_schema` parses it.
 */
const browser_runner_session_validator = v.union(
	v.object({
		mode: v.literal("file"),
		sessionId: v.string(),
		nodeId: v.string(),
		navGen: v.number(),
		loadGen: v.number(),
		controlGen: v.number(),
		control: v.union(v.literal("agent"), files_browser_session_control_validator),
		sourceKind: files_browser_session_source_kind_validator,
		sourceVersion: v.string(),
		sourceHash: v.string(),
		idleUntil: v.number(),
		totalUntil: v.number(),
	}),
	v.object({
		mode: v.literal("web"),
		sessionId: v.string(),
		navGen: v.number(),
		loadGen: v.number(),
		controlGen: v.number(),
		control: v.union(v.literal("agent"), files_browser_session_control_validator),
		agentAccess: v.boolean(),
		tabId: v.string(),
		tabGen: v.number(),
		viewedTabId: v.union(v.string(), v.null()),
		viewGen: v.number(),
		tabCount: v.number(),
		policyRevision: v.number(),
		idleUntil: v.number(),
		totalUntil: v.number(),
	}),
);

const browser_file_session_public_validator = v.object({
	mode: v.literal("file"),
	sessionId: v.id("files_browser_sessions"),
	targetKind: v.union(v.literal("saved"), v.literal("private")),
	nodeId: v.string(),
	path: v.string(),
	navigationGeneration: v.number(),
	sourceKind: files_browser_session_source_kind_validator,
	sourceVersion: v.string(),
	sourceHash: v.string(),
	loadGen: v.number(),
	controlGen: v.number(),
	control: v.string(),
	idleUntil: v.union(v.number(), v.null()),
	totalUntil: v.union(v.number(), v.null()),
});

const browser_web_session_public_validator = v.object({
	mode: v.literal("web"),
	sessionId: v.id("files_browser_sessions"),
	navigationGeneration: v.number(),
	loadGen: v.number(),
	controlGen: v.number(),
	control: v.string(),
	agentAccess: v.boolean(),
	tabId: v.union(v.string(), v.null()),
	tabGen: v.number(),
	viewedTabId: v.union(v.string(), v.null()),
	viewGen: v.number(),
	tabCount: v.number(),
	policyRevision: v.number(),
	idleUntil: v.union(v.number(), v.null()),
	totalUntil: v.union(v.number(), v.null()),
});

/**
 * Data on a refused start. `Browser busy` names the mode of the live session, so the UI can offer
 * to end it. `Plan required` carries `plan_required`, so the UI can link to billing.
 */
const browser_start_refusal_data_validator = v.union(
	v.object({ mode: v.union(v.literal("file"), v.literal("web")) }),
	v.object({ code: v.literal("plan_required") }),
);

// Runner response shapes. Every consumed field is validated; nothing is trusted by shape alone.
const files_browser_runner_open_schema = z.object({
	ok: z.literal(true),
	session: files_browser_runner_session_schema,
});

const files_browser_runner_close_schema = z.object({
	ok: z.literal(true),
	usage: files_browser_runner_usage_schema.nullable(),
});

const browser_management_ack_schema = z.object({
	ok: z.literal(true),
	status: z.enum(["completed", "refused", "in_progress", "unknown"]),
	result: z.object({ reason: z.string().nullable() }),
});

/**
 * The saved sites of one profile: cookie domains with a count. The runner never sends cookie
 * names or values.
 */
const files_browser_runner_profile_summary_schema = z.object({
	ok: z.literal(true),
	exists: z.boolean(),
	savedAt: z.number().nullable(),
	truncated: z.boolean(),
	sites: z.array(z.object({ domain: z.string(), cookies: z.number().int().nonnegative() })),
});

const files_browser_runner_profile_clear_schema = z.object({
	ok: z.literal(true),
	removed: z.number().int().nonnegative(),
});

const files_browser_runner_profile_delete_schema = z.object({
	ok: z.literal(true),
	deleted: z.literal(true),
});

/**
 * One human download that the runner still holds in memory. `origin` is the page origin that made
 * it, or null for a `data:` URL. The name is raw; Convex normalizes it.
 */
const files_browser_runner_download_info_schema = z.object({
	ok: z.literal(true),
	name: z.string(),
	size: z.number().int().nonnegative(),
	contentType: z.string(),
	origin: z.string().nullable(),
});

/**
 * A single-use grant for one computer upload into the open file chooser.
 */
const files_browser_runner_upload_grant_schema = z.object({
	ok: z.literal(true),
	grantId: z.string().min(1),
	expiresAt: z.number(),
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

/**
 * The start refusal for a failed runner open. The runner's registry caps get their own text,
 * because trying again does not help there. The Start cards show these texts as they are.
 */
function browser_open_refusal_message(code: string | undefined) {
	switch (code) {
		case "user_limit":
			return "You already have 2 browsers open in other workspaces. End one first.";
		case "organization_limit":
			return "Your organization already has 4 browsers open. Try again later.";
		default:
			return "Browser did not start";
	}
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
 * Check that web mode is on and that the member may use the web browser in this workspace.
 * Web sessions have no file, so this permission is their whole access check.
 */
async function browser_db_authorize_web_use(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; membership: Doc<"organizations_workspaces_users"> },
) {
	if (process.env.AI_CHAT_BROWSER_ENABLED !== "true") {
		return Result({ _nay: { message: "Browser unavailable" } });
	}
	return await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.userId },
		membership: args.membership,
		permission: "workspace.browser.use",
	});
}

export async function files_browser_db_get_preferences(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const saved = await ctx.db
		.query("files_browser_preferences")
		.withIndex("by_owner_organization_workspace", (q) =>
			q.eq("ownerId", args.userId).eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.first();
	return (
		saved ?? {
			ownerId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			webAgentAccess: true,
			policyRevision: 0,
			agentBlockedHosts: [],
			syncPending: false,
			updatedAt: 0,
		}
	);
}

/**
 * Recheck the original chat and the user's saved browser policy, never the mounted view.
 */
export async function files_browser_db_check_agent_intent(
	ctx: QueryCtx | MutationCtx,
	args: {
		source: Infer<typeof ai_chat_browser_source_validator>;
		browserIntent: Infer<typeof browser_intent_validator>;
		mode?: "file" | "web";
	},
) {
	const resolved = await ai_chat_workspaces_db_resolve(ctx, { source: args.source, workspace: "current" });
	if (resolved._nay) return resolved;
	const message = await ctx.db.get("ai_chat_threads_messages_aisdk_5", args.source.sourceMessageId);
	if (
		!message ||
		message.threadId !== args.source.threadId ||
		message.createdBy !== args.source.userId ||
		message.organizationId !== args.source.organizationId ||
		message.workspaceId !== args.source.workspaceId ||
		message.content.role !== "user"
	)
		return Result({ _nay: { message: "Chat source is no longer available" } });
	const preference = await files_browser_db_get_preferences(ctx, args.source);
	if (args.mode === "file") return Result({ _yay: preference });
	if (preference.policyRevision !== args.browserIntent.policyRevision)
		return Result({ _nay: { name: "browser_intent_changed", message: "Browser policy changed" } });
	if (!preference.webAgentAccess)
		return Result({ _nay: { name: "agent_access_off", message: "Agent browser access is off" } });
	if (preference.syncPending)
		return Result({ _nay: { name: "policy_sync_pending", message: "Browser policy is still updating" } });
	const membership = await ctx.db.get("organizations_workspaces_users", args.source.membershipId);
	if (!membership) return Result({ _nay: { message: "Unauthorized" } });
	const permission = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.source.userId },
		membership,
		permission: "workspace.browser.use",
	});
	if (permission._nay) return permission;
	return Result({ _yay: preference });
}

export const check_browser_source = internalQuery({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		mode: v.optional(v.union(v.literal("file"), v.literal("web"))),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const checked = await files_browser_db_check_agent_intent(ctx, args);
		return checked._nay ? checked : Result({ _yay: null });
	},
});

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
 * Refuse a start unless the payer is on a paid plan, and return the payer to freeze on the doc.
 * The payer is the organization owner in an owner-billed organization, so a member's own plan
 * does not matter there.
 */
async function browser_db_check_payer(
	ctx: MutationCtx,
	args: { userId: Id<"users">; organization: Doc<"organizations"> },
) {
	const billedUserId = billing_pick_billed_user_id({ userId: args.userId, organization: args.organization });
	const { hasPaidPlan } = await billing_db_check_paid_plan(ctx, { userId: billedUserId });
	if (!hasPaidPlan) {
		return Result({ _nay: { message: "Plan required", data: { code: "plan_required" as const } } });
	}
	return Result({ _yay: billedUserId });
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
		_nay: { data: browser_start_refusal_data_validator },
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
			if (session.mode !== "file") continue;
			if (session.control === "closing") return Result({ _nay: { message: BROWSER_CLOSING_MESSAGE } });
			if (!live_session_control(session.control)) {
				continue;
			}
			if (session.control === "starting" && (session.startingExpiresAt ?? 0) <= now) {
				const opening = await ctx.db
					.query("ai_chat_browser_invocations")
					.withIndex("by_openingSession", (q) => q.eq("openingSessionId", session._id))
					.first();
				if (opening && opening.status !== "finished") return Result({ _nay: { message: "Browser is starting" } });
				await browser_db_delete_session(ctx, session._id);
				continue;
			}
			if (session.control === "starting") return Result({ _nay: { message: "Browser is starting" } });
			// Repeated starts for the same live file and source reattach after fresh checks.
			// Another file needs an explicit End first.
			if (
				session.mode === "file" &&
				session.targetKind === args.targetKind &&
				session.nodeId === args.nodeId &&
				session.sourceKind === args.sourceKind &&
				session.navigationGeneration === args.navigationGeneration
			) {
				return Result({ _yay: { sessionId: session._id, reattached: true } });
			}
			return Result({ _nay: { message: "Browser busy", data: { mode: session.mode } } });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const payer = await browser_db_check_payer(ctx, { userId: args.userId, organization });
		if (payer._nay) {
			return payer;
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
			mode: "file",
			ownerId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			billedUserId: payer._yay,
			billing: { state: "pending" },
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
 * Claim the owner's workspace browser slot for a web session and record a starting doc.
 *
 * Web starts skip the workspace start brake. They count toward the user's daily web starts
 * instead, and only at commit, so a reattach or a failed open costs nothing.
 *
 * A new session also finds or creates the owner's saved profile for this workspace and marks it
 * used. Its key goes back to the start action only, which sends it to the runner.
 */
export const create_starting_web_browser_session = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		viewportWidth: v.number(),
		viewportHeight: v.number(),
	},
	returns: v_result({
		_yay: v.union(
			v.object({
				sessionId: v.id("files_browser_sessions"),
				reattached: v.literal(true),
			}),
			v.object({
				sessionId: v.id("files_browser_sessions"),
				reattached: v.literal(false),
				profile: v.object({
					profileId: v.id("files_browser_profiles"),
					profileKey: v.bytes(),
					agentBlockedHosts: v.array(v.string()),
					agentAccess: v.boolean(),
					policyRevision: v.number(),
				}),
			}),
		),
		_nay: { data: browser_start_refusal_data_validator },
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
			!Number.isInteger(args.viewportWidth) ||
			!Number.isInteger(args.viewportHeight) ||
			args.viewportWidth < 320 ||
			args.viewportHeight < 320 ||
			args.viewportWidth > 2560 ||
			args.viewportHeight > 1440
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await browser_db_authorize_web_use(ctx, { userId: args.userId, membership });
		if (authorized._nay) {
			return authorized;
		}

		const now = Date.now();
		const existing = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_owner_organization_workspace", (q) =>
				q.eq("ownerId", args.userId).eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
			)
			.collect();
		for (const session of existing) {
			if (session.mode !== "web") continue;
			if (session.control === "closing") return Result({ _nay: { message: BROWSER_CLOSING_MESSAGE } });
			if (!live_session_control(session.control)) {
				continue;
			}
			if (session.control === "starting" && (session.startingExpiresAt ?? 0) <= now) {
				const opening = await ctx.db
					.query("ai_chat_browser_invocations")
					.withIndex("by_openingSession", (q) => q.eq("openingSessionId", session._id))
					.first();
				if (opening && opening.status !== "finished") return Result({ _nay: { message: "Browser is starting" } });
				await browser_db_delete_session(ctx, session._id);
				continue;
			}
			if (session.control === "starting") return Result({ _nay: { message: "Browser is starting" } });
			return Result({ _yay: { sessionId: session._id, reattached: true as const } });
		}

		const payer = await browser_db_check_payer(ctx, {
			userId: args.userId,
			organization: authorized._yay.organization,
		});
		if (payer._nay) {
			return payer;
		}

		const day = new Date(now).toISOString().slice(0, 10);
		const dailyUse = await ctx.db
			.query("files_browser_user_daily_use")
			.withIndex("by_user_day", (q) => q.eq("userId", args.userId).eq("day", day))
			.first();
		if ((dailyUse?.webStarts ?? 0) >= BROWSER_DAILY_WEB_STARTS_MAX) {
			return Result({ _nay: { message: "Daily limit reached" } });
		}

		const preference = await files_browser_db_get_preferences(ctx, args);
		if (preference.syncPending) return Result({ _nay: { message: "Browser policy is still updating" } });
		const profile = await ctx.db
			.query("files_browser_profiles")
			.withIndex("by_organization_workspace_user", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
			)
			.first();
		let profileId: Id<"files_browser_profiles">;
		let profileKey: ArrayBuffer;
		if (profile) {
			await ctx.db.patch("files_browser_profiles", profile._id, { lastUsedAt: now });
			profileId = profile._id;
			profileKey = profile.profileKey;
		} else {
			profileKey = crypto.getRandomValues(new Uint8Array(32)).buffer;
			profileId = await ctx.db.insert("files_browser_profiles", {
				userId: args.userId,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				profileKey,
				createdAt: now,
				lastUsedAt: now,
			});
		}

		const sessionId = await ctx.db.insert("files_browser_sessions", {
			mode: "web",
			ownerId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			billedUserId: payer._yay,
			billing: { state: "pending" },
			agentAccess: preference.webAgentAccess,
			tabId: null,
			tabGen: 0,
			viewedTabId: null,
			viewGen: 0,
			tabCount: 0,
			tabs: [],
			policyRevision: preference.policyRevision,
			// Open starts at generation 1. The runner may advance it during navigation.
			navigationGeneration: 1,
			loadGen: 0,
			controlGen: 0,
			control: "starting",
			startingExpiresAt: now + BROWSER_STARTING_TTL_MS,
			createdAt: now,
			updatedAt: now,
		});
		return Result({
			_yay: {
				sessionId,
				reattached: false as const,
				profile: {
					profileId,
					profileKey,
					agentBlockedHosts: preference.agentBlockedHosts,
					agentAccess: preference.webAgentAccess,
					policyRevision: preference.policyRevision,
				},
			},
		});
	},
});

type create_starting_web_browser_session_Result =
	typeof create_starting_web_browser_session extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Commit a starting session to its live runner session. Refuses when End ran while the runner was
 * opening; the caller then closes the orphan runner session at once and bills its time.
 *
 * A web start counts toward the user's daily web starts here, after the runner opened it. So a
 * refused or failed open costs nothing.
 */
export const commit_live_browser_session = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		navigationGeneration: v.number(),
		runner: browser_runner_session_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		const runner = args.runner;
		if (
			!session ||
			session.control !== "starting" ||
			session.navigationGeneration !== args.navigationGeneration ||
			session.mode !== runner.mode
		) {
			// End closed the doc while the runner was opening, but the runner already holds a browser.
			// Record that runner session on the doc, so its time can still be billed: the caller settles
			// it from the close reply, and the settle cron asks the runner when that reply is lost. Also
			// drop the start deadline, or the hourly sweep would delete the doc before it is billed.
			if (session && (session.control === "closing" || session.control === "closed") && !session.runnerSessionId) {
				await ctx.db.patch("files_browser_sessions", args.sessionId, {
					runnerSessionId: runner.sessionId,
					startingExpiresAt: undefined,
					updatedAt: Date.now(),
				});
			}
			return Result({ _nay: { message: "Not found" } });
		}

		const now = Date.now();
		const shared = {
			loadGen: runner.loadGen,
			controlGen: runner.controlGen,
			control: "ready" as const,
			runnerSessionId: runner.sessionId,
			idleUntil: runner.idleUntil,
			totalUntil: runner.totalUntil,
			startingExpiresAt: undefined,
			updatedAt: now,
		};
		if (runner.mode === "file") {
			await ctx.db.patch("files_browser_sessions", args.sessionId, {
				...shared,
				sourceVersion: runner.sourceVersion,
				sourceHash: runner.sourceHash,
			});
			return Result({ _yay: null });
		}
		const preference = await files_browser_db_get_preferences(ctx, {
			userId: session.ownerId,
			organizationId: session.organizationId,
			workspaceId: session.workspaceId,
		});
		if (
			preference.syncPending ||
			runner.policyRevision !== preference.policyRevision ||
			runner.agentAccess !== preference.webAgentAccess
		) {
			await ctx.db.patch("files_browser_sessions", session._id, {
				runnerSessionId: runner.sessionId,
				control: "closing",
				startingExpiresAt: undefined,
				updatedAt: now,
			});
			return Result({ _nay: { message: "Browser policy changed while opening" } });
		}

		// The initial navigation may advance before Open finishes.
		await ctx.db.patch("files_browser_sessions", args.sessionId, {
			...shared,
			agentAccess: runner.agentAccess,
			navigationGeneration: runner.navGen,
			tabId: runner.tabId,
			tabGen: runner.tabGen,
			viewedTabId: runner.viewedTabId,
			viewGen: runner.viewGen,
			tabCount: runner.tabCount,
			tabs: [{ tabId: runner.tabId, tabGen: runner.tabGen, navGen: runner.navGen }],
			policyRevision: runner.policyRevision,
		});
		const day = new Date(now).toISOString().slice(0, 10);
		const dailyUse = await ctx.db
			.query("files_browser_user_daily_use")
			.withIndex("by_user_day", (q) => q.eq("userId", session.ownerId).eq("day", day))
			.first();
		if (dailyUse) {
			await ctx.db.patch("files_browser_user_daily_use", dailyUse._id, {
				webStarts: dailyUse.webStarts + 1,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("files_browser_user_daily_use", {
				userId: session.ownerId,
				day,
				webStarts: 1,
				updatedAt: now,
			});
		}
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
			await browser_db_delete_session(ctx, args.sessionId);
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
		mode: v.optional(v.union(v.literal("file"), v.literal("web"))),
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
			if (args.mode === undefined) return Result({ _nay: { message: "Browser mode is required" } });
			const sessions = await ctx.db
				.query("files_browser_sessions")
				.withIndex("by_owner_organization_workspace", (q) =>
					q.eq("ownerId", args.userId).eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect();
			session =
				sessions.find((candidate) => candidate.mode === args.mode && live_session_control(candidate.control)) ?? null;
		}
		if (
			!session ||
			(args.mode !== undefined && session.mode !== args.mode) ||
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
export const check_browser_session_access = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		tabId: v.optional(v.string()),
	},
	returns: v.union(
		v.object({
			ok: v.literal(true),
			mode: v.literal("file"),
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
		v.object({
			ok: v.literal(true),
			mode: v.literal("web"),
			control: v.string(),
			controlGen: v.number(),
			loadGen: v.number(),
			navGen: v.number(),
			runnerSessionId: v.string(),
			tabId: v.union(v.string(), v.null()),
			tabGen: v.number(),
			policyRevision: v.number(),
		}),
		v.object({ ok: v.literal(false), reason: v.string() }),
	),
	handler: check_browser_session_access_db,
});

async function check_browser_session_access_db(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		sessionId: Id<"files_browser_sessions">;
		tabId?: string;
	},
) {
	const membership = await organizations_db_get_membership(ctx, {
		userId: args.userId,
		membershipId: args.membershipId,
	});
	if (!membership || membership.organizationId !== args.organizationId || membership.workspaceId !== args.workspaceId) {
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

	// A web session has no file. The agent may use it only while the owner still has the
	// permission and has not turned agent access off.
	if (session.mode === "web") {
		const authorized = await browser_db_authorize_web_use(ctx, { userId: args.userId, membership });
		if (authorized._nay) {
			return { ok: false as const, reason: "denied" };
		}
		if (!session.agentAccess) {
			return { ok: false as const, reason: "agent_access_off" };
		}
		const tab = session.tabs.find((candidate) => candidate.tabId === (args.tabId ?? session.tabId));
		if (!tab) return { ok: false as const, reason: "tab_closed" };
		return {
			ok: true as const,
			mode: "web" as const,
			control: session.control,
			controlGen: session.controlGen,
			loadGen: session.loadGen,
			navGen: tab.navGen,
			runnerSessionId: session.runnerSessionId,
			tabId: tab.tabId,
			tabGen: tab.tabGen,
			policyRevision: session.policyRevision,
		};
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
		mode: "file" as const,
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
}

function web_session_public_meta(session: WebBrowserSession) {
	return {
		mode: "web" as const,
		sessionId: session._id,
		navigationGeneration: session.navigationGeneration,
		loadGen: session.loadGen,
		controlGen: session.controlGen,
		control: session.control,
		agentAccess: session.agentAccess,
		tabId: session.tabId,
		tabGen: session.tabGen,
		viewedTabId: session.viewedTabId,
		viewGen: session.viewGen,
		tabCount: session.tabCount,
		policyRevision: session.policyRevision,
		idleUntil: session.idleUntil ?? null,
		totalUntil: session.totalUntil ?? null,
	};
}

const browser_tab_validator = v.object({
	tabId: v.string(),
	tabGen: v.number(),
	navGen: v.number(),
	title: v.string(),
	url: v.string(),
});
const browser_tabs_result_validator = v.object({
	session: v.union(browser_web_session_public_validator, v.null()),
	tabs: v.array(browser_tab_validator),
	viewedTabId: v.union(v.string(), v.null()),
	viewGen: v.number(),
	status: v.union(v.literal("completed"), v.literal("refused"), v.literal("in_progress"), v.literal("unknown")),
	result: v.object({ tabId: v.union(v.string(), v.null()), reason: v.union(v.string(), v.null()) }),
});
const browser_tabs_response_schema = z.object({
	ok: z.literal(true),
	session: files_browser_runner_session_schema.nullable(),
	tabs: z
		.array(
			z.object({
				tabId: z.string().max(256),
				tabGen: z.number().int().nonnegative(),
				navGen: z.number().int().nonnegative(),
				title: z.string().max(512),
				url: z.string().max(2048),
			}),
		)
		.max(8),
	status: z.enum(["completed", "refused", "in_progress", "unknown"]).optional(),
	result: z.object({ tabId: z.string().nullable(), reason: z.string().nullable() }).optional(),
	usage: files_browser_runner_usage_schema.nullable().optional(),
});

async function browser_tabs_for_owner(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		membership: Doc<"organizations_workspaces_users">;
		sessionId: Id<"files_browser_sessions">;
		route: "tabs" | "tab-new" | "tab-close" | "tab-select";
		tabId?: string;
		viewerId?: string;
		url?: string | null;
		operationId?: string;
		operationDeadline?: number;
		toolCallId?: string;
		expectedAgentLease?: Infer<typeof browser_agent_lease_validator>;
		source?: Infer<typeof ai_chat_browser_source_validator>;
		browserIntent?: Infer<typeof browser_intent_validator>;
	},
): Promise<BrowserActionResult<Infer<typeof browser_tabs_result_validator>>> {
	const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
		userId: args.userId,
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		membershipId: args.membership._id,
		sessionId: args.sessionId,
		mode: "web",
	})) as load_browser_session_Result;
	if (loaded._nay) return loaded;
	if (loaded._yay.mode !== "web" || !loaded._yay.runnerSessionId)
		return Result({ _nay: { message: "Browser is not ready" } });
	const sourceAccess = await authorize_live_browser_session(ctx, {
		userId: args.userId,
		membership: args.membership,
		session: loaded._yay,
	});
	if (!sourceAccess.ok) return Result({ _nay: { message: sourceAccess.message } });
	if (args.source && args.browserIntent) {
		const checked = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
		});
		if (checked._nay) return checked;
	}
	const preference = await ctx.runQuery(internal.files_browser.get_browser_preferences, {
		userId: args.userId,
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
	});
	const response = await files_browser_runner_call({
		route: args.route,
		body: {
			mode: "web",
			sessionId: loaded._yay.runnerSessionId,
			ownerId: args.userId,
			organizationId: args.membership.organizationId,
			workspaceId: args.membership.workspaceId,
			tabId: args.tabId,
			viewerId: args.viewerId,
			url: args.url ?? null,
			operationId: args.operationId ?? crypto.randomUUID(),
			operationDeadline: args.operationDeadline ?? Date.now() + 120_000,
			source: args.source
				? { chatId: args.source.threadId, sourceMessageId: args.source.sourceMessageId, toolCallId: args.toolCallId }
				: undefined,
			expectedAgentLease: args.expectedAgentLease,
			policyRevision: preference.policyRevision,
		},
	});
	if (response._nay)
		return response._nay.name
			? response
			: Result({ _nay: { name: "outcome_unknown", message: "Browser reply was not received" } });
	const parsed = browser_tabs_response_schema.safeParse(response._yay);
	if (!parsed.success || (parsed.data.session && parsed.data.session.mode !== "web"))
		return Result({ _nay: { name: "outcome_unknown", message: "Browser reply was not valid" } });
	if (parsed.data.session) {
		const synced = (await ctx.runMutation(internal.files_browser.sync_browser_session, {
			sessionId: args.sessionId,
			runner: parsed.data.session,
		})) as files_browser_sync_browser_session_Result;
		if (synced._nay) return synced;
		if (parsed.data.session.mode === "web")
			await ctx.runMutation(internal.files_browser.sync_browser_tab_identities, {
				sessionId: args.sessionId,
				controlGen: parsed.data.session.controlGen,
				policyRevision: parsed.data.session.policyRevision,
				tabs: parsed.data.tabs.map(({ tabId, tabGen, navGen }) => ({ tabId, tabGen, navGen })),
			});
	} else if (args.route === "tab-close" && parsed.data.status === "completed") {
		// Settle the completed last-tab Close without live session metadata.
		await ctx.runMutation(internal.files_browser.settle_browser_usage, {
			sessionId: args.sessionId,
			usage: parsed.data.usage ?? null,
		});
	}
	if (args.source && args.browserIntent) {
		const checked = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
		});
		if (checked._nay) return checked;
	}
	const latest = (await ctx.runQuery(internal.files_browser.load_browser_session, {
		userId: args.userId,
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		membershipId: args.membership._id,
		sessionId: args.sessionId,
		mode: "web",
	})) as load_browser_session_Result;
	if (latest._nay && !(args.route === "tab-close" && parsed.data.status === "completed" && !parsed.data.session))
		return latest;
	const session = latest._yay?.mode === "web" ? web_session_public_meta(latest._yay) : null;
	return Result({
		_yay: {
			session,
			tabs: parsed.data.tabs,
			viewedTabId: session?.viewedTabId ?? null,
			viewGen: session?.viewGen ?? 0,
			status: parsed.data.status ?? ("completed" as const),
			result: parsed.data.result ?? { tabId: null, reason: null },
		},
	});
}

async function browser_tabs_from_user(args: {
	ctx: ActionCtx;
	membershipId: Id<"organizations_workspaces_users">;
	sessionId: Id<"files_browser_sessions">;
	tabId?: string;
	viewerId?: string;
	url?: string;
	route: "tabs" | "tab-new" | "tab-close" | "tab-select";
}): Promise<BrowserActionResult<Infer<typeof browser_tabs_result_validator>>> {
	const { ctx, route, ...previousArgs } = args;

	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
	if (!user || user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await ctx.runQuery(api.organizations.get_membership, { membershipId: args.membershipId });
	if (!membership || membership.userId !== user._id) return Result({ _nay: { message: "Unauthorized" } });
	return browser_tabs_for_owner(ctx, { ...previousArgs, userId: user._id, membership, route });
}

export const list_browser_tabs = action({
	args: { membershipId: v.id("organizations_workspaces_users"), sessionId: v.id("files_browser_sessions") },
	returns: v_result({ _yay: browser_tabs_result_validator }),
	handler: async (ctx, args) => browser_tabs_from_user({ ctx, ...args, route: "tabs" }),
});
export const new_browser_tab = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		viewerId: v.string(),
		url: v.optional(v.string()),
	},
	returns: v_result({ _yay: browser_tabs_result_validator }),
	handler: async (ctx, args) => browser_tabs_from_user({ ctx, ...args, route: "tab-new" }),
});
export const close_browser_tab = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		tabId: v.string(),
		viewerId: v.string(),
	},
	returns: v_result({ _yay: browser_tabs_result_validator }),
	handler: async (ctx, args) => browser_tabs_from_user({ ctx, ...args, route: "tab-close" }),
});
export const select_browser_tab = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		tabId: v.string(),
		viewerId: v.string(),
	},
	returns: v_result({ _yay: browser_tabs_result_validator }),
	handler: async (ctx, args) => browser_tabs_from_user({ ctx, ...args, route: "tab-select" }),
});

export const get_browser_preferences = internalQuery({
	args: { userId: v.id("users"), organizationId: v.id("organizations"), workspaceId: v.id("organizations_workspaces") },
	returns: browser_preferences_public_validator,
	handler: async (ctx, args) => browser_preferences_public(await files_browser_db_get_preferences(ctx, args)),
});

export const sync_browser_tab_identities = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		controlGen: v.number(),
		policyRevision: v.number(),
		tabs: v.array(v.object({ tabId: v.string(), tabGen: v.number(), navGen: v.number() })),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (
			!session ||
			session.mode !== "web" ||
			session.control === "closed" ||
			session.control === "closing" ||
			args.controlGen !== session.controlGen ||
			args.policyRevision !== session.policyRevision ||
			args.tabs.length > 8
		)
			return null;
		// A late catalog must keep newer completed navigation on every matching tab.
		const tabs = args.tabs.map((tab) => {
			const current = session.tabs.find((saved) => saved.tabId === tab.tabId);
			return current && (tab.navGen < current.navGen || tab.tabGen < current.tabGen) ? current : tab;
		});
		await ctx.db.patch("files_browser_sessions", session._id, { tabs, tabCount: tabs.length });
		return null;
	},
});

export const get_browser_membership = internalQuery({
	args: { userId: v.id("users"), membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(doc(app_convex_schema, "organizations_workspaces_users"), v.null()),
	handler: organizations_db_get_membership,
});

export const agent_browser_tabs = internalAction({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		sessionId: v.id("files_browser_sessions"),
		expectedAgentLease: browser_agent_lease_validator,
		operationId: v.string(),
		operationDeadline: v.number(),
		toolCallId: v.string(),
		operation: v.union(v.literal("tabs"), v.literal("tab-new"), v.literal("tab-close")),
		tabId: v.optional(v.string()),
		url: v.optional(v.string()),
	},
	returns: v_result({ _yay: browser_tabs_result_validator }),
	handler: async (ctx, args): Promise<BrowserActionResult<Infer<typeof browser_tabs_result_validator>>> => {
		const checked = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
		});
		if (checked._nay) return checked;
		const membership = await ctx.runQuery(internal.files_browser.get_browser_membership, {
			userId: args.source.userId,
			membershipId: args.source.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		return browser_tabs_for_owner(ctx, { ...args, userId: args.source.userId, membership, route: args.operation });
	},
});

function file_session_public_meta(session: FileBrowserSession) {
	return {
		mode: "file" as const,
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
		_yay: browser_file_session_public_validator,
		_nay: { data: browser_start_refusal_data_validator },
	}),
	handler: async (
		ctx,
		args,
	): Promise<
		BrowserActionResult<
			Infer<typeof browser_file_session_public_validator>,
			Infer<typeof browser_start_refusal_data_validator>
		>
	> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		// Anonymous users cannot start a browser in either mode, even in an organization whose paid
		// owner pays for it.
		if (!user || userAuth?.kind === "anonymous") {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		return start_file_browser_for_member({ ctx, ...args, user, membership });
	},
});

async function start_file_browser_for_member(args: {
	ctx: ActionCtx;
	membershipId: Id<"organizations_workspaces_users">;
	targetKind: "saved" | "private";
	nodeId: string;
	path: string;
	sourceKind: "saved" | "proposed" | "draft";
	navigationGeneration: number;
	navigationClientId: string;
	viewport: { width: number; height: number };
	draftCaptureId?: Id<"files_browser_draft_captures">;
	draftStorageId?: string;
	draftRevisionAfter?: number;
	operationId?: string;
	operationDeadline?: number;
	toolCallId?: string;
	admittedAgentControl?: { sessionId: Id<"files_browser_sessions">; controlGen: number };
	source?: Infer<typeof ai_chat_browser_source_validator>;
	browserIntent?: Infer<typeof browser_intent_validator>;
	user: Doc<"users">;
	membership: Doc<"organizations_workspaces_users">;
}): Promise<
	BrowserActionResult<
		Infer<typeof browser_file_session_public_validator>,
		Infer<typeof browser_start_refusal_data_validator>
	>
> {
	const { ctx, user, membership } = args;

	const existing = (await ctx.runQuery(internal.files_browser.load_browser_session, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: user._id,
		membershipId: args.membershipId,
		mode: "file",
	})) as load_browser_session_Result;
	if (existing._yay?.runnerSessionId) {
		const checked = await files_browser_refresh_session(ctx, existing._yay);
		if (checked._nay) {
			if (checked._nay.message === "Browser is closing") {
				return Result({ _nay: { message: BROWSER_CLOSING_MESSAGE } });
			}
			return checked;
		}

		// A file browser keeps running after the user opens another file. When the user can no
		// longer open its file (archived, deleted, or access removed), the Files panel does not
		// show it, so nothing on screen can end it. The check below ends it in that case, and
		// this start then takes the browser slot. A session the user can still open stays live.
		if (checked._yay?.mode === "file") {
			await authorize_live_browser_session(ctx, { membership, userId: user._id, session: checked._yay });
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
		if (live._yay.mode !== "file") {
			return Result({ _nay: { message: "Not found" } });
		}
		if (
			args.source &&
			(live._yay.control !== "ready" ||
				live._yay._id !== args.admittedAgentControl?.sessionId ||
				live._yay.controlGen !== args.admittedAgentControl.controlGen)
		)
			return Result({ _nay: { name: "stale", message: "Browser control changed" } });
		return Result({ _yay: file_session_public_meta(live._yay) });
	}
	if (args.sourceKind === "draft" && (!args.draftCaptureId || !args.draftStorageId)) {
		await discardStarting();
		return Result({ _nay: { name: "needs_capture", message: "Capture the current editor draft first." } });
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
	if (args.source && args.browserIntent) {
		const allowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
			mode: "file",
		});
		if (allowed._nay) {
			await discardStarting();
			return allowed;
		}
	}
	if (args.source && args.operationId) {
		const bound = await ctx.runMutation(internal.ai_chat_files.bind_browser_open_invocation, {
			commandId: args.operationId,
			source: args.source,
			sessionId: created._yay.sessionId,
		});
		if (bound._nay) {
			await discardStarting();
			return bound;
		}
	}
	const opened = await files_browser_runner_call({
		route: "open",
		body: {
			mode: "file",
			attemptId: args.operationId ?? crypto.randomUUID(),
			operationId: args.operationId,
			operationDeadline: args.operationDeadline,
			source: args.source
				? { chatId: args.source.threadId, sourceMessageId: args.source.sourceMessageId, toolCallId: args.toolCallId }
				: undefined,
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
		const refused = [
			"address_blocked",
			"user_limit",
			"organization_limit",
			"workspace_limit",
			"deployment_limit",
		].includes(opened._nay.name ?? "");
		if (!args.operationId || refused) await discardStarting();
		console.error("Browser open failed", { code: opened._nay.name ?? null });
		return Result({
			_nay: {
				...(args.operationId ? { name: refused ? "operation_refused" : "outcome_unknown" } : {}),
				message: browser_open_refusal_message(opened._nay.name),
			},
		});
	}
	const parsed = files_browser_runner_open_schema.safeParse(opened._yay);
	if (!parsed.success || parsed.data.session.mode !== "file") {
		if (!args.operationId) await discardStarting();
		console.error("Browser open returned an invalid response", {});
		return Result({ _nay: { name: "outcome_unknown", message: "Browser did not start" } });
	}

	const committed = (await ctx.runMutation(internal.files_browser.commit_live_browser_session, {
		sessionId: created._yay.sessionId,
		navigationGeneration: args.navigationGeneration,
		runner: parsed.data.session,
	})) as commit_live_browser_session_Result;
	if (committed._nay) {
		// End ran while the runner was opening and closed the doc. Close the orphan at once and bill
		// its time. Do not discard the doc: it is no longer starting, and it must stay until it is billed.
		const closed = await files_browser_runner_call({
			route: "close",
			body: {
				mode: "file",
				sessionId: parsed.data.session.sessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				reason: "start_orphan",
			},
		});
		const usage = closed._nay ? null : files_browser_runner_close_schema.safeParse(closed._yay);
		await ctx.runMutation(internal.files_browser.settle_browser_usage, {
			sessionId: created._yay.sessionId,
			usage: usage?.success ? usage.data.usage : null,
		});
		return Result({ _nay: { message: "Browser did not start" } });
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
	if (live._yay.mode !== "file") {
		return Result({ _nay: { message: "Not found" } });
	}
	if (args.source && (live._yay.control !== "ready" || live._yay.controlGen !== parsed.data.session.controlGen))
		return Result({ _nay: { name: "stale", message: "Browser control changed" } });
	return Result({ _yay: file_session_public_meta(live._yay) });
}

/**
 * Start one shared cloud web browser, with no file. Only paid plans may start one, and the
 * owner needs the `workspace.browser.use` permission. A repeated start reattaches to the live web
 * session. The agent may use the browser from the start; the owner can turn that off.
 */
export const start_web_browser = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		viewport: v.object({ width: v.number(), height: v.number() }),
		startUrl: v.union(v.string(), v.null()),
	},
	returns: v_result({
		_yay: v.object({ session: browser_web_session_public_validator }),
		_nay: { data: browser_start_refusal_data_validator },
	}),
	handler: async (
		ctx,
		args,
	): Promise<
		BrowserActionResult<
			{ session: Infer<typeof browser_web_session_public_validator> },
			Infer<typeof browser_start_refusal_data_validator>
		>
	> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || userAuth?.kind === "anonymous") {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		return await start_web_browser_for_member({ ctx, ...args, user, membership });
	},
});

async function start_web_browser_for_member(args: {
	ctx: ActionCtx;
	membershipId: Id<"organizations_workspaces_users">;
	viewport: { width: number; height: number };
	startUrl: string | null;
	operationId?: string;
	operationDeadline?: number;
	admittedAgentControl?: { sessionId: Id<"files_browser_sessions">; controlGen: number };
	toolCallId?: string;
	source?: Infer<typeof ai_chat_browser_source_validator>;
	browserIntent?: Infer<typeof browser_intent_validator>;
	user: Doc<"users">;
	membership: Doc<"organizations_workspaces_users">;
}): Promise<
	BrowserActionResult<
		{ session: Infer<typeof browser_web_session_public_validator> },
		Infer<typeof browser_start_refusal_data_validator>
	>
> {
	let { ctx, user, membership } = args;

	if (process.env.AI_CHAT_BROWSER_ENABLED !== "true") {
		return Result({ _nay: { message: "Browser unavailable" } });
	}

	// The runner checks the address again with its deny list. This check only catches bad input early.
	let startUrl: string | null = null;
	if (args.startUrl !== null) {
		const normalized = browser_web_normalize_url(args.startUrl, []);
		if (!normalized.ok) {
			return Result({ _nay: { message: "Address blocked" } });
		}
		startUrl = normalized.url;
	}

	const existing = (await ctx.runQuery(internal.files_browser.load_browser_session, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: user._id,
		membershipId: args.membershipId,
		mode: "web",
	})) as load_browser_session_Result;
	if (existing._yay?.runnerSessionId) {
		const checked = await files_browser_refresh_session(ctx, existing._yay);
		if (checked._nay) {
			if (checked._nay.message === "Browser is closing") {
				return Result({ _nay: { message: BROWSER_CLOSING_MESSAGE } });
			}
			return checked;
		}
	}

	const created = (await ctx.runMutation(internal.files_browser.create_starting_web_browser_session, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: user._id,
		membershipId: args.membershipId,
		viewportWidth: args.viewport.width,
		viewportHeight: args.viewport.height,
	})) as create_starting_web_browser_session_Result;
	if (created._nay) {
		return created;
	}

	const loadLive = async (admittedControlGen: number | undefined) => {
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
		if (live._yay.mode !== "web") {
			return Result({ _nay: { message: "Not found" } });
		}
		// Open keeps its admitted control. Take and Resume must not rebind an older turn.
		if (
			args.source &&
			(live._yay.control !== "ready" ||
				live._yay.controlGen !== admittedControlGen ||
				(created._yay.reattached && live._yay._id !== args.admittedAgentControl?.sessionId))
		)
			return Result({ _nay: { name: "stale", message: "Browser control changed" } });
		return Result({ _yay: { session: web_session_public_meta(live._yay) } });
	};

	// Reattach keeps the page the user left. `startUrl` applies only to a new session.
	if (created._yay.reattached) {
		return await loadLive(args.admittedAgentControl?.controlGen);
	}

	const discardStarting = async () => {
		await ctx.runMutation(internal.files_browser.delete_starting_browser_session, {
			sessionId: created._yay.sessionId,
		});
	};

	if (args.source && args.browserIntent) {
		const checked = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
		});
		if (checked._nay) {
			await discardStarting();
			return checked;
		}
	}
	if (args.source && args.operationId) {
		const bound = await ctx.runMutation(internal.ai_chat_files.bind_browser_open_invocation, {
			commandId: args.operationId,
			source: args.source,
			sessionId: created._yay.sessionId,
		});
		if (bound._nay) {
			await discardStarting();
			return bound;
		}
	}

	const opened = await files_browser_runner_call({
		route: "open",
		body: {
			mode: "web",
			attemptId: args.operationId ?? crypto.randomUUID(),
			operationId: args.operationId,
			operationDeadline: args.operationDeadline,
			source: args.source
				? { chatId: args.source.threadId, sourceMessageId: args.source.sourceMessageId, toolCallId: args.toolCallId }
				: undefined,
			ownerId: user._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			navGen: 1,
			startUrl,
			viewport: args.viewport,
			agentAccess: created._yay.profile.agentAccess,
			policyRevision: created._yay.profile.policyRevision,
			// The runner keeps the key only in memory, to unlock and save this profile's cookies.
			profileId: created._yay.profile.profileId,
			profileKey: browser_profile_key_base64(created._yay.profile.profileKey),
			agentBlockedHosts: created._yay.profile.agentBlockedHosts,
		},
	});
	if (opened._nay) {
		const refused = [
			"address_blocked",
			"user_limit",
			"organization_limit",
			"workspace_limit",
			"deployment_limit",
		].includes(opened._nay.name ?? "");
		if (!args.operationId || refused) await discardStarting();
		if (opened._nay.name === "address_blocked") {
			return Result({ _nay: { message: "Address blocked" } });
		}
		console.error("Browser open failed", { code: opened._nay.name ?? null });
		return Result({
			_nay: {
				...(args.operationId ? { name: refused ? "operation_refused" : "outcome_unknown" } : {}),
				message: browser_open_refusal_message(opened._nay.name),
			},
		});
	}
	const parsed = files_browser_runner_open_schema.safeParse(opened._yay);
	if (!parsed.success || parsed.data.session.mode !== "web") {
		if (!args.operationId) await discardStarting();
		console.error("Browser open returned an invalid response", {});
		return Result({ _nay: { name: "outcome_unknown", message: "Browser did not start" } });
	}

	const committed = (await ctx.runMutation(internal.files_browser.commit_live_browser_session, {
		sessionId: created._yay.sessionId,
		navigationGeneration: 1,
		runner: parsed.data.session,
	})) as commit_live_browser_session_Result;
	if (committed._nay) {
		// End ran while the runner was opening. Close the orphan at once and bill its time, so
		// ending during Start is not free browser time. Do not discard the doc: it is no longer
		// starting, and it must stay until it is billed.
		const closed = await files_browser_runner_call({
			route: "close",
			body: {
				mode: "web",
				sessionId: parsed.data.session.sessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				saveProfile: false,
				reason: "start_orphan",
			},
		});
		const usage = closed._nay ? null : files_browser_runner_close_schema.safeParse(closed._yay);
		await ctx.runMutation(internal.files_browser.settle_browser_usage, {
			sessionId: created._yay.sessionId,
			usage: usage?.success ? usage.data.usage : null,
		});
		return Result({ _nay: { message: "Browser did not start" } });
	}

	return await loadLive(parsed.data.session.controlGen);
}

export const agent_open_browser = internalAction({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		operationId: v.string(),
		operationDeadline: v.number(),
		toolCallId: v.string(),
		startUrl: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.object({ session: browser_web_session_public_validator }) }),
	handler: async (
		ctx,
		args,
	): Promise<BrowserActionResult<{ session: Infer<typeof browser_web_session_public_validator> }>> => {
		const checked = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
		});
		if (checked._nay) return checked;
		const user = await ctx.runQuery(internal.users.get, { userId: args.source.userId });
		const membership = await ctx.runQuery(internal.files_browser.get_browser_membership, {
			userId: args.source.userId,
			membershipId: args.source.membershipId,
		});
		if (!user || !membership || !user.clerkUserId)
			return Result({ _nay: { message: "Cloud browser needs a signed-in account" } });
		const previous = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			userId: args.source.userId,
			organizationId: args.source.organizationId,
			workspaceId: args.source.workspaceId,
			membershipId: args.source.membershipId,
			mode: "web",
		})) as load_browser_session_Result;
		if (previous._yay && previous._yay.control !== "ready")
			return Result({ _nay: { message: "Browser is paused or busy" } });
		const opened = await start_web_browser_for_member({
			ctx,
			membershipId: membership._id,
			viewport: { width: 1280, height: 720 },
			startUrl: args.startUrl ?? null,
			operationId: args.operationId,
			operationDeadline: args.operationDeadline,
			admittedAgentControl: previous._yay
				? { sessionId: previous._yay._id, controlGen: previous._yay.controlGen }
				: undefined,
			source: args.source,
			browserIntent: args.browserIntent,
			toolCallId: args.toolCallId,
			user,
			membership,
		});
		if (opened._nay) return Result({ _nay: { name: opened._nay.name, message: opened._nay.message } });
		const stillAllowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
		});
		if (stillAllowed._nay) {
			// A revoked start owns only its new session. Never end a browser it reused.
			if (previous._yay?._id !== opened._yay.session.sessionId)
				await ctx.runAction(internal.files_browser.end_browser_session_internal, {
					sessionId: opened._yay.session.sessionId,
					reason: "source_revoked",
				});
			return stillAllowed;
		}
		return Result({ _yay: opened._yay });
	},
});

export const agent_open_file_browser = internalAction({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		operationId: v.string(),
		operationDeadline: v.number(),
		toolCallId: v.string(),
		path: v.string(),
		sourceKind: files_browser_session_source_kind_validator,
	},
	returns: v_result({ _yay: v.object({ session: browser_file_session_public_validator }) }),
	handler: async (
		ctx,
		args,
	): Promise<BrowserActionResult<{ session: Infer<typeof browser_file_session_public_validator> }>> => {
		const allowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
			mode: "file",
		});
		if (allowed._nay) return allowed;
		const user = await ctx.runQuery(internal.users.get, { userId: args.source.userId });
		const membership = await ctx.runQuery(internal.files_browser.get_browser_membership, {
			userId: args.source.userId,
			membershipId: args.source.membershipId,
		});
		if (!user || !membership || !user.clerkUserId)
			return Result({ _nay: { message: "Cloud browser needs a signed-in account" } });
		const entry = (await ctx.runQuery(internal.files_nodes.get_visible_entry_by_path, {
			organizationId: args.source.organizationId,
			workspaceId: args.source.workspaceId,
			path: args.path,
			visibilityUserId: args.source.userId,
			overlayUserId: args.source.userId,
		})) as files_nodes_get_visible_entry_by_path_Result;
		if (!entry || entry.node.kind !== "file") return Result({ _nay: { message: "Not found" } });
		const previous = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			userId: args.source.userId,
			organizationId: args.source.organizationId,
			workspaceId: args.source.workspaceId,
			membershipId: args.source.membershipId,
			mode: "file",
		})) as load_browser_session_Result;
		if (previous._yay && previous._yay.control !== "ready")
			return Result({ _nay: { message: "Browser is paused or busy" } });
		const exact =
			previous._yay?.mode === "file" &&
			previous._yay.nodeId === String(entry.node._id) &&
			previous._yay.targetKind === entry.kind &&
			previous._yay.sourceKind === args.sourceKind
				? previous._yay
				: null;
		if (args.sourceKind === "draft" && !exact)
			return Result({ _nay: { name: "needs_capture", message: "Capture the current editor draft first." } });
		const opened = await start_file_browser_for_member({
			ctx,
			membershipId: membership._id,
			targetKind: entry.kind,
			nodeId: String(entry.node._id),
			path: args.path,
			sourceKind: args.sourceKind,
			navigationGeneration: exact?.navigationGeneration ?? 1,
			navigationClientId: exact?.navigationClientId ?? args.operationId,
			viewport: { width: 1280, height: 720 },
			operationId: args.operationId,
			operationDeadline: args.operationDeadline,
			admittedAgentControl: previous._yay
				? { sessionId: previous._yay._id, controlGen: previous._yay.controlGen }
				: undefined,
			source: args.source,
			browserIntent: args.browserIntent,
			toolCallId: args.toolCallId,
			user,
			membership,
		});
		if (opened._nay) return Result({ _nay: { name: opened._nay.name, message: opened._nay.message } });
		const stillAllowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
			mode: "file",
		});
		if (stillAllowed._nay) {
			if (previous._yay?._id !== opened._yay.sessionId)
				await ctx.runAction(internal.files_browser.end_browser_session_internal, {
					sessionId: opened._yay.sessionId,
					reason: "source_revoked",
				});
			return stillAllowed;
		}
		return Result({ _yay: { session: opened._yay } });
	},
});

export const get_agent_browser_catalog = internalQuery({
	args: { source: ai_chat_browser_source_validator, browserIntent: browser_intent_validator },
	returns: v_result({
		_yay: v.object({
			browsers: v.array(v.object({ browserRef: v.string(), resource: ai_chat_browser_resource_validator })),
		}),
	}),
	handler: async (ctx, args) => {
		const checked = await files_browser_db_check_agent_intent(ctx, { ...args, mode: "file" });
		if (checked._nay) return checked;
		const webAllowed = await files_browser_db_check_agent_intent(ctx, args);
		const sessions = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_owner_organization_workspace", (q) =>
				q
					.eq("ownerId", args.source.userId)
					.eq("organizationId", args.source.organizationId)
					.eq("workspaceId", args.source.workspaceId),
			)
			.collect();
		const browsers: Array<{ browserRef: string; resource: Infer<typeof ai_chat_browser_resource_validator> }> = [];
		for (const session of sessions) {
			if (session.control !== "ready" || !session.runnerSessionId) continue;
			if (
				session.mode === "web" &&
				(webAllowed._nay || !session.agentAccess || session.policyRevision !== args.browserIntent.policyRevision)
			)
				continue;
			const access = await check_browser_session_access_db(ctx, {
				userId: args.source.userId,
				organizationId: args.source.organizationId,
				workspaceId: args.source.workspaceId,
				membershipId: args.source.membershipId,
				sessionId: session._id,
			});
			if (!access.ok) continue;
			browsers.push({
				browserRef: session._id,
				resource: {
					provider: "cloud",
					mode: session.mode,
					sessionId: session._id,
					controlGen: session.controlGen,
					loadGen: session.loadGen,
					navGen: session.navigationGeneration,
					tabId: session.mode === "web" ? session.tabId : null,
					tabGen: session.mode === "web" ? session.tabGen : null,
				},
			});
		}
		return Result({ _yay: { browsers } });
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
			mode: v.union(v.literal("file"), v.literal("web")),
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
					mode: session.mode,
					ownerId: session.ownerId,
					organizationId: session.organizationId,
					workspaceId: session.workspaceId,
				},
			});
		}

		const expectedAgentLease = args.expectedAgentLease;
		const expectedTab =
			session.mode === "web" ? session.tabs.find((tab) => tab.tabId === expectedAgentLease?.tabId) : null;
		if (
			expectedAgentLease &&
			(session.control !== "ready" ||
				session.controlGen !== expectedAgentLease.controlGen ||
				session.loadGen !== expectedAgentLease.loadGen ||
				(session.mode === "file"
					? session.navigationGeneration !== expectedAgentLease.navGen
					: !expectedTab ||
						expectedTab.navGen !== expectedAgentLease.navGen ||
						expectedTab.tabGen !== expectedAgentLease.tabGen ||
						session.policyRevision !== expectedAgentLease.policyRevision))
		) {
			return Result({ _nay: { message: "Browser control changed" } });
		}
		// Agent close must win its runner lease check before changing the app session.
		if (!expectedAgentLease) {
			if (session.mode === "web") {
				const preference = await files_browser_db_get_preferences(ctx, membership);
				const next = {
					ownerId: args.userId,
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					...browser_preferences_public(preference),
					policyRevision: preference.policyRevision + 1,
					syncPending: true,
					updatedAt: Date.now(),
				};
				const preferenceId =
					"_id" in preference ? preference._id : await ctx.db.insert("files_browser_preferences", next);
				if ("_id" in preference) await ctx.db.patch("files_browser_preferences", preferenceId, next);
				await ctx.scheduler.runAfter(0, internal.files_browser.sync_browser_preferences_for_member, {
					preferenceId,
					membershipId: membership._id,
				});
			}
			await ctx.db.patch("files_browser_sessions", args.sessionId, {
				control: "closing",
				updatedAt: Date.now(),
			});
		}
		return Result({
			_yay: {
				runnerSessionId: session.runnerSessionId ?? null,
				mode: session.mode,
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
	handler: async (ctx, args): Promise<BrowserActionResult<null>> => {
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

		return end_browser_for_member({ ctx, ...args, user, membership });
	},
});

async function end_browser_for_member(args: {
	ctx: ActionCtx;
	membershipId: Id<"organizations_workspaces_users">;
	sessionId: Id<"files_browser_sessions">;
	expectedAgentLease?: Infer<typeof browser_agent_lease_validator>;
	source?: Infer<typeof ai_chat_browser_source_validator>;
	browserIntent?: Infer<typeof browser_intent_validator>;
	operationId?: string;
	operationDeadline?: number;
	toolCallId?: string;
	user: Doc<"users">;
	membership: Doc<"organizations_workspaces_users">;
}): Promise<BrowserActionResult<null>> {
	const { ctx, user, membership } = args;

	if (args.source && args.browserIntent) {
		const loaded = (await ctx.runQuery(internal.files_browser.load_browser_session, {
			userId: user._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			membershipId: membership._id,
			sessionId: args.sessionId,
		})) as load_browser_session_Result;
		if (loaded._nay) return loaded;
		const allowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
			mode: loaded._yay.mode,
		});
		if (allowed._nay) return allowed;
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
				mode: begun._yay.mode,
				sessionId: begun._yay.runnerSessionId,
				ownerId: begun._yay.ownerId,
				organizationId: begun._yay.organizationId,
				workspaceId: begun._yay.workspaceId,
				expectedAgentLease: args.expectedAgentLease,
				// Only a human End saves the web profile. The agent's close never does.
				operationId: args.operationId,
				operationDeadline: args.operationDeadline,
				source: args.source
					? { chatId: args.source.threadId, sourceMessageId: args.source.sourceMessageId, toolCallId: args.toolCallId }
					: undefined,
				saveProfile: !args.expectedAgentLease,
				reason: args.expectedAgentLease ? "agent_close" : "human_end",
			},
		});
		if (closed._nay) {
			if (args.expectedAgentLease) {
				return closed;
			}
			console.error("Browser close failed", { message: closed._nay.message });
		} else {
			if (args.operationId) {
				const ack = browser_management_ack_schema.safeParse(closed._yay);
				if (!ack.success || ack.data.status !== "completed")
					return Result({
						_nay: {
							name: ack.success && ack.data.status === "refused" ? "operation_refused" : "outcome_unknown",
							message: "Browser close did not complete",
						},
					});
			}
			const usage = files_browser_runner_close_schema.safeParse(closed._yay);
			await ctx.runMutation(internal.files_browser.settle_browser_usage, {
				sessionId: args.sessionId,
				usage: usage.success ? usage.data.usage : null,
			});
			return Result({ _yay: null });
		}
	}

	await ctx.runMutation(internal.files_browser.finish_close_browser_session, {
		sessionId: args.sessionId,
	});
	return Result({ _yay: null });
}

export const agent_close_browser = internalAction({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		sessionId: v.id("files_browser_sessions"),
		expectedAgentLease: browser_agent_lease_validator,
		operationId: v.string(),
		operationDeadline: v.number(),
		toolCallId: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args): Promise<BrowserActionResult<null>> => {
		const user = await ctx.runQuery(internal.users.get, { userId: args.source.userId });
		const membership = await ctx.runQuery(internal.files_browser.get_browser_membership, {
			userId: args.source.userId,
			membershipId: args.source.membershipId,
		});
		if (!user || !membership) return Result({ _nay: { message: "Unauthorized" } });
		return end_browser_for_member({ ctx, ...args, membershipId: membership._id, user, membership });
	},
});

/**
 * Close one session without any membership check. It runs after the owner lost access, for
 * example after a member was removed, so the owner's membership may be gone already.
 */
export const begin_close_browser_session_internal = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
	},
	returns: v.union(
		v.object({
			runnerSessionId: v.string(),
			mode: v.union(v.literal("file"), v.literal("web")),
			ownerId: v.id("users"),
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (!session || session.control === "closed") {
			return null;
		}
		const now = Date.now();
		if (!session.runnerSessionId) {
			await ctx.db.patch("files_browser_sessions", args.sessionId, {
				control: "closed",
				closedAt: now,
				updatedAt: now,
			});
			return null;
		}
		await ctx.db.patch("files_browser_sessions", args.sessionId, { control: "closing", updatedAt: now });
		return {
			runnerSessionId: session.runnerSessionId,
			mode: session.mode,
			ownerId: session.ownerId,
			organizationId: session.organizationId,
			workspaceId: session.workspaceId,
		};
	},
});

/**
 * End one session from the server side: after access loss, before a saved-profile read or clear,
 * and at account deletion. No membership check. The runner does not save the web profile, and the
 * usage is settled from the close reply.
 */
export const end_browser_session_internal = internalAction({
	args: {
		sessionId: v.id("files_browser_sessions"),
		reason: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const begun = await ctx.runMutation(internal.files_browser.begin_close_browser_session_internal, {
			sessionId: args.sessionId,
		});
		if (!begun) {
			return null;
		}

		const closed = await files_browser_runner_call({
			route: "close",
			body: {
				mode: begun.mode,
				sessionId: begun.runnerSessionId,
				ownerId: begun.ownerId,
				organizationId: begun.organizationId,
				workspaceId: begun.workspaceId,
				saveProfile: false,
				reason: args.reason,
			},
		});
		if (closed._nay) {
			// The runner's idle alarm reaps the orphan. The settle cron bills it later from `status`.
			console.error("Browser close failed", { reason: args.reason, message: closed._nay.message });
			await ctx.runMutation(internal.files_browser.finish_close_browser_session, { sessionId: args.sessionId });
			return null;
		}

		const usage = files_browser_runner_close_schema.safeParse(closed._yay);
		await ctx.runMutation(internal.files_browser.settle_browser_usage, {
			sessionId: args.sessionId,
			usage: usage.success ? usage.data.usage : null,
		});
		return null;
	},
});

/**
 * Bill one session's browser time once, and mark the doc closed. Every close path calls this:
 * End, the internal close, a status check that finds the session gone, and the settle cron.
 *
 * `usage` is the runner's receipt. When it is missing, wait: the runner may still be writing it.
 * Only when the session ended more than `BROWSER_USAGE_RECEIPT_WAIT_MS` ago, bill 0 and log it.
 * A doc that End closed during Start has no runner session yet. Its start action may still record
 * one when the runner open finishes, so it waits until the start deadline, then bills 0.
 */
export const settle_browser_usage = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		usage: v.union(
			v.object({
				providerAcquiredAt: v.number(),
				endedAt: v.number(),
				reason: v.string(),
			}),
			v.null(),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (!session || session.billing.state === "settled") {
			return null;
		}
		if (!args.usage && !session.runnerSessionId) {
			const opening = await ctx.db
				.query("ai_chat_browser_invocations")
				.withIndex("by_openingSession", (q) => q.eq("openingSessionId", session._id))
				.first();
			if (opening && opening.status !== "finished") return null;
		}

		const now = Date.now();
		const closedAt = session.closedAt ?? now;
		const waitUntil = session.runnerSessionId
			? (session.closedAt ?? session.totalUntil ?? now) + BROWSER_USAGE_RECEIPT_WAIT_MS
			: (session.startingExpiresAt ?? 0);
		if (!args.usage && waitUntil > now) {
			// Always move `updatedAt`, so the settle cron reads other pending docs first next time.
			await ctx.db.patch("files_browser_sessions", args.sessionId, { control: "closed", closedAt, updatedAt: now });
			return null;
		}

		if (!args.usage && session.runnerSessionId) {
			console.warn("browser_usage_missing", { sessionId: args.sessionId });
		}
		const billedMs = args.usage ? Math.max(0, args.usage.endedAt - args.usage.providerAcquiredAt) : 0;
		// Round to tenths of a cent. Without it, 3 minutes bill 0.8999999999999999 instead of 0.9.
		const amountCents = Math.round(Math.ceil(billedMs / 60_000) * BROWSER_COST_CENTS_PER_MINUTE * 10) / 10;

		const billedUser = await ctx.db.get("users", session.billedUserId);
		if (amountCents > 0 && billedUser) {
			const event: billing_Event = {
				name: "browser_usage",
				externalCustomerId: session.billedUserId,
				externalMemberId: session.ownerId,
				externalId: composite_id(
					"billing",
					"browser_usage",
					session.billedUserId,
					session.ownerId,
					session.organizationId,
					session.workspaceId,
					session._id,
				),
				metadata: {
					amount: amountCents,
					actorUserId: session.ownerId,
					billedUserId: session.billedUserId,
					organizationId: session.organizationId,
					workspaceId: session.workspaceId,
					sessionId: session._id,
					mode: session.mode,
					billedMs,
				},
			};
			await billing_ingest_events(ctx, { billedUserEvents: [{ billedUser, event }] });
		}

		await ctx.db.patch("files_browser_sessions", args.sessionId, {
			control: "closed",
			closedAt,
			billing: { state: "settled", billedMs, amountCents, settledAt: now },
			updatedAt: now,
		});
		return null;
	},
});

/**
 * Unbilled sessions that should be over: closed ones, and ones past their total deadline plus
 * the receipt wait. A session whose doc still says `ready` after the runner ended it shows up
 * here too, so no browser time stays unbilled.
 */
export const list_browser_sessions_to_settle = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			sessionId: v.id("files_browser_sessions"),
			runnerSessionId: v.union(v.string(), v.null()),
			mode: v.union(v.literal("file"), v.literal("web")),
			ownerId: v.id("users"),
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
		}),
	),
	handler: async (ctx) => {
		const overdueAt = Date.now() - BROWSER_USAGE_RECEIPT_WAIT_MS;
		const sessions = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_billing_state_updatedAt", (q) => q.eq("billing.state", "pending"))
			.filter((q) =>
				q.or(
					q.eq(q.field("control"), "closed"),
					q.and(q.neq(q.field("totalUntil"), undefined), q.lte(q.field("totalUntil"), overdueAt)),
				),
			)
			.take(BROWSER_SETTLE_BATCH_SIZE);
		return sessions.map((session) => ({
			sessionId: session._id,
			mode: session.mode,
			runnerSessionId: session.runnerSessionId ?? null,
			ownerId: session.ownerId,
			organizationId: session.organizationId,
			workspaceId: session.workspaceId,
		}));
	},
});

type list_browser_sessions_to_settle_Result =
	typeof list_browser_sessions_to_settle extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Move one unbilled doc to the back of the settle cron's order. The cron reads the oldest
 * `updatedAt` first, so docs that cannot settle yet would otherwise fill every batch and starve
 * newer ones.
 */
export const delay_browser_usage_settle = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (session && session.billing.state === "pending") {
			await ctx.db.patch("files_browser_sessions", args.sessionId, { updatedAt: Date.now() });
		}
		return null;
	},
});

/**
 * Close live web sessions whose owner lost the membership or the `workspace.browser.use`
 * permission. The Browser page hides such a session, so no viewer door runs to close it. Without
 * this, the browser would stay open and billed until its idle deadline.
 */
export const close_web_browser_sessions_without_access = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		// Web mode turned off is a deploy switch, not an access loss. The deploy steps end live
		// browsers first.
		if (process.env.AI_CHAT_BROWSER_ENABLED !== "true") {
			return null;
		}

		// Every live session is still unbilled, and the runner allows only ten live browsers per
		// deployment, so this read stays small.
		const sessions = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_billing_state_updatedAt", (q) => q.eq("billing.state", "pending"))
			.filter((q) =>
				q.and(
					q.eq(q.field("mode"), "web"),
					q.or(
						q.eq(q.field("control"), "starting"),
						q.eq(q.field("control"), "ready"),
						q.eq(q.field("control"), "human"),
						q.eq(q.field("control"), "pausing"),
					),
				),
			)
			.take(BROWSER_SETTLE_BATCH_SIZE);
		for (const session of sessions) {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", session.ownerId)
						.eq("organizationId", session.organizationId)
						.eq("workspaceId", session.workspaceId),
				)
				.first();
			const authorized = membership
				? await browser_db_authorize_web_use(ctx, { userId: session.ownerId, membership })
				: null;
			if (authorized && !authorized._nay) {
				continue;
			}
			await ctx.scheduler.runAfter(0, internal.files_browser.end_browser_session_internal, {
				sessionId: session._id,
				reason: "access_lost",
			});
		}
		return null;
	},
});

/**
 * Cron: close web sessions that lost access, then bill sessions that ended without a settle, for
 * example when End failed or the doc stayed `ready` after the runner closed the browser. Settle
 * only when the runner says the session is gone and not still closing.
 */
export const settle_pending_browser_usage = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await ctx.runMutation(internal.files_browser.close_web_browser_sessions_without_access, {});

		const sessions = (await ctx.runQuery(
			internal.files_browser.list_browser_sessions_to_settle,
			{},
		)) as list_browser_sessions_to_settle_Result;

		await Promise.all(
			sessions.map(async (session) => {
				if (!session.runnerSessionId) {
					await ctx.runMutation(internal.files_browser.settle_browser_usage, {
						sessionId: session.sessionId,
						usage: null,
					});
					return;
				}

				const checked = await files_browser_runner_call({
					route: "status",
					body: {
						mode: session.mode,
						sessionId: session.runnerSessionId,
						ownerId: session.ownerId,
						organizationId: session.organizationId,
						workspaceId: session.workspaceId,
					},
				});
				const parsed = checked._nay ? null : files_browser_runner_status_schema.safeParse(checked._yay);
				if (!parsed?.success || parsed.data.alive || parsed.data.closing) {
					if (checked._nay) {
						console.error("Browser status check failed", { message: checked._nay.message });
					}
					await ctx.runMutation(internal.files_browser.delay_browser_usage_settle, { sessionId: session.sessionId });
					return;
				}
				await ctx.runMutation(internal.files_browser.settle_browser_usage, {
					sessionId: session.sessionId,
					usage: parsed.data.usage,
				});
			}),
		);
		return null;
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

const browser_reload_result_validator = v.union(
	v.object({
		mode: v.literal("file"),
		loadGen: v.number(),
		sourceVersion: v.string(),
		sourceHash: v.string(),
		controlGen: v.number(),
		navGen: v.number(),
	}),
	v.object({
		mode: v.literal("web"),
		loadGen: v.number(),
		controlGen: v.number(),
		navGen: v.number(),
		tabId: v.string(),
		tabGen: v.number(),
	}),
);

/**
 * Reload the live page from a newer snapshot of the same file and source kind. Drafts always
 * need a fresh capture; switching kinds is a user Start choice, never an agent reload.
 *
 * A web session has no file: the runner reloads the page it shows now, and `path` is ignored.
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
	returns: v_result({ _yay: browser_reload_result_validator }),
	handler: async (ctx, args): Promise<BrowserActionResult<Infer<typeof browser_reload_result_validator>>> => {
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
		return reload_browser_for_member({ ctx, ...args, user, membership });
	},
});

async function reload_browser_for_member(args: {
	ctx: ActionCtx;
	membershipId: Id<"organizations_workspaces_users">;
	sessionId: Id<"files_browser_sessions">;
	path: string;
	expectedAgentLease?: Infer<typeof browser_agent_lease_validator>;
	draftCaptureId?: Id<"files_browser_draft_captures">;
	draftStorageId?: string;
	draftRevisionAfter?: number;
	source?: Infer<typeof ai_chat_browser_source_validator>;
	browserIntent?: Infer<typeof browser_intent_validator>;
	operationId?: string;
	operationDeadline?: number;
	toolCallId?: string;
	user: Doc<"users">;
	membership: Doc<"organizations_workspaces_users">;
}): Promise<BrowserActionResult<Infer<typeof browser_reload_result_validator>>> {
	const { ctx, user, membership } = args;

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
	const runnerSessionId = session.runnerSessionId;
	if (!runnerSessionId) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (args.source && args.browserIntent) {
		const allowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
			mode: session.mode,
		});
		if (allowed._nay) return allowed;
	}

	if (session.mode === "web") {
		const source = await authorize_live_browser_session(ctx, { membership, userId: user._id, session });
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}
		const reloaded = await files_browser_runner_call({
			route: "reload",
			body: {
				sessionId: runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				navGen: args.expectedAgentLease?.navGen ?? session.navigationGeneration,
				mode: "web",
				expectedAgentLease: args.expectedAgentLease,
				tabId: args.expectedAgentLease?.tabId,
				tabGen: args.expectedAgentLease?.tabGen,
				operationId: args.operationId,
				operationDeadline: args.operationDeadline,
				source: args.source
					? { chatId: args.source.threadId, sourceMessageId: args.source.sourceMessageId, toolCallId: args.toolCallId }
					: undefined,
			},
		});
		if (reloaded._nay) {
			console.error("Browser reload failed", { message: reloaded._nay.message });
			return Result({ _nay: { message: "Browser did not reload" } });
		}
		if (args.operationId) {
			const ack = browser_management_ack_schema.safeParse(reloaded._yay);
			if (!ack.success || ack.data.status !== "completed")
				return Result({
					_nay: {
						name: ack.success && ack.data.status === "refused" ? "operation_refused" : "outcome_unknown",
						message: "Browser reload did not complete",
					},
				});
		}
		const parsed = files_browser_runner_open_schema.safeParse(reloaded._yay);
		if (!parsed.success || parsed.data.session.mode !== "web") {
			return Result({ _nay: { message: "Browser did not reload" } });
		}
		// Reload cannot adopt another tab or newer human control.
		if (
			args.expectedAgentLease &&
			(parsed.data.session.tabId !== args.expectedAgentLease.tabId ||
				parsed.data.session.controlGen !== args.expectedAgentLease.controlGen)
		) {
			return Result({ _nay: { name: "stale", message: "Browser control changed" } });
		}
		const updated = (await ctx.runMutation(internal.files_browser.sync_browser_session, {
			sessionId: args.sessionId,
			runner: parsed.data.session,
		})) as files_browser_sync_browser_session_Result;
		if (updated._nay) {
			return updated;
		}
		if (!updated._yay) return Result({ _nay: { message: "Not found" } });
		return Result({
			_yay: {
				mode: "web" as const,
				loadGen: parsed.data.session.loadGen,
				controlGen: parsed.data.session.controlGen,
				navGen: parsed.data.session.navGen,
				tabId: parsed.data.session.tabId,
				tabGen: parsed.data.session.tabGen,
			},
		});
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
			return Result({ _nay: { name: "needs_capture", message: "Capture the current editor draft first." } });
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

	if (args.source && args.browserIntent) {
		const allowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
			mode: "file",
		});
		if (allowed._nay) return allowed;
	}
	const reloaded = await files_browser_runner_call({
		route: "reload",
		body: {
			mode: "file",
			sessionId: runnerSessionId,
			ownerId: user._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			navGen: session.navigationGeneration,
			expectedAgentLease: args.expectedAgentLease,
			operationId: args.operationId,
			operationDeadline: args.operationDeadline,
			source: args.source
				? { chatId: args.source.threadId, sourceMessageId: args.source.sourceMessageId, toolCallId: args.toolCallId }
				: undefined,
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
	if (args.operationId) {
		const ack = browser_management_ack_schema.safeParse(reloaded._yay);
		if (!ack.success || ack.data.status !== "completed")
			return Result({
				_nay: {
					name: ack.success && ack.data.status === "refused" ? "operation_refused" : "outcome_unknown",
					message: "Browser reload did not complete",
				},
			});
	}

	const parsed = files_browser_runner_open_schema.safeParse(reloaded._yay);
	if (!parsed.success || parsed.data.session.mode !== "file") {
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
			mode: "file" as const,
			loadGen: parsed.data.session.loadGen,
			controlGen: parsed.data.session.controlGen,
			navGen: parsed.data.session.navGen,
			sourceVersion: parsed.data.session.sourceVersion,
			sourceHash: parsed.data.session.sourceHash,
		},
	});
}

export const agent_reload_browser = internalAction({
	args: {
		source: ai_chat_browser_source_validator,
		browserIntent: browser_intent_validator,
		sessionId: v.id("files_browser_sessions"),
		expectedAgentLease: browser_agent_lease_validator,
		operationId: v.string(),
		operationDeadline: v.number(),
		toolCallId: v.string(),
	},
	returns: v_result({ _yay: browser_reload_result_validator }),
	handler: async (ctx, args): Promise<BrowserActionResult<Infer<typeof browser_reload_result_validator>>> => {
		const user = await ctx.runQuery(internal.users.get, { userId: args.source.userId });
		const membership = await ctx.runQuery(internal.files_browser.get_browser_membership, {
			userId: args.source.userId,
			membershipId: args.source.membershipId,
		});
		if (!user || !membership) return Result({ _nay: { message: "Unauthorized" } });
		const result = await reload_browser_for_member({
			ctx,
			...args,
			membershipId: membership._id,
			path: "",
			user,
			membership,
		});
		if (result._nay) return result;
		const allowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
			source: args.source,
			browserIntent: args.browserIntent,
			mode: result._yay.mode,
		});
		return allowed._nay ? allowed : result;
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
		runner: browser_runner_session_validator,
	},
	returns: v_result({ _yay: v.union(doc(app_convex_schema, "files_browser_sessions"), v.null()) }),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (!session || session.control === "closed" || session.control === "closing") {
			return Result({ _yay: null });
		}
		const runner = args.runner;
		if (
			runner.mode !== session.mode ||
			runner.sessionId !== session.runnerSessionId ||
			(runner.mode === "file" && runner.navGen !== session.navigationGeneration) ||
			(runner.mode === "file" &&
				session.mode === "file" &&
				(runner.nodeId !== session.nodeId || runner.sourceKind !== session.sourceKind)) ||
			runner.control === "starting" ||
			runner.control === "closing" ||
			runner.control === "closed"
		) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		const patch: {
			loadGen?: number;
			sourceVersion?: string;
			sourceHash?: string;
			control?: "ready" | "human" | "pausing";
			controlGen?: number;
			agentAccess?: boolean;
			idleUntil?: number;
			totalUntil?: number;
			updatedAt?: number;
			navigationGeneration?: number;
			tabId?: string;
			tabGen?: number;
			viewedTabId?: string | null;
			viewGen?: number;
			tabCount?: number;
			policyRevision?: number;
			tabs?: WebBrowserSession["tabs"];
		} = {};
		// Source and control advance separately. A late reload must not undo a newer take.
		// A web reload keeps `loadGen`, so only a file reload lands here.
		if (runner.loadGen > session.loadGen) {
			patch.loadGen = runner.loadGen;
			if (runner.mode === "file") {
				patch.sourceVersion = runner.sourceVersion;
				patch.sourceHash = runner.sourceHash;
			}
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
		// Turning agent access on or off bumps `controlGen`, so an older reply cannot undo a newer switch.
		if (
			runner.mode === "web" &&
			session.mode === "web" &&
			runner.controlGen >= session.controlGen &&
			runner.policyRevision >= session.policyRevision
		) {
			patch.agentAccess = runner.agentAccess;
			const currentTab = session.tabs.find((current) => current.tabId === runner.tabId);
			const tab =
				currentTab && (runner.navGen < currentTab.navGen || runner.tabGen < currentTab.tabGen)
					? currentTab
					: { tabId: runner.tabId, tabGen: runner.tabGen, navGen: runner.navGen };
			// A delayed viewer reply must keep the tab's newer completed navigation.
			patch.tabId = tab.tabId;
			patch.tabGen = tab.tabGen;
			patch.tabCount = runner.tabCount;
			patch.navigationGeneration = tab.navGen;
			patch.tabs = currentTab
				? session.tabs.map((current) => (current.tabId === tab.tabId ? tab : current))
				: [...session.tabs, tab].slice(0, 8);
			patch.policyRevision = runner.policyRevision;
			if (runner.viewGen >= session.viewGen) {
				patch.viewedTabId = runner.viewedTabId;
				patch.viewGen = runner.viewGen;
			}
		}
		if (runner.idleUntil > (session.idleUntil ?? 0)) patch.idleUntil = runner.idleUntil;
		if (session.totalUntil !== runner.totalUntil) patch.totalUntil = runner.totalUntil;
		if (Object.keys(patch).length > 0) {
			patch.updatedAt = Date.now();
			await ctx.db.patch("files_browser_sessions", args.sessionId, patch);
		}
		return Result({ _yay: { ...session, ...patch } as Doc<"files_browser_sessions"> });
	},
});

export type files_browser_sync_browser_session_Result =
	typeof sync_browser_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Check web browser use for one member: web mode on, and the `workspace.browser.use` permission.
 */
export const authorize_web_browser_use = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const authorized = await browser_db_authorize_web_use(ctx, { userId: args.userId, membership });
		if (authorized._nay) {
			return authorized;
		}
		return Result({ _yay: null });
	},
});

type authorize_web_browser_use_Result =
	typeof authorize_web_browser_use extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Re-check live file access for viewer-side doors, and close the session promptly when it is
 * gone. Watching, taking, resuming, or extending must not survive a revoke, archive, delete,
 * or type change; the agent lease check refuses the same way without closing.
 *
 * A web session has no file, so its check is the `workspace.browser.use` permission.
 */
async function authorize_live_browser_session(
	ctx: ActionCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		userId: Id<"users">;
		session: Doc<"files_browser_sessions">;
	},
): Promise<{ ok: true } | { ok: false; message: string }> {
	if (args.session.mode === "web") {
		const authorized = (await ctx.runQuery(internal.files_browser.authorize_web_browser_use, {
			userId: args.userId,
			membershipId: args.membership._id,
		})) as authorize_web_browser_use_Result;
		if (authorized._nay) {
			// Web mode turned off is a deploy switch, not an access loss. The deploy steps end
			// live browsers first, so only a lost permission closes the session here.
			if (authorized._nay.message !== "Browser unavailable") {
				await ctx.runAction(internal.files_browser.end_browser_session_internal, {
					sessionId: args.session._id,
					reason: "access_lost",
				});
			}
			return { ok: false, message: authorized._nay.message };
		}
		return { ok: true };
	}

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
		await ctx.runAction(internal.files_browser.end_browser_session_internal, {
			sessionId: args.session._id,
			reason: "access_lost",
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

		const source = await authorize_live_browser_session(ctx, {
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
				mode: loaded._yay.mode,
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

		const viewerBaseUrl = files_browser_runner_viewer_url();
		const viewerUrl = viewerBaseUrl ? `${viewerBaseUrl}?mode=${loaded._yay.mode}` : null;
		if (!viewerUrl) {
			return Result({ _nay: { message: "Browser unavailable" } });
		}

		const source = await authorize_live_browser_session(ctx, {
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
				mode: loaded._yay.mode,
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
		_yay: v.object({
			grantedUntil: v.number(),
			control: v.string(),
			controlGen: v.number(),
			// The web session's agent access, so every viewer follows a switch. Null for a file session.
			agentAccess: v.union(v.boolean(), v.null()),
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
		if (!loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_session(ctx, {
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
				mode: loaded._yay.mode,
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
				agentAccess: updated._yay.mode === "web" ? updated._yay.agentAccess : null,
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

		const source = await authorize_live_browser_session(ctx, {
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
				mode: loaded._yay.mode,
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
 * End human control for this browser. The runner checks the paused control generation.
 */
export const resume_browser_agent = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		controlGen: v.number(),
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
		if (loaded._yay.controlGen !== args.controlGen)
			return Result({ _nay: { name: "stale", message: "Browser control changed" } });

		const source = await authorize_live_browser_session(ctx, {
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
				mode: loaded._yay.mode,
				controlGen: args.controlGen,
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

function browser_preferences_public(preference: Awaited<ReturnType<typeof files_browser_db_get_preferences>>) {
	return {
		policyRevision: preference.policyRevision,
		webAgentAccess: preference.webAgentAccess,
		agentBlockedHosts: preference.agentBlockedHosts,
		syncPending: preference.syncPending,
	};
}

export const current_browser_preferences = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(browser_preferences_public_validator, v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
		if (!user || user.deletedAt !== undefined) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		return browser_preferences_public(await files_browser_db_get_preferences(ctx, membership));
	},
});

export const change_browser_preferences = internalMutation({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		change: v.union(
			v.object({ kind: v.literal("access"), enabled: v.boolean() }),
			v.object({ kind: v.literal("hosts"), hosts: v.array(v.string()) }),
			v.object({ kind: v.literal("end") }),
		),
	},
	returns: v_result({ _yay: doc(app_convex_schema, "files_browser_preferences") }),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, args);
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const permission = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: "workspace.browser.use",
		});
		if (permission._nay) return permission;
		const current = await files_browser_db_get_preferences(ctx, membership);
		const { change } = args;
		let hosts = current.agentBlockedHosts;
		if (change.kind === "hosts") {
			if (change.hosts.length > BROWSER_PROFILE_BLOCKED_HOSTS_MAX)
				return Result({ _nay: { message: "Too many sites" } });
			const canonical = change.hosts.map(browser_site_host);
			if (canonical.some((host) => !host)) return Result({ _nay: { message: "Invalid site" } });
			hosts = [...new Set(canonical as string[])].sort();
		}
		const changed =
			change.kind === "end" ||
			(change.kind === "access" && change.enabled !== current.webAgentAccess) ||
			(change.kind === "hosts" && JSON.stringify(hosts) !== JSON.stringify(current.agentBlockedHosts));
		const next = {
			ownerId: args.userId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			webAgentAccess: change.kind === "access" ? change.enabled : current.webAgentAccess,
			policyRevision: current.policyRevision + (changed ? 1 : 0),
			agentBlockedHosts: hosts,
			syncPending: changed || current.syncPending,
			updatedAt: Date.now(),
		};
		const preferenceId = "_id" in current ? current._id : await ctx.db.insert("files_browser_preferences", next);
		if ("_id" in current) await ctx.db.patch("files_browser_preferences", preferenceId, next);
		return Result({ _yay: (await ctx.db.get("files_browser_preferences", preferenceId))! });
	},
});

type change_browser_preferences_Result =
	typeof change_browser_preferences extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const finish_browser_preferences_sync = internalMutation({
	args: { preferenceId: v.id("files_browser_preferences"), policyRevision: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const preference = await ctx.db.get("files_browser_preferences", args.preferenceId);
		if (!preference || preference.policyRevision !== args.policyRevision) return false;
		await ctx.db.patch("files_browser_preferences", preference._id, { syncPending: false });
		return true;
	},
});

export const load_browser_preferences_doc = internalQuery({
	args: { preferenceId: v.id("files_browser_preferences") },
	returns: v.union(doc(app_convex_schema, "files_browser_preferences"), v.null()),
	handler: async (ctx, args) => ctx.db.get("files_browser_preferences", args.preferenceId),
});

export const sync_browser_preferences_for_member = internalAction({
	args: { preferenceId: v.id("files_browser_preferences"), membershipId: v.id("organizations_workspaces_users") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args): Promise<BrowserActionResult<null>> => {
		const preference = await ctx.runQuery(internal.files_browser.load_browser_preferences_doc, {
			preferenceId: args.preferenceId,
		});
		if (!preference?.syncPending) return Result({ _yay: null });
		const synced = await sync_browser_preferences({ ctx, preference, membershipId: args.membershipId });
		if (synced._nay) {
			console.warn("Browser policy sync failed; the cron will retry", {
				preferenceId: preference._id,
				reason: synced._nay.name ?? "sync_failed",
			});
		}
		return synced;
	},
});

export const retry_browser_preferences_sync = internalMutation({
	args: { cursor: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const pending = await ctx.db
			.query("files_browser_preferences")
			.withIndex("by_syncPending_updatedAt", (q) => q.eq("syncPending", true).lte("updatedAt", Date.now() - 30_000))
			.paginate({ cursor: args.cursor ?? null, numItems: 50 });
		const memberships = await Promise.all(
			pending.page.map((preference) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) =>
						q
							.eq("userId", preference.ownerId)
							.eq("organizationId", preference.organizationId)
							.eq("workspaceId", preference.workspaceId)
							.eq("active", true),
					)
					.first(),
			),
		);
		for (let index = 0; index < pending.page.length; index++) {
			const membership = memberships[index];
			if (membership)
				await ctx.scheduler.runAfter(0, internal.files_browser.sync_browser_preferences_for_member, {
					preferenceId: pending.page[index]!._id,
					membershipId: membership._id,
				});
		}
		if (!pending.isDone)
			await ctx.scheduler.runAfter(0, internal.files_browser.retry_browser_preferences_sync, {
				cursor: pending.continueCursor,
			});
		return null;
	},
});

async function sync_browser_preferences(args: {
	ctx: ActionCtx;
	preference: Doc<"files_browser_preferences">;
	membershipId: Id<"organizations_workspaces_users">;
}): Promise<BrowserActionResult<null>> {
	const { ctx, preference, membershipId } = args;

	const cloud = (await ctx.runQuery(internal.files_browser.load_browser_session, {
		userId: preference.ownerId,
		organizationId: preference.organizationId,
		workspaceId: preference.workspaceId,
		membershipId,
		mode: "web",
	})) as load_browser_session_Result;
	if (cloud._yay?.runnerSessionId) {
		const synced = await files_browser_runner_call({
			route: "agent-access",
			body: {
				mode: "web",
				sessionId: cloud._yay.runnerSessionId,
				ownerId: preference.ownerId,
				organizationId: preference.organizationId,
				workspaceId: preference.workspaceId,
				on: preference.webAgentAccess,
				agentBlockedHosts: preference.agentBlockedHosts,
				policyRevision: preference.policyRevision,
			},
		});
		if (synced._nay) return synced;
		const parsed = files_browser_runner_open_schema.safeParse(synced._yay);
		if (
			!parsed.success ||
			parsed.data.session.mode !== "web" ||
			parsed.data.session.policyRevision !== preference.policyRevision
		)
			return Result({ _nay: { message: "Browser policy update failed" } });
		const updated = (await ctx.runMutation(internal.files_browser.sync_browser_session, {
			sessionId: cloud._yay._id,
			runner: parsed.data.session,
		})) as files_browser_sync_browser_session_Result;
		if (updated._nay) return updated;
	}
	const remote = await ctx.runAction(internal.playwriter_browser.sync_policy, {
		ownerId: preference.ownerId,
		organizationId: preference.organizationId,
		workspaceId: preference.workspaceId,
		webAgentAccess: preference.webAgentAccess,
		agentBlockedHosts: preference.agentBlockedHosts,
		policyRevision: preference.policyRevision,
	});
	if (remote._nay) return remote;
	const committed = await ctx.runMutation(internal.files_browser.finish_browser_preferences_sync, {
		preferenceId: preference._id,
		policyRevision: preference.policyRevision,
	});
	return committed ? Result({ _yay: null }) : Result({ _nay: { message: "Browser policy changed again" } });
}

async function change_browser_preferences_from_user(args: {
	ctx: ActionCtx;
	membershipId: Id<"organizations_workspaces_users">;
	change: FunctionArgs<typeof internal.files_browser.change_browser_preferences>["change"];
}): Promise<BrowserActionResult<Infer<typeof browser_preferences_public_validator>>> {
	const { ctx, membershipId, change } = args;

	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
	if (!user || user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthenticated" } });
	const changed = (await ctx.runMutation(internal.files_browser.change_browser_preferences, {
		userId: user._id,
		membershipId,
		change,
	})) as change_browser_preferences_Result;
	if (changed._nay) return changed;
	if (!changed._yay.syncPending) return Result({ _yay: browser_preferences_public(changed._yay) });
	const synced = await sync_browser_preferences({ ctx, preference: changed._yay, membershipId });
	if (synced._nay) {
		await ctx.scheduler.runAfter(30_000, internal.files_browser.sync_browser_preferences_for_member, {
			preferenceId: changed._yay._id,
			membershipId,
		});
		return synced;
	}
	return Result({ _yay: { ...browser_preferences_public(changed._yay), syncPending: false } });
}

export const set_browser_agent_access = action({
	args: { membershipId: v.id("organizations_workspaces_users"), enabled: v.boolean() },
	returns: v_result({ _yay: browser_preferences_public_validator }),
	handler: async (ctx, args): Promise<BrowserActionResult<Infer<typeof browser_preferences_public_validator>>> =>
		change_browser_preferences_from_user({
			ctx,
			membershipId: args.membershipId,
			change: { kind: "access", enabled: args.enabled },
		}),
});

export const set_agent_blocked_hosts = action({
	args: { membershipId: v.id("organizations_workspaces_users"), hosts: v.array(v.string()) },
	returns: v_result({ _yay: browser_preferences_public_validator }),
	handler: async (ctx, args): Promise<BrowserActionResult<Infer<typeof browser_preferences_public_validator>>> =>
		change_browser_preferences_from_user({
			ctx,
			membershipId: args.membershipId,
			change: { kind: "hosts", hosts: args.hosts },
		}),
});

/**
 * Whether this member can start a web browser here. `enabled` is web mode on plus the
 * `workspace.browser.use` permission. `paidPlan` is the payer's plan: the organization owner in an
 * owner-billed organization, else the member.
 */
export const web_browser_available = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.object({ enabled: v.boolean(), paidPlan: v.boolean() }),
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
			return { enabled: false, paidPlan: false };
		}

		const authorized = await browser_db_authorize_web_use(ctx, { userId: user._id, membership });
		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			return { enabled: false, paidPlan: false };
		}
		const billedUserId = billing_pick_billed_user_id({ userId: user._id, organization });
		const { hasPaidPlan } = await billing_db_check_paid_plan(ctx, { userId: billedUserId });
		return { enabled: !authorized._nay && userAuth?.kind !== "anonymous", paidPlan: hasPaidPlan };
	},
});

/**
 * The owner's live browser session for this workspace, if any. Safe metadata only: the runner
 * session id never leaves the server.
 */
export const current_browser_session = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		mode: v.union(v.literal("file"), v.literal("web")),
	},
	returns: v.union(browser_file_session_public_validator, browser_web_session_public_validator, v.null()),
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
				q.and(
					q.eq(q.field("mode"), args.mode),
					q.or(
						q.eq(q.field("control"), "starting"),
						q.eq(q.field("control"), "ready"),
						q.eq(q.field("control"), "human"),
						q.eq(q.field("control"), "pausing"),
					),
				),
			)
			.first();
		if (!session) {
			return null;
		}
		// Hide sessions the owner can no longer use. The next viewer door closes the session
		// itself; a query cannot do that.
		if (session.mode === "web") {
			const authorized = await browser_db_authorize_web_use(ctx, { userId: user._id, membership });
			if (authorized._nay) {
				return null;
			}
			return web_session_public_meta(session);
		}
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
		// The stored path is the path at Start. Return the live one, so a renamed file shows its new name.
		return { ...file_session_public_meta(session), path };
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
	expectedSource: v.union(
		v.object({
			mode: v.literal("file"),
			targetKind: v.union(v.literal("saved"), v.literal("private")),
			nodeId: v.string(),
			sourceKind: v.union(v.literal("saved"), v.literal("proposed"), v.literal("draft")),
			sourceVersion: v.string(),
			sourceHash: v.string(),
		}),
		v.object({ mode: v.literal("web") }),
	),
});

/**
 * Refuse a capture whose page is no longer the one the agent ran against, or whose HTML source the
 * user can no longer read. Both checks run again at finalize, because the upload happens in between.
 *
 * A web page has no source file. There the owner must still have the web browser permission and
 * must not have turned agent access off.
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
		(session.mode === "file"
			? session.navigationGeneration !== args.expectedAgentLease.navGen
			: !session.tabs.some(
					(tab) =>
						tab.tabId === args.expectedAgentLease.tabId &&
						tab.tabGen === args.expectedAgentLease.tabGen &&
						tab.navGen === args.expectedAgentLease.navGen,
				)) ||
		session.mode !== args.expectedSource.mode
	)
		return Result({ _nay: { message: "Browser session changed. Run the capture again." } });

	if (session.mode === "web") {
		const preference = await files_browser_db_get_preferences(ctx, {
			userId: args.userId,
			organizationId: session.organizationId,
			workspaceId: session.workspaceId,
		});
		if (
			!preference.webAgentAccess ||
			preference.syncPending ||
			preference.policyRevision !== args.expectedAgentLease.policyRevision
		)
			return Result({ _nay: { message: "Browser session changed. Run the capture again." } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.agentSource.membershipId,
		});
		if (
			!membership ||
			membership.organizationId !== session.organizationId ||
			membership.workspaceId !== session.workspaceId
		)
			return Result({ _nay: { message: "Unauthorized" } });
		const authorized = await browser_db_authorize_web_use(ctx, { userId: args.userId, membership });
		if (authorized._nay) return authorized;
		if (!session.agentAccess) return Result({ _nay: { message: "Browser session changed. Run the capture again." } });
		return Result({ _yay: null });
	}

	if (
		args.expectedSource.mode !== "file" ||
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

// #region saved browser profiles
// Web sessions keep the owner's logins in one saved profile per user and workspace, shared with
// that user's agent chats. The runner stores the cookies encrypted. Convex holds only the key half
// in `files_browser_profiles` and never sees cookie values or site names.

/**
 * The canonical form of one site host, or null when it is not a plain host name. It accepts what a
 * person types for a site (`Bank.example.`, `bücher.de`), never a URL, port, or path. `new URL`
 * turns Unicode into punycode, the same way the runner compares hosts.
 */
function browser_site_host(raw: string) {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed.length > 253 || /[\s/\\?#@:[\]%]/u.test(trimmed)) {
		return null;
	}
	let hostname: string;
	try {
		hostname = new URL(`https://${trimmed}`).hostname;
	} catch {
		return null;
	}
	const host = browser_web_canonical_host(hostname);
	// Dot-separated labels of letters, digits, and inner hyphens. IPv4 addresses pass too.
	if (
		host.length > 253 ||
		!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(host)
	) {
		return null;
	}
	return host;
}

/**
 * The runner takes the 32-byte profile key as base64. Only runner calls use this form.
 */
function browser_profile_key_base64(profileKey: ArrayBuffer) {
	return btoa(String.fromCharCode(...new Uint8Array(profileKey)));
}

/**
 * Delete one saved profile. Without its key half nobody can open the saved cookies again, so they
 * are gone from this moment. The wipe doc, written in the same transaction, makes the wipe job ask
 * the runner to delete the bytes too. Callers schedule `process_browser_profile_wipes` so that
 * job runs at once instead of at its next cron run.
 */
export async function files_browser_db_delete_profile(ctx: MutationCtx, profile: Doc<"files_browser_profiles">) {
	const now = Date.now();
	await ctx.db.delete("files_browser_profiles", profile._id);
	await ctx.db.insert("files_browser_profile_wipes", {
		profileId: profile._id,
		ownerId: profile.userId,
		organizationId: profile.organizationId,
		workspaceId: profile.workspaceId,
		createdAt: now,
		attempts: 0,
		nextAttemptAt: now,
	});
}

/**
 * Account deletion, at the request: close the user's live browsers without saving, and delete every
 * saved profile of the user in bounded batches. Recovering the account does not bring the logins
 * back; the user signs in to those sites again.
 */
export async function files_browser_db_schedule_user_deletion(ctx: MutationCtx, args: { userId: Id<"users"> }) {
	await disconnect_user_connections(ctx, args);
	// Every live session is still unbilled, and the runner allows only ten live browsers per
	// deployment, so this read stays small.
	const liveSessions = await ctx.db
		.query("files_browser_sessions")
		.withIndex("by_billing_state_updatedAt", (q) => q.eq("billing.state", "pending"))
		.filter((q) =>
			q.and(
				q.eq(q.field("ownerId"), args.userId),
				q.or(
					q.eq(q.field("control"), "starting"),
					q.eq(q.field("control"), "ready"),
					q.eq(q.field("control"), "human"),
					q.eq(q.field("control"), "pausing"),
				),
			),
		)
		.take(BROWSER_SETTLE_BATCH_SIZE);
	for (const session of liveSessions) {
		await ctx.scheduler.runAfter(0, internal.files_browser.end_browser_session_internal, {
			sessionId: session._id,
			reason: "account_deleted",
		});
	}
	await ctx.scheduler.runAfter(0, internal.files_browser.delete_user_profiles_batch, { userId: args.userId });
}

async function disconnect_user_connections(ctx: MutationCtx, args: { userId: Id<"users"> }) {
	const connections = await ctx.db
		.query("playwriter_connections")
		.withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
		.filter((q) => q.or(q.neq(q.field("encryptedShareId"), null), q.eq(q.field("active"), true)))
		.take(BROWSER_PROFILE_DELETE_BATCH_SIZE);
	for (const connection of connections)
		await playwriter_browser_db_disconnect({ ctx, connection, reason: "account_deleted" });
	if (connections.length === BROWSER_PROFILE_DELETE_BATCH_SIZE)
		await ctx.scheduler.runAfter(0, internal.files_browser.disconnect_user_browser_connections, args);
}

export const disconnect_user_browser_connections = internalMutation({
	args: { userId: v.id("users") },
	returns: v.null(),
	handler: async (ctx, args) => {
		await disconnect_user_connections(ctx, args);
		return null;
	},
});

/**
 * Delete one batch of a user's saved profiles and continue until none is left.
 */
export const delete_user_profiles_batch = internalMutation({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const profiles = await ctx.db
			.query("files_browser_profiles")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.take(BROWSER_PROFILE_DELETE_BATCH_SIZE);
		for (const profile of profiles) {
			await files_browser_db_delete_profile(ctx, profile);
		}
		if (profiles.length > 0) {
			await ctx.scheduler.runAfter(0, internal.files_browser.process_browser_profile_wipes, {});
		}
		if (profiles.length === BROWSER_PROFILE_DELETE_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.files_browser.delete_user_profiles_batch, args);
		}
		return null;
	},
});

/**
 * The owner's saved profile in one workspace, with its key, for the profile doors. The caller has
 * already checked the membership.
 */
export const get_browser_profile = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v.union(
		v.object({
			profileId: v.id("files_browser_profiles"),
			profileKey: v.bytes(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const profile = await ctx.db
			.query("files_browser_profiles")
			.withIndex("by_organization_workspace_user", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
			)
			.first();
		return profile ? { profileId: profile._id, profileKey: profile.profileKey } : null;
	},
});

type get_browser_profile_Result =
	typeof get_browser_profile extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * End the caller's live browser in this workspace without saving its profile. The runner refuses
 * profile reads and changes while a session is live there.
 */
async function end_live_browser_for_profile(
	ctx: ActionCtx,
	args: { userId: Id<"users">; membership: Doc<"organizations_workspaces_users">; reason: string },
) {
	const live = (await ctx.runQuery(internal.files_browser.load_browser_session, {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		userId: args.userId,
		membershipId: args.membership._id,
		mode: "web",
	})) as load_browser_session_Result;
	if (live._yay) {
		await ctx.runAction(internal.files_browser.end_browser_session_internal, {
			sessionId: live._yay._id,
			reason: args.reason,
		});
	}
}

/**
 * The caller's saved profile in this workspace, without its key. `exists` is true once a web start
 * or a blocked-sites change created the profile; logins may be saved in it. Null when the
 * membership is not the caller's.
 */
export const current_browser_profile = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.union(
		v.object({
			exists: v.boolean(),
			lastUsedAt: v.union(v.number(), v.null()),
			agentBlockedHosts: v.array(v.string()),
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

		const profile = await ctx.db
			.query("files_browser_profiles")
			.withIndex("by_organization_workspace_user", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", user._id),
			)
			.first();
		const preference = await files_browser_db_get_preferences(ctx, membership);
		return {
			exists: profile !== null,
			lastUsedAt: profile?.lastUsedAt ?? null,
			agentBlockedHosts: preference.agentBlockedHosts,
		};
	},
});

/**
 * The saved sites of the caller's profile: cookie domains with a count, never cookie values. The
 * runner reads them only while no session is live, so this ends the caller's live browser first,
 * without saving.
 */
export const list_browser_profile_sites = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v_result({
		_yay: v.object({
			exists: v.boolean(),
			savedAt: v.union(v.number(), v.null()),
			truncated: v.boolean(),
			sites: v.array(v.object({ domain: v.string(), cookies: v.number() })),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		// Anonymous users never start a web browser, so they have no saved profile.
		if (!user || userAuth?.kind === "anonymous") {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const userId = user._id;

		const profile = (await ctx.runQuery(internal.files_browser.get_browser_profile, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId,
		})) as get_browser_profile_Result;
		if (!profile) {
			return Result({ _yay: { exists: false, savedAt: null, truncated: false, sites: [] } });
		}

		await end_live_browser_for_profile(ctx, { userId, membership, reason: "profile_listed" });

		const summary = await files_browser_runner_call({
			route: "profile-summary",
			body: {
				mode: "web",
				ownerId: userId,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				profileId: profile.profileId,
				profileKey: browser_profile_key_base64(profile.profileKey),
			},
		});
		if (summary._nay?.name === "profile_unreadable") {
			return Result({ _nay: { name: "profile_unreadable", message: BROWSER_PROFILE_UNREADABLE_MESSAGE } });
		}
		if (summary._nay) {
			return summary;
		}
		const parsed = files_browser_runner_profile_summary_schema.safeParse(summary._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		return Result({
			_yay: {
				exists: parsed.data.exists,
				savedAt: parsed.data.savedAt,
				truncated: parsed.data.truncated,
				sites: parsed.data.sites,
			},
		});
	},
});

/**
 * Remove the saved cookies of one site from the caller's profile: cookies of `domain` and of every
 * host under it. Ends the caller's live browser first, without saving.
 */
export const clear_browser_profile_site = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		domain: v.string(),
	},
	returns: v_result({ _yay: v.object({ removed: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		// Anonymous users never start a web browser, so they have no saved profile.
		if (!user || userAuth?.kind === "anonymous") {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const userId = user._id;

		const domain = browser_site_host(args.domain);
		if (!domain) {
			return Result({ _nay: { message: "Invalid site" } });
		}

		const profile = (await ctx.runQuery(internal.files_browser.get_browser_profile, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId,
		})) as get_browser_profile_Result;
		if (!profile) {
			return Result({ _yay: { removed: 0 } });
		}

		await end_live_browser_for_profile(ctx, { userId, membership, reason: "profile_site_cleared" });

		const cleared = await files_browser_runner_call({
			route: "profile-clear",
			body: {
				mode: "web",
				ownerId: userId,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				profileId: profile.profileId,
				profileKey: browser_profile_key_base64(profile.profileKey),
				domain,
			},
		});
		if (cleared._nay?.name === "profile_unreadable") {
			return Result({ _nay: { name: "profile_unreadable", message: BROWSER_PROFILE_UNREADABLE_MESSAGE } });
		}
		// A `busy` refusal also comes when the stored cookies changed during the clear. Try again then.
		if (cleared._nay) {
			return cleared;
		}
		const parsed = files_browser_runner_profile_clear_schema.safeParse(cleared._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}
		return Result({ _yay: { removed: parsed.data.removed } });
	},
});

/**
 * Delete the caller's profile doc for Clear all, with its wipe doc in the same transaction.
 */
export const delete_browser_profile = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const profile = await ctx.db
			.query("files_browser_profiles")
			.withIndex("by_organization_workspace_user", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
			)
			.first();
		if (profile) {
			await files_browser_db_delete_profile(ctx, profile);
			await ctx.scheduler.runAfter(0, internal.files_browser.process_browser_profile_wipes, {});
		}
		return null;
	},
});

/**
 * Clear all saved data of the caller in this workspace: every saved login and the sites the
 * agent may not use. Ends the caller's live browser first, without saving. The next web start
 * creates a new profile with a new key.
 *
 * This works without the browser permission and while web mode is off: a user may always delete
 * their own data. The runner wipe then retries until the runner is back.
 */
export const clear_browser_profile = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		// Anonymous users never start a web browser, so they have no saved profile.
		if (!user || userAuth?.kind === "anonymous") {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== user._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const userId = user._id;

		const profile = (await ctx.runQuery(internal.files_browser.get_browser_profile, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId,
		})) as get_browser_profile_Result;
		if (!profile) {
			return Result({ _yay: null });
		}

		await end_live_browser_for_profile(ctx, { userId, membership, reason: "profile_cleared" });
		await ctx.runMutation(internal.files_browser.delete_browser_profile, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId,
		});
		return Result({ _yay: null });
	},
});

/**
 * Wipe docs whose next attempt is due, oldest first.
 */
export const list_due_browser_profile_wipes = internalQuery({
	args: {},
	returns: v.array(doc(app_convex_schema, "files_browser_profile_wipes")),
	handler: async (ctx) => {
		return await ctx.db
			.query("files_browser_profile_wipes")
			.withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", Date.now()))
			.take(BROWSER_PROFILE_WIPE_BATCH_SIZE);
	},
});

type list_due_browser_profile_wipes_Result =
	typeof list_due_browser_profile_wipes extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Record one runner wipe result. Success deletes the wipe doc. Failure moves the next attempt out:
 * 1 minute after the first failure, doubling each time, at most 6 hours. There is no attempt
 * limit, so the bytes are deleted as soon as the runner answers again.
 */
export const finish_browser_profile_wipe = internalMutation({
	args: {
		wipeId: v.id("files_browser_profile_wipes"),
		attempts: v.number(),
		deleted: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const wipe = await ctx.db.get("files_browser_profile_wipes", args.wipeId);
		// Another run of the wipe job already recorded this attempt.
		if (!wipe || wipe.attempts !== args.attempts) {
			return null;
		}
		if (args.deleted) {
			await ctx.db.delete("files_browser_profile_wipes", wipe._id);
			return null;
		}

		const attempts = wipe.attempts + 1;
		const delay = Math.min(BROWSER_PROFILE_WIPE_RETRY_MIN_MS * 2 ** (attempts - 1), BROWSER_PROFILE_WIPE_RETRY_MAX_MS);
		await ctx.db.patch("files_browser_profile_wipes", wipe._id, { attempts, nextAttemptAt: Date.now() + delay });
		// Log the count only. Ids here belong to the deleted profile's owner.
		console.warn("browser_profile_wipe_failed", { attempts });
		return null;
	},
});

/**
 * Wipe job: ask the runner to delete the stored bytes of deleted profiles. It runs right after each
 * deletion and every 5 minutes from the cron.
 */
export const process_browser_profile_wipes = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const wipes = (await ctx.runQuery(
			internal.files_browser.list_due_browser_profile_wipes,
			{},
		)) as list_due_browser_profile_wipes_Result;

		await Promise.all(
			wipes.map(async (wipe) => {
				const deleted = await files_browser_runner_call({
					route: "profile-delete",
					body: {
						mode: "web",
						ownerId: wipe.ownerId,
						organizationId: wipe.organizationId,
						workspaceId: wipe.workspaceId,
						profileId: wipe.profileId,
					},
				});
				const parsed = deleted._nay ? null : files_browser_runner_profile_delete_schema.safeParse(deleted._yay);
				await ctx.runMutation(internal.files_browser.finish_browser_profile_wipe, {
					wipeId: wipe._id,
					attempts: wipe.attempts,
					deleted: parsed?.success === true,
				});
			}),
		);

		// A full batch may leave more due wipes. Failed ones moved to a later time, so this ends.
		if (wipes.length === BROWSER_PROFILE_WIPE_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.files_browser.process_browser_profile_wipes, {});
		}
		return null;
	},
});
// #endregion saved browser profiles

// #region browser downloads and uploads
// Human downloads in a web session are saved to `/.system/downloads/` in Files. The runner holds
// the bytes for 2 minutes; Convex creates an upload node and a signed PUT URL, and the runner
// uploads the bytes there. The normal R2 finalizer then publishes the file.
//
// A page file chooser can get files from Files (signed GET URLs the runner downloads) or one
// computer file (a single-use grant the app PUTs to). Both need human control; the runner checks it.

function browser_download_refusal(nay: { message: string; name?: string }) {
	if (nay.name === "download_gone") {
		return Result({ _nay: { name: nay.name, message: "Download not saved: it is no longer available." } });
	}
	if (nay.name === "download_push_failed") {
		return Result({ _nay: { name: nay.name, message: "Download not saved: the upload failed." } });
	}
	return Result({ _nay: nay });
}

export const get_browser_download_save = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		sessionId: v.id("files_browser_sessions"),
		downloadId: v.string(),
	},
	returns: v.union(
		v.object({ nodeId: v.id("files_nodes"), path: v.string(), shared: v.boolean(), pushed: v.boolean() }),
		v.null(),
	),
	handler: async (ctx, args) => {
		const saved = await ctx.db
			.query("files_browser_download_saves")
			.withIndex("by_session_download", (q) => q.eq("sessionId", args.sessionId).eq("downloadId", args.downloadId))
			.first();
		if (!saved) {
			return null;
		}

		// Emptying the trash can delete the saved node for good. Then there is nothing to return.
		const node = await ctx.db.get("files_nodes", saved.nodeId);
		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!node || !organization) {
			return null;
		}
		return { nodeId: node._id, path: node.path, shared: !organization.default, pushed: saved.pushedAt !== null };
	},
});

type get_browser_download_save_Result =
	typeof get_browser_download_save extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Sign the R2 PUT URL the runner uploads one download to. Keep the URL end time on the asset, so
 * cleanup can remove a late PUT, like `create_upload_node`.
 */
async function browser_db_sign_download_push(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetId: Id<"files_r2_assets">;
		contentType: string | null;
	},
) {
	await ctx.db.patch("files_r2_assets", args.assetId, {
		uploadUrlExpiresAt: Date.now() + files_UPLOAD_URL_TTL_MS,
	});
	const signedUpload = await r2.generateUploadUrl(
		r2_create_asset_key({ organizationId: args.organizationId, workspaceId: args.workspaceId, assetId: args.assetId }),
		{ createOnly: true, expiresIn: files_UPLOAD_URL_TTL_MS / 1000 },
	);
	return {
		url: signedUpload.url,
		headers: { ...(args.contentType ? { "Content-Type": args.contentType } : {}), "If-None-Match": "*" },
	};
}

/**
 * Create the upload node for one human download, like `create_upload_node` does for a normal
 * upload: the same rate limit and the same paid-plan gate. It never replaces a file: a taken name
 * gets `-2`, `-3`, and so on. It records the save in the same transaction, so a second save of
 * the same download returns this node. `kind: "push"` means the runner must upload the bytes to
 * the returned URL.
 */
export const create_browser_download_node = internalMutation({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		downloadId: v.string(),
		name: v.string(),
		contentType: v.string(),
		size: v.number(),
		origin: v.union(v.string(), v.null()),
	},
	returns: v_result({
		_yay: v.union(
			v.object({ kind: v.literal("saved"), nodeId: v.id("files_nodes"), path: v.string(), shared: v.boolean() }),
			v.object({
				kind: v.literal("push"),
				nodeId: v.id("files_nodes"),
				path: v.string(),
				shared: v.boolean(),
				url: v.string(),
				headers: v.record(v.string(), v.string()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const session = await ctx.db.get("files_browser_sessions", args.sessionId);
		if (
			!session ||
			session.mode !== "web" ||
			session.ownerId !== args.userId ||
			session.organizationId !== membership.organizationId ||
			session.workspaceId !== membership.workspaceId ||
			!live_session_control(session.control)
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "membership.organizationId points to a missing organizations doc";
			const errorData = { membershipId: membership._id, organizationId: membership.organizationId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const shared = !organization.default;

		// Two viewer tabs of the owner can both save the same download, and a failed push can be
		// saved again. A pushed save only returns its node.
		const saved = await ctx.db
			.query("files_browser_download_saves")
			.withIndex("by_session_download", (q) => q.eq("sessionId", args.sessionId).eq("downloadId", args.downloadId))
			.first();
		if (saved) {
			const node = await ctx.db.get("files_nodes", saved.nodeId);
			if (!node) {
				return Result({ _nay: { message: "Download not saved: it was deleted." } });
			}
			if (saved.pushedAt !== null) {
				return Result({ _yay: { kind: "saved" as const, nodeId: node._id, path: node.path, shared } });
			}

			// No push worked yet, or one is still running in another tab. Sign a new URL for the same
			// asset. The runner joins a running push, and R2 keeps the first upload of the asset.
			const signed = await browser_db_sign_download_push(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				// The download node was created with its upload asset, below.
				assetId: node.assetId!,
				contentType: node.contentType,
			});
			return Result({ _yay: { kind: "push" as const, nodeId: node._id, path: node.path, shared, ...signed } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: args.userId });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const admission = await files_stored_uploads_db_admit(ctx, {
			organization,
			actorUserId: args.userId,
			workspaceId: membership.workspaceId,
			declaredBytes: [args.size],
		});
		if (admission._nay) return admission;

		// A web server picks the type. A broken type falls back to the name, then to plain bytes,
		// so a bad header does not lose the download.
		const name = files_normalize_browser_download_name(args.name);
		const contentType =
			files_normalize_content_type(args.contentType) ??
			files_guess_content_type_from_name(name) ??
			"application/octet-stream";

		// Never replace a file: find the first free name among saved files.
		const basePath = `${BROWSER_DOWNLOADS_FOLDER_PATH}/${name}`;
		const dot = basePath.lastIndexOf(".");
		const extensionStart = dot > basePath.lastIndexOf("/") + 1 ? dot : basePath.length;
		let path: string | null = null;
		for (let suffix = 0; suffix < 100; suffix++) {
			const candidate =
				suffix === 0 ? basePath : `${basePath.slice(0, extensionStart)}-${suffix + 1}${basePath.slice(extensionStart)}`;
			const occupant = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("path", candidate)
						.eq("archiveOperationId", null),
				)
				.first();
			if (!occupant) {
				path = candidate;
				break;
			}
		}
		if (!path) {
			return Result({ _nay: { message: "Download not saved: no free file name was found." } });
		}

		// Keep only the origin. A full page URL can hold private query values, and metadata is
		// visible to every reader of the file. The runner sends an origin already; this re-checks
		// its reply.
		let origin: string | null = null;
		if (args.origin !== null) {
			try {
				const url = new URL(args.origin);
				origin = url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
			} catch {
				origin = null;
			}
		}

		const now = Date.now();
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			kind: "upload",
			r2Bucket: r2.config.bucket,
			size: args.size,
			createdBy: args.userId,
			unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
			updatedAt: now,
		});

		// This creates `/.system/downloads/` too when it is missing. It checks the write permission
		// and folder locks before it inserts anything.
		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: args.userId,
			parentId: files_ROOT_ID,
			path: path.slice(1),
			kind: "file",
			contentType,
			assetId,
			// The R2 event publish stamps the real size and media type.
			metadata: [
				{ key: "source", value: "browser-download" },
				...(origin ? [{ key: "original-url", value: origin }] : []),
			],
			now,
		});
		if (created._nay) {
			// A normal return commits every write, so remove the asset doc written above.
			await ctx.db.delete("files_r2_assets", assetId);
			if (created._nay.message === "Permission denied") {
				return Result({ _nay: { message: "Download not saved: you cannot add files to .system/downloads." } });
			}
			return Result({ _nay: { message: `Download not saved: ${created._nay.message}` } });
		}

		await ctx.db.insert("files_browser_download_saves", {
			sessionId: args.sessionId,
			downloadId: args.downloadId,
			nodeId: created._yay,
			createdAt: now,
			pushedAt: null,
		});

		const signed = await browser_db_sign_download_push(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId,
			contentType,
		});
		return Result({ _yay: { kind: "push" as const, nodeId: created._yay, path, shared, ...signed } });
	},
});

/**
 * Record that the runner uploaded the bytes of one saved download. Later saves then only return
 * the file.
 */
export const mark_browser_download_pushed = internalMutation({
	args: {
		sessionId: v.id("files_browser_sessions"),
		downloadId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const saved = await ctx.db
			.query("files_browser_download_saves")
			.withIndex("by_session_download", (q) => q.eq("sessionId", args.sessionId).eq("downloadId", args.downloadId))
			.first();
		// A workspace purge or an account deletion can delete the session and its saves during the push.
		if (saved && saved.pushedAt === null) {
			await ctx.db.patch("files_browser_download_saves", saved._id, { pushedAt: Date.now() });
		}
		return null;
	},
});

type create_browser_download_node_Result =
	typeof create_browser_download_node extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Save one human download of the owner's live web browser to `/.system/downloads/`. The app calls
 * this as soon as the viewer says a download is ready. Saving the same download again returns the
 * saved file and does not upload it again. After a failed upload, saving again retries it while the
 * runner still holds the bytes.
 */
export const save_browser_download = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		downloadId: v.string(),
	},
	returns: v_result({
		_yay: v.object({ nodeId: v.id("files_nodes"), path: v.string(), shared: v.boolean() }),
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
		if (loaded._yay.mode !== "web" || !loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_session(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		// Check before asking the runner: it forgets a download once it is pushed.
		const saved = (await ctx.runQuery(internal.files_browser.get_browser_download_save, {
			organizationId: membership.organizationId,
			sessionId: args.sessionId,
			downloadId: args.downloadId,
		})) as get_browser_download_save_Result;
		if (saved?.pushed) {
			return Result({ _yay: { nodeId: saved.nodeId, path: saved.path, shared: saved.shared } });
		}

		const runnerBody = {
			sessionId: loaded._yay.runnerSessionId,
			ownerId: user._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			downloadId: args.downloadId,
		};
		const info = await files_browser_runner_call({ route: "download-info", body: runnerBody });
		if (info._nay) {
			// Another viewer tab may have pushed this download after the check above, so the runner
			// forgot it. Then that tab's saved file is the answer.
			if (info._nay.name === "download_gone") {
				const savedByOtherTab = (await ctx.runQuery(internal.files_browser.get_browser_download_save, {
					organizationId: membership.organizationId,
					sessionId: args.sessionId,
					downloadId: args.downloadId,
				})) as get_browser_download_save_Result;
				if (savedByOtherTab?.pushed) {
					return Result({
						_yay: { nodeId: savedByOtherTab.nodeId, path: savedByOtherTab.path, shared: savedByOtherTab.shared },
					});
				}
			}
			return browser_download_refusal(info._nay);
		}
		const parsedInfo = files_browser_runner_download_info_schema.safeParse(info._yay);
		if (!parsedInfo.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}

		const created = (await ctx.runMutation(internal.files_browser.create_browser_download_node, {
			userId: user._id,
			membershipId: args.membershipId,
			sessionId: args.sessionId,
			downloadId: args.downloadId,
			name: parsedInfo.data.name,
			contentType: parsedInfo.data.contentType,
			size: parsedInfo.data.size,
			origin: parsedInfo.data.origin,
		})) as create_browser_download_node_Result;
		if (created._nay) {
			return created;
		}
		const { nodeId, path, shared } = created._yay;
		if (created._yay.kind === "saved") {
			return Result({ _yay: { nodeId, path, shared } });
		}

		// The R2 event publishes the file after this PUT. A failed push keeps the bytes in the runner
		// for its 2-minute hold, so the app can save again to retry. If nobody does, the empty upload
		// node is cleaned up like any upload that never arrived.
		const pushed = await files_browser_runner_call({
			route: "download-push",
			body: { ...runnerBody, url: created._yay.url, headers: created._yay.headers },
		});
		if (pushed._nay) {
			return browser_download_refusal(pushed._nay);
		}
		await ctx.runMutation(internal.files_browser.mark_browser_download_pushed, {
			sessionId: args.sessionId,
			downloadId: args.downloadId,
		});

		return Result({ _yay: { nodeId, path, shared } });
	},
});

/**
 * Give the page's open file chooser 1 to 10 files from Files. Every file must be readable by the
 * owner; one refusal refuses the whole call. The runner downloads them from short signed URLs and
 * checks the chooser, the control generation, and human control itself.
 */
export const fill_browser_chooser_from_files = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		chooserId: v.string(),
		controlGen: v.number(),
		tabId: v.string(),
		tabGen: v.number(),
		viewGen: v.number(),
		nodeIds: v.array(v.id("files_nodes")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		if (args.nodeIds.length < 1 || args.nodeIds.length > BROWSER_UPLOAD_MAX_FILES) {
			return Result({ _nay: { message: `Choose 1 to ${BROWSER_UPLOAD_MAX_FILES} files.` } });
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
		if (loaded._yay.mode !== "web" || !loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_session(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		// The signer refuses a folder, a missing file, and a file without `content.read`, all as
		// "Not found". Editable Markdown gets a fresh snapshot first.
		const files: Array<{ name: string; contentType: string; url: string }> = [];
		let totalBytes = 0;
		for (const nodeId of args.nodeIds) {
			const signed = await r2_action_create_signed_download_url(ctx, {
				userId: user._id,
				membershipId: args.membershipId,
				fileNodeId: nodeId,
				expiresInSeconds: BROWSER_UPLOAD_URL_TTL_SECONDS,
			});
			if (signed._nay) {
				return signed;
			}
			totalBytes += signed._yay.asset.size;
			if (totalBytes > BROWSER_UPLOAD_MAX_BYTES) {
				return Result({ _nay: { message: "Files too large: a page takes at most 20 MB at once." } });
			}
			files.push({ name: signed._yay.fileNode.name, contentType: signed._yay.contentType, url: signed._yay.url });
		}

		const filled = await files_browser_runner_call({
			route: "upload-fill",
			body: {
				mode: loaded._yay.mode,
				sessionId: loaded._yay.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				chooserId: args.chooserId,
				controlGen: args.controlGen,
				tabId: args.tabId,
				tabGen: args.tabGen,
				viewGen: args.viewGen,
				files,
			},
		});
		if (filled._nay) {
			return filled;
		}
		return Result({ _yay: null });
	},
});

/**
 * Mint a single-use grant for one computer file to the page's open file chooser. The app PUTs the
 * file to `url` with its own `name` param added. This grant lasts 2 minutes.
 * It is bound to the chooser.
 */
export const grant_browser_upload = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("files_browser_sessions"),
		chooserId: v.string(),
		controlGen: v.number(),
		tabId: v.string(),
		tabGen: v.number(),
		viewGen: v.number(),
	},
	returns: v_result({ _yay: v.object({ url: v.string(), expiresAt: v.number() }) }),
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
		if (loaded._yay.mode !== "web" || !loaded._yay.runnerSessionId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const source = await authorize_live_browser_session(ctx, {
			membership,
			userId: user._id,
			session: loaded._yay,
		});
		if (!source.ok) {
			return Result({ _nay: { message: source.message } });
		}

		const granted = await files_browser_runner_call({
			route: "upload-grant",
			body: {
				mode: loaded._yay.mode,
				sessionId: loaded._yay.runnerSessionId,
				ownerId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				chooserId: args.chooserId,
				controlGen: args.controlGen,
				tabId: args.tabId,
				tabGen: args.tabGen,
				viewGen: args.viewGen,
			},
		});
		if (granted._nay) {
			return granted;
		}
		const parsed = files_browser_runner_upload_grant_schema.safeParse(granted._yay);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser request failed" } });
		}

		const url = files_browser_runner_upload_url({
			mode: loaded._yay.mode,
			ownerId: user._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			grantId: parsed.data.grantId,
		});
		if (!url) {
			return Result({ _nay: { message: "Browser unavailable" } });
		}
		return Result({ _yay: { url, expiresAt: parsed.data.expiresAt } });
	},
});
// #endregion browser downloads and uploads

const BROWSER_SWEEP_BATCH_SIZE = 50;

/**
 * Delete one browser session doc with its saved-download records. Every session delete goes
 * through here. The runner keeps at most 20 downloads per session, so one read gets them all.
 */
async function browser_db_delete_session(ctx: MutationCtx, sessionId: Id<"files_browser_sessions">) {
	const saves = await ctx.db
		.query("files_browser_download_saves")
		.withIndex("by_session_download", (q) => q.eq("sessionId", sessionId))
		.collect();
	for (const save of saves) {
		await ctx.db.delete("files_browser_download_saves", save._id);
	}
	await ctx.db.delete("files_browser_sessions", sessionId);
}

/**
 * Sweep draft captures with their blobs, unfinished starts, old daily-use counters, settled
 * sessions, and saved profiles unused for 90 days.
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
			const opening = await ctx.db
				.query("ai_chat_browser_invocations")
				.withIndex("by_openingSession", (q) => q.eq("openingSessionId", session._id))
				.first();
			if (opening && opening.status !== "finished") continue;
			await browser_db_delete_session(ctx, session._id);
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

		const userDailyUseDocs = await ctx.db
			.query("files_browser_user_daily_use")
			.withIndex("by_day", (q) => q.lt("day", dayCutoff))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const dailyUse of userDailyUseDocs) {
			await ctx.db.delete("files_browser_user_daily_use", dailyUse._id);
		}
		if (userDailyUseDocs.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		const remoteDailyUseDocs = await ctx.db
			.query("playwriter_user_daily_use")
			.withIndex("by_day", (q) => q.lt("day", dayCutoff))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const dailyUse of remoteDailyUseDocs) await ctx.db.delete("playwriter_user_daily_use", dailyUse._id);
		if (remoteDailyUseDocs.length === BROWSER_SWEEP_BATCH_SIZE) reschedule = true;

		// Read settled sessions only. A doc still waiting for its bill must stay, and many of
		// them must not block the sweep of older settled docs. Settling always closes the doc.
		const closedCutoff = now - BROWSER_SESSION_RETENTION_MS;
		const closedSessions = await ctx.db
			.query("files_browser_sessions")
			.withIndex("by_billing_state_updatedAt", (q) => q.eq("billing.state", "settled").lt("updatedAt", closedCutoff))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const session of closedSessions) {
			await browser_db_delete_session(ctx, session._id);
		}
		if (closedSessions.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		// A web start marks its profile used, and a session lasts at most an hour, so no live browser
		// uses a profile this old.
		const unusedProfiles = await ctx.db
			.query("files_browser_profiles")
			.withIndex("by_lastUsedAt", (q) => q.lt("lastUsedAt", now - BROWSER_PROFILE_UNUSED_MS))
			.take(BROWSER_SWEEP_BATCH_SIZE);
		for (const profile of unusedProfiles) {
			await files_browser_db_delete_profile(ctx, profile);
		}
		if (unusedProfiles.length > 0) {
			await ctx.scheduler.runAfter(0, internal.files_browser.process_browser_profile_wipes, {});
		}
		if (unusedProfiles.length === BROWSER_SWEEP_BATCH_SIZE) {
			reschedule = true;
		}

		if (reschedule) {
			await ctx.scheduler.runAfter(0, internal.files_browser.cleanup_expired_browser_docs, {});
		}
		return null;
	},
});

/**
 * Purge one workspace batch of shared connections, browser preferences, cloud sessions, and profiles.
 * Shared connection cleanup finishes first. Orphaned cloud sessions die on their idle alarm.
 */
export async function files_browser_db_purge_workspace_batch(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; batchSize: number },
) {
	const connections = await ctx.db
		.query("playwriter_connections")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (connections.length > 0) {
		let deletedCount = 0;
		for (const connection of connections) {
			if (connection.state !== "closed" || connection.encryptedShareId)
				await playwriter_browser_db_disconnect({ ctx, connection, reason: "workspace_deleted" });
			else {
				await ctx.db.delete("playwriter_connections", connection._id);
				deletedCount++;
			}
		}
		return { done: false, deletedCount };
	}
	const preferences = await ctx.db
		.query("files_browser_preferences")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (preferences.length > 0) {
		await Promise.all(preferences.map((preference) => ctx.db.delete("files_browser_preferences", preference._id)));
		return { done: false, deletedCount: preferences.length };
	}
	const sessions = await ctx.db
		.query("files_browser_sessions")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (sessions.length > 0) {
		await Promise.all(sessions.map((session) => browser_db_delete_session(ctx, session._id)));
		return { done: false, deletedCount: sessions.length };
	}

	const profiles = await ctx.db
		.query("files_browser_profiles")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (profiles.length > 0) {
		for (const profile of profiles) {
			await files_browser_db_delete_profile(ctx, profile);
		}
		await ctx.scheduler.runAfter(0, internal.files_browser.process_browser_profile_wipes, {});
		return { done: false, deletedCount: profiles.length };
	}

	// Draft captures expire within minutes and the hourly sweep deletes them with their blobs,
	// so the workspace purge leaves them alone.
	return { done: true, deletedCount: 0 };
}

/**
 * Drain one user's shared connections, call receipts, preferences, daily-use counters, cloud
 * sessions, draft captures with their blobs, and profiles. Account deletion normally removes
 * profiles at the request. A data-only reset reaches the profiles only here.
 */
export async function files_browser_db_delete_user_batch(
	ctx: MutationCtx,
	args: { userId: Id<"users">; batchSize: number },
) {
	const connections = await ctx.db
		.query("playwriter_connections")
		.withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
		.take(args.batchSize);
	if (connections.length > 0) {
		let deletedCount = 0;
		for (const connection of connections) {
			if (connection.state !== "closed" || connection.encryptedShareId)
				await playwriter_browser_db_disconnect({ ctx, connection, reason: "account_deleted" });
			else {
				await ctx.db.delete("playwriter_connections", connection._id);
				deletedCount++;
			}
		}
		return { done: false, deletedCount };
	}
	const invocations = await ctx.db
		.query("ai_chat_browser_invocations")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.take(args.batchSize);
	if (invocations.length > 0)
		return ai_chat_files_db_delete_browser_invocations({ ctx, invocations, options: { cloudCommands: "interrupt" } });
	const preferences = await ctx.db
		.query("files_browser_preferences")
		.withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
		.take(args.batchSize);
	if (preferences.length > 0) {
		await Promise.all(preferences.map((preference) => ctx.db.delete("files_browser_preferences", preference._id)));
		return { done: false, deletedCount: preferences.length };
	}
	const remoteDailyUse = await ctx.db
		.query("playwriter_user_daily_use")
		.withIndex("by_user_day", (q) => q.eq("userId", args.userId))
		.take(args.batchSize);
	if (remoteDailyUse.length > 0) {
		await Promise.all(remoteDailyUse.map((use) => ctx.db.delete("playwriter_user_daily_use", use._id)));
		return { done: false, deletedCount: remoteDailyUse.length };
	}
	const sessions = await ctx.db
		.query("files_browser_sessions")
		.withIndex("by_owner", (q) => q.eq("ownerId", args.userId))
		.take(args.batchSize);
	if (sessions.length > 0) {
		await Promise.all(sessions.map((session) => browser_db_delete_session(ctx, session._id)));
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

	const dailyUseDocs = await ctx.db
		.query("files_browser_user_daily_use")
		.withIndex("by_user_day", (q) => q.eq("userId", args.userId))
		.take(args.batchSize);
	if (dailyUseDocs.length > 0) {
		await Promise.all(dailyUseDocs.map((dailyUse) => ctx.db.delete("files_browser_user_daily_use", dailyUse._id)));
		return { done: false, deletedCount: dailyUseDocs.length };
	}

	const profiles = await ctx.db
		.query("files_browser_profiles")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.take(args.batchSize);
	if (profiles.length > 0) {
		for (const profile of profiles) {
			await files_browser_db_delete_profile(ctx, profile);
		}
		await ctx.scheduler.runAfter(0, internal.files_browser.process_browser_profile_wipes, {});
		return { done: false, deletedCount: profiles.length };
	}

	return { done: true, deletedCount: 0 };
}
