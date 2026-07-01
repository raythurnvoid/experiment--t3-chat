import "./main-app-header-organization-controls-modal.css";

import type { FunctionArgs, FunctionReturnType } from "convex/server";
import {
	memo,
	useEffect,
	useImperativeHandle,
	useId,
	useRef,
	useState,
	type ComponentPropsWithoutRef,
	type Dispatch,
	type Ref,
	type RefObject,
	type ReactNode,
	type SetStateAction,
} from "react";
import {
	Building2,
	ChevronRight,
	CircleHelp,
	CreditCard,
	EllipsisVertical,
	FolderKanban,
	Info,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";

import { useFn, useLiveRef } from "@/hooks/utils-hooks.ts";
import { MyPrimaryAction } from "@/components/my-action.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import {
	MyMenu,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuTrigger,
} from "@/components/my-menu.tsx";
import {
	MyInput,
	MyInputBackground,
	MyInputBox,
	MyInputArea,
	MyInputControl,
	MyInputHelperText,
	MyInputLabel,
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
import {
	MyRadioCard,
	MyRadioCardDescription,
	MyRadioCardLabel,
} from "@/components/my-radio-card.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipInfoTrigger, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { MyFocus, type MyFocus_ClassNames } from "@/lib/my-focus.ts";
import {
	organizations_DESCRIPTION_MAX_LENGTH,
	organizations_NAME_MAX_LENGTH,
	organizations_NAME_MIN_LENGTH,
	organizations_description_normalize,
	organizations_name_autofix,
	organizations_name_validate,
} from "@/lib/organizations.ts";
import { cn } from "@/lib/utils.ts";
import { quotas } from "../../shared/quotas.ts";

function is_rejected_name_message(validationMessage: string) {
	return validationMessage === "Organization name already exists" || validationMessage === "Workspace name already exists";
}

// Use canonical submit values so autofix-only edits do not enable Save.
function get_canonical_name_value(value: string) {
	return organizations_name_autofix(value);
}

function get_canonical_description_value(value: string) {
	const validatedDescription = organizations_description_normalize(value);

	return validatedDescription._nay ? value.trim() : validatedDescription._yay;
}

function validate_name_field_input(
	el: HTMLInputElement,
	canonicalName: string,
	rejectedValueMessagesMap: Map<string, string>,
) {
	const normalized = organizations_name_autofix(el.value, { trim_trailing_hyphens: false });
	if (el.value !== normalized) {
		el.value = normalized;
	}

	const validated = organizations_name_validate(normalized);
	const rejectedValueMessage = validated._yay ? rejectedValueMessagesMap.get(canonicalName) : undefined;
	const validationMessage = validated._nay?.message ?? (validated._yay ? rejectedValueMessage : undefined);

	return { validationMessage };
}

function validate_description_field_input(el: HTMLInputElement) {
	const validated = organizations_description_normalize(el.value);
	const validationMessage = validated._nay?.message;

	return { validationMessage };
}

// #region list item model
export type MainAppHeaderOrganizationSwitcherModal_ListItem = {
	id: string;
	label: string;
	description: string;
	isCurrent?: boolean;
	isDefault?: boolean;
	ownershipBadge?: "personal" | "owner" | "member";
	billingBadge?: "members_pay" | "my_balance" | "owner_pays";
	onManageBilling?: () => void;
	onEdit?: () => void;
	onDelete?: () => void;
	onSelect: () => void;
};
// #endregion list item model

// #region edit target / callback
export type MainAppHeaderOrganizationSwitcherModal_EditTarget =
	| {
			kind: "organization";
			id: string;
			initialName: string;
			initialDescription: string;
			defaultWorkspaceId: app_convex_Id<"organizations_workspaces">;
	  }
	| {
			kind: "workspace";
			id: string;
			initialName: string;
			initialDescription: string;
			organizationId: app_convex_Id<"organizations">;
			defaultWorkspaceId: app_convex_Id<"organizations_workspaces">;
	  };

export type MainAppHeaderOrganizationSwitcherModal_AfterEdit = {
	kind: "workspace" | "organization";
	oldName: string;
	newName: string;
	organizationId: app_convex_Id<"organizations">;
	workspaceId?: app_convex_Id<"organizations_workspaces">;
};

export type MainAppHeaderOrganizationSwitcherModal_BillingTarget = {
	organizationId: app_convex_Id<"organizations">;
	organizationName: string;
	billingMode: "user" | "organization_owner";
};
// #endregion edit target / callback

// #region list item
type MainAppHeaderOrganizationSwitcherModalListItem_ClassNames =
	| "MainAppHeaderOrganizationSwitcherModalListItem"
	| "MainAppHeaderOrganizationSwitcherModalListItem-primary"
	| "MainAppHeaderOrganizationSwitcherModalListItem-label-row"
	| "MainAppHeaderOrganizationSwitcherModalListItem-label"
	| "MainAppHeaderOrganizationSwitcherModalListItem-badge"
	| "MainAppHeaderOrganizationSwitcherModalListItem-ownership-badge"
	| "MainAppHeaderOrganizationSwitcherModalListItem-billing-badge"
	| "MainAppHeaderOrganizationSwitcherModalListItem-description"
	| "MainAppHeaderOrganizationSwitcherModalListItem-actions"
	| "MainAppHeaderOrganizationSwitcherModalListItem-action"
	| "MainAppHeaderOrganizationSwitcherModalListItem-current-border";

export type MainAppHeaderOrganizationSwitcherModalListItem_Props = {
	item: MainAppHeaderOrganizationSwitcherModal_ListItem;
	kind: "workspace" | "organization";
};

export const MainAppHeaderOrganizationSwitcherModalListItem = memo(function MainAppHeaderOrganizationSwitcherModalListItem(
	props: MainAppHeaderOrganizationSwitcherModalListItem_Props,
) {
	const { item, kind } = props;

	const handleSelect = useFn(() => {
		if (item.isCurrent) {
			return;
		}

		item.onSelect();
	});

	const handleEdit = useFn(() => {
		item.onEdit?.();
	});

	const handleDelete = useFn(() => {
		item.onDelete?.();
	});
	const handleManageBilling = useFn(() => {
		item.onManageBilling?.();
	});

	const descriptionText = item.description.trim() ? item.description : "(No description)";
	const isCurrent = Boolean(item.isCurrent);
	const isDefault = Boolean(item.isDefault);
	const canDelete = !isDefault && Boolean(item.onDelete);
	const showMenu = Boolean(item.onManageBilling || item.onEdit || item.onDelete);
	const itemKindLabel = kind === "organization" ? "organization" : "workspace";
	const itemActionLabel = `${itemKindLabel}: ${item.label}`;
	const selectLabel = isCurrent ? `Current ${itemActionLabel}` : `Select ${itemActionLabel}`;
	const moreActionsLabel = `More actions for ${itemActionLabel}`;
	const ownershipBadgeLabel =
		item.ownershipBadge === "personal"
			? "Personal"
			: item.ownershipBadge === "owner"
				? "Owner"
				: item.ownershipBadge === "member"
					? "Member"
					: null;
	const billingBadgeLabel =
		item.billingBadge === "members_pay"
			? "Members pay"
			: item.billingBadge === "my_balance"
				? "My balance"
				: item.billingBadge === "owner_pays"
					? "Owner pays"
					: null;

	return (
		<li
			className={cn(
				"MainAppHeaderOrganizationSwitcherModalListItem" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
			)}
		>
			<MyPrimaryAction
				className={cn(
					"MainAppHeaderOrganizationSwitcherModalListItem-primary" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
					"MyFocus-row" satisfies MyFocus_ClassNames,
				)}
				selected={isCurrent}
				aria-label={selectLabel}
				aria-current={isCurrent ? "true" : undefined}
				aria-disabled={isCurrent || undefined}
				tabIndex={isCurrent ? -1 : undefined}
				onClick={handleSelect}
			>
				{isCurrent && (
					<div
						className={cn(
							"MainAppHeaderOrganizationSwitcherModalListItem-current-border" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
						)}
						aria-hidden
					/>
				)}

				<div
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalListItem-label-row" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderOrganizationSwitcherModalListItem-label" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
						)}
					>
						{item.label}
					</div>
					{ownershipBadgeLabel ? (
						<span
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalListItem-badge" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
								"MainAppHeaderOrganizationSwitcherModalListItem-ownership-badge" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
							)}
						>
							{ownershipBadgeLabel}
						</span>
					) : null}
					{billingBadgeLabel ? (
						<span
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalListItem-badge" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
								"MainAppHeaderOrganizationSwitcherModalListItem-billing-badge" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
							)}
						>
							{billingBadgeLabel}
						</span>
					) : null}
				</div>

				<div
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalListItem-description" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
					)}
				>
					{descriptionText}
				</div>
			</MyPrimaryAction>

			{showMenu ? (
				<div
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalListItem-actions" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
					)}
				>
					<MyMenu>
						<MyMenuTrigger>
							<MyIconButton
								className={cn(
									"MainAppHeaderOrganizationSwitcherModalListItem-action" satisfies MainAppHeaderOrganizationSwitcherModalListItem_ClassNames,
								)}
								variant="ghost-highlightable"
								tooltip={moreActionsLabel}
							>
								<MyIconButtonIcon>
									<EllipsisVertical />
								</MyIconButtonIcon>
							</MyIconButton>
						</MyMenuTrigger>
						<MyMenuPopover>
							<MyMenuPopoverContent>
								{item.onManageBilling ? (
									<MyMenuItem aria-label={`Manage billing for ${itemActionLabel}`} onClick={handleManageBilling}>
										<MyMenuItemContent>
											<MyMenuItemContentIcon>
												<CreditCard />
											</MyMenuItemContentIcon>
											<MyMenuItemContentPrimary>Manage billing</MyMenuItemContentPrimary>
										</MyMenuItemContent>
									</MyMenuItem>
								) : null}
								{item.onEdit ? (
									<MyMenuItem aria-label={`Edit ${itemActionLabel}`} onClick={handleEdit}>
										<MyMenuItemContent>
											<MyMenuItemContentIcon>
												<Pencil />
											</MyMenuItemContentIcon>
											<MyMenuItemContentPrimary>Edit</MyMenuItemContentPrimary>
										</MyMenuItemContent>
									</MyMenuItem>
								) : null}
								{item.onDelete ? (
									<MyMenuItem
										aria-label={`Delete ${itemActionLabel}`}
										variant="destructive"
										disabled={!canDelete}
										onClick={handleDelete}
									>
										<MyMenuItemContent>
											<MyMenuItemContentIcon>
												<Trash2 />
											</MyMenuItemContentIcon>
											<MyMenuItemContentPrimary>Delete</MyMenuItemContentPrimary>
										</MyMenuItemContent>
									</MyMenuItem>
								) : null}
							</MyMenuPopoverContent>
						</MyMenuPopover>
					</MyMenu>
				</div>
			) : null}
		</li>
	);
});
// #endregion list item

