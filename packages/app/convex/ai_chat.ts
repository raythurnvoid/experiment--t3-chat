import { composite_id, omit_properties, should_never_happen } from "../shared/shared-utils.ts";
import {
	ai_chat_MESSAGE_IMAGE_MAX_COUNT,
	ai_chat_MESSAGE_IMAGE_MAX_TOTAL_URL_CHARS,
	ai_chat_MODEL_IDS,
	ai_chat_MODE_IDS,
	ai_chat_is_message_image_media_type,
	type ai_chat_AiSdk5UiMessage,
} from "../shared/ai-chat.ts";
import { math_clamp } from "../src/lib/utils.ts";
import { get_id_generator } from "../shared/generated-ids.ts";
import {
	query,
	mutation,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import { paginationOptsValidator, paginationResultValidator, type RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import { openai } from "@ai-sdk/openai";
import {
	streamText,
	smoothStream,
	createUIMessageStream,
	createUIMessageStreamResponse,
	consumeStream,
	stepCountIs,
	convertToModelMessages,
	validateUIMessages,
	TypeValidationError,
} from "ai";
import { z } from "zod";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import type { access_control_Permission } from "../shared/access-control.ts";
import { files_READ_RANGE_MAX_LINES } from "./files_nodes.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import {
	ai_chat_tool_create_bash,
	ai_chat_tool_create_edit_file,
	ai_chat_tool_create_web_search,
	ai_chat_tool_create_execute_code,
	ai_chat_WRITE_TOOL_NAMES,
} from "../server/server-ai-tools.ts";
import app_convex_schema from "./schema.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { billing_event } from "../server/billing.ts";
import { billing_ingest_events } from "./billing_db.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import type { Doc, Id } from "./_generated/dataModel";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). Do not keep request state in module-level values.
export const experimental_reuseContext = true;

export {
	remove_file_pending_update_if_expired,
	upsert_file_pending_update,
	persist_file_pending_update_rebased_state,
	get_file_pending_update,
	get_file_pending_update_last_sequence_saved,
	list_files_pending_updates,
	save_file_pending_update,
} from "./files_pending_updates.ts";

/**
 * A chat thread is a conversation, not a file. Reading the workspace is enough to open a thread and
 * to run your own: no thread handler in this file touches a file. That is why a read-only role can
 * use ask mode, and why the agent-mode branch of `/api/chat` asks for `content.write` as well.
 *
 * Changing somebody else's thread is a different question — see `authorize_thread_mutation`.
 */
const THREAD_PERMISSION = "content.read" as const satisfies access_control_Permission;

/**
 * Threads are shared by the whole workspace: `threads_list` reads them by organization and workspace,
 * with no filter on the user. So `THREAD_PERMISSION` decides who may open a thread, and this decides
 * who may change one: its author, or anyone who can edit workspace content.
 *
 * Without this check a read-only role could archive or rename the whole chat history of the
 * workspace. Worse, `thread_messages_add` would let it write text into someone else's thread.
 * `/api/chat` sends the stored messages back to the model as earlier conversation, so the next person
 * who continues that thread in agent mode would hand that text to an agent that can edit files. A
 * read-only role would have turned itself into a writer.
 */
async function authorize_thread_mutation(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		thread: Doc<"ai_chat_threads">;
	},
) {
	if (args.thread.createdBy === args.userAuth.id) {
		return Result({ _yay: null });
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		permission: "content.write",
	});
	return authorized._nay ? authorized : Result({ _yay: null });
}

const TITLE_MODEL_ID = "gpt-4.1-nano" as const;

const TITLE_SYSTEM_PROMPT = [
	"Generate a concise, descriptive title (max 6 words) for this conversation.",
	"The title should capture the main topic or purpose.",
	"Respond with ONLY the title, no quotes or extra text.",
].join("\n");

function ai_chat_system_prompt(args: { organizationName: string; workspaceName: string }) {
	const HOME = "/home/cloud-usr";
	const appMountPath = `${HOME}/w`;
	const currentWorkspacePath = `${appMountPath}/${args.organizationName}/${args.workspaceName}`;
	return [
		"You are the app chat agent for the user's organization.",
		"Use the available tools as the working interface for the organization.",
		`Bash starts in the current workspace path at \`~/w/${args.organizationName}/${args.workspaceName}\` (\`${currentWorkspacePath}\`). \`~\` is \`${HOME}\`, the app mount is \`${appMountPath}\`, and \`/tmp\` is durable scratch scoped to this chat thread.`,
		`User messages may reference app files with mentions written as \`@/path/to/file.md\` (any app file works the same, for example \`@/data/config.json\`); a trailing slash like \`@/docs/\` means a folder. Resolve them under the current workspace path (\`@/docs/api.md\` is \`${currentWorkspacePath}/docs/api.md\`) before using Bash or \`edit_file\`.`,
		"The Bash tool description is the authority on its command surface, its flags, and how the db-backed app mount differs from `/tmp`. Follow it instead of assuming POSIX/GNU behavior, and never describe an app-mount limitation as a global Bash limitation.",
		"Run the exact printed `Next page:` command to continue a listing, and when the user asks for one continuation, run only the first one and then stop.",
		"If a failed Bash command prints a `Try:` command that directly matches the user's request, run that `Try:` command next instead of only reporting the failure.",
		"Only summarize actual Bash stdout/stderr. The blank line between the shell prompt and output is transcript formatting, not file content. If stdout is empty or a command failed, say that instead of inferring likely filesystem contents.",
		"Bash app-file writes and `edit_file` create pending review changes for the user to apply; your own later reads (Bash readers, `search`, and the file tools) see them as already applied.",
		"Use tools to clarify uncertain reads, searches, and path lookups instead of inventing content or paths.",
		"Use `web_search` for current public facts, official documentation, release notes, news, and other information outside this organization when file tools are not enough.",
		"Summarize `web_search` highlight snippets in your own words.",
		"On failed web search, continue from organization context and state that current web results were unavailable.",
		"Use `execute_code` to run small JavaScript snippets for precise calculations, JSON transformation, parsing, public HTTPS fetches, or algorithmic checks when doing it by hand would be error-prone.",
		"The snippet has `fetch`, `input`, and `process.env.T3_APP_ORIGIN`; the runner gateway adds app file API authorization.",
		"To read app files from code, fetch `${process.env.T3_APP_ORIGIN}/api/v1/files/list` for paths, then `${process.env.T3_APP_ORIGIN}/api/v1/files/read-many` for contents; follow `cursor` until `isDone`, check `errors` and `truncated`, and use `/api/v1/files/read` only for one known file.",
		"Do not pass app file paths or contents through `input`; keep `input` for ordinary JSON parameters, run file API fetches inside the snippet, and return a compact aggregate instead of raw file contents.",
		"Summarize `execute_code` results and logs in your answer; do not paste large raw output.",
		"After tool results, give the user a concise direct answer and only continue using tools when it materially helps.",
	].join("\n");
}

const ASK_MODE_SYSTEM_PROMPT_SUFFIX =
	"Ask mode is for reading, searching, and answering. Durable folder and file changes are handled in Agent mode; /tmp scratch is durable per chat thread but is not app file storage.";

/**
 * Resolve the persisted context for a client-provided parent message id.
 *
 * The client can send either a Convex message `_id` or an optimistic
 * `clientGeneratedMessageId`, depending on whether the live query has caught up.
 * Return a bad result when the parent id cannot be resolved so callers cannot
 * accidentally use a partial parent chain and create a new root branch.
 */
function resolve_parent_message_context(input: {
	messages: Doc<"ai_chat_threads_messages_aisdk_5">[];
	parentId: string | null | undefined;
}) {
	// Index both persisted and optimistic ids so parent resolution works before
	// the client has received the server-created message ids.
	const messagesMap = new Map<string, Doc<"ai_chat_threads_messages_aisdk_5">>();
	for (const msg of input.messages) {
		messagesMap.set(msg._id, msg);
		if (msg.clientGeneratedMessageId) {
			messagesMap.set(msg.clientGeneratedMessageId, msg);
		}
	}

	// Walk from the requested parent id back to the root.
	const reconstructedMessages: Doc<"ai_chat_threads_messages_aisdk_5">[] = [];
	let nextParentId = input.parentId;
	while (nextParentId) {
		const message = messagesMap.get(nextParentId);
		if (!message) {
			return Result({
				_nay: {
					message: "Message not found.",
					data: {
						unresolvedParentId: nextParentId,
					},
				},
			});
		}

		reconstructedMessages.push(message);
		nextParentId = message.parentId as string | null;
	}

	// Resolve the immediate parent separately; this is the id persisted on newly
	// submitted messages and the optimistic id echoed back to the client.
	const parentMessage = input.parentId ? (messagesMap.get(input.parentId) ?? null) : null;

	// Keep all parent-resolution outputs together so the stream and persistence
	// code cannot accidentally derive them from different lookup paths.
	return Result({
		_yay: {
			reconstructedMessages,
			resolvedParentId: parentMessage?._id ?? null,
			resolvedParentClientGeneratedId: parentMessage?.clientGeneratedMessageId ?? null,
		},
	});
}

function compute_token_usage_cost_cents(args: { modelId: string; inputTokens: number; outputTokens: number }) {
	switch (args.modelId) {
		case "gpt-5.4-nano":
		case "gpt-4.1-nano":
			return args.inputTokens * 0.00001 + args.outputTokens * 0.00004;
		case "gpt-5.6-luna":
			return args.inputTokens * 0.00002 + args.outputTokens * 0.00012;
		case "gpt-5.6-terra":
			return args.inputTokens * 0.0002 + args.outputTokens * 0.0012;
		case "gpt-5.4-mini":
		default:
			return args.inputTokens * 0.00003 + args.outputTokens * 0.00015;
	}
}

