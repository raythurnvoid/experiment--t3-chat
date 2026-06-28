import { defineCommand } from "just-bash/browser";
import {
	bash_current_project_path_to_app_file_node_path,
	bash_delegate_builtin_command,
	bash_resolve_path,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;

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
			const appFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath);
			if (appFileNodePath != null) {
				return {
					stdout: "",
					stderr:
						`rm: cannot delete app file '${file}' through bash.\n` +
						`App files cannot be deleted via shell commands. Use the Files sidebar Archive action for path '${appFileNodePath}', or use write_file/edit_file for content changes.\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await bash_delegate_builtin_command({ command: "rm", args, commandCtx });
	});
}
