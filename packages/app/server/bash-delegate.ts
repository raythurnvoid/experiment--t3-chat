// Delegation to the native just-bash engine. This module owns every just-bash VALUE import
// (`Bash`, `getCommandNames`); `bash-utils.ts` must keep its just-bash imports type-only so
// isolate-runtime Convex code (ai_chat.ts via server-ai-tools.ts) can import it - the just-bash
// browser bundle statically imports `node:zlib`, which the isolate bundler cannot resolve.

import {
	Bash,
	getCommandNames,
	type CommandContext,
	type CommandName,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from "just-bash/browser";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_DEV_NULL_PATH,
	bash_DEV_ZERO_BYTE_COUNT,
	bash_DEV_ZERO_PATH,
	bash_TMP_MOUNT,
	bash_current_workspace_path_to_db_files_path,
	bash_is_path_under_current_workspace_path,
	bash_normalize_path,
	bash_resolve_path,
	bash_shell_arg_quote,
} from "./bash-utils.ts";

const COMMAND_LOOKUP_PATH_REGEX = /^\/(?:usr\/)?bin\/([^/]+)$/u;
const DISABLED_NATIVE_JUST_BASH_COMMANDS = new Set<string>(["file"]);
export const bash_ALLOWED_COMMANDS = getCommandNames().filter(
	(command): command is CommandName => !DISABLED_NATIVE_JUST_BASH_COMMANDS.has(command),
);
const ALLOWED_COMMAND_NAMES = new Set<string>(bash_ALLOWED_COMMANDS);

// #region builtin command delegation

/**
 * Builds argv for delegating part of an app-aware command to the original built-in.
 *
 * App-file pagination options and original operands are removed. The caller
 * passes only the built-in operands that should remain, usually the original
 * operand text so delegated output keeps normal shell path formatting.
 */
export function bash_command_build_builtin_delegation_args(
	args: string[],
	builtinOperands: string[],
	options: {
		optionsWithValues: ReadonlySet<string>;
		pathsPosition: "beforeOptions" | "afterOptions";
	},
) {
	const builtinArgs: string[] = [];
	const shortOptionsWithValues = [...options.optionsWithValues].filter(
		(option) => option.startsWith("-") && !option.startsWith("--"),
	);
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			builtinArgs.push(arg);
			continue;
		}
		if (arg === "--limit" || arg === "--cursor") {
			index++;
			continue;
		}
		if (arg.startsWith("--limit=") || arg.startsWith("--cursor=")) {
			continue;
		}

		const equalsIndex = arg.indexOf("=");
		const optionName = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
		if (options.optionsWithValues.has(optionName)) {
			builtinArgs.push(arg);
			if (equalsIndex === -1 && index + 1 < args.length) {
				builtinArgs.push(args[index + 1]);
				index++;
			}
			continue;
		}

		if (
			arg.startsWith("-") &&
			!arg.startsWith("--") &&
			shortOptionsWithValues.some((option) => arg.startsWith(option) && arg.length > option.length)
		) {
			builtinArgs.push(arg);
			continue;
		}

		if (arg.startsWith("-") && arg !== "-") {
			builtinArgs.push(arg);
		}
	}

	if (options.pathsPosition === "beforeOptions") {
		return [...builtinOperands, ...builtinArgs];
	}
	return [...builtinArgs, ...builtinOperands];
}

/**
 * Run one Just Bash built-in command through an isolated Bash instance.
 *
 * Custom app-aware commands registered by the outer shell intentionally shadow
 * several built-ins. Calling `ctx.exec(...)` from those overrides would resolve
 * back to the override and recurse, so this helper creates a clean nested shell
 * whose command registry contains only the requested built-in command.
 *
 * Examples: app-aware `ls`, `find`, `tree`, `cat`, `stat`, `touch`, `rm`,
 * `cp`, `mv`, and `tee` call this after their app-path checks pass.
 */
