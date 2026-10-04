import { defineCommand, type Command } from "just-bash/browser";
import { z } from "zod";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import {
	channels_render_file_mentions,
	channels_render_file_quotes,
	channels_render_people_mentions,
	channels_search_query_schema,
} from "../shared/channels.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_parse_limit,
	bash_read_option_value,
	bash_resolve_path,
	bash_resolve_db_files_shell_path,
	bash_db_files_path_to_current_workspace_path,
	bash_shell_arg_quote,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const USAGE =
	"Usage: channels ls [--kind public|private|direct|file]\n" +
	"Usage: channels members <reference>\n" +
	"Usage: channels read <reference> [--since DATE] [--until DATE] [--thread ROOT_ID] [--format text|json]\n" +
	"Usage: channels search <words> [--in reference] [--from USER_ID] [--attachments true|false] [--since DATE] [--until DATE] [--format text|json]\n" +
	"All commands: [--workspace current|home] [--limit 1..50] [--cursor CURSOR]\n";
const date_schema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const cursor_schema = z.object({ key: z.string(), cursor: z.string() });

// Command keeps the generated API from inferring this handler through the Bash action.
export function bash_channels_command_create(ctx: ActionCtx, roots: bash_DbFilesRoots): Command {
	return defineCommand("channels", async (args, commandCtx) => {
		const fail = (message: string, usage = false) => ({
			stdout: "",
			stderr: `channels: ${message}\n${usage ? USAGE : ""}`,
			exitCode: usage ? bash_COMMAND_EXIT_USAGE : bash_COMMAND_EXIT_FAILURE,
		});
		const command = args[0];
		if (command === "--help") return { stdout: USAGE, stderr: "", exitCode: 0 };
		if (command !== "ls" && command !== "read" && command !== "members" && command !== "search")
			return fail("Choose ls, read, members, or search", true);
		const options: Record<string, string> = {};
		let reference: string | undefined;
		const words: string[] = [];
		const allowed = new Set([
			"workspace",
			"limit",
			"cursor",
			...(command === "ls" ? ["kind"] : []),
			...(command === "read" ? ["since", "until", "thread", "format"] : []),
			...(command === "search" ? ["in", "from", "attachments", "since", "until", "format"] : []),
		]);
		for (let index = 1; index < args.length; index++) {
			const arg = args[index];
			if (!arg.startsWith("--")) {
				if (command === "search") {
					words.push(arg);
					continue;
				}
				if (command === "ls" || reference !== undefined) return fail(`Unexpected argument ${arg}`, true);
				reference = arg;
				continue;
			}
			const equals = arg.indexOf("=");
			const name = arg.slice(2, equals === -1 ? undefined : equals);
			if (!allowed.has(name) || name in options) return fail(`Invalid option --${name}`, true);
			if (equals !== -1) options[name] = arg.slice(equals + 1);
			else {
				const value = bash_read_option_value("channels", args, index, arg);
				if (value._nay) return fail(value._nay.message, true);
				options[name] = value._yay.value;
				index++;
			}
		}
		if (command === "search") reference = options.in;
		if ((command === "read" || command === "members") && !reference) return fail("Missing channel reference", true);
		const searchQuery = command === "search" ? channels_search_query_schema.safeParse(words.join(" ")) : null;
		if (searchQuery && !searchQuery.success) return fail(searchQuery.error.issues[0]!.message, true);
		if (options.attachments !== undefined && options.attachments !== "true" && options.attachments !== "false")
			return fail("Attachments must be true or false", true);
		if (options.workspace && options.workspace !== "current" && options.workspace !== "home")
			return fail("Workspace must be current or home", true);
		const kind = z.enum(["public", "private", "direct", "file"]).optional().safeParse(options.kind);
		if (!kind.success) return fail("Kind must be public, private, direct, or file", true);
		if (options.format && options.format !== "text" && options.format !== "json")
			return fail("Format must be text or json", true);
		const limit = bash_parse_limit({ command: "channels", value: options.limit, defaultLimit: 20, maxLimit: 50 });
		if (limit._nay) return fail(limit._nay.message, true);
		const dates: { since?: number; until?: number } = {};
		for (const name of ["since", "until"] as const) {
			if (options[name] === undefined) continue;
			if (!date_schema.safeParse(options[name]).success)
				return fail(`--${name} needs YYYY-MM-DD or a full ISO date`, true);
			dates[name] = Date.parse(options[name]);
		}
		if (dates.since !== undefined && dates.until !== undefined && dates.since >= dates.until)
			return fail("Since must be before until", true);
		let root = options.workspace === "home" ? (roots.personal ?? roots.app) : roots.app;
		let target: FunctionArgs<typeof internal.channels_messages.agent_read>["reference"] = {
			kind: "channel",
			value: reference ?? "",
		};
		if (reference?.startsWith("#")) target = { kind: "public", value: reference.slice(1) };
		else if (reference?.startsWith("file:")) {
			const file = reference.slice(5);
			if (!file) return fail("Missing file reference", true);
			if (!file.includes("/")) target = { kind: "file_id", value: file };
			else {
				const resolved = bash_resolve_db_files_shell_path(bash_resolve_path(commandCtx.cwd, file), roots);
				if (resolved.kind !== "app" || resolved.dbFilesPath === null) return fail("Not found");
				const fileRoot = [roots.app, roots.personal].find((item) => item?.fs === resolved.fs);
				if (!fileRoot || (options.workspace && fileRoot !== root)) return fail("Not found");
				root = fileRoot;
				target = { kind: "file_path", value: resolved.dbFilesPath };
			}
		} else if (reference?.includes(":")) {
			try {
				const url = new URL(reference);
				const match = /^\/w\/([^/]+)\/([^/]+)\/messages\/([^/]+)$/u.exec(url.pathname);
				if (!match || (url.protocol !== "http:" && url.protocol !== "https:"))
					return fail("Expected a Messages app URL", true);
				const urlRoot = [roots.app, roots.personal].find(
					(item) =>
						item &&
						item.fs.ctxData.organizationName === decodeURIComponent(match[1]) &&
						item.fs.ctxData.workspaceName === decodeURIComponent(match[2]),
				);
				if (!urlRoot || (options.workspace && root !== urlRoot)) return fail("Not found");
				root = urlRoot;
				target = { kind: "channel", value: decodeURIComponent(match[3]) };
			} catch {
				return fail("Invalid Messages app URL", true);
			}
		}
		const source = root.fs.ctxData.agentSource;
		if (!source || !root.fs.writeScope) return fail("An active workspace chat is required");
		const resolved = (await ctx.runQuery(internal.ai_chat_workspaces.resolve, {
			source,
			workspace: root.fs.ctxData.workspaceId === source.workspaceId ? "current" : "personal",
		})) as FunctionReturnType<typeof internal.ai_chat_workspaces.resolve>;
		if (resolved._nay) return fail(resolved._nay.message);
		const common = { userId: source.userId, membershipId: resolved._yay.membershipId, agentSource: source };
		const key = JSON.stringify({
			command,
			userId: source.userId,
			threadId: source.threadId,
			lifetime: source.membershipLifetime,
			workspaceId: resolved._yay.workspaceId,
			target,
			kind: kind.data,
			...dates,
			thread: options.thread,
			query: searchQuery?.success ? searchQuery.data : undefined,
			authorUserId: options.from,
			hasAttachments: options.attachments === undefined ? undefined : options.attachments === "true",
			limit: limit._yay,
		});
		let cursor: string | null = null;
		if (options.cursor) {
			const stored = await bash_cursor_id_resolve(ctx, options.cursor);
			if (stored._nay) return fail(stored._nay.message);
			let value: unknown;
			try {
				value = JSON.parse(stored._yay);
			} catch {
				return fail("Invalid cursor. Run the command again.");
			}
			const parsed = cursor_schema.safeParse(value);
			if (!parsed.success || parsed.data.key !== key)
				return fail("Cursor belongs to another command. Run this command again.");
			cursor = parsed.data.cursor;
		}
		const paginationOpts = { numItems: limit._yay, cursor };
		const result =
			command === "ls"
				? await ctx.runQuery(internal.channels_messages.agent_list, { ...common, kind: kind.data, paginationOpts })
				: command === "search"
					? await ctx.runQuery(internal.channels_messages.agent_search, {
							...common,
							query: searchQuery?.success ? searchQuery.data : "",
							reference: reference ? target : undefined,
							authorUserId: options.from,
							hasAttachments: options.attachments === undefined ? undefined : options.attachments === "true",
							...dates,
							paginationOpts,
						})
					: command === "members"
						? await ctx.runQuery(internal.channels_messages.agent_members, {
								...common,
								reference: target,
								paginationOpts,
							})
						: await ctx.runQuery(internal.channels_messages.agent_read, {
								...common,
								reference: target,
								...dates,
								rootMessageId: options.thread,
								paginationOpts,
							});
		if (result._nay) return fail(result._nay.message);
		const page = result._yay;
		const nextCursor = page.isDone
			? null
			: await bash_cursor_id_create(ctx, JSON.stringify({ key, cursor: page.continueCursor }));
		const next = nextCursor
			? `Next page: channels ${args
					.filter((arg, index) => arg !== "--cursor" && args[index - 1] !== "--cursor" && !arg.startsWith("--cursor="))
					.map(bash_shell_arg_quote)
					.join(" ")} --cursor ${bash_shell_arg_quote(nextCursor)}\n`
			: "";
		if ((command === "read" || command === "search") && options.format === "json")
			return { stdout: `${JSON.stringify({ messages: page.page, nextCursor })}\n`, stderr: "", exitCode: 0 };
		const lines = page.page.map((item) => {
			if ("channelId" in item) {
				const path = item.filePath
					? bash_db_files_path_to_current_workspace_path(root.currentWorkspacePath, item.filePath)
					: null;
				return `${item.channelId}\t${path ? `file:${path}` : item.reference}\t${item.kind}\t${path ?? item.name}\t${item.lastMessageAt ? new Date(item.lastMessageAt).toISOString() : "no messages"}`;
			}
			if ("userId" in item) return `${item.userId}\t${item.name}`;
			const message = item.message;
			return [
				...(command === "search" ? [`channel: ${message.channelId}`] : []),
				`[${new Date(message._creationTime).toISOString().slice(0, 16).replace("T", " ")} UTC] ${item.authorName} <${message._id}>${message.threadRootId ? ` (in thread ${message.threadRootId})` : ""}`,
				...(message.replyTo
					? [`↳ reply to ${message.replyTo.messageId}: ${JSON.stringify(item.replyPreview?.excerpt ?? "")}`]
					: []),
				...(item.thread
					? [`thread: ${item.thread.replyCount} replies${item.thread.isResolved ? " (resolved)" : ""}`]
					: []),
				channels_render_file_quotes(
					channels_render_file_mentions(
						channels_render_people_mentions(message.body, item.mentionNames),
						item.fileMentions.map((file) => (file.kind === "file" ? file : null)),
					),
					message.fileQuotes,
				),
				...item.attachments.map((attachment) =>
					attachment.kind === "file"
						? `attachment: ${attachment.name} (${bash_db_files_path_to_current_workspace_path(root.currentWorkspacePath, attachment.path)})`
						: attachment.kind === "upload"
							? `attachment: ${attachment.name} (upload:${attachment.uploadId})`
							: "attachment: unavailable",
				),
				"",
			].join("\n");
		});
		return { stdout: `${lines.join("\n")}${lines.length ? "\n" : ""}${next}`, stderr: "", exitCode: 0 };
	});
}
