import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalQuery } from "./_generated/server.js";
import { v_result } from "../server/convex-utils.ts";
import { ai_chat_skills_LIMITS } from "../server/ai-chat-skills.ts";
import type { files_visible_internal_list_Result } from "./files_visible.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";

export const ai_chat_context_ENABLED = process.env.AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED === "true";

// 20 pages of 50 items is 1000 files. That is the most this query reads before it
// reports the catalog as incomplete.
const MAX_CATALOG_PAGES = 20;
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
		const skills: string[] = [];
		let cursor: string | null = null;
		let complete = false;
		for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
			// Read through the user's own pending moves. A pending rename can turn an ordinary file
			// into SKILL.md, and a folder move can bring skills into the catalog from elsewhere.
			const listed = (await ctx.runQuery(internal.files_visible.internal_list, {
				organizationId,
				workspaceId,
				visibilityUserId: userId,
				overlayUserId: userId,
				folderPath: "/.agents/skills",
				mode: "subtree",
				minDepth: 2,
				maxDepth: 2,
				kind: "file",
				numItems: 50,
				cursor,
			})) as files_visible_internal_list_Result;
			// A page that fails leaves the catalog incomplete. Stop here and return the skills found
			// so far with the warning below, instead of failing the whole chat.
			if (listed._nay) {
				break;
			}
			for (const item of listed._yay.items) {
				// A private file whose content is not sealed yet cannot be used as a skill.
				if (!item.preparing && SKILL_PATH_REGEX.test(item.path)) skills.push(item.path);
			}
			if (listed._yay.isDone) {
				complete = true;
				break;
			}
			if (skills.length > ai_chat_skills_LIMITS.discovered) break;
			cursor = listed._yay.continueCursor;
		}
		skills.sort();
		return Result({
			_yay: {
				organizationId,
				workspaceId,
				skills: skills.slice(0, ai_chat_skills_LIMITS.discovered),
				...(!complete || skills.length > ai_chat_skills_LIMITS.discovered
					? {
							warning: "The skill catalog is incomplete. Use Bash to inspect /.agents/skills for more skills.",
						}
					: {}),
			},
		});
	},
});