function build_agent_configuration(input: {
	ctx: ActionCtx;
	ctxData: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
		userId: Id<"users">;
	};
	args: {
		modeId: (typeof ai_chat_MODE_IDS)[number];
	};
	getThreadId: () => Id<"ai_chat_threads"> | null;
}) {
	const {
		ctx,
		ctxData,
		args: { modeId },
		getThreadId,
	} = input;

	// The tools that write pending updates (or grants) read the running chat's thread id from
	// their ctxData; the lazy getter resolves after the http handler creates/loads the thread.
	const toolCtxData = { ...ctxData, getThreadId };

	// We list every tool here, in both modes. `validateUIMessages` fails when a message mentions a tool
	// name that is not in this list. The route accepts whatever messages a client posts, and a thread
	// that once ran in agent mode can hold agent-only tool calls. So a list that changed with the mode
	// would turn "this thread once ran in agent mode" into a 400. Our own app posts only the new user
	// message, but the route cannot count on that.
	const validationTools = {
		bash: ai_chat_tool_create_bash(ctx, toolCtxData, {
			allowDbFilesMkdir: modeId === "agent",
		}),
		edit_file: ai_chat_tool_create_edit_file(ctx, toolCtxData),
		web_search: ai_chat_tool_create_web_search(),
		execute_code: ai_chat_tool_create_execute_code(ctx, toolCtxData),
	};

	const writeToolNames = new Set<string>(ai_chat_WRITE_TOOL_NAMES);

	// The tools the model can really call. In ask mode we remove the write tools from this object, not
	// only from `activeTools`. `activeTools` is just a hint: it only shapes the request sent to the
	// model. When a tool call comes back, the SDK looks the name up in this object to parse and run it,
	// and `experimental_repairToolCall` also matches wrong upper/lower case against it. So a write tool
	// left here stays callable in ask mode. `edit_file` checks no permission by itself, because this
	// route is meant to be the check.
	const tools = Object.fromEntries(
		Object.entries(validationTools).filter(([name]) => !(modeId === "ask" && writeToolNames.has(name))),
	) as Partial<typeof validationTools>;

	const activeTools = Object.keys(tools) as Array<keyof typeof validationTools>;

	return {
		systemPrompt:
			modeId === "ask"
				? `${ai_chat_system_prompt(ctxData)}\n${ASK_MODE_SYSTEM_PROMPT_SUFFIX}`
				: ai_chat_system_prompt(ctxData),
		tools,
		validationTools,
		activeTools,
	};
}

export const get_thread_state = internalQuery({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
	},
	returns: doc(app_convex_schema, "ai_chat_threads_state"),
	handler: async (ctx, args) => {
		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (!thread) {
			throw convex_error({ message: "Not found" });
		}
		if (thread.organizationId !== args.organizationId || thread.workspaceId !== args.workspaceId) {
			throw convex_error({ message: "Unauthorized" });
		}
		if (!thread.stateId) {
			throw should_never_happen("AI chat thread state pointer missing", {
				threadId: args.threadId,
			});
		}

		const state = await ctx.db.get("ai_chat_threads_state", thread.stateId);
		if (
			!state ||
			state.organizationId !== args.organizationId ||
			state.workspaceId !== args.workspaceId ||
			state.threadId !== args.threadId
		) {
			throw should_never_happen("AI chat thread state missing or mismatched", {
				threadId: args.threadId,
				stateId: thread.stateId,
			});
		}

		return state;
	},
});

export type ai_chat_get_thread_state_Result =
	typeof get_thread_state extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const set_thread_state = internalMutation({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		userId: v.id("users"),
		patch: v.object({
			bashCwd: v.optional(v.string()),
		}),
	},
	returns: doc(app_convex_schema, "ai_chat_threads_state"),
	handler: async (ctx, args) => {
		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (!thread) {
			throw convex_error({ message: "Not found" });
		}
		if (thread.organizationId !== args.organizationId || thread.workspaceId !== args.workspaceId) {
			throw convex_error({ message: "Unauthorized" });
		}
		if (!thread.stateId) {
			throw should_never_happen("AI chat thread state pointer missing", {
				threadId: args.threadId,
			});
		}

		// Keep this table for low-churn per-thread agent state, not user-authored chat content.
		const state = await ctx.db.get("ai_chat_threads_state", thread.stateId);
		if (
			!state ||
			state.organizationId !== args.organizationId ||
			state.workspaceId !== args.workspaceId ||
			state.threadId !== args.threadId
		) {
			throw should_never_happen("AI chat thread state missing or mismatched", {
				threadId: args.threadId,
				stateId: thread.stateId,
			});
		}

		const patch = {
			...(args.patch.bashCwd !== undefined ? { bashCwd: args.patch.bashCwd } : {}),
			updatedBy: args.userId,
			updatedAt: Date.now(),
		};
		await ctx.db.patch("ai_chat_threads_state", state._id, patch);

		return {
			...state,
			...patch,
		};
	},
});

export const threads_list = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		paginationOpts: paginationOptsValidator,
		archived: v.optional(v.boolean()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "ai_chat_threads")),
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
			return {
				page: [],
				isDone: true,
				continueCursor: "",
			};
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return {
				page: [],
				isDone: true,
				continueCursor: "",
			};
		}

		const numItems = math_clamp(args.paginationOpts.numItems ?? 100, 1, 100);
		const archived = args.archived ?? false;

		const threads_query = ctx.db
			.query("ai_chat_threads")
			.withIndex("by_organization_workspace_archived_lastMessageAt", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("archived", archived),
			);

		const result = await threads_query.order("desc").paginate({
			...args.paginationOpts,
			numItems,
		});

		return result;
	},
});

/**
 * Query to get a single thread by ID
 */
export const thread_get = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		/**
		 * Can be a temporary ID generated by Assistant UI
		 **/
		threadId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "ai_chat_threads"), v.null()),
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
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return null;
		}

		const id_normalized = ctx.db.normalizeId("ai_chat_threads", args.threadId);

		if (!id_normalized) {
			return null;
		}

		const thread = await ctx.db.get("ai_chat_threads", id_normalized);

		if (
			!thread ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId
		) {
			return null;
		}

		return thread;
	},
});

/**
 * Mutation to create a new thread
 */
export const thread_create = mutation({
	args: v.object({
		membershipId: v.id("organizations_workspaces_users"),
		clientGeneratedId: app_convex_schema.tables.ai_chat_threads.validator.fields.clientGeneratedId,
		title: v.optional(app_convex_schema.tables.ai_chat_threads.validator.fields.title),
		lastMessageAt: app_convex_schema.tables.ai_chat_threads.validator.fields.lastMessageAt,
	}),
	returns: v_result({
		_yay: v.object({
			threadId: v.id("ai_chat_threads"),
		}),
	}),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "ai_chat_thread_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return authorized;
		}

		const now = Date.now();

		// We do not trust `lastMessageAt`. This is a public mutation, and the only real caller
		// (`/api/chat`) sends its own server time anyway. `threads_list` sorts on this field, so a time
		// in the future would put the thread at the top of the list for every member until the first
		// message replaces it. `readAt` copies this value too, so until then the thread also looks
		// read.
		const lastMessageAt = args.lastMessageAt == null ? undefined : Math.min(args.lastMessageAt, now);

		const threadId = await ctx.db.insert("ai_chat_threads", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			clientGeneratedId: args.clientGeneratedId,
			title: args.title ?? null,
			lastMessageAt,
			readAt: lastMessageAt,
			archived: false,
			runtime: "aisdk_5",
			stateId: null,
			createdBy: userAuth.id,
			updatedBy: userAuth.id,
			updatedAt: now,
			starred: false,
		});
		const stateId = await ctx.db.insert("ai_chat_threads_state", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			threadId,
			bashCwd: "~",
			updatedBy: userAuth.id,
			updatedAt: now,
		});
		await ctx.db.patch("ai_chat_threads", threadId, { stateId });

		return Result({ _yay: { threadId } });
	},
});

/**
 * Branch a thread by creating a new thread with the same source thread as parent.
 *
 * @param args.membershipId
 * @param args.threadId
 * @param args.messageId - The ID of the message to start the new thread from. Must be a convex generated ID of a persisted message.
 */
