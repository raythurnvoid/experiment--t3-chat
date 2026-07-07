import { defineCommand } from "just-bash/browser";
import { path_name_of } from "../shared/shared-utils.ts";
import {
	bash_DbFilesContentUnavailableError,
	bash_build_unreadable_file_advisory,
	bash_create_glob_syntax_unsupported_message,
	bash_current_workspace_path_to_db_files_path,
	bash_delegate_builtin_command,
	bash_GLOB_METACHARACTER_REGEX,
	bash_is_path_under_current_workspace_path,
	bash_is_path_under_read_only_mounts,
	bash_normalize_path,
	bash_parse_cp_mv_operands,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_TMP_MOUNT,
	bash_read_only_mount_error,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
} from "./bash-utils.ts";

/**
 * Check whether a normalized path is inside the per-command scratch mount.
 */
function is_under_tmp_mount(path: string) {
	return path === bash_TMP_MOUNT || path.startsWith(`${bash_TMP_MOUNT}/`);
}

/**
 * Allow the one app-file `cp` shape that is useful to agents:
 * copy one readable app file into `/tmp` scratch for Native Just Bash tools.
 *
 * Everything else involving app paths is rejected before delegation so cp never
 * mutates the durable app tree or silently treats app destinations as scratch.
 */
export function bash_cp_command_create(currentWorkspacePath: string) {
	return defineCommand("cp", async (args, commandCtx) => {
		const { operands, recursive } = bash_parse_cp_mv_operands(args);

		// Mounts are read-only: reject any cp whose destination (the last operand) is under /.mounts
		// or /.plugins, before native delegation could write into the reserved mount tree. Copying a
		// mount file OUT to /tmp scratch stays allowed (the source may be a mount path).
		if (operands.length >= 2) {
			const destResolved = bash_resolve_path(commandCtx.cwd, operands[operands.length - 1]);
			if (bash_is_path_under_read_only_mounts(destResolved)) {
				return {
					stdout: "",
					stderr: bash_read_only_mount_error("cp", destResolved),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
		}

		// Classify app operands up front so any app-path command is fully preflighted
		// before delegating to native cp, which could otherwise create /tmp side effects.
		const appOperands = operands.filter((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);

		// Pure scratch/non-app copies keep native Just Bash behavior.
		if (appOperands.length === 0) {
			return await bash_delegate_builtin_command({ command: "cp", args, commandCtx });
		}

		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("cp", operand),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}
		// Writing INTO the app tree (any -> app destination) is read-only for cp; route
		// straight to write_file so the model does not retry cp.
		if (
			operands.length === 2 &&
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operands[1]))
		) {
			const sourceShellPath = bash_resolve_path(commandCtx.cwd, operands[0]);
			const destShellPath = bash_resolve_path(commandCtx.cwd, operands[1]);
			let destDbFilesPath =
				bash_current_workspace_path_to_db_files_path(currentWorkspacePath, destShellPath) ?? operands[1];
			try {
				const destStat = await commandCtx.fs.stat(destShellPath);
				if (destStat.isDirectory) {
					const nativeDirectoryDestPath = bash_normalize_path(`${destShellPath}/${path_name_of(sourceShellPath)}`);
					destDbFilesPath =
						bash_current_workspace_path_to_db_files_path(currentWorkspacePath, nativeDirectoryDestPath) ?? destDbFilesPath;
				}
			} catch {
				// Missing destinations are normal; the rejected write target is the operand itself.
			}
			return {
				stdout: "",
				stderr:
					`cp: cannot write to app file '${operands[1]}': the app file tree is read-only for cp.\n` +
					`To create a durable copy at '${destDbFilesPath}', use write_file with path '${destDbFilesPath}' and the content read from the source.\n` +
					`cp into the app tree is never supported; only cp <app-file> /tmp[/<name>] (scratch copy) is allowed.\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}
		// The only mixed form allowed is source app file first, scratch destination second.
		if (recursive || operands.length !== 2 || appOperands.length !== 1 || appOperands[0] !== operands[0]) {
			return {
				stdout: "",
				stderr:
					"cp: app files can only be copied as one exact readable file to a /tmp destination.\n" +
					"Usage: cp <app-file> /tmp[/<name>] - copies the file content to durable per-thread /tmp scratch space.\n" +
					"To duplicate an app file as a new durable file, use write_file with the new app file path (strip the current workspace path prefix).\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		const sourceShellPath = bash_resolve_path(commandCtx.cwd, operands[0]);
		let destShellPath = bash_resolve_path(commandCtx.cwd, operands[1]);
		if (!is_under_tmp_mount(destShellPath)) {
			const destDbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, destShellPath);
			const destHint =
				destDbFilesPath != null
					? `To create a durable copy at '${destDbFilesPath}', use write_file with path '${destDbFilesPath}' and the content read from the source.`
					: "Choose a /tmp/<name> destination for a scratch copy.";
			return {
				stdout: "",
				stderr:
					`cp: cannot write app file '${operands[0]}' to '${operands[1]}': app-file cp only supports /tmp destinations.\n` +
					`Only /tmp destinations are supported: cp ${bash_shell_arg_quote(operands[0])} /tmp[/<name>]\n` +
					`${destHint}\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}
		try {
			const sourceStat = await commandCtx.fs.stat(sourceShellPath);
			if (!sourceStat.isFile) {
				return {
					stdout: "",
					stderr: "cp: recursive app directory copy is not supported\n",
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			try {
				const destStat = await commandCtx.fs.stat(destShellPath);
				if (destStat.isDirectory) {
					// Match native cp's directory destination behavior within /tmp scratch.
					destShellPath = bash_normalize_path(`${destShellPath}/${path_name_of(sourceShellPath)}`);
				}
			} catch {
				// Missing destinations are normal; writeFile creates the scratch file.
			}
			// Read through the mounted fs so app-file readability checks stay centralized,
			// then write only to the already-validated scratch destination.
			const content = await commandCtx.fs.readFileBuffer(sourceShellPath);
			await commandCtx.fs.writeFile(destShellPath, content);
			return { stdout: "", stderr: "", exitCode: 0 };
		} catch (error) {
			if (error instanceof bash_DbFilesContentUnavailableError) {
				const dbFilesPath =
					bash_current_workspace_path_to_db_files_path(currentWorkspacePath, error.shellPath) ?? error.shellPath;
				return {
					stdout: "",
					stderr: bash_build_unreadable_file_advisory(currentWorkspacePath, dbFilesPath, error.contentType),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			return {
				stdout: "",
				stderr: `cp: cannot copy '${operands[0]}'\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}
	});
}
