import * as React from "react";
import { MessageSquare, Plus, Search, X, ArchiveIcon } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { ThreadListPrimitive, ThreadListItemPrimitive } from "@assistant-ui/react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button";
import "./ai-chat-sidebar.css";

// Class names object for AiChatSidebarContent component (main component)
const AiChatSidebarContent_class_names = {
	root: "AiChatSidebarContent",
	close_button: "AiChatSidebarContent_close_button",
	search: {
		container: "AiChatSidebarContent_search_container",
		label: "AiChatSidebarContent_search_label",
		input: "AiChatSidebarContent_search_input",
		icon: "AiChatSidebarContent_search_icon",
	},
	new_chat_button: "AiChatSidebarContent_new_chat_button",
	// Sub-component: AiChatSidebar wrapper
	wrapper: {
		root: "AiChatSidebarContent_wrapper",
		sidebar: "AiChatSidebarContent_wrapper_sidebar",
		border_overlay: "AiChatSidebarContent_wrapper_border_overlay",
	},
	// Sub-component: ThreadListItemAlt (primitive-based)
	thread_list_item_alt: {
		root: "AiChatSidebarContent_thread_list_item_alt",
		trigger: "AiChatSidebarContent_thread_list_item_alt_trigger",
		trigger_area: "AiChatSidebarContent_thread_list_item_trigger_area",
		content: "AiChatSidebarContent_thread_list_item_alt_content",
		icon: "AiChatSidebarContent_thread_list_item_alt_icon",
		title: "AiChatSidebarContent_thread_list_item_alt_title",
		actions: "AiChatSidebarContent_thread_list_item_alt_actions",
		archive_button: "AiChatSidebarContent_thread_list_item_alt_archive_button",
	},
};

// ThreadListItemAlt sub-component (primitive-based, no props)
// This component works with ThreadListPrimitive.Items and gets thread data from context
function ThreadListItemAlt() {
	const trigger_id = React.useId();

	return (
		<ThreadListItemPrimitive.Root
			className={cn(AiChatSidebarContent_class_names.thread_list_item_alt.root, "group flex w-full py-1 px-2")}
		>
			<label
				className={cn(
					AiChatSidebarContent_class_names.thread_list_item_alt.trigger_area,
					"w-full p-1 rounded-lg hover:bg-muted focus-within:bg-muted cursor-pointer outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
				)}
				htmlFor={trigger_id}
			>
				<ThreadListItemPrimitive.Trigger
					id={trigger_id}
					className={cn(
						AiChatSidebarContent_class_names.thread_list_item_alt.trigger,
						"flex items-center gap-2 w-full text-start bg-transparent border-none outline-none",
					)}
				>
					<MessageSquare
						className={cn(AiChatSidebarContent_class_names.thread_list_item_alt.icon, "h-4 w-4 shrink-0")}
					/>
					<span className={cn(AiChatSidebarContent_class_names.thread_list_item_alt.title, "truncate text-sm")}>
						<ThreadListItemPrimitive.Title fallback="New Chat" />
					</span>
				</ThreadListItemPrimitive.Trigger>
				<div
					className={cn(
						AiChatSidebarContent_class_names.thread_list_item_alt.actions,
						"flex justify-end px-1 mt-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200",
					)}
				>
					<ThreadListItemPrimitive.Archive asChild>
						<TooltipIconButton
							className={cn(
								AiChatSidebarContent_class_names.thread_list_item_alt.archive_button,
								"hover:text-primary text-foreground size-4 p-0",
							)}
							variant="ghost"
							tooltip="Archive thread"
						>
							<ArchiveIcon className="h-4 w-4" />
						</TooltipIconButton>
					</ThreadListItemPrimitive.Archive>
				</div>
			</label>
		</ThreadListItemPrimitive.Root>
	);
}

// Props interface for the AiChatSidebarContent component
interface AiChatSidebarContent_Props {
	onClose?: (() => void) | undefined;
}

// Main sidebar content component
function AiChatSidebarContent({ onClose }: AiChatSidebarContent_Props) {
	const [search_query, setSearchQuery] = useState("");

	return (
		<ThreadListPrimitive.Root className={cn(AiChatSidebarContent_class_names.root, "flex flex-col h-full")}>
			<SidebarHeader className="border-b">
				{/* Close button only if onClose is provided */}
				{onClose && (
					<div className="flex items-center justify-between mb-4">
						<Button
							variant="ghost"
							size="icon"
							onClick={onClose}
							className={cn(AiChatSidebarContent_class_names.close_button, "h-8 w-8")}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				)}

				{/* Search Form */}
				<div className={cn(AiChatSidebarContent_class_names.search.container, "relative mb-4")}>
					<div
						className={cn(
							AiChatSidebarContent_class_names.search.label,
							"text-xs font-medium text-muted-foreground mb-2",
						)}
					>
						Search chats
					</div>
					<input
						placeholder="Search conversations..."
						value={search_query}
						onChange={(e) => setSearchQuery(e.target.value)}
						className={cn(
							AiChatSidebarContent_class_names.search.input,
							"w-full h-8 px-3 py-1 pl-8 text-sm bg-background border border-input rounded-md shadow-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
						)}
					/>
					<Search
						className={cn(
							AiChatSidebarContent_class_names.search.icon,
							"absolute top-8 left-2 h-4 w-4 text-muted-foreground pointer-events-none",
						)}
					/>
				</div>

				<ThreadListNew></ThreadListNew>
			</SidebarHeader>

			<SidebarContent className="flex-1">
				<ThreadListPrimitive.Items components={{ ThreadListItem: ThreadListItemAlt }} />
			</SidebarContent>
		</ThreadListPrimitive.Root>
	);
}

function ThreadListNew() {
	return (
		<ThreadListPrimitive.New asChild>
			<Button
				className={cn(AiChatSidebarContent_class_names.new_chat_button, "w-full justify-start gap-2")}
				variant="outline"
			>
				<Plus className="h-4 w-4" />
				New Chat
			</Button>
		</ThreadListPrimitive.New>
	);
}

// Props interface for the AiChatSidebar wrapper component
export interface AiChatSidebar_Props {
	onClose?: (() => void) | undefined;
}

// Main sidebar wrapper component
export function AiChatSidebar({
	onClose,
	className,
	...props
}: AiChatSidebar_Props & React.ComponentProps<typeof Sidebar>) {
	return (
		<div
			className={cn(AiChatSidebarContent_class_names.wrapper.root, "relative overflow-hidden w-full h-full", className)}
		>
			<Sidebar
				side="left"
				variant="sidebar"
				collapsible="none"
				className={cn(AiChatSidebarContent_class_names.wrapper.sidebar, "!border-r-0 [&>*]:!border-r-0 h-full")}
				style={{ borderRight: "none !important", width: "320px" }}
				{...props}
			>
				<AiChatSidebarContent onClose={onClose} />
			</Sidebar>
		</div>
	);
}
