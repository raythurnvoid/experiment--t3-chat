import { defineCommand, type CommandContext } from "just-bash/browser";
import { Result } from "../shared/errors-as-values-utils.ts";
import {
	bash_shell_arg_quote,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_NON_NEGATIVE_INTEGER_REGEX,
	bash_WHITESPACE_RUN_REGEX,
} from "./bash-utils.ts";

const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });
const XARGS_DELIMITER_NEWLINE_ESCAPE_REGEX = /\\n/gu;
const XARGS_DELIMITER_TAB_ESCAPE_REGEX = /\\t/gu;
const XARGS_DELIMITER_NUL_ESCAPE_REGEX = /\\0/gu;
const XARGS_ATTACHED_MAX_ARGS_REGEX = /^-n\d+$/u;
const XARGS_COMBINED_BOOLEAN_FLAGS_REGEX = /^-[0rt]{2,}$/u;
const XARGS_SINGLE_TRAILING_NEWLINE_REGEX = /\n$/u;
const XARGS_USAGE =
	"Supported: xargs [-n N|--max-args N|--max-args=N] [-I REPLACE|--replace[=REPLACE]] [-d DELIM|--delimiter DELIM|--delimiter=DELIM] [-P 0|1] [-0] [-t] [-r] [--] [COMMAND [ARGS...]]\n";

/**
 * Decode Just Bash's latin1-shaped byte stdin into Unicode text for commands
 * that parse text instead of forwarding raw bytes.
 */
function decode_bash_stdin_as_utf8(stdin: CommandContext["stdin"] | undefined) {
	if (stdin == null) {
		return "";
	}
	const bytes = String(stdin);
	// Just Bash exposes stdin as a ByteString: one JS code unit per raw byte.
	const buffer = new Uint8Array(bytes.length);
	for (let index = 0; index < bytes.length; index++) {
		buffer[index] = bytes.charCodeAt(index) & 0xff;
	}
	try {
		return fatalTextDecoder.decode(buffer);
	} catch {
		// If stdin was already normal JS text, preserve it instead of making xargs fail.
		return bytes;
	}
}

function parse_delimiter(value: string) {
	return value
		.replace(XARGS_DELIMITER_NEWLINE_ESCAPE_REGEX, "\n")
		.replace(XARGS_DELIMITER_TAB_ESCAPE_REGEX, "\t")
		.replace(XARGS_DELIMITER_NUL_ESCAPE_REGEX, "\0");
}

function parse_max_args(rawValue: string | undefined) {
	if (rawValue == null || !bash_NON_NEGATIVE_INTEGER_REGEX.test(rawValue) || Number(rawValue) < 1) {
		return Result({ _nay: { message: "xargs: -n requires a positive integer" } });
	}
	return Result({ _yay: { maxArgs: Number(rawValue) } as const });
}

function parse_parallel(rawValue: string | undefined) {
	if (rawValue == null || rawValue === "" || !bash_NON_NEGATIVE_INTEGER_REGEX.test(rawValue)) {
		return Result({ _nay: { message: "xargs: -P requires a non-negative integer" } });
	}
	if (Number(rawValue) > 1) {
		return Result({
			_nay: {
				message: "xargs: parallel execution (-P > 1) is not supported in this app shell",
				includeUsage: false,
			} as const,
		});
	}
	return Result({ _yay: {} });
}

