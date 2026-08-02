import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Lock, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import { MyCheckboxButton } from "@/components/my-checkbox-button.tsx";
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
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import {
	access_control_ENFORCED_PERMISSIONS,
	access_control_MAX_ROLE_DESCRIPTION_LENGTH,
	access_control_MAX_ROLE_NAME_LENGTH,
	access_control_PERMISSION_CATALOG,
	access_control_PERMISSION_GROUPS,
	access_control_SYSTEM_ROLE_MATRIX,
	access_control_SYSTEM_ROLES,
	type access_control_Permission,
} from "../../../../../../shared/access-control.ts";

/** What the signed-in user may hand out. `"all"` is the organization owner. */
type RouteRolesCallerPermissions = ReadonlySet<access_control_Permission> | "all";

function route_roles_can_hand_out(
	callerPermissions: RouteRolesCallerPermissions,
	permission: access_control_Permission,
) {
	return callerPermissions === "all" || callerPermissions.has(permission);
}

// #region permission picker
/**
 * The catalog split into the groups the editor shows, in the order
 * `access_control_PERMISSION_GROUPS` sets.
 *
 * Only enforced permissions are here. A permission nothing checks yet would be a switch that does
 * nothing, and the server refuses it anyway.
 */
const PERMISSION_GROUPS = access_control_PERMISSION_GROUPS.map((group) => ({
	group,
	permissions: access_control_ENFORCED_PERMISSIONS.filter(
		(permission) => access_control_PERMISSION_CATALOG[permission].group === group,
	),
}));

type RouteRolesPermissionPicker_ClassNames =
	| "RouteRolesPermissionPicker"
	| "RouteRolesPermissionPicker-group"
	| "RouteRolesPermissionPicker-group-title"
	| "RouteRolesPermissionPicker-list"
	| "RouteRolesPermissionPicker-permission"
	| "RouteRolesPermissionPicker-permission-locked"
	| "RouteRolesPermissionPicker-permission-locked-icon"
	| "RouteRolesPermissionPicker-permission-text"
	| "RouteRolesPermissionPicker-permission-label"
	| "RouteRolesPermissionPicker-permission-description";

type RouteRolesPermissionPicker_Props = {
	selected: ReadonlySet<access_control_Permission>;
	callerPermissions: RouteRolesCallerPermissions;
	disabled: boolean;
	onToggle: (permission: access_control_Permission, checked: boolean) => void;
};

const RouteRolesPermissionPicker = memo(function RouteRolesPermissionPicker(props: RouteRolesPermissionPicker_Props) {
	const { selected, callerPermissions, disabled, onToggle } = props;

	return (
		<div className={"RouteRolesPermissionPicker" satisfies RouteRolesPermissionPicker_ClassNames}>
			{PERMISSION_GROUPS.map((entry) => (
				<fieldset
					key={entry.group}
					className={"RouteRolesPermissionPicker-group" satisfies RouteRolesPermissionPicker_ClassNames}
				>
					<legend className={"RouteRolesPermissionPicker-group-title" satisfies RouteRolesPermissionPicker_ClassNames}>
						{entry.group}
					</legend>
					<ul className={"RouteRolesPermissionPicker-list" satisfies RouteRolesPermissionPicker_ClassNames}>
						{entry.permissions.map((permission) => {
							const catalogEntry = access_control_PERMISSION_CATALOG[permission];
							const canHandOut = route_roles_can_hand_out(callerPermissions, permission);
							const text = (
								<span
									className={
										"RouteRolesPermissionPicker-permission-text" satisfies RouteRolesPermissionPicker_ClassNames
									}
								>
									<span
										className={
											"RouteRolesPermissionPicker-permission-label" satisfies RouteRolesPermissionPicker_ClassNames
										}
									>
										{catalogEntry.label}
									</span>
									<span
										className={
											"RouteRolesPermissionPicker-permission-description" satisfies RouteRolesPermissionPicker_ClassNames
										}
									>
										{canHandOut
											? catalogEntry.description
											: `${catalogEntry.description} You cannot give this away, because you do not have it yourself.`}
									</span>
								</span>
							);

							// `data-permission` sits on the `li`, not on the control: `MyCheckboxButton` spreads the
							// rest of its props onto its hidden 1px input, which a browser test cannot click.
							return (
								<li key={permission} data-permission={permission}>
									{/* A permission the user does not hold stays visible, not hidden: hiding it would make
									    the app look like it has fewer permissions than it has. It is plain text, not a
									    disabled checkbox, so nothing looks clickable.

									    It never has to show a checked state: Edit only opens for a role whose every
									    permission the user can hand out, and a new role starts empty. So a locked row is
									    always an off row. */}
									{canHandOut ? (
										<MyCheckboxButton
											className={
												"RouteRolesPermissionPicker-permission" satisfies RouteRolesPermissionPicker_ClassNames
											}
											variant="outline"
											checked={selected.has(permission)}
											disabled={disabled}
											onCheckedChange={(checked) => onToggle(permission, checked)}
										>
											{text}
										</MyCheckboxButton>
									) : (
										<div
											className={
												"RouteRolesPermissionPicker-permission-locked" satisfies RouteRolesPermissionPicker_ClassNames
											}
										>
											<Lock
												className={
													"RouteRolesPermissionPicker-permission-locked-icon" satisfies RouteRolesPermissionPicker_ClassNames
												}
												aria-hidden
											/>
											{text}
										</div>
									)}
								</li>
							);
						})}
					</ul>
				</fieldset>
			))}
		</div>
	);
});
// #endregion permission picker

