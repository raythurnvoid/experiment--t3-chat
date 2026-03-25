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
import { ChevronRight, Folder, FolderKanban, Plus } from "lucide-react";

import { useFn } from "@/hooks/utils-hooks.ts";
import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
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
import { MySidebarList, MySidebarListItem, MySidebarListItemPrimaryAction } from "@/components/my-sidebar.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { MyFocus, type MyFocus_ClassNames } from "@/lib/my-focus.ts";
import { workspaces_name_autofix, workspaces_name_validate } from "@/lib/workspaces-name.ts";
import { cn } from "@/lib/utils.ts";

// #region list item model
export type MainAppHeaderWorkspaceSwitcherModal_ListItem = {
	description: string;
	id: string;
	isCurrent?: boolean;
	label: string;
	onSelect: () => void;
};
// #endregion list item model

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
// #endregion create args / results

// #region list item selected
type MainAppHeaderWorkspaceSwitcherModalListItemSelected_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalListItemSelected"
	| "MainAppHeaderWorkspaceSwitcherModalListItemSelected-border";

export type MainAppHeaderWorkspaceSwitcherModalListItemSelected_Props = {
	label: string;
	description: string;
};

export const MainAppHeaderWorkspaceSwitcherModalListItemSelected = memo(
	function MainAppHeaderWorkspaceSwitcherModalListItemSelected(
		props: MainAppHeaderWorkspaceSwitcherModalListItemSelected_Props,
	) {
		const { label, description } = props;

		const descriptionText = description.trim() ? description : "(No description)";

		return (
			<>
				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalListItemSelected" satisfies MainAppHeaderWorkspaceSwitcherModalListItemSelected_ClassNames,
						"MainAppHeaderWorkspaceSwitcherModalListItem-content" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
					)}
					aria-current="true"
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalListItemSelected-border" satisfies MainAppHeaderWorkspaceSwitcherModalListItemSelected_ClassNames,
						)}
						aria-hidden
					/>
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalListItem-label" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
						)}
					>
						{label}
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalListItem-description" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
						)}
					>
						{descriptionText}
					</div>
				</div>
				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalListItem-actions" satisfies MainAppHeaderWorkspaceSwitcherModalListItemSelectable_ClassNames,
					)}
					aria-hidden
				/>
			</>
		);
	},
);
// #endregion list item selected

// #region list item selectable
type MainAppHeaderWorkspaceSwitcherModalListItemSelectable_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalListItemSelectable"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-actions";

export type MainAppHeaderWorkspaceSwitcherModalListItemSelectable_Props = {
	label: string;
	description: string;
	onSelect: () => void;
};

export const MainAppHeaderWorkspaceSwitcherModalListItemSelectable = memo(
	function MainAppHeaderWorkspaceSwitcherModalListItemSelectable(
		props: MainAppHeaderWorkspaceSwitcherModalListItemSelectable_Props,
	) {
		const { label, description, onSelect } = props;

		const handleSelect = useFn(() => {
			onSelect();
		});

		const descriptionText = description.trim() ? description : "(No description)";

		return (
			<>
				<MySidebarListItemPrimaryAction
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalListItemSelectable" satisfies MainAppHeaderWorkspaceSwitcherModalListItemSelectable_ClassNames,
						"MainAppHeaderWorkspaceSwitcherModalListItem-content" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
						"MyFocus-row" satisfies MyFocus_ClassNames,
					)}
					onClick={handleSelect}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalListItem-label" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
						)}
					>
						{label}
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModalListItem-description" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
						)}
					>
						{descriptionText}
					</div>
				</MySidebarListItemPrimaryAction>
				<div
					className={cn(
						"MainAppHeaderWorkspaceSwitcherModalListItem-actions" satisfies MainAppHeaderWorkspaceSwitcherModalListItemSelectable_ClassNames,
					)}
					aria-hidden
				/>
			</>
		);
	},
);
// #endregion list item selectable

// #region list item
type MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModalListItem"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-content"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-label"
	| "MainAppHeaderWorkspaceSwitcherModalListItem-description";

export type MainAppHeaderWorkspaceSwitcherModalListItem_Props = {
	item: MainAppHeaderWorkspaceSwitcherModal_ListItem;
};