export const thread_branch = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
		messageId: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			threadId: v.id("ai_chat_threads"),
		}),
	}),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "ai_chat_thread_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return authorized;
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (thread.organizationId !== membership.organizationId || thread.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const now = Date.now();
		const organizationId = thread.organizationId;
		const workspaceId = thread.workspaceId;

		const allMessages = await ctx.db
			.query("ai_chat_threads_messages_aisdk_5")
			.withIndex("by_organization_workspace_thread", (q) =>
				q.eq("organizationId", thread.organizationId).eq("workspaceId", thread.workspaceId).eq("threadId", threadId),
			)
			.collect();

		const byId = new Map<string, Doc<"ai_chat_threads_messages_aisdk_5">>(allMessages.map((m) => [m._id, m]));

		let newestMessage = undefined;
		if (args.messageId) {
			const messageId = ctx.db.normalizeId("ai_chat_threads_messages_aisdk_5", args.messageId);
			const message = messageId ? byId.get(messageId) : undefined;
			if (!message) {
				return Result({ _nay: { message: "Message not found" } });
			}
			newestMessage = message;
		}

		const unarchivedThreads = await ctx.db
			.query("ai_chat_threads")
			.withIndex("by_organization_workspace_archived_lastMessageAt", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("archived", false),
			)
			.collect();

		const archivedThreads = await ctx.db
			.query("ai_chat_threads")
			.withIndex("by_organization_workspace_archived_lastMessageAt", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("archived", true),
			)
			.collect();

		const sourceTitle = (thread.title || "New Chat").trim() || "New Chat";
		const baseTitle = sourceTitle.replace(/ \(\d+\)$/, "");

		let maxSuffix = 0;
		for (const thread of [...unarchivedThreads, ...archivedThreads]) {
			const title = (thread.title || "New Chat").trim() || "New Chat";
			const normalized = title.replace(/ \(\d+\)$/, "");
			if (normalized !== baseTitle) {
				continue;
			}

			const match = title.match(/ \((\d+)\)$/);
			if (!match) {
				continue;
			}

			const n = Number(match[1]);
			if (Number.isFinite(n) && n > maxSuffix) {
				maxSuffix = n;
			}
		}

		if (!newestMessage) {
			let newest: Doc<"ai_chat_threads_messages_aisdk_5"> | null = null;

			for (const message of allMessages) {
				if (!newest || message._creationTime > newest._creationTime) {
					newest = message;
				}
			}

			newestMessage = newest;
		}

		const title = `${baseTitle} (${maxSuffix + 1})`;
		const clientGeneratedId = get_id_generator("ai_thread")();

		const sourceState = thread.stateId ? await ctx.db.get("ai_chat_threads_state", thread.stateId) : null;
		if (!sourceState) {
			throw should_never_happen("AI chat thread state missing", {
				threadId,
				stateId: thread.stateId,
			});
		}

		const newThreadId = await ctx.db.insert("ai_chat_threads", {
			organizationId,
			workspaceId,
			clientGeneratedId,
			title,
			lastMessageAt: now,
			readAt: now,
			archived: false,
			runtime: "aisdk_5",
			stateId: null,
			createdBy: userAuth.id,
			updatedBy: userAuth.id,
			updatedAt: now,
			starred: false,
		});
		// Branching stays open to any member: it copies messages the caller can already read.
		// The scratch state is different. It is the `/tmp` files and the `bashCwd` of the source
		// thread. To reach those inside the source thread you must send a prompt there, and
		// `thread_messages_add` asks for `content.write` unless you created the thread. Copying them
		// into a new thread that the caller owns would skip that check, so we copy them only when the
		// caller was allowed to write in the source thread.
		const threadAuthorized = await authorize_thread_mutation(ctx, { userAuth, membership, thread });
		const canReadSourceScratch = !threadAuthorized._nay;

		const stateId = await ctx.db.insert("ai_chat_threads_state", {
			organizationId,
			workspaceId,
			threadId: newThreadId,
			// `"~"` is the folder a brand-new thread starts in. Using it makes a branch without scratch
			// access look like a fresh thread instead of a half-copied one.
			bashCwd: canReadSourceScratch ? sourceState.bashCwd : "~",
			updatedBy: userAuth.id,
			updatedAt: now,
		});
		await ctx.db.patch("ai_chat_threads", newThreadId, { stateId });

		if (canReadSourceScratch) {
			await ctx.runMutation(internal.ai_chat_files.copy_thread_tmp_files, {
				organizationId,
				workspaceId,
				sourceThreadId: threadId,
				targetThreadId: newThreadId,
			});
		}

		if (!newestMessage) {
			return Result({ _yay: { threadId: newThreadId } });
		}

		const chain: Array<Doc<"ai_chat_threads_messages_aisdk_5">> = [];

		let current: Doc<"ai_chat_threads_messages_aisdk_5"> | undefined = newestMessage;
		while (current) {
			chain.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}

		const messages: Array<{
			clientGeneratedMessageId: string;
			content: Record<string, unknown>;
		}> = [];

		for (let i = chain.length - 1; i >= 0; i--) {
			const msg = chain[i];
			const content = msg.content as unknown as ai_chat_AiSdk5UiMessage;
			const nextId = get_id_generator("ai_message")();
			const metadata = content.metadata
				? omit_properties(content.metadata, ["convexParentId", "convexId", "parentClientGeneratedId"])
				: undefined;

			messages.push({
				clientGeneratedMessageId: nextId,
				content: {
					...content,
					id: nextId,
					...(metadata ? { metadata } : {}),
				},
			});
		}

		let nextParentId: Id<"ai_chat_threads_messages_aisdk_5"> | null = null;
		for (const message of messages) {
			const insertedId: Id<"ai_chat_threads_messages_aisdk_5"> = await ctx.db.insert(
				"ai_chat_threads_messages_aisdk_5",
				{
					organizationId,
					workspaceId,
					parentId: nextParentId,
					threadId: newThreadId,
					createdBy: userAuth.id,
					updatedAt: now,
					clientGeneratedMessageId: message.clientGeneratedMessageId,
					content: message.content,
				},
			);

			nextParentId = insertedId;
		}

		await ctx.db.patch("ai_chat_threads", newThreadId, {
			lastMessageAt: now,
			readAt: now,
			updatedAt: now,
			updatedBy: userAuth.id,
		});

		return Result({ _yay: { threadId: newThreadId } });
	},
});

/**
 * Mutation to update thread details
 */
export const thread_update = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
		title: v.optional(v.union(v.string(), v.null())),
		isArchived: v.optional(v.boolean()),
		starred: v.optional(v.boolean()),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "ai_chat_thread_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return authorized;
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (thread.organizationId !== membership.organizationId || thread.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const threadAuthorized = await authorize_thread_mutation(ctx, { userAuth, membership, thread });
		if (threadAuthorized._nay) {
			return threadAuthorized;
		}

		await ctx.db.patch(
			"ai_chat_threads",
			threadId,
			Object.assign(
				{
					updatedBy: userAuth.id,
					updatedAt: Date.now(),
				},
				args.title !== undefined
					? {
							title: args.title,
						}
					: {},
				args.isArchived !== undefined
					? {
							archived: args.isArchived,
						}
					: {},
				args.starred !== undefined
					? {
							starred: args.starred,
						}
					: {},
			),
		);

		return Result({ _yay: null });
	},
});

/**
 * Move the thread read cursor up to the newest message.
 *
 * Unread is derived (`lastMessageAt > readAt`), so nothing ever marks a thread
 * unread: a new message does that on its own. This is the only write.
 */
export const thread_mark_read = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "ai_chat_thread_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return authorized;
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (thread.organizationId !== membership.organizationId || thread.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// This write does not call `authorize_thread_mutation`, unlike the other thread writes. Threads
		// belong to the whole workspace, and the list shows them as unread until someone opens them. So
		// asking for `content.write` would leave a read-only role with unread badges it can never clear
		// on threads it is allowed to read. None of the problems that helper exists to stop can happen
		// by moving a read marker.
		//
		// `readAt` is one field on the shared thread, not one marker per user. So whoever opens a
		// thread clears the badge for the whole workspace. That is how the feature already works for
		// every member; blocking this one write would only make the badge permanent for readers, it
		// would not make it private.
		//
		// Reading is not a content edit, so `updatedAt`/`updatedBy` stay untouched.
		// `Math.max` keeps the cursor correct when the newest message is already persisted.
		await ctx.db.patch("ai_chat_threads", threadId, {
			readAt: Math.max(Date.now(), thread.lastMessageAt ?? 0),
		});

		return Result({ _yay: null });
	},
});

/**
 * Mutation to archive/unarchive a thread
 */
export const thread_archive = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "ai_chat_thread_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return authorized;
		}

		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (thread.organizationId !== membership.organizationId || thread.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const threadAuthorized = await authorize_thread_mutation(ctx, { userAuth, membership, thread });
		if (threadAuthorized._nay) {
			return threadAuthorized;
		}

		const now = Date.now();

		await ctx.db.patch("ai_chat_threads", args.threadId, {
			archived: true,
			updatedBy: userAuth.id,
			updatedAt: now,
		});

		return Result({ _yay: null });
	},
});

/**
 * Query to list messages in a thread
 */
export const thread_messages_list = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.union(
		v.object({
			messages: v.array(doc(app_convex_schema, "ai_chat_threads_messages_aisdk_5")),
		}),
		v.null(),
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
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return null;
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return null;
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (
			!thread ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId
		) {
			return null;
		}

		const messages = await ctx.db
			.query("ai_chat_threads_messages_aisdk_5")
			.withIndex("by_organization_workspace_thread", (q) =>
				q.eq("organizationId", thread.organizationId).eq("workspaceId", thread.workspaceId).eq("threadId", threadId),
			)
			.order(args.order ?? "desc")
			.collect();

		return { messages };
	},
});

/**
 * Mutation to add one or more messages to a thread.
 *
 * Repeated client-generated ids return the existing message ids.
 */
