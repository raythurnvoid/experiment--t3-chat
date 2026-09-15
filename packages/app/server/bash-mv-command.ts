import { defineCommand, type Command } from "just-bash/browser";
import type { ActionCtx } from "../convex/_generated/server.js";
import {
	bash_create_glob_syntax_unsupported_message,
	bash_GLOB_METACHARACTER_REGEX,
	bash_is_path_under_current_workspace_path,
	bash_is_path_under_read_only_mounts,
	bash_parse_cp_mv_operands,
	bash_resolve_path,
	bash_read_only_mount_error,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";
import { bash_transfer_command_run, type bash_TransferContext } from "./bash-transfer-command.ts";

/**
 * App moves use transfer proposals. Scratch moves keep native behavior.
 */
export function bash_mv_command_create(
	ctx: ActionCtx,
	dbFilesRoots: bash_DbFilesRoots,
	transferContext?: bash_TransferContext,
): Command {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand("mv", async (args, commandCtx) => {
		const parsed = bash_parse_cp_mv_operands("mv", args);
		const { operands } = parsed;
		const mountOperand = operands.find((operand) =>
			bash_is_path_under_read_only_mounts(bash_resolve_path(commandCtx.cwd, operand)),
		);

		if (mountOperand !== undefined)
			return {
				stdout: "",
				stderr: bash_read_only_mount_error("mv", bash_resolve_path(commandCtx.cwd, mountOperand)),
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};

		const appOperands = operands.filter((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);
		if (appOperands.length === 0) return await bash_delegate_builtin_command({ command: "mv", args, commandCtx });

		if (parsed._nay) return { stdout: "", stderr: `${parsed._nay.message}\n`, exitCode: bash_COMMAND_EXIT_USAGE };
		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand))
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("mv", operand),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
		}

		if (appOperands.length !== operands.length)
			return {
				stdout: "",
				stderr:
					"mv: all sources and the destination must be app paths. Use cp <app-file> /tmp/<name> to copy readable text into scratch.\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};

		return await bash_transfer_command_run({
			ctx,
			dbFilesRoots,
			transferContext,
			command: "mv",
			commandCtx,
			parsed: parsed._yay,
		});
	});
}