// #region select head
type MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames =
	| "MainAppHeaderOrganizationSwitcherModalSelectHead"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-copy"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-icon"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-title-row"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-title"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-quota"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-help"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-create-trigger"
	| "MainAppHeaderOrganizationSwitcherModalSelectHead-create";

export type MainAppHeaderOrganizationSwitcherModalSelectHead_Props = {
	title: string;
	titleId: string;
	kind: "workspace" | "organization";
	createDisabled?: boolean;
	createDisabledReason?: string;
	quotaFraction?: string;
	quotaTooltip?: string;
	onCreate: () => void;
	iconSlot: ReactNode;
};

export const MainAppHeaderOrganizationSwitcherModalSelectHead = memo(
	function MainAppHeaderOrganizationSwitcherModalSelectHead(props: MainAppHeaderOrganizationSwitcherModalSelectHead_Props) {
		const {
			title,
			titleId,
			kind,
			createDisabled,
			createDisabledReason,
			quotaFraction,
			quotaTooltip,
			onCreate,
			iconSlot,
		} = props;

		const createDisabledTooltip = createDisabled ? createDisabledReason : undefined;
		const createLabel = kind === "organization" ? "Create organization" : "Create workspace";

		return (
			<div
				className={cn(
					"MainAppHeaderOrganizationSwitcherModalSelectHead" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
				)}
			>
				<MyIcon
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalSelectHead-icon" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
					)}
					aria-hidden
				>
					{iconSlot}
				</MyIcon>
				<div
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalSelectHead-copy" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
					)}
				>
					{quotaFraction && quotaTooltip ? (
						<div
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalSelectHead-title-row" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
							)}
						>
							<h2
								id={titleId}
								className={cn(
									"MainAppHeaderOrganizationSwitcherModalSelectHead-title" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
								)}
							>
								{title}
							</h2>
							<MyTooltip placement="bottom">
								<MyTooltipInfoTrigger>
									<span
										className={cn(
											"MainAppHeaderOrganizationSwitcherModalSelectHead-quota" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
										)}
									>
										{quotaFraction}
										<MyIcon
											className={cn(
												"MainAppHeaderOrganizationSwitcherModalSelectHead-help" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
											)}
											aria-hidden
										>
											<CircleHelp />
										</MyIcon>
									</span>
								</MyTooltipInfoTrigger>
								<MyTooltipContent unmountOnHide>
									<>{quotaTooltip}</>
								</MyTooltipContent>
							</MyTooltip>
						</div>
					) : (
						<div
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalSelectHead-title-row" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
							)}
						>
							<h2
								id={titleId}
								className={cn(
									"MainAppHeaderOrganizationSwitcherModalSelectHead-title" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
								)}
							>
								{title}
							</h2>
							{quotaFraction ? (
								<span
									className={cn(
										"MainAppHeaderOrganizationSwitcherModalSelectHead-quota" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
									)}
								>
									({quotaFraction})
								</span>
							) : null}
						</div>
					)}
				</div>
				{createDisabledTooltip ? (
					<MyTooltip placement="bottom">
						<MyTooltipTrigger>
							<span
								className={cn(
									"MainAppHeaderOrganizationSwitcherModalSelectHead-create-trigger" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
								)}
							>
								<MyButton
									className={cn(
										"MainAppHeaderOrganizationSwitcherModalSelectHead-create" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
									)}
									type="button"
									disabled
									variant="ghost-highlightable"
									aria-label={createLabel}
									onClick={onCreate}
								>
									<Plus aria-hidden />
									Create
								</MyButton>
							</span>
						</MyTooltipTrigger>
						<MyTooltipContent unmountOnHide>
							<>{createDisabledTooltip}</>
						</MyTooltipContent>
					</MyTooltip>
				) : (
					<MyButton
						className={cn(
							"MainAppHeaderOrganizationSwitcherModalSelectHead-create" satisfies MainAppHeaderOrganizationSwitcherModalSelectHead_ClassNames,
						)}
						type="button"
						disabled={Boolean(createDisabled)}
						variant="ghost-highlightable"
						aria-label={createLabel}
						onClick={onCreate}
					>
						<Plus aria-hidden />
						Create
					</MyButton>
				)}
			</div>
		);
	},
);
// #endregion select head

// #region select list
type MainAppHeaderOrganizationSwitcherModalSelectList_ClassNames = "MainAppHeaderOrganizationSwitcherModalSelectList";

export type MainAppHeaderOrganizationSwitcherModalSelectList_Props = {
	myFocusSyncKey: string;
	ariaLabel: string;
	children: ReactNode;
};

export const MainAppHeaderOrganizationSwitcherModalSelectList = memo(
	function MainAppHeaderOrganizationSwitcherModalSelectList(props: MainAppHeaderOrganizationSwitcherModalSelectList_Props) {
		const { myFocusSyncKey, ariaLabel, children } = props;

		const [list, setList] = useState<HTMLUListElement | null>(null);
		const focusRef = useRef<MyFocus | null>(null);

		useEffect(() => {
			if (!list) {
				return;
			}

			const focus = new MyFocus(list);
			focus.start();
			focusRef.current = focus;

			return () => {
				focusRef.current = null;
				focus.stop();
			};
		}, [list]);

		useEffect(() => {
			focusRef.current?.sync();
		}, [myFocusSyncKey]);

		return (
			<ul
				ref={setList}
				className={cn(
					"MainAppHeaderOrganizationSwitcherModalSelectList" satisfies MainAppHeaderOrganizationSwitcherModalSelectList_ClassNames,
					"MyFocus-container" satisfies MyFocus_ClassNames,
				)}
				aria-label={ariaLabel}
			>
				{children}
			</ul>
		);
	},
);
// #endregion select list

// #region select pane list
export type MainAppHeaderOrganizationSwitcherModalSelectPaneList_Props = {
	dialogOpen: boolean;
	title: string;
	kind: "workspace" | "organization";
	items: MainAppHeaderOrganizationSwitcherModalSelectPane_Props["items"];
	selectedItemId: string;
};

