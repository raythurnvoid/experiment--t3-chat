import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantCloud } from "@assistant-ui/react";
import { auth_ANONYMOUS_USER_ID, auth_ANONYMOUS_WORKSPACE_ID } from "./auth.ts";

// ===== LOCAL BACKEND CONFIGURATION =====
const API_BASE = "http://localhost:3001/api";

// AssistantCloud instance with our backend
// const assistantCloud = new AssistantCloud({
// 	baseUrl: API_BASE,
// 	anonymous: true, // for local development without auth
// });

// Using the real assistant-ui cloud with API key to inspect formats
const assistantCloud = new AssistantCloud({
	baseUrl: "https://proj-0y1uymi64egi.assistant-api.com",
	authToken: async () => {
		const response = await fetch("/api/assistant-ui-token", { method: "POST" });

		if (response.ok) {
			return await response.json().then((data) => data.token);
		} else {
			const error = await response.json();
			throw new Error("Failed to fetch assistant-ui token", error);
		}
	},
});

// Public hook – use this to get multi-thread support with AI SDK
export const useBackendRuntime = () => {
	// Use useChatRuntime with the official AssistantCloud adapter
	// The cloud adapter automatically handles message persistence through AssistantCloudThreadHistoryAdapter
	const runtime = useChatRuntime({
		api: `${API_BASE}/chat`, // Using local backend chat endpoint
		cloud: assistantCloud,
	});

	return runtime;
};
