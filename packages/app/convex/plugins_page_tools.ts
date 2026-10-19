// Plugin page tools: the chat agent calls a tool that a plugin page declares, and the member's open
// page runs it.
//
// The chat turn runs on the server, and the server cannot send anything to a browser tab. So the
// call goes through one `plugins_page_tool_calls` doc:
//
// 1. The chat tool writes a `pending` doc (`create_call`) and waits for its result (`get_call`).
// 2. The member's open page watches its pending calls (`list_pending`), takes one (`claim_call`),
//    runs it inside the plugin frame, and writes the result (`complete_call`).
// 3. The chat tool reads the result and deletes the doc (`delete_call`).
//
// Only the browser tab that sent the chat message gets the call: the same member, installation,
// page id, and tab id. A call nobody answers ends with a timeout in the chat tool.

import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import { internalQuery, query } from "./_generated/server.js";
import { internalMutation, mutation } from "./functions.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";

/**
 * When the scheduled delete removes a call doc. The chat tool waits at most 45 seconds and deletes
 * the doc itself, so this delete only matters when its action died first.
 */
const CALL_CLEANUP_DELAY_MS = 120_000;

/**
 * The most calls one tab sees at once. The agent runs a few tools per step, so more never wait.
 */
const MAX_PENDING_CALLS = 16;

/**
 * The biggest result a page may write. The model reads the result, so keep it small.
 */
export const plugins_page_tools_MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * Find the page the chat turn may use, with its tools. Null when the page has no tools for this
 * turn: the plugin is not installed or is off, the member did not consent to page tools, or the
 * page declares none.
 */
export const get_turn_page = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		pluginName: v.string(),
		pageId: v.string(),
	},
	returns: v.union(
		v.object({
			installationId: v.id("plugins_workspace_installations"),
			pluginName: v.string(),
			displayName: v.string(),
			pageTitle: v.string(),
			tools: v.array(v.object({ name: v.string(), description: v.string(), inputSchemaJson: v.string() })),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const installation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginName", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("pluginName", args.pluginName),
			)
			.first();
		if (
			!installation ||
			installation.status !== "enabled" ||
			!installation.acceptedCapabilities.includes("agent.page-tools")
		) {
			return null;
		}

		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version || version.sourceStatus !== "ready" || version.reviewStatus !== "passed") {
			return null;
		}
		const page = version.pages.find((candidate) => candidate.id === args.pageId);
		if (!page?.agent) {
			return null;
		}

		return {
			installationId: installation._id,
			pluginName: installation.pluginName,
			displayName: version.displayName,
			pageTitle: page.title,
			tools: page.agent.tools,
		};
	},
});

export const create_call = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		installationId: v.id("plugins_workspace_installations"),
		pageId: v.string(),
		pageInstanceId: v.string(),
		toolCallId: v.string(),
		toolName: v.string(),
		inputJson: v.string(),
		expiresAt: v.number(),
	},
	returns: v.id("plugins_page_tool_calls"),
	handler: async (ctx, args) => {
		const callId = await ctx.db.insert("plugins_page_tool_calls", {
			...args,
			status: "pending",
			result: null,
		});
		// The chat tool deletes the doc when it stops waiting. If its action dies first, this delete
		// removes the doc instead.
		await ctx.scheduler.runAfter(CALL_CLEANUP_DELAY_MS, internal.plugins_page_tools.delete_call, { callId });
		return callId;
	},
});

export const get_call = internalQuery({
	args: { callId: v.id("plugins_page_tool_calls") },
	returns: v.union(
		v.object({ ok: v.literal(true), outputJson: v.string() }),
		v.object({ ok: v.literal(false), error: v.string() }),
		v.null(),
	),
	handler: async (ctx, args) => {
		const call = await ctx.db.get("plugins_page_tool_calls", args.callId);
		return call?.result ?? null;
	},
});

export const delete_call = internalMutation({
	args: { callId: v.id("plugins_page_tool_calls") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const call = await ctx.db.get("plugins_page_tool_calls", args.callId);
		if (call) {
			await ctx.db.delete("plugins_page_tool_calls", call._id);
		}
		return null;
	},
});

/**
 * The calls waiting for this tab. One doc per tool call in flight, and each one is deleted within
 * minutes, so the range stays small.
 */
export const list_pending = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginName: v.string(),
		pageId: v.string(),
		pageInstanceId: v.string(),
	},
	returns: v.array(v.object({ callId: v.id("plugins_page_tool_calls"), toolName: v.string(), inputJson: v.string() })),
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

		const installation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginName", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("pluginName", args.pluginName),
			)
			.first();
		if (!installation || installation.status !== "enabled") {
			return [];
		}

		const calls = await ctx.db
			.query("plugins_page_tool_calls")
			.withIndex("by_user_installation_page_instance_status", (q) =>
				q
					.eq("userId", userAuth.id)
					.eq("installationId", installation._id)
					.eq("pageId", args.pageId)
					.eq("pageInstanceId", args.pageInstanceId)
					.eq("status", "pending"),
			)
			.take(MAX_PENDING_CALLS);

		return calls.map((call) => ({ callId: call._id, toolName: call.toolName, inputJson: call.inputJson }));
	},
});

/**
 * Take a pending call for this tab. A call can be taken once, so it never runs twice.
 */
export const claim_call = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		callId: v.id("plugins_page_tool_calls"),
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

		const call = await ctx.db.get("plugins_page_tool_calls", args.callId);
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

		await ctx.db.patch("plugins_page_tool_calls", call._id, { status: "claimed" });
		return Result({ _yay: null });
	},
});

/**
 * Save the page's answer to a call this member claimed.
 */
export const complete_call = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		callId: v.id("plugins_page_tool_calls"),
		result: v.union(
			v.object({ ok: v.literal(true), outputJson: v.string() }),
			v.object({ ok: v.literal(false), error: v.string() }),
		),
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

		const call = await ctx.db.get("plugins_page_tool_calls", args.callId);
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

		// Drop a long answer here, so one call never stores more than the cap. The model reads the
		// error instead and can ask the page for less.
		const result =
			args.result.ok && files_get_utf8_byte_size(args.result.outputJson) > plugins_page_tools_MAX_OUTPUT_BYTES
				? { ok: false as const, error: "The page answer was larger than 32 KiB and was dropped." }
				: args.result.ok
					? args.result
					: { ok: false as const, error: args.result.error.slice(0, 2000) };
		await ctx.db.patch("plugins_page_tool_calls", call._id, { status: "done", result });
		return Result({ _yay: null });
	},
});