export async function bash_delegate_builtin_command(args: {
	command: CommandName;
	args: string[];
	commandCtx: CommandContext;
	cwd?: string;
}) {
	// Custom commands shadow built-ins, so delegate through a clean nested Bash
	// instance instead of ctx.exec, which would recurse into the calling override.
	const env = Object.fromEntries(args.commandCtx.env);
	const cwd = args.cwd ?? args.commandCtx.cwd;
	const inner = new Bash({
		fs: args.commandCtx.fs,
		cwd,
		env,
		commands: [args.command],
		executionLimits: args.commandCtx.limits,
	});
	return await inner.exec([args.command, ...args.args.map(bash_shell_arg_quote)].join(" "), {
		cwd,
		stdin: args.commandCtx.stdin as unknown as string,
		stdinKind: "bytes",
		env: {
			...env,
			PWD: cwd,
		},
	});
}

// #endregion builtin command delegation

// #region native just bash tmp command

/**
 * Returns whether a path is in the direct-access surface for Native Just Bash
 * commands: `/`, `/dev`, `/dev/null`, `/dev/zero`, `/tmp`, or a descendant of `/tmp`.
 *
 * Synthetic command lookup paths are handled separately.
 */
function is_native_just_bash_tmp_path(path: string) {
	const normalizedPath = bash_normalize_path(path);
	return (
		normalizedPath === "/" ||
		normalizedPath === "/dev" ||
		normalizedPath === bash_DEV_NULL_PATH ||
		normalizedPath === bash_DEV_ZERO_PATH ||
		normalizedPath === bash_TMP_MOUNT ||
		normalizedPath.startsWith(`${bash_TMP_MOUNT}/`)
	);
}

/**
 * Returns whether a path is one of the synthetic command lookup directories
 * exposed to Native Just Bash: `/bin`, `/usr`, or `/usr/bin`.
 */
function is_native_just_bash_command_lookup_directory(path: string) {
	const normalizedPath = bash_normalize_path(path);
	return normalizedPath === "/bin" || normalizedPath === "/usr" || normalizedPath === "/usr/bin";
}

/**
 * Returns the allowed command name for synthetic executable paths such as
 * `/bin/sort` or `/usr/bin/sort`; returns `null` for non-command paths or
 * disabled Just Bash commands.
 */
function native_just_bash_command_lookup_name(path: string) {
	const normalizedPath = bash_normalize_path(path);
	const match = COMMAND_LOOKUP_PATH_REGEX.exec(normalizedPath);
	if (!match) {
		return null;
	}
	return ALLOWED_COMMAND_NAMES.has(match[1]) ? match[1] : null;
}

function native_just_bash_tmp_command_path_app_operand(
	args: string[],
	ctx: CommandContext,
	currentWorkspacePath: string,
) {
	for (const arg of args) {
		if (arg.startsWith("-")) {
			continue;
		}
		const resolvedPath = bash_resolve_path(ctx.cwd, arg);
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && bash_is_path_under_current_workspace_path(currentWorkspacePath, resolvedPath)) {
			return resolvedPath;
		}
	}
	return null;
}

function native_just_bash_tmp_command_rg_app_operand(args: string[], ctx: CommandContext, currentWorkspacePath: string) {
	let pattern: string | null = null;
	for (const arg of args) {
		if (arg.startsWith("-")) {
			continue;
		}
		if (pattern == null) {
			pattern = arg;
			continue;
		}
		const resolvedPath = bash_resolve_path(ctx.cwd, arg);
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && bash_is_path_under_current_workspace_path(currentWorkspacePath, resolvedPath)) {
			return { pattern, path: resolvedPath };
		}
	}
	return null;
}

function native_just_bash_tmp_command_app_hint_path(
	args: string[],
	ctx: CommandContext,
	currentWorkspacePath: string,
	stderr: string,
) {
	let hasExplicitScratchOperand = false;
	for (const arg of args) {
		if (arg.startsWith("-")) {
			continue;
		}
		const resolvedPath = bash_resolve_path(ctx.cwd, arg);
		if (is_native_just_bash_tmp_path(resolvedPath)) {
			hasExplicitScratchOperand = true;
			continue;
		}
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && bash_is_path_under_current_workspace_path(currentWorkspacePath, resolvedPath)) {
			return resolvedPath;
		}
	}
	if (stderr.includes(currentWorkspacePath)) {
		return currentWorkspacePath;
	}
	const hasStdin = ctx.stdin != null && String(ctx.stdin).length > 0;
	if (!hasStdin && !hasExplicitScratchOperand && bash_is_path_under_current_workspace_path(currentWorkspacePath, ctx.cwd)) {
		return ctx.cwd;
	}
	return null;
}