function parse_args(args: string[]) {
	let replaceString: string | null = null;
	let delimiter: string | null = null;
	let maxArgs: number | null = null;
	let nullSeparated = false;
	let verbose = false;
	let commandStart = args.length;

	// Parse only xargs flags until the first command token. `commandStart`
	// always points at the command argv that will receive the parsed stdin items.
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help") {
			return Result({ _yay: { help: true } as const });
		}
		if (arg === "--") {
			commandStart = index + 1;
			break;
		}
		if (arg === "--replace") {
			replaceString = "{}";
			commandStart = index + 1;
			continue;
		}
		if (arg === "-I") {
			const value = args[index + 1];
			if (value == null || value === "") {
				return Result({ _nay: { message: "xargs: -I requires a value" } });
			}
			replaceString = value;
			index++;
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("--replace=")) {
			const value = arg.slice("--replace=".length);
			if (value === "") {
				return Result({ _nay: { message: "xargs: -I requires a value" } });
			}
			replaceString = value;
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("-I") && arg.length > 2) {
			replaceString = arg.slice(2);
			commandStart = index + 1;
			continue;
		}
		if (arg === "-d" || arg === "--delimiter") {
			const value = args[index + 1];
			if (value == null || value === "") {
				return Result({ _nay: { message: "xargs: -d requires a value" } });
			}
			delimiter = parse_delimiter(value);
			index++;
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("--delimiter=")) {
			const value = arg.slice("--delimiter=".length);
			if (value === "") {
				return Result({ _nay: { message: "xargs: -d requires a value" } });
			}
			delimiter = parse_delimiter(value);
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("-d") && arg.length > 2) {
			delimiter = parse_delimiter(arg.slice(2));
			commandStart = index + 1;
			continue;
		}
		if (arg === "-n" || arg === "--max-args") {
			const parsed = parse_max_args(args[index + 1]);
			if (parsed._nay) return parsed;
			maxArgs = parsed._yay.maxArgs;
			index++;
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("--max-args=")) {
			const parsed = parse_max_args(arg.slice("--max-args=".length));
			if (parsed._nay) return parsed;
			maxArgs = parsed._yay.maxArgs;
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("-n") && arg.length > 2) {
			if (!XARGS_ATTACHED_MAX_ARGS_REGEX.test(arg)) {
				return Result({ _nay: { message: "xargs: -n requires a positive integer" } });
			}
			const parsed = parse_max_args(arg.slice(2));
			if (parsed._nay) return parsed;
			maxArgs = parsed._yay.maxArgs;
			commandStart = index + 1;
			continue;
		}
		// Accept `-P 0` and `-P 1` for compatibility, but keep execution serial.
		// Parallel nested shell execution would make stdout/stderr ordering and
		// mutation timing much harder for an agent to reason about.
		if (arg === "-P") {
			const parsed = parse_parallel(args[index + 1]);
			if (parsed._nay) return parsed;
			index++;
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("-P") && arg.length > 2) {
			const parsed = parse_parallel(arg.slice(2));
			if (parsed._nay) return parsed;
			commandStart = index + 1;
			continue;
		}
		if (arg === "-0" || arg === "--null") {
			nullSeparated = true;
			commandStart = index + 1;
			continue;
		}
		if (arg === "-t" || arg === "--verbose") {
			verbose = true;
			commandStart = index + 1;
			continue;
		}
		if (arg === "-r" || arg === "--no-run-if-empty") {
			// The app shell always keeps empty-input xargs as no-run for safety; accept
			// GNU's explicit no-run flag as a compatibility no-op.
			commandStart = index + 1;
			continue;
		}
		if (XARGS_COMBINED_BOOLEAN_FLAGS_REGEX.test(arg)) {
			// Only no-value flags can be safely bundled. Value-taking flags such
			// as -n2, -I{}, and -d, keep their dedicated parse paths above.
			for (const flag of arg.slice(1)) {
				if (flag === "0") nullSeparated = true;
				if (flag === "t") verbose = true;
			}
			commandStart = index + 1;
			continue;
		}
		if (arg.startsWith("-")) {
			return Result({ _nay: { message: `xargs: unsupported option ${arg}` } });
		}
		commandStart = index;
		break;
	}

	return Result({
		_yay: {
			replaceString,
			delimiter,
			maxArgs,
			nullSeparated,
			verbose,
			command: args.slice(commandStart),
		} as const,
	});
}

/**
 * Curated app-shell `xargs`.
 *
 * Supports the common serial forms agents use (`-n`/`--max-args`,
 * `-I`/`--replace`, `-d`/`--delimiter`, serial `-P 0|1`, `-0`, `-t`, and the
 * no-op safety flag `-r`) and executes each nested command through the same guarded shell
 * context, so app-file protections still apply.
 */
export function bash_xargs_command_create() {
	return defineCommand("xargs", async (args, commandCtx) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			const includeUsage = !("includeUsage" in parsed._nay) || parsed._nay.includeUsage !== false;
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\n${includeUsage ? XARGS_USAGE : ""}`,
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}
		if ("help" in parsed._yay) {
			return { stdout: XARGS_USAGE, stderr: "", exitCode: 0 };
		}

		const { replaceString, delimiter, maxArgs, nullSeparated, verbose } = parsed._yay;
		const command = parsed._yay.command.length === 0 ? ["echo"] : parsed._yay.command;

		// xargs parses stdin as text, so decode the byte-shaped shell stream before splitting records.
		const stdinText = decode_bash_stdin_as_utf8(commandCtx.stdin);
		let items: string[];
		if (nullSeparated) {
			items = stdinText.split("\0").filter(Boolean);
		} else if (delimiter != null) {
			items = stdinText.replace(XARGS_SINGLE_TRAILING_NEWLINE_REGEX, "").split(delimiter).filter(Boolean);
		} else if (replaceString != null) {
			// Replacement mode is line-oriented so filenames/items with spaces stay intact.
			items = stdinText.replace(XARGS_SINGLE_TRAILING_NEWLINE_REGEX, "").split("\n").filter(Boolean);
		} else {
			items = stdinText.split(bash_WHITESPACE_RUN_REGEX).filter(Boolean);
		}
		if (items.length === 0) {
			// Unlike POSIX xargs without -r, the app shell always treats empty input as
			// no-run. This avoids surprising commands that run only because a pipe was empty.
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		if (!commandCtx.exec) {
			return {
				stdout: "",
				stderr: "xargs: nested execution is unavailable\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		// Run nested commands serially through the current shell context so app-file guards still apply.
		const commandBatches: string[][] = [];
		if (replaceString != null) {
			for (const item of items) {
				commandBatches.push(command.map((part) => part.replaceAll(replaceString, item)));
			}
		} else if (maxArgs != null) {
			for (let index = 0; index < items.length; index += maxArgs) {
				commandBatches.push([...command, ...items.slice(index, index + maxArgs)]);
			}
		} else {
			commandBatches.push([...command, ...items]);
		}

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		for (const batch of commandBatches) {
			if (batch.length === 0) {
				continue;
			}
			if (verbose) {
				stderr += `${batch.map(bash_shell_arg_quote).join(" ")}\n`;
			}
			const result = await commandCtx.exec(bash_shell_arg_quote(batch[0]), {
				cwd: commandCtx.cwd,
				signal: commandCtx.signal,
				args: batch.slice(1),
			});
			stdout += result.stdout;
			stderr += result.stderr;
			if (result.exitCode !== 0) {
				exitCode = result.exitCode;
			}
		}
		return { stdout, stderr, exitCode };
	});
}
