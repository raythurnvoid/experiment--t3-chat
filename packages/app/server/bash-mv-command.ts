import { defineCommand } from "just-bash/browser";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	bash_create_glob_syntax_unsupported_message,
	bash_current_workspace_path_to_db_files_path,
	bash_delegate_builtin_command,
	bash_GLOB_METACHARACTER_REGEX,
	bash_is_path_under_current_workspace_path,
	bash_is_path_under_read_only_mounts,
	bash_parse_cp_mv_operands,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_read_only_mount_error,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
} from "./bash-utils.ts";

/**
 * Keep app files read-only for shell `mv`.
 *
 * `/tmp` moves still delegate to the built-in. Any app source or destination
 * aborts before delegation so a mixed command cannot leave partial scratch
 * side effects while pretending to mutate the durable app tree.
 */
export function bash_mv_command_create(currentWorkspacePath: string) {
	return defineCommand("mv", async (args, commandCtx) => {
		const { operands } = bash_parse_cp_mv_operands(args);

		// Mounts are read-only: mv would delete a mount source or write a mount destination, so reject
		// any operand under /.mounts or /.plugins before native delegation. (cp <mount> /tmp covers
		// read-out copies.)
		const mountOperand = operands.find((operand) =>
			bash_is_path_under_read_only_mounts(bash_resolve_path(commandCtx.cwd, operand)),
		);
		if (mountOperand != null) {
			return {
				stdout: "",
				stderr: bash_read_only_mount_error("mv", bash_resolve_path(commandCtx.cwd, mountOperand)),
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		const appOperands = operands.filter((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);

		if (appOperands.length === 0) {
			return await bash_delegate_builtin_command({ command: "mv", args, commandCtx });
		}

		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("mv", operand),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}

		const destOperand = operands.length >= 2 ? operands.at(-1) : undefined;
		const sourceOperands = operands.length >= 2 ? operands.slice(0, -1) : operands;
		const sourceAppPathOperand = sourceOperands.find((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);
		const destDbFilesPath =
			destOperand == null
				? null
				: bash_current_workspace_path_to_db_files_path(
						currentWorkspacePath,
						bash_resolve_path(commandCtx.cwd, destOperand),
					);
		const sourceDbFilesPath =
			sourceAppPathOperand == null
				? null
				: bash_current_workspace_path_to_db_files_path(
						currentWorkspacePath,
						bash_resolve_path(commandCtx.cwd, sourceAppPathOperand),
					);

		if (sourceDbFilesPath != null && destDbFilesPath != null) {
			return {
				stdout: "",
				stderr:
					"mv: cannot move or rename app files through bash.\n" +
					`Use the Files sidebar rename/move UI for app path '${sourceDbFilesPath}' -> '${destDbFilesPath}'. For content changes, use edit_file on '${sourceDbFilesPath}' or write_file with path '${destDbFilesPath}'.\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		if (destDbFilesPath != null) {
			return {
				stdout: "",
				stderr:
					`mv: cannot write to app file '${destOperand}': the app file tree is read-only for mv.\n` +
					`To create or replace durable content at '${destDbFilesPath}', use write_file with path '${destDbFilesPath}' and the content read from the source.\n` +
					"Moving /tmp files into the app tree through bash is not supported.\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		if (sourceAppPathOperand == null || sourceDbFilesPath == null) {
			throw should_never_happen("mv: app source path missing after destination branches", {
				operands,
				appOperands,
				sourceOperands,
				sourceAppPathOperand,
				sourceDbFilesPath,
			});
		}

		return {
			stdout: "",
			stderr:
				`mv: cannot move or rename app file '${sourceAppPathOperand}' through bash.\n` +
				`Use the Files sidebar rename/move UI for app path '${sourceDbFilesPath}'. To copy readable content into scratch for processing, use cp ${bash_shell_arg_quote(sourceAppPathOperand)} /tmp/<name>.\n`,
			exitCode: bash_COMMAND_EXIT_FAILURE,
		};
	});
}