/**
 * Run a Native Just Bash command through the `/tmp`-restricted filesystem view.
 *
 * This is used for Just Bash built-ins that have not been made app-file-aware:
 * they can process `/tmp` paths and stdin, but cannot directly operate on
 * db-backed paths under `currentWorkspacePath`. It keeps direct operands away
 * from the app tree, permits `/tmp`, `/dev/null`, `/dev/zero`, and synthetic command lookup
 * paths, and adds app-file guidance when the command likely failed because it
 * tried to touch the mounted app file tree directly.
 *
 * Examples: `sort`, `uniq`, `cut`, `awk`, `sed`, `du`, `diff`, `rg`, `rev`,
 * `tac`, `nl`, `base64`, `jq`, and `sha256sum` run through this path.
 */
export async function bash_delegate_native_just_bash_tmp_command(
	command: CommandName,
	args: string[],
	ctx: CommandContext,
	currentWorkspacePath: string,
) {
	const env = Object.fromEntries(ctx.env);
	const cwd = is_native_just_bash_tmp_path(ctx.cwd) ? ctx.cwd : bash_TMP_MOUNT;
	const directRgOperand =
		command === "rg" ? native_just_bash_tmp_command_rg_app_operand(args, ctx, currentWorkspacePath) : null;

	// ln is pre-checked too: just-bash's catch-all sanitizer rewrites /home…|/tmp… substrings
	// to <path>, so a thrown NativeJustBashTmpCommandAccessError loses every concrete path by the time
	// the model sees it. Rejecting before the inner shell keeps the message intact.
	const directPathOperand =
		command === "du" || command === "diff" || command === "ln"
			? native_just_bash_tmp_command_path_app_operand(args, ctx, currentWorkspacePath)
			: null;
	const directAppOperand = directRgOperand?.path ?? directPathOperand;

	if (directAppOperand != null) {
		const appOperandError =
			new NativeJustBashTmpCommandAccessError(currentWorkspacePath, directAppOperand).message +
			(command === "du"
				? `du: app-mount paths do not expose POSIX disk usage. Try: stat ${bash_shell_arg_quote(directAppOperand)} && find ${bash_shell_arg_quote(directAppOperand)} -type f --limit 20\n`
				: "") +
			(directRgOperand != null
				? `rg: app paths do not support direct Native Just Bash rg. Try: grep ${bash_shell_arg_quote(directRgOperand.pattern)} ${bash_shell_arg_quote(directRgOperand.path)}\n`
				: "");
		return {
			stdout: "",
			stderr: appOperandError,
			exitCode: bash_COMMAND_EXIT_FAILURE,
			env: {
				...env,
				PWD: ctx.cwd,
			},
		};
	}

	const inner = new Bash({
		fs: new RestrictedNativeJustBashTmpCommandFs(ctx.fs, currentWorkspacePath, ctx.cwd),
		cwd,
		env,
		commands: [...bash_ALLOWED_COMMANDS],
		executionLimits: ctx.limits,
	});

	const result = await inner.exec([command, ...args.map(bash_shell_arg_quote)].join(" "), {
		cwd,
		stdin: ctx.stdin as unknown as string,
		stdinKind: "bytes",
		env: {
			...env,
			PWD: cwd,
		},
	});

	const guidancePath = native_just_bash_tmp_command_app_hint_path(args, ctx, currentWorkspacePath, result.stderr);
	if (result.exitCode !== 0 && guidancePath != null && !result.stderr.includes("db-backed")) {
		return {
			...result,
			stderr: `${result.stderr}${new NativeJustBashTmpCommandAccessError(currentWorkspacePath, guidancePath).message}`,
		};
	}
	return result;
}

/**
 * Means a Native Just Bash /tmp command tried to access the db-backed app file tree.
 */
