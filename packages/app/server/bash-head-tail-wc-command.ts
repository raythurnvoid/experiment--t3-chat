import { defineCommand, type Command, type CommandContext } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { Doc } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_read_file_content_from_chunks_Result,
	files_nodes_read_file_content_stats_Result,
	files_nodes_read_file_line_range_Result,
	files_nodes_read_file_tail_lines_Result,
} from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_node_has_editable_yjs_state } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { bash_sed_command_build_next_page_hint } from "./bash-sed-command.ts";
import { bash_DbFilesContentUnavailableError, bash_build_unreadable_file_advisory, bash_create_glob_syntax_unsupported_message, bash_enforce_reader_operand_cap, bash_format_multiline_hint, bash_GLOB_METACHARACTER_REGEX, bash_get_db_file_byte_size, bash_is_path_under_current_workspace_path, bash_READ_HEAD_LARGE_FILE_MAX_LINES, bash_READ_INLINE_MAX_BYTES, bash_resolve_path, bash_shell_arg_quote, bash_resolve_db_files_shell_path, bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE, type bash_DbFilesRoots, type bash_DbFilesShellPathResolution } from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

const READER_LINE_COUNT_REGEX = /^(\+?)(\d+)$/u;
const WC_COMBINED_FLAGS_REGEX = /^-[lwmc]{2,}$/u;
const OBSOLETE_LINE_COUNT_FLAG_REGEX = /^-(\d+)$/u;

type WcCommandFlags = { lines: boolean; words: boolean; chars: boolean; bytes: boolean };
type ReaderCommandOversizedFileOperand = {
	file: string;
	dbFilesPath: string;
	size: number;
	contentType: Doc<"files_nodes">["contentType"];
	hasEditableYjsState: boolean;
	pathResolution: bash_DbFilesShellPathResolution;
};

function parse_line_count(command: string, option: string, value: string | undefined) {
	if (value == null) {
		return Result({ _nay: { message: `${command}: ${option} requires a value` } });
	}

	// A leading `+` (e.g. `tail -n +K`) means "start at line K" (forward), not "last K lines".
	const match = READER_LINE_COUNT_REGEX.exec(value.trim());
	if (!match) {
		return Result({ _nay: { message: `${command}: ${option} must be an integer line count` } });
	}

	return Result({ _yay: { count: Number(match[2]), fromStart: match[1] === "+" } as const });
}

function wants_default(flags: WcCommandFlags) {
	return !flags.lines && !flags.words && !flags.chars && !flags.bytes;
}

function build_fields(
	flags: WcCommandFlags,
	counts: { lineCount: number; wordCount: number; charCount: number; byteCount: number },
) {
	const fields: string[] = [];
	const wantDefault = wants_default(flags);

	if (flags.lines || wantDefault) fields.push(String(counts.lineCount));
	if (flags.words || wantDefault) fields.push(String(counts.wordCount));
	if (flags.bytes || wantDefault) fields.push(String(counts.byteCount));
	if (flags.chars) fields.push(String(counts.charCount));

	return fields.join(" ");
}

