import { defineCommand, type Command } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_list_children_Result,
	files_nodes_list_subtree_Result,
} from "../convex/files_nodes.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { path_name_of } from "../shared/shared-utils.ts";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, files_pending_path_overlay_list_injections, files_pending_path_overlay_project_committed_path } from "../shared/files.ts";
import { bash_APP_MOUNT_PATH, bash_db_files_path_to_current_workspace_path, bash_clamp_listing_page_limit, bash_create_glob_syntax_unsupported_message, bash_cursor_id_create, bash_cursor_id_resolve, bash_GLOB_METACHARACTER_REGEX, bash_LISTING_DEFAULT_LIMIT, bash_LISTING_MAX_LIMIT, bash_overlay_committed_scope_path, bash_overlay_project_scoped_path, bash_overlay_subtree_injections, bash_parse_limit, bash_read_option_value, bash_resolve_path, bash_shell_arg_quote, bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE, bash_resolve_db_files_shell_path, type bash_DbFilesFs, type bash_DbFilesFsOptions, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_command_build_builtin_delegation_args, bash_delegate_builtin_command } from "./bash-delegate.ts";

const PATH_OPERAND_MAX = 20;
const BUILTIN_OPTIONS_WITH_VALUES = new Set<string>();

function parse_args(args: string[]) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	const paths: string[] = [];
	let unsupportedDbFilesOption: string | null = null;
	let recursive = false;
	let directory = false;
	let reverse = false;
	let long = false;
	let time = false;
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			paths.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "--limit") {
			const value = bash_read_option_value("ls", args, index, "--limit");
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
			const value = bash_read_option_value("ls", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (arg === "--recursive") {
			recursive = true;
			continue;
		}
		if (arg === "--directory") {
			directory = true;
			continue;
		}
		if (arg === "--reverse") {
			reverse = true;
			continue;
		}
		if (arg === "--classify") {
			continue;
		}
		if (arg === "--indicator-style") {
			const value = bash_read_option_value("ls", args, index, "--indicator-style");
			if (value._nay) return value;
			if (value._yay.value !== "slash") {
				unsupportedDbFilesOption ??= `--indicator-style=${value._yay.value}`;
			}
			index++;
			continue;
		}
		if (arg.startsWith("--indicator-style=")) {
			const value = arg.slice("--indicator-style=".length);
			if (value !== "slash") {
				unsupportedDbFilesOption ??= arg;
			}
			continue;
		}
		if (arg === "--sort") {
			const value = bash_read_option_value("ls", args, index, "--sort");
			if (value._nay) return value;
			if (value._yay.value === "time" || value._yay.value === "mtime") {
				time = true;
			} else if (value._yay.value !== "name") {
				unsupportedDbFilesOption ??= `--sort=${value._yay.value}`;
			}
			index++;
			continue;
		}
		if (arg.startsWith("--sort=")) {
			const value = arg.slice("--sort=".length);
			if (value === "time" || value === "mtime") {
				time = true;
			} else if (value !== "name") {
				unsupportedDbFilesOption ??= arg;
			}
			continue;
		}
		if (arg.startsWith("--")) {
			unsupportedDbFilesOption ??= arg;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of arg.slice(1)) {
				if (flag === "1" || flag === "a" || flag === "A" || flag === "p" || flag === "F") {
					continue;
				}
				if (flag === "d") {
					directory = true;
					continue;
				}
				if (flag === "r") {
					reverse = true;
					continue;
				}
				if (flag === "R") {
					recursive = true;
					continue;
				}
				if (flag === "l") {
					long = true;
					continue;
				}
				if (flag === "t") {
					time = true;
					continue;
				}
				unsupportedDbFilesOption ??= `-${flag}`;
			}
			continue;
		}
		paths.push(arg);
	}

	const limit = bash_parse_limit("ls", limitValue, bash_LISTING_DEFAULT_LIMIT, bash_LISTING_MAX_LIMIT);
	if (limit._nay) {
		return limit;
	}
	if (paths.length > PATH_OPERAND_MAX) {
		return Result({ _nay: { message: `ls: app file listings support at most ${PATH_OPERAND_MAX} path operands` } });
	}

	if (cursor != null && cursor.trim() === "") {
		cursor = null;
	}
	if (cursor != null && paths.length > 1) {
		return Result({ _nay: { message: "ls: --cursor can only continue one listing target" } });
	}

	return Result({
		_yay: {
			paths,
			limit: limit._yay,
			cursor,
			unsupportedDbFilesOption,
			recursive,
			directory,
			reverse,
			long,
			time,
		} as const,
	});
}