export const thread_messages_add = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		parentId: v.optional(v.union(v.string(), v.null())),
		messages: v.array(
			v.object({
				clientGeneratedMessageId:
					app_convex_schema.tables.ai_chat_threads_messages_aisdk_5.validator.fields.clientGeneratedMessageId,
				content: app_convex_schema.tables.ai_chat_threads_messages_aisdk_5.validator.fields.content,
			}),
		),
	},
	returns: v_result({
		_yay: v.object({
			ids: v.array(v.id("ai_chat_threads_messages_aisdk_5")),
		}),
	}),
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

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: THREAD_PERMISSION,
		});
		if (authorized._nay) {
			return authorized;
		}

		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (!thread) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (thread.organizationId !== membership.organizationId || thread.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const threadAuthorized = await authorize_thread_mutation(ctx, { userAuth, membership, thread });
		if (threadAuthorized._nay) {
			return threadAuthorized;
		}

		// The `content` validator is loose (`v.any()` fields), but stored file parts
		// are forwarded to the model provider on later turns. Enforce the same image
		// contract as the chat route, so a direct call to this public mutation cannot
		// store a remote URL or an oversized image.
		for (const message of args.messages) {
			const parts: unknown[] = Array.isArray(message.content.parts) ? message.content.parts : [];
			let filePartCount = 0;
			let totalUrlChars = 0;
			for (const part of parts) {
				if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "file") {
					continue;
				}

				filePartCount += 1;
				const filePart = part as { mediaType?: unknown; url?: unknown };
				if (
					typeof filePart.mediaType !== "string" ||
					typeof filePart.url !== "string" ||
					!ai_chat_is_message_image_media_type(filePart.mediaType) ||
					!filePart.url.startsWith(`data:${filePart.mediaType};base64,`)
				) {
					return Result({ _nay: { message: "Invalid image attachments" } });
				}
				totalUrlChars += filePart.url.length;
			}

			if (
				filePartCount > ai_chat_MESSAGE_IMAGE_MAX_COUNT ||
				totalUrlChars > ai_chat_MESSAGE_IMAGE_MAX_TOTAL_URL_CHARS
			) {
				return Result({ _nay: { message: "Invalid image attachments" } });
			}
		}

		const parentId = args.parentId ? ctx.db.normalizeId("ai_chat_threads_messages_aisdk_5", args.parentId) : null;

		const existingIdsByClientGeneratedMessageId = new Map<string, Id<"ai_chat_threads_messages_aisdk_5">>();
		const newClientGeneratedMessageIds = new Set<string>();
		const existingMessages = await Promise.all(
			args.messages.map(async (message) => ({
				clientGeneratedMessageId: message.clientGeneratedMessageId,
				existingMessage: await ctx.db
					.query("ai_chat_threads_messages_aisdk_5")
					.withIndex("by_organization_workspace_thread_clientGeneratedMessageId", (q) =>
						q
							.eq("organizationId", thread.organizationId)
							.eq("workspaceId", thread.workspaceId)
							.eq("threadId", args.threadId)
							.eq("clientGeneratedMessageId", message.clientGeneratedMessageId),
					)
					.first(),
			})),
		);
		for (const { clientGeneratedMessageId, existingMessage } of existingMessages) {
			if (existingMessage) {
				existingIdsByClientGeneratedMessageId.set(clientGeneratedMessageId, existingMessage._id);
			} else if (!existingIdsByClientGeneratedMessageId.has(clientGeneratedMessageId)) {
				newClientGeneratedMessageIds.add(clientGeneratedMessageId);
			}
		}

		// Here the rate limit runs after the permission check, unlike the other handlers in this file.
		// The limit costs one token per new message, and we only know how many messages are new after
		// we have looked up the ones already stored.
		if (newClientGeneratedMessageIds.size > 0) {
			const rateLimit = await rate_limiter_limit_by_key(ctx, {
				name: "ai_chat_message_write",
				key: userAuth.id,
				count: newClientGeneratedMessageIds.size,
			});
			if (rateLimit) {
				return Result({ _nay: { message: rateLimit.message } });
			}
		}

		const now = Date.now();
		const ids: Array<Id<"ai_chat_threads_messages_aisdk_5">> = [];
		let nextParentId = parentId;
		for (const message of args.messages) {
			const existingMessageId = existingIdsByClientGeneratedMessageId.get(message.clientGeneratedMessageId);
			if (existingMessageId) {
				ids.push(existingMessageId);
				nextParentId = existingMessageId;
				continue;
			}

			const messageId = await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
				organizationId: thread.organizationId,
				workspaceId: thread.workspaceId,
				parentId: nextParentId,
				threadId: args.threadId,
				createdBy: userAuth.id,
				updatedAt: now,
				clientGeneratedMessageId: message.clientGeneratedMessageId,
				content: message.content,
			});

			existingIdsByClientGeneratedMessageId.set(message.clientGeneratedMessageId, messageId);
			ids.push(messageId);
			nextParentId = messageId;
		}

		if (ids.length > 0) {
			await ctx.db.patch("ai_chat_threads", args.threadId, {
				lastMessageAt: now,
				updatedAt: now,
				updatedBy: userAuth.id,
			});
		}

		return Result({ _yay: { ids } });
	},
});

/**
 * Keep this in sync with the AI SDK `PrepareSendMessagesRequest` shape used by
 * `AssistantChatTransport.prepareSendMessagesRequest`.
 */
const chat_body_validator = z.object({
	/**
	 * The messages to append to the thread.
	 */
	messages: z.array(z.any()),
	/**
	 * Server-allowlisted model.
	 */
	model: z.enum(ai_chat_MODEL_IDS),
	/** Agent mode */
	mode: z.enum(ai_chat_MODE_IDS),
	trigger: z.enum(["submit-message", "regenerate-message"]),
	/**
	 * The id of the message to which the new message should be appended.
	 * `null` means root.
	 */
	parentId: z.string().nullable().optional(),
	/**
	 * The id of the thread to which the new message should be appended.
	 *
	 * `undefined` for new threads.
	 */
	threadId: z.string().optional(),

	/**
	 * The client generated id for a new thread.
	 */
	clientGeneratedThreadId: z.string().optional(),

	/**
	 * Authenticated membership scope.
	 *
	 * Server derives organization/workspace from this membership doc.
	 **/
	membershipId: z.string(),
});

export type ai_chat_http_chat_Body = z.infer<typeof chat_body_validator>;

