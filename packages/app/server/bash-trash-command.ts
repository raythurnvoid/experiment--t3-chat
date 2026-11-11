import { defineCommand, type Command } from "just-bash/browser";
import { z } from "zod";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { files_archive_operation_id_time, type files_SavedStream } from "../shared/files.ts";
import { files_trash_areas_merge_page } from "./files-trash-areas.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_DbFilesPermissionDeniedError,
	bash_db_files_path_to_current_workspace_path,
	bash_is_path_under,
	bash_is_path_under_read_only_mounts,
	bash_parse_limit,
	bash_read_option_value,
	bash_resolve_db_files_shell_path,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_TMP_MOUNT,
	type bash_DbFilesRoot,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const USAGE =
	"Usage: trash [ls] [AREA_PATH] [--format text|json]\n" +
	"Usage: trash ls --in ID [--format text|json]\n" +
	"Usage: trash areas [--format text|json]\n" +
	"Usage: trash restore PATH... | --id ID...   (Agent mode)\n" +
	"All commands: [--workspace current|home] [--limit 1..50] [--cursor CURSOR]\n" +
	"Rows: time, kind, deleted by, id, path. Your own rm shows as (pending delete) until the user saves it,\n" +
	"or (pending delete, now in Trash) when a saved delete already moved the item to Trash.\n" +
	"trash restore undoes your own pending delete. Restoring a saved Trash item is not available yet.\n";
const GUEST_MESSAGE =
	"Permission denied. Guests have no Trash view. A workspace member can do this, or ask for workspace access.";
const cursor_schema = z.object({
	key: z.string(),
	stream: z.enum(["pending", "saved", "children", "areas"]),
	cursor: z.string().nullable(),
	afterKey: z.unknown(),
});
const children_key_schema = z.object({ kind: z.enum(["file", "folder"]), name: z.string() }).nullable();
const area_key_schema = z.object({ treePath: z.string(), nodeId: z.string() }).nullable();

const JOB_LABELS = { archive: "moving to Trash", restore: "restoring", purge: "deleting permanently" } as const;

type Item = {
	id: string | null;
	nodeId: Id<"files_nodes"> | null;
	pending: "draft" | "in_trash" | null;
	time: number | null;
	kind: "file" | "folder";
	changedBy: string | null;
	path: string;
	locked: boolean;
	job: { kind: keyof typeof JOB_LABELS; activityId: Id<"activities"> | null } | null;
};

function item_line(item: Item) {
	const marks = [
		...(item.pending === "draft" ? [" (pending delete)"] : []),
		...(item.pending === "in_trash" ? [" (pending delete, now in Trash)"] : []),
		...(item.locked ? [" (locked)"] : []),
		...(item.job
			? [` (${JOB_LABELS[item.job.kind]}${item.job.activityId ? `: Activity ${item.job.activityId}` : ""})`]
			: []),
	];
	return [
		item.time === null ? "-" : `${new Date(item.time).toISOString().slice(0, 16).replace("T", " ")} UTC`,
		item.kind,
		item.changedBy ?? "-",
		item.id ?? "-",
		`${item.path}${item.kind === "folder" && item.path !== "/" ? "/" : ""}${marks.join("")}`,
	].join("\t");
}

/**
 * The agent's view of the Trash: list an area, look inside a deleted folder, list the areas, and undo its
 * own draft deletes. Reads use the app's Trash view rules (`convex/files_trash_agent.ts`).
 */
