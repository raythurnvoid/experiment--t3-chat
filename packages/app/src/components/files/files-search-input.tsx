import "./files-search-input.css";
import React, { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { useConvex, useQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyChip,
	MyChipLabel,
	MyChipRemove,
	MyChipRow,
	type MyChipRemove_CustomAttributes,
} from "@/components/my-chip.tsx";
import {
	MyCombobox,
	MyComboboxGroup,
	MyComboboxInputControl,
	MyComboboxItem,
	MyComboboxList,
	MyComboboxPopover,
	MyComboboxPopoverContent,
	MyComboboxPopoverScrollableArea,
	type MyCombobox_Props,
	type MyComboboxInputControl_Props,
} from "@/components/my-combobox.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputIcon,
	type MyInputArea_Props,
} from "@/components/my-input.tsx";
import { useDebounce, useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { files_TreeItem } from "@/lib/files.ts";
import { cn } from "@/lib/utils.ts";
import {
	files_metadata_FRONTMATTER_FIELD_PREFIX,
	files_metadata_METADATA_FIELD_PREFIX,
	type files_metadata_Value,
} from "../../../shared/files-metadata.ts";
import {
	files_search_query_FILE_FIELDS,
	files_search_query_folder_path,
	files_search_query_format_key,
	files_search_query_format_value,
	files_search_query_parse,
	files_search_query_qualified_fields,
	files_search_query_serialize,
	files_search_query_typing_token,
	type files_search_query_Filter,
	type files_search_query_Key,
} from "../../../shared/files-search-query.ts";

// #region search filter chip
type FilesSearchInputFilterChip_ClassNames =
	| "FilesSearchInputFilterChip"
	| "FilesSearchInputFilterChip-key"
	| "FilesSearchInputFilterChip-invalid";

const FilesSearchInput_FILE_FIELD_LABELS: Record<string, string> = {
	path: "Path",
	name: "Name",
	ext: "Extension",
	kind: "Type",
	updated: "Updated",
};

type FilesSearchInputFilterChip_Props = {
	filter: files_search_query_Filter;
	onRemove: () => void;
};

/**
 * One committed filter. A filter the parser cannot run stays visible as a chip, so the user can
 * read the reason and remove it. The reason is read out with the remove button.
 */
const FilesSearchInputFilterChip = memo(function FilesSearchInputFilterChip(props: FilesSearchInputFilterChip_Props) {
	const { filter, onRemove } = props;

	const problemId = useId();
	const keyLabel =
		filter.key.namespace === "file"
			? (FilesSearchInput_FILE_FIELD_LABELS[filter.key.name] ?? `file.${filter.key.name}`)
			: filter.key.namespace === "any"
				? filter.key.name
				: `${filter.key.namespace}.${filter.key.name}`;
	const valueLabel =
		filter.match.op === "exists"
			? "any value"
			: filter.match.op === "range"
				? `${{ gt: ">", gte: "≥", lt: "<", lte: "≤" }[filter.match.comparator]} ${filter.match.value}`
				: filter.match.op === "prefix"
					? `${filter.match.value}*`
					: filter.match.quoted
						? JSON.stringify(filter.match.value)
						: filter.match.value;

	return (
		<MyChip
			size="compact"
			className={cn(
				"FilesSearchInputFilterChip" satisfies FilesSearchInputFilterChip_ClassNames,
				filter.problem !== null &&
					("FilesSearchInputFilterChip-invalid" satisfies FilesSearchInputFilterChip_ClassNames),
			)}
			title={filter.problem === null ? filter.raw : `${filter.raw}: ${filter.problem}`}
		>
			<MyChipLabel>
				<span className={cn("FilesSearchInputFilterChip-key" satisfies FilesSearchInputFilterChip_ClassNames)}>
					{filter.negated ? "Not " : ""}
					{keyLabel}
				</span>{" "}
				{valueLabel}
			</MyChipLabel>
			{filter.problem !== null ? (
				<span id={problemId} className="sr-only">
					{filter.problem}
				</span>
			) : null}
			<MyChipRemove
				tooltip={`Remove filter ${filter.raw}`}
				aria-describedby={filter.problem !== null ? problemId : undefined}
				onClick={onRemove}
			>
				<X />
			</MyChipRemove>
		</MyChip>
	);
});
// #endregion search filter chip

// #region search
type FilesSearchInput_ClassNames =
	| "FilesSearchInput"
	| "FilesSearchInput-area"
	| "FilesSearchInput-filters"
	| "FilesSearchInput-filter-button"
	| "FilesSearchInput-summary"
	| "FilesSearchInput-clear"
	| "FilesSearchInput-error"
	| "FilesSearchInput-popover"
	| "FilesSearchInput-popover-scrollable-area"
	| "FilesSearchInput-suggestion"
	| "FilesSearchInput-suggestion-label"
	| "FilesSearchInput-suggestion-hint"
	| "FilesSearchInput-syntax";

export type FilesSearchInput_Props = {
	initialQuery: string;
	id?: string;
	variant?: "sidebar" | "palette";
	inputRef?: React.RefObject<HTMLInputElement | null>;
	resultsRef?: React.RefObject<HTMLElement | null>;
	onNavigateResults?: () => void;
	treeItemsList: files_TreeItem[] | undefined;
	isSearchLoading: boolean;
	isSearchFailed: boolean;
	/**
	 * Direct matches of the current query, or null while no search is active.
	 */
	searchMatchCount: number | null;
	onSearchQueryChange: (searchQuery: string) => void;
	/**
	 * Open the node the query identifies. Returns false while the metadata results are not in
	 * yet, so the box can tell the user to press Enter again.
	 */
	onSubmit: (searchQuery: string) => boolean;
};

const FilesSearchInput_SUGGESTIONS_MAX_ROWS = 40;

const FilesSearchInput_VALUE_KIND_LABELS = {
	string: "text",
	number: "number",
	boolean: "boolean",
	maybe_date: "date",
} satisfies Record<files_metadata_Value["valueKind"], string>;

/**
 * Write a parsed key back the way the user typed it, so a picked value keeps the `frontmatter.`
 * or `metadata.` spelling the user chose.
 */
function search_key_text(key: files_search_query_Key) {
	return files_search_query_format_key(key.namespace === "any" ? key.name : `${key.namespace}.${key.name}`);
}

/**
 * Search box with filter chips and suggestions.
 *
 * The URL `q` param holds one string. The box splits it into committed `key:value` chips and the
 * free text, and joins them back for every change. Enter and Space commit the filters typed in
 * the text. Enter with no filter opens the one node the free text identifies.
 */
export const FilesSearchInput = memo(function FilesSearchInput(props: FilesSearchInput_Props) {
	const {
		initialQuery,
		id,
		variant = "sidebar",
		onNavigateResults,
		treeItemsList,
		isSearchLoading,
		isSearchFailed,
		searchMatchCount,
		onSearchQueryChange,
		onSubmit,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();

	const [filters, setFilters] = useState(() => files_search_query_parse(initialQuery).filters);
	const [text, setText] = useState(() => files_search_query_parse(initialQuery).text);
	const [announcement, setAnnouncement] = useState("");
	const [isFocused, setIsFocused] = useState(false);
	const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
	const [previousQuery, setPreviousQuery] = useState(initialQuery);
	const [searchFields, setSearchFields] = useState<FunctionReturnType<
		typeof app_convex_api.files_metadata.list_search_fields
	> | null>(null);

	const localInputRef = useRef<HTMLInputElement>(null);
	const inputRef = props.inputRef ?? localInputRef;
	const chipRowRef = useRef<HTMLUListElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const suggestionsRef = useRef<HTMLDivElement>(null);
	const suggestionsId = useId();

	const searchQuery = files_search_query_serialize({ filters, text });
	const searchQueryDebounced = useDebounce(searchQuery, variant === "sidebar" ? 300 : 0);

	if (previousQuery !== initialQuery) {
		setPreviousQuery(initialQuery);
		if (initialQuery !== searchQueryDebounced) {
			const parsed = files_search_query_parse(initialQuery);
			setFilters(parsed.filters);
			setText(parsed.text);
		}
	}

	// The token being typed decides the suggestions: keys while it has no colon, values after it.
	const typing = files_search_query_typing_token(text);
	const typingFilter = files_search_query_parse(typing.token).filters[0] ?? null;
	// A typed namespace narrows the key rows to that metadata kind, and an opening quote is the
	// start of a quoted key, not part of its name.
	const typedNamespace = /^!?(frontmatter|metadata)\./u.exec(typing.token)?.[1] ?? null;
	const typedKey = typing.token.replace(/^!?"?(?:frontmatter\.|metadata\.)?"?/u, "").toLowerCase();
	const typedValue =
		typingFilter === null || typingFilter.match.op === "exists" || typingFilter.match.op === "range"
			? ""
			: typingFilter.match.value;
	const typedValueDebounced = useDebounce(typedValue, 150);

	// Fold the two metadata kinds into one row per bare key: the user types `status`, not
	// `frontmatter.status`, and the row says where the key was found.
	const catalogKeys = ((/* iife */) => {
		const byName = new Map<
			string,
			{ name: string; metadataKinds: string[]; valueKinds: Set<files_metadata_Value["valueKind"]> }
		>();
		for (const field of searchFields ?? []) {
			const metadataKind = field.qualifiedField.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX)
				? "frontmatter"
				: "metadata";
			const bareName = field.qualifiedField.slice(
				metadataKind === "frontmatter"
					? files_metadata_FRONTMATTER_FIELD_PREFIX.length
					: files_metadata_METADATA_FIELD_PREFIX.length,
			);
			// A key named like a namespace (`file`, `metadata`, `frontmatter.x`) would read as that
			// namespace when typed bare, so its row keeps its own namespace.
			const name = /^(?:file|frontmatter|metadata)(?:\.|$)/u.test(bareName) ? field.qualifiedField : bareName;

			const row = byName.get(name) ?? { name, metadataKinds: [], valueKinds: new Set() };
			row.metadataKinds.push(metadataKind);
			for (const valueKind of field.valueKinds) {
				row.valueKinds.add(valueKind);
			}
			byName.set(name, row);
		}

		return [...byName.values()];
	})();

	// A key that holds a colon, like `slack:message-id`, reads as the key `slack` plus a value while
	// it is typed. The key rows keep listing it as long as a catalog key contains the typed text.
	const matchingKeys = catalogKeys
		.filter(
			(key) =>
				key.name.toLowerCase().includes(typedKey) &&
				(typedNamespace === null || key.metadataKinds.includes(typedNamespace)),
		)
		.slice(0, FilesSearchInput_SUGGESTIONS_MAX_ROWS);
	const matchingFileFields =
		typingFilter === null && typedNamespace === null
			? files_search_query_FILE_FIELDS.map((field) => `file.${field}`).filter((field) => field.includes(typedKey))
			: [];
	// A plain search word stays in the query when the user adds a filter.
	const isNewFilter =
		typingFilter === null && typedNamespace === null && matchingKeys.length === 0 && matchingFileFields.length === 0;
	const keyRows = isNewFilter ? catalogKeys.slice(0, FilesSearchInput_SUGGESTIONS_MAX_ROWS) : matchingKeys;
	const fileFieldRows = isNewFilter ? files_search_query_FILE_FIELDS.map((field) => `file.${field}`) : matchingFileFields;

	// A range value (`>2`) has nothing to complete. A `file.*` key completes from the tree below.
	// The fields are joined into one string so the memo below depends on plain strings only. The
	// template literal makes the React Compiler see a plain string. With a bare `.join()` result
	// the compiler cannot preserve the manual `useMemo` below and the
	// `react-hooks/preserve-manual-memoization` lint fails.
	const valueQueryFields =
		isFocused && typingFilter !== null && typingFilter.match.op !== "range"
			? `${files_search_query_qualified_fields(typingFilter.key).join("\n")}`
			: "";

	// Keep manual `useMemo` here. Convex `useQueries` re-subscribes with a render-phase setState
	// whenever the queries object identity changes, so an inline object loops the render until
	// React throws. Build the object once per typed token.
	const valueQueries = useMemo(
		() =>
			Object.fromEntries(
				(valueQueryFields === "" ? [] : valueQueryFields.split("\n")).map((qualifiedField) => [
					qualifiedField,
					{
						query: app_convex_api.files_metadata.list_search_values,
						args: { membershipId, qualifiedField, prefix: typedValueDebounced },
					},
				]),
			),
		[membershipId, valueQueryFields, typedValueDebounced],
	);
	const valueResults = useQueries(valueQueries);

	const valueRows = ((/* iife */) => {
		if (typingFilter === null || typingFilter.match.op === "range") {
			return [];
		}

		// A typed path or extension is read the way the filter will read it, so `tasks` still lists
		// `/tasks` and `.md` still lists `md`.
		const typedFileValue =
			typingFilter.key.namespace !== "file" || typedValue.length === 0
				? typedValue
				: typingFilter.key.name === "path"
					? files_search_query_folder_path(typedValue)
					: typingFilter.key.name === "ext"
						? typedValue.replace(/^\./u, "")
						: typedValue;
		const typedValueLower = typedFileValue.toLowerCase();
		const rows: Array<{ value: string; label: string }> = [];
		const push = (value: string, label = value) => {
			// A metadata value matches exact case, on the server and here, so a row never shows for a
			// prefix the server will not confirm. File values ignore case like their filters. A folder
			// is listed when its path contains the typed text, without the leading slash the filter
			// adds, so `tasks` lists `/projects/tasks` and `arch` lists `/tasks-archive`.
			const matchesTyped =
				typingFilter.key.namespace === "file"
					? typingFilter.key.name === "path"
						? value.toLowerCase().includes(typedValueLower.replace(/^\//u, ""))
						: value.toLowerCase().startsWith(typedValueLower)
					: value.startsWith(typedFileValue);
			if (matchesTyped && !rows.some((row) => row.value === value)) {
				rows.push({ value, label });
			}
		};

		if (typingFilter.key.namespace === "file") {
			if (typingFilter.key.name === "kind") {
				push("file");
				push("folder");
			} else if (typingFilter.key.name === "ext") {
				const extensions = new Set<string>();
				for (const item of treeItemsList ?? []) {
					if (item.lowercaseExtension !== null) {
						extensions.add(item.lowercaseExtension);
					}
				}
				for (const extension of [...extensions].sort()) {
					push(extension);
				}
			} else if (typingFilter.key.name === "path") {
				const folderPaths = (treeItemsList ?? [])
					.filter((item) => item.kind === "folder" && item.path !== "/")
					.map((item) => item.path)
					.sort();
				for (const path of folderPaths) {
					push(path);
				}
			}

			return rows.slice(0, FilesSearchInput_SUGGESTIONS_MAX_ROWS);
		}

		if (typedValue.length === 0) {
			push("*", "* (any value)");
		}
		if (catalogKeys.find((key) => key.name === typingFilter.key.name)?.valueKinds.has("boolean")) {
			push("true");
			push("false");
		}

		const serverValues = new Set<string>();
		for (const qualifiedField of Object.keys(valueQueries)) {
			const values = valueResults[qualifiedField];
			if (!Array.isArray(values)) {
				continue;
			}
			for (const value of values) {
				if (typeof value === "string") {
					serverValues.add(value);
				}
			}
		}
		for (const value of [...serverValues].sort()) {
			push(value);
		}

		return rows.slice(0, FilesSearchInput_SUGGESTIONS_MAX_ROWS);
	})();

	const matchStatus = isSearchLoading
		? "Searching…"
		: isSearchFailed
			? "Search failed"
			: searchMatchCount === null
				? ""
				: `${searchMatchCount} ${searchMatchCount === 1 ? "match" : "matches"}`;
	const statusText = [announcement, matchStatus].filter((part) => part.length > 0).join(". ");
	const filterProblem = filters.find((filter) => filter.problem !== null)?.problem;

	const commitFilters = (committed: files_search_query_Filter[], remainingText: string) => {
		// Parse the chips as one query, the way the URL `q` is read back, so the filter cap counts
		// the chips already committed and the chip past the cap shows as one that cannot run.
		const nextFilters = files_search_query_parse(
			files_search_query_serialize({ filters: [...filters, ...committed], text: "" }),
		).filters;
		const added = nextFilters.slice(filters.length);
		setFilters(nextFilters);
		setIsSuggestionsOpen(false);
		setText(remainingText);

		const invalidFilter = added.find((filter) => filter.problem !== null);
		setAnnouncement(
			invalidFilter
				? `Filter ${invalidFilter.raw} cannot run. ${invalidFilter.problem}`
				: `Added filter ${added.map((filter) => filter.raw).join(", ")}`,
		);
	};

	const removeFilter = (index: number) => {
		const removed = filters[index];
		if (!removed) {
			return;
		}

		// Re-parse the chips left, so a chip past the filter cap can run once there is room.
		const remaining = filters.filter((_, filterIndex) => filterIndex !== index);
		setFilters(files_search_query_parse(files_search_query_serialize({ filters: remaining, text: "" })).filters);
		setAnnouncement(`Removed filter ${removed.raw}`);
	};

	const pickKey = (keyText: string) => {
		const negation = !isNewFilter && typing.token.startsWith("!") ? "!" : "";
		// Keep the namespace the user already typed, so `frontmatter.sta` picks `frontmatter.status`.
		const namespace =
			typedNamespace === null || /^(?:file|frontmatter|metadata)\./u.test(keyText) ? "" : `${typedNamespace}.`;
		setText(`${isNewFilter ? `${text} ` : text.slice(0, typing.start)}${negation}${namespace}${keyText}:`);
	};

	const pickValue = (value: string) => {
		if (typingFilter === null) {
			return;
		}

		const negation = typingFilter.negated ? "!" : "";
		const valueText = value === "*" ? "*" : files_search_query_format_value(value);
		const raw = `${negation}${search_key_text(typingFilter.key)}:${valueText}`;
		commitFilters(files_search_query_parse(raw).filters, text.slice(0, typing.start));
	};

	const handleTextChange = useFn<NonNullable<MyCombobox_Props["setValue"]>>((nextText) => {
		setText(nextText);
		setAnnouncement("");
	});

	const handleInputKeyDown = useFn<NonNullable<MyComboboxInputControl_Props["onKeyDown"]>>((event) => {
		// Ariakit already used this key: Enter on an active suggestion clicked it. A key pressed while
		// an IME composes text belongs to the composition. Safari reports the key that ends a
		// composition with `isComposing` false and `keyCode` 229.
		if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
			return;
		}

		if (event.key === " " && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
			event.preventDefault();
			setIsSuggestionsOpen(true);
			return;
		}

		// Enter commits the filters typed in the text. With no filter it opens the one node the
		// text identifies, on the live value so a paste followed straight away by Enter acts on
		// what was just pasted.
		if (event.key === "Enter") {
			const parsed = files_search_query_parse(text);
			if (parsed.filters.length > 0) {
				commitFilters(parsed.filters, parsed.text);
				return;
			}

			if (!onSubmit(searchQuery)) {
				// No trailing period: the status line adds one before the match count.
				setAnnouncement("Still searching. Press Enter again when the results are in");
			}
			return;
		}

		// Space commits the complete filters typed so far, so `status:open` becomes a chip as soon
		// as the user moves on. A filter with a problem stays in the text next to the free text, so
		// the user can fix it. An open quote keeps the space, so the user can keep typing, and so
		// does a caret that is not at the end, because the commit rewrites the whole text.
		if (event.key === " ") {
			const input = event.currentTarget;
			if (input.selectionStart !== text.length || input.selectionEnd !== text.length) {
				return;
			}
			const parsed = files_search_query_parse(text);
			const complete = parsed.filters.filter((filter) => filter.problem === null);
			if (parsed.openQuote || complete.length === 0) {
				return;
			}

			event.preventDefault();
			const remainingText = files_search_query_serialize({
				filters: parsed.filters.filter((filter) => filter.problem !== null),
				text: parsed.text,
			});
			commitFilters(complete, remainingText.length > 0 ? `${remainingText} ` : "");
			return;
		}

		// Backspace on an empty text reaches the chips, like a token field.
		if (event.key === "Backspace" && text.length === 0 && filters.length > 0) {
			event.preventDefault();
			chipRowRef.current
				?.querySelector<HTMLElement>(
					`li:last-of-type [${"data-my-chip-remove" satisfies keyof MyChipRemove_CustomAttributes}]`,
				)
				?.focus();
		}
	});

	const handleInputFocus = useFn<NonNullable<MyComboboxInputControl_Props["onFocus"]>>((event) => {
		setIsFocused(true);
		// Returning from chips, suggestions, or results keeps the current menu state.
		if (
			!rootRef.current?.contains(event.relatedTarget) &&
			!suggestionsRef.current?.contains(event.relatedTarget) &&
			!props.resultsRef?.current?.contains(event.relatedTarget)
		) {
			setIsSuggestionsOpen(true);
		}

		// Read the key catalog once per focus instead of subscribing to it. A subscription would
		// walk every key again after each metadata write in the workspace while the box is focused.
		convex
			.query(app_convex_api.files_metadata.list_search_fields, { membershipId })
			.then(setSearchFields)
			.catch((error: unknown) => {
				console.error("[FilesSearchInput.handleInputFocus] Failed to load the search key catalog", {
					error,
					membershipId,
				});
			});
	});

	const handleInputBlur = useFn<NonNullable<MyComboboxInputControl_Props["onBlur"]>>(() => {
		setIsFocused(false);
	});

	// The Ariakit input does not use the `MyInput` label id, so forward clicks on the area by hand.
	const handleFocusForward = useFn<NonNullable<MyInputArea_Props["onFocusForward"]>>((event) => {
		event.preventDefault();
		event.detail.originalEvent.preventDefault();
		inputRef.current?.focus();
	});

	const handleFiltersFocusExit = useFn(() => {
		inputRef.current?.focus();
		setIsSuggestionsOpen(false);
	});

	const handleShowFilters = useFn(() => {
		inputRef.current?.focus();
		setIsSuggestionsOpen(true);
	});

	const handleClearSearch = useFn(() => {
		setFilters([]);
		setText("");
		setAnnouncement("Search cleared");
		inputRef.current?.focus();
		setIsSuggestionsOpen(false);
	});

	useEffect(() => {
		onSearchQueryChange(searchQueryDebounced);
	}, [searchQueryDebounced]);

	// `MyComboboxInputControl` owns its own generated id for the Ariakit wiring, so the global id
	// that the Mod+K shortcut looks up lives on the wrapper.
	return (
		<MyCombobox value={text} setValue={handleTextChange} open={isSuggestionsOpen} setOpen={setIsSuggestionsOpen}>
			<div ref={rootRef} className={cn("FilesSearchInput" satisfies FilesSearchInput_ClassNames)}>
				{filters.length > 0 ? (
					<MyChipRow
						ref={chipRowRef}
						size="compact"
						overflow="wrap"
						aria-label="Search filters"
						className={cn("FilesSearchInput-filters" satisfies FilesSearchInput_ClassNames)}
						onFocusExit={handleFiltersFocusExit}
					>
						{filters.map((filter, index) => (
							<li key={`${index}:${filter.raw}`}>
								<FilesSearchInputFilterChip filter={filter} onRemove={() => removeFilter(index)} />
							</li>
						))}
					</MyChipRow>
				) : null}
				<MyInput id={id}>
					<MyInputBackground />
					<MyInputArea
						className={cn("FilesSearchInput-area" satisfies FilesSearchInput_ClassNames)}
						focusForwarding
						onFocusForward={handleFocusForward}
					>
						<MyInputIcon>
							<Search />
						</MyInputIcon>
						{/* Keys and values are exact-case, so a phone keyboard must not capitalize or correct them. */}
						<MyComboboxInputControl
							ref={inputRef}
							aria-label={
								variant === "palette"
									? "Search files by name, contents, or key:value filters"
									: "Search files by name, path, or key:value filters"
							}
							placeholder={variant === "palette" ? "Search names, contents, or add a filter" : "Search files"}
							autoFocus={variant === "palette"}
							showOnChange={false}
							showOnClick={false}
							showOnKeyPress={false}
							aria-keyshortcuts="Control+Space"
							onKeyDownCapture={(event) => {
								if (
									event.key === "ArrowDown" &&
									!isSuggestionsOpen &&
									onNavigateResults &&
									!event.nativeEvent.isComposing &&
									event.nativeEvent.keyCode !== 229
								) {
									event.preventDefault();
									onNavigateResults();
								}
							}}
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							onKeyDown={handleInputKeyDown}
							onFocus={handleInputFocus}
							onBlur={handleInputBlur}
						/>
						<MyIconButton
							variant="ghost-highlightable"
							tooltip="Add search filter (Ctrl+Space)"
							aria-label="Add search filter"
							aria-expanded={isSuggestionsOpen}
							aria-controls={isSuggestionsOpen ? suggestionsId : undefined}
							className={cn("FilesSearchInput-filter-button" satisfies FilesSearchInput_ClassNames)}
							onClick={handleShowFilters}
						>
							<MyIconButtonIcon>
								<SlidersHorizontal />
							</MyIconButtonIcon>
						</MyIconButton>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				{searchQuery.length > 0 ? (
					<div className={cn("FilesSearchInput-summary" satisfies FilesSearchInput_ClassNames)}>
						<span>{filterProblem ? "Check your filters" : matchStatus}</span>
						<MyButton
							variant="ghost-highlightable"
							aria-label="Clear search"
							className={cn("FilesSearchInput-clear" satisfies FilesSearchInput_ClassNames)}
							onClick={handleClearSearch}
						>
							Clear
						</MyButton>
					</div>
				) : null}
				{filterProblem ? (
					<div className={cn("FilesSearchInput-error" satisfies FilesSearchInput_ClassNames)}>{filterProblem}</div>
				) : null}
			</div>

			<MyComboboxPopover
				ref={suggestionsRef}
				id={suggestionsId}
				aria-label="Search filters"
				className={cn("FilesSearchInput-popover" satisfies FilesSearchInput_ClassNames)}
				unmountOnHide
			>
				<MyComboboxPopoverScrollableArea
					className={cn("FilesSearchInput-popover-scrollable-area" satisfies FilesSearchInput_ClassNames)}
				>
					<MyComboboxList aria-label="Search suggestions">
						<MyComboboxPopoverContent>
							{keyRows.length > 0 ? (
								<MyComboboxGroup heading="Properties">
									{keyRows.map((key) => (
										<MyComboboxItem
											key={key.name}
											value={key.name}
											focusOnHover
											hideOnClick={false}
											setValueOnClick={false}
											className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
											title={`${[...key.valueKinds].map((kind) => FilesSearchInput_VALUE_KIND_LABELS[kind]).join(", ")} · ${key.metadataKinds.join(", ")}`}
											onClick={() => pickKey(files_search_query_format_key(key.name))}
										>
											<span className={cn("FilesSearchInput-suggestion-label" satisfies FilesSearchInput_ClassNames)}>
												{key.name}
											</span>
											<span className={cn("FilesSearchInput-suggestion-hint" satisfies FilesSearchInput_ClassNames)}>
												{[...key.valueKinds].map((kind) => FilesSearchInput_VALUE_KIND_LABELS[kind]).join(", ")}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{fileFieldRows.length > 0 ? (
								<MyComboboxGroup heading="File details" separator={keyRows.length > 0}>
									{fileFieldRows.map((field) => (
										<MyComboboxItem
											key={field}
											value={field}
											focusOnHover
											hideOnClick={false}
											setValueOnClick={false}
											className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
											onClick={() => pickKey(field)}
										>
											<span className={cn("FilesSearchInput-suggestion-label" satisfies FilesSearchInput_ClassNames)}>
												{FilesSearchInput_FILE_FIELD_LABELS[field.slice(5)]}
											</span>
											<span className={cn("FilesSearchInput-suggestion-hint" satisfies FilesSearchInput_ClassNames)}>
												{field}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{valueRows.length > 0 ? (
								<MyComboboxGroup heading={`Values for ${typingFilter?.key.name}`}>
									{valueRows.map((row) => (
										<MyComboboxItem
											key={row.value}
											value={row.value}
											focusOnHover
											setValueOnClick={false}
											className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
											onClick={() => pickValue(row.value)}
										>
											<span className={cn("FilesSearchInput-suggestion-label" satisfies FilesSearchInput_ClassNames)}>
												{row.label}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
						</MyComboboxPopoverContent>
					</MyComboboxList>
					<div className={cn("FilesSearchInput-syntax" satisfies FilesSearchInput_ClassNames)}>
						{typingFilter === null
							? "Choose a filter, or type key:value"
							: "Choose a value, or type one and press Enter"}
						<div>Esc to close · Ctrl+Space to show filters</div>
						<details>
							<summary>Filter syntax</summary>
							<dl>
								<dt>Exact value</dt>
								<dd>status:open</dd>
								<dt>Any value</dt>
								<dd>status:*</dd>
								<dt>Starts with</dt>
								<dd>title:Rec*</dd>
								<dt>Number or date</dt>
								<dd>priority:&gt;=2</dd>
								<dt>Exclude</dt>
								<dd>!status:done</dd>
								<dt>Spaces in values</dt>
								<dd>key:"two words"</dd>
								<dt>Colon in keys</dt>
								<dd>"a:b":value</dd>
								<dt>Folder</dt>
								<dd>file.path:/tasks</dd>
							</dl>
						</details>
					</div>
				</MyComboboxPopoverScrollableArea>
			</MyComboboxPopover>

			<div role="status" className="sr-only">
				{statusText}
			</div>
		</MyCombobox>
	);
});
// #endregion search
