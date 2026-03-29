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
	type FormEventHandler,
	type ReactNode,
	type SetStateAction,
} from "react";
import { ChevronRight, EllipsisVertical, Folder, FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";

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
	MyInputTextAreaControl,
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
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { MyFocus, type MyFocus_ClassNames } from "@/lib/my-focus.ts";
import {
	workspaces_description_max_length,
	workspaces_description_normalize,
	workspaces_name_autofix,
	workspaces_name_validate,
} from "@/lib/workspaces.ts";
import { cn } from "@/lib/utils.ts";

// #region list item model
export type MainAppHeaderWorkspaceSwitcherModal_ListItem = {
	description: string;
	id: string;
	isCurrent?: boolean;
	isDefault?: boolean;
	label: string;
	onDelete?: () => void;
	onEdit?: () => void;
	onSelect: () => void;
};
// #endregion list item model

// #region rename target / callback
export type MainAppHeaderWorkspaceSwitcherModal_RenameTarget =
	| {
			kind: "workspace";
			id: string;
			initialName: string;
			defaultProjectId: app_convex_Id<"workspaces_projects">;
	  }
	| {
			kind: "project";
			id: string;
			initialName: string;
			workspaceId: app_convex_Id<"workspaces">;
			defaultProjectId: app_convex_Id<"workspaces_projects">;
	  };

export type MainAppHeaderWorkspaceSwitcherModal_AfterRename = {
	kind: "project" | "workspace";
	oldName: string;
	newName: string;
	projectId?: app_convex_Id<"workspaces_projects">;
	workspaceId: app_convex_Id<"workspaces">;
};
// #endregion rename target / callback

// #region create args / results
type MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs = FunctionArgs<
	typeof app_convex_api.workspaces.create_project
>;

type MainAppHeaderWorkspaceSwitcherModal_CreateWorkspaceResult = FunctionReturnType<
	typeof app_convex_api.workspaces.create_workspace
>;
type MainAppHeaderWorkspaceSwitcherModal_CreateProjectResult = FunctionReturnType<
	typeof app_convex_api.workspaces.create_project
>;

type MainAppHeaderWorkspaceSwitcherModal_RenameWorkspaceResult = FunctionReturnType<
	typeof app_convex_api.workspaces.rename_workspace
>;
type MainAppHeaderWorkspaceSwitcherModal_RenameProjectResult = FunctionReturnType<
	typeof app_convex_api.workspaces.rename_project
>;
// #endregion create args / results

// #region after create selection
export type MainAppHeaderWorkspaceSwitcherModal_AfterCreateSelection = {
	workspaceId: app_convex_Id<"workspaces">;
	projectId: app_convex_Id<"workspaces_projects">;
	workspaceName: string;
	projectName: string;
};
// #endregion after create selection

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
				type="button"
				variant="ghost-highlightable"
				className={cn(
					"MainAppHeaderWorkspaceSwitcherModalListItem-primary" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
					"MyFocus-row" satisfies MyFocus_ClassNames,
				)}
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
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-icon"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-title"
	| "MainAppHeaderWorkspaceSwitcherModalSelectHead-create";

export type MainAppHeaderWorkspaceSwitcherModalSelectHead_Props = {
	iconSlot: ReactNode;
	title: string;
	createDisabled?: boolean;
	onCreate: () => void;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectHead = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectHead(props: MainAppHeaderWorkspaceSwitcherModalSelectHead_Props) {
		const { iconSlot, title, createDisabled, onCreate } = props;

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
						"MainAppHeaderWorkspaceSwitcherModalSelectHead-title" satisfies MainAppHeaderWorkspaceSwitcherModalSelectHead_ClassNames,
					)}
				>
					{title}
				</div>
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
			</div>
		);
	},
);
// #endregion select head

// #region select list
type MainAppHeaderWorkspaceSwitcherModalSelectList_ClassNames = "MainAppHeaderWorkspaceSwitcherModalSelectList";