export const MainAppHeaderOrganizationSwitcherModalSelectPaneList = memo(
	function MainAppHeaderOrganizationSwitcherModalSelectPaneList(
		props: MainAppHeaderOrganizationSwitcherModalSelectPaneList_Props,
	) {
		const { dialogOpen, title, kind, items, selectedItemId } = props;

		const myFocusSyncKey = `${dialogOpen}:${selectedItemId}:${items.map((item) => item.id).join(",")}`;

		return (
			<MainAppHeaderOrganizationSwitcherModalSelectList myFocusSyncKey={myFocusSyncKey} ariaLabel={`${title} list`}>
				{items.map((item) => (
					<MainAppHeaderOrganizationSwitcherModalListItem
						key={item.id}
						kind={kind}
						item={{ ...item, isCurrent: item.id === selectedItemId }}
					/>
				))}
			</MainAppHeaderOrganizationSwitcherModalSelectList>
		);
	},
);
// #endregion select pane list

// #region select pane
type MainAppHeaderOrganizationSwitcherModalSelectPane_ClassNames = "MainAppHeaderOrganizationSwitcherModalSelectPane";

export type MainAppHeaderOrganizationSwitcherModalSelectPane_Props = {
	dialogOpen: boolean;
	title: string;
	kind: "workspace" | "organization";
	items: Omit<MainAppHeaderOrganizationSwitcherModal_ListItem, "isCurrent">[];
	selectedItemId: string;
	createDisabled?: boolean;
	createDisabledReason?: string;
	quotaFraction?: string;
	quotaTooltip?: string;
	onCreate: () => void;
	icon: ReactNode;
};

export const MainAppHeaderOrganizationSwitcherModalSelectPane = memo(
	function MainAppHeaderOrganizationSwitcherModalSelectPane(props: MainAppHeaderOrganizationSwitcherModalSelectPane_Props) {
		const {
			dialogOpen,
			title,
			kind,
			items,
			selectedItemId,
			createDisabled,
			createDisabledReason,
			quotaFraction,
			quotaTooltip,
			onCreate,
			icon,
		} = props;
		const titleId = `MainAppHeaderOrganizationSwitcherModalSelectPane-title-${kind}-${useId().replace(/:/g, "")}`;

		return (
			<section
				className={cn(
					"MainAppHeaderOrganizationSwitcherModalSelectPane" satisfies MainAppHeaderOrganizationSwitcherModalSelectPane_ClassNames,
				)}
				aria-label={title}
			>
				<MainAppHeaderOrganizationSwitcherModalSelectHead
					title={title}
					titleId={titleId}
					kind={kind}
					createDisabled={createDisabled}
					createDisabledReason={createDisabledReason}
					quotaFraction={quotaFraction}
					quotaTooltip={quotaTooltip}
					onCreate={onCreate}
					iconSlot={icon}
				/>

				<MainAppHeaderOrganizationSwitcherModalSelectPaneList
					dialogOpen={dialogOpen}
					title={title}
					kind={kind}
					items={items}
					selectedItemId={selectedItemId}
				/>
			</section>
		);
	},
);
// #endregion select pane

// #region create edit form field
type MainAppHeaderOrganizationCreateEditFormField_ClassNames =
	| "MainAppHeaderOrganizationCreateEditFormField-label-optional"
	| "MainAppHeaderOrganizationCreateEditFormField-helper-row"
	| "MainAppHeaderOrganizationCreateEditFormField-helper-message"
	| "MainAppHeaderOrganizationCreateEditFormField-helper-counter"
	| "MainAppHeaderOrganizationCreateEditFormField-helper-state-error";

type MainAppHeaderOrganizationCreateEditFormField_Props = {
	validationMessage?: string;
	displayValidationMessage?: string;
	inputRef: RefObject<HTMLInputElement | null>;
	label: ReactNode;
	placeholder: string;
	draftValueLength: number;
	required?: boolean;
	minLength?: number;
	maxLength: number;
	helperText?: string;
	isHelperTextInvalid?: boolean;
	isSubmitting: boolean;
	onCompositionEnd?: ComponentPropsWithoutRef<"input">["onCompositionEnd"];
	onBlur?: ComponentPropsWithoutRef<"input">["onBlur"];
	onInvalid?: ComponentPropsWithoutRef<"input">["onInvalid"];
	onInput: NonNullable<ComponentPropsWithoutRef<"input">["onInput"]>;
	onPaste?: ComponentPropsWithoutRef<"input">["onPaste"];
};

const MainAppHeaderOrganizationCreateEditFormField = memo(function MainAppHeaderOrganizationCreateEditFormField(
	props: MainAppHeaderOrganizationCreateEditFormField_Props,
) {
	const {
		validationMessage,
		displayValidationMessage,
		inputRef,
		label,
		placeholder,
		draftValueLength,
		required,
		minLength,
		maxLength,
		helperText,
		isHelperTextInvalid = false,
		isSubmitting,
		onCompositionEnd,
		onBlur,
		onInvalid,
		onInput,
		onPaste,
	} = props;

	return (
		<MyInput displayValidationMessage={displayValidationMessage}>
			<MyInputLabel>{label}</MyInputLabel>
			<MyInputBackground />
			<MyInputArea>
				<MyInputControl
					ref={inputRef}
					validationMessage={validationMessage}
					type="text"
					autoComplete="off"
					defaultValue=""
					required={required}
					minLength={minLength}
					maxLength={maxLength}
					placeholder={placeholder}
					disabled={isSubmitting}
					onCompositionEnd={onCompositionEnd}
					onBlur={onBlur}
					onInvalid={onInvalid}
					onInput={onInput}
					onPaste={onPaste}
				/>
			</MyInputArea>
			<MyInputBox />
			<MyInputHelperText
				className={cn(
					"MainAppHeaderOrganizationCreateEditFormField-helper-row" satisfies MainAppHeaderOrganizationCreateEditFormField_ClassNames,
				)}
			>
				<span
					className={cn(
						"MainAppHeaderOrganizationCreateEditFormField-helper-message" satisfies MainAppHeaderOrganizationCreateEditFormField_ClassNames,
						isHelperTextInvalid &&
							("MainAppHeaderOrganizationCreateEditFormField-helper-state-error" satisfies MainAppHeaderOrganizationCreateEditFormField_ClassNames),
					)}
				>
					{helperText}
				</span>
				<span
					className={cn(
						"MainAppHeaderOrganizationCreateEditFormField-helper-counter" satisfies MainAppHeaderOrganizationCreateEditFormField_ClassNames,
					)}
				>
					{draftValueLength}/{maxLength}
				</span>
			</MyInputHelperText>
		</MyInput>
	);
});
// #endregion create edit form field

// #region create edit name field
type MainAppHeaderOrganizationNameField_Ref = {
	setRejectedNameValidationMessage: (name: string, validationMessage: string) => void;
};

type MainAppHeaderOrganizationNameField_Props = {
	ref: Ref<MainAppHeaderOrganizationNameField_Ref>;
	resetKey: string;
	initialValue: string;
	kind: "workspace" | "organization";
	label: ReactNode;
	submitValidationMessage?: string;
	isSubmitting: boolean;
	onValidationStateChange: (state: { validationMessage?: string; canonicalValue: string }) => void;
	onUserInput: () => void;
};

