import "./files-write-policy-writers-modal.css";

import { usePaginatedQuery, useQueries } from "convex/react";
import { Plug, Search } from "lucide-react";
import { memo, useId, useMemo, useRef, useState } from "react";

import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyButton } from "@/components/my-button.tsx";
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
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputIcon,
	type MyInputArea_Props,
} from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { compute_fallback_user_name, cn } from "@/lib/utils.ts";

/**
 * One person or plugin that may edit. The name is only for showing. The save call sends the ids.
 * The code calls a plugin a service account.
 */
export type FilesWritePolicyWriter =
	| { kind: "user"; userId: app_convex_Id<"users">; name: string }
	| { kind: "service_account"; serviceAccountId: app_convex_Id<"access_control_service_accounts">; name: string };

function files_write_policy_writer_key(
	writer:
		| { kind: "user"; userId: app_convex_Id<"users"> }
		| { kind: "service_account"; serviceAccountId: app_convex_Id<"access_control_service_accounts"> },
) {
	return writer.kind === "user" ? `user:${writer.userId}` : `service_account:${writer.serviceAccountId}`;
}

type Candidate = {
	writer: FilesWritePolicyWriter;
	avatarUrl: string | undefined;
};

/**
 * People and plugins per page. "Show more" reads the next page.
 */
const PAGE_SIZE = 20;

/**
 * The keys that narrow the menu to one kind. The menu lists them, so nobody has to know them.
 */
const FILTER_KEYS = [
	{ key: "people:", hint: "Only people" },
	{ key: "plugin:", hint: "Only plugins" },
];

/**
 * Split the text into an optional scope and the words to match. `people:ada` searches only people
 * and `plugin:back` only plugins. Without a prefix, the search covers both.
 */
function parse_search_text(text: string) {
	const match = /^\s*(people|person|plugins?)\s*:\s*/iu.exec(text);
	if (!match) {
		return { scope: "all" as const, term: text.trim().toLowerCase() };
	}

	return {
		scope: match[1].toLowerCase().startsWith("plug") ? ("plugins" as const) : ("people" as const),
		term: text.slice(match[0].length).trim().toLowerCase(),
	};
}

function read_avatar_url(
	value: app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error,
) {
	return value == null || value instanceof Error ? undefined : value.avatarUrl;
}

// #region content
type FilesWritePolicyWritersModalContent_ClassNames =
	| "FilesWritePolicyWritersModalContent"
	| "FilesWritePolicyWritersModalContent-popover"
	| "FilesWritePolicyWritersModalContent-popover-scrollable-area"
	| "FilesWritePolicyWritersModalContent-suggestion"
	| "FilesWritePolicyWritersModalContent-suggestion-hint"
	| "FilesWritePolicyWritersModalContent-empty"
	| "FilesWritePolicyWritersModalContent-group"
	| "FilesWritePolicyWritersModalContent-group-heading"
	| "FilesWritePolicyWritersModalContent-list"
	| "FilesWritePolicyWritersModalContent-row"
	| "FilesWritePolicyWritersModalContent-row-icon"
	| "FilesWritePolicyWritersModalContent-row-name"
	| "FilesWritePolicyWritersModalContent-note";

type FilesWritePolicyWritersModalContent_Props = {
	writers: FilesWritePolicyWriter[];
	hiddenWriterCount: number;
	onWritersChange: (writers: FilesWritePolicyWriter[]) => void;
};

/**
 * The field and the two lists. It mounts only while the dialog is open, so people and plugins are
 * searched only when somebody wants to change the writers.
 *
 * The field works like the file search box: the menu lists people and plugins, and typing narrows it.
 * Writers already on the list stay in the menu as locked "Added" rows.
 * Picking a row adds it at once and keeps the menu open, so adding several is quick.
 *
 * People and plugins come from the server one page at a time, so a workspace of any size loads the
 * same.
 */
