import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQueries, useQuery } from "convex/react";
import { Crown, LogOut, Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
} from "@/components/my-input.tsx";
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
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn, compute_fallback_user_name } from "@/lib/utils.ts";
import { app_tenant_primary_workspace_for_organization } from "@/lib/urls.ts";
import {
	access_control_display_role_label,
	access_control_display_role_order,
	access_control_SYSTEM_ROLE_MATRIX,
	access_control_SYSTEM_ROLES,
	type access_control_DisplayRole,
	type access_control_Permission,
	type access_control_RoleRef,
} from "../../../../../../shared/access-control.ts";

// #region user list item
type RouteUsersUserListItem_ClassNames =
	| "RouteUsersUserListItem"
	| "RouteUsersUserListItem-avatar"
	| "RouteUsersUserListItem-main"
	| "RouteUsersUserListItem-title"
	| "RouteUsersUserListItem-name"
	| "RouteUsersUserListItem-email"
	| "RouteUsersUserListItem-role-select"
	| "RouteUsersUserListItem-actions";

/**
 * One entry of the role select. `value` is what `set_user_role` stores; the empty string is the
 * "no workspace role" entry, which sends `null` and leaves only the organization role.
 */
type RouteUsersAssignableRole = { value: string; label: string };

type RouteUsersUserListItem_Props = {
	userId: app_convex_Id<"users">;
	authUserId: app_convex_Id<"users"> | null;
	displayName: string;
	email: string;
	role: access_control_DisplayRole | null;
	assignableRoles: readonly RouteUsersAssignableRole[];
	/** `undefined` while the permission query is still loading. */
	canManageMembers: boolean | undefined;
	/** Whether the caller may change roles here. Wider than `canManageMembers`, see the root. */
	canChangeRoles: boolean;
	roleChangePending: boolean;
	canLeaveOrganization: boolean;
	organizationIsPersonal: boolean;
	canTransferOwnership: boolean;
	onRemove: (userId: app_convex_Id<"users">) => void;
	onRoleChange: (userId: app_convex_Id<"users">, role: access_control_RoleRef | null) => void;
	onTransfer: (userId: app_convex_Id<"users">, displayName: string) => void;
};

