import { defineCommand, type CommandContext } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_list_subtree_Result,
	files_nodes_search_paths_Result,
} from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	bash_APP_MOUNT_PATH,
	bash_clamp_listing_page_limit,
	bash_command_build_builtin_delegation_args,
	bash_create_glob_syntax_unsupported_message,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_delegate_builtin_command,
	bash_GLOB_METACHARACTER_REGEX,
	bash_HOME,
	bash_is_path_under_current_workspace_path,
	bash_is_path_under_read_only_mounts,
	bash_LISTING_DEFAULT_LIMIT,
	bash_LISTING_MAX_LIMIT,
	bash_normalize_path,
	bash_parse_limit,
	bash_parse_simple_extension_glob,
	bash_plugins_fan_out_db_files_path,
	bash_plugins_fan_out_paginate,
	bash_read_option_value,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_resolve_db_files_shell_path,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_NON_NEGATIVE_INTEGER_REGEX,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const EXTENSION_TOKEN_REGEX = /^[a-z0-9][a-z0-9_-]*$/iu;
const SIMPLE_PATH_WORD_GLOB_REGEX = /^\*+([a-z0-9][a-z0-9_-]*)\*+$/iu;
const SIMPLE_PATH_WORD_PREFIX_EXTENSION_GLOB_REGEX = /^([a-z0-9][a-z0-9_-]*)\*\.[a-z0-9][a-z0-9_-]*$/iu;
const SIMPLE_PATH_WORD_REGEX_GLOB_REGEX = /^\.\*([a-z0-9][a-z0-9_-]*)\.\*$/iu;
const BUILTIN_OPTIONS_WITH_VALUES = new Set([
	"-iname",
	"-ipath",
	"-iregex",
	"-maxdepth",
	"-mindepth",
	"-mtime",
	"-name",
	"-newer",
	"-path",
	"-perm",
	"-printf",
	"-regex",
	"-regextype",
	"-size",
	"-type",
]);

/**
 * Clean the extension value used by `find --extension`.
 *
 * `md` and `.md` both become `md`.
 *
 * Bad input returns a `_nay` with the text to print.
 */
function normalize_extension_value(extension: string) {
	const trimmed = extension.trim();

	// Let callers pass `md` or `.md`.
	const extensionWithoutDot = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
	if (extensionWithoutDot === "") {
		return Result({ _nay: { message: "find: --extension requires a file extension" } });
	}

	// Keep this to one simple extension token, not a path or glob.
	if (!EXTENSION_TOKEN_REGEX.test(extensionWithoutDot)) {
		return Result({ _nay: { message: "find: --extension supports a simple extension token such as md, ts, or pdf" } });
	}

	// Match extensions without caring about letter case.
	return Result({ _yay: { extension: extensionWithoutDot.toLowerCase() } });
}

/**
 * Read simple "contains this word" glob or regex-shaped mistakes.
 *
 * Accepts forms like `*readme*`, `readme*.md`, and `.*readme.*`.
 *
 * Returns `null` for real globs or regexes.
 */
function parse_simple_path_word_glob(pattern: string) {
	const trimmed = pattern.trim();

	// Treat `*readme*` as the plain path word `readme`.
	const globMatch = trimmed.match(SIMPLE_PATH_WORD_GLOB_REGEX);
	if (globMatch) {
		return globMatch[1].toLowerCase();
	}

	// Treat `readme*.md` as the plain path word `readme`. The command still
	// rejects the glob; this only lets the stderr print the indexed retry.
	const prefixExtensionGlobMatch = trimmed.match(SIMPLE_PATH_WORD_PREFIX_EXTENSION_GLOB_REGEX);
	if (prefixExtensionGlobMatch) {
		return prefixExtensionGlobMatch[1].toLowerCase();
	}

	// Treat `.*readme.*` the same way, without accepting full regex syntax.
	const regexMatch = trimmed.match(SIMPLE_PATH_WORD_REGEX_GLOB_REGEX);
	return regexMatch?.[1]?.toLowerCase() ?? null;
}

/**
 * App-file `-name`/`-iname` are indexed app-file path word searches, not exact glob
 * filters. Strip a simple literal extension so `README.md` searches for the
 * filename word instead of mostly matching every Markdown file by `md`.
 */
function normalize_name_path_query(value: string | undefined) {
	if (value == null) {
		return undefined;
	}
	const trimmed = value.trim();
	const lastSlashIndex = trimmed.lastIndexOf("/");
	const lastDotIndex = trimmed.lastIndexOf(".");
	return !bash_GLOB_METACHARACTER_REGEX.test(trimmed) && lastDotIndex > Math.max(lastSlashIndex, 0)
		? trimmed.slice(0, lastDotIndex).toLowerCase()
		: trimmed.toLowerCase();
}

