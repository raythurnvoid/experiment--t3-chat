import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantCloud } from "@assistant-ui/react";
import { ai_chat_HARDCODED_PROJECT_ID } from "./ai_chat.ts";
import { api } from "../../convex/_generated/api";
import { app_convex } from "./app_convex_client.ts";

// ===== LOCAL BACKEND CONFIGURATION =====
const API_BASE = "http://localhost:3001/api";

// AssistantCloud instance with our backend
// const assistantCloud = new AssistantCloud({
// 	baseUrl: API_BASE,
// 	anonymous: true, // for local development without auth
// });

// Using the real assistant-ui cloud with API key to inspect formats
const assistant_cloud = new AssistantCloud({
	baseUrl: "https://proj-0y1uymi64egi.assistant-api.com",
	useAssistantUICloud: true,
	authToken: async () => {
		try {
			// Call the Convex action programmatically using the client
			debugger;
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
	},
});

// Public hook – use this to get multi-thread support with AI SDK
export const useBackendRuntime = () => {
	// Use useChatRuntime with the official AssistantCloud adapter
	// The cloud adapter automatically handles message persistence through AssistantCloudThreadHistoryAdapter
	const runtime = useChatRuntime({
		api: `${API_BASE}/chat`, // Using local backend chat endpoint
		cloud: assistant_cloud,
	});

	return runtime;
};