export const MainAppHeaderWorkspaceSwitcherModalListItem = memo(function MainAppHeaderWorkspaceSwitcherModalListItem(
	props: MainAppHeaderWorkspaceSwitcherModalListItem_Props,
) {
	const { item } = props;

	return (
		<MySidebarListItem
			className={cn(
				"MainAppHeaderWorkspaceSwitcherModalListItem" satisfies MainAppHeaderWorkspaceSwitcherModalListItem_ClassNames,
			)}
		>
			{item.isCurrent ? (
				<MainAppHeaderWorkspaceSwitcherModalListItemSelected label={item.label} description={item.description} />
			) : (
				<MainAppHeaderWorkspaceSwitcherModalListItemSelectable
					label={item.label}
					description={item.description}
					onSelect={item.onSelect}
				/>
			)}
		</MySidebarListItem>
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
};

export const MainAppHeaderWorkspaceSwitcherModalSelectList = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectList(props: MainAppHeaderWorkspaceSwitcherModalSelectList_Props) {
		const { children } = props;

		const [list, setList] = useState<HTMLUListElement | null>(null);

		useEffect(() => {
			if (!list) {
				return;
			}

			const focus = new MyFocus(list);
			focus.start();

			return () => {
				focus.stop();
			};
		}, [list]);

		return (
			<MySidebarList
				ref={setList}
				className={cn(
					"MainAppHeaderWorkspaceSwitcherModalSelectList" satisfies MainAppHeaderWorkspaceSwitcherModalSelectList_ClassNames,
					"MyFocus-container" satisfies MyFocus_ClassNames,
				)}
			>
				{children}
			</MySidebarList>
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
};

export const MainAppHeaderWorkspaceSwitcherModalSelectPaneList = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectPaneList(
		props: MainAppHeaderWorkspaceSwitcherModalSelectPaneList_Props,
	) {
		const { items, selectedItemId } = props;

		return (
			<MainAppHeaderWorkspaceSwitcherModalSelectList>
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
	createDisabled?: boolean;
	onCreate: () => void;
};

export const MainAppHeaderWorkspaceSwitcherModalSelectPane = memo(
	function MainAppHeaderWorkspaceSwitcherModalSelectPane(props: MainAppHeaderWorkspaceSwitcherModalSelectPane_Props) {
		const { icon, title, items, selectedItemId, createDisabled, onCreate } = props;

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

				<MainAppHeaderWorkspaceSwitcherModalSelectPaneList items={items} selectedItemId={selectedItemId} />
			</section>
		);
	},
);
// #endregion select pane

// #region create modal
const main_app_header_workspace_switcher_modal_CREATE_NAME_HELPER_TEXT =
	"Lowercase letters and hyphens only (kebab-case).";

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
	onAfterCreateProject: (args: { projectName: string; workspaceName: string }) => void;
	onAfterCreateWorkspace: (args: { projectName: string; workspaceName: string }) => void;
};

export const MainAppHeaderWorkspaceSwitcherModalCreateModal = memo(
	function MainAppHeaderWorkspaceSwitcherModalCreateModal(
		props: MainAppHeaderWorkspaceSwitcherModalCreateModal_Props,
	) {
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
		const nameSubmitFailuresRef = useRef<Set<string>>(new Set());
		const [isNameValid, setIsNameValid] = useState(false);
		const [isNameNonEmpty, setIsNameNonEmpty] = useState(false);
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
		};

		const apply_name_input_to_control = (el: HTMLInputElement) => {
			sync_name_value_for_submit(el);
			setSubmitMessage(undefined);
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

			void (async (/* iife */) => {
				setIsSubmitting(true);
				setSubmitMessage(undefined);

				if (kind === "workspace") {
					const result = await createWorkspace({ name });
					setIsSubmitting(false);

					if (result == null) {
						return;
					}

					if (result._nay) {
						nameSubmitFailuresRef.current.add(name);
						setIsNameValid(false);
						setSubmitMessage(result._nay.message);
						return;
					}

					setOpen(false);
					onAfterCreateWorkspace({
						workspaceName: result._yay.name,
						projectName: result._yay.defaultProjectName,
					});
					return;
				}

				const result = await createProject({ name, workspaceId });
				setIsSubmitting(false);

				if (result == null) {
					return;
				}

				if (result._nay) {
					nameSubmitFailuresRef.current.add(name);
					setIsNameValid(false);
					setSubmitMessage(result._nay.message);
					return;
				}

				setOpen(false);
				onAfterCreateProject({ workspaceName, projectName: result._yay.name });
			})().catch((error) => {
				setIsSubmitting(false);
				console.error("[MainAppHeaderWorkspaceSwitcherModalCreateModal] Unexpected create error", {
					error,
					kind,
				});
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

		useEffect(() => {
			if (!open) {
				return;
			}

			nameSubmitFailuresRef.current.clear();
			setSubmitMessage(undefined);

			const el = nameInputRef.current;
			if (el) {
				el.value = "";
			}

			setIsNameValid(false);
			setIsNameNonEmpty(false);
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
							</div>
						</form>
					</MyModalScrollableArea>

					<MyModalFooter>
						<MyButton
							type="button"
							disabled={isSubmitting}
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</MyButton>
						<MyButton
							type="submit"
							form={createFormDomId}
							disabled={!isNameValid || isSubmitting}
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

// #region root
type MainAppHeaderWorkspaceSwitcherModal_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModal"
	| "MainAppHeaderWorkspaceSwitcherModal-header-copy"
	| "MainAppHeaderWorkspaceSwitcherModal-body"
	| "MainAppHeaderWorkspaceSwitcherModal-summary"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-label"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-value"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-chevron"
	| "MainAppHeaderWorkspaceSwitcherModal-columns"
	| "MainAppHeaderWorkspaceSwitcherModal-footer";

type MainAppHeaderWorkspaceSwitcherModal_Props = {
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
	projectName: string;
	switchDisabled: boolean;
	workspaceItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[];
	workspaceName: string;
	onAfterCreateProject: (args: { projectName: string; workspaceName: string }) => void;
	onAfterCreateWorkspace: (args: { projectName: string; workspaceName: string }) => void;
	onCancel: () => void;
	onSwitch: () => void;
};

export const MainAppHeaderWorkspaceSwitcherModal = memo(function MainAppHeaderWorkspaceSwitcherModal(
	props: MainAppHeaderWorkspaceSwitcherModal_Props,
) {
	const {
		createProject,
		createWorkspace,
		listLoaded,
		draftProjectId,
		draftWorkspaceId,
		projectItems,
		projectName,
		switchDisabled,
		workspaceItems,
		workspaceName,
		onAfterCreateProject,
		onAfterCreateWorkspace,
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
						<MyModalDescription>
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
							{listLoaded ? workspaceName : "…"}
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
							{listLoaded ? projectName : "…"}
						</span>
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModal-columns" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
						)}
					>
						<MainAppHeaderWorkspaceSwitcherModalSelectPane
							icon={<Folder />}
							title="Workspaces"
							items={workspaceItems}
							selectedItemId={draftWorkspaceId}
							onCreate={() => openCreateDialog("workspace")}
						/>

						<MainAppHeaderWorkspaceSwitcherModalSelectPane
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
			</MyModalPopover>
		</>
	);
});
// #endregion root