/**
 * Build the agent-facing `Try:` line for path word search recovery.
 *
 * This points the model at the indexed `find --path-query` form when it used a
 * glob or regex-shaped path query that the app shell cannot run directly.
 */
function build_path_query_retry_hint(
	absoluteShellPath: string,
	args: { query: string; type?: string; maxDepth?: number; limit: number },
) {
	const parts = ["Try:", "find", bash_shell_arg_quote(absoluteShellPath)];
	if (args.maxDepth != null) {
		parts.push("-maxdepth", String(args.maxDepth));
	}
	if (args.type != null) {
		parts.push("-type", args.type);
	}
	parts.push("--path-query", bash_shell_arg_quote(args.query), "--limit", String(args.limit));
	return parts.join(" ");
}

function parse_args(args: string[]) {
	let path: string | undefined;
	let prefix: string | undefined;
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let unsupportedDbFilesPredicate: string | null = null;
	let unsupportedRegexPathQuery: string | undefined;
	let maxDepthValue: string | undefined;
	let minDepthValue: string | undefined;
	let type: string | undefined;
	let name: string | undefined;
	let iname: string | undefined;
	let pathQuery: string | undefined;
	let extension: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (arg === "--limit") {
			const value = bash_read_option_value("find", args, index, "--limit");
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
			const value = bash_read_option_value("find", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (arg === "--prefix") {
			const value = bash_read_option_value("find", args, index, "--prefix");
			if (value._nay) return value;
			prefix = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--prefix=")) {
			prefix = arg.slice("--prefix=".length);
			continue;
		}
		if (arg === "-maxdepth" || arg === "--maxdepth") {
			const value = bash_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			maxDepthValue = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-mindepth" || arg === "--mindepth") {
			const value = bash_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			minDepthValue = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-print") {
			// Printing is already the default action; accept it as a no-op for compatibility.
			continue;
		}
		if (arg === "-type" || arg === "--type") {
			const value = bash_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			type = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-name" || arg === "--name") {
			const value = bash_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			name = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-iname" || arg === "--iname") {
			const value = bash_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			iname = value._yay.value;
			index++;
			continue;
		}
		if (arg === "--path-query") {
			const value = bash_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			pathQuery = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--path-query=")) {
			pathQuery = arg.slice("--path-query=".length);
			continue;
		}
		if (arg === "--extension") {
			const value = bash_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			extension = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--extension=")) {
			extension = arg.slice("--extension=".length);
			continue;
		}
		if (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")") {
			unsupportedDbFilesPredicate ??= arg;

			if (arg === "-regex" || arg === "-iregex") {
				const simpleRegexPathQuery = args[index + 1] == null ? null : parse_simple_path_word_glob(args[index + 1]);
				if (simpleRegexPathQuery != null) {
					unsupportedRegexPathQuery ??= simpleRegexPathQuery;
				}
			}

			if (BUILTIN_OPTIONS_WITH_VALUES.has(arg)) {
				index++;
			} else if (arg === "-exec" || arg === "-ok") {
				while (index + 1 < args.length && args[index + 1] !== ";" && args[index + 1] !== "+") {
					index++;
				}
				if (index + 1 < args.length) {
					index++;
				}
			}
			continue;
		}
		const simpleExtensionGlob = bash_parse_simple_extension_glob(arg);
		if (simpleExtensionGlob) {
			if (path != null) {
				return Result({ _nay: { message: "find: app file find supports one path only" } });
			}
			if (extension != null) {
				const normalizedExtension = normalize_extension_value(extension);
				if (normalizedExtension._nay) return normalizedExtension;
				if (normalizedExtension._yay.extension !== simpleExtensionGlob.extension) {
					return Result({ _nay: { message: "find: simple extension glob conflicts with --extension" } });
				}
			}
			path = simpleExtensionGlob.path;
			extension = simpleExtensionGlob.extension;
			continue;
		}
		if (path != null) {
			return Result({ _nay: { message: "find: app file find supports one path only" } });
		}
		path = arg;
	}

	if (prefix != null && path != null) {
		return Result({ _nay: { message: "find: --prefix cannot be combined with PATH" } });
	}

	const limit = bash_parse_limit("find", limitValue, bash_LISTING_DEFAULT_LIMIT, bash_LISTING_MAX_LIMIT);
	if (limit._nay) {
		return limit;
	}

	let maxDepth: number | null = null;
	if (maxDepthValue != null) {
		if (!bash_NON_NEGATIVE_INTEGER_REGEX.test(maxDepthValue.trim())) {
			return Result({ _nay: { message: "find: -maxdepth must be a non-negative integer" } });
		}
		maxDepth = Number(maxDepthValue);
	}

	let minDepth: number | null = null;
	if (minDepthValue != null) {
		if (!bash_NON_NEGATIVE_INTEGER_REGEX.test(minDepthValue.trim())) {
			return Result({ _nay: { message: "find: -mindepth must be a non-negative integer" } });
		}
		minDepth = Number(minDepthValue);
	}

	if (prefix != null && (maxDepth != null || minDepth != null)) {
		// --prefix uses direct indexed path-boundary scans and does not compute a
		// base node depth. Reject rather than silently mis-filter.
		return Result({
			_nay: {
				message:
					"find: --prefix cannot be combined with -maxdepth/-mindepth because prefix scans do not resolve a starting folder depth.\n" +
					"Depth filters require an existing folder PATH. Retry without --prefix after replacing the prefix with that folder path.",
			},
		});
	}

	if (type != null && type !== "f" && type !== "d") {
		return Result({ _nay: { message: "find: -type supports only f or d for app files" } });
	}

	let normalizedExtension: string | undefined;
	if (extension != null) {
		const normalized = normalize_extension_value(extension);
		if (normalized._nay) return normalized;
		normalizedExtension = normalized._yay.extension;
	}

	// Simple `*.ext` name globs become indexed extension searches.
	const nameGlob = name ?? iname;
	const simpleNameExtension = nameGlob != null ? bash_parse_simple_extension_glob(nameGlob.trim()) : null;
	if (simpleNameExtension) {
		if (simpleNameExtension.path != null) {
			return Result({ _nay: { message: "find: -name/-iname simple extension globs must not include a path" } });
		}
		if (normalizedExtension != null && normalizedExtension !== simpleNameExtension.extension) {
			return Result({ _nay: { message: "find: -name/-iname simple extension glob conflicts with --extension" } });
		}
		normalizedExtension = simpleNameExtension.extension;
		name = undefined;
		iname = undefined;
	}

	// In app-file find, -name, -iname, and --path-query use the same case-insensitive db word search.
	const normalizedNamePathQuery = normalize_name_path_query(name);
	const normalizedInamePathQuery = normalize_name_path_query(iname);
	const pathQueries = [normalizedNamePathQuery, normalizedInamePathQuery, pathQuery].filter(
		(value): value is string => value != null,
	);
	if (pathQueries.length > 1) {
		return Result({ _nay: { message: "find: use only one of -name, -iname, or --path-query" } });
	}

	// Empty search text cannot produce meaningful db word-search results.
	const normalizedPathQuery = pathQueries.at(0)?.trim();
	if (normalizedPathQuery === "") {
		return Result({ _nay: { message: "find: path search requires a non-empty query" } });
	}

	// For app files, -name/-iname are word search aliases, not shell glob filters.
	if (
		(name != null || iname != null) &&
		normalizedPathQuery != null &&
		bash_GLOB_METACHARACTER_REGEX.test(normalizedPathQuery)
	) {
		const simplePathWordGlob = parse_simple_path_word_glob(normalizedPathQuery);
		return Result({
			_nay: {
				message:
					"find: -name/-iname use indexed app-file path word search for app files, not glob patterns. Try `find <dir> -type f --extension md --limit 20` for simple extension searches, or use words like `readme`.",
				...(simplePathWordGlob == null
					? {}
					: {
							data: {
								tryPathQuery: {
									query: simplePathWordGlob,
									...(type == null ? {} : { type }),
									...(path == null ? {} : { path }),
									limit: limit._yay,
								},
							},
						}),
			},
		});
	}

	// --path-query also accepts plain word-search text only.
	if (pathQuery != null && normalizedPathQuery != null && bash_GLOB_METACHARACTER_REGEX.test(normalizedPathQuery)) {
		const simplePathWordGlob = parse_simple_path_word_glob(normalizedPathQuery);
		return Result({
			_nay: {
				message:
					"find: --path-query uses indexed app-file path word search, not regex/glob patterns. Use plain tokens like `readme`.",
				...(simplePathWordGlob == null
					? {}
					: {
							data: {
								tryPathQuery: {
									query: simplePathWordGlob,
									...(type == null ? {} : { type }),
									...(path == null ? {} : { path }),
									limit: limit._yay,
								},
							},
						}),
			},
		});
	}

	return Result({
		_yay: {
			path,
			prefix,
			limit: limit._yay,
			cursor,
			unsupportedDbFilesPredicate,
			unsupportedRegexPathQuery,
			maxDepth,
			minDepth,
			type,
			name: normalizedNamePathQuery == null ? undefined : normalizedPathQuery,
			iname: normalizedInamePathQuery == null ? undefined : normalizedPathQuery,
			pathQuery: pathQuery == null ? undefined : normalizedPathQuery,
			extension: normalizedExtension,
		} as const,
	});
}

/**
 * Resolve a shell prefix to the absolute shell path the subtree scan starts from.
 *
 * Prefix scans do not require an existing files_nodes doc. The caller classifies the
 * returned shell path to pick the right scope and convert it into a trailing-slash
 * `treePath` prefix via `list_subtree`.
 */
function prefix_to_shell_path(commandCtx: CommandContext, currentWorkspacePath: string, prefix: string) {
	if (bash_GLOB_METACHARACTER_REGEX.test(prefix)) {
		return Result({ _nay: { message: bash_create_glob_syntax_unsupported_message("find", prefix) } });
	}
	if (prefix === "/" || prefix.startsWith("/") || prefix.startsWith("~/")) {
		const shellPath = prefix.startsWith("~/")
			? bash_normalize_path(`${bash_HOME}/${prefix.slice(2)}`)
			: bash_normalize_path(prefix);
		return Result({ _yay: { shellPath } });
	}

	const cwd = bash_normalize_path(commandCtx.cwd);
	if (bash_is_path_under_current_workspace_path(currentWorkspacePath, cwd) || bash_is_path_under_read_only_mounts(cwd)) {
		return Result({ _yay: { shellPath: bash_resolve_path(commandCtx.cwd, prefix) } });
	}
	return Result({ _yay: { shellPath: bash_normalize_path(prefix) } });
}

function build_continuation(args: {
	parsed: NonNullable<ReturnType<typeof parse_args>["_yay"]>;
	target: string | null;
	prefix: string | null;
	cursor: string;
}) {
	const continuationParts = ["Next page:", "find"];
	if (args.prefix != null) {
		continuationParts.push("--prefix", bash_shell_arg_quote(args.prefix));
	} else if (args.target != null) {
		continuationParts.push(bash_shell_arg_quote(args.target));
	}
	// Depth flags are invalid with --prefix (rejected at parse time); never emit them there.
	if (args.prefix == null && args.parsed.maxDepth != null) {
		continuationParts.push("-maxdepth", String(args.parsed.maxDepth));
	}
	if (args.prefix == null && args.parsed.minDepth != null) {
		continuationParts.push("-mindepth", String(args.parsed.minDepth));
	}
	if (args.parsed.type != null) {
		continuationParts.push("-type", args.parsed.type);
	}
	if (args.parsed.name != null) {
		continuationParts.push("-name", bash_shell_arg_quote(args.parsed.name));
	}
	if (args.parsed.iname != null) {
		continuationParts.push("-iname", bash_shell_arg_quote(args.parsed.iname));
	}
	if (args.parsed.pathQuery != null) {
		continuationParts.push("--path-query", bash_shell_arg_quote(args.parsed.pathQuery));
	}
	if (args.parsed.extension != null) {
		continuationParts.push("--extension", bash_shell_arg_quote(args.parsed.extension));
	}
	continuationParts.push("--limit", String(args.parsed.limit), "--cursor", bash_shell_arg_quote(args.cursor));
	return continuationParts.join(" ");
}

export function bash_find_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand("find", async (args, commandCtx) => {
		const parsed = parse_args(args);
		// Parse failures return usage text before any app-file or built-in command routing.
		if (parsed._nay) {
			const errorData = parsed._nay.data as
				| { tryPathQuery?: { path?: string; query: string; type?: string; limit: number } }
				| undefined;
			const tryPathQuery = errorData?.tryPathQuery ?? null;
			const tryLine =
				tryPathQuery == null
					? ""
					: `${build_path_query_retry_hint(
							tryPathQuery.path == null ? currentWorkspacePath : bash_resolve_path(commandCtx.cwd, tryPathQuery.path),
							tryPathQuery,
						)}\n`;
			return {
				stdout: "",
				stderr:
					`${parsed._nay.message}\n` +
					tryLine +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}
		// AI agents commonly hallucinate `--next-page`; reject it after parse
		// validation so malformed real options still report their normal errors.
		if (args.includes("--next-page")) {
			return {
				stdout: "",
				stderr:
					"find: --next-page is not supported\n" +
					"Copy the exact `Next page: find ... --limit N --cursor ...` command from the previous find output.\n" +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}
		const pathQuery = parsed._yay.name ?? parsed._yay.iname ?? parsed._yay.pathQuery;

		let cursor: string | null = null;
		const absoluteShellPath = bash_resolve_path(commandCtx.cwd, parsed._yay.path ?? commandCtx.cwd);
		// Classify the search root: workspace / mount db-files path, the synthetic `/.mounts` root,
		// or an external (non-app) path. The reserved `/.mounts` root is listed from reserved-root `"/"`.
		const pathResolution = bash_resolve_db_files_shell_path(absoluteShellPath, dbFilesRoots);
		const target = {
			inputPath: parsed._yay.path,
			absoluteShellPath,
			pathResolution,
			dbFilesPath: pathResolution.dbFilesPath,
			builtinOperand: parsed._yay.path ?? ".",
		};
		// The `/.plugins` root spans one indexed tree per installed plugin. Fan out one
		// indexed query per plugin, in name order, under a composite cursor.
		if (parsed._yay.prefix == null && pathResolution.kind === "plugins_root") {
			if (dbFilesRoots.plugins.mounts.size === 0) {
				return {
					stdout: "",
					stderr: `find: ${target.absoluteShellPath}: No such file or directory\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			if (parsed._yay.unsupportedDbFilesPredicate != null) {
				return {
					stdout: "",
					stderr:
						`find: unsupported predicate ${parsed._yay.unsupportedDbFilesPredicate} for db-files paths under ${bash_APP_MOUNT_PATH} or /.mounts\n` +
						"GNU find extensions like -printf, -mtime, -newer, -exec, -ok, and -delete are not available there; omit them and use -name QUERY, --path-query QUERY, -type f|d, -maxdepth N, or -mindepth N instead.\n" +
						"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
			// Path word search at the root supports the full fan-out subtree only; depth
			// filters need a single plugin's folder anchor.
			if (pathQuery != null && (parsed._yay.maxDepth != null || parsed._yay.minDepth != null)) {
				return {
					stdout: "",
					stderr:
						"find: path word search at /.plugins does not support -maxdepth/-mindepth; scope to one plugin: find /.plugins/<pluginName> --path-query QUERY\n" +
						"Run 'ls /.plugins' to list the installed plugins.\n",
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
			if (pathQuery != null && parsed._yay.extension != null) {
				return {
					stdout: "",
					stderr: "find: path word search cannot be combined with --extension for app files.\n",
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
			// --extension only matches files; -maxdepth 0 keeps only the synthetic root itself.
			if ((parsed._yay.extension != null && parsed._yay.type === "d") || parsed._yay.maxDepth === 0) {
				return {
					stdout: "0 matches.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			let pluginsCursor: string | null = null;
			if (parsed._yay.cursor != null) {
				const resolvedCursor = await bash_cursor_id_resolve(ctx, parsed._yay.cursor);
				if (resolvedCursor._nay) {
					return {
						stdout: "",
						stderr: `${resolvedCursor._nay.message}\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				pluginsCursor = resolvedCursor._yay;
			}

			// Depth predicates are relative to `/.plugins`; each plugin's version root renders
			// as the depth-1 entry `/.plugins/<pluginName>/`, so per-plugin depths shift by 1.
			const perPluginMinDepth = parsed._yay.minDepth == null || parsed._yay.minDepth <= 1 ? null : parsed._yay.minDepth - 1;
			const perPluginMaxDepth = parsed._yay.maxDepth == null ? null : parsed._yay.maxDepth - 1;

			const fanOut = await bash_plugins_fan_out_paginate({
				command: "find",
				plugins: dbFilesRoots.plugins,
				cursor: pluginsCursor,
				limit: bash_clamp_listing_page_limit(parsed._yay.limit),
				runPage: async (pageArgs) => {
					if (pathQuery != null) {
						const pageResult = (await ctx.runQuery(internal.files_nodes.search_paths, {
							organizationId: pageArgs.mount.fs.ctxData.organizationId,
							workspaceId: pageArgs.mount.fs.ctxData.workspaceId,
							pathQuery,
							numItems: pageArgs.numItems,
							cursor: pageArgs.innerCursor,
							...(parsed._yay.type === "f"
								? { kind: "file" as const }
								: parsed._yay.type === "d"
									? { kind: "folder" as const }
									: {}),
							pathPrefix: `/${pageArgs.mount.pluginVersionId}`,
						})) as files_nodes_search_paths_Result;
						return {
							items: pageResult.items.map((item) => ({
								path: bash_plugins_fan_out_db_files_path(pageArgs.mount, item.path),
								kind: item.kind,
							})),
							continueCursor: pageResult.continueCursor,
							isDone: pageResult.isDone,
						};
					}
					const pageResult = (await ctx.runQuery(internal.files_nodes.list_subtree, {
						organizationId: pageArgs.mount.fs.ctxData.organizationId,
						workspaceId: pageArgs.mount.fs.ctxData.workspaceId,
						folderPath: `/${pageArgs.mount.pluginVersionId}`,
						numItems: pageArgs.numItems,
						cursor: pageArgs.innerCursor,
						...(parsed._yay.extension != null
							? { kind: "file" as const, lowercaseExtension: parsed._yay.extension }
							: parsed._yay.type === "f"
								? { kind: "file" as const }
								: parsed._yay.type === "d"
									? { kind: "folder" as const }
									: {}),
						...(perPluginMinDepth == null ? {} : { minDepth: perPluginMinDepth }),
						...(perPluginMaxDepth == null ? {} : { maxDepth: perPluginMaxDepth }),
					})) as files_nodes_list_subtree_Result;
					return {
						items: pageResult.page.map((item) => ({
							path: bash_plugins_fan_out_db_files_path(pageArgs.mount, item.path),
							kind: item.kind,
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

			const lines = fanOut._yay.items.map(
				(item) => `${pathResolution.renderShellPath(item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!fanOut._yay.isDone && fanOut._yay.continueCursor != null) {
				lines.push(
					"",
					build_continuation({
						parsed: parsed._yay,
						target: target.absoluteShellPath,
						prefix: null,
						cursor: await bash_cursor_id_create(ctx, fanOut._yay.continueCursor),
					}),
				);
			} else if (lines.length === 0) {
				lines.push("0 matches.");
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		// Non-app targets belong to Just Bash's built-in find unless the caller requested app-file prefix search.
		if (parsed._yay.prefix == null && pathResolution.kind === "outside_db_files") {
			return await bash_delegate_builtin_command({
				command: "find",
				args: bash_command_build_builtin_delegation_args(args, [target.builtinOperand], {
					optionsWithValues: BUILTIN_OPTIONS_WITH_VALUES,
					pathsPosition: "beforeOptions",
				}),
				commandCtx,
			});
		}
		// App files only support predicates that can be implemented with indexed db queries.
		if (parsed._yay.unsupportedDbFilesPredicate != null) {
			const regexPredicateHint =
				parsed._yay.unsupportedDbFilesPredicate === "-regex" ||
				parsed._yay.unsupportedDbFilesPredicate === "-iregex" ||
				parsed._yay.unsupportedDbFilesPredicate === "-regextype"
					? "Regex path predicates are not available for app files; use --path-query with plain path words such as `readme`.\n"
					: "";

			const regexPathQueryRetry =
				parsed._yay.unsupportedRegexPathQuery == null || parsed._yay.prefix != null
					? ""
					: `${build_path_query_retry_hint(target.absoluteShellPath, {
							query: parsed._yay.unsupportedRegexPathQuery,
							...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
							limit: parsed._yay.limit,
						})}\n`;

			return {
				stdout: "",
				stderr:
					`find: unsupported predicate ${parsed._yay.unsupportedDbFilesPredicate} for db-files paths under ${bash_APP_MOUNT_PATH} or /.mounts\n` +
					regexPredicateHint +
					regexPathQueryRetry +
					"GNU find extensions like -printf, -mtime, -newer, -exec, -ok, and -delete are not available there; omit them and use -name QUERY, --path-query QUERY, -type f|d, -maxdepth N, or -mindepth N instead.\n" +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}
		// Cursor ids are opaque handles stored outside the command output; resolve them before querying.
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

		// Prefix search scans treePath descendants and does not require an existing folder.
		if (parsed._yay.prefix != null) {
			// Prefix mode is only for broad path-boundary scans.
			if (parsed._yay.extension != null) {
				return {
					stdout: "",
					stderr:
						"find: --prefix cannot be combined with --extension for app files.\n" +
						"Try: find <folder> -type f --extension " +
						bash_shell_arg_quote(parsed._yay.extension) +
						" --limit " +
						String(parsed._yay.limit) +
						"\n",
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}

			// Prefix scans and path word search use different query shapes.
			if (pathQuery != null) {
				return {
					stdout: "",
					stderr:
						"find: --prefix cannot be combined with path word search for app files.\n" +
						"Use `find --prefix PREFIX` for indexed descendant path discovery, or `find -name QUERY` for indexed app-file path word search.\n",
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}

			// Resolve the prefix to a shell path, then classify it to pick the right scope and renderer.
			const prefixResult = prefix_to_shell_path(commandCtx, currentWorkspacePath, parsed._yay.prefix);
			if (prefixResult._nay) {
				return {
					stdout: "",
					stderr: prefixResult._nay.message,
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}

			// The reserved `/.mounts` root scans from reserved-root `"/"`; other targets scan from their
			// db-files path. External prefixes keep the prior raw-path behavior on the workspace FS.
			const prefixResolution = bash_resolve_db_files_shell_path(prefixResult._yay.shellPath, dbFilesRoots);
			// The `/.plugins` root has no single stored tree to prefix-scan; scope to one plugin.
			if (prefixResolution.kind === "plugins_root") {
				return {
					stdout: "",
					stderr:
						"find: --prefix cannot scan the /.plugins root; scope to one plugin: find --prefix /.plugins/<pluginName>/<path>\n" +
						"Run 'ls /.plugins' to list the installed plugins.\n",
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
			const prefixFolderPath = prefixResolution.dbFilesPath ?? prefixResult._yay.shellPath;

			const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
				organizationId: prefixResolution.ctxData.organizationId,
				workspaceId: prefixResolution.ctxData.workspaceId,
				folderPath: prefixFolderPath,
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.type === "f"
					? { kind: "file" as const }
					: parsed._yay.type === "d"
						? { kind: "folder" as const }
						: {}),
			})) as files_nodes_list_subtree_Result;

			const lines = result.page.map(
				(item) => `${prefixResolution.renderShellPath(item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				lines.push(
					"",
					build_continuation({
						parsed: parsed._yay,
						target: null,
						prefix: prefixResolution.renderShellPath(prefixFolderPath),
						cursor: await bash_cursor_id_create(ctx, result.continueCursor),
					}),
				);
			} else if (lines.length === 0) {
				lines.push("0 matches.");
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		// App-file find does not expand shell globs; indexed path search flags handle search.
		if (target.inputPath != null && bash_GLOB_METACHARACTER_REGEX.test(target.inputPath)) {
			return {
				stdout: "",
				stderr: bash_create_glob_syntax_unsupported_message("find", target.inputPath),
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// Non-prefix app-file execution should only reach this point after target path resolution succeeded.
		if (target.dbFilesPath == null) {
			throw should_never_happen("find: app file path missing after built-in and prefix branches", {
				absoluteShellPath: target.absoluteShellPath,
				prefix: parsed._yay.prefix,
			});
		}

		const dbFilesDoc: files_nodes_get_by_path_Result =
			target.dbFilesPath === "/"
				? null
				: await ctx.runQuery(internal.files_nodes.get_by_path, {
						organizationId: pathResolution.ctxData.organizationId,
						workspaceId: pathResolution.ctxData.workspaceId,
						path: target.dbFilesPath,
					});
		// Missing concrete app paths fail normally, with a hint for prefix-style discovery.
		if (target.dbFilesPath !== "/" && !dbFilesDoc) {
			return {
				stdout: "",
				stderr:
					`find: ${target.absoluteShellPath}: No such file or directory\n` +
					`If you intended a path-prefix subtree search, run:\n` +
					`  find --prefix ${bash_shell_arg_quote(target.absoluteShellPath)} --limit ${parsed._yay.limit}\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		// Path word search is full-text search, not glob matching.
		if (pathQuery != null) {
			// Word search and extension search are separate modes.
			if (parsed._yay.extension != null) {
				return {
					stdout: "",
					stderr:
						"find: path word search cannot be combined with --extension for app files.\n" +
						`${build_path_query_retry_hint(target.absoluteShellPath, {
							query: pathQuery,
							...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
							limit: parsed._yay.limit,
						})}\n` +
						`For extension-only search, use: find ${bash_shell_arg_quote(target.absoluteShellPath)} -type f --extension ${bash_shell_arg_quote(parsed._yay.extension)} --limit ${parsed._yay.limit}\n`,
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}

			// Path word search can only express workspace-wide, direct-child, or subtree scopes.
			let parentId: Id<"files_nodes"> | typeof files_ROOT_ID | undefined = undefined;
			let pathPrefix: string | undefined = undefined;
			let minPathDepth: number | undefined = undefined;
			if (target.dbFilesPath === "/") {
				// At root, -maxdepth 1 is the direct children query.
				if (parsed._yay.maxDepth != null && parsed._yay.maxDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: path word search supports workspace-wide results or immediate children with -maxdepth 1.\n" +
							`${build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n`,
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				// Root has no files_nodes doc, so only the natural child floor is supported.
				if (parsed._yay.minDepth != null && parsed._yay.minDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: path word search supports -mindepth 1 only; deeper mindepth values are not supported.\n" +
							`${build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n` +
							"Filter deeper paths from those results if needed.\n",
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				if (parsed._yay.maxDepth === 1) {
					parentId = files_ROOT_ID;
				}
			} else {
				// A scoped path-word search starts from an exact folder.
				if (!dbFilesDoc || dbFilesDoc.kind !== "folder") {
					return {
						stdout: "",
						stderr: "find: path word search can target the workspace root or an immediate folder.\n",
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				// Non-root scoped search supports the full subtree or direct children.
				if (parsed._yay.maxDepth != null && parsed._yay.maxDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: scoped path word search supports the full subtree (omit -maxdepth) or immediate children with -maxdepth 1.\n" +
							`${build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n`,
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				// The only supported mindepth filter excludes the starting folder itself.
				if (parsed._yay.minDepth != null && parsed._yay.minDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: scoped path word search supports -mindepth 1 only; deeper mindepth values are not supported.\n" +
							`${build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n` +
							"Filter deeper paths from those results if needed.\n",
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}

				if (parsed._yay.maxDepth === 1) {
					parentId = dbFilesDoc._id;
				} else {
					pathPrefix = target.dbFilesPath;
					if (parsed._yay.minDepth === 1) {
						minPathDepth = dbFilesDoc.pathDepth + 1;
					}
				}
			}

			const result = (await ctx.runQuery(internal.files_nodes.search_paths, {
				organizationId: pathResolution.ctxData.organizationId,
				workspaceId: pathResolution.ctxData.workspaceId,
				pathQuery,
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.type === "f"
					? { kind: "file" as const }
					: parsed._yay.type === "d"
						? { kind: "folder" as const }
						: {}),
				...(parentId == null ? {} : { parentId }),
				...(pathPrefix == null ? {} : { pathPrefix }),
				...(minPathDepth == null ? {} : { minPathDepth }),
			})) as files_nodes_search_paths_Result;

			const lines = result.items.map(
				(item) => `${pathResolution.renderShellPath(item.path)}${item.kind === "folder" ? "/" : ""}`,
			);

			// Path word search emits the next-page command or a zero-match marker after pagination.
			if (!result.isDone) {
				lines.push(
					"",
					build_continuation({
						parsed: parsed._yay,
						target: target.absoluteShellPath,
						prefix: null,
						cursor: await bash_cursor_id_create(ctx, result.continueCursor),
					}),
				);
			} else if (lines.length === 0) {
				lines.push("0 matches.");
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		// Extension searches go through the subtree extension index and only return file paths.
		if (parsed._yay.extension != null) {
			// --extension only matches files.
			if (parsed._yay.type === "d") {
				return {
					stdout: "0 matches.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			// Exact file targets are handled without a subtree query.
			if (dbFilesDoc?.kind === "file") {
				const matchesDepth =
					(parsed._yay.minDepth == null || parsed._yay.minDepth <= 0) &&
					(parsed._yay.maxDepth == null || parsed._yay.maxDepth >= 0);
				const lines: string[] =
					cursor == null && matchesDepth && dbFilesDoc.lowercaseExtension === parsed._yay.extension
						? [pathResolution.renderShellPath(dbFilesDoc.path)]
						: ["0 matches."];
				return {
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
				organizationId: pathResolution.ctxData.organizationId,
				workspaceId: pathResolution.ctxData.workspaceId,
				folderPath: target.dbFilesPath,
				kind: "file" as const,
				lowercaseExtension: parsed._yay.extension,
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.minDepth == null ? {} : { minDepth: parsed._yay.minDepth }),
				...(parsed._yay.maxDepth == null ? {} : { maxDepth: parsed._yay.maxDepth }),
			})) as files_nodes_list_subtree_Result;

			const lines = result.page.map((item) => pathResolution.renderShellPath(item.path));
			if (!result.isDone) {
				lines.push(
					"",
					build_continuation({
						parsed: parsed._yay,
						target: target.absoluteShellPath,
						prefix: null,
						cursor: await bash_cursor_id_create(ctx, result.continueCursor),
					}),
				);
			} else if (lines.length === 0) {
				lines.push("0 matches.");
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		// Plain app-file find lists the subtree through the path index with optional type/depth filters.
		if (dbFilesDoc?.kind === "file") {
			const matchesKind = parsed._yay.type == null || parsed._yay.type === "f";
			const matchesDepth =
				(parsed._yay.minDepth == null || parsed._yay.minDepth <= 0) &&
				(parsed._yay.maxDepth == null || parsed._yay.maxDepth >= 0);
			const lines: string[] =
				cursor == null && matchesKind && matchesDepth
					? [pathResolution.renderShellPath(dbFilesDoc.path)]
					: ["0 matches."];
			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
			organizationId: pathResolution.ctxData.organizationId,
			workspaceId: pathResolution.ctxData.workspaceId,
			folderPath: target.dbFilesPath,
			numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
			cursor,
			...(parsed._yay.type === "f"
				? { kind: "file" as const }
				: parsed._yay.type === "d"
					? { kind: "folder" as const }
					: {}),
			...(parsed._yay.minDepth == null ? {} : { minDepth: parsed._yay.minDepth }),
			...(parsed._yay.maxDepth == null ? {} : { maxDepth: parsed._yay.maxDepth }),
		})) as files_nodes_list_subtree_Result;

		const lines = result.page.map(
			(item) => `${pathResolution.renderShellPath(item.path)}${item.kind === "folder" ? "/" : ""}`,
		);

		// Plain subtree listings emit the next-page command or a zero-match marker after pagination.
		if (!result.isDone) {
			lines.push(
				"",
				build_continuation({
					parsed: parsed._yay,
					target: target.absoluteShellPath,
					prefix: null,
					cursor: await bash_cursor_id_create(ctx, result.continueCursor),
				}),
			);
		} else if (lines.length === 0) {
			lines.push("0 matches.");
		}

		return {
			stdout: `${lines.join("\n")}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}