const RouteUsersUserListItem = memo(function RouteUsersUserListItem(props: RouteUsersUserListItem_Props) {
	const {
		userId,
		authUserId,
		displayName,
		email,
		role,
		assignableRoles,
		canManageMembers,
		canChangeRoles,
		roleChangePending,
		canLeaveOrganization,
		organizationIsPersonal,
		canTransferOwnership,
		onRemove,
		onRoleChange,
		onTransfer,
	} = props;

	const isCurrentUser = userId === authUserId;
	const isOwner = role?.kind === "owner";
	const removeLabel = isCurrentUser ? "Leave" : "Remove";
	const removeDisabled = isOwner || (isCurrentUser ? !canLeaveOrganization : canManageMembers !== true);
	// This follows `removeDisabled` case by case, so an enabled button can never show a reason that
	// says it is disabled. The `null` cases are the ones still loading: nothing is wrong yet, the
	// answer has simply not arrived, and saying "you don't have permission" before we know would be a
	// guess.
	const removeDisabledReason = !removeDisabled
		? null
		: isOwner
			? isCurrentUser
				? organizationIsPersonal
					? "Your personal organization is only yours, so there is nobody to leave it to."
					: "Before leaving this organization, transfer ownership to another member."
				: "The organization owner cannot be removed. Transfer ownership first."
			: isCurrentUser || canManageMembers !== false
				? null
				: "You don't have permission to remove users from the organization.";
	// Ariakit renders the tooltip in another place in the DOM, and the button never points at it:
	// `TooltipAnchor` only sets `aria-labelledby`, and only when the tooltip is used as a label instead
	// of a description. So we give the reason its own element and point the button at it with
	// `aria-describedby`. Without this a screen reader says "unavailable" and explains nothing.
	const removeReasonId = `RouteUsers-remove-reason-${userId}`;
	// We use `aria-disabled`, not `disabled`. A really disabled button cannot be hovered or focused, so
	// the tooltip would never open and Tab would skip the button. This way it stays focusable and just
	// ignores the click.
	const removeButton = (
		<MyButton
			variant="ghost_destructive"
			className={cn(removeDisabled && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
			aria-label={isCurrentUser ? "Leave organization" : `Remove ${displayName}`}
			aria-disabled={removeDisabled || undefined}
			aria-describedby={removeDisabledReason ? removeReasonId : undefined}
			onClick={() => {
				if (removeDisabled) {
					return;
				}
				onRemove(userId);
			}}
		>
			{isCurrentUser ? <LogOut aria-hidden /> : <Trash2 aria-hidden />}
			{removeLabel}
		</MyButton>
	);

	const roleLabel = role ? access_control_display_role_label(role) : "No role";
	// The owner has no role assignment to change, and changing your own role can only lower it with no
	// way back, so both keep the read-only badge instead of a select.
	const canChangeRole = canChangeRoles && !isOwner && !isCurrentUser;
	// The value the server stores: a system role name, or the id of a custom role. Owner is never one
	// of these, which is why the owner cannot appear in the list.
	const roleValue = role?.kind === "system" ? role.role : role?.kind === "custom" ? role.roleId : "";

	// `data-user-id` here, and `data-role-kind` on the badge below, are the only stable way the E2E
	// tests can find one row: nothing else in a row is unique, and ids from `useId()` change on every
	// render. Both are listed as selectors in
	// `.agents/skills/app-playwriter-harness/references/app-map.md`.
	return (
		<li className={"RouteUsersUserListItem" satisfies RouteUsersUserListItem_ClassNames} data-user-id={userId}>
			<MyAvatar size="40px" className={"RouteUsersUserListItem-avatar" satisfies RouteUsersUserListItem_ClassNames}>
				<MyAvatarImage alt={displayName} fallbackDelay={false} />
				<MyAvatarFallback>{compute_fallback_user_name(displayName)}</MyAvatarFallback>
			</MyAvatar>

			<div className={"RouteUsersUserListItem-main" satisfies RouteUsersUserListItem_ClassNames}>
				<div className={"RouteUsersUserListItem-title" satisfies RouteUsersUserListItem_ClassNames}>
					<span className={"RouteUsersUserListItem-name" satisfies RouteUsersUserListItem_ClassNames}>
						{displayName}
					</span>
					{canChangeRole ? (
						<MySelect
							value={roleValue}
							setValue={(value) => onRoleChange(userId, value === "" ? null : (value as access_control_RoleRef))}
						>
							{/* 
							Closed while the change is in flight: the list re-sorts by role when the answer
							arrives, so a second pick would land on a row that has already moved. 
							*/}
							<MySelectTrigger disabled={roleChangePending}>
								{/* 
								A button may carry `aria-label`, unlike the badge below. The name repeats the member
								like the Remove button in this row does, so the control still makes sense on its
								own in a screen reader's list of form controls. 
								*/}
								<MyButton
									type="button"
									variant="outline"
									className={"RouteUsersUserListItem-role-select" satisfies RouteUsersUserListItem_ClassNames}
									aria-label={`Role for ${displayName}`}
									aria-busy={roleChangePending || undefined}
									data-role-kind={role?.kind}
									data-role-value={roleValue}
								>
									<span>{roleChangePending ? "Saving..." : roleLabel}</span>
									<MySelectOpenIndicator />
								</MyButton>
							</MySelectTrigger>
							{/* `
							unmountOnHide` because the popover portals out of this row: without it every closed
							member's option list stays in the DOM and a test matching on role names finds many. 
							*/}
							<MySelectPopover unmountOnHide>
								<MySelectPopoverScrollableArea>
									<MySelectPopoverContent>
										{assignableRoles.map((assignableRole) => (
											<MySelectItem
												key={assignableRole.value}
												value={assignableRole.value}
												data-role-value={assignableRole.value}
											>
												{assignableRole.label}
												{roleValue === assignableRole.value ? <MySelectItemIndicator /> : null}
											</MySelectItem>
										))}
									</MySelectPopoverContent>
								</MySelectPopoverScrollableArea>
							</MySelectPopover>
						</MySelect>
					) : (
						<MyBadge
							variant={isOwner ? "secondary" : "outline"}
							data-role-kind={role?.kind}
							data-role-value={roleValue}
						>
							{/* 
							The badge is a bare word next to the name, so it says what the word means. Hidden
							text and not `aria-label`, because ARIA forbids naming a plain span. 
							*/}
							<span className="sr-only">Role: </span>
							{roleLabel}
						</MyBadge>
					)}
				</div>
				{email ? (
					<span className={"RouteUsersUserListItem-email" satisfies RouteUsersUserListItem_ClassNames}>{email}</span>
				) : null}
			</div>

			<div className={"RouteUsersUserListItem-actions" satisfies RouteUsersUserListItem_ClassNames}>
				{canTransferOwnership ? (
					<MyButton
						variant="outline"
						aria-label={`Transfer ownership to ${displayName}`}
						onClick={() => onTransfer(userId, displayName)}
					>
						<Crown aria-hidden />
						Transfer ownership
					</MyButton>
				) : null}
				{removeDisabledReason ? (
					<>
						<MyTooltip placement="bottom">
							<MyTooltipTrigger>{removeButton}</MyTooltipTrigger>
							<MyTooltipContent unmountOnHide>
								<>{removeDisabledReason}</>
							</MyTooltipContent>
						</MyTooltip>
						<span id={removeReasonId} className="sr-only">
							{removeDisabledReason}
						</span>
					</>
				) : (
					removeButton
				)}
			</div>
		</li>
	);
});
// #endregion user list item

// #region user list
type RouteUsersList_Props = {
	workspaceUserIds: app_convex_Id<"users">[];
	userAnagraphicDict: Record<
		app_convex_Id<"users">,
		| app_convex_FunctionReturnType<typeof app_convex_api.users.get_workspace_member_anagraphic>
		| undefined
		| Error
	>;
	userRoleDict: Record<app_convex_Id<"users">, access_control_DisplayRole | null | undefined | Error>;
	assignableRoles: readonly RouteUsersAssignableRole[];
	authUserId: app_convex_Id<"users"> | null;
	/** `undefined` while the permission query is still loading. */
	canManageMembers: boolean | undefined;
	canChangeRoles: boolean;
	roleChangePendingUserId: app_convex_Id<"users"> | null;
	canLeaveOrganization: boolean;
	organizationIsPersonal: boolean;
	canTransferOwnership: boolean;
	onRemove: (userId: app_convex_Id<"users">) => void;
	onRoleChange: (userId: app_convex_Id<"users">, role: access_control_RoleRef | null) => void;
	onTransfer: (userId: app_convex_Id<"users">, displayName: string) => void;
};

/** A failed role query is treated like "no role". Loading is handled before any row is rendered. */
function read_display_role(value: access_control_DisplayRole | null | undefined | Error) {
	return value == null || value instanceof Error ? null : value;
}

const RouteUsersList = memo(function RouteUsersList(props: RouteUsersList_Props) {
	const {
		workspaceUserIds,
		userAnagraphicDict,
		userRoleDict,
		assignableRoles,
		authUserId,
		canManageMembers,
		canChangeRoles,
		roleChangePendingUserId,
		canLeaveOrganization,
		organizationIsPersonal,
		canTransferOwnership,
		onRemove,
		onRoleChange,
		onTransfer,
	} = props;

	// We wait for the roles too, not only for the names. Rendering earlier would show everyone as
	// "No role", then sort the list again under the user's mouse when the roles arrive, and show
	// "Transfer ownership" for a moment on the owner's own row, because nothing says yet that they are
	// the owner.
	const userRowsLoading = workspaceUserIds.some((userId) => {
		const anagraphic = userAnagraphicDict[userId];

		return anagraphic === undefined || userRoleDict[userId] === undefined;
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
		// A role is an object, so we cannot compare roles directly. We sort with the shared sort key.
		const roleOrderDifference =
			access_control_display_role_order(read_display_role(userRoleDict[a])) -
			access_control_display_role_order(read_display_role(userRoleDict[b]));
		if (roleOrderDifference !== 0) {
			return roleOrderDifference;
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
		<ul className={"RouteUsers-list" satisfies RouteUsers_ClassNames} aria-label="Organization members">
			{sortedWorkspaceUserIds.map((userId) => {
				const anagraphic = userAnagraphicDict[userId];
				if (anagraphic === undefined || anagraphic === null || anagraphic instanceof Error) {
					return null;
				}

				const role = read_display_role(userRoleDict[userId]);

				return (
					<RouteUsersUserListItem
						key={userId}
						userId={userId}
						authUserId={authUserId}
						displayName={anagraphic.displayName}
						email={anagraphic.email}
						role={role}
						assignableRoles={assignableRoles}
						canManageMembers={canManageMembers}
						canChangeRoles={canChangeRoles}
						roleChangePending={roleChangePendingUserId === userId}
						canLeaveOrganization={canLeaveOrganization}
						organizationIsPersonal={organizationIsPersonal}
						canTransferOwnership={canTransferOwnership && role?.kind !== "owner"}
						onRemove={onRemove}
						onRoleChange={onRoleChange}
						onTransfer={onTransfer}
					/>
				);
			})}
		</ul>
	);
});
// #endregion user list

// #region invite modal
type RouteUsersInviteModal_ClassNames =
	| "RouteUsersInviteModal"
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

	// Same approach as the Remove button: `aria-disabled` keeps the button reachable with Tab, so the
	// user can read the reason, and the reason gets its own element that the button points at.
	const inviteReasonId = "RouteUsersInviteModal-reason";
	const inviteButton = (
		<MyButton
			className={cn(inviteButtonDisabled && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
			aria-disabled={inviteButtonDisabled || undefined}
			aria-describedby={inviteButtonDisabled && inviteButtonDisabledTooltip ? inviteReasonId : undefined}
		>
			<UserPlus aria-hidden />
			Invite
		</MyButton>
	);

	return (
		<MyModal open={inviteModalOpen} setOpen={onInviteModalOpenChange}>
			{inviteButtonDisabled ? (
				inviteButtonDisabledTooltip ? (
					<>
						<MyTooltip placement="bottom">
							<MyTooltipTrigger>{inviteButton}</MyTooltipTrigger>
							<MyTooltipContent unmountOnHide>
								<>{inviteButtonDisabledTooltip}</>
							</MyTooltipContent>
						</MyTooltip>
						<span id={inviteReasonId} className="sr-only">
							{inviteButtonDisabledTooltip}
						</span>
					</>
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
					<MyInput layout="stacked">
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
								// The trigger's only text is the workspace it currently holds, and `combobox` is not a
								// name-from-content role, so without this a screen reader announces it with no name at
								// all. Which workspace this picks decides which membership the invite writes.
								aria-label="Workspace to invite into"
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
					<MyInput layout="stacked">
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
	const defaultWorkspace = organization
		? app_tenant_primary_workspace_for_organization({ organization, workspaces })
		: null;
	const currentWorkspace = workspaces.find((workspace) => workspace._id === workspaceId);
	const workspaceUserIds = useQuery(app_convex_api.organizations.list_organization_workspace_users, {
		organizationId,
		workspaceId,
	});
	const currentOrganizationRole = useQuery(
		app_convex_api.access_control.get_current_user_role,
		defaultWorkspace ? { organizationId, workspaceId: defaultWorkspace._id } : "skip",
	);

	const organizationMembersManagePermission = useQuery(
		app_convex_api.access_control.get_current_user_organization_permission,
		auth.userId === null
			? "skip"
			: {
					organizationId,
					permission: "organization.members.manage",
				},
	);

	// Any active member may read this, so the role select can show custom role names to everybody. The
	// server still refuses a change the caller is not allowed to make.
	const customRoles = useQuery(app_convex_api.access_control.list_roles, { organizationId });

	// The Users page is a shared-workspace roster, so this query returns email. `get_anagraphic`
	// blanks it for anyone but the caller because a bare `users` id is not a tenant check.
	// The react compiler is unable to memoize code that uses the returned value from a hook
	const userAnagraphicQueryProps = useMemo(
		() =>
			Object.fromEntries(
				(workspaceUserIds ?? []).map(
					(userId) =>
						[
							userId,
							{
								query: app_convex_api.users.get_workspace_member_anagraphic,
								args: { organizationId, workspaceId, userId },
							},
						] as const,
				),
			),
		[workspaceUserIds, organizationId, workspaceId],
	);

	const userAnagraphicQueryResults = useQueries(userAnagraphicQueryProps) as Record<
		app_convex_Id<"users">,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_workspace_member_anagraphic> | undefined | Error
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
		access_control_DisplayRole | null | undefined | Error
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
	// Only one row can be waiting at a time, because its select is closed while it waits.
	const [roleChangePendingUserId, setRoleChangePendingUserId] = useState<app_convex_Id<"users"> | null>(null);

	const organizationIsPersonal = organization?.default === true;
	// One permission query drives both Invite and Remove, so a custom role can never get a working
	// Invite next to a greyed-out Remove. It keeps three states on purpose: both buttons are disabled
	// for anything except `true`, and neither says why until the answer arrives.
	const canManageMembers = organizationIsPersonal ? false : organizationMembersManagePermission;

	// The caller's permissions in this workspace. `set_user_role` measures both what the caller may do
	// and what they may hand out at `args.workspaceId`, and `organizations.list` fills this dict with
	// the same helper and the same arguments, so this is the same set the server compares against.
	// The react compiler cannot memoize a value built from a hook result, so this one is by hand.
	const callerPermissionsValue = organizationList?.workspaceIdsPermissionsDict[workspaceId];
	const callerPermissions = useMemo(
		(): ReadonlySet<access_control_Permission> | "all" =>
			callerPermissionsValue === "all" ? "all" : new Set<access_control_Permission>(callerPermissionsValue),
		[callerPermissionsValue],
	);

	// Changing a role is not the same permission as Invite and Remove, which work across the whole
	// organization. Outside the default workspace `set_user_role` also takes `workspace.members.manage`,
	// so somebody can run one workspace without being able to touch the organization's member list.
	const isDefaultWorkspace = defaultWorkspace?._id === workspaceId;
	const canChangeRoles =
		!organizationIsPersonal &&
		(canManageMembers === true ||
			(!isDefaultWorkspace && (callerPermissions === "all" || callerPermissions.has("workspace.members.manage"))));

	// Only the roles the server would accept. It refuses any role holding a permission the caller does
	// not hold, so offering the rest would just be a list of guaranteed error toasts.
	const assignableRoles = useMemo((): RouteUsersAssignableRole[] => {
		const canHandOut = (permissions: readonly access_control_Permission[]) =>
			callerPermissions === "all" || permissions.every((permission) => callerPermissions.has(permission));

		const options: RouteUsersAssignableRole[] = [];

		// Outside the default workspace the assignment is a workspace role, which only adds to the
		// organization role. This entry is the only way to take one back: every weaker role is refused
		// by the "adds nothing" rule, so without it a workspace role would be permanent and the role
		// itself undeletable.
		if (!isDefaultWorkspace) {
			options.push({ value: "", label: "No workspace role" });
		}

		for (const systemRole of access_control_SYSTEM_ROLES) {
			if (canHandOut(access_control_SYSTEM_ROLE_MATRIX[systemRole].permissions)) {
				options.push({ value: systemRole, label: access_control_SYSTEM_ROLE_MATRIX[systemRole].label });
			}
		}

		for (const customRole of customRoles ?? []) {
			if (canHandOut(customRole.permissions)) {
				options.push({ value: customRole._id, label: customRole.name });
			}
		}

		return options;
	}, [callerPermissions, customRoles, isDefaultWorkspace]);
	const inviteButtonDisabled = canManageMembers !== true;
	// Both real reasons need a message, like the Remove button: a disabled button with no explanation
	// tells the user nothing. The loading case stays quiet on purpose: nothing is wrong yet, the answer
	// is only not ready.
	const inviteButtonDisabledTooltip = organizationIsPersonal
		? "Your personal organization is only yours, so there is nobody to invite."
		: canManageMembers === false
			? "You don't have permission to invite people to this organization."
			: null;
	// Everyone except the owner may leave; the owner has to transfer ownership first. While the role is
	// still loading the button stays disabled, so the owner never sees a Leave button that cannot work.
	const canLeaveOrganization =
		!organizationIsPersonal && currentOrganizationRole !== undefined && currentOrganizationRole?.kind !== "owner";
	const canTransferOwnership =
		defaultWorkspace?._id === workspaceId && currentOrganizationRole?.kind === "owner" && !organizationIsPersonal;
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
					// The server message says the real reason: quota reached, no permission, or unknown
					// email. A generic "Failed" would leave the user with nothing they can do.
					toast.error(result._nay.message);
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
					toast.error(result._nay.message);
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

	const handleRoleChange = useFn((userId: app_convex_Id<"users">, role: access_control_RoleRef | null) => {
		setRoleChangePendingUserId(userId);
		app_convex
			.mutation(app_convex_api.access_control.set_user_role, {
				organizationId,
				workspaceId,
				userId,
				role,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[RouteUsers.handleRoleChange] Failed to change role:", {
						error: result._nay,
						organizationId,
						workspaceId,
						userId,
						role,
					});
					// The server message names the real reason, for example a role that grants more than the
					// caller has. A generic "Failed" would hide which role is the problem.
					toast.error(result._nay.message);
					return;
				}

				toast.success(role === null ? "Workspace role removed" : "Role updated");
			})
			.catch((error) => {
				console.error("[RouteUsers.handleRoleChange] Failed to change role:", {
					error,
					organizationId,
					workspaceId,
					userId,
				});
				toast.error("Failed to change role");
			})
			.finally(() => {
				setRoleChangePendingUserId((current) => (current === userId ? null : current));
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
					toast.error(result._nay.message);
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

	// Every branch below renders a `main`, like the api-keys and plugins routes next to this one.
	// Without it the page would have no main landmark, and the member list would sit outside every
	// landmark, which makes it hard to reach with a screen reader.
	return organizationList === undefined || auth.userId === null ? (
		<main className={"RouteUsers-loading" satisfies RouteUsers_ClassNames} role="status" aria-live="polite">
			<UsersIcon aria-hidden />
			Loading users...
		</main>
	) : !organization || !defaultWorkspace || !currentWorkspace || workspaceUserIds === null ? (
		<main className={"RouteUsers-empty" satisfies RouteUsers_ClassNames} role="alert">
			Organization users unavailable.
		</main>
	) : workspaceUserIds === undefined ? (
		<main className={"RouteUsers-loading" satisfies RouteUsers_ClassNames} role="status" aria-live="polite">
			<UsersIcon aria-hidden />
			Loading users...
		</main>
	) : (
		<main className={cn("RouteUsers" satisfies RouteUsers_ClassNames, "app-scrollable" satisfies AppClassName)}>
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
				assignableRoles={assignableRoles}
				authUserId={auth.userId}
				canManageMembers={canManageMembers}
				canChangeRoles={canChangeRoles}
				roleChangePendingUserId={roleChangePendingUserId}
				canLeaveOrganization={canLeaveOrganization}
				organizationIsPersonal={organizationIsPersonal}
				canTransferOwnership={canTransferOwnership}
				onRemove={handleRemove}
				onRoleChange={handleRoleChange}
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
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/users/")({
	component: RouteUsers,
});

export { Route };
// #endregion root
