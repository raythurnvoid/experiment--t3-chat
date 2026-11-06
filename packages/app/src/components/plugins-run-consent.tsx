import "./plugins-run-consent.css";

import { usePaginatedQuery, useQuery } from "convex/react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { MyCheckboxButton } from "@/components/my-checkbox-button.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputLabel } from "@/components/my-input.tsx";
import { MyRadioButton, MyRadioButtonLabel } from "@/components/my-radio-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionArgs,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";

export type PluginsRunConsent_Value = Pick<
	app_convex_FunctionArgs<typeof app_convex_api.plugins_access.grant_run_as_me>,
	"scopes"
>;

const SCOPE_CHOICES = [
	{
		scope: "files:list",
		capability: "workspace.files.read",
		label: "List my selected files",
		management: false,
	},
	{
		scope: "files:read",
		capability: "workspace.files.read",
		label: "Read my selected files",
		management: false,
	},
	{
		scope: "plugin_data:read",
		capability: "plugin.data.read",
		label: "Read this plugin's stored data",
		management: false,
	},
	{
		scope: "plugin_data:write",
		capability: "plugin.data.write",
		label: "Write this plugin's stored data",
		management: false,
	},
	{
		scope: "volumes:write",
		capability: "workspace.volumes.write",
		label: "Write read-only Mounts, billed to the owner",
		management: true,
	},
	{
		scope: "secrets:read",
		capability: "plugin.secrets.read",
		label: "Read this installation's secrets",
		management: true,
	},
	{
		scope: "outbound:fetch",
		capability: "outbound.fetch",
		label: "Call its allowed outside origins",
		management: true,
	},
] as const;

type PluginsRunConsent_ClassNames = "PluginsRunConsent" | "PluginsRunConsent-scopes" | "PluginsRunConsent-note";

/**
 * The same direct consent is used by first install and My run permissions.
 */
