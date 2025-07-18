import * as React from "react";
import { MessageSquare, Plus, Search, X, ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { ThreadListPrimitive, ThreadListItemPrimitive, useThreadListItem } from "@assistant-ui/react";
import { useState, createContext, use } from "react";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

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

interface SearchContextProviderProps {
	children: React.ReactNode;
}

function SearchContextProvider({ children }: SearchContextProviderProps) {
	const [search_query, set_search_query] = useState("");

	return <SearchContext.Provider value={{ search_query, set_search_query }}>{children}</SearchContext.Provider>;
}

interface ShowArchivedCheckboxProps {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	className?: string;
}

function ShowArchivedCheckbox({ checked, onCheckedChange, className }: ShowArchivedCheckboxProps) {
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
	const thread_title = useThreadListItem((t) => t.title) || "New Chat";

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
					<ArchiveToggle />
				</div>
			</label>
		</ThreadListItemPrimitive.Root>
	);
}

function ArchiveToggle() {
	const is_archived = useThreadListItem((t) => t.status === "archived");

	const class_names = {
		root: cn(
			"AiChatSidebarContent-thread-list-item-alt-archive-button",
			"size-4 p-0 text-foreground hover:text-primary",
		),
		icon: cn("h-4 w-4"),
	};

	if (is_archived) {
		return (
			<ThreadListItemPrimitive.Unarchive asChild>
				<TooltipIconButton className={class_names.root} variant="ghost" tooltip="Unarchive thread">
					<ArchiveIcon className={class_names.icon} />
				</TooltipIconButton>
			</ThreadListItemPrimitive.Unarchive>
		);
	} else {
		return (
			<ThreadListItemPrimitive.Archive asChild>
				<TooltipIconButton className={class_names.root} variant="ghost" tooltip="Archive thread">
					<ArchiveRestoreIcon className={class_names.icon} />
				</TooltipIconButton>
			</ThreadListItemPrimitive.Archive>
		);
	}
}

// Props interface for the AiChatSidebarContent component
interface AiChatSidebarContent_Props {
	onClose?: (() => void) | undefined;
}

// Main sidebar content component
function AiChatSidebarContent({ onClose }: AiChatSidebarContent_Props) {
	const { search_query, set_search_query } = useSearchContext();
	const [show_archived, set_show_archived] = useState(false);

	return (
		<ThreadListPrimitive.Root className={cn("AiChatSidebarContent", "flex h-full flex-col")}>
			<SidebarHeader className="border-b">
				{/* Close button only if onClose is provided */}
				{onClose && (
					<div className="mb-4 flex items-center justify-between">
						<Button
							variant="ghost"
							size="icon"
							onClick={onClose}
							className={cn("AiChatSidebarContent-close-button", "h-8 w-8")}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				)}

				{/* Search Form */}
				<div className={cn("AiChatSidebarContent-search-container", "relative mb-4")}>
					<div className={cn("AiChatSidebarContent-search-label", "mb-2 text-xs font-medium text-muted-foreground")}>
						Search chats
					</div>
					<input
						placeholder="Search chats..."
						value={search_query}
						onChange={(e) => set_search_query(e.target.value)}
						className={cn(
							"AiChatSidebarContent-search-input",
							"h-8 w-full rounded-md border border-input bg-background px-3 py-1 pl-8 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
						)}
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
	);
}
