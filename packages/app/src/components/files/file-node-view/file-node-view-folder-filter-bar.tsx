import "./file-node-view-folder-filter-bar.css";
import { ListFilter, SlidersHorizontal, X } from "lucide-react";
import { memo, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
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
import { useFilesMetadataCatalogPages, useFilesMetadataFolderKeys } from "@/hooks/files-metadata-catalog-hooks.ts";
import { useDebounce, useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
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
	type files_folder_table_query_Operation,
	type files_folder_table_query_Token,
} from "../../../../shared/files-folder-table-query.ts";
import {
	files_search_query_split_tokens,
	files_search_query_typing_token,
} from "../../../../shared/files-search-query.ts";
import { files_sort_field_is_valid } from "../../../../shared/files-sort.ts";

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

// #region folder filter bar suggestions
/**
 * A row that only tells something. It is disabled, so it cannot be picked.
 */
const FileNodeViewFolderFilterBarSuggestionsMessage = memo(function FileNodeViewFolderFilterBarSuggestionsMessage(props: {
	children: string;
}) {
	return (
		<MyComboboxItem
			value={`message:${props.children}`}
			disabled
			className={cn("FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames)}
		>
			{props.children}
		</MyComboboxItem>
	);
});

/**
 * Show more for a paged list. It stays active while its page loads, and the caller ignores that
 * click.
 */
const FileNodeViewFolderFilterBarSuggestionsMore = memo(function FileNodeViewFolderFilterBarSuggestionsMore(props: {
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
			className={cn("FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames)}
			onClick={props.onClick}
		>
			Show more
		</MyComboboxItem>
	);
});

const FileNodeViewFolderFilterBarSuggestionsError = memo(function FileNodeViewFolderFilterBarSuggestionsError(
	props: ErrorComponentProps,
) {
	return (
		<>
			<FileNodeViewFolderFilterBarSuggestionsMessage>Could not load suggestions.</FileNodeViewFolderFilterBarSuggestionsMessage>
			<MyComboboxItem
				value="retry"
				hideOnClick={false}
				setValueOnClick={false}
				className={cn("FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames)}
				onClick={props.reset}
			>
				Retry
			</MyComboboxItem>
		</>
	);
});

/**
 * The keys on the folder's children that start with the typed text, in pages, inside a stage's
 * group. Rows from an older text stay, disabled, until the new first page arrives.
 */
const FileNodeViewFolderFilterBarKeyRows = memo(function FileNodeViewFolderFilterBarKeyRows(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: app_convex_Doc<"files_nodes">["parentId"];
	prefix: string;
	/**
	 * The typed text is newer than `prefix`.
	 */
	stale: boolean;
	/**
	 * No other row of the group matches, so an empty page says so.
	 */
	showNoMatch: boolean;
	canPick: (field: string) => boolean;
	onPick: (field: string) => void;
}) {
	const { membershipId, folderId, prefix, stale, showNoMatch, canPick, onPick } = props;

	const keys = useFilesMetadataFolderKeys({ membershipId, folderId, prefix });
	const isDisabled = stale || keys.updating;
	const rows = keys.rows.filter(canPick);

	return (
		<>
			{rows.map((field) => (
				<MyComboboxItem
					key={field}
					value={field}
					disabled={isDisabled}
					hideOnClick={false}
					setValueOnClick={false}
					className={cn("FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames)}
					onClick={() => {
						if (!isDisabled) {
							onPick(field);
						}
					}}
				>
					<span
						className={cn("FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames)}
					>
						{field}
					</span>
					<span
						className={cn("FileNodeViewFolderFilterBar-suggestion-hint" satisfies FileNodeViewFolderFilterBar_ClassNames)}
					>
						{field.startsWith("metadata.") ? "metadata" : "frontmatter"}
					</span>
				</MyComboboxItem>
			))}
			{isDisabled ? (
				<FileNodeViewFolderFilterBarSuggestionsMessage>Updating suggestions…</FileNodeViewFolderFilterBarSuggestionsMessage>
			) : showNoMatch && rows.length === 0 && keys.status === "Exhausted" ? (
				<FileNodeViewFolderFilterBarSuggestionsMessage>
					{prefix === "" ? "No folder keys yet" : `No keys start with ${prefix}`}
				</FileNodeViewFolderFilterBarSuggestionsMessage>
			) : null}
			{keys.status === "CanLoadMore" || keys.status === "LoadingMore" ? (
				<FileNodeViewFolderFilterBarSuggestionsMore
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
		</>
	);
});

/**
 * Saved values of one folder key that start with the typed text, exact case, in pages.
 */
const FileNodeViewFolderFilterBarValueRows = memo(function FileNodeViewFolderFilterBarValueRows(props: {
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
	const isDisabled = stale || values.updating;
	// A held row of an older text may not start with the typed text any more.
	const rows = values.rows.filter((value) => value.startsWith(typed));

	return (
		<>
			{rows.map((value) => (
				<MyComboboxItem
					key={value}
					value={value}
					disabled={isDisabled}
					setValueOnClick={false}
					className={cn("FileNodeViewFolderFilterBar-suggestion" satisfies FileNodeViewFolderFilterBar_ClassNames)}
					onClick={() => {
						if (!isDisabled) {
							onPick(value);
						}
					}}
				>
					<span
						className={cn("FileNodeViewFolderFilterBar-suggestion-label" satisfies FileNodeViewFolderFilterBar_ClassNames)}
					>
						{value}
					</span>
				</MyComboboxItem>
			))}
			{isDisabled ? (
				<FileNodeViewFolderFilterBarSuggestionsMessage>Updating suggestions…</FileNodeViewFolderFilterBarSuggestionsMessage>
			) : rows.length === 0 && values.status === "Exhausted" ? (
				<FileNodeViewFolderFilterBarSuggestionsMessage>
					{prefix === "" ? "No saved values" : `No saved values start with ${prefix}`}
				</FileNodeViewFolderFilterBarSuggestionsMessage>
			) : null}
			{values.status === "CanLoadMore" || values.status === "LoadingMore" ? (
				<FileNodeViewFolderFilterBarSuggestionsMore
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
		</>
	);
});
// #endregion folder filter bar suggestions

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
	 * The folder whose children's keys the suggestions list.
	 */
	folderId: app_convex_Doc<"files_nodes">["parentId"];
	/**
	 * Write a new `committedQuery`, a new `viewQuery`, or both. A missing key stays as it is.
	 */
	onChange: (change: { committedQuery?: string; viewQuery?: string }) => void;
};

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
 * Whether a filter on this field with this operation can join the committed query. The parser decides,
 * so the bar never keeps its own copy of the pairing rules. The sample value only has to be valid.
 */
function can_add_filter(committedQuery: string, fieldText: string, operation: files_folder_table_query_Operation) {
	const field = files_folder_table_query_parse_field(fieldText).field;
	const value = field === "size" ? "0" : field === "updated" || field === "created" ? "2000-01-01" : "a";
	const raw = `${fieldText}:${operation.op}${operation.needsValue ? `:${value}` : ""}`;
	return files_folder_table_query_get_add_problem(committedQuery, raw) === null;
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
	const { ref, committedQuery, viewQuery, folderId, onChange } = props;

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
	const typedKeyDebounced = useDebounce(stage.kind === "key" || stage.kind === "sort_field" ? stage.typed : "", 150);
	const typedValueDebounced = useDebounce(stage.kind === "value" ? stage.typed : "", 150);

	const canAddSort = parsed.sorts.length === 0;

	// The file details the user can sort by or filter by. The folder's own keys show after them, from
	// `FileNodeViewFolderFilterBarKeyRows`.
	const allFieldRows = files_folder_table_query_FILE_FIELDS.map((name) => ({
		field: `file.${name}`,
		hint: FileNodeViewFolderFilterBar_FILE_FIELD_HINTS[name],
	}));
	const fieldRows = allFieldRows.filter((row) => row.field.toLowerCase().includes(typedLower));

	// The table runs one filter, or `file.name:starts_with` plus one "is" filter. A field shows when one
	// of its operations can still join.
	const canAddFilterOn = (fieldText: string) => {
		const field = files_folder_table_query_parse_field(fieldText).field;
		return (
			field !== null &&
			files_folder_table_query_operations(field).some((operation) =>
				can_add_filter(committedQuery, fieldText, operation),
			)
		);
	};
	const keyRows = stage.kind === "key" ? fieldRows.filter((row) => canAddFilterOn(row.field)) : [];
	const canAddFilter = stage.kind !== "key" || allFieldRows.some((row) => canAddFilterOn(row.field));
	const showSortKey = stage.kind === "key" && canAddSort && "sort_by".includes(typedLower);
	// While a filter is on, only the filter's order field can sort.
	const canSortBy = (fieldText: string) =>
		files_folder_table_query_get_add_problem(committedQuery, `sort_by:${fieldText}:asc`) === null;
	const sortFieldRows = stage.kind === "sort_field" ? fieldRows.filter((row) => canSortBy(row.field)) : [];
	// A folder key also needs a name the table can sort and filter by.
	const canFilterByKey = (field: string) => files_sort_field_is_valid(field) && canAddFilterOn(field);
	const canSortByKey = (field: string) => files_sort_field_is_valid(field) && canSortBy(field);
	const sortDirectionRows =
		stage.kind === "sort_direction" ? ["asc", "desc"].filter((direction) => direction.startsWith(typedLower)) : [];

	const operationRows = ((/* iife */) => {
		if (stage.kind !== "operation") {
			return [];
		}

		const field = files_folder_table_query_parse_field(stage.field).field;
		return field === null
			? []
			: files_folder_table_query_operations(field).filter(
					(operation) =>
						operation.op.startsWith(typedLower) && can_add_filter(committedQuery, stage.field, operation),
				);
	})();

	// Only the folder fields have values to suggest. File details have no value list.
	const valueFieldPath =
		stage.kind === "value" &&
		(stage.field.startsWith("metadata.") || stage.field.startsWith("frontmatter.")) &&
		files_folder_table_query_parse_field(stage.field).field !== null
			? stage.field
			: null;

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
		// Returning from chips or suggestions keeps the current menu state.
		if (!rootRef.current?.contains(event.relatedTarget) && !suggestionsRef.current?.contains(event.relatedTarget)) {
			setIsSuggestionsOpen(true);
		}
	});

	const handleInputBlur = useFn<NonNullable<MyComboboxInputControl_Props["onBlur"]>>(() => {
		setIsFocused(false);
	});

	const handleSuggestionsError = useFn((error: unknown) =>
		console.error("[FileNodeViewFolderFilterBar] Failed to load suggestions", { error, membershipId, folderId }),
	);

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
							{stage.kind === "key" && canAddFilter ? (
								<MyComboboxGroup heading="Filter by" separator={showSortKey}>
									{keyRows.map((row) => (
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
									<CatchBoundary
										getResetKey={() => `${membershipId}\n${folderId}\nkey\n${typedKeyDebounced}`}
										onCatch={handleSuggestionsError}
										errorComponent={FileNodeViewFolderFilterBarSuggestionsError}
									>
										<FileNodeViewFolderFilterBarKeyRows
											membershipId={membershipId}
											folderId={folderId}
											prefix={typedKeyDebounced}
											stale={stage.typed !== typedKeyDebounced}
											showNoMatch={keyRows.length === 0}
											canPick={canFilterByKey}
											onPick={(field) => pickPart(`${field}:`)}
										/>
									</CatchBoundary>
								</MyComboboxGroup>
							) : null}
							{stage.kind === "sort_field" ? (
								<MyComboboxGroup heading="Sort by">
									{sortFieldRows.map((row) => (
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
									<CatchBoundary
										getResetKey={() => `${membershipId}\n${folderId}\nsort\n${typedKeyDebounced}`}
										onCatch={handleSuggestionsError}
										errorComponent={FileNodeViewFolderFilterBarSuggestionsError}
									>
										<FileNodeViewFolderFilterBarKeyRows
											membershipId={membershipId}
											folderId={folderId}
											prefix={typedKeyDebounced}
											stale={stage.typed !== typedKeyDebounced}
											showNoMatch={sortFieldRows.length === 0}
											canPick={canSortByKey}
											onPick={(field) => pickPart(`sort_by:${field}:`)}
										/>
									</CatchBoundary>
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
							{valueFieldPath !== null && stage.kind === "value" ? (
								<MyComboboxGroup heading={`Values for ${stage.field}`}>
									<CatchBoundary
										getResetKey={() => `${membershipId}\n${valueFieldPath}\n${typedValueDebounced}`}
										onCatch={handleSuggestionsError}
										errorComponent={FileNodeViewFolderFilterBarSuggestionsError}
									>
										<FileNodeViewFolderFilterBarValueRows
											membershipId={membershipId}
											fieldPath={valueFieldPath}
											prefix={typedValueDebounced}
											typed={stage.typed}
											stale={stage.typed !== typedValueDebounced}
											onPick={(value) =>
												pickToken(`${stage.field}:${stage.operation}:${files_folder_table_query_format_value(value)}`)
											}
										/>
									</CatchBoundary>
								</MyComboboxGroup>
							) : null}
						</MyComboboxPopoverContent>
					</MyComboboxList>
					<div className={cn("FileNodeViewFolderFilterBar-notes" satisfies FileNodeViewFolderFilterBar_ClassNames)}>
						{stage.kind === "key" && !canAddFilter ? (
							<p>Use one filter, or 'name starts with' plus one 'is' filter</p>
						) : null}
					</div>
				</MyComboboxPopoverScrollableArea>
			</MyComboboxPopover>
		</MyCombobox>
	);
});
// #endregion folder filter bar
