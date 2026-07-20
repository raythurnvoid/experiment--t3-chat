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
import { Result } from "common/errors-as-values-utils.ts";
import { files_node_has_editable_yjs_state, files_pending_update_has_yjs_content } from "../shared/files.ts";
import { organizations_is_reserved_workspace_id, organizations_is_global_organization_id } from "../shared/organizations.ts";
import { bash_build_unreadable_file_advisory, bash_create_glob_syntax_unsupported_message, bash_enforce_reader_operand_cap, bash_format_multiline_hint, bash_GLOB_METACHARACTER_REGEX, bash_READ_HEAD_LARGE_FILE_MAX_LINES, bash_READ_INLINE_MAX_BYTES, bash_resolve_path, bash_shell_arg_quote, bash_resolve_db_files_shell_path, bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

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

export function bash_cat_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	const fileContentCache = new Map<string, string>();
	// A same-call mv/cp proposal changes what paths serve; clear this cache with the fs caches.
	dbFilesRoots.app.fs.linkProposalCache(fileContentCache);

	return defineCommand("cat", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: cat [-n] [--] [FILE...]\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// Keep `cat --help` on the built-in help path, while `cat -- --help`
		// remains a normal file operand.
		if ("delegate" in parsed._yay) {
			return await bash_delegate_builtin_command({ command: "cat", args, commandCtx });
		}

		const targets = parsed._yay.files.length ? parsed._yay.files : ["-"];
		const capError = bash_enforce_reader_operand_cap("cat", commandCtx, currentWorkspacePath, targets);
		if (capError != null) return capError;

		// Cat keeps app-file size lookups inline. Routing them through
		// bash_get_db_file_byte_size reintroduces a TypeScript inference cycle through
		// the inline customCommands array.

		// Multi-file cat is all-or-nothing. If one app file is too large to read inline,
		// inserting only its first page into the concatenation would look like real file
		// content and corrupt any downstream pipe. Refuse before writing stdout.
		if (targets.length > 1) {
			for (const file of targets) {
				if (file === "-" || bash_GLOB_METACHARACTER_REGEX.test(file)) continue;

				const pathResolution = bash_resolve_db_files_shell_path(bash_resolve_path(commandCtx.cwd, file), dbFilesRoots);
				if (pathResolution.dbFilesPath == null) continue;

				const dbFilesDoc: Doc<"files_nodes"> | null =
					pathResolution.dbFilesPath === "/"
						? null
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								organizationId: pathResolution.ctxData.organizationId,
								workspaceId: pathResolution.ctxData.workspaceId,
								path: pathResolution.dbFilesPath,
								overlayUserId: pathResolution.fs.overlayUserId,
							})) as files_nodes_get_by_path_Result);
				let size: number | null = null;
				if (dbFilesDoc?.kind === "file" && dbFilesDoc.assetId != null) {
					let hasPendingUpdate = false;
					const organizationId = pathResolution.ctxData.organizationId;
					const workspaceId = pathResolution.ctxData.workspaceId;
					if (
						files_node_has_editable_yjs_state(dbFilesDoc) &&
						!organizations_is_global_organization_id(organizationId) &&
						!organizations_is_reserved_workspace_id(workspaceId)
					) {
						const pendingUpdate = (await ctx.runQuery(internal.files_pending_updates.get_by_file_node, {
							organizationId,
							workspaceId,
							userId: pathResolution.ctxData.userId,
							fileNodeId: dbFilesDoc._id,
						})) as files_pending_updates_get_by_file_node_Result;
						// A move-only pending update doc stores size 0; only a content-bearing doc may shadow the committed asset size.
						if (files_pending_update_has_yjs_content(pendingUpdate)) {
							hasPendingUpdate = true;
							size = pendingUpdate.size;
						}
					}
					if (!hasPendingUpdate) {
						const asset = (await ctx.runQuery(internal.r2.get_asset_by_id, {
							organizationId: pathResolution.ctxData.organizationId,
							workspaceId: pathResolution.ctxData.workspaceId,
							assetId: dbFilesDoc.assetId,
						})) as get_asset_by_id_Result;
						size = asset?.size ?? null;
					}
				}

				if (size != null && size > bash_READ_INLINE_MAX_BYTES) {
					return {
						stdout: "",
						stderr: `cat: ${file}: ${size} bytes — too large to concatenate. Read large files one at a time (e.g. head -n ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} ${bash_shell_arg_quote(file)} or wc ${bash_shell_arg_quote(file)}).\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
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
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}

			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
			const pathResolution = bash_resolve_db_files_shell_path(resolvedPath, dbFilesRoots);
			const target = {
				resolvedPath,
				dbFilesPath: pathResolution.dbFilesPath,
			};

			// Check the current byte size before reading. Unsaved edits can be larger
			// than the committed file, and each command asks Convex for fresh metadata.
			if (target.dbFilesPath != null) {
				const dbFilesDoc: Doc<"files_nodes"> | null =
					target.dbFilesPath === "/"
						? null
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								organizationId: pathResolution.ctxData.organizationId,
								workspaceId: pathResolution.ctxData.workspaceId,
								path: target.dbFilesPath,
								overlayUserId: pathResolution.fs.overlayUserId,
							})) as files_nodes_get_by_path_Result);

				let size: number | null = null;
				if (dbFilesDoc?.kind === "file" && dbFilesDoc.assetId != null) {
					let hasPendingUpdate = false;
					const organizationId = pathResolution.ctxData.organizationId;
					const workspaceId = pathResolution.ctxData.workspaceId;
					if (
						files_node_has_editable_yjs_state(dbFilesDoc) &&
						!organizations_is_global_organization_id(organizationId) &&
						!organizations_is_reserved_workspace_id(workspaceId)
					) {
						const pendingUpdate = (await ctx.runQuery(internal.files_pending_updates.get_by_file_node, {
							organizationId,
							workspaceId,
							userId: pathResolution.ctxData.userId,
							fileNodeId: dbFilesDoc._id,
						})) as files_pending_updates_get_by_file_node_Result;
						// A move-only pending update doc stores size 0; only a content-bearing doc may shadow the committed asset size.
						if (files_pending_update_has_yjs_content(pendingUpdate)) {
							hasPendingUpdate = true;
							size = pendingUpdate.size;
						}
					}
					if (!hasPendingUpdate) {
						const asset = (await ctx.runQuery(internal.r2.get_asset_by_id, {
							organizationId: pathResolution.ctxData.organizationId,
							workspaceId: pathResolution.ctxData.workspaceId,
							assetId: dbFilesDoc.assetId,
						})) as get_asset_by_id_Result;
						size = asset?.size ?? null;
					}
				}

				// Large app file: show a bounded first page instead of dumping the
				// whole file. The footer tells the agent how to continue without
				// implying that stdout contains the complete file.
				if (size != null && size > bash_READ_INLINE_MAX_BYTES) {
					const resolvedAppShellPath = pathResolution.renderShellPath(target.dbFilesPath);

					const page = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
						organizationId: pathResolution.ctxData.organizationId,
						workspaceId: pathResolution.ctxData.workspaceId,
						userId: pathResolution.ctxData.userId,
						path: target.dbFilesPath,
						overlayUserId: pathResolution.fs.overlayUserId,
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
						if (dbFilesDoc?.kind === "file") {
							stderr += files_node_has_editable_yjs_state(dbFilesDoc)
								? `cat: ${file}: content is not available from materialized chunks\n`
								: bash_build_unreadable_file_advisory(
										pathResolution.basePath,
										target.dbFilesPath,
										dbFilesDoc.contentType,
									);
						} else {
							stderr +=
								dbFilesDoc?.kind === "folder"
									? `cat: ${file}: Is a directory\n`
									: `cat: ${file}: No such file or directory\n`;
						}
						exitCode = bash_COMMAND_EXIT_FAILURE;
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

				// Small app-file cat stays query-only and chunk-backed. bash_DbFilesFs.readFile
				// still has a legacy full-content action fallback for other callers, but
				// cat output should be predictable and should not pull a whole file through
				// the action path after chunks say they cannot serve it.
				const cached = fileContentCache.get(target.dbFilesPath);
				if (cached != null) {
					appendContent(cached, parsed._yay.showLineNumbers);
					continue;
				}

				const chunkRead = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
					organizationId: pathResolution.ctxData.organizationId,
					workspaceId: pathResolution.ctxData.workspaceId,
					userId: pathResolution.ctxData.userId,
					path: target.dbFilesPath,
					overlayUserId: pathResolution.fs.overlayUserId,
					mode: {
						kind: "full",
						maxBytes: bash_READ_INLINE_MAX_BYTES,
					},
				})) as files_nodes_read_file_content_from_chunks_Result;

				if (chunkRead) {
					fileContentCache.set(target.dbFilesPath, chunkRead.content);
					appendContent(chunkRead.content, parsed._yay.showLineNumbers);
					continue;
				}

				// No chunk content means cat has no stdout for this operand. Check the
				// node only to choose the right stderr message and exit status.
				if (target.dbFilesPath === "/" || dbFilesDoc?.kind === "folder") {
					stderr += `cat: ${file}: Is a directory\n`;
					exitCode = bash_COMMAND_EXIT_FAILURE;
					continue;
				}

				if (dbFilesDoc?.kind === "file") {
					// Advisory belongs on stderr so `cat unreadable | grep ...` cannot match it
					// as if it were file content.
					stderr += files_node_has_editable_yjs_state(dbFilesDoc)
						? `cat: ${file}: content is not available from materialized chunks\n`
						: bash_build_unreadable_file_advisory(pathResolution.basePath, target.dbFilesPath, dbFilesDoc.contentType);
					exitCode = bash_COMMAND_EXIT_FAILURE;
					continue;
				}

				stderr += `cat: ${file}: No such file or directory\n`;
				exitCode = bash_COMMAND_EXIT_FAILURE;
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
				exitCode = bash_COMMAND_EXIT_FAILURE;
			}
		}

		return { stdout, stderr, exitCode };
	});
}