export const PluginsRunConsent = memo(function PluginsRunConsent(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	capabilities: readonly string[];
	canManage: boolean;
	initialScopes?: PluginsRunConsent_Value["scopes"];
	disabled?: boolean;
	onChange: (consent: PluginsRunConsent_Value | null) => void;
}) {
	const { membershipId, capabilities, canManage, initialScopes, disabled, onChange } = props;
	const groupName = useId();
	const choices = SCOPE_CHOICES.filter((choice) => capabilities.includes(choice.capability));
	const [scopes, setScopes] = useState<PluginsRunConsent_Value["scopes"]>(() =>
		choices
			.filter((choice) => (!choice.management || canManage) && (!initialScopes || initialScopes.includes(choice.scope)))
			.map((choice) => choice.scope),
	);
	const [confirmed, setConfirmed] = useState(false);
	const needsPluginDataRead = capabilities.includes("plugin.data.read") || capabilities.includes("plugin.data.write");
	const needsPluginDataWrite = capabilities.includes("plugin.data.write");
	const canReadWorkspace = useQuery(
		app_convex_api.access_control.get_current_user_workspace_permission,
		needsPluginDataRead ? { membershipId, permission: "content.read" } : "skip",
	);
	const canWriteWorkspace = useQuery(
		app_convex_api.access_control.get_current_user_workspace_permission,
		needsPluginDataWrite ? { membershipId, permission: "content.write" } : "skip",
	);
	const canReadPluginData = capabilities.includes("plugin.data.read") && canReadWorkspace === true;
	const canWritePluginData = canReadPluginData && canWriteWorkspace === true && scopes.includes("plugin_data:read");
	const checkingPluginData =
		needsPluginDataRead &&
		(canReadWorkspace === undefined || (needsPluginDataWrite && canWriteWorkspace === undefined));
	const selectedScopes = useMemo(
		() =>
			scopes.filter((scope) =>
				SCOPE_CHOICES.some(
					(choice) =>
						choice.scope === scope &&
						capabilities.includes(choice.capability) &&
						(!choice.management || canManage) &&
						(scope !== "plugin_data:read" || canReadPluginData) &&
						(scope !== "plugin_data:write" || canWritePluginData),
				),
			),
		[scopes, capabilities, canManage, canReadPluginData, canWritePluginData],
	);
	const notifyChange = useFn(onChange);

	useEffect(() => {
		notifyChange(confirmed && !checkingPluginData ? { scopes: selectedScopes } : null);
	}, [confirmed, checkingPluginData, selectedScopes, notifyChange]);

	return (
		<div className={"PluginsRunConsent" satisfies PluginsRunConsent_ClassNames}>
			<p className={"PluginsRunConsent-note" satisfies PluginsRunConsent_ClassNames}>
				A manager may select you for scheduled runs. File operations use your choices in My file permissions. Other
				operations still check your current access and this plugin's accepted permissions.
			</p>
			<div className={"PluginsRunConsent-scopes" satisfies PluginsRunConsent_ClassNames}>
				{choices.map((choice) => (
					<MyCheckboxButton
						key={choice.scope}
						name={groupName}
						variant="outline"
						checked={selectedScopes.includes(choice.scope)}
						disabled={
							disabled ||
							(choice.management && !canManage) ||
							(choice.scope === "plugin_data:read" && !canReadPluginData) ||
							(choice.scope === "plugin_data:write" && !canWritePluginData)
						}
						onCheckedChange={(checked) =>
							setScopes((current) =>
								checked
									? [...current, choice.scope]
									: current.filter(
											(scope) =>
												scope !== choice.scope &&
												(choice.scope !== "plugin_data:read" || scope !== "plugin_data:write"),
										),
							)
						}
					>
						{choice.label}
					</MyCheckboxButton>
				))}
			</div>
			{checkingPluginData ? <p role="status">Checking stored data access…</p> : null}
			{needsPluginDataRead && canReadWorkspace === false ? (
				<p className={"PluginsRunConsent-note" satisfies PluginsRunConsent_ClassNames}>
					Stored data needs workspace read access. You can still allow file operations; choose their files in My file
					permissions.
				</p>
			) : null}
			{needsPluginDataWrite && canReadWorkspace === true && canWriteWorkspace === false ? (
				<p className={"PluginsRunConsent-note" satisfies PluginsRunConsent_ClassNames}>
					Stored data writes need workspace write access.
				</p>
			) : null}
			{choices.some((choice) => choice.management) && !canManage ? (
				<p className={"PluginsRunConsent-note" satisfies PluginsRunConsent_ClassNames}>
					Mount writes, secrets, and outside requests need installation management access.
				</p>
			) : null}
			<MyCheckboxButton
				variant="outline"
				checked={confirmed}
				disabled={disabled || checkingPluginData}
				onCheckedChange={setConfirmed}
			>
				Allow this plugin to run as me while I am signed out.
			</MyCheckboxButton>
		</div>
	);
});

type PluginsMyRunPermissions_ClassNames =
	| "PluginsMyRunPermissions"
	| "PluginsMyRunPermissions-actions"
	| "PluginsMyRunPermissions-feedback";