function parse_args(command: "head" | "tail" | "wc", args: string[]) {
	const files: string[] = [];
	let lineCount: number | null = null;
	let lineCountFromStart = false;
	let byteMode = false;
	const wcFlags: WcCommandFlags = { lines: false, words: false, chars: false, bytes: false };
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			files.push(arg);
			continue;
		}

		if (arg === "--") {
			optionsEnded = true;
			continue;
		}

		if (command === "wc") {
			if (arg === "-l" || arg === "--lines") {
				wcFlags.lines = true;
				continue;
			}
			if (arg === "-w" || arg === "--words") {
				wcFlags.words = true;
				continue;
			}
			if (arg === "-c" || arg === "--bytes") {
				wcFlags.bytes = true;
				continue;
			}
			if (arg === "-m" || arg === "--chars") {
				wcFlags.chars = true;
				continue;
			}
			if (WC_COMBINED_FLAGS_REGEX.test(arg)) {
				for (const ch of arg.slice(1)) {
					if (ch === "l") wcFlags.lines = true;
					else if (ch === "w") wcFlags.words = true;
					else if (ch === "c") wcFlags.bytes = true;
					else if (ch === "m") wcFlags.chars = true;
				}
				continue;
			}
		} else {
			if (arg === "-n" || arg === "--lines") {
				const parsed = parse_line_count(command, arg, args[index + 1]);
				if (parsed._nay) return Result({ _nay: parsed._nay });
				lineCount = parsed._yay.count;
				lineCountFromStart = parsed._yay.fromStart;
				index++;
				continue;
			}
			if (arg === "-c" || arg === "--bytes") {
				byteMode = true;
				// Keep the original argv for delegated small-file reads, but consume the
				// byte count here so it is not mistaken for a file operand in app-file routing.
				index++;
				continue;
			}
			if (arg.startsWith("--lines=")) {
				const parsed = parse_line_count(command, "--lines", arg.slice("--lines=".length));
				if (parsed._nay) return Result({ _nay: parsed._nay });
				lineCount = parsed._yay.count;
				lineCountFromStart = parsed._yay.fromStart;
				continue;
			}
			if (arg.startsWith("--bytes=")) {
				byteMode = true;
				continue;
			}
			const obsoleteLineCount = OBSOLETE_LINE_COUNT_FLAG_REGEX.exec(arg);
			if (obsoleteLineCount) {
				lineCount = Number(obsoleteLineCount[1]);
				lineCountFromStart = false;
				continue;
			}
			if (arg.startsWith("-n")) {
				const parsed = parse_line_count(command, "-n", arg.slice(2));
				if (parsed._nay) return Result({ _nay: parsed._nay });
				lineCount = parsed._yay.count;
				lineCountFromStart = parsed._yay.fromStart;
				continue;
			}
			if (arg.startsWith("-c")) {
				byteMode = true;
				continue;
			}
			if (arg === "-q" || arg === "--quiet" || arg === "-v" || arg === "--verbose") {
				continue;
			}
		}

		if (!arg.startsWith("-") || arg === "-") {
			files.push(arg);
		}
	}

	return Result({
		_yay: {
			files,
			lineCount,
			lineCountFromStart,
			byteMode,
			wcFlags,
		} as const,
	});
}

/**
 * Returns the first app-file operand whose byte size exceeds the inline read cap, so readers
 * can refuse to pull a multi-MB file in one shot. Unknown sizes (unmaterialized) are allowed
 * through to the normal path.
 */
async function find_oversized_file_operand(
	ctx: ActionCtx,
	dbFilesRoots: bash_DbFilesRoots,
	commandCtx: CommandContext,
	files: string[],
): Promise<ReaderCommandOversizedFileOperand | null> {
	for (const file of files) {
		if (file === "-") continue;

		const pathResolution = bash_resolve_db_files_shell_path(bash_resolve_path(commandCtx.cwd, file), dbFilesRoots);
		if (pathResolution.dbFilesPath == null) continue;

		const dbFilesDoc: files_nodes_get_by_path_Result =
			pathResolution.dbFilesPath === "/"
				? null
				: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
						organizationId: pathResolution.ctxData.organizationId,
						workspaceId: pathResolution.ctxData.workspaceId,
						path: pathResolution.dbFilesPath,
					})) as files_nodes_get_by_path_Result);
		if (dbFilesDoc == null) continue;

		const size: number | null = await bash_get_db_file_byte_size({ ctx, ctxData: pathResolution.ctxData, dbFilesDoc });
		if (size != null && size > bash_READ_INLINE_MAX_BYTES) {
			return {
				file,
				dbFilesPath: pathResolution.dbFilesPath,
				size,
				contentType: dbFilesDoc.contentType,
				hasEditableYjsState: dbFilesDoc.kind === "file" && files_node_has_editable_yjs_state(dbFilesDoc),
				pathResolution,
			} as const;
		}
	}
	return null;
}

/**
 * Route `head`, `tail`, and `wc` through app-aware fast paths before falling back:
 * app-only `wc` uses bounded stats, oversized app files use bounded pages or
 * refusal guidance, single app-file `head`/`tail` reads use materialized chunks,
 * unreadable app probes return app advisories, and all remaining cases delegate
 * to the built-in command.
 */
