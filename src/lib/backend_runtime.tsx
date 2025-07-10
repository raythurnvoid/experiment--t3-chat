import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantCloud } from "@assistant-ui/react";
import { auth_get_token_manager_token } from "./auth.ts";
import { api } from "../../convex/_generated/api";
import { ai_chat_HARDCODED_PROJECT_ID } from "./ai_chat.ts";
import { app_convex } from "./app_convex_client.ts";

// ===== CONVEX BACKEND CONFIGURATION =====
// Get Convex deployment URL from environment or use default
const CONVEX_URL =
	import.meta.env.VITE_CONVEX_URL ||
	"https://your-convex-deployment.convex.site";
const API_BASE = CONVEX_URL;

async function get_assistant_ui_token() {
	try {
		// Call the Convex action programmatically using the client
		const result = await app_convex.action(
			api.auth.generate_assistant_ui_token,
			{
				aui_api_key: import.meta.env.VITE_ASSISTANT_UI_API_KEY,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
			}
		);
		return result.token;
	} catch (error) {
		console.error("Failed to fetch assistant-ui token:", error);
		throw new Error("Failed to fetch assistant-ui token");
	}
}

// AssistantCloud instance with Convex backend
const assistant_cloud = new AssistantCloud({
	baseUrl: API_BASE,
	useAssistantUICloud: false,
	authToken: get_assistant_ui_token,
});

// Public hook – use this to get multi-thread support with AI SDK
export const useBackendRuntime = () => {
	// Use useChatRuntime with the Convex HTTP endpoints
	// The chat endpoint is now handled by Convex HTTP actions
	const runtime = useChatRuntime({
		api: `${API_BASE}/api/chat`, // Using Convex HTTP action endpoint
		cloud: assistant_cloud,
		headers: async () => {
			const token = await auth_get_token_manager_token();

			const headers = new Headers();
			if (token) {
				headers.set("Authorization", `Bearer ${token}`);
			}

			return headers;
		},
	});

	return runtime;
};
