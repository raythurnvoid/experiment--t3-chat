import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_match_plain_text_file_lines_Result,
	files_nodes_text_search_files_Result,
} from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import {
	bash_create_glob_syntax_unsupported_message,
	bash_cursor_id_create,
	bash_format_multiline_hint,
	bash_GLOB_METACHARACTER_REGEX,
	bash_read_option_value,
	bash_regex_validation_error,
	bash_resolve_path,
	bash_search_command_build_continuation,
	bash_search_command_exact_query_filter,
	bash_search_command_exact_query_note,
	bash_search_command_exact_query_summary,
	bash_resolve_db_files_shell_path,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

// `-R` folder scans page through the same indexed full-text search `search`/`grep -R` use.
const TEXTGREP_RECURSIVE_PAGE_LIMIT = 20;

// Short boolean flags bundled into one token, e.g. `-iF`, `-iv`, `-cl`.
const TEXTGREP_COMBINED_SHORT_FLAGS_REGEX = /^-[a-zA-Z]{2,}$/u;
// Context windows attached to the flag, e.g. `-A3`, `-B2`, `-C1`.
const TEXTGREP_ATTACHED_CONTEXT_REGEX = /^-([ABC])(\d+)$/u;
// Long context window flags with an inline count, e.g. `--context=3`.
const TEXTGREP_LONG_CONTEXT_REGEX = /^--(after-context|before-context|context)=\d+$/u;

const TEXTGREP_CONTEXT_FLAGS = new Set(["-A", "-B", "-C", "--after-context", "--before-context", "--context"]);
const TEXTGREP_WINDOW_FLAGS = new Set(["--start-line", "--max-lines", "--start-index", "--max-chars"]);

// Display-only grep flags that are accepted but have no effect on a single rendered plain-text scan.
const TEXTGREP_NOOP_FLAGS = new Set([
	"-H",
	"--with-filename",
	"-h",
	"--no-filename",
	"-s",
	"-I",
	"--color",
	"--color=auto",
	"--color=always",
	"--color=never",
]);

const TEXTGREP_LINE_NUMBER_GUIDANCE =
	"textgrep prints rendered plain text without line numbers; use `grep -n PATTERN <file>` for canonical Markdown line numbers.";
const TEXTGREP_CONTEXT_GUIDANCE =
	"textgrep does not support context windows over derived plain text; use `grep` for canonical file context, or `search` for cross-file snippets.";
const TEXTGREP_WINDOW_GUIDANCE = "Markdown scan-window controls don't apply to derived plain text; use `grep`.";
const TEXTGREP_RECURSIVE_FIXED_STRINGS_GUIDANCE =
	"textgrep -R over app folders uses indexed full-text search and does not support exact fixed-string (-F) matching; use `search --path <folder> <terms>` for indexed search, or `textgrep -F PATTERN <file>` on one exact file.";

const TEXTGREP_USAGE = "Usage: textgrep [-i] [-F] [-v] [-c] [-l] [-R] PATTERN <file|folder>";

type TextgrepParsedArgs = {
	pattern: string | undefined;
	ignoreCase: boolean;
	fixedStrings: boolean;
	invert: boolean;
	recursive: boolean;
	countOnly: boolean;
	listOnly: boolean;
	operands: string[];
};

function parse_args(args: string[]) {
	let pattern: string | undefined;
	let ignoreCase = false;
	let fixedStrings = false;
	let invert = false;
	let recursive = false;
	let countOnly = false;
	let listOnly = false;
	const operands: string[] = [];
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			if (pattern === undefined) {
				pattern = arg;
			} else {
				operands.push(arg);
			}
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "-e" || arg === "--regexp") {
			const value = bash_read_option_value("textgrep", args, index, arg);
			if (value._nay) return value;
			if (pattern !== undefined) {
				return Result({ _nay: { message: "textgrep: multiple patterns are not supported" } });
			}
			pattern = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--regexp=")) {
			if (pattern !== undefined) {
				return Result({ _nay: { message: "textgrep: multiple patterns are not supported" } });
			}
			pattern = arg.slice("--regexp=".length);
			continue;
		}
		if (arg === "-i" || arg === "--ignore-case") {
			ignoreCase = true;
			continue;
		}
		if (arg === "-F" || arg === "--fixed-strings") {
			fixedStrings = true;
			continue;
		}
		if (arg === "-v" || arg === "--invert-match") {
			invert = true;
			continue;
		}
		if (arg === "-c" || arg === "--count") {
			countOnly = true;
			continue;
		}
		if (arg === "-l" || arg === "--files-with-matches") {
			listOnly = true;
			continue;
		}
		if (arg === "-r" || arg === "-R" || arg === "--recursive") {
			recursive = true;
			continue;
		}
		if (arg === "-n" || arg === "--line-number") {
			return Result({ _nay: { message: TEXTGREP_LINE_NUMBER_GUIDANCE } });
		}
		if (
			TEXTGREP_CONTEXT_FLAGS.has(arg) ||
			TEXTGREP_ATTACHED_CONTEXT_REGEX.test(arg) ||
			TEXTGREP_LONG_CONTEXT_REGEX.test(arg)
		) {
			return Result({ _nay: { message: TEXTGREP_CONTEXT_GUIDANCE } });
		}
		if (TEXTGREP_WINDOW_FLAGS.has(arg) || [...TEXTGREP_WINDOW_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) {
			return Result({ _nay: { message: TEXTGREP_WINDOW_GUIDANCE } });
		}
		if (TEXTGREP_COMBINED_SHORT_FLAGS_REGEX.test(arg)) {
			for (const ch of arg.slice(1)) {
				if (ch === "i") {
					ignoreCase = true;
				} else if (ch === "F") {
					fixedStrings = true;
				} else if (ch === "v") {
					invert = true;
				} else if (ch === "c") {
					countOnly = true;
				} else if (ch === "l") {
					listOnly = true;
				} else if (ch === "r" || ch === "R") {
					recursive = true;
				} else if (ch === "H" || ch === "h" || ch === "s" || ch === "I") {
					// Display-only flag, no effect on a single rendered plain-text scan.
				} else if (ch === "n") {
					return Result({ _nay: { message: TEXTGREP_LINE_NUMBER_GUIDANCE } });
				} else {
					return Result({ _nay: { message: `textgrep: unsupported option -${ch}` } });
				}
			}
			continue;
		}
		if (TEXTGREP_NOOP_FLAGS.has(arg)) {
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			return Result({ _nay: { message: `textgrep: unsupported option ${arg}` } });
		}
		if (pattern === undefined) {
			pattern = arg;
		} else {
			operands.push(arg);
		}
	}

	// `-R` routes folders through tokenized indexed full-text search, which cannot honor exact
	// fixed-string (-F) matching, so reject the combination instead of silently approximating it.
	if (recursive && fixedStrings) {
		return Result({ _nay: { message: TEXTGREP_RECURSIVE_FIXED_STRINGS_GUIDANCE } });
	}

	const parsed: TextgrepParsedArgs = {
		pattern,
		ignoreCase,
		fixedStrings,
		invert,
		recursive,
		countOnly,
		listOnly,
		operands,
	};

	return Result({ _yay: parsed });
}

