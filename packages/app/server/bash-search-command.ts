import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_text_search_files_Result,
} from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_chunk_BITMASK_FLAGS, files_chunk_has_bitmask_flag } from "./files-markdown-chunking-mastra.ts";
import {
	bash_app_file_node_path_to_current_project_path,
	bash_clamp_listing_page_limit,
	bash_current_project_path_to_app_file_node_path,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_is_path_under_current_project_path,
	bash_normalize_path,
	bash_parse_limit,
	bash_read_option_value,
	bash_resolve_path,
	bash_search_command_build_continuation,
	bash_search_command_exact_query_filter,
	bash_search_command_exact_query_note,
	bash_search_command_exact_query_summary,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;

function parse_args(args: string[], options: { currentProjectPath: string; cwd: string }) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let pathValue: string | undefined;
	const queryParts: string[] = [];
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			queryParts.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "--code" || arg === "--table" || arg === "--no-code") {
			return Result({
				_nay: {
					message:
						`search: ${arg} is not supported for full-text content search.\n` +
						"Use plain content words or inspect a specific file with grep.",
				},
			});
		}
		if (arg === "--limit") {
			const value = bash_read_option_value("search", args, index, "--limit");
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
			const value = bash_read_option_value("search", args, index, "--cursor");
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
			const value = bash_read_option_value("search", args, index, "--path");
			if (value._nay) return value;
			pathValue = value._yay.value.trim();
			index++;
			continue;
		}
		if (arg.startsWith("--path=")) {
			pathValue = arg.slice("--path=".length).trim();
			continue;
		}
		if (arg.startsWith("--") || (arg.startsWith("-") && arg !== "-")) {
			return Result({ _nay: { message: `search: unsupported option ${arg}` } });
		}
		queryParts.push(arg);
	}

	const limit = bash_parse_limit("search", limitValue, 20, 100);
	if (limit._nay) {
		return limit;
	}

	const query = queryParts.join(" ").trim();
	if (!query) {
		return Result({
			_nay: { message: "search: missing query" },
		});
	}

	// A positional path is almost always a mistaken scope filter; point to --path instead of
	// silently folding it into the text query.
	const pathOperand = queryParts.find(
		(arg) =>
			arg.includes("/") ||
			arg.startsWith("~") ||
			arg === "." ||
			arg === ".." ||
			bash_is_path_under_current_project_path(options.currentProjectPath, bash_normalize_path(arg)),
	);
	if (pathOperand != null) {
		return Result({
			_nay: {
				message:
					`search: path operands are not supported: ${pathOperand}\n` +
					"Pass content words only. To restrict to one folder, use: search --path <folder> <content terms>",
			},
		});
	}

	// Convert the user-facing folder scope to the app path used by the chunk index.
	// The command handler verifies that this app path is an existing folder.
	let path: string | undefined;
	if (pathValue != null) {
		if (pathValue === "") {
			return Result({ _nay: { message: "search: --path requires a non-empty folder path" } });
		}
		const appFileNodePath = bash_current_project_path_to_app_file_node_path(
			options.currentProjectPath,
			bash_resolve_path(options.cwd, pathValue),
		);
		if (appFileNodePath == null) {
			return Result({
				_nay: {
					message:
						`search: --path must be a folder under the app file tree: ${pathValue}\n` +
						`Use a path under ${options.currentProjectPath}.`,
				},
			});
		}
		path = appFileNodePath;
	}

	return Result({
		_yay: {
			query,
			limit: limit._yay,
			cursor,
			path,
		},
	});
}

