import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel";
import type {
	files_nodes_get_by_path_Result,
	files_nodes_get_file_last_available_markdown_content_by_path_Result,
} from "../convex/files_nodes.ts";
import type {
	upsert_file_pending_move_in_db_Result,
	upsert_file_pending_update_internal_action_Result,
} from "../convex/files_pending_updates.ts";
import {
	files_ROOT_ID,
	files_SYNTHETIC_ROOT_FOLDER,
	files_get_normalized_node_path_segments,
	files_node_has_editable_yjs_state,
} from "../shared/files.ts";
import { organizations_is_global_organization_id, organizations_is_reserved_workspace_id } from "../shared/organizations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { path_join } from "./server-utils.ts";
import { bash_create_glob_syntax_unsupported_message, bash_current_workspace_path_to_db_files_path, bash_db_files_path_to_current_workspace_path, bash_GLOB_METACHARACTER_REGEX, bash_is_path_under_current_workspace_path, bash_is_path_under_read_only_mounts, bash_parse_cp_mv_operands, bash_resolve_path, bash_shell_arg_quote, bash_read_only_mount_error, bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

/**
 * Occupied-destination error. Suggest `-f` only when a file-onto-file replace could work.
 */
function create_dest_exists_error(destPath: string, canReplace: boolean, force: boolean) {
	if (canReplace && !force) {
		return `mv: destination '${destPath}' already exists. To propose replacing the existing file, add -f: the replacement only applies after the user accepts it in Files.\n`;
	}
	return `mv: destination '${destPath}' already exists; only a file can replace an existing file with mv -f. Choose a different destination path.\n`;
}

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
		const { operands, force } = bash_parse_cp_mv_operands(args);

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
		// The active file that `mv -f` would replace at the destination, when there is one.
		let replaceTargetNode: NonNullable<files_nodes_get_by_path_Result> | null = null;
		if (destNode) {
			if (destNode._id === sourceNode._id) {
				return {
					stdout: "",
					stderr: `mv: '${sourceOperand}' and '${destOperand}' are the same file\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
			if (destNode.kind !== "folder") {
				// `mv -f` file-onto-file proposes a replace; folders can never replace or be replaced.
				if (!force || sourceNode.kind !== "file") {
					return {
						stdout: "",
						stderr: create_dest_exists_error(destDbFilesPath, sourceNode.kind === "file", force),
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				destParentId = destNode.parentId;
				destName = destNode.name;
				intendedDestPath = destNode.path;
				replaceTargetNode = destNode;
			} else {
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
					if (!force || sourceNode.kind !== "file" || occupant.kind !== "file") {
						return {
							stdout: "",
							stderr: create_dest_exists_error(
								intendedDestPath,
								sourceNode.kind === "file" && occupant.kind === "file",
								force,
							),
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}
					replaceTargetNode = occupant;
				}
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

		// `mv -f` between editable files proposes a copy on the TARGET plus `archivesSourceOnAccept`:
		// the target keeps its identity and history, and accepting saves the replacement as a new
		// version and archives the source. Non-editable files (no history to keep) stay structural.
		if (
			replaceTargetNode &&
			files_node_has_editable_yjs_state(sourceNode) &&
			files_node_has_editable_yjs_state(replaceTargetNode)
		) {
			// Copy what the agent sees: the last available markdown, including the calling user's
			// own pending overlay on the source file.
			const sourceContent = (await ctx.runAction(
				internal.files_nodes.get_file_last_available_markdown_content_by_path,
				{
					organizationId,
					workspaceId,
					userId,
					path: sourceDbFilesPath,
				},
			)) as files_nodes_get_file_last_available_markdown_content_by_path_Result;
			if (sourceContent) {
				const upserted = (await ctx.runAction(
					internal.files_pending_updates.upsert_file_pending_update_internal_action,
					{
						organizationId,
						workspaceId,
						userId,
						nodeId: replaceTargetNode._id,
						unstagedMarkdown: sourceContent.content,
						copiedFrom: { nodeId: sourceNode._id, path: sourceDbFilesPath, archivesSourceOnAccept: true },
					},
				)) as upsert_file_pending_update_internal_action_Result;
				if (upserted._nay) {
					return {
						stdout: "",
						stderr: `mv: cannot replace '${destOperand}': ${upserted._nay.message}\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				return {
					stdout: `pending replace created: ${sourceDbFilesPath} -> ${intendedDestPath} — replaces the file's content and archives the source when accepted; review in Files\n`,
					stderr: "",
					exitCode: 0,
				};
			}
			// Unreadable source content: fall through to the structural replace, which still moves the file.
		}

		const proposed = (await ctx.runMutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId,
			workspaceId,
			userId,
			nodeId: sourceNode._id,
			destParentId,
			destName,
			replace: force,
		})) as upsert_file_pending_move_in_db_Result;
		if (proposed._nay) {
			const message = proposed._nay.message;
			return {
				stdout: "",
				stderr:
					message === "Path already exists"
						? create_dest_exists_error(intendedDestPath, sourceNode.kind === "file", force)
						: message === "Cannot move a folder into itself"
							? `mv: cannot move '${sourceOperand}' to a subdirectory of itself\n`
							: message === "Source and destination are the same"
								? `mv: '${sourceOperand}' and '${destOperand}' are the same file\n`
								: `mv: ${message.toLowerCase()}\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}

		return {
			stdout: proposed._yay.replacesExistingFile
				? `pending move created: ${proposed._yay.fromPath} -> ${proposed._yay.destPath} — replaces the existing file when accepted; review in Files\n`
				: `pending move created: ${proposed._yay.fromPath} -> ${proposed._yay.destPath} — review in Files\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}
