import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import type { RegisteredQuery } from "convex/server";
import type { Id } from "./_generated/dataModel.js";
import { internalQuery } from "./_generated/server.js";
import { v_result } from "../server/convex-utils.ts";
import { files_pending_overlay_list_over_budget } from "../server/files-pending-overlay.ts";
import { files_visible_is_preparing } from "./files_visible.ts";
import { files_visible_db_create_reader } from "./files_visible_db.ts";
import { ai_chat_workspaces_db_resolve } from "./ai_chat_workspaces.ts";
import { ai_chat_workspaces_source_validator, files_pending_target_validator } from "./schema.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";

export const ai_chat_context_ENABLED = process.env.AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED === "true";

const workspace_validator = v.union(v.literal("current"), v.literal("personal"));

/**
 * Resolve the chat's guidance roots and its plugin skills. The skills catalog in the roots is listed by
 * the chat action, page by page (`ai_chat_context_discover_sources`).
 */
export const resolve_sources = internalQuery({
	args: { source: ai_chat_workspaces_source_validator },
	returns: v_result({
		_yay: v.object({
			workspaces: v.array(
				v.object({
					workspace: workspace_validator,
					organizationId: v.id("organizations"),
					workspaceId: v.id("organizations_workspaces"),
					organizationName: v.string(),
					workspaceName: v.string(),
				}),
			),
			pluginSkills: v.array(
				v.object({ pluginName: v.string(), name: v.string(), description: v.string(), path: v.string() }),
			),
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

		// Plugin skills come only from enabled installations in the current workspace, so they never
		// reach the home workspace. The Bash mount `/.plugins/<pluginName>` follows the same rule, and
		// so does its guest rule: a member without workspace read gets no plugins.
		const current = workspaces.find((root) => root.workspace === "current")!;
		const membership = await organizations_db_get_membership(ctx, args.source);
		const authorized =
			membership &&
			(await access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.source.userId },
				membership,
				permission: "content.read",
			}));
		const installations = !authorized?._yay
			? []
			: await ctx.db
					.query("plugins_workspace_installations")
					.withIndex("by_organization_workspace_status_pluginName", (q) =>
						q
							.eq("organizationId", current.organizationId)
							.eq("workspaceId", current.workspaceId)
							.eq("status", "enabled"),
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
				pluginSkills,
			},
		});
	},
});

export type ai_chat_context_resolve_sources_Result =
	typeof resolve_sources extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Find the readable `SKILL.md` in each skill folder of one catalog page. Each folder costs one exact
 * path read (about 6 index ranges), so one page of 50 folders stays far below the read budget.
 */
export const find_skill_files = internalQuery({
	args: {
		source: ai_chat_workspaces_source_validator,
		workspace: workspace_validator,
		folders: v.array(v.object({ target: files_pending_target_validator, path: v.string() })),
	},
	returns: v_result({ _yay: v.object({ paths: v.array(v.string()), complete: v.boolean() }) }),
	handler: async (ctx, args) => {
		if (!ai_chat_context_ENABLED)
			return Result({ _nay: { name: "unavailable", message: "Workspace guidance is unavailable." } });
		// Resolve again: the chat action lists each page in its own transaction, so the membership may
		// have changed since `resolve_sources`.
		const resolved = await ai_chat_workspaces_db_resolve(ctx, { source: args.source, workspace: args.workspace });
		if (resolved._nay) return Result({ _nay: { name: "unavailable", message: "Workspace guidance is unavailable." } });
		const { organizationId, workspaceId } = resolved._yay;

		// One reader for the page keeps the shared folder reads cached.
		const reader = await files_visible_db_create_reader(ctx, {
			organizationId,
			workspaceId,
			userId: args.source.userId,
			readLimit: 2_000,
		});
		const paths: string[] = [];
		for (const folder of args.folders) {
			if (files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics()))
				return Result({ _yay: { paths, complete: false } });
			const found = await reader.findChild(folder.target, `${folder.path}/SKILL.md`);
			if (!found || found.entry.node.kind !== "file" || !(await reader.canRead(found.accessNode))) continue;
			// A private file whose content is not sealed yet cannot be used as a skill.
			if (found.entry.kind === "private" && files_visible_is_preparing(found.entry.pendingUpdate)) continue;
			paths.push(found.entry.path);
		}
		return Result({ _yay: { paths, complete: !reader.exhausted } });
	},
});
