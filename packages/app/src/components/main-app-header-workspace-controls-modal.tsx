import "./main-app-header-workspace-controls-modal.css";

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
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";

import { useFn, useLiveRef } from "@/hooks/utils-hooks.ts";
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
import { MyTooltip, MyTooltipContent, MyTooltipInfoTrigger, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { MyFocus, type MyFocus_ClassNames } from "@/lib/my-focus.ts";
import {
	workspaces_DESCRIPTION_MAX_LENGTH,
	workspaces_NAME_MAX_LENGTH,
	workspaces_NAME_MIN_LENGTH,
	workspaces_description_normalize,
	workspaces_name_autofix,
	workspaces_name_validate,
} from "@/lib/workspaces.ts";
import { cn } from "@/lib/utils.ts";
import { quotas } from "../../shared/quotas.ts";

function is_rejected_name_message(validationMessage: string) {
	return validationMessage === "Workspace name already exists" || validationMessage === "Project name already exists";
}

// Use canonical submit values so autofix-only edits do not enable Save.
function get_canonical_name_value(value: string) {
	return workspaces_name_autofix(value);
}

function get_canonical_description_value(value: string) {
	const validatedDescription = workspaces_description_normalize(value);

	return validatedDescription._nay ? value.trim() : validatedDescription._yay;
}

function validate_name_field_input(
	el: HTMLInputElement,
	canonicalName: string,
	rejectedValueMessagesMap: Map<string, string>,
) {
	const normalized = workspaces_name_autofix(el.value, { trim_trailing_hyphens: false });
	if (el.value !== normalized) {
		el.value = normalized;
	}

	const validated = workspaces_name_validate(normalized);
	const rejectedValueMessage = validated._yay ? rejectedValueMessagesMap.get(canonicalName) : undefined;
	const validationMessage = validated._nay?.message ?? (validated._yay ? rejectedValueMessage : undefined);

	return { validationMessage };
}

function validate_description_field_input(el: HTMLInputElement) {
	const validated = workspaces_description_normalize(el.value);
	const validationMessage = validated._nay?.message;

	return { validationMessage };
}

// #region list item model
export type MainAppHeaderWorkspaceSwitcherModal_ListItem = {
	id: string;
	label: string;
	description: string;
	isCurrent?: boolean;
	isDefault?: boolean;
	billingBadge?: string;
	onManageBilling?: () => void;
	onEdit?: () => void;
	onDelete?: () => void;
	onSelect: () => void;
};
// #endregion list item model

// #region edit target / callback
export type MainAppHeaderWorkspaceSwitcherModal_EditTarget =
	| {
			kind: "workspace";
			id: string;
			initialName: string;
			initialDescription: string;
			defaultProjectId: app_convex_Id<"workspaces_projects">;
	  }
	| {
			kind: "project";
			id: string;
			initialName: string;
			initialDescription: string;
			workspaceId: app_convex_Id<"workspaces">;
			defaultProjectId: app_convex_Id<"workspaces_projects">;
	  };

export type MainAppHeaderWorkspaceSwitcherModal_AfterEdit = {
	kind: "project" | "workspace";
	oldName: string;
	newName: string;
	workspaceId: app_convex_Id<"workspaces">;
	projectId?: app_convex_Id<"workspaces_projects">;
};

export type MainAppHeaderWorkspaceSwitcherModal_BillingTarget = {
	workspaceId: app_convex_Id<"workspaces">;
	workspaceName: string;
	billingMode: "user" | "workspace_owner";
};
// #endregion edit target / callback

// #region list item
type MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalListItem"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-primary"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-label-row"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-label"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-billing-badge"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-description"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-actions"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-action"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-current-border";

export type MainAppHeaderWorkspaceSwitcherModalListItem_Props = {
	item: MainAppHeaderWorkspaceSwitcherModal_ListItem;
};

export const MainAppHeaderWorkspaceSwitcherModalListItem = memo(function MainAppHeaderWorkspaceSwitcherModalListItem(
	props: MainAppHeaderWorkspaceSwitcherModalListItem_Props,
) {
	const { item } = props;

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

	return (
		<li
			className={cn(
				"MainAppHeaderWorkspaceSwitcherModalListItem" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
			)}
		>
			<MyButton
				className={cn(
					"MainAppHeaderWorkspaceSwitcherModalListItem-primary" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
					"MyFocus-row" satisfies MyFocus_ClassNames,
				)}
				type="button"
				variant="ghost-highlightable"
				data-selected={isCurrent || undefined}
				aria-current={isCurrent ? "true" : undefined}
				aria-disabled={isCurrent || undefined}
				tabIndex={isCurrent ? -1 : undefined}
				onClick={handleSelect}
			>
				{isCurrent && (
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalListItem-current-border" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
						)}
						aria-hidden
					/>
				)}

				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalListItem-label-row" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalListItem-label" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
						)}
					>
						{item.label}
					</div>
					{item.billingBadge ? (
						<span
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalListItem-billing-badge" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
							)}
						>
							{item.billingBadge}
						</span>
					) : null}
				</div>

				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalListItem-description" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
					)}
				>
					{descriptionText}
				</div>
			</MyButton>

			{showMenu ? (
				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalListItem-actions" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
					)}
				>
					<MyMenu>
						<MyMenuTrigger>
							<MyIconButton
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalListItem-action" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
								)}
								variant="ghost-highlightable"
								tooltip="More actions"
							>
								<MyIconButtonIcon>
									<EllipsisVertical />
								</MyIconButtonIcon>
							</MyIconButton>
						</MyMenuTrigger>
						<MyMenuPopover>
							<MyMenuPopoverContent>
								{item.onManageBilling ? (
									<MyMenuItem onClick={handleManageBilling}>
										<MyMenuItemContent>
											<MyMenuItemContentIcon>
												<CreditCard />
											</MyMenuItemContentIcon>
											<MyMenuItemContentPrimary>Manage</MyMenuItemContentPrimary>
										</MyMenuItemContent>
									</MyMenuItem>
								) : null}
								{item.onEdit ? (
									<MyMenuItem onClick={handleEdit}>
										<MyMenuItemContent>
											<MyMenuItemContentIcon>
												<Pencil />
											</MyMenuItemContentIcon>
											<MyMenuItemContentPrimary>Edit</MyMenuItemContentPrimary>
										</MyMenuItemContent>
									</MyMenuItem>
								) : null}
								{item.onDelete ? (
									<MyMenuItem variant="destructive" disabled={!canDelete} onClick={handleDelete}>
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
type MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-copy"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-icon"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-title-row"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-title"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-quota"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-help"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-create-trigger"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-create";

export type MainAppHeaderWorkspaceSwitcherModalSelectHead_Props = {
	title: string;
	createDisabled?: boolean;
	createDisabledReason?: string;
	quotaFraction?: string;
	quotaTooltip?: string;
	onCreate: () => void;
	iconSlot: ReactNode;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectHead = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectHead(props: MainAppHeaderWorkspaceSwitcherModalSelectHead_Props) {
		const { title, createDisabled, createDisabledReason, quotaFraction, quotaTooltip, onCreate, iconSlot } = props;

		const createDisabledTooltip = createDisabled ? createDisabledReason : undefined;

		return (
			<div
				className={cn(
					"MainAppHeaderWorkspaceSwitcherModalSelectHead" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
				)}
			>
				<MyIcon
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalSelectHead-icon" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
					)}
					aria-hidden
				>
					{iconSlot}
				</MyIcon>
				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalSelectHead-copy" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
					)}
				>
					{quotaFraction && quotaTooltip ? (
						<div
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalSelectHead-title-row" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
							)}
						>
							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalSelectHead-title" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
								)}
							>
								{title}
							</div>
							<MyTooltip placement="bottom">
								<MyTooltipInfoTrigger>
									<span
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModalSelectHead-quota" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
										)}
									>
										{quotaFraction}
										<MyIcon
											className={cn(
												"MainAppHeaderWorkspaceSwitcherModalSelectHead-help" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
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
								"MainAppHeaderWorkspaceSwitcherModalSelectHead-title-row" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
							)}
						>
							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalSelectHead-title" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
								)}
							>
								{title}
							</div>
							{quotaFraction ? (
								<span
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModalSelectHead-quota" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
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
									"MainAppHeaderWorkspaceSwitcherModalSelectHead-create-trigger" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
								)}
							>
								<MyButton
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModalSelectHead-create" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
									)}
									type="button"
									disabled
									variant="ghost-highlightable"
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
							"MainAppHeaderWorkspaceSwitcherModalSelectHead-create" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
						)}
						type="button"
						disabled={Boolean(createDisabled)}
						variant="ghost-highlightable"
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
type MainAppHeaderWorkspaceSwitcherModalSelectList_ClassNames = "MainAppHeaderWorkspaceSwitcherModalSelectList";