const FilesWritePolicyWritersModalContent = memo(function FilesWritePolicyWritersModalContent(
	props: FilesWritePolicyWritersModalContent_Props,
) {
	const { writers, hiddenWriterCount, onWritersChange } = props;

	const { membershipId } = AppTenantProvider.useContext();
	const popoverId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [text, setText] = useState("");
	const [isMenuOpen, setIsMenuOpen] = useState(false);

	const search = parse_search_text(text);
	const searchesPeople = search.scope !== "plugins";
	const searchesPlugins = search.scope !== "people";
	const people = usePaginatedQuery(
		app_convex_api.organizations_member_names.search_workspace_members,
		searchesPeople ? { membershipId, text: search.term } : "skip",
		{ initialNumItems: PAGE_SIZE },
	);
	const plugins = usePaginatedQuery(
		app_convex_api.access_control.search_service_accounts,
		searchesPlugins ? { membershipId, text: search.term } : "skip",
		{ initialNumItems: PAGE_SIZE },
	);

	const addedPeople = writers.filter((writer) => writer.kind === "user");
	const addedPlugins = writers.filter((writer) => writer.kind === "service_account");

	// The avatars of the people on the list. The list is the rule's own writers, not the workspace.
	const addedPeopleProfiles = useQueries(
		useMemo(
			() =>
				Object.fromEntries(
					addedPeople.map((writer) => [
						writer.userId,
						{
							query: app_convex_api.users.get_anagraphic,
							args: { userId: writer.userId },
						},
					]),
				),
			[addedPeople],
		),
	);

	const peopleRows: Candidate[] = people.results.map((member) => ({
		writer: { kind: "user", userId: member.userId, name: member.displayName || "Unknown" },
		avatarUrl: member.avatarUrl ?? undefined,
	}));
	const pluginRows: Candidate[] = plugins.results.map((account) => ({
		writer: { kind: "service_account", serviceAccountId: account._id, name: account.name },
		avatarUrl: undefined,
	}));
	const addedKeys = new Set(writers.map(files_write_policy_writer_key));
	// Offer the keys until one is chosen, and while the text could still become one.
	const keyRows = search.scope === "all" ? FILTER_KEYS.filter((row) => row.key.startsWith(search.term)) : [];
	// A skipped search also says "LoadingFirstPage", and it never stops. So count only the searches
	// that run.
	const isLoading =
		(searchesPeople && people.status === "LoadingFirstPage") ||
		(searchesPlugins && plugins.status === "LoadingFirstPage");

	const handleAdd = (candidate: Candidate) => {
		onWritersChange([...writers, candidate.writer]);
		setText("");
	};

	const handlePickKey = (key: string) => {
		setText(key);
		setIsMenuOpen(true);
		inputRef.current?.focus();
	};

	const handleRemove = (writer: FilesWritePolicyWriter) => {
		const removedKey = files_write_policy_writer_key(writer);
		onWritersChange(writers.filter((current) => files_write_policy_writer_key(current) !== removedKey));
	};

	const handleTextChange = useFn<NonNullable<MyCombobox_Props["setValue"]>>((nextText) => {
		setText(nextText);
		setIsMenuOpen(true);
	});

	// The combobox input does not use the `MyInput` label id, so forward clicks on the area by hand.
	const handleFocusForward = useFn<NonNullable<MyInputArea_Props["onFocusForward"]>>((event) => {
		event.preventDefault();
		event.detail.originalEvent.preventDefault();
		inputRef.current?.focus();
	});

	const handleInputKeyDown = useFn<NonNullable<MyComboboxInputControl_Props["onKeyDown"]>>((event) => {
		// Ctrl+Space and the arrow keys open the menu, the same way the file search box does.
		if (
			(event.key === " " && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) ||
			event.key === "ArrowDown"
		) {
			event.preventDefault();
			setIsMenuOpen(true);
		}
	});

	// The people and plugins on the list stay in the menu, marked, so a search for them says why they
	// cannot be added instead of finding nothing.
	const renderCandidate = (candidate: Candidate) => {
		const isAdded = addedKeys.has(files_write_policy_writer_key(candidate.writer));

		return (
			<MyComboboxItem
				key={files_write_policy_writer_key(candidate.writer)}
				value={files_write_policy_writer_key(candidate.writer)}
				disabled={isAdded}
				hideOnClick={false}
				setValueOnClick={false}
				className={cn(
					"FilesWritePolicyWritersModalContent-suggestion" satisfies FilesWritePolicyWritersModalContent_ClassNames,
				)}
				onClick={() => handleAdd(candidate)}
			>
				<WriterIcon writer={candidate.writer} avatarUrl={candidate.avatarUrl} />
				<span
					className={cn(
						"FilesWritePolicyWritersModalContent-row-name" satisfies FilesWritePolicyWritersModalContent_ClassNames,
					)}
				>
					{candidate.writer.name}
				</span>
				{isAdded ? (
					<span
						className={cn(
							"FilesWritePolicyWritersModalContent-suggestion-hint" satisfies FilesWritePolicyWritersModalContent_ClassNames,
						)}
					>
						Added
					</span>
				) : null}
			</MyComboboxItem>
		);
	};

	const renderShowMore = (args: { label: string; page: { status: string; loadMore: (count: number) => void } }) => {
		const { label, page } = args;

		return page.status === "CanLoadMore" || page.status === "LoadingMore" ? (
			<MyComboboxItem
				value={label}
				disabled={page.status === "LoadingMore"}
				hideOnClick={false}
				setValueOnClick={false}
				className={cn(
					"FilesWritePolicyWritersModalContent-suggestion" satisfies FilesWritePolicyWritersModalContent_ClassNames,
				)}
				onClick={() => page.loadMore(PAGE_SIZE)}
			>
				<span
					className={cn(
						"FilesWritePolicyWritersModalContent-row-name" satisfies FilesWritePolicyWritersModalContent_ClassNames,
					)}
				>
					{page.status === "LoadingMore" ? "Loading…" : label}
				</span>
			</MyComboboxItem>
		) : null;
	};

	const renderGroup = (args: { heading: string; emptyText: string; groupWriters: FilesWritePolicyWriter[] }) => {
		const { heading, emptyText, groupWriters } = args;

		return (
			<section
				aria-label={heading}
				className={cn(
					"FilesWritePolicyWritersModalContent-group" satisfies FilesWritePolicyWritersModalContent_ClassNames,
				)}
			>
				<h3
					className={cn(
						"FilesWritePolicyWritersModalContent-group-heading" satisfies FilesWritePolicyWritersModalContent_ClassNames,
					)}
				>
					{heading} ({groupWriters.length})
				</h3>
				{groupWriters.length > 0 ? (
					<ul
						className={cn(
							"FilesWritePolicyWritersModalContent-list" satisfies FilesWritePolicyWritersModalContent_ClassNames,
						)}
					>
						{groupWriters.map((writer) => (
							<li
								key={files_write_policy_writer_key(writer)}
								className={cn(
									"FilesWritePolicyWritersModalContent-row" satisfies FilesWritePolicyWritersModalContent_ClassNames,
								)}
							>
								<WriterIcon
									writer={writer}
									avatarUrl={writer.kind === "user" ? read_avatar_url(addedPeopleProfiles[writer.userId]) : undefined}
								/>
								<span
									className={cn(
										"FilesWritePolicyWritersModalContent-row-name" satisfies FilesWritePolicyWritersModalContent_ClassNames,
									)}
								>
									{writer.name}
								</span>
								<MyButton
									variant="ghost-highlightable"
									aria-label={`Remove ${writer.name}`}
									onClick={() => handleRemove(writer)}
								>
									Remove
								</MyButton>
							</li>
						))}
					</ul>
				) : (
					<p
						className={cn(
							"FilesWritePolicyWritersModalContent-empty" satisfies FilesWritePolicyWritersModalContent_ClassNames,
						)}
					>
						{emptyText}
					</p>
				)}
			</section>
		);
	};

	return (
		<div className={cn("FilesWritePolicyWritersModalContent" satisfies FilesWritePolicyWritersModalContent_ClassNames)}>
			<MyCombobox value={text} setValue={handleTextChange} open={isMenuOpen} setOpen={setIsMenuOpen}>
				<MyInput>
					<MyInputBackground />
					<MyInputArea focusForwarding onFocusForward={handleFocusForward}>
						<MyInputIcon>
							<Search />
						</MyInputIcon>
						{/* The menu opens by hand, like the file search box. Names are free text, so a phone
						    keyboard must not capitalize or correct them. */}
						<MyComboboxInputControl
							ref={inputRef}
							aria-label="Add a person or plugin"
							placeholder="Add a person or plugin…"
							showOnChange={false}
							showOnClick={false}
							showOnKeyPress={false}
							autoSelect
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							aria-keyshortcuts="Control+Space"
							onFocus={() => setIsMenuOpen(true)}
							onClick={() => setIsMenuOpen(true)}
							onKeyDown={handleInputKeyDown}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>

				<MyComboboxPopover
					id={popoverId}
					aria-label="People and plugins"
					sameWidth
					unmountOnHide
					className={cn(
						"FilesWritePolicyWritersModalContent-popover" satisfies FilesWritePolicyWritersModalContent_ClassNames,
					)}
				>
					<MyComboboxPopoverScrollableArea
						className={cn(
							"FilesWritePolicyWritersModalContent-popover-scrollable-area" satisfies FilesWritePolicyWritersModalContent_ClassNames,
						)}
					>
						<MyComboboxList aria-label="People and plugins">
							<MyComboboxPopoverContent>
								{keyRows.length > 0 ? (
									<MyComboboxGroup heading="Filter by">
										{keyRows.map((row) => (
											<MyComboboxItem
												key={row.key}
												value={row.key}
												hideOnClick={false}
												setValueOnClick={false}
												className={cn(
													"FilesWritePolicyWritersModalContent-suggestion" satisfies FilesWritePolicyWritersModalContent_ClassNames,
												)}
												onClick={() => handlePickKey(row.key)}
											>
												<span
													className={cn(
														"FilesWritePolicyWritersModalContent-row-name" satisfies FilesWritePolicyWritersModalContent_ClassNames,
													)}
												>
													{row.key}
												</span>
												<span
													className={cn(
														"FilesWritePolicyWritersModalContent-suggestion-hint" satisfies FilesWritePolicyWritersModalContent_ClassNames,
													)}
												>
													{row.hint}
												</span>
											</MyComboboxItem>
										))}
									</MyComboboxGroup>
								) : null}
								{peopleRows.length > 0 ? (
									<MyComboboxGroup heading="People" separator={keyRows.length > 0}>
										{peopleRows.map(renderCandidate)}
										{renderShowMore({ label: "Show more people", page: people })}
									</MyComboboxGroup>
								) : null}
								{pluginRows.length > 0 ? (
									<MyComboboxGroup heading="Plugins" separator={keyRows.length > 0 || peopleRows.length > 0}>
										{pluginRows.map(renderCandidate)}
										{renderShowMore({ label: "Show more plugins", page: plugins })}
									</MyComboboxGroup>
								) : null}
								{keyRows.length === 0 && peopleRows.length === 0 && pluginRows.length === 0 ? (
									<p
										className={cn(
											"FilesWritePolicyWritersModalContent-empty" satisfies FilesWritePolicyWritersModalContent_ClassNames,
										)}
									>
										{isLoading ? "Searching…" : "No matches."}
									</p>
								) : null}
							</MyComboboxPopoverContent>
						</MyComboboxList>
					</MyComboboxPopoverScrollableArea>
				</MyComboboxPopover>
			</MyCombobox>

			{renderGroup({ heading: "People", emptyText: "No people yet.", groupWriters: addedPeople })}
			{renderGroup({ heading: "Plugins", emptyText: "No plugins yet.", groupWriters: addedPlugins })}

			{/* Hidden writers are people who left and plugins that were revoked. Their names are private, so
			    only their count shows. Saving the rule drops them. */}
			{hiddenWriterCount > 0 ? (
				<p
					className={cn(
						"FilesWritePolicyWritersModalContent-note" satisfies FilesWritePolicyWritersModalContent_ClassNames,
					)}
				>
					{hiddenWriterCount === 1
						? "1 more writer is no longer available. Saving removes it."
						: `${hiddenWriterCount} more writers are no longer available. Saving removes them.`}
				</p>
			) : null}
		</div>
	);
});