export const PluginsMyRunPermissions = memo(function PluginsMyRunPermissions(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations">;
	canManage: boolean;
}) {
	const { membershipId, installationId, canManage } = props;
	const permission = useQuery(app_convex_api.plugins_access.get_my_run_as_grant, { membershipId, installationId });
	const [consent, setConsent] = useState<PluginsRunConsent_Value | null>(null);
	const [pending, setPending] = useState<"grant" | "revoke" | null>(null);
	const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
	const feedbackRef = useRef<HTMLParagraphElement | null>(null);
	const [focusFeedback, setFocusFeedback] = useState(false);
	const handleConsentChange = useFn((value: PluginsRunConsent_Value | null) => {
		setConsent(value);
		setFeedback((current) => (current?.error ? null : current));
	});
	const handleGrant = useFn(() => {
		if (!consent || pending) return;
		setPending("grant");
		setFeedback(null);
		app_convex
			.mutation(app_convex_api.plugins_access.grant_run_as_me, { membershipId, installationId, ...consent })
			.then((result) => {
				setFeedback(
					result._nay
						? { error: true, message: result._nay.message }
						: { error: false, message: "Your run permissions were saved." },
				);
				setFocusFeedback(true);
			})
			.catch((error: unknown) => {
				console.error("[PluginsMyRunPermissions] Could not grant run permissions", { error });
				setFeedback({ error: true, message: "Could not save your run permissions." });
			})
			.finally(() => setPending(null));
	});
	const handleRevoke = useFn(() => {
		if (!permission?.grant || pending) return;
		setPending("revoke");
		setFeedback(null);
		app_convex
			.mutation(app_convex_api.plugins_access.revoke_run_as_me, { membershipId, installationId })
			.then((result) => {
				setFeedback(
					result._nay
						? { error: true, message: result._nay.message }
						: { error: false, message: "Your run permissions were revoked. Work running as you was stopped." },
				);
				setFocusFeedback(true);
			})
			.catch((error: unknown) => {
				console.error("[PluginsMyRunPermissions] Could not revoke run permissions", { error });
				setFeedback({ error: true, message: "Could not revoke your run permissions." });
			})
			.finally(() => setPending(null));
	});

	useEffect(() => {
		if (!focusFeedback) return;
		setFocusFeedback(false);
		feedbackRef.current?.focus();
	}, [focusFeedback]);

	if (permission === undefined) return <p role="status">Loading My run permissions…</p>;
	if (permission === null) return null;

	return (
		<section
			className={"PluginsMyRunPermissions" satisfies PluginsMyRunPermissions_ClassNames}
			aria-label="My run permissions"
		>
			<h2>My run permissions</h2>
			<p>
				{permission.isAssigned ? "You are the selected scheduled user." : "You are not the selected scheduled user."}
			</p>
			{permission.grant ? (
				<p>
					{permission.grant.valid
						? "Permission granted for this workspace membership. File access comes from My file permissions."
						: "Your permission must be granted again."}
				</p>
			) : (
				<p>You have not granted permission to run as you.</p>
			)}
			<PluginsRunConsent
				key={`${installationId}:${permission.grant?.grantId ?? "new"}`}
				membershipId={membershipId}
				capabilities={permission.capabilities}
				canManage={canManage}
				initialScopes={permission.grant?.scopes}
				disabled={pending !== null}
				onChange={handleConsentChange}
			/>
			{feedback ? (
				<p
					ref={feedbackRef}
					tabIndex={-1}
					role={feedback.error ? "alert" : "status"}
					className={"PluginsMyRunPermissions-feedback" satisfies PluginsMyRunPermissions_ClassNames}
				>
					{feedback.message}
				</p>
			) : null}
			<div className={"PluginsMyRunPermissions-actions" satisfies PluginsMyRunPermissions_ClassNames}>
				<MyButton
					disabled={!consent && pending !== "grant"}
					aria-disabled={pending !== null || undefined}
					aria-busy={pending === "grant" || undefined}
					onClick={handleGrant}
				>
					Save my run permissions
				</MyButton>
				{permission.grant ? (
					<MyButton
						variant="ghost_destructive"
						aria-disabled={pending !== null || undefined}
						aria-busy={pending === "revoke" || undefined}
						onClick={handleRevoke}
					>
						Revoke my run permissions
					</MyButton>
				) : null}
			</div>
		</section>
	);
});

type PluginsMyFilePermissions_ClassNames =
	| "PluginsMyFilePermissions"
	| "PluginsMyFilePermissions-target"
	| "PluginsMyFilePermissions-choices"
	| "PluginsMyFilePermissions-list"
	| "PluginsMyFilePermissions-item"
	| "PluginsMyFilePermissions-note"
	| "PluginsMyFilePermissions-feedback";

