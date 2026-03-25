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
	type FormEventHandler,
} from "react";
import { ChevronRight, Folder, FolderKanban, Plus } from "lucide-react";

import { MyButton } from "@/components/my-button.tsx";
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
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { workspaces_name_autofix, workspaces_name_validate } from "@/lib/workspaces-name.ts";
import { cn } from "@/lib/utils.ts";

// #region list item
export type MainAppHeaderWorkspaceSwitcherModal_ListItem = {
	description: string;
	id: string;
	isCurrent?: boolean;
	label: string;
	onSelect: () => void;
};
// #endregion list item

// #region create args / results
type MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs = FunctionArgs<typeof app_convex_api.workspaces.create_project>;

type MainAppHeaderWorkspaceSwitcherModal_CreateWorkspaceResult = FunctionReturnType<typeof app_convex_api.workspaces.create_workspace>;
type MainAppHeaderWorkspaceSwitcherModal_CreateProjectResult = FunctionReturnType<typeof app_convex_api.workspaces.create_project>;
// #endregion create args / results

// #region modal
const main_app_header_workspace_switcher_modal_CREATE_NAME_HELPER_TEXT =
	"Lowercase letters and hyphens only (kebab-case).";

type MainAppHeaderWorkspaceSwitcherModal_ClassNames =
	| "MainAppHeaderWorkspaceSwitcherModal"
	| "MainAppHeaderWorkspaceSwitcherModal-header-copy"
	| "MainAppHeaderWorkspaceSwitcherModal-body"
	| "MainAppHeaderWorkspaceSwitcherModal-summary"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-label"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-value"
	| "MainAppHeaderWorkspaceSwitcherModal-summary-chevron"
	| "MainAppHeaderWorkspaceSwitcherModal-columns"
	| "MainAppHeaderWorkspaceSwitcherModal-column"
	| "MainAppHeaderWorkspaceSwitcherModal-section-head"
	| "MainAppHeaderWorkspaceSwitcherModal-section-head-start"
	| "MainAppHeaderWorkspaceSwitcherModal-section-head-actions"
	| "MainAppHeaderWorkspaceSwitcherModal-section-icon"
	| "MainAppHeaderWorkspaceSwitcherModal-section-title"
	| "MainAppHeaderWorkspaceSwitcherModal-empty-hint"
	| "MainAppHeaderWorkspaceSwitcherModal-list"
	| "MainAppHeaderWorkspaceSwitcherModal-list-item"
	| "MainAppHeaderWorkspaceSwitcherModal-list-item-current"
	| "MainAppHeaderWorkspaceSwitcherModal-list-item-label"
	| "MainAppHeaderWorkspaceSwitcherModal-list-item-description"
	| "MainAppHeaderWorkspaceSwitcherModal-sub"
	| "MainAppHeaderWorkspaceSwitcherModal-sub-body"
	| "MainAppHeaderWorkspaceSwitcherModal-sub-form"
	| "MainAppHeaderWorkspaceSwitcherModal-create-form"
	| "MainAppHeaderWorkspaceSwitcherModal-sub-helper-state-error";

type MainAppHeaderWorkspaceSwitcherModal_Props = {
	createProject: (
		args: MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs,
	) => Promise<MainAppHeaderWorkspaceSwitcherModal_CreateProjectResult | undefined>;
	createWorkspace: (args: FunctionArgs<typeof app_convex_api.workspaces.create_workspace>) => Promise<
		MainAppHeaderWorkspaceSwitcherModal_CreateWorkspaceResult | undefined
	>;
	listLoaded: boolean;
	projectItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[];
	projectName: string;
	workspaceId: MainAppHeaderWorkspaceSwitcherModal_CreateProjectArgs["workspaceId"];
	workspaceItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[];
	workspaceName: string;
	onAfterCreateProject: (args: { projectName: string; workspaceName: string }) => void;
	onAfterCreateWorkspace: (args: { projectName: string; workspaceName: string }) => void;
};