export async function ai_chat_http_chat(ctx: ActionCtx, request: Request) {
	try {
		const requestParseResult = await server_request_json_parse_and_validate(request, chat_body_validator);

		if (requestParseResult._nay) {
			return {
				status: 400,
				body: requestParseResult._nay,
			} as const;
		}

		const now = Date.now();

		const body = requestParseResult._yay;

		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return {
				status: 401,
				body: {
					message: "Unauthenticated",
				},
			} as const;
		}
		const user = await ctx.runQuery(internal.users.get, {
			userId: userAuth.id,
		});
		if (!user) {
			return {
				status: 401,
				body: {
					message: "Unauthenticated",
				},
			} as const;
		}

		const membership = await ctx.runQuery(api.organizations.get_membership, {
			membershipId: body.membershipId,
		});

		if (!membership) {
			return {
				status: 403,
				body: {
					message: "Unauthorized",
				},
			} as const;
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "ai_chat_http",
			key: membership.userId,
		});
		if (rateLimit) {
			return {
				status: 429,
				body: {
					message: rateLimit.message,
					retryAfterMs: rateLimit.retryAfterMs,
				},
			} as const;
		}

		// In both modes the AI tools read workspace files, and the tools check no permission
		// themselves — this route is their only check — so `content.read` is always needed.
		// Agent mode can also edit files, so it asks for `content.write` too.
		// We ask for both instead of only the stronger one, because a custom role can have
		// write without read. Such a role was already refused later by the `content.read`
		// check inside `thread_get` / `thread_create`, but that answers 400, which looks
		// like a broken request. Checking here lets the route answer 403 itself.
		// We write the names here instead of reusing `THREAD_PERMISSION`: that one guards
		// the thread record, these guard file access, so they must not change together.
		const chatPermissions =
			body.mode === "agent"
				? (["content.read", "content.write"] as const satisfies readonly access_control_Permission[])
				: (["content.read"] as const satisfies readonly access_control_Permission[]);
		for (const permission of chatPermissions) {
			const allowed = await ctx.runQuery(api.access_control.get_current_user_workspace_permission, {
				membershipId: membership._id,
				permission,
			});
			if (!allowed) {
				return {
					status: 403,
					body: {
						message: "Permission denied",
					},
				} as const;
			}
		}

		const tenant = await ctx.runQuery(internal.organizations.get_tenant, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
		});

		if (body.threadId == null && body.clientGeneratedThreadId == null) {
			return {
				status: 400,
				body: {
					message: "One of `threadId` or `clientGeneratedThreadId` is required",
				},
			} as const;
		}
		let threadId: Id<"ai_chat_threads"> | null = null;
		let createdThreadId = null;

		const { systemPrompt, tools, validationTools, activeTools } = build_agent_configuration({
			ctx,
			ctxData: {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				organizationName: tenant.organization.name,
				workspaceName: tenant.workspace.name,
				// Pass the same user id into file tools so pending overlays and file-create audit fields
				// use the identity already accepted by this chat action.
				userId: user._id,
			},
			args: {
				modeId: body.mode,
			},
			getThreadId: () => threadId,
		});

		// Validate the messages if they are present
		if (body.messages.length > 0) {
			try {
				await validateUIMessages<ai_chat_AiSdk5UiMessage>({
					messages: body.messages,
					tools: validationTools,
				});
			} catch (error) {
				if (error instanceof TypeValidationError) {
					return {
						status: 400,
						body: {
							message: "Invalid messages format",
							cause: error == null ? undefined : { message: error instanceof Error ? error.message : String(error) },
						},
					} as const;
				} else {
					const msg = "Failed to validate chat messages";
					should_never_happen(msg, {
						cause: error == null ? undefined : { message: error instanceof Error ? error.message : String(error) },
					});
					return {
						status: 500,
						body: {
							message: msg,
							cause: error == null ? undefined : { message: error instanceof Error ? error.message : String(error) },
						},
					} as const;
				}
			}
		}

		const requestMessages = body.messages as ai_chat_AiSdk5UiMessage[];

		// Enforce the image-attachment contract on incoming messages. The
		// client compresses images to fit, but the caps must hold here too:
		// a file part must be a small base64 data-URL image, because the
		// whole message is stored as one Convex document (~1 MiB limit) and
		// a remote URL must never be forwarded to the model provider.
		for (const requestMessage of requestMessages) {
			const fileParts = requestMessage.parts.filter((part) => part.type === "file");
			const totalUrlChars = fileParts.reduce((total, part) => total + part.url.length, 0);
			const hasInvalidFilePart = fileParts.some(
				(part) =>
					!ai_chat_is_message_image_media_type(part.mediaType) ||
					!part.url.startsWith(`data:${part.mediaType};base64,`),
			);
			if (
				hasInvalidFilePart ||
				fileParts.length > ai_chat_MESSAGE_IMAGE_MAX_COUNT ||
				totalUrlChars > ai_chat_MESSAGE_IMAGE_MAX_TOTAL_URL_CHARS
			) {
				return {
					status: 400,
					body: {
						message: "Invalid image attachments",
					},
				} as const;
			}
		}

		const uiMessages: ai_chat_AiSdk5UiMessage[] = [];

		if (body.threadId) {
			const existingThread = await ctx.runQuery(api.ai_chat.thread_get, {
				membershipId: membership._id,
				threadId: body.threadId,
			});
			if (!existingThread) {
				return {
					status: 400,
					body: {
						message: "Not found",
					},
				} as const;
			}

			threadId = existingThread._id;
		} else {
			if (!body.clientGeneratedThreadId) {
				throw should_never_happen(
					"`body.clientGeneratedThreadId` missing, the request was not properly validated at the top of this handler",
					{
						threadId,
						clientGeneratedThreadId: body.clientGeneratedThreadId,
					},
				);
			}

			if (body.parentId) {
				// A parent id only makes sense after the optimistic thread has been persisted
				// and selected from the live query. Reject instead of resolving optimistic
				// thread ids server-side, which would hide a client sync bug.
				return {
					status: 409,
					body: {
						message: "Message not found.",
					},
				} as const;
			}
		}

		// Check credits after cheap request validation but before any LLM work.
		const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
			userId: user._id,
			organizationId: membership.organizationId,
			minimumRequiredCents: 1,
		});
		if (!creditCheck.hasCredits) {
			return {
				status: 402,
				body: {
					message: "Insufficient funds",
				},
			} as const;
		}
		const billedUser = creditCheck.billedUser;
		if (!billedUser) {
			throw should_never_happen("Organization credit check did not return billed user", {
				userId: user._id,
				organizationId: membership.organizationId,
			});
		}

		if (!threadId) {
			const created = await ctx.runMutation(api.ai_chat.thread_create, {
				membershipId: membership._id,
				// Store the optimistic client thread id on the persisted thread.
				// This lets the frontend dedupe the optimistic entry as soon as the
				// thread appears in `threads_list`, even if the SSE `data-thread-id`
				// mapping arrives slightly later.
				clientGeneratedId: body.clientGeneratedThreadId ?? get_id_generator("ai_thread")(),
				lastMessageAt: now,
			});

			if (created._nay) {
				return {
					status: 400,
					body: {
						message: created._nay.message,
					},
				} as const;
			}

			createdThreadId = threadId = created._yay.threadId;
		}

		// FIX(parentId-race-condition): Track the resolved Convex doc ID for `onFinish` persistence.
		let resolvedParentId: string | null | undefined = body.parentId;
		let resolvedParentClientGeneratedId: string | null = null;

		if (threadId) {
			do {
				const threadMessagesResult = await ctx.runQuery(api.ai_chat.thread_messages_list, {
					threadId: threadId as Id<"ai_chat_threads">,
					membershipId: membership._id,
					order: "asc",
				});

				if (!threadMessagesResult) {
					break;
				}

				// Resolve both Convex ids and client-generated ids. Reject unresolved parents
				// so the UI can wait for sync instead of creating an accidental root branch.
				const parentContext = resolve_parent_message_context({
					messages: threadMessagesResult.messages,
					parentId: body.parentId,
				});
				if (parentContext._nay) {
					console.warn("AI chat parent message id unresolved; rejecting request", {
						threadId,
						parentId: body.parentId,
						unresolvedParentId: parentContext._nay.data.unresolvedParentId,
					});
					return {
						status: 409,
						body: {
							message: parentContext._nay.message,
						},
					} as const;
				}

				resolvedParentId = parentContext._yay.resolvedParentId;
				resolvedParentClientGeneratedId = parentContext._yay.resolvedParentClientGeneratedId;

				for (let i = parentContext._yay.reconstructedMessages.length - 1; i >= 0; i--) {
					const msg = parentContext._yay.reconstructedMessages[i];
					uiMessages.push({
						...(msg.content as any),
						id: msg._id,
					});
				}
			} while (0);
		}

		// Persist user-submitted messages before starting assistant streaming.
		// This keeps edits durable even when the user stops generation.
		if (requestMessages.length > 0) {
			const persistedRequestMessages = await ctx.runMutation(api.ai_chat.thread_messages_add, {
				membershipId: membership._id,
				threadId: threadId as Id<"ai_chat_threads">,
				parentId: resolvedParentId,
				messages: requestMessages.map((message) => ({
					clientGeneratedMessageId: message.id,
					content: message,
				})),
			});

			if (persistedRequestMessages._nay) {
				return {
					status: 403,
					body: {
						message: persistedRequestMessages._nay.message,
					},
				} as const;
			}

			for (let i = 0; i < requestMessages.length; i++) {
				const requestMessage = requestMessages[i];
				const persistedMessageId = persistedRequestMessages._yay.ids[i];
				if (!persistedMessageId) {
					throw should_never_happen("Failed to map request message to persisted message ID", {
						threadId,
						requestMessageId: requestMessage.id,
						index: i,
					});
				}

				uiMessages.push({
					...requestMessage,
					id: persistedMessageId,
				} satisfies ai_chat_AiSdk5UiMessage);
			}

			resolvedParentId = persistedRequestMessages._yay.ids.at(-1) ?? resolvedParentId;
			resolvedParentClientGeneratedId = requestMessages.at(-1)?.id ?? resolvedParentClientGeneratedId;
		}

		const modelMessages = convertToModelMessages(uiMessages, {
			ignoreIncompleteToolCalls: true,
		});

		// The AI SDK routes every URL-shaped file part through its download
		// step, and Convex `fetch` cannot request data: URLs, so the model
		// call would fail with "Failed to download data:...". Decode the
		// image data URLs to bytes here so the provider receives them directly.
		for (const modelMessage of modelMessages) {
			if (modelMessage.role !== "user" || !Array.isArray(modelMessage.content)) {
				continue;
			}
			for (const part of modelMessage.content) {
				if (part.type === "file" && typeof part.data === "string" && part.data.startsWith("data:")) {
					const base64Content = part.data.slice(part.data.indexOf(",") + 1);
					part.data = Uint8Array.from(atob(base64Content), (char) => char.charCodeAt(0));
				}
			}
		}

		let didStreamError = false;
		// Captured by `streamText.onFinish` below so `createUIMessageStream.onFinish`
		// can emit one direct Polar usage event with the actual token cost.
		let capturedUsage: { inputTokens: number; outputTokens: number } | null = null;
		let capturedActualCents = 0;

		const stream = createUIMessageStream<ai_chat_AiSdk5UiMessage>({
			generateId: get_id_generator("ai_message"),
			execute: async ({ writer }) => {
				// TODO(ai-chat): If we allocate Convex message docs up front, emit a transient `data-message-ids`
				// part here (while `writer` is available) so the client can swap optimistic UIMessage ids to
				// Convex ids and/or drop optimistic messages immediately, without persisting client ids in db.
				if (createdThreadId) {
					writer.write({
						type: "data-thread-id",
						data: {
							threadId: createdThreadId,
						},
						transient: true,
					});
				}

				writer.write({
					type: "message-metadata",
					messageMetadata: {
						convexParentId: uiMessages.at(-1)?.id,
						parentClientGeneratedId: resolvedParentClientGeneratedId,
					},
				});

				const result1 = streamText({
					model: openai(body.model),
					system: systemPrompt,
					messages: modelMessages,
					maxOutputTokens: 2000,
					abortSignal: request.signal,
					activeTools,
					experimental_repairToolCall: async (failed) => {
						const lowerToolName = failed.toolCall.toolName.toLowerCase();
						// `Object.hasOwn`, not `in`: `tools` is a plain object, so `in` also finds
						// keys from `Object.prototype`. With `in`, the name `"Constructor"` would
						// be "fixed" to `"constructor"`, which is a built-in function, not a tool.
						if (lowerToolName !== failed.toolCall.toolName && Object.hasOwn(tools, lowerToolName)) {
							return {
								...failed.toolCall,
								toolName: lowerToolName,
							};
						}

						return {
							...failed.toolCall,
							input: JSON.stringify({
								tool: failed.toolCall.toolName,
								error: failed.error.message,
							}),
							toolName: "invalid",
						};
					},
					toolChoice: "auto",
					stopWhen: stepCountIs(10),
					tools,
					onAbort: async () => {
						console.info("streamText.onAbort", {
							threadId,
							parentId: resolvedParentId,
							requestSignalAborted: request.signal.aborted,
						});
					},
					onFinish: async ({ totalUsage }) => {
						// Aggregated across all steps; read by createUIMessageStream.onFinish
						// to emit one response-usage event.
						capturedUsage = {
							inputTokens: totalUsage.inputTokens ?? 0,
							outputTokens: totalUsage.outputTokens ?? 0,
						};
						capturedActualCents += compute_token_usage_cost_cents({
							modelId: body.model,
							inputTokens: capturedUsage.inputTokens,
							outputTokens: capturedUsage.outputTokens,
						});
					},
				});

				const ui_message_stream = result1.toUIMessageStream<ai_chat_AiSdk5UiMessage>();
				writer.merge(ui_message_stream);

				if (request.signal.aborted) {
					return;
				}

				const response1 = await result1.response;

				if (request.signal.aborted) {
					return;
				}

				const thread = await ctx.runQuery(api.ai_chat.thread_get, {
					membershipId: membership._id,
					threadId,
				});
				const existingTitle = typeof thread?.title === "string" ? thread.title.trim() : "";

				// Generate a title for the new thread
				if (thread && !existingTitle) {
					if (request.signal.aborted) {
						return;
					}

					const titleMessages = [...modelMessages, ...response1.messages];
					let titleInputTokens = 0;
					let titleOutputTokens = 0;
					const titleResult = streamText({
						model: openai(TITLE_MODEL_ID),
						system: TITLE_SYSTEM_PROMPT,
						messages: titleMessages,
						stopWhen: stepCountIs(1),
						temperature: 0.3,
						maxOutputTokens: 50,
						abortSignal: request.signal,
						onFinish: async ({ totalUsage }) => {
							// Keep title usage separate from the response event
							titleInputTokens = totalUsage.inputTokens ?? 0;
							titleOutputTokens = totalUsage.outputTokens ?? 0;
						},
					});

					const reader = titleResult.textStream.getReader();
					let title = "";
					while (true) {
						const { value, done } = await reader.read();
						if (done) {
							break;
						}

						if (value) {
							title += value;
						}
					}

					const trimmedTitle = title.trim();
					if (trimmedTitle) {
						writer.write({
							type: "data-chat-title",
							data: { title: trimmedTitle },
							transient: true,
						});

						const threadUpdateResult = await ctx.runMutation(api.ai_chat.thread_update, {
							threadId: thread._id,
							membershipId: membership._id,
							title: trimmedTitle,
						});
						if (threadUpdateResult._nay) {
							console.error("Failed to persist generated title", {
								threadId: thread._id,
								result: threadUpdateResult,
							});
						}
					}

					if (titleInputTokens + titleOutputTokens > 0) {
						await billing_ingest_events(ctx, {
							billedUserEvents: [
								{
									billedUser,
									event: billing_event({
										name: "ai_usage",
										externalCustomerId: billedUser._id,
										externalMemberId: user._id,
										externalId: composite_id(
											"billing",
											"ai_usage",
											billedUser._id,
											user._id,
											membership.organizationId,
											membership.workspaceId,
											String(threadId ?? ""),
											// TODO: Evaluate if this is a good idea to pass "title" as messageId
											"title",
										),
										metadata: {
											amount: compute_token_usage_cost_cents({
												modelId: TITLE_MODEL_ID,
												inputTokens: titleInputTokens,
												outputTokens: titleOutputTokens,
											}),
											actorUserId: user._id,
											billedUserId: billedUser._id,
											organizationId: membership.organizationId,
											workspaceId: membership.workspaceId,
											modelId: TITLE_MODEL_ID,
											inputTokens: titleInputTokens,
											outputTokens: titleOutputTokens,
											threadId: String(threadId ?? ""),
											messageId: "title",
										},
									}),
								},
							],
						});
					}
				}
			},
			onError: (error: unknown) => {
				didStreamError = true;
				console.error("AI chat stream error:", error);
				return error instanceof Error ? error.message : String(error);
			},
			onFinish: async (result) => {
				if (!result.responseMessage) {
					return;
				}

				if (result.isAborted) {
					console.info("onFinish aborted", {
						threadId,
						parentId: resolvedParentId,
						isAborted: result.isAborted,
						didStreamError,
						hasResponseMessage: Boolean(result.responseMessage),
					});
					return;
				}

				if (didStreamError) {
					console.info("onFinish stream error", {
						threadId,
						parentId: resolvedParentId,
						hasResponseMessage: Boolean(result.responseMessage),
					});
					return;
				}

				const capturedInputTokens = capturedUsage?.inputTokens ?? 0;
				const capturedOutputTokens = capturedUsage?.outputTokens ?? 0;
				const capturedTotalTokens = capturedInputTokens + capturedOutputTokens;
				if (capturedTotalTokens > 0) {
					await billing_ingest_events(ctx, {
						billedUserEvents: [
							{
								billedUser,
								event: billing_event({
									name: "ai_usage",
									externalCustomerId: billedUser._id,
									externalMemberId: user._id,
									externalId: composite_id(
										"billing",
										"ai_usage",
										billedUser._id,
										user._id,
										membership.organizationId,
										membership.workspaceId,
										String(threadId ?? ""),
										String(result.responseMessage.id ?? ""),
									),
									metadata: {
										amount: capturedActualCents,
										actorUserId: user._id,
										billedUserId: billedUser._id,
										organizationId: membership.organizationId,
										workspaceId: membership.workspaceId,
										modelId: body.model,
										inputTokens: capturedInputTokens,
										outputTokens: capturedOutputTokens,
										threadId: String(threadId ?? ""),
										messageId: String(result.responseMessage.id ?? ""),
									},
								}),
							},
						],
					});
				}

				// Persist completed assistant responses below the last persisted request message.
				const assistantPersistResult = await ctx.runMutation(api.ai_chat.thread_messages_add, {
					membershipId: membership._id,
					threadId: threadId as Id<"ai_chat_threads">,
					parentId: resolvedParentId,
					messages: [
						{
							clientGeneratedMessageId: result.responseMessage.id,
							content: result.responseMessage,
						},
					],
				});

				if (assistantPersistResult._nay) {
					throw new Error("Failed to persist assistant message", {
						cause: assistantPersistResult._nay,
					});
				}
			},
		});

		return {
			status: 200,
			body: stream,
		} as const;
	} catch (error) {
		const errorMessage = "AI chat stream error";
		console.error(`${errorMessage}:`, error);

		return {
			status: 500,
			body: {
				message: "Internal server error",
				cause: error == null ? undefined : { message: error instanceof Error ? error.message : String(error) },
			},
		} as const;
	}
}

