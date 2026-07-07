import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_get_by_path_Result, files_nodes_list_subtree_Result } from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import {
	bash_APP_MOUNT_PATH,
	bash_clamp_listing_page_limit,
	bash_command_build_builtin_delegation_args,
	bash_create_glob_syntax_unsupported_message,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_delegate_builtin_command,
	bash_GLOB_METACHARACTER_REGEX,
	bash_LISTING_DEFAULT_LIMIT,
	bash_LISTING_MAX_LIMIT,
	bash_parse_limit,
	bash_plugins_fan_out_db_files_path,
	bash_plugins_fan_out_paginate,
	bash_read_option_value,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_resolve_db_files_shell_path,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const BUILTIN_OPTIONS_WITH_VALUES = new Set(["-L", "-P", "-I", "--filelimit", "-o"]);

/**
 * Return the path segments from a tree root to an item path.
 *
 * Both paths must already be normalized by the command boundary.
 */
function relative_segments(basePath: string, itemPath: string) {
	if (itemPath === basePath) {
		return [];
	}
	const suffix = basePath === "/" ? itemPath.slice(1) : itemPath.slice(basePath.length + 1);
	return suffix.split("/").filter(Boolean);
}

function parse_args(args: string[]) {
	let path: string | undefined;
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let unsupportedDbFilesOption: string | null = null;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (arg === "--limit") {
			const value = bash_read_option_value("tree", args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}

		if (arg === "--cursor") {
			const value = bash_read_option_value("tree", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}

		if (BUILTIN_OPTIONS_WITH_VALUES.has(arg)) {
			unsupportedDbFilesOption ??= arg;
			index++;
			continue;
		}

		if (arg.startsWith("-")) {
			unsupportedDbFilesOption ??= arg;
			continue;
		}

		if (path != null) {
			return Result({ _nay: { message: "tree: app file tree supports one path only" } });
		}

		path = arg;
	}

	const limit = bash_parse_limit("tree", limitValue, bash_LISTING_DEFAULT_LIMIT, bash_LISTING_MAX_LIMIT);
	if (limit._nay) {
		return limit;
	}

	return Result({
		_yay: {
			path,
			limit: limit._yay,
			cursor,
			unsupportedDbFilesOption,
		} as const,
	});
}

function build_continuation(args: { target: string; limit: number; cursor: string }) {
	return [
		"Next page:",
		"tree",
		bash_shell_arg_quote(args.target),
		"--limit",
		String(args.limit),
		"--cursor",
		bash_shell_arg_quote(args.cursor),
	].join(" ");
}

export function bash_tree_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	return defineCommand("tree", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: tree [PATH] [--limit N] [--cursor CURSOR]\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// AI agents commonly hallucinate `--next-page`; reject it after parse
		// validation so malformed real options still report their normal errors.
		if (args.includes("--next-page")) {
			return {
				stdout: "",
				stderr:
					"tree: --next-page is not supported\n" +
					"Copy the exact `Next page: tree <path> --limit N --cursor ...` command from the previous tree output.\n" +
					"Usage: tree [PATH] [--limit N] [--cursor CURSOR]\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// Turn the tree target into a shell path and classify it (app tree / mount / synthetic root / external).
		const absoluteShellPath = bash_resolve_path(commandCtx.cwd, parsed._yay.path ?? commandCtx.cwd);
		const pathResolution = bash_resolve_db_files_shell_path(absoluteShellPath, dbFilesRoots);
		const target = {
			inputPath: parsed._yay.path,
			absoluteShellPath,
			pathResolution,
			dbFilesPath: pathResolution.dbFilesPath,
			builtinOperand: parsed._yay.path ?? ".",
		};

		// The `/.plugins` root spans one indexed tree per installed plugin. Fan out one
		// subtree listing per plugin, in name order, under a composite cursor.
		if (pathResolution.kind === "plugins_root") {
			if (dbFilesRoots.plugins.mounts.size === 0) {
				return {
					stdout: "",
					stderr: `tree: ${target.absoluteShellPath}: No such file or directory\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			if (parsed._yay.unsupportedDbFilesOption != null) {
				return {
					stdout: "",
					stderr:
						`tree: unsupported option ${parsed._yay.unsupportedDbFilesOption} for db-files paths under ${bash_APP_MOUNT_PATH} or /.mounts\n` +
						"Usage: tree [PATH] [--limit N] [--cursor CURSOR]\n",
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}

			let pluginsCursor: string | null = null;
			if (parsed._yay.cursor != null) {
				const resolvedCursor = await bash_cursor_id_resolve(ctx, parsed._yay.cursor);
				if (resolvedCursor._nay) {
					return {
						stdout: "",
						stderr: `${resolvedCursor._nay.message}\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				pluginsCursor = resolvedCursor._yay;
			}

			// Each plugin page includes its version-root folder doc, which renders as the
			// `/.plugins/<pluginName>/` branch line, so no synthetic entries are needed.
			const fanOut = await bash_plugins_fan_out_paginate({
				command: "tree",
				plugins: dbFilesRoots.plugins,
				cursor: pluginsCursor,
				limit: bash_clamp_listing_page_limit(parsed._yay.limit),
				runPage: async (pageArgs) => {
					const pageResult = (await ctx.runQuery(internal.files_nodes.list_subtree, {
						organizationId: pageArgs.mount.fs.ctxData.organizationId,
						workspaceId: pageArgs.mount.fs.ctxData.workspaceId,
						folderPath: `/${pageArgs.mount.pluginVersionId}`,
						numItems: pageArgs.numItems,
						cursor: pageArgs.innerCursor,
					})) as files_nodes_list_subtree_Result;
					return {
						items: pageResult.page.map((item) => ({
							path: bash_plugins_fan_out_db_files_path(pageArgs.mount, item.path),
							kind: item.kind,
						})),
						continueCursor: pageResult.continueCursor,
						isDone: pageResult.isDone,
					};
				},
			});
			if (fanOut._nay) {
				return {
					stdout: "",
					stderr: `${fanOut._nay.message}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}

			const lines = [target.absoluteShellPath];
			for (const item of fanOut._yay.items) {
				const segments = item.path.split("/").filter(Boolean);
				if (segments.length === 0) {
					continue;
				}
				const prefix = segments.length === 1 ? "|-- " : `${"|   ".repeat(segments.length - 1)}|-- `;
				lines.push(`${prefix}${segments.at(-1)}${item.kind === "folder" ? "/" : ""}`);
			}
			if (!fanOut._yay.isDone && fanOut._yay.continueCursor != null) {
				lines.push(
					"",
					build_continuation({
						target: target.absoluteShellPath,
						limit: parsed._yay.limit,
						cursor: await bash_cursor_id_create(ctx, fanOut._yay.continueCursor),
					}),
				);
				if (parsed._yay.cursor != null) {
					lines.push(
						"Note: this output is already a continuation page; if the user asked for exactly one continuation, stop here. Run another Next page only if the user asks for more.",
					);
				}
			}
			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		// Non-db-files paths are normal Just Bash filesystem paths. Delegate them so native
		// `tree` behavior is preserved outside the app file tree and external mounts.
		if (target.dbFilesPath == null) {
			return await bash_delegate_builtin_command({
				command: "tree",
				args: bash_command_build_builtin_delegation_args(args, [target.builtinOperand], {
					optionsWithValues: BUILTIN_OPTIONS_WITH_VALUES,
					pathsPosition: "afterOptions",
				}),
				commandCtx,
			});
		}

		// Option parsing happens before target routing. Once the target is a db-files
		// path, reject options that only the built-in `tree` implementation can handle.
		if (parsed._yay.unsupportedDbFilesOption != null) {
			return {
				stdout: "",
				stderr:
					`tree: unsupported option ${parsed._yay.unsupportedDbFilesOption} for db-files paths under ${bash_APP_MOUNT_PATH} or /.mounts\n` +
					"Usage: tree [PATH] [--limit N] [--cursor CURSOR]\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// App files are files_nodes docs, so shell globs cannot be expanded without an
		// unbounded scan. Point callers to indexed discovery commands instead.
		if (target.inputPath != null && bash_GLOB_METACHARACTER_REGEX.test(target.inputPath)) {
			return {
				stdout: "",
				stderr: bash_create_glob_syntax_unsupported_message("tree", target.inputPath),
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// Cursor ids are opaque handles stored outside command output. Resolve the
		// public id before sending the real Convex cursor to the paginated query.
		let cursor: string | null = null;
		if (parsed._yay.cursor != null) {
			const resolvedCursor = await bash_cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return {
					stdout: "",
					stderr: `${resolvedCursor._nay.message}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			cursor = resolvedCursor._yay;
		}

		// The `/.mounts` root spans every materialized mount: its content lives at the reserved scope root,
		// so `target.dbFilesPath` is `"/"` and renders descendants as `/.mounts/<name>/...`.
		const rootDbFilesPath = target.dbFilesPath;

		// The workspace root and the `/.mounts` root are synthetic and have no files_nodes doc.
		// Every other app target must resolve to a real files_nodes doc before tree can print it.
		const dbFilesDoc =
			rootDbFilesPath === "/"
				? null
				: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
						organizationId: target.pathResolution.ctxData.organizationId,
						workspaceId: target.pathResolution.ctxData.workspaceId,
						path: rootDbFilesPath,
					})) as files_nodes_get_by_path_Result);

		// Missing concrete app paths fail like normal tree paths.
		if (rootDbFilesPath !== "/" && !dbFilesDoc) {
			return {
				stdout: "",
				stderr: `tree: ${target.absoluteShellPath}: No such file or directory\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		// A file target is already a complete tree of one item.
		if (dbFilesDoc?.kind === "file") {
			return {
				stdout: `${target.absoluteShellPath}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		// Folder targets use the subtree index. minDepth excludes the folder itself
		// because the first output line already prints the requested root path.
		const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
			organizationId: target.pathResolution.ctxData.organizationId,
			workspaceId: target.pathResolution.ctxData.workspaceId,
			folderPath: rootDbFilesPath,
			numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
			cursor,
			minDepth: 1,
		})) as files_nodes_list_subtree_Result;

		// Render each returned descendant as a simple tree branch relative to the
		// requested root, preserving folder slashes for easy visual scanning.
		const lines = [target.absoluteShellPath];
		for (const item of result.page) {
			const segments = relative_segments(rootDbFilesPath, item.path);
			if (segments.length === 0) {
				continue;
			}
			const prefix = segments.length === 1 ? "|-- " : `${"|   ".repeat(segments.length - 1)}|-- `;
			lines.push(`${prefix}${segments.at(-1)}${item.kind === "folder" ? "/" : ""}`);
		}

		// Emit a complete continuation command so the next page can be copied without
		// reconstructing the path, limit, or cursor by hand.
		if (!result.isDone) {
			lines.push(
				"",
				build_continuation({
					target: target.absoluteShellPath,
					limit: parsed._yay.limit,
					cursor: await bash_cursor_id_create(ctx, result.continueCursor),
				}),
			);
			if (parsed._yay.cursor != null) {
				lines.push(
					"Note: this output is already a continuation page; if the user asked for exactly one continuation, stop here. Run another Next page only if the user asks for more.",
				);
			}
		}

		return {
			stdout: `${lines.join("\n")}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}
