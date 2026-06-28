import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_get_by_path_Result } from "../convex/files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_SYNTHETIC_ROOT_FOLDER } from "../shared/files.ts";
import {
	bash_create_glob_syntax_unsupported_message,
	bash_current_project_path_to_app_file_node_path,
	bash_delegate_builtin_command,
	bash_enforce_reader_operand_cap,
	bash_GLOB_METACHARACTER_REGEX,
	bash_get_app_file_byte_size,
	bash_read_option_value,
	bash_resolve_path,
	type bash_WorkspaceFs,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;
const STAT_FORMAT_TOKEN_REGEX = /%[%nNsFaAuUgGyYxXzZ]/g;
const STAT_UNSUPPORTED_FORMAT_TOKEN_REGEX = /%(?![%nNsFaAuUgGyYxXzZ])/u;

/**
 * Parse the small GNU-compatible `stat` surface this app-aware command supports:
 * optional `-c`/`--format`, `--` for dash-leading operands, or `--help` delegation.
 */
function parse_args(args: string[]) {
	let format: string | null = null;
	const files: string[] = [];
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			files.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "--help") {
			return Result({ _yay: { delegate: true } as const });
		}
		if (arg === "-c") {
			const value = bash_read_option_value("stat", args, index, "-c");
			if (value._nay) return value;
			format = value._yay.value;
			index++;
			continue;
		}
		if (arg === "--format") {
			const value = bash_read_option_value("stat", args, index, "--format");
			if (value._nay) return value;
			format = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--format=")) {
			format = arg.slice("--format=".length);
			continue;
		}
		if (arg.startsWith("-c")) {
			format = arg.slice(2);
			continue;
		}
		if (arg.startsWith("-")) {
			return Result({ _nay: { message: `stat: unsupported option ${arg}` } });
		}
		files.push(arg);
	}

	if (files.length === 0) {
		return Result({ _nay: { message: "stat: missing operand" } });
	}

	return Result({ _yay: { format, files } as const });
}

/**
 * Render a POSIX-looking mode string from the fixed placeholder modes app files expose.
 */
function format_mode(mode: number, isDirectory: boolean) {
	const prefix = isDirectory ? "d" : "-";
	const bits = [
		[0o400, "r"],
		[0o200, "w"],
		[0o100, "x"],
		[0o040, "r"],
		[0o020, "w"],
		[0o010, "x"],
		[0o004, "r"],
		[0o002, "w"],
		[0o001, "x"],
	] as const;
	return `${prefix}${bits.map(([bit, char]) => ((mode & bit) === bit ? char : "-")).join("")}`;
}

/**
 * Render either `stat -c` replacement tokens or the default multi-line app metadata view.
 */
function render_output(
	format: string | null,
	file: string,
	stat: { isDirectory: boolean; mode: number; size: number | null | undefined; mtime: Date },
	advisory?: string,
) {
	const modeOctal = stat.mode.toString(8);
	const modeStr = format_mode(stat.mode, stat.isDirectory);
	// When size is undefined the current app-file size is unknown/not tracked;
	// render "?" rather than "0" so a %s format does not mislead the agent into
	// thinking the file is empty.
	const sizeStr = stat.size != null ? String(stat.size) : "?";
	const mtimeIso = stat.mtime.toISOString();
	const mtimeHuman = mtimeIso.replace("T", " ").replace("Z", " +0000");

	if (format != null) {
		const mtimeSeconds = String(Math.floor(stat.mtime.getTime() / 1000));
		const output = format.replace(STAT_FORMAT_TOKEN_REGEX, (token) => {
			switch (token) {
				case "%%":
					return "%";
				case "%n":
					return file;
				case "%N":
					return `'${file}'`;
				case "%s":
					return sizeStr;
				case "%F":
					return stat.isDirectory ? "directory" : "regular file";
				case "%a":
					return modeOctal;
				case "%A":
					return modeStr;
				case "%u":
				case "%g":
					return "1000";
				case "%U":
					return "user";
				case "%G":
					return "group";
				case "%y":
				case "%x":
				case "%z":
					return mtimeHuman;
				case "%Y":
				case "%X":
				case "%Z":
					return mtimeSeconds;
				default:
					return token;
			}
		});
		return `${output}\n`;
	}

	const sizeDisplay =
		stat.size != null
			? String(stat.size)
			: stat.isDirectory
				? "(directory; no content size)"
				: "(content size not tracked for this file)";

	return [
		`  File: ${file}`,
		`  Size: ${sizeDisplay}`,
		`  Type: ${stat.isDirectory ? "directory" : "regular file"}`,
		`Access: (${modeOctal.padStart(4, "0")}/${modeStr})`,
		`Modify: ${mtimeIso}`,
		...(advisory == null ? [] : [advisory]),
		"",
	].join("\n");
}

