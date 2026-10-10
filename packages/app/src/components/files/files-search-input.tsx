import "./files-search-input.css";
import React, { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { useQueries, useQuery } from "convex/react";
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
import {
	files_metadata_catalog_key_order,
	files_metadata_catalog_key_prefixes,
	useFilesMetadataCatalogPages,
} from "@/hooks/files-metadata-catalog-hooks.ts";
import { useDebounce, useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn } from "@/lib/utils.ts";
import { files_metadata_FRONTMATTER_FIELD_PREFIX, type files_metadata_Value } from "../../../shared/files-metadata.ts";
import {
	files_search_query_FILE_FIELDS,
	files_search_query_folder_path,
	files_search_query_format_value,
	files_search_query_parse,
	files_search_query_field_paths,
	files_search_query_serialize,
	files_search_query_typing_token,
	type files_search_query_Filter,
} from "../../../shared/files-search-query.ts";

// #region search filter chip
type FilesSearchInputFilterChip_ClassNames =
	| "FilesSearchInputFilterChip"
	| "FilesSearchInputFilterChip-key"
	| "FilesSearchInputFilterChip-invalid";

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
	const keyLabel = `${filter.key.namespace}.${filter.key.name}`;
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

// #region search suggestions
/**
 * A row that only tells something. It is disabled, so it cannot be picked.
 */
const FilesSearchInputSuggestionsMessage = memo(function FilesSearchInputSuggestionsMessage(props: { children: string }) {
	return (
		<MyComboboxItem
			value={`message:${props.children}`}
			disabled
			className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
		>
			{props.children}
		</MyComboboxItem>
	);
});

/**
 * Show more for a paged list. It stays active while its page loads, and the caller ignores that
 * click.
 */
const FilesSearchInputSuggestionsMore = memo(function FilesSearchInputSuggestionsMore(props: {
	label: string;
	disabled: boolean;
	loading: boolean;
	onClick: () => void;
}) {
	return (
		<MyComboboxItem
			value={`more:${props.label}`}
			aria-label={props.label}
			aria-busy={props.loading}
			disabled={props.disabled}
			hideOnClick={false}
			setValueOnClick={false}
			className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
			onClick={props.onClick}
		>
			Show more
		</MyComboboxItem>
	);
});

const FilesSearchInputSuggestionsError = memo(function FilesSearchInputSuggestionsError(props: ErrorComponentProps) {
	return (
		<MyComboboxGroup heading="Suggestions">
			<FilesSearchInputSuggestionsMessage>Could not load suggestions.</FilesSearchInputSuggestionsMessage>
			<MyComboboxItem
				value="retry"
				hideOnClick={false}
				setValueOnClick={false}
				className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
				onClick={props.reset}
			>
				Retry
			</MyComboboxItem>
		</MyComboboxGroup>
	);
});

/**
 * Saved keys that start with the typed text, in pages. Rows from an older text stay, disabled,
 * until the new first page arrives.
 */
const FilesSearchInputKeyRows = memo(function FilesSearchInputKeyRows(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	prefix: string;
	/**
	 * The typed text is newer than `prefix`.
	 */
	stale: boolean;
	onPick: (fieldPath: string) => void;
	/**
	 * Called with a prefix that starts no saved key.
	 */
	onUnmatched: (prefix: string) => void;
}) {
	const { membershipId, prefix, stale, onPick, onUnmatched } = props;

	const keys = useFilesMetadataCatalogPages({
		query: app_convex_api.files_metadata.list_search_fields,
		membershipId,
		requests: files_metadata_catalog_key_prefixes(prefix).map((keyPrefix) => ({ membershipId, prefix: keyPrefix })),
		scope: membershipId,
		order: (row) => files_metadata_catalog_key_order(row.fieldPath),
		rowKey: (row) => row.fieldPath,
	});
	const isDisabled = stale || keys.updating;
	const isUnmatched = !isDisabled && keys.status === "Exhausted" && keys.rows.length === 0 && prefix !== "";

	useEffect(() => {
		if (isUnmatched) {
			onUnmatched(prefix);
		}
	}, [isUnmatched, prefix]);

	// A key in the normal and the Move view stream can have other kinds in each.
	const kindsByKey = new Map<string, Set<files_metadata_Value["valueKind"]>>();
	for (const row of keys.loadedRows) {
		const kinds = kindsByKey.get(row.fieldPath) ?? new Set();
		for (const kind of row.valueKinds) {
			kinds.add(kind);
		}
		kindsByKey.set(row.fieldPath, kinds);
	}

	return (
		<MyComboboxGroup heading="Properties">
			{keys.rows.map((key) => {
				const kinds = [...(kindsByKey.get(key.fieldPath) ?? [])]
					.map((kind) => FilesSearchInput_VALUE_KIND_LABELS[kind])
					.join(", ");
				const metadataKind = key.fieldPath.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX) ? "frontmatter" : "metadata";
				return (
					<MyComboboxItem
						key={key.fieldPath}
						value={key.fieldPath}
						disabled={isDisabled}
						hideOnClick={false}
						setValueOnClick={false}
						className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
						title={`${kinds} · ${metadataKind}`}
						onClick={() => {
							if (!isDisabled) {
								onPick(key.fieldPath);
							}
						}}
					>
						<span className={cn("FilesSearchInput-suggestion-label" satisfies FilesSearchInput_ClassNames)}>
							{key.fieldPath}
						</span>
						<span className={cn("FilesSearchInput-suggestion-hint" satisfies FilesSearchInput_ClassNames)}>
							{kinds}
						</span>
					</MyComboboxItem>
				);
			})}
			{isDisabled ? (
				<FilesSearchInputSuggestionsMessage>Updating suggestions…</FilesSearchInputSuggestionsMessage>
			) : keys.rows.length === 0 ? (
				<FilesSearchInputSuggestionsMessage>
					{prefix === "" ? "No saved keys yet" : `No keys start with ${prefix}`}
				</FilesSearchInputSuggestionsMessage>
			) : null}
			{keys.status === "CanLoadMore" || keys.status === "LoadingMore" ? (
				<FilesSearchInputSuggestionsMore
					label="Show more keys"
					disabled={isDisabled}
					loading={keys.status === "LoadingMore"}
					onClick={() => {
						if (!isDisabled && keys.status === "CanLoadMore") {
							keys.loadMore();
						}
					}}
				/>
			) : null}
		</MyComboboxGroup>
	);
});