class NativeJustBashTmpCommandAccessError extends Error {
	constructor(currentWorkspacePath: string, path: string) {
		const normalizedPath = bash_normalize_path(path);
		const dbFilesPath =
			bash_current_workspace_path_to_db_files_path(currentWorkspacePath, normalizedPath) ?? normalizedPath;
		super(
			`Native Just Bash /tmp commands cannot access app files directly: '${normalizedPath}'.\n` +
				`The app file tree at '${currentWorkspacePath}' is db-backed, so Native Just Bash /tmp commands can use /tmp paths or stdin but not direct app-file operands.\n` +
				`For app path '${dbFilesPath}', use app-aware commands such as search, find, grep, cat, head, tail, wc, stat, or tree. To process one readable app file with Native Just Bash /tmp tools, pipe it through cat or copy it first: cp ${bash_shell_arg_quote(normalizedPath)} /tmp/<name>\n`,
		);
		this.name = "NativeJustBashTmpCommandAccessError";
	}
}

/**
 * Restricted filesystem view for Native Just Bash /tmp commands.
 *
 * This is not the `/tmp` storage implementation; `BashTmpFs` owns that. This
 * wrapper sits in front of the full mounted shell filesystem for nested Native Just Bash
 * commands, allows `/tmp`, `/dev/null`, `/dev/zero`, and command lookup paths, and rejects
 * direct access to the db-backed app file tree with a targeted error.
 *
 * Synthetic paths are entries this wrapper reports even though they are not
 * persisted in the mounted filesystem: `/bin`, `/usr`, `/usr/bin`, executable
 * command-name files under `/bin` and `/usr/bin`, plus `/dev`, `/dev/null`, and `/dev/zero`.
 * They exist only to satisfy Just Bash command lookup and null-device behavior.
 */
class RestrictedNativeJustBashTmpCommandFs implements IFileSystem {
	constructor(
		private readonly fs: IFileSystem,
		private readonly currentWorkspacePath: string,
		private readonly commandCwd: string,
	) {}

	async readFile(path: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		return await this.fs.readFile(normalizedPath, options);
	}

	async readFileBuffer(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		return await this.fs.readFileBuffer(normalizedPath);
	}