export type MainAppHeaderWorkspaceSwitcherModalSelectList_Props = {
	myFocusSyncKey: string;
	children: ReactNode;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectList = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectList(props: MainAppHeaderWorkspaceSwitcherModalSelectList_Props) {
		const { myFocusSyncKey, children } = props;

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
					"MainAppHeaderWorkspaceSwitcherModalSelectList" satisfies MainAppHeaderWorkspaceSwitcherModalSelectList_ClassNames,
					"MyFocus-container" satisfies MyFocus_ClassNames,
				)}
			>
				{children}
			</ul>
		);
	},
);
// #endregion select list

// #region select pane list
export type MainAppHeaderWorkspaceSwitcherModalSelectPaneList_Props = {
	dialogOpen: boolean;
	items: MainAppHeaderWorkspaceSwitcherModalSelectPane_Props["items"];
	selectedItemId: string;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectPaneList = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectPaneList(
		props: MainAppHeaderWorkspaceSwitcherModalSelectPaneList_Props,
	) {
		const { dialogOpen, items, selectedItemId } = props;

		const myFocusSyncKey = `${dialogOpen}:${selectedItemId}:${items.map((item) => item.id).join(",")}`;

		return (
			<MainAppHeaderWorkspaceSwitcherModalSelectList myFocusSyncKey={myFocusSyncKey}>
				{items.map((item) => (
					<MainAppHeaderWorkspaceSwitcherModalListItem
						key={item.id}
						item={{ ...item, isCurrent: item.id === selectedItemId }}
					/>
				))}
			</MainAppHeaderWorkspaceSwitcherModalSelectList>
		);
	},
);
// #endregion select pane list