export const PluginsMyFilePermissions = memo(function PluginsMyFilePermissions(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations">;
}) {
	const { membershipId, installationId } = props;
	const groupName = useId();
	const scopeGroupName = useId();
	const [scope, setScope] = useState<"file" | "workspace">("file");
	const [path, setPath] = useState("");
	const [selectedFileId, setSelectedFileId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	const [level, setLevel] =
		useState<app_convex_FunctionArgs<typeof app_convex_api.plugins_access.grant_file_access_as_me>["level"]>("read");
	const [showPathError, setShowPathError] = useState(false);
	const [pending, setPending] = useState<"grant" | app_convex_Id<"plugins_file_consents"> | null>(null);
	const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
	const feedbackRef = useRef<HTMLParagraphElement | null>(null);
	const [focusFeedback, setFocusFeedback] = useState(false);
	const target = useQuery(
		app_convex_api.files_nodes.get_visible_target_by_path,
		scope === "file" && path.trim() ? { membershipId, path: path.trim() } : "skip",
	);
	const savedTarget = target?.target.kind === "saved" ? target.target : null;
	// Null selects the workspace. Undefined means no target was chosen.
	const selectedRootNodeId =
		scope === "workspace" ? null : savedTarget && savedTarget.id === selectedFileId ? savedTarget.id : undefined;
	const grants = usePaginatedQuery(
		app_convex_api.plugins_access.list_my_file_grants,
		{ membershipId, installationId },
		{ initialNumItems: 20 },
	);
	const pathMessage = path.trim()
		? target === undefined
			? undefined
			: savedTarget
				? undefined
				: "Choose a saved file or folder you can read."
		: "Enter the path of a saved file or folder you can read.";
	const handleGrant = useFn(() => {
		if (selectedRootNodeId === undefined || pending) return;
		setPending("grant");
		setFeedback(null);
		app_convex
			.mutation(app_convex_api.plugins_access.grant_file_access_as_me, {
				membershipId,
				installationId,
				rootNodeId: selectedRootNodeId,
				level,
			})
			.then((result) => {
				setFeedback(
					result._nay
						? { error: true, message: result._nay.message }
						: { error: false, message: "Your file permission was saved. The change is pending." },
				);
				setFocusFeedback(true);
			})
			.catch((error: unknown) => {
				console.error("[PluginsMyFilePermissions] Could not save file permission", { error });
				setFeedback({ error: true, message: "Could not save your file permission." });
				setFocusFeedback(true);
			})
			.finally(() => setPending(null));
	});
	const handleRevoke = useFn((consentId: app_convex_Id<"plugins_file_consents">) => {
		if (pending) return;
		setPending(consentId);
		setFeedback(null);
		app_convex
			.mutation(app_convex_api.plugins_access.revoke_file_access_as_me, { membershipId, installationId, consentId })
			.then((result) => {
				setFeedback(
					result._nay
						? { error: true, message: result._nay.message }
						: { error: false, message: "Your file permission was removed." },
				);
				setFocusFeedback(true);
			})
			.catch((error: unknown) => {
				console.error("[PluginsMyFilePermissions] Could not remove file permission", { error });
				setFeedback({ error: true, message: "Could not remove your file permission." });
				setFocusFeedback(true);
			})
			.finally(() => setPending(null));
	});

	useEffect(() => {
		if (!focusFeedback) return;
		setFocusFeedback(false);
		feedbackRef.current?.focus();
	}, [focusFeedback]);

	return (
		<section
			className={"PluginsMyFilePermissions" satisfies PluginsMyFilePermissions_ClassNames}
			aria-label="My file permissions"
		>
			<h2>My file permissions</h2>
			<p className={"PluginsMyFilePermissions-note" satisfies PluginsMyFilePermissions_ClassNames}>
				Choose the files, folders or whole workspace this plugin may use for you. This does not allow scheduled runs.
			</p>
			<p className={"PluginsMyFilePermissions-note" satisfies PluginsMyFilePermissions_ClassNames}>
				Access changes apply in the background. The plugin keeps its current access until each change finishes.
			</p>
			<div className={"PluginsMyFilePermissions-choices" satisfies PluginsMyFilePermissions_ClassNames}>
				<MyRadioButton
					name={scopeGroupName}
					checked={scope === "file"}
					disabled={pending !== null}
					onChange={() => {
						setScope("file");
						setFeedback(null);
					}}
				>
					<MyRadioButtonLabel>File or folder</MyRadioButtonLabel>
				</MyRadioButton>
				<MyRadioButton
					name={scopeGroupName}
					checked={scope === "workspace"}
					disabled={pending !== null}
					onChange={() => {
						setScope("workspace");
						setFeedback(null);
					}}
				>
					<MyRadioButtonLabel>Whole workspace</MyRadioButtonLabel>
				</MyRadioButton>
			</div>
			{scope === "workspace" ? (
				<p className={"PluginsMyFilePermissions-note" satisfies PluginsMyFilePermissions_ClassNames}>
					Includes current and future open files. Restricted folders need separate permission.
				</p>
			) : (
				<>
					<MyInput displayValidationMessage={showPathError ? pathMessage : undefined}>
						<MyInputLabel>File or folder path</MyInputLabel>
						<MyInputArea>
							<MyInputBox />
							<MyInputControl
								value={path}
								disabled={pending !== null}
								placeholder="/shared/reports"
								validationMessage={pathMessage}
								onChange={(event) => {
									setPath(event.currentTarget.value);
									setSelectedFileId(null);
									setFeedback(null);
								}}
								onBlur={() => setShowPathError(true)}
							/>
						</MyInputArea>
					</MyInput>
					{showPathError && pathMessage ? <p role="alert">{pathMessage}</p> : null}
					{path.trim() && target === undefined ? <p role="status">Looking up this path...</p> : null}
					{savedTarget ? (
						<>
							<MyButton
								className={"PluginsMyFilePermissions-target" satisfies PluginsMyFilePermissions_ClassNames}
								variant="outline"
								disabled={pending !== null}
								onClick={() => setSelectedFileId(savedTarget.id)}
							>
								Use this {target?.kind}: {path.trim()}
							</MyButton>
							{selectedFileId === savedTarget.id ? (
								<p role="status">
									Selected {target?.kind}: {path.trim()}
								</p>
							) : null}
						</>
					) : null}
				</>
			)}
			<div className={"PluginsMyFilePermissions-choices" satisfies PluginsMyFilePermissions_ClassNames}>
				<MyRadioButton
					name={groupName}
					checked={level === "read"}
					disabled={pending !== null}
					onChange={() => setLevel("read")}
				>
					<MyRadioButtonLabel>Can view</MyRadioButtonLabel>
				</MyRadioButton>
				<MyRadioButton
					name={groupName}
					checked={level === "write"}
					disabled={pending !== null}
					onChange={() => setLevel("write")}
				>
					<MyRadioButtonLabel>Can edit</MyRadioButtonLabel>
				</MyRadioButton>
				<MyButton
					disabled={selectedRootNodeId === undefined && pending !== "grant"}
					aria-disabled={pending !== null || undefined}
					aria-busy={pending === "grant" || undefined}
					onClick={handleGrant}
				>
					Save
				</MyButton>
			</div>
			{feedback ? (
				<p
					ref={feedbackRef}
					tabIndex={-1}
					role={feedback.error ? "alert" : "status"}
					className={"PluginsMyFilePermissions-feedback" satisfies PluginsMyFilePermissions_ClassNames}
				>
					{feedback.message}
				</p>
			) : null}
			{grants.status === "LoadingFirstPage" ? <p role="status">Loading My file permissions…</p> : null}
			{grants.status !== "LoadingFirstPage" && grants.results.length === 0 ? (
				<p>No file permissions selected.</p>
			) : null}
			<ul className={"PluginsMyFilePermissions-list" satisfies PluginsMyFilePermissions_ClassNames}>
				{grants.results.map((grant) => (
					<li
						key={grant.consentId}
						className={"PluginsMyFilePermissions-item" satisfies PluginsMyFilePermissions_ClassNames}
						data-state={grant.state}
					>
						<p>{grant.rootNodeId === null ? "Whole workspace" : (grant.path ?? "Unavailable item")}</p>
						<p>Chosen: {grant.requestedLevel === "write" ? "Can edit" : "Can view"}</p>
						<p>
							Current:{" "}
							{grant.appliedLevel === "write" ? "Can edit" : grant.appliedLevel === "read" ? "Can view" : "No access"}
						</p>
						{grant.state === "pending" ? <p role="status">Change pending.</p> : null}
						{grant.state === "ended" ? <p>Ended. {grant.endedReason}</p> : null}
						{grant.open ? (
							<MyButton
								variant="ghost_destructive"
								aria-disabled={pending !== null || undefined}
								aria-busy={pending === grant.consentId || undefined}
								aria-label={`Remove permission for ${grant.rootNodeId === null ? "whole workspace" : (grant.path ?? "unavailable item")}`}
								onClick={() => handleRevoke(grant.consentId)}
							>
								Remove
							</MyButton>
						) : null}
					</li>
				))}
			</ul>
			{grants.status === "CanLoadMore" || grants.status === "LoadingMore" ? (
				<MyButton
					variant="outline"
					aria-disabled={grants.status === "LoadingMore" || undefined}
					aria-busy={grants.status === "LoadingMore" || undefined}
					onClick={() => {
						if (grants.status === "CanLoadMore") grants.loadMore(20);
					}}
				>
					Load more
				</MyButton>
			) : null}
		</section>
	);
});