function format_item(args: {
	kind: "folder" | "file";
	updatedAt: number;
	updatedBy?: string;
	contentType?: string;
	display: string;
	long: boolean;
}) {
	const display = args.kind === "folder" && !args.display.endsWith("/") ? `${args.display}/` : args.display;
	if (!args.long) {
		return display;
	}
	const fields = [args.kind, new Date(args.updatedAt).toISOString(), `updatedBy=${args.updatedBy ?? "-"}`];
	if (args.contentType != null) {
		fields.push(`contentType=${args.contentType}`);
	}
	fields.push(display);
	return fields.join("\t");
}

async function get_path_entry(args: {
	ctx: ActionCtx;
	ctxData: bash_DbFilesFsOptions["ctxData"];
	dbFilesFs: bash_DbFilesFs;
	dbFilesPath: string;
	needsFullMetadata: boolean;
}) {
	if (!args.needsFullMetadata) {
		const cached = await args.dbFilesFs.getEntry(args.dbFilesPath);
		if (!cached) {
			return null;
		}
		if (args.dbFilesPath === "/") {
			return files_SYNTHETIC_ROOT_FOLDER;
		}
		if (cached._id != null) {
			return {
				_id: cached._id,
				path: cached.path,
				name: cached.name,
				kind: cached.kind,
				updatedAt: cached.updatedAt,
				updatedBy: cached.updatedBy,
				contentType: cached.contentType,
			};
		}
	}

	if (args.dbFilesPath === "/") {
		return files_SYNTHETIC_ROOT_FOLDER;
	}

	const dbFilesDoc = (await args.ctx.runQuery(internal.files_nodes.get_by_path, {
		organizationId: args.ctxData.organizationId,
		workspaceId: args.ctxData.workspaceId,
		path: args.dbFilesPath,
		overlayUserId: args.dbFilesFs.overlayUserId,
	})) as files_nodes_get_by_path_Result;
	if (dbFilesDoc) {
		// The overlay can present a moved node here: cache it under the requested path,
		// never the node's committed path (identical without an overlay).
		args.dbFilesFs.rememberEntry({
			_id: dbFilesDoc._id,
			path: args.dbFilesPath,
			name: path_name_of(args.dbFilesPath),
			kind: dbFilesDoc.kind,
			updatedAt: dbFilesDoc.updatedAt,
			updatedBy: dbFilesDoc.updatedBy,
			contentType: dbFilesDoc.contentType,
		});
	}
	return dbFilesDoc;
}

function build_continuation(args: {
	parsed: NonNullable<ReturnType<typeof parse_args>["_yay"]>;
	absoluteShellPath?: string;
	cursor: string;
}) {
	const continuationParts = ["Next page:", "ls"];
	if (args.parsed.long) {
		continuationParts.push("-l");
	}
	if (args.parsed.reverse) {
		continuationParts.push("-r");
	}
	if (args.parsed.time) {
		continuationParts.push("-t");
	}
	if (args.parsed.recursive && !args.parsed.directory) {
		continuationParts.push("-R");
	}
	continuationParts.push("--limit", String(args.parsed.limit), "--cursor", bash_shell_arg_quote(args.cursor));
	if (args.absoluteShellPath != null) {
		continuationParts.push(bash_shell_arg_quote(args.absoluteShellPath));
	}
	return continuationParts.join(" ");
}

