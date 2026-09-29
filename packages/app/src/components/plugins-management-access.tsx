import "./plugins-management-access.css";

import { useQueries, useQuery } from "convex/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { MyButton } from "@/components/my-button.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectItemsGroup,
	MySelectItemsGroupText,
	MySelectLabel,
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
	type app_convex_FunctionArgs,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import {
	access_control_is_system_role,
	access_control_SYSTEM_ROLE_MATRIX,
	access_control_SYSTEM_ROLES,
} from "../../shared/access-control.ts";

type ManagementAccess = Pick<
	app_convex_FunctionArgs<typeof app_convex_api.plugins_access.update_workspace_install_access>,
	"mode" | "principals"
>;

function principal_key(principal: ManagementAccess["principals"][number]) {
	return principal.kind === "user" ? `user:${principal.userId}` : `role:${principal.role}`;
}

type PluginsManagementAccess_ClassNames =
	| "PluginsManagementAccess"
	| "PluginsManagementAccess-controls"
	| "PluginsManagementAccess-list"
	| "PluginsManagementAccess-entry"
	| "PluginsManagementAccess-feedback";

/**
 * Workspace setup and one installation have separate management lists.
 */
export const PluginsManagementAccess = memo(function PluginsManagementAccess(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	organizationId: app_convex_Id<"organizations">;
	workspaceId: app_convex_Id<"organizations_workspaces">;
	installationId?: app_convex_Id<"plugins_workspace_installations">;
	onSaved?: () => void;
}) {
	const { membershipId, organizationId, workspaceId, installationId, onSaved } = props;
	const workspaceAccess = useQuery(
		app_convex_api.plugins_access.get_workspace_install_access,
		installationId ? "skip" : { membershipId },
	);
	const installationAccess = useQuery(
		app_convex_api.plugins_access.get_installation_access,
		installationId ? { membershipId, installationId } : "skip",
	);
	const access = installationId ? installationAccess : workspaceAccess;
	const canEdit = installationId ? access !== null : workspaceAccess?.canManageSettings === true;
	const workspaceUsers = useQuery(
		app_convex_api.organizations.list_organization_workspace_users,
		canEdit ? { organizationId, workspaceId } : "skip",
	);
	const roles = useQuery(app_convex_api.access_control.list_roles, canEdit ? { organizationId } : "skip");
	const [draft, setDraft] = useState<ManagementAccess | null>(null);
	const [addValue, setAddValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
	const feedbackRef = useRef<HTMLParagraphElement | null>(null);
	const saveButtonRef = useRef<HTMLButtonElement | null>(null);
	const principalTriggerRef = useRef<HTMLButtonElement | null>(null);
	const [focusFeedback, setFocusFeedback] = useState(false);
	const current = draft ?? (access?.mode ? { mode: access.mode, principals: access.principals } : null);
	const namedUserIds = useMemo(() => {
		const ids = new Set(workspaceUsers ?? []);
		if (access) ids.add(access.organizationOwnerUserId);
		for (const principal of current?.principals ?? []) {
			if (principal.kind === "user") ids.add(principal.userId);
		}
		return [...ids];
	}, [workspaceUsers, access, current?.principals]);
	const nameQueries = useMemo(
		() =>
			Object.fromEntries(
				namedUserIds.map((userId) => [
					userId,
					{
						query: app_convex_api.users.get_anagraphic,
						args: { userId },
					},
				]),
			),
		[namedUserIds],
	);
	const names = useQueries(nameQueries) as Record<
		string,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error
	>;
	const user_name = (userId: app_convex_Id<"users">) => {
		const person = names[userId];
		return person instanceof Error ? "Member unavailable" : (person?.displayName ?? "Workspace member");
	};
	const role_name = (role: Extract<ManagementAccess["principals"][number], { kind: "role" }>["role"]) =>
		access_control_is_system_role(role)
			? access_control_SYSTEM_ROLE_MATRIX[role].label
			: (roles?.find((candidate) => candidate._id === role)?.name ?? "Deleted role");
	const candidates = [
		...(workspaceUsers ?? [])
			.filter((userId) => userId !== access?.organizationOwnerUserId)
			.map((userId) => ({
				key: `user:${userId}`,
				principal: { kind: "user" as const, userId },
				name: user_name(userId),
			})),
		...access_control_SYSTEM_ROLES.map((role) => ({
			key: `role:${role}`,
			principal: { kind: "role" as const, role },
			name: access_control_SYSTEM_ROLE_MATRIX[role].label,
		})),
		...(roles ?? []).map((role) => ({
			key: `role:${role._id}`,
			principal: { kind: "role" as const, role: role._id },
			name: role.name,
		})),
	].filter((candidate) => !current?.principals.some((principal) => principal_key(principal) === candidate.key));
	const selected = candidates.find((candidate) => candidate.key === addValue);
	const handleSave = useFn(() => {
		if (!draft || saving || !canEdit) return;
		setSaving(true);
		setFeedback(null);
		const args = { membershipId, mode: draft.mode, principals: draft.mode === "selected" ? draft.principals : [] };
		const request = installationId
			? app_convex.mutation(app_convex_api.plugins_access.update_installation_access, { ...args, installationId })
			: app_convex.mutation(app_convex_api.plugins_access.update_workspace_install_access, args);
		request
			.then((result) => {
				setFeedback(
					result._nay
						? { error: true, message: result._nay.message }
						: { error: false, message: "Plugin access saved." },
				);
				if (!result._nay) {
					setDraft(null);
					// Removing your own access can remove this whole panel.
					onSaved?.();
				}
				if (document.activeElement === saveButtonRef.current) setFocusFeedback(true);
			})
			.catch((error: unknown) => {
				console.error("[PluginsManagementAccess] Could not save plugin access", { error });
				setFeedback({ error: true, message: "Could not save plugin access." });
			})
			.finally(() => setSaving(false));
	});

	useEffect(() => {
		if (!focusFeedback) return;
		setFocusFeedback(false);
		feedbackRef.current?.focus();
	}, [focusFeedback]);

	if (access === undefined) return <p role="status">Loading plugin access…</p>;
	if (!access || !canEdit || !current) return null;
	const loadingNames = namedUserIds.some((userId) => names[userId] === undefined);

	return (
		<section
			className={"PluginsManagementAccess" satisfies PluginsManagementAccess_ClassNames}
			aria-label={installationId ? "Plugin management access" : "Plugin setup access"}
		>
			<h2>{installationId ? "Plugin management access" : "Plugin setup access"}</h2>
			<p>
				{installationId
					? "Choose who can configure, disable, or manage this installation."
					: "Choose who can install new plugins in this workspace. Installers manage only the installation they create."}
			</p>
			<MySelect
				value={current.mode}
				setValue={(value) => {
					if (saving || (value !== "owner" && value !== "selected" && value !== "workspace")) return;
					setDraft({ ...current, mode: value });
					setFeedback(null);
				}}
			>
				<MySelectLabel>{installationId ? "Who can manage this plugin" : "Who can install plugins"}</MySelectLabel>
				<MySelectTrigger disabled={saving}>
					<MyButton variant="outline">
						{current.mode === "owner"
							? "Owner only"
							: current.mode === "workspace"
								? "Everybody in this workspace"
								: "Selected people and roles"}
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover>
					<MySelectPopoverContent>
						<MySelectItem value="owner">Owner only</MySelectItem>
						<MySelectItem value="selected">Selected people and roles</MySelectItem>
						<MySelectItem value="workspace">Everybody in this workspace</MySelectItem>
					</MySelectPopoverContent>
				</MySelectPopover>
			</MySelect>
			<p>{loadingNames ? "Loading names…" : user_name(access.organizationOwnerUserId)} (owner) always has access.</p>
			{current.mode === "selected" ? (
				<>
					<ul className={"PluginsManagementAccess-list" satisfies PluginsManagementAccess_ClassNames}>
						{current.principals.map((principal) => (
							<li
								key={principal_key(principal)}
								data-plugin-principal={principal_key(principal)}
								className={"PluginsManagementAccess-entry" satisfies PluginsManagementAccess_ClassNames}
							>
								<span>
									{principal.kind === "user" ? user_name(principal.userId) : `${role_name(principal.role)} (role)`}
								</span>
								<MyButton
									variant="ghost_destructive"
									disabled={saving}
									aria-label={`Remove ${principal.kind === "user" ? user_name(principal.userId) : role_name(principal.role)}`}
									onClick={() => {
										if (saving) return;
										principalTriggerRef.current?.focus();
										setDraft({
											...current,
											principals: current.principals.filter(
												(entry) => principal_key(entry) !== principal_key(principal),
											),
										});
										setFeedback(null);
									}}
								>
									Remove
								</MyButton>
							</li>
						))}
					</ul>
					<div className={"PluginsManagementAccess-controls" satisfies PluginsManagementAccess_ClassNames}>
						<MySelect
							value={addValue}
							setValue={(value) => {
								if (typeof value === "string" && !saving) setAddValue(value);
							}}
						>
							<MySelectLabel>Person or role to add</MySelectLabel>
							<MySelectTrigger disabled={saving || loadingNames || roles === undefined}>
								<MyButton ref={principalTriggerRef} variant="outline">
									{selected?.name ?? "Choose a person or role"}
									<MySelectOpenIndicator />
								</MyButton>
							</MySelectTrigger>
							<MySelectPopover>
								<MySelectPopoverScrollableArea>
									<MySelectPopoverContent>
										{(["user", "role"] as const).map((kind) => (
											<MySelectItemsGroup key={kind}>
												<MySelectItemsGroupText>{kind === "user" ? "People" : "Roles"}</MySelectItemsGroupText>
												{candidates
													.filter((candidate) => candidate.principal.kind === kind)
													.map((candidate) => (
														<MySelectItem key={candidate.key} value={candidate.key}>
															{candidate.name}
														</MySelectItem>
													))}
											</MySelectItemsGroup>
										))}
									</MySelectPopoverContent>
								</MySelectPopoverScrollableArea>
							</MySelectPopover>
						</MySelect>
						<MyButton
							variant="outline"
							disabled={!selected || saving || current.principals.length >= 50}
							onClick={() => {
								if (!selected || saving || current.principals.length >= 50) return;
								principalTriggerRef.current?.focus();
								setDraft({ ...current, principals: [...current.principals, selected.principal] });
								setAddValue("");
								setFeedback(null);
							}}
						>
							Add to access list
						</MyButton>
					</div>
					<p>{current.principals.length} of 50 people or roles. A role can be on at most 50 plugin access lists.</p>
				</>
			) : null}
			{current.mode === "workspace" ? (
				<p>
					Every active workspace member can use this access. This does not grant permission to run as another person.
				</p>
			) : null}
			{feedback ? (
				<p
					ref={feedbackRef}
					tabIndex={-1}
					role={feedback.error ? "alert" : "status"}
					className={"PluginsManagementAccess-feedback" satisfies PluginsManagementAccess_ClassNames}
				>
					{feedback.message}
				</p>
			) : null}
			<MyButton
				ref={saveButtonRef}
				disabled={!draft && !saving}
				aria-disabled={saving || undefined}
				aria-busy={saving || undefined}
				onClick={handleSave}
			>
				{saving ? "Saving…" : "Save plugin access"}
			</MyButton>
		</section>
	);
});
