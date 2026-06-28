import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_match_plain_text_file_lines_Result,
	files_nodes_regex_search_plain_text_files_Result,
} from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import {
	bash_app_file_node_path_to_current_project_path,
	bash_clamp_listing_page_limit,
	bash_create_glob_syntax_unsupported_message,
	bash_current_project_path_to_app_file_node_path,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_format_multiline_hint,
	bash_GLOB_METACHARACTER_REGEX,
	bash_LISTING_DEFAULT_LIMIT,
	bash_LISTING_MAX_LIMIT,
	bash_parse_limit,
	bash_read_option_value,
	bash_regex_validation_error,
	bash_resolve_path,
	bash_shell_arg_quote,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;

function parse_args(args: string[], options: { currentProjectPath: string; cwd: string }) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let pathValue: string | undefined;
	let ignoreCase = false;
	const operands: string[] = [];
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			operands.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "-i" || arg === "--ignore-case") {
			ignoreCase = true;
			continue;
		}
		if (arg === "--limit") {
			const value = bash_read_option_value("textgrep", args, index, "--limit");
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
			const value = bash_read_option_value("textgrep", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value.trim();
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length).trim();
			continue;
		}
		if (arg === "--path") {
			const value = bash_read_option_value("textgrep", args, index, "--path");
			if (value._nay) return value;
			pathValue = value._yay.value.trim();
			index++;
			continue;
		}
		if (arg.startsWith("--path=")) {
			pathValue = arg.slice("--path=".length).trim();
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			return Result({ _nay: { message: `textgrep: unsupported option ${arg}` } });
		}
		operands.push(arg);
	}

	const limit = bash_parse_limit("textgrep", limitValue, bash_LISTING_DEFAULT_LIMIT, bash_LISTING_MAX_LIMIT);
	if (limit._nay) {
		return limit;
	}
	if (operands.length === 0) {
		return Result({ _nay: { message: "textgrep: missing regex pattern" } });
	}
	if (operands.length > 2) {
		return Result({ _nay: { message: "textgrep: supports either PATTERN or PATTERN <file>" } });
	}
	if (pathValue != null && operands.length === 2) {
		return Result({ _nay: { message: "textgrep: --path cannot be combined with a file operand" } });
	}
	if (pathValue === "") {
		return Result({ _nay: { message: "textgrep: --path requires a non-empty folder path" } });
	}

	let path: string | undefined;
	if (pathValue != null) {
		const appFileNodePath = bash_current_project_path_to_app_file_node_path(
			options.currentProjectPath,
			bash_resolve_path(options.cwd, pathValue),
		);
		if (appFileNodePath == null) {
			return Result({
				_nay: {
					message:
						`textgrep: --path must be a folder under the app file tree: ${pathValue}\n` +
						`Use a path under ${options.currentProjectPath}.`,
				},
			});
		}
		path = appFileNodePath;
	}

	return Result({
		_yay: {
			pattern: operands[0],
			file: operands[1],
			ignoreCase,
			limit: limit._yay,
			cursor,
			path,
		} as const,
	});
}

function build_continuation(args: {
	currentProjectPath: string;
	path: string | undefined;
	limit: number;
	cursor: string;
	pattern: string;
	ignoreCase: boolean;
}) {
	const continuationParts = ["Next page:", "textgrep"];
	if (args.ignoreCase) {
		continuationParts.push("-i");
	}
	if (args.path != null) {
		continuationParts.push(
			"--path",
			bash_shell_arg_quote(bash_app_file_node_path_to_current_project_path(args.currentProjectPath, args.path)),
		);
	}
	continuationParts.push(
		"--limit",
		String(args.limit),
		"--cursor",
		bash_shell_arg_quote(args.cursor),
		bash_shell_arg_quote(args.pattern),
	);
	return continuationParts.join(" ");
}

