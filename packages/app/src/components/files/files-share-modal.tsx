import "./files-share-modal.css";

import { useQueries, useQuery } from "convex/react";
import { Globe, Lock, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
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
	MySelect,
	MySelectItem,
	MySelectItemIndicator,
	MySelectItemsGroup,
	MySelectItemsGroupText,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { compute_fallback_user_name } from "@/lib/utils.ts";
import {
	access_control_FILE_SHARE_LEVEL_KEYS,
	access_control_FILE_SHARE_LEVELS,
	access_control_is_system_role,
	access_control_SYSTEM_ROLE_MATRIX,
	access_control_SYSTEM_ROLES,
	type access_control_FileShareLevel,
	type access_control_RoleRef,
} from "../../../shared/access-control.ts";

// #region principal value
/** Who one share row is about. The same two kinds `files_sharing` accepts. */
type FilesSharePrincipal =
	| { kind: "user"; userId: app_convex_Id<"users"> }
	| { kind: "role"; role: access_control_RoleRef };

/**
 * One select value that stands for one principal.
 *
 * The kind prefix is what keeps the two apart: a custom role id and a user id are both plain Convex
 * ids, so without it they could collide. The server groups its grants by the same string.
 */
function files_share_principal_value(principal: FilesSharePrincipal) {
	return principal.kind === "user" ? `user:${principal.userId}` : `role:${principal.role}`;
}

function files_share_principal_from_value(value: string): FilesSharePrincipal | null {
	if (value.startsWith("user:")) {
		return { kind: "user", userId: value.slice("user:".length) as app_convex_Id<"users"> };
	}
	if (value.startsWith("role:")) {
		return { kind: "role", role: value.slice("role:".length) as access_control_RoleRef };
	}

	// The empty value of the "choose someone" placeholder lands here.
	return null;
}
// #endregion principal value

// #region entry row
type FilesShareModalEntry_ClassNames =
	| "FilesShareModalEntry"
	| "FilesShareModalEntry-icon"
	| "FilesShareModalEntry-main"
	| "FilesShareModalEntry-name"
	| "FilesShareModalEntry-meta"
	| "FilesShareModalEntry-actions"
	| "FilesShareModalEntry-level-trigger";

type FilesShareModalEntry_Props = {
	principal: FilesSharePrincipal;
	name: string;
	/** Shown under the name, e.g. what the level means or why this row cannot change. */
	meta: string;
	level: access_control_FileShareLevel | null;
	/** `false` renders the row read-only, with no select and no Remove. */
	editable: boolean;
	/** This row is the one being saved. */
	pending: boolean;
	/** A write is running somewhere in the dialog, so no control here may start a second one. */
	busy: boolean;
	onLevelChange: (principal: FilesSharePrincipal, level: access_control_FileShareLevel) => void;
	onRemove: (principal: FilesSharePrincipal) => void;
};

const FilesShareModalEntry = memo(function FilesShareModalEntry(props: FilesShareModalEntry_Props) {
	const { principal, name, meta, level, editable, pending, busy, onLevelChange, onRemove } = props;

	// `data-share-principal` is the only stable way a browser test can find one row: names are free
	// text and ids from `useId()` change on every render. It is listed as a selector in
	// `.agents/skills/app-playwriter-harness/references/app-map.md`.
	return (
		<li
			className={"FilesShareModalEntry" satisfies FilesShareModalEntry_ClassNames}
			data-share-principal={files_share_principal_value(principal)}
			data-share-level={level ?? undefined}
		>
			{principal.kind === "user" ? (
				<MyAvatar size="32px" className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames}>
					<MyAvatarImage alt={name} fallbackDelay={false} />
					<MyAvatarFallback>{compute_fallback_user_name(name)}</MyAvatarFallback>
				</MyAvatar>
			) : (
				<div className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames} aria-hidden>
					<ShieldCheck />
				</div>
			)}

			<div className={"FilesShareModalEntry-main" satisfies FilesShareModalEntry_ClassNames}>
				<span className={"FilesShareModalEntry-name" satisfies FilesShareModalEntry_ClassNames}>{name}</span>
				<span className={"FilesShareModalEntry-meta" satisfies FilesShareModalEntry_ClassNames}>{meta}</span>
			</div>

			<div className={"FilesShareModalEntry-actions" satisfies FilesShareModalEntry_ClassNames}>
				{level === null ? (
					<MyBadge variant="secondary">Full access</MyBadge>
				) : editable ? (
					<MySelect
						value={level}
						setValue={(value) => onLevelChange(principal, value as access_control_FileShareLevel)}
					>
						{/* The row being saved keeps its own control enabled. Disabling the element the user
						    just used drops keyboard focus to the page, and they lose their place in the list.
						    A second write cannot start anyway: the handlers refuse while one is running. */}
						<MySelectTrigger disabled={busy && !pending}>
							<MyButton
								type="button"
								variant="outline"
								className={"FilesShareModalEntry-level-trigger" satisfies FilesShareModalEntry_ClassNames}
								aria-label={`Access level for ${name}`}
								aria-busy={pending || undefined}
							>
								<span>{pending ? "Saving..." : access_control_FILE_SHARE_LEVELS[level].label}</span>
								<MySelectOpenIndicator />
							</MyButton>
						</MySelectTrigger>
						{/* `unmountOnHide` because the popover portals out of this row: without it every closed
						    row's option list stays in the DOM and a test matching on level names finds many. */}
						<MySelectPopover unmountOnHide>
							<MySelectPopoverContent>
								{access_control_FILE_SHARE_LEVEL_KEYS.map((levelKey) => (
									<MySelectItem key={levelKey} value={levelKey} data-share-level={levelKey}>
										{access_control_FILE_SHARE_LEVELS[levelKey].label}
										{level === levelKey ? <MySelectItemIndicator /> : null}
									</MySelectItem>
								))}
							</MySelectPopoverContent>
						</MySelectPopover>
					</MySelect>
				) : (
					<MyBadge variant="outline">
						{/* Hidden text, not `aria-label`: ARIA forbids naming a plain span. */}
						<span className="sr-only">Access: </span>
						{access_control_FILE_SHARE_LEVELS[level].label}
					</MyBadge>
				)}

				{editable && level !== null ? (
					<MyIconButton
						variant="ghost_destructive"
						tooltip={`Remove ${name}`}
						disabled={busy && !pending}
						aria-busy={pending || undefined}
						onClick={() => onRemove(principal)}
					>
						<Trash2 aria-hidden />
					</MyIconButton>
				) : null}
			</div>
		</li>
	);
});
// #endregion entry row

