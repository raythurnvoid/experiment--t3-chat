// Small reads about API keys for the background jobs that a key starts. Keep this module free of
// `public_api.ts`, so the job engines that import it keep small import graphs.

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server.js";
import { files_nodes_user_write_context, type files_nodes_WriteContext } from "../server/files-write-policy.ts";
import { public_api_SERVICE_ACCOUNT_SCOPES, type public_api_Scope } from "../shared/public-api.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

/**
 * Say whether the service account of a key is still live. A personal key has no account, so it
 * returns true. A bound key needs an active account in its own workspace. It may hold only the
 * scopes an account may hold.
 */
export async function public_api_credentials_db_has_live_account(
	ctx: QueryCtx,
	credential: Pick<Doc<"api_credentials">, "organizationId" | "workspaceId" | "serviceAccountId" | "scopes">,
) {
	if (credential.serviceAccountId === null) {
		return true;
	}

	const allowedScopes: readonly public_api_Scope[] = public_api_SERVICE_ACCOUNT_SCOPES;
	if (credential.scopes.some((scope) => !allowedScopes.includes(scope))) {
		return false;
	}

	const account = await ctx.db.get("access_control_service_accounts", credential.serviceAccountId);
	return (
		account !== null &&
		account.revokedAt === null &&
		account.organizationId === credential.organizationId &&
		account.workspaceId === credential.workspaceId
	);
}

/**
 * Say whether the API key that started a job may still act for it: not revoked, the same person and
 * workspace, still holding every scope the job needs, and with its service account still live when it
 * has one. Rotate revokes the old key, so a job started by the old key stops too.
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
		credential.workspaceId === args.workspaceId &&
		args.scopes.every((scope) => credential.scopes.includes(scope)) &&
		(await public_api_credentials_db_has_live_account(ctx, credential))
	);
}

/**
 * Get who the access checks of a job act as. `credentialId` is the API key that started the job, or
 * null for the app and the agent, which act as the person.
 *
 * A key bound to a service account acts as the account, so the job reads and writes only what the
 * account may, not what the person behind the key may. A key keeps its account for life. Callers pass
 * a key that exists: a request has just checked it, and a job step runs
 * `public_api_credentials_db_is_live` first.
 */
export async function public_api_credentials_db_get_write_context(
	ctx: QueryCtx,
	args: { credentialId: Id<"api_credentials"> | null; userId: Id<"users">; force?: boolean },
): Promise<files_nodes_WriteContext> {
	if (args.credentialId === null) {
		return files_nodes_user_write_context(args.userId);
	}

	const credential = await ctx.db.get("api_credentials", args.credentialId);
	if (!credential || credential.userId !== args.userId) {
		throw should_never_happen("A job's API key is gone", args);
	}
	const force = args.force === true && credential.scopes.includes("files:read-only");
	return credential.serviceAccountId === null
		? { ...files_nodes_user_write_context(credential.userId), force }
		: {
				subject: { kind: "service_account", serviceAccountId: credential.serviceAccountId },
				actorUserId: credential.userId,
				resourceScope: { kind: "workspace" },
				force,
			};
}
