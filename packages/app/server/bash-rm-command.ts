import { defineCommand, type Command } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { upsert_file_pending_archive_in_db_Result } from "../convex/files_pending_updates.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	bash_create_glob_syntax_unsupported_message,
	bash_GLOB_METACHARACTER_REGEX,
	bash_resolve_db_files_shell_path,
	bash_is_path_under_read_only_mounts,
	bash_resolve_path,
	bash_read_only_mount_error,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

/**
 * Extract `rm` operands and flags for app-path routing.
 *
 * Mirrors the builtin's accepted flags (-r/-R/--recursive, -f/--force, -v/--verbose,
 * short clusters, `--`). Any other option marks the parse unknown so the whole
 * command delegates to the builtin, whose parser errors before touching the fs.
 */
function parse_rm_operands(args: string[]) {
	const operands: string[] = [];
	let recursive = false;
	let force = false;
	let verbose = false;
	let unknownOption = false;
	let optionsEnded = false;

	for (const arg of args) {
		if (optionsEnded) {
			operands.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		// The builtin's parseArgs also accepts `--flag=value` for boolean flags and ignores the
		// value, so `--force=false` still means force; delegating those forms instead would let
		// the builtin swallow the app EROFS error under force and exit 0 with no proposal.
		if (arg === "-r" || arg === "-R" || arg === "--recursive" || arg.startsWith("--recursive=")) {
			recursive = true;
			continue;
		}
		if (arg === "-f" || arg === "--force" || arg.startsWith("--force=")) {
			force = true;
			continue;
		}
		if (arg === "-v" || arg === "--verbose" || arg.startsWith("--verbose=")) {
			verbose = true;
			continue;
		}
		if (arg.startsWith("-")) {
			if (arg.startsWith("--")) {
				unknownOption = true;
				continue;
			}
			const flags = [...arg.slice(1)];
			if (flags.some((flag) => flag !== "r" && flag !== "R" && flag !== "f" && flag !== "v")) {
				unknownOption = true;
				continue;
			}
			recursive ||= flags.some((flag) => flag === "r" || flag === "R");
			force ||= flags.includes("f");
			verbose ||= flags.includes("v");
			continue;
		}
		operands.push(arg);
	}
	return { operands, recursive, force, verbose, unknownOption };
}

/**
 * Propose app-file deletes as pending updates for shell `rm`.
 *
 * `/tmp` removals still delegate to the built-in. In Agent mode an app `rm`
 * records a pending delete the user reviews in Files; accepting archives the
 * node (a folder with its whole subtree). `rm` on the user's own unaccepted
 * Added file cancels it immediately, like Discard. Ask mode keeps rejections.
 */
// The explicit `Command` return type breaks a type-inference cycle: the handler's inferred
// type would otherwise flow through internal.* into the bash action and back into this command.
export function bash_rm_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots): Command {
	return defineCommand("rm", async (args, commandCtx) => {
		const { operands, recursive, force, verbose, unknownOption } = parse_rm_operands(args);

		// Unknown options: the builtin's parser errors before touching the fs, so app paths are safe.
		if (unknownOption) {
			return await bash_delegate_builtin_command({ command: "rm", args, commandCtx });
		}

		// Mounts are read-only: reject any operand under /.mounts or /.plugins before
		// native delegation.
		const mountOperand = operands.find((operand) =>
			bash_is_path_under_read_only_mounts(bash_resolve_path(commandCtx.cwd, operand)),
		);
		if (mountOperand != null) {
			return {
				stdout: "",
				stderr: bash_read_only_mount_error("rm", bash_resolve_path(commandCtx.cwd, mountOperand)),
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		const appOperands = operands.filter(
			(operand) =>
				bash_resolve_db_files_shell_path(bash_resolve_path(commandCtx.cwd, operand), dbFilesRoots).kind === "app",
		);
		if (appOperands.length === 0) {
			return await bash_delegate_builtin_command({ command: "rm", args, commandCtx });
		}

		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("rm", operand),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}

		// Ask mode keeps the read-only rejection; only Agent mode may create pending proposals.
		const firstAppOperand = appOperands[0];
		const firstTarget = bash_resolve_db_files_shell_path(
			bash_resolve_path(commandCtx.cwd, firstAppOperand),
			dbFilesRoots,
		);
		if (!firstTarget.fs.allowDbFilesMkdir) {
			return {
				stdout: "",
				stderr:
					`rm: cannot delete app file '${firstAppOperand}' through bash.\n` +
					`App file deletes are available in Agent mode; Ask mode is read-only for app files. Use the Files sidebar Archive action for path '${firstTarget.dbFilesPath}'.\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		// Builtin semantics: operands run in their original order and failures continue
		// with exit 1, so a mixed /tmp + app command keeps its output order.
		const delegatedFlagTokens = [...(recursive ? ["-r"] : []), ...(force ? ["-f"] : []), ...(verbose ? ["-v"] : [])];
		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		for (const operand of operands) {
			const resolvedPath = bash_resolve_path(commandCtx.cwd, operand);
			const target = bash_resolve_db_files_shell_path(resolvedPath, dbFilesRoots);
			if (target.kind !== "app") {
				const delegated = await bash_delegate_builtin_command({
					command: "rm",
					args: [...delegatedFlagTokens, "--", operand],
					commandCtx,
				});
				stdout += delegated.stdout;
				stderr += delegated.stderr;
				if (delegated.exitCode !== 0) {
					exitCode = bash_COMMAND_EXIT_FAILURE;
				}
				continue;
			}

			const dbFilesPath = target.dbFilesPath;
			if (dbFilesPath == null) {
				throw should_never_happen("rm: app operand lost its app path", { operand, resolvedPath });
			}
			if (dbFilesPath === "/") {
				stderr += `rm: cannot remove '${operand}': Operation not permitted\n`;
				exitCode = bash_COMMAND_EXIT_FAILURE;
				continue;
			}

			// Resolution runs through the calling user's pending path overlay: an already
			// pending-deleted path reads as missing, like a real fs after rm.
			const node = await target.fs.getEntry(dbFilesPath);
			if (!node?.target || node.target.kind === "root") {
				if (!force) {
					stderr += `rm: cannot remove '${operand}': No such file or directory\n`;
					exitCode = bash_COMMAND_EXIT_FAILURE;
				}
				continue;
			}
			if (node.kind === "folder" && !recursive) {
				stderr += `rm: cannot remove '${operand}': Is a directory\n`;
				exitCode = bash_COMMAND_EXIT_FAILURE;
				continue;
			}

			const { organizationId, workspaceId, userId, threadId, agentSource } = target.ctxData;
			if (
				organizations_is_global_organization_id(organizationId) ||
				organizations_is_reserved_workspace_id(workspaceId) ||
				!agentSource
			) {
				throw should_never_happen("rm reached a scope without agent write access", { organizationId, workspaceId });
			}
			const proposed = (await ctx.runMutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
				organizationId,
				workspaceId,
				userId,
				target: node.target,
				threadId: threadId ?? undefined,
				agentSource,
			})) as upsert_file_pending_archive_in_db_Result;
			if (proposed._nay) {
				// The node can be archived between the path lookup above and the mutation; -f
				// suppresses that race like any other missing path.
				if (force && proposed._nay.message === "Not found") {
					continue;
				}
				stderr += `rm: cannot remove '${operand}': ${proposed._nay.message.toLowerCase()}\n`;
				exitCode = bash_COMMAND_EXIT_FAILURE;
				continue;
			}
			// Later commands chained in this same bash call must see the path as gone.
			target.fs.resetProposalCaches();
			if (proposed._yay.outcome === "cancelled_added_file") {
				// The user's own unaccepted new file: really removed, nothing pends. Always
				// printed (not only with -v) so the agent knows no proposal was created.
				stdout += `removed '${operand}'\n`;
			} else {
				stdout +=
					proposed._yay.nodeKind === "folder"
						? `pending delete created: ${dbFilesPath} — archives the folder and its contents when accepted; review in Files\n`
						: `pending delete created: ${dbFilesPath} — archives the file when accepted; review in Files\n`;
			}
		}

		return { stdout, stderr, exitCode };
	});
}
