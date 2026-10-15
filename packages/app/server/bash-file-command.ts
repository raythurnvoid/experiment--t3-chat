import { defineCommand, type Command } from "just-bash/browser";
import { Result } from "common/errors-as-values-utils.ts";
import { files_parse_content_type } from "../shared/files.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_create_glob_syntax_unsupported_message,
	bash_enforce_reader_operand_cap,
	bash_GLOB_METACHARACTER_REGEX,
	bash_is_path_under,
	bash_resolve_db_files_shell_path,
	bash_resolve_path,
	bash_SHELLS_MOUNT,
	bash_TMP_MOUNT,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

const FILE_USAGE = "Usage: file [-b|--brief] [--mime-type] [--] FILE...\n";
const SHELL_TRANSCRIPT_PATH_REGEX = /^\/shells\/[^/]+\/transcript$/u;

function parse_args(args: string[]) {
	if (args.length === 1 && args[0] === "--help") {
		return Result({ _yay: { help: true } as const });
	}

	let brief = false;
	let mimeType = false;
	let optionsEnded = false;
	const files: string[] = [];
	for (const arg of args) {
		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && (arg === "-b" || arg === "--brief")) {
			brief = true;
			continue;
		}
		if (!optionsEnded && arg === "--mime-type") {
			mimeType = true;
			continue;
		}
		if (arg === "-") {
			return Result({ _nay: { message: "file: stdin is not supported; name a file path" } });
		}
		if (!optionsEnded && arg.startsWith("-")) {
			return Result({ _nay: { message: `file: unsupported option ${arg}` } });
		}
		files.push(arg);
	}
	if (files.length === 0) {
		return Result({ _nay: { message: "file: missing operand" } });
	}
	return Result({ _yay: { brief, mimeType, files } as const });
}

/**
 * Read stored app types without loading content; only /tmp uses native detection.
 */
export function bash_file_command_create(dbFilesRoots: bash_DbFilesRoots): Command {
	return defineCommand("file", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return { stdout: "", stderr: `${parsed._nay.message}\n${FILE_USAGE}`, exitCode: bash_COMMAND_EXIT_USAGE };
		}
		if ("help" in parsed._yay) {
			return {
				stdout:
					FILE_USAGE +
					"App files report stored content types, without reading their bytes. /tmp uses native detection.\n",
				stderr: "",
				exitCode: 0,
			};
		}

		const capError = bash_enforce_reader_operand_cap({
			command: "file",
			commandCtx,
			dbFilesRoots,
			files: parsed._yay.files,
		});
		if (capError) return capError;

		let stdout = "";
		let stderr = "";
		let hasError = false;
		for (const file of parsed._yay.files) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
			const pathResolution = bash_resolve_db_files_shell_path(resolvedPath, dbFilesRoots);
			let description: string | null = null;
			if (pathResolution.dbFilesPath != null) {
				if (bash_GLOB_METACHARACTER_REGEX.test(file)) {
					stderr += bash_create_glob_syntax_unsupported_message("file", file);
					hasError = true;
					continue;
				}
				const entry = await pathResolution.fs.getEntry(pathResolution.dbFilesPath);
				if (entry?.kind === "folder") {
					description = parsed._yay.mimeType ? "inode/directory" : "directory";
				} else if (entry) {
					const storedType = entry.contentType ?? "";
					const contentType = files_parse_content_type(storedType);
					description = contentType ? (parsed._yay.mimeType ? contentType.essence : storedType) : "unknown";
				}
			} else if (bash_is_path_under(bash_TMP_MOUNT, resolvedPath)) {
				const result = await bash_delegate_builtin_command({
					command: "file",
					args: ["-b", ...(parsed._yay.mimeType ? ["--mime-type"] : []), resolvedPath],
					commandCtx,
				});
				// Native file puts missing-path errors in stdout; render our shared error below.
				if (result.exitCode !== 0 && (result.exitCode !== 1 || result.stderr !== "")) {
					return { stdout, stderr: stderr + result.stderr, exitCode: result.exitCode };
				}
				if (result.exitCode === 0) {
					description = parsed._yay.mimeType
						? (files_parse_content_type(result.stdout.trim())?.essence ?? "unknown")
						: result.stdout.replace(/\n$/u, "");
				}
			} else if (
				bash_is_path_under(bash_SHELLS_MOUNT, resolvedPath) &&
				SHELL_TRANSCRIPT_PATH_REGEX.test(resolvedPath)
			) {
				// stat/lstat materialize lazy transcripts just to calculate their size.
				if (await commandCtx.fs.exists(resolvedPath)) description = "unknown";
			} else {
				try {
					const stat = await commandCtx.fs.lstat(resolvedPath);
					description = stat.isDirectory ? (parsed._yay.mimeType ? "inode/directory" : "directory") : "unknown";
				} catch {
					// Match the missing-file result without exposing hidden entries.
				}
			}

			if (description == null) {
				stderr += `file: cannot stat '${file}': No such file or directory\n`;
				hasError = true;
				continue;
			}
			stdout += `${parsed._yay.brief ? "" : `${file}: `}${description}\n`;
		}
		return { stdout, stderr, exitCode: hasError ? bash_COMMAND_EXIT_FAILURE : 0 };
	});
}
