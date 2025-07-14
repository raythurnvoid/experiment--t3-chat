import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { app_convex_adapt_convex_to_app_thread } from "@/lib/app_convex_client";
import type { ai_chat_Thread } from "@/lib/ai_chat";

export interface ai_chat_GroupedThreads {
	today: ai_chat_Thread[];
	yesterday: ai_chat_Thread[];
	past_week: ai_chat_Thread[];
	past_month: ai_chat_Thread[];
	older: ai_chat_Thread[];
}

export const useGroupedThreads = (): ai_chat_GroupedThreads => {
	// Fetch threads directly from Convex
	const threads_result = useQuery(api.ai_chat.threads_list, {
		pagination_opts: {
			numItems: 50, // Get up to 50 threads
			cursor: null,
		},
		include_archived: false,
	});

	return useMemo(() => {
		const empty_groups: ai_chat_GroupedThreads = {
			today: [],
			yesterday: [],
			past_week: [],
			past_month: [],
			older: [],
		};

		if (!threads_result?.page?.threads) {
			return empty_groups;
		}

		const now = new Date();
		const today_start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const yesterday_start = new Date(today_start.getTime() - 24 * 60 * 60 * 1000);
		const week_start = new Date(today_start.getTime() - 7 * 24 * 60 * 60 * 1000);
		const month_start = new Date(today_start.getTime() - 30 * 24 * 60 * 60 * 1000);

		const grouped: ai_chat_GroupedThreads = {
			today: [],
			yesterday: [],
			past_week: [],
			past_month: [],
			older: [],
		};

		// Convert Convex threads to ai_chat_Thread format and sort by last_message_at descending
		const adapted_threads = threads_result.page.threads
			.map((convex_thread) => app_convex_adapt_convex_to_app_thread(convex_thread))
			.sort((a, b) => b.last_message_at.getTime() - a.last_message_at.getTime());

		// Group threads by time periods
		for (const thread of adapted_threads) {
			const thread_date = thread.last_message_at;

			if (thread_date >= today_start) {
				grouped.today.push(thread);
			} else if (thread_date >= yesterday_start) {
				grouped.yesterday.push(thread);
			} else if (thread_date >= week_start) {
				grouped.past_week.push(thread);
			} else if (thread_date >= month_start) {
				grouped.past_month.push(thread);
			} else {
				grouped.older.push(thread);
			}
		}

		return grouped;
	}, [threads_result]);
};
