// UI calls: a chat tool needs an answer from the member's open browser tab. `view_snapshot` reads
// the screen, `view_screenshot` asks the member for one picture of the tab, and a plugin page tool
// runs inside the plugin page.
//
// The chat turn runs on the server, and the server cannot send anything to a browser tab. So the
// call goes through one `ai_chat_ui_calls` doc:
//
// 1. The chat tool writes a `pending` doc (`create_call`) and waits for its result (`get_call`).
// 2. The member's open tab watches its pending calls (`list_pending`), takes one (`claim_call`),
//    answers it, and writes the result (`complete_call`).
// 3. The chat tool reads the result and deletes the doc (`delete_call`).
//
// Only the browser tab that sent the chat message gets the call: the same member, workspace and tab
// id. A call nobody answers ends with a timeout in the chat tool.

import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalQuery, query } from "./_generated/server.js";
import { internalMutation, mutation } from "./functions.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";

/**
 * When the scheduled delete removes a call doc. The chat tool waits at most 45 seconds and deletes
 * the doc itself, so this delete only matters when its action died first.
 */
const CALL_CLEANUP_DELAY_MS = 120_000;

/**
 * After the member takes a screenshot call, the chat tool waits this long for the picture: the
 * browser asks what to share, and the member picks.
 */
export const ai_chat_ui_calls_SCREENSHOT_CAPTURE_GRACE_MS = 60_000;

/**
 * The biggest picture a tab may store, as base64. It keeps the doc far below the 1 MiB Convex limit.
 */
const SCREENSHOT_MAX_BASE64_CHARS = 700 * 1024;

/**
 * The most calls one tab sees at once. The agent runs a few tools per step, so more never wait.
 */
const MAX_PENDING_CALLS = 16;

/**
 * The biggest answer a tab may write. The model reads it, so keep it small.
 */
export const ai_chat_ui_calls_MAX_OUTPUT_BYTES = 32 * 1024;

const SNAPSHOT_TRUNCATED_NOTE = "[truncated: the screen text passed 32 KiB. Read a part with a ref.]";

const call_result_validator = v.union(
	v.object({
		ok: v.literal(true),
		output: v.string(),
		snapshot: v.union(
			v.object({
				truncated: v.boolean(),
				buildMs: v.number(),
				plugins: v.array(v.object({ name: v.string(), answered: v.boolean() })),
			}),
			v.null(),
		),
	}),
	v.object({ ok: v.literal(false), error: v.string() }),
	v.object({
		ok: v.literal(true),
		image: v.object({
			mediaType: v.union(v.literal("image/jpeg"), v.literal("image/png"), v.literal("image/webp")),
			base64: v.string(),
			width: v.number(),
			height: v.number(),
		}),
	}),
	v.object({
		ok: v.literal(false),
		reason: v.union(
			v.literal("declined"),
			v.literal("denied"),
			v.literal("unsupported"),
			v.literal("wrong_surface"),
			v.literal("failed"),
			v.literal("too_large"),
		),
	}),
);

export const create_call = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		uiInstanceId: v.string(),
		toolCallId: v.string(),
		request: app_convex_schema.tables.ai_chat_ui_calls.validator.fields.request,
		expiresAt: v.number(),
	},
	returns: v.id("ai_chat_ui_calls"),
	handler: async (ctx, args) => {
		const callId = await ctx.db.insert("ai_chat_ui_calls", {
			...args,
			status: "pending",
			result: null,
		});
		// The chat tool deletes the doc when it stops waiting. If its action dies first, this delete
		// removes the doc instead. A screenshot call can wait longer than 120 seconds, so its delete
		// comes after the last moment the chat tool still waits.
		const cleanupDelayMs =
			args.request.kind === "view_screenshot"
				? Math.max(
						CALL_CLEANUP_DELAY_MS,
						args.expiresAt + ai_chat_ui_calls_SCREENSHOT_CAPTURE_GRACE_MS + 60_000 - Date.now(),
					)
				: CALL_CLEANUP_DELAY_MS;
		await ctx.scheduler.runAfter(cleanupDelayMs, internal.ai_chat_ui_calls.delete_call, { callId });
		return callId;
	},
});

