import { defineCommand, type Command } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_visible_internal_list_Result } from "../convex/files_visible.ts";
import { Result } from "common/errors-as-values-utils.ts";
import {
	bash_APP_MOUNT_PATH,
	bash_clamp_listing_page_limit,
	bash_create_glob_syntax_unsupported_message,
	bash_cursor_id_create,
	bash_cursor_id_resolve,
	bash_GLOB_METACHARACTER_REGEX,
	bash_LISTING_DEFAULT_LIMIT,
	bash_LISTING_MAX_LIMIT,
	bash_parse_limit,
	bash_read_option_value,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_resolve_db_files_shell_path,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
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
	contentType?: string | null;
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
			const result = (await ctx.runQuery(internal.files_visible.internal_list, {
				agentSource: targets[0].pathResolution.ctxData.agentSource,
				organizationId: targets[0].pathResolution.ctxData.organizationId,
				workspaceId: targets[0].pathResolution.ctxData.workspaceId,
				visibilityUserId: targets[0].pathResolution.ctxData.userId,
				overlayUserId: targets[0].pathResolution.fs.overlayUserId,
				folderPath: "/",
				mode: "recent",
				numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				orderBy: "updatedAt",
				order: parsed._yay.reverse ? "asc" : "desc",
			})) as files_visible_internal_list_Result;
			if (result._nay)
				return { stdout: "", stderr: `ls: ${result._nay.message}\n`, exitCode: bash_COMMAND_EXIT_FAILURE };
			const lines = result._yay.items.map(
				(item) =>
					`${new Date(item.updatedAt).toISOString()}\t${targets[0].pathResolution.renderShellPath(item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result._yay.isDone && result._yay.continueCursor !== null) {
				lines.push(
					"",
					build_continuation({
						parsed: parsed._yay,
						cursor: await bash_cursor_id_create(ctx, result._yay.continueCursor),
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

			const dbFilesDoc = await target.pathResolution.fs.getEntry(dbFilesPath);
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
			} else {
				const result = (await ctx.runQuery(internal.files_visible.internal_list, {
					agentSource: target.pathResolution.ctxData.agentSource,
					organizationId: target.pathResolution.ctxData.organizationId,
					workspaceId: target.pathResolution.ctxData.workspaceId,
					visibilityUserId: target.pathResolution.ctxData.userId,
					overlayUserId: target.pathResolution.fs.overlayUserId,
					folderPath: dbFilesPath,
					mode: parsed._yay.recursive ? "subtree" : "children",
					numItems: bash_clamp_listing_page_limit(parsed._yay.limit),
					cursor,
					orderBy: parsed._yay.time ? "updatedAt" : "name",
					order: parsed._yay.time ? (parsed._yay.reverse ? "asc" : "desc") : parsed._yay.reverse ? "desc" : "asc",
				})) as files_visible_internal_list_Result;

				if (result._nay) {
					stderr += `ls: ${result._nay.message}\n`;
					exitCode = bash_COMMAND_EXIT_FAILURE;
					continue;
				}

				lines.push(
					...result._yay.items.map((item) =>
						format_item({
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy,
							contentType: item.contentType,
							display: parsed._yay.recursive ? target.pathResolution.renderShellPath(item.path) : item.name,
							long: parsed._yay.long,
						}),
					),
				);

				if (!result._yay.isDone && result._yay.continueCursor !== null) {
					lines.push(
						"",
						build_continuation({
							parsed: parsed._yay,
							absoluteShellPath: target.absoluteShellPath,
							cursor: await bash_cursor_id_create(ctx, result._yay.continueCursor),
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
