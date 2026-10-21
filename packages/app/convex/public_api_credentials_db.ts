// Small reads about API keys for the background jobs that a key starts. Keep this module free of
// `public_api.ts`, so the job engines that import it keep small import graphs.

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server.js";

/**
 * Say whether the personal API key that started a job may still act for it: not revoked, the same
 * person and workspace, and still holding every scope the job needs. Rotate revokes the old key, so a
 * job started by the old key stops too.
 */
export async function public_api_credentials_db_is_live(
	ctx: QueryCtx,
	args: {
		credentialId: Id<"api_credentials">;
		userId: Id<"users">;
		workspaceId: Id<"organizations_workspaces">;
		scopes: Doc<"api_credentials">["scopes"];
	},
) {
	const credential = await ctx.db.get("api_credentials", args.credentialId);
	return (
		!!credential &&
		credential.revokedAt === null &&
		credential.userId === args.userId &&
		credential.serviceAccountId === null &&
		credential.workspaceId === args.workspaceId &&
		args.scopes.every((scope) => credential.scopes.includes(scope))
	);
}
