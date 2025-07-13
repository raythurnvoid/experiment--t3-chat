import { v } from "convex/values";
import { action } from "./_generated/server";
import { AssistantCloudConvex } from "@assistant-ui/cloud";
import { auth_ANONYMOUS_USER_ID, auth_ANONYMOUS_WORKSPACE_ID } from "../shared/shared_auth_constants.ts";

export const generate_assistant_ui_token = action({
	args: {
		aui_api_key: v.string(),
		project_id: v.string(),
	},
	handler: async (ctx, { aui_api_key, project_id }) => {
		try {
			// Get user identity from Clerk authentication
			const identity = await ctx.auth.getUserIdentity();

			if (identity) {
				// Authenticated user flow
				const user_id = identity.subject; // Clerk user ID
				const workspace_id = `${user_id}--${project_id}`;

				const assistant_ui_cloud = new AssistantCloudConvex({
					apiKey: aui_api_key,
					userId: user_id,
					workspaceId: workspace_id,
				});

				const result = await assistant_ui_cloud.auth.tokens.create();

				return {
					token: result.token,
				};
			} else {
				// Anonymous user flow
				const assistant_ui_cloud = new AssistantCloudConvex({
					apiKey: aui_api_key,
					userId: auth_ANONYMOUS_USER_ID,
					workspaceId: auth_ANONYMOUS_WORKSPACE_ID,
				});

				const result = await assistant_ui_cloud.auth.tokens.create();

				return {
					token: result.token,
				};
			}
		} catch (error) {
			console.error("Error generating Assistant UI token:", error);
			throw new Error("Failed to generate Assistant UI token");
		}
	},
});