export function bash_search_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
	return defineCommand("search", async (args, commandCtx) => {
		const parsed = parse_args(args, { currentProjectPath, cwd: commandCtx.cwd });
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: search [--limit N] [--cursor CURSOR] [--path <folder>] <content terms...>\n`,
				exitCode: 2,
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

		// `search --path` is an exact folder scope, not a prefix scan.
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
					stderr: `search: --path folder does not exist: ${scopedShellPath}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if (scopedFolder.kind !== "folder") {
				return {
					stdout: "",
					stderr: `search: --path must be a folder: ${scopedShellPath}\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}

		const cwdAppFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, commandCtx.cwd);

		// Without --path, search follows cwd when it is inside currentProjectPath.
		const path =
			parsed._yay.path ?? (cwdAppFileNodePath != null && cwdAppFileNodePath !== "/" ? cwdAppFileNodePath : undefined);

		const res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
			workspaceId: workspaceFs.ctxData.workspaceId,
			projectId: workspaceFs.ctxData.projectId,
			userId: workspaceFs.ctxData.userId,
			query: parsed._yay.query,
			numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
			cursor,
			pathPrefix: path,
		})) as files_nodes_text_search_files_Result;

		const exactQueryFilter = bash_search_command_exact_query_filter(parsed._yay.query);
		const searchResult = {
			items: res.items.map((item) => ({
				...item,
				path: bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path),
			})),
		};

		const scopeNote =
			path != null ? ` under ${bash_app_file_node_path_to_current_project_path(currentProjectPath, path)}` : "";

		// The miss text is actionable because full-text search accepts plain
		// content terms, not path/name/glob syntax.
		let output =
			`No content matches found${scopeNote}. ` +
			`search expects words from the file content, not a shell pattern: ` +
			`pass one distinctive word or a few plain terms that should appear in the document body. ` +
			`The text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term. ` +
			`It is implemented with Convex full-text search, but it is not path/name/glob/regex search; ` +
			`use find -name QUERY or find --path-query QUERY for path/name discovery. ` +
			`YAML frontmatter fields are indexed separately from body text, so a frontmatter field or value will not match here; ` +
			`use meta search (e.g. exists/eq) to find files by a frontmatter field or value. ` +
			`Retry with shorter distinctive content terms if needed.`;

		if (searchResult.items.length) {
			const outputBlocks = searchResult.items.map((item) => {
				const isCodeChunk = files_chunk_has_bitmask_flag(item.chunkFlags, files_chunk_BITMASK_FLAGS.isCode);
				const isTableChunk = files_chunk_has_bitmask_flag(item.chunkFlags, files_chunk_BITMASK_FLAGS.isTable);
				const hasSpecificAbove = files_chunk_has_bitmask_flag(
					item.chunkFlags,
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove,
				);
				const hasSpecificBelow = files_chunk_has_bitmask_flag(
					item.chunkFlags,
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow,
				);

				// Each hit is one block: stable location metadata, optional context hints,
				// then the matched Markdown chunk exactly as it was indexed.
				const blockLines = [
					`${item.path} (lines ${item.lineStart}-${item.lineEnd}, chars ${item.startIndex}-${item.endIndex}, chunk #${item.chunkIndex})${bash_search_command_exact_query_note(exactQueryFilter, parsed._yay.query, item.markdownChunk)}`,
				];

				if (item.hasChunkAbove) {
					if (hasSpecificAbove && isCodeChunk) {
						blockLines.push("... more code block content above");
					} else if (hasSpecificAbove && isTableChunk) {
						blockLines.push("... more table content above");
					} else {
						blockLines.push("... more content above");
					}
				}

				blockLines.push(item.markdownChunk);

				if (item.hasChunkBelow) {
					if (hasSpecificBelow && isCodeChunk) {
						blockLines.push("... more code block content below");
					} else if (hasSpecificBelow && isTableChunk) {
						blockLines.push("... more table content below");
					} else {
						blockLines.push("... more content below");
					}
				}

				return blockLines.join("\n");
			});

			// Blank lines separate the summary, result blocks, and continuation command in the transcript.
			const blocks = [
				`Found ${searchResult.items.length} results${scopeNote}${bash_search_command_exact_query_summary(
					exactQueryFilter,
					searchResult.items.map((item) => item.markdownChunk),
				)}`,
			];
			if (!res.isDone) {
				// Print a complete command before long result snippets so an agent asked to
				// continue sees the exact command before a large content block.
				const cursorId = await bash_cursor_id_create(ctx, res.continueCursor);
				blocks.push(
					"",
					bash_search_command_build_continuation({
						currentProjectPath,
						path,
						limit: parsed._yay.limit,
						cursor: cursorId,
						query: parsed._yay.query,
					}),
					parsed._yay.cursor == null
						? "Note: if the user asked for a continuation, run the exact Next page command before answering."
						: "Note: this output is already a continuation page; if the user asked for exactly one continuation, stop here. Run another Next page only if the user asks for more.",
				);
			}
			blocks.push("", ...outputBlocks);
			output = blocks.join("\n");
		}

		return {
			stdout: `${output}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}