export const get_call = internalQuery({
	args: { callId: v.id("ai_chat_ui_calls") },
	returns: v.union(
		v.object({
			status: app_convex_schema.tables.ai_chat_ui_calls.validator.fields.status,
			expiresAt: v.number(),
			result: v.union(call_result_validator, v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const call = await ctx.db.get("ai_chat_ui_calls", args.callId);
		return call ? { status: call.status, expiresAt: call.expiresAt, result: call.result } : null;
	},
});

export const delete_call = internalMutation({
	args: { callId: v.id("ai_chat_ui_calls") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const call = await ctx.db.get("ai_chat_ui_calls", args.callId);
		if (call) {
			await ctx.db.delete("ai_chat_ui_calls", call._id);
		}
		return null;
	},
});

/**
 * The calls waiting for this tab. One doc per tool call in flight, and each one is deleted within
 * minutes, so the range stays small. The workspace is part of the range, so a tab showing another
 * workspace never sees a call.
 */
export const list_pending = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		uiInstanceId: v.string(),
	},
	returns: v.array(
		v.object({
			callId: v.id("ai_chat_ui_calls"),
			toolCallId: v.string(),
			request: app_convex_schema.tables.ai_chat_ui_calls.validator.fields.request,
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		const calls = await ctx.db
			.query("ai_chat_ui_calls")
			.withIndex("by_user_instance_workspace_status", (q) =>
				q
					.eq("userId", userAuth.id)
					.eq("uiInstanceId", args.uiInstanceId)
					.eq("workspaceId", membership.workspaceId)
					.eq("status", "pending"),
			)
			.take(MAX_PENDING_CALLS);

		return calls.map((call) => ({ callId: call._id, toolCallId: call.toolCallId, request: call.request }));
	},
});

/**
 * Take a pending call for this tab. A call can be taken once, so it never runs twice.
 */
export const claim_call = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		callId: v.id("ai_chat_ui_calls"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const call = await ctx.db.get("ai_chat_ui_calls", args.callId);
		if (
			!call ||
			call.userId !== userAuth.id ||
			call.organizationId !== membership.organizationId ||
			call.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (call.status !== "pending" || call.expiresAt <= Date.now()) {
			return Result({ _nay: { message: "This call was already taken or has ended" } });
		}

		// An admin can turn the plugin off while the call waits. Its page must not run the call then.
		if (call.request.kind === "page_tool") {
			const installation = await ctx.db.get("plugins_workspace_installations", call.request.installationId);
			if (!installation || installation.status !== "enabled") {
				return Result({ _nay: { message: "This plugin is not installed or is off" } });
			}
		}

		await ctx.db.patch("ai_chat_ui_calls", call._id, { status: "claimed" });
		return Result({ _yay: null });
	},
});

/**
 * Save the tab's answer to a call this member claimed.
 */
export const complete_call = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		callId: v.id("ai_chat_ui_calls"),
		result: call_result_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const call = await ctx.db.get("ai_chat_ui_calls", args.callId);
		if (
			!call ||
			call.userId !== userAuth.id ||
			call.organizationId !== membership.organizationId ||
			call.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (call.status !== "claimed") {
			return Result({ _nay: { message: "This call is not waiting for an answer" } });
		}

		await ctx.db.patch("ai_chat_ui_calls", call._id, {
			status: "done",
			result: bound_result(call.request.kind, args.result),
		});
		return Result({ _yay: null });
	},
});

/**
 * Keep one stored answer small, so a tab can never store more than the cap.
 *
 * A page answer over the cap is dropped: half a JSON value is useless, and the model can ask the page
 * for less. A snapshot over the cap is cut on a line boundary instead, because half a screen still
 * helps.
 */
function bound_result(
	kind: Doc<"ai_chat_ui_calls">["request"]["kind"],
	result: typeof call_result_validator.type,
): NonNullable<Doc<"ai_chat_ui_calls">["result"]> {
	// A screenshot answer is a picture or a fixed reason, and only a screenshot call takes one.
	if (kind === "view_screenshot") {
		if ("reason" in result) {
			return result;
		}
		if (!("image" in result)) {
			return { ok: false, reason: "failed" };
		}
		return result.image.base64.length > SCREENSHOT_MAX_BASE64_CHARS ? { ok: false, reason: "too_large" } : result;
	}
	if ("image" in result || "reason" in result) {
		return { ok: false, error: "The answer had the wrong shape." };
	}

	if (!result.ok) {
		return { ok: false, error: result.error.slice(0, 2000) };
	}

	if (kind === "page_tool") {
		if (result.snapshot !== null) {
			return { ok: false, error: "The page answer had the wrong shape." };
		}
		return files_get_utf8_byte_size(result.output) > ai_chat_ui_calls_MAX_OUTPUT_BYTES
			? { ok: false, error: "The page answer was larger than 32 KiB and was dropped." }
			: result;
	}

	if (result.snapshot === null) {
		return { ok: false, error: "The snapshot answer had the wrong shape." };
	}
	// The tab names the plugin frames it asked. Keep that list short too.
	const snapshot = {
		...result.snapshot,
		plugins: result.snapshot.plugins.slice(0, 20).map((plugin) => ({ ...plugin, name: plugin.name.slice(0, 64) })),
	};
	if (files_get_utf8_byte_size(result.output) <= ai_chat_ui_calls_MAX_OUTPUT_BYTES) {
		return { ok: true, output: result.output, snapshot };
	}

	const lines = result.output.split("\n");
	const kept: string[] = [];
	let bytes = files_get_utf8_byte_size(SNAPSHOT_TRUNCATED_NOTE) + 1;
	for (const line of lines) {
		const lineBytes = files_get_utf8_byte_size(line) + 1;
		if (bytes + lineBytes > ai_chat_ui_calls_MAX_OUTPUT_BYTES) break;
		kept.push(line);
		bytes += lineBytes;
	}
	kept.push(SNAPSHOT_TRUNCATED_NOTE);
	return { ok: true, output: kept.join("\n"), snapshot: { ...snapshot, truncated: true } };
}
