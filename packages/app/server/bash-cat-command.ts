import { defineCommand, type Command } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_read_file_content_from_chunks_Result } from "../convex/files_nodes.ts";
import { Result } from "common/errors-as-values-utils.ts";
import {
	bash_DbFilesPermissionDeniedError,
	bash_build_unreadable_file_advisory,
	bash_create_glob_syntax_unsupported_message,
	bash_enforce_reader_operand_cap,
	bash_format_multiline_hint,
	bash_GLOB_METACHARACTER_REGEX,
	bash_get_db_file_byte_size,
	bash_READ_HEAD_LARGE_FILE_MAX_LINES,
	bash_READ_INLINE_MAX_BYTES,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_resolve_db_files_shell_path,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";
import { async_all_settled_with_limit } from "../shared/async-utils.ts";

// Each app file needs its own Convex queries, so read a few files at the same time. Keep the pool
// small: the deployment runs only a few queries at once for all users, and one chat step can run
// several Bash calls in parallel.
const CAT_READ_CONCURRENCY = 4;

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

function to_binary_string(content: string | Uint8Array) {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	let result = "";
	for (const byte of bytes) result += String.fromCharCode(byte);
	return result;
}

// The command boundary breaks inference through the generated action API.
export function bash_cat_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots): Command {
	const fileContentCache = new Map<string, string>();
	// A same-call mv/cp proposal changes what paths serve; clear this cache with the fs caches.
	for (const fs of [
		dbFilesRoots.app.fs,
		...(dbFilesRoots.personal ? [dbFilesRoots.personal.fs] : []),
		...Array.from(dbFilesRoots.externalMounts.mounts.values(), (mount) => mount.fs),
		...Array.from(dbFilesRoots.plugins.mounts.values(), (mount) => mount.fs),
	])
		fs.linkProposalCache(fileContentCache);

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
		const capError = bash_enforce_reader_operand_cap({ command: "cat", commandCtx, dbFilesRoots, files: targets });
		if (capError != null) return capError;

		const globFile = targets.find((file) => file !== "-" && bash_GLOB_METACHARACTER_REGEX.test(file));
		if (globFile != null) {
			return {
				stdout: "",
				stderr: bash_create_glob_syntax_unsupported_message("cat", globFile),
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// Look up each app file once, a few at a time. The size checks and the reads below reuse
		// these entries. Check the current byte size before reading: unsaved edits can be larger
		// than the committed file, and each command asks Convex for fresh metadata.
		const lookups = await async_all_settled_with_limit({
			items: targets,
			limit: CAT_READ_CONCURRENCY,
			run: async (file) => {
				if (file === "-") return { kind: "stdin", file } as const;

				const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
				const pathResolution = bash_resolve_db_files_shell_path(resolvedPath, dbFilesRoots);
				const dbFilesPath = pathResolution.dbFilesPath;
				if (dbFilesPath == null) return { kind: "native", file, resolvedPath } as const;

				let dbFilesDoc;
				try {
					dbFilesDoc = await pathResolution.fs.getEntry(dbFilesPath);
				} catch (error) {
					if (!(error instanceof bash_DbFilesPermissionDeniedError)) throw error;
					return { kind: "denied", file } as const;
				}
				const size = dbFilesDoc
					? await bash_get_db_file_byte_size({ ctx, ctxData: pathResolution.ctxData, dbFilesDoc })
					: null;
				return { kind: "db", file, pathResolution, dbFilesPath, dbFilesDoc, size } as const;
			},
		});
		// Throw the first unexpected error in operand order, after every started lookup has ended.
		const entries = lookups.map((lookup) => {
			if (lookup.status === "rejected") throw lookup.reason;
			return lookup.value;
		});

		// Multi-file cat is all-or-nothing. If one app file is too large to read inline,
		// inserting only its first page into the concatenation would look like real file
		// content and corrupt any downstream pipe. Refuse before writing stdout.
		if (entries.length > 1) {
			let totalBytes = 0;
			for (const entry of entries) {
				// A locked operand has no size here; the reads below report it.
				if (entry.kind !== "db") continue;

				if (entry.size != null && entry.size > bash_READ_INLINE_MAX_BYTES) {
					return {
						stdout: "",
						stderr: `cat: ${entry.file}: ${entry.size} bytes — too large to concatenate. Read large files one at a time (e.g. head -n ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} ${bash_shell_arg_quote(entry.file)} or wc ${bash_shell_arg_quote(entry.file)}).\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				totalBytes += entry.size ?? 0;
				if (totalBytes > bash_READ_INLINE_MAX_BYTES) {
					return {
						stdout: "",
						stderr: `cat: files exceed the ${bash_READ_INLINE_MAX_BYTES}-byte batch limit. Read fewer files per command.\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
			}
		}

		// The Bash call deadline aborts this signal. Do not start the reads after it; the shell then
		// reports the timeout and stops the remaining commands.
		if (commandCtx.signal?.aborted) {
			return { stdout: "", stderr: "", exitCode: bash_COMMAND_EXIT_FAILURE };
		}

		const reads = await async_all_settled_with_limit({
			items: entries,
			limit: CAT_READ_CONCURRENCY,
			run: async (entry) => {
				if (entry.kind === "stdin") {
					return { content: String(commandCtx.stdin ?? ""), stderr: "", failed: false };
				}

				if (entry.kind === "denied") {
					return { content: null, stderr: `cat: ${entry.file}: Permission denied\n`, failed: true };
				}

				// Non-app paths are normal Just Bash filesystem paths; read them through
				// the delegated filesystem so `/tmp` and stdin-style pipelines keep native behavior.
				if (entry.kind === "native") {
					try {
						return {
							content: to_binary_string(await commandCtx.fs.readFileBuffer(entry.resolvedPath)),
							stderr: "",
							failed: false,
						};
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						return {
							content: null,
							stderr: msg.startsWith("EISDIR")
								? `cat: ${entry.file}: Is a directory\n`
								: `cat: ${entry.file}: No such file or directory\n`,
							failed: true,
						};
					}
				}

				const { file, pathResolution, dbFilesPath, dbFilesDoc, size } = entry;

				// Large app file: show a bounded first page instead of dumping the
				// whole file. The footer tells the agent how to continue without
				// implying that stdout contains the complete file.
				if (size != null && size > bash_READ_INLINE_MAX_BYTES) {
					const resolvedAppShellPath = pathResolution.renderShellPath(dbFilesPath);

					const page = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
						agentSource: pathResolution.ctxData.agentSource,
						organizationId: pathResolution.ctxData.organizationId,
						workspaceId: pathResolution.ctxData.workspaceId,
						userId: pathResolution.ctxData.userId,
						subject: { kind: "user", userId: pathResolution.ctxData.userId, plugin: null },
						path: dbFilesPath,
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
							return {
								content: null,
								stderr:
									dbFilesDoc.textKind !== null
										? `cat: ${file}: content is not available from materialized chunks\n`
										: bash_build_unreadable_file_advisory({
												currentWorkspacePath: pathResolution.basePath,
												normalizedPath: dbFilesPath,
												contentType: dbFilesDoc.contentType,
											}),
								failed: true,
							};
						}
						return {
							content: null,
							stderr:
								dbFilesDoc?.kind === "folder"
									? `cat: ${file}: Is a directory\n`
									: `cat: ${file}: No such file or directory\n`,
							failed: true,
						};
					}

					// Content goes to stdout verbatim; the advisory goes to stderr so it never
					// contaminates a pipe (e.g. `cat big.md | grep …`).
					return {
						content: to_binary_string(page.content),
						stderr: bash_format_multiline_hint("cat", [
							`'${file}' is ${size} bytes; showing the first ${page.content.split("\n").length - 1} lines`,
							...(page.moreLines
								? [
										`Next page: sed -n '${page.content.split("\n").length},${page.content.split("\n").length + bash_READ_HEAD_LARGE_FILE_MAX_LINES - 1}p' ${bash_shell_arg_quote(resolvedAppShellPath)}`,
									]
								: []),
							`Full counts: wc ${bash_shell_arg_quote(file)}`,
						]),
						failed: false,
					};
				}

				// Small app-file cat stays query-only and chunk-backed. bash_DbFilesFs.readFile
				// still has a legacy full-content action fallback for other callers, but
				// cat output should be predictable and should not pull a whole file through
				// the action path after chunks say they cannot serve it.
				const cacheKey = `${pathResolution.ctxData.organizationId}:${pathResolution.ctxData.workspaceId}:${dbFilesPath}`;
				const cached = fileContentCache.get(cacheKey);
				// Volume access can change during the size lookup. Read it through Convex again.
				if (cached != null && pathResolution.fs.readOnlySource !== "volume") {
					return { content: to_binary_string(cached), stderr: "", failed: false };
				}

				const chunkRead = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
					agentSource: pathResolution.ctxData.agentSource,
					organizationId: pathResolution.ctxData.organizationId,
					workspaceId: pathResolution.ctxData.workspaceId,
					userId: pathResolution.ctxData.userId,
					subject: { kind: "user", userId: pathResolution.ctxData.userId, plugin: null },
					path: dbFilesPath,
					overlayUserId: pathResolution.fs.overlayUserId,
					mode: {
						kind: "full",
						maxBytes: bash_READ_INLINE_MAX_BYTES,
					},
				})) as files_nodes_read_file_content_from_chunks_Result;

				if (chunkRead) {
					// A later lookup finds a changed file only by comparing with its cached entry, and a
					// missing operand above may have cleared that entry. Store it again with the content,
					// or a later cat in this call could print old cached text.
					if (dbFilesDoc) pathResolution.fs.rememberEntry(dbFilesDoc);
					fileContentCache.set(cacheKey, chunkRead.content);
					return { content: to_binary_string(chunkRead.content), stderr: "", failed: false };
				}

				// No chunk content means cat has no stdout for this operand. Check the
				// node only to choose the right stderr message and exit status.
				if (dbFilesPath === "/" || dbFilesDoc?.kind === "folder") {
					return { content: null, stderr: `cat: ${file}: Is a directory\n`, failed: true };
				}

				// Advisory belongs on stderr so `cat unreadable | grep ...` cannot match it
				// as if it were file content.
				if (dbFilesDoc?.kind === "file") {
					return {
						content: null,
						stderr:
							dbFilesDoc.textKind !== null
								? `cat: ${file}: content is not available from materialized chunks\n`
								: bash_build_unreadable_file_advisory({
										currentWorkspacePath: pathResolution.basePath,
										normalizedPath: dbFilesPath,
										contentType: dbFilesDoc.contentType,
									}),
						failed: true,
					};
				}

				return { content: null, stderr: `cat: ${file}: No such file or directory\n`, failed: true };
			},
		});

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		let lineNumber = 1;

		// Join the results in operand order, whatever order the reads finished in.
		for (const read of reads) {
			if (read.status === "rejected") throw read.reason;

			const { content } = read.value;
			// `cat -n` numbers one continuous output stream, not each file independently.
			// Keep the next line number outside the loop so stdin and files share it.
			if (content != null && parsed._yay.showLineNumbers) {
				const numbered = add_line_numbers(content, lineNumber);
				stdout += numbered.content;
				lineNumber = numbered.nextLineNumber;
			} else if (content != null) {
				stdout += content;
			}
			stderr += read.value.stderr;
			if (read.value.failed) exitCode = bash_COMMAND_EXIT_FAILURE;
		}

		// stdin and native files are bytes; app text is encoded once above.
		return { stdout, stderr, exitCode, stdoutEncoding: "binary" as const };
	});
}
