import * as React from "react";
import { FileText, Plus, Search, X, ArchiveIcon, ArchiveRestoreIcon, Star } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useState, createContext, use } from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Search Context for docs
interface DocsSearchContextType {
	search_query: string;
	set_search_query: (query: string) => void;
}

const DocsSearchContext = createContext<DocsSearchContextType | null>(null);

function DocsSearchContextProvider({ children }: { children: React.ReactNode }) {
	const [search_query, set_search_query] = useState("");

	return <DocsSearchContext.Provider value={{ search_query, set_search_query }}>{children}</DocsSearchContext.Provider>;
}

function useDocsSearchContext() {
	const context = use(DocsSearchContext);
	if (!context) {
		throw new Error("useDocsSearchContext must be used within DocsSearchContextProvider");
	}
	return context;
}

// Mock document type for now
interface Document {
	id: string;
	title: string;
	created_at: Date;
	updated_at: Date;
	is_archived: boolean;
	is_starred: boolean;
}

// Mock documents data
const mock_documents: Document[] = [
	{
		id: "1",
		title: "Project Requirements",
		created_at: new Date("2024-01-15"),
		updated_at: new Date("2024-01-15"),
		is_archived: false,
		is_starred: true,
	},
	{
		id: "2",
		title: "Meeting Notes - Q1 Planning",
		created_at: new Date("2024-01-14"),
		updated_at: new Date("2024-01-14"),
		is_archived: false,
		is_starred: false,
	},
	{
		id: "3",
		title: "API Documentation Draft",
		created_at: new Date("2024-01-10"),
		updated_at: new Date("2024-01-12"),
		is_archived: true,
		is_starred: false,
	},
];

// Document list item component
function DocumentListItem({ document }: { document: Document }) {
	const { search_query } = useDocsSearchContext();

	// Check if document matches search query
	const matches_search = !search_query || document.title.toLowerCase().includes(search_query.toLowerCase());

	if (!matches_search) {
		return null;
	}

	return (
		<div className={cn("DocsSidebar-document-item", "group flex w-full cursor-pointer rounded-lg p-3 hover:bg-muted")}>
			<div className={cn("DocsSidebar-document-content", "flex w-full items-start gap-3")}>
				<FileText className={cn("DocsSidebar-document-icon", "mt-0.5 h-4 w-4 shrink-0")} />
				<div className={cn("DocsSidebar-document-info", "min-w-0 flex-1")}>
					<div className={cn("DocsSidebar-document-title", "truncate text-sm font-medium")}>{document.title}</div>
					<div className={cn("DocsSidebar-document-meta", "mt-1 text-xs text-muted-foreground")}>
						Updated {document.updated_at.toLocaleDateString()}
					</div>
				</div>
				<div
					className={cn("DocsSidebar-document-actions", "flex items-center gap-1 opacity-0 group-hover:opacity-100")}
				>
					{document.is_starred && (
						<Star className={cn("DocsSidebar-document-star", "h-3 w-3 fill-yellow-400 text-yellow-400")} />
					)}
					{document.is_archived && (
						<ArchiveIcon className={cn("DocsSidebar-document-archive", "h-3 w-3 text-muted-foreground")} />
					)}
				</div>
			</div>
		</div>
	);
}

// Show archived checkbox component
function ShowArchivedCheckbox({
	checked,
	onCheckedChange,
	className,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	className?: string;
}) {
	const checkbox_id = React.useId();

	return (
		<div className={cn("mb-4 flex items-center space-x-2", className)}>
			<Checkbox
				id={checkbox_id}
				checked={checked}
				onCheckedChange={(checked) => onCheckedChange(checked === true)}
				className={cn("ShowArchivedCheckbox-checkbox")}
			/>
			<Label htmlFor={checkbox_id} className={cn("ShowArchivedCheckbox-label", "cursor-pointer text-sm")}>
				Show archived
			</Label>
		</div>
	);
}

// New document button component
function NewDocumentButton() {
	const handle_new_document = () => {
		// TODO: Implement new document creation
		console.log("Creating new document...");
	};

	return (
		<Button
			onClick={handle_new_document}
			className={cn("DocsSidebar-new-button", "w-full justify-start gap-2")}
			variant="outline"
		>
			<Plus className="h-4 w-4" />
			New Document
		</Button>
	);
}

// Props interface for the DocsSidebar content component
interface DocsSidebarContent_Props {
	onClose?: (() => void) | undefined;
}

// Main sidebar content component
function DocsSidebarContent({ onClose }: DocsSidebarContent_Props) {
	const { search_query, set_search_query } = useDocsSearchContext();
	const [show_archived, set_show_archived] = useState(false);

	// Filter documents based on archived status
	const filtered_documents = mock_documents.filter((doc) => show_archived || !doc.is_archived);

	return (
		<div className={cn("DocsSidebarContent", "flex h-full flex-col")}>
			<SidebarHeader className="border-b">
				{/* Close button only if onClose is provided */}
				{onClose && (
					<div className="mb-4 flex items-center justify-between">
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
						Search documents
					</div>
					<input
						placeholder="Search documents..."
						value={search_query}
						onChange={(e) => set_search_query(e.target.value)}
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

				{/* Show Archived Checkbox */}
				<ShowArchivedCheckbox
					checked={show_archived}
					onCheckedChange={set_show_archived}
					className={cn("DocsSidebarContent-archived-filter")}
				/>

				{/* New Document Button */}
				<NewDocumentButton />
			</SidebarHeader>

			<SidebarContent className="flex-1 p-2">
				<div className={cn("DocsSidebarContent-documents-list", "space-y-1")}>
					{filtered_documents.length === 0 ? (
						<div className={cn("DocsSidebarContent-empty-state", "py-8 text-center")}>
							<FileText className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
							<p className="text-sm text-muted-foreground">No documents found</p>
						</div>
					) : (
						filtered_documents.map((document) => <DocumentListItem key={document.id} document={document} />)
					)}
				</div>
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
	);
}
