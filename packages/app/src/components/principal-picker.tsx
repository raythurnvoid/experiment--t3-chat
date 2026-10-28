import "./principal-picker.css";

import { usePaginatedQuery } from "convex/react";
import { Plug, Search, ShieldCheck } from "lucide-react";
import { memo, useId, useState, type ReactNode, type RefObject } from "react";

import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
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
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { compute_fallback_user_name } from "@/lib/utils.ts";
import type { access_control_RoleRef } from "../../shared/access-control.ts";

/**
 * Who one access row is about: a person, a role, or an app. The code calls an app a service account.
 */
export type PrincipalPicker_Principal =
	| { kind: "user"; userId: app_convex_Id<"users"> }
	| { kind: "role"; role: access_control_RoleRef }
	| { kind: "service_account"; serviceAccountId: app_convex_Id<"access_control_service_accounts"> };

/**
 * One string that stands for one principal.
 *
 * The kind prefix is what keeps the kinds apart: a custom role id and a user id are both plain Convex
 * ids, so without it they could collide. The server keys share grants and plugin access entries by the
 * same string.
 */
function principal_picker_value(principal: PrincipalPicker_Principal) {
	return principal.kind === "user"
		? `user:${principal.userId}`
		: principal.kind === "role"
			? `role:${principal.role}`
			: `service_account:${principal.serviceAccountId}`;
}

function principal_picker_from_value(value: string): PrincipalPicker_Principal | null {
	if (value.startsWith("user:")) {
		return { kind: "user", userId: value.slice("user:".length) as app_convex_Id<"users"> };
	}
	if (value.startsWith("role:")) {
		return { kind: "role", role: value.slice("role:".length) as access_control_RoleRef };
	}
	if (value.startsWith("service_account:")) {
		return {
			kind: "service_account",
			serviceAccountId: value.slice("service_account:".length) as app_convex_Id<"access_control_service_accounts">,
		};
	}

	// The empty value before a pick lands here.
	return null;
}

/**
 * People and apps per page. "Show more" reads the next page.
 */
const PAGE_SIZE = 20;

/**
 * The keys that narrow the menu to one kind. The menu lists them, so nobody has to know them.
 */
const FILTER_KEYS = [
	{ key: "people:", scope: "people", hint: "Only people" },
	{ key: "role:", scope: "roles", hint: "Only workspace roles" },
	{ key: "app:", scope: "apps", hint: "Only apps" },
] as const;

/**
 * Split the text into an optional scope and the words to match. `people:ada` searches only people,
 * `role:edit` only roles, and `app:back` only apps. Without a prefix, the search covers all three.
 */
function parse_search_text(text: string) {
	const match = /^\s*(people|person|roles?|apps?)\s*:\s*/iu.exec(text);
	if (!match) {
		return { scope: "all" as const, term: text.trim() };
	}

	const word = match[1].toLowerCase();
	return {
		scope: word.startsWith("app")
			? ("apps" as const)
			: word.startsWith("role")
				? ("roles" as const)
				: ("people" as const),
		term: text.slice(match[0].length).trim(),
	};
}

type PrincipalPicker_ClassNames =
	| "PrincipalPicker"
	| "PrincipalPicker-popover"
	| "PrincipalPicker-popover-scrollable-area"
	| "PrincipalPicker-option"
	| "PrincipalPicker-option-icon"
	| "PrincipalPicker-option-name"
	| "PrincipalPicker-option-note"
	| "PrincipalPicker-status";

type PrincipalPicker_CustomAttributes = {
	/** On the field: the value of the picked row, or "" before a pick. */
	"data-principal-picker-value": string;
	/** On each person, role, and app row: its value. */
	"data-principal-picker-option": string;
};

type PrincipalPicker_Props = {
	ref: RefObject<HTMLInputElement | null>;
	/** The field's accessible name. */
	label: string;
	placeholder: string;
	text: string;
	/** The value of the picked row, or "" before a pick. */
	selectedValue: string;
	/** The values already on the list. Their rows show "Added" and cannot be picked. */
	takenValues: ReadonlySet<string>;
	ownerUserId: app_convex_Id<"users">;
	/** Every role the caller may pick, by name. Empty when they cannot pick roles. */
	roles: Array<{ role: access_control_RoleRef; name: string }>;
	canPickApps: boolean;
	disabled: boolean;
	onTextChange: (text: string) => void;
	onPick: (value: string, name: string) => void;
};

/**
 * The field that picks who gets access: avatars for people, icons for roles and apps, and `people:`,
 * `role:`, `app:` to narrow the menu. It works like the writers field in the Properties dialog.
 *
 * People and apps come from the server one page at a time, so a workspace of any size loads the same.
 * Roles are filtered here, because the list is small: the system roles plus at most 20 custom roles.
 */
