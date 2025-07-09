import { v } from "convex/values";
import { action } from "./_generated/server";
import { AssistantCloud } from "@assistant-ui/react";

// Import constants from the frontend for consistency
const ai_chat_HARDCODED_PROJECT_ID = "app_project_local_dev";
const auth_ANONYMOUS_USER_ID = "anonymous";
const auth_ANONYMOUS_WORKSPACE_ID = "anonymous";

// Helper function to create Assistant UI auth tokens
// This replicates the logic from AssistantCloudAPIKeyAuthStrategy
async function create_assistant_ui_token(
	api_key: string,
	user_id: string,
	workspace_id: string
) {
	const response = await fetch(
		"https://backend.assistant-api.com/auth/tokens",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${api_key}`,
				"Aui-User-Id": user_id,
				"Aui-Workspace-Id": workspace_id,
			},
			// No body needed - auth info is in headers like AssistantCloudAPIKeyAuthStrategy
		}
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to create Assistant UI token: ${response.status} ${errorText}`
		);
	}

	const result = await response.json();
	return result;
}

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
				const workspace_id = `${project_id}--${user_id}`;

				const assistant_ui_cloud = new AssistantCloud({
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
				const assistant_ui_cloud = new AssistantCloud({
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