export type MainAppHeaderWorkspaceSwitcherModalSelectList_Props = {
	children: ReactNode;
	myFocusSyncKey: string;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectList = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectList(props: MainAppHeaderWorkspaceSwitcherModalSelectList_Props) {
		const { children, myFocusSyncKey } = props;

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

export type MainAppHeaderWorkspaceSwitcherModalSelectPane_Item = Omit<
	MainAppHeaderWorkspaceSwitcherModal_ListItem,
	"isCurrent"
>;

// #region select pane list
export type MainAppHeaderWorkspaceSwitcherModalSelectPaneList_Props = {
	items: MainAppHeaderWorkspaceSwitcherModalSelectPane_Item[];
	selectedItemId: string;
	dialogOpen: boolean;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectPaneList = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectPaneList(
		props: MainAppHeaderWorkspaceSwitcherModalSelectPaneList_Props,
	) {
		const { items, selectedItemId, dialogOpen } = props;

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
	icon: ReactNode;
	title: string;
	items: MainAppHeaderWorkspaceSwitcherModalSelectPane_Item[];
	selectedItemId: string;
	dialogOpen: boolean;
	createDisabled?: boolean;
	onCreate: () => void;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectPane = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectPane(props: MainAppHeaderWorkspaceSwitcherModalSelectPane_Props) {
		const { icon, title, items, selectedItemId, dialogOpen, createDisabled, onCreate } = props;

		return (
			<section
				className={cn(
					"MainAppHeaderWorkspaceSwitcherModalSelectPane" satisfies MainAppHeaderWorkspaceSwitcherModalSelectPane_ClassNames,
				)}
			>
				<MainAppHeaderWorkspaceSwitcherModalSelectHead
					iconSlot={icon}
					title={title}
					createDisabled={createDisabled}
					onCreate={onCreate}
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

// #region create modal
const main_app_header_workspace_switcher_modal_CREATE_NAME_HELPER_TEXT =
	"Lowercase letters and hyphens only (kebab-case).";

const main_app_header_workspace_switcher_modal_CREATE_DESCRIPTION_HELPER_TEXT = `Plain text, up to ${workspaces_description_max_length} characters. Leave empty if you do not need a description.`;

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
	createProject: (
		args: MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs,
	) => Promise<MainAppHeaderWorkspaceSwitcherModal_CreateProjectResult | undefined>;
	createWorkspace: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_workspace>,
	) => Promise<MainAppHeaderWorkspaceSwitcherModal_CreateWorkspaceResult | undefined>;
	workspaceId: MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs["workspaceId"];
	workspaceName: string;
	onAfterCreateProject: (args: MainAppHeaderWorkspaceSwitcherModal_AfterCreateSelection) => void;
	onAfterCreateWorkspace: (args: MainAppHeaderWorkspaceSwitcherModal_AfterCreateSelection) => void;
};

export const MainAppHeaderWorkspaceSwitcherModalCreateModal = memo(
	function MainAppHeaderWorkspaceSwitcherModalCreateModal(props: MainAppHeaderWorkspaceSwitcherModalCreateModal_Props) {
		const {
			open,
			setOpen,
			kind,
			createProject,
			createWorkspace,
			workspaceId,
			workspaceName,
			onAfterCreateProject,
			onAfterCreateWorkspace,
		} = props;

		const createFormDomId = `MainAppHeaderWorkspaceSwitcherModalCreateModal-create-form-${useId().replace(/:/g, "")}`;

		const nameInputRef = useRef<HTMLInputElement>(null);
		const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
		const nameSubmitFailuresRef = useRef<Set<string>>(new Set());
		const [isNameValid, setIsNameValid] = useState(false);
		const [isNameNonEmpty, setIsNameNonEmpty] = useState(false);
		const [isDescriptionValid, setIsDescriptionValid] = useState(true);
		const [submitMessage, setSubmitMessage] = useState<string | undefined>(undefined);
		const [descriptionSubmitMessage, setDescriptionSubmitMessage] = useState<string | undefined>(undefined);
		const [isSubmitting, setIsSubmitting] = useState(false);

		const sync_name_value_for_submit = (el: HTMLInputElement) => {
			const normalized = workspaces_name_autofix(el.value, { trim_trailing_hyphens: false });
			if (el.value !== normalized) {
				el.value = normalized;
			}

			setIsNameNonEmpty(normalized.length > 0);

			const validated = workspaces_name_validate(normalized);
			const blockedByFailedRetry = nameSubmitFailuresRef.current.has(normalized);

			setIsNameValid(!validated._nay && !blockedByFailedRetry);
		};

		const apply_name_input_to_control = (el: HTMLInputElement) => {
			sync_name_value_for_submit(el);
			setSubmitMessage(undefined);
		};

		const sync_description_value_for_submit = (el: HTMLTextAreaElement) => {
			const validated = workspaces_description_normalize(el.value);
			setIsDescriptionValid(!validated._nay);
		};

		const apply_description_input_to_control = (el: HTMLTextAreaElement) => {
			sync_description_value_for_submit(el);
			setDescriptionSubmitMessage(undefined);
		};

		const handleFormSubmit: FormEventHandler<HTMLFormElement> = (event) => {
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

			sync_name_value_for_submit(el);
			const canonicalName = workspaces_name_autofix(el.value);
			el.value = canonicalName;
			const validated = workspaces_name_validate(canonicalName);
			if (validated._nay) {
				return;
			}

			const name = validated._yay;
			if (nameSubmitFailuresRef.current.has(name)) {
				return;
			}

			sync_description_value_for_submit(descriptionEl);
			const descriptionValidated = workspaces_description_normalize(descriptionEl.value);
			if (descriptionValidated._nay) {
				setDescriptionSubmitMessage(descriptionValidated._nay.message);
				return;
			}
			const description = descriptionValidated._yay;

			void (async (/* iife */) => {
				setIsSubmitting(true);
				setSubmitMessage(undefined);
				setDescriptionSubmitMessage(undefined);

				if (kind === "workspace") {
					const result = await createWorkspace({ name, description });

					if (result == null) {
						return;
					}

					if (result._nay) {
						if (result._nay.message === "Description is too long") {
							setDescriptionSubmitMessage(result._nay.message);
						} else {
							nameSubmitFailuresRef.current.add(name);
							setIsNameValid(false);
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
						setDescriptionSubmitMessage(result._nay.message);
					} else {
						nameSubmitFailuresRef.current.add(name);
						setIsNameValid(false);
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
		};

		const handleNameInput: FormEventHandler<HTMLInputElement> = (event) => {
			const el = event.currentTarget;
			const native = event.nativeEvent;
			if ("isComposing" in native && (native as InputEvent).isComposing) {
				return;
			}

			// Covers insertFromPaste, insertFromDrop, insertText, and delete-*: el.value already includes the edit (onPaste uses preventDefault and normalizes without relying on this).
			apply_name_input_to_control(el);
		};

		const handleNamePaste: ClipboardEventHandler<HTMLInputElement> = (event) => {
			const pasted = event.clipboardData.getData("text/plain");
			if (pasted === "") {
				return;
			}

			event.preventDefault();
			const el = event.currentTarget;
			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? el.value.length;
			el.value = el.value.slice(0, start) + pasted + el.value.slice(end);
			apply_name_input_to_control(el);

			queueMicrotask(() => {
				const pos = el.value.length;
				el.setSelectionRange(pos, pos);
			});
		};

		const handleNameCompositionEnd: CompositionEventHandler<HTMLInputElement> = (event) => {
			apply_name_input_to_control(event.currentTarget);
		};

		const handleDescriptionInput: FormEventHandler<HTMLTextAreaElement> = (event) => {
			apply_description_input_to_control(event.currentTarget);
		};

		useEffect(() => {
			if (!open) {
				return;
			}

			nameSubmitFailuresRef.current.clear();
			setSubmitMessage(undefined);
			setDescriptionSubmitMessage(undefined);

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
								<MyInput variant="surface">
									<MyInputLabel>{nameFieldLabel}</MyInputLabel>
									<MyInputArea>
										<MyInputBox />
										<MyInputControl
											ref={nameInputRef}
											type="text"
											autoComplete="off"
											defaultValue=""
											placeholder={kind === "workspace" ? "acme-labs" : "my-project"}
											aria-invalid={!isNameValid && isNameNonEmpty}
											disabled={isSubmitting}
											onCompositionEnd={handleNameCompositionEnd}
											onInput={handleNameInput}
											onPaste={handleNamePaste}
										/>
									</MyInputArea>
									<MyInputHelperText
										className={cn(
											submitMessage &&
												("MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-helper-state-error" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames),
										)}
									>
										{submitMessage ?? main_app_header_workspace_switcher_modal_CREATE_NAME_HELPER_TEXT}
									</MyInputHelperText>
								</MyInput>

								<MyInput variant="surface">
									<MyInputLabel>Description</MyInputLabel>
									<MyInputArea>
										<MyInputBox />
										<MyInputTextAreaControl
											ref={descriptionInputRef}
											rows={3}
											autoComplete="off"
											placeholder={
												kind === "workspace" ? "What is this workspace used for?" : "What is this project used for?"
											}
											aria-invalid={!isDescriptionValid}
											disabled={isSubmitting}
											onInput={handleDescriptionInput}
										/>
									</MyInputArea>
									<MyInputHelperText
										className={cn(
											descriptionSubmitMessage &&
												("MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-helper-state-error" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames),
										)}
									>
										{descriptionSubmitMessage ?? main_app_header_workspace_switcher_modal_CREATE_DESCRIPTION_HELPER_TEXT}
									</MyInputHelperText>
								</MyInput>
							</div>
						</form>
					</MyModalScrollableArea>

					<MyModalFooter>
						<MyButton type="button" disabled={isSubmitting} variant="outline" onClick={() => setOpen(false)}>
							Cancel
						</MyButton>
						<MyButton
							type="submit"
							form={createFormDomId}
							disabled={!isNameValid || !isDescriptionValid || isSubmitting}
							variant="accent"
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

// #region rename modal
type MainAppHeaderWorkspaceSwitcherModalRenameModal_Props = {
	renameProject: (
		args: FunctionArgs<typeof app_convex_api.workspaces.rename_project>,
	) => Promise<MainAppHeaderWorkspaceSwitcherModal_RenameProjectResult | undefined>;
	renameWorkspace: (
		args: FunctionArgs<typeof app_convex_api.workspaces.rename_workspace>,
	) => Promise<MainAppHeaderWorkspaceSwitcherModal_RenameWorkspaceResult | undefined>;
	setTarget: Dispatch<SetStateAction<MainAppHeaderWorkspaceSwitcherModal_RenameTarget | null>>;
	target: MainAppHeaderWorkspaceSwitcherModal_RenameTarget | null;
	onAfterRename: (args: MainAppHeaderWorkspaceSwitcherModal_AfterRename) => void;
};

export const MainAppHeaderWorkspaceSwitcherModalRenameModal = memo(
	function MainAppHeaderWorkspaceSwitcherModalRenameModal(props: MainAppHeaderWorkspaceSwitcherModalRenameModal_Props) {
		const { target, setTarget, renameWorkspace, renameProject, onAfterRename } = props;

		const renameFormDomId = `MainAppHeaderWorkspaceSwitcherModalRenameModal-form-${useId().replace(/:/g, "")}`;

		const nameInputRef = useRef<HTMLInputElement>(null);
		const nameSubmitFailuresRef = useRef<Set<string>>(new Set());
		const initialCanonicalNameRef = useRef<string>("");
		const [isNameValid, setIsNameValid] = useState(false);
		const [isNameNonEmpty, setIsNameNonEmpty] = useState(false);
		const [isUnchanged, setIsUnchanged] = useState(true);
		const [submitMessage, setSubmitMessage] = useState<string | undefined>(undefined);
		const [isSubmitting, setIsSubmitting] = useState(false);

		const sync_name_value_for_submit = (el: HTMLInputElement) => {
			const normalized = workspaces_name_autofix(el.value, { trim_trailing_hyphens: false });
			if (el.value !== normalized) {
				el.value = normalized;
			}

			setIsNameNonEmpty(normalized.length > 0);

			const validated = workspaces_name_validate(normalized);
			const blockedByFailedRetry = nameSubmitFailuresRef.current.has(normalized);

			setIsNameValid(!validated._nay && !blockedByFailedRetry);

			const canonicalForCompare = validated._nay ? normalized : validated._yay;
			setIsUnchanged(canonicalForCompare === initialCanonicalNameRef.current);
		};

		const apply_name_input_to_control = (el: HTMLInputElement) => {
			sync_name_value_for_submit(el);
			setSubmitMessage(undefined);
		};

		const handleFormSubmit: FormEventHandler<HTMLFormElement> = (event) => {
			event.preventDefault();
			if (isSubmitting || !target) {
				return;
			}

			const el = nameInputRef.current;
			if (!el) {
				return;
			}

			sync_name_value_for_submit(el);
			const canonicalName = workspaces_name_autofix(el.value);
			el.value = canonicalName;
			const validated = workspaces_name_validate(canonicalName);
			if (validated._nay) {
				return;
			}

			const name = validated._yay;
			if (nameSubmitFailuresRef.current.has(name)) {
				return;
			}

			if (name === initialCanonicalNameRef.current) {
				setTarget(null);
				return;
			}

			const activeTarget = target;

			void (async (/* iife */) => {
				setIsSubmitting(true);
				setSubmitMessage(undefined);

				if (activeTarget.kind === "workspace") {
					const result = await renameWorkspace({
						workspaceId: activeTarget.id as app_convex_Id<"workspaces">,
						defaultProjectId: activeTarget.defaultProjectId,
						name,
					});

					if (result == null) {
						return;
					}

					if (result._nay) {
						nameSubmitFailuresRef.current.add(name);
						setIsNameValid(false);
						setSubmitMessage(result._nay.message);
						return;
					}

					await app_convex.query(app_convex_api.workspaces.list, {});

					setTarget(null);
					onAfterRename({
						kind: "workspace",
						oldName: activeTarget.initialName,
						newName: result._yay.name,
						workspaceId: activeTarget.id as app_convex_Id<"workspaces">,
					});
					return;
				}

				const result = await renameProject({
					workspaceId: activeTarget.workspaceId,
					defaultProjectId: activeTarget.defaultProjectId,
					projectId: activeTarget.id as app_convex_Id<"workspaces_projects">,
					name,
				});

				if (result == null) {
					return;
				}

				if (result._nay) {
					nameSubmitFailuresRef.current.add(name);
					setIsNameValid(false);
					setSubmitMessage(result._nay.message);
					return;
				}

				await app_convex.query(app_convex_api.workspaces.list, {});

				setTarget(null);
				onAfterRename({
					kind: "project",
					oldName: activeTarget.initialName,
					newName: result._yay.name,
					workspaceId: result._yay.workspaceId,
					projectId: activeTarget.id as app_convex_Id<"workspaces_projects">,
				});
			})()
				.catch((error) => {
					console.error("[MainAppHeaderWorkspaceSwitcherModalRenameModal] Unexpected rename error", {
						error,
						kind: activeTarget.kind,
					});
				})
				.finally(() => {
					setIsSubmitting(false);
				});
		};

		const handleNameInput: FormEventHandler<HTMLInputElement> = (event) => {
			const el = event.currentTarget;
			const native = event.nativeEvent;
			if ("isComposing" in native && (native as InputEvent).isComposing) {
				return;
			}

			apply_name_input_to_control(el);
		};

		const handleNamePaste: ClipboardEventHandler<HTMLInputElement> = (event) => {
			const pasted = event.clipboardData.getData("text/plain");
			if (pasted === "") {
				return;
			}

			event.preventDefault();
			const el = event.currentTarget;
			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? el.value.length;
			el.value = el.value.slice(0, start) + pasted + el.value.slice(end);
			apply_name_input_to_control(el);

			queueMicrotask(() => {
				const pos = el.value.length;
				el.setSelectionRange(pos, pos);
			});
		};

		const handleNameCompositionEnd: CompositionEventHandler<HTMLInputElement> = (event) => {
			apply_name_input_to_control(event.currentTarget);
		};

		useEffect(() => {
			if (!target) {
				return;
			}

			nameSubmitFailuresRef.current.clear();
			setSubmitMessage(undefined);

			const validatedInitial = workspaces_name_validate(workspaces_name_autofix(target.initialName));
			initialCanonicalNameRef.current = validatedInitial._nay ? "" : validatedInitial._yay;

			const el = nameInputRef.current;
			if (el) {
				el.value = target.initialName;
				apply_name_input_to_control(el);
			}
		}, [target]);

		const dialogTitle = target ? (target.kind === "workspace" ? "Rename workspace" : "Rename project") : "Rename";
		const nameFieldLabel = target ? (target.kind === "workspace" ? "Workspace name" : "Project name") : "Name";
		const renameOpen = target !== null;

		const handleRenameModalSetOpen: Dispatch<SetStateAction<boolean>> = (next) => {
			const resolved = typeof next === "function" ? next(renameOpen) : next;
			if (!resolved) {
				setTarget(null);
			}
		};

		return (
			<MyModal open={renameOpen} setOpen={handleRenameModalSetOpen}>
				<MyModalPopover
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalCreateModal" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames,
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
							id={renameFormDomId}
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
								<MyInput variant="surface">
									<MyInputLabel>{nameFieldLabel}</MyInputLabel>
									<MyInputArea>
										<MyInputBox />
										<MyInputControl
											ref={nameInputRef}
											type="text"
											autoComplete="off"
											defaultValue=""
											placeholder={target?.kind === "workspace" ? "acme-labs" : "my-project"}
											aria-invalid={!isNameValid && isNameNonEmpty}
											disabled={isSubmitting}
											onCompositionEnd={handleNameCompositionEnd}
											onInput={handleNameInput}
											onPaste={handleNamePaste}
										/>
									</MyInputArea>
									<MyInputHelperText
										className={cn(
											submitMessage &&
												("MainAppHeaderWorkspaceSwitcherModalCreateModal-sub-helper-state-error" satisfies MainAppHeaderWorkspaceSwitcherModalCreateModal_ClassNames),
										)}
									>
										{submitMessage ?? main_app_header_workspace_switcher_modal_CREATE_NAME_HELPER_TEXT}
									</MyInputHelperText>
								</MyInput>
							</div>
						</form>
					</MyModalScrollableArea>

					<MyModalFooter>
						<MyButton type="button" disabled={isSubmitting} variant="outline" onClick={() => setTarget(null)}>
							Cancel
						</MyButton>
						<MyButton
							type="submit"
							form={renameFormDomId}
							disabled={!isNameValid || isSubmitting || isUnchanged}
							variant="accent"
						>
							{isSubmitting ? "Saving…" : "Save"}
						</MyButton>
					</MyModalFooter>

					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		);
	},
);
// #endregion rename modal

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

type MainAppHeaderWorkspaceSwitcherModal_Props = {
	dialogOpen: boolean;
	createProject: (
		args: MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs,
	) => Promise<MainAppHeaderWorkspaceSwitcherModal_CreateProjectResult | undefined>;
	createWorkspace: (
		args: FunctionArgs<typeof app_convex_api.workspaces.create_workspace>,
	) => Promise<MainAppHeaderWorkspaceSwitcherModal_CreateWorkspaceResult | undefined>;
	listLoaded: boolean;
	draftProjectId: app_convex_Id<"workspaces_projects">;
	draftWorkspaceId: MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs["workspaceId"];
	projectItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[];
	switchDisabled: boolean;
	summaryProjectName: string;
	summaryWorkspaceName: string;
	workspaceItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[];
	/** Workspace name for create-project flow (draft row), not necessarily the routed tenant. */
	workspaceName: string;
	renameProject: MainAppHeaderWorkspaceSwitcherModalRenameModal_Props["renameProject"];
	renameTarget: MainAppHeaderWorkspaceSwitcherModal_RenameTarget | null;
	renameWorkspace: MainAppHeaderWorkspaceSwitcherModalRenameModal_Props["renameWorkspace"];
	setRenameTarget: MainAppHeaderWorkspaceSwitcherModalRenameModal_Props["setTarget"];
	onAfterCreateProject: (args: MainAppHeaderWorkspaceSwitcherModal_AfterCreateSelection) => void;
	onAfterCreateWorkspace: (args: MainAppHeaderWorkspaceSwitcherModal_AfterCreateSelection) => void;
	onAfterRename: (args: MainAppHeaderWorkspaceSwitcherModal_AfterRename) => void;
	onCancel: () => void;
	onSwitch: () => void;
};

export const MainAppHeaderWorkspaceSwitcherModal = memo(function MainAppHeaderWorkspaceSwitcherModal(
	props: MainAppHeaderWorkspaceSwitcherModal_Props,
) {
	const {
		dialogOpen,
		createProject,
		createWorkspace,
		listLoaded,
		draftProjectId,
		draftWorkspaceId,
		projectItems,
		switchDisabled,
		summaryProjectName,
		summaryWorkspaceName,
		workspaceItems,
		workspaceName,
		renameProject,
		renameTarget,
		renameWorkspace,
		setRenameTarget,
		onAfterCreateProject,
		onAfterCreateWorkspace,
		onAfterRename,
		onCancel,
		onSwitch,
	} = props;

	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createDialogKind, setCreateDialogKind] = useState<"project" | "workspace">("workspace");

	const openCreateDialog = (kind: "project" | "workspace") => {
		setCreateDialogKind(kind);
		setCreateDialogOpen(true);
	};

	const canCreateProject = listLoaded;

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
							icon={<Folder />}
							title="Workspaces"
							items={workspaceItems}
							selectedItemId={draftWorkspaceId}
							onCreate={() => openCreateDialog("workspace")}
						/>

						<MainAppHeaderWorkspaceSwitcherModalSelectPane
							dialogOpen={dialogOpen}
							icon={<FolderKanban />}
							title="Projects"
							items={projectItems}
							selectedItemId={draftProjectId}
							createDisabled={!canCreateProject}
							onCreate={() => openCreateDialog("project")}
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
					<MyButton type="button" disabled={switchDisabled} variant="accent" onClick={onSwitch}>
						Switch
					</MyButton>
				</MyModalFooter>

				<MyModalCloseTrigger />
				<MainAppHeaderWorkspaceSwitcherModalCreateModal
					open={createDialogOpen}
					setOpen={setCreateDialogOpen}
					kind={createDialogKind}
					createProject={createProject}
					createWorkspace={createWorkspace}
					workspaceId={draftWorkspaceId}
					workspaceName={workspaceName}
					onAfterCreateProject={onAfterCreateProject}
					onAfterCreateWorkspace={onAfterCreateWorkspace}
				/>
				<MainAppHeaderWorkspaceSwitcherModalRenameModal
					target={renameTarget}
					setTarget={setRenameTarget}
					renameWorkspace={renameWorkspace}
					renameProject={renameProject}
					onAfterRename={onAfterRename}
				/>
			</MyModalPopover>
		</>
	);
});
// #endregion root
