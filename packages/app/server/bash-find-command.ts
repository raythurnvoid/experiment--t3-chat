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
	bash_app_file_node_path_to_current_project_path,
	bash_APP_MOUNT_PATH,
	bash_clamp_listing_page_limit,
	bash_command_build_builtin_delegation_args,
	bash_current_project_path_to_app_file_node_path,
	bash_create_glob_syntax_unsupported_message,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_delegate_builtin_command,
	bash_GLOB_METACHARACTER_REGEX,
	bash_HOME,
	bash_is_path_under_current_project_path,
	bash_LISTING_DEFAULT_LIMIT,
	bash_LISTING_MAX_LIMIT,
	bash_normalize_path,
	bash_parse_limit,
	bash_parse_simple_extension_glob,
	bash_read_option_value,
	bash_resolve_path,
	bash_shell_arg_quote,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;
const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/u;
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
 * App-file `-name`/`-iname` are DB-backed path word searches, not exact glob
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
	let unsupportedAppFilePredicate: string | null = null;
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
			unsupportedAppFilePredicate ??= arg;

			if (arg === "-regex" || arg === "-iregex") {
				const simpleRegexPathQuery =
					args[index + 1] == null ? null : parse_simple_path_word_glob(args[index + 1]);
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
		if (!NON_NEGATIVE_INTEGER_REGEX.test(maxDepthValue.trim())) {
			return Result({ _nay: { message: "find: -maxdepth must be a non-negative integer" } });
		}
		maxDepth = Number(maxDepthValue);
	}

	let minDepth: number | null = null;
	if (minDepthValue != null) {
		if (!NON_NEGATIVE_INTEGER_REGEX.test(minDepthValue.trim())) {
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

	// In app-file find, -name, -iname, and --path-query use the same case-insensitive DB word search.
	const normalizedNamePathQuery = normalize_name_path_query(name);
	const normalizedInamePathQuery = normalize_name_path_query(iname);
	const pathQueries = [normalizedNamePathQuery, normalizedInamePathQuery, pathQuery].filter(
		(value): value is string => value != null,
	);
	if (pathQueries.length > 1) {
		return Result({ _nay: { message: "find: use only one of -name, -iname, or --path-query" } });
	}

	// Empty search text cannot produce meaningful DB word-search results.
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
					"find: -name/-iname use DB-backed path word search for app files, not glob patterns. Try `find <dir> -type f --extension md --limit 20` for simple extension searches, or use words like `readme`.",
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
					"find: --path-query uses DB-backed path word search, not regex/glob patterns. Use plain tokens like `readme`.",
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
			unsupportedAppFilePredicate,
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
 * Convert a shell prefix to the app path format used by `treePath`.
 *
 * Prefix scans do not require an existing file-node doc. They only need the normalized
 * app path that `list_subtree` can turn into a trailing-slash
 * `treePath` prefix.
 */
function prefix_to_app_file_node_path(
	commandCtx: CommandContext,
	currentProjectPath: string,
	prefix: string,
) {
	if (bash_GLOB_METACHARACTER_REGEX.test(prefix)) {
		return Result({ _nay: { message: bash_create_glob_syntax_unsupported_message("find", prefix) } });
	}
	if (prefix === "/" || prefix.startsWith("/") || prefix.startsWith("~/")) {
		const shellPath = prefix.startsWith("~/")
			? bash_normalize_path(`${bash_HOME}/${prefix.slice(2)}`)
			: bash_normalize_path(prefix);
		const currentProjectAppFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, shellPath);
		return Result({ _yay: { appFileNodePath: currentProjectAppFileNodePath ?? bash_normalize_path(prefix) } });
	}

	const cwd = bash_normalize_path(commandCtx.cwd);
	if (bash_is_path_under_current_project_path(currentProjectPath, cwd)) {
		return Result({
			_yay: {
				appFileNodePath:
					bash_current_project_path_to_app_file_node_path(currentProjectPath, bash_resolve_path(commandCtx.cwd, prefix)) ??
					bash_normalize_path(prefix),
			},
		});
	}
	return Result({ _yay: { appFileNodePath: bash_normalize_path(prefix) } });
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

export function bash_find_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
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
							tryPathQuery.path == null ? currentProjectPath : bash_resolve_path(commandCtx.cwd, tryPathQuery.path),
							tryPathQuery,
						)}\n`;
			return {
				stdout: "",
				stderr:
					`${parsed._nay.message}\n` +
					tryLine +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: 2,
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
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const pathQuery = parsed._yay.name ?? parsed._yay.iname ?? parsed._yay.pathQuery;

		let cursor: string | null = null;
		const absoluteShellPath = bash_resolve_path(commandCtx.cwd, parsed._yay.path ?? commandCtx.cwd);
		const target = {
			inputPath: parsed._yay.path,
			absoluteShellPath,
			appFileNodePath: bash_current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
			builtinOperand: parsed._yay.path ?? ".",
		};
		// Non-app targets belong to Just Bash's built-in find unless the caller requested app-file prefix search.
		if (parsed._yay.prefix == null && target.appFileNodePath == null) {
			return await bash_delegate_builtin_command({
				command: "find",
				args: bash_command_build_builtin_delegation_args(args, [target.builtinOperand], {
					optionsWithValues: BUILTIN_OPTIONS_WITH_VALUES,
					pathsPosition: "beforeOptions",
				}),
				commandCtx,
			});
		}
		// App files only support predicates that can be implemented with indexed Convex queries.
		if (parsed._yay.unsupportedAppFilePredicate != null) {
			const regexPredicateHint =
				parsed._yay.unsupportedAppFilePredicate === "-regex" ||
				parsed._yay.unsupportedAppFilePredicate === "-iregex" ||
				parsed._yay.unsupportedAppFilePredicate === "-regextype"
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
					`find: unsupported predicate ${parsed._yay.unsupportedAppFilePredicate} for paths under ${bash_APP_MOUNT_PATH}\n` +
					regexPredicateHint +
					regexPathQueryRetry +
					"GNU find extensions like -printf, -mtime, -newer, -exec, -ok, and -delete are not available there; omit them and use -name QUERY, --path-query QUERY, -type f|d, -maxdepth N, or -mindepth N instead.\n" +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		// Cursor ids are opaque handles stored outside the command output; resolve them before querying.
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
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			// Prefix scans and path word search use different query shapes.
			if (pathQuery != null) {
				return {
					stdout: "",
					stderr:
						"find: --prefix cannot be combined with path word search for app files.\n" +
						"Use `find --prefix PREFIX` for indexed descendant path discovery, or `find -name QUERY` for DB-backed path word search.\n",
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			// Convert to the app path format that matches folder treePath prefixes.
			const prefixResult = prefix_to_app_file_node_path(
				commandCtx,
				currentProjectPath,
				parsed._yay.prefix,
			);
			if (prefixResult._nay) {
				return {
					stdout: "",
					stderr: prefixResult._nay.message,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				folderPath: prefixResult._yay.appFileNodePath,
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.type === "f"
					? { kind: "file" as const }
					: parsed._yay.type === "d"
						? { kind: "folder" as const }
						: {}),
			})) as files_nodes_list_subtree_Result;

			const lines = result.page.map(
				(item) =>
					`${bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				lines.push(
					"",
					build_continuation({
						parsed: parsed._yay,
						target: null,
						prefix: bash_app_file_node_path_to_current_project_path(currentProjectPath, prefixResult._yay.appFileNodePath),
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
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		// Non-prefix app-file execution should only reach this point after target path resolution succeeded.
		if (target.appFileNodePath == null) {
			throw should_never_happen("find: app file path missing after built-in and prefix branches", {
				absoluteShellPath: target.absoluteShellPath,
				prefix: parsed._yay.prefix,
			});
		}

		const fileNode: files_nodes_get_by_path_Result =
			target.appFileNodePath === "/"
				? null
				: await ctx.runQuery(internal.files_nodes.get_by_path, {
						workspaceId: workspaceFs.ctxData.workspaceId,
						projectId: workspaceFs.ctxData.projectId,
						path: target.appFileNodePath,
					});
		// Missing concrete app paths fail normally, with a hint for prefix-style discovery.
		if (target.appFileNodePath !== "/" && !fileNode) {
			return {
				stdout: "",
				stderr:
					`find: ${target.absoluteShellPath}: No such file or directory\n` +
					`If you intended a path-prefix subtree search, run:\n` +
					`  find --prefix ${bash_shell_arg_quote(target.absoluteShellPath)} --limit ${parsed._yay.limit}\n`,
				exitCode: COMMAND_EXIT_FAILURE,
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
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			// Path word search can only express project-wide, direct-child, or subtree scopes.
			let parentId: Id<"files_nodes"> | typeof files_ROOT_ID | undefined = undefined;
			let pathPrefix: string | undefined = undefined;
			let minPathDepth: number | undefined = undefined;
			if (target.appFileNodePath === "/") {
				// At root, -maxdepth 1 is the direct children query.
				if (parsed._yay.maxDepth != null && parsed._yay.maxDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: path word search supports project-wide results or immediate children with -maxdepth 1.\n" +
							`${build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n`,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				// Root has no file-node doc, so only the natural child floor is supported.
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
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				if (parsed._yay.maxDepth === 1) {
					parentId = files_ROOT_ID;
				}
			} else {
				// A scoped path-word search starts from an exact folder.
				if (!fileNode || fileNode.kind !== "folder") {
					return {
						stdout: "",
						stderr: "find: path word search can target the project root or an immediate folder.\n",
						exitCode: COMMAND_EXIT_USAGE,
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
						exitCode: COMMAND_EXIT_USAGE,
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
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				if (parsed._yay.maxDepth === 1) {
					parentId = fileNode._id;
				} else {
					pathPrefix = target.appFileNodePath;
					if (parsed._yay.minDepth === 1) {
						minPathDepth = fileNode.pathDepth + 1;
					}
				}
			}

			const result = (await ctx.runQuery(internal.files_nodes.search_paths, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
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
				(item) =>
					`${bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
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
			if (fileNode?.kind === "file") {
				const matchesDepth =
					(parsed._yay.minDepth == null || parsed._yay.minDepth <= 0) &&
					(parsed._yay.maxDepth == null || parsed._yay.maxDepth >= 0);
				const lines: string[] =
					cursor == null && matchesDepth && fileNode.lowercaseExtension === parsed._yay.extension
						? [bash_app_file_node_path_to_current_project_path(currentProjectPath, fileNode.path)]
						: ["0 matches."];
				return {
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				folderPath: target.appFileNodePath,
				kind: "file" as const,
				lowercaseExtension: parsed._yay.extension,
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.minDepth == null ? {} : { minDepth: parsed._yay.minDepth }),
				...(parsed._yay.maxDepth == null ? {} : { maxDepth: parsed._yay.maxDepth }),
			})) as files_nodes_list_subtree_Result;

			const lines = result.page.map((item) =>
				bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path),
			);
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
		if (fileNode?.kind === "file") {
			const matchesKind = parsed._yay.type == null || parsed._yay.type === "f";
			const matchesDepth =
				(parsed._yay.minDepth == null || parsed._yay.minDepth <= 0) &&
				(parsed._yay.maxDepth == null || parsed._yay.maxDepth >= 0);
			const lines: string[] =
				cursor == null && matchesKind && matchesDepth
					? [bash_app_file_node_path_to_current_project_path(currentProjectPath, fileNode.path)]
					: ["0 matches."];
			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
			workspaceId: workspaceFs.ctxData.workspaceId,
			projectId: workspaceFs.ctxData.projectId,
			folderPath: target.appFileNodePath,
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
			(item) =>
				`${bash_app_file_node_path_to_current_project_path(currentProjectPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
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
