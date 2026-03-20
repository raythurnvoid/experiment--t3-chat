import "./main-app-header.css";

import { memo, useState, type ComponentPropsWithRef } from "react";
import { ChevronsUpDown } from "lucide-react";

import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
	MyModalTrigger,
} from "@/components/my-modal.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

// #region workspace controls
type MainAppHeaderWorkspaceControls_ClassNames =
	| "MainAppHeaderWorkspaceControls"
	| "MainAppHeaderWorkspaceControls-button"
	| "MainAppHeaderWorkspaceControls-text"
	| "MainAppHeaderWorkspaceControls-primary-text"
	| "MainAppHeaderWorkspaceControls-secondary-text"
	| "MainAppHeaderWorkspaceControls-icon";

type MainAppHeaderWorkspaceControls_ListItem = {
	description: string;
	isCurrent?: boolean;
	label: string;
};

const mock_workspace_record = {
	projectName: "Launchpad",
	workspaceName: "Northstar Studio",
};

const mock_workspace_items: MainAppHeaderWorkspaceControls_ListItem[] = [
	{
		isCurrent: true,
		label: "Northstar Studio",
		description: "Product design, engineering, and ops",
	},
	{
		label: "Acme Client Services",
		description: "External partner workspace",
	},
	{
		label: "Internal R&D",
		description: "Experiments and incubation work",
	},
];

const mock_project_items: MainAppHeaderWorkspaceControls_ListItem[] = [
	{
		isCurrent: true,
		label: "Launchpad",
		description: "Default product surface for the current tenant",
	},
	{
		label: "Growth Site",
		description: "Marketing pages and onboarding flows",
	},
	{
		label: "Admin Console",
		description: "Permissions, billing, and workspace settings",
	},
];

type MainAppHeaderWorkspaceControls_Props = ComponentPropsWithRef<"div">;

const MainAppHeaderWorkspaceControls = memo(function MainAppHeaderWorkspaceControls(
	props: MainAppHeaderWorkspaceControls_Props,
) {
	const { ref, id, className, ...rest } = props;
	const [isOpen, setIsOpen] = useState(false);

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MainAppHeaderWorkspaceControls" satisfies MainAppHeaderWorkspaceControls_ClassNames, className)}
			{...rest}
		>
			<MyModal open={isOpen} setOpen={setIsOpen}>
				<MyModalTrigger>
					<button
						type="button"
						className={cn("MainAppHeaderWorkspaceControls-button" satisfies MainAppHeaderWorkspaceControls_ClassNames)}
					>
						<span
							className={cn("MainAppHeaderWorkspaceControls-text" satisfies MainAppHeaderWorkspaceControls_ClassNames)}
						>
							<span
								className={cn(
									"MainAppHeaderWorkspaceControls-primary-text" satisfies MainAppHeaderWorkspaceControls_ClassNames,
								)}
							>
								{mock_workspace_record.workspaceName}
							</span>

							<span
								className={cn(
									"MainAppHeaderWorkspaceControls-secondary-text" satisfies MainAppHeaderWorkspaceControls_ClassNames,
								)}
							>
								{mock_workspace_record.projectName}
							</span>
						</span>

						<ChevronsUpDown
							className={cn("MainAppHeaderWorkspaceControls-icon" satisfies MainAppHeaderWorkspaceControls_ClassNames)}
						/>
					</button>
				</MyModalTrigger>

				<MainAppHeaderWorkspaceControlsModal
					projectItems={mock_project_items}
					projectName={mock_workspace_record.projectName}
					workspaceItems={mock_workspace_items}
					workspaceName={mock_workspace_record.workspaceName}
				/>
			</MyModal>
		</div>
	);
});
// #endregion workspace controls

// #region workspace controls modal
type MainAppHeaderWorkspaceControlsModal_ClassNames =
	| "MainAppHeaderWorkspaceControlsModal"
	| "MainAppHeaderWorkspaceControlsModal-header-copy"
	| "MainAppHeaderWorkspaceControlsModal-body"
	| "MainAppHeaderWorkspaceControlsModal-section"
	| "MainAppHeaderWorkspaceControlsModal-section-title"
	| "MainAppHeaderWorkspaceControlsModal-current-selection"
	| "MainAppHeaderWorkspaceControlsModal-current-selection-label"
	| "MainAppHeaderWorkspaceControlsModal-current-selection-workspace"
	| "MainAppHeaderWorkspaceControlsModal-current-selection-project"
	| "MainAppHeaderWorkspaceControlsModal-list"
	| "MainAppHeaderWorkspaceControlsModal-list-item"
	| "MainAppHeaderWorkspaceControlsModal-list-item-current"
	| "MainAppHeaderWorkspaceControlsModal-list-item-label"
	| "MainAppHeaderWorkspaceControlsModal-list-item-description";

