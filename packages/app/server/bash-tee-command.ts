import { defineCommand } from "just-bash/browser";
import { bash_current_workspace_path_to_db_files_path, bash_is_path_under_read_only_mounts, bash_resolve_path, bash_read_only_mount_error, bash_COMMAND_EXIT_FAILURE, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

/**
 * Mirror the builtin's argument handling: `--help` anywhere wins first, then only
 * `-a`/`--append` (including clustered `-aa` and `--append=x`) are valid options and
 * everything else is a file operand (`-` included).
 *
 * Returns null when the builtin would show help or an option error — it exits before
 * touching any file in those cases, so delegating is safe even with app operands.
 */
function parse_tee_invocation(args: string[]): { append: boolean; files: string[] } | null {
	if (args.includes("--help")) {
		return null;
	}
	let append = false;
	const files: string[] = [];
	let optionsEnded = false;
	for (const arg of args) {
		if (optionsEnded || !arg.startsWith("-") || arg === "-") {
			files.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			const optionName = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
			if (optionName !== "append") {
				return null;
			}
			append = true;
			continue;
		}
		for (const flagChar of arg.slice(1)) {
			if (flagChar !== "a") {
				return null;
			}
		}
		append = true;
	}
	return { append, files };
}

/**
 * Guard shell `tee` before builtin delegation.
 *
 * Mount targets stay rejected and Ask mode keeps app targets read-only. In Agent
 * mode app targets are written here instead of delegating: the builtin replaces
 * every write error with a misleading "No such file or directory", while the
 * fs proposal errors carry the real guidance. Writes go through the mounted fs,
 * so app targets become pending proposals and mixed `/tmp` targets keep native
 * behavior.
 */
export function bash_tee_command_create(dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	return defineCommand("tee", async (args, commandCtx) => {
		const parsed = parse_tee_invocation(args);
		if (parsed == null) {
			return await bash_delegate_builtin_command({ command: "tee", args, commandCtx });
		}
		const operands = parsed.files;
		let hasAppOperand = false;
		for (const file of operands) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);

			if (bash_is_path_under_read_only_mounts(resolvedPath)) {
				return {
					stdout: "",
					stderr: bash_read_only_mount_error("tee", resolvedPath),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}

			const dbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, resolvedPath);

			if (dbFilesPath != null) {
				hasAppOperand = true;
				if (!dbFilesRoots.app.fs.allowDbFilesMkdir) {
					return {
						stdout: "",
						stderr:
							`tee: cannot write to app file '${file}' in Ask mode.\n` +
							"App file writes are available in Agent mode; Ask mode is read-only for app files.\n",
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
			}
		}

		if (!hasAppOperand) {
			return await bash_delegate_builtin_command({ command: "tee", args, commandCtx });
		}

		// Mirror the builtin's byte-clean semantics: stdin is a latin1-shaped byte string,
		// each file write uses "binary", and the same bytes pass through to stdout.
		const append = parsed.append;
		const content = String(commandCtx.stdin ?? "");
		let stderr = "";
		let exitCode = 0;
		for (const file of operands) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
			try {
				if (append) {
					await commandCtx.fs.appendFile(resolvedPath, content, "binary");
				} else {
					await commandCtx.fs.writeFile(resolvedPath, content, "binary");
				}
			} catch (error) {
				stderr += `tee: ${file}: ${error instanceof Error ? error.message : String(error)}\n`;
				exitCode = bash_COMMAND_EXIT_FAILURE;
			}
		}

		return {
			stdout: content,
			stderr,
			exitCode,
			stdoutEncoding: "binary" as const,
		};
	});
}
