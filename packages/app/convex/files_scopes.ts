import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { organizations_is_reserved_workspace_id } from "../shared/organizations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Literal checks alone cannot tell a workspace id from a volume id.
export function files_db_resolve_scope(ctx: QueryCtx | MutationCtx, workspaceId: Doc<"files_nodes">["workspaceId"]) {
	if (organizations_is_reserved_workspace_id(workspaceId)) {
		return { kind: "reserved" as const, workspaceId };
	}
	const realWorkspaceId = ctx.db.normalizeId("organizations_workspaces", workspaceId);

	if (realWorkspaceId) {
		return { kind: "workspace" as const, workspaceId: realWorkspaceId };
	}
	const volumeId = ctx.db.normalizeId("plugins_volumes", workspaceId);

	if (volumeId) {
		return { kind: "volume" as const, volumeId };
	}
	throw should_never_happen("Invalid file storage scope", { workspaceId });
}