// #region role editor modal
type RouteRolesEditorModal_ClassNames = "RouteRolesEditorModal" | "RouteRolesEditorModal-fields";

type RouteRolesEditorModal_Props = {
	open: boolean;
	/** `true` while editing an existing role, so only the wording changes. */
	editing: boolean;
	name: string;
	description: string;
	permissions: ReadonlySet<access_control_Permission>;
	callerPermissions: RouteRolesCallerPermissions;
	saving: boolean;
	onClose: () => void;
	onNameChange: (name: string) => void;
	onDescriptionChange: (description: string) => void;
	onTogglePermission: (permission: access_control_Permission, checked: boolean) => void;
	onSave: () => void;
};

const RouteRolesEditorModal = memo(function RouteRolesEditorModal(props: RouteRolesEditorModal_Props) {
	const {
		open,
		editing,
		name,
		description,
		permissions,
		callerPermissions,
		saving,
		onClose,
		onNameChange,
		onDescriptionChange,
		onTogglePermission,
		onSave,
	} = props;

	return (
		<MyModal open={open} setOpen={(next) => !next && onClose()}>
			{/* Escape must not close a modal that is mid-save: the save leaves `saving` on, and the next
			    modal would open frozen and then shut itself when this request answers. */}
			<MyModalPopover
				className={"RouteRolesEditorModal" satisfies RouteRolesEditorModal_ClassNames}
				hideOnEscape={!saving}
			>
				<MyModalHeader>
					<MyModalHeading>{editing ? "Edit role" : "New role"}</MyModalHeading>
					<MyModalDescription>Pick what this role can do. It works everywhere in the organization.</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea>
					<div className={"RouteRolesEditorModal-fields" satisfies RouteRolesEditorModal_ClassNames}>
						<MyInput layout="stacked">
							<MyInputLabel>Name</MyInputLabel>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									value={name}
									placeholder="editor"
									autoFocus
									disabled={saving}
									maxLength={access_control_MAX_ROLE_NAME_LENGTH}
									onChange={(event) => onNameChange(event.currentTarget.value)}
								/>
							</MyInputArea>
							<MyInputBox />
						</MyInput>

						<MyInput layout="stacked">
							<MyInputLabel>Description</MyInputLabel>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									value={description}
									placeholder="Can write files, but cannot change members"
									disabled={saving}
									maxLength={access_control_MAX_ROLE_DESCRIPTION_LENGTH}
									onChange={(event) => onDescriptionChange(event.currentTarget.value)}
								/>
							</MyInputArea>
							<MyInputBox />
						</MyInput>

						<RouteRolesPermissionPicker
							selected={permissions}
							callerPermissions={callerPermissions}
							disabled={saving}
							onToggle={onTogglePermission}
						/>
					</div>
				</MyModalScrollableArea>

				<MyModalFooter>
					<MyButton variant="ghost" disabled={saving} onClick={onClose}>
						Cancel
					</MyButton>
					<MyButton disabled={!name.trim() || permissions.size === 0 || saving} onClick={onSave}>
						{saving ? "Saving..." : editing ? "Save role" : "Create role"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={saving} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion role editor modal

// #region delete role modal
type RouteRolesDeleteModal_ClassNames = "RouteRolesDeleteModal";

type RouteRolesDeleteModal_Props = {
	roleName: string | null;
	deleting: boolean;
	/** Where focus goes after closing. The row that opened this modal is gone once the delete works. */
	finalFocus: RefObject<HTMLElement | null>;
	onClose: () => void;
	onDelete: () => void;
};

const RouteRolesDeleteModal = memo(function RouteRolesDeleteModal(props: RouteRolesDeleteModal_Props) {
	const { roleName, deleting, finalFocus, onClose, onDelete } = props;

	return (
		<MyModal open={roleName !== null} setOpen={(open) => !open && onClose()}>
			<MyModalPopover
				className={"RouteRolesDeleteModal" satisfies RouteRolesDeleteModal_ClassNames}
				hideOnEscape={!deleting}
				finalFocus={finalFocus}
			>
				<MyModalHeader>
					<MyModalHeading>Delete role</MyModalHeading>
					{/* `delete_role` refuses while somebody still has the role. It never moves them off it, so
					    this must not promise that it does. */}
					<MyModalDescription>
						Delete {roleName ?? "this role"}. Members who still have this role must get another role first.
					</MyModalDescription>
				</MyModalHeader>

				<MyModalFooter>
					<MyButton variant="ghost" disabled={deleting} onClick={onClose}>
						Cancel
					</MyButton>
					<MyButton variant="destructive" disabled={deleting} onClick={onDelete}>
						{deleting ? "Deleting..." : "Delete role"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={deleting} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion delete role modal

// #region role list item
type RouteRolesListItem_ClassNames =
	| "RouteRolesListItem"
	| "RouteRolesListItem-head"
	| "RouteRolesListItem-identity"
	| "RouteRolesListItem-name"
	| "RouteRolesListItem-description"
	| "RouteRolesListItem-actions"
	| "RouteRolesListItem-permissions";

type RouteRolesListItem_Props = {
	/** Missing for a system role, which lives in code and has nothing to edit. */
	roleId?: app_convex_Id<"access_control_roles">;
	name: string;
	description?: string;
	permissions: readonly access_control_Permission[];
	/** At least one assignment points at this role. */
	inUse?: boolean;
	/**
	 * Why Edit and Delete are refused for this one role. Set only when the user may manage roles but
	 * not this one, so the buttons stay and say why instead of quietly disappearing.
	 */
	changeDisabledReason?: string;
	onEdit?: (roleId: app_convex_Id<"access_control_roles">) => void;
	onDelete?: (roleId: app_convex_Id<"access_control_roles">) => void;
};

const RouteRolesListItem = memo(function RouteRolesListItem(props: RouteRolesListItem_Props) {
	const { roleId, name, description, permissions, inUse, changeDisabledReason, onEdit, onDelete } = props;

	// Same shape as the New role button and the members page: `aria-disabled` instead of `disabled`,
	// so the button keeps its place in the tab order and can point at the reason. A really disabled
	// button cannot be focused or hovered, so neither the tooltip nor a screen reader would ever
	// reach the explanation.
	const changeReasonId = `RouteRoles-change-reason-${roleId}`;
	// `ReactElement`, not `ReactNode`: `MyTooltipTrigger` passes its child to Ariakit as a render prop,
	// which has to be a single element.
	const renderAction = (button: ReactElement) =>
		changeDisabledReason ? (
			<MyTooltip placement="bottom">
				<MyTooltipTrigger>{button}</MyTooltipTrigger>
				<MyTooltipContent unmountOnHide>
					<>{changeDisabledReason}</>
				</MyTooltipContent>
			</MyTooltip>
		) : (
			button
		);

	return (
		// `data-role-id` and `data-role-name` are here so a browser test can find one row without
		// guessing at the text, the same reason the members list carries `data-user-id`. Both are listed
		// as selectors in `.agents/skills/app-playwriter-harness/references/app-map.md`.
		<li
			className={"RouteRolesListItem" satisfies RouteRolesListItem_ClassNames}
			data-role-id={roleId}
			data-role-name={name}
		>
			<div className={"RouteRolesListItem-head" satisfies RouteRolesListItem_ClassNames}>
				<div className={"RouteRolesListItem-identity" satisfies RouteRolesListItem_ClassNames}>
					<div className={"RouteRolesListItem-name" satisfies RouteRolesListItem_ClassNames}>
						{name}
						{/* `assignmentCount` counts assignment docs, not people: one member can hold a role in two
						    workspaces, a user being deleted still counts, and the server stops counting at 100. So
						    this only says "somebody has this", never how many. */}
						{inUse ? <MyBadge variant="secondary">In use</MyBadge> : null}
					</div>
					{description ? (
						<div className={"RouteRolesListItem-description" satisfies RouteRolesListItem_ClassNames}>
							{description}
						</div>
					) : null}
				</div>

				{roleId && (onEdit || onDelete) ? (
					<div className={"RouteRolesListItem-actions" satisfies RouteRolesListItem_ClassNames}>
						{onEdit
							? renderAction(
									<MyButton
										variant="outline"
										className={cn(changeDisabledReason && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
										aria-label={`Edit ${name}`}
										aria-disabled={changeDisabledReason ? true : undefined}
										aria-describedby={changeDisabledReason ? changeReasonId : undefined}
										onClick={() => !changeDisabledReason && onEdit(roleId)}
									>
										<Pencil aria-hidden />
										Edit
									</MyButton>,
								)
							: null}
						{onDelete
							? renderAction(
									<MyButton
										variant="outline_destructive"
										className={cn(changeDisabledReason && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
										aria-label={`Delete ${name}`}
										aria-disabled={changeDisabledReason ? true : undefined}
										aria-describedby={changeDisabledReason ? changeReasonId : undefined}
										onClick={() => !changeDisabledReason && onDelete(roleId)}
									>
										<Trash2 aria-hidden />
										Delete
									</MyButton>,
								)
							: null}
						{/* One reason element for both buttons: Ariakit's tooltip only wires `aria-labelledby`,
						    and only for label-type tooltips, so the tooltip alone never reaches a screen reader. */}
						{changeDisabledReason ? (
							<span id={changeReasonId} className="sr-only">
								{changeDisabledReason}
							</span>
						) : null}
					</div>
				) : null}
			</div>

			<ul className={"RouteRolesListItem-permissions" satisfies RouteRolesListItem_ClassNames}>
				{permissions.map((permission) => (
					<li key={permission}>
						<MyBadge variant="outline">{access_control_PERMISSION_CATALOG[permission].label}</MyBadge>
					</li>
				))}
			</ul>
		</li>
	);
});
// #endregion role list item

// #region header
type RouteRolesHeader_ClassNames =
	| "RouteRolesHeader"
	| "RouteRolesHeader-title"
	| "RouteRolesHeader-description"
	| "RouteRolesHeader-toolbar";

type RouteRolesHeader_Props = {
	description: string;
	toolbar: ReactNode;
};

const RouteRolesHeader = memo(function RouteRolesHeader(props: RouteRolesHeader_Props) {
	const { description, toolbar } = props;

	return (
		<header className={"RouteRolesHeader" satisfies RouteRolesHeader_ClassNames}>
			<div>
				<h1 className={"RouteRolesHeader-title" satisfies RouteRolesHeader_ClassNames}>Roles</h1>
				<p className={"RouteRolesHeader-description" satisfies RouteRolesHeader_ClassNames}>{description}</p>
			</div>

			<div className={"RouteRolesHeader-toolbar" satisfies RouteRolesHeader_ClassNames}>{toolbar}</div>
		</header>
	);
});
// #endregion header

// #region root
type RouteRoles_ClassNames =
	| "RouteRoles"
	| "RouteRoles-loading"
	| "RouteRoles-unavailable"
	| "RouteRoles-list"
	| "RouteRoles-section"
	| "RouteRoles-section-title"
	| "RouteRoles-section-description"
	| "RouteRoles-section-empty";

function RouteRoles() {
	const { organizationId } = AppTenantProvider.useContext();

	const auth = AppAuthProvider.useAuth();

	const organizationList = useQuery(app_convex_api.organizations.list);
	const organization = organizationList?.organizations.find((candidate) => candidate._id === organizationId);
	const roles = useQuery(app_convex_api.access_control.list_roles, { organizationId });

	// This asks the server the same question it asks itself before a write, so a grant on a single
	// file would count here once file sharing ships. `callerPermissions` below cannot answer it: that
	// set leaves such grants out on purpose.
	const organizationRolesManagePermission = useQuery(
		app_convex_api.access_control.get_current_user_organization_permission,
		auth.userId === null
			? "skip"
			: {
					organizationId,
					permission: "organization.roles.manage",
				},
	);

	const [editorOpen, setEditorOpen] = useState(false);
	const [editorRoleId, setEditorRoleId] = useState<app_convex_Id<"access_control_roles"> | null>(null);
	const [editorName, setEditorName] = useState("");
	const [editorDescription, setEditorDescription] = useState("");
	const [editorPermissions, setEditorPermissions] = useState<ReadonlySet<access_control_Permission>>(new Set());
	const [saving, setSaving] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<{
		roleId: app_convex_Id<"access_control_roles">;
		name: string;
	} | null>(null);
	const [deleting, setDeleting] = useState(false);

	// A delete removes the row that opened the modal, so focus would land on `body`. Send it to the
	// one control that is always there.
	const createButtonRef = useRef<HTMLButtonElement>(null);

	// The ceiling: nobody can put a permission on a role that they do not hold themselves. The server
	// measures it at the default workspace for role editing, and `organizations.list` fills this dict
	// with the same helper and the same arguments, so this is the same set the server compares against.
	// The react compiler cannot memoize a value built from a hook result, so this one is by hand.
	const defaultWorkspaceId = organization?.defaultWorkspaceId;
	const callerPermissionsValue = defaultWorkspaceId
		? organizationList?.workspaceIdsPermissionsDict[defaultWorkspaceId]
		: undefined;
	const callerPermissions = useMemo(
		(): RouteRolesCallerPermissions =>
			callerPermissionsValue === "all" ? "all" : new Set<access_control_Permission>(callerPermissionsValue),
		[callerPermissionsValue],
	);

	// Same three-state rule as the Invite button on the members page: anything except `true` disables
	// the button, and only the two real answers get a reason. While the query is still loading nothing
	// is wrong yet, so saying "you don't have permission" would be a guess.
	const organizationIsPersonal = organization?.default === true;
	const canManageRoles = organizationIsPersonal ? false : organizationRolesManagePermission;
	const createButtonDisabled = canManageRoles !== true;
	const createButtonDisabledTooltip = organizationIsPersonal
		? "Your personal organization is only yours, so custom roles do nothing there."
		: canManageRoles === false
			? "You don't have permission to manage roles in this organization."
			: null;

	const handleOpenCreate = useFn(() => {
		if (createButtonDisabled) {
			return;
		}

		setEditorRoleId(null);
		setEditorName("");
		setEditorDescription("");
		setEditorPermissions(new Set());
		setEditorOpen(true);
	});

	const handleOpenEdit = useFn((roleId: app_convex_Id<"access_control_roles">) => {
		const role = roles?.find((candidate) => candidate._id === roleId);
		if (!role) {
			return;
		}

		setEditorRoleId(role._id);
		setEditorName(role.name);
		setEditorDescription(role.description);
		setEditorPermissions(new Set(role.permissions));
		setEditorOpen(true);
	});

	// Both closers ignore the click while the request is in flight, for the same reason the modals do
	// not close on Escape then: `saving` and `deleting` would stay on and freeze the next modal.
	const handleCloseEditor = useFn(() => {
		if (saving) {
			return;
		}

		setEditorOpen(false);
	});

	// Somebody else can delete the role while this form is open. Then every Save answers "Not found"
	// and the form has no way out, so close it and say what happened.
	useEffect(() => {
		if (!editorOpen || editorRoleId === null || saving || !roles) {
			return;
		}

		if (!roles.some((role) => role._id === editorRoleId)) {
			setEditorOpen(false);
			toast.error("This role was deleted.");
		}
	}, [editorOpen, editorRoleId, saving, roles]);

	const handleTogglePermission = useFn((permission: access_control_Permission, checked: boolean) => {
		setEditorPermissions((current) => {
			const next = new Set(current);
			if (checked) {
				next.add(permission);
			} else {
				next.delete(permission);
			}
			return next;
		});
	});

	const handleSave = useFn(() => {
		const name = editorName.trim();
		const permissions = [...editorPermissions];
		if (!name || permissions.length === 0) {
			return;
		}

		const description = editorDescription.trim();
		const editing = editorRoleId !== null;

		setSaving(true);
		const request = editorRoleId
			? app_convex.mutation(app_convex_api.access_control.update_role, {
					roleId: editorRoleId,
					name,
					description,
					permissions,
				})
			: app_convex.mutation(app_convex_api.access_control.create_role, {
					organizationId,
					name,
					description,
					permissions,
				});

		request
			.then((result) => {
				if (result._nay) {
					console.error("[RouteRoles.handleSave] Failed to save role:", {
						error: result._nay,
						organizationId,
						editorRoleId,
						name,
					});
					// The server message says the real reason: a duplicate name, a reserved name, or a
					// permission the user cannot give away. A generic "Failed" would leave them stuck.
					toast.error(result._nay.message);
					return;
				}

				toast.success(editing ? "Role updated" : "Role created");
				setEditorOpen(false);
			})
			.catch((error) => {
				console.error("[RouteRoles.handleSave] Failed to save role:", {
					error,
					organizationId,
					editorRoleId,
				});
				toast.error(editing ? "Failed to update role" : "Failed to create role");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	const handleOpenDelete = useFn((roleId: app_convex_Id<"access_control_roles">) => {
		const role = roles?.find((candidate) => candidate._id === roleId);
		if (role) {
			setDeleteTarget({ roleId: role._id, name: role.name });
		}
	});

	const handleCloseDeleteModal = useFn(() => {
		if (deleting) {
			return;
		}

		setDeleteTarget(null);
	});

	const handleDelete = useFn(() => {
		if (!deleteTarget) {
			return;
		}

		const roleId = deleteTarget.roleId;

		setDeleting(true);
		app_convex
			.mutation(app_convex_api.access_control.delete_role, { roleId })
			.then((result) => {
				if (result._nay) {
					console.error("[RouteRoles.handleDelete] Failed to delete role:", {
						error: result._nay,
						organizationId,
						roleId,
					});
					// This is where "Give this role's members another role first" reaches the user, so the
					// server message has to survive.
					toast.error(result._nay.message);
					return;
				}

				toast.success("Role deleted");
				setDeleteTarget(null);
			})
			.catch((error) => {
				console.error("[RouteRoles.handleDelete] Failed to delete role:", {
					error,
					organizationId,
					roleId,
				});
				toast.error("Failed to delete role");
			})
			.finally(() => {
				setDeleting(false);
			});
	});

	// `aria-disabled`, not `disabled`: a really disabled button cannot be focused or hovered, so Tab
	// would skip it and the tooltip holding the reason would never open.
	const createReasonId = "RouteRoles-create-reason";
	const createButton = (
		<MyButton
			ref={createButtonRef}
			className={cn(createButtonDisabled && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
			aria-disabled={createButtonDisabled || undefined}
			aria-describedby={createButtonDisabledTooltip ? createReasonId : undefined}
			onClick={handleOpenCreate}
		>
			<Plus aria-hidden />
			New role
		</MyButton>
	);

	// Every branch below renders a `main`, like the members and api-keys routes next to this one.
	// Without it the page would have no main landmark and the role list would sit outside every
	// landmark, which makes it hard to reach with a screen reader.
	return organizationList === undefined || auth.userId === null || roles === undefined ? (
		<main className={"RouteRoles-loading" satisfies RouteRoles_ClassNames} role="status" aria-live="polite">
			<ShieldCheck aria-hidden />
			Loading roles...
		</main>
	) : !organization ? (
		<main className={"RouteRoles-unavailable" satisfies RouteRoles_ClassNames} role="alert">
			Organization roles unavailable.
		</main>
	) : (
		<main className={cn("RouteRoles" satisfies RouteRoles_ClassNames, "app-scrollable" satisfies AppClassName)}>
			<RouteRolesHeader
				description={
					organizationIsPersonal
						? "Your personal organization is only yours, so roles do nothing here."
						: `Who can do what in the ${organization.name} organization.`
				}
				toolbar={
					createButtonDisabledTooltip ? (
						<>
							<MyTooltip placement="bottom">
								<MyTooltipTrigger>{createButton}</MyTooltipTrigger>
								<MyTooltipContent unmountOnHide>
									<>{createButtonDisabledTooltip}</>
								</MyTooltipContent>
							</MyTooltip>
							<span id={createReasonId} className="sr-only">
								{createButtonDisabledTooltip}
							</span>
						</>
					) : (
						createButton
					)
				}
			/>

			<section className={"RouteRoles-section" satisfies RouteRoles_ClassNames}>
				<div>
					<h2 className={"RouteRoles-section-title" satisfies RouteRoles_ClassNames}>System roles</h2>
					<p className={"RouteRoles-section-description" satisfies RouteRoles_ClassNames}>
						These come with the app and cannot be changed. The owner is not listed: they can always do everything.
					</p>
				</div>

				<ul className={"RouteRoles-list" satisfies RouteRoles_ClassNames}>
					{access_control_SYSTEM_ROLES.map((role) => (
						<RouteRolesListItem
							key={role}
							name={access_control_SYSTEM_ROLE_MATRIX[role].label}
							permissions={access_control_SYSTEM_ROLE_MATRIX[role].permissions}
						/>
					))}
				</ul>
			</section>

			<section className={"RouteRoles-section" satisfies RouteRoles_ClassNames}>
				<div>
					<h2 className={"RouteRoles-section-title" satisfies RouteRoles_ClassNames}>Custom roles</h2>
					<p className={"RouteRoles-section-description" satisfies RouteRoles_ClassNames}>
						Roles you make yourself. They work in every workspace of this organization.
					</p>
				</div>

				{roles.length === 0 ? (
					<p className={"RouteRoles-section-empty" satisfies RouteRoles_ClassNames}>No custom roles yet.</p>
				) : (
					<ul className={"RouteRoles-list" satisfies RouteRoles_ClassNames}>
						{roles.map((role) => {
							// `update_role` and `delete_role` both refuse a role that grants a permission the user
							// does not hold, so that nobody can hand themselves more power than they have. Without
							// this the "manage roles" permission would quietly mean "give myself anything".
							//
							// The buttons stay and carry the reason instead of disappearing. A row with no buttons
							// next to rows that have them reads as a bug, and the user cannot tell that the rule is
							// deliberate. The header button is hidden for a different case: there the user cannot
							// manage roles at all, and its own tooltip already says so.
							const missingPermission =
								canManageRoles === true
									? role.permissions.find((permission) => !route_roles_can_hand_out(callerPermissions, permission))
									: undefined;

							return (
								<RouteRolesListItem
									key={role._id}
									roleId={role._id}
									name={role.name}
									description={role.description}
									permissions={role.permissions}
									inUse={role.assignmentCount > 0}
									changeDisabledReason={
										missingPermission
											? `You cannot change this role, because it gives "${access_control_PERMISSION_CATALOG[missingPermission].label}" and you do not have it yourself.`
											: undefined
									}
									onEdit={canManageRoles === true ? handleOpenEdit : undefined}
									onDelete={canManageRoles === true ? handleOpenDelete : undefined}
								/>
							);
						})}
					</ul>
				)}
			</section>

			<RouteRolesEditorModal
				open={editorOpen}
				editing={editorRoleId !== null}
				name={editorName}
				description={editorDescription}
				permissions={editorPermissions}
				callerPermissions={callerPermissions}
				saving={saving}
				onClose={handleCloseEditor}
				onNameChange={setEditorName}
				onDescriptionChange={setEditorDescription}
				onTogglePermission={handleTogglePermission}
				onSave={handleSave}
			/>

			<RouteRolesDeleteModal
				roleName={deleteTarget?.name ?? null}
				deleting={deleting}
				finalFocus={createButtonRef}
				onClose={handleCloseDeleteModal}
				onDelete={handleDelete}
			/>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/roles/")({
	component: RouteRoles,
});

export { Route };
// #endregion root
