import { defineCommand } from "just-bash/browser";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	bash_create_glob_syntax_unsupported_message,
	bash_current_project_path_to_app_file_node_path,
	bash_delegate_builtin_command,
	bash_GLOB_METACHARACTER_REGEX,
	bash_is_path_under_current_project_path,
	bash_parse_cp_mv_operands,
	bash_resolve_path,
	bash_shell_arg_quote,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;

/**
 * Keep app files read-only for shell `mv`.
 *
 * `/tmp` moves still delegate to the built-in. Any app source or destination
 * aborts before delegation so a mixed command cannot leave partial scratch
 * side effects while pretending to mutate the durable app tree.
 */
export function bash_mv_command_create(currentProjectPath: string) {
	return defineCommand("mv", async (args, commandCtx) => {
		const { operands } = bash_parse_cp_mv_operands(args);
		const appOperands = operands.filter((operand) =>
			bash_is_path_under_current_project_path(currentProjectPath, bash_resolve_path(commandCtx.cwd, operand)),
		);

		if (appOperands.length === 0) {
			return await bash_delegate_builtin_command({ command: "mv", args, commandCtx });
		}

		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("mv", operand),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}

		const destOperand = operands.length >= 2 ? operands.at(-1) : undefined;
		const sourceOperands = operands.length >= 2 ? operands.slice(0, -1) : operands;
		const sourceAppOperand = sourceOperands.find((operand) =>
			bash_is_path_under_current_project_path(currentProjectPath, bash_resolve_path(commandCtx.cwd, operand)),
		);
		const destAppFileNodePath =
			destOperand == null
				? null
				: bash_current_project_path_to_app_file_node_path(
						currentProjectPath,
						bash_resolve_path(commandCtx.cwd, destOperand),
					);
		const sourceAppFileNodePath =
			sourceAppOperand == null
				? null
				: bash_current_project_path_to_app_file_node_path(
						currentProjectPath,
						bash_resolve_path(commandCtx.cwd, sourceAppOperand),
					);

		if (sourceAppFileNodePath != null && destAppFileNodePath != null) {
			return {
				stdout: "",
				stderr:
					"mv: cannot move or rename app files through bash.\n" +
					`Use the Files sidebar rename/move UI for app path '${sourceAppFileNodePath}' -> '${destAppFileNodePath}'. For content changes, use edit_file on '${sourceAppFileNodePath}' or write_file with path '${destAppFileNodePath}'.\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		if (destAppFileNodePath != null) {
			return {
				stdout: "",
				stderr:
					`mv: cannot write to app file '${destOperand}': the app file tree is read-only for mv.\n` +
					`To create or replace durable content at '${destAppFileNodePath}', use write_file with path '${destAppFileNodePath}' and the content read from the source.\n` +
					"Moving /tmp files into the app tree through bash is not supported.\n",
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		if (sourceAppOperand == null || sourceAppFileNodePath == null) {
			throw should_never_happen("mv: app source path missing after destination branches", {
				operands,
				appOperands,
				sourceOperands,
				sourceAppOperand,
				sourceAppFileNodePath,
			});
		}

		return {
			stdout: "",
			stderr:
				`mv: cannot move or rename app file '${sourceAppOperand}' through bash.\n` +
				`Use the Files sidebar rename/move UI for app path '${sourceAppFileNodePath}'. To copy readable content into scratch for processing, use cp ${bash_shell_arg_quote(sourceAppOperand)} /tmp/<name>.\n`,
			exitCode: COMMAND_EXIT_FAILURE,
		};
	});
}
