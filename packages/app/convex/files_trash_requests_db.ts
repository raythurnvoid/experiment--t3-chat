// Small reads of Trash requests. The Pending list loads this module, so keep it free of the queue and
// file engine code in files_trash_requests.ts.

import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

export async function files_trash_requests_db_get_summary(args: {
	ctx: QueryCtx;
	membership: Doc<"organizations_workspaces_users">;
	listKey: string;
}) {
	const { ctx, membership } = args;
	const summary = await ctx.db
		.query("files_trash_request_summaries")
		.withIndex("by_org_ws_user_listKey", (q) =>
			q
				.eq("organizationId", membership.organizationId)
				.eq("workspaceId", membership.workspaceId)
				.eq("userId", membership.userId)
				.eq("listKey", args.listKey),
		)
		.first();
	return { count: summary?.count ?? 0 };
}