/**
 * Saved values of one key that start with the typed text, exact case, in pages. `*` and
 * `true`/`false` come first.
 */
const FilesSearchInputValueRows = memo(function FilesSearchInputValueRows(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	fieldPath: string;
	prefix: string;
	/**
	 * The value text as typed, newer than `prefix` while `stale`.
	 */
	typed: string;
	stale: boolean;
	onPick: (value: string) => void;
}) {
	const { membershipId, fieldPath, prefix, typed, stale, onPick } = props;

	const values = useFilesMetadataCatalogPages({
		query: app_convex_api.files_metadata.list_search_values,
		membershipId,
		requests: [{ membershipId, fieldPath, prefix }],
		scope: `${membershipId}\n${fieldPath}`,
		order: (value) => value,
		rowKey: (value) => value,
	});
	// The exact key's kinds, not a prefix page, decide the boolean hint.
	const field = useQuery(app_convex_api.files_metadata.get_search_field, { membershipId, fieldPath });
	const isDisabled = stale || values.updating;

	const rows: Array<{ value: string; label: string }> = [];
	const push = (value: string, label = value) => {
		// A saved value matches exact case, on the server and here, so a row never shows for a prefix
		// the server will not confirm.
		if (value.startsWith(typed) && !rows.some((row) => row.value === value)) {
			rows.push({ value, label });
		}
	};
	if (typed.length === 0) {
		push("*", "* (any value)");
	}
	if (field?.valueKinds.includes("boolean")) {
		push("true");
		push("false");
	}
	for (const value of values.rows) {
		push(value);
	}

	return (
		<MyComboboxGroup heading={`Values for ${fieldPath}`}>
			{rows.map((row) => (
				<MyComboboxItem
					key={row.value}
					value={row.value}
					disabled={isDisabled}
					setValueOnClick={false}
					className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
					onClick={() => {
						if (!isDisabled) {
							onPick(row.value);
						}
					}}
				>
					<span className={cn("FilesSearchInput-suggestion-label" satisfies FilesSearchInput_ClassNames)}>
						{row.label}
					</span>
				</MyComboboxItem>
			))}
			{isDisabled ? <FilesSearchInputSuggestionsMessage>Updating suggestions…</FilesSearchInputSuggestionsMessage> : null}
			{values.status === "CanLoadMore" || values.status === "LoadingMore" ? (
				<FilesSearchInputSuggestionsMore
					label="Show more values"
					disabled={isDisabled}
					loading={values.status === "LoadingMore"}
					onClick={() => {
						if (!isDisabled && values.status === "CanLoadMore") {
							values.loadMore();
						}
					}}
				/>
			) : null}
		</MyComboboxGroup>
	);
});
// #endregion search suggestions

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
	isSearchLoading: boolean;
	/**
	 * Matches loaded for the current query, or null while no search is active.
	 */
	searchMatchCount: number | null;
	/**
	 * More pages of matches can load, so the count reads "50+ matches".
	 */
	hasMoreMatches: boolean;
	onSearchQueryChange: (searchQuery: string) => void;
	/**
	 * Open the node the query identifies. Returns false while the metadata results are not in
	 * yet, so the box can tell the user to press Enter again.
	 */
	onSubmit: (searchQuery: string) => boolean;
};

