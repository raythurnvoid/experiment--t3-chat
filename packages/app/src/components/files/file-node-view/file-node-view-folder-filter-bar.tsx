import "./file-node-view-folder-filter-bar.css";
import { ListFilter, SlidersHorizontal, X } from "lucide-react";
import { memo, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useQueries } from "convex/react";
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
import { cn } from "@/lib/utils.ts";
import {
	files_folder_table_query_close_open_quote,
	files_folder_table_query_FILE_FIELDS,
	files_folder_table_query_field_text,
	files_folder_table_query_format_value,
	files_folder_table_query_get_add_problem,
	files_folder_table_query_MAX_LENGTH,
	files_folder_table_query_operations,
	files_folder_table_query_parse,
	files_folder_table_query_parse_field,
	files_folder_table_query_parse_token,
	files_folder_table_query_serialize,
	files_folder_table_query_with_filter,
	type files_folder_table_query_Token,
} from "../../../../shared/files-folder-table-query.ts";
import {
	files_search_query_split_tokens,
	files_search_query_typing_token,
} from "../../../../shared/files-search-query.ts";
import { files_sort_MAX_CLAUSES } from "../../../../shared/files-sort.ts";

// #region folder filter bar chip
type FileNodeViewFolderFilterBarChip_ClassNames =
	| "FileNodeViewFolderFilterBarChip"
	| "FileNodeViewFolderFilterBarChip-key";

type FileNodeViewFolderFilterBarChip_Props = {
	token: files_folder_table_query_Token;
	onRemove: () => void;
};

/**
 * One committed token. It reads like the token: the key first, then the rest.
 */
const FileNodeViewFolderFilterBarChip = memo(function FileNodeViewFolderFilterBarChip(
	props: FileNodeViewFolderFilterBarChip_Props,
) {
	const { token, onRemove } = props;

	const keyLabel = token.kind === "sort" ? "sort_by" : files_folder_table_query_field_text(token.field);
	const valueLabel =
		token.kind === "sort"
			? `${files_folder_table_query_field_text(token.field)} ${token.direction}`
			: token.value === null
				? token.op
				: `${token.op} ${JSON.stringify(token.value)}`;

	return (
		<MyChip
			size="compact"
			className={"FileNodeViewFolderFilterBarChip" satisfies FileNodeViewFolderFilterBarChip_ClassNames}
			title={token.raw}
		>
			<MyChipLabel>
				<span className={"FileNodeViewFolderFilterBarChip-key" satisfies FileNodeViewFolderFilterBarChip_ClassNames}>
					{keyLabel}
				</span>{" "}
				{valueLabel}
			</MyChipLabel>
			<MyChipRemove tooltip={`Remove ${token.raw}`} onClick={onRemove}>
				<X />
			</MyChipRemove>
		</MyChip>
	);
});
// #endregion folder filter bar chip

// #region folder filter bar
type FileNodeViewFolderFilterBar_ClassNames =
	| "FileNodeViewFolderFilterBar"
	| "FileNodeViewFolderFilterBar-filters"
	| "FileNodeViewFolderFilterBar-area"
	| "FileNodeViewFolderFilterBar-hotkey"
	| "FileNodeViewFolderFilterBar-icon-button"
	| "FileNodeViewFolderFilterBar-error"
	| "FileNodeViewFolderFilterBar-popover"
	| "FileNodeViewFolderFilterBar-popover-scrollable-area"
	| "FileNodeViewFolderFilterBar-suggestion"
	| "FileNodeViewFolderFilterBar-suggestion-label"
	| "FileNodeViewFolderFilterBar-suggestion-hint"
	| "FileNodeViewFolderFilterBar-notes";

export type FileNodeViewFolderFilterBar_Ref = {
	/**
	 * Drop the current filter and start a new one for this table field. The column menu uses it.
	 */
	startFilter: (field: string) => void;
};

