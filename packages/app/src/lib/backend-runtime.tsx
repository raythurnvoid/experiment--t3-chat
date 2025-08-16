import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantCloud } from "@assistant-ui/react";
import { api } from "../../convex/_generated/api";
import { ai_chat_HARDCODED_PROJECT_ID } from "./ai-chat.ts";
import { app_convex } from "./app-convex-client.ts";
import { app_fetch_main_api_url } from "./fetch.ts";
import { auth_get_token } from "./auth.ts";
import type { api_schemas_Main } from "./api-schemas.ts";
import type { Tool as assistant_ui_Tool, AssistantRuntime } from "@assistant-ui/react";

// ===== CONVEX BACKEND CONFIGURATION =====
// Get Convex deployment URL from environment or use default
const CONVEX_URL = import.meta.env.VITE_CONVEX_URL || "https://your-convex-deployment.convex.site";
const API_BASE = CONVEX_URL;

async function get_assistant_ui_token() {
	try {
		// Call the Convex action programmatically using the client
		const result = await app_convex.action(api.auth.generate_assistant_ui_token, {
			aui_api_key: import.meta.env.VITE_ASSISTANT_UI_API_KEY,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
		});
		return result.token;
	} catch (error) {
		console.error("Failed to fetch assistant-ui token:", error);
		throw new Error("Failed to fetch assistant-ui token");
	}
}

// AssistantCloud instance with Convex backend
const assistant_cloud = new AssistantCloud({
	baseUrl: API_BASE,
	useAssistantUiCloud: false,
	authToken: get_assistant_ui_token,
});

// Public hook – use this to get multi-thread support with AI SDK
export const useBackendRuntime = () => {
	// Use useChatRuntime with the Convex HTTP endpoints
	// The chat endpoint is now handled by Convex HTTP actions
	// const runtime = useChatRuntime({
	// 	useAssistantUiFetch: true,
	// 	api: `${API_BASE}/api/chat`, // Using Convex HTTP action endpoint
	// 	cloud: assistant_cloud,
	// 	credentials: "omit",
	// 	headers: async () => {
	// 		const token = await auth_get_token();

	// 		const headers = new Headers();
	// 		if (token) {
	// 			headers.set("Authorization", `Bearer ${token}`);
	// 		}

	// 		return headers;
	// 	},
	// });

	const runtime = useChatRuntime({
		cloud: assistant_cloud,
		transport: new AssistantChatTransport({
			api: app_fetch_main_api_url("/api/chat"),
			// Route through app_fetch_main_chat by default
			prepareSendMessagesRequest: async (options) => {
				const body = options.body as Record<string, unknown> & {
					system?: string | undefined;
					tools: Record<string, assistant_ui_Tool>;
				};

				if (body == null) {
					throw new Error('`body` is null when calling `useChatRuntime.app_fetch_main_api_url("/api/chat")`');
				}

				const headers = new Headers(options.headers);
				headers.set("Accept", "text/event-stream");

				const token = await auth_get_token();
				if (token) {
					headers.set("Authorization", `Bearer ${token}`);
				}

				debugger;

				// This will prevent TS to break because of self-referencing `runtime`
				const runtime_local = runtime as AssistantRuntime;

				const threadId = runtime_local.threads.mainItem.getState().remoteId;
				const messages = threadId ? runtime_local.threads.main.getState().messages : [];
				const lastMessage = messages.findLast(
					(message) =>
						message.status?.type && (message.status.type === "complete" || message.status.type === "incomplete"),
				);
				const remoteParentId = lastMessage
					? ((await assistant_cloud.__historyAdapter?._getIdForLocalId?.[lastMessage.id]) ?? lastMessage.id)
					: undefined;

				// Inspired from AssistantChatTransport.prepareSendMessagesRequest
				return {
					...options,
					body: {
						...body,
						id: options.id,
						// Send only the last message
						messages: options.messages.slice(-1),
						trigger: options.trigger,
						messageId: options.messageId,

						threadId,
						parentId: remoteParentId,
					} satisfies api_schemas_Main["/api/chat"]["get"]["body"],
					credentials: "omit",
					headers,
				};
			},
		}),
	});

	return runtime;
};
