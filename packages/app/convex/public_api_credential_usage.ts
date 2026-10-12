import { v } from "convex/values";
import { internalMutation } from "./functions.ts";
import { resolve_principal } from "./public_api.ts";

// Reuse the loaded module between calls. Keep request state inside the handler.
export const experimental_reuseContext = true;

console.info("API usage small module loaded");

// Temporary heavy import for the fix-off check.
void resolve_principal;

const API_CREDENTIAL_LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export const mark_credential_used = internalMutation({
	args: {
		credentialId: v.id("api_credentials"),
		now: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// eslint-disable-next-line no-console -- Temporary handler timing.
		console.time("API credential usage handler");
		try {
			// Never write the credential doc here: every file publish reads it to check revocation, so a
			// write there would conflict with parallel publishes. The usage doc has its own table.
			const usage = await ctx.db
				.query("api_credentials_last_used")
				.withIndex("by_credential", (q) => q.eq("credentialId", args.credentialId))
				.first();
			if (usage) {
				// Write at most once per minute, so parallel requests of one key rarely touch this doc.
				if (args.now - usage.lastUsedAt >= API_CREDENTIAL_LAST_USED_UPDATE_INTERVAL_MS) {
					await ctx.db.patch("api_credentials_last_used", usage._id, { lastUsedAt: args.now });
				}
				return null;
			}

			const credential = await ctx.db.get("api_credentials", args.credentialId);
			if (credential) {
				await ctx.db.insert("api_credentials_last_used", {
					credentialId: credential._id,
					organizationId: credential.organizationId,
					workspaceId: credential.workspaceId,
					userId: credential.userId,
					lastUsedAt: args.now,
				});
			}

			return null;
		} finally {
			// eslint-disable-next-line no-console -- Temporary handler timing.
			console.timeEnd("API credential usage handler");
		}
	},
});

// Temporary timing control; remove it after the module comparison.
export const profile_usage_startup = internalMutation({
	args: { marker: v.string() },
	returns: v.string(),
	handler: async (_ctx, args) => {
		console.info("API credential usage startup", { marker: args.marker });
		return args.marker;
	},
});