export function bash_textgrep_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
	return defineCommand("textgrep", async (args, commandCtx) => {
		const parsed = parse_args(args, { currentProjectPath, cwd: commandCtx.cwd });
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: textgrep [-i] [--path <folder>] [--limit N] [--cursor CURSOR] <regex> [file]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		const regexError = bash_regex_validation_error("textgrep", parsed._yay.pattern);
		if (regexError != null) {
			return {
				stdout: "",
				stderr: regexError,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		if (parsed._yay.file != null) {
			// Single app-file textgrep path:
			// - reads rendered plain-text chunks for exactly one app file
			// - treats the pattern as a JavaScript regex
			// This is the plain-text counterpart to Markdown-backed single-file `grep`.
			const absoluteShellPath = bash_resolve_path(commandCtx.cwd, parsed._yay.file);
			const target = {
				inputPath: parsed._yay.file,
				absoluteShellPath,
				appFileNodePath: bash_current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
			};

			if (target.appFileNodePath == null) {
				return {
					stdout: "",
					stderr: "textgrep: file operand must be an app file path\n",
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			if (bash_GLOB_METACHARACTER_REGEX.test(target.inputPath)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("textgrep", target.inputPath),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			const fileNode =
				target.appFileNodePath === "/"
					? null
					: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							path: target.appFileNodePath,
						})) as files_nodes_get_by_path_Result);

			if (!fileNode || fileNode.kind !== "file") {
				return {
					stdout: "",
					stderr: `textgrep: ${target.inputPath}: No such file or directory\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}

			const result = (await ctx.runQuery(internal.files_nodes.match_plain_text_file_lines, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				userId: workspaceFs.ctxData.userId,
				fileNodeId: fileNode._id,
				pattern: parsed._yay.pattern,
				ignoreCase: parsed._yay.ignoreCase,
			})) as files_nodes_match_plain_text_file_lines_Result;

			if (!result || result.lines.length === 0) {
				return { stdout: "", stderr: "", exitCode: COMMAND_EXIT_FAILURE };
			}

			return {
				stdout: `${result.lines.map((line) => line.line).join("\n")}\n`,
				stderr: result.scanTruncated
					? bash_format_multiline_hint("textgrep", ["scanned only a bounded portion of a large file"])
					: "",
				exitCode: 0,
			};
		}

		let cursor: string | null = null;
		if (parsed._yay.cursor != null) {
			const resolvedCursor = await bash_cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return {
					stdout: "",
					stderr: `${resolvedCursor._nay.message}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			cursor = resolvedCursor._yay;
		}

		if (parsed._yay.path != null && parsed._yay.path !== "/") {
			const scopedFolder = (await ctx.runQuery(internal.files_nodes.get_by_path, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				path: parsed._yay.path,
			})) as files_nodes_get_by_path_Result;
			const scopedShellPath = bash_app_file_node_path_to_current_project_path(currentProjectPath, parsed._yay.path);
			if (!scopedFolder) {
				return {
					stdout: "",
					stderr: `textgrep: --path folder does not exist: ${scopedShellPath}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if (scopedFolder.kind !== "folder") {
				return {
					stdout: "",
					stderr: `textgrep: --path must be a folder: ${scopedShellPath}\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}

		const cwdAppFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, commandCtx.cwd);
		const path =
			parsed._yay.path ?? (cwdAppFileNodePath != null && cwdAppFileNodePath !== "/" ? cwdAppFileNodePath : undefined);

		const res = (await ctx.runQuery(internal.files_nodes.regex_search_plain_text_files, {
			workspaceId: workspaceFs.ctxData.workspaceId,
			projectId: workspaceFs.ctxData.projectId,
			userId: workspaceFs.ctxData.userId,
			query: parsed._yay.pattern,
			ignoreCase: parsed._yay.ignoreCase,
			numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
			cursor,
			pathPrefix: path,
		})) as files_nodes_regex_search_plain_text_files_Result;

		const scopeNote =
			path != null ? ` under ${bash_app_file_node_path_to_current_project_path(currentProjectPath, path)}` : "";

		const blocks =
			res.items.length > 0
				? [
						`Found ${res.items.length} bounded plain-text regex results${scopeNote}.`,
						"",
						...res.items.map((item) =>
							[
								`${bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path)}:${item.lineNumber}`,
								item.line,
							].join("\n"),
						),
					]
				: [`No bounded plain-text regex matches found${scopeNote}.`];

		if (!res.isDone) {
			blocks.push(
				"",
				build_continuation({
					currentProjectPath,
					path,
					limit: parsed._yay.limit,
					cursor: await bash_cursor_id_create(ctx, res.continueCursor),
					pattern: parsed._yay.pattern,
					ignoreCase: parsed._yay.ignoreCase,
				}),
			);
		}

		return {
			stdout: `${blocks.join("\n")}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}
