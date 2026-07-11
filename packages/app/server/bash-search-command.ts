import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_get_by_path_Result, files_nodes_text_search_files_Result } from "../convex/files_nodes.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { files_chunk_BITMASK_FLAGS, files_chunk_has_bitmask_flag } from "./files-markdown-chunking-mastra.ts";
import {
	bash_clamp_listing_page_limit,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_is_path_under_current_workspace_path,
	bash_is_path_under_read_only_mounts,
	bash_normalize_path,
	bash_parse_limit,
	bash_external_mounts_fan_out_db_files_path,
	bash_external_mounts_fan_out_paginate,
	bash_plugins_fan_out_db_files_path,
	bash_plugins_fan_out_paginate,
	bash_read_option_value,
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

function parse_args(args: string[], options: { currentWorkspacePath: string; cwd: string }) {
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
			bash_is_path_under_current_workspace_path(options.currentWorkspacePath, bash_normalize_path(arg)) ||
			bash_is_path_under_read_only_mounts(bash_normalize_path(arg)),
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

	// Resolve the user-facing folder scope to an absolute shell path; the handler classifies it
	// (workspace vs. mount) and verifies it is an existing folder.
	let pathShell: string | undefined;
	if (pathValue != null) {
		if (pathValue === "") {
			return Result({ _nay: { message: "search: --path requires a non-empty folder path" } });
		}
		pathShell = bash_resolve_path(options.cwd, pathValue);
	}

	return Result({
		_yay: {
			query,
			limit: limit._yay,
			cursor,
			pathShell,
		},
	});
}

export function bash_search_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand("search", async (args, commandCtx) => {
		const parsed = parse_args(args, { currentWorkspacePath, cwd: commandCtx.cwd });
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: search [--limit N] [--cursor CURSOR] [--path <folder>] <content terms...>\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		let cursor: string | null = null;
		if (parsed._yay.cursor != null) {
			const resolvedCursor = await bash_cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return {
					stdout: "",
					stderr: `${resolvedCursor._nay.message}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			cursor = resolvedCursor._yay;
		}

		// search runs within one indexed tree (the workspace or a single mount) or fans out across a
		// mount root (`/.mounts`, `/.plugins`). The scope is the explicit --path folder when given,
		// otherwise the cwd. Classify it to pick the right scope IDs.
		const scopeShellPath = parsed._yay.pathShell ?? commandCtx.cwd;
		const scope = bash_resolve_db_files_shell_path(scopeShellPath, dbFilesRoots);

		// The `/.mounts` root fans out one indexed search per synced mount under a
		// composite cursor; with zero synced mounts the root itself does not exist.
		if (scope.kind === "external_mounts_root" && dbFilesRoots.externalMounts.mounts.size === 0) {
			return {
				stdout: "",
				stderr: `search: ${scope.basePath}: No such file or directory\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}
		// The `/.plugins` root fans out one indexed search per installed plugin under a
		// composite cursor; with zero installations the root itself does not exist.
		if (scope.kind === "plugins_root" && dbFilesRoots.plugins.mounts.size === 0) {
			return {
				stdout: "",
				stderr: `search: ${scope.basePath}: No such file or directory\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}
		// An explicit --path outside any indexed tree (e.g. /tmp or a not-installed plugin)
		// has nothing to search.
		if (
			parsed._yay.pathShell != null &&
			scope.dbFilesPath == null &&
			scope.kind !== "plugins_root" &&
			scope.kind !== "external_mounts_root"
		) {
			const normalizedScopeShellPath = bash_normalize_path(scopeShellPath);
			const mountHint = normalizedScopeShellPath.startsWith("/.mounts")
				? "/.mounts/<name>"
				: normalizedScopeShellPath.startsWith("/.plugins")
					? "/.plugins/<pluginName> (installed plugins only; run 'ls /.plugins')"
					: "a mount";
			return {
				stdout: "",
				stderr: `search: --path must be a folder under ${currentWorkspacePath} or ${mountHint}: ${parsed._yay.pathShell}\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// `search --path` is an exact folder scope, not a prefix scan.
		if (parsed._yay.pathShell != null && scope.dbFilesPath != null && scope.dbFilesPath !== "/") {
			const scopedFolder = (await ctx.runQuery(internal.files_nodes.get_by_path, {
				organizationId: scope.ctxData.organizationId,
				workspaceId: scope.ctxData.workspaceId,
				path: scope.dbFilesPath,
			})) as files_nodes_get_by_path_Result;
			const scopedShellPath = scope.renderShellPath(scope.dbFilesPath);
			if (!scopedFolder) {
				return {
					stdout: "",
					stderr: `search: --path folder does not exist: ${scopedShellPath}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			if (scopedFolder.kind !== "folder") {
				return {
					stdout: "",
					stderr: `search: --path must be a folder: ${scopedShellPath}\n`,
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}

		// Scope the chunk scan to the classified folder; the workspace/mount root maps to the whole tree.
		const path = scope.dbFilesPath != null && scope.dbFilesPath !== "/" ? scope.dbFilesPath : undefined;
		// The `/.plugins` and `/.mounts` root scopes print and continue as `--path <root>` even
		// though the fan-out has no single stored tree path.
		const scopePath = scope.kind === "plugins_root" || scope.kind === "external_mounts_root" ? "/" : path;

		let res: files_nodes_text_search_files_Result;
		if (scope.kind === "external_mounts_root") {
			// One text search per synced mount, each scoped to its commit-keyed tree.
			const fanOut = await bash_external_mounts_fan_out_paginate({
				command: "search",
				externalMounts: dbFilesRoots.externalMounts,
				cursor,
				limit: bash_clamp_listing_page_limit(parsed._yay.limit),
				runPage: async (pageArgs) => {
					const pageResult = (await ctx.runQuery(internal.files_nodes.text_search_files, {
						organizationId: pageArgs.mount.fs.ctxData.organizationId,
						workspaceId: pageArgs.mount.fs.ctxData.workspaceId,
						userId: pageArgs.mount.fs.ctxData.userId,
						query: parsed._yay.query,
						numItems: pageArgs.numItems,
						cursor: pageArgs.innerCursor,
						pathPrefix: `/${pageArgs.mount.name}/${pageArgs.mount.commitSha}`,
					})) as files_nodes_text_search_files_Result;
					return {
						items: pageResult.items.map((item) => ({
							...item,
							path: bash_external_mounts_fan_out_db_files_path(pageArgs.mount, item.path),
						})),
						continueCursor: pageResult.continueCursor,
						isDone: pageResult.isDone,
					};
				},
			});
			if (fanOut._nay) {
				return {
					stdout: "",
					stderr: `${fanOut._nay.message}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			res = {
				items: fanOut._yay.items,
				continueCursor: fanOut._yay.continueCursor ?? "",
				isDone: fanOut._yay.isDone,
			};
		} else if (scope.kind === "plugins_root") {
			// One text search per installed plugin, each scoped to its version-keyed tree.
			const fanOut = await bash_plugins_fan_out_paginate({
				command: "search",
				plugins: dbFilesRoots.plugins,
				cursor,
				limit: bash_clamp_listing_page_limit(parsed._yay.limit),
				runPage: async (pageArgs) => {
					const pageResult = (await ctx.runQuery(internal.files_nodes.text_search_files, {
						organizationId: pageArgs.mount.fs.ctxData.organizationId,
						workspaceId: pageArgs.mount.fs.ctxData.workspaceId,
						userId: pageArgs.mount.fs.ctxData.userId,
						query: parsed._yay.query,
						numItems: pageArgs.numItems,
						cursor: pageArgs.innerCursor,
						pathPrefix: `/${pageArgs.mount.pluginVersionId}`,
					})) as files_nodes_text_search_files_Result;
					return {
						items: pageResult.items.map((item) => ({
							...item,
							path: bash_plugins_fan_out_db_files_path(pageArgs.mount, item.path),
						})),
						continueCursor: pageResult.continueCursor,
						isDone: pageResult.isDone,
					};
				},
			});
			if (fanOut._nay) {
				return {
					stdout: "",
					stderr: `${fanOut._nay.message}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			res = {
				items: fanOut._yay.items,
				continueCursor: fanOut._yay.continueCursor ?? "",
				isDone: fanOut._yay.isDone,
			};
		} else {
			res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
				organizationId: scope.ctxData.organizationId,
				workspaceId: scope.ctxData.workspaceId,
				userId: scope.ctxData.userId,
				query: parsed._yay.query,
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				pathPrefix: path,
			})) as files_nodes_text_search_files_Result;
		}

		const exactQueryFilter = bash_search_command_exact_query_filter(parsed._yay.query);
		const searchResult = {
			items: res.items.map((item) => ({
				...item,
				path: scope.renderShellPath(item.path),
			})),
		};

		const scopeNote = scopePath != null ? ` under ${scope.renderShellPath(scopePath)}` : "";

		// The miss text is actionable because full-text search accepts plain
		// content terms, not path/name/glob syntax.
		let output =
			`No content matches found${scopeNote}. ` +
			`search expects words from the file content, not a shell pattern: ` +
			`pass one distinctive word or a few plain terms that should appear in the document body. ` +
			`The text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term. ` +
			`It is implemented with db full-text search, but it is not path/name/glob/regex search; ` +
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
						currentWorkspacePath: scope.basePath,
						path: scopePath,
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
