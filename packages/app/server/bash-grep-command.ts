import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_match_markdown_file_lines_Result,
	files_nodes_text_search_files_Result,
} from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import {
	bash_app_file_node_path_to_current_project_path,
	bash_create_glob_syntax_unsupported_message,
	bash_current_project_path_to_app_file_node_path,
	bash_cursor_id_create,
	bash_delegate_native_just_bash_tmp_command,
	bash_format_multiline_hint,
	bash_GLOB_METACHARACTER_REGEX,
	bash_read_option_value,
	bash_regex_validation_error,
	bash_resolve_path,
	bash_search_command_build_continuation,
	bash_search_command_exact_query_filter,
	bash_search_command_exact_query_note,
	bash_search_command_exact_query_summary,
	bash_shell_arg_quote,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;
const TERMINAL_LINE_ENDING_REGEX = /\r\n?/g;
const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/u;

const GREP_ATTACHED_CONTEXT_REGEX = /^-([ABC])(\d+)$/u;
const GREP_LONG_CONTEXT_REGEX = /^--(after-context|before-context|context)=(\d+)$/u;
const GREP_COMBINED_SHORT_FLAGS_REGEX = /^-[a-zA-Z]{2,}$/u;
const GREP_DEFAULT_MAX_LINES = 200;
const GREP_DEFAULT_MAX_CHARS = 16 * 1024;
const GREP_VALUE_OPTIONS = new Set(["-m", "--max-count", "-f", "--file"]);
const GREP_NOOP_FLAGS = new Set([
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

function parse_context_value(raw: string | undefined) {
	if (raw == null) return null;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : null;
}

function parse_window_value(option: string, raw: string, min: number) {
	if (!NON_NEGATIVE_INTEGER_REGEX.test(raw.trim())) {
		return Result({ _nay: { message: `grep: ${option} must be an integer` } });
	}
	const value = Number(raw);
	if (value < min) {
		return Result({ _nay: { message: `grep: ${option} must be ${min === 0 ? "non-negative" : "positive"}` } });
	}
	return Result({ _yay: value });
}

function parse_args(args: string[]) {
	let pattern: string | undefined;
	let ignoreCase = false;
	let fixedStrings = false;
	let recursive = false;
	let invert = false;
	let countOnly = false;
	let listOnly = false;
	let showLineNumbers = false;
	let before = 0;
	let after = 0;
	let complexFlag = false;
	let unsupportedFlag: string | null = null;
	let startLine: number | null = null;
	let maxLines: number | null = null;
	let startIndex: number | null = null;
	let maxChars: number | null = null;
	const operands: string[] = [];
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			if (pattern === undefined) pattern = arg;
			else operands.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "-e" || arg === "--regexp") {
			const value = args[++index];
			// A second pattern (multiple -e) is real-grep OR semantics we don't reproduce.
			if (pattern !== undefined || value == null) {
				complexFlag = true;
				unsupportedFlag ??= arg;
			} else {
				pattern = value;
			}
			continue;
		}
		if (arg.startsWith("--regexp=")) {
			if (pattern !== undefined) {
				complexFlag = true;
				unsupportedFlag ??= "--regexp";
			} else {
				pattern = arg.slice("--regexp=".length);
			}
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
		if (arg === "-n" || arg === "--line-number") {
			showLineNumbers = true;
			continue;
		}
		if (arg === "-r" || arg === "-R" || arg === "--recursive") {
			recursive = true;
			continue;
		}
		if (arg === "-v" || arg === "--invert-match") {
			invert = true;
			continue;
		}
		if (arg === "--start-line") {
			const value = bash_read_option_value("grep", args, index, "--start-line");
			if (value._nay) return value;
			const parsed = parse_window_value("--start-line", value._yay.value, 1);
			if (parsed._nay) return parsed;
			startLine = parsed._yay;
			index++;
			continue;
		}
		if (arg.startsWith("--start-line=")) {
			const parsed = parse_window_value("--start-line", arg.slice("--start-line=".length), 1);
			if (parsed._nay) return parsed;
			startLine = parsed._yay;
			continue;
		}
		if (arg === "--max-lines") {
			const value = bash_read_option_value("grep", args, index, "--max-lines");
			if (value._nay) return value;
			const parsed = parse_window_value("--max-lines", value._yay.value, 1);
			if (parsed._nay) return parsed;
			maxLines = Math.min(parsed._yay, GREP_DEFAULT_MAX_LINES);
			index++;
			continue;
		}
		if (arg.startsWith("--max-lines=")) {
			const parsed = parse_window_value("--max-lines", arg.slice("--max-lines=".length), 1);
			if (parsed._nay) return parsed;
			maxLines = Math.min(parsed._yay, GREP_DEFAULT_MAX_LINES);
			continue;
		}
		if (arg === "--start-index") {
			const value = bash_read_option_value("grep", args, index, "--start-index");
			if (value._nay) return value;
			const parsed = parse_window_value("--start-index", value._yay.value, 0);
			if (parsed._nay) return parsed;
			startIndex = parsed._yay;
			index++;
			continue;
		}
		if (arg.startsWith("--start-index=")) {
			const parsed = parse_window_value("--start-index", arg.slice("--start-index=".length), 0);
			if (parsed._nay) return parsed;
			startIndex = parsed._yay;
			continue;
		}
		if (arg === "--max-chars") {
			const value = bash_read_option_value("grep", args, index, "--max-chars");
			if (value._nay) return value;
			const parsed = parse_window_value("--max-chars", value._yay.value, 1);
			if (parsed._nay) return parsed;
			maxChars = Math.min(parsed._yay, GREP_DEFAULT_MAX_CHARS);
			index++;
			continue;
		}
		if (arg.startsWith("--max-chars=")) {
			const parsed = parse_window_value("--max-chars", arg.slice("--max-chars=".length), 1);
			if (parsed._nay) return parsed;
			maxChars = Math.min(parsed._yay, GREP_DEFAULT_MAX_CHARS);
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
		// Context flags: -A/-B/-C with a separate value, the attached short form (-A3), or --x=N.
		if (arg === "-A" || arg === "--after-context") {
			const value = parse_context_value(args[++index]);
			if (value == null) complexFlag = true;
			else after = value;
			continue;
		}
		if (arg === "-B" || arg === "--before-context") {
			const value = parse_context_value(args[++index]);
			if (value == null) complexFlag = true;
			else before = value;
			continue;
		}
		if (arg === "-C" || arg === "--context") {
			const value = parse_context_value(args[++index]);
			if (value == null) complexFlag = true;
			else before = after = value;
			continue;
		}
		const attachedContext = GREP_ATTACHED_CONTEXT_REGEX.exec(arg);
		if (attachedContext) {
			const value = Number(attachedContext[2]);
			if (attachedContext[1] === "A") after = value;
			else if (attachedContext[1] === "B") before = value;
			else before = after = value;
			continue;
		}
		const longContext = GREP_LONG_CONTEXT_REGEX.exec(arg);
		if (longContext) {
			const value = Number(longContext[2]);
			if (longContext[1] === "after-context") after = value;
			else if (longContext[1] === "before-context") before = value;
			else before = after = value;
			continue;
		}
		// Combined short flags like -in (= -i -n) or -ivc. Split and apply each; only boolean
		// i/F/v/c/l/n/H/h/s/I (and r/R) are safe; any value/unknown char falls back to guidance.
		if (GREP_COMBINED_SHORT_FLAGS_REGEX.test(arg)) {
			for (const ch of arg.slice(1)) {
				if (ch === "i") ignoreCase = true;
				else if (ch === "F") fixedStrings = true;
				else if (ch === "r" || ch === "R") recursive = true;
				else if (ch === "v") invert = true;
				else if (ch === "c") countOnly = true;
				else if (ch === "l") listOnly = true;
				else if (ch === "n") showLineNumbers = true;
				else if (ch === "H" || ch === "h" || ch === "s" || ch === "I") {
					// display/no-op flag
				} else {
					complexFlag = true;
					unsupportedFlag ??= `-${ch}`;
				}
			}
			continue;
		}
		if (GREP_VALUE_OPTIONS.has(arg)) {
			index++; // consume the value
			complexFlag = true; // output/semantics we don't reproduce on the fast path
			unsupportedFlag ??= arg;
			continue;
		}
		if (GREP_NOOP_FLAGS.has(arg)) continue;
		if (arg.startsWith("-") && arg !== "-") {
			complexFlag = true; // unknown / semantics-changing flag (-w, -o, -x, -P, ...)
			unsupportedFlag ??= arg;
			continue;
		}
		if (pattern === undefined) pattern = arg;
		else operands.push(arg);
	}

	const hasLineWindow = startLine != null || maxLines != null;
	const hasSliceWindow = startIndex != null || maxChars != null;
	if (hasLineWindow && hasSliceWindow) {
		return Result({ _nay: { message: "grep: use either a line window or a slice window, not both" } });
	}

	return Result({
		_yay: {
			pattern,
			ignoreCase,
			fixedStrings,
			recursive,
			invert,
			countOnly,
			listOnly,
			showLineNumbers,
			before,
			after,
			complexFlag,
			unsupportedFlag,
			operands,
			window: hasSliceWindow
				? ({
						kind: "slice",
						startIndex: startIndex ?? 0,
						maxChars: maxChars ?? GREP_DEFAULT_MAX_CHARS,
					} as const)
				: hasLineWindow
					? ({
							kind: "lines",
							startLine: startLine ?? 1,
							maxLines: maxLines ?? GREP_DEFAULT_MAX_LINES,
						} as const)
					: undefined,
		} as const,
	});
}

function build_window_args(
	window: NonNullable<ReturnType<typeof parse_args>["_yay"]>["window"],
) {
	if (window?.kind === "slice") {
		return ["--start-index", String(window.startIndex), "--max-chars", String(window.maxChars)];
	}
	if (window?.kind === "lines") {
		return ["--start-line", String(window.startLine), "--max-lines", String(window.maxLines)];
	}
	return [];
}

function build_continuation(args: {
	parsed: NonNullable<ReturnType<typeof parse_args>["_yay"]>;
	result: NonNullable<files_nodes_match_markdown_file_lines_Result>;
	inputPath: string;
}) {
	if (args.result.nextStartIndex != null) {
		const maxChars = args.parsed.window?.kind === "slice" ? args.parsed.window.maxChars : GREP_DEFAULT_MAX_CHARS;
		return build_command({
			parsed: args.parsed,
			window: { kind: "slice", startIndex: args.result.nextStartIndex, maxChars },
			inputPath: args.inputPath,
		});
	}
	if (args.result.nextStartLine != null) {
		const maxLines = args.parsed.window?.kind === "lines" ? args.parsed.window.maxLines : GREP_DEFAULT_MAX_LINES;
		return build_command({
			parsed: args.parsed,
			window: { kind: "lines", startLine: args.result.nextStartLine, maxLines },
			inputPath: args.inputPath,
		});
	}
	return null;
}

function build_command(args: {
	parsed: NonNullable<ReturnType<typeof parse_args>["_yay"]>;
	window: NonNullable<ReturnType<typeof parse_args>["_yay"]>["window"];
	inputPath: string;
}) {
	const parts = ["grep"];
	if (args.parsed.showLineNumbers) parts.push("-n");
	if (args.parsed.ignoreCase) parts.push("-i");
	if (args.parsed.fixedStrings) parts.push("-F");
	if (args.parsed.invert) parts.push("-v");
	if (args.parsed.countOnly) parts.push("-c");
	if (args.parsed.listOnly) parts.push("-l");
	if (args.parsed.before > 0 && args.parsed.before === args.parsed.after) {
		parts.push("-C", String(args.parsed.before));
	} else {
		if (args.parsed.before > 0) parts.push("-B", String(args.parsed.before));
		if (args.parsed.after > 0) parts.push("-A", String(args.parsed.after));
	}
	parts.push(...build_window_args(args.window));
	if (args.parsed.pattern != null) {
		parts.push(bash_shell_arg_quote(args.parsed.pattern));
	}
	parts.push(bash_shell_arg_quote(args.inputPath));
	return parts.join(" ");
}

function build_truncation_stderr(args: {
	parsed: NonNullable<ReturnType<typeof parse_args>["_yay"]>;
	result: NonNullable<files_nodes_match_markdown_file_lines_Result>;
	inputPath: string;
	mode: "matches" | "count" | "list" | "normal";
}) {
	if (!args.result.scanTruncated) {
		return "";
	}
	const continuation = build_continuation(args);
	const reason =
		args.result.truncatedReason === "scan_byte_limit_reached"
			? "byte scan cap reached"
			: args.result.truncatedReason === "scan_line_limit_reached"
				? "line scan cap reached"
				: args.result.truncatedReason === "slice_window_ended"
					? "slice window ended"
					: args.result.truncatedReason === "selected_match_limit_reached"
						? "match cap reached"
						: args.result.truncatedReason === "output_line_limit_reached"
							? "output cap reached"
							: "scan cap reached";
	const countSuffix = args.mode === "count" ? "; count is a lower bound" : "";
	const existenceSuffix =
		args.mode === "matches" || args.mode === "list" ? "; matches may exist beyond it" : "; more may exist";
	return bash_format_multiline_hint("grep", [
		`${reason}${countSuffix}${countSuffix ? "" : existenceSuffix}`,
		...(continuation == null ? [] : [`Next scan: ${continuation}`]),
	]);
}

function slice_mode_stderr(
	window: NonNullable<ReturnType<typeof parse_args>["_yay"]>["window"],
) {
	return window?.kind === "slice"
		? bash_format_multiline_hint("grep", [
				"slice mode scans a text slice, not a full native line window; output may contain partial line text",
			])
		: "";
}

export function bash_grep_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
	return defineCommand("grep", async (args, commandCtx) => {
		// Parse only the bounded grep subset that maps cleanly to app-file queries.
		// Unsupported flags stay recorded so later branches can return focused guidance.
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr:
					`${parsed._nay.message}\n` +
					"Usage: grep [-n] [-i] [-F] [--start-line N --max-lines N | --start-index N --max-chars N] PATTERN <file>\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		// Single app-file grep path:
		// - reads Markdown chunks for exactly one app file
		// - treats the pattern as a regex by default
		// - treats the pattern as a literal substring only when -F/--fixed-strings is set
		// - supports the bounded grep-like flags handled by the parser above
		if (
			parsed._yay.pattern != null &&
			parsed._yay.pattern.length > 0 &&
			!parsed._yay.recursive &&
			!parsed._yay.complexFlag &&
			parsed._yay.operands.length === 1 &&
			parsed._yay.operands[0] !== "-"
		) {
			const inputPath = parsed._yay.operands[0];
			const absoluteShellPath = bash_resolve_path(commandCtx.cwd, inputPath);
			const target = {
				inputPath,
				absoluteShellPath,
				appFileNodePath: bash_current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
			};

			if (target.appFileNodePath != null) {
				if (bash_GLOB_METACHARACTER_REGEX.test(target.inputPath)) {
					return {
						stdout: "",
						stderr: bash_create_glob_syntax_unsupported_message("grep", target.inputPath),
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
						stderr: `grep: ${target.inputPath}: No such file or directory\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}

				// Validate regex only for exact single-file scans; folder and multi-file grep use indexed search.
				if (!parsed._yay.fixedStrings) {
					const regexError = bash_regex_validation_error("grep", parsed._yay.pattern);
					if (regexError != null) {
						return {
							stdout: "",
							stderr: regexError,
							exitCode: COMMAND_EXIT_USAGE,
						};
					}
				}

				const result = (await ctx.runQuery(internal.files_nodes.match_markdown_file_lines, {
					workspaceId: workspaceFs.ctxData.workspaceId,
					projectId: workspaceFs.ctxData.projectId,
					userId: workspaceFs.ctxData.userId,
					fileNodeId: fileNode._id,
					pattern: parsed._yay.pattern,
					ignoreCase: parsed._yay.ignoreCase,
					fixedStrings: parsed._yay.fixedStrings,
					invert: parsed._yay.invert,
					before: parsed._yay.before,
					after: parsed._yay.after,
					window: parsed._yay.window,
				})) as files_nodes_match_markdown_file_lines_Result;

				if (!result) {
					return { stdout: "", stderr: "", exitCode: 1 };
				}

				const sliceModeWarning = slice_mode_stderr(parsed._yay.window);

				if (parsed._yay.listOnly) {
					if (result.selectedCount > 0) {
						return {
							stdout: `${target.inputPath}\n`,
							stderr:
								sliceModeWarning +
								build_truncation_stderr({
									parsed: parsed._yay,
									result,
									inputPath: target.inputPath,
									mode: "list",
								}),
							exitCode: 0,
						};
					}
					return {
						stdout: "",
						stderr:
							sliceModeWarning +
							build_truncation_stderr({
								parsed: parsed._yay,
								result,
								inputPath: target.inputPath,
								mode: "list",
							}),
						exitCode: 1,
					};
				}

				if (parsed._yay.countOnly) {
					return {
						stdout: `${result.selectedCount}\n`,
						stderr:
							sliceModeWarning +
							build_truncation_stderr({
								parsed: parsed._yay,
								result,
								inputPath: target.inputPath,
								mode: "count",
							}),
						exitCode: result.selectedCount > 0 ? 0 : 1,
					};
				}

				if (result.lines.length === 0) {
					// Real grep: exit 1 means "no matches".
					return {
						stdout: "",
						stderr:
							sliceModeWarning +
							build_truncation_stderr({
								parsed: parsed._yay,
								result,
								inputPath: target.inputPath,
								mode: "matches",
							}),
						exitCode: 1,
					};
				}

				// Context output uses native grep's group separators. Plain and inverted
				// no-context output stays raw unless -n asks for line numbers.
				const separatesGroups = parsed._yay.before > 0 || parsed._yay.after > 0;
				const pieces: string[] = [];
				let prevLineNumber: number | null = null;
				for (const lineEntry of result.lines) {
					if (separatesGroups && prevLineNumber !== null && lineEntry.lineNumber > prevLineNumber + 1) {
						pieces.push("--");
					}
					const lineNumberSeparator = separatesGroups && !lineEntry.matched ? "-" : ":";
					pieces.push(
						parsed._yay.showLineNumbers
							? `${lineEntry.lineNumber}${lineNumberSeparator}${lineEntry.line}`
							: lineEntry.line,
					);
					prevLineNumber = lineEntry.lineNumber;
				}

				const stdout = `${pieces.join("\n")}\n`;
				const stderr =
					sliceModeWarning +
					build_truncation_stderr({
						parsed: parsed._yay,
						result,
						inputPath: target.inputPath,
						mode: "normal",
					});

				return { stdout, stderr, exitCode: 0 };
			}
		}

		// Stdin grep path:
		// - scans the piped text already in memory
		// - uses regex by default, like single-file app grep
		// - uses literal substring matching only for -F/--fixed-strings
		const readsStdin =
			parsed._yay.operands.length === 0
				? commandCtx.stdin !== undefined
				: parsed._yay.operands.length === 1 && parsed._yay.operands[0] === "-";
		if (
			parsed._yay.pattern != null &&
			parsed._yay.pattern.length > 0 &&
			!parsed._yay.recursive &&
			!parsed._yay.complexFlag &&
			readsStdin
		) {
			let regex: RegExp | null = null;
			if (!parsed._yay.fixedStrings) {
				const regexError = bash_regex_validation_error("grep", parsed._yay.pattern);
				if (regexError != null) {
					return {
						stdout: "",
						stderr: regexError,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				regex = new RegExp(parsed._yay.pattern, parsed._yay.ignoreCase ? "iu" : "u");
			}

			const text = String(commandCtx.stdin ?? "");
			const normalizedNeedle = parsed._yay.ignoreCase ? parsed._yay.pattern.toLowerCase() : parsed._yay.pattern;
			const lines = text.replace(TERMINAL_LINE_ENDING_REGEX, "\n").split("\n");
			if (text.endsWith("\n")) {
				lines.pop();
			}

			const selected = new Set<number>();
			for (let index = 0; index < lines.length; index++) {
				const haystack = parsed._yay.ignoreCase ? lines[index].toLowerCase() : lines[index];
				const matched = parsed._yay.fixedStrings
					? haystack.includes(normalizedNeedle)
					: regex?.test(lines[index]) === true;
				if (parsed._yay.invert ? !matched : matched) {
					selected.add(index);
				}
			}

			if (parsed._yay.listOnly) {
				return {
					stdout: selected.size > 0 ? "(standard input)\n" : "",
					stderr: "",
					exitCode: selected.size > 0 ? 0 : 1,
				};
			}

			if (parsed._yay.countOnly) {
				return {
					stdout: `${selected.size}\n`,
					stderr: "",
					exitCode: selected.size > 0 ? 0 : 1,
				};
			}

			if (selected.size === 0) {
				return { stdout: "", stderr: "", exitCode: 1 };
			}

			const outputIndexes = new Set<number>();
			for (const index of selected) {
				const start = Math.max(0, index - parsed._yay.before);
				const end = Math.min(lines.length - 1, index + parsed._yay.after);
				for (let lineIndex = start; lineIndex <= end; lineIndex++) {
					outputIndexes.add(lineIndex);
				}
			}

			const outputLines: string[] = [];
			const separatesGroups = parsed._yay.before > 0 || parsed._yay.after > 0;
			let previousIndex: number | null = null;
			for (const index of [...outputIndexes].sort((a, b) => a - b)) {
				if (separatesGroups && previousIndex !== null && index > previousIndex + 1) {
					outputLines.push("--");
				}
				outputLines.push(
					parsed._yay.showLineNumbers ? `${index + 1}${selected.has(index) ? ":" : "-"}${lines[index]}` : lines[index],
				);
				previousIndex = index;
			}

			return {
				stdout: `${outputLines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		if (
			parsed._yay.operands.length > 0 &&
			parsed._yay.operands.every(
				(operand) =>
					operand === "-" ||
					bash_current_project_path_to_app_file_node_path(currentProjectPath, bash_resolve_path(commandCtx.cwd, operand)) ==
						null,
			)
		) {
			return await bash_delegate_native_just_bash_tmp_command("grep", args, commandCtx, currentProjectPath);
		}

		// Recursive app-folder grep path:
		// - maps `grep -R PATTERN <folder>` to indexed full-text search
		// - returns search snippets, not exact line matches
		// - does not support native recursive regex grep semantics
		if (
			parsed._yay.pattern != null &&
			parsed._yay.pattern.length > 0 &&
			parsed._yay.recursive &&
			!parsed._yay.complexFlag &&
			!parsed._yay.invert &&
			!parsed._yay.countOnly &&
			!parsed._yay.listOnly &&
			parsed._yay.before === 0 &&
			parsed._yay.after === 0 &&
			parsed._yay.operands.length === 1 &&
			parsed._yay.operands[0] !== "-" &&
			!bash_GLOB_METACHARACTER_REGEX.test(parsed._yay.operands[0])
		) {
			const inputPath = parsed._yay.operands[0];
			const absoluteShellPath = bash_resolve_path(commandCtx.cwd, inputPath);
			const target = {
				inputPath,
				absoluteShellPath,
				appFileNodePath: bash_current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
			};

			const fileNode =
				target.appFileNodePath == null || target.appFileNodePath === "/"
					? null
					: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							path: target.appFileNodePath,
						})) as files_nodes_get_by_path_Result);

			if (target.appFileNodePath != null && (target.appFileNodePath === "/" || fileNode?.kind === "folder")) {
				const recursivePattern = parsed._yay.pattern;
				const res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
					workspaceId: workspaceFs.ctxData.workspaceId,
					projectId: workspaceFs.ctxData.projectId,
					userId: workspaceFs.ctxData.userId,
					query: recursivePattern,
					numItems: 20,
					cursor: null,
					pathPrefix: target.appFileNodePath,
				})) as files_nodes_text_search_files_Result;

				const scopePath = bash_app_file_node_path_to_current_project_path(currentProjectPath, target.appFileNodePath);

				// Same exact-query annotation as search: hyphenated single-token patterns get a
				// per-hit note saying whether the literal pattern appears in the shown chunk.
				const exactQueryFilter = bash_search_command_exact_query_filter(recursivePattern);
				const blocks =
					res.items.length > 0
						? [
								`grep -R over app folders uses indexed full-text search, not exact recursive regex grep.`,
								`Found ${res.items.length} results under ${scopePath}${bash_search_command_exact_query_summary(
									exactQueryFilter,
									res.items.map((item) => item.markdownChunk ?? ""),
								)}`,
								"",
								...res.items.map((item) => {
									const markdownChunk = item.markdownChunk ?? "";
									return [
										`${bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path)} (lines ${item.lineStart}-${item.lineEnd}, chars ${item.startIndex}-${item.endIndex}, chunk #${item.chunkIndex})${bash_search_command_exact_query_note(exactQueryFilter, recursivePattern, markdownChunk)}`,
										markdownChunk,
									].join("\n");
								}),
							]
						: [
								`No content matches found under ${scopePath}.`,
								`grep -R over app folders uses indexed full-text search, not exact recursive regex grep.`,
							];

				if (!res.isDone) {
					const cursorId = await bash_cursor_id_create(ctx, res.continueCursor);
					blocks.push(
						"",
						bash_search_command_build_continuation({
							currentProjectPath,
							path: target.appFileNodePath,
							limit: 20,
							cursor: cursorId,
							query: recursivePattern,
						}),
					);
				}

				return {
					stdout: `${blocks.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			}
		}

		// Unsupported app-file flags get a grep-specific error instead of the broad search fallback.
		if (
			parsed._yay.pattern != null &&
			parsed._yay.pattern.length > 0 &&
			parsed._yay.unsupportedFlag != null &&
			parsed._yay.operands.length === 1 &&
			parsed._yay.operands[0] !== "-"
		) {
			const inputPath = parsed._yay.operands[0];
			const absoluteShellPath = bash_resolve_path(commandCtx.cwd, inputPath);
			const target = {
				inputPath,
				absoluteShellPath,
				appFileNodePath: bash_current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
			};

			if (target.appFileNodePath != null) {
				return {
					stdout: "",
					stderr:
						`grep: unsupported option ${parsed._yay.unsupportedFlag} for app-file grep. ` +
						"Supported: grep [-n] [-i] [-F] [--start-line N --max-lines N | --start-index N --max-chars N] PATTERN <file> with -c, -l, -v, and -A/-B/-C N. " +
						"Drop the flag, or use search for cross-file discovery.\n" +
						`Try: ${build_command({
							parsed: parsed._yay,
							window: parsed._yay.window,
							inputPath,
						})}\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}

		// Everything outside the supported fast paths returns a concrete search retry.
		let suggestedCommand = parsed._yay.pattern
			? `search --limit 20 ${bash_shell_arg_quote(parsed._yay.pattern)}`
			: "search --limit 20 <content-terms>";

		if (parsed._yay.pattern) {
			const firstAppOperand = parsed._yay.operands.find((operand) => {
				if (operand === "-" || bash_GLOB_METACHARACTER_REGEX.test(operand)) return false;
				return (
					bash_current_project_path_to_app_file_node_path(currentProjectPath, bash_resolve_path(commandCtx.cwd, operand)) !=
					null
				);
			});

			if (firstAppOperand != null) {
				const absoluteShellPath = bash_resolve_path(commandCtx.cwd, firstAppOperand);
				const target = {
					inputPath: firstAppOperand,
					absoluteShellPath,
					appFileNodePath: bash_current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
				};

				const fileNode =
					target.appFileNodePath == null || target.appFileNodePath === "/"
						? null
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								workspaceId: workspaceFs.ctxData.workspaceId,
								projectId: workspaceFs.ctxData.projectId,
								path: target.appFileNodePath,
							})) as files_nodes_get_by_path_Result);

				if (target.appFileNodePath === "/" || fileNode?.kind === "folder") {
					suggestedCommand = `search --path ${bash_shell_arg_quote(target.absoluteShellPath)} --limit 20 ${bash_shell_arg_quote(parsed._yay.pattern)}`;
				}
			}
		}

		return {
			stdout:
				[
					"grep over multiple/app-wide files is not supported; use search, or grep a single file.",
					"To search ALL files for content, use search with words that should appear in the document body:",
					`Try: ${suggestedCommand}`,
					"If the Try command matches the user's request, run it next before answering.",
					"IMPORTANT: search is full-text, not grep. Pass one distinctive word or a few plain terms; the text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term.",
					"It is implemented with Convex full-text search, but it is not regex/glob/exact substring matching.",
					"To grep ONE file, pass exactly one app file path: grep [-n] [-i] [-F] PATTERN <file> (regex match; -F uses fixed strings; -n prints line numbers).",
					"To restrict search to a folder, cd there or use search --path <folder> <content terms>; broad scopes with common terms can be heavier.",
					"The search command returns matching file paths with snippets.",
				].join("\n") + "\n",
			stderr: "",
			exitCode: 2,
		};
	});
}
