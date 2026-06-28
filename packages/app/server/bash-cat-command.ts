import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { Doc } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_read_file_content_from_chunks_Result,
} from "../convex/files_nodes.ts";
import type { files_pending_updates_get_by_file_node_Result } from "../convex/files_pending_updates.ts";
import type { get_asset_by_id_Result } from "../convex/r2.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_node_has_editable_yjs_state } from "../shared/files.ts";
import {
	bash_app_file_node_path_to_current_project_path,
	bash_build_unreadable_file_advisory,
	bash_current_project_path_to_app_file_node_path,
	bash_create_glob_syntax_unsupported_message,
	bash_delegate_builtin_command,
	bash_enforce_reader_operand_cap,
	bash_format_multiline_hint,
	bash_GLOB_METACHARACTER_REGEX,
	bash_READ_HEAD_LARGE_FILE_MAX_LINES,
	bash_READ_INLINE_MAX_BYTES,
	bash_resolve_path,
	bash_shell_arg_quote,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;

function parse_args(args: string[]) {
	let showLineNumbers = false;
	const files: string[] = [];
	let optionsEnded = false;

	for (const arg of args) {
		// Native `cat -- -name` treats dash-leading tokens as file names.
		if (optionsEnded) {
			files.push(arg);
			continue;
		}

		if (arg === "--") {
			optionsEnded = true;
			continue;
		}

		// Keep help delegated so it stays aligned with Just Bash's built-in help.
		if (arg === "--help") {
			return Result({ _yay: { delegate: true } as const });
		}

		if (arg === "-n" || arg === "--number") {
			showLineNumbers = true;
			continue;
		}

		if (arg.startsWith("-") && arg !== "-") {
			return Result({ _nay: { message: `cat: unsupported option ${arg}` } });
		}

		files.push(arg);
	}

	return Result({
		_yay: {
			showLineNumbers,
			files,
		} as const,
	});
}

function add_line_numbers(content: string, startLine: number) {
	// Empty stdin is no content; do not invent a numbered blank line.
	if (content === "") {
		return { content: "", nextLineNumber: startLine };
	}
	const lines = content.split("\n");
	const hasTrailingNewline = content.endsWith("\n");
	const linesToNumber = hasTrailingNewline ? lines.slice(0, -1) : lines;
	const numbered = linesToNumber.map((line, index) => `${String(startLine + index).padStart(6)}\t${line}`);
	return {
		content: numbered.join("\n") + (hasTrailingNewline ? "\n" : ""),
		nextLineNumber: startLine + linesToNumber.length,
	};
}

export function bash_cat_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
	const appContentCache = new Map<string, string>();

	return defineCommand("cat", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: cat [-n] [--] [FILE...]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		// Keep `cat --help` on the built-in help path, while `cat -- --help`
		// remains a normal file operand.
		if ("delegate" in parsed._yay) {
			return await bash_delegate_builtin_command({ command: "cat", args, commandCtx });
		}

		const targets = parsed._yay.files.length ? parsed._yay.files : ["-"];
		const capError = bash_enforce_reader_operand_cap("cat", commandCtx, currentProjectPath, targets);
		if (capError != null) return capError;

		// Cat keeps app-file size lookups inline. Routing them through
		// get_app_file_byte_size reintroduces a TypeScript inference cycle through
		// the inline customCommands array.

		// Multi-file cat is all-or-nothing. If one app file is too large to read inline,
		// inserting only its first page into the concatenation would look like real file
		// content and corrupt any downstream pipe. Refuse before writing stdout.
		if (targets.length > 1) {
			for (const file of targets) {
				if (file === "-" || bash_GLOB_METACHARACTER_REGEX.test(file)) continue;

				const appFileNodePath = bash_current_project_path_to_app_file_node_path(
					currentProjectPath,
					bash_resolve_path(commandCtx.cwd, file),
				);
				if (appFileNodePath == null) continue;

				const fileNode: Doc<"files_nodes"> | null =
					appFileNodePath === "/"
						? null
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								workspaceId: workspaceFs.ctxData.workspaceId,
								projectId: workspaceFs.ctxData.projectId,
								path: appFileNodePath,
							})) as files_nodes_get_by_path_Result);
				let size: number | null = null;
				if (fileNode?.kind === "file" && fileNode.assetId != null) {
					let hasPendingUpdate = false;
					if (files_node_has_editable_yjs_state(fileNode)) {
						const pendingUpdate = (await ctx.runQuery(internal.files_pending_updates.get_by_file_node, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							userId: workspaceFs.ctxData.userId,
							fileNodeId: fileNode._id,
						})) as files_pending_updates_get_by_file_node_Result;
						if (pendingUpdate) {
							hasPendingUpdate = true;
							size = pendingUpdate.size;
						}
					}
					if (!hasPendingUpdate) {
						const asset = (await ctx.runQuery(internal.r2.get_asset_by_id, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							assetId: fileNode.assetId,
						})) as get_asset_by_id_Result;
						size = asset?.size ?? null;
					}
				}

				if (size != null && size > bash_READ_INLINE_MAX_BYTES) {
					return {
						stdout: "",
						stderr: `cat: ${file}: ${size} bytes — too large to concatenate. Read large files one at a time (e.g. head -n ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} ${bash_shell_arg_quote(file)} or wc ${bash_shell_arg_quote(file)}).\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}
			}
		}

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		let lineNumber = 1;

		const appendContent = (content: string, showLineNumbers: boolean) => {
			// `cat -n` numbers one continuous output stream, not each file independently.
			// Keep the next line number outside the per-file loop so stdin and files share it.
			if (showLineNumbers) {
				const numbered = add_line_numbers(content, lineNumber);
				stdout += numbered.content;
				lineNumber = numbered.nextLineNumber;
			} else {
				stdout += content;
			}
		};

		for (const file of targets) {
			if (file === "-") {
				appendContent(String(commandCtx.stdin ?? ""), parsed._yay.showLineNumbers);
				continue;
			}

			if (bash_GLOB_METACHARACTER_REGEX.test(file)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("cat", file),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
			const target = {
				resolvedPath,
				appFileNodePath: bash_current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath),
			};

			// Check the current byte size before reading. Unsaved edits can be larger
			// than the committed file, and each command asks Convex for fresh metadata.
			if (target.appFileNodePath != null) {
				const fileNode: Doc<"files_nodes"> | null =
					target.appFileNodePath === "/"
						? null
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								workspaceId: workspaceFs.ctxData.workspaceId,
								projectId: workspaceFs.ctxData.projectId,
								path: target.appFileNodePath,
							})) as files_nodes_get_by_path_Result);

				let size: number | null = null;
				if (fileNode?.kind === "file" && fileNode.assetId != null) {
					let hasPendingUpdate = false;
					if (files_node_has_editable_yjs_state(fileNode)) {
						const pendingUpdate = (await ctx.runQuery(internal.files_pending_updates.get_by_file_node, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							userId: workspaceFs.ctxData.userId,
							fileNodeId: fileNode._id,
						})) as files_pending_updates_get_by_file_node_Result;
						if (pendingUpdate) {
							hasPendingUpdate = true;
							size = pendingUpdate.size;
						}
					}
					if (!hasPendingUpdate) {
						const asset = (await ctx.runQuery(internal.r2.get_asset_by_id, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							assetId: fileNode.assetId,
						})) as get_asset_by_id_Result;
						size = asset?.size ?? null;
					}
				}

				// Large app file: show a bounded first page instead of dumping the
				// whole file. The footer tells the agent how to continue without
				// implying that stdout contains the complete file.
				if (size != null && size > bash_READ_INLINE_MAX_BYTES) {
					const resolvedAppShellPath = bash_app_file_node_path_to_current_project_path(
						currentProjectPath,
						target.appFileNodePath,
					);

					const page = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
						workspaceId: workspaceFs.ctxData.workspaceId,
						projectId: workspaceFs.ctxData.projectId,
						userId: workspaceFs.ctxData.userId,
						path: target.appFileNodePath,
						mode: {
							kind: "lines",
							startLine: 1,
							maxLines: bash_READ_HEAD_LARGE_FILE_MAX_LINES,
						},
					})) as files_nodes_read_file_content_from_chunks_Result;

					// Size metadata said this is a readable app file, but the chunk
					// query could not serve the requested page. Use the loaded node
					// to print the native-looking failure for files, folders, or misses.
					if (!page) {
						if (fileNode?.kind === "file") {
							stderr += files_node_has_editable_yjs_state(fileNode)
								? `cat: ${file}: content is not available from materialized chunks\n`
								: bash_build_unreadable_file_advisory(currentProjectPath, target.appFileNodePath, fileNode.contentType);
						} else {
							stderr +=
								fileNode?.kind === "folder"
									? `cat: ${file}: Is a directory\n`
									: `cat: ${file}: No such file or directory\n`;
						}
						exitCode = 1;
						continue;
					}

					// Content goes to stdout verbatim; the advisory goes to stderr so it never
					// contaminates a pipe (e.g. `cat big.md | grep …`).
					appendContent(page.content, parsed._yay.showLineNumbers);
					stderr += bash_format_multiline_hint("cat", [
						`'${file}' is ${size} bytes; showing the first ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines`,
						...(page.moreLines
							? [
									`Continue with: sed -n '${bash_READ_HEAD_LARGE_FILE_MAX_LINES + 1},${bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bash_shell_arg_quote(resolvedAppShellPath)}`,
								]
							: []),
						`Full counts: wc ${bash_shell_arg_quote(file)}`,
					]);
					continue;
				}

				// Small app-file cat stays query-only and chunk-backed. bash_WorkspaceFs.readFile
				// still has a legacy full-content action fallback for other callers, but
				// cat output should be predictable and should not pull a whole file through
				// the action path after chunks say they cannot serve it.
				const cached = appContentCache.get(target.appFileNodePath);
				if (cached != null) {
					appendContent(cached, parsed._yay.showLineNumbers);
					continue;
				}

				const chunkRead = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
					workspaceId: workspaceFs.ctxData.workspaceId,
					projectId: workspaceFs.ctxData.projectId,
					userId: workspaceFs.ctxData.userId,
					path: target.appFileNodePath,
					mode: {
						kind: "full",
						maxBytes: bash_READ_INLINE_MAX_BYTES,
					},
				})) as files_nodes_read_file_content_from_chunks_Result;

				if (chunkRead) {
					appContentCache.set(target.appFileNodePath, chunkRead.content);
					appendContent(chunkRead.content, parsed._yay.showLineNumbers);
					continue;
				}

				// No chunk content means cat has no stdout for this operand. Check the
				// node only to choose the right stderr message and exit status.
				if (target.appFileNodePath === "/" || fileNode?.kind === "folder") {
					stderr += `cat: ${file}: Is a directory\n`;
					exitCode = 1;
					continue;
				}

				if (fileNode?.kind === "file") {
					// Advisory belongs on stderr so `cat unreadable | grep ...` cannot match it
					// as if it were file content.
					stderr += files_node_has_editable_yjs_state(fileNode)
						? `cat: ${file}: content is not available from materialized chunks\n`
						: bash_build_unreadable_file_advisory(currentProjectPath, target.appFileNodePath, fileNode.contentType);
					exitCode = 1;
					continue;
				}

				stderr += `cat: ${file}: No such file or directory\n`;
				exitCode = 1;
				continue;
			}

			// Non-app paths are normal Just Bash filesystem paths; read them through
			// the delegated filesystem so `/tmp` and stdin-style pipelines keep native behavior.
			try {
				appendContent(await commandCtx.fs.readFile(target.resolvedPath), parsed._yay.showLineNumbers);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				stderr += msg.startsWith("EISDIR")
					? `cat: ${file}: Is a directory\n`
					: `cat: ${file}: No such file or directory\n`;
				exitCode = 1;
			}
		}

		return { stdout, stderr, exitCode };
	});
}
