import { create } from "zustand";

import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";

type ai_chat_ThreadStore = {
	selectedThreadId: string | null;
	selectThread: (threadId: string) => void;
	setSelectedThreadId: (threadId: string | null) => void;
	startNewThread: () => Promise<string>;
};

export const useAiChatThreadStore = create<ai_chat_ThreadStore>((set) => ({
	selectedThreadId: null,
	selectThread: (threadId) => set({ selectedThreadId: threadId }),
	setSelectedThreadId: (threadId) => set({ selectedThreadId: threadId }),
	startNewThread: async () => {
		const { thread_id } = await app_convex.mutation(app_convex_api.ai_chat.thread_create, {
			lastMessageAt: Date.now(),
		});

		set({ selectedThreadId: thread_id });
		return thread_id;
	},
}));
