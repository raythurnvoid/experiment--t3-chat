import { defineCommand } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel";
import type {
	files_nodes_create_file_by_path_Result,
	files_nodes_get_by_path_Result,
	files_nodes_get_file_last_available_markdown_content_by_path_Result,
	files_nodes_remove_eager_created_node_if_safe_Result,
} from "../convex/files_nodes.ts";
import type { upsert_file_pending_update_internal_action_Result } from "../convex/files_pending_updates.ts";
import {
	files_SYNTHETIC_ROOT_FOLDER,
	files_get_normalized_node_path_segments,
	files_pending_path_overlay_translate_path,
} from "../shared/files.ts";
import { organizations_is_global_organization_id, organizations_is_reserved_workspace_id } from "../shared/organizations.ts";
import { path_name_of, should_never_happen } from "../shared/shared-utils.ts";
import { path_join } from "./server-utils.ts";
import { bash_DbFilesContentUnavailableError, bash_build_unreadable_file_advisory, bash_create_glob_syntax_unsupported_message, bash_current_workspace_path_to_db_files_path, bash_GLOB_METACHARACTER_REGEX, bash_is_path_under_current_workspace_path, bash_is_path_under_read_only_mounts, bash_normalize_path, bash_parse_cp_mv_operands, bash_resolve_path, bash_shell_arg_quote, bash_TMP_MOUNT, bash_read_only_mount_error, bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE, type bash_DbFilesRoots } from "./bash-utils.ts";
import { bash_delegate_builtin_command } from "./bash-delegate.ts";

/**
 * Check whether a normalized path is inside the per-command scratch mount.
 */
function is_under_tmp_mount(path: string) {
	return path === bash_TMP_MOUNT || path.startsWith(`${bash_TMP_MOUNT}/`);
}

/**
 * Allow the app-file `cp` shapes that are useful to agents:
 * copy one readable app file into `/tmp` scratch for Native Just Bash tools,
 * or (Agent mode only) propose an app→app copy as a pending update the user
 * reviews in Files.
 *
 * Everything else involving app paths is rejected before delegation so cp never
 * mutates the durable app tree or silently treats app destinations as scratch.
 */