const MainAppHeaderOrganizationNameField = memo(function MainAppHeaderOrganizationNameField(
	props: MainAppHeaderOrganizationNameField_Props,
) {
	const {
		ref,
		resetKey,
		initialValue,
		kind,
		label,
		submitValidationMessage,
		isSubmitting,
		onValidationStateChange,
		onUserInput,
	} = props;

	const inputRef = useRef<HTMLInputElement>(null);
	const rejectedNameMessagesMapRef = useRef<Map<string, string>>(new Map());
	const onValidationStateChangeRef = useLiveRef(onValidationStateChange);
	// Keep native validity live, but don't show red UI for focus-only blur from modal controls.
	const isDirtyRef = useRef(false);
	const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined);
	const [fieldDisplayValidationMessage, setFieldDisplayValidationMessage] = useState<string | undefined>(undefined);
	const [draftValueLength, setDraftValueLength] = useState(0);

	const validateInput = useFn((el: HTMLInputElement) => {
		const canonicalName = get_canonical_name_value(el.value);
		const validationResult = validate_name_field_input(el, canonicalName, rejectedNameMessagesMapRef.current);

		setValidationMessage(validationResult.validationMessage);
		setDraftValueLength(el.value.length);
		onValidationStateChangeRef.current({
			validationMessage: validationResult.validationMessage,
			canonicalValue: canonicalName,
		});
		if (fieldDisplayValidationMessage !== undefined) {
			setFieldDisplayValidationMessage(validationResult.validationMessage);
		}

		return validationResult;
	});

	const revealCurrentMessage = useFn((el: HTMLInputElement) => {
		const validationResult = validateInput(el);
		if (isDirtyRef.current) {
			setFieldDisplayValidationMessage(validationResult.validationMessage);
		}
	});

	const handleInput = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onInput"]>>((event) => {
		const el = event.currentTarget;
		const native = event.nativeEvent;
		if ("isComposing" in native && (native as InputEvent).isComposing) {
			return;
		}

		// Covers insertFromPaste, insertFromDrop, insertText, and delete-*: el.value already includes the edit (onPaste uses preventDefault and normalizes without relying on this).
		isDirtyRef.current = true;
		validateInput(el);
		onUserInput();
	});

	const handlePaste = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onPaste"]>>((event) => {
		const pasted = event.clipboardData.getData("text/plain");
		if (pasted === "") {
			return;
		}

		event.preventDefault();
		const el = event.currentTarget;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? el.value.length;
		el.value = el.value.slice(0, start) + pasted + el.value.slice(end);
		isDirtyRef.current = true;
		validateInput(el);
		onUserInput();

		queueMicrotask(() => {
			const pos = el.value.length;
			el.setSelectionRange(pos, pos);
		});
	});

	const handleCompositionEnd = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onCompositionEnd"]>>((event) => {
		isDirtyRef.current = true;
		validateInput(event.currentTarget);
		onUserInput();
	});

	const handleBlur = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onBlur"]>>((event) => {
		revealCurrentMessage(event.currentTarget);
	});

	const handleInvalid = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onInvalid"]>>((event) => {
		event.preventDefault();
		revealCurrentMessage(event.currentTarget);
	});

	useEffect(() => {
		isDirtyRef.current = false;
		rejectedNameMessagesMapRef.current.clear();
		setValidationMessage(undefined);
		setFieldDisplayValidationMessage(undefined);

		const el = inputRef.current;
		if (!el) {
			const validated = organizations_name_validate(
				organizations_name_autofix(initialValue, { trim_trailing_hyphens: false }),
			);
			setValidationMessage(validated._nay?.message);
			setDraftValueLength(initialValue.length);
			onValidationStateChangeRef.current({
				validationMessage: validated._nay?.message,
				canonicalValue: get_canonical_name_value(initialValue),
			});
			return;
		}

		el.value = initialValue;
		const canonicalName = get_canonical_name_value(el.value);
		const validationResult = validate_name_field_input(el, canonicalName, rejectedNameMessagesMapRef.current);
		setValidationMessage(validationResult.validationMessage);
		setDraftValueLength(el.value.length);
		onValidationStateChangeRef.current({
			validationMessage: validationResult.validationMessage,
			canonicalValue: canonicalName,
		});
	}, [initialValue, onValidationStateChangeRef, resetKey]);

	useImperativeHandle(
		ref,
		() => ({
			setRejectedNameValidationMessage: (name, rejectedNameValidationMessage) => {
				rejectedNameMessagesMapRef.current.set(name, rejectedNameValidationMessage);

				const el = inputRef.current;
				if (!el) {
					return;
				}

				const canonicalName = get_canonical_name_value(el.value);
				const validationResult = validate_name_field_input(el, canonicalName, rejectedNameMessagesMapRef.current);
				setValidationMessage(validationResult.validationMessage);
				setDraftValueLength(el.value.length);
				onValidationStateChangeRef.current({
					validationMessage: validationResult.validationMessage,
					canonicalValue: canonicalName,
				});
				setFieldDisplayValidationMessage(validationResult.validationMessage);
			},
		}),
		[onValidationStateChangeRef, ref],
	);

	const displayValidationMessage = submitValidationMessage ?? fieldDisplayValidationMessage;
	const showValidationErrorMessage =
		displayValidationMessage != null &&
		displayValidationMessage !== "Name cannot be empty" &&
		displayValidationMessage !== "Name must be at least 3 characters";
	const helperText = showValidationErrorMessage
		? displayValidationMessage
		: `Min ${organizations_NAME_MIN_LENGTH} characters`;

	return (
		<MainAppHeaderOrganizationCreateEditFormField
			validationMessage={validationMessage}
			displayValidationMessage={displayValidationMessage}
			inputRef={inputRef}
			label={label}
			placeholder={kind === "organization" ? "acme-labs" : "my-workspace"}
			draftValueLength={draftValueLength}
			required
			minLength={organizations_NAME_MIN_LENGTH}
			maxLength={organizations_NAME_MAX_LENGTH}
			helperText={helperText}
			isHelperTextInvalid={Boolean(displayValidationMessage)}
			isSubmitting={isSubmitting}
			onCompositionEnd={handleCompositionEnd}
			onBlur={handleBlur}
			onInvalid={handleInvalid}
			onInput={handleInput}
			onPaste={handlePaste}
		/>
	);
});
// #endregion create edit name field

// #region create edit description field
type MainAppHeaderOrganizationDescriptionField_Ref = {
	setServerValidationMessage: (validationMessage: string) => void;
};

type MainAppHeaderOrganizationDescriptionField_Props = {
	ref: Ref<MainAppHeaderOrganizationDescriptionField_Ref>;
	resetKey: string;
	initialValue: string;
	kind: "workspace" | "organization";
	isSubmitting: boolean;
	onValidationStateChange: (state: { validationMessage?: string; canonicalValue: string }) => void;
};

const MainAppHeaderOrganizationDescriptionField = memo(function MainAppHeaderOrganizationDescriptionField(
	props: MainAppHeaderOrganizationDescriptionField_Props,
) {
	const { ref, resetKey, initialValue, kind, isSubmitting, onValidationStateChange } = props;

	const inputRef = useRef<HTMLInputElement>(null);
	const onValidationStateChangeRef = useLiveRef(onValidationStateChange);
	// Keep native validity live, but don't show red UI for focus-only blur from modal controls.
	const isDirtyRef = useRef(false);
	const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined);
	const [displayValidationMessage, setDisplayValidationMessage] = useState<string | undefined>(undefined);
	const [draftValueLength, setDraftValueLength] = useState(0);

	const validateInput = useFn((el: HTMLInputElement) => {
		const canonicalDescription = get_canonical_description_value(el.value);
		const validationResult = validate_description_field_input(el);

		setValidationMessage(validationResult.validationMessage);
		setDraftValueLength(el.value.length);
		onValidationStateChangeRef.current({
			validationMessage: validationResult.validationMessage,
			canonicalValue: canonicalDescription,
		});
		if (displayValidationMessage !== undefined) {
			setDisplayValidationMessage(validationResult.validationMessage);
		}

		return validationResult;
	});

	const revealCurrentMessage = useFn((el: HTMLInputElement) => {
		const validationResult = validateInput(el);
		if (isDirtyRef.current) {
			setDisplayValidationMessage(validationResult.validationMessage);
		}
	});

	const handleInput = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onInput"]>>((event) => {
		isDirtyRef.current = true;
		validateInput(event.currentTarget);
	});

	const handleBlur = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onBlur"]>>((event) => {
		revealCurrentMessage(event.currentTarget);
	});

	const handleInvalid = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onInvalid"]>>((event) => {
		event.preventDefault();
		revealCurrentMessage(event.currentTarget);
	});

	useEffect(() => {
		isDirtyRef.current = false;
		setValidationMessage(undefined);
		setDisplayValidationMessage(undefined);

		const el = inputRef.current;
		if (!el) {
			const validated = organizations_description_normalize(initialValue);
			setValidationMessage(validated._nay?.message);
			setDraftValueLength(initialValue.length);
			onValidationStateChangeRef.current({
				validationMessage: validated._nay?.message,
				canonicalValue: get_canonical_description_value(initialValue),
			});
			return;
		}

		el.value = initialValue;
		const canonicalDescription = get_canonical_description_value(el.value);
		const validationResult = validate_description_field_input(el);
		setValidationMessage(validationResult.validationMessage);
		setDraftValueLength(el.value.length);
		onValidationStateChangeRef.current({
			validationMessage: validationResult.validationMessage,
			canonicalValue: canonicalDescription,
		});
	}, [initialValue, onValidationStateChangeRef, resetKey]);

	useImperativeHandle(
		ref,
		() => ({
			setServerValidationMessage: (serverValidationMessage) => {
				setValidationMessage(serverValidationMessage);
				onValidationStateChangeRef.current({
					validationMessage: serverValidationMessage,
					canonicalValue: inputRef.current ? get_canonical_description_value(inputRef.current.value) : "",
				});
				setDisplayValidationMessage(serverValidationMessage);
			},
		}),
		[onValidationStateChangeRef, ref],
	);

	return (
		<MainAppHeaderOrganizationCreateEditFormField
			validationMessage={validationMessage}
			displayValidationMessage={displayValidationMessage}
			inputRef={inputRef}
			label={
				<>
					Description{" "}
					<span
						className={cn(
							"MainAppHeaderOrganizationCreateEditFormField-label-optional" satisfies MainAppHeaderOrganizationCreateEditFormField_ClassNames,
						)}
					>
						(optional)
					</span>
				</>
			}
			placeholder={kind === "organization" ? "What is this organization used for?" : "What is this workspace used for?"}
			draftValueLength={draftValueLength}
			maxLength={organizations_DESCRIPTION_MAX_LENGTH}
			helperText={displayValidationMessage}
			isHelperTextInvalid={Boolean(displayValidationMessage)}
			isSubmitting={isSubmitting}
			onBlur={handleBlur}
			onInvalid={handleInvalid}
			onInput={handleInput}
		/>
	);
});
// #endregion create edit description field