export type FileNodeViewFolderFilterBar_Props = {
	ref: Ref<FileNodeViewFolderFilterBar_Ref>;
	/**
	 * The committed tokens, as the URL `filter` param holds them.
	 */
	committedQuery: string;
	/**
	 * The text the user is typing, as the URL `view_q` param holds it.
	 */
	viewQuery: string;
	/**
	 * The `metadata.` and `frontmatter.` fields the folder has, for the suggestions.
	 */
	fields: string[];
	fieldsState: "loading" | "failed" | "ready";
	/**
	 * True while the user works in the bar, so the parent loads the fields only then.
	 */
	onActiveChange: (active: boolean) => void;
	/**
	 * Write a new `committedQuery`, a new `viewQuery`, or both. A missing key stays as it is.
	 */
	onChange: (change: { committedQuery?: string; viewQuery?: string }) => void;
};

const FileNodeViewFolderFilterBar_SUGGESTIONS_MAX_ROWS = 40;

const FileNodeViewFolderFilterBar_FILE_FIELD_HINTS = {
	name: "text",
	updated: "date",
	created: "date",
	extension: "text",
	size: "number",
} satisfies Record<(typeof files_folder_table_query_FILE_FIELDS)[number], string>;

/**
 * Where the typed token is: still on the key, or past a colon on the next part.
 */
