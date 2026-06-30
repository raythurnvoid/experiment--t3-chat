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
 * Extract `rm` operands that might delete app paths.
 *
 * `rm` options accepted by Just Bash are boolean flags, so skipping dash-leading
 * tokens before `--` finds targets without swallowing option values.
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
 * Keep app files read-only for shell `rm`; durable deletion/archival stays a UI action.
 */
export function bash_rm_command_create(currentProjectPath: string) {
	return defineCommand("rm", async (args, commandCtx) => {
		for (const file of path_operands(args)) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);

			if (bash_is_path_under_mounts(resolvedPath)) {
				return {
					stdout: "",
					stderr: bash_read_only_mount_error("rm", resolvedPath),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}

			const dbFilesPath = bash_current_project_path_to_db_files_path(currentProjectPath, resolvedPath);
			if (dbFilesPath != null) {
				return {
					stdout: "",
					stderr:
						`rm: cannot delete app file '${file}' through bash.\n` +
						`App files cannot be deleted via shell commands. Use the Files sidebar Archive action for path '${dbFilesPath}', or use write_file/edit_file for content changes.\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await bash_delegate_builtin_command({ command: "rm", args, commandCtx });
	});
}