function guidance() {
	return {
		stdout:
			[
				"textgrep regex runs over ONE app file's rendered plain text: textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file>.",
				"For recursive or cross-file content, use textgrep -R PATTERN <folder> or search (indexed full-text).",
				"For canonical Markdown line numbers or -A/-B/-C context, use grep [-n] PATTERN <file>.",
			].join("\n") + "\n",
		stderr: "",
		exitCode: bash_COMMAND_EXIT_USAGE,
	};
}

export function bash_textgrep_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	return defineCommand("textgrep", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\n${TEXTGREP_USAGE}\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		const { pattern, ignoreCase, fixedStrings, invert, recursive, countOnly, listOnly, operands } = parsed._yay;

		if (pattern == null || pattern.length === 0) {
			return guidance();
		}

		// `textgrep -R PATTERN <folder>` → indexed full-text search, mirroring `grep -R`.
		if (
			recursive &&
			!countOnly &&
			!listOnly &&
			!invert &&
			operands.length === 1 &&
			operands[0] !== "-" &&
			!bash_GLOB_METACHARACTER_REGEX.test(operands[0])
		) {
			const absoluteShellPath = bash_resolve_path(commandCtx.cwd, operands[0]);
			const pathResolution = bash_resolve_db_files_shell_path(absoluteShellPath, dbFilesRoots);
			const dbFilesPath = pathResolution.dbFilesPath;
			const folderNode =
				dbFilesPath == null || dbFilesPath === "/"
					? null
					: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
							organizationId: pathResolution.ctxData.organizationId,
							workspaceId: pathResolution.ctxData.workspaceId,
							path: dbFilesPath,
						})) as files_nodes_get_by_path_Result);

			if (dbFilesPath != null && (dbFilesPath === "/" || folderNode?.kind === "folder")) {
				const res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
					organizationId: pathResolution.ctxData.organizationId,
					workspaceId: pathResolution.ctxData.workspaceId,
					userId: pathResolution.ctxData.userId,
					query: pattern,
					numItems: TEXTGREP_RECURSIVE_PAGE_LIMIT,
					cursor: null,
					pathPrefix: dbFilesPath,
				})) as files_nodes_text_search_files_Result;

				const scopePath = pathResolution.renderShellPath(dbFilesPath);
				const exactQueryFilter = bash_search_command_exact_query_filter(pattern);
				const blocks =
					res.items.length > 0
						? [
								"textgrep -R over app folders uses indexed full-text search, not exact recursive regex grep.",
								`Found ${res.items.length} results under ${scopePath}${bash_search_command_exact_query_summary(
									exactQueryFilter,
									res.items.map((item) => item.markdownChunk ?? ""),
								)}`,
								"",
								...res.items.map((item) => {
									const markdownChunk = item.markdownChunk ?? "";
									return [
										`${pathResolution.renderShellPath(item.path)} (lines ${item.lineStart}-${item.lineEnd}, chars ${item.startIndex}-${item.endIndex}, chunk #${item.chunkIndex})${bash_search_command_exact_query_note(
											exactQueryFilter,
											pattern,
											markdownChunk,
										)}`,
										markdownChunk,
									].join("\n");
								}),
							]
						: [
								`No content matches found under ${scopePath}.`,
								"textgrep -R over app folders uses indexed full-text search, not exact recursive regex grep.",
							];

				if (!res.isDone) {
					const cursorId = await bash_cursor_id_create(ctx, res.continueCursor);
					blocks.push(
						"",
						bash_search_command_build_continuation({
							currentWorkspacePath: pathResolution.basePath,
							path: dbFilesPath,
							limit: TEXTGREP_RECURSIVE_PAGE_LIMIT,
							cursor: cursorId,
							query: pattern,
						}),
					);
				}

				return { stdout: `${blocks.join("\n")}\n`, stderr: "", exitCode: 0 };
			}
		}

		// `textgrep [flags] PATTERN <file>` → bounded regex over one file's rendered plain text.
		if (!recursive && operands.length === 1 && operands[0] !== "-") {
			const inputPath = operands[0];
			const absoluteShellPath = bash_resolve_path(commandCtx.cwd, inputPath);
			const pathResolution = bash_resolve_db_files_shell_path(absoluteShellPath, dbFilesRoots);
			const dbFilesPath = pathResolution.dbFilesPath;

			if (dbFilesPath != null) {
				if (bash_GLOB_METACHARACTER_REGEX.test(inputPath)) {
					return {
						stdout: "",
						stderr: bash_create_glob_syntax_unsupported_message("textgrep", inputPath),
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				if (!fixedStrings) {
					const regexError = bash_regex_validation_error("textgrep", pattern);
					if (regexError != null) {
						return { stdout: "", stderr: regexError, exitCode: bash_COMMAND_EXIT_USAGE };
					}
				}

				const dbFilesDoc =
					dbFilesPath === "/"
						? null
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								organizationId: pathResolution.ctxData.organizationId,
								workspaceId: pathResolution.ctxData.workspaceId,
								path: dbFilesPath,
							})) as files_nodes_get_by_path_Result);

				if (!dbFilesDoc || dbFilesDoc.kind !== "file") {
					return {
						stdout: "",
						stderr: `textgrep: ${inputPath}: No such file or directory\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}

				const result = (await ctx.runQuery(internal.files_nodes.match_plain_text_file_lines, {
					organizationId: pathResolution.ctxData.organizationId,
					workspaceId: pathResolution.ctxData.workspaceId,
					userId: pathResolution.ctxData.userId,
					fileNodeId: dbFilesDoc._id,
					pattern,
					ignoreCase,
					fixedStrings,
					invert,
				})) as files_nodes_match_plain_text_file_lines_Result;

				if (!result) {
					return { stdout: "", stderr: "", exitCode: bash_COMMAND_EXIT_FAILURE };
				}

				const truncationStderr = result.scanTruncated
					? bash_format_multiline_hint("textgrep", ["scanned only a bounded portion of a large file"])
					: "";

				// Mirror grep's output ordering: -l and -c report before the empty-result branch,
				// so `textgrep -c PATTERN <file>` prints `0` when nothing matches.
				if (listOnly) {
					return result.selectedCount > 0
						? { stdout: `${inputPath}\n`, stderr: truncationStderr, exitCode: 0 }
						: { stdout: "", stderr: truncationStderr, exitCode: bash_COMMAND_EXIT_FAILURE };
				}
				if (countOnly) {
					return {
						stdout: `${result.selectedCount}\n`,
						stderr: truncationStderr,
						exitCode: result.selectedCount > 0 ? 0 : bash_COMMAND_EXIT_FAILURE,
					};
				}
				if (result.lines.length === 0) {
					return { stdout: "", stderr: truncationStderr, exitCode: bash_COMMAND_EXIT_FAILURE };
				}
				return {
					stdout: `${result.lines.map((line) => line.line).join("\n")}\n`,
					stderr: truncationStderr,
					exitCode: 0,
				};
			}
		}

		return guidance();
	});
}
