import { Result } from "common/errors-as-values-utils.ts";
import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { files_db_resolve_scope } from "./files_scopes.ts";
import type { ai_chat_workspaces_source_validator } from "./schema.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";

export async function files_db_authorize_volume_read(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		volumeId: Id<"plugins_volumes">;
		readerUserId: Id<"users">;
		agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
	},
) {
	const volume = await ctx.db.get("plugins_volumes", args.volumeId);
	if (!volume || volume.organizationId !== args.organizationId || volume.deleteRequestedAt !== null)
		return Result({ _nay: { message: "Volume unavailable" } });
	const installation = await ctx.db.get("plugins_workspace_installations", volume.installationId);
	const source = args.agentSource;
	if (
		!installation ||
		installation.status !== "enabled" ||
		installation.organizationId !== volume.organizationId ||
		installation.workspaceId !== volume.workspaceId ||
		!source ||
		source.userId !== args.readerUserId ||
		source.organizationId !== volume.organizationId ||
		source.workspaceId !== volume.workspaceId
	)
		return Result({ _nay: { message: "Volume unavailable" } });
	// Use the saved chat membership and lifetime. A rejoin cannot revive an old call.
	const allowed = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
		agentSource: source,
		organizationId: volume.organizationId,
		workspaceId: volume.workspaceId,
		userId: args.readerUserId,
	});
	if (allowed._nay) return Result({ _nay: { message: "Volume unavailable" } });
	return Result({ _yay: null });
}

export async function files_db_authorize_file_read(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
	},
) {
	const scope = files_db_resolve_scope(ctx, args.workspaceId);
	if (scope.kind === "volume") {
		if (organizations_is_global_organization_id(args.organizationId))
			return Result({ _nay: { message: "Volume unavailable" } });
		return await files_db_authorize_volume_read(ctx, {
			organizationId: args.organizationId,
			volumeId: scope.volumeId,
			readerUserId: args.userId,
			agentSource: args.agentSource,
		});
	}
	if (args.agentSource)
		return await ai_chat_workspaces_db_authorize_file_scope(ctx, { ...args, agentSource: args.agentSource });
	return Result({ _yay: null });
}
