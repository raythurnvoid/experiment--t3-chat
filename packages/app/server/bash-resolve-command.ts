import { defineCommand, type Command } from "just-bash/browser";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_db_files_path_to_current_workspace_path,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

const RESOLVE_USAGE = "Usage: resolve [--] NODE_ID_OR_APP_FILE_URL\n";
const RESOLVE_UNAVAILABLE_MESSAGE = "File or folder is unavailable in this chat's workspaces";
const RESOLVE_FILE_URL_PATH_REGEX = /^\/w\/([^/]+)\/([^/]+)\/files(?:\/(.*))?$/u;

function parse_args(args: string[]) {
	if (args.length === 1 && args[0] === "--help") {
		return Result({ _yay: { help: true } as const });
	}

	const operands = args[0] === "--" ? args.slice(1) : args;
	if (operands.length !== 1 || (args[0] !== "--" && operands[0].startsWith("-"))) {
		return Result({
			_nay: { message: "Expected one node ID or app file URL", data: { exitCode: bash_COMMAND_EXIT_USAGE } },
		});
	}
	const reference = operands[0];
	if (!reference.includes(":") && !reference.includes("/")) {
		return Result({ _yay: { nodeId: reference } });
	}

	try {
		// Copied links may use another app host. Workspace and node access checks still apply.
		const url = new URL(reference);
		const match = RESOLVE_FILE_URL_PATH_REGEX.exec(url.pathname);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !match) {
			return Result({ _nay: { message: "Expected an app file URL", data: { exitCode: bash_COMMAND_EXIT_USAGE } } });
		}
		const workspace = { organizationName: decodeURIComponent(match[1]), workspaceName: decodeURIComponent(match[2]) };

		const nodeIds = [...url.searchParams.getAll("nodeId"), ...url.searchParams.getAll("pendingNodeId")];
		if (nodeIds.length > 0) {
			if (nodeIds.length !== 1 || !nodeIds[0]) {
				return Result({
					_nay: {
						message: "Expected one nonempty nodeId or pendingNodeId",
						data: { exitCode: bash_COMMAND_EXIT_USAGE },
					},
				});
			}
			return Result({ _yay: { nodeId: nodeIds[0], workspace } });
		}

		const path = `/${path_extract_segments_from(decodeURIComponent(match[3] ?? "")).join("/")}`;
		if (path === "/") {
			return Result({
				_nay: {
					message: "The URL needs a nodeId, pendingNodeId, or file path",
					data: { exitCode: bash_COMMAND_EXIT_USAGE },
				},
			});
		}
		return Result({ _yay: { path, workspace } });
	} catch {
		return Result({ _nay: { message: "Invalid app file URL", data: { exitCode: bash_COMMAND_EXIT_USAGE } } });
	}
}

/**
 * Resolve a node reference to its current path without reading its content.
 * The Command return type breaks the generated API's type-inference cycle.
 */
export function bash_resolve_command_create(ctx: ActionCtx, dbFilesRoots: bash_DbFilesRoots): Command {
	return defineCommand("resolve", async (args) => {
		const parsed = parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `resolve: ${parsed._nay.message}\n${parsed._nay.data.exitCode === bash_COMMAND_EXIT_USAGE ? RESOLVE_USAGE : ""}`,
				exitCode: parsed._nay.data.exitCode,
			};
		}
		if ("help" in parsed._yay) {
			return { stdout: RESOLVE_USAGE, stderr: "", exitCode: 0 };
		}

		// IDs are unique across workspaces. URLs select one root before any lookup.
		for (const root of [dbFilesRoots.app, dbFilesRoots.personal]) {
			if (!root) continue;
			const { fs, currentWorkspacePath } = root;
			const { organizationId, workspaceId, userId } = fs.ctxData;
			// The shared shell also runs plugin reviews, which have no tenant file scope.
			if (
				fs.readOnlySource != null ||
				organizations_is_global_organization_id(organizationId) ||
				organizations_is_reserved_workspace_id(workspaceId)
			)
				continue;
			if (
				"workspace" in parsed._yay &&
				parsed._yay.workspace &&
				(parsed._yay.workspace.organizationName !== fs.ctxData.organizationName ||
					parsed._yay.workspace.workspaceName !== fs.ctxData.workspaceName)
			)
				continue;

			let nodeId: string | undefined;
			if ("nodeId" in parsed._yay) {
				nodeId = parsed._yay.nodeId;
			} else {
				// A path URL identifies the saved node, even if pending moves swap its path.
				const node = await ctx.runQuery(internal.files_nodes.get_by_path, {
					agentSource: fs.ctxData.agentSource,
					organizationId,
					workspaceId,
					visibilityUserId: userId,
					path: parsed._yay.path,
				});
				nodeId = node?._id;
			}
			const path =
				nodeId == null
					? null
					: await ctx.runQuery(internal.files_nodes.get_path_by_id, {
							agentSource: fs.ctxData.agentSource,
							organizationId,
							workspaceId,
							visibilityUserId: userId,
							nodeId,
						});
			if (path == null) continue;

			fs.observePath(path);
			return {
				stdout: `${bash_db_files_path_to_current_workspace_path(currentWorkspacePath, path)}\n`,
				stderr: "",
				exitCode: 0,
			};
		}
		return { stdout: "", stderr: `resolve: ${RESOLVE_UNAVAILABLE_MESSAGE}\n`, exitCode: bash_COMMAND_EXIT_FAILURE };
	});
}
