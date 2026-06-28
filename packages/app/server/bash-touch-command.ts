import { defineCommand } from "just-bash/browser";
import {
	bash_current_project_path_to_app_file_node_path,
	bash_delegate_builtin_command,
	bash_resolve_path,
} from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;

/**
 * Extract only the `touch` operands that can touch app paths.
 *
 * This is not a full touch parser; it skips date/time values and records
 * reference operands so both writes and app-file reference reads are rejected
 * before the delegated built-in can mutate `/tmp`.
 */
function path_operands(args: string[]) {
	const operands: { file: string; kind: "target" | "reference" }[] = [];
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			operands.push({ file: arg, kind: "target" });
			continue;
		}

		if (arg === "--") {
			optionsEnded = true;
			continue;
		}

		if (arg === "-d" || arg === "--date" || arg === "-t") {
			index++;
			continue;
		}

		if (
			arg.startsWith("--date=") ||
			(arg.startsWith("-d") && arg.length > 2) ||
			(arg.startsWith("-t") && arg.length > 2)
		) {
			continue;
		}

		if (arg === "-r" || arg === "--reference") {
			const file = args[index + 1];
			if (file != null && file !== "") {
				operands.push({ file, kind: "reference" });
			}
			index++;
			continue;
		}

		if (arg.startsWith("--reference=")) {
			const file = arg.slice("--reference=".length);
			if (file !== "") {
				operands.push({ file, kind: "reference" });
			}
			continue;
		}

		if (arg.startsWith("-r") && arg.length > 2) {
			operands.push({ file: arg.slice(2), kind: "reference" });
			continue;
		}

		if (!arg.startsWith("-")) {
			operands.push({ file: arg, kind: "target" });
		}
	}

	return operands;
}

/**
 * Keep app files read-only for shell `touch`.
 *
 * The first app operand aborts the batch before delegation, so mixed app and
 * `/tmp` invocations cannot leave partial scratch side effects.
 */
export function bash_touch_command_create(currentProjectPath: string) {
	return defineCommand("touch", async (args, commandCtx) => {
		for (const { file, kind } of path_operands(args)) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
			const appFileNodePath = bash_current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath);

			if (appFileNodePath != null) {
				if (kind === "reference") {
					return {
						stdout: "",
						stderr: `touch: cannot use app file '${file}' as a reference file through bash (app path '${appFileNodePath}').\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}

				return {
					stdout: "",
					stderr:
						`touch: cannot create or update app file '${file}' through bash.\n` +
						`Use write_file with path '${appFileNodePath}' to create a new file (strip the current project path prefix '${currentProjectPath}' from the bash path).\n` +
						`Use edit_file with path '${appFileNodePath}' to update an existing file.\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}

		return await bash_delegate_builtin_command({ command: "touch", args, commandCtx });
	});
}
