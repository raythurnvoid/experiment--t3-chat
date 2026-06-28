import { defineCommand } from "just-bash/browser";
import {
	bash_current_project_path_to_app_file_node_path,
	bash_delegate_builtin_command,
	bash_resolve_path,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;

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
			const appFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath);

			if (appFileNodePath != null) {
				return {
					stdout: "",
					stderr:
						`tee: cannot write to app file '${file}' through bash.\n` +
						`Use write_file with path '${appFileNodePath}' to write new content (strip the current project path prefix '${currentProjectPath}').\n` +
						`Use edit_file with path '${appFileNodePath}' to apply targeted edits to an existing file.\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await bash_delegate_builtin_command({ command: "tee", args, commandCtx });
	});
}