type WriterIcon_Props = {
	writer: FilesWritePolicyWriter;
	avatarUrl: string | undefined;
};

/**
 * A round avatar for a person, and a square plug icon for a plugin.
 */
const WriterIcon = memo(function WriterIcon(props: WriterIcon_Props) {
	const { writer, avatarUrl } = props;

	if (writer.kind === "user") {
		return (
			<MyAvatar size="28px">
				<MyAvatarImage src={avatarUrl} alt="" fallbackDelay={false} />
				<MyAvatarFallback>{compute_fallback_user_name(writer.name)}</MyAvatarFallback>
			</MyAvatar>
		);
	}

	return (
		<span
			className={cn(
				"FilesWritePolicyWritersModalContent-row-icon" satisfies FilesWritePolicyWritersModalContent_ClassNames,
			)}
			aria-hidden
		>
			<Plug />
		</span>
	);
});
// #endregion content

// #region root
type FilesWritePolicyWritersModal_ClassNames = "FilesWritePolicyWritersModal";

type FilesWritePolicyWritersModal_Props = {
	open: boolean;
	setOpen: (open: boolean) => void;
	title: string;
	subtitle: string;
	writers: FilesWritePolicyWriter[];
	hiddenWriterCount: number;
	onWritersChange: (writers: FilesWritePolicyWriter[]) => void;
};