// The explicit `Command` return type breaks a type-inference cycle: the handler's inferred
// type would otherwise flow through internal.* into the bash action and back into this command.
export function bash_ls_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots): Command {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand("ls", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// AI agents commonly hallucinate `--next-page`; reject it after parse
		// validation so malformed real options still report their normal errors.
		if (args.includes("--next-page")) {
			return {
				stdout: "",
				stderr:
					"ls: --next-page is not supported\n" +
					"Copy the exact `Next page: ls --limit N --cursor ... <path>` command from the previous ls output.\n" +
					"Usage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		const targetInputs = parsed._yay.paths.length > 0 ? parsed._yay.paths : [undefined];

		// Turn each ls target into a shell path and classify it (workspace / mount / synthetic root / external).
		const targets = targetInputs.map((path) => {
			const absoluteShellPath = bash_resolve_path(commandCtx.cwd, path ?? commandCtx.cwd);
			const pathResolution = bash_resolve_db_files_shell_path(absoluteShellPath, dbFilesRoots);
			return {
				inputPath: path,
				absoluteShellPath,
				pathResolution,
				dbFilesPath: pathResolution.dbFilesPath,
				builtinOperand: path ?? ".",
			};
		});

		// App-aware = a db file listing target: a workspace/mount db-files path, including the reserved
		// `/.mounts` root which maps to `"/"` in the reserved scope.
		const hasDbFilesPathTarget = targets.some((target) => target.dbFilesPath != null);

		if (hasDbFilesPathTarget && parsed._yay.unsupportedDbFilesOption != null) {
			const opt = parsed._yay.unsupportedDbFilesOption;
			const hint = `ls on db-files paths under ${bash_APP_MOUNT_PATH} or /.mounts supports name and time order only; use find/search for pattern and content discovery.`;
			return {
				stdout: "",
				stderr: `ls: unsupported option ${opt} for db-files paths under ${bash_APP_MOUNT_PATH} or /.mounts\n${hint}\nUsage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		let cursor: string | null = null;
		if (hasDbFilesPathTarget && parsed._yay.cursor != null) {
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

		// Pathless `ls -t` is the workspace-wide recency view, so the agent can ask
		// "what changed recently?" without first discovering every folder. Only for a workspace cwd —
		// inside a mount there is no workspace-wide view, so it falls to the per-target mount listing below.
		if (parsed._yay.time && parsed._yay.paths.length === 0 && targets[0]?.pathResolution.kind === "app") {
			const result = (await ctx.runQuery(internal.files_nodes.list_children, {
				organizationId: targets[0].pathResolution.ctxData.organizationId,
				workspaceId: targets[0].pathResolution.ctxData.workspaceId,
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				orderBy: "updatedAt",
				order: parsed._yay.reverse ? "asc" : "desc",
			})) as files_nodes_list_children_Result;

			// The proposer's pending moves project recency entries into the visible tree: moved
			// nodes show their visible path and hidden ones (replaced, shadowed) drop out.
			const overlay = await targets[0].pathResolution.fs.getOverlay();
			const visibleItems =
				overlay == null
					? result.items
					: result.items.flatMap((item) => {
							const visiblePath = files_pending_path_overlay_project_committed_path(overlay, item.path);
							return visiblePath == null ? [] : [{ ...item, path: visiblePath }];
						});

			const lines = visibleItems.map(
				(item) =>
					`${new Date(item.updatedAt).toISOString()}\t${bash_db_files_path_to_current_workspace_path(currentWorkspacePath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				lines.push(
					"",
					build_continuation({
						parsed: parsed._yay,
						cursor: await bash_cursor_id_create(ctx, result.continueCursor),
					}),
				);
			} else if (lines.length === 0) {
				lines.push("(no files)");
			}
			return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
		}

		// There is no single indexed query for recursive subtree results ordered by
		// updatedAt, so reject instead of loading and sorting a whole tree in memory.
		if (hasDbFilesPathTarget && parsed._yay.time && parsed._yay.recursive && !parsed._yay.directory) {
			return {
				stdout: "",
				stderr:
					"ls -t -R is not supported for app file paths.\n" +
					"Use `ls -t` for workspace-wide recency, `ls -t <dir>` for immediate children, or `find <dir>` for recursive path discovery.\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		// db-files paths are db-backed. Native Just Bash glob expansion would require
		// unbounded client-side filtering, so guide callers to indexed commands.
		for (const target of targets) {
			if (
				target.dbFilesPath != null &&
				target.inputPath != null &&
				bash_GLOB_METACHARACTER_REGEX.test(target.inputPath)
			) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("ls", target.inputPath),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}

		const sections: string[] = [];
		let stderr = "";
		let exitCode = 0;
		for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
			const target = targets[targetIndex];
			const dbFilesPath = target.dbFilesPath;

			if (dbFilesPath == null) {
				const builtinTargets = [target];
				while (targetIndex + 1 < targets.length && targets[targetIndex + 1].dbFilesPath == null) {
					targetIndex++;
					builtinTargets.push(targets[targetIndex]);
				}

				// Adjacent built-in targets can run as one delegated ls call. Stop the
				// batch before an app target so output order stays the same as input order.
				const result = await bash_delegate_builtin_command({
					command: "ls",
					args: bash_command_build_builtin_delegation_args(
						args,
						builtinTargets.map((builtinTarget) => builtinTarget.builtinOperand),
						{
							optionsWithValues: BUILTIN_OPTIONS_WITH_VALUES,
							pathsPosition: "afterOptions",
						},
					),
					commandCtx,
				});
				let stdout = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
				try {
					const stat = await commandCtx.fs.stat(target.absoluteShellPath);
					// A single built-in directory in a mixed ls still needs the heading
					// that multi-target ls would have printed.
					if (
						builtinTargets.length === 1 &&
						targets.length > 1 &&
						stat.isDirectory &&
						!parsed._yay.directory &&
						!parsed._yay.recursive
					) {
						stdout = stdout.length > 0 ? `${target.builtinOperand}:\n${stdout}` : `${target.builtinOperand}:`;
					}
				} catch {
					// Missing built-in targets already report through the delegated ls stderr.
				}
				if (stdout.length > 0) {
					sections.push(stdout);
				}
				stderr += result.stderr;
				if (result.exitCode !== 0) {
					exitCode = result.exitCode;
				}
				continue;
			}

			// Plain output only needs basic entry data. Long output asks for the
			// full files_nodes doc when it needs updatedBy/contentType fields.
			const dbFilesDoc = await get_path_entry({
				ctx,
				ctxData: target.pathResolution.ctxData,
				dbFilesFs: target.pathResolution.fs,
				dbFilesPath,
				needsFullMetadata:
					parsed._yay.long &&
					(parsed._yay.directory || (await target.pathResolution.fs.getEntry(dbFilesPath))?.kind === "file"),
			});
			if (!dbFilesDoc) {
				stderr += `ls: cannot access '${target.absoluteShellPath}': No such file or directory\n`;
				if (exitCode === 0) {
					exitCode = bash_COMMAND_EXIT_FAILURE;
				}
				continue;
			}

			const lines: string[] = [];
			if (parsed._yay.directory || dbFilesDoc.kind === "file") {
				// `-d` means "print the target itself"; files are also printed as a
				// single target instead of being treated as directories.
				if (parsed._yay.cursor != null) {
					return {
						stdout: "",
						stderr: `ls: --cursor can only continue a directory or recursive listing\n`,
						exitCode: bash_COMMAND_EXIT_USAGE,
					};
				}
				lines.push(
					format_item({
						kind: dbFilesDoc.kind,
						updatedAt: dbFilesDoc.updatedAt,
						updatedBy: dbFilesDoc.updatedBy,
						contentType: dbFilesDoc.contentType,
						display: target.absoluteShellPath,
						long: parsed._yay.long,
					}),
				);
			} else if (parsed._yay.recursive) {
				// Recursive listings use the subtree index and print absolute shell
				// paths, since children can be nested at different depths.
				// The listed folder may be a pending-move destination: walk its committed
				// source subtree and project every entry back into the visible tree.
				const overlay = await target.pathResolution.fs.getOverlay();
				const committedFolderPath = overlay == null ? dbFilesPath : bash_overlay_committed_scope_path(overlay, dbFilesPath);
				const result = (await ctx.runQuery(internal.files_nodes.list_subtree, {
					organizationId: target.pathResolution.ctxData.organizationId,
					workspaceId: target.pathResolution.ctxData.workspaceId,
					folderPath: committedFolderPath,
					numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
					cursor,
					minDepth: 1,
					order: parsed._yay.reverse ? "desc" : "asc",
				})) as files_nodes_list_subtree_Result;

				const visibleItems =
					overlay == null
						? result.page
						: result.page.flatMap((item) => {
								const visiblePath = bash_overlay_project_scoped_path({
									overlay,
									committedPath: item.path,
									visibleScopePath: dbFilesPath,
								});
								return visiblePath == null ? [] : [{ ...item, path: visiblePath }];
							});

				lines.push(
					...visibleItems.map((item) =>
						format_item({
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy,
							contentType: item.contentType,
							display: target.pathResolution.renderShellPath(item.path),
							long: parsed._yay.long,
						}),
					),
				);

				// Moved-in entries live outside the walked committed subtree: add them once,
				// on the first page, with each moved folder's committed subtree spliced in.
				if (overlay != null && cursor == null) {
					// A nested pending move can surface twice: once projected out of its moved parent's
					// splice and once as its own injection. Keep the first appearance of each visible path.
					const seenVisiblePaths = new Set(visibleItems.map((item) => item.path));
					for (const move of bash_overlay_subtree_injections(overlay, {
						visibleScopePath: dbFilesPath,
						committedScopePath: committedFolderPath,
					})) {
						const injectedDoc = (await ctx.runQuery(internal.files_nodes.get_by_path, {
							organizationId: target.pathResolution.ctxData.organizationId,
							workspaceId: target.pathResolution.ctxData.workspaceId,
							path: move.committedPath,
						})) as files_nodes_get_by_path_Result;
						if (!injectedDoc) {
							continue;
						}
						if (!seenVisiblePaths.has(move.visiblePath)) {
							seenVisiblePaths.add(move.visiblePath);
							lines.push(
								format_item({
									kind: injectedDoc.kind,
									updatedAt: injectedDoc.updatedAt,
									updatedBy: injectedDoc.updatedBy,
									contentType: injectedDoc.contentType,
									display: target.pathResolution.renderShellPath(move.visiblePath),
									long: parsed._yay.long,
								}),
							);
						}
						if (injectedDoc.kind !== "folder") {
							continue;
						}
						// The splice repeats this branch's own query shape, so a leftover splice
						// cursor can continue through `ls -R <visible destination> --cursor ...`.
						const splice = (await ctx.runQuery(internal.files_nodes.list_subtree, {
							organizationId: target.pathResolution.ctxData.organizationId,
							workspaceId: target.pathResolution.ctxData.workspaceId,
							folderPath: move.committedPath,
							numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
							cursor: null,
							minDepth: 1,
							order: parsed._yay.reverse ? "desc" : "asc",
						})) as files_nodes_list_subtree_Result;
						for (const item of splice.page) {
							const visiblePath = bash_overlay_project_scoped_path({
								overlay,
								committedPath: item.path,
								visibleScopePath: dbFilesPath,
							});
							if (visiblePath == null || seenVisiblePaths.has(visiblePath)) {
								continue;
							}
							seenVisiblePaths.add(visiblePath);
							lines.push(
								format_item({
									kind: item.kind,
									updatedAt: item.updatedAt,
									updatedBy: item.updatedBy,
									contentType: item.contentType,
									display: target.pathResolution.renderShellPath(visiblePath),
									long: parsed._yay.long,
								}),
							);
						}
						if (!splice.isDone) {
							lines.push(
								"",
								build_continuation({
									parsed: parsed._yay,
									absoluteShellPath: target.pathResolution.renderShellPath(move.visiblePath),
									cursor: await bash_cursor_id_create(ctx, splice.continueCursor),
								}),
							);
						}
					}
				}
				if (!result.isDone) {
					lines.push(
						"",
						build_continuation({
							parsed: parsed._yay,
							absoluteShellPath: target.absoluteShellPath,
							cursor: await bash_cursor_id_create(ctx, result.continueCursor),
						}),
					);
				}
			} else {
				// Plain directory listings are a parentId query. The workspace root is
				// synthetic, so its parent id is the stable root sentinel.
				let parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
				if (dbFilesDoc.path === "/") {
					parentId = files_ROOT_ID;
				} else {
					parentId = dbFilesDoc._id as Id<"files_nodes">;
				}
				const result = (await ctx.runQuery(internal.files_nodes.list_children, {
					organizationId: target.pathResolution.ctxData.organizationId,
					workspaceId: target.pathResolution.ctxData.workspaceId,
					parentId,
					numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
					cursor,
					orderBy: parsed._yay.time ? "updatedAt" : "name",
					order: parsed._yay.time ? (parsed._yay.reverse ? "asc" : "desc") : parsed._yay.reverse ? "desc" : "asc",
				})) as files_nodes_list_children_Result;

				// Children come from the committed folder (a redirected folder lists its
				// committed source's children); keep each child only when its visible
				// parent is still this folder, showing renamed children under the new name.
				const overlay = await target.pathResolution.fs.getOverlay();
				const visibleItems =
					overlay == null
						? result.items
						: result.items.flatMap((item) => {
								const visiblePath = files_pending_path_overlay_project_committed_path(overlay, item.path);
								if (visiblePath == null) {
									return [];
								}
								const visibleParentPath = visiblePath.slice(0, visiblePath.lastIndexOf("/")) || "/";
								if (visibleParentPath !== dbFilesPath) {
									return [];
								}
								return [{ ...item, path: visiblePath, name: visiblePath.slice(visiblePath.lastIndexOf("/") + 1) }];
							});
				// Moved-in children appear once, on the first page, from their committed docs.
				// Skip injections whose visible path a projected child already owns.
				if (overlay != null && cursor == null) {
					const seenVisiblePaths = new Set(visibleItems.map((item) => item.path));
					for (const injection of files_pending_path_overlay_list_injections(overlay, dbFilesPath)) {
						const injectedPath = dbFilesPath === "/" ? `/${injection.visibleName}` : `${dbFilesPath}/${injection.visibleName}`;
						if (seenVisiblePaths.has(injectedPath)) {
							continue;
						}
						const injectedDoc = (await ctx.runQuery(internal.files_nodes.get_by_path, {
							organizationId: target.pathResolution.ctxData.organizationId,
							workspaceId: target.pathResolution.ctxData.workspaceId,
							path: injection.committedPath,
						})) as files_nodes_get_by_path_Result;
						if (!injectedDoc) {
							continue;
						}
						visibleItems.push({
							name: injection.visibleName,
							kind: injectedDoc.kind,
							path: injectedPath,
							updatedAt: injectedDoc.updatedAt,
							updatedBy: injectedDoc.updatedBy,
							contentType: injectedDoc.contentType,
						});
					}
				}

				lines.push(
					...visibleItems.map((item) =>
						format_item({
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy,
							contentType: item.contentType,
							display: item.name,
							long: parsed._yay.long,
						}),
					),
				);
				if (!result.isDone) {
					lines.push(
						"",
						build_continuation({
							parsed: parsed._yay,
							absoluteShellPath: target.absoluteShellPath,
							cursor: await bash_cursor_id_create(ctx, result.continueCursor),
						}),
					);
				}
			}

			if (lines.length === 0) {
				lines.push("(empty directory)");
			}
			if (targets.length > 1 && dbFilesDoc.kind === "folder" && !parsed._yay.directory) {
				lines.unshift(`${target.absoluteShellPath}:`);
			}
			sections.push(lines.join("\n"));
		}

		return {
			stdout: sections.length > 0 ? `${sections.join("\n\n")}\n` : "",
			stderr,
			exitCode,
		};
	});
}