// #region create modal

type MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames =
	| "MainAppHeaderOrganizationSwitcherModalCreateModal"
	| "MainAppHeaderOrganizationSwitcherModalCreateModal-sub"
	| "MainAppHeaderOrganizationSwitcherModalCreateModal-sub-body"
	| "MainAppHeaderOrganizationSwitcherModalCreateModal-create-form"
	| "MainAppHeaderOrganizationSwitcherModalCreateModal-sub-form";

type MainAppHeaderOrganizationSwitcherModalCreateModal_Props = {
	open: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
	kind: "workspace" | "organization";
	organizationId: FunctionArgs<typeof app_convex_api.organizations.create_workspace>["organizationId"];
	organizationName: string;
	createOrganization: (
		args: FunctionArgs<typeof app_convex_api.organizations.create_organization>,
	) => Promise<FunctionReturnType<typeof app_convex_api.organizations.create_organization> | undefined>;
	createWorkspace: (
		args: FunctionArgs<typeof app_convex_api.organizations.create_workspace>,
	) => Promise<FunctionReturnType<typeof app_convex_api.organizations.create_workspace> | undefined>;
	onAfterCreateOrganization: (args: {
		organizationId: app_convex_Id<"organizations">;
		workspaceId: app_convex_Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
	}) => void;
	onAfterCreateWorkspace: (args: {
		organizationId: app_convex_Id<"organizations">;
		workspaceId: app_convex_Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
	}) => void;
};

export const MainAppHeaderOrganizationSwitcherModalCreateModal = memo(
	function MainAppHeaderOrganizationSwitcherModalCreateModal(props: MainAppHeaderOrganizationSwitcherModalCreateModal_Props) {
		const {
			open,
			setOpen,
			kind,
			organizationId,
			organizationName,
			createOrganization,
			createWorkspace,
			onAfterCreateOrganization,
			onAfterCreateWorkspace,
		} = props;

		const createFormDomId = `MainAppHeaderOrganizationSwitcherModalCreateModal-create-form-${useId().replace(/:/g, "")}`;

		const nameFieldRef = useRef<MainAppHeaderOrganizationNameField_Ref>(null);
		const descriptionFieldRef = useRef<MainAppHeaderOrganizationDescriptionField_Ref>(null);
		const [isNameValid, setIsNameValid] = useState(false);
		const [isDescriptionValid, setIsDescriptionValid] = useState(true);
		const [nameCanonicalValue, setNameCanonicalValue] = useState("");
		const [descriptionCanonicalValue, setDescriptionCanonicalValue] = useState("");
		const [submitValidationMessage, setSubmitValidationMessage] = useState<string | undefined>(undefined);
		const [isSubmitting, setIsSubmitting] = useState(false);

		const createFormResetKey = open ? `open:${kind}` : `closed:${kind}`;

		const handleNameValidationStateChange = useFn<MainAppHeaderOrganizationNameField_Props["onValidationStateChange"]>(
			(state) => {
				setIsNameValid(!state.validationMessage);
				setNameCanonicalValue(state.canonicalValue);
			},
		);

		const handleDescriptionValidationStateChange = useFn<
			MainAppHeaderOrganizationDescriptionField_Props["onValidationStateChange"]
		>((state) => {
			setIsDescriptionValid(!state.validationMessage);
			setDescriptionCanonicalValue(state.canonicalValue);
		});

		const handleNameUserInput = useFn(() => {
			setSubmitValidationMessage(undefined);
		});

		const handleFormSubmit = useFn<NonNullable<ComponentPropsWithoutRef<"form">["onSubmit"]>>((event) => {
			event.preventDefault();
			if (isSubmitting) {
				return;
			}

			if (!event.currentTarget.checkValidity()) {
				return;
			}

			const name = nameCanonicalValue;
			const description = descriptionCanonicalValue;

			void (async (/* iife */) => {
				setIsSubmitting(true);
				setSubmitValidationMessage(undefined);

				if (kind === "organization") {
					const result = await createOrganization({ name, description });

					if (result == null) {
						return;
					}

					if (result._nay) {
						if (result._nay.message === "Organization quota reached") {
							setSubmitValidationMessage(quotas.extra_organizations.disabledReason);
						} else if (result._nay.message === "Description is too long") {
							descriptionFieldRef.current?.setServerValidationMessage(result._nay.message);
						} else if (is_rejected_name_message(result._nay.message)) {
							nameFieldRef.current?.setRejectedNameValidationMessage(name, result._nay.message);
						} else {
							setSubmitValidationMessage(result._nay.message);
						}
						return;
					}

					await app_convex.query(app_convex_api.organizations.list, {});

					setOpen(false);
					onAfterCreateOrganization({
						organizationId: result._yay.organizationId,
						workspaceId: result._yay.defaultWorkspaceId,
						organizationName: result._yay.name,
						workspaceName: result._yay.defaultWorkspaceName,
					});
					return;
				}

				const result = await createWorkspace({ name, organizationId, description });

				if (result == null) {
					return;
				}

				if (result._nay) {
					if (result._nay.message === "Workspace quota reached") {
						setSubmitValidationMessage(quotas.extra_workspaces.disabledReason);
					} else if (result._nay.message === "Description is too long") {
						descriptionFieldRef.current?.setServerValidationMessage(result._nay.message);
					} else if (is_rejected_name_message(result._nay.message)) {
						nameFieldRef.current?.setRejectedNameValidationMessage(name, result._nay.message);
					} else {
						setSubmitValidationMessage(result._nay.message);
					}
					return;
				}

				await app_convex.query(app_convex_api.organizations.list, {});

				setOpen(false);
				onAfterCreateWorkspace({
					organizationId: result._yay.organizationId,
					workspaceId: result._yay.workspaceId,
					organizationName,
					workspaceName: result._yay.name,
				});
			})()
				.catch((error) => {
					console.error("[MainAppHeaderOrganizationSwitcherModalCreateModal] Unexpected create error", {
						error,
						kind,
					});
				})
				.finally(() => {
					setIsSubmitting(false);
				});
		});

		const handleCreateModalCancel = useFn(() => {
			setOpen(false);
		});

		useEffect(() => {
			if (!open) {
				return;
			}

			setSubmitValidationMessage(undefined);
			setIsNameValid(false);
			setIsDescriptionValid(true);
			setNameCanonicalValue("");
			setDescriptionCanonicalValue("");
		}, [open, kind]);

		const dialogTitle = kind === "organization" ? "Create organization" : "Create workspace";
		const nameFieldLabel = kind === "organization" ? "Organization name" : "Workspace name";

		return (
			<MyModal open={open} setOpen={setOpen}>
				<MyModalPopover
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalCreateModal" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
						"MainAppHeaderOrganizationSwitcherModalCreateModal-sub" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
					)}
				>
					<MyModalHeader>
						<MyModalHeading>{dialogTitle}</MyModalHeading>
					</MyModalHeader>

					<MyModalScrollableArea
						className={cn(
							"MainAppHeaderOrganizationSwitcherModalCreateModal-sub-body" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
						)}
					>
						<form
							id={createFormDomId}
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalCreateModal-create-form" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
							)}
							noValidate
							onSubmit={handleFormSubmit}
						>
							<div
								className={cn(
									"MainAppHeaderOrganizationSwitcherModalCreateModal-sub-form" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
								)}
							>
								<MainAppHeaderOrganizationNameField
									ref={nameFieldRef}
									resetKey={createFormResetKey}
									initialValue=""
									kind={kind}
									label={nameFieldLabel}
									submitValidationMessage={submitValidationMessage}
									isSubmitting={isSubmitting}
									onValidationStateChange={handleNameValidationStateChange}
									onUserInput={handleNameUserInput}
								/>
								<MainAppHeaderOrganizationDescriptionField
									ref={descriptionFieldRef}
									resetKey={createFormResetKey}
									initialValue=""
									kind={kind}
									isSubmitting={isSubmitting}
									onValidationStateChange={handleDescriptionValidationStateChange}
								/>
							</div>
						</form>
					</MyModalScrollableArea>

					<MyModalFooter>
						<MyButton type="button" variant="outline" disabled={isSubmitting} onClick={handleCreateModalCancel}>
							Cancel
						</MyButton>
						<MyButton
							type="submit"
							form={createFormDomId}
							variant="accent"
							disabled={!isNameValid || !isDescriptionValid || isSubmitting}
						>
							{isSubmitting ? "Creating…" : dialogTitle}
						</MyButton>
					</MyModalFooter>

					<MyModalCloseTrigger tooltip={`Close ${dialogTitle.toLowerCase()} dialog`} />
				</MyModalPopover>
			</MyModal>
		);
	},
);
// #endregion create modal

