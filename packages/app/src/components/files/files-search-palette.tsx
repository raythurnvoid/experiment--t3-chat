import "./files-search-palette.css";

import * as Ariakit from "@ariakit/react";
import { useNavigate } from "@tanstack/react-router";
import { FileText, Folder, Search } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";

import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyModal, MyModalPopover } from "@/components/my-modal.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { useFilesSearchSaved, type FilesSearchSavedList } from "@/hooks/files-search-hooks.ts";
import { useDebounce, useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { files_ROOT_ID } from "@/lib/files.ts";
import { detect_search_query_mode, search_free_text } from "@/lib/files-search.ts";
import { path_name_of } from "@/lib/paths.ts";
import { app_local_storage_set_value } from "@/lib/storage.ts";
import { url_parse_file_link } from "@/lib/urls.ts";
import { cn } from "@/lib/utils.ts";
import { files_search_query_parse, files_search_query_serialize } from "../../../shared/files-search-query.ts";
import { FilesSearchInput } from "./files-search-input.tsx";

const SNIPPET_RADIUS = 60;

function files_search_palette_snippet(textChunk: string, query: string) {
	const flatText = textChunk.replace(/\s+/gu, " ").trim();
	const firstTerm = query.trim().split(/\s+/u)[0] ?? "";
	const hitIndex = firstTerm ? flatText.toLowerCase().indexOf(firstTerm.toLowerCase()) : -1;
	const start = hitIndex < 0 ? 0 : Math.max(0, hitIndex - SNIPPET_RADIUS);
	const end = Math.min(flatText.length, start + SNIPPET_RADIUS * 2);
	return `${start > 0 ? "…" : ""}${flatText.slice(start, end)}${end < flatText.length ? "…" : ""}`;
}

type FilesSearchPaletteGroup_ClassNames =
	| "FilesSearchPaletteGroup"
	| "FilesSearchPaletteGroup-header"
	| "FilesSearchPaletteGroup-label"
	| "FilesSearchPaletteGroup-count"
	| "FilesSearchPaletteGroup-state"
	| "FilesSearchPaletteGroup-list"
	| "FilesSearchPaletteGroup-item"
	| "FilesSearchPaletteGroup-item-icon"
	| "FilesSearchPaletteGroup-item-name"
	| "FilesSearchPaletteGroup-item-path"
	| "FilesSearchPaletteGroup-item-snippet"
	| "FilesSearchPaletteGroup-more";

type FilesSearchPaletteGroup_CustomAttributes = {
	"data-node-id": string;
};

type FilesSearchPaletteGroup_Props = {
	label: string;
	/**
	 * The search list, or a static text shown in place of its rows.
	 */
	list: FilesSearchSavedList | string;
	/**
	 * The searched words, to cut the snippet of a content row around them.
	 */
	snippetText: string;
	/**
	 * A static text shown under the rows, or null.
	 */
	note: string | null;
	onSelect: (nodeId: string) => void;
};

/**
 * One list of the palette, with its own count and Show more.
 */
const FilesSearchPaletteGroup = memo(function FilesSearchPaletteGroup(props: FilesSearchPaletteGroup_Props) {
	const { label, list, snippetText, note, onSelect } = props;

	const labelId = useId();
	const groupRef = useRef<HTMLDivElement | null>(null);
	// The row ids when Show more was clicked, until its page has loaded.
	const [loadMoreFromIds, setLoadMoreFromIds] = useState<Set<string> | null>(null);

	useEffect(() => {
		if (
			typeof list === "string" ||
			loadMoreFromIds === null ||
			(list.status === "more" && list.rows.length <= loadMoreFromIds.size)
		) {
			return;
		}
		setLoadMoreFromIds(null);
		// While more pages remain, focus stays on Show more. Once it is gone, move focus to the first new
		// row. Leave focus alone when the user has moved it out of the group while the page loaded.
		const activeElement = document.activeElement;
		if (list.status === "more" || (activeElement !== document.body && !groupRef.current?.contains(activeElement))) {
			return;
		}
		const firstNewRow = list.rows.find((row) => !loadMoreFromIds.has(row.nodeId)) ?? list.rows.at(-1);
		if (firstNewRow) {
			groupRef.current
				?.querySelector<HTMLElement>(
					`[${"data-node-id" satisfies keyof FilesSearchPaletteGroup_CustomAttributes}="${firstNewRow.nodeId}"]`,
				)
				?.focus();
		}
	}, [list, loadMoreFromIds]);

	const handleLoadMoreClick = useFn(() => {
		if (typeof list === "string") {
			return;
		}
		setLoadMoreFromIds(new Set(list.rows.map((row) => row.nodeId)));
		list.loadMore();
	});

	const hasRows = typeof list !== "string" && list.status !== "loading" && list.problem === null;

	return (
		<div
			ref={groupRef}
			role="group"
			aria-labelledby={labelId}
			aria-busy={typeof list !== "string" && list.status === "loading"}
			className={"FilesSearchPaletteGroup" satisfies FilesSearchPaletteGroup_ClassNames}
		>
			<div className={"FilesSearchPaletteGroup-header" satisfies FilesSearchPaletteGroup_ClassNames}>
				<span id={labelId} className={"FilesSearchPaletteGroup-label" satisfies FilesSearchPaletteGroup_ClassNames}>
					{label}
				</span>
				{hasRows ? (
					<span className={"FilesSearchPaletteGroup-count" satisfies FilesSearchPaletteGroup_ClassNames}>
						{list.rows.length}
						{list.status === "more" ? "+" : ""} {list.rows.length === 1 && list.status === "done" ? "match" : "matches"}
					</span>
				) : null}
			</div>
			{typeof list === "string" ? (
				<p className={"FilesSearchPaletteGroup-state" satisfies FilesSearchPaletteGroup_ClassNames}>{list}</p>
			) : list.status === "loading" ? (
				<div className={"FilesSearchPaletteGroup-state" satisfies FilesSearchPaletteGroup_ClassNames}>
					<MySpinner />
				</div>
			) : list.problem !== null ? (
				<p className={"FilesSearchPaletteGroup-state" satisfies FilesSearchPaletteGroup_ClassNames}>{list.problem}</p>
			) : list.rows.length === 0 && list.status === "done" ? (
				<p className={"FilesSearchPaletteGroup-state" satisfies FilesSearchPaletteGroup_ClassNames}>
					No matching files
				</p>
			) : (
				<div role="list" className={"FilesSearchPaletteGroup-list" satisfies FilesSearchPaletteGroup_ClassNames}>
					{list.rows.map((row) => (
						<div role="listitem" key={row.nodeId}>
							<Ariakit.CompositeItem
								render={<MyButton variant="ghost-highlightable" />}
								className={"FilesSearchPaletteGroup-item" satisfies FilesSearchPaletteGroup_ClassNames}
								{...({ "data-node-id": row.nodeId } satisfies FilesSearchPaletteGroup_CustomAttributes)}
								onClick={() => onSelect(row.nodeId)}
							>
								{row.kind === "folder" ? (
									<Folder
										className={"FilesSearchPaletteGroup-item-icon" satisfies FilesSearchPaletteGroup_ClassNames}
									/>
								) : (
									<FileText
										className={"FilesSearchPaletteGroup-item-icon" satisfies FilesSearchPaletteGroup_ClassNames}
									/>
								)}
								<span className={"FilesSearchPaletteGroup-item-name" satisfies FilesSearchPaletteGroup_ClassNames}>
									{path_name_of(row.path)}
								</span>
								<span className={"FilesSearchPaletteGroup-item-path" satisfies FilesSearchPaletteGroup_ClassNames}>
									{row.path}
								</span>
								{row.textChunk ? (
									<span className={"FilesSearchPaletteGroup-item-snippet" satisfies FilesSearchPaletteGroup_ClassNames}>
										{files_search_palette_snippet(row.textChunk, snippetText)}
									</span>
								) : null}
							</Ariakit.CompositeItem>
						</div>
					))}
				</div>
			)}
			{hasRows && list.isTopMatches ? (
				<p className={"FilesSearchPaletteGroup-state" satisfies FilesSearchPaletteGroup_ClassNames}>
					Showing the top 1,024 matches. Add more words to narrow the search.
				</p>
			) : null}
			{hasRows && note !== null ? (
				<p className={"FilesSearchPaletteGroup-state" satisfies FilesSearchPaletteGroup_ClassNames}>{note}</p>
			) : null}
			{typeof list !== "string" && list.status === "more" ? (
				<Ariakit.CompositeItem
					render={<MyButton variant="ghost" />}
					className={"FilesSearchPaletteGroup-more" satisfies FilesSearchPaletteGroup_ClassNames}
					aria-busy={list.isLoadingMore}
					// Focus stays on Show more while its page loads.
					disabled={list.isLoadingMore}
					accessibleWhenDisabled
					onClick={handleLoadMoreClick}
				>
					Show more
				</Ariakit.CompositeItem>
			) : null}
		</div>
	);
});

type FilesSearchPalette_ClassNames =
	| "FilesSearchPalette"
	| "FilesSearchPalette-input"
	| "FilesSearchPalette-list"
	| "FilesSearchPalette-state"
	| "FilesSearchPalette-footer";

const FilesSearchPaletteContent = memo(function FilesSearchPaletteContent(props: { onClose: () => void }) {
	const { onClose } = props;
	const navigate = useNavigate();
	const { organizationName, workspaceName, membershipId } = AppTenantProvider.useContext();
	const [searchQuery, setSearchQuery] = useState("");
	const debouncedQuery = useDebounce(searchQuery, 300);
	const inputRef = useRef<HTMLInputElement>(null);
	const resultsRef = useRef<HTMLDivElement>(null);
	const search = useFilesSearchSaved({ membershipId, searchQuery: debouncedQuery, withContents: true });
	const parsed = files_search_query_parse(debouncedQuery);
	const text = search_free_text(parsed.text);
	const hasFilters = parsed.filters.length > 0;
	const hasInvalidFilter = search.mode === "invalid";
	const isActive = searchQuery.trim().length > 0;
	const isDebouncing = searchQuery !== debouncedQuery;
	const lists = [search.names, ...(search.contents === null || search.contents === "folder" ? [] : [search.contents])];
	const isSearching = search.mode === "search";
	const isLoading = isActive && (isDebouncing || (isSearching && lists.some((list) => list.status === "loading")));
	const hasMoreMatches = isSearching && lists.some((list) => list.status === "more");

	// The first row or Show more, in list order.
	const getFirstResultElement = () =>
		resultsRef.current?.querySelector<HTMLElement>(
			`.${"FilesSearchPaletteGroup-item" satisfies FilesSearchPaletteGroup_ClassNames}, .${"FilesSearchPaletteGroup-more" satisfies FilesSearchPaletteGroup_ClassNames}`,
		);

	const handleSelectResult = useFn((nodeId: string) => {
		onClose();
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: (previous) => ({ q: previous.q, nodeId }),
		}).catch((error) =>
			console.error("[FilesSearchPalette.handleSelectResult] Failed to open file", { error, nodeId }),
		);
	});

	const handleOpenDraft = useFn((pendingNodeId: string) => {
		onClose();
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: (previous) => ({ q: previous.q, pendingNodeId }),
		}).catch((error) =>
			console.error("[FilesSearchPalette.handleOpenDraft] Failed to open draft", { error, pendingNodeId }),
		);
	});

	const handleOpenPath = useFn((path: string) => {
		onClose();
		navigate({
			to: "/w/$organizationName/$workspaceName/files/$",
			params: { organizationName, workspaceName, _splat: path },
		}).catch((error) => console.error("[FilesSearchPalette.handleOpenPath] Failed to open path", { error, path }));
	});

	const handleUseFilters = useFn(() => {
		const q = files_search_query_serialize({ filters: parsed.filters, text: "" });
		app_local_storage_set_value("app_state::sidebar::files_open", true);
		onClose();
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: (previous) => ({ ...previous, nodeId: previous.nodeId ?? files_ROOT_ID, pendingNodeId: undefined, q }),
		}).catch((error) => console.error("[FilesSearchPalette.handleUseFilters] Failed to open filtered tree", { error }));
	});

	return (
		<>
			<div className={cn("FilesSearchPalette-input" satisfies FilesSearchPalette_ClassNames)}>
				<FilesSearchInput
					initialQuery=""
					variant="palette"
					inputRef={inputRef}
					resultsRef={resultsRef}
					isSearchLoading={isLoading}
					// A file can match by name and by contents, so count it once.
					searchMatchCount={
						isActive && isSearching ? new Set(lists.flatMap((list) => list.rows.map((row) => row.nodeId))).size : null
					}
					hasMoreMatches={hasMoreMatches}
					onSearchQueryChange={setSearchQuery}
					onNavigateResults={() => getFirstResultElement()?.focus()}
					onSubmit={(query) => {
						// A pasted draft link, a link with a path, or a typed path acts on the live text at once,
						// like the sidebar. A link with a node id waits for the search, which checks the node is
						// in this workspace.
						const link = url_parse_file_link(query.trim());
						if (link && "pendingNodeId" in link) {
							handleOpenDraft(link.pendingNodeId);
							return true;
						}
						const liveQuery = files_search_query_parse(query);
						const liveText = search_free_text(liveQuery.text);
						const liveTextQuery = liveText.length > 0 ? detect_search_query_mode(liveText) : null;
						if (liveQuery.filters.length === 0 && liveTextQuery?.mode === "path") {
							handleOpenPath(liveTextQuery.value);
							return true;
						}
						if (query !== debouncedQuery) return false;
						// Enter opens the first name match, or the one node an exact path or id names.
						if (search.names.status === "loading") return false;
						const firstRow = search.names.rows[0];
						if (firstRow) handleSelectResult(firstRow.nodeId);
						return true;
					}}
				/>
			</div>
			<Ariakit.CompositeProvider orientation="vertical" focusLoop={false}>
				<Ariakit.Composite
					ref={resultsRef}
					role="group"
					aria-label="Search results"
					aria-busy={isLoading}
					className={cn(
						"FilesSearchPalette-list" satisfies FilesSearchPalette_ClassNames,
						"app-scrollable" satisfies AppClassName,
					)}
					onKeyDown={(event) => {
						// Up from the first result goes back to the input.
						if (event.key === "ArrowUp" && event.target === getFirstResultElement()) {
							event.preventDefault();
							inputRef.current?.focus();
						}
					}}
				>
					{!isActive || isDebouncing || !isSearching ? (
						<div className={cn("FilesSearchPalette-state" satisfies FilesSearchPalette_ClassNames)} role="status">
							{!isActive ? (
								"Search file names and contents, or choose a filter."
							) : isDebouncing ? (
								<MySpinner />
							) : hasInvalidFilter ? (
								"Fix or remove the invalid filter to search."
							) : (
								"This is a link to a draft. Press Enter to open it."
							)}
						</div>
					) : (
						<>
							<FilesSearchPaletteGroup
								label={search.contents === null ? "Matches" : "Names"}
								list={search.names}
								snippetText={text}
								note={search.isFolderDate ? "In a folder, a date matches only values written the same way." : null}
								onSelect={handleSelectResult}
							/>
							{search.contents !== null ? (
								<FilesSearchPaletteGroup
									label="Contents"
									list={
										search.contents === "folder"
											? "Contents search does not work inside a folder. Remove the folder to search contents."
											: search.contents
									}
									snippetText={text}
									note={null}
									onSelect={handleSelectResult}
								/>
							) : null}
						</>
					)}
				</Ariakit.Composite>
			</Ariakit.CompositeProvider>
			<div className={cn("FilesSearchPalette-footer" satisfies FilesSearchPalette_ClassNames)}>
				<span>
					{hasMoreMatches
						? "More matches may be available · Add more words to narrow the search"
						: "↑ ↓ Navigate · Enter Open · Esc Close"}
				</span>
				{hasFilters && !hasInvalidFilter ? (
					<MyButton variant="ghost-highlightable" disabled={isLoading} onClick={handleUseFilters}>
						Use filters in sidebar
					</MyButton>
				) : null}
			</div>
		</>
	);
});

const FilesSearchPalette = memo(function FilesSearchPalette() {
	const [isOpen, setIsOpen] = useState(false);
	AppHotkeysProvider.useHotkey({
		hotkey: "Mod+Shift+F",
		callback: useFn(() => setIsOpen(true)),
		options: { ignoreInputs: false },
	});
	return (
		<>
			<MyIconButton variant="ghost-highlightable" tooltip="Search files (Ctrl+Shift+F)" onClick={() => setIsOpen(true)}>
				<MyIconButtonIcon>
					<Search />
				</MyIconButtonIcon>
			</MyIconButton>
			<MyModal open={isOpen} setOpen={setIsOpen}>
				<MyModalPopover
					aria-label="Search files"
					unmountOnHide
					className={cn("FilesSearchPalette" satisfies FilesSearchPalette_ClassNames)}
				>
					<FilesSearchPaletteContent onClose={() => setIsOpen(false)} />
				</MyModalPopover>
			</MyModal>
		</>
	);
});

export { FilesSearchPalette };