export const MainAppHeaderWorkspaceSwitcherModal = memo(function MainAppHeaderWorkspaceSwitcherModal(
	props: MainAppHeaderWorkspaceSwitcherModal_Props,
) {
	const {
		createProject,
		createWorkspace,
		listLoaded,
		projectItems,
		projectName,
		workspaceId,
		workspaceItems,
		workspaceName,
		onAfterCreateProject,
		onAfterCreateWorkspace,
	} = props;

	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createDialogKind, setCreateDialogKind] = useState<"project" | "workspace">("workspace");

	const MainAppHeaderWorkspaceSwitcherModal_createFormDomId = `MainAppHeaderWorkspaceSwitcherModal-create-form-${useId().replace(/:/g, "")}`;

	const createDialogNameInputRef = useRef<HTMLInputElement>(null);
	const createNameSubmitFailuresRef = useRef<Set<string>>(new Set());
	const [isCreateNameValid, setIsCreateNameValid] = useState(false);
	const [createNameSubmitMessage, setCreateNameSubmitMessage] = useState<string | undefined>(undefined);
	const [isCreateSubmitting, setIsCreateSubmitting] = useState(false);

	const sync_create_dialog_name_value_for_submit = (el: HTMLInputElement) => {
		const normalized = workspaces_name_autofix(el.value);
		if (el.value !== normalized) {
			el.value = normalized;
		}

		const validated = workspaces_name_validate(normalized);
		const blockedByFailedRetry = createNameSubmitFailuresRef.current.has(normalized);

		setIsCreateNameValid(!validated._nay && !blockedByFailedRetry);
	};

	const apply_create_dialog_name_input_to_control = (el: HTMLInputElement) => {
		sync_create_dialog_name_value_for_submit(el);
		setCreateNameSubmitMessage(undefined);
	};

	const openCreateDialog = (kind: "project" | "workspace") => {
		setCreateDialogKind(kind);
		createNameSubmitFailuresRef.current.clear();
		setCreateNameSubmitMessage(undefined);
		setCreateDialogOpen(true);
	};

	const handleCreateNameFormSubmit: FormEventHandler<HTMLFormElement> = (event) => {
		event.preventDefault();
		if (isCreateSubmitting) {
			return;
		}

		const el = createDialogNameInputRef.current;
		if (!el) {
			return;
		}

		sync_create_dialog_name_value_for_submit(el);
		const canonicalName = workspaces_name_autofix(el.value);
		el.value = canonicalName;
		const validated = workspaces_name_validate(canonicalName);
		if (validated._nay) {
			return;
		}

		const name = validated._yay;
		if (createNameSubmitFailuresRef.current.has(name)) {
			return;
		}

		void (async (/* iife */) => {
			setIsCreateSubmitting(true);
			setCreateNameSubmitMessage(undefined);

			if (createDialogKind === "workspace") {
				const result = await createWorkspace({ name });
				setIsCreateSubmitting(false);

				if (result == null) {
					return;
				}

				if (result._nay) {
					createNameSubmitFailuresRef.current.add(name);
					setIsCreateNameValid(false);
					setCreateNameSubmitMessage(result._nay.message);
					return;
				}

				setCreateDialogOpen(false);
				onAfterCreateWorkspace({
					workspaceName: result._yay.name,
					projectName: result._yay.defaultProjectName,
				});
				return;
			}

			const result = await createProject({ name, workspaceId });
			setIsCreateSubmitting(false);

			if (result == null) {
				return;
			}

			if (result._nay) {
				createNameSubmitFailuresRef.current.add(name);
				setIsCreateNameValid(false);
				setCreateNameSubmitMessage(result._nay.message);
				return;
			}

			setCreateDialogOpen(false);
			onAfterCreateProject({ workspaceName, projectName: result._yay.name });
		})().catch((error) => {
			setIsCreateSubmitting(false);
			console.error("[MainAppHeaderWorkspaceSwitcherModal] Unexpected create error", { error, kind: createDialogKind });
		});
	};

	const handleNewEntityNameInput: FormEventHandler<HTMLInputElement> = (event) => {
		const el = event.currentTarget;
		const native = event.nativeEvent;
		if ("isComposing" in native && (native as InputEvent).isComposing) {
			return;
		}

		// Covers insertFromPaste, insertFromDrop, insertText, and delete-*: el.value already includes the edit (onPaste uses preventDefault and normalizes without relying on this).
		apply_create_dialog_name_input_to_control(el);
	};

	const handleNewEntityNamePaste: ClipboardEventHandler<HTMLInputElement> = (event) => {
		const pasted = event.clipboardData.getData("text/plain");
		if (pasted === "") {
			return;
		}

		event.preventDefault();
		const el = event.currentTarget;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? el.value.length;
		el.value = el.value.slice(0, start) + pasted + el.value.slice(end);
		apply_create_dialog_name_input_to_control(el);

		queueMicrotask(() => {
			const pos = el.value.length;
			el.setSelectionRange(pos, pos);
		});
	};

	const handleNewEntityNameCompositionEnd: CompositionEventHandler<HTMLInputElement> = (event) => {
		apply_create_dialog_name_input_to_control(event.currentTarget);
	};

	useEffect(() => {
		if (!createDialogOpen) {
			return;
		}

		createNameSubmitFailuresRef.current.clear();
		setCreateNameSubmitMessage(undefined);

		const el = createDialogNameInputRef.current;
		if (el) {
			el.value = "";
		}

		setIsCreateNameValid(false);
	}, [createDialogOpen, createDialogKind]);

	const createDialogTitle = createDialogKind === "workspace" ? "Create workspace" : "Create project";
	const nameFieldLabel = createDialogKind === "workspace" ? "Workspace name" : "Project name";
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
						<MyModalHeading>Workspaces</MyModalHeading>
						<MyModalDescription>Switch workspace or project, or create a new one.</MyModalDescription>
					</div>
				</MyModalHeader>

				<MyModalScrollableArea
					className={cn("MainAppHeaderWorkspaceSwitcherModal-body" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames)}
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
						</span>
						<span
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-summary-value" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
						>
							{listLoaded ? workspaceName : "…"}
						</span>
						<ChevronRight
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-summary-chevron" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
							aria-hidden
							strokeWidth={2.25}
						/>
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
						<div
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-column" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
						>
							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModal-section-head" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
								)}
							>
								<div
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModal-section-head-start" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
									)}
								>
									<Folder
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModal-section-icon" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
										)}
										aria-hidden
									/>
									<div
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModal-section-title" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
										)}
									>
										Workspaces
									</div>
								</div>

								<div
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModal-section-head-actions" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
									)}
								>
									<MyButton type="button" variant="outline" onClick={() => openCreateDialog("workspace")}>
										<Plus aria-hidden />
										Create
									</MyButton>
								</div>
							</div>

							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModal-list" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
								)}
							>
								{workspaceItems.map((item) => (
									<button
										key={item.id}
										type="button"
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModal-list-item" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
											item.isCurrent &&
												("MainAppHeaderWorkspaceSwitcherModal-list-item-current" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames),
										)}
										onClick={item.onSelect}
									>
										<div
											className={cn(
												"MainAppHeaderWorkspaceSwitcherModal-list-item-label" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
											)}
										>
											{item.label}
										</div>

										{item.description ? (
											<div
												className={cn(
													"MainAppHeaderWorkspaceSwitcherModal-list-item-description" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
												)}
											>
												{item.description}
											</div>
										) : null}
									</button>
								))}
							</div>
						</div>

						<div
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-column" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
						>
							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModal-section-head" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
								)}
							>
								<div
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModal-section-head-start" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
									)}
								>
									<FolderKanban
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModal-section-icon" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
										)}
										aria-hidden
									/>
									<div
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModal-section-title" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
										)}
									>
										Projects
									</div>
								</div>

								<div
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModal-section-head-actions" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
									)}
								>
									<MyButton
										type="button"
										disabled={!canCreateProject}
										variant="outline"
										onClick={() => openCreateDialog("project")}
									>
										<Plus aria-hidden />
										Create
									</MyButton>
								</div>
							</div>

							{listLoaded && projectItems.length === 0 ? (
								<p
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModal-empty-hint" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
									)}
								>
									No projects in this workspace yet.
								</p>
							) : null}

							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModal-list" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
								)}
							>
								{projectItems.map((item) => (
									<button
										key={item.id}
										type="button"
										className={cn(
											"MainAppHeaderWorkspaceSwitcherModal-list-item" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
											item.isCurrent &&
												("MainAppHeaderWorkspaceSwitcherModal-list-item-current" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames),
										)}
										onClick={item.onSelect}
									>
										<div
											className={cn(
												"MainAppHeaderWorkspaceSwitcherModal-list-item-label" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
											)}
										>
											{item.label}
										</div>

										{item.description ? (
											<div
												className={cn(
													"MainAppHeaderWorkspaceSwitcherModal-list-item-description" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
												)}
											>
												{item.description}
											</div>
										) : null}
									</button>
								))}
							</div>
						</div>
					</div>
				</MyModalScrollableArea>

				<MyModalCloseTrigger />
				<MyModal open={createDialogOpen} setOpen={setCreateDialogOpen}>
					<MyModalPopover
						className={cn(
							"MainAppHeaderWorkspaceSwitcherModal-sub" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
						)}
					>
						<MyModalHeader>
							<div
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModal-header-copy" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
								)}
							>
								<MyModalHeading>{createDialogTitle}</MyModalHeading>
							</div>
						</MyModalHeader>

						<MyModalScrollableArea
							className={cn(
								"MainAppHeaderWorkspaceSwitcherModal-sub-body" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
							)}
						>
							<form
								id={MainAppHeaderWorkspaceSwitcherModal_createFormDomId}
								className={cn(
									"MainAppHeaderWorkspaceSwitcherModal-create-form" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
								)}
								noValidate
								onSubmit={handleCreateNameFormSubmit}
							>
								<div
									className={cn(
										"MainAppHeaderWorkspaceSwitcherModal-sub-form" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames,
									)}
								>
									<MyInput variant="surface">
										<MyInputLabel>{nameFieldLabel}</MyInputLabel>
										<MyInputArea>
											<MyInputBox />
											<MyInputControl
												ref={createDialogNameInputRef}
												type="text"
												autoComplete="off"
												defaultValue=""
												placeholder={createDialogKind === "workspace" ? "acme-labs" : "my-project"}
												aria-invalid={
													!isCreateNameValid &&
													Boolean(workspaces_name_autofix(createDialogNameInputRef.current?.value ?? "").length)
												}
												disabled={isCreateSubmitting}
												onCompositionEnd={handleNewEntityNameCompositionEnd}
												onInput={handleNewEntityNameInput}
												onPaste={handleNewEntityNamePaste}
											/>
										</MyInputArea>
										<MyInputHelperText
											className={cn(
												createNameSubmitMessage &&
													("MainAppHeaderWorkspaceSwitcherModal-sub-helper-state-error" satisfies MainAppHeaderWorkspaceSwitcherModal_ClassNames),
											)}
										>
											{createNameSubmitMessage ?? main_app_header_workspace_switcher_modal_CREATE_NAME_HELPER_TEXT}
										</MyInputHelperText>
									</MyInput>
								</div>
							</form>
						</MyModalScrollableArea>

						<MyModalFooter>
							<MyButton type="button" disabled={isCreateSubmitting} variant="outline" onClick={() => setCreateDialogOpen(false)}>
								Cancel
							</MyButton>
							<MyButton
								type="submit"
								form={MainAppHeaderWorkspaceSwitcherModal_createFormDomId}
								disabled={!isCreateNameValid || isCreateSubmitting}
								variant="accent"
							>
								{isCreateSubmitting ? "Creating…" : createDialogTitle}
							</MyButton>
						</MyModalFooter>

						<MyModalCloseTrigger />
					</MyModalPopover>
				</MyModal>
			</MyModalPopover>
		</>
	);
});
// #endregion modal
