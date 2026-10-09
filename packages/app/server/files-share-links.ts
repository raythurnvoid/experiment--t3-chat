import type { Doc } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";

/**
 * A moved link expires at publication, before its physical row is removed.
 */
export async function files_share_links_db_is_selected(db: QueryCtx["db"], link: Doc<"files_share_links">) {
	if (!link.moveView) return true;
	const cohort = await db.get("files_move_cohorts", link.moveView.cohortId);
	return (
		cohort !== null &&
		cohort.organizationId === link.organizationId &&
		cohort.workspaceId === link.workspaceId &&
		cohort.visibleView === link.moveView.view
	);
}