	async writeFile(path: string, content: FileContent, options?: Parameters<IFileSystem["writeFile"]>[2]) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		await this.fs.writeFile(normalizedPath, content, options);
	}

	async appendFile(path: string, content: FileContent, options?: Parameters<IFileSystem["appendFile"]>[2]) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		await this.fs.appendFile(normalizedPath, content, options);
	}

	async exists(path: string) {
		const normalizedPath = bash_normalize_path(path);

		// Synthetic command lookup paths exist so Just Bash PATH resolution can probe them.
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return true;
		}

		// Native Just Bash commands are limited to synthetic lookup paths, /dev, and /tmp.
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			return false;
		}
		return normalizedPath === "/dev" || normalizedPath === bash_DEV_ZERO_PATH || (await this.fs.exists(normalizedPath));
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = bash_normalize_path(path);

		// Synthetic lookup folders must stat as directories so Just Bash can search PATH.
		if (is_native_just_bash_command_lookup_directory(normalizedPath)) {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: 0o755,
				size: 0,
				mtime: new Date(),
			};
		}

		// Synthetic lookup entries must stat as executable files so command resolution succeeds.
		if (native_just_bash_command_lookup_name(normalizedPath) != null) {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: 0o755,
				size: 0,
				mtime: new Date(),
			};
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}

		// /dev is synthetic; the mounted filesystem only owns device files and /tmp contents.
		if (normalizedPath === "/dev") {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: 0o755,
				size: 0,
				mtime: new Date(),
			};
		}
		if (normalizedPath === bash_DEV_ZERO_PATH) {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: 0o666,
				size: bash_DEV_ZERO_BYTE_COUNT,
				mtime: new Date(),
			};
		}
		return await this.fs.stat(normalizedPath);
	}

	async mkdir(path: string, options?: MkdirOptions) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		await this.fs.mkdir(normalizedPath, options);
	}

	async readdir(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (normalizedPath === "/usr") {
			return ["bin"];
		}
		if (normalizedPath === "/bin" || normalizedPath === "/usr/bin") {
			// Return only native Just Bash commands here. App-only custom commands
			// are available to the outer shell, but not as executable files inside
			// the restricted Native Just Bash /tmp view.
			return bash_ALLOWED_COMMANDS.toSorted();
		}
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		if (normalizedPath === "/") {
			return ["dev", "tmp"];
		}
		if (normalizedPath === "/dev") {
			return ["null", "zero"];
		}
		return await this.fs.readdir(normalizedPath);
	}

	async rm(path: string, options?: RmOptions) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		await this.fs.rm(normalizedPath, options);
	}

	async cp(src: string, dest: string, options?: CpOptions) {
		const normalizedSrc = bash_normalize_path(src);
		if (!is_native_just_bash_tmp_path(normalizedSrc)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedSrc);
		}

		const normalizedDest = bash_normalize_path(dest);
		if (!is_native_just_bash_tmp_path(normalizedDest)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedDest);
		}

		await this.fs.cp(normalizedSrc, normalizedDest, options);
	}

	async mv(src: string, dest: string) {
		const normalizedSrc = bash_normalize_path(src);
		if (!is_native_just_bash_tmp_path(normalizedSrc)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedSrc);
		}

		const normalizedDest = bash_normalize_path(dest);
		if (!is_native_just_bash_tmp_path(normalizedDest)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedDest);
		}

		await this.fs.mv(normalizedSrc, normalizedDest);
	}

	resolvePath(base: string, path: string) {
		if (path.startsWith("/")) {
			return bash_normalize_path(path);
		}
		// The nested shell may run from `/tmp`, but relative operands typed from
		// the app tree should still resolve against the outer command cwd so the
		// app-file guard rejects them instead of treating them as scratch paths.
		const basePath = is_native_just_bash_tmp_path(this.commandCwd) ? base : this.commandCwd;
		return bash_resolve_path(basePath, path);
	}

	getAllPaths() {
		const paths = new Set(["/", "/dev", bash_DEV_NULL_PATH, bash_DEV_ZERO_PATH, bash_TMP_MOUNT]);
		for (const path of this.fs.getAllPaths()) {
			const normalizedPath = bash_normalize_path(path);
			if (normalizedPath === bash_TMP_MOUNT || normalizedPath.startsWith(`${bash_TMP_MOUNT}/`)) {
				paths.add(normalizedPath);
			}
		}
		return [...paths].sort();
	}

	async chmod(path: string, mode: number) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		await this.fs.chmod(normalizedPath, mode);
	}

	async symlink(target: string, linkPath: string) {
		const normalizedLinkPath = bash_normalize_path(linkPath);
		if (!is_native_just_bash_tmp_path(normalizedLinkPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedLinkPath);
		}

		const resolvedTarget = target.startsWith("/")
			? bash_normalize_path(target)
			: bash_resolve_path(bash_normalize_path(`${normalizedLinkPath}/..`), target);
		if (!is_native_just_bash_tmp_path(resolvedTarget)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, resolvedTarget);
		}

		await this.fs.symlink(target, normalizedLinkPath);
	}

	async link(existingPath: string, newPath: string) {
		const normalizedExistingPath = bash_normalize_path(existingPath);
		if (!is_native_just_bash_tmp_path(normalizedExistingPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedExistingPath);
		}

		const normalizedNewPath = bash_normalize_path(newPath);
		if (!is_native_just_bash_tmp_path(normalizedNewPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedNewPath);
		}

		await this.fs.link(normalizedExistingPath, normalizedNewPath);
	}

	async readlink(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		return await this.fs.readlink(normalizedPath);
	}

	async lstat(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return await this.stat(normalizedPath);
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}

		if (normalizedPath === "/dev" || normalizedPath === bash_DEV_ZERO_PATH) {
			return await this.stat(normalizedPath);
		}

		return await this.fs.lstat(normalizedPath);
	}

	async realpath(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return normalizedPath;
		}
		if (normalizedPath === bash_DEV_ZERO_PATH) {
			return normalizedPath;
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}

		const realPath = await this.fs.realpath(normalizedPath);
		const normalizedRealPath = bash_normalize_path(realPath);
		if (!is_native_just_bash_tmp_path(normalizedRealPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedRealPath);
		}

		return normalizedRealPath;
	}

	async utimes(path: string, atime: Date, mtime: Date) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentWorkspacePath, normalizedPath);
		}
		await this.fs.utimes(normalizedPath, atime, mtime);
	}
}

// #endregion native just bash tmp command