/**
 * App-aware `stat` that keeps `/tmp` behavior native and renders indexed app-file metadata.
 */
export function bash_stat_command_create(ctx: ActionCtx, workspaceFs: bash_WorkspaceFs, currentProjectPath: string) {
	return defineCommand("stat", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: stat [-c FORMAT] [--] FILE...\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		if ("delegate" in parsed._yay) {
			return await bash_delegate_builtin_command({ command: "stat", args, commandCtx });
		}

		const capError = bash_enforce_reader_operand_cap("stat", commandCtx, currentProjectPath, parsed._yay.files);
		if (capError != null) return capError;

		let stdout = "";
		let stderr = "";
		let hasError = false;
		let warnedUnsupportedAppFormatToken = false;
		for (const file of parsed._yay.files) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
			const appFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath);

			if (appFileNodePath == null) {
				try {
					const stat = await commandCtx.fs.stat(resolvedPath);
					stdout += render_output(parsed._yay.format, file, stat);
				} catch {
					stderr += `stat: cannot stat '${file}': No such file or directory\n`;
					hasError = true;
				}
				continue;
			}

			if (bash_GLOB_METACHARACTER_REGEX.test(file)) {
				stderr += bash_create_glob_syntax_unsupported_message("stat", file);
				hasError = true;
				continue;
			}

			const fileNode: files_nodes_get_by_path_Result | typeof files_SYNTHETIC_ROOT_FOLDER =
				appFileNodePath === "/"
					? files_SYNTHETIC_ROOT_FOLDER
					: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							path: appFileNodePath,
						})) as files_nodes_get_by_path_Result);

			if (!fileNode) {
				stderr += `stat: cannot stat '${file}': No such file or directory\n`;
				hasError = true;
				continue;
			}

			const currentAppFileSize: number | null =
				fileNode.kind === "file"
					? await bash_get_app_file_byte_size({ ctx, ctxData: workspaceFs.ctxData, fileNode })
					: null;

			stdout += render_output(
				parsed._yay.format,
				file,
				{
					isDirectory: fileNode.kind === "folder",
					mode: fileNode.kind === "folder" ? 0o755 : 0o644,
					size: currentAppFileSize,
					mtime: new Date(fileNode.updatedAt),
				},
				"[stat: Access is a fixed placeholder; app files track only Size, Type, and Modify — not POSIX permissions, owner, group, inode, or blocks]",
			);
			// Unsupported format tokens are preserved literally in stdout, matching the
			// formatter above. Warn once on stderr so agents do not treat `%i`, `%b`,
			// device ids, or filesystem ids as real app-file metadata.
			if (
				parsed._yay.format != null &&
				!warnedUnsupportedAppFormatToken &&
				STAT_UNSUPPORTED_FORMAT_TOKEN_REGEX.test(parsed._yay.format)
			) {
				stderr +=
					"stat: app files support only %% %n %N %s %F %a %A %u %U %g %G %y %Y %x %X %z %Z; " +
					"inode, blocks, device, and filesystem fields are not tracked\n";
				warnedUnsupportedAppFormatToken = true;
			}
		}

		return { stdout, stderr, exitCode: hasError ? COMMAND_EXIT_FAILURE : 0 };
	});
}
