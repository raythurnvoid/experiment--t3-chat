import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import type { RegisteredQuery } from "convex/server";
import type { Id } from "./_generated/dataModel.js";
import { internalQuery } from "./_generated/server.js";
import { v_result } from "../server/convex-utils.ts";
import { ai_chat_skills_LIMITS } from "../server/ai-chat-skills.ts";
import { files_pending_overlay_list, files_pending_overlay_list_over_budget } from "../server/files-pending-overlay.ts";
import { files_visible_db_create_reader, files_visible_is_preparing } from "./files_visible.ts";
import { ai_chat_workspaces_db_resolve } from "./ai_chat_workspaces.ts";
import { ai_chat_workspaces_source_validator } from "./schema.ts";

export const ai_chat_context_ENABLED = process.env.AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED === "true";

// 4 pages of 50 skill folders is 200 folders, twice the catalog limit. Each folder costs one exact
// path read of its SKILL.md (about 6 index ranges), so this is the most this query reads before it
// reports the catalog as incomplete.
const MAX_CATALOG_PAGES = 4;
const CATALOG_PAGE_SIZE = 50;

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
			pluginSkills: v.array(
				v.object({ pluginName: v.string(), name: v.string(), description: v.string(), path: v.string() }),
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
		const scans = workspaces.map((root) => ({
			root,
			cursor: null as string | null,
			complete: false,
			reader: null as Awaited<ReturnType<typeof files_visible_db_create_reader>> | null,
		}));
		// Alternate roots within one page budget, so a large current catalog cannot hide home.
		// The listing reads share this query's transaction, so the catalog also stops on their read
		// budget and reports itself incomplete.
		const overBudget = async () => files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics());
		for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
			const unfinished = scans.filter((scan) => !scan.complete);
			if (!unfinished.length || (await overBudget())) break;
			const scan = unfinished[page % unfinished.length];
			const { organizationId, workspaceId, workspace } = scan.root;
			// Read through the user's own drafts. A pending rename can turn an ordinary file into
			// SKILL.md, and a folder move can bring skills into the catalog from elsewhere.
			const listed = await files_pending_overlay_list(ctx, {
				agentSource: args.source,
				organizationId,
				workspaceId,
				visibilityUserId: args.source.userId,
				overlayUserId: args.source.userId,
				folderPath: "/.agents/skills",
				mode: "children",
				kind: "folder",
				order: "asc",
				numItems: CATALOG_PAGE_SIZE,
				cursor: scan.cursor,
			});
			// A page that fails leaves the catalog incomplete. Stop here and return the skills found
			// so far with the warning below, instead of failing the whole chat.
			if (listed._nay) {
				break;
			}
			// One exact path read per skill folder. One reader per workspace keeps the folder reads cached.
			const reader = (scan.reader ??= await files_visible_db_create_reader(ctx, {
				organizationId,
				workspaceId,
				userId: args.source.userId,
				readLimit: 2_000,
			}));
			let stopped = false;
			for (const item of listed._yay.items) {
				if (await overBudget()) {
					stopped = true;
					break;
				}
				const found = await reader.findChild(item.target, `${item.path}/SKILL.md`);
				if (!found || found.entry.node.kind !== "file" || !(await reader.canRead(found.accessNode))) continue;
				// A private file whose content is not sealed yet cannot be used as a skill.
				if (found.entry.kind === "private" && files_visible_is_preparing(found.entry.pendingUpdate)) continue;
				skills.push({ workspace, path: found.entry.path });
			}
			if (stopped || reader.exhausted) break;
			scan.complete = listed._yay.isDone;
			if (skills.length > ai_chat_skills_LIMITS.discovered) break;
			scan.cursor = listed._yay.continueCursor;
		}
		skills.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.path.localeCompare(b.path));

		// Plugin skills come only from enabled installations in the current workspace, so they never
		// reach the home workspace. The Bash mount `/.plugins/<pluginName>` follows the same rule.
		const current = workspaces.find((root) => root.workspace === "current")!;
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q.eq("organizationId", current.organizationId).eq("workspaceId", current.workspaceId).eq("status", "enabled"),
			)
			.collect();
		const pluginSkills: { pluginName: string; name: string; description: string; path: string }[] = [];
		for (const installation of installations) {
			if (!installation.acceptedCapabilities.includes("agent.skills.contribute")) continue;
			const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
			for (const skill of version.skills) {
				pluginSkills.push({ pluginName: installation.pluginName, ...skill });
			}
		}

		return Result({
			_yay: {
				workspaces,
				skills: skills.slice(0, ai_chat_skills_LIMITS.discovered),
				pluginSkills,
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
