import type { Doc } from "../convex/_generated/dataModel";

// #region data deletion requests
/**
 * Retention after queue: purge uses each document’s Convex `_creationTime` (via the built-in `by_creation_time` index).
 * `scope` records origin only (see `workspaces_data_deletion_requests.scope` in Convex schema).
 */
export type user_DataDeletionRequestScope = NonNullable<
	Doc<"workspaces_data_deletion_requests">["scope"]
>;

export const user_DATA_DELETION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// #endregion data deletion requests
