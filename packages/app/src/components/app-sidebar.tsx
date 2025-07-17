import * as React from "react";
import { MessageSquare, Plus, Search, X } from "lucide-react";
import { SearchForm } from "@/components/search-form";
import { VersionSwitcher } from "@/components/version-switcher";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useAssistantRuntime } from "@assistant-ui/react";
import type { ai_chat_Thread } from "@/lib/ai_chat";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { app_convex_adapt_convex_to_app_thread } from "@/lib/app_convex_client";
import { cn } from "@/lib/utils";

// This is sample data.
const data = {
	versions: ["1.0.1", "1.1.0-alpha", "2.0.0-beta1"],
};

// Helper function to format thread display name
const format_thread_display_name = (thread: ai_chat_Thread): string => {
	return thread.title || "New Chat";
};

// Helper function to handle thread switching
const handle_thread_switch = async (runtime: any, thread: ai_chat_Thread) => {
	if (runtime?.threads?.switchToThread) {
		await runtime.threads.switchToThread(thread.id);
	}
};

export interface AiChatSidebarContent_Props {
	onClose?: (() => void) | undefined;
}

// New proper sidebar component that uses the Sidebar wrapper
export function AiChatSidebar({
	onClose,
	className,
	...props
}: AiChatSidebarContent_Props & React.ComponentProps<typeof Sidebar>) {
	return (
		<div className={cn("AiChatSidebar-wrapper", "relative overflow-hidden w-full h-full", className)}>
			<Sidebar
				side="left"
				variant="sidebar"
				collapsible="none"
				className="!border-r-0 [&>*]:!border-r-0 h-full"
				style={{ borderRight: "none !important", width: "320px" }}
				{...props}
			>
				<AiChatSidebarContent onClose={onClose} />
			</Sidebar>
			{/* Overlay to cover any border */}
			<div className="absolute top-0 right-0 bottom-0 w-px bg-sidebar z-10"></div>
		</div>
	);
}

// Content component that renders inside the sidebar
export function AiChatSidebarContent({ onClose }: AiChatSidebarContent_Props) {
	const grouped_threads = useGroupedThreads();
	const runtime = useAssistantRuntime();

	// Helper function to render a group of threads
	const render_thread_group = (title: string, threads: ai_chat_Thread[]) => {
		if (threads.length === 0) return null;

		return (
			<SidebarGroup key={title}>
				<SidebarGroupLabel className={cn("AiChatSidebarContent-group-label")}>{title}</SidebarGroupLabel>
				<SidebarGroupContent className={cn("AiChatSidebarContent-group-content")}>
					<SidebarMenu>
						{threads.map((thread) => (
							<SidebarMenuItem key={thread.id}>
								<SidebarMenuButton
									onClick={() => handle_thread_switch(runtime, thread)}
									className={cn("AiChatSidebarContent-thread-button")}
								>
									<MessageSquare className="h-4 w-4" />
									<span className="truncate">{format_thread_display_name(thread)}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		);
	};

	const handle_new_chat = async () => {
		if (runtime?.threads?.switchToNewThread) {
			await runtime.threads.switchToNewThread();
		}
	};

	return (
		<>
			<SidebarHeader>
				{/* Top row with close button and version switcher */}
				<div className={cn("AiChatSidebarContent-top-row", "flex items-center justify-between")}>
					{/* Close button on top-left */}
					{onClose && (
						<Button
							variant="ghost"
							size="icon"
							onClick={onClose}
							className={cn("AiChatSidebarContent-close-button", "h-8 w-8")}
						>
							<X className="h-4 w-4" />
						</Button>
					)}

					{/* Version switcher on the right */}
					<div className={cn("AiChatSidebarContent-version", "flex-1 ml-2")}>
						<VersionSwitcher versions={data.versions} defaultVersion={data.versions[0]} />
					</div>
				</div>

				{/* Search Form */}
				<div className={cn("AiChatSidebarContent-search", "relative")}>
					<div className="text-xs font-medium text-muted-foreground mb-2">Search</div>
					<input
						placeholder="Search the docs..."
						className={cn(
							"AiChatSidebarContent-search-input",
							"w-full h-8 px-3 py-1 pl-8 text-sm bg-background border border-input rounded-md shadow-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
						)}
					/>
					<Search className="absolute top-8 left-2 h-4 w-4 text-muted-foreground pointer-events-none" />
				</div>

				{/* New Chat Button */}
				<Button onClick={() => void handle_new_chat()} className="w-full justify-start gap-2" variant="outline">
					<Plus className="h-4 w-4" />
					New Chat
				</Button>
			</SidebarHeader>

			<SidebarContent>
				{render_thread_group("Today", grouped_threads.today)}
				{render_thread_group("Yesterday", grouped_threads.yesterday)}
				{render_thread_group("Past Week", grouped_threads.past_week)}
				{render_thread_group("Past Month", grouped_threads.past_month)}
				{render_thread_group("Older", grouped_threads.older)}
			</SidebarContent>

			<SidebarRail />
		</>
	);
}

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