// Command keeps the generated API from inferring this handler through the Bash action.
export function bash_trash_command_create(ctx: ActionCtx, roots: bash_DbFilesRoots): Command {
	return defineCommand("trash", async (args, commandCtx) => {
		const fail = (message: string, usage = false) => ({
			stdout: "",
			stderr: `trash: ${message}\n${usage ? USAGE : ""}`,
			exitCode: usage ? bash_COMMAND_EXIT_USAGE : bash_COMMAND_EXIT_FAILURE,
		});
		if (args[0] === "--help") return { stdout: USAGE, stderr: "", exitCode: 0 };

		const first = args[0];
		if (first === "rm")
			return fail(
				"to move an item to Trash, use rm (rm -r for a folder). Deleting items in Trash permanently is not available yet.",
				true,
			);
		if (first === "purge" || first === "empty") return fail(`${first} is not available yet.`, true);
		// Bare `trash` and `trash PATH` list, like `trash ls`.
		const command = first === "ls" || first === "list" ? "ls" : first === "areas" || first === "restore" ? first : null;
		const rest = command === null ? args : args.slice(1);

		const options: Record<string, string> = {};
		const ids: string[] = [];
		const operands: string[] = [];
		const allowed = new Set([
			"workspace",
			"limit",
			"cursor",
			...(command === "restore" ? ["id"] : ["format"]),
			...(command !== "restore" && command !== "areas" ? ["in"] : []),
		]);
		for (let index = 0; index < rest.length; index++) {
			const arg = rest[index];
			if (!arg.startsWith("--")) {
				operands.push(arg);
				continue;
			}
			const equals = arg.indexOf("=");
			const name = arg.slice(2, equals === -1 ? undefined : equals);
			if (!allowed.has(name) || (name in options && name !== "id")) return fail(`Invalid option --${name}`, true);
			let value: string;
			if (equals !== -1) value = arg.slice(equals + 1);
			else {
				const read = bash_read_option_value("trash", rest, index, arg);
				if (read._nay) return fail(read._nay.message, true);
				value = read._yay.value;
				index++;
			}
			if (name === "id") ids.push(value);
			else options[name] = value;
		}
		if (options.workspace && options.workspace !== "current" && options.workspace !== "home")
			return fail("Workspace must be current or home", true);
		if (options.format && options.format !== "text" && options.format !== "json")
			return fail("Format must be text or json", true);
		const limit = bash_parse_limit({ command: "trash", value: options.limit, defaultLimit: 50, maxLimit: 50 });
		if (limit._nay) return fail(limit._nay.message, true);
		if (command === "areas" && operands.length > 0) return fail(`Unexpected argument ${operands[0]}`, true);
		if (command !== "restore" && command !== "areas" && operands.length + (options.in ? 1 : 0) > 1)
			return fail(`Unexpected argument ${operands.at(-1)}`, true);
		if (command === "restore" && operands.length === 0 && ids.length === 0)
			return fail("Missing PATH or --id ID", true);

		// A PATH picks the workspace that holds it. Without one: --workspace, else the shell's folder.
		const optionRoot =
			options.workspace === "home" ? (roots.personal ?? roots.app) : options.workspace ? roots.app : null;
		const cwd = bash_resolve_db_files_shell_path(commandCtx.cwd, roots);
		const cwdRoot = cwd.kind === "app" ? [roots.app, roots.personal].find((item) => item?.fs === cwd.fs) : undefined;
		const paths: Array<{ operand: string; root: bash_DbFilesRoot; dbFilesPath: string }> = [];
		for (const operand of operands) {
			const shellPath = bash_resolve_path(commandCtx.cwd, operand);
			const resolved = bash_resolve_db_files_shell_path(shellPath, roots);
			const root = [roots.app, roots.personal].find((item) => item?.fs === resolved.fs);
			if (resolved.kind !== "app" || resolved.dbFilesPath === null || !root) {
				if (bash_is_path_under(bash_TMP_MOUNT, shellPath))
					return fail(`${bash_TMP_MOUNT} has no Trash. rm in ${bash_TMP_MOUNT} deletes for good.`);
				if (bash_is_path_under_read_only_mounts(shellPath)) return fail(`'${operand}' is read-only and has no Trash.`);
				return fail(`cannot open '${operand}': No such file or directory`);
			}
			paths.push({ operand, root, dbFilesPath: resolved.dbFilesPath });
		}
		const root = paths[0]?.root ?? optionRoot ?? cwdRoot ?? roots.app;
		if (paths.some((item) => item.root !== root) || (optionRoot && optionRoot !== root))
			return fail("all paths must be in one workspace.", true);

		const source = root.fs.ctxData.agentSource;
		if (!source || !root.fs.writeScope) return fail("An active workspace chat is required");
		if (command === "restore" && !root.fs.allowDbFilesMkdir)
			return fail("restore is available in Agent mode. Ask mode is read-only for app files.");
		const resolved = (await ctx.runQuery(internal.ai_chat_workspaces.resolve, {
			source,
			workspace: root.fs.ctxData.workspaceId === source.workspaceId ? "current" : "personal",
		})) as FunctionReturnType<typeof internal.ai_chat_workspaces.resolve>;
		if (resolved._nay) return fail(resolved._nay.message);
		const { organizationId, workspaceId, membershipId } = resolved._yay;
		const common = { userId: source.userId, membershipId, agentSource: source };
		const render = (dbFilesPath: string) =>
			bash_db_files_path_to_current_workspace_path(root.currentWorkspacePath, dbFilesPath);

		if (command === "restore") {
			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			const items = [
				...paths.map((item) => ({ operand: item.operand, item: { path: item.dbFilesPath } })),
				...ids.map((id) => ({ operand: id, id })),
			];
			for (const entry of items) {
				let item: { path: string } | { nodeId: string };
				if ("id" in entry) {
					const separator = entry.id.lastIndexOf(":");
					const nodeId = entry.id.slice(0, separator);
					if (separator <= 0) {
						stderr += `trash: '${entry.id}' is not a Trash id. Copy the id column of trash ls.\n`;
						exitCode = bash_COMMAND_EXIT_FAILURE;
						continue;
					}
					if (entry.id.slice(separator + 1) !== "pending") {
						stderr += `trash: cannot restore '${entry.id}': restoring a saved Trash item is not available yet. Ask the user to restore it in Files (Trash).\n`;
						exitCode = bash_COMMAND_EXIT_FAILURE;
						continue;
					}
					item = { nodeId };
				} else item = entry.item;

				const restored = (await ctx.runMutation(internal.files_trash_agent.restore_pending_delete, {
					...common,
					item,
				})) as FunctionReturnType<typeof internal.files_trash_agent.restore_pending_delete>;
				if (restored._nay) {
					const reasons: Partial<Record<string, string>> = {
						not_found: "No such file or directory",
						not_deleted: "it is not deleted.",
						no_pending_delete:
							"it is not your pending delete. Restoring a saved Trash item is not available yet: ask the user to restore it in Files (Trash).",
						in_trash:
							"it is in Trash now. Restoring a saved Trash item is not available yet: ask the user to restore it in Files (Trash).",
						parent_hidden: "its folder is deleted too. Restore the folder first.",
						exists: "File exists. Move or remove the item at that path first.",
					};
					const reason = reasons[restored._nay.name ?? ""] ?? restored._nay.message;
					stderr += `trash: cannot restore '${entry.operand}': ${reason}\n`;
					exitCode = bash_COMMAND_EXIT_FAILURE;
					continue;
				}
				// Later commands chained in this same bash call must see the item again.
				root.fs.resetProposalCaches();
				stdout += `restored: ${render(restored._yay.path)} (your pending delete was removed)\n`;
			}
			return { stdout, stderr, exitCode };
		}

		const json = options.format === "json";
		let area: Id<"files_nodes"> | null = null;
		let areaPath = "/";
		let inFolder: { nodeId: string; archiveOperationId: string } | null = null;
		if (options.in) {
			const separator = options.in.lastIndexOf(":");
			if (separator <= 0) return fail(`'${options.in}' is not a Trash id. Copy the id column of trash ls.`);
			if (options.in.slice(separator + 1) === "pending")
				return fail(
					`'${options.in}' is your own pending delete. Its items are still in place: run trash restore --id ${options.in}, then ls it.`,
				);
			inFolder = { nodeId: options.in.slice(0, separator), archiveOperationId: options.in.slice(separator + 1) };
		} else if (command !== "areas" && paths[0]) {
			const { operand, dbFilesPath } = paths[0];
			let entry;
			try {
				entry = await root.fs.getEntry(dbFilesPath);
			} catch (error) {
				if (!(error instanceof bash_DbFilesPermissionDeniedError)) throw error;
				return fail(`cannot open '${operand}': Permission denied`);
			}
			if (!entry?.target) return fail(`cannot open '${operand}': No such file or directory`);
			// `trash notes.md` is how macOS puts an item in Trash.
			if (entry.kind !== "folder")
				return command === null
					? fail(`to move an item to Trash, use rm ${bash_shell_arg_quote(operand)}.`, true)
					: fail(`'${operand}' is not a folder.`);
			if (entry.target.kind === "private")
				return fail(`'${operand}' is a new folder that is not saved yet. It has no Trash.`);
			area = entry.target.kind === "root" ? null : entry.target.id;
			areaPath = dbFilesPath;
		}

		const key = JSON.stringify({
			command: inFolder ? "in" : (command ?? "ls"),
			userId: source.userId,
			threadId: source.threadId,
			lifetime: source.membershipLifetime,
			workspaceId,
			area,
			inFolder,
			limit: limit._yay.limit,
		});
		let stored: z.infer<typeof cursor_schema> | null = null;
		if (options.cursor) {
			const opened = await bash_cursor_id_resolve(ctx, options.cursor);
			if (opened._nay) return fail(opened._nay.message);
			let value: unknown;
			try {
				value = JSON.parse(opened._yay);
			} catch {
				return fail("Invalid cursor. Run the command again.");
			}
			const parsed = cursor_schema.safeParse(value);
			if (!parsed.success || parsed.data.key !== key)
				return fail("Cursor belongs to another command. Run this command again.");
			stored = parsed.data;
		}

		const items: Item[] = [];
		const areaRows: Array<{ areaNodeId: Id<"files_nodes"> | null; path: string }> = [];
		let next: Omit<z.infer<typeof cursor_schema>, "key"> | null = null;
		const area_error = (nay: { name?: string; message: string; data?: { areaPath: string | null } }) => {
			const shown = paths[0]?.operand ?? render(areaPath);
			if (nay.name === "not_an_area") {
				const outer = nay.data?.areaPath;
				return outer
					? fail(
							`'${shown}' is not a Trash area. Its items are in the Trash of '${render(outer)}': run trash ls ${bash_shell_arg_quote(render(outer))}.`,
						)
					: fail(`'${shown}' is not a Trash area. Its items are in the Trash of a folder you cannot open.`);
			}
			if (nay.name === "guest" || nay.name === "not_a_folder") return fail(nay.message);
			return fail(`cannot open '${shown}': ${nay.message}`);
		};
		const saved_item = (
			row: NonNullable<FunctionReturnType<typeof internal.files_trash_agent.list_entries>["_yay"]>["page"][number],
		) => ({
			id: row.locked ? null : `${row.nodeId}:${row.archiveOperationId}`,
			nodeId: row.locked ? null : row.nodeId,
			pending: null,
			time: row.archiveOperationId === null ? null : files_archive_operation_id_time(row.archiveOperationId),
			kind: row.kind,
			changedBy: row.locked ? null : row.changedBy,
			path: render(row.path),
			locked: row.locked,
			job: row.locked ? null : row.job,
		});
		try {
			if (inFolder) {
				const afterKey = children_key_schema.safeParse(stored?.afterKey ?? null);
				if (!afterKey.success) return fail("Invalid cursor. Run the command again.");
				const result = (await ctx.runQuery(internal.files_trash_agent.list_children, {
					...common,
					...inFolder,
					afterKey: afterKey.data,
					numItems: limit._yay.limit,
				})) as FunctionReturnType<typeof internal.files_trash_agent.list_children>;
				if (result._nay) {
					const id = options.in;
					const messages: Partial<Record<string, string>> = {
						not_found: `no Trash item '${id}' in this workspace. If you listed it in another workspace, add --workspace home (or current).`,
						not_a_folder: `'${id}' is not a folder.`,
						changed: "This Trash item changed. Run trash ls and pick it again.",
						guest: result._nay.message,
					};
					return fail(messages[result._nay.name ?? ""] ?? `cannot open '${id}': ${result._nay.message}`);
				}
				for (const row of result._yay.page) items.push(saved_item(row));
				if (result._yay.nextKey) next = { stream: "children", cursor: null, afterKey: result._yay.nextKey };
			} else if (command === "areas") {
				const afterKey = area_key_schema.safeParse(stored?.afterKey ?? null);
				if (!afterKey.success) return fail("Invalid cursor. Run the command again.");
				const viewArgs = {
					organizationId,
					workspaceId,
					visibilityUserId: source.userId,
					subject: { kind: "user" as const, userId: source.userId, plugin: null },
					folderPath: "/",
				};
				const view = await ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs);
				if (!view) return fail(GUEST_MESSAGE);
				const sources: files_SavedStream[] = [{ kind: "normal", generation: view.generation }];
				if (view.cohortId !== null && view.view !== null)
					sources.push({ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation });
				// Source order follows migration. A doc moved between these reads is seen at least once.
				if (view.migrationDirection === "to_normal") sources.reverse();
				// The first page starts with the open part of the workspace, which every member can open.
				const withOpenArea = !stored;
				const merged = await files_trash_areas_merge_page({
					sources,
					afterKey: afterKey.data,
					numItems: limit._yay.limit - (withOpenArea ? 1 : 0),
					read_page: async (page) =>
						(await ctx.runQuery(internal.public_api_files_organize.list_trash_areas_page, {
							organizationId,
							workspaceId,
							userId: source.userId,
							subject: viewArgs.subject,
							savedStream: page.source,
							principalIndex: page.principalIndex,
							afterKey: page.afterKey,
							numItems: page.numItems,
							agentSource: source,
						})) as FunctionReturnType<typeof internal.public_api_files_organize.list_trash_areas_page>,
				});
				if (merged.status === "denied") return fail(GUEST_MESSAGE);
				if (withOpenArea) areaRows.push({ areaNodeId: null, path: root.currentWorkspacePath });
				for (const row of merged.page) areaRows.push({ areaNodeId: row.nodeId, path: render(row.path) });
				if (!merged.isDone) next = { stream: "areas", cursor: null, afterKey: merged.afterKey };
			} else {
				// The user's own draft deletes come first, newest first. Then the saved Trash in the app's order.
				let stream = stored?.stream ?? "pending";
				let cursor = stored?.cursor ?? null;
				if (stream === "pending") {
					const result = (await ctx.runQuery(internal.files_trash_agent.list_pending_deletes, {
						...common,
						area,
						paginationOpts: { numItems: limit._yay.limit, cursor },
					})) as FunctionReturnType<typeof internal.files_trash_agent.list_pending_deletes>;
					if (result._nay) return area_error(result._nay);
					for (const row of result._yay.page)
						items.push({
							id: row.locked ? null : `${row.nodeId}:pending`,
							nodeId: row.locked ? null : row.nodeId,
							pending: row.inTrash ? "in_trash" : "draft",
							time: row.at,
							kind: row.kind,
							changedBy: row.locked ? null : "you",
							path: render(row.path),
							locked: row.locked,
							job: null,
						});
					if (!result._yay.isDone) next = { stream: "pending", cursor: result._yay.continueCursor, afterKey: null };
					else {
						stream = "saved";
						cursor = null;
					}
				}
				const remaining = limit._yay.limit - items.length;
				if (stream === "saved" && !next && remaining === 0) next = { stream: "saved", cursor: null, afterKey: null };
				if (stream === "saved" && !next && remaining > 0) {
					let endCursor: string | null = null;
					let result;
					// A page that would read too much asks for a split. Read its first part and continue there.
					for (let split = 0; split < 8; split++) {
						result = (await ctx.runQuery(internal.files_trash_agent.list_entries, {
							...common,
							area,
							paginationOpts: { numItems: remaining, cursor, ...(endCursor ? { endCursor } : {}) },
						})) as FunctionReturnType<typeof internal.files_trash_agent.list_entries>;
						if (result._nay || result._yay.pageStatus !== "SplitRequired" || !result._yay.splitCursor) break;
						endCursor = result._yay.splitCursor;
					}
					if (!result) throw new Error("trash: list_entries did not run");
					if (result._nay) return area_error(result._nay);
					for (const row of result._yay.page) items.push(saved_item(row));
					if (!result._yay.isDone || endCursor)
						next = { stream: "saved", cursor: result._yay.continueCursor, afterKey: null };
				}
			}
		} catch (error) {
			// A Move that starts or ends between pages changes the saved view.
			if (
				!(error instanceof ConvexError) ||
				!z.object({ paginationError: z.literal("InvalidCursor") }).safeParse(error.data).success
			)
				throw error;
			return fail("The Trash changed. Run the command again without --cursor.");
		}

		const nextCursor = next ? await bash_cursor_id_create(ctx, source.userId, JSON.stringify({ key, ...next })) : null;
		const limitNote = limit._yay.note ? `${limit._yay.note}\n` : "";
		if (json) {
			const body =
				command === "areas"
					? { areas: areaRows, nextCursor }
					: { area: inFolder ? null : { areaNodeId: area, path: render(areaPath) }, items, nextCursor };
			return { stdout: `${JSON.stringify(body)}\n`, stderr: limitNote, exitCode: 0 };
		}

		// Print the clamped `--limit`, so the next page does not repeat the over-max note.
		const nextLine = nextCursor
			? `Next page: trash ${[
					...args
						.filter(
							(arg, index) =>
								!["--cursor", "--limit"].some(
									(option) => arg === option || args[index - 1] === option || arg.startsWith(`${option}=`),
								),
						)
						.map(bash_shell_arg_quote),
					...(options.limit === undefined ? [] : ["--limit", String(limit._yay.limit)]),
				].join(" ")} --cursor ${bash_shell_arg_quote(nextCursor)}\n`
			: "";
		const lines =
			command === "areas"
				? areaRows.map((row) => `${row.path}${row.path.endsWith("/") ? "" : "/"}`)
				: items.map(item_line);
		const note =
			stored || command === "areas" || inFolder
				? ""
				: `trash: Trash of '${render(areaPath)}'. Restricted folders have their own Trash: trash areas. Items inside a deleted folder: trash ls --in ID.\n`;
		const empty = !stored && lines.length === 0 && !nextCursor ? "(Trash is empty)\n" : "";
		return {
			stdout: `${lines.join("\n")}${lines.length ? "\n" : ""}`,
			stderr: `${limitNote}${note}${empty}${nextLine}`,
			exitCode: 0,
		};
	});
}
