import { defineCommand, type FsStat } from "just-bash/browser";
import {
	bash_command_has_disallowed_source_target,
	bash_is_path_under_current_project_path,
	bash_is_path_under_mounts,
	bash_resolve_path,
	bash_disallowed_source_target_error,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_COMMAND_EXIT_CANNOT_EXECUTE,
	bash_COMMAND_EXIT_NOT_FOUND,
} from "./bash-utils.ts";

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
		let scriptName: string;
		let scriptArgs: string[];

		// Treat the common `bash -lc` agent habit as `bash -c`; login-shell setup is irrelevant in this curated shell.
		if (args[0] === "-c" || args[0] === "-lc" || args[0] === "-cl") {
			if (args[1] == null) {
				return {
					stdout: "",
					stderr: `${name}: -c: option requires an argument\n`,
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
			script = args[1];
			scriptName = args[2] ?? name;
			scriptArgs = args.slice(3);
		} else if (args[0].startsWith("-")) {
			return {
				stdout: "",
				stderr: `${name}: unsupported option ${args[0]}\nSupported: ${name} -c 'script' for inline scripts, or ${name} /tmp/script.sh for non-app script files. Avoid set -euo pipefail, process substitution, and other shell-specific flags.\n`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		} else {
			const scriptPath = bash_resolve_path(commandCtx.cwd, args[0]);
			// Script files are only executable from non-app paths such as /tmp.
			// App files are document content, not shell entrypoints.
			if (bash_is_path_under_current_project_path(currentProjectPath, scriptPath)) {
				return {
					stdout: "",
					stderr: `${name}: app-mounted script files are not executable through bash: ${scriptPath}\n`,
					exitCode: bash_COMMAND_EXIT_CANNOT_EXECUTE,
				};
			}
			// Mounted external-source files are read-only document content, not shell entrypoints.
			if (bash_is_path_under_mounts(scriptPath)) {
				return {
					stdout: "",
					stderr: `${name}: mounted external-source files are not executable through bash: ${scriptPath}\n`,
					exitCode: bash_COMMAND_EXIT_CANNOT_EXECUTE,
				};
			}

			let scriptStat: FsStat;
			try {
				scriptStat = await commandCtx.fs.stat(scriptPath);
			} catch {
				return {
					stdout: "",
					stderr: `${name}: ${args[0]}: No such file or directory\n`,
					exitCode: bash_COMMAND_EXIT_NOT_FOUND,
				};
			}
			if (scriptStat.isDirectory) {
				return {
					stdout: "",
					stderr: `${name}: ${args[0]}: Is a directory\n`,
					exitCode: bash_COMMAND_EXIT_CANNOT_EXECUTE,
				};
			}

			try {
				// Stat and read are separated so missing files, directories, and
				// unreadable script bodies get native-looking diagnostics.
				script = await commandCtx.fs.readFile(scriptPath);
				scriptName = args[0];
				scriptArgs = args.slice(1);
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
							? bash_COMMAND_EXIT_NOT_FOUND
							: bash_COMMAND_EXIT_CANNOT_EXECUTE,
				};
			}
		}

		if (!commandCtx.exec) {
			return {
				stdout: "",
				stderr: `${name}: nested execution is unavailable\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}
		if (bash_command_has_disallowed_source_target(script, { cwd: commandCtx.cwd, currentProjectPath })) {
			return {
				stdout: "",
				stderr: bash_disallowed_source_target_error(),
				exitCode: bash_COMMAND_EXIT_CANNOT_EXECUTE,
			};
		}

		const positionalEnv: Record<string, string> = {
			...(commandCtx.exportedEnv ?? {}),
			"0": scriptName,
			"#": String(scriptArgs.length),
			"@": scriptArgs.join(" "),
			"*": scriptArgs.join(" "),
		};
		scriptArgs.forEach((arg, index) => {
			positionalEnv[String(index + 1)] = arg;
		});

		return await commandCtx.exec(script, {
			cwd: commandCtx.cwd,
			env: positionalEnv,
			signal: commandCtx.signal,
			stdin: commandCtx.stdin as unknown as string,
			stdinKind: "bytes",
		});
	});
}