// #region edit modal
type MainAppHeaderOrganizationSwitcherModalEditModal_Props = {
	target: MainAppHeaderOrganizationSwitcherModal_EditTarget | null;
	editOrganization: (
		args: FunctionArgs<typeof app_convex_api.organizations.edit_organization>,
	) => Promise<FunctionReturnType<typeof app_convex_api.organizations.edit_organization> | undefined>;
	editWorkspace: (
		args: FunctionArgs<typeof app_convex_api.organizations.edit_workspace>,
	) => Promise<FunctionReturnType<typeof app_convex_api.organizations.edit_workspace> | undefined>;
	setTarget: Dispatch<SetStateAction<MainAppHeaderOrganizationSwitcherModal_EditTarget | null>>;
	onAfterEdit: (args: MainAppHeaderOrganizationSwitcherModal_AfterEdit) => void;
};

export const MainAppHeaderOrganizationSwitcherModalEditModal = memo(function MainAppHeaderOrganizationSwitcherModalEditModal(
	props: MainAppHeaderOrganizationSwitcherModalEditModal_Props,
) {
	const { target, editOrganization, editWorkspace, setTarget, onAfterEdit } = props;

	const editFormDomId = `MainAppHeaderOrganizationSwitcherModalEditModal-form-${useId().replace(/:/g, "")}`;

	const nameFieldRef = useRef<MainAppHeaderOrganizationNameField_Ref>(null);
	const descriptionFieldRef = useRef<MainAppHeaderOrganizationDescriptionField_Ref>(null);
	const [isNameValid, setIsNameValid] = useState(false);
	const [isDescriptionValid, setIsDescriptionValid] = useState(true);
	const [nameCanonicalValue, setNameCanonicalValue] = useState("");
	const [descriptionCanonicalValue, setDescriptionCanonicalValue] = useState("");
	const [submitValidationMessage, setSubmitValidationMessage] = useState<string | undefined>(undefined);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const initialCanonicalName = target ? get_canonical_name_value(target.initialName) : "";
	const initialCanonicalDescription = target ? get_canonical_description_value(target.initialDescription) : "";
	const isUnchanged =
		target === null ||
		(nameCanonicalValue === initialCanonicalName && descriptionCanonicalValue === initialCanonicalDescription);
	const editFormResetKey = target
		? `${target.kind}:${target.id}:${target.initialName}:${target.initialDescription}`
		: "closed";

	const handleNameValidationStateChange = useFn<MainAppHeaderOrganizationNameField_Props["onValidationStateChange"]>(
		(state) => {
			setIsNameValid(!state.validationMessage);
			setNameCanonicalValue(state.canonicalValue);
		},
	);

	const handleDescriptionValidationStateChange = useFn<
		MainAppHeaderOrganizationDescriptionField_Props["onValidationStateChange"]
	>((state) => {
		setIsDescriptionValid(!state.validationMessage);
		setDescriptionCanonicalValue(state.canonicalValue);
	});

	const handleNameUserInput = useFn(() => {
		setSubmitValidationMessage(undefined);
	});

	const handleFormSubmit = useFn<NonNullable<ComponentPropsWithoutRef<"form">["onSubmit"]>>((event) => {
		event.preventDefault();
		if (isSubmitting || !target) {
			return;
		}

		if (!event.currentTarget.checkValidity()) {
			return;
		}

		const name = nameCanonicalValue;
		const description = descriptionCanonicalValue;

		if (name === initialCanonicalName && description === initialCanonicalDescription) {
			setTarget(null);
			return;
		}

		const activeTarget = target;

		void (async (/* iife */) => {
			setIsSubmitting(true);
			setSubmitValidationMessage(undefined);

			if (activeTarget.kind === "organization") {
				const result = await editOrganization({
					organizationId: activeTarget.id as app_convex_Id<"organizations">,
					defaultWorkspaceId: activeTarget.defaultWorkspaceId,
					name,
					description,
				});

				if (result == null) {
					return;
				}

				if (result._nay) {
					if (result._nay.message === "Description is too long") {
						descriptionFieldRef.current?.setServerValidationMessage(result._nay.message);
					} else if (is_rejected_name_message(result._nay.message)) {
						nameFieldRef.current?.setRejectedNameValidationMessage(name, result._nay.message);
					} else {
						setSubmitValidationMessage(result._nay.message);
					}
					return;
				}

				await app_convex.query(app_convex_api.organizations.list, {});

				setTarget(null);
				onAfterEdit({
					kind: "organization",
					oldName: activeTarget.initialName,
					newName: result._yay.name,
					organizationId: activeTarget.id as app_convex_Id<"organizations">,
				});
				return;
			}

			const result = await editWorkspace({
				organizationId: activeTarget.organizationId,
				defaultWorkspaceId: activeTarget.defaultWorkspaceId,
				workspaceId: activeTarget.id as app_convex_Id<"organizations_workspaces">,
				name,
				description,
			});

			if (result == null) {
				return;
			}

			if (result._nay) {
				if (result._nay.message === "Description is too long") {
					descriptionFieldRef.current?.setServerValidationMessage(result._nay.message);
				} else if (is_rejected_name_message(result._nay.message)) {
					nameFieldRef.current?.setRejectedNameValidationMessage(name, result._nay.message);
				} else {
					setSubmitValidationMessage(result._nay.message);
				}
				return;
			}

			await app_convex.query(app_convex_api.organizations.list, {});

			setTarget(null);
			onAfterEdit({
				kind: "workspace",
				oldName: activeTarget.initialName,
				newName: result._yay.name,
				organizationId: result._yay.organizationId,
				workspaceId: activeTarget.id as app_convex_Id<"organizations_workspaces">,
			});
		})()
			.catch((error) => {
				console.error("[MainAppHeaderOrganizationSwitcherModalEditModal] Unexpected edit error", {
					error,
					kind: activeTarget.kind,
				});
			})
			.finally(() => {
				setIsSubmitting(false);
			});
	});

	const handleEditModalCancel = useFn(() => {
		setTarget(null);
	});

	const handleEditModalSetOpen = useFn<Dispatch<SetStateAction<boolean>>>((next) => {
		const resolved = typeof next === "function" ? next(target !== null) : next;
		if (!resolved) {
			setTarget(null);
		}
	});

	useEffect(() => {
		if (!target) {
			return;
		}

		setSubmitValidationMessage(undefined);
		setNameCanonicalValue(get_canonical_name_value(target.initialName));
		setDescriptionCanonicalValue(get_canonical_description_value(target.initialDescription));
	}, [target]);

	const dialogTitle = target ? (target.kind === "organization" ? "Edit organization" : "Edit workspace") : "Edit";
	const nameFieldLabel = target ? (target.kind === "organization" ? "Organization name" : "Workspace name") : "Name";
	const editOpen = target !== null;

	return (
		<MyModal open={editOpen} setOpen={handleEditModalSetOpen}>
			<MyModalPopover
				className={cn(
					"MainAppHeaderOrganizationSwitcherModalCreateModal" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
					"MainAppHeaderOrganizationSwitcherModalCreateModal-sub" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
				)}
			>
				<MyModalHeader>
					<MyModalHeading>{dialogTitle}</MyModalHeading>
				</MyModalHeader>

				<MyModalScrollableArea
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalCreateModal-sub-body" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
					)}
				>
					<form
						id={editFormDomId}
						className={cn(
							"MainAppHeaderOrganizationSwitcherModalCreateModal-create-form" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
						)}
						noValidate
						onSubmit={handleFormSubmit}
					>
						<div
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalCreateModal-sub-form" satisfies MainAppHeaderOrganizationSwitcherModalCreateModal_ClassNames,
							)}
						>
							<MainAppHeaderOrganizationNameField
								ref={nameFieldRef}
								resetKey={editFormResetKey}
								initialValue={target?.initialName ?? ""}
								kind={target?.kind ?? "organization"}
								label={nameFieldLabel}
								submitValidationMessage={submitValidationMessage}
								isSubmitting={isSubmitting}
								onValidationStateChange={handleNameValidationStateChange}
								onUserInput={handleNameUserInput}
							/>
							<MainAppHeaderOrganizationDescriptionField
								ref={descriptionFieldRef}
								resetKey={editFormResetKey}
								initialValue={target?.initialDescription ?? ""}
								kind={target?.kind ?? "organization"}
								isSubmitting={isSubmitting}
								onValidationStateChange={handleDescriptionValidationStateChange}
							/>
						</div>
					</form>
				</MyModalScrollableArea>

				<MyModalFooter>
					<MyButton type="button" variant="outline" disabled={isSubmitting} onClick={handleEditModalCancel}>
						Cancel
					</MyButton>
					<MyButton
						type="submit"
						form={editFormDomId}
						variant="accent"
						disabled={!isNameValid || !isDescriptionValid || isSubmitting || isUnchanged}
					>
						{isSubmitting ? "Saving…" : "Save"}
					</MyButton>
				</MyModalFooter>

				<MyModalCloseTrigger tooltip={`Close ${dialogTitle.toLowerCase()} dialog`} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion edit modal

type MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames =
	| "MainAppHeaderOrganizationSwitcherModalBillingModal"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-body"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-options"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-option"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-option-title"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-option-description"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-note"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-note-icon"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-note-copy"
	| "MainAppHeaderOrganizationSwitcherModalBillingModal-message";

// #region billing modal option
type MainAppHeaderOrganizationSwitcherModalBillingModalOption_Props = {
	name: string;
	value: "user" | "organization_owner";
	checked: boolean;
	disabled: boolean;
	title: string;
	description: string;
	onChange: NonNullable<ComponentPropsWithoutRef<"input">["onChange"]>;
};

const MainAppHeaderOrganizationSwitcherModalBillingModalOption = memo(
	function MainAppHeaderOrganizationSwitcherModalBillingModalOption(
		props: MainAppHeaderOrganizationSwitcherModalBillingModalOption_Props,
	) {
		const { name, value, checked, disabled, title, description, onChange } = props;

		const optionId = `${name}-option-${useId()}`;
		const radioId = `${optionId}-radio`;
		const descriptionId = `${optionId}-description`;

		return (
			<MyRadioCard
				className={cn(
					"MainAppHeaderOrganizationSwitcherModalBillingModal-option" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
				)}
				id={radioId}
				name={name}
				value={value}
				checked={checked}
				disabled={disabled}
				aria-describedby={descriptionId}
				onChange={onChange}
			>
				<MyRadioCardLabel
					htmlFor={radioId}
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalBillingModal-option-title" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
					)}
				>
					{title}
				</MyRadioCardLabel>
				<MyRadioCardDescription
					id={descriptionId}
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalBillingModal-option-description" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
					)}
				>
					{description}
				</MyRadioCardDescription>
			</MyRadioCard>
		);
	},
);
// #endregion billing modal option

// #region billing modal
type MainAppHeaderOrganizationSwitcherModalBillingModal_Props = {
	target: MainAppHeaderOrganizationSwitcherModal_BillingTarget | null;
	setTarget: Dispatch<SetStateAction<MainAppHeaderOrganizationSwitcherModal_BillingTarget | null>>;
	setOrganizationBillingMode: (
		args: FunctionArgs<typeof app_convex_api.organizations.set_organization_billing_mode>,
	) => Promise<FunctionReturnType<typeof app_convex_api.organizations.set_organization_billing_mode> | undefined>;
};

const MainAppHeaderOrganizationSwitcherModalBillingModal = memo(function MainAppHeaderOrganizationSwitcherModalBillingModal(
	props: MainAppHeaderOrganizationSwitcherModalBillingModal_Props,
) {
	const { target, setTarget, setOrganizationBillingMode } = props;

	const billingModeRadioName = `MainAppHeaderOrganizationSwitcherModalBillingModal-${useId()}`;

	const [selectedMode, setSelectedMode] = useState<"user" | "organization_owner">("user");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [message, setMessage] = useState<string | undefined>(undefined);

	const billingOpen = target !== null;
	const isUnchanged = selectedMode === target?.billingMode;

	const handleSetOpen = useFn<Dispatch<SetStateAction<boolean>>>((next) => {
		const resolved = typeof next === "function" ? next(target !== null) : next;
		if (!resolved) {
			setTarget(null);
		}
	});

	const handleCancel = useFn(() => {
		setTarget(null);
	});

	const handleBillingModeChange = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onChange"]>>((event) => {
		if (!event.currentTarget.checked) {
			return;
		}

		setSelectedMode(event.currentTarget.value as "user" | "organization_owner");
	});

	const handleSave = useFn(() => {
		if (!target || isSubmitting || isUnchanged) {
			return;
		}

		const activeTarget = target;
		void (async (/* iife */) => {
			setIsSubmitting(true);
			setMessage(undefined);

			const result = await setOrganizationBillingMode({
				organizationId: activeTarget.organizationId,
				billingMode: selectedMode,
			});
			if (result == null) {
				return;
			}

			if (result._nay) {
				setMessage(result._nay.message);
				return;
			}

			await app_convex.query(app_convex_api.organizations.list, {});
			setTarget(null);
		})()
			.catch((error) => {
				console.error("[MainAppHeaderOrganizationSwitcherModalBillingModal] Unexpected billing mode error", {
					error,
					organizationId: activeTarget.organizationId,
				});
			})
			.finally(() => {
				setIsSubmitting(false);
			});
	});

	useEffect(() => {
		if (!target) {
			return;
		}

		setSelectedMode(target.billingMode);
		setMessage(undefined);
	}, [target]);

	return (
		<MyModal open={billingOpen} setOpen={handleSetOpen}>
			<MyModalPopover
				className={cn(
					"MainAppHeaderOrganizationSwitcherModalBillingModal" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
				)}
			>
				<MyModalHeader>
					<MyModalHeading>Organization billing</MyModalHeading>
					<MyModalDescription>
						Choose who pays for usage in {target ? target.organizationName : "this organization"}.
					</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea
					className={cn(
						"MainAppHeaderOrganizationSwitcherModalBillingModal-body" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderOrganizationSwitcherModalBillingModal-options" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
						)}
						role="radiogroup"
						aria-label="Organization billing source"
						aria-disabled={isSubmitting || undefined}
					>
						<MainAppHeaderOrganizationSwitcherModalBillingModalOption
							name={billingModeRadioName}
							value="user"
							checked={selectedMode === "user"}
							disabled={isSubmitting}
							onChange={handleBillingModeChange}
							title="Bill each member"
							description="Each member uses their own balance for their activity."
						/>
						<MainAppHeaderOrganizationSwitcherModalBillingModalOption
							name={billingModeRadioName}
							value="organization_owner"
							checked={selectedMode === "organization_owner"}
							disabled={isSubmitting}
							onChange={handleBillingModeChange}
							title="Bill my balance"
							description="All organization usage is charged to your balance."
						/>
					</div>
					<div
						role="note"
						className={cn(
							"MainAppHeaderOrganizationSwitcherModalBillingModal-note" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
						)}
					>
						<Info
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalBillingModal-note-icon" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
							)}
							aria-hidden
						/>
						<span
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalBillingModal-note-copy" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
							)}
						>
							This setting applies to all future usage in this organization. You can change it again at any time.
						</span>
					</div>
					{message ? (
						<div
							className={cn(
								"MainAppHeaderOrganizationSwitcherModalBillingModal-message" satisfies MainAppHeaderOrganizationSwitcherModalBillingModal_ClassNames,
							)}
						>
							{message}
						</div>
					) : null}
				</MyModalScrollableArea>

				<MyModalFooter>
					<MyButton type="button" variant="outline" disabled={isSubmitting} onClick={handleCancel}>
						Cancel
					</MyButton>
					<MyButton type="button" variant="accent" disabled={isSubmitting || isUnchanged} onClick={handleSave}>
						{isSubmitting ? "Saving…" : "Save changes"}
					</MyButton>
				</MyModalFooter>

				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion billing modal

