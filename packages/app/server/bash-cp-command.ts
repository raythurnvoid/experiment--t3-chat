import { defineCommand, type Command } from "just-bash/browser";
import type { ActionCtx } from "../convex/_generated/server.js";
import { path_name_of } from "../shared/paths.ts";
import {
	bash_DbFilesContentUnavailableError,
	bash_build_unreadable_file_advisory,
	bash_create_glob_syntax_unsupported_message,
	bash_current_workspace_path_to_db_files_path,
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
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";
import { bash_transfer_command_run, type bash_TransferContext } from "./bash-transfer-command.ts";

function is_under_tmp_mount(path: string) {
	return path === bash_TMP_MOUNT || path.startsWith(`${bash_TMP_MOUNT}/`);
}

/**
 * App copies create reviewable transfer output. Scratch copies keep native behavior.
 */
export function bash_cp_command_create(
	ctx: ActionCtx,
	dbFilesRoots: bash_DbFilesRoots,
	transferContext?: bash_TransferContext,
): Command {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand("cp", async (args, commandCtx) => {
		const parsed = bash_parse_cp_mv_operands("cp", args);
		const { operands } = parsed;
		const destination = operands.at(-1);

		if (operands.length >= 2 && destination !== undefined) {
			const path = bash_resolve_path(commandCtx.cwd, destination);
			if (bash_is_path_under_read_only_mounts(path))
				return { stdout: "", stderr: bash_read_only_mount_error("cp", path), exitCode: bash_COMMAND_EXIT_FAILURE };
		}

		const appOperands = operands.filter((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);
		if (appOperands.length === 0) return await bash_delegate_builtin_command({ command: "cp", args, commandCtx });

		if (parsed._nay) return { stdout: "", stderr: `${parsed._nay.message}\n`, exitCode: bash_COMMAND_EXIT_USAGE };
		const { recursive, conflictPolicy } = parsed._yay;
		const noClobber = conflictPolicy === "skip";

		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand))
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("cp", operand),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
		}

		if (appOperands.length === operands.length)
			return await bash_transfer_command_run({
				ctx,
				dbFilesRoots,
				transferContext,
				command: "cp",
				commandCtx,
				parsed: parsed._yay,
			});

		if (destination !== undefined && appOperands.includes(destination))
			return {
				stdout: "",
				stderr: dbFilesRoots.app.fs.allowDbFilesMkdir
					? `cp: only app files can be copied into the app tree. To write scratch text, use cat <scratch-file> > ${bash_shell_arg_quote(destination)}.\n`
					: "cp: app file writes require Agent mode\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};

		// The only mixed form allowed is source app file first, scratch destination second.
		if (recursive || operands.length !== 2 || appOperands.length !== 1 || appOperands[0] !== operands[0]) {
			return {
				stdout: "",
				stderr:
					"cp: app files can only be copied as one exact readable file to a /tmp destination.\n" +
					"Usage: cp <app-file> /tmp[/<name>] - copies the file content to durable per-thread /tmp scratch space.\n" +
					"To duplicate an app file as a new durable file, use cp <app-file> <new-app-path> — it creates a pending copy the user reviews in Files.\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		const sourceShellPath = bash_resolve_path(commandCtx.cwd, operands[0]);
		let destShellPath = bash_resolve_path(commandCtx.cwd, operands[1]);

		if (!is_under_tmp_mount(destShellPath)) {
			const destDbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, destShellPath);
			const destHint =
				destDbFilesPath != null
					? `To propose that content at '${destDbFilesPath}', redirect instead: cat ${bash_shell_arg_quote(operands[0])} > ${bash_shell_arg_quote(destShellPath)}`
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

			if (noClobber) {
				try {
					await commandCtx.fs.stat(destShellPath);
					return { stdout: "", stderr: "", exitCode: 0 };
				} catch {
					// Missing destinations are normal; continue with the scratch copy.
				}
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