function get_typing_stage(token: string) {
	const sortPrefix = "sort_by:";
	if (token.startsWith(sortPrefix)) {
		const rest = token.slice(sortPrefix.length);
		const colon = rest.indexOf(":");
		return colon < 0
			? ({ kind: "sort_field", typed: rest } as const)
			: ({ kind: "sort_direction", field: rest.slice(0, colon), typed: rest.slice(colon + 1) } as const);
	}

	const firstColon = token.indexOf(":");
	if (firstColon < 0) {
		return { kind: "key", typed: token } as const;
	}

	const secondColon = token.indexOf(":", firstColon + 1);
	return secondColon < 0
		? ({ kind: "operation", field: token.slice(0, firstColon), typed: token.slice(firstColon + 1) } as const)
		: ({
				kind: "value",
				field: token.slice(0, firstColon),
				operation: token.slice(firstColon + 1, secondColon),
				typed: token.slice(secondColon + 1).replace(/^"/u, ""),
			} as const);
}

/**
 * Decide what a commit does with these tokens. A token joins the query when it is valid and fits
 * the one-filter and sort limits. Space only reports a token that is whole but does not fit.
 * Enter also reports a token that is not valid yet.
 */
function plan_commit(committedQuery: string, rawTokens: string[], mode: "enter" | "space") {
	let nextQuery = committedQuery;
	const added: string[] = [];
	const kept: string[] = [];
	let problem: string | null = null;

	for (const raw of rawTokens) {
		const syntaxProblem = files_folder_table_query_parse_token(raw).problem;
		const addProblem = syntaxProblem ?? files_folder_table_query_get_add_problem(nextQuery, raw);
		if (addProblem === null) {
			added.push(raw);
			nextQuery = nextQuery === "" ? raw : `${nextQuery} ${raw}`;
			continue;
		}

		kept.push(raw);
		if (mode === "enter" || syntaxProblem === null) {
			problem ??= addProblem;
		}
	}

	return { nextQuery, added, kept, problem };
}

/**
 * Read the typed text as tokens. A quote left open is closed, so the token is whole.
 */
function read_text_tokens(text: string) {
	const { tokens, openQuote } = files_search_query_split_tokens(text);
	return {
		openQuote,
		tokens: tokens.map((raw, index) =>
			openQuote && index === tokens.length - 1 ? files_folder_table_query_close_open_quote(raw) : raw,
		),
	};
}

/**
 * Filter and sort bar of the folder table.
 *
 * The URL `filter` param holds the committed tokens and `view_q` holds the text the user is still
 * typing. The bar shows the tokens as chips. Enter and Space commit the whole tokens typed in the
 * text. Ctrl+Space opens the suggestions.
 */
export const FileNodeViewFolderFilterBar = memo(function FileNodeViewFolderFilterBar(
	props: FileNodeViewFolderFilterBar_Props,
) {
	const { ref, committedQuery, viewQuery, fields, fieldsState, onActiveChange, onChange } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const [text, setText] = useState(viewQuery);
	const [problem, setProblem] = useState<string | null>(null);
	const [isFocused, setIsFocused] = useState(false);
	const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
	const [previousViewQuery, setPreviousViewQuery] = useState(viewQuery);

	const inputRef = useRef<HTMLInputElement>(null);
	const chipRowRef = useRef<HTMLUListElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const suggestionsRef = useRef<HTMLDivElement>(null);
	const suggestionsId = useId();

	const textDebounced = useDebounce(text, 300);

	// A change that did not come from this bar, such as the browser Back button, replaces the text.
	if (previousViewQuery !== viewQuery) {
		setPreviousViewQuery(viewQuery);
		if (viewQuery !== textDebounced) {
			setText(viewQuery);
		}
	}

	const parsed = files_folder_table_query_parse(committedQuery);
	const typing = files_search_query_typing_token(text);
	const stage = get_typing_stage(typing.token);
	const typedLower = stage.typed.toLowerCase();
	const typedValueDebounced = useDebounce(stage.kind === "value" ? stage.typed : "", 150);

	const canAddFilter = parsed.filter === null;
	const canAddSort = parsed.sorts.length < files_sort_MAX_CLAUSES;

	// A field the user can sort by or filter by: the file details, then the folder fields.
	const fieldRows = [
		...files_folder_table_query_FILE_FIELDS.map((name) => ({
			field: `file.${name}`,
			hint: FileNodeViewFolderFilterBar_FILE_FIELD_HINTS[name],
		})),
		...fields.map((field) => ({ field, hint: field.startsWith("metadata.") ? "metadata" : "frontmatter" })),
	].filter((row) => row.field.toLowerCase().includes(typedLower));

	const keyRows = stage.kind === "key" && canAddFilter ? fieldRows : [];
	const showSortKey = stage.kind === "key" && canAddSort && "sort_by".includes(typedLower);
	const sortFieldRows =
		stage.kind === "sort_field"
			? fieldRows.filter(
					(row) => !parsed.sorts.some((sort) => files_folder_table_query_field_text(sort.field) === row.field),
				)
			: [];
	const sortDirectionRows =
		stage.kind === "sort_direction" ? ["asc", "desc"].filter((direction) => direction.startsWith(typedLower)) : [];

	const operationRows = ((/* iife */) => {
		if (stage.kind !== "operation") {
			return [];
		}

		const field = files_folder_table_query_parse_field(stage.field).field;
		return field === null
			? []
			: files_folder_table_query_operations(field).filter((operation) => operation.op.startsWith(typedLower));
	})();

	// Only the folder fields have values to suggest. File details have no value list. The template
	// literal makes the React Compiler see a plain string, so the manual `useMemo` below is kept.
	const valueFieldPath =
		isFocused &&
		stage.kind === "value" &&
		(stage.field.startsWith("metadata.") || stage.field.startsWith("frontmatter.")) &&
		files_folder_table_query_parse_field(stage.field).field !== null
			? `${stage.field}`
			: "";

	// Keep manual `useMemo` here. Convex `useQueries` re-subscribes with a render-phase setState
	// whenever the queries object identity changes, so an inline object loops the render until
	// React throws. Build the object once per typed value.
	const valueQueries = useMemo(
		() =>
			valueFieldPath === ""
				? {}
				: {
						[valueFieldPath]: {
							query: app_convex_api.files_metadata.list_search_values,
							args: { membershipId, fieldPath: valueFieldPath, prefix: typedValueDebounced },
						},
					},
		[membershipId, valueFieldPath, typedValueDebounced],
	);
	const valueResults = useQueries(valueQueries);

	const valueRows = ((/* iife */) => {
		const values = valueFieldPath === "" ? undefined : valueResults[valueFieldPath];
		if (!Array.isArray(values)) {
			return [];
		}

		return values
			.filter((value): value is string => typeof value === "string" && value.startsWith(stage.typed))
			.sort()
			.slice(0, FileNodeViewFolderFilterBar_SUGGESTIONS_MAX_ROWS);
	})();

	const hasContent = parsed.tokens.length > 0 || text.length > 0;

	const applyCommit = (plan: ReturnType<typeof plan_commit>, remainingText: string) => {
		setText(remainingText);
		setProblem(plan.problem);
		setIsSuggestionsOpen(false);
		if (plan.added.length > 0) {
			onChange({ committedQuery: plan.nextQuery, viewQuery: remainingText.trim() });
		}
	};

	const removeToken = (index: number) => {
		onChange({
			committedQuery: files_folder_table_query_serialize(parsed.tokens.filter((_, tokenIndex) => tokenIndex !== index)),
		});
		setProblem(null);
	};

	// Put the next part of the token in the text, so the menu moves on to the next stage.
	const pickPart = (tokenText: string) => {
		setText(`${text.slice(0, typing.start)}${tokenText}`);
		setProblem(null);
	};

	// Add the finished token and keep the text typed before it.
	const pickToken = (raw: string) => {
		applyCommit(plan_commit(committedQuery, [raw], "enter"), text.slice(0, typing.start).trimEnd());
	};

	const handleTextChange = useFn<NonNullable<MyCombobox_Props["setValue"]>>((nextText) => {
		setText(nextText);
		setProblem(null);
	});

	const handleInputKeyDown = useFn<NonNullable<MyComboboxInputControl_Props["onKeyDown"]>>((event) => {
		// The combobox already used this key. A key pressed while an IME composes text belongs to the
		// composition. Safari reports the key that ends a composition with `keyCode` 229.
		if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
			return;
		}

		if (event.key === " " && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
			event.preventDefault();
			setIsSuggestionsOpen(true);
			return;
		}

		// Enter commits every token typed. A token that cannot join stays in the text with its reason.
		if (event.key === "Enter") {
			const { tokens } = read_text_tokens(text);
			if (tokens.length === 0) {
				return;
			}

			const plan = plan_commit(committedQuery, tokens, "enter");
			applyCommit(plan, plan.kept.join(" "));
			return;
		}

		// Space commits the whole tokens typed so far. An open quote or a caret that is not at the
		// end keeps the space, because the commit rewrites the whole text.
		if (event.key === " ") {
			const input = event.currentTarget;
			if (input.selectionStart !== text.length || input.selectionEnd !== text.length) {
				return;
			}

			const { tokens, openQuote } = read_text_tokens(text);
			if (openQuote) {
				return;
			}

			const plan = plan_commit(committedQuery, tokens, "space");
			if (plan.added.length === 0 && plan.problem === null) {
				return;
			}

			event.preventDefault();
			applyCommit(plan, plan.kept.length > 0 ? `${plan.kept.join(" ")} ` : "");
			return;
		}

		// Backspace on an empty text reaches the chips, like a token field.
		if (event.key === "Backspace" && text.length === 0 && parsed.tokens.length > 0) {
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
		onActiveChange(true);
		// Returning from chips or suggestions keeps the current menu state.
		if (!rootRef.current?.contains(event.relatedTarget) && !suggestionsRef.current?.contains(event.relatedTarget)) {
			setIsSuggestionsOpen(true);
		}
	});

	const handleInputBlur = useFn<NonNullable<MyComboboxInputControl_Props["onBlur"]>>(() => {
		setIsFocused(false);
		onActiveChange(false);
	});

	// The combobox input does not use the `MyInput` label id, so forward clicks on the area by hand.
	const handleFocusForward = useFn<NonNullable<MyInputArea_Props["onFocusForward"]>>((event) => {
		event.preventDefault();
		event.detail.originalEvent.preventDefault();
		inputRef.current?.focus();
	});

	const handleChipsFocusExit = useFn(() => {
		inputRef.current?.focus();
		setIsSuggestionsOpen(false);
	});

	const handleShowSuggestions = useFn(() => {
		inputRef.current?.focus();
		setIsSuggestionsOpen(true);
	});

	const handleClear = useFn(() => {
		onChange({ committedQuery: "", viewQuery: "" });
		setText("");
		setProblem(null);
		inputRef.current?.focus();
		setIsSuggestionsOpen(false);
	});

	const startFilter = useFn((field: string) => {
		onChange({ committedQuery: files_folder_table_query_with_filter(committedQuery, null) });
		setText(`${files_folder_table_query_field_text(field)}:`);
		setProblem(null);
		inputRef.current?.focus();
		setIsSuggestionsOpen(true);
	});

	useImperativeHandle(ref, () => ({ startFilter }), [startFilter]);

	useEffect(() => {
		if (textDebounced !== viewQuery) {
			onChange({ viewQuery: textDebounced });
		}
	}, [textDebounced]);

	return (
		<MyCombobox value={text} setValue={handleTextChange} open={isSuggestionsOpen} setOpen={setIsSuggestionsOpen}>
			<div ref={rootRef} className={cn("FileNodeViewFolderFilterBar" satisfies FileNodeViewFolderFilterBar_ClassNames)}>
				{parsed.tokens.length > 0 ? (
					<MyChipRow
						ref={chipRowRef}
						size="compact"
						overflow="wrap"
						aria-label="Table filter and sort"
						className={cn("FileNodeViewFolderFilterBar-filters" satisfies FileNodeViewFolderFilterBar_ClassNames)}
						onFocusExit={handleChipsFocusExit}
					>
						{parsed.tokens.map((token, index) => (
							<li key={`${index}:${token.raw}`}>
								<FileNodeViewFolderFilterBarChip token={token} onRemove={() => removeToken(index)} />
							</li>
						))}
					</MyChipRow>
				) : null}
				<MyInput>
					<MyInputBackground />
					<MyInputArea
						className={cn("FileNodeViewFolderFilterBar-area" satisfies FileNodeViewFolderFilterBar_ClassNames)}
						focusForwarding
						onFocusForward={handleFocusForward}
					>
						<MyInputIcon>
							<ListFilter />
						</MyInputIcon>
						{/* Fields and values are exact-case, so a phone keyboard must not capitalize or correct them. */}
						<MyComboboxInputControl
							ref={inputRef}
							aria-label="Filter and sort this folder"
							placeholder="Filter or sort this folder"
							showOnChange={false}
							showOnClick={false}
							showOnKeyPress={false}
							aria-keyshortcuts="Control+Space"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							// The route drops a `view_q` longer than this, which would clear the typed text.
							maxLength={files_folder_table_query_MAX_LENGTH}
							onKeyDown={handleInputKeyDown}
							onFocus={handleInputFocus}
							onBlur={handleInputBlur}
						/>
						{/* The hotkey works only in the focused input, and focus opens the menu, which already lists it. So the hint shows only when the input is focused and the menu is closed. */}
						{isFocused && !isSuggestionsOpen ? (
							<kbd
								aria-hidden
								className={cn("FileNodeViewFolderFilterBar-hotkey" satisfies FileNodeViewFolderFilterBar_ClassNames)}
							>
								Ctrl+Space
							</kbd>
						) : null}
						{hasContent ? (
							<MyIconButton
								variant="ghost-highlightable"
								tooltip="Clear filter and sort"
								className={cn(
									"FileNodeViewFolderFilterBar-icon-button" satisfies FileNodeViewFolderFilterBar_ClassNames,
								)}
								onClick={handleClear}
							>
								<MyIconButtonIcon>
									<X />
								</MyIconButtonIcon>
							</MyIconButton>
						) : null}
						<MyIconButton
							variant="ghost-highlightable"
							tooltip="Add filter or sort (Ctrl+Space)"
							aria-label="Add filter or sort"
							aria-expanded={isSuggestionsOpen}
							aria-controls={isSuggestionsOpen ? suggestionsId : undefined}
							className={cn("FileNodeViewFolderFilterBar-icon-button" satisfies FileNodeViewFolderFilterBar_ClassNames)}
							onClick={handleShowSuggestions}
						>
							<MyIconButtonIcon>
								<SlidersHorizontal />
							</MyIconButtonIcon>
						</MyIconButton>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				{problem !== null ? (
					<p
						role="alert"
						className={cn("FileNodeViewFolderFilterBar-error" satisfies FileNodeViewFolderFilterBar_ClassNames)}
					>
						{problem}
					</p>
				) : null}
			</div>

			<MyComboboxPopover
				ref={suggestionsRef}
				id={suggestionsId}
				aria-label="Table filter and sort suggestions"
				className={cn("FileNodeViewFolderFilterBar-popover" satisfies FileNodeViewFolderFilterBar_ClassNames)}
				unmountOnHide
			>
				<MyComboboxPopoverScrollableArea
					className={cn(
						"FileNodeViewFolderFilterBar-popover-scrollable-area" satisfies FileNodeViewFolderFilterBar_ClassNames,
					)}
				>
					<MyComboboxList aria-label="Suggestions">
						<MyComboboxPopoverContent>
							{showSortKey ? (
								<MyComboboxGroup heading="Sort">
									<MyComboboxItem
										value="sort_by"
										hideOnClick={false}
										setValueOnClick={false}
										className={cn(
											"FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames,
										)}
										onClick={() => pickPart("sort_by:")}
									>
										<span
											className={cn(
												"FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames,
											)}
										>
											sort_by
										</span>
										<span
											className={cn(
												"FileNodeViewFolderFilterBar-suggestion-hint" satisfies FileNodeViewFolderFilterBar_ClassNames,
											)}
										>
											sort the table
										</span>
									</MyComboboxItem>
								</MyComboboxGroup>
							) : null}
							{keyRows.length > 0 ? (
								<MyComboboxGroup heading="Filter by" separator={showSortKey}>
									{keyRows.slice(0, FileNodeViewFolderFilterBar_SUGGESTIONS_MAX_ROWS).map((row) => (
										<MyComboboxItem
											key={row.field}
											value={row.field}
											hideOnClick={false}
											setValueOnClick={false}
											className={cn(
												"FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames,
											)}
											onClick={() => pickPart(`${row.field}:`)}
										>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{row.field}
											</span>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-hint" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{row.hint}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{sortFieldRows.length > 0 ? (
								<MyComboboxGroup heading="Sort by">
									{sortFieldRows.slice(0, FileNodeViewFolderFilterBar_SUGGESTIONS_MAX_ROWS).map((row) => (
										<MyComboboxItem
											key={row.field}
											value={row.field}
											hideOnClick={false}
											setValueOnClick={false}
											className={cn(
												"FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames,
											)}
											onClick={() => pickPart(`sort_by:${row.field}:`)}
										>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{row.field}
											</span>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-hint" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{row.hint}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{sortDirectionRows.length > 0 && stage.kind === "sort_direction" ? (
								<MyComboboxGroup heading="Direction">
									{sortDirectionRows.map((direction) => (
										<MyComboboxItem
											key={direction}
											value={direction}
											hideOnClick={false}
											setValueOnClick={false}
											className={cn(
												"FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames,
											)}
											onClick={() => pickToken(`sort_by:${stage.field}:${direction}`)}
										>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{direction}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{operationRows.length > 0 && stage.kind === "operation" ? (
								<MyComboboxGroup heading={`How to compare ${stage.field}`}>
									{operationRows.map((operation) => (
										<MyComboboxItem
											key={operation.op}
											value={operation.op}
											hideOnClick={false}
											setValueOnClick={false}
											className={cn(
												"FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames,
											)}
											onClick={() =>
												operation.needsValue
													? pickPart(`${stage.field}:${operation.op}:`)
													: pickToken(`${stage.field}:${operation.op}`)
											}
										>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{operation.op}
											</span>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-hint" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{operation.needsValue ? "needs a value" : "no value"}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
							{valueRows.length > 0 && stage.kind === "value" ? (
								<MyComboboxGroup heading={`Values for ${stage.field}`}>
									{valueRows.map((value) => (
										<MyComboboxItem
											key={value}
											value={value}
											setValueOnClick={false}
											className={cn(
												"FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames,
											)}
											onClick={() =>
												pickToken(`${stage.field}:${stage.operation}:${files_folder_table_query_format_value(value)}`)
											}
										>
											<span
												className={cn(
													"FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames,
												)}
											>
												{value}
											</span>
										</MyComboboxItem>
									))}
								</MyComboboxGroup>
							) : null}
						</MyComboboxPopoverContent>
					</MyComboboxList>
					<div className={cn("FileNodeViewFolderFilterBar-notes" satisfies FileNodeViewFolderFilterBar_ClassNames)}>
						{fieldsState === "loading" ? <p role="status">Loading fields…</p> : null}
						{fieldsState === "failed" ? <p role="status">Fields could not be loaded</p> : null}
						{stage.kind === "key" && !canAddFilter ? (
							<p>The table uses one filter at a time. Remove the filter to add another.</p>
						) : null}
						{stage.kind === "key" && !canAddSort ? (
							<p>The table sorts by up to {files_sort_MAX_CLAUSES} fields.</p>
						) : null}
					</div>
				</MyComboboxPopoverScrollableArea>
			</MyComboboxPopover>
		</MyCombobox>
	);
});
// #endregion folder filter bar