type MainAppHeaderWorkspaceControlsModal_Props = {
	projectItems: MainAppHeaderWorkspaceControls_ListItem[];
	projectName: string;
	workspaceItems: MainAppHeaderWorkspaceControls_ListItem[];
	workspaceName: string;
};

const MainAppHeaderWorkspaceControlsModal = memo(function MainAppHeaderWorkspaceControlsModal(
	props: MainAppHeaderWorkspaceControlsModal_Props,
) {
	const { projectItems, projectName, workspaceItems, workspaceName } = props;

	return (
		<MyModalPopover className={cn("MainAppHeaderWorkspaceControlsModal" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}>
			<MyModalHeader>
				<div
					className={cn(
						"MainAppHeaderWorkspaceControlsModal-header-copy" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
					)}
				>
					<MyModalHeading>Workspace and project</MyModalHeading>
					<MyModalDescription>Use mocked tenant data here until the real switcher is wired up.</MyModalDescription>
				</div>
			</MyModalHeader>

			<MyModalScrollableArea
				className={cn("MainAppHeaderWorkspaceControlsModal-body" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}
			>
				<section
					className={cn("MainAppHeaderWorkspaceControlsModal-section" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-section-title" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						Current selection
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-current-selection" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							Workspace
						</div>

						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-workspace" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							{workspaceName}
						</div>

						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							Project
						</div>

						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-project" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							{projectName}
						</div>
					</div>
				</section>

				<section
					className={cn("MainAppHeaderWorkspaceControlsModal-section" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-section-title" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						Mock workspaces
					</div>

					<div className={cn("MainAppHeaderWorkspaceControlsModal-list" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}>
						{workspaceItems.map((item) => (
							<div
								key={item.label}
								className={cn(
									"MainAppHeaderWorkspaceControlsModal-list-item" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									item.isCurrent &&
										("MainAppHeaderWorkspaceControlsModal-list-item-current" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames),
								)}
							>
								<div
									className={cn(
										"MainAppHeaderWorkspaceControlsModal-list-item-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									)}
								>
									{item.label}
								</div>

								<div
									className={cn(
										"MainAppHeaderWorkspaceControlsModal-list-item-description" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									)}
								>
									{item.description}
								</div>
							</div>
						))}
					</div>
				</section>

				<section
					className={cn("MainAppHeaderWorkspaceControlsModal-section" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-section-title" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						Mock projects
					</div>

					<div className={cn("MainAppHeaderWorkspaceControlsModal-list" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}>
						{projectItems.map((item) => (
							<div
								key={item.label}
								className={cn(
									"MainAppHeaderWorkspaceControlsModal-list-item" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									item.isCurrent &&
										("MainAppHeaderWorkspaceControlsModal-list-item-current" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames),
								)}
							>
								<div
									className={cn(
										"MainAppHeaderWorkspaceControlsModal-list-item-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									)}
								>
									{item.label}
								</div>

								<div
									className={cn(
										"MainAppHeaderWorkspaceControlsModal-list-item-description" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									)}
								>
									{item.description}
								</div>
							</div>
						))}
					</div>
				</section>
			</MyModalScrollableArea>

			<MyModalCloseTrigger />
		</MyModalPopover>
	);
});
// #endregion workspace controls modal

// #region root
type MainAppHeader_ClassNames = "MainAppHeader" | "MainAppHeader-content";

export type MainAppHeader_Props = ComponentPropsWithRef<"header">;

export const MainAppHeader = memo(function MainAppHeader(props: MainAppHeader_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<header ref={ref} id={id} className={cn("MainAppHeader" satisfies MainAppHeader_ClassNames, className)} {...rest}>
			<MainAppHeaderWorkspaceControls />
			<div
				id={"app_main_header_content" satisfies AppElementId}
				className={cn("MainAppHeader-content" satisfies MainAppHeader_ClassNames)}
			>
				{/* The pages inject content here */}
			</div>
		</header>
	);
});
// #endregion root
