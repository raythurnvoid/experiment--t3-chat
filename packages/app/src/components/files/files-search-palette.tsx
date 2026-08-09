import "./files-search-palette.css";

import * as Ariakit from "@ariakit/react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { FileText, Search } from "lucide-react";
import { memo, useState } from "react";

import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { MyModal, MyModalPopover } from "@/components/my-modal.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { useDebounce, useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

type FilesSearchPalette_ClassNames =
	| "FilesSearchPalette"
	| "FilesSearchPalette-input"
	| "FilesSearchPalette-list"
	| "FilesSearchPalette-state"
	| "FilesSearchPalette-item"
	| "FilesSearchPalette-item-icon"
	| "FilesSearchPalette-item-name"
	| "FilesSearchPalette-item-count"
	| "FilesSearchPalette-item-path"
	| "FilesSearchPalette-item-snippet";

const SNIPPET_RADIUS = 60;

/**
 * Cut roughly 120 characters around the first query-term hit, so the row shows why the file
 * matched without rendering the whole 1200-character chunk.
 */
function files_search_palette_snippet(markdownChunk: string, query: string) {
	const flatText = markdownChunk.replace(/\s+/gu, " ").trim();
	const firstTerm = query.trim().split(/\s+/u)[0] ?? "";
	const hitIndex = firstTerm ? flatText.toLowerCase().indexOf(firstTerm.toLowerCase()) : -1;

	const start = hitIndex < 0 ? 0 : Math.max(0, hitIndex - SNIPPET_RADIUS);
	const end = Math.min(flatText.length, start + SNIPPET_RADIUS * 2);
	return `${start > 0 ? "…" : ""}${flatText.slice(start, end)}${end < flatText.length ? "…" : ""}`;
}

function files_search_palette_file_name(path: string) {
	return path.slice(path.lastIndexOf("/") + 1);
}

const FilesSearchPalette = memo(function FilesSearchPalette() {
	const navigate = useNavigate();
	const { organizationName, workspaceName, membershipId } = AppTenantProvider.useContext();

	const [isOpen, setIsOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const debouncedQuery = useDebounce(searchQuery, 300);

	// The live value decides which state the list shows; the debounced value drives the server
	// query so typing does not fire one request per keystroke.
	const liveQuery = searchQuery.trim();
	const serverQuery = debouncedQuery.trim();
	const searchResult = useQuery(
		app_convex_api.files_nodes.search_content,
		isOpen && serverQuery.length >= 2 ? { membershipId, query: serverQuery } : "skip",
	);
	const results = serverQuery.length >= 2 ? searchResult?.results : undefined;

	const handleOpenChange = useFn((open: boolean) => {
		setIsOpen(open);
		if (!open) {
			setSearchQuery("");
		}
	});

	const handleSelectResult = useFn((nodeId: app_convex_Id<"files_nodes">) => {
		handleOpenChange(false);
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: { nodeId },
		}).catch((error) => {
			console.error("[FilesSearchPalette.handleSelectResult] Error navigating to file", { error, nodeId });
		});
	});

	// `ignoreInputs: false` keeps the shortcut working while the editor or another input has
	// focus, which is where users are when they want to search.
	AppHotkeysProvider.useHotkey(
		"Mod+Shift+F",
		useFn(() => {
			setIsOpen(true);
		}),
		{ ignoreInputs: false },
	);

	return (
		<>
			<MyIconButton
				variant="ghost-highlightable"
				tooltip="Search file contents (Ctrl+Shift+F)"
				onClick={() => setIsOpen(true)}
			>
				<MyIconButtonIcon>
					<Search />
				</MyIconButtonIcon>
			</MyIconButton>

			<MyModal open={isOpen} setOpen={handleOpenChange}>
				<MyModalPopover
					aria-label="Search file contents"
					unmountOnHide
					className={cn("FilesSearchPalette" satisfies FilesSearchPalette_ClassNames)}
				>
					{/* The list below is always visible, so pin the combobox open. Otherwise the store
					    starts closed: the first ArrowDown only "opens" it and autoSelect never
					    highlights the first result while typing. */}
					<Ariakit.ComboboxProvider open value={searchQuery} setValue={setSearchQuery}>
						<div className={cn("FilesSearchPalette-input" satisfies FilesSearchPalette_ClassNames)}>
							<MyInput variant="floating">
								<MyInputBackground />
								<MyInputArea>
									<Ariakit.Combobox
										autoFocus
										autoSelect
										aria-label="Search file contents"
										placeholder="Search file contents…"
										render={(comboboxProps) => {
											const { className: comboboxClassName, id: _comboboxId, ...comboboxRest } = comboboxProps;
											return <MyInputControl className={cn(comboboxClassName)} {...comboboxRest} />;
										}}
									/>
								</MyInputArea>
								<MyInputBox />
							</MyInput>
						</div>

						<Ariakit.ComboboxList
							aria-label="Search results"
							className={cn(
								"FilesSearchPalette-list" satisfies FilesSearchPalette_ClassNames,
								"app-scrollable" satisfies AppClassName,
							)}
						>
							{liveQuery.length < 2 ? (
								<div className={cn("FilesSearchPalette-state" satisfies FilesSearchPalette_ClassNames)}>
									Type to search file contents
								</div>
							) : results === undefined ? (
								<div className={cn("FilesSearchPalette-state" satisfies FilesSearchPalette_ClassNames)}>
									<MySpinner />
								</div>
							) : results.length === 0 ? (
								<div className={cn("FilesSearchPalette-state" satisfies FilesSearchPalette_ClassNames)}>
									No matches
								</div>
							) : (
								results.map((result) => (
									<Ariakit.ComboboxItem
										key={result.nodeId}
										value={result.path}
										focusOnHover
										setValueOnClick={false}
										className={cn("FilesSearchPalette-item" satisfies FilesSearchPalette_ClassNames)}
										onClick={() => handleSelectResult(result.nodeId)}
									>
										<FileText className={cn("FilesSearchPalette-item-icon" satisfies FilesSearchPalette_ClassNames)} />
										<span className={cn("FilesSearchPalette-item-name" satisfies FilesSearchPalette_ClassNames)}>
											{files_search_palette_file_name(result.path)}
										</span>
										{/* The count covers the fetched pages only, so never call it a total. */}
										{result.matchCount > 1 ? (
											<span className={cn("FilesSearchPalette-item-count" satisfies FilesSearchPalette_ClassNames)}>
												{result.matchCount} matches
											</span>
										) : null}
										<span className={cn("FilesSearchPalette-item-path" satisfies FilesSearchPalette_ClassNames)}>
											{result.path}
										</span>
										<span className={cn("FilesSearchPalette-item-snippet" satisfies FilesSearchPalette_ClassNames)}>
											{files_search_palette_snippet(result.markdownChunk, serverQuery)}
										</span>
									</Ariakit.ComboboxItem>
								))
							)}
						</Ariakit.ComboboxList>

						<div role="status" className="sr-only">
							{results === undefined ? "" : results.length === 1 ? "1 result" : `${results.length} results`}
						</div>
					</Ariakit.ComboboxProvider>
				</MyModalPopover>
			</MyModal>
		</>
	);
});

export { FilesSearchPalette };