// #region select pane
type MainAppHeaderWorkspaceSwitcherModalSelectPane_ClassNames = "MainAppHeaderWorkspaceSwitcherModalSelectPane";

export type MainAppHeaderWorkspaceSwitcherModalSelectPane_Props = {
	dialogOpen: boolean;
	title: string;
	items: Omit<MainAppHeaderWorkspaceSwitcherModal_ListItem, "isCurrent">[];
	selectedItemId: string;
	createDisabled?: boolean;
	createDisabledReason?: string;
	quotaFraction?: string;
	quotaTooltip?: string;
	onCreate: () => void;
	icon: ReactNode;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectPane = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectPane(props: MainAppHeaderWorkspaceSwitcherModalSelectPane_Props) {
		const {
			dialogOpen,
			title,
			items,
			selectedItemId,
			createDisabled,
			createDisabledReason,
			quotaFraction,
			quotaTooltip,
			onCreate,
			icon,
		} = props;

		return (
			<section
				className={cn(
					"MainAppHeaderWorkspaceSwitcherModalSelectPane" satisfies MainAppHeaderWorkspaceSwitcherModalSelectPane_ClassNames,
				)}
			>
				<MainAppHeaderWorkspaceSwitcherModalSelectHead
					title={title}
					createDisabled={createDisabled}
					createDisabledReason={createDisabledReason}
					quotaFraction={quotaFraction}
					quotaTooltip={quotaTooltip}
					onCreate={onCreate}
					iconSlot={icon}
				/>

				<MainAppHeaderWorkspaceSwitcherModalSelectPaneList
					dialogOpen={dialogOpen}
					items={items}
					selectedItemId={selectedItemId}
				/>
			</section>
		);
	},
);
// #endregion select pane

// #region create edit form field
type MainAppHeaderWorkspaceCreateEditFormField_ClassNames =
	| "MainAppHeaderWorkspaceCreateEditFormField-label-optional"
	| "MainAppHeaderWorkspaceCreateEditFormField-helper-row"
	| "MainAppHeaderWorkspaceCreateEditFormField-helper-message"
	| "MainAppHeaderWorkspaceCreateEditFormField-helper-counter"
	| "MainAppHeaderWorkspaceCreateEditFormField-helper-state-error";