// #region root
type FilesShareModal_ClassNames =
	| "FilesShareModal"
	| "FilesShareModal-body"
	| "FilesShareModal-status"
	| "FilesShareModal-status-icon"
	| "FilesShareModal-status-main"
	| "FilesShareModal-status-title"
	| "FilesShareModal-status-text"
	| "FilesShareModal-status-actions"
	| "FilesShareModal-add"
	| "FilesShareModal-add-principal-trigger"
	| "FilesShareModal-add-level-trigger"
	| "FilesShareModal-list"
	| "FilesShareModal-loading"
	| "FilesShareModal-footer-spacer";

export type FilesShareModal_Props = {
	/** The node the dialog is about. `null` keeps it closed. */
	nodeId: app_convex_Id<"files_nodes"> | null;
	onClose: () => void;
};

/** A name that has not arrived, or that failed to load, reads the same way the file tree writes it. */
function read_display_name(
	value: app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error,
) {
	return value == null || value instanceof Error ? "Unknown" : value.displayName;
}

export const FilesShareModal = memo(function FilesShareModal(props: FilesShareModal_Props) {
	const { nodeId, onClose } = props;

	const { organizationId, workspaceId, membershipId } = AppTenantProvider.useContext();

	// Set when the user steps from a node up to the restricted folder that decides its access. It is
	// keyed by the node it was opened from, so opening the dialog on another node drops it without an
	// effect.
	const [scopeStep, setScopeStep] = useState<{
		fromNodeId: app_convex_Id<"files_nodes">;
		nodeId: app_convex_Id<"files_nodes">;
	} | null>(null);
	const viewNodeId = scopeStep && scopeStep.fromNodeId === nodeId ? scopeStep.nodeId : nodeId;

	const [addPrincipalValue, setAddPrincipalValue] = useState("");
	const [addLevel, setAddLevel] = useState<access_control_FileShareLevel>("read");
	/** The one row, or button, waiting for an answer. Every write here is a single small call. */
	const [pendingKey, setPendingKey] = useState<string | null>(null);
	const listRef = useRef<HTMLUListElement>(null);
	/** Where focus goes when the write a button started replaces the branch that button lived in. */
	const dialogRef = useRef<HTMLDivElement>(null);
	const addPrincipalTriggerRef = useRef<HTMLButtonElement>(null);

	const shareState = useQuery(
		app_convex_api.files_sharing.get_node_share_state,
		viewNodeId ? { membershipId, nodeId: viewNodeId } : "skip",
	);
	const workspaceUserIds = useQuery(
		app_convex_api.organizations.list_organization_workspace_users,
		viewNodeId ? { organizationId, workspaceId } : "skip",
	);
	// Any active member may read this, so the picker can show custom role names to everybody. The
	// server still refuses a change the caller is not allowed to make.
	const customRoles = useQuery(app_convex_api.access_control.list_roles, viewNodeId ? { organizationId } : "skip");

	// Everybody the dialog has to name: the workspace members it can offer, the owner's fixed row, and
	// anybody already on the list who has since left the workspace.
	// The react compiler cannot memoize a value built from a hook result, so these two are by hand.
	const namedUserIds = useMemo(() => {
		const userIds = new Set<app_convex_Id<"users">>(workspaceUserIds ?? []);
		if (shareState) {
			userIds.add(shareState.organizationOwnerUserId);
			for (const entry of shareState.entries) {
				if (entry.principal.kind === "user") {
					userIds.add(entry.principal.userId);
				}
			}
		}

		return [...userIds];
	}, [workspaceUserIds, shareState]);

	const userAnagraphicQueryProps = useMemo(
		() =>
			Object.fromEntries(
				namedUserIds.map(
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
		[namedUserIds],
	);

	const userAnagraphicDict = useQueries(userAnagraphicQueryProps) as Record<
		app_convex_Id<"users">,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error
	>;

	const handleClose = useFn(() => {
		if (pendingKey) {
			return;
		}

		setScopeStep(null);
		setAddPrincipalValue("");
		setAddLevel("read");
		onClose();
	});

	/** Every write here answers the same way, so they all report through this. */
	const runShareWrite = useFn(
		(args: {
			key: string;
			request: Promise<{ _nay?: { message: string } }>;
			successMessage: string;
			/** Runs only when the server said yes, so a refusal leaves the form as the user left it. */
			onDone?: () => void;
		}) => {
			setPendingKey(args.key);
			args.request
				.then((result) => {
					if (result._nay) {
						console.error("[FilesShareModal.runShareWrite] Failed to change sharing:", {
							error: result._nay,
							nodeId: viewNodeId,
							key: args.key,
						});
						// The server message is the real reason: the last manager, a level the caller cannot give
						// away, or a person who left the workspace. A generic "Failed" would leave them stuck.
						toast.error(result._nay.message);
						return;
					}

					toast.success(args.successMessage);
					args.onDone?.();
				})
				.catch((error) => {
					console.error("[FilesShareModal.runShareWrite] Failed to change sharing:", {
						error,
						nodeId: viewNodeId,
						key: args.key,
					});
					toast.error("Failed to change sharing");
				})
				.finally(() => {
					setPendingKey(null);
				});
		},
	);

	const handleRestrict = useFn(() => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		runShareWrite({
			key: "restrict",
			request: app_convex.mutation(app_convex_api.files_sharing.restrict_node, { membershipId, nodeId: viewNodeId }),
			successMessage: "Access restricted",
			// This button goes away with the branch the new state replaces, so focus would fall to the page.
			// The dialog is the one part always there, and it reads out the name and the state that changed.
			onDone: () => dialogRef.current?.focus(),
		});
	});

	const handleUnrestrict = useFn(() => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		runShareWrite({
			key: "unrestrict",
			request: app_convex.mutation(app_convex_api.files_sharing.unrestrict_node, { membershipId, nodeId: viewNodeId }),
			successMessage: "Restriction removed",
			onDone: () => dialogRef.current?.focus(),
		});
	});

	const handleAdd = useFn(() => {
		const principal = files_share_principal_from_value(addPrincipalValue);
		if (!viewNodeId || !principal || pendingKey) {
			return;
		}

		runShareWrite({
			key: "add",
			request: app_convex.mutation(app_convex_api.files_sharing.set_node_share_grant, {
				membershipId,
				nodeId: viewNodeId,
				principal,
				level: addLevel,
			}),
			successMessage: "Access granted",
			// Clearing the selection disables Add, so focus would fall to the page. The picker is where the
			// next one is chosen, and somebody sharing a file usually adds more than one.
			onDone: () => {
				setAddPrincipalValue("");
				addPrincipalTriggerRef.current?.focus();
			},
		});
	});

	const handleLevelChange = useFn((principal: FilesSharePrincipal, level: access_control_FileShareLevel) => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		runShareWrite({
			key: files_share_principal_value(principal),
			request: app_convex.mutation(app_convex_api.files_sharing.set_node_share_grant, {
				membershipId,
				nodeId: viewNodeId,
				principal,
				level,
			}),
			successMessage: "Access updated",
		});
	});

	const handleRemove = useFn((principal: FilesSharePrincipal) => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		runShareWrite({
			key: files_share_principal_value(principal),
			request: app_convex.mutation(app_convex_api.files_sharing.remove_node_share_grant, {
				membershipId,
				nodeId: viewNodeId,
				principal,
			}),
			successMessage: "Access removed",
			// The row holding the focused button is gone now, so focus would fall to the page and a
			// keyboard user would be left outside the dialog. The list is the nearest thing still there,
			// and it announces itself by its label.
			onDone: () => listRef.current?.focus(),
		});
	});

	const handleStepIntoScope = useFn(() => {
		if (!nodeId || !shareState?.scope) {
			return;
		}

		setScopeStep({ fromNodeId: nodeId, nodeId: shareState.scope.nodeId });
		// The step points the dialog at the folder and drops this button with the branch it was in, so park
		// focus on the dialog itself.
		dialogRef.current?.focus();
	});

	const scope = shareState?.scope ?? null;
	const canEditList = Boolean(shareState?.canManage && scope?.isSelf);
	const nodeKindText = shareState?.nodeKind === "folder" ? "folder" : "file";
	/** One write at a time. Every control says so, so nothing here is clickable but does nothing. */
	const busy = pendingKey !== null;

	// Wait for the names too, not only for the list. Rendering earlier would show every row as
	// "Unknown" and then swap the names in under the user's mouse.
	const loading =
		shareState === undefined ||
		workspaceUserIds === undefined ||
		customRoles === undefined ||
		namedUserIds.some((userId) => userAnagraphicDict[userId] === undefined);

	const roleName = (role: access_control_RoleRef) =>
		access_control_is_system_role(role)
			? access_control_SYSTEM_ROLE_MATRIX[role].label
			: (customRoles?.find((candidate) => candidate._id === role)?.name ?? "Deleted role");

	const entries = (shareState?.entries ?? [])
		.map((entry) => ({
			principal: entry.principal as FilesSharePrincipal,
			level: entry.level,
			name:
				entry.principal.kind === "user"
					? read_display_name(userAnagraphicDict[entry.principal.userId])
					: roleName(entry.principal.role),
		}))
		// People first, then roles, and by name inside each. A share list is short, so one stable order
		// matters more than any ranking.
		.sort((a, b) =>
			a.principal.kind === b.principal.kind ? a.name.localeCompare(b.name) : a.principal.kind === "user" ? -1 : 1,
		);

	const takenPrincipalValues = new Set(entries.map((entry) => files_share_principal_value(entry.principal)));
	// The owner is left out: they already pass every check and hold no grant, so a row for them would
	// be a switch that changes nothing.
	const candidateUsers = (workspaceUserIds ?? [])
		.filter(
			(userId) =>
				userId !== shareState?.organizationOwnerUserId &&
				!takenPrincipalValues.has(files_share_principal_value({ kind: "user", userId })),
		)
		.map((userId) => ({ userId, name: read_display_name(userAnagraphicDict[userId]) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const candidateRoles = [
		...access_control_SYSTEM_ROLES.map((role) => ({ role: role as access_control_RoleRef })),
		...(customRoles ?? []).map((role) => ({ role: role._id as access_control_RoleRef })),
	]
		.filter((candidate) => !takenPrincipalValues.has(files_share_principal_value({ kind: "role", ...candidate })))
		.map((candidate) => ({ role: candidate.role, name: roleName(candidate.role) }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const addDisabled = addPrincipalValue === "" || busy;
	const selectedPrincipal = files_share_principal_from_value(addPrincipalValue);
	const selectedCandidateName = !selectedPrincipal
		? null
		: selectedPrincipal.kind === "user"
			? read_display_name(userAnagraphicDict[selectedPrincipal.userId])
			: roleName(selectedPrincipal.role);

	return (
		<MyModal open={nodeId !== null} setOpen={(open) => !open && handleClose()}>
			{/* Escape must not close a dialog that is mid-write: `pendingKey` would stay set and the next
			    dialog would open frozen. Same rule as the role editor. */}
			<MyModalPopover
				ref={dialogRef}
				className={"FilesShareModal" satisfies FilesShareModal_ClassNames}
				hideOnEscape={!busy}
				data-files-share-modal=""
			>
				<MyModalHeader>
					<MyModalHeading>{shareState ? `Share ${shareState.nodeName}` : "Share"}</MyModalHeading>
					<MyModalDescription>
						{scope
							? `Only the people and roles below can open this ${nodeKindText}.`
							: `Choose who can open this ${nodeKindText}.`}
					</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea>
					{loading ? (
						<div
							className={"FilesShareModal-loading" satisfies FilesShareModal_ClassNames}
							role="status"
							aria-live="polite"
						>
							<Lock aria-hidden />
							Loading sharing...
						</div>
					) : !shareState ? (
						<div className={"FilesShareModal-loading" satisfies FilesShareModal_ClassNames} role="alert">
							{/* `shareState` is null here, so its kind is unknown. Say neither. */}
							This is not available.
						</div>
					) : (
						<div className={"FilesShareModal-body" satisfies FilesShareModal_ClassNames}>
							{/* `data-share-scope` says which of the three states this is, so a browser test never has
							    to read the wording. */}
							<div
								className={"FilesShareModal-status" satisfies FilesShareModal_ClassNames}
								data-share-scope={scope ? (scope.isSelf ? "self" : "inherited") : "open"}
							>
								<div className={"FilesShareModal-status-icon" satisfies FilesShareModal_ClassNames} aria-hidden>
									{scope ? <Lock /> : <Globe />}
								</div>

								<div className={"FilesShareModal-status-main" satisfies FilesShareModal_ClassNames}>
									<span className={"FilesShareModal-status-title" satisfies FilesShareModal_ClassNames}>
										{!scope
											? "Everyone in this workspace"
											: scope.isSelf
												? "Restricted"
												: `Shared through ${scope.name}`}
									</span>
									<span className={"FilesShareModal-status-text" satisfies FilesShareModal_ClassNames}>
										{!scope
											? `Anybody whose role lets them read workspace content can open this ${nodeKindText}.`
											: scope.isSelf
												? "A workspace role does not open this on its own. Only the people and roles listed below, plus the organization owner."
												: `The folder ${scope.path} decides who can open this ${nodeKindText}.`}
									</span>
								</div>

								{shareState.canManage ? (
									<div className={"FilesShareModal-status-actions" satisfies FilesShareModal_ClassNames}>
										{!scope ? (
											<MyButton
												disabled={busy}
												aria-busy={pendingKey === "restrict" || undefined}
												onClick={handleRestrict}
											>
												<Lock aria-hidden />
												{pendingKey === "restrict" ? "Restricting..." : "Restrict access"}
											</MyButton>
										) : !scope.isSelf ? (
											<>
												<MyButton variant="outline" disabled={busy} onClick={handleStepIntoScope}>
													Manage {scope.name}
												</MyButton>
												<MyButton
													variant="outline"
													disabled={busy}
													aria-busy={pendingKey === "restrict" || undefined}
													onClick={handleRestrict}
												>
													{pendingKey === "restrict" ? "Restricting..." : "Restrict separately"}
												</MyButton>
											</>
										) : null}
									</div>
								) : null}
							</div>

							{canEditList ? (
								<div className={"FilesShareModal-add" satisfies FilesShareModal_ClassNames}>
									<MySelect value={addPrincipalValue} setValue={(value) => setAddPrincipalValue(value as string)}>
										{/* Stays enabled while its own add runs, same reason as a row's level trigger:
										    `handleAdd` puts focus back here, and a disabled button cannot take it. */}
										<MySelectTrigger disabled={busy && pendingKey !== "add"}>
											<MyButton
												ref={addPrincipalTriggerRef}
												type="button"
												variant="outline"
												className={"FilesShareModal-add-principal-trigger" satisfies FilesShareModal_ClassNames}
												aria-label="Person or role to add"
												data-share-add-principal={addPrincipalValue}
											>
												<span>{selectedCandidateName ?? "Add a person or role"}</span>
												<MySelectOpenIndicator />
											</MyButton>
										</MySelectTrigger>
										<MySelectPopover unmountOnHide sameWidth>
											<MySelectPopoverScrollableArea>
												<MySelectPopoverContent>
													<MySelectItemsGroup>
														<MySelectItemsGroupText>People</MySelectItemsGroupText>
														{candidateUsers.length === 0 ? (
															<MySelectItem value="" disabled>
																Everyone is already on the list
															</MySelectItem>
														) : (
															candidateUsers.map((candidate) => {
																const value = files_share_principal_value({
																	kind: "user",
																	userId: candidate.userId,
																});

																return (
																	<MySelectItem key={value} value={value} data-share-principal={value}>
																		{candidate.name}
																		{addPrincipalValue === value ? <MySelectItemIndicator /> : null}
																	</MySelectItem>
																);
															})
														)}
													</MySelectItemsGroup>
													<MySelectItemsGroup separator>
														<MySelectItemsGroupText>Roles</MySelectItemsGroupText>
														{candidateRoles.length === 0 ? (
															<MySelectItem value="" disabled>
																Every role is already on the list
															</MySelectItem>
														) : (
															candidateRoles.map((candidate) => {
																const value = files_share_principal_value({
																	kind: "role",
																	role: candidate.role,
																});

																return (
																	<MySelectItem key={value} value={value} data-share-principal={value}>
																		{candidate.name}
																		{addPrincipalValue === value ? <MySelectItemIndicator /> : null}
																	</MySelectItem>
																);
															})
														)}
													</MySelectItemsGroup>
												</MySelectPopoverContent>
											</MySelectPopoverScrollableArea>
										</MySelectPopover>
									</MySelect>

									<MySelect value={addLevel} setValue={(value) => setAddLevel(value as access_control_FileShareLevel)}>
										<MySelectTrigger disabled={busy}>
											<MyButton
												type="button"
												variant="outline"
												className={"FilesShareModal-add-level-trigger" satisfies FilesShareModal_ClassNames}
												aria-label="Access level for the new person or role"
												data-share-level={addLevel}
											>
												<span>{access_control_FILE_SHARE_LEVELS[addLevel].label}</span>
												<MySelectOpenIndicator />
											</MyButton>
										</MySelectTrigger>
										<MySelectPopover unmountOnHide>
											<MySelectPopoverContent>
												{access_control_FILE_SHARE_LEVEL_KEYS.map((levelKey) => (
													<MySelectItem key={levelKey} value={levelKey} data-share-level={levelKey}>
														{access_control_FILE_SHARE_LEVELS[levelKey].label}
														{addLevel === levelKey ? <MySelectItemIndicator /> : null}
													</MySelectItem>
												))}
											</MySelectPopoverContent>
										</MySelectPopover>
									</MySelect>

									<MyButton disabled={addDisabled} aria-busy={pendingKey === "add" || undefined} onClick={handleAdd}>
										<Plus aria-hidden />
										{pendingKey === "add" ? "Adding..." : "Add"}
									</MyButton>
								</div>
							) : null}

							{scope ? (
								<ul
									ref={listRef}
									// Not reachable by Tab, but `handleRemove` can put focus here once the row a user
									// was standing on is removed.
									tabIndex={-1}
									className={"FilesShareModal-list" satisfies FilesShareModal_ClassNames}
									aria-label="People and roles with access"
								>
									<FilesShareModalEntry
										principal={{ kind: "user", userId: shareState.organizationOwnerUserId }}
										name={read_display_name(userAnagraphicDict[shareState.organizationOwnerUserId])}
										meta="Organization owner"
										level={null}
										editable={false}
										pending={false}
										busy={busy}
										onLevelChange={handleLevelChange}
										onRemove={handleRemove}
									/>

									{entries.map((entry) => (
										<FilesShareModalEntry
											key={files_share_principal_value(entry.principal)}
											principal={entry.principal}
											name={entry.name}
											meta={
												entry.principal.kind === "role"
													? `Everyone with the ${entry.name} role`
													: access_control_FILE_SHARE_LEVELS[entry.level].description
											}
											level={entry.level}
											editable={canEditList}
											pending={pendingKey === files_share_principal_value(entry.principal)}
											busy={busy}
											onLevelChange={handleLevelChange}
											onRemove={handleRemove}
										/>
									))}
								</ul>
							) : null}
						</div>
					)}
				</MyModalScrollableArea>

				<MyModalFooter>
					{shareState?.canManage && scope?.isSelf ? (
						<>
							<MyButton
								variant="outline_destructive"
								disabled={busy}
								aria-busy={pendingKey === "unrestrict" || undefined}
								onClick={handleUnrestrict}
							>
								{pendingKey === "unrestrict" ? "Removing..." : "Stop restricting"}
							</MyButton>
							<div className={"FilesShareModal-footer-spacer" satisfies FilesShareModal_ClassNames} />
						</>
					) : null}
					<MyButton variant="ghost" disabled={busy} onClick={handleClose}>
						Done
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={busy} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion root
