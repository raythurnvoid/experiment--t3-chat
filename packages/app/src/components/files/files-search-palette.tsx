import "./files-search-palette.css";

import * as Ariakit from "@ariakit/react";
import { useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FileText, Folder, Search } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";

import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyModal, MyModalPopover } from "@/components/my-modal.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { useFilesSearchMetadata } from "@/hooks/files-search-hooks.ts";
import { useDebounce, useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { files_ROOT_ID, files_create_tree_items_list_from_nodes, files_is_node } from "@/lib/files.ts";
import { parse_search_query, search_filter_matches_item } from "@/lib/files-search.ts";
import { app_local_storage_set_value } from "@/lib/storage.ts";
import { cn } from "@/lib/utils.ts";
import { files_search_query_parse, files_search_query_serialize } from "../../../shared/files-search-query.ts";
import { FilesSearchInput } from "./files-search-input.tsx";

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
	| "FilesSearchPalette-item-snippet"
	| "FilesSearchPalette-footer";

const SNIPPET_RADIUS = 60;
const RESULTS_LIMIT = 50;

function files_search_palette_snippet(textChunk: string, query: string) {
	const flatText = textChunk.replace(/\s+/gu, " ").trim();
	const firstTerm = query.trim().split(/\s+/u)[0] ?? "";
	const hitIndex = firstTerm ? flatText.toLowerCase().indexOf(firstTerm.toLowerCase()) : -1;
	const start = hitIndex < 0 ? 0 : Math.max(0, hitIndex - SNIPPET_RADIUS);
	const end = Math.min(flatText.length, start + SNIPPET_RADIUS * 2);
	return `${start > 0 ? "…" : ""}${flatText.slice(start, end)}${end < flatText.length ? "…" : ""}`;
}

const FilesSearchPaletteContent = memo(function FilesSearchPaletteContent(props: { onClose: () => void }) {
	const { onClose } = props;
	const navigate = useNavigate();
	const { organizationName, workspaceName, membershipId } = AppTenantProvider.useContext();
	const [searchQuery, setSearchQuery] = useState("");
	const debouncedQuery = useDebounce(searchQuery, 300);
	const inputRef = useRef<HTMLInputElement>(null);
	const firstResultRef = useRef<HTMLButtonElement>(null);
	const resultsRef = useRef<HTMLDivElement>(null);
	const treeNodes = useQuery(app_convex_api.files_nodes.list_tree, { membershipId });
	const treeItems = useMemo(
		() => (treeNodes ? files_create_tree_items_list_from_nodes(treeNodes) : undefined),
		[treeNodes],
	);
	const {
		searchMetadataNodeIds,
		isSearchLoading: isMetadataLoading,
		isSearchFailed: isMetadataFailed,
	} = useFilesSearchMetadata(membershipId, debouncedQuery, treeItems);
	const parsed = useMemo(() => files_search_query_parse(debouncedQuery), [debouncedQuery]);
	const text = `${parsed.text.replace(/"/gu, "").trim()}`;
	const textQuery = parse_search_query(text);
	const hasFilters = parsed.filters.length > 0;
	const hasInvalidFilter = parsed.filters.some((filter) => filter.problem !== null);
	const hasMetadata = parsed.filters.some((filter) => filter.key.namespace !== "file");
	const isActive = searchQuery.trim().length > 0;

	const candidates = useMemo(
		() =>
			(treeItems ?? []).filter(
				(item) =>
					files_is_node(item) &&
					item.archiveOperationId === undefined &&
					(!hasMetadata || item.kind === "file") &&
					!hasInvalidFilter &&
					parsed.filters.every(
						(filter) => search_filter_matches_item({ filter, item, metadataNodeIds: searchMetadataNodeIds }) === true,
					),
			),
		[treeItems, hasMetadata, hasInvalidFilter, parsed.filters, searchMetadataNodeIds],
	);
	// Filter the content query before its page limit, including when no candidate matches.
	const contentNodeIds = useMemo(
		() =>
			hasFilters
				? candidates
						.filter(files_is_node)
						.filter((item) => item.kind === "file")
						.map((item) => item._id)
				: undefined,
		[hasFilters, candidates],
	);
	const canSearchContent =
		text.length >= 2 &&
		text.length <= 200 &&
		!hasInvalidFilter &&
		!isMetadataLoading &&
		!isMetadataFailed &&
		treeItems !== undefined;
	// Convex useQueries needs a stable object to avoid resubscribing during render.
	const contentQueries = useMemo(
		() => ({
			...(canSearchContent
				? {
						content: {
							query: app_convex_api.files_nodes.search_content,
							args: { membershipId, query: text, ...(contentNodeIds === undefined ? {} : { nodeIds: contentNodeIds }) },
						},
					}
				: {}),
		}),
		[canSearchContent, membershipId, text, contentNodeIds],
	);
	const contentResponse: FunctionReturnType<typeof app_convex_api.files_nodes.search_content> | Error | undefined =
		useQueries(contentQueries).content;
	const isFailed = isMetadataFailed || contentResponse instanceof Error;
	const isLoading =
		isActive &&
		(searchQuery !== debouncedQuery ||
			treeItems === undefined ||
			isMetadataLoading ||
			(canSearchContent && contentResponse === undefined));
	const contentResults = contentResponse instanceof Error ? [] : (contentResponse?.results ?? []);
	const resultsById = new Map<
		app_convex_Id<"files_nodes">,
		{
			nodeId: app_convex_Id<"files_nodes">;
			path: string;
			kind: "file" | "folder";
			snippet?: string;
			matchCount?: number;
		}
	>();
	for (const item of candidates) {
		if (!files_is_node(item)) continue;
		const matchesText =
			text.length === 0
				? hasFilters
				: textQuery.mode === "node"
					? item._id === textQuery.value
					: textQuery.mode === "path"
						? item.path.toLowerCase().includes(textQuery.value)
						: item.name.toLowerCase().includes(textQuery.value);
		if (matchesText) resultsById.set(item._id, { nodeId: item._id, path: item.path, kind: item.kind });
	}
	for (const result of contentResults) {
		resultsById.set(result.nodeId, {
			...result,
			kind: "file",
			snippet: files_search_palette_snippet(result.textChunk, text),
		});
	}
	const results =
		isLoading || isFailed || hasInvalidFilter || !isActive ? [] : [...resultsById.values()].slice(0, RESULTS_LIMIT);

	const handleSelectResult = useFn((nodeId: app_convex_Id<"files_nodes">) => {
		onClose();
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: (previous) => ({ q: previous.q, nodeId }),
		}).catch((error) =>
			console.error("[FilesSearchPalette.handleSelectResult] Failed to open file", { error, nodeId }),
		);
	});

	const handleUseFilters = useFn(() => {
		const q = files_search_query_serialize({ filters: parsed.filters, text: "" });
		app_local_storage_set_value("app_state::sidebar::files_open", true);
		onClose();
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: (previous) => ({ ...previous, nodeId: previous.nodeId ?? files_ROOT_ID, q }),
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
					treeItemsList={treeItems}
					isSearchLoading={isLoading}
					isSearchFailed={isFailed}
					searchMatchCount={isActive ? results.length : null}
					onSearchQueryChange={setSearchQuery}
					onNavigateResults={() => firstResultRef.current?.focus()}
					onSubmit={(query) => {
						if (query !== debouncedQuery || isLoading) return false;
						if (results[0]) handleSelectResult(results[0].nodeId);
						return true;
					}}
				/>
			</div>
			<Ariakit.CompositeProvider orientation="vertical" focusLoop={false}>
				<Ariakit.Composite
					ref={resultsRef}
					role="list"
					aria-label="Search results"
					aria-busy={isLoading}
					className={cn(
						"FilesSearchPalette-list" satisfies FilesSearchPalette_ClassNames,
						"app-scrollable" satisfies AppClassName,
					)}
				>
					{!isActive || isLoading || isFailed || hasInvalidFilter || results.length === 0 ? (
						<div className={cn("FilesSearchPalette-state" satisfies FilesSearchPalette_ClassNames)} role="status">
							{!isActive ? (
								"Search file names and contents, or choose a filter."
							) : isLoading ? (
								<MySpinner />
							) : isFailed ? (
								"Search failed. Try changing your query."
							) : hasInvalidFilter ? (
								"Fix or remove the invalid filter to search."
							) : (
								"No matching files"
							)}
						</div>
					) : (
						results.map((result, index) => (
							<div role="listitem" key={result.nodeId}>
								<Ariakit.CompositeItem
									render={<MyButton variant="ghost-highlightable" />}
									ref={index === 0 ? firstResultRef : undefined}
									className={cn("FilesSearchPalette-item" satisfies FilesSearchPalette_ClassNames)}
									onClick={() => handleSelectResult(result.nodeId)}
									onKeyDown={(event) => {
										if (index === 0 && event.key === "ArrowUp") {
											event.preventDefault();
											inputRef.current?.focus();
										}
									}}
								>
									{result.kind === "folder" ? (
										<Folder className={cn("FilesSearchPalette-item-icon" satisfies FilesSearchPalette_ClassNames)} />
									) : (
										<FileText className={cn("FilesSearchPalette-item-icon" satisfies FilesSearchPalette_ClassNames)} />
									)}
									<span className={cn("FilesSearchPalette-item-name" satisfies FilesSearchPalette_ClassNames)}>
										{result.path.slice(result.path.lastIndexOf("/") + 1)}
									</span>
									{result.matchCount && result.matchCount > 1 ? (
										<span className={cn("FilesSearchPalette-item-count" satisfies FilesSearchPalette_ClassNames)}>
											{result.matchCount} matches
										</span>
									) : null}
									<span className={cn("FilesSearchPalette-item-path" satisfies FilesSearchPalette_ClassNames)}>
										{result.path}
									</span>
									{result.snippet ? (
										<span className={cn("FilesSearchPalette-item-snippet" satisfies FilesSearchPalette_ClassNames)}>
											{result.snippet}
										</span>
									) : null}
								</Ariakit.CompositeItem>
							</div>
						))
					)}
				</Ariakit.Composite>
			</Ariakit.CompositeProvider>
			<div className={cn("FilesSearchPalette-footer" satisfies FilesSearchPalette_ClassNames)}>
				<span>
					{resultsById.size > RESULTS_LIMIT
						? "First 50 results · Add a filter to narrow your search"
						: "↑ ↓ Navigate · Enter Open · Esc Close"}
				</span>
				{hasFilters && !hasInvalidFilter ? (
					<MyButton variant="ghost-highlightable" disabled={isLoading || isFailed} onClick={handleUseFilters}>
						Use filters in sidebar
					</MyButton>
				) : null}
			</div>
		</>
	);
});

const FilesSearchPalette = memo(function FilesSearchPalette() {
	const [isOpen, setIsOpen] = useState(false);
	AppHotkeysProvider.useHotkey(
		"Mod+Shift+F",
		useFn(() => setIsOpen(true)),
		{ ignoreInputs: false },
	);
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
