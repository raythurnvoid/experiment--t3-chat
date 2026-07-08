import { defineCommand } from "just-bash/browser";
import { bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE } from "./bash-utils.ts";
import { bash_ALLOWED_COMMANDS } from "./bash-delegate.ts";

const WHICH_USAGE = "Usage: which [-a] [-s] NAME...\n";
const WHICH_COMBINED_FLAGS_REGEX = /^-[as]{2,}$/u;

/**
 * Custom commands registered by `server/bash.ts` that are not Native Just Bash built-ins.
 */
const APP_SHELL_EXTRA_COMMANDS = ["search", "textgrep", "meta"] as const;
const APP_SHELL_COMMAND_NAMES = new Set<string>([...bash_ALLOWED_COMMANDS, ...APP_SHELL_EXTRA_COMMANDS]);

/**
 * Report the curated app-shell command surface.
 *
 * The printed `/usr/bin/<name>` and `/bin/<name>` paths are synthetic lookup
 * paths for native Just Bash commands. App-only custom commands like `search`
 * and `textgrep` are reported as command-availability advice from the outer
 * shell, but are not executable synthetic files in nested Native Just Bash
 * `/tmp` command instances.
 */
export function bash_which_command_create() {
	return defineCommand("which", async (args) => {
		let silent = false;
		let showAll = false;
		const names: string[] = [];
		let optionsEnded = false;
		for (const arg of args) {
			if (optionsEnded) {
				names.push(arg);
				continue;
			}
			if (arg === "--") {
				optionsEnded = true;
				continue;
			}
			if (arg === "--help") {
				return { stdout: WHICH_USAGE, stderr: "", exitCode: 0 };
			}
			if (arg === "-s" || arg === "--silent") {
				silent = true;
				continue;
			}
			if (arg === "-a" || arg === "--all") {
				showAll = true;
				continue;
			}
			if (WHICH_COMBINED_FLAGS_REGEX.test(arg)) {
				for (const flag of arg.slice(1)) {
					if (flag === "a") showAll = true;
					if (flag === "s") silent = true;
				}
				continue;
			}
			if (arg.startsWith("-")) {
				return {
					stdout: "",
					stderr: `which: unsupported option ${arg}\n${WHICH_USAGE}`,
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
			names.push(arg);
		}
		if (names.length === 0) {
			return {
				stdout: "",
				stderr: `which: missing command name\n${WHICH_USAGE}`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		let stdout = "";
		let stderr = "";
		let allFound = true;
		for (const name of names) {
			// `which` answers for the outer app shell, so it includes app-only
			// commands even though the restricted Native Just Bash PATH exposes
			// only `bash_ALLOWED_COMMANDS`.
			if (APP_SHELL_COMMAND_NAMES.has(name)) {
				if (!silent) {
					stdout += `/usr/bin/${name}\n`;
					if (showAll) {
						stdout += `/bin/${name}\n`;
					}
				}
			} else {
				allFound = false;
				if (!silent) {
					stderr += `which: no ${name} in (/usr/bin:/bin)\n`;
				}
			}
		}
		return { stdout, stderr, exitCode: allFound ? 0 : bash_COMMAND_EXIT_FAILURE };
	});
}