// #region root
type MainAppHeaderOrganizationSwitcherModal_ClassNames =
	| "MainAppHeaderOrganizationSwitcherModal"
	| "MainAppHeaderOrganizationSwitcherModal-body"
	| "MainAppHeaderOrganizationSwitcherModal-summary"
	| "MainAppHeaderOrganizationSwitcherModal-summary-label"
	| "MainAppHeaderOrganizationSwitcherModal-summary-value"
	| "MainAppHeaderOrganizationSwitcherModal-summary-chevron"
	| "MainAppHeaderOrganizationSwitcherModal-columns"
	| "MainAppHeaderOrganizationSwitcherModal-footer";

export type MainAppHeaderOrganizationSwitcherModal_Props = {
	dialogOpen: boolean;
	listLoaded: boolean;
	draftWorkspaceId: app_convex_Id<"organizations_workspaces">;
	draftOrganizationId: FunctionArgs<typeof app_convex_api.organizations.create_workspace>["organizationId"];
	summaryOrganizationName: string;
	summaryWorkspaceName: string;
	/** Organization name for create-workspace flow (draft row), not necessarily the routed tenant. */
	organizationName: string;
	organizationItems: MainAppHeaderOrganizationSwitcherModal_ListItem[];
	workspaceItems: MainAppHeaderOrganizationSwitcherModal_ListItem[];
	createOrganizationDisabled: boolean;
	createOrganizationDisabledReason?: string;
	createWorkspaceDisabled: boolean;
	createWorkspaceDisabledReason?: string;
	organizationQuotaFraction?: string;
	organizationQuotaTooltip?: string;
	workspaceQuotaFraction?: string;
	workspaceQuotaTooltip?: string;
	switchDisabled: boolean;
	editTarget: MainAppHeaderOrganizationSwitcherModal_EditTarget | null;
	billingTarget: MainAppHeaderOrganizationSwitcherModal_BillingTarget | null;
	createOrganization: (
		args: FunctionArgs<typeof app_convex_api.organizations.create_organization>,
	) => Promise<FunctionReturnType<typeof app_convex_api.organizations.create_organization> | undefined>;
	createWorkspace: (
		args: FunctionArgs<typeof app_convex_api.organizations.create_workspace>,
	) => Promise<FunctionReturnType<typeof app_convex_api.organizations.create_workspace> | undefined>;
	editOrganization: MainAppHeaderOrganizationSwitcherModalEditModal_Props["editOrganization"];
	editWorkspace: MainAppHeaderOrganizationSwitcherModalEditModal_Props["editWorkspace"];
	setEditTarget: MainAppHeaderOrganizationSwitcherModalEditModal_Props["setTarget"];
	setBillingTarget: MainAppHeaderOrganizationSwitcherModalBillingModal_Props["setTarget"];
	setOrganizationBillingMode: MainAppHeaderOrganizationSwitcherModalBillingModal_Props["setOrganizationBillingMode"];
	onAfterCreateOrganization: (args: {
		organizationId: app_convex_Id<"organizations">;
		workspaceId: app_convex_Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
	}) => void;
	onAfterCreateWorkspace: (args: {
		organizationId: app_convex_Id<"organizations">;
		workspaceId: app_convex_Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
	}) => void;
	onAfterEdit: (args: MainAppHeaderOrganizationSwitcherModal_AfterEdit) => void;
	onCancel: () => void;
	onSwitch: () => void;
};

export const MainAppHeaderOrganizationSwitcherModal = memo(function MainAppHeaderOrganizationSwitcherModal(
	props: MainAppHeaderOrganizationSwitcherModal_Props,
) {
	const {
		dialogOpen,
		listLoaded,
		draftWorkspaceId,
		draftOrganizationId,
		summaryOrganizationName,
		summaryWorkspaceName,
		organizationName,
		organizationItems,
		workspaceItems,
		createOrganizationDisabled,
		createOrganizationDisabledReason,
		createWorkspaceDisabled,
		createWorkspaceDisabledReason,
		organizationQuotaFraction,
		organizationQuotaTooltip,
		workspaceQuotaFraction,
		workspaceQuotaTooltip,
		switchDisabled,
		editTarget,
		billingTarget,
		createOrganization,
		createWorkspace,
		editOrganization,
		editWorkspace,
		setEditTarget,
		setBillingTarget,
		setOrganizationBillingMode,
		onAfterCreateOrganization,
		onAfterCreateWorkspace,
		onAfterEdit,
		onCancel,
		onSwitch,
	} = props;

	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createDialogKind, setCreateDialogKind] = useState<"workspace" | "organization">("organization");

	const handleOpenCreateOrganizationDialog = useFn(() => {
		setCreateDialogKind("organization");
		setCreateDialogOpen(true);
	});

	const handleOpenCreateWorkspaceDialog = useFn(() => {
		setCreateDialogKind("workspace");
		setCreateDialogOpen(true);
	});

	return (
		<>
			<MyModalPopover
				className={cn("MainAppHeaderOrganizationSwitcherModal" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames)}
			>
				<MyModalHeader>
					<MyModalHeading>Organizations and workspaces</MyModalHeading>
					<MyModalDescription>Switch organizations, choose a workspace, or manage settings.</MyModalDescription>
				</MyModalHeader>

				<div
					className={cn(
						"MainAppHeaderOrganizationSwitcherModal-body" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderOrganizationSwitcherModal-summary" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
						)}
					>
						<span
							className={cn(
								"MainAppHeaderOrganizationSwitcherModal-summary-label" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
							)}
						>
							Current:
						</span>{" "}
						<span
							className={cn(
								"MainAppHeaderOrganizationSwitcherModal-summary-value" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
							)}
						>
							{listLoaded ? summaryOrganizationName : "…"}
						</span>{" "}
						<MyIcon
							className={cn(
								"MainAppHeaderOrganizationSwitcherModal-summary-chevron" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
							)}
							aria-hidden
						>
							<ChevronRight aria-hidden strokeWidth={2.25} />
						</MyIcon>{" "}
						<span
							className={cn(
								"MainAppHeaderOrganizationSwitcherModal-summary-value" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
							)}
						>
							{listLoaded ? summaryWorkspaceName : "…"}
						</span>
					</div>

					<div
						className={cn(
							"MainAppHeaderOrganizationSwitcherModal-columns" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
						)}
					>
						<MainAppHeaderOrganizationSwitcherModalSelectPane
							dialogOpen={dialogOpen}
							title="Organizations"
							kind="organization"
							items={organizationItems}
							selectedItemId={draftOrganizationId}
							createDisabled={createOrganizationDisabled}
							createDisabledReason={createOrganizationDisabledReason}
							quotaFraction={organizationQuotaFraction}
							quotaTooltip={organizationQuotaTooltip}
							onCreate={handleOpenCreateOrganizationDialog}
							icon={<Building2 />}
						/>

						<MainAppHeaderOrganizationSwitcherModalSelectPane
							dialogOpen={dialogOpen}
							title="Workspaces"
							kind="workspace"
							items={workspaceItems}
							selectedItemId={draftWorkspaceId}
							createDisabled={createWorkspaceDisabled}
							createDisabledReason={createWorkspaceDisabledReason}
							quotaFraction={workspaceQuotaFraction}
							quotaTooltip={workspaceQuotaTooltip}
							onCreate={handleOpenCreateWorkspaceDialog}
							icon={<FolderKanban />}
						/>
					</div>
				</div>

				<MyModalFooter
					className={cn(
						"MainAppHeaderOrganizationSwitcherModal-footer" satisfies MainAppHeaderOrganizationSwitcherModal_ClassNames,
					)}
				>
					<MyButton type="button" variant="outline" onClick={onCancel}>
						Cancel
					</MyButton>
					<MyButton type="button" variant="accent" disabled={switchDisabled} onClick={onSwitch}>
						Switch
					</MyButton>
				</MyModalFooter>

				<MyModalCloseTrigger tooltip="Close organization switcher" />
				<MainAppHeaderOrganizationSwitcherModalCreateModal
					open={createDialogOpen}
					setOpen={setCreateDialogOpen}
					kind={createDialogKind}
					organizationId={draftOrganizationId}
					organizationName={organizationName}
					createOrganization={createOrganization}
					createWorkspace={createWorkspace}
					onAfterCreateOrganization={onAfterCreateOrganization}
					onAfterCreateWorkspace={onAfterCreateWorkspace}
				/>
				<MainAppHeaderOrganizationSwitcherModalEditModal
					target={editTarget}
					editWorkspace={editWorkspace}
					editOrganization={editOrganization}
					setTarget={setEditTarget}
					onAfterEdit={onAfterEdit}
				/>
				<MainAppHeaderOrganizationSwitcherModalBillingModal
					target={billingTarget}
					setTarget={setBillingTarget}
					setOrganizationBillingMode={setOrganizationBillingMode}
				/>
			</MyModalPopover>
		</>
	);
});
// #endregion root
