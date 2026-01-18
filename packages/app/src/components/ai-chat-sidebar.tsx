import * as React from "react";
import { MessageSquare, Plus, Search, X, ArchiveIcon, ArchiveRestoreIcon, Star, Menu } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider } from "@/components/ui/sidebar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { ThreadListPrimitive, ThreadListItemPrimitive, useAssistantState } from "@assistant-ui/react";
import { useState, createContext, use } from "react";
import { cn, ui_create_auto_complete_off_value } from "@/lib/utils.ts";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Label } from "@/components/ui/label.tsx";
import { useMutation, useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";

// Search Context
interface SearchContextType {
	search_query: string;
	set_search_query: (query: string) => void;
}

const SearchContext = createContext<SearchContextType | null>(null);

const useSearchContext = () => {
	const context = use(SearchContext);
	if (!context) {
		throw new Error("useSearchContext must be used within SearchContextProvider");
	}
	return context;
};

interface SearchContextProvider_Props {
	children: React.ReactNode;
}

function SearchContextProvider({ children }: SearchContextProvider_Props) {
	const [search_query, set_search_query] = useState("");

	return <SearchContext.Provider value={{ search_query, set_search_query }}>{children}</SearchContext.Provider>;
}

interface ShowArchivedCheckbox_Props {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void; // camelCase - matches Checkbox API
	className?: string; // camelCase - for DOM compatibility
}

function ShowArchivedCheckbox({ checked, onCheckedChange, className }: ShowArchivedCheckbox_Props) {
	const checkbox_id = React.useId();

	return (
		<div className={cn("mb-4 flex items-center space-x-2", className)}>
			<Label htmlFor={checkbox_id} className={cn("AiChatSidebarContent-archived-label")}>
				<Checkbox
					id={checkbox_id}
					checked={checked}
					onCheckedChange={(checked) => onCheckedChange(checked === true)}
					className={cn("AiChatSidebarContent-archived-checkbox")}
				/>
				Show archived
			</Label>
		</div>
	);
}

// ThreadListItemAlt sub-component (primitive-based, no props)
// This component works with ThreadListPrimitive.Items and gets thread data from context
function ThreadListItemAlt() {
	const trigger_id = React.useId();
	const { search_query } = useSearchContext();
	const thread_title = useAssistantState(({ threadListItem }) => threadListItem.title) || "New Chat";
	const thread_id = useAssistantState(({ threadListItem }) => threadListItem.remoteId);

	// Check if thread matches search query
	const matches_search = !search_query || thread_title.toLowerCase().includes(search_query.toLowerCase());

	return (
		<ThreadListItemPrimitive.Root
			className={cn("AiChatSidebarContent-thread-list-item-alt", "group flex w-full px-2 py-1")}
			style={{ display: matches_search ? "flex" : "none" }}
		>
			<label
				className={cn(
					"AiChatSidebarContent-thread-list-item-trigger-area",
					"w-full cursor-pointer rounded-lg p-1 outline-none focus-within:bg-muted hover:bg-muted",
					"has-[.AiChatSidebarContent-thread-list-item-alt-trigger:focus-visible]:ring-[3px] has-[.AiChatSidebarContent-thread-list-item-alt-trigger:focus-visible]:ring-ring/50",
				)}
				htmlFor={trigger_id}
			>
				<ThreadListItemPrimitive.Trigger
					id={trigger_id}
					className={cn(
						"AiChatSidebarContent-thread-list-item-alt-trigger",
						"flex w-full items-center gap-2 border-none bg-transparent text-start outline-none",
					)}
				>
					<MessageSquare className={cn("AiChatSidebarContent-thread-list-item-alt-icon", "h-4 w-4 shrink-0")} />
					<span className={cn("AiChatSidebarContent-thread-list-item-alt-title", "truncate text-sm")}>
						<ThreadListItemPrimitive.Title fallback="New Chat" />
					</span>
				</ThreadListItemPrimitive.Trigger>
				<div className={cn("AiChatSidebarContent-thread-list-item-alt-actions", "mt-1 flex justify-end px-1")}>
					<ThreadListItemOptionToggle
						toggle={(args) => (thread_id ? <StarToggle {...args} thread_id={thread_id} /> : null)}
					/>
					<ThreadListItemOptionToggle toggle={(args) => <ArchiveToggle {...args} />} />
				</div>
			</label>
		</ThreadListItemPrimitive.Root>
	);
}

// Abstract component for thread list item option toggles
interface ThreadListItemOptionToggle_Props {
	toggle: (props: { className: { root: string; icon: string } }) => React.ReactNode;
}

function ThreadListItemOptionToggle({ toggle }: ThreadListItemOptionToggle_Props) {
	const shared_class_names = {
		root: cn("size-4 p-0 text-foreground hover:text-primary"),
		icon: cn("h-4 w-4"),
	};

	return (
		<>
			{toggle({
				className: shared_class_names,
			})}
		</>
	);
}

interface StarToggle_Props {
	className: { root: string; icon: string }; // camelCase - standard React prop
	thread_id: string;
}

function StarToggle(props: StarToggle_Props) {
	const { className, thread_id } = props;

	const thread = useQuery(app_convex_api.ai_chat.thread_get, {
		threadId: thread_id,
	});
	const thread_update_mutation = useMutation(app_convex_api.ai_chat.thread_update);

	const handle_star_toggle = async () => {
		if (!thread) return;

		try {
			await thread_update_mutation({
				threadId: thread._id,
				starred: !thread.starred,
			});
		} catch (error) {
			console.error("Failed to update thread starred status:", error);
		}
	};

	if (!thread) {
		return null;
	} else {
		if (thread.starred) {
			return (
				<TooltipIconButton
					className={className.root}
					variant="ghost"
					tooltip="Remove from favorites"
					onClick={handle_star_toggle}
				>
					<Star className={className.icon} fill="currentColor" />
				</TooltipIconButton>
			);
		} else {
			return (
				<TooltipIconButton
					className={className.root}
					variant="ghost"
					tooltip="Add to favorites"
					onClick={handle_star_toggle}
				>
					<Star className={className.icon} />
				</TooltipIconButton>
			);
		}
	}
}

interface ArchiveToggle_Props {
	className: { root: string; icon: string }; // camelCase - standard React prop
}

function ArchiveToggle({ className }: ArchiveToggle_Props) {
	const is_archived = useAssistantState(({ threadListItem }) => threadListItem.status === "archived");

	if (is_archived) {
		return (
			<ThreadListItemPrimitive.Unarchive asChild>
				<TooltipIconButton className={className.root} variant="ghost" tooltip="Unarchive thread">
					<ArchiveIcon className={className.icon} />
				</TooltipIconButton>
			</ThreadListItemPrimitive.Unarchive>
		);
	} else {
		return (
			<ThreadListItemPrimitive.Archive asChild>
				<TooltipIconButton className={className.root} variant="ghost" tooltip="Archive thread">
					<ArchiveRestoreIcon className={className.icon} />
				</TooltipIconButton>
			</ThreadListItemPrimitive.Archive>
		);
	}
}

// Props interface for the AiChatSidebarContent component
interface AiChatSidebarContent_Props {
	onClose?: (() => void) | undefined; // camelCase - could be used as event handler prop
}

// Main sidebar content component
function AiChatSidebarContent({ onClose }: AiChatSidebarContent_Props) {
	const { search_query, set_search_query } = useSearchContext();
	const [show_archived, set_show_archived] = useState(false);
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	return (
		<ThreadListPrimitive.Root className={cn("AiChatSidebarContent", "flex h-full flex-col")}>
			<SidebarHeader className="border-b">
				{/* Top row with hamburger and close button */}
				<div className="mb-4 flex items-center justify-between">
					<div className={cn("AiChatSidebarContent-top-row-left", "flex items-center gap-2")}>
						{/* Hamburger Menu - mobile only */}
						<Button
							variant="ghost"
							size="icon"
							onClick={toggleSidebar}
							className={cn("AiChatSidebarContent-hamburger-button", "h-8 w-8 lg:hidden")}
						>
							<Menu className="h-4 w-4" />
						</Button>

						{/* Close button */}
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
					</div>
				</div>

				{/* Search Form */}
				<div className={cn("AiChatSidebarContent-search-container", "relative mb-4")}>
					<div className={cn("AiChatSidebarContent-search-label", "mb-2 text-xs font-medium text-muted-foreground")}>
						Search chats
					</div>
					<input
						className={cn(
							"AiChatSidebarContent-search-input",
							"h-8 w-full rounded-md border border-input bg-background px-3 py-1 pl-8 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
						)}
						placeholder="Search chats..."
						value={search_query}
						autoComplete={ui_create_auto_complete_off_value()}
						onChange={(e) => set_search_query(e.target.value)}
					/>
					<Search
						className={cn(
							"AiChatSidebarContent-search-icon",
							"pointer-events-none absolute top-8 left-2 h-4 w-4 text-muted-foreground",
						)}
					/>
				</div>

				{/* Show Archived Checkbox */}
				<ShowArchivedCheckbox
					checked={show_archived}
					onCheckedChange={set_show_archived}
					className={cn("AiChatSidebarContent-archived-filter")}
				/>

				<ThreadListNew></ThreadListNew>
			</SidebarHeader>

			<SidebarContent className="flex-1">
				<ThreadListPrimitive.Items archived={show_archived} components={{ ThreadListItem: ThreadListItemAlt }} />
			</SidebarContent>
		</ThreadListPrimitive.Root>
	);
}

function ThreadListNew() {
	return (
		<ThreadListPrimitive.New asChild>
			<Button className={cn("AiChatSidebarContent-new-chat-button", "w-full justify-start gap-2")} variant="outline">
				<Plus className="h-4 w-4" />
				New Chat
			</Button>
		</ThreadListPrimitive.New>
	);
}

// Props interface for the AiChatSidebar wrapper component
export interface AiChatSidebar_Props extends React.ComponentProps<typeof Sidebar> {
	onClose?: (() => void) | undefined; // camelCase - could be used as event handler prop
}

// Main sidebar wrapper component
export function AiChatSidebar({ onClose, className, ...props }: AiChatSidebar_Props) {
	return (
		<SidebarProvider className={cn("AiChatSidebar", "flex h-full w-full")}>
			<SearchContextProvider>
				<div className={cn("AiChatSidebarContent-wrapper", "relative h-full w-full overflow-hidden", className)}>
					<Sidebar
						side="left"
						variant="sidebar"
						collapsible="none"
						className={cn("AiChatSidebarContent-wrapper-sidebar", "h-full !border-r-0 [&>*]:!border-r-0")}
						style={{ borderRight: "none !important", width: "320px" }}
						{...props}
					>
						<AiChatSidebarContent onClose={onClose} />
					</Sidebar>
				</div>
			</SearchContextProvider>
		</SidebarProvider>
	);
}
