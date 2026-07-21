import { defineCommand } from "just-bash/browser";
import { bash_current_workspace_path_to_db_files_path, bash_is_path_under_read_only_mounts, bash_resolve_path, bash_read_only_mount_error, bash_COMMAND_EXIT_FAILURE, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

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
 * Guard shell `touch` before builtin delegation.
 *
 * Mount targets and app reference reads stay rejected, and Ask mode keeps app
 * targets read-only. The first rejected operand aborts the batch before
 * delegation, so mixed app and `/tmp` invocations cannot leave partial scratch
 * side effects. In Agent mode app targets delegate to the builtin, whose
 * `fs.writeFile("")` on a missing file creates an empty pending proposal
 * (an Added file the user reviews in Files); `utimes` on existing app files
 * is a no-op.
 */
export function bash_touch_command_create(dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand("touch", async (args, commandCtx) => {
		for (const { file, kind } of path_operands(args)) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);

			if (bash_is_path_under_read_only_mounts(resolvedPath)) {
				return {
					stdout: "",
					stderr: bash_read_only_mount_error("touch", resolvedPath),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}

			const dbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, resolvedPath);

			if (dbFilesPath != null) {
				if (kind === "reference") {
					return {
						stdout: "",
						stderr: `touch: cannot use app file '${file}' as a reference file through bash (app path '${dbFilesPath}').\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}

				if (!dbFilesRoots.app.fs.allowDbFilesMkdir) {
					return {
						stdout: "",
						stderr:
							`touch: cannot create or update app file '${file}' in Ask mode.\n` +
							"App file writes are available in Agent mode; Ask mode is read-only for app files.\n",
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
			}
		}

		return await bash_delegate_builtin_command({ command: "touch", args, commandCtx });
	});
}
