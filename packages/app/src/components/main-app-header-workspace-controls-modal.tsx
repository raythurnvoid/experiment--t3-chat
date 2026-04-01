import "./main-app-header-workspace-controls-modal.css";

import type { FunctionArgs, FunctionReturnType } from "convex/server";
import {
	memo,
	useEffect,
	useId,
	useRef,
	useState,
	type ClipboardEventHandler,
	type CompositionEventHandler,
	type Dispatch,
	type InputEventHandler,
	type RefObject,
	type ReactNode,
	type SetStateAction,
	type SubmitEventHandler,
} from "react";
import {
	Briefcase,
	ChevronRight,
	CircleHelp,
	EllipsisVertical,
	FolderKanban,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";

import { useFn } from "@/hooks/utils-hooks.ts";
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
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { MyFocus, type MyFocus_ClassNames } from "@/lib/my-focus.ts";
import {
	workspaces_description_max_length,
	workspaces_description_normalize,
	workspaces_name_autofix,
	workspaces_name_max_length,
	workspaces_name_min_length,
	workspaces_name_validate,
} from "@/lib/workspaces.ts";
import { cn } from "@/lib/utils.ts";

// #region list item model
export type MainAppHeaderWorkspaceSwitcherModal_ListItem = {
	id: string;
	label: string;
	description: string;
	isCurrent?: boolean;
	isDefault?: boolean;
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
// #endregion edit target / callback

// #region list item
type MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalListItem"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-primary"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-label"
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
		item.onSelect();
	});

	const handleEdit = useFn(() => {
		item.onEdit?.();
	});

	const handleDelete = useFn(() => {
		item.onDelete?.();
	});

	const descriptionText = item.description.trim() ? item.description : "(No description)";
	const isCurrent = Boolean(item.isCurrent);
	const isDefault = Boolean(item.isDefault);
	const canDelete = !isDefault && Boolean(item.onDelete);
	const showMenu = Boolean(item.onEdit || item.onDelete);

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
						"MainAppHeaderWorkspaceSwitcherModalListItem-label" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
					)}
				>
					{item.label}
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
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-limit-trigger"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-limit"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-help"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-create-trigger"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-create";

export type MainAppHeaderWorkspaceSwitcherModalSelectHead_Props = {
	title: string;
	createDisabled?: boolean;
	createDisabledReason?: string;
	limitFraction?: string;
	limitTooltip?: string;
	onCreate: () => void;
	iconSlot: ReactNode;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectHead = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectHead(props: MainAppHeaderWorkspaceSwitcherModalSelectHead_Props) {
		const { title, createDisabled, createDisabledReason, limitFraction, limitTooltip, onCreate, iconSlot } = props;

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
					{limitFraction && limitTooltip ? (
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
								<MyTooltipTrigger
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModalSelectHead-limit-trigger" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
									)}
									tabIndex={0}
								>
									<span
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModalSelectHead-limit" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
										)}
									>
										{limitFraction}
										<MyIcon
											className={cn(
												"MainAppHeaderWorkspaceSwitcherModalSelectHead-help" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
											)}
											aria-hidden
										>
											<CircleHelp />
										</MyIcon>
									</span>
								</MyTooltipTrigger>
								<MyTooltipContent unmountOnHide>
									<>{limitTooltip}</>
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
							{limitFraction ? (
								<span
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModalSelectHead-limit" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
									)}
								>
									({limitFraction})
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
	limitFraction?: string;
	limitTooltip?: string;
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
			limitFraction,
			limitTooltip,
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
					limitFraction={limitFraction}
					limitTooltip={limitTooltip}
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

// #region modal form helpers
const main_app_header_workspace_switcher_modal_NAME_HELPER_TEXT = `Use ${workspaces_name_min_length}-${workspaces_name_max_length} characters. Lowercase letters and hyphens only (kebab-case).`;

const main_app_header_workspace_switcher_modal_DESCRIPTION_HELPER_TEXT = `Optional. Plain text, up to ${workspaces_description_max_length} characters.`;

