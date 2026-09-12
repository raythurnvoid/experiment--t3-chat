import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server.js";
import { v_result } from "../server/convex-utils.ts";
import { files_db_get_pending_path_overlay_data } from "../server/files.ts";
import { ai_chat_skills_LIMITS } from "../server/ai-chat-skills.ts";
import {
	files_pending_path_overlay_build,
	files_pending_path_overlay_project_committed_path,
} from "../shared/files.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";

export const ai_chat_context_ENABLED = process.env.AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED === "true";

const MAX_SCANNED_NODES = 1000;
const SKILL_PATH_REGEX = /^\/\.agents\/skills\/[^/]+\/SKILL\.md$/u;

export const discover_sources = internalQuery({
	args: { membershipId: v.id("organizations_workspaces_users"), userId: v.id("users") },
	returns: v_result({
		_yay: v.object({
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			skills: v.array(v.string()),
			warning: v.optional(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const membership = ai_chat_context_ENABLED ? await organizations_db_get_membership(ctx, args) : null;
		if (!membership) return Result({ _nay: { name: "unavailable", message: "Workspace guidance is unavailable." } });
		const allowed = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: "content.read",
		});
		if (allowed._nay) return Result({ _nay: { name: "unavailable", message: "Workspace guidance is unavailable." } });

		const { organizationId, workspaceId, userId } = membership;
		const [nodes, pendingUpdates] = await Promise.all([
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation_name", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("archiveOperationId", null)
						.eq("name", "SKILL.md"),
				)
				.take(MAX_SCANNED_NODES + 1),
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("userId", userId),
				)
				.take(MAX_SCANNED_NODES + 1),
		]);
		if (nodes.length > MAX_SCANNED_NODES || pendingUpdates.length > MAX_SCANNED_NODES) {
			return Result({
				_yay: {
					organizationId,
					workspaceId,
					skills: [],
					warning:
						"The skill catalog is incomplete: too many file or pending paths to inspect. Use Bash to inspect /.agents/skills.",
				},
			});
		}

		// The check above bounds the ordinary overlay loader in this same query snapshot.
		const overlayData = await files_db_get_pending_path_overlay_data(ctx, { organizationId, workspaceId, userId });
		const overlay = files_pending_path_overlay_build({
			pendingUpdates: overlayData.pendingUpdates,
			nodesById: new Map(overlayData.referencedNodes.map((node) => [node._id, node])),
		});
		// A pending rename may turn an ordinary file into SKILL.md. Folder moves project
		// all named candidates, including skills moved into the catalog from elsewhere.
		const candidates = new Map([...nodes, ...overlayData.referencedNodes].map((node) => [node._id, node]));
		const paths = new Map(
			[...candidates.values()].flatMap((node) => {
				const path =
					node.kind === "file" ? files_pending_path_overlay_project_committed_path(overlay, node.path) : null;
				return path && SKILL_PATH_REGEX.test(path) ? [[node._id, path] as const] : [];
			}),
		);

		const readable = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId,
			workspaceId,
			userId,
			nodes: [...candidates.values()].filter((node) => paths.has(node._id)),
		});
		const skills = readable.map((node) => paths.get(node._id)!).sort();
		return Result({
			_yay: {
				organizationId,
				workspaceId,
				skills: skills.slice(0, ai_chat_skills_LIMITS.discovered),
				...(skills.length > ai_chat_skills_LIMITS.discovered
					? {
							warning:
								"The skill catalog is incomplete: only the first 100 skills are listed. Use Bash to inspect /.agents/skills.",
						}
					: {}),
			},
		});
	},
});