/**
 * The folders a `file.path` value lists. Saved keys and values have no cut: they show in pages.
 */
const FilesSearchInput_FOLDER_MAX_ROWS = 40;

const FilesSearchInput_VALUE_KIND_LABELS = {
	string: "text",
	number: "number",
	boolean: "boolean",
	maybe_date: "date",
} satisfies Record<files_metadata_Value["valueKind"], string>;

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
		isSearchLoading,
		searchMatchCount,
		hasMoreMatches,
		onSearchQueryChange,
		onSubmit,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const [filters, setFilters] = useState(() => files_search_query_parse(initialQuery).filters);
	const [text, setText] = useState(() => files_search_query_parse(initialQuery).text);
	const [announcement, setAnnouncement] = useState("");
	const [isFocused, setIsFocused] = useState(false);
	const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
	const [previousQuery, setPreviousQuery] = useState(initialQuery);
	// The last typed key that starts no saved key, as the key rows found on their first page.
	const [unmatchedKey, setUnmatchedKey] = useState<string | null>(null);

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
	// Saved keys ignore case on the server, so the typed key keeps its case.
	const typedKey = typing.token.replace(/^!/u, "");
	const typedKeyDebounced = useDebounce(typedKey, 150);
	const typedValue =
		typingFilter === null || typingFilter.match.op === "exists" || typingFilter.match.op === "range"
			? ""
			: typingFilter.match.value;
	const typedValueDebounced = useDebounce(typedValue, 150);

	const matchingFileFields =
		typingFilter === null
			? files_search_query_FILE_FIELDS.map((field) => `file.${field}`).filter((field) =>
					field.includes(typedKey.toLowerCase()),
				)
			: [];
	// A plain search word stays in the query when the user adds a filter. A word is plain when it
	// starts no saved key and no file field. Then every key and file field shows.
	const isNewFilter = typingFilter === null && matchingFileFields.length === 0 && unmatchedKey === typedKey;
	const fileFieldRows = isNewFilter
		? files_search_query_FILE_FIELDS.map((field) => `file.${field}`)
		: matchingFileFields;
	const keyPrefix = isNewFilter ? "" : typedKeyDebounced;

	// A range value (`>2`) has nothing to complete. A `file.*` key completes from the rows below.
	const valueFieldPath =
		typingFilter !== null && typingFilter.match.op !== "range"
			? (files_search_query_field_paths(typingFilter.key)[0] ?? null)
			: null;

	// A `file.path` value completes from the saved folders the user can read, found by the words of
	// the last part of the typed path. The rows below keep the folders whose path holds the whole text.
	const folderQueryText =
		isFocused && typingFilter?.key.namespace === "file" && typingFilter.key.name === "path"
			? (typedValueDebounced.split("/").findLast((part) => part.length > 0) ?? "")
			: "";
	// Keep manual `useMemo` here. Convex `useQueries` re-subscribes with a render-phase setState
	// whenever the queries object identity changes, so an inline object loops the render until
	// React throws. Build the object once per typed text.
	const folderQueries = useMemo(
		() =>
			Object.fromEntries(
				folderQueryText === ""
					? []
					: [
							[
								"folders",
								{
									query: app_convex_api.files_nodes.search_saved,
									args: {
										membershipId,
										clause: { kind: "name", text: folderQueryText, nodeKind: "folder" },
										paginationOpts: { numItems: FilesSearchInput_FOLDER_MAX_ROWS, cursor: null },
									},
								},
							],
						],
			),
		[membershipId, folderQueryText],
	);
	const folderResult: FunctionReturnType<typeof app_convex_api.files_nodes.search_saved> | Error | undefined =
		useQueries(folderQueries).folders;

	// A `file.*` value completes here. Saved values show in `FilesSearchInputValueRows`.
	const fileValueRows = ((/* iife */) => {
		if (typingFilter === null || typingFilter.match.op === "range" || typingFilter.key.namespace !== "file") {
			return [];
		}

		// A typed path is read the way the filter will read it, so `tasks` still lists `/tasks`.
		const typedFileValue =
			typedValue.length > 0 && typingFilter.key.name === "path" ? files_search_query_folder_path(typedValue) : typedValue;
		const typedValueLower = typedFileValue.toLowerCase();
		const rows: string[] = [];
		const push = (value: string) => {
			// File values ignore case here, and a row writes the stored value, so a picked path has the
			// exact case the filter needs. A folder is listed when its path contains the typed text,
			// without the leading slash the filter adds, so `tasks` lists `/projects/tasks` and `arch`
			// lists `/tasks-archive`.
			const matchesTyped =
				typingFilter.key.name === "path"
					? value.toLowerCase().includes(typedValueLower.replace(/^\//u, ""))
					: value.toLowerCase().startsWith(typedValueLower);
			if (matchesTyped && !rows.includes(value)) {
				rows.push(value);
			}
		};

		if (typingFilter.key.name === "link") {
			push("public");
		} else if (typingFilter.key.name === "path" && folderResult && !(folderResult instanceof Error)) {
			const folderPaths = folderResult.page.flatMap((row) => (row.kind === "folder" ? [row.path] : [])).sort();
			for (const path of folderPaths) {
				push(path);
			}
		}

		return rows;
	})();

	const matchStatus = isSearchLoading
		? "Searching…"
		: searchMatchCount === null
			? ""
			: `${searchMatchCount}${hasMoreMatches ? "+" : ""} ${searchMatchCount === 1 && !hasMoreMatches ? "match" : "matches"}`;
	const statusText = [announcement, matchStatus].filter((part) => part.length > 0).join(". ");
	// Check the chips against the whole query, so typing words next to a filter shows its problem at
	// once. The query lists the chips first, so the first parsed filters are the chips.
	const chipFilters = files_search_query_parse(searchQuery).filters.slice(0, filters.length);
	const filterProblem = chipFilters.find((filter) => filter.problem !== null)?.problem;

	const commitFilters = (committed: files_search_query_Filter[], remainingText: string) => {
		// Parse the chips and the text left as one query, the way the URL `q` is read back, so a
		// chip that cannot join the chips already committed or the words shows its problem.
		const nextFilters = files_search_query_parse(
			files_search_query_serialize({ filters: [...filters, ...committed], text: remainingText }),
		).filters.slice(0, filters.length + committed.length);
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

		setFilters(filters.filter((_, filterIndex) => filterIndex !== index));
		setAnnouncement(`Removed filter ${removed.raw}`);
	};

	const pickKey = (keyText: string) => {
		const negation = !isNewFilter && typing.token.startsWith("!") ? "!" : "";
		setText(`${isNewFilter ? `${text} ` : text.slice(0, typing.start)}${negation}${keyText}:`);
	};

	const pickValue = (value: string) => {
		if (typingFilter === null) {
			return;
		}

		const negation = typingFilter.negated ? "!" : "";
		const valueText = value === "*" ? "*" : files_search_query_format_value(value);
		const raw = `${negation}${typingFilter.key.namespace}.${typingFilter.key.name}:${valueText}`;
		commitFilters(files_search_query_parse(raw).filters, text.slice(0, typing.start));
	};

	const handleTextChange = useFn<NonNullable<MyCombobox_Props["setValue"]>>((nextText) => {
		setText(nextText);
		setAnnouncement("");
	});

	const handleInputKeyDown = useFn<NonNullable<MyComboboxInputControl_Props["onKeyDown"]>>((event) => {
		// The combobox already used this key: Enter on an active suggestion clicked it. A key pressed while
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

		// Space commits the complete filters typed so far, so `metadata.status:open` becomes a chip as soon
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
	});

	const handleSuggestionsError = useFn((error: unknown) =>
		console.error("[FilesSearchInput] Failed to load search suggestions", { error, membershipId }),
	);

	const handleInputBlur = useFn<NonNullable<MyComboboxInputControl_Props["onBlur"]>>(() => {
		setIsFocused(false);
	});

	// The combobox input does not use the `MyInput` label id, so forward clicks on the area by hand.
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

	// `MyComboboxInputControl` owns its own generated id for the combobox wiring, so the global id
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
						{chipFilters.map((filter, index) => (
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
									? "Search files by name, contents, or one key:value filter"
									: "Search files by name, path, or one key:value filter"
							}
							placeholder={variant === "palette" ? "Search names and contents, or add one filter" : "Search files"}
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
							{typingFilter === null ? (
								<CatchBoundary
									getResetKey={() => `${membershipId}\n${keyPrefix}`}
									onCatch={handleSuggestionsError}
									errorComponent={FilesSearchInputSuggestionsError}
								>
									<FilesSearchInputKeyRows
										membershipId={membershipId}
										prefix={keyPrefix}
										stale={!isNewFilter && typedKey !== typedKeyDebounced}
										onPick={pickKey}
										onUnmatched={setUnmatchedKey}
									/>
								</CatchBoundary>
							) : null}
							{fileFieldRows.length > 0 ? (
								<MyComboboxGroup heading="File details" separator={typingFilter === null}>
									{fileFieldRows.map((field) => (
										<MyComboboxItem
											key={field}
											value={field}
											hideOnClick={false}
											setValueOnClick={false}
											className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
											onClick={() => pickKey(field)}
										>
											<span className={cn("FilesSearchInput-suggestion-label" satisfies FilesSearchInput_ClassNames)}>
												{field}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{fileValueRows.length > 0 ? (
								<MyComboboxGroup heading={`Values for ${typingFilter?.key.namespace}.${typingFilter?.key.name}`}>
									{fileValueRows.map((value) => (
										<MyComboboxItem
											key={value}
											value={value}
											setValueOnClick={false}
											className={cn("FilesSearchInput-suggestion" satisfies FilesSearchInput_ClassNames)}
											onClick={() => pickValue(value)}
										>
											<span className={cn("FilesSearchInput-suggestion-label" satisfies FilesSearchInput_ClassNames)}>
												{value}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{valueFieldPath !== null ? (
								<CatchBoundary
									getResetKey={() => `${membershipId}\n${valueFieldPath}\n${typedValueDebounced}`}
									onCatch={handleSuggestionsError}
									errorComponent={FilesSearchInputSuggestionsError}
								>
									<FilesSearchInputValueRows
										membershipId={membershipId}
										fieldPath={valueFieldPath}
										prefix={typedValueDebounced}
										typed={typedValue}
										stale={typedValue !== typedValueDebounced}
										onPick={pickValue}
									/>
								</CatchBoundary>
							) : null}
						</MyComboboxPopoverContent>
					</MyComboboxList>
					<div className={cn("FilesSearchInput-syntax" satisfies FilesSearchInput_ClassNames)}>
						{typingFilter === null
							? "Choose a filter, or type metadata.key:value"
							: "Choose a value, or type one and press Enter"}
						<div>Esc to close · Ctrl+Space to show filters</div>
						<details>
							<summary>Filter syntax</summary>
							<dl>
								{/* The sidebar searches names only, so only the palette says it finds contents. */}
								{variant === "palette" ? (
									<>
										<dt>Words</dt>
										<dd>Finds names and contents with these words.</dd>
									</>
								) : null}
								<dt>Exact value</dt>
								<dd>metadata.status:open</dd>
								<dt>Any value</dt>
								<dd>metadata.status:*</dd>
								<dt>Starts with</dt>
								<dd>metadata.title:Rec*</dd>
								<dt>Number or date</dt>
								<dd>metadata.priority:&gt;=2</dd>
								<dt>Spaces in values</dt>
								<dd>metadata.key:"two words"</dd>
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
