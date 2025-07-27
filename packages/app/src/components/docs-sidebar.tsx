import * as React from "react";
import { FileText, Plus, Search, X, ChevronRight } from "lucide-react";
import {
	Sidebar,
	SidebarContent,
	SidebarHeader,
	SidebarProvider,
	SidebarGroup,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { useState, createContext, use } from "react";
import { cn } from "@/lib/utils";

// Types for document structure - all items are documents, some have children
interface DocItem {
	id: string;
	title: string;
	url: string;
	isActive?: boolean;
	items?: DocItem[];
}

// Mock data for nested documents - following shadcn sidebar-08 pattern
const MOCK_DOCS_DATA: DocItem[] = [
	{
		id: "getting-started",
		title: "Getting Started",
		url: "#getting-started",
		isActive: true,
		items: [
			{ id: "introduction", title: "Introduction", url: "#introduction" },
			{ id: "installation", title: "Installation", url: "#installation" },
			{ id: "quick-start", title: "Quick Start Guide", url: "#quick-start" },
		],
	},
	{
		id: "user-guide",
		title: "User Guide",
		url: "#user-guide",
		items: [
			{ id: "dashboard", title: "Dashboard Overview", url: "#dashboard" },
			{ id: "projects", title: "Managing Projects", url: "#projects" },
			{
				id: "collaboration",
				title: "Collaboration",
				url: "#collaboration",
				items: [
					{ id: "sharing", title: "Sharing Documents", url: "#sharing" },
					{ id: "comments", title: "Comments & Reviews", url: "#comments" },
					{ id: "real-time", title: "Real-time Editing", url: "#real-time" },
				],
			},
		],
	},
	{
		id: "api",
		title: "API Reference",
		url: "#api",
		items: [
			{ id: "authentication", title: "Authentication", url: "#authentication" },
			{ id: "endpoints", title: "API Endpoints", url: "#endpoints" },
			{ id: "webhooks", title: "Webhooks", url: "#webhooks" },
			{
				id: "examples",
				title: "Examples",
				url: "#examples",
				items: [
					{ id: "javascript", title: "JavaScript SDK", url: "#javascript" },
					{ id: "python", title: "Python SDK", url: "#python" },
					{ id: "curl", title: "cURL Examples", url: "#curl" },
				],
			},
		],
	},
	{
		id: "tutorials",
		title: "Tutorials",
		url: "#tutorials",
		items: [
			{ id: "basic-setup", title: "Basic Setup", url: "#basic-setup" },
			{ id: "advanced-features", title: "Advanced Features", url: "#advanced-features" },
			{ id: "integrations", title: "Third-party Integrations", url: "#integrations" },
		],
	},
	{
		id: "troubleshooting",
		title: "Troubleshooting",
		url: "#troubleshooting",
		items: [
			{ id: "common-issues", title: "Common Issues", url: "#common-issues" },
			{ id: "performance", title: "Performance Tips", url: "#performance" },
			{ id: "support", title: "Getting Support", url: "#support" },
		],
	},
];

// Search Context
interface DocsSearchContextType {
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	selectedDocId: string | null;
	setSelectedDocId: (id: string | null) => void;
}

const DocsSearchContext = createContext<DocsSearchContextType | null>(null);

const useDocsSearchContext = () => {
	const context = use(DocsSearchContext);
	if (!context) {
		throw new Error("useDocsSearchContext must be used within DocsSearchContextProvider");
	}
	return context;
};

interface DocsSearchContextProvider_Props {
	children: React.ReactNode;
}

function DocsSearchContextProvider({ children }: DocsSearchContextProvider_Props) {
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedDocId, setSelectedDocId] = useState<string | null>("getting-started");

	return (
		<DocsSearchContext.Provider
			value={{
				searchQuery,
				setSearchQuery,
				selectedDocId,
				setSelectedDocId,
			}}
		>
			{children}
		</DocsSearchContext.Provider>
	);
}

// Recursive function to flatten docs for search
function flattenDocs(docs: DocItem[]): DocItem[] {
	const flattened: DocItem[] = [];

	function traverse(items: DocItem[]) {
		for (const item of items) {
			flattened.push(item);
			if (item.items) {
				traverse(item.items);
			}
		}
	}

	traverse(docs);
	return flattened;
}

// Filter docs based on search query
function filterDocs(docs: DocItem[], searchQuery: string): DocItem[] {
	if (!searchQuery) return docs;

	function hasMatchingItems(item: DocItem): boolean {
		// Check if current item matches
		if (item.title.toLowerCase().includes(searchQuery.toLowerCase())) {
			return true;
		}
		// Check if any children match
		if (item.items) {
			return item.items.some(hasMatchingItems);
		}
		return false;
	}

	function filterItem(item: DocItem): DocItem | null {
		const itemMatches = item.title.toLowerCase().includes(searchQuery.toLowerCase());
		const filteredChildren = item.items ? (item.items.map(filterItem).filter(Boolean) as DocItem[]) : undefined;

		if (itemMatches || (filteredChildren && filteredChildren.length > 0)) {
			return {
				...item,
				items: filteredChildren,
			};
		}
		return null;
	}

	return docs.map(filterItem).filter(Boolean) as DocItem[];
}

// NavMain component following shadcn sidebar-08 pattern
interface NavMain_Props {
	items: DocItem[];
}

