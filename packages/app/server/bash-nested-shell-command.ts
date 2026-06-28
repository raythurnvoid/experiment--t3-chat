import { defineCommand, type FsStat } from "just-bash/browser";
import { bash_is_path_under_current_project_path, bash_resolve_path } from "./bash-utils.ts";

const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;
const COMMAND_EXIT_CANNOT_EXECUTE = 126;
const COMMAND_EXIT_NOT_FOUND = 127;

/**
 * Provide the supported nested shell surface: `bash -c|-lc|-cl 'script'` and
 * non-app script paths. App-mounted scripts are rejected, positional args are
 * forwarded to the nested script, and every nested command still uses the same
 * app-file guards as the outer shell.
 */
export function bash_nested_shell_command_create(name: "bash" | "sh", currentProjectPath: string) {
	return defineCommand(name, async (args, commandCtx) => {
		if (args.length === 0) {
			return { stdout: "", stderr: "", exitCode: 0 };
		}

		let script: string;
		let forwardArgs: string[];

		// Treat the common `bash -lc` agent habit as `bash -c`; login-shell setup is irrelevant in this curated shell.
		if (args[0] === "-c" || args[0] === "-lc" || args[0] === "-cl") {
			if (args[1] == null) {
				return {
					stdout: "",
					stderr: `${name}: -c: option requires an argument\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			script = args[1];
			forwardArgs = args.slice(2);
		} else if (args[0].startsWith("-")) {
			return {
				stdout: "",
				stderr: `${name}: unsupported option ${args[0]}\nSupported: ${name} -c 'script' for inline scripts, or ${name} /tmp/script.sh for non-app script files. Avoid set -euo pipefail, process substitution, and other shell-specific flags.\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		} else {
			const scriptPath = bash_resolve_path(commandCtx.cwd, args[0]);
			// Script files are only executable from non-app paths such as /tmp.
			// App files are document content, not shell entrypoints.
			if (bash_is_path_under_current_project_path(currentProjectPath, scriptPath)) {
				return {
					stdout: "",
					stderr: `${name}: app-mounted script files are not executable through bash: ${scriptPath}\n`,
					exitCode: COMMAND_EXIT_CANNOT_EXECUTE,
				};
			}

			let scriptStat: FsStat;
			try {
				scriptStat = await commandCtx.fs.stat(scriptPath);
			} catch {
				return {
					stdout: "",
					stderr: `${name}: ${args[0]}: No such file or directory\n`,
					exitCode: COMMAND_EXIT_NOT_FOUND,
				};
			}
			if (scriptStat.isDirectory) {
				return {
					stdout: "",
					stderr: `${name}: ${args[0]}: Is a directory\n`,
					exitCode: COMMAND_EXIT_CANNOT_EXECUTE,
				};
			}

			try {
				// Stat and read are separated so missing files, directories, and
				// unreadable script bodies get native-looking diagnostics.
				script = await commandCtx.fs.readFile(scriptPath);
				forwardArgs = args.slice(1);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					stdout: "",
					stderr:
						msg.startsWith("ENOENT") || msg.startsWith("ENOFILE")
							? `${name}: ${args[0]}: No such file or directory\n`
							: msg.startsWith("EACCES")
								? `${name}: ${args[0]}: Permission denied\n`
								: `${name}: ${args[0]}: Cannot read script file\n`,
					exitCode:
						msg.startsWith("ENOENT") || msg.startsWith("ENOFILE")
							? COMMAND_EXIT_NOT_FOUND
							: COMMAND_EXIT_CANNOT_EXECUTE,
				};
			}
		}

		if (!commandCtx.exec) {
			return {
				stdout: "",
				stderr: `${name}: nested execution is unavailable\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		// Disable pathname expansion in nested shells too. Top-level execution uses
		// the same prefix so nested scripts cannot bypass the Convex-backed app glob policy.
		return await commandCtx.exec(`set -f\n${script}`, {
			cwd: commandCtx.cwd,
			signal: commandCtx.signal,
			args: forwardArgs,
			stdin: commandCtx.stdin as unknown as string,
			stdinKind: "bytes",
		});
	});
}
