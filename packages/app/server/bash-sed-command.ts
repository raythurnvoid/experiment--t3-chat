import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_get_by_path_Result, files_nodes_read_file_line_range_Result } from "../convex/files_nodes.ts";
import { bash_build_unreadable_file_advisory, bash_format_multiline_hint, bash_READ_HEAD_LARGE_FILE_MAX_LINES, bash_resolve_path, bash_shell_arg_quote, bash_resolve_db_files_shell_path, bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_delegate_native_just_bash_tmp_command } from "./bash-delegate.ts";

/**
 * Negative line numbers are accepted at parse time so app-file sed returns
 * the same clean invalid-range error as zero or reversed ranges.
 */
const SED_PRINT_RANGE_REGEX = /^(-?\d+)(?:,(-?\d+))?p$/u;

/**
 * Recognize the bounded app-file range form `sed -n 'A,Bp' <file>`.
 *
 * Other scripts are left to the /tmp-only Native Just Bash delegation path.
 */
function parse_app_fast_path(args: string[]) {
	let suppressAutoPrint = false;
	let optionsEnded = false;
	const operands: string[] = [];

	for (const arg of args) {
		if (!optionsEnded && operands.length === 0) {
			if (arg === "--") {
				optionsEnded = true;
				continue;
			}

			if (arg === "-n") {
				suppressAutoPrint = true;
				continue;
			}

			if (arg.startsWith("-") && !SED_PRINT_RANGE_REGEX.test(arg)) {
				return null;
			}
		}

		operands.push(arg);
	}

	if (!suppressAutoPrint || operands.length !== 2) {
		return null;
	}

	const rangeMatch = SED_PRINT_RANGE_REGEX.exec(operands[0]);
	if (!rangeMatch) {
		return null;
	}

	const startLine = Number(rangeMatch[1]);
	const endLine = rangeMatch[2] != null ? Number(rangeMatch[2]) : startLine;
	return { script: operands[0], file: operands[1], startLine, endLine } as const;
}

export function bash_sed_command_build_next_page_hint(args: {
	nextStartLine: number;
	maxLines: number;
	shellPath: string;
}) {
	return `Next page: sed -n '${args.nextStartLine},${args.nextStartLine + args.maxLines - 1}p' ${bash_shell_arg_quote(args.shellPath)}`;
}

/**
 * `sed` with a special fast path for bounded line-range reads of an app file:
 * `sed -n 'A,Bp' <file>` (or `sed -n 'Ap' <file>`) reads exactly that line range via a
 * bounded read, so the agent can page through a large file (this is what `head`/`sed`
 * continuation hints point to). Any other sed usage falls back to the standard guard:
 * app-file operands must be piped through cat; non-app operands delegate to the builtin.
 */
export function bash_sed_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	const command = defineCommand("sed", async (args, commandCtx) => {
		const fastPath = parse_app_fast_path(args);
		if (fastPath != null) {
			const pathResolution = bash_resolve_db_files_shell_path(
				bash_resolve_path(commandCtx.cwd, fastPath.file),
				dbFilesRoots,
			);
			const dbFilesPath = pathResolution.dbFilesPath;
			if (dbFilesPath != null) {
				if (fastPath.startLine < 1 || fastPath.endLine < 1 || fastPath.endLine < fastPath.startLine) {
					return {
						stdout: "",
						stderr: `sed: invalid line range '${fastPath.script}'\n`,
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				const maxLines = fastPath.endLine - fastPath.startLine + 1;
				if (maxLines > bash_READ_HEAD_LARGE_FILE_MAX_LINES) {
					return {
						stdout: "",
						stderr: `sed: line range too large (${maxLines} lines; max ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} per read). Narrow the range.\n`,
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
					organizationId: pathResolution.ctxData.organizationId,
					workspaceId: pathResolution.ctxData.workspaceId,
					userId: pathResolution.ctxData.userId,
					path: dbFilesPath,
					startLine: fastPath.startLine,
					maxLines,
				})) as files_nodes_read_file_line_range_Result;
				if (!result) {
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
							stderr: `sed: ${fastPath.file}: Is a directory\n`,
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}

					if (dbFilesDoc?.kind === "file") {
						return {
							stdout: "",
							stderr: bash_build_unreadable_file_advisory(pathResolution.basePath, dbFilesPath, dbFilesDoc.contentType),
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}

					return {
						stdout: "",
						stderr: `sed: ${fastPath.file}: No such file or directory\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}

				const stdout = result.content;
				const notes: string[] = [];

				if (result.moreLines && !result.scanTruncated) {
					notes.push(
						`More lines below. ${bash_sed_command_build_next_page_hint({
							nextStartLine: fastPath.endLine + 1,
							maxLines,
							shellPath: pathResolution.renderShellPath(dbFilesPath),
						})}`,
					);
				}

				if (result.scanTruncated) {
					notes.push("large file; only the scanned block was read; range may be incomplete");
				}

				return { stdout, stderr: bash_format_multiline_hint("sed", notes), exitCode: 0 };
			}
		}

		return await bash_delegate_native_just_bash_tmp_command("sed", args, commandCtx, currentWorkspacePath);
	});

	return command;
}
