import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_get_by_path_Result, files_nodes_read_file_line_range_Result } from "../convex/files_nodes.ts";
import {
	bash_app_file_node_path_to_current_project_path,
	bash_build_unreadable_file_advisory,
	bash_current_project_path_to_app_file_node_path,
	bash_delegate_native_just_bash_tmp_command,
	bash_format_multiline_hint,
	bash_READ_HEAD_LARGE_FILE_MAX_LINES,
	bash_resolve_path,
	bash_shell_arg_quote,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;

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

export function bash_sed_command_build_next_page_hint(args: { nextStartLine: number; maxLines: number; shellPath: string }) {
	return `Next page: sed -n '${args.nextStartLine},${args.nextStartLine + args.maxLines - 1}p' ${bash_shell_arg_quote(args.shellPath)}`;
}

/**
 * `sed` with a special fast path for bounded line-range reads of an app file:
 * `sed -n 'A,Bp' <file>` (or `sed -n 'Ap' <file>`) reads exactly that line range via a
 * bounded read, so the agent can page through a large file (this is what `head`/`sed`
 * continuation hints point to). Any other sed usage falls back to the standard guard:
 * app-file operands must be piped through cat; non-app operands delegate to the builtin.
 */
export function bash_sed_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
	const command = defineCommand("sed", async (args, commandCtx) => {
		const fastPath = parse_app_fast_path(args);
		if (fastPath != null) {
			const appFileNodePath = bash_current_project_path_to_app_file_node_path(
				currentProjectPath,
				bash_resolve_path(commandCtx.cwd, fastPath.file),
			);
			if (appFileNodePath != null) {
				if (fastPath.startLine < 1 || fastPath.endLine < 1 || fastPath.endLine < fastPath.startLine) {
					return {
						stdout: "",
						stderr: `sed: invalid line range '${fastPath.script}'\n`,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				const maxLines = fastPath.endLine - fastPath.startLine + 1;
				if (maxLines > bash_READ_HEAD_LARGE_FILE_MAX_LINES) {
					return {
						stdout: "",
						stderr: `sed: line range too large (${maxLines} lines; max ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} per read). Narrow the range.\n`,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
					workspaceId: workspaceFs.ctxData.workspaceId,
					projectId: workspaceFs.ctxData.projectId,
					userId: workspaceFs.ctxData.userId,
					path: appFileNodePath,
					startLine: fastPath.startLine,
					maxLines,
				})) as files_nodes_read_file_line_range_Result;
				if (!result) {
					const fileNode: files_nodes_get_by_path_Result =
						appFileNodePath === "/"
							? null
							: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
									workspaceId: workspaceFs.ctxData.workspaceId,
									projectId: workspaceFs.ctxData.projectId,
									path: appFileNodePath,
								})) as files_nodes_get_by_path_Result);

					if (appFileNodePath === "/" || fileNode?.kind === "folder") {
						return {
							stdout: "",
							stderr: `sed: ${fastPath.file}: Is a directory\n`,
							exitCode: COMMAND_EXIT_FAILURE,
						};
					}

					if (fileNode?.kind === "file") {
						return {
							stdout: "",
							stderr: bash_build_unreadable_file_advisory(currentProjectPath, appFileNodePath, fileNode.contentType),
							exitCode: COMMAND_EXIT_FAILURE,
						};
					}

					return {
						stdout: "",
						stderr: `sed: ${fastPath.file}: No such file or directory\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}

				const stdout = result.content;
				const notes: string[] = [];

				if (result.moreLines && !result.scanTruncated) {
					notes.push(
						`More lines below. ${bash_sed_command_build_next_page_hint({
							nextStartLine: fastPath.endLine + 1,
							maxLines,
							shellPath: bash_app_file_node_path_to_current_project_path(currentProjectPath, appFileNodePath),
						})}`,
					);
				}

				if (result.scanTruncated) {
					notes.push("large file; only the scanned block was read; range may be incomplete");
				}

				return { stdout, stderr: bash_format_multiline_hint("sed", notes), exitCode: 0 };
			}
		}

		return await bash_delegate_native_just_bash_tmp_command("sed", args, commandCtx, currentProjectPath);
	});

	return command;
}
