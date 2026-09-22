import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import type { RegisteredQuery } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalQuery } from "./_generated/server.js";
import { v_result } from "../server/convex-utils.ts";
import { ai_chat_skills_LIMITS } from "../server/ai-chat-skills.ts";
import type { files_visible_internal_list_Result } from "./files_visible.ts";
import { ai_chat_workspaces_db_resolve } from "./ai_chat_workspaces.ts";
import { ai_chat_workspaces_source_validator } from "./schema.ts";

export const ai_chat_context_ENABLED = process.env.AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED === "true";

// 20 pages of 50 items is 1000 files. That is the most this query reads before it
// reports the catalog as incomplete.
const MAX_CATALOG_PAGES = 20;
const SKILL_PATH_REGEX = /^\/\.agents\/skills\/[^/]+\/SKILL\.md$/u;

export const discover_sources = internalQuery({
	args: { source: ai_chat_workspaces_source_validator },
	returns: v_result({
		_yay: v.object({
			workspaces: v.array(
				v.object({
					workspace: v.union(v.literal("current"), v.literal("personal")),
					organizationId: v.id("organizations"),
					workspaceId: v.id("organizations_workspaces"),
					organizationName: v.string(),
					workspaceName: v.string(),
				}),
			),
			skills: v.array(
				v.object({
					workspace: v.union(v.literal("current"), v.literal("personal")),
					path: v.string(),
				}),
			),
			warning: v.optional(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		if (!ai_chat_context_ENABLED)
			return Result({ _nay: { name: "unavailable", message: "Workspace guidance is unavailable." } });
		const workspaces: {
			workspace: "current" | "personal";
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			organizationName: string;
			workspaceName: string;
		}[] = [];
		for (const workspace of ["current", "personal"] as const) {
			const resolved = await ai_chat_workspaces_db_resolve(ctx, { source: args.source, workspace });
			if (resolved._nay)
				return Result({ _nay: { name: "unavailable", message: "Workspace guidance is unavailable." } });
			const { organizationId, workspaceId, organizationName, workspaceName } = resolved._yay;
			if (!workspaces.some((root) => root.workspaceId === workspaceId))
				workspaces.push({ workspace, organizationId, workspaceId, organizationName, workspaceName });
		}
		const skills: { workspace: "current" | "personal"; path: string }[] = [];
		const scans = workspaces.map((root) => ({ root, cursor: null as string | null, complete: false }));
		// Alternate roots within one page budget, so a large current catalog cannot hide home.
		for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
			const unfinished = scans.filter((scan) => !scan.complete);
			if (!unfinished.length) break;
			const scan = unfinished[page % unfinished.length];
			const { organizationId, workspaceId, workspace } = scan.root;
			// Read through the user's own pending moves. A pending rename can turn an ordinary file
			// into SKILL.md, and a folder move can bring skills into the catalog from elsewhere.
			const listed = (await ctx.runQuery(internal.files_visible.internal_list, {
				agentSource: args.source,
				organizationId,
				workspaceId,
				visibilityUserId: args.source.userId,
				overlayUserId: args.source.userId,
				folderPath: "/.agents/skills",
				mode: "subtree",
				minDepth: 2,
				maxDepth: 2,
				kind: "file",
				numItems: 50,
				cursor: scan.cursor,
			})) as files_visible_internal_list_Result;
			// A page that fails leaves the catalog incomplete. Stop here and return the skills found
			// so far with the warning below, instead of failing the whole chat.
			if (listed._nay) {
				break;
			}
			for (const item of listed._yay.items) {
				// A private file whose content is not sealed yet cannot be used as a skill.
				if (!item.preparing && SKILL_PATH_REGEX.test(item.path)) skills.push({ workspace, path: item.path });
			}
			scan.complete = listed._yay.isDone;
			if (skills.length > ai_chat_skills_LIMITS.discovered) break;
			scan.cursor = listed._yay.continueCursor;
		}
		skills.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.path.localeCompare(b.path));
		return Result({
			_yay: {
				workspaces,
				skills: skills.slice(0, ai_chat_skills_LIMITS.discovered),
				...(scans.some((scan) => !scan.complete) || skills.length > ai_chat_skills_LIMITS.discovered
					? {
							warning: "The skill catalog is incomplete. Use Bash to inspect each workspace's .agents/skills folder.",
						}
					: {}),
			},
		});
	},
});

export type ai_chat_context_discover_sources_Result =
	typeof discover_sources extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