function should_block_name_retry(message: string) {
	return message === "Workspace name already exists" || message === "Project name already exists";
}

type MainAppHeaderWorkspaceCreateEditFormFields_Props = {
	nameInputRef: RefObject<HTMLInputElement | null>;
	descriptionInputRef: RefObject<HTMLInputElement | null>;
	kind: "project" | "workspace";
	nameFieldLabel: string;
	isNameValid: boolean;
	isNameNonEmpty: boolean;
	isDescriptionValid: boolean;
	isSubmitting: boolean;
	nameMessage?: string;
	descriptionMessage?: string;
	onNameCompositionEnd: CompositionEventHandler<HTMLInputElement>;
	onNameInput: InputEventHandler<HTMLInputElement>;
	onNamePaste: ClipboardEventHandler<HTMLInputElement>;
	onDescriptionInput: InputEventHandler<HTMLInputElement>;
};

const MainAppHeaderWorkspaceCreateEditFormFields = memo(function MainAppHeaderWorkspaceCreateEditFormFields(
	props: MainAppHeaderWorkspaceCreateEditFormFields_Props,
) {
	const {
		nameInputRef,
		descriptionInputRef,
		kind,
		nameFieldLabel,
		isNameValid,
		isNameNonEmpty,
		isDescriptionValid,
		isSubmitting,
		nameMessage,
		descriptionMessage,
		onNameCompositionEnd,
		onNameInput,
		onNamePaste,
		onDescriptionInput,
	} = props;

	return (
		<>
			<MyInput variant="surface">
				<MyInputLabel>{nameFieldLabel}</MyInputLabel>
				<MyInputArea>
					<MyInputBox />
					<MyInputControl
						ref={nameInputRef}
						type="text"
						autoComplete="off"
						defaultValue=""
						maxLength={workspaces_name_max_length}
						placeholder={kind === "workspace" ? "acme-labs" : "my-project"}
						aria-invalid={!isNameValid && isNameNonEmpty}
						disabled={isSubmitting}
						onCompositionEnd={onNameCompositionEnd}
						onInput={onNameInput}
						onPaste={onNamePaste}
					/>
				</MyInputArea>
				<MyInputHelperText
					className={cn(
						nameMessage &&
							("MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-helper-state-error" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames),
					)}
				>
					{nameMessage ?? main_app_header_workspace_switcher_modal_NAME_HELPER_TEXT}
				</MyInputHelperText>
			</MyInput>

			<MyInput variant="surface">
				<MyInputLabel>Description</MyInputLabel>
				<MyInputArea>
					<MyInputBox />
					<MyInputControl
						ref={descriptionInputRef}
						type="text"
						autoComplete="off"
						defaultValue=""
						maxLength={workspaces_description_max_length}
						placeholder={kind === "workspace" ? "What is this workspace used for?" : "What is this project used for?"}
						aria-invalid={!isDescriptionValid}
						disabled={isSubmitting}
						onInput={onDescriptionInput}
					/>
				</MyInputArea>
				<MyInputHelperText
					className={cn(
						descriptionMessage &&
							("MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-helper-state-error" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames),
					)}
				>
					{descriptionMessage ?? main_app_header_workspace_switcher_modal_DESCRIPTION_HELPER_TEXT}
				</MyInputHelperText>
			</MyInput>
		</>
	);
});
// #endregion modal form helpers

// #region create modal

type MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-sub"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-header-copy"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-body"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-create-form"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-form"
	| "MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-helper-state-error";

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

		const nameInputRef = useRef<HTMLInputElement>(null);
		const descriptionInputRef = useRef<HTMLInputElement>(null);
		const nameBlockedMessagesRef = useRef<Map<string, string>>(new Map());
		const [isNameValid, setIsNameValid] = useState(false);
		const [isNameNonEmpty, setIsNameNonEmpty] = useState(false);
		const [isDescriptionValid, setIsDescriptionValid] = useState(true);
		const [nameValidationMessage, setNameValidationMessage] = useState<string | undefined>(undefined);
		const [submitMessage, setSubmitMessage] = useState<string | undefined>(undefined);
		const [descriptionMessage, setDescriptionMessage] = useState<string | undefined>(undefined);
		const [isSubmitting, setIsSubmitting] = useState(false);

		const syncNameValueForSubmit = useFn((el: HTMLInputElement) => {
			const normalized = workspaces_name_autofix(el.value, { trim_trailing_hyphens: false });
			if (el.value !== normalized) {
				el.value = normalized;
			}

			setIsNameNonEmpty(normalized.length > 0);

			const validated = workspaces_name_validate(normalized);
			const blockedMessage = validated._nay ? undefined : nameBlockedMessagesRef.current.get(validated._yay);

			setNameValidationMessage(validated._nay?.message ?? blockedMessage);
			setIsNameValid(!validated._nay && !blockedMessage);
		});

		const applyNameInputToControl = useFn((el: HTMLInputElement) => {
			syncNameValueForSubmit(el);
			setSubmitMessage(undefined);
		});

		const syncDescriptionValueForSubmit = useFn((el: HTMLInputElement) => {
			const validated = workspaces_description_normalize(el.value);

			setDescriptionMessage(validated._nay?.message);
			setIsDescriptionValid(!validated._nay);
		});

		const applyDescriptionInputToControl = useFn((el: HTMLInputElement) => {
			syncDescriptionValueForSubmit(el);
		});

		const handleFormSubmit = useFn<SubmitEventHandler<HTMLFormElement>>((event) => {
			event.preventDefault();
			if (isSubmitting) {
				return;
			}

			const el = nameInputRef.current;
			if (!el) {
				return;
			}

			const descriptionEl = descriptionInputRef.current;
			if (!descriptionEl) {
				return;
			}

			syncNameValueForSubmit(el);
			const canonicalName = workspaces_name_autofix(el.value);
			el.value = canonicalName;
			const validated = workspaces_name_validate(canonicalName);
			if (validated._nay) {
				return;
			}

			const name = validated._yay;
			if (nameBlockedMessagesRef.current.has(name)) {
				return;
			}

			syncDescriptionValueForSubmit(descriptionEl);
			const descriptionValidated = workspaces_description_normalize(descriptionEl.value);
			if (descriptionValidated._nay) {
				setDescriptionMessage(descriptionValidated._nay.message);
				return;
			}
			const description = descriptionValidated._yay;

			void (async (/* iife */) => {
				setIsSubmitting(true);
				setSubmitMessage(undefined);

				if (kind === "workspace") {
					const result = await createWorkspace({ name, description });

					if (result == null) {
						return;
					}

					if (result._nay) {
						if (result._nay.message === "Description is too long") {
							setDescriptionMessage(result._nay.message);
						} else if (should_block_name_retry(result._nay.message)) {
							nameBlockedMessagesRef.current.set(name, result._nay.message);
							syncNameValueForSubmit(el);
						} else {
							setSubmitMessage(result._nay.message);
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
					if (result._nay.message === "Description is too long") {
						setDescriptionMessage(result._nay.message);
					} else if (should_block_name_retry(result._nay.message)) {
						nameBlockedMessagesRef.current.set(name, result._nay.message);
						syncNameValueForSubmit(el);
					} else {
						setSubmitMessage(result._nay.message);
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

		const handleNameInput = useFn<InputEventHandler<HTMLInputElement>>((event) => {
			const el = event.currentTarget;
			const native = event.nativeEvent;
			if ("isComposing" in native && (native as InputEvent).isComposing) {
				return;
			}

			// Covers insertFromPaste, insertFromDrop, insertText, and delete-*: el.value already includes the edit (onPaste uses preventDefault and normalizes without relying on this).
			applyNameInputToControl(el);
		});

		const handleNamePaste = useFn<ClipboardEventHandler<HTMLInputElement>>((event) => {
			const pasted = event.clipboardData.getData("text/plain");
			if (pasted === "") {
				return;
			}

			event.preventDefault();
			const el = event.currentTarget;
			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? el.value.length;
			el.value = el.value.slice(0, start) + pasted + el.value.slice(end);
			applyNameInputToControl(el);

			queueMicrotask(() => {
				const pos = el.value.length;
				el.setSelectionRange(pos, pos);
			});
		});

		const handleNameCompositionEnd = useFn<CompositionEventHandler<HTMLInputElement>>((event) => {
			applyNameInputToControl(event.currentTarget);
		});

		const handleDescriptionInput = useFn<InputEventHandler<HTMLInputElement>>((event) => {
			applyDescriptionInputToControl(event.currentTarget);
		});

		const handleCreateModalCancel = useFn(() => {
			setOpen(false);
		});

		useEffect(() => {
			if (!open) {
				return;
			}

			nameBlockedMessagesRef.current.clear();
			setNameValidationMessage(undefined);
			setSubmitMessage(undefined);
			setDescriptionMessage(undefined);

			const el = nameInputRef.current;
			if (el) {
				el.value = "";
			}

			const descriptionEl = descriptionInputRef.current;
			if (descriptionEl) {
				descriptionEl.value = "";
			}

			setIsNameValid(false);
			setIsNameNonEmpty(false);
			setIsDescriptionValid(true);
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
						<div
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModalCreateModal-header-copy" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
							)}
						>
							<MyModalHeading>{dialogTitle}</MyModalHeading>
						</div>
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
								<MainAppHeaderWorkspaceCreateEditFormFields
									nameInputRef={nameInputRef}
									descriptionInputRef={descriptionInputRef}
									kind={kind}
									nameFieldLabel={nameFieldLabel}
									isNameValid={isNameValid}
									isNameNonEmpty={isNameNonEmpty}
									isDescriptionValid={isDescriptionValid}
									isSubmitting={isSubmitting}
									nameMessage={submitMessage ?? nameValidationMessage}
									descriptionMessage={descriptionMessage}
									onNameCompositionEnd={handleNameCompositionEnd}
									onNameInput={handleNameInput}
									onNamePaste={handleNamePaste}
									onDescriptionInput={handleDescriptionInput}
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

	const nameInputRef = useRef<HTMLInputElement>(null);
	const descriptionInputRef = useRef<HTMLInputElement>(null);
	const nameBlockedMessagesRef = useRef<Map<string, string>>(new Map());
	const initialCanonicalNameRef = useRef<string>("");
	const initialDescriptionRef = useRef<string>("");
	const [isNameValid, setIsNameValid] = useState(false);
	const [isNameNonEmpty, setIsNameNonEmpty] = useState(false);
	const [isDescriptionValid, setIsDescriptionValid] = useState(true);
	const [isUnchanged, setIsUnchanged] = useState(true);
	const [nameValidationMessage, setNameValidationMessage] = useState<string | undefined>(undefined);
	const [submitMessage, setSubmitMessage] = useState<string | undefined>(undefined);
	const [descriptionMessage, setDescriptionMessage] = useState<string | undefined>(undefined);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const syncUnchangedState = useFn(() => {
		const el = nameInputRef.current;
		const descriptionEl = descriptionInputRef.current;
		if (!el || !descriptionEl) {
			return;
		}

		const canonicalName = workspaces_name_autofix(el.value);
		const validatedName = workspaces_name_validate(canonicalName);
		const canonicalNameForCompare = validatedName._nay ? canonicalName : validatedName._yay;

		const validatedDescription = workspaces_description_normalize(descriptionEl.value);
		const normalizedDescription = validatedDescription._nay ? descriptionEl.value.trim() : validatedDescription._yay;

		setIsUnchanged(
			canonicalNameForCompare === initialCanonicalNameRef.current &&
				normalizedDescription === initialDescriptionRef.current,
		);
	});

	const syncNameValueForSubmit = useFn((el: HTMLInputElement) => {
		const normalized = workspaces_name_autofix(el.value, { trim_trailing_hyphens: false });
		if (el.value !== normalized) {
			el.value = normalized;
		}

		setIsNameNonEmpty(normalized.length > 0);

		const validated = workspaces_name_validate(normalized);
		const blockedMessage = validated._nay ? undefined : nameBlockedMessagesRef.current.get(validated._yay);

		setNameValidationMessage(validated._nay?.message ?? blockedMessage);
		setIsNameValid(!validated._nay && !blockedMessage);
		syncUnchangedState();
	});

	const applyNameInputToControl = useFn((el: HTMLInputElement) => {
		syncNameValueForSubmit(el);
		setSubmitMessage(undefined);
	});

	const syncDescriptionValueForSubmit = useFn((el: HTMLInputElement) => {
		const validated = workspaces_description_normalize(el.value);
		setDescriptionMessage(validated._nay?.message);
		setIsDescriptionValid(!validated._nay);
		syncUnchangedState();
	});

	const applyDescriptionInputToControl = useFn((el: HTMLInputElement) => {
		syncDescriptionValueForSubmit(el);
	});

	const handleFormSubmit = useFn<SubmitEventHandler<HTMLFormElement>>((event) => {
		event.preventDefault();
		if (isSubmitting || !target) {
			return;
		}

		const el = nameInputRef.current;
		if (!el) {
			return;
		}

		const descriptionEl = descriptionInputRef.current;
		if (!descriptionEl) {
			return;
		}

		syncNameValueForSubmit(el);
		const canonicalName = workspaces_name_autofix(el.value);
		el.value = canonicalName;
		const validated = workspaces_name_validate(canonicalName);
		if (validated._nay) {
			return;
		}

		const name = validated._yay;
		if (nameBlockedMessagesRef.current.has(name)) {
			return;
		}

		syncDescriptionValueForSubmit(descriptionEl);
		const descriptionValidated = workspaces_description_normalize(descriptionEl.value);
		if (descriptionValidated._nay) {
			setDescriptionMessage(descriptionValidated._nay.message);
			return;
		}

		const description = descriptionValidated._yay;

		if (name === initialCanonicalNameRef.current && description === initialDescriptionRef.current) {
			setTarget(null);
			return;
		}

		const activeTarget = target;

		void (async (/* iife */) => {
			setIsSubmitting(true);
			setSubmitMessage(undefined);

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
						setDescriptionMessage(result._nay.message);
					} else if (should_block_name_retry(result._nay.message)) {
						nameBlockedMessagesRef.current.set(name, result._nay.message);
						syncNameValueForSubmit(el);
					} else {
						setSubmitMessage(result._nay.message);
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
					setDescriptionMessage(result._nay.message);
				} else if (should_block_name_retry(result._nay.message)) {
					nameBlockedMessagesRef.current.set(name, result._nay.message);
					syncNameValueForSubmit(el);
				} else {
					setSubmitMessage(result._nay.message);
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

	const handleNameInput = useFn<InputEventHandler<HTMLInputElement>>((event) => {
		const el = event.currentTarget;
		const native = event.nativeEvent;
		if ("isComposing" in native && (native as InputEvent).isComposing) {
			return;
		}

		applyNameInputToControl(el);
	});

	const handleNamePaste = useFn<ClipboardEventHandler<HTMLInputElement>>((event) => {
		const pasted = event.clipboardData.getData("text/plain");
		if (pasted === "") {
			return;
		}

		event.preventDefault();
		const el = event.currentTarget;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? el.value.length;
		el.value = el.value.slice(0, start) + pasted + el.value.slice(end);
		applyNameInputToControl(el);

		queueMicrotask(() => {
			const pos = el.value.length;
			el.setSelectionRange(pos, pos);
		});
	});

	const handleNameCompositionEnd = useFn<CompositionEventHandler<HTMLInputElement>>((event) => {
		applyNameInputToControl(event.currentTarget);
	});

	const handleDescriptionInput = useFn<InputEventHandler<HTMLInputElement>>((event) => {
		applyDescriptionInputToControl(event.currentTarget);
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

		nameBlockedMessagesRef.current.clear();
		setNameValidationMessage(undefined);
		setSubmitMessage(undefined);
		setDescriptionMessage(undefined);

		const validatedInitial = workspaces_name_validate(workspaces_name_autofix(target.initialName));
		initialCanonicalNameRef.current = validatedInitial._nay
			? workspaces_name_autofix(target.initialName)
			: validatedInitial._yay;

		const validatedInitialDescription = workspaces_description_normalize(target.initialDescription);
		initialDescriptionRef.current = validatedInitialDescription._nay
			? target.initialDescription.trim()
			: validatedInitialDescription._yay;

		const el = nameInputRef.current;
		if (el) {
			el.value = target.initialName;
			applyNameInputToControl(el);
		}

		const descriptionEl = descriptionInputRef.current;
		if (descriptionEl) {
			descriptionEl.value = target.initialDescription;
			applyDescriptionInputToControl(descriptionEl);
		}
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
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalCreateModal-header-copy" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
						)}
					>
						<MyModalHeading>{dialogTitle}</MyModalHeading>
					</div>
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
							<MainAppHeaderWorkspaceCreateEditFormFields
								nameInputRef={nameInputRef}
								descriptionInputRef={descriptionInputRef}
								kind={target?.kind ?? "workspace"}
								nameFieldLabel={nameFieldLabel}
								isNameValid={isNameValid}
								isNameNonEmpty={isNameNonEmpty}
								isDescriptionValid={isDescriptionValid}
								isSubmitting={isSubmitting}
								nameMessage={submitMessage ?? nameValidationMessage}
								descriptionMessage={descriptionMessage}
								onNameCompositionEnd={handleNameCompositionEnd}
								onNameInput={handleNameInput}
								onNamePaste={handleNamePaste}
								onDescriptionInput={handleDescriptionInput}
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

// #region root
type MainAppHeaderWorkspaceSwitcherModal_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModal"
	| "MainAppHeaderWorkspaceSwitcherModal-header-copy"
	| "MainAppHeaderWorkspaceSwitcherModal-header-description"
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
	workspaceLimitFraction?: string;
	workspaceLimitTooltip?: string;
	projectLimitFraction?: string;
	projectLimitTooltip?: string;
	switchDisabled: boolean;
	editTarget: MainAppHeaderWorkspaceSwitcherModal_EditTarget | null;
	createWorkspace: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_workspace>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.create_workspace> | undefined>;
	createProject: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_project>,
	) => Promise<FunctionReturnType<typeof app_convex_api.workspaces.create_project> | undefined>;
	editWorkspace: MainAppHeaderWorkspaceSwitcherModalEditModal_Props["editWorkspace"];
	editProject: MainAppHeaderWorkspaceSwitcherModalEditModal_Props["editProject"];
	setEditTarget: MainAppHeaderWorkspaceSwitcherModalEditModal_Props["setTarget"];
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
		workspaceLimitFraction,
		workspaceLimitTooltip,
		projectLimitFraction,
		projectLimitTooltip,
		switchDisabled,
		editTarget,
		createWorkspace,
		createProject,
		editWorkspace,
		editProject,
		setEditTarget,
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
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModal-header-copy" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
						)}
					>
						<MyModalHeading>Workspace</MyModalHeading>
						<MyModalDescription
							className={
								"MainAppHeaderWorkspaceSwitcherModal-header-description" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames
							}
						>
							Select a workspace to list its projects, choose a project, then click Switch.
						</MyModalDescription>
					</div>
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
							limitFraction={workspaceLimitFraction}
							limitTooltip={workspaceLimitTooltip}
							onCreate={handleOpenCreateWorkspaceDialog}
							icon={<Briefcase />}
						/>

						<MainAppHeaderWorkspaceSwitcherModalSelectPane
							dialogOpen={dialogOpen}
							title="Projects"
							items={projectItems}
							selectedItemId={draftProjectId}
							createDisabled={createProjectDisabled}
							createDisabledReason={createProjectDisabledReason}
							limitFraction={projectLimitFraction}
							limitTooltip={projectLimitTooltip}
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
			</MyModalPopover>
		</>
	);
});
// #endregion root