const PrincipalPicker = Object.assign(
	memo(function PrincipalPicker(props: PrincipalPicker_Props) {
		const {
			ref,
			label,
			placeholder,
			text,
			selectedValue,
			takenValues,
			ownerUserId,
			roles,
			canPickApps,
			disabled,
			onTextChange,
			onPick,
		} = props;

		const { membershipId } = AppTenantProvider.useContext();
		const popoverId = useId();
		const [isMenuOpen, setIsMenuOpen] = useState(false);

		const menuLabel = canPickApps ? "People, roles, and apps" : "People and roles";
		const search = parse_search_text(text);
		const searchesPeople = search.scope === "all" || search.scope === "people";
		const searchesApps = canPickApps && (search.scope === "all" || search.scope === "apps");
		const people = usePaginatedQuery(
			app_convex_api.organizations_member_names.search_workspace_members,
			searchesPeople ? { membershipId, text: search.term } : "skip",
			{ initialNumItems: PAGE_SIZE },
		);
		const apps = usePaginatedQuery(
			app_convex_api.access_control.search_service_accounts,
			searchesApps ? { membershipId, text: search.term } : "skip",
			{ initialNumItems: PAGE_SIZE },
		);

		const roleRows =
			search.scope === "all" || search.scope === "roles"
				? roles.filter((role) => role.name.toLowerCase().includes(search.term.toLowerCase()))
				: [];
		// Offer the keys until one is chosen, and while the text could still become one.
		const keyRows =
			search.scope === "all"
				? FILTER_KEYS.filter(
						(row) =>
							row.key.startsWith(search.term.toLowerCase()) &&
							(row.scope !== "roles" || roles.length > 0) &&
							(row.scope !== "apps" || canPickApps),
					)
				: [];
		// A skipped search also says "LoadingFirstPage", and it never stops. So count only the searches
		// that run.
		const isLoading =
			(searchesPeople && people.status === "LoadingFirstPage") || (searchesApps && apps.status === "LoadingFirstPage");
		const hasRows = keyRows.length + people.results.length + roleRows.length + apps.results.length > 0;

		const handleTextChange = useFn<NonNullable<MyCombobox_Props["setValue"]>>((nextText) => {
			onTextChange(nextText);
			setIsMenuOpen(true);
		});

		const handlePickKey = (key: string) => {
			onTextChange(key);
			setIsMenuOpen(true);
			ref.current?.focus();
		};

		// The combobox input does not use the `MyInput` label id, so forward clicks on the area by hand.
		const handleFocusForward = useFn<NonNullable<MyInputArea_Props["onFocusForward"]>>((event) => {
			event.preventDefault();
			event.detail.originalEvent.preventDefault();
			ref.current?.focus();
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

		const renderOption = (args: { value: string; name: string; icon: ReactNode; note: string | null }) => {
			const { value, name, icon, note } = args;

			return (
				<MyComboboxItem
					key={value}
					value={value}
					disabled={note !== null}
					setValueOnClick={false}
					className={"PrincipalPicker-option" satisfies PrincipalPicker_ClassNames}
					{...({ "data-principal-picker-option": value } satisfies Partial<PrincipalPicker_CustomAttributes>)}
					onClick={() => onPick(value, name)}
				>
					{icon}
					<span className={"PrincipalPicker-option-name" satisfies PrincipalPicker_ClassNames}>{name}</span>
					{note ? (
						<span className={"PrincipalPicker-option-note" satisfies PrincipalPicker_ClassNames}>{note}</span>
					) : null}
				</MyComboboxItem>
			);
		};

		const renderShowMore = (args: { label: string; page: { status: string; loadMore: (count: number) => void } }) => {
			const { label: showMoreLabel, page } = args;

			return page.status === "CanLoadMore" || page.status === "LoadingMore" ? (
				<MyComboboxItem
					value={showMoreLabel}
					disabled={page.status === "LoadingMore"}
					hideOnClick={false}
					setValueOnClick={false}
					className={"PrincipalPicker-option" satisfies PrincipalPicker_ClassNames}
					onClick={() => page.loadMore(PAGE_SIZE)}
				>
					<span className={"PrincipalPicker-option-name" satisfies PrincipalPicker_ClassNames}>
						{page.status === "LoadingMore" ? "Loading…" : showMoreLabel}
					</span>
				</MyComboboxItem>
			) : null;
		};

		const optionIcon = (Icon: typeof ShieldCheck) => (
			<span className={"PrincipalPicker-option-icon" satisfies PrincipalPicker_ClassNames} aria-hidden>
				<Icon />
			</span>
		);

		return (
			<MyCombobox value={text} setValue={handleTextChange} open={isMenuOpen} setOpen={setIsMenuOpen}>
				<MyInput className={"PrincipalPicker" satisfies PrincipalPicker_ClassNames}>
					<MyInputBackground />
					<MyInputArea focusForwarding onFocusForward={handleFocusForward}>
						<MyInputIcon>
							<Search />
						</MyInputIcon>
						{/* The owner may put focus here when it opens and after each add, so focus alone must not
						    open the menu. Names are free text, so a phone keyboard must not capitalize or
						    correct them. */}
						<MyComboboxInputControl
							ref={ref}
							aria-label={label}
							placeholder={placeholder}
							{...({
								"data-principal-picker-value": selectedValue,
							} satisfies Partial<PrincipalPicker_CustomAttributes>)}
							disabled={disabled}
							showOnChange={false}
							showOnClick={false}
							showOnKeyPress={false}
							autoSelect
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							aria-keyshortcuts="Control+Space"
							onClick={() => setIsMenuOpen(true)}
							onKeyDown={handleInputKeyDown}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>

				<MyComboboxPopover
					id={popoverId}
					aria-label={menuLabel}
					sameWidth
					unmountOnHide
					className={"PrincipalPicker-popover" satisfies PrincipalPicker_ClassNames}
				>
					<MyComboboxPopoverScrollableArea
						className={"PrincipalPicker-popover-scrollable-area" satisfies PrincipalPicker_ClassNames}
					>
						<MyComboboxList aria-label={menuLabel}>
							<MyComboboxPopoverContent>
								{keyRows.length > 0 ? (
									<MyComboboxGroup heading="Filter by">
										{keyRows.map((row) => (
											<MyComboboxItem
												key={row.key}
												value={row.key}
												hideOnClick={false}
												setValueOnClick={false}
												className={"PrincipalPicker-option" satisfies PrincipalPicker_ClassNames}
												onClick={() => handlePickKey(row.key)}
											>
												<span className={"PrincipalPicker-option-name" satisfies PrincipalPicker_ClassNames}>
													{row.key}
												</span>
												<span className={"PrincipalPicker-option-note" satisfies PrincipalPicker_ClassNames}>
													{row.hint}
												</span>
											</MyComboboxItem>
										))}
									</MyComboboxGroup>
								) : null}
								{people.results.length > 0 ? (
									<MyComboboxGroup heading="People" separator={keyRows.length > 0}>
										{/* The owner and the people on the list stay in the menu, marked, so a search
										    for them says why they cannot be added instead of finding nothing. */}
										{people.results.map((member) => {
											const value = principal_picker_value({ kind: "user", userId: member.userId });
											const name = member.displayName || "Unknown";
											return renderOption({
												value,
												name,
												icon: (
													<MyAvatar size="28px">
														<MyAvatarImage src={member.avatarUrl ?? undefined} alt="" fallbackDelay={false} />
														<MyAvatarFallback>{compute_fallback_user_name(name)}</MyAvatarFallback>
													</MyAvatar>
												),
												note: member.userId === ownerUserId ? "Owner" : takenValues.has(value) ? "Added" : null,
											});
										})}
										{renderShowMore({ label: "Show more people", page: people })}
									</MyComboboxGroup>
								) : null}
								{roleRows.length > 0 ? (
									<MyComboboxGroup heading="Workspace roles" separator={keyRows.length + people.results.length > 0}>
										{roleRows.map((row) => {
											const value = principal_picker_value({ kind: "role", role: row.role });
											return renderOption({
												value,
												name: row.name,
												icon: optionIcon(ShieldCheck),
												note: takenValues.has(value) ? "Added" : null,
											});
										})}
									</MyComboboxGroup>
								) : null}
								{apps.results.length > 0 ? (
									<MyComboboxGroup
										heading="Apps"
										separator={keyRows.length + people.results.length + roleRows.length > 0}
									>
										{apps.results.map((account) => {
											const value = principal_picker_value({ kind: "service_account", serviceAccountId: account._id });
											return renderOption({
												value,
												name: account.name,
												icon: optionIcon(Plug),
												note: takenValues.has(value) ? "Added" : null,
											});
										})}
										{renderShowMore({ label: "Show more apps", page: apps })}
									</MyComboboxGroup>
								) : null}
								{!hasRows ? (
									<p className={"PrincipalPicker-status" satisfies PrincipalPicker_ClassNames}>
										{isLoading ? "Searching…" : "No matches."}
									</p>
								) : null}
							</MyComboboxPopoverContent>
						</MyComboboxList>
					</MyComboboxPopoverScrollableArea>
				</MyComboboxPopover>
			</MyCombobox>
		);
	}),
	{
		value: principal_picker_value,
		fromValue: principal_picker_from_value,
	},
);

export { PrincipalPicker };