function NavMain({ items }: NavMain_Props) {
	const { selectedDocId, setSelectedDocId } = useDocsSearchContext();

	const handleDocumentClick = (docId: string) => {
		setSelectedDocId(docId);
		console.log("Navigate to document:", docId);
	};

	return (
		<SidebarGroup>
			<SidebarMenu>
				{items.map((item) => (
					<Collapsible key={item.id} asChild defaultOpen={item.isActive}>
						<SidebarMenuItem>
							<SidebarMenuButton asChild tooltip={item.title} isActive={selectedDocId === item.id}>
								<button onClick={() => handleDocumentClick(item.id)} className="w-full justify-start">
									<FileText className="h-4 w-4" />
									<span>{item.title}</span>
								</button>
							</SidebarMenuButton>
							{item.items?.length ? (
								<>
									<CollapsibleTrigger asChild>
										<SidebarMenuAction className="data-[state=open]:rotate-90">
											<ChevronRight />
											<span className="sr-only">Toggle</span>
										</SidebarMenuAction>
									</CollapsibleTrigger>
									<CollapsibleContent>
										<SidebarMenuSub className="mx-0 ml-3.5 px-0 pl-2.5">
											{item.items?.map((subItem) => (
												<NavSubItem key={subItem.id} item={subItem} onItemClick={handleDocumentClick} />
											))}
										</SidebarMenuSub>
									</CollapsibleContent>
								</>
							) : null}
						</SidebarMenuItem>
					</Collapsible>
				))}
			</SidebarMenu>
		</SidebarGroup>
	);
}

// Recursive component for sub-items
interface NavSubItem_Props {
	item: DocItem;
	onItemClick: (docId: string) => void;
}

function NavSubItem({ item, onItemClick }: NavSubItem_Props) {
	const { selectedDocId } = useDocsSearchContext();

	if (item.items?.length) {
		return (
			<Collapsible key={item.id} asChild>
				<SidebarMenuItem>
					<SidebarMenuButton asChild isActive={selectedDocId === item.id}>
						<button onClick={() => onItemClick(item.id)} className="w-full justify-start">
							<FileText className="h-4 w-4" />
							<span>{item.title}</span>
						</button>
					</SidebarMenuButton>
					<CollapsibleTrigger asChild>
						<SidebarMenuAction className="data-[state=open]:rotate-90">
							<ChevronRight />
							<span className="sr-only">Toggle</span>
						</SidebarMenuAction>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<SidebarMenuSub className="mx-0 ml-3.5 px-0 pl-2.5">
							{item.items.map((subItem) => (
								<NavSubItem key={subItem.id} item={subItem} onItemClick={onItemClick} />
							))}
						</SidebarMenuSub>
					</CollapsibleContent>
				</SidebarMenuItem>
			</Collapsible>
		);
	}

	return (
		<SidebarMenuSubItem key={item.id}>
			<SidebarMenuSubButton asChild isActive={selectedDocId === item.id}>
				<button onClick={() => onItemClick(item.id)} className="w-full justify-start">
					<FileText className="h-4 w-4" />
					<span>{item.title}</span>
				</button>
			</SidebarMenuSubButton>
		</SidebarMenuSubItem>
	);
}

// Props interface for the DocsSidebarContent component
interface DocsSidebarContent_Props {
	onClose?: (() => void) | undefined;
}

// Main sidebar content component
function DocsSidebarContent({ onClose }: DocsSidebarContent_Props) {
	const { searchQuery, setSearchQuery } = useDocsSearchContext();

	// Filter docs based on search query
	const filteredDocs = filterDocs(MOCK_DOCS_DATA, searchQuery);

	return (
		<div className={cn("DocsSidebarContent", "flex h-full flex-col")}>
			<SidebarHeader className="border-b">
				{/* Close button only if onClose is provided */}
				{onClose && (
					<div className="mb-4 flex items-center justify-between">
						<h2 className={cn("DocsSidebarContent-title", "text-lg font-semibold")}>Documentation</h2>
						<Button
							variant="ghost"
							size="icon"
							onClick={onClose}
							className={cn("DocsSidebarContent-close-button", "h-8 w-8")}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				)}

				{/* Search Form */}
				<div className={cn("DocsSidebarContent-search-container", "relative mb-4")}>
					<div className={cn("DocsSidebarContent-search-label", "mb-2 text-xs font-medium text-muted-foreground")}>
						Search docs
					</div>
					<input
						placeholder="Search documentation..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className={cn(
							"DocsSidebarContent-search-input",
							"h-8 w-full rounded-md border border-input bg-background px-3 py-1 pl-8 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
						)}
					/>
					<Search
						className={cn(
							"DocsSidebarContent-search-icon",
							"pointer-events-none absolute top-8 left-2 h-4 w-4 text-muted-foreground",
						)}
					/>
				</div>

				{/* New Document Button */}
				<Button className={cn("DocsSidebarContent-new-doc-button", "w-full justify-start gap-2")} variant="outline">
					<Plus className="h-4 w-4" />
					New Document
				</Button>
			</SidebarHeader>

			<SidebarContent className="flex-1 overflow-auto">
				<NavMain items={filteredDocs} />
			</SidebarContent>
		</div>
	);
}

// Props interface for the DocsSidebar wrapper component
export interface DocsSidebar_Props extends React.ComponentProps<typeof Sidebar> {
	onClose?: (() => void) | undefined;
}

// Main sidebar wrapper component
export function DocsSidebar({ onClose, className, ...props }: DocsSidebar_Props) {
	return (
		<SidebarProvider className={cn("DocsSidebar", "flex h-full w-full")}>
			<DocsSearchContextProvider>
				<div className={cn("DocsSidebarContent-wrapper", "relative h-full w-full overflow-hidden", className)}>
					<Sidebar
						side="left"
						variant="sidebar"
						collapsible="none"
						className={cn("DocsSidebarContent-wrapper-sidebar", "h-full !border-r-0 [&>*]:!border-r-0")}
						style={{ borderRight: "none !important", width: "320px" }}
						{...props}
					>
						<DocsSidebarContent onClose={onClose} />
					</Sidebar>
				</div>
			</DocsSearchContextProvider>
		</SidebarProvider>
	);
}
