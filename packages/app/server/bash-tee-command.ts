import { defineCommand } from "just-bash/browser";
import {
	bash_current_project_path_to_db_files_path,
	bash_delegate_builtin_command,
	bash_is_path_under_mounts,
	bash_resolve_path,
	bash_read_only_mount_error,
	bash_COMMAND_EXIT_FAILURE,
} from "./bash-utils.ts";

/**
 * Extract `tee` operands that might write app paths.
 *
 * `tee` options accepted by Just Bash are boolean flags, so skipping
 * dash-leading tokens before `--` finds targets without swallowing option values.
 */
function path_operands(args: string[]) {
	const operands: string[] = [];
	let optionsEnded = false;

	for (const arg of args) {
		if (optionsEnded) {
			operands.push(arg);
			continue;
		}

		if (arg === "--") {
			optionsEnded = true;
			continue;
		}

		if (arg.startsWith("-")) {
			continue;
		}

		operands.push(arg);
	}

	return operands;
}

/**
 * Keep app files read-only for shell `tee`; durable writes must use write_file/edit_file.
 */
export function bash_tee_command_create(currentProjectPath: string) {
	return defineCommand("tee", async (args, commandCtx) => {
		for (const file of path_operands(args)) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);

			if (bash_is_path_under_mounts(resolvedPath)) {
				return {
					stdout: "",
					stderr: bash_read_only_mount_error("tee", resolvedPath),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}

			const dbFilesPath = bash_current_project_path_to_db_files_path(currentProjectPath, resolvedPath);

			if (dbFilesPath != null) {
				return {
					stdout: "",
					stderr:
						`tee: cannot write to app file '${file}' through bash.\n` +
						`Use write_file with path '${dbFilesPath}' to write new content (strip the current project path prefix '${currentProjectPath}').\n` +
						`Use edit_file with path '${dbFilesPath}' to apply targeted edits to an existing file.\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await bash_delegate_builtin_command({ command: "tee", args, commandCtx });
	});
}