/**
 * The dialog where a person adds and removes the writers of a rule. It changes only the draft of the
 * Properties dialog. The Save button in that dialog writes it.
 */
const FilesWritePolicyWritersModal = Object.assign(
	memo(function FilesWritePolicyWritersModal(props: FilesWritePolicyWritersModal_Props) {
		const { open, setOpen, title, subtitle, writers, hiddenWriterCount, onWritersChange } = props;

		const handleDone = useFn(() => {
			setOpen(false);
		});

		return (
			<MyModal open={open} setOpen={setOpen}>
				<MyModalPopover className={"FilesWritePolicyWritersModal" satisfies FilesWritePolicyWritersModal_ClassNames}>
					<MyModalHeader>
						<MyModalHeading>{title}</MyModalHeading>
						<MyModalDescription>{subtitle}</MyModalDescription>
					</MyModalHeader>

					<MyModalScrollableArea>
						{open ? (
							<FilesWritePolicyWritersModalContent
								writers={writers}
								hiddenWriterCount={hiddenWriterCount}
								onWritersChange={onWritersChange}
							/>
						) : null}
					</MyModalScrollableArea>

					<MyModalFooter>
						<MyButton onClick={handleDone}>Done</MyButton>
					</MyModalFooter>
					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		);
	}),
	{
		/**
		 * A stable id for a writer, used for React keys and to compare two lists of writers.
		 */
		writerKey: files_write_policy_writer_key,
	},
);

export { FilesWritePolicyWritersModal };
// #endregion root