export function bash_cp_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots) {
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	// Proposals target only the tenant app tree; the reserved mount scopes never back `app.fs`.
	// Narrow the ctxData union up front for the workspace-only functions below, which declare strict ids.
	const { organizationId, workspaceId, userId, threadId } = dbFilesRoots.app.fs.ctxData;
	if (organizations_is_global_organization_id(organizationId) || organizations_is_reserved_workspace_id(workspaceId)) {
		throw should_never_happen("cp command created for a reserved mount scope", { organizationId, workspaceId });
	}

	return defineCommand("cp", async (args, commandCtx) => {
		const { operands, recursive } = bash_parse_cp_mv_operands(args);

		// Mounts are read-only: reject any cp whose destination (the last operand) is under /.mounts
		// or /.plugins, before native delegation could write into the reserved mount tree. Copying a
		// mount file OUT to /tmp scratch stays allowed (the source may be a mount path).
		if (operands.length >= 2) {
			const destResolved = bash_resolve_path(commandCtx.cwd, operands[operands.length - 1]);
			if (bash_is_path_under_read_only_mounts(destResolved)) {
				return {
					stdout: "",
					stderr: bash_read_only_mount_error("cp", destResolved),
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			}
		}

		// Classify app operands up front so any app-path command is fully preflighted
		// before delegating to native cp, which could otherwise create /tmp side effects.
		const appOperands = operands.filter((operand) =>
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operand)),
		);

		// Pure scratch/non-app copies keep native Just Bash behavior.
		if (appOperands.length === 0) {
			return await bash_delegate_builtin_command({ command: "cp", args, commandCtx });
		}

		for (const operand of appOperands) {
			if (bash_GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: bash_create_glob_syntax_unsupported_message("cp", operand),
					exitCode: bash_COMMAND_EXIT_USAGE,
				};
			}
		}
		// App destinations: an app→app copy becomes a pending proposal in Agent mode; every
		// other write INTO the app tree stays rejected and routes to a shell redirect so
		// the model does not retry cp.
		if (
			operands.length === 2 &&
			bash_is_path_under_current_workspace_path(currentWorkspacePath, bash_resolve_path(commandCtx.cwd, operands[1]))
		) {
			const sourceShellPath = bash_resolve_path(commandCtx.cwd, operands[0]);
			const destShellPath = bash_resolve_path(commandCtx.cwd, operands[1]);
			const sourceDbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, sourceShellPath);
			if (sourceDbFilesPath != null && dbFilesRoots.app.fs.allowDbFilesMkdir) {
				if (recursive) {
					return {
						stdout: "",
						stderr: "cp: app folder copy is not supported; copy individual files\n",
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				// Resolutions run through the calling user's pending path overlay: their earlier
				// pending moves are already visible, so sources read through pending moves work.
				const sourceNode = (await ctx.runQuery(internal.files_nodes.get_by_path, {
					organizationId,
					workspaceId,
					path: sourceDbFilesPath,
					overlayUserId: userId,
				})) as files_nodes_get_by_path_Result;
				if (!sourceNode) {
					return {
						stdout: "",
						stderr: `cp: cannot stat '${operands[0]}': No such file or directory\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				if (sourceNode.kind === "folder") {
					return {
						stdout: "",
						stderr: "cp: app folder copy is not supported; copy individual files\n",
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				const rawDestDbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, destShellPath);
				if (rawDestDbFilesPath == null) {
					throw should_never_happen("cp: app destination path missing inside the app destination branch", {
						operands,
						destShellPath,
					});
				}
				const destNode: files_nodes_get_by_path_Result | typeof files_SYNTHETIC_ROOT_FOLDER =
					rawDestDbFilesPath === "/"
						? files_SYNTHETIC_ROOT_FOLDER
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								organizationId,
								workspaceId,
								path: rawDestDbFilesPath,
								overlayUserId: userId,
							})) as files_nodes_get_by_path_Result);
				let destPath: string;
				// Where create_file_by_path writes when nothing occupies the destination. It differs
				// from destPath only for a moved destination folder: the committed join keeps the
				// eager node under the moved folder, so it travels with it on accept.
				let creationDestPath: string;
				if (destNode && destNode.kind === "folder") {
					// An existing folder destination keeps the source's visible basename inside it,
					// like native cp (a moved source's committed name may differ). Occupants and
					// stdout use the REQUESTED visible join: a moved destination folder's committed
					// path reads as vacated and would miss the visible occupant.
					destPath = path_join(rawDestDbFilesPath, path_name_of(sourceDbFilesPath));
					creationDestPath = path_join(destNode.path, path_name_of(sourceDbFilesPath));
				} else if (destNode) {
					// Existing file destination: like native cp, the copy replaces its content — as a
					// pending proposal the user reviews before anything is committed. Keep the requested
					// path for display: the overlay can present a moved node here (identical without one).
					destPath = rawDestDbFilesPath;
					creationDestPath = destPath;
				} else {
					// Missing parent folders are fine; create_file_by_path creates them below.
					const normalizedDestSegments = files_get_normalized_node_path_segments({
						kind: "file",
						nameOrPath: rawDestDbFilesPath,
					});
					if (!normalizedDestSegments || "validationMessage" in normalizedDestSegments) {
						return {
							stdout: "",
							stderr: `cp: invalid destination '${rawDestDbFilesPath}'${
								normalizedDestSegments ? `: ${normalizedDestSegments.validationMessage}` : ""
							}\n`,
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}
					destPath = `/${normalizedDestSegments.normalizedPathSegments.join("/")}`;
					// Implicit parent creation must not build committed folders under a visible file
					// ancestor (committed, or a pending file move's claim); real cp fails with ENOTDIR.
					const nearestAncestor = await dbFilesRoots.app.fs.getNearestVisibleAncestor(destPath);
					if (nearestAncestor?.kind === "file") {
						return {
							stdout: "",
							stderr: `cp: cannot create regular file '${destPath}': Not a directory\n`,
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}
					// A missing dest inside a moved folder's claimed area creates at the COMMITTED
					// join (like write_file), so the eager node travels with the folder on accept.
					// "hidden" keeps the requested path; the vacated guard below handles it.
					const overlay = await dbFilesRoots.app.fs.getOverlay();
					const translated = overlay == null ? null : files_pending_path_overlay_translate_path(overlay, destPath);
					creationDestPath = translated?.kind === "redirected" ? translated.committedPath : destPath;
				}
				// Resolve the final (joined/normalized) path: an existing file there becomes the
				// replace target instead of an eagerly-created node.
				const occupant =
					destNode && destNode.kind !== "folder"
						? destNode
						: ((await ctx.runQuery(internal.files_nodes.get_by_path, {
								organizationId,
								workspaceId,
								path: destPath,
								overlayUserId: userId,
							})) as files_nodes_get_by_path_Result);
				if (occupant && occupant._id === sourceNode._id) {
					return {
						stdout: "",
						stderr: `cp: '${operands[0]}' and '${operands[1]}' are the same file\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				if (occupant && occupant.kind === "folder") {
					return {
						stdout: "",
						stderr: `cp: cannot overwrite directory '${destPath}' with non-directory\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				// Copy what the agent sees: the last available markdown, including the calling
				// user's own pending overlay on the source file.
				const sourceContent = (await ctx.runAction(
					internal.files_nodes.get_file_last_available_markdown_content_by_path,
					{
						organizationId,
						workspaceId,
						userId,
						path: sourceDbFilesPath,
						overlayUserId: userId,
					},
				)) as files_nodes_get_file_last_available_markdown_content_by_path_Result;
				if (!sourceContent) {
					return {
						stdout: "",
						stderr: bash_build_unreadable_file_advisory(currentWorkspacePath, sourceDbFilesPath, sourceNode.contentType),
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				let destNodeId: Id<"files_nodes">;
				let replacesExisting: boolean;
				let eagerCreatedCommittedSequence: number | undefined;
				let createdAncestorIds: Id<"files_nodes">[] | undefined;
				if (occupant) {
					destNodeId = occupant._id;
					replacesExisting = true;
				} else {
					// The overlay can present this path as free while a committed node is still there
					// mid-move (vacated source or replaced path). Creating here would reuse that
					// committed node and silently turn the copy into a content replacement on it. A fresh
					// name under a moved folder also translates hidden but has no committed occupant
					// there, so it may proceed.
					const overlay = await dbFilesRoots.app.fs.getOverlay();
					if (
						overlay != null &&
						files_pending_path_overlay_translate_path(overlay, creationDestPath).kind === "hidden"
					) {
						const committedOccupant = (await ctx.runQuery(internal.files_nodes.get_by_path, {
							organizationId,
							workspaceId,
							path: creationDestPath,
						})) as files_nodes_get_by_path_Result;
						if (committedOccupant) {
							return {
								stdout: "",
								stderr: `cp: cannot create '${creationDestPath}': the path is vacated by your pending move. Accept or discard that proposal first, or choose a different destination path.\n`,
								exitCode: bash_COMMAND_EXIT_FAILURE,
							};
						}
					}
					const created = (await ctx.runAction(internal.files_nodes.create_file_by_path, {
						organizationId,
						workspaceId,
						userId,
						path: creationDestPath,
					})) as files_nodes_create_file_by_path_Result;
					if (created._nay) {
						return {
							stdout: "",
							stderr: `cp: cannot create '${destPath}': ${created._nay.message}\n`,
							exitCode: bash_COMMAND_EXIT_FAILURE,
						};
					}
					destNodeId = created._yay.nodeId;
					// A raced creation reuses the pre-existing node: degrade to a content replacement so
					// discard/expiry can never hard-delete a node this command did not create. The
					// stamp is the creation-time sequence captured by create_file_by_path, so a save
					// landing before the upsert below keeps the node safe from hard deletes.
					replacesExisting = !created._yay.created;
					if (created._yay.created) {
						eagerCreatedCommittedSequence = created._yay.createdCommittedSequence;
						createdAncestorIds = created._yay.createdAncestorIds;
					}
				}
				// A failed upsert after the eager create would leave the just-created empty node behind.
				// Best-effort compensation: remove it while it is still provably untouched; a
				// cleanup failure must never mask the original upsert error.
				const eager_created_failure_note = async () => {
					if (eagerCreatedCommittedSequence === undefined) {
						return "";
					}
					try {
						const removal = (await ctx.runMutation(internal.files_nodes.remove_eager_created_node_if_safe, {
							organizationId,
							workspaceId,
							userId,
							nodeId: destNodeId,
							eagerCreatedCommittedSequence,
							createdAncestorIds,
						})) as files_nodes_remove_eager_created_node_if_safe_Result;
						if (removal._yay?.removed) {
							return removal._yay.ancestorsLeft > 0
								? ` — empty folders created for '${destPath}' were left behind; remove them in Files if they are not wanted`
								: ` — nothing was created at '${destPath}'`;
						}
					} catch (cleanupError) {
						console.error("cp failed to remove the eagerly created node after a failed upsert", cleanupError);
					}
					return ` — an empty file was left behind at '${destPath}'; remove it in Files if it is not wanted`;
				};
				let upserted: upsert_file_pending_update_internal_action_Result;
				try {
					upserted = (await ctx.runAction(
						internal.files_pending_updates.upsert_file_pending_update_internal_action,
						{
							organizationId,
							workspaceId,
							userId,
							nodeId: destNodeId,
							unstagedMarkdown: sourceContent.content,
							copiedFrom: { nodeId: sourceNode._id, path: sourceDbFilesPath },
							eagerCreatedCommittedSequence,
							// Recorded on the pending update doc so Discard/TTL expiry can also remove the
							// parent folders this cp eagerly created.
							eagerCreatedAncestorIds: createdAncestorIds,
							threadId: threadId ?? undefined,
						},
					)) as upsert_file_pending_update_internal_action_Result;
				} catch (error) {
					if (eagerCreatedCommittedSequence === undefined) {
						throw error;
					}
					const message = error instanceof Error ? error.message : String(error);
					return {
						stdout: "",
						stderr: `cp: cannot copy '${operands[0]}': ${message}${await eager_created_failure_note()}\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				if (upserted._nay) {
					return {
						stdout: "",
						stderr: `cp: cannot copy '${operands[0]}': ${upserted._nay.message}${await eager_created_failure_note()}\n`,
						exitCode: bash_COMMAND_EXIT_FAILURE,
					};
				}
				// Later commands chained in this same bash call must see the new proposal.
				dbFilesRoots.app.fs.resetProposalCaches();
				return {
					stdout: replacesExisting
						? `pending copy created: ${sourceDbFilesPath} -> ${destPath} — replaces the existing file's content when accepted; review in Files\n`
						: `pending copy created: ${sourceDbFilesPath} -> ${destPath} — review in Files\n`,
					stderr: "",
					exitCode: 0,
				};
			}
			let destDbFilesPath =
				bash_current_workspace_path_to_db_files_path(currentWorkspacePath, destShellPath) ?? operands[1];
			let redirectDestShellPath = destShellPath;
			try {
				const destStat = await commandCtx.fs.stat(destShellPath);
				if (destStat.isDirectory) {
					const nativeDirectoryDestPath = bash_normalize_path(`${destShellPath}/${path_name_of(sourceShellPath)}`);
					destDbFilesPath =
						bash_current_workspace_path_to_db_files_path(currentWorkspacePath, nativeDirectoryDestPath) ?? destDbFilesPath;
					redirectDestShellPath = nativeDirectoryDestPath;
				}
			} catch {
				// Missing destinations are normal; the rejected write target is the operand itself.
			}
			// Agent mode only reaches here with a non-app source (app→app already proposed above);
			// Ask mode reaches here for every app destination.
			// `cat` on a folder source would create the destination proposal first and then fail,
			// so the redirect recovery is only suggested for a file source.
			let sourceIsFile = false;
			try {
				sourceIsFile = (await commandCtx.fs.stat(sourceShellPath)).isFile;
			} catch {
				// A missing source keeps the generic guidance.
			}
			return {
				stdout: "",
				stderr: dbFilesRoots.app.fs.allowDbFilesMkdir
					? `cp: cannot write to app file '${operands[1]}': only app files can be copied within the app tree.\n` +
						(sourceIsFile
							? `To propose that content at '${destDbFilesPath}', redirect instead: cat ${bash_shell_arg_quote(operands[0])} > ${bash_shell_arg_quote(redirectDestShellPath)} — it creates a pending proposal the user reviews in Files.\n`
							: "")
					: `cp: cannot write to app file '${operands[1]}' in Ask mode.\n` +
						"App file writes are available in Agent mode; Ask mode is read-only for app files.\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		}
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
