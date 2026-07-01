import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQueries, useQuery } from "convex/react";
import { Crown, LogOut, Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl, MyInputLabel } from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalTrigger,
} from "@/components/my-modal.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectItemIndicator,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { compute_fallback_user_name } from "@/lib/utils.ts";

// #region user list item
type RouteUsersUserListItem_ClassNames =
	| "RouteUsersUserListItem"
	| "RouteUsersUserListItem-avatar"
	| "RouteUsersUserListItem-main"
	| "RouteUsersUserListItem-title"
	| "RouteUsersUserListItem-name"
	| "RouteUsersUserListItem-actions"
	| "RouteUsersUserListItem-remove-trigger";

type RouteUsersUserListItem_Props = {
	userId: app_convex_Id<"users">;
	authUserId: app_convex_Id<"users"> | null;
	displayName: string;
	role: NonNullable<
		app_convex_FunctionReturnType<typeof app_convex_api.access_control.get_organization_workspace_user_role>
	>;
	canManageMembers: boolean;
	canLeaveOrganization: boolean;
	canTransferOwnership: boolean;
	onRemove: (userId: app_convex_Id<"users">) => void;
	onTransfer: (userId: app_convex_Id<"users">, displayName: string) => void;
};

const RouteUsersUserListItem = memo(function RouteUsersUserListItem(props: RouteUsersUserListItem_Props) {
	const {
		userId,
		authUserId,
		displayName,
		role,
		canManageMembers,
		canLeaveOrganization,
		canTransferOwnership,
		onRemove,
		onTransfer,
	} = props;

	const isCurrentUser = userId === authUserId;
	const removeLabel = isCurrentUser ? "Leave" : "Remove";
	const removeDisabled = role === "owner" || (isCurrentUser ? !canLeaveOrganization : !canManageMembers);
	const removeDisabledTooltip =
		isCurrentUser && role === "owner"
			? "Before leaving this organization, transfer ownership to another member."
			: !isCurrentUser && !canManageMembers
				? "You don't have permission to remove users from the organization."
				: null;
	const removeButton = (
		<MyButton variant="ghost_destructive" disabled={removeDisabled} onClick={() => onRemove(userId)}>
			{isCurrentUser ? <LogOut aria-hidden /> : <Trash2 aria-hidden />}
			{removeLabel}
		</MyButton>
	);

	return (
		<div className={"RouteUsersUserListItem" satisfies RouteUsersUserListItem_ClassNames}>
			<MyAvatar size="40px" className={"RouteUsersUserListItem-avatar" satisfies RouteUsersUserListItem_ClassNames}>
				<MyAvatarImage alt={displayName} fallbackDelay={false} />
				<MyAvatarFallback>{compute_fallback_user_name(displayName)}</MyAvatarFallback>
			</MyAvatar>

			<div className={"RouteUsersUserListItem-main" satisfies RouteUsersUserListItem_ClassNames}>
				<div className={"RouteUsersUserListItem-title" satisfies RouteUsersUserListItem_ClassNames}>
					<span className={"RouteUsersUserListItem-name" satisfies RouteUsersUserListItem_ClassNames}>
						{displayName}
					</span>
					<MyBadge variant={role === "owner" ? "secondary" : "outline"}>
						{role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member"}
					</MyBadge>
				</div>
			</div>

			<div className={"RouteUsersUserListItem-actions" satisfies RouteUsersUserListItem_ClassNames}>
				{canTransferOwnership ? (
					<MyButton variant="outline" onClick={() => onTransfer(userId, displayName)}>
						<Crown aria-hidden />
						Transfer ownership
					</MyButton>
				) : null}
				{removeDisabledTooltip ? (
					<MyTooltip placement="bottom">
						<MyTooltipTrigger>
							<span className={"RouteUsersUserListItem-remove-trigger" satisfies RouteUsersUserListItem_ClassNames}>
								{removeButton}
							</span>
						</MyTooltipTrigger>
						<MyTooltipContent unmountOnHide>
							<>{removeDisabledTooltip}</>
						</MyTooltipContent>
					</MyTooltip>
				) : (
					removeButton
				)}
			</div>
		</div>
	);
});
// #endregion user list item

// #region user list
type RouteUsersList_Props = {
	workspaceUserIds: app_convex_Id<"users">[];
	userAnagraphicDict: Record<
		app_convex_Id<"users">,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error
	>;
	userRoleDict: Record<
		app_convex_Id<"users">,
		| app_convex_FunctionReturnType<typeof app_convex_api.access_control.get_organization_workspace_user_role>
		| undefined
		| Error
	>;
	authUserId: app_convex_Id<"users"> | null;
	canManageMembers: boolean;
	canLeaveOrganization: boolean;
	canTransferOwnership: boolean;
	onRemove: (userId: app_convex_Id<"users">) => void;
	onTransfer: (userId: app_convex_Id<"users">, displayName: string) => void;
};

const RouteUsersList = memo(function RouteUsersList(props: RouteUsersList_Props) {
	const {
		workspaceUserIds,
		userAnagraphicDict,
		userRoleDict,
		authUserId,
		canManageMembers,
		canLeaveOrganization,
		canTransferOwnership,
		onRemove,
		onTransfer,
	} = props;

	const userRowsLoading = workspaceUserIds.some((userId) => {
		const anagraphic = userAnagraphicDict[userId];

		return anagraphic === undefined;
	});
	if (userRowsLoading) {
		return (
			<div className={"RouteUsers-loading" satisfies RouteUsers_ClassNames}>
				<UsersIcon aria-hidden />
				Loading users...
			</div>
		);
	}

	const userRowsUnavailable = workspaceUserIds.some((userId) => {
		const anagraphic = userAnagraphicDict[userId];

		return anagraphic === null || anagraphic instanceof Error;
	});
	if (userRowsUnavailable) {
		return <div className={"RouteUsers-empty" satisfies RouteUsers_ClassNames}>Organization users unavailable.</div>;
	}

	const sortedWorkspaceUserIds = workspaceUserIds.toSorted((a, b) => {
		const aRoleDictValue = userRoleDict[a];
		const aRole =
			aRoleDictValue === undefined || aRoleDictValue === null || aRoleDictValue instanceof Error
				? "member"
				: aRoleDictValue;
		const bRoleDictValue = userRoleDict[b];
		const bRole =
			bRoleDictValue === undefined || bRoleDictValue === null || bRoleDictValue instanceof Error
				? "member"
				: bRoleDictValue;

		if (aRole !== bRole) {
			const aRoleOrder = aRole === "owner" ? 0 : aRole === "admin" ? 1 : 2;
			const bRoleOrder = bRole === "owner" ? 0 : bRole === "admin" ? 1 : 2;
			return aRoleOrder - bRoleOrder;
		}

		const aAnagraphic = userAnagraphicDict[a];
		const bAnagraphic = userAnagraphicDict[b];
		const aDisplayName =
			aAnagraphic === undefined || aAnagraphic === null || aAnagraphic instanceof Error ? "" : aAnagraphic.displayName;
		const bDisplayName =
			bAnagraphic === undefined || bAnagraphic === null || bAnagraphic instanceof Error ? "" : bAnagraphic.displayName;

		return aDisplayName.localeCompare(bDisplayName);
	});

	return (
		<div className={"RouteUsers-list" satisfies RouteUsers_ClassNames}>
			{sortedWorkspaceUserIds.map((userId) => {
				const anagraphic = userAnagraphicDict[userId];
				if (anagraphic === undefined || anagraphic === null || anagraphic instanceof Error) {
					return null;
				}

				const roleDictValue = userRoleDict[userId];
				const role =
					roleDictValue === undefined || roleDictValue === null || roleDictValue instanceof Error
						? "member"
						: roleDictValue;

				return (
					<RouteUsersUserListItem
						key={userId}
						userId={userId}
						authUserId={authUserId}
						displayName={anagraphic.displayName}
						role={role}
						canManageMembers={canManageMembers}
						canLeaveOrganization={canLeaveOrganization}
						canTransferOwnership={canTransferOwnership && role !== "owner"}
						onRemove={onRemove}
						onTransfer={onTransfer}
					/>
				);
			})}
		</div>
	);
});
// #endregion user list

// #region invite modal
type RouteUsersInviteModal_ClassNames =
	| "RouteUsersInviteModal"
	| "RouteUsersInviteModal-trigger"
	| "RouteUsersInviteModal-form"
	| "RouteUsersInviteModal-workspace-trigger"
	| "RouteUsersInviteModal-actions";

type RouteUsersInviteModal_Props = {
	workspaces: app_convex_FunctionReturnType<
		typeof app_convex_api.organizations.list
	>["organizationIdsWorkspacesDict"][app_convex_Id<"organizations">];
	inviteButtonDisabled: boolean;
	inviteButtonDisabledTooltip: string | null;
	inviteModalOpen: boolean;
	inviteEmail: string;
	inviteWorkspaceId: app_convex_Id<"organizations_workspaces">;
	invitedWorkspace?: app_convex_FunctionReturnType<
		typeof app_convex_api.organizations.list
	>["organizationIdsWorkspacesDict"][app_convex_Id<"organizations">][number];
	inviting: boolean;
	onInviteModalOpenChange: (open: boolean) => void;
	onInviteEmailChange: (email: string) => void;
	onInviteWorkspaceIdChange: (workspaceId: app_convex_Id<"organizations_workspaces">) => void;
	onInvite: () => void;
};

const RouteUsersInviteModal = memo(function RouteUsersInviteModal(props: RouteUsersInviteModal_Props) {
	const {
		workspaces,
		inviteButtonDisabled,
		inviteButtonDisabledTooltip,
		inviteModalOpen,
		inviteEmail,
		inviteWorkspaceId,
		invitedWorkspace,
		inviting,
		onInviteModalOpenChange,
		onInviteEmailChange,
		onInviteWorkspaceIdChange,
		onInvite,
	} = props;

	const inviteButton = (
		<MyButton disabled={inviteButtonDisabled}>
			<UserPlus aria-hidden />
			Invite
		</MyButton>
	);

	return (
		<MyModal open={inviteModalOpen} setOpen={onInviteModalOpenChange}>
			{inviteButtonDisabled ? (
				inviteButtonDisabledTooltip ? (
					<MyTooltip placement="bottom">
						<MyTooltipTrigger>
							<span className={"RouteUsersInviteModal-trigger" satisfies RouteUsersInviteModal_ClassNames}>
								{inviteButton}
							</span>
						</MyTooltipTrigger>
						<MyTooltipContent unmountOnHide>
							<>{inviteButtonDisabledTooltip}</>
						</MyTooltipContent>
					</MyTooltip>
				) : (
					inviteButton
				)
			) : (
				<MyModalTrigger>{inviteButton}</MyModalTrigger>
			)}
			<MyModalPopover className={"RouteUsersInviteModal" satisfies RouteUsersInviteModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>Invite user</MyModalHeading>
					<MyModalDescription>Invite an existing user by exact email.</MyModalDescription>
				</MyModalHeader>

				<div className={"RouteUsersInviteModal-form" satisfies RouteUsersInviteModal_ClassNames}>
					<MyInput>
						<MyInputLabel>Email</MyInputLabel>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								type="email"
								value={inviteEmail}
								placeholder="name@example.com"
								disabled={inviting}
								onChange={(event) => onInviteEmailChange(event.currentTarget.value)}
							/>
						</MyInputArea>
						<MyInputBox />
					</MyInput>

					<MySelect
						value={inviteWorkspaceId}
						setValue={(value) => onInviteWorkspaceIdChange(value as app_convex_Id<"organizations_workspaces">)}
					>
						<MySelectTrigger>
							<MyButton
								type="button"
								variant="outline"
								className={"RouteUsersInviteModal-workspace-trigger" satisfies RouteUsersInviteModal_ClassNames}
							>
								<span>{invitedWorkspace?.name ?? "Select workspace"}</span>
								<MySelectOpenIndicator />
							</MyButton>
						</MySelectTrigger>
						<MySelectPopover sameWidth>
							<MySelectPopoverScrollableArea>
								<MySelectPopoverContent>
									{workspaces.map((workspace) => (
										<MySelectItem key={workspace._id} value={workspace._id}>
											{workspace.name}
											{inviteWorkspaceId === workspace._id ? <MySelectItemIndicator /> : null}
										</MySelectItem>
									))}
								</MySelectPopoverContent>
							</MySelectPopoverScrollableArea>
						</MySelectPopover>
					</MySelect>
				</div>

				<div className={"RouteUsersInviteModal-actions" satisfies RouteUsersInviteModal_ClassNames}>
					<MyButton variant="ghost" onClick={() => onInviteModalOpenChange(false)}>
						Cancel
					</MyButton>
					<MyButton disabled={!inviteEmail.trim() || inviting} onClick={onInvite}>
						{inviting ? "Inviting..." : "Invite"}
					</MyButton>
				</div>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion invite modal

// #region transfer modal
type RouteUsersTransferModal_ClassNames =
	| "RouteUsersTransferModal"
	| "RouteUsersTransferModal-form"
	| "RouteUsersTransferModal-actions";

type RouteUsersTransferModal_Props = {
	transferTargetDisplayName: string | null;
	transferConfirmation: string;
	transferring: boolean;
	onClose: () => void;
	onTransferConfirmationChange: (transferConfirmation: string) => void;
	onTransfer: () => void;
};

const RouteUsersTransferModal = memo(function RouteUsersTransferModal(props: RouteUsersTransferModal_Props) {
	const {
		transferTargetDisplayName,
		transferConfirmation,
		transferring,
		onClose,
		onTransferConfirmationChange,
		onTransfer,
	} = props;

	return (
		<MyModal open={transferTargetDisplayName !== null} setOpen={(open) => !open && onClose()}>
			<MyModalPopover className={"RouteUsersTransferModal" satisfies RouteUsersTransferModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>Transfer ownership</MyModalHeading>
					<MyModalDescription>
						Transfer organization ownership to {transferTargetDisplayName ?? "this user"}.
					</MyModalDescription>
				</MyModalHeader>

				<div className={"RouteUsersTransferModal-form" satisfies RouteUsersTransferModal_ClassNames}>
					<MyInput>
						<MyInputLabel>Confirmation</MyInputLabel>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								value={transferConfirmation}
								placeholder="TRANSFER"
								disabled={transferring}
								onChange={(event) => onTransferConfirmationChange(event.currentTarget.value)}
							/>
						</MyInputArea>
						<MyInputBox />
					</MyInput>
				</div>

				<div className={"RouteUsersTransferModal-actions" satisfies RouteUsersTransferModal_ClassNames}>
					<MyButton variant="ghost" onClick={onClose}>
						Cancel
					</MyButton>
					<MyButton
						variant="destructive"
						disabled={transferConfirmation !== "TRANSFER" || transferring}
						onClick={onTransfer}
					>
						{transferring ? "Transferring..." : "Transfer ownership"}
					</MyButton>
				</div>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion transfer modal

// #region header
type RouteUsersHeader_ClassNames =
	| "RouteUsersHeader"
	| "RouteUsersHeader-title"
	| "RouteUsersHeader-description"
	| "RouteUsersHeader-toolbar";

type RouteUsersHeader_Props = {
	description: string;
	toolbar: ReactNode;
};

const RouteUsersHeader = memo(function RouteUsersHeader(props: RouteUsersHeader_Props) {
	const { description, toolbar } = props;

	return (
		<header className={"RouteUsersHeader" satisfies RouteUsersHeader_ClassNames}>
			<div>
				<h1 className={"RouteUsersHeader-title" satisfies RouteUsersHeader_ClassNames}>Users</h1>
				<p className={"RouteUsersHeader-description" satisfies RouteUsersHeader_ClassNames}>{description}</p>
			</div>

			<div className={"RouteUsersHeader-toolbar" satisfies RouteUsersHeader_ClassNames}>{toolbar}</div>
		</header>
	);
});
// #endregion header

// #region root
type RouteUsers_ClassNames = "RouteUsers" | "RouteUsers-loading" | "RouteUsers-empty" | "RouteUsers-list";

function RouteUsers() {
	const { organizationId, workspaceId } = AppTenantProvider.useContext();

	const auth = AppAuthProvider.useAuth();

	const organizationList = useQuery(app_convex_api.organizations.list);
	const organization = organizationList?.organizations.find((organization) => organization._id === organizationId);
	const workspaces = organizationList?.organizationIdsWorkspacesDict[organizationId] ?? [];
	const defaultWorkspace = organization?.defaultWorkspaceId
		? workspaces.find((workspace) => workspace._id === organization.defaultWorkspaceId)
		: workspaces.find((workspace) => workspace.default);
	const currentWorkspace = workspaces.find((workspace) => workspace._id === workspaceId);
	const workspaceUserIds = useQuery(app_convex_api.organizations.list_organization_workspace_users, { organizationId, workspaceId });
	const currentOrganizationRole = useQuery(
		app_convex_api.access_control.get_current_user_role,
		defaultWorkspace ? { organizationId, workspaceId: defaultWorkspace._id } : "skip",
	);

	const canInviteOrganizationMembers = useQuery(
		app_convex_api.access_control.get_current_user_organization_permission,
		auth.userId === null
			? "skip"
			: {
					organizationId,
					permission: "organization.members.manage",
				},
	);

	// The react compiler is unable to memoize code that uses the returned value from a hook
	const userAnagraphicQueryProps = useMemo(
		() =>
			Object.fromEntries(
				(workspaceUserIds ?? []).map(
					(userId) =>
						[
							userId,
							{
								query: app_convex_api.users.get_anagraphic,
								args: { userId },
							},
						] as const,
				),
			),
		[workspaceUserIds],
	);

	const userAnagraphicQueryResults = useQueries(userAnagraphicQueryProps) as Record<
		app_convex_Id<"users">,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error
	>;

	// The react compiler is unable to memoize code that uses the returned value from a hook
	const userRoleQueryProps = useMemo(
		() =>
			Object.fromEntries(
				(workspaceUserIds ?? []).map(
					(userId) =>
						[
							userId,
							{
								query: app_convex_api.access_control.get_organization_workspace_user_role,
								args: { organizationId, workspaceId, userId },
							},
						] as const,
				),
			),
		[workspaceUserIds, organizationId, workspaceId],
	);

	const userRoleQueryResults = useQueries(userRoleQueryProps) as Record<
		app_convex_Id<"users">,
		| app_convex_FunctionReturnType<typeof app_convex_api.access_control.get_organization_workspace_user_role>
		| undefined
		| Error
	>;

	const [inviteModalOpen, setInviteModalOpen] = useState(false);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteWorkspaceId, setInviteWorkspaceId] = useState<app_convex_Id<"organizations_workspaces">>(workspaceId);
	const [inviting, setInviting] = useState(false);
	const [transferTarget, setTransferTarget] = useState<{
		userId: app_convex_Id<"users">;
		displayName: string;
	} | null>(null);
	const [transferConfirmation, setTransferConfirmation] = useState("");
	const [transferring, setTransferring] = useState(false);

	const organizationIsPersonal = organization?.default === true;
	const canManageMembers =
		!organizationIsPersonal && (currentOrganizationRole === "owner" || currentOrganizationRole === "admin");
	const inviteButtonDisabled = organizationIsPersonal || canInviteOrganizationMembers !== true;
	const inviteButtonDisabledTooltip =
		!organizationIsPersonal && canInviteOrganizationMembers === false
			? "You don't have permission to invite people to this organization."
			: null;
	const canLeaveOrganization =
		!organizationIsPersonal && (currentOrganizationRole === "admin" || currentOrganizationRole === "member");
	const canTransferOwnership =
		defaultWorkspace?._id === workspaceId && currentOrganizationRole === "owner" && !organizationIsPersonal;
	const invitedWorkspace = workspaces.find((workspace) => workspace._id === inviteWorkspaceId);

	const handleInvite = useFn(() => {
		if (!organization || !invitedWorkspace || !inviteEmail.trim()) {
			return;
		}

		setInviting(true);
		app_convex
			.mutation(app_convex_api.organizations.invite_user_to_organization_workspace, {
				organizationId,
				workspaceId: inviteWorkspaceId,
				email: inviteEmail,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[RouteUsers.handleInvite] Failed to invite user:", {
						error: result._nay,
						organizationId,
						inviteWorkspaceId,
						email: inviteEmail,
					});
					toast.error("Failed to invite user");
					return;
				}

				toast.success("User invited");
				setInviteEmail("");
				setInviteModalOpen(false);
			})
			.catch((error) => {
				console.error("[RouteUsers.handleInvite] Failed to invite user:", {
					error,
					organizationId,
					inviteWorkspaceId,
				});
				toast.error("Failed to invite user");
			})
			.finally(() => {
				setInviting(false);
			});
	});

	const handleRemove = useFn((userIdToRemove: app_convex_Id<"users">) => {
		const isLeaving = userIdToRemove === auth.userId;
		const failureMessage = isLeaving ? "Failed to leave organization" : "Failed to remove user";

		app_convex
			.mutation(app_convex_api.organizations.remove_user_from_organization, {
				organizationId,
				userIdToRemove,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[RouteUsers.handleRemove] Failed to update organization membership:", {
						error: result._nay,
						organizationId,
						userIdToRemove,
					});
					toast.error(failureMessage);
					return;
				}

				toast.success(isLeaving ? "Left organization" : "User removed");
			})
			.catch((error) => {
				console.error("[RouteUsers.handleRemove] Failed to update organization membership:", {
					error,
					organizationId,
					userIdToRemove,
				});
				toast.error(failureMessage);
			});
	});

	const handleTransferTarget = useFn((userId: app_convex_Id<"users">, displayName: string) => {
		setTransferTarget({ userId, displayName });
	});

	const handleCloseTransferModal = useFn(() => {
		setTransferTarget(null);
	});

	const handleTransfer = useFn(() => {
		if (!transferTarget || transferConfirmation !== "TRANSFER") {
			return;
		}

		const newOwnerUserId = transferTarget.userId;

		setTransferring(true);
		app_convex
			.mutation(app_convex_api.access_control.transfer_organization_ownership, {
				organizationId,
				newOwnerUserId,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[RouteUsers.handleTransfer] Failed to transfer ownership:", {
						error: result._nay,
						organizationId,
						newOwnerUserId,
					});
					toast.error("Failed to transfer ownership");
					return;
				}

				toast.success("Ownership transferred");
				setTransferTarget(null);
			})
			.catch((error) => {
				console.error("[RouteUsers.handleTransfer] Failed to transfer ownership:", {
					error,
					organizationId,
					newOwnerUserId,
				});
				toast.error("Failed to transfer ownership");
			})
			.finally(() => {
				setTransferring(false);
			});
	});

	useEffect(() => {
		if (inviteModalOpen) {
			setInviteWorkspaceId(workspaceId);
		}
	}, [inviteModalOpen, workspaceId]);

	useEffect(() => {
		if (!transferTarget) {
			setTransferConfirmation("");
		}
	}, [transferTarget]);

	return organizationList === undefined || auth.userId === null ? (
		<div className={"RouteUsers-loading" satisfies RouteUsers_ClassNames}>
			<UsersIcon aria-hidden />
			Loading users...
		</div>
	) : !organization || !defaultWorkspace || !currentWorkspace || workspaceUserIds === null ? (
		<div className={"RouteUsers-empty" satisfies RouteUsers_ClassNames}>Organization users unavailable.</div>
	) : workspaceUserIds === undefined ? (
		<div className={"RouteUsers-loading" satisfies RouteUsers_ClassNames}>
			<UsersIcon aria-hidden />
			Loading users...
		</div>
	) : (
		<div className={"RouteUsers" satisfies RouteUsers_ClassNames}>
			<RouteUsersHeader
				description={
					defaultWorkspace._id === workspaceId
						? organization.default
							? "Personal organization membership"
							: `${organization.name} organization membership`
						: `${currentWorkspace.name} workspace membership`
				}
				toolbar={
					<RouteUsersInviteModal
						workspaces={workspaces}
						inviteButtonDisabled={inviteButtonDisabled}
						inviteButtonDisabledTooltip={inviteButtonDisabledTooltip}
						inviteModalOpen={inviteModalOpen}
						inviteEmail={inviteEmail}
						inviteWorkspaceId={inviteWorkspaceId}
						invitedWorkspace={invitedWorkspace}
						inviting={inviting}
						onInviteModalOpenChange={setInviteModalOpen}
						onInviteEmailChange={setInviteEmail}
						onInviteWorkspaceIdChange={setInviteWorkspaceId}
						onInvite={handleInvite}
					/>
				}
			/>

			<RouteUsersList
				workspaceUserIds={workspaceUserIds}
				userAnagraphicDict={userAnagraphicQueryResults}
				userRoleDict={userRoleQueryResults}
				authUserId={auth.userId}
				canManageMembers={canManageMembers}
				canLeaveOrganization={canLeaveOrganization}
				canTransferOwnership={canTransferOwnership}
				onRemove={handleRemove}
				onTransfer={handleTransferTarget}
			/>

			<RouteUsersTransferModal
				transferTargetDisplayName={transferTarget?.displayName ?? null}
				transferConfirmation={transferConfirmation}
				transferring={transferring}
				onClose={handleCloseTransferModal}
				onTransferConfirmationChange={setTransferConfirmation}
				onTransfer={handleTransfer}
			/>
		</div>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/users/")({
	component: RouteUsers,
});

export { Route };
// #endregion root