type MainAppHeaderWorkspaceCreateEditFormField_Props = {
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

const MainAppHeaderWorkspaceCreateEditFormField = memo(function MainAppHeaderWorkspaceCreateEditFormField(
	props: MainAppHeaderWorkspaceCreateEditFormField_Props,
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
		<MyInput displayValidationMessage={displayValidationMessage} variant="surface">
			<MyInputLabel>{label}</MyInputLabel>
			<MyInputArea>
				<MyInputBox />
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
			<MyInputHelperText
				className={cn(
					"MainAppHeaderWorkspaceCreateEditFormField-helper-row" satisfies MainAppHeaderWorkspaceCreateEditFormField_ClassNames,
				)}
			>
				<span
					className={cn(
						"MainAppHeaderWorkspaceCreateEditFormField-helper-message" satisfies MainAppHeaderWorkspaceCreateEditFormField_ClassNames,
						isHelperTextInvalid &&
							("MainAppHeaderWorkspaceCreateEditFormField-helper-state-error" satisfies MainAppHeaderWorkspaceCreateEditFormField_ClassNames),
					)}
				>
					{helperText}
				</span>
				<span
					className={cn(
						"MainAppHeaderWorkspaceCreateEditFormField-helper-counter" satisfies MainAppHeaderWorkspaceCreateEditFormField_ClassNames,
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
type MainAppHeaderWorkspaceNameField_Ref = {
	setRejectedNameValidationMessage: (name: string, validationMessage: string) => void;
};

type MainAppHeaderWorkspaceNameField_Props = {
	ref: Ref<MainAppHeaderWorkspaceNameField_Ref>;
	resetKey: string;
	initialValue: string;
	kind: "project" | "workspace";
	label: ReactNode;
	submitValidationMessage?: string;
	isSubmitting: boolean;
	onValidationStateChange: (state: { validationMessage?: string; canonicalValue: string }) => void;
	onUserInput: () => void;
};

const MainAppHeaderWorkspaceNameField = memo(function MainAppHeaderWorkspaceNameField(
	props: MainAppHeaderWorkspaceNameField_Props,
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
		setFieldDisplayValidationMessage(validationResult.validationMessage);
	});

	const handleInput = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onInput"]>>((event) => {
		const el = event.currentTarget;
		const native = event.nativeEvent;
		if ("isComposing" in native && (native as InputEvent).isComposing) {
			return;
		}

		// Covers insertFromPaste, insertFromDrop, insertText, and delete-*: el.value already includes the edit (onPaste uses preventDefault and normalizes without relying on this).
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
		validateInput(el);
		onUserInput();

		queueMicrotask(() => {
			const pos = el.value.length;
			el.setSelectionRange(pos, pos);
		});
	});

	const handleCompositionEnd = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onCompositionEnd"]>>((event) => {
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
		rejectedNameMessagesMapRef.current.clear();
		setValidationMessage(undefined);
		setFieldDisplayValidationMessage(undefined);

		const el = inputRef.current;
		if (!el) {
			const validated = workspaces_name_validate(
				workspaces_name_autofix(initialValue, { trim_trailing_hyphens: false }),
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
		: `Min ${workspaces_NAME_MIN_LENGTH} characters`;

	return (
		<MainAppHeaderWorkspaceCreateEditFormField
			validationMessage={validationMessage}
			displayValidationMessage={displayValidationMessage}
			inputRef={inputRef}
			label={label}
			placeholder={kind === "workspace" ? "acme-labs" : "my-project"}
			draftValueLength={draftValueLength}
			required
			minLength={workspaces_NAME_MIN_LENGTH}
			maxLength={workspaces_NAME_MAX_LENGTH}
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
type MainAppHeaderWorkspaceDescriptionField_Ref = {
	setServerValidationMessage: (validationMessage: string) => void;
};

type MainAppHeaderWorkspaceDescriptionField_Props = {
	ref: Ref<MainAppHeaderWorkspaceDescriptionField_Ref>;
	resetKey: string;
	initialValue: string;
	kind: "project" | "workspace";
	isSubmitting: boolean;
	onValidationStateChange: (state: { validationMessage?: string; canonicalValue: string }) => void;
};

const MainAppHeaderWorkspaceDescriptionField = memo(function MainAppHeaderWorkspaceDescriptionField(
	props: MainAppHeaderWorkspaceDescriptionField_Props,
) {
	const { ref, resetKey, initialValue, kind, isSubmitting, onValidationStateChange } = props;

	const inputRef = useRef<HTMLInputElement>(null);
	const onValidationStateChangeRef = useLiveRef(onValidationStateChange);
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
		setDisplayValidationMessage(validationResult.validationMessage);
	});

	const handleInput = useFn<NonNullable<ComponentPropsWithoutRef<"input">["onInput"]>>((event) => {
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
		setValidationMessage(undefined);
		setDisplayValidationMessage(undefined);

		const el = inputRef.current;
		if (!el) {
			const validated = workspaces_description_normalize(initialValue);
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
		<MainAppHeaderWorkspaceCreateEditFormField
			validationMessage={validationMessage}
			displayValidationMessage={displayValidationMessage}
			inputRef={inputRef}
			label={
				<>
					Description{" "}
					<span
						className={cn(
							"MainAppHeaderWorkspaceCreateEditFormField-label-optional" satisfies MainAppHeaderWorkspaceCreateEditFormField_ClassNames,
						)}
					>
						(optional)
					</span>
				</>
			}
			placeholder={kind === "workspace" ? "What is this workspace used for?" : "What is this project used for?"}
			draftValueLength={draftValueLength}
			maxLength={workspaces_DESCRIPTION_MAX_LENGTH}
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

type MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-sub"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-body"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-create-form"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-form";

type MainAppHeaderWorkspaceSwitcherModalCreateModal_Props = {
	open: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
	kind: "project" | "workspace";
	workspaceId: FunctionArgs<typeof app_convex_api.workspaces.create_project>["workspaceId"];
	workspaceName: string;
	createWorkspace: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_workspace>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.create_workspace> | undefined>;
	createProject: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_project>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.create_project> | undefined>;
	onAfterCreateWorkspace: (args: {
		workspaceId: app_convex_Id<"workspaces">;
		projectId: app_convex_Id<"workspaces_projects">;
		workspaceName: string;
		projectName: string;
	}) => void;
	onAfterCreateProject: (args: {
		workspaceId: app_convex_Id<"workspaces">;
		projectId: app_convex_Id<"workspaces_projects">;
		workspaceName: string;
		projectName: string;
	}) => void;
};

export const MainAppHeaderWorkspaceSwitcherModalCreateModal = memo(
	function MainAppHeaderWorkspaceSwitcherModalCreateModal(props: MainAppHeaderWorkspaceSwitcherModalCreateModal_Props) {
		const {
			open,
			setOpen,
			kind,
			workspaceId,
			workspaceName,
			createWorkspace,
			createProject,
			onAfterCreateWorkspace,
			onAfterCreateProject,
		} = props;

		const createFormDomId = `MainAppHeaderWorkspaceSwitcherModalCreateModal-create-form-${useId().replace(/:/g, "")}`;

		const nameFieldRef = useRef<MainAppHeaderWorkspaceNameField_Ref>(null);
		const descriptionFieldRef = useRef<MainAppHeaderWorkspaceDescriptionField_Ref>(null);
		const [isNameValid, setIsNameValid] = useState(false);
		const [isDescriptionValid, setIsDescriptionValid] = useState(true);
		const [nameCanonicalValue, setNameCanonicalValue] = useState("");
		const [descriptionCanonicalValue, setDescriptionCanonicalValue] = useState("");
		const [submitValidationMessage, setSubmitValidationMessage] = useState<string | undefined>(undefined);
		const [isSubmitting, setIsSubmitting] = useState(false);

		const createFormResetKey = open ? `open:${kind}` : `closed:${kind}`;

		const handleNameValidationStateChange = useFn<MainAppHeaderWorkspaceNameField_Props["onValidationStateChange"]>(
			(state) => {
				setIsNameValid(!state.validationMessage);
				setNameCanonicalValue(state.canonicalValue);
			},
		);

		const handleDescriptionValidationStateChange = useFn<
			MainAppHeaderWorkspaceDescriptionField_Props["onValidationStateChange"]
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

				if (kind === "workspace") {
					const result = await createWorkspace({ name, description });

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

					await app_convex.query(app_convex_api.workspaces.list, {});

					setOpen(false);
					onAfterCreateWorkspace({
						workspaceId: result._yay.workspaceId,
						projectId: result._yay.defaultProjectId,
						workspaceName: result._yay.name,
						projectName: result._yay.defaultProjectName,
					});
					return;
				}

				const result = await createProject({ name, workspaceId, description });

				if (result == null) {
					return;
				}

				if (result._nay) {
					if (result._nay.message === "Project quota reached") {
						setSubmitValidationMessage(quotas.extra_projects.disabledReason);
					} else if (result._nay.message === "Description is too long") {
						descriptionFieldRef.current?.setServerValidationMessage(result._nay.message);
					} else if (is_rejected_name_message(result._nay.message)) {
						nameFieldRef.current?.setRejectedNameValidationMessage(name, result._nay.message);
					} else {
						setSubmitValidationMessage(result._nay.message);
					}
					return;
				}

				await app_convex.query(app_convex_api.workspaces.list, {});

				setOpen(false);
				onAfterCreateProject({
					workspaceId: result._yay.workspaceId,
					projectId: result._yay.projectId,
					workspaceName,
					projectName: result._yay.name,
				});
			})()
				.catch((error) => {
					console.error("[MainAppHeaderWorkspaceSwitcherModalCreateModal] Unexpected create error", {
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

		const dialogTitle = kind === "workspace" ? "Create workspace" : "Create project";
		const nameFieldLabel = kind === "workspace" ? "Workspace name" : "Project name";

		return (
			<MyModal open={open} setOpen={setOpen}>
				<MyModalPopover
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalCreateModal" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
						"MainAppHeaderWorkspaceSwitcherModalCreateModal-sub" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
					)}
				>
					<MyModalHeader>
						<MyModalHeading>{dialogTitle}</MyModalHeading>
					</MyModalHeader>

					<MyModalScrollableArea
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-body" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
						)}
					>
						<form
							id={createFormDomId}
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalCreateModal-create-form" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
							)}
							noValidate
							onSubmit={handleFormSubmit}
						>
							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-form" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
								)}
							>
								<MainAppHeaderWorkspaceNameField
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
								<MainAppHeaderWorkspaceDescriptionField
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

					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		);
	},
);
// #endregion create modal

// #region edit modal
type MainAppHeaderWorkspaceSwitcherModalEditModal_Props = {
	target: MainAppHeaderWorkspaceSwitcherModal_EditTarget | null;
	editWorkspace: (
		args: FunctionArgs<typeof app_convex_api.workspaces.edit_workspace>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.edit_workspace> | undefined>;
	editProject: (
		args: FunctionArgs<typeof app_convex_api.workspaces.edit_project>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.edit_project> | undefined>;
	setTarget: Dispatch<SetStateAction<MainAppHeaderWorkspaceSwitcherModal_EditTarget | null>>;
	onAfterEdit: (args: MainAppHeaderWorkspaceSwitcherModal_AfterEdit) => void;
};

export const MainAppHeaderWorkspaceSwitcherModalEditModal = memo(function MainAppHeaderWorkspaceSwitcherModalEditModal(
	props: MainAppHeaderWorkspaceSwitcherModalEditModal_Props,
) {
	const { target, editWorkspace, editProject, setTarget, onAfterEdit } = props;

	const editFormDomId = `MainAppHeaderWorkspaceSwitcherModalEditModal-form-${useId().replace(/:/g, "")}`;

	const nameFieldRef = useRef<MainAppHeaderWorkspaceNameField_Ref>(null);
	const descriptionFieldRef = useRef<MainAppHeaderWorkspaceDescriptionField_Ref>(null);
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

	const handleNameValidationStateChange = useFn<MainAppHeaderWorkspaceNameField_Props["onValidationStateChange"]>(
		(state) => {
			setIsNameValid(!state.validationMessage);
			setNameCanonicalValue(state.canonicalValue);
		},
	);

	const handleDescriptionValidationStateChange = useFn<
		MainAppHeaderWorkspaceDescriptionField_Props["onValidationStateChange"]
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

			if (activeTarget.kind === "workspace") {
				const result = await editWorkspace({
					workspaceId: activeTarget.id as app_convex_Id<"workspaces">,
					defaultProjectId: activeTarget.defaultProjectId,
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

				await app_convex.query(app_convex_api.workspaces.list, {});

				setTarget(null);
				onAfterEdit({
					kind: "workspace",
					oldName: activeTarget.initialName,
					newName: result._yay.name,
					workspaceId: activeTarget.id as app_convex_Id<"workspaces">,
				});
				return;
			}

			const result = await editProject({
				workspaceId: activeTarget.workspaceId,
				defaultProjectId: activeTarget.defaultProjectId,
				projectId: activeTarget.id as app_convex_Id<"workspaces_projects">,
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

			await app_convex.query(app_convex_api.workspaces.list, {});

			setTarget(null);
			onAfterEdit({
				kind: "project",
				oldName: activeTarget.initialName,
				newName: result._yay.name,
				workspaceId: result._yay.workspaceId,
				projectId: activeTarget.id as app_convex_Id<"workspaces_projects">,
			});
		})()
			.catch((error) => {
				console.error("[MainAppHeaderWorkspaceSwitcherModalEditModal] Unexpected edit error", {
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

	const dialogTitle = target ? (target.kind === "workspace" ? "Edit workspace" : "Edit project") : "Edit";
	const nameFieldLabel = target ? (target.kind === "workspace" ? "Workspace name" : "Project name") : "Name";
	const editOpen = target !== null;

	return (
		<MyModal open={editOpen} setOpen={handleEditModalSetOpen}>
			<MyModalPopover
				className={cn(
					"MainAppHeaderWorkspaceSwitcherModalCreateModal" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
					"MainAppHeaderWorkspaceSwitcherModalCreateModal-sub" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
				)}
			>
				<MyModalHeader>
					<MyModalHeading>{dialogTitle}</MyModalHeading>
				</MyModalHeader>

				<MyModalScrollableArea
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-body" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
					)}
				>
					<form
						id={editFormDomId}
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalCreateModal-create-form" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
						)}
						noValidate
						onSubmit={handleFormSubmit}
					>
						<div
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-form" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
							)}
						>
							<MainAppHeaderWorkspaceNameField
								ref={nameFieldRef}
								resetKey={editFormResetKey}
								initialValue={target?.initialName ?? ""}
								kind={target?.kind ?? "workspace"}
								label={nameFieldLabel}
								submitValidationMessage={submitValidationMessage}
								isSubmitting={isSubmitting}
								onValidationStateChange={handleNameValidationStateChange}
								onUserInput={handleNameUserInput}
							/>
							<MainAppHeaderWorkspaceDescriptionField
								ref={descriptionFieldRef}
								resetKey={editFormResetKey}
								initialValue={target?.initialDescription ?? ""}
								kind={target?.kind ?? "workspace"}
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

				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion edit modal

// #region billing modal
type MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalBillingModal"
	| "MainAppHeaderWorkspaceSwitcherModalBillingModal-body"
	| "MainAppHeaderWorkspaceSwitcherModalBillingModal-options"
	| "MainAppHeaderWorkspaceSwitcherModalBillingModal-option"
	| "MainAppHeaderWorkspaceSwitcherModalBillingModal-option-title"
	| "MainAppHeaderWorkspaceSwitcherModalBillingModal-option-description"
	| "MainAppHeaderWorkspaceSwitcherModalBillingModal-message";

type MainAppHeaderWorkspaceSwitcherModalBillingModal_Props = {
	target: MainAppHeaderWorkspaceSwitcherModal_BillingTarget | null;
	setTarget: Dispatch<SetStateAction<MainAppHeaderWorkspaceSwitcherModal_BillingTarget | null>>;
	setWorkspaceBillingMode: (
		args: FunctionArgs<typeof app_convex_api.workspaces.set_workspace_billing_mode>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.set_workspace_billing_mode> | undefined>;
};

const MainAppHeaderWorkspaceSwitcherModalBillingModal = memo(function MainAppHeaderWorkspaceSwitcherModalBillingModal(
	props: MainAppHeaderWorkspaceSwitcherModalBillingModal_Props,
) {
	const { target, setTarget, setWorkspaceBillingMode } = props;

	const [selectedMode, setSelectedMode] = useState<"user" | "workspace_owner">("user");
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

	const handleSave = useFn(() => {
		if (!target || isSubmitting || isUnchanged) {
			return;
		}

		const activeTarget = target;
		void (async (/* iife */) => {
			setIsSubmitting(true);
			setMessage(undefined);

			const result = await setWorkspaceBillingMode({
				workspaceId: activeTarget.workspaceId,
				billingMode: selectedMode,
			});
			if (result == null) {
				return;
			}

			if (result._nay) {
				setMessage(result._nay.message);
				return;
			}

			await app_convex.query(app_convex_api.workspaces.list, {});
			setTarget(null);
		})()
			.catch((error) => {
				console.error("[MainAppHeaderWorkspaceSwitcherModalBillingModal] Unexpected billing mode error", {
					error,
					workspaceId: activeTarget.workspaceId,
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
					"MainAppHeaderWorkspaceSwitcherModalBillingModal" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
				)}
			>
				<MyModalHeader>
					<MyModalHeading>Workspace billing</MyModalHeading>
					<MyModalDescription>{target ? target.workspaceName : "Workspace"}</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalBillingModal-body" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalBillingModal-options" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
						)}
					>
						<MyButton
							type="button"
							variant="ghost-highlightable"
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalBillingModal-option" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
							)}
							data-selected={selectedMode === "user" || undefined}
							aria-pressed={selectedMode === "user"}
							onClick={() => setSelectedMode("user")}
						>
							<span
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalBillingModal-option-title" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
								)}
							>
								User billing
							</span>
							<span
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalBillingModal-option-description" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
								)}
							>
								Each member spends their own balance.
							</span>
						</MyButton>
						<MyButton
							type="button"
							variant="ghost-highlightable"
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalBillingModal-option" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
							)}
							data-selected={selectedMode === "workspace_owner" || undefined}
							aria-pressed={selectedMode === "workspace_owner"}
							onClick={() => setSelectedMode("workspace_owner")}
						>
							<span
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalBillingModal-option-title" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
								)}
							>
								Owner billing
							</span>
							<span
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModalBillingModal-option-description" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
								)}
							>
								Workspace usage spends the owner balance.
							</span>
						</MyButton>
					</div>
					{message ? (
						<div
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalBillingModal-message" satisfies MainAppHeaderWorkspaceSwitcherModalBillingModal_ClassNames,
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
						{isSubmitting ? "Saving…" : "Save"}
					</MyButton>
				</MyModalFooter>

				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion billing modal

// #region root
type MainAppHeaderWorkspaceSwitcherModal_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModal"
	| "MainAppHeaderWorkspaceSwitcherModal-body"
	| "MainAppHeaderWorkspaceSwitcherModal-summary"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-label"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-value"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-chevron"
	| "MainAppHeaderWorkspaceSwitcherModal-columns"
	| "MainAppHeaderWorkspaceSwitcherModal-footer";

export type MainAppHeaderWorkspaceSwitcherModal_Props = {
	dialogOpen: boolean;
	listLoaded: boolean;
	draftProjectId: app_convex_Id<"workspaces_projects">;
	draftWorkspaceId: FunctionArgs<typeof app_convex_api.workspaces.create_project>["workspaceId"];
	summaryWorkspaceName: string;
	summaryProjectName: string;
	/** Workspace name for create-project flow (draft row), not necessarily the routed tenant. */
	workspaceName: string;
	workspaceItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[];
	projectItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[];
	createWorkspaceDisabled: boolean;
	createWorkspaceDisabledReason?: string;
	createProjectDisabled: boolean;
	createProjectDisabledReason?: string;
	workspaceQuotaFraction?: string;
	workspaceQuotaTooltip?: string;
	projectQuotaFraction?: string;
	projectQuotaTooltip?: string;
	switchDisabled: boolean;
	editTarget: MainAppHeaderWorkspaceSwitcherModal_EditTarget | null;
	billingTarget: MainAppHeaderWorkspaceSwitcherModal_BillingTarget | null;
	createWorkspace: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_workspace>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.create_workspace> | undefined>;
	createProject: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_project>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.create_project> | undefined>;
	editWorkspace: MainAppHeaderWorkspaceSwitcherModalEditModal_Props["editWorkspace"];
	editProject: MainAppHeaderWorkspaceSwitcherModalEditModal_Props["editProject"];
	setEditTarget: MainAppHeaderWorkspaceSwitcherModalEditModal_Props["setTarget"];
	setBillingTarget: MainAppHeaderWorkspaceSwitcherModalBillingModal_Props["setTarget"];
	setWorkspaceBillingMode: MainAppHeaderWorkspaceSwitcherModalBillingModal_Props["setWorkspaceBillingMode"];
	onAfterCreateWorkspace: (args: {
		workspaceId: app_convex_Id<"workspaces">;
		projectId: app_convex_Id<"workspaces_projects">;
		workspaceName: string;
		projectName: string;
	}) => void;
	onAfterCreateProject: (args: {
		workspaceId: app_convex_Id<"workspaces">;
		projectId: app_convex_Id<"workspaces_projects">;
		workspaceName: string;
		projectName: string;
	}) => void;
	onAfterEdit: (args: MainAppHeaderWorkspaceSwitcherModal_AfterEdit) => void;
	onCancel: () => void;
	onSwitch: () => void;
};

export const MainAppHeaderWorkspaceSwitcherModal = memo(function MainAppHeaderWorkspaceSwitcherModal(
	props: MainAppHeaderWorkspaceSwitcherModal_Props,
) {
	const {
		dialogOpen,
		listLoaded,
		draftProjectId,
		draftWorkspaceId,
		summaryWorkspaceName,
		summaryProjectName,
		workspaceName,
		workspaceItems,
		projectItems,
		createWorkspaceDisabled,
		createWorkspaceDisabledReason,
		createProjectDisabled,
		createProjectDisabledReason,
		workspaceQuotaFraction,
		workspaceQuotaTooltip,
		projectQuotaFraction,
		projectQuotaTooltip,
		switchDisabled,
		editTarget,
		billingTarget,
		createWorkspace,
		createProject,
		editWorkspace,
		editProject,
		setEditTarget,
		setBillingTarget,
		setWorkspaceBillingMode,
		onAfterCreateWorkspace,
		onAfterCreateProject,
		onAfterEdit,
		onCancel,
		onSwitch,
	} = props;

	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createDialogKind, setCreateDialogKind] = useState<"project" | "workspace">("workspace");

	const handleOpenCreateWorkspaceDialog = useFn(() => {
		setCreateDialogKind("workspace");
		setCreateDialogOpen(true);
	});

	const handleOpenCreateProjectDialog = useFn(() => {
		setCreateDialogKind("project");
		setCreateDialogOpen(true);
	});

	return (
		<>
			<MyModalPopover
				className={cn("MainAppHeaderWorkspaceSwitcherModal" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames)}
			>
				<MyModalHeader>
					<MyModalHeading>Workspaces and projects</MyModalHeading>
					<MyModalDescription>Switch workspaces, choose a project, or manage settings.</MyModalDescription>
				</MyModalHeader>

				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModal-body" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModal-summary" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
						)}
					>
						<span
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-summary-label" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
						>
							Current:
						</span>{" "}
						<span
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-summary-value" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
						>
							{listLoaded ? summaryWorkspaceName : "…"}
						</span>{" "}
						<MyIcon
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-summary-chevron" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
							aria-hidden
						>
							<ChevronRight aria-hidden strokeWidth={2.25} />
						</MyIcon>{" "}
						<span
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-summary-value" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
						>
							{listLoaded ? summaryProjectName : "…"}
						</span>
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModal-columns" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
						)}
					>
						<MainAppHeaderWorkspaceSwitcherModalSelectPane
							dialogOpen={dialogOpen}
							title="Workspaces"
							items={workspaceItems}
							selectedItemId={draftWorkspaceId}
							createDisabled={createWorkspaceDisabled}
							createDisabledReason={createWorkspaceDisabledReason}
							quotaFraction={workspaceQuotaFraction}
							quotaTooltip={workspaceQuotaTooltip}
							onCreate={handleOpenCreateWorkspaceDialog}
							icon={<Building2 />}
						/>

						<MainAppHeaderWorkspaceSwitcherModalSelectPane
							dialogOpen={dialogOpen}
							title="Projects"
							items={projectItems}
							selectedItemId={draftProjectId}
							createDisabled={createProjectDisabled}
							createDisabledReason={createProjectDisabledReason}
							quotaFraction={projectQuotaFraction}
							quotaTooltip={projectQuotaTooltip}
							onCreate={handleOpenCreateProjectDialog}
							icon={<FolderKanban />}
						/>
					</div>
				</div>

				<MyModalFooter
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModal-footer" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
					)}
				>
					<MyButton type="button" variant="outline" onClick={onCancel}>
						Cancel
					</MyButton>
					<MyButton type="button" variant="accent" disabled={switchDisabled} onClick={onSwitch}>
						Switch
					</MyButton>
				</MyModalFooter>

				<MyModalCloseTrigger />
				<MainAppHeaderWorkspaceSwitcherModalCreateModal
					open={createDialogOpen}
					setOpen={setCreateDialogOpen}
					kind={createDialogKind}
					workspaceId={draftWorkspaceId}
					workspaceName={workspaceName}
					createWorkspace={createWorkspace}
					createProject={createProject}
					onAfterCreateWorkspace={onAfterCreateWorkspace}
					onAfterCreateProject={onAfterCreateProject}
				/>
				<MainAppHeaderWorkspaceSwitcherModalEditModal
					target={editTarget}
					editProject={editProject}
					editWorkspace={editWorkspace}
					setTarget={setEditTarget}
					onAfterEdit={onAfterEdit}
				/>
				<MainAppHeaderWorkspaceSwitcherModalBillingModal
					target={billingTarget}
					setTarget={setBillingTarget}
					setWorkspaceBillingMode={setWorkspaceBillingMode}
				/>
			</MyModalPopover>
		</>
	);
});
// #endregion root