export function bash_head_tail_wc_command_create(
	ctx: ActionCtx,
	dbFilesRoots: bash_DbFilesRoots,
	command: "head" | "tail" | "wc",
): Command {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand(command, async (args, commandCtx) => {
		const lineCountUsage = `Usage: ${command} [-n N] [FILE...]\n`;
		const parsed = parse_args(command, args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\n${lineCountUsage}`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		const { files, lineCount, lineCountFromStart, byteMode, wcFlags } = parsed._yay;

		for (const file of files) {
			if (
				file !== "-" &&
				bash_GLOB_METACHARACTER_REGEX.test(file) &&
				bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, file))
			) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message(command, file),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}

		const capError = bash_enforce_reader_operand_cap(command, commandCtx, currentWorkspacePath, files);
		if (capError != null) return capError;

		// App-file wc uses the bounded stats path so even a single file never needs a full read.
		// Mixed/real-fs/stdin batches fall through to the builtin.
		if (
			command === "wc" &&
			files.length >= 1 &&
			files.every(
				(file) =>
					file !== "-" &&
					bash_resolve_db_files_shell_path(bash_resolve_path(commandCtx.cwd, file), dbFilesRoots).dbFilesPath != null,
			)
		) {
			const totals = { lineCount: 0, wordCount: 0, charCount: 0, byteCount: 0 };
			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			let anyWindowed = false;
			for (const file of files) {
				const pathResolution = bash_resolve_db_files_shell_path(bash_resolve_path(commandCtx.cwd, file), dbFilesRoots);
				const dbFilesPath = pathResolution.dbFilesPath;
				if (dbFilesPath == null) {
					// Unreachable: the surrounding branch requires every operand to resolve to an app file path.
					throw should_never_happen("wc: operand stopped resolving to an app file path", { file });
				}

				const stats = (await ctx.runAction(internal.files_nodes.read_file_content_stats, {
					organizationId: pathResolution.ctxData.organizationId,
					workspaceId: pathResolution.ctxData.workspaceId,
					userId: pathResolution.ctxData.userId,
					path: dbFilesPath,
				})) as files_nodes_read_file_content_stats_Result;
				if (!stats) {
					const dbFilesDoc: files_nodes_get_by_path_Result =
						dbFilesPath === "/"
							? null
							: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
									organizationId: pathResolution.ctxData.organizationId,
									workspaceId: pathResolution.ctxData.workspaceId,
									path: dbFilesPath,
								})) as files_nodes_get_by_path_Result);

					if (dbFilesPath === "/" || dbFilesDoc?.kind === "folder") {
						stderr += `wc: ${file}: Is a directory\n`;
					} else if (dbFilesDoc?.kind === "file") {
						stderr += bash_build_unreadable_file_advisory(pathResolution.basePath, dbFilesPath, dbFilesDoc.contentType);
						if (wcFlags.bytes || wants_default(wcFlags)) {
							stderr += bash_format_multiline_hint("wc", [
								`For the byte size of this app file, use: stat -c %s ${bash_shell_arg_quote(pathResolution.renderShellPath(dbFilesPath))}`,
							]);
						}
					} else {
						stderr += `wc: ${file}: No such file or directory\n`;
					}
					exitCode = bash_COMMAND_EXIT_FAILURE;
					continue;
				}

				totals.lineCount += stats.lineCount;
				totals.wordCount += stats.wordCount;
				totals.charCount += stats.charCount;
				totals.byteCount += stats.byteCount;

				if (!stats.exact) anyWindowed = true;
				stdout += `${build_fields(wcFlags, stats)} ${file}\n`;
			}

			if (files.length > 1) {
				stdout += `${build_fields(wcFlags, totals)} total\n`;
			}

			// Byte counts are always exact; only line/word/char come from a bounded window.
			const windowedRequested = wcFlags.lines || wcFlags.words || wcFlags.chars || wants_default(wcFlags);
			if (anyWindowed && windowedRequested) {
				stderr += bash_format_multiline_hint("wc", [
					"one or more files exceed the scan window; line/word/char counts are lower bounds. Byte counts are exact.",
				]);
			}

			return { stdout, stderr, exitCode };
		}

		// Large files would pull megabytes through a full read; gate them. head/tail/wc map to
		// bounded line reads served from materialized chunks (any depth); byte-mode (head -c) and
		// multi-file batches still refuse with guidance below.
		const oversized = await find_oversized_file_operand(ctx, dbFilesRoots, commandCtx, files);
		if (oversized != null) {
			// Large files are read in bounded pages. head/tail map to bounded line reads; a
			// single file operand is required so the page output is unambiguous.
			if ((command === "head" || command === "tail") && byteMode && files.length === 1) {
				return {
					stdout: "",
					stderr: `${command}: byte-range reads (-c) are not supported for large app files; use ${command} -n N (lines) or wc -c ${bash_shell_arg_quote(
						oversized.pathResolution.renderShellPath(oversized.dbFilesPath),
					)} for the byte count.\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			if ((command === "head" || command === "tail") && !byteMode && files.length === 1) {
				const oversizedFileShellPath = oversized.pathResolution.renderShellPath(oversized.dbFilesPath);

				// `tail -n +K`: output from line K onward — a forward read at an offset, not a trailing
				// window. Serve it from the same bounded forward reader head uses (paged via sed).
				if (command === "tail" && lineCountFromStart && lineCount != null) {
					const startLine = Math.max(1, lineCount);
					const maxLines = bash_READ_HEAD_LARGE_FILE_MAX_LINES;
					const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						organizationId: oversized.pathResolution.ctxData.organizationId,
						workspaceId: oversized.pathResolution.ctxData.workspaceId,
						userId: oversized.pathResolution.ctxData.userId,
						path: oversized.dbFilesPath,
						startLine,
						maxLines,
					})) as files_nodes_read_file_line_range_Result;

					if (!result) {
						return {
							stdout: "",
							stderr: oversized.hasEditableYjsState
								? `tail: ${oversized.file}: content is not available from materialized chunks\n`
								: bash_build_unreadable_file_advisory(
										oversized.pathResolution.basePath,
										oversized.dbFilesPath,
										oversized.contentType,
									),
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}

					const stdout = result.content;
					const notes: string[] = [];

					if (result.moreLines && !result.scanTruncated) {
						notes.push(
							`More lines below. ${bash_sed_command_build_next_page_hint({
								nextStartLine: startLine + maxLines,
								maxLines,
								shellPath: oversizedFileShellPath,
							})}`,
						);
					}

					if (result.scanTruncated) {
						notes.push("large file; only the first scanned block was read; output may be incomplete");
					}

					return { stdout, stderr: bash_format_multiline_hint("tail", notes), exitCode: 0 };
				}

				const requestedLines = lineCount ?? 10;
				// Clamp (don't refuse) an over-large -n to the per-page cap, and note it.
				const maxLines = Math.min(requestedLines, bash_READ_HEAD_LARGE_FILE_MAX_LINES);
				const clampNote =
					requestedLines > bash_READ_HEAD_LARGE_FILE_MAX_LINES
						? `showing ${maxLines} lines (per-page cap); page again to read further`
						: null;
				if (command === "head") {
					const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						organizationId: oversized.pathResolution.ctxData.organizationId,
						workspaceId: oversized.pathResolution.ctxData.workspaceId,
						userId: oversized.pathResolution.ctxData.userId,
						path: oversized.dbFilesPath,
						startLine: 1,
						maxLines,
					})) as files_nodes_read_file_line_range_Result;

					if (!result) {
						return {
							stdout: "",
							stderr: oversized.hasEditableYjsState
								? `head: ${oversized.file}: content is not available from materialized chunks\n`
								: bash_build_unreadable_file_advisory(
										oversized.pathResolution.basePath,
										oversized.dbFilesPath,
										oversized.contentType,
									),
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}

					const stdout = result.content;
					const notes: string[] = [];

					if (clampNote) notes.push(clampNote);
					if (result.moreLines && !result.scanTruncated) {
						// Point the agent at the next page via sed line ranges (plain bash paging).
						notes.push(
							`More lines below. ${bash_sed_command_build_next_page_hint({
								nextStartLine: maxLines + 1,
								maxLines,
								shellPath: oversizedFileShellPath,
							})}`,
						);
					}
					if (result.scanTruncated) {
						notes.push("large file; only the first scanned block was read; output may be incomplete");
					}

					return { stdout, stderr: bash_format_multiline_hint("head", notes), exitCode: 0 };
				}

				const result = (await ctx.runAction(internal.files_nodes.read_file_tail_lines, {
					organizationId: oversized.pathResolution.ctxData.organizationId,
					workspaceId: oversized.pathResolution.ctxData.workspaceId,
					userId: oversized.pathResolution.ctxData.userId,
					path: oversized.dbFilesPath,
					maxLines,
				})) as files_nodes_read_file_tail_lines_Result;

				if (!result) {
					return {
						stdout: "",
						stderr: oversized.hasEditableYjsState
							? `tail: ${oversized.file}: content is not available from materialized chunks\n`
							: bash_build_unreadable_file_advisory(
									oversized.pathResolution.basePath,
									oversized.dbFilesPath,
									oversized.contentType,
								),
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}

				const stdout = result.content;
				const tailNotes: string[] = [];

				if (clampNote) tailNotes.push(clampNote);
				if (result.scanTruncated) {
					tailNotes.push("large file; only the trailing block was read");
				} else if (result.moreLines) {
					// Signal that this is a partial end-of-file view and point at the top of the file.
					tailNotes.push(
						`showing the last ${maxLines} lines; earlier lines precede them. Read from the top with: head -n ${maxLines} ${bash_shell_arg_quote(
							oversizedFileShellPath,
						)}`,
					);
				}

				return { stdout, stderr: bash_format_multiline_hint("tail", tailNotes), exitCode: 0 };
			}

			const hint =
				command === "head"
					? `Use head -n N (line mode, single file, N<=${bash_READ_HEAD_LARGE_FILE_MAX_LINES}) to read the start, then the printed sed -n page command to continue.`
					: command === "tail"
						? `Use tail -n N (line mode, single file, N<=${bash_READ_HEAD_LARGE_FILE_MAX_LINES}) to read the end.`
						: "Read with head -n N / sed -n 'A,Bp' / tail -n N, or use search for content.";
			return {
				stdout: "",
				stderr: `${command}: '${oversized.file}' is ${oversized.size} bytes, over the ${bash_READ_INLINE_MAX_BYTES}-byte inline read limit. ${hint}\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		if ((command === "head" || command === "tail") && !byteMode && files.length === 1) {
			const file = files[0];
			if (file !== "-") {
				const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
				const pathResolution = bash_resolve_db_files_shell_path(resolvedPath, dbFilesRoots);
				const dbFilesPath = pathResolution.dbFilesPath;

				if (dbFilesPath != null) {
					const chunkRead = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
						organizationId: pathResolution.ctxData.organizationId,
						workspaceId: pathResolution.ctxData.workspaceId,
						userId: pathResolution.ctxData.userId,
						path: dbFilesPath,
						mode: {
							kind: "full",
							maxBytes: bash_READ_INLINE_MAX_BYTES,
						},
					})) as files_nodes_read_file_content_from_chunks_Result;

					if (chunkRead) {
						const content = chunkRead.content;
						const hasTrailingNewline = content.endsWith("\n");
						const lines = (hasTrailingNewline ? content.slice(0, -1) : content).split("\n");
						const requestedLines = lineCount ?? 10;

						const selected =
							command === "head"
								? lines.slice(0, requestedLines)
								: lineCountFromStart
									? lines.slice(Math.max(0, requestedLines - 1))
									: lines.slice(-requestedLines);

						const stdout =
							selected.length === 0
								? ""
								: `${selected.join("\n")}${hasTrailingNewline || selected.length < lines.length ? "\n" : ""}`;

						return { stdout, stderr: "", exitCode: 0 };
					}

					const dbFilesDoc: files_nodes_get_by_path_Result =
						dbFilesPath === "/"
							? null
							: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
									organizationId: pathResolution.ctxData.organizationId,
									workspaceId: pathResolution.ctxData.workspaceId,
									path: dbFilesPath,
								})) as files_nodes_get_by_path_Result);

					if (dbFilesPath === "/" || dbFilesDoc?.kind === "folder") {
						return {
							stdout: "",
							stderr: `${command}: ${file}: Is a directory\n`,
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}

					if (dbFilesDoc?.kind === "file") {
						return {
							stdout: "",
							stderr: files_node_has_editable_yjs_state(dbFilesDoc)
								? `${command}: ${file}: content is not available from materialized chunks\n`
								: bash_build_unreadable_file_advisory(pathResolution.basePath, dbFilesPath, dbFilesDoc.contentType),
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}

					return {
						stdout: "",
						stderr: `${command}: ${file}: No such file or directory\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
			}
		}

		for (const file of files) {
			if (file === "-") continue;

			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
			const pathResolution = bash_resolve_db_files_shell_path(resolvedPath, dbFilesRoots);
			if (pathResolution.dbFilesPath == null) continue;

			try {
				await commandCtx.fs.readFile(resolvedPath);
			} catch (error) {
				if (error instanceof bash_DbFilesContentUnavailableError) {
					return {
						stdout: "",
						stderr: bash_build_unreadable_file_advisory(
							pathResolution.basePath,
							pathResolution.dbFilesPath,
							error.contentType,
						),
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
			}
		}

		try {
			return await bash_delegate_builtin_command({ command, args, commandCtx });
		} catch (error) {
			if (error instanceof bash_DbFilesContentUnavailableError) {
				const pathResolution = bash_resolve_db_files_shell_path(error.shellPath, dbFilesRoots);
				return {
					stdout: "",
					stderr: bash_build_unreadable_file_advisory(
						pathResolution.basePath,
						pathResolution.dbFilesPath ?? error.shellPath,
						error.contentType,
					),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			throw error;
		}
	});
}