export async function ai_chat_http_chat_response(ctx: ActionCtx, request: Request) {
	// Keep the AI SDK response helper behind the lazy route boundary too.
	const result = await ai_chat_http_chat(ctx, request);

	if (result.status === 200) {
		return createUIMessageStreamResponse({
			status: result.status,
			stream: result.body,
			consumeSseStream: consumeStream,
		});
	}

	return Response.json(result.body, result);
}

/**
 * Keep this in sync with the AI SDK `PrepareSendMessagesRequest` shape used by
 * `AssistantChatTransport.prepareSendMessagesRequest`.
 */
const run_stream_body_validator = z.object({
	/**
	 * Authenticated membership scope.
	 *
	 * Server derives organization/workspace from this membership doc.
	 **/
	membershipId: z.string(),
	thread_id: z.string(),
	assistant_id: z.string(),
	messages: z.array(z.any()),
	response_format: z.string().optional(),
});

export type ai_chat_http_run_stream_Body = z.infer<typeof run_stream_body_validator>;

export async function ai_chat_http_run_stream(ctx: ActionCtx, request: Request) {
	try {
		const requestParseResult = await server_request_json_parse_and_validate(request, run_stream_body_validator);

		if (requestParseResult._nay) {
			return {
				status: 400,
				body: requestParseResult._nay,
			} as const;
		}

		const body = requestParseResult._yay;

		if (body.assistant_id !== "system/thread_title") {
			return {
				status: 400,
				body: {
					message: "Invalid stream ID",
				},
			} as const;
		}

		const membership = await ctx.runQuery(api.organizations.get_membership, {
			membershipId: body.membershipId,
		});

		if (!membership) {
			return {
				status: 403,
				body: {
					message: "Unauthorized",
				},
			} as const;
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "ai_chat_http",
			key: membership.userId,
		});
		if (rateLimit) {
			return {
				status: 429,
				body: {
					message: rateLimit.message,
					retryAfterMs: rateLimit.retryAfterMs,
				},
			} as const;
		}

		// This route only runs the thread titler above. It writes a thread
		// title and never touches a file, so reading is enough.
		const allowed = await ctx.runQuery(api.access_control.get_current_user_workspace_permission, {
			membershipId: membership._id,
			permission: THREAD_PERMISSION,
		});
		if (!allowed) {
			return {
				status: 403,
				body: {
					message: "Permission denied",
				},
			} as const;
		}

		const messages = body.messages || [];
		const thread_id = body.thread_id;

		// Extract conversation text from messages for title generation
		const conversation_text = messages
			.map((msg: any) =>
				[`${msg.role}:`, Array.isArray(msg.content) ? msg.content.map((part: any) => part.text).join(" ") : msg.content]
					.filter(Boolean)
					.join(" "),
			)
			.filter(Boolean)
			.join("\n");

		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) => {
			if (!userAuth) {
				return null;
			}

			return ctx.runQuery(internal.users.get, {
				userId: userAuth.id,
			});
		});
		if (!user) {
			return {
				status: 401,
				body: {
					message: "Unauthenticated",
				},
			} as const;
		}

		// Check credits before title generation. One title per thread; the literal
		// "title" discriminator keeps the usage event id stable across HTTP retries.
		const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
			userId: user._id,
			organizationId: membership.organizationId,
			minimumRequiredCents: 1,
		});
		if (!creditCheck.hasCredits) {
			return {
				status: 402,
				body: { message: "Insufficient funds" },
			} as const;
		}
		const billedUser = creditCheck.billedUser;
		if (!billedUser) {
			throw should_never_happen("Organization credit check did not return billed user", {
				userId: user._id,
				organizationId: membership.organizationId,
			});
		}

		let titleInputTokens = 0;
		let titleOutputTokens = 0;

		// Generate title using AI with streaming
		const result = streamText({
			model: openai(TITLE_MODEL_ID),
			system: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: `Generate a title for this conversation:\n\n${conversation_text}`,
				},
			],
			stopWhen: stepCountIs(1),
			temperature: 0.3,
			maxOutputTokens: 50,
			experimental_transform: smoothStream({
				delayInMs: 100,
			}),
			onFinish: async ({ totalUsage }) => {
				titleInputTokens = totalUsage.inputTokens ?? 0;
				titleOutputTokens = totalUsage.outputTokens ?? 0;
			},
		});

		// Transform the AI stream to properly encode text chunks
		let title = "";

		// Trigger mutation when the stream is finished
		const transform_stream = new TransformStream({
			transform(chunk, controller) {
				title += chunk;
				controller.enqueue(chunk);
			},
			flush: async () => {
				const capturedTotalTokens = titleInputTokens + titleOutputTokens;
				if (capturedTotalTokens > 0) {
					const titleCostCents = compute_token_usage_cost_cents({
						modelId: TITLE_MODEL_ID,
						inputTokens: titleInputTokens,
						outputTokens: titleOutputTokens,
					});
					await billing_ingest_events(ctx, {
						billedUserEvents: [
							{
								billedUser,
								event: billing_event({
									name: "ai_usage",
									externalCustomerId: billedUser._id,
									externalMemberId: user._id,
									externalId: composite_id(
										"billing",
										"ai_usage",
										billedUser._id,
										user._id,
										membership.organizationId,
										membership.workspaceId,
										thread_id,
										// TODO: Evaluate if this is a good idea to pass "title" as messageId
										"title",
									),
									metadata: {
										amount: titleCostCents,
										actorUserId: user._id,
										billedUserId: billedUser._id,
										organizationId: membership.organizationId,
										workspaceId: membership.workspaceId,
										modelId: TITLE_MODEL_ID,
										inputTokens: titleInputTokens,
										outputTokens: titleOutputTokens,
										threadId: thread_id,
										messageId: "title",
									},
								}),
							},
						],
					});
				}

				const trimmedTitle = title.trim();
				if (!trimmedTitle) {
					return;
				}

				const threadUpdateResult = await ctx.runMutation(api.ai_chat.thread_update, {
					membershipId: membership._id,
					threadId: thread_id,
					title: trimmedTitle,
				});

				if (threadUpdateResult._nay) {
					console.error("Failed to persist generated title", {
						threadId: thread_id,
						result: threadUpdateResult,
					});
				}
			},
		});

		// Pipe the AI textStream through the transformer, insprired by ai-sdk's `createTextStreamResponse`
		const stream = result.textStream.pipeThrough(transform_stream).pipeThrough(new TextEncoderStream());

		void result.consumeStream();

		return {
			status: 200,
			body: stream,
		} as const;
	} catch (error) {
		const errorMessage = "Title generation error";
		console.error(`${errorMessage}:`, error);

		return {
			status: 500,
			body: {
				message: errorMessage,
				cause: error == null ? undefined : { message: error instanceof Error ? error.message : String(error) },
			},
		} as const;
	}
}

// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect, vi } = import.meta.vitest;

	type build_agent_configuration_test_user_identity = NonNullable<
		Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>
	>;

	const build_agent_configuration_test_ctx_data = {
		organizationId: "app_organization_test_1" as Id<"organizations">,
		workspaceId: "app_workspace_test_1" as Id<"organizations_workspaces">,
		organizationName: "personal",
		workspaceName: "home",
		userId: "user_1" as Id<"users">,
	} as const;

	const build_agent_configuration_test_user_identity_default = {
		issuer: "https://clerk.test",
		subject: "subject-user-1",
		external_id: "user_1",
		name: "Test User",
	} as unknown as build_agent_configuration_test_user_identity;

	const build_agent_configuration_expected_tool_keys = ["bash", "edit_file", "web_search", "execute_code"] as const;

	const makeCtx = (args?: {
		runQueryImpl?: (...fnArgs: unknown[]) => Promise<unknown>;
		runMutationImpl?: (...fnArgs: unknown[]) => Promise<unknown>;
		userIdentity?: build_agent_configuration_test_user_identity;
	}) => {
		const runQuery = vi.fn(args?.runQueryImpl ?? (async () => null));
		const runMutation = vi.fn(args?.runMutationImpl ?? (async () => null));
		const getUserIdentity = vi.fn(
			async () => args?.userIdentity ?? build_agent_configuration_test_user_identity_default,
		);
		const ctx = {
			runQuery,
			runMutation,
			auth: {
				getUserIdentity,
			},
		} as unknown as ActionCtx;

		return {
			ctx,
			runQuery,
			runMutation,
			getUserIdentity,
		};
	};

	const makeUserMessage = () =>
		({
			id: "message_1",
			role: "user",
			parts: [{ type: "text", text: "stored message" }],
		}) as ai_chat_AiSdk5UiMessage;

	const makeDbMessage = (args: { id: string; parentId?: string | null; clientGeneratedMessageId?: string }) =>
		({
			_id: args.id,
			parentId: args.parentId ?? null,
			clientGeneratedMessageId: args.clientGeneratedMessageId,
			content: makeUserMessage(),
		}) as unknown as Doc<"ai_chat_threads_messages_aisdk_5">;

	describe("resolve_parent_message_context", () => {
		test("resolves client-generated parent ids and reconstructs the parent chain", () => {
			const root = makeDbMessage({ id: "msg_root", clientGeneratedMessageId: "client_root" });
			const child = makeDbMessage({
				id: "msg_child",
				parentId: "msg_root",
				clientGeneratedMessageId: "client_child",
			});

			const result = resolve_parent_message_context({
				messages: [root, child],
				parentId: "client_child",
			});

			expect(result._nay).toBeUndefined();
			const resolved = result._yay;
			expect(resolved).toBeDefined();
			expect(resolved!.reconstructedMessages.map((message) => message._id)).toEqual(["msg_child", "msg_root"]);
			expect(resolved!.resolvedParentId).toBe("msg_child");
			expect(resolved!.resolvedParentClientGeneratedId).toBe("client_child");
		});

		test("returns a bad result for a missing parent id", () => {
			const result = resolve_parent_message_context({
				messages: [makeDbMessage({ id: "msg_root" })],
				parentId: "stale_parent",
			});

			expect(result._yay).toBeUndefined();
			const error = result._nay;
			expect(error).toBeDefined();
			expect(error!.message).toBe("Message not found.");
			expect(error!.data.unresolvedParentId).toBe("stale_parent");
		});
	});

	describe("build_agent_configuration", () => {
		test("returns the tool registry and keeps edit_file active in Agent mode", () => {
			const { ctx } = makeCtx();
			const configuration = build_agent_configuration({
				ctx,
				ctxData: build_agent_configuration_test_ctx_data,
				args: {
					modeId: "agent",
				},
				getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			});

			expect(Object.keys(configuration.tools)).toEqual(build_agent_configuration_expected_tool_keys);
			expect(configuration.activeTools).toEqual(["bash", "edit_file", "web_search", "execute_code"]);
		});

		test("drops write tools from the tool registry itself in Ask mode, not only from activeTools", () => {
			const { ctx } = makeCtx();
			const configuration = build_agent_configuration({
				ctx,
				ctxData: build_agent_configuration_test_ctx_data,
				args: {
					modeId: "ask",
				},
				getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			});

			// The `tools` object is what really matters. `activeTools` only shapes the request sent to
			// the model. The SDK parses and runs a tool call by looking its name up in `tools`, so
			// leaving `edit_file` there would keep it callable in ask mode whatever `activeTools` says.
			expect(Object.keys(configuration.tools)).toEqual(["bash", "web_search", "execute_code"]);
			expect(configuration.activeTools).toEqual(["bash", "web_search", "execute_code"]);
			expect("edit_file" in configuration.tools).toBe(false);

			// The list used to validate messages still holds every tool. It has to accept the
			// `edit_file` parts that an earlier agent-mode turn stored in the same thread.
			expect(Object.keys(configuration.validationTools)).toEqual(build_agent_configuration_expected_tool_keys);
		});

		test("accepts a historical execute_code tool part when validating stored UI messages", async () => {
			const { ctx } = makeCtx();
			const configuration = build_agent_configuration({
				ctx,
				ctxData: build_agent_configuration_test_ctx_data,
				args: {
					modeId: "agent",
				},
				getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			});

			const message = {
				id: "message_exec_1",
				role: "assistant",
				parts: [
					{
						type: "tool-execute_code",
						toolCallId: "call_exec_1",
						state: "output-available",
						input: { code: "return input.n * 2;", input: { n: 2 } },
						output: {
							title: "Execute code",
							output: "Result: 4",
							metadata: {
								executionId: "exec_1",
								status: "succeeded",
								elapsedMs: 3,
								resultTruncated: false,
								logsTruncated: false,
							},
						},
					},
				],
			} as unknown as ai_chat_AiSdk5UiMessage;

			await expect(
				validateUIMessages<ai_chat_AiSdk5UiMessage>({ messages: [message], tools: configuration.validationTools }),
			).resolves.toBeDefined();
		});

		test("still validates a stored edit_file part after the thread is reopened in Ask mode", async () => {
			const { ctx } = makeCtx();
			const configuration = build_agent_configuration({
				ctx,
				ctxData: build_agent_configuration_test_ctx_data,
				args: {
					modeId: "ask",
				},
				getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			});

			// Ask mode cannot call `edit_file`, but an earlier agent-mode turn in the same thread may
			// have stored one. If we validated against the callable tools instead of the full list, that
			// old message would be rejected and the request would fail with "Invalid messages format".
			const message = {
				id: "message_edit_file_history",
				role: "assistant",
				parts: [
					{
						type: "tool-edit_file",
						toolCallId: "call_edit_file_history",
						state: "output-available",
						input: { path: "/notes.md", oldString: "before", newString: "after" },
						output: { ok: true },
					},
				],
			} as unknown as ai_chat_AiSdk5UiMessage;

			await expect(
				validateUIMessages<ai_chat_AiSdk5UiMessage>({ messages: [message], tools: configuration.validationTools }),
			).resolves.toBeDefined();
		});

		test("appends the Ask mode instruction to the system prompt", () => {
			const { ctx } = makeCtx();
			const configuration = build_agent_configuration({
				ctx,
				ctxData: build_agent_configuration_test_ctx_data,
				args: {
					modeId: "ask",
				},
				getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			});

			expect(configuration.systemPrompt).toContain(
				"Ask mode is for reading, searching, and answering. Durable folder and file changes are handled in Agent mode; /tmp scratch is durable per chat thread but is not app file storage.",
			);
		});

		test("describes bash as the app file shell without synonym rules", () => {
			const { ctx } = makeCtx();
			const configuration = build_agent_configuration({
				ctx,
				ctxData: build_agent_configuration_test_ctx_data,
				args: {
					modeId: "agent",
				},
				getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			});

			// The model receives the system prompt and the tool descriptions together, so assert
			// the durable guidance survives somewhere in that combined surface instead of pinning
			// it to whichever part currently carries it. Backticks are normalized away because
			// tool descriptions are plain text while the system prompt uses markdown.
			const agentSurface = [
				configuration.systemPrompt,
				configuration.validationTools.bash.description,
				configuration.validationTools.edit_file.description,
			]
				.join("\n")
				.replaceAll("`", "");

			expect(agentSurface).toContain(
				"Bash starts in the current workspace path at ~/w/personal/home (/home/cloud-usr/w/personal/home). ~ is /home/cloud-usr, the app mount is /home/cloud-usr/w, and /tmp is durable scratch scoped to this chat thread.",
			);
			expect(agentSurface).toContain(
				"/tmp persists across Bash calls in this chat and reloads from Convex if the warm backend runtime cache is gone.",
			);
			expect(agentSurface).toContain(
				"It is not shared with new chats and is not app file storage; use app file tools for durable user-visible files.",
			);
			expect(agentSurface).toContain(
				"Do not call /tmp ephemeral or temporary in a way that implies same-chat data loss.",
			);
			expect(agentSurface).toContain("that is expected evidence of per-chat isolation, not a global Bash failure.");
			expect(agentSurface).toContain(
				"Bash cwd persists across tool calls in the same chat. If the previous Bash output already shows the desired cwd, use bare or relative commands instead of repeating cd.",
			);
			expect(agentSurface).toContain(
				"/tmp has the safe Just Bash native-style scratch command surface, while app files are db-backed and do not have full POSIX/GNU filesystem semantics",
			);
			expect(agentSurface).toContain("Do not describe them as global Bash limitations.");
			expect(agentSurface).toContain(
				"If a command touches only /tmp or stdin, use normal scratch commands; if it touches the app mount, use the app-aware command forms below.",
			);
			expect(agentSurface).toContain(
				"Native-style /tmp commands use Just Bash's own argument parsing and include safe text/file utilities such as du, diff, rg, jq, base64, sha256sum, nl, rev, and tac; the Unix file command is intentionally unavailable.",
			);
			expect(agentSurface).toContain(
				"If file fails or the user asks for it, do not stop after reporting that it is unavailable",
			);
			expect(agentSurface).toContain("/tmp native commands are Just Bash browser commands, not host GNU coreutils.");
			expect(agentSurface).toContain(
				"if a /tmp option fails but the command is useful, retry once with simpler native syntax.",
			);
			expect(agentSurface).toContain(
				"When retrying a /tmp command option, prefer doing related scratch work in one call when convenient",
			);
			expect(agentSurface).toContain(
				"When reporting Bash results, treat app-only flags such as --limit, --cursor, --path-query, and --extension as supported app Bash syntax",
			);
			expect(agentSurface).toContain(
				"Printed Next page commands use short cursor ids without an @ prefix; run the exact printed command to continue.",
			);
			expect(agentSurface).toContain(
				"If the user asks for exactly one continuation, one continuation, or one next page, run only the first printed continuation",
			);
			expect(agentSurface).toContain(
				"If the user asked for continuations from multiple commands, continue each requested command before summarizing.",
			);
			expect(agentSurface).toContain(
				"When a user names an app-root path like /docs, run it as /home/cloud-usr/w/personal/home/docs",
			);
			expect(agentSurface).toContain(
				"If a failed Bash command prints a Try: command that directly matches the user's request",
			);
			expect(agentSurface).toContain(
				"Shell pathname expansion works for /tmp scratch paths. General app-file and mount glob operands such as src/**/*.ts, foo?.txt, and [abc].md are unsupported",
			);
			expect(agentSurface).toContain("Use find <path> --extension md -type f for exact indexed extension search");
			expect(agentSurface).toContain(
				"ls --limit and find --limit are app-file pagination commands. Relative paths resolve against the current working directory.",
			);
			expect(agentSurface).toContain(
				"When listing the current directory, prefer ls --limit N over ls --limit N <current-cwd>.",
			);
			expect(agentSurface).toContain(
				"Content-vs-path rule: use search for text inside files, and use find only for path/name discovery.",
			);
			expect(agentSurface).toContain(
				"For recursive grep requests over an app folder, the first Bash command should be search --path <folder> <content terms>",
			);
			expect(agentSurface).toContain("do not run ls first to verify that folder");
			expect(agentSurface).toContain('Plain requests like "search for X with limit N" mean content search');
			expect(agentSurface).toContain(
				'If the user says "search for the X file", "find the X file", "file named X", or "path/name contains X", use find.',
			);
			expect(agentSurface).toContain("run search --path <folder> X or search X; do not substitute find --path-query.");
			expect(agentSurface).toContain(
				"For search --path and meta search --path, the same app-root path rule applies: pass /home/cloud-usr/w/personal/home/folder or relative folder, never raw /folder.",
			);
			expect(agentSurface).toContain(
				"Use ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...] for app listings. Bare ls --limit N lists the current directory.",
			);
			expect(agentSurface).toContain(
				"ls -t (newest first) and ls -rt (oldest first) without PATH list the whole workspace ordered by update time",
			);
			expect(agentSurface).toContain("bare ls -t is still workspace-wide");
			expect(agentSurface).toContain("ls -R lists a paginated subtree as full app shell paths");
			expect(agentSurface).toContain("when the user asks for tree-shaped output, use tree, not ls -R");
			expect(agentSurface).toContain(
				"Use find -name QUERY or find --path-query QUERY only for indexed app-file path/name word search",
			);
			expect(agentSurface).toContain('Prefer --path-query QUERY for natural "path/name contains QUERY" requests');
			expect(agentSurface).toContain(
				"For regex path requests against app files, say regex is unsupported and use token search when a plain token is obvious",
			);
			expect(agentSurface).toContain("Use find <path> --extension md -type f");
			expect(agentSurface).toContain(
				"find --prefix <prefix> --limit N [--cursor CURSOR] for a folder-boundary subtree scan",
			);
			expect(agentSurface).toContain("sibling-prefix paths such as /docs-archive are excluded from /docs");
			expect(agentSurface).toContain("find searches app paths/names only, not file content.");
			expect(agentSurface).toContain(
				"find -maxdepth N and find -mindepth N filter non-search app subtree results by depth.",
			);
			expect(agentSurface).toContain("When asked for app files under a folder, include -type f");
			expect(agentSurface).toContain("find -type f and find -type d restrict app results to files or folders.");
			expect(agentSurface).toContain(
				"General glob/regex patterns and GNU find extensions such as -printf, -mtime, -newer, -exec, and -ok are not supported for app paths",
			);
			expect(agentSurface).toContain(
				"Use search [--limit N] [--cursor CURSOR] <content terms...> for full-text content search",
			);
			expect(agentSurface).toContain("Pass one distinctive word or a few plain terms");
			expect(agentSurface).toContain(
				'For requests like "where does X appear" or "which files mention X", run search first',
			);
			expect(agentSurface).toContain(
				"For recursive grep, grep -R, or rg wording over an app folder, do not try native rg or multi-file grep first",
			);
			expect(agentSurface).toContain("do not substitute find, which only searches paths/names");
			expect(agentSurface).toContain("it is not regex, glob, path/name search, or exact grep");
			expect(agentSurface).toContain("broad folder scopes with common terms can be heavier");
			expect(agentSurface).toContain("bare search scopes to that cwd");
			expect(agentSurface).toContain("Use exact app paths with cat [-n] [--] [FILE...], head, tail, wc, and stat");
			expect(agentSurface).toContain("cat unreadable-file advisories are stderr, not file content");
			expect(agentSurface).toContain("Uploaded source files do not alias to generated Markdown outputs.");
			expect(agentSurface).toContain("read the exact generated output path when the user wants converted text");
			expect(agentSurface).toContain("these readers fetch at most 10 app files per command");
			expect(agentSurface).toContain("accepts multiple files (per-file counts plus a total)");
			expect(agentSurface).toContain("Large files are not read inline");
			expect(agentSurface).toContain(`up to ${files_READ_RANGE_MAX_LINES} lines per read`);
			expect(agentSurface).toContain(
				"Simple grep -R PATTERN <app-folder> is recovered through indexed full-text search",
			);
			expect(agentSurface).toContain("grep [-n] [-i] [-F] PATTERN <file>");
			expect(agentSurface).toContain("regex by default; -F/--fixed-strings uses literal substring matching");
			expect(agentSurface).toContain("textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file>");
			expect(agentSurface).toContain("For rendered plain-text chunk scans");
			expect(agentSurface).toContain("not exact recursive regex/fixed-string grep");
			expect(agentSurface).toContain("Single-file textgrep has no line numbers or context flags");
			expect(agentSurface).toContain(
				"for one app file (regex by default; -F/--fixed-strings uses literal substring matching; -v inverts; -c counts; -l prints the path if matched)",
			);
			expect(agentSurface).toContain("Use tree [PATH] [--limit N] [--cursor CURSOR] for paginated app tree shape");
			expect(agentSurface).toContain("also -c count, -l list-if-matched, -v invert, and -A/-B/-C N context.");
			expect(agentSurface).toContain("When using bash -c or sh -c to compare /tmp and app-mount behavior");
			expect(agentSurface).toContain("For xargs path checks, print pathnames into xargs");
			expect(agentSurface).toContain("avoid strict-mode boilerplate such as set -euo pipefail");
			expect(agentSurface).toContain("pipefail is unsupported");
			expect(agentSurface).toContain(
				"For multi-command inspection or eval checks, do not use set -e or hide stderr with 2>/dev/null",
			);
			expect(agentSurface).toContain("Only summarize actual Bash stdout/stderr");
			expect(agentSurface).toContain(
				"The blank line between the shell prompt and output is transcript formatting, not file content.",
			);
			expect(agentSurface).toContain("mv <app-path> <app-path> proposes a pending move/rename (one source only)");
			expect(agentSurface).toContain(
				"If copying a path from bash, remove the /home/cloud-usr/w/<organization>/<workspace> current workspace path prefix before passing it here.",
			);
			expect(agentSurface).toContain(
				"create or overwrite a file with a quoted heredoc (cat > '<path>' <<'EOF' ... EOF) or a redirect",
			);
			expect(agentSurface).toContain("never /README.md");
			expect(agentSurface).not.toContain("convenience mount root");
			expect(agentSurface).not.toContain('words like "files"');
			expect(agentSurface).not.toContain("Do not answer file-listing");
		});

		test("keeps the returned tool keys aligned with the current runtime registry", () => {
			const { ctx } = makeCtx();
			const configuration = build_agent_configuration({
				ctx,
				ctxData: build_agent_configuration_test_ctx_data,
				args: {
					modeId: "agent",
				},
				getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			});

			expect(Object.keys(configuration.tools)).toEqual(build_agent_configuration_expected_tool_keys);
		});
	});
}
