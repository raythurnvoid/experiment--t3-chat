import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel";
import type { files_nodes_get_by_path_Result } from "../convex/files_nodes.ts";
import type { upsert_file_pending_move_in_db_Result } from "../convex/files_pending_updates.ts";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, files_get_normalized_node_path_segments } from "../shared/files.ts";
import { organizations_is_global_organization_id, organizations_is_reserved_workspace_id } from "../shared/organizations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { path_join } from "./server-utils.ts";
import { bash_create_glob_syntax_unsupported_message, bash_current_workspace_path_to_db_files_path, bash_db_files_path_to_current_workspace_path, bash_GLOB_METACHARACTER_REGEX, bash_is_path_under_current_workspace_path, bash_is_path_under_read_only_mounts, bash_parse_cp_mv_operands, bash_resolve_path, bash_shell_arg_quote, bash_read_only_mount_error, bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

/**
 * Propose app-file moves as pending updates for shell `mv`.
 *
 * `/tmp` moves still delegate to the built-in. In Agent mode an app→app `mv`
 * records a pending move the user reviews in Files; the committed tree stays
 * untouched until they accept. Mixed app/tmp forms and Ask mode keep rejections
 * so a command cannot leave partial scratch side effects while pretending to
 * mutate the durable app tree.
 */
export function bash_mv_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	// Proposals target only the tenant app tree; the reserved mount scopes never back `app.fs`.
	// Narrow the ctxData union up front for the workspace-only functions below, which declare strict ids.
	const { organizationId, workspaceId, userId } = dbFilesRoots.app.fs.ctxData;
	if (organizations_is_global_organization_id(organizationId) || organizations_is_reserved_workspace_id(workspaceId)) {
		throw should_never_happen("mv command created for a reserved mount scope", { organizationId, workspaceId });
	}

	return defineCommand("mv", async (args, commandCtx) => {
		const { operands } = bash_parse_cp_mv_operands(args);

		// Mounts are read-only: mv would delete a mount source or write a mount destination, so reject
		// any operand under /.mounts or /.plugins before native delegation. (cp <mount> /tmp covers
		// read-out copies.)
		const mountOperand = operands.find((operand) =>
			bash_is_path_under_read_only_mounts(bash_resolve_path(commandCtx.cwd, operand)),
		);
		if (mountOperand != null) {
			return {
				stdout: "",
				stderr: bash_read_only_mount_error("mv", bash_resolve_path(commandCtx.cwd, mountOperand)),
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		const appOperands = operands.filter((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);

		if (appOperands.length === 0) {
			return await bash_delegate_builtin_command({ command: "mv", args, commandCtx });
		}

		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("mv", operand),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}

		const destOperand = operands.length >= 2 ? operands.at(-1) : undefined;
		const sourceOperands = operands.length >= 2 ? operands.slice(0, -1) : operands;
		const sourceAppPathOperand = sourceOperands.find((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);
		const destDbFilesPath =
			destOperand == null
				? null
				: bash_current_workspace_path_to_db_files_path(
						currentWorkspacePath,
						bash_resolve_path(commandCtx.cwd, destOperand),
					);

		// App source with a non-app (or missing) destination: moving app files out of the app tree
		// stays unsupported; point at cp for scratch copies.
		if (destOperand == null || destDbFilesPath == null) {
			if (sourceAppPathOperand == null) {
				throw should_never_happen("mv: app source path missing for non-app destination", {
					operands,
					appOperands,
					sourceOperands,
				});
			}
			return {
				stdout: "",
				stderr:
					`mv: cannot move or rename app file '${sourceAppPathOperand}' to a non-app destination.\n` +
					`To copy readable content into scratch for processing, use cp ${bash_shell_arg_quote(sourceAppPathOperand)} /tmp/<name>.\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		// Non-app sources into the app tree stay rejected; only app→app moves become proposals.
		const nonAppSourceOperand = sourceOperands.find(
			(operand) =>
				!bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);
		if (nonAppSourceOperand != null) {
			return {
				stdout: "",
				stderr:
					`mv: cannot write to app file '${destOperand}': only app files can be moved within the app tree.\n` +
					`To create or replace durable content at '${destDbFilesPath}', use write_file with path '${destDbFilesPath}' and the content read from the source.\n` +
					"Moving /tmp files into the app tree through bash is not supported.\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		const sourceOperand = sourceOperands[0];
		const sourceDbFilesPath = bash_current_workspace_path_to_db_files_path(
			currentWorkspacePath,
			bash_resolve_path(commandCtx.cwd, sourceOperand),
		);
		if (sourceDbFilesPath == null) {
			throw should_never_happen("mv: app source path missing after destination branches", {
				operands,
				appOperands,
				sourceOperands,
			});
		}

		// Ask mode keeps the read-only rejection; only Agent mode may create pending proposals.
		if (!dbFilesRoots.app.fs.allowDbFilesMkdir) {
			return {
				stdout: "",
				stderr:
					"mv: cannot move or rename app files through bash.\n" +
					`Use the Files sidebar rename/move UI for app path '${sourceDbFilesPath}' -> '${destDbFilesPath}'. For content changes, use edit_file on '${sourceDbFilesPath}' or write_file with path '${destDbFilesPath}'.\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		if (operands.length > 2) {
			return {
				stdout: "",
				stderr:
					"mv: app moves support exactly one source and one destination.\n" +
					"Usage: mv <app-path> <app-path> — creates a pending move the user reviews in Files.\n",
				exitCode: bash_COMMAND_EXIT_USAGE,
			};
		}

		const sourceNode = (await ctx.runQuery(internal.files_nodes.get_by_path, {
			organizationId,
			workspaceId,
			path: sourceDbFilesPath,
		})) as files_nodes_get_by_path_Result;
		if (!sourceNode) {
			return {
				stdout: "",
				stderr: `mv: cannot stat '${sourceOperand}': No such file or directory\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		const destNode: files_nodes_get_by_path_Result | typeof files_SYNTHETIC_ROOT_FOLDER =
			destDbFilesPath === "/"
				? files_SYNTHETIC_ROOT_FOLDER
				: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
						organizationId,
						workspaceId,
						path: destDbFilesPath,
					})) as files_nodes_get_by_path_Result);

		let destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		let destName: string;
		let intendedDestPath: string;
		if (destNode) {
			if (destNode._id === sourceNode._id) {
				return {
					stdout: "",
					stderr: `mv: '${sourceOperand}' and '${destOperand}' are the same file\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			if (destNode.kind !== "folder") {
				return {
					stdout: "",
					stderr: `mv: destination '${destDbFilesPath}' already exists; overwrite is not supported. Choose a different destination path.\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			// An existing folder destination keeps the source name inside it, like native mv.
			destParentId = destNode._id;
			destName = sourceNode.name;
			intendedDestPath = path_join(destNode.path, destName);
			const occupant = (await ctx.runQuery(internal.files_nodes.get_by_path, {
				organizationId,
				workspaceId,
				path: intendedDestPath,
			})) as files_nodes_get_by_path_Result;
			if (occupant) {
				if (occupant._id === sourceNode._id) {
					return {
						stdout: "",
						stderr: `mv: '${sourceOperand}' and '${destOperand}' are the same file\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				return {
					stdout: "",
					stderr: `mv: destination '${intendedDestPath}' already exists; overwrite is not supported. Choose a different destination path.\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
		} else {
			// Missing destination: the last segment is the new name; the parent folder must already exist.
			const lastSlashIndex = destDbFilesPath.lastIndexOf("/");
			const destParentPath = lastSlashIndex <= 0 ? "/" : destDbFilesPath.slice(0, lastSlashIndex);
			const rawDestName = destDbFilesPath.slice(lastSlashIndex + 1);
			if (destParentPath === "/") {
				destParentId = files_ROOT_ID;
			} else {
				const destParent = (await ctx.runQuery(internal.files_nodes.get_by_path, {
					organizationId,
					workspaceId,
					path: destParentPath,
				})) as files_nodes_get_by_path_Result;
				if (!destParent || destParent.kind !== "folder") {
					return {
						stdout: "",
						stderr: `mv: destination folder '${destParentPath}' does not exist. Create it first with mkdir ${bash_shell_arg_quote(bash_db_files_path_to_current_workspace_path(currentWorkspacePath, destParentPath))}.\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				destParentId = destParent._id;
			}
			const normalizedDestName = files_get_normalized_node_path_segments({
				kind: sourceNode.kind,
				nameOrPath: rawDestName,
			});
			if (!normalizedDestName || "validationMessage" in normalizedDestName) {
				return {
					stdout: "",
					stderr: `mv: invalid destination name '${rawDestName}'${
						normalizedDestName ? `: ${normalizedDestName.validationMessage}` : ""
					}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			// The raw name has no path separators, so normalization yields exactly one segment.
			destName = normalizedDestName.normalizedPathSegments.join("/");
			intendedDestPath = path_join(destParentPath, destName);
		}

		const proposed = (await ctx.runMutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId,
			workspaceId,
			userId,
			nodeId: sourceNode._id,
			destParentId,
			destName,
		})) as upsert_file_pending_move_in_db_Result;
		if (proposed._nay) {
			const message = proposed._nay.message;
			return {
				stdout: "",
				stderr:
					message === "Path already exists"
						? `mv: destination '${intendedDestPath}' already exists; overwrite is not supported. Choose a different destination path.\n`
						: message === "Cannot move a folder into itself"
							? `mv: cannot move '${sourceOperand}' to a subdirectory of itself\n`
							: message === "Source and destination are the same"
								? `mv: '${sourceOperand}' and '${destOperand}' are the same file\n`
								: `mv: ${message.toLowerCase()}\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		return {
			stdout: `pending move created: ${proposed._yay.fromPath} -> ${proposed._yay.destPath} — review in Files\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}
