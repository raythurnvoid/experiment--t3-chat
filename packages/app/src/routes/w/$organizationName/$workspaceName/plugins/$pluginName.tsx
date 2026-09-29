import "./plugin.css";

import { Editor, type EditorProps } from "@monaco-editor/react";
import { createFileRoute } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
	ChevronRight,
	CircleCheck,
	Clock3,
	Download,
	Ellipsis,
	GitBranch,
	HeartPulse,
	History,
	Info,
	KeyRound,
	Puzzle,
	Save,
	ServerCog,
	Settings2,
	ShieldCheck,
	Trash2,
	TriangleAlert,
	Unplug,
} from "lucide-react";
import { editor as monaco_editor } from "monaco-editor";
import { memo, useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { toast } from "sonner";

import { McpConnect } from "@/components/mcp-connect.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyCheckboxButton } from "@/components/my-checkbox-button.tsx";
import { ServiceAccountSelect } from "@/components/service-account-select.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectLabel,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
	MyInputTextAreaControl,
} from "@/components/my-input.tsx";
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
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { PluginsPublishButton } from "@/components/plugins-publish-button.tsx";
import { PluginsPublishSessionProvider } from "@/components/plugins-publish-session.tsx";
import { PluginsManagementAccess } from "@/components/plugins-management-access.tsx";
import {
	PluginsMyRunPermissions,
	PluginsRunConsent,
	type PluginsRunConsent_Value,
} from "@/components/plugins-run-consent.tsx";
import { useFn, useLiveRef } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_FunctionArgs,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { format_datetime } from "@/lib/date.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import {
	plugins_consent_diff,
	plugins_get_event_filter_values,
	plugins_parse_installation_configuration_yaml,
	plugins_parse_env_text,
	plugins_validate_secret_name,
	type plugins_McpServer,
} from "../../../../../../shared/plugins.ts";
import {
	access_control_FILE_SHARE_LEVEL_KEYS,
	access_control_FILE_SHARE_LEVELS,
	type access_control_FileShareLevel,
} from "../../../../../../shared/access-control.ts";

type RoutePlugins_Installation = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_installations
>[number];

type RoutePlugins_PublishedPlugin = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_published_plugins
>[number];

type RoutePlugins_PublisherPlugin = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.plugins.get_publisher_plugin>
>;

// #region health
type RoutePluginsPluginHealth_ClassNames =
	| "RoutePluginsPluginHealth"
	| "RoutePluginsPluginHealth-header"
	| "RoutePluginsPluginHealth-title"
	| "RoutePluginsPluginHealth-status"
	| "RoutePluginsPluginHealth-status-incomplete"
	| "RoutePluginsPluginHealth-list"
	| "RoutePluginsPluginHealthIssue"
	| "RoutePluginsPluginHealthIssue-icon"
	| "RoutePluginsPluginHealthIssue-icon-notice"
	| "RoutePluginsPluginHealthIssue-body"
	| "RoutePluginsPluginHealthIssue-title"
	| "RoutePluginsPluginHealthIssue-text"
	| "RoutePluginsPluginHealthIssue-note"
	| "RoutePluginsPluginHealthIssue-error";

type RoutePluginsPluginHealth_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	pluginName: string;
	onOpenSecrets: () => void;
};

const RoutePluginsPluginHealth = memo(function RoutePluginsPluginHealth(props: RoutePluginsPluginHealth_Props) {
	const { membershipId, pluginName, onOpenSecrets } = props;
	const health = useQuery(app_convex_api.plugins.get_installation_health, { membershipId, pluginName });

	const handleOpenActivity = () => {
		const activity = document.getElementById("app_plugin_activity_section" satisfies AppElementId);
		if (activity instanceof HTMLDetailsElement) {
			activity.open = true;
			activity.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	};

	// undefined is still loading; null means not installed or not a plugin manager.
	if (!health) {
		return null;
	}
	const hasMissingSecret = health.issues.some((issue) => issue.kind === "missing_secret");

	return (
		<section className={"RoutePluginsPluginHealth" satisfies RoutePluginsPluginHealth_ClassNames}>
			<header className={"RoutePluginsPluginHealth-header" satisfies RoutePluginsPluginHealth_ClassNames}>
				<h2 className={"RoutePluginsPluginHealth-title" satisfies RoutePluginsPluginHealth_ClassNames}>
					<HeartPulse aria-hidden />
					Health
				</h2>
				<p
					className={cn(
						"RoutePluginsPluginHealth-status" satisfies RoutePluginsPluginHealth_ClassNames,
						hasMissingSecret &&
							("RoutePluginsPluginHealth-status-incomplete" satisfies RoutePluginsPluginHealth_ClassNames),
					)}
				>
					{/* The capability notice alone must not demote the header: a plugin that runs fine
					    on publisher defaults would otherwise read "Needs attention" forever. */}
					{hasMissingSecret ? (
						<>
							<TriangleAlert aria-hidden />
							Installation incomplete
						</>
					) : health.issues.some((issue) => issue.kind === "recent_runs_failing") ? (
						<>
							<TriangleAlert aria-hidden />
							Needs attention
						</>
					) : (
						<>
							<CircleCheck aria-hidden />
							Installation healthy
						</>
					)}
				</p>
			</header>
			{health.issues.length > 0 ? (
				<ul className={"RoutePluginsPluginHealth-list" satisfies RoutePluginsPluginHealth_ClassNames}>
					{health.issues.map((issue) =>
						issue.kind === "missing_secret" ? (
							<li
								key={`missing_secret:${issue.name}`}
								className={"RoutePluginsPluginHealthIssue" satisfies RoutePluginsPluginHealth_ClassNames}
							>
								<TriangleAlert
									aria-hidden
									className={"RoutePluginsPluginHealthIssue-icon" satisfies RoutePluginsPluginHealth_ClassNames}
								/>
								<div className={"RoutePluginsPluginHealthIssue-body" satisfies RoutePluginsPluginHealth_ClassNames}>
									<div className={"RoutePluginsPluginHealthIssue-title" satisfies RoutePluginsPluginHealth_ClassNames}>
										Missing secret <code>{issue.name}</code>
									</div>
									<p className={"RoutePluginsPluginHealthIssue-text" satisfies RoutePluginsPluginHealth_ClassNames}>
										The installed version declares this secret as required, and no value is configured.
									</p>
									{/* Publisher-authored text: render it escaped and clearly attributed, never as markup. */}
									{issue.description.trim().length > 0 ? (
										<p className={"RoutePluginsPluginHealthIssue-note" satisfies RoutePluginsPluginHealth_ClassNames}>
											Publisher's note: {issue.description}
										</p>
									) : null}
								</div>
								<MyButton variant="outline" onClick={onOpenSecrets}>
									Manage secrets
								</MyButton>
							</li>
						) : issue.kind === "secrets_capability_unconfigured" ? (
							<li
								key="secrets_capability_unconfigured"
								className={"RoutePluginsPluginHealthIssue" satisfies RoutePluginsPluginHealth_ClassNames}
							>
								<Info
									aria-hidden
									className={cn(
										"RoutePluginsPluginHealthIssue-icon" satisfies RoutePluginsPluginHealth_ClassNames,
										"RoutePluginsPluginHealthIssue-icon-notice" satisfies RoutePluginsPluginHealth_ClassNames,
									)}
								/>
								<div className={"RoutePluginsPluginHealthIssue-body" satisfies RoutePluginsPluginHealth_ClassNames}>
									<div className={"RoutePluginsPluginHealthIssue-title" satisfies RoutePluginsPluginHealth_ClassNames}>
										No secrets configured
									</div>
									<p className={"RoutePluginsPluginHealthIssue-text" satisfies RoutePluginsPluginHealth_ClassNames}>
										This plugin can read workspace secrets; none are configured in this workspace. Configure them only
										if the plugin's documentation asks for them.
									</p>
								</div>
							</li>
						) : (
							<li
								key="recent_runs_failing"
								className={"RoutePluginsPluginHealthIssue" satisfies RoutePluginsPluginHealth_ClassNames}
							>
								<TriangleAlert
									aria-hidden
									className={"RoutePluginsPluginHealthIssue-icon" satisfies RoutePluginsPluginHealth_ClassNames}
								/>
								<div className={"RoutePluginsPluginHealthIssue-body" satisfies RoutePluginsPluginHealth_ClassNames}>
									<div className={"RoutePluginsPluginHealthIssue-title" satisfies RoutePluginsPluginHealth_ClassNames}>
										Recent runs are failing
									</div>
									<p className={"RoutePluginsPluginHealthIssue-text" satisfies RoutePluginsPluginHealth_ClassNames}>
										The last {issue.failedCount} finished runs all failed.
									</p>
									{/* Plugin-authored text, rendered escaped like the Activity list does. */}
									{issue.latestErrorMessage ? (
										<p className={"RoutePluginsPluginHealthIssue-error" satisfies RoutePluginsPluginHealth_ClassNames}>
											{issue.latestErrorMessage}
										</p>
									) : null}
								</div>
								<MyButton variant="outline" onClick={handleOpenActivity}>
									View activity
								</MyButton>
							</li>
						),
					)}
				</ul>
			) : null}
		</section>
	);
});
// #endregion health

// #region secrets modal panel
type RoutePluginsPluginSecretsModalPanel_ClassNames =
	| "RoutePluginsPluginSecretsModalPanel"
	| "RoutePluginsPluginSecretsModalPanel-note"
	| "RoutePluginsPluginSecretsModalPanel-empty"
	| "RoutePluginsPluginSecretsModalPanel-list"
	| "RoutePluginsPluginSecretsModalPanel-form"
	| "RoutePluginsPluginSecretsModalPanel-hint"
	| "RoutePluginsPluginSecretItem"
	| "RoutePluginsPluginSecretItem-identity"
	| "RoutePluginsPluginSecretItem-name"
	| "RoutePluginsPluginSecretItem-name-overridden"
	| "RoutePluginsPluginSecretItem-meta";

type RoutePluginsPluginSecretsModalPanel_Props = {
	target:
		| {
				scope: "workspace";
				membershipId: app_convex_Id<"organizations_workspaces_users">;
				installationId: app_convex_Id<"plugins_workspace_installations">;
				// Upserts require plugin.secrets.read on the installed version, but listing and deleting
				// deliberately do not, so leftover secrets stay removable after an upgrade drops the capability.
				canAdd: boolean;
				// Same-name plugin secrets are shadowed by these rows at runtime.
				pluginSecretNames: Set<string>;
		  }
		| {
				scope: "plugin";
				repositoryId: app_convex_Id<"plugins_publisher_repositories">;
				// Same-name workspace secrets shadow these rows at runtime; empty when that scope is not visible.
				workspaceSecretNames: Set<string>;
		  };
	secrets:
		| Array<
				| app_convex_FunctionReturnType<typeof app_convex_api.plugins.list_installation_secrets>[number]
				| app_convex_FunctionReturnType<typeof app_convex_api.plugins.list_publisher_repository_secrets>[number]
		  >
		| undefined;
	// Only the bare (untabbed) panel takes initial focus; with tabs the tab list is first-tabbable.
	autoFocusName: boolean;
};

const RoutePluginsPluginSecretsModalPanel = memo(function RoutePluginsPluginSecretsModalPanel(
	props: RoutePluginsPluginSecretsModalPanel_Props,
) {
	const { target, secrets, autoFocusName } = props;
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	// Run one secret action at a time. The buttons stay enabled while work is in flight and report
	// the wait with `aria-busy`, because a browser blurs a focused control the moment it becomes
	// disabled and nothing puts that focus back. The guards in the handlers, not disabled buttons,
	// stop a second press from starting the same action twice.
	const [saving, setSaving] = useState(false);
	// The name of the secret whose delete is in flight, so only that row reports busy.
	const [deleting, setDeleting] = useState<string | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const nameInputRef = useRef<HTMLInputElement | null>(null);
	const saveButtonRef = useRef<HTMLButtonElement | null>(null);

	const scopeLabel = target.scope === "workspace" ? "Workspace" : "Plugin";
	const canAdd = target.scope === "plugin" || target.canAdd;

	const handleSaveSecret = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (saving || deleting !== null || !name.trim() || !value) {
			return;
		}

		// Validating locally spares a doomed round-trip and a plugins_manage rate-limit token.
		const validName = plugins_validate_secret_name(name);
		if (validName._nay) {
			toast.error(validName._nay.message);
			return;
		}

		setSaving(true);
		const upsert: Promise<
			| app_convex_FunctionReturnType<typeof app_convex_api.plugins.upsert_installation_secret>
			| app_convex_FunctionReturnType<typeof app_convex_api.plugins.upsert_publisher_repository_secret>
		> =
			target.scope === "workspace"
				? app_convex.mutation(app_convex_api.plugins.upsert_installation_secret, {
						membershipId: target.membershipId,
						installationId: target.installationId,
						name: validName._yay,
						value,
					})
				: app_convex.mutation(app_convex_api.plugins.upsert_publisher_repository_secret, {
						repositoryId: target.repositoryId,
						name: validName._yay,
						value,
					});
		upsert
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`${scopeLabel} secret ${validName._yay} saved`);
				// The inputs stay enabled during the save, so only clear what the user has not retyped since.
				setName((current) => (current === name ? "" : current));
				setValue((current) => (current === value ? "" : current));
				// Clearing the fields disables the Save button again, and a browser blurs a focused
				// control the moment it becomes disabled. Send the focus to the Name input, where the
				// next secret starts, but only when the button was still holding it.
				if (document.activeElement === saveButtonRef.current) {
					nameInputRef.current?.focus();
				}
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleSaveSecret] Failed to save secret:", { error, scope: target.scope });
				toast.error("Failed to save secret");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	// Pasting .env-style text into either field saves every KEY=value line into this panel's scope.
	// A single KEY=value line only auto-fills the two fields from the Name input, so one-line values
	// that happen to contain "=" (base64, connection strings) paste normally into Value.
	const handleEnvPaste = useFn((event: ClipboardEvent<HTMLInputElement>, field: "name" | "value") => {
		const text = event.clipboardData.getData("text");
		const parsed = plugins_parse_env_text(text);
		if (parsed._nay || !parsed._yay[0]) {
			// The single-line input silently joins pasted lines, and values are write-only after saving,
			// so a mangled multi-line value could never be discovered — reject it instead.
			if (field === "value" && text.trim().includes("\n")) {
				event.preventDefault();
				toast.error("Multi-line values are not supported");
			}

			return;
		}

		const first = parsed._yay[0];
		if (!text.trim().includes("\n")) {
			if (field === "value") {
				return;
			}

			event.preventDefault();
			setName(first.name);
			setValue(first.value);
			return;
		}

		event.preventDefault();
		if (saving || deleting !== null) {
			toast.error("Cannot import secrets while a save or delete is in progress");
			return;
		}

		setSaving(true);
		const upsert: Promise<
			| app_convex_FunctionReturnType<typeof app_convex_api.plugins.upsert_installation_secrets>
			| app_convex_FunctionReturnType<typeof app_convex_api.plugins.upsert_publisher_repository_secrets>
		> =
			target.scope === "workspace"
				? app_convex.mutation(app_convex_api.plugins.upsert_installation_secrets, {
						membershipId: target.membershipId,
						installationId: target.installationId,
						secrets: parsed._yay,
					})
				: app_convex.mutation(app_convex_api.plugins.upsert_publisher_repository_secrets, {
						repositoryId: target.repositoryId,
						secrets: parsed._yay,
					});
		upsert
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Saved ${result._yay.count} ${target.scope} secret${result._yay.count === 1 ? "" : "s"}`);
				// The inputs stay enabled during the import, so only clear what the user has not retyped since.
				setName((current) => (current === name ? "" : current));
				setValue((current) => (current === value ? "" : current));
				// Clearing the fields disables the Save button again, and a browser blurs a focused
				// control the moment it becomes disabled. Send the focus to the Name input, where the
				// next secret starts, but only when the button was still holding it.
				if (document.activeElement === saveButtonRef.current) {
					nameInputRef.current?.focus();
				}
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleEnvPaste] Failed to import secrets:", { error, scope: target.scope });
				toast.error("Failed to import secrets");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	const handleDeleteSecret = useFn((secretName: string, button: HTMLButtonElement) => {
		if (saving || deleting !== null) {
			return;
		}

		setDeleting(secretName);
		const remove: Promise<
			| app_convex_FunctionReturnType<typeof app_convex_api.plugins.delete_installation_secret>
			| app_convex_FunctionReturnType<typeof app_convex_api.plugins.delete_publisher_repository_secret>
		> =
			target.scope === "workspace"
				? app_convex.mutation(app_convex_api.plugins.delete_installation_secret, {
						membershipId: target.membershipId,
						installationId: target.installationId,
						name: secretName,
					})
				: app_convex.mutation(app_convex_api.plugins.delete_publisher_repository_secret, {
						repositoryId: target.repositoryId,
						name: secretName,
					});
		remove
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`${scopeLabel} secret ${secretName} deleted`);
				// The deleted row unmounts when the list updates, and the focus a removed element held
				// falls to the page body. Send it to the panel instead, but only when the pressed button
				// was still holding it or the focus already fell.
				if (document.activeElement === button || document.activeElement === document.body) {
					panelRef.current?.focus();
				}
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleDeleteSecret] Failed to delete secret:", {
					error,
					scope: target.scope,
				});
				toast.error("Failed to delete secret");
			})
			.finally(() => {
				setDeleting(null);
			});
	});

	return (
		<div
			ref={panelRef}
			className={"RoutePluginsPluginSecretsModalPanel" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames}
			// A focus target for a finished delete, so the focus of the removed row does not fall to the body.
			tabIndex={-1}
		>
			<p
				className={"RoutePluginsPluginSecretsModalPanel-note" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames}
			>
				{target.scope === "workspace"
					? "Stored for this workspace only. A workspace secret overrides a plugin secret with the same name at runtime."
					: "Runtime defaults for every workspace that installs this plugin."}
			</p>

			{secrets === undefined ? (
				<div
					className={
						"RoutePluginsPluginSecretsModalPanel-empty" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
					}
					role="status"
				>
					Loading secrets...
				</div>
			) : secrets.length === 0 ? (
				<div
					className={
						"RoutePluginsPluginSecretsModalPanel-empty" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
					}
				>
					{target.scope === "workspace" ? "No workspace secrets yet." : "No plugin secrets yet."}
				</div>
			) : (
				<div
					className={
						"RoutePluginsPluginSecretsModalPanel-list" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
					}
				>
					{secrets.map((secret) => {
						const overridden = target.scope === "plugin" && target.workspaceSecretNames.has(secret.name);
						const overrides = target.scope === "workspace" && target.pluginSecretNames.has(secret.name);
						return (
							<div
								key={secret._id}
								className={"RoutePluginsPluginSecretItem" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames}
							>
								<div
									className={
										"RoutePluginsPluginSecretItem-identity" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
									}
								>
									<span
										className={cn(
											"RoutePluginsPluginSecretItem-name" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames,
											overridden &&
												("RoutePluginsPluginSecretItem-name-overridden" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames),
										)}
									>
										{secret.name}
									</span>
									<span
										className={
											"RoutePluginsPluginSecretItem-meta" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
										}
									>
										{`Updated ${format_datetime(secret.updatedAt)}${
											"lastUsedAt" in secret && secret.lastUsedAt !== null
												? ` · last used ${format_datetime(secret.lastUsedAt)}`
												: ""
										}${overridden ? " · overridden in this workspace" : ""}${
											overrides ? " · overrides the plugin default" : ""
										}`}
									</span>
								</div>
								<MyButton
									variant="ghost_destructive"
									tooltip={`Delete ${target.scope} secret ${secret.name}`}
									aria-busy={deleting === secret.name}
									onClick={(event) => handleDeleteSecret(secret.name, event.currentTarget)}
								>
									<Trash2 aria-hidden />
								</MyButton>
							</div>
						);
					})}
				</div>
			)}

			{canAdd ? (
				<>
					<form
						className={
							"RoutePluginsPluginSecretsModalPanel-form" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
						}
						onSubmit={handleSaveSecret}
					>
						<MyInput layout="stacked">
							<MyInputLabel>Name</MyInputLabel>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									ref={nameInputRef}
									value={name}
									placeholder="OPENAI_API_KEY"
									autoFocus={autoFocusName}
									required
									onChange={(event) => setName(event.currentTarget.value)}
									onPaste={(event) => handleEnvPaste(event, "name")}
								/>
							</MyInputArea>
							<MyInputBox />
						</MyInput>
						<MyInput layout="stacked">
							<MyInputLabel>Value</MyInputLabel>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									value={value}
									type="password"
									autoComplete="off"
									required
									onChange={(event) => setValue(event.currentTarget.value)}
									onPaste={(event) => handleEnvPaste(event, "value")}
								/>
							</MyInputArea>
							<MyInputBox />
						</MyInput>
						<MyButton ref={saveButtonRef} type="submit" aria-busy={saving} disabled={!name.trim() || !value}>
							<Save aria-hidden />
							{saving ? "Saving..." : "Save"}
						</MyButton>
					</form>
					<p
						className={
							"RoutePluginsPluginSecretsModalPanel-hint" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
						}
					>
						Paste .env-style text into Name to import several secrets at once.
					</p>
				</>
			) : (
				<p
					className={
						"RoutePluginsPluginSecretsModalPanel-note" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames
					}
				>
					The installed version does not request secret access, so new secrets cannot be added.
				</p>
			)}
		</div>
	);
});
// #endregion secrets modal panel

// #region secrets modal
type RoutePluginsPluginSecretsModal_ClassNames = "RoutePluginsPluginSecretsModal";

type RoutePluginsPluginSecretsModal_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations"> | null;
	installationCanAdd: boolean;
	publisherRepositoryId: app_convex_Id<"plugins_publisher_repositories"> | null;
	onClose: () => void;
};

const RoutePluginsPluginSecretsModal = memo(function RoutePluginsPluginSecretsModal(
	props: RoutePluginsPluginSecretsModal_Props,
) {
	const { membershipId, installationCanAdd, onClose } = props;
	// Snapshot at mount: a reactive flip of either id would re-parent the panel between the bare and
	// tabbed positions, remounting it and wiping half-typed input.
	const [{ installationId, publisherRepositoryId }] = useState(() => ({
		installationId: props.installationId,
		publisherRepositoryId: props.publisherRepositoryId,
	}));
	const workspaceSecrets = useQuery(
		app_convex_api.plugins.list_installation_secrets,
		installationId ? { membershipId, installationId } : "skip",
	);
	const pluginSecrets = useQuery(
		app_convex_api.plugins.list_publisher_repository_secrets,
		publisherRepositoryId ? { repositoryId: publisherRepositoryId } : "skip",
	);

	const workspacePanel = installationId ? (
		<RoutePluginsPluginSecretsModalPanel
			target={{
				scope: "workspace",
				membershipId,
				installationId,
				canAdd: installationCanAdd,
				pluginSecretNames: new Set((pluginSecrets ?? []).map((secret) => secret.name)),
			}}
			secrets={workspaceSecrets}
			autoFocusName={!publisherRepositoryId}
		/>
	) : null;
	const pluginPanel = publisherRepositoryId ? (
		<RoutePluginsPluginSecretsModalPanel
			target={{
				scope: "plugin",
				repositoryId: publisherRepositoryId,
				workspaceSecretNames: new Set((workspaceSecrets ?? []).map((secret) => secret.name)),
			}}
			secrets={pluginSecrets}
			autoFocusName={!installationId}
		/>
	) : null;

	return (
		<MyModal
			open
			setOpen={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<MyModalPopover className={"RoutePluginsPluginSecretsModal" satisfies RoutePluginsPluginSecretsModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>Manage secrets</MyModalHeading>
					<MyModalDescription>
						Values this plugin can read at runtime. Values are write-only and never shown after saving.
					</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					{workspacePanel && pluginPanel ? (
						// The tab doubles as the scope picker; workspace first so an inattentive add stays local.
						<MyTabs defaultSelectedId="workspace">
							<MyTabsList aria-label="Secret scope">
								<MyTabsTab id="workspace">Workspace secrets</MyTabsTab>
								<MyTabsTab id="plugin">Plugin secrets</MyTabsTab>
							</MyTabsList>
							<MyTabsPanels>
								<MyTabsPanel tabId="workspace">{workspacePanel}</MyTabsPanel>
								<MyTabsPanel tabId="plugin">{pluginPanel}</MyTabsPanel>
							</MyTabsPanels>
						</MyTabs>
					) : (
						(workspacePanel ?? pluginPanel)
					)}
				</MyModalScrollableArea>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion secrets modal

// #region secrets
type RoutePluginsPluginSecrets_ClassNames =
	| "RoutePluginsPluginSecrets"
	| "RoutePluginsPluginSecrets-header"
	| "RoutePluginsPluginSecrets-title"
	| "RoutePluginsPluginSecrets-description";

type RoutePluginsPluginSecrets_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations"> | null;
	installationCanAdd: boolean;
	publisherRepositoryId: app_convex_Id<"plugins_publisher_repositories"> | null;
	// Owned by the route so the Health section's "Manage secrets" action can open the same modal.
	managing: boolean;
	onManagingChange: (managing: boolean) => void;
};

const RoutePluginsPluginSecrets = memo(function RoutePluginsPluginSecrets(props: RoutePluginsPluginSecrets_Props) {
	const { membershipId, installationId, installationCanAdd, publisherRepositoryId, managing, onManagingChange } = props;
	// A non-publisher install without plugin.secrets.read only needs this section while leftover
	// secrets from a previous version remain deletable, so peek at the list in that rare case.
	// `managing` keeps the section (and the modal mounted inside it) alive while the user deletes
	// the last leftover; the section leaves once the modal closes.
	const leftoverSecrets = useQuery(
		app_convex_api.plugins.list_installation_secrets,
		installationId && !installationCanAdd && !publisherRepositoryId ? { membershipId, installationId } : "skip",
	);
	if (installationId && !installationCanAdd && !publisherRepositoryId && !leftoverSecrets?.length && !managing) {
		return null;
	}

	return (
		<section className={"RoutePluginsPluginSecrets" satisfies RoutePluginsPluginSecrets_ClassNames}>
			<header className={"RoutePluginsPluginSecrets-header" satisfies RoutePluginsPluginSecrets_ClassNames}>
				<h2 className={"RoutePluginsPluginSecrets-title" satisfies RoutePluginsPluginSecrets_ClassNames}>
					<KeyRound aria-hidden />
					Secrets
				</h2>
				<p className={"RoutePluginsPluginSecrets-description" satisfies RoutePluginsPluginSecrets_ClassNames}>
					Values this plugin can read at runtime.
				</p>
			</header>
			<MyButton variant="outline" onClick={() => onManagingChange(true)}>
				Manage secrets
			</MyButton>
			{/* Mounted per open so form state resets and the secret queries only subscribe while managing. */}
			{managing ? (
				<RoutePluginsPluginSecretsModal
					membershipId={membershipId}
					installationId={installationId}
					installationCanAdd={installationCanAdd}
					publisherRepositoryId={publisherRepositoryId}
					onClose={() => onManagingChange(false)}
				/>
			) : null}
		</section>
	);
});
// #endregion secrets

// #region service controls
type RoutePluginsPluginService_Registration = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.plugins.get_plugin_service_registration>
>;

type RoutePluginsPluginService_Scope = RoutePluginsPluginService_Registration["scopes"][number];

const ROUTE_PLUGINS_SERVICE_SCOPES: RoutePluginsPluginService_Scope[] = [
	"plugin_data:read",
	"plugin_data:write",
	"files:write",
];

type RoutePluginsPluginServiceControls_ClassNames =
	| "RoutePluginsPluginServiceControls"
	| "RoutePluginsPluginServiceControls-status"
	| "RoutePluginsPluginServiceControls-scopes"
	| "RoutePluginsPluginServiceControls-actions"
	| "RoutePluginsPluginServiceControls-secret"
	| "RoutePluginsPluginServiceControls-secret-value"
	| "RoutePluginsPluginServiceControls-secret-note";

type RoutePluginsPluginServiceControls_Props = {
	pluginName: string;
	registration: RoutePluginsPluginService_Registration;
};

const RoutePluginsPluginServiceControls = memo(function RoutePluginsPluginServiceControls(
	props: RoutePluginsPluginServiceControls_Props,
) {
	const { pluginName, registration } = props;
	const [selectedScopes, setSelectedScopes] = useState<RoutePluginsPluginService_Scope[]>(() =>
		registration.exists ? registration.scopes : [...ROUTE_PLUGINS_SERVICE_SCOPES],
	);
	// The plaintext exists only in this state, right after a generate. A refresh or any other
	// remount loses it for good, on purpose. The parent deliberately does not remount this
	// component when the registration row changes, so the just-issued secret survives that.
	const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const handleScopeChange = (scope: RoutePluginsPluginService_Scope, checked: boolean) => {
		setSelectedScopes((current) => {
			const next = current.filter((existing) => existing !== scope);
			if (checked) {
				next.push(scope);
			}
			return ROUTE_PLUGINS_SERVICE_SCOPES.filter((known) => next.includes(known));
		});
	};

	const handleGenerate = useFn(() => {
		if (busy) {
			return;
		}
		setBusy(true);
		app_convex
			.mutation(app_convex_api.plugins.set_plugin_service_registration, { pluginName, scopes: selectedScopes })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				setIssuedSecret(result._yay.exchangeSecret);
				toast.success(registration.exists ? "Service secret rotated" : "Service secret generated");
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleGenerate] Failed to set service registration:", { error });
				toast.error("Failed to update the service registration");
			})
			.finally(() => {
				setBusy(false);
			});
	});

	const handleRemove = useFn(() => {
		if (busy) {
			return;
		}

		setBusy(true);
		app_convex
			.mutation(app_convex_api.plugins.remove_plugin_service_registration, { pluginName })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				setIssuedSecret(null);
				// Removing drops the registration, so offer the full scope list again the way a
				// first-time publisher sees it.
				setSelectedScopes([...ROUTE_PLUGINS_SERVICE_SCOPES]);
				toast.success("Service registration removed");
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleRemove] Failed to remove service registration:", { error });
				toast.error("Failed to remove the service registration");
			})
			.finally(() => {
				setBusy(false);
			});
	});

	const handleCopySecret = useFn(() => {
		if (!issuedSecret) {
			return;
		}
		navigator.clipboard
			.writeText(issuedSecret)
			.then(() => {
				toast.success("Secret copied");
			})
			.catch((error: unknown) => {
				console.error("[RoutePluginsPlugin.handleCopySecret] Failed to copy secret:", { error });
				toast.error("Failed to copy the secret");
			});
	});

	return (
		<div className={"RoutePluginsPluginServiceControls" satisfies RoutePluginsPluginServiceControls_ClassNames}>
			<p className={"RoutePluginsPluginServiceControls-status" satisfies RoutePluginsPluginServiceControls_ClassNames}>
				{registration.exists && registration.updatedAt !== null
					? `Registered · updated ${format_datetime(registration.updatedAt)}`
					: "No service registered. Generate a secret to let a server exchange this plugin's page tokens for service grants."}
			</p>
			<div
				className={"RoutePluginsPluginServiceControls-scopes" satisfies RoutePluginsPluginServiceControls_ClassNames}
			>
				{ROUTE_PLUGINS_SERVICE_SCOPES.map((scope) => (
					<MyCheckboxButton
						key={scope}
						variant="outline"
						checked={selectedScopes.includes(scope)}
						disabled={busy}
						onCheckedChange={(checked) => handleScopeChange(scope, checked)}
					>
						{scope}
					</MyCheckboxButton>
				))}
			</div>
			<p>Leave all scopes off if the service only needs workspace identity and members.</p>
			<div
				className={"RoutePluginsPluginServiceControls-actions" satisfies RoutePluginsPluginServiceControls_ClassNames}
			>
				<MyButton variant="outline" aria-busy={busy || undefined} onClick={handleGenerate}>
					{registration.exists ? "Rotate secret" : "Generate secret"}
				</MyButton>
				{registration.exists ? (
					<MyButton variant="outline_destructive" aria-busy={busy || undefined} onClick={handleRemove}>
						Remove
					</MyButton>
				) : null}
			</div>
			{issuedSecret ? (
				<div
					className={"RoutePluginsPluginServiceControls-secret" satisfies RoutePluginsPluginServiceControls_ClassNames}
				>
					<div>
						<code
							className={
								"RoutePluginsPluginServiceControls-secret-value" satisfies RoutePluginsPluginServiceControls_ClassNames
							}
						>
							{issuedSecret}
						</code>
						<p
							className={
								"RoutePluginsPluginServiceControls-secret-note" satisfies RoutePluginsPluginServiceControls_ClassNames
							}
						>
							Shown once. Store it in the service's secret store; only its hash is kept here.
						</p>
					</div>
					<MyButton variant="outline" onClick={handleCopySecret}>
						Copy
					</MyButton>
				</div>
			) : null}
		</div>
	);
});
// #endregion service controls

// #region service
type RoutePluginsPluginService_ClassNames =
	| "RoutePluginsPluginService"
	| "RoutePluginsPluginService-header"
	| "RoutePluginsPluginService-title"
	| "RoutePluginsPluginService-description";

type RoutePluginsPluginService_Props = {
	pluginName: string;
};

const RoutePluginsPluginService = memo(function RoutePluginsPluginService(props: RoutePluginsPluginService_Props) {
	const { pluginName } = props;
	// Publisher-only: the query answers null for everyone else, and the section stays away.
	const registration = useQuery(app_convex_api.plugins.get_plugin_service_registration, { pluginName });
	if (!registration) {
		return null;
	}

	return (
		<section className={"RoutePluginsPluginService" satisfies RoutePluginsPluginService_ClassNames}>
			<header className={"RoutePluginsPluginService-header" satisfies RoutePluginsPluginService_ClassNames}>
				<h2 className={"RoutePluginsPluginService-title" satisfies RoutePluginsPluginService_ClassNames}>
					<ServerCog aria-hidden />
					Service
				</h2>
				<p className={"RoutePluginsPluginService-description" satisfies RoutePluginsPluginService_ClassNames}>
					The exchange secret a server of this plugin proves itself with.
				</p>
			</header>
			{/* Do not key this on the registration row. The plaintext secret lives only in the child's
			    state, and generating the first one flips `exists` from false to true, which would
			    remount the child and throw the secret away before the publisher could copy it. The
			    child resets its own checklist after a Remove instead. */}
			<RoutePluginsPluginServiceControls pluginName={pluginName} registration={registration} />
		</section>
	);
});
// #endregion service

// #region configuration
type RoutePluginsPluginConfiguration_ClassNames =
	| "RoutePluginsPluginConfiguration"
	| "RoutePluginsPluginConfiguration-header"
	| "RoutePluginsPluginConfiguration-title"
	| "RoutePluginsPluginConfiguration-description"
	| "RoutePluginsPluginConfiguration-example"
	| "RoutePluginsPluginConfiguration-editor"
	| "RoutePluginsPluginConfiguration-actions"
	| "RoutePluginsPluginConfiguration-status"
	| "RoutePluginsPluginConfiguration-status-error";

type RoutePluginsPluginConfiguration_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations">;
	configurationYaml: string;
	description: string;
	events: RoutePlugins_Installation["version"]["events"];
	mounts: RoutePlugins_Installation["version"]["mounts"];
};

type RoutePluginsPluginConfiguration_State = {
	draftYaml: string;
	serverYaml: string;
	feedback: { kind: "conflict" | "error" | "success"; message: string } | null;
};

const RoutePluginsPluginConfiguration = memo(function RoutePluginsPluginConfiguration(
	props: RoutePluginsPluginConfiguration_Props,
) {
	const { membershipId, installationId, configurationYaml, description, events, mounts } = props;
	const [configuration, setConfiguration] = useState<RoutePluginsPluginConfiguration_State>(() => ({
		draftYaml: configurationYaml,
		serverYaml: configurationYaml,
		feedback: null,
	}));
	const [saving, setSaving] = useState(false);
	// A saved draft equals the server text, and that legitimately disables the Save button below. A
	// browser blurs a focused control the moment it becomes disabled, so the focus a keyboard member
	// left on Save must be sent somewhere deliberate: the status line that announces the result.
	const [focusFeedback, setFocusFeedback] = useState(false);
	const saveButtonRef = useRef<HTMLButtonElement | null>(null);
	const feedbackRef = useRef<HTMLParagraphElement | null>(null);
	const configurationRef = useLiveRef(configuration);
	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	const hasPathFilter = events.some((event) =>
		event.filters.some((filter) => filter.field === "source.path" && filter.operator === "pathIsUnderAny"),
	);
	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);
	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones
	// option updates and DOM references in these options are cyclic.
	const [editorOptions] = useState(() => {
		return {
			overflowWidgetsDomNode: hoistingContainer ?? undefined,
			fixedOverflowWidgets: true,
			ariaLabel: "Plugin configuration YAML",
			// Let Tab reach the next control instead of changing YAML.
			tabFocusMode: true,
			automaticLayout: true,
			fontSize: 14,
			lineHeight: 20,
			minimap: { enabled: false },
			padding: { top: 12, bottom: 12 },
			scrollBeyondLastLine: false,
			wordWrap: "on",
		} satisfies NonNullable<EditorProps["options"]>;
	});

	const handleOnMount = useFn<EditorProps["onMount"]>((editor) => {
		editorRef.current = editor;
		editor.updateOptions({ readOnly: saving });
	});

	useEffect(() => {
		editorRef.current?.updateOptions({ readOnly: saving });
	}, [saving]);

	useEffect(() => {
		setConfiguration((current) => {
			const serverYaml = configurationYaml;
			if (serverYaml === current.serverYaml) {
				return current;
			}

			if (current.draftYaml === current.serverYaml) {
				return { draftYaml: serverYaml, serverYaml, feedback: null };
			}

			if (current.draftYaml === serverYaml) {
				return { ...current, serverYaml, feedback: null };
			}

			return {
				...current,
				serverYaml,
				feedback: {
					kind: "conflict",
					message: "Configuration changed elsewhere. Review this draft before saving it over the newer version.",
				},
			};
		});
	}, [configurationYaml]);

	const handleSave = useFn(() => {
		if (saving || configuration.draftYaml === configuration.serverYaml) {
			return;
		}

		// Use the shared parser first so invalid drafts do not spend a plugins_manage rate-limit token.
		const parsed = plugins_parse_installation_configuration_yaml({
			configurationYaml: configuration.draftYaml,
			events,
			mounts,
		});
		if (parsed._nay) {
			setConfiguration((current) => ({
				...current,
				feedback: { kind: "error", message: parsed._nay.message },
			}));
			toast.error(parsed._nay.message);
			return;
		}

		const yamlToSave = parsed._yay.configurationYaml;
		const serverYamlBeforeSave = configuration.serverYaml;
		setSaving(true);
		setConfiguration((current) => ({ ...current, feedback: null }));
		app_convex
			.mutation(app_convex_api.plugins.update_installation_configuration, {
				membershipId,
				installationId,
				configurationYaml: yamlToSave,
			})
			.then((result) => {
				if (result._nay) {
					setConfiguration((current) => ({
						...current,
						feedback:
							current.serverYaml !== serverYamlBeforeSave
								? {
										kind: "conflict",
										message: `${result._nay.message}. Configuration also changed elsewhere. Review this draft before saving again.`,
									}
								: { kind: "error", message: result._nay.message },
					}));
					toast.error(result._nay.message);
					return;
				}

				const current = configurationRef.current;
				let nextConfiguration: RoutePluginsPluginConfiguration_State;
				if (current.serverYaml !== serverYamlBeforeSave && current.serverYaml !== yamlToSave) {
					nextConfiguration = {
						...current,
						feedback: {
							kind: "conflict",
							message: "Configuration changed again while saving. Review this draft before saving again.",
						},
					};
				} else {
					nextConfiguration = {
						...current,
						serverYaml: yamlToSave,
						feedback:
							current.draftYaml === yamlToSave
								? { kind: "success", message: "Configuration saved" }
								: {
										kind: "conflict",
										message: "An earlier draft was saved. Review the current draft before saving again.",
									},
					};
				}

				// Read the focus before the state lands: the success re-render disables the button
				// (draft now equals server) and mounts the status line the effect below focuses.
				if (nextConfiguration.feedback?.kind === "success" && document.activeElement === saveButtonRef.current) {
					setFocusFeedback(true);
				}
				setConfiguration(nextConfiguration);
				if (nextConfiguration.feedback?.kind === "success") {
					toast.success("Plugin configuration saved");
				}
			})
			.catch((error) => {
				console.error("[RoutePluginsPluginConfiguration.handleSave] Failed to save plugin configuration:", {
					error,
					installationId,
				});
				setConfiguration((current) => ({
					...current,
					feedback:
						current.serverYaml !== serverYamlBeforeSave
							? {
									kind: "conflict",
									message:
										"Failed to save plugin configuration. Configuration also changed elsewhere. Review this draft before saving again.",
								}
							: { kind: "error", message: "Failed to save plugin configuration" },
				}));
				toast.error("Failed to save plugin configuration");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	useEffect(() => {
		if (!focusFeedback) {
			return;
		}
		setFocusFeedback(false);
		feedbackRef.current?.focus();
	}, [focusFeedback]);

	return (
		<section className={"RoutePluginsPluginConfiguration" satisfies RoutePluginsPluginConfiguration_ClassNames}>
			<header className={"RoutePluginsPluginConfiguration-header" satisfies RoutePluginsPluginConfiguration_ClassNames}>
				<h2 className={"RoutePluginsPluginConfiguration-title" satisfies RoutePluginsPluginConfiguration_ClassNames}>
					<Settings2 aria-hidden />
					Configuration
				</h2>
				<p
					className={"RoutePluginsPluginConfiguration-description" satisfies RoutePluginsPluginConfiguration_ClassNames}
				>
					{description}
				</p>
				{hasPathFilter ? (
					<p className={"RoutePluginsPluginConfiguration-example" satisfies RoutePluginsPluginConfiguration_ClassNames}>
						Path filters are case-sensitive. Use <code>/</code> for every folder and an empty list to stop automatic
						runs. Manual runs ignore automatic trigger filters.
					</p>
				) : null}
			</header>

			<div className={"RoutePluginsPluginConfiguration-editor" satisfies RoutePluginsPluginConfiguration_ClassNames}>
				{hoistingContainer ? (
					<Editor
						height="240px"
						language="yaml"
						theme={app_monaco_THEME_NAME_DARK}
						value={configuration.draftYaml}
						options={editorOptions}
						onMount={handleOnMount}
						onChange={(value) => {
							const draftYaml = value ?? "";
							setConfiguration((current) => ({
								...current,
								draftYaml,
								feedback:
									draftYaml !== current.serverYaml && current.feedback?.kind === "conflict" ? current.feedback : null,
							}));
						}}
					/>
				) : null}
			</div>

			<div className={"RoutePluginsPluginConfiguration-actions" satisfies RoutePluginsPluginConfiguration_ClassNames}>
				{configuration.feedback ? (
					<p
						className={cn(
							"RoutePluginsPluginConfiguration-status" satisfies RoutePluginsPluginConfiguration_ClassNames,
							configuration.feedback.kind !== "success" &&
								("RoutePluginsPluginConfiguration-status-error" satisfies RoutePluginsPluginConfiguration_ClassNames),
						)}
						role={configuration.feedback.kind === "success" ? "status" : "alert"}
						// A focus target for a finished save: the success disables the Save button and a
						// browser blurs a disabled control, so the focus lands here instead of the body.
						ref={feedbackRef}
						tabIndex={-1}
					>
						{configuration.feedback.message}
					</p>
				) : null}
				<MyButton
					ref={saveButtonRef}
					// Keep the button enabled while the save runs: disabling it would blur a keyboard
					// member. The handler's own guard stops a second press.
					disabled={configuration.draftYaml === configuration.serverYaml}
					aria-busy={saving}
					onClick={handleSave}
				>
					<Save aria-hidden />
					{saving ? "Saving..." : "Save configuration"}
				</MyButton>
			</div>
		</section>
	);
});
// #endregion configuration

// #region scheduled runs
type EligibleRunUser = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins_access.list_eligible_run_users
>["page"][number];

const RoutePluginsScheduledUserSelect = memo(function RoutePluginsScheduledUserSelect(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations">;
	value: string;
	includeMe?: boolean;
	disabled?: boolean;
	onChange: (user: EligibleRunUser | null) => void;
	onSelectionValidChange: (valid: boolean) => void;
}) {
	const { membershipId, installationId, value, includeMe, disabled, onChange, onSelectionValidChange } = props;
	const users = usePaginatedQuery(
		app_convex_api.plugins_access.list_eligible_run_users,
		{ membershipId, installationId },
		{ initialNumItems: 50 },
	);
	const selected = users.results.find((user) => user.grantId === value);
	const selectionValid = (includeMe && value === "me") || selected !== undefined;
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const [focusAfterLoad, setFocusAfterLoad] = useState(false);
	useEffect(() => {
		if (users.status === "LoadingFirstPage") return;
		onSelectionValidChange(selectionValid);
	}, [users.status, value, selectionValid, onSelectionValidChange]);
	useEffect(() => {
		if (!focusAfterLoad || users.status !== "Exhausted") return;
		setFocusAfterLoad(false);
		if (document.activeElement === document.body) triggerRef.current?.focus();
	}, [focusAfterLoad, users.status]);
	return (
		<div>
			<MySelect
				value={value}
				setValue={(next) => {
					if (disabled) return;
					if (includeMe && next === "me") onChange(null);
					else {
						const user = users.results.find((candidate) => candidate.grantId === next);
						if (user) onChange(user);
					}
				}}
			>
				<MySelectLabel>Run as</MySelectLabel>
				<MySelectTrigger disabled={disabled || users.status === "LoadingFirstPage"}>
					<MyButton ref={triggerRef} variant="outline">
						{includeMe && value === "me" ? "Me" : (selected?.displayName ?? "Choose a user who granted access")}
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover>
					<MySelectPopoverContent>
						{includeMe ? <MySelectItem value="me">Me</MySelectItem> : null}
						{users.results.map((user) => (
							<MySelectItem key={user.grantId} value={user.grantId}>
								{user.displayName}
							</MySelectItem>
						))}
					</MySelectPopoverContent>
				</MySelectPopover>
			</MySelect>
			{value && value !== "me" && !selected && users.status !== "LoadingFirstPage" ? (
				<p role="alert">The selected user's permission is no longer available. Choose a user again.</p>
			) : null}
			{users.status === "CanLoadMore" || users.status === "LoadingMore" ? (
				<MyButton
					variant="ghost"
					disabled={disabled}
					aria-disabled={users.status === "LoadingMore" || undefined}
					aria-busy={users.status === "LoadingMore" || undefined}
					onClick={(event) => {
						if (disabled || users.status !== "CanLoadMore") return;
						setFocusAfterLoad(document.activeElement === event.currentTarget);
						users.loadMore(50);
					}}
				>
					{users.status === "LoadingMore" ? "Loading users…" : "Load more users"}
				</MyButton>
			) : null}
			<p>Other people must grant their own permission in My run permissions before they appear here.</p>
		</div>
	);
});

type RoutePluginsSchedule_ClassNames =
	| "RoutePluginsSchedule"
	| "RoutePluginsSchedule-facts"
	| "RoutePluginsSchedule-actions"
	| "RoutePluginsSchedule-error";

const RoutePluginsSchedule = memo(function RoutePluginsSchedule(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations">;
	disabled: boolean;
}) {
	const { membershipId, installationId, disabled } = props;
	const schedule = useQuery(app_convex_api.plugins.get_installation_schedule, { membershipId, installationId });
	const [selectedUser, setSelectedUser] = useState<EligibleRunUser | null>(null);
	const [selectedUserValid, setSelectedUserValid] = useState(false);
	const [pending, setPending] = useState<"assign" | "run" | null>(null);
	const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
	const [focusFeedback, setFocusFeedback] = useState(false);
	const assignButtonRef = useRef<HTMLButtonElement | null>(null);
	const feedbackRef = useRef<HTMLParagraphElement | null>(null);
	useEffect(() => {
		// A saved assignment change replaces this form's old choice.
		setSelectedUser(null);
		setSelectedUserValid(false);
	}, [schedule?.userId, schedule?.grantId]);

	const handleAssign = useFn(() => {
		if (!selectedUser || !selectedUserValid || disabled || pending) return;
		setPending("assign");
		setFeedback(null);
		app_convex
			.mutation(app_convex_api.plugins_access.set_scheduled_run_user, {
				membershipId,
				installationId,
				userId: selectedUser.userId,
				grantId: selectedUser.grantId,
			})
			.then((result) => {
				// Read focus before the cleared choice disables this button.
				if (!result._nay && document.activeElement === assignButtonRef.current) {
					setFocusFeedback(true);
				}
				setFeedback(
					result._nay
						? { error: true, message: result._nay.message }
						: { error: false, message: "Scheduled user changed. Work under the old assignment was stopped." },
				);
			})
			.catch((error: unknown) => {
				console.error("[RoutePluginsSchedule] Could not change scheduled user", { error });
				setFeedback({ error: true, message: "Could not change the scheduled user." });
			})
			.finally(() => setPending(null));
	});
	const handleRun = useFn(() => {
		if (!schedule || schedule.status !== "enabled" || schedule.assignmentError || disabled || pending) return;
		setPending("run");
		setFeedback(null);
		app_convex
			.mutation(app_convex_api.plugins.run_schedule_now, { membershipId, installationId })
			.then((result) =>
				setFeedback(
					result._nay
						? { error: true, message: result._nay.message }
						: { error: false, message: "Scheduled run queued." },
				),
			)
			.catch((error: unknown) => {
				console.error("[RoutePluginsSchedule] Could not queue scheduled run", { error });
				setFeedback({ error: true, message: "Could not queue the scheduled run." });
			})
			.finally(() => setPending(null));
	});

	useEffect(() => {
		if (!focusFeedback) return;
		setFocusFeedback(false);
		feedbackRef.current?.focus();
	}, [focusFeedback]);

	if (schedule === undefined) return <p role="status">Loading schedule…</p>;
	if (schedule === null) return null;
	return (
		<section className={"RoutePluginsSchedule" satisfies RoutePluginsSchedule_ClassNames} aria-label="Schedule">
			<h2>Schedule</h2>
			<dl className={"RoutePluginsSchedule-facts" satisfies RoutePluginsSchedule_ClassNames}>
				<dt>Status</dt>
				<dd>{schedule.status === "enabled" ? "Enabled" : "Disabled"}</dd>
				<dt>Interval</dt>
				<dd>
					{schedule.intervalMinutes === null ? "Invalid configuration" : `Every ${schedule.intervalMinutes} minutes`}
				</dd>
				<dt>Run user</dt>
				<dd>{schedule.userName ?? "Choose a user"}</dd>
				<dt>Scheduled Mount writes billed to</dt>
				<dd>{schedule.payerName}</dd>
				<dt>Next run</dt>
				<dd>
					{schedule.status === "disabled"
						? "Paused while disabled"
						: schedule.nextRunAt === null
							? "Not scheduled"
							: format_datetime(schedule.nextRunAt)}
				</dd>
				<dt>Last result</dt>
				<dd>
					{schedule.lastRun
						? `${schedule.lastRun.status} · ${format_datetime(schedule.lastRun.updatedAt)}`
						: "No runs yet"}
				</dd>
			</dl>
			{schedule.assignmentError ? (
				<p role="alert" className={"RoutePluginsSchedule-error" satisfies RoutePluginsSchedule_ClassNames}>
					{schedule.assignmentError}. Choose a user with a current grant below.
				</p>
			) : null}
			{schedule.lastRun?.errorMessage ? (
				<p className={"RoutePluginsSchedule-error" satisfies RoutePluginsSchedule_ClassNames}>
					{schedule.lastRun.errorMessage}
				</p>
			) : null}
			<RoutePluginsScheduledUserSelect
				membershipId={membershipId}
				installationId={installationId}
				value={selectedUser?.grantId ?? ""}
				disabled={disabled || pending !== null}
				onChange={setSelectedUser}
				onSelectionValidChange={setSelectedUserValid}
			/>
			<p>
				The run user and payer are separate. Mount writes cost half a cent (0.5 cents) per new file. Up to 10,000 files
				can be billed per day.
			</p>
			{feedback ? (
				<p role={feedback.error ? "alert" : "status"} ref={feedbackRef} tabIndex={-1}>
					{feedback.message}
				</p>
			) : null}
			<div className={"RoutePluginsSchedule-actions" satisfies RoutePluginsSchedule_ClassNames}>
				<MyButton
					ref={assignButtonRef}
					disabled={(!selectedUser || !selectedUserValid || disabled) && pending !== "assign"}
					aria-disabled={pending !== null || undefined}
					aria-busy={pending === "assign" || undefined}
					onClick={handleAssign}
				>
					{pending === "assign" ? "Changing…" : "Change scheduled user"}
				</MyButton>
				<MyButton
					variant="outline"
					disabled={
						(disabled || schedule.status !== "enabled" || schedule.assignmentError !== null) && pending !== "run"
					}
					aria-disabled={pending !== null || undefined}
					aria-busy={pending === "run" || undefined}
					onClick={handleRun}
				>
					{pending === "run" ? "Queuing…" : "Run now"}
				</MyButton>
			</div>
		</section>
	);
});
// #endregion scheduled runs

// #region mounts
type RoutePluginsMounts_ClassNames =
	| "RoutePluginsMounts"
	| "RoutePluginsMounts-list"
	| "RoutePluginsMounts-volume"
	| "RoutePluginsMounts-usage";

const RoutePluginsMounts = memo(function RoutePluginsMounts(props: RoutePluginsInstalledRuns_Props) {
	const { membershipId, installationId } = props;
	const mounts = useQuery(app_convex_api.plugins.get_installation_mounts, { membershipId, installationId });
	if (mounts === undefined) return <p role="status">Loading Mounts…</p>;
	if (mounts === null || (mounts.mounts.length === 0 && mounts.volumes.length === 0)) return null;
	return (
		<section className={"RoutePluginsMounts" satisfies RoutePluginsMounts_ClassNames} aria-label="Mounts">
			<h2>Mounts</h2>
			<p>
				Read-only outside content for the chat agent. Everyone who can read workspace files can read these mounts.
				Folder sharing limits do not apply. Mounts do not appear in the Files sidebar.
			</p>
			<ul className={"RoutePluginsMounts-list" satisfies RoutePluginsMounts_ClassNames}>
				{mounts.mounts.map((mount) => (
					<li key={mount.mountId}>
						<code>/.mounts/{mount.name}</code>
						{!mounts.volumes.some((volume) => volume.mountId === mount.mountId) ? " · No published files yet" : ""}
					</li>
				))}
				{mounts.volumes.map((volume) => (
					<li
						key={volume.volumeId}
						className={"RoutePluginsMounts-volume" satisfies RoutePluginsMounts_ClassNames}
						data-mount-copy-status={volume.deleting ? "deleting" : volume.published ? "published" : "staging"}
					>
						<strong>
							{volume.mountName
								? `/.mounts/${volume.mountName}/${volume.volumeKey}`
								: `${volume.volumeKey} (removed mount)`}
						</strong>
						{volume.deleting ? <p>Deleting</p> : null}
						{volume.published ? (
							<p>
								Published · Revision: {volume.published.revision ?? "Hidden or not provided"} ·{" "}
								{volume.published.fileCount.toLocaleString()} files · {volume.published.bytes.toLocaleString()} bytes ·{" "}
								{volume.published.publishedAt === null
									? "Publish time not recorded"
									: format_datetime(volume.published.publishedAt)}
							</p>
						) : (
							<p>No published copy</p>
						)}
						{volume.staging ? (
							<p>
								Open staging copy · Revision: {volume.staging.revision ?? "Hidden or not provided"} ·{" "}
								{volume.staging.fileCount.toLocaleString()} files · {volume.staging.bytes.toLocaleString()} bytes ·{" "}
								{volume.staging.expiresAt === null
									? "Expiry not recorded"
									: `Expires ${format_datetime(volume.staging.expiresAt)}`}
							</p>
						) : null}
					</li>
				))}
			</ul>
			<div className={"RoutePluginsMounts-usage" satisfies RoutePluginsMounts_ClassNames}>
				<p>
					Storage in use: {mounts.usage.fileCount.toLocaleString()} of{" "}
					{mounts.limits.installationFiles.toLocaleString()} files · {mounts.usage.bytes.toLocaleString()} of{" "}
					{mounts.limits.installationBytes.toLocaleString()} bytes.
				</p>
				<p>
					{mounts.usage.dailyFilesLeft.toLocaleString()} of {mounts.limits.dailyFiles.toLocaleString()} new files left
					today. Half a cent (0.5 cents) per new file. Scheduled writes are billed to the organization owner. Other
					writes use this installation's billing settings.
				</p>
				<p>
					Each copy: {mounts.limits.copyFiles.toLocaleString()} files and {mounts.limits.copyBytes.toLocaleString()}{" "}
					bytes. Up to {mounts.limits.volumesPerMount} file trees per mount and {mounts.limits.volumesPerInstallation}{" "}
					per installation. Staging and retained copies count toward storage.
				</p>
			</div>
		</section>
	);
});
// #endregion mounts

// #region installed runs
type RoutePluginsInstalledRuns_ClassNames =
	| "RoutePluginsInstalledRuns"
	| "RoutePluginsInstalledRuns-summary"
	| "RoutePluginsInstalledRuns-chevron"
	| "RoutePluginsInstalledRuns-title"
	| "RoutePluginsInstalledRuns-description"
	| "RoutePluginsInstalledRuns-empty"
	| "RoutePluginsInstalledRuns-list"
	| "RoutePluginsInstalledRunItem"
	| "RoutePluginsInstalledRunItem-header"
	| "RoutePluginsInstalledRunItem-path"
	| "RoutePluginsInstalledRunItem-meta"
	| "RoutePluginsInstalledRunItem-error";

function format_run_duration(ms: number | undefined) {
	if (ms === undefined) return "not recorded";
	return `${ms} ms`;
}

type RoutePluginsInstalledRuns_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations">;
};

const RoutePluginsInstalledRuns = memo(function RoutePluginsInstalledRuns(props: RoutePluginsInstalledRuns_Props) {
	const { membershipId, installationId } = props;
	const runs = usePaginatedQuery(
		app_convex_api.plugins.list_run_history,
		{ membershipId, installationId },
		{ initialNumItems: 25 },
	);
	const [expandedRunId, setExpandedRunId] = useState<app_convex_Id<"plugins_event_runs"> | null>(null);
	const summaryRef = useRef<HTMLElement | null>(null);
	const [focusAfterLoad, setFocusAfterLoad] = useState(false);
	const calls = useQuery(
		app_convex_api.plugins.list_run_calls,
		expandedRunId ? { membershipId, installationId, runId: expandedRunId } : "skip",
	);
	useEffect(() => {
		if (!focusAfterLoad || runs.status !== "Exhausted") return;
		setFocusAfterLoad(false);
		if (document.activeElement === document.body) summaryRef.current?.focus();
	}, [focusAfterLoad, runs.status]);

	return (
		<details
			id={"app_plugin_activity_section" satisfies AppElementId}
			className={"RoutePluginsInstalledRuns" satisfies RoutePluginsInstalledRuns_ClassNames}
		>
			<summary
				ref={summaryRef}
				className={"RoutePluginsInstalledRuns-summary" satisfies RoutePluginsInstalledRuns_ClassNames}
			>
				<ChevronRight
					className={"RoutePluginsInstalledRuns-chevron" satisfies RoutePluginsInstalledRuns_ClassNames}
					aria-hidden
				/>
				<h2 className={"RoutePluginsInstalledRuns-title" satisfies RoutePluginsInstalledRuns_ClassNames}>
					<Clock3 aria-hidden />
					Activity
				</h2>
			</summary>
			<p className={"RoutePluginsInstalledRuns-description" satisfies RoutePluginsInstalledRuns_ClassNames}>
				Run history is kept without a time limit.
			</p>

			{runs.status === "LoadingFirstPage" ? (
				<div className={"RoutePluginsInstalledRuns-empty" satisfies RoutePluginsInstalledRuns_ClassNames} role="status">
					Loading runs...
				</div>
			) : runs.results.length === 0 ? (
				<div className={"RoutePluginsInstalledRuns-empty" satisfies RoutePluginsInstalledRuns_ClassNames}>
					No activity yet.
				</div>
			) : (
				<div className={"RoutePluginsInstalledRuns-list" satisfies RoutePluginsInstalledRuns_ClassNames}>
					{runs.results.map((run) => (
						<div
							key={run._id}
							className={"RoutePluginsInstalledRunItem" satisfies RoutePluginsInstalledRuns_ClassNames}
						>
							<div className={"RoutePluginsInstalledRunItem-header" satisfies RoutePluginsInstalledRuns_ClassNames}>
								<MyBadge
									variant={
										run.status === "failed" ? "destructive" : run.status === "succeeded" ? "secondary" : "outline"
									}
								>
									{run.status}
								</MyBadge>
								<span className={"RoutePluginsInstalledRunItem-path" satisfies RoutePluginsInstalledRuns_ClassNames}>
									{run.file?.path ?? run.event}
								</span>
							</div>
							<div className={"RoutePluginsInstalledRunItem-meta" satisfies RoutePluginsInstalledRuns_ClassNames}>
								{format_datetime(run.updatedAt)} ·{" "}
								{format_run_duration(
									run.startedAt !== null && run.finishedAt !== null ? run.finishedAt - run.startedAt : undefined,
								)}{" "}
								· {run.apiCallCount} API call{run.apiCallCount === 1 ? "" : "s"} · {run.outputWriteCount} file
								{run.outputWriteCount === 1 ? "" : "s"} written
							</div>
							<div className={"RoutePluginsInstalledRunItem-meta" satisfies RoutePluginsInstalledRuns_ClassNames}>
								Run as {run.actorName}
								{run.chainRootRunId ? (
									<>
										{" "}
										· Chain <code>{run.chainRootRunId}</code> · Step {(run.chainIndex ?? 0) + 1}
									</>
								) : null}
							</div>
							{run.errorMessage || run.errorCode ? (
								<div className={"RoutePluginsInstalledRunItem-error" satisfies RoutePluginsInstalledRuns_ClassNames}>
									{run.errorCode ? `${run.errorCode}: ` : ""}
									{run.errorMessage}
								</div>
							) : null}
							<MyButton
								variant="ghost"
								aria-expanded={expandedRunId === run._id}
								onClick={() => setExpandedRunId(expandedRunId === run._id ? null : run._id)}
							>
								{expandedRunId === run._id ? "Hide API calls" : "Show API calls"}
							</MyButton>
							{expandedRunId === run._id ? (
								calls === undefined ? (
									<p role="status">Loading API calls…</p>
								) : calls.length === 0 ? (
									<p>No API calls recorded.</p>
								) : (
									<ul>
										{calls.map((call) => (
											<li key={call._id}>
												<strong>
													{call.sequence}. {call.route}
												</strong>{" "}
												· {call.kind} · {call.status} · {format_datetime(call.startedAt)}
												{call.responseStatus !== undefined ? ` · HTTP ${call.responseStatus}` : ""} ·{" "}
												{format_run_duration(call.elapsedMs)} · {call.requestBytes ?? 0} request bytes ·{" "}
												{call.responseBytes ?? 0} response bytes
												{call.errorMessage ? <p role="alert">{call.errorMessage}</p> : null}
											</li>
										))}
									</ul>
								)
							) : null}
						</div>
					))}
				</div>
			)}
			{runs.status === "CanLoadMore" || runs.status === "LoadingMore" ? (
				<MyButton
					variant="ghost"
					aria-disabled={runs.status === "LoadingMore" || undefined}
					aria-busy={runs.status === "LoadingMore" || undefined}
					onClick={(event) => {
						if (runs.status !== "CanLoadMore") return;
						setFocusAfterLoad(document.activeElement === event.currentTarget);
						runs.loadMore(25);
					}}
				>
					{runs.status === "LoadingMore" ? "Loading runs…" : "Load more runs"}
				</MyButton>
			) : null}
		</details>
	);
});
// #endregion installed runs

// #region access and automation
type RoutePluginsPluginAccess_ClassNames =
	| "RoutePluginsPluginAccess"
	| "RoutePluginsPluginAccess-header"
	| "RoutePluginsPluginAccess-title"
	| "RoutePluginsPluginAccess-description"
	| "RoutePluginsPluginAccess-group"
	| "RoutePluginsPluginAccess-group-title"
	| "RoutePluginsPluginAccess-list"
	| "RoutePluginsPluginAccess-item"
	| "RoutePluginsPluginAccess-item-actions"
	| "RoutePluginsPluginAccess-empty"
	| "RoutePluginsPluginAccess-trigger"
	| "RoutePluginsPluginAccess-trigger-name"
	| "RoutePluginsPluginAccess-trigger-types"
	| "RoutePluginsPluginAccess-trigger-policy";

type RoutePluginsPluginAccess_Props = {
	plugin: RoutePlugins_PublishedPlugin;
	payerName: string;
	handlers: RoutePlugins_Installation["handlers"] | null;
	configurationYaml: string | null;
	events: RoutePlugins_Installation["version"]["events"] | null;
	mounts: RoutePlugins_Installation["version"]["mounts"];
	/**
	 * Null when the plugin is not installed.
	 */
	mcpServerStatuses: app_convex_FunctionReturnType<
		typeof app_convex_api.plugins_mcp.get_installation_mcp_status
	> | null;
	/**
	 * Null when the plugin is not installed.
	 */
	installationId: app_convex_Id<"plugins_workspace_installations"> | null;
	installationEnabled: boolean;
	onMcpDisconnect: (
		target: app_convex_FunctionArgs<typeof app_convex_api.plugins_mcp_oauth.disconnect>["target"],
	) => void;
};

type RoutePluginsPluginAccess_CustomAttributes = {
	"data-organization-policy": "allowed" | "blocked";
};

/**
 * This spells out both capability names and event types, so it stays one plain rule instead of a
 * list of per-value labels. It also splits on `-` so a hyphenated name reads like every other one.
 */
function format_access_label(value: string) {
	return value
		.split(/[._-]/)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

/**
 * A capability name is consent copy. An admin reads it to decide whether to grant the access. Some
 * names come out of the plain rule above saying the wrong thing, so each one gets a written label
 * here instead of inside `format_access_label`. Keeping the overrides out of the shared rule means
 * it carries no capability spellings and event types keep using it unchanged.
 */
function format_capability_label(value: string, payerName = "the workspace owner") {
	if (value === "workspace.volumes.write") {
		return `Add read-only mount folders to this workspace. Everyone who can read workspace files can read them through the chat agent. Folder sharing limits do not apply to these folders. The content comes from outside sources. Each new stored file costs half a cent (0.5 cents), at most 10,000 files per day. Scheduled writes are billed to ${payerName}. Other writes use this installation's billing settings.`;
	}
	if (value === "plugin.schedule.run") {
		return "Run its backend on a schedule as the selected workspace user. It can use only that user's current access and the permissions granted to this plugin. It can run while that user is signed out. Choose another user if they leave the workspace.";
	}
	// The plain rule writes "Workspace Files Create Read Only", which reads as create-and-read
	// access. That is the opposite of what this capability does, because it lets a plugin lock the
	// file it creates so nobody in the workspace can edit it.
	if (value === "workspace.files.create-read-only") {
		return "Create read-only workspace files";
	}

	// The plain rule writes "Plugin Data User Write", which reads as "the user's plugin data" and so
	// says whose data it is instead of who writes it. It also lands one word away from
	// `plugin.data.write`'s "Plugin Data Write", and those two are separate consents: that one is the
	// plugin's own backend or service writing as the installation, this one is the plugin's browser
	// frames writing as the member who opened them. Name the writer and the surface so an admin can
	// tell the two apart. Both frame kinds are named because the door checks the capability on the UI
	// session alone, and a page and a file view mint their session from the same table.
	if (value === "plugin.data.user-write") {
		return "Write its plugin data as the acting member, from its pages and file views";
	}

	// The plain rule writes "Ui", which is not a word. It also lands one word away from
	// `outbound.fetch`'s "Outbound Fetch", and those two are separate capabilities on purpose: this
	// one is the plugin's own browser frames calling out from inside the member's browser, the other
	// is its backend calling out from the runner. Name both frame kinds here so an admin can tell the
	// two consents apart. The origins reach a file view exactly as they reach a page, because the
	// policy carrying them is set on every plugin asset response and the list lives on the version.
	if (value === "ui.outbound.fetch") {
		return "Call allowed outside origins from its pages and file views";
	}

	// The plain rule writes "Workspace Members Read", which says a plugin reads something about
	// members and leaves the admin to guess what. The whole point of this capability is the step from
	// resolving names for ids the plugin already holds — which every plugin with data read can do, and
	// which enumerates nobody — to reading the list itself. Name the list, and say what a row carries,
	// because "members" alone leaves an admin wondering whether email comes with it.
	if (value === "workspace.members.read") {
		return "List every member of this workspace, with their display names but not their emails";
	}

	// The plain rule writes "Plugin Backend Invoke", three nouns that say nothing about who starts
	// what. Name the trigger and the actor: a member's click in the plugin's frames runs the
	// publisher's backend code, which then acts with the plugin's own API access.
	if (value === "plugin.backend.invoke") {
		return "Run its backend when a member uses its pages and file views";
	}

	// Explain the editable labels that select the plugin's files.
	if (value === "workspace.files.own-write") {
		return "Create, update, and archive files and folders marked for this plugin. Members can edit their labels.";
	}

	// Explain both the plugin's access controls and the member's manage permission.
	if (value === "workspace.files.own-access") {
		return "Set locks and readers for its output. Members with manage permission can change them.";
	}

	// The plain rule writes "Agent Mcp Connect", which does not say who calls what. The chat agent
	// calls the outside servers listed on this screen.
	if (value === "agent.mcp.connect") {
		return "Let the chat agent call the MCP servers listed here";
	}

	// The plain rule writes "Agent Skills Contribute", which does not say where the skills go.
	if (value === "agent.skills.contribute") {
		return "Add its skills to the chat agent's skill list";
	}

	return format_access_label(value);
}

/**
 * How a member reaches one MCP server, in words an admin can read.
 */
function format_mcp_server_auth(server: plugins_McpServer) {
	if (server.auth.kind === "none") {
		return "no sign-in";
	}
	if (server.auth.kind === "secret_headers") {
		return "uses plugin secrets";
	}
	return `each member signs in at ${new URL(server.auth.issuer).host}`;
}

const RoutePluginsPluginAccess = memo(function RoutePluginsPluginAccess(props: RoutePluginsPluginAccess_Props) {
	const {
		plugin,
		payerName,
		handlers,
		configurationYaml,
		events,
		mounts,
		mcpServerStatuses,
		installationId,
		installationEnabled,
		onMcpDisconnect,
	} = props;
	const parsedConfiguration =
		configurationYaml !== null && events !== null
			? plugins_parse_installation_configuration_yaml({ configurationYaml, events, mounts })
			: null;
	const activeEvents =
		handlers && events
			? events.flatMap((event, eventIndex) => {
					const contentTypes = event.contentTypes.filter((contentType) =>
						handlers.some((handler) => handler.event === event.type && handler.contentType === contentType),
					);
					if (
						contentTypes.length === 0 &&
						!(
							(event.type === "users.account.deleted" || event.type === "schedule.interval.elapsed") &&
							handlers.some((handler) => handler.event === event.type && handler.contentType === undefined)
						)
					) {
						return [];
					}
					return [
						{
							key: `${event.type}:${eventIndex}`,
							type: event.type,
							contentTypes,
							filters:
								parsedConfiguration && !parsedConfiguration._nay
									? plugins_get_event_filter_values({
											configuration: parsedConfiguration._yay.configuration,
											event,
										})
									: [],
						},
					];
				})
			: null;

	return (
		<section className={"RoutePluginsPluginAccess" satisfies RoutePluginsPluginAccess_ClassNames}>
			<header className={"RoutePluginsPluginAccess-header" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h2 className={"RoutePluginsPluginAccess-title" satisfies RoutePluginsPluginAccess_ClassNames}>
					<ShieldCheck aria-hidden />
					Access & automation
				</h2>
				<p className={"RoutePluginsPluginAccess-description" satisfies RoutePluginsPluginAccess_ClassNames}>
					What this plugin can access and when it runs.
				</p>
			</header>

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
					Capabilities
				</h3>
				{plugin.capabilities.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No elevated capabilities.
					</div>
				) : (
					<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
						{plugin.capabilities.map((capability) => (
							<li
								key={capability}
								className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
								title={capability}
							>
								{format_capability_label(capability, payerName)}
							</li>
						))}
					</ul>
				)}
			</section>

			{mounts.length > 0 ? (
				<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
					<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
						Mount folders
					</h3>
					<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
						{mounts.map((mount) => (
							<li
								key={mount.id}
								className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
							>
								{parsedConfiguration?._yay?.mountNames[mount.id] ?? mount.id} · {mount.description}
							</li>
						))}
					</ul>
				</section>
			) : null}

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>Pages</h3>
				{plugin.pages.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No UI pages.
					</div>
				) : (
					<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
						{plugin.pages.map((page) => (
							<li
								key={page.id}
								className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
							>
								{page.title}
								{page.navItem ? ` — sidebar item: ${page.navItem.label}` : ""}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
					File views
				</h3>
				{plugin.fileViews.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No file views.
					</div>
				) : (
					<>
						<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
							{plugin.fileViews.map((fileView) => (
								<li
									key={fileView.id}
									className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
								>
									{fileView.title} — {fileView.contentTypes.join(", ")}
								</li>
							))}
						</ul>
						<p className={"RoutePluginsPluginAccess-description" satisfies RoutePluginsPluginAccess_ClassNames}>
							A file view adds a tab next to the file details when a member opens a file with one of these content
							types.
						</p>
					</>
				)}
			</section>

			{/* Reviewed page code is trusted; the iframe is host isolation, not data containment. A file view
			    grants the same thing. It mints its session from the same table, and that session gets the same
			    workspace-wide file scopes a page gets. The file it was opened from narrows nothing. So keep this
			    warning outside both surface gates, in the words the install consent dialog already uses. Inside
			    the pages gate, a plugin that ships only file views showed no warning at all. */}
			{plugin.pages.length > 0 || plugin.fileViews.length > 0 ? (
				<p className={"RoutePluginsPluginAccess-description" satisfies RoutePluginsPluginAccess_ClassNames}>
					Plugin pages and file views are trusted with the data their capabilities expose. They can send that data away
					by navigating, even when no backend origin is listed.
				</p>
			) : null}

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
					MCP servers
				</h3>
				{plugin.mcpServers.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No MCP servers.
					</div>
				) : (
					<>
						<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
							{plugin.mcpServers.map((server) => {
								const status = mcpServerStatuses?.find((item) => item.serverId === server.id);
								const target = installationId ? { kind: "plugin" as const, installationId, serverId: server.id } : null;
								// Offer a sign-in only while the installation is on and the organization allows the server.
								const canConnect =
									installationEnabled && status?.policy === "allowed" && status.connection?.status !== "connected";
								return (
									<li
										key={server.id}
										className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
										{...(status
											? ({
													"data-organization-policy": status.policy,
												} satisfies RoutePluginsPluginAccess_CustomAttributes)
											: {})}
									>
										{server.title} — {new URL(server.url).host} — {format_mcp_server_auth(server)}
										{server.tools ? ` — tools: ${server.tools.join(", ")}` : ""}
										{status?.policy === "blocked" ? " — Blocked by your organization's MCP policy" : ""}
										{status?.health === "paused" ? " — Paused after failed tool lists" : ""}
										{server.auth.kind === "oauth" && status
											? status.connection === null
												? " — Not connected"
												: status.connection.status === "connected"
													? ` — Connected, signed in at ${status.connection.authorizationHost}`
													: " — Needs reconnect"
											: ""}
										{/* A member can always remove a sign-in. */}
										{server.auth.kind === "oauth" && status && target && (canConnect || status.connection !== null) ? (
											<div
												className={
													"RoutePluginsPluginAccess-item-actions" satisfies RoutePluginsPluginAccess_ClassNames
												}
											>
												{canConnect ? (
													<McpConnect
														target={target}
														label={status.connection === null ? "Connect" : "Reconnect"}
														serverLabel={server.title}
													/>
												) : null}
												{status.connection !== null ? (
													<MyButton
														variant="outline"
														aria-label={`Disconnect ${server.title}`}
														onClick={() => onMcpDisconnect(target)}
													>
														<Unplug aria-hidden />
														Disconnect
													</MyButton>
												) : null}
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
						<p className={"RoutePluginsPluginAccess-description" satisfies RoutePluginsPluginAccess_ClassNames}>
							MCP servers are outside services. When the agent calls a tool, the chat sends that call's data to the
							server without asking.
						</p>
					</>
				)}
			</section>

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>Skills</h3>
				{plugin.skills.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No skills.
					</div>
				) : (
					<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
						{plugin.skills.map((skill) => (
							<li
								key={skill.name}
								className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
							>
								{skill.name} — {skill.description}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
					Backend network access
				</h3>
				{plugin.outboundOrigins.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No backend outbound origins.
					</div>
				) : (
					<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
						{plugin.outboundOrigins.map((origin) => (
							<li
								key={origin}
								className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
							>
								{origin}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
					Page and file view network access
				</h3>
				{plugin.uiOutboundOrigins.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No page or file view outbound origins.
					</div>
				) : (
					<>
						<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
							{plugin.uiOutboundOrigins.map((origin) => (
								<li
									key={origin}
									className={"RoutePluginsPluginAccess-item" satisfies RoutePluginsPluginAccess_ClassNames}
								>
									{origin}
								</li>
							))}
						</ul>
						<p className={"RoutePluginsPluginAccess-description" satisfies RoutePluginsPluginAccess_ClassNames}>
							A plugin page and a file view both run in a member's browser and may call these origins directly. This is
							a separate risk from backend network access: the frame holds that member's session token.
						</p>
					</>
				)}
			</section>

			{activeEvents ? (
				<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
					<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
						Triggers
					</h3>
					{activeEvents.length === 0 ? (
						<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
							No active triggers.
						</div>
					) : (
						<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
							{activeEvents.map((event) => (
								<li
									key={event.key}
									className={"RoutePluginsPluginAccess-trigger" satisfies RoutePluginsPluginAccess_ClassNames}
								>
									<span
										className={"RoutePluginsPluginAccess-trigger-name" satisfies RoutePluginsPluginAccess_ClassNames}
									>
										{event.type === "schedule.interval.elapsed" ? "Schedule" : format_access_label(event.type)}
									</span>
									{event.contentTypes.length > 0 && (
										<span
											className={"RoutePluginsPluginAccess-trigger-types" satisfies RoutePluginsPluginAccess_ClassNames}
										>
											{event.contentTypes.join(", ")}
										</span>
									)}
									{event.filters.map((filter, filterIndex) => (
										<span
											key={`${filter.filter.configurationPath.join(".")}:${filterIndex}`}
											className={
												"RoutePluginsPluginAccess-trigger-policy" satisfies RoutePluginsPluginAccess_ClassNames
											}
										>
											{filter.values.length === 0
												? "Automatic runs are disabled."
												: filter.values.includes("/")
													? "Runs for matching files in every folder."
													: `Paths: ${filter.values.join(", ")}`}
										</span>
									))}
								</li>
							))}
						</ul>
					)}
				</section>
			) : null}
		</section>
	);
});
// #endregion access and automation

// #region publisher releases
function review_badge_variant(status: "passed" | "rejected" | "flagged" | "pending") {
	return status === "rejected" ? "destructive" : status === "flagged" ? "outline" : "secondary";
}

type RoutePluginsPluginPublisherReleases_ClassNames =
	| "RoutePluginsPluginPublisherReleases"
	| "RoutePluginsPluginPublisherReleases-title"
	| "RoutePluginsPluginPublisherReleases-lastAttempt"
	| "RoutePluginsPluginPublisherReleases-lastAttemptMessage"
	| "RoutePluginsPluginPublisherReleases-limitNotice"
	| "RoutePluginsPluginPublisherReleases-empty"
	| "RoutePluginsPluginPublisherReleases-list"
	| "RoutePluginsPluginPublisherReleaseItem"
	| "RoutePluginsPluginPublisherReleaseItem-header"
	| "RoutePluginsPluginPublisherReleaseItem-name"
	| "RoutePluginsPluginPublisherReleaseItem-meta"
	| "RoutePluginsPluginPublisherReleaseItem-findings"
	| "RoutePluginsPluginPublisherReleaseItem-advisory-title"
	| "RoutePluginsPluginPublisherReleaseItem-advisory"
	| "RoutePluginsPluginPublisherReleaseItem-note";

type RoutePluginsPluginPublisherReleases_Props = {
	versions: RoutePlugins_PublisherPlugin["versions"];
	reviews: RoutePlugins_PublisherPlugin["reviews"];
	lastPublishAttempt: RoutePlugins_PublisherPlugin["repository"]["lastPublishAttempt"];
	historyIsTruncated: RoutePlugins_PublisherPlugin["historyIsTruncated"];
};

const RoutePluginsPluginPublisherReleases = memo(function RoutePluginsPluginPublisherReleases(
	props: RoutePluginsPluginPublisherReleases_Props,
) {
	const { versions, reviews, lastPublishAttempt, historyIsTruncated } = props;
	const reviewsById = new Map(reviews.map((review) => [review._id, review]));
	const releases: Array<{
		id: string;
		name: string;
		version: string;
		sourceCommitSha: string | null;
		publishedAt: number | null;
		reviewStatus: "passed" | "rejected" | "flagged" | "pending";
		review: RoutePlugins_PublisherPlugin["reviews"][number] | null;
	}> = versions.map((version) => {
		const review = version.reviewId ? (reviewsById.get(version.reviewId) ?? null) : null;
		return {
			id: version._id,
			name: version.name,
			version: version.version,
			sourceCommitSha: version.sourceCommitSha,
			publishedAt: version.updatedAt,
			reviewStatus: review?.status ?? version.reviewStatus,
			review,
		};
	});
	const publishedReviewIds = new Set(versions.flatMap((version) => (version.reviewId ? [version.reviewId] : [])));
	for (const review of reviews) {
		if (!publishedReviewIds.has(review._id)) {
			releases.push({
				id: review._id,
				name: review.pluginName,
				version: review.version,
				sourceCommitSha: null,
				publishedAt: null,
				reviewStatus: review.status,
				review,
			});
		}
	}
	releases.sort(
		(a, b) =>
			Math.max(b.publishedAt ?? 0, b.review?.updatedAt ?? 0) - Math.max(a.publishedAt ?? 0, a.review?.updatedAt ?? 0),
	);

	return (
		<section className={"RoutePluginsPluginPublisherReleases" satisfies RoutePluginsPluginPublisherReleases_ClassNames}>
			<h2
				className={"RoutePluginsPluginPublisherReleases-title" satisfies RoutePluginsPluginPublisherReleases_ClassNames}
			>
				<History aria-hidden />
				Recent release history
			</h2>
			{historyIsTruncated ? (
				<div
					className={
						"RoutePluginsPluginPublisherReleases-limitNotice" satisfies RoutePluginsPluginPublisherReleases_ClassNames
					}
				>
					Older published versions or review attempts are not shown.
				</div>
			) : null}
			{lastPublishAttempt && lastPublishAttempt.status !== "succeeded" ? (
				<div
					className={
						"RoutePluginsPluginPublisherReleases-lastAttempt" satisfies RoutePluginsPluginPublisherReleases_ClassNames
					}
				>
					<MyBadge variant={lastPublishAttempt.status === "flagged" ? "outline" : "destructive"}>
						{lastPublishAttempt.status}
					</MyBadge>
					<span
						className={
							"RoutePluginsPluginPublisherReleases-lastAttemptMessage" satisfies RoutePluginsPluginPublisherReleases_ClassNames
						}
					>
						Last publish {format_datetime(lastPublishAttempt.at)} · {lastPublishAttempt.message}
					</span>
				</div>
			) : null}
			{releases.length === 0 ? (
				<div
					className={
						"RoutePluginsPluginPublisherReleases-empty" satisfies RoutePluginsPluginPublisherReleases_ClassNames
					}
				>
					Nothing published yet. Use the Publish button above to build and review the first version.
				</div>
			) : (
				<div
					className={
						"RoutePluginsPluginPublisherReleases-list" satisfies RoutePluginsPluginPublisherReleases_ClassNames
					}
				>
					{releases.map((release) => {
						// Only these blocked the version. Advisory findings render in their own labeled list
						// below, so a publisher never reads a shape warning as the reason for a reject.
						const findings = release.review ? [...release.review.mechanicalFindings, ...release.review.aiFindings] : [];
						const advisoryFindings = release.review?.mechanicalAdvisoryFindings ?? [];
						return (
							<div
								key={release.id}
								className={
									"RoutePluginsPluginPublisherReleaseItem" satisfies RoutePluginsPluginPublisherReleases_ClassNames
								}
							>
								<div
									className={
										"RoutePluginsPluginPublisherReleaseItem-header" satisfies RoutePluginsPluginPublisherReleases_ClassNames
									}
								>
									<span
										className={
											"RoutePluginsPluginPublisherReleaseItem-name" satisfies RoutePluginsPluginPublisherReleases_ClassNames
										}
									>
										{release.name}@{release.version}
									</span>
									<span
										className={
											"RoutePluginsPluginPublisherReleaseItem-meta" satisfies RoutePluginsPluginPublisherReleases_ClassNames
										}
									>
										{release.publishedAt
											? `published ${format_datetime(release.publishedAt)}${release.sourceCommitSha ? ` · ${release.sourceCommitSha.slice(0, 8)}` : ""}${
													release.review
														? release.review.model === "none"
															? " · mechanical checks"
															: ` · reviewed by ${release.review.model}`
														: " · review pending"
												}`
											: release.review
												? `not published · reviewed ${format_datetime(release.review.updatedAt)} · ${release.review.model === "none" ? "mechanical checks" : release.review.model}`
												: "not published · review pending"}
									</span>
									<MyBadge variant={review_badge_variant(release.reviewStatus)}>{release.reviewStatus}</MyBadge>
								</div>
								{findings.length === 0 ? null : (
									<ul
										className={
											"RoutePluginsPluginPublisherReleaseItem-findings" satisfies RoutePluginsPluginPublisherReleases_ClassNames
										}
									>
										{findings.map((finding, index) => (
											<li key={index}>{finding}</li>
										))}
									</ul>
								)}
								{advisoryFindings.length === 0 ? null : (
									<>
										<div
											className={
												"RoutePluginsPluginPublisherReleaseItem-advisory-title" satisfies RoutePluginsPluginPublisherReleases_ClassNames
											}
										>
											Advisory — did not block this version
										</div>
										<ul
											className={
												"RoutePluginsPluginPublisherReleaseItem-advisory" satisfies RoutePluginsPluginPublisherReleases_ClassNames
											}
										>
											{advisoryFindings.map((finding, index) => (
												<li key={index}>{finding}</li>
											))}
										</ul>
									</>
								)}
								{release.reviewStatus === "flagged" ? (
									<div
										className={
											"RoutePluginsPluginPublisherReleaseItem-note" satisfies RoutePluginsPluginPublisherReleases_ClassNames
										}
									>
										This version was not published. Change the reviewed content and publish again.
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
});
// #endregion publisher releases

// #region root
type RoutePluginsPlugin_ClassNames =
	| "RoutePluginsPlugin"
	| "RoutePluginsPlugin-content"
	| "RoutePluginsPlugin-loading"
	| "RoutePluginsPlugin-missing"
	| "RoutePluginsPluginHero"
	| "RoutePluginsPluginHero-icon"
	| "RoutePluginsPluginHero-info"
	| "RoutePluginsPluginHero-titleRow"
	| "RoutePluginsPluginHero-title"
	| "RoutePluginsPluginHero-statuses"
	| "RoutePluginsPluginHero-meta"
	| "RoutePluginsPluginHero-repoLink"
	| "RoutePluginsPluginHero-description"
	| "RoutePluginsPluginHero-actions"
	| "RoutePluginsPluginHero-actions-buttons"
	| "RoutePluginsPluginHero-action-note"
	| "RoutePluginsPluginConsentModal"
	| "RoutePluginsPluginConsentModal-baseline"
	| "RoutePluginsPluginConsentModal-sectionTitle"
	| "RoutePluginsPluginConsentModal-list"
	| "RoutePluginsPluginConsentModal-item"
	| "RoutePluginsPluginConsentModal-empty"
	| "RoutePluginsPluginConsentModal-actions"
	| "RoutePluginsPluginConsentModal-accountFields";

type RoutePluginsPlugin_CustomAttributes = {
	"data-organization-policy": RoutePlugins_PublishedPlugin["organizationPolicy"];
};

// Publishers can inspect a version before it appears in the public catalog.
function get_publisher_version(publisherPlugin: RoutePlugins_PublisherPlugin): RoutePlugins_PublishedPlugin | null {
	const version = publisherPlugin.versions.at(0);
	if (!version) {
		return null;
	}

	return {
		pluginVersionId: version._id,
		name: version.name,
		displayName: version.displayName,
		description: version.description,
		version: version.version,
		publisherDisplayName: "You",
		reviewStatus: version.reviewStatus,
		// Mirror list_published_plugins: the file baseline needs a backend and a file event.
		canProcessFiles:
			version.backendEntrypointFile !== null && version.events.some((event) => event.type === "files.upload.completed"),
		canInstall: false,
		canManage: false,
		installationId: null,
		configuration: version.configuration,
		mounts: version.mounts,
		events: version.events,
		capabilities: version.capabilities,
		outboundOrigins: version.outboundOrigins,
		uiOutboundOrigins: version.uiOutboundOrigins,
		pages: version.pages,
		fileViews: version.fileViews,
		mcpServers: version.mcpServers,
		mcpServersFingerprint: version.mcpServersFingerprint,
		skills: version.skills,
		// Install rights come from the catalog. This publisher fallback never offers Install.
		organizationPolicy: "allowed",
	};
}

type PluginServiceAccountGrants = NonNullable<
	app_convex_FunctionArgs<typeof app_convex_api.plugins.install_version>["serviceAccountGrants"]
>;

const RoutePluginsServiceAccountGrants = memo(function RoutePluginsServiceAccountGrants(props: {
	serviceAccountId: app_convex_Id<"access_control_service_accounts">;
	grants: PluginServiceAccountGrants;
	disabled: boolean;
	onChange: (grants: PluginServiceAccountGrants) => void;
}) {
	const { serviceAccountId, grants, disabled, onChange } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [resourceKind, setResourceKind] = useState<"workspace" | "file">("workspace");
	const [path, setPath] = useState("");
	const [level, setLevel] = useState<access_control_FileShareLevel>("read");
	const [resourceLabels, setResourceLabels] = useState<Record<string, string>>({});

	const node = useQuery(
		app_convex_api.files_nodes.get_authorized_by_path,
		resourceKind === "file" && path.startsWith("/") ? { membershipId, path } : "skip",
	);
	const grantManagement = useQuery(
		app_convex_api.access_control.get_service_account_grant_management_state,
		resourceKind === "workspace"
			? { membershipId, serviceAccountId, resource: { kind: "workspace" } }
			: node
				? { membershipId, serviceAccountId, resource: { kind: "file", nodeId: node.nodeId } }
				: "skip",
	);

	const get_resource_key = (resource: PluginServiceAccountGrants[number]["resource"]) =>
		resource.kind === "workspace" ? "workspace" : resource.nodeId;

	const handleAddGrant = () => {
		if (
			disabled ||
			!grantManagement?.canManage ||
			!grantManagement.grantableLevels.includes(level) ||
			grants.length >= 20
		) {
			return;
		}

		const key = get_resource_key(grantManagement.resource);
		setResourceLabels({
			...resourceLabels,
			[key]:
				grantManagement.resource.kind === "workspace"
					? "Workspace"
					: `${grantManagement.file?.path ?? "Protected item"} — ${grantManagement.file?.scope === "restricted_scope" ? "This restricted scope" : "This item only"}`,
		});
		onChange([
			...grants.filter((grant) => get_resource_key(grant.resource) !== key),
			{ resource: grantManagement.resource, level },
		]);
	};

	return (
		<div className={"RoutePluginsPluginConsentModal-accountFields" satisfies RoutePluginsPlugin_ClassNames}>
			<h3>Grants to apply on install</h3>
			<p>Only grants you add below will be changed. Existing grants stay as they are.</p>
			<MySelect
				value={resourceKind}
				setValue={(value) => {
					if (!disabled && (value === "workspace" || value === "file")) {
						setResourceKind(value);
					}
				}}
			>
				<MySelectLabel>Grant resource</MySelectLabel>
				<MySelectTrigger disabled={disabled}>
					<MyButton variant="outline">
						{resourceKind === "workspace" ? "Workspace" : "File or folder"}
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover>
					<MySelectPopoverContent>
						<MySelectItem value="workspace">Workspace</MySelectItem>
						<MySelectItem value="file">File or folder</MySelectItem>
					</MySelectPopoverContent>
				</MySelectPopover>
			</MySelect>
			{resourceKind === "file" ? (
				<MyInput layout="stacked">
					<MyInputLabel>Grant file or folder path</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							value={path}
							placeholder="/logs"
							onChange={(event) => {
								if (!disabled) {
									setPath(event.currentTarget.value);
								}
							}}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
			) : null}
			{grantManagement ? (
				<p>
					{grantManagement.file?.path ?? "Workspace"}:{" "}
					{grantManagement.resource.kind === "workspace"
						? "Unrestricted workspace content"
						: grantManagement.file?.scope === "restricted_scope"
							? "This restricted scope"
							: "This item only"}
				</p>
			) : null}
			<MySelect
				value={level}
				setValue={(value) => {
					if (!disabled) {
						setLevel(value as access_control_FileShareLevel);
					}
				}}
			>
				<MySelectLabel>Grant access level</MySelectLabel>
				<MySelectTrigger disabled={disabled}>
					<MyButton variant="outline">
						{access_control_FILE_SHARE_LEVELS[level].label}
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover>
					<MySelectPopoverContent>
						{access_control_FILE_SHARE_LEVEL_KEYS.map((key) => (
							<MySelectItem key={key} value={key} disabled={!grantManagement?.grantableLevels.includes(key)}>
								{access_control_FILE_SHARE_LEVELS[key].label}
							</MySelectItem>
						))}
					</MySelectPopoverContent>
				</MySelectPopover>
			</MySelect>
			<MyButton
				variant="outline"
				disabled={
					disabled ||
					!grantManagement?.canManage ||
					!grantManagement.grantableLevels.includes(level) ||
					grants.length >= 20
				}
				onClick={handleAddGrant}
			>
				Add reviewed grant
			</MyButton>
			<ul>
				{grants.map((grant) => (
					<li key={get_resource_key(grant.resource)}>
						{resourceLabels[get_resource_key(grant.resource)] ?? "Selected resource"}:{" "}
						{access_control_FILE_SHARE_LEVELS[grant.level].label}
						<MyButton
							variant="ghost"
							disabled={disabled}
							onClick={() =>
								onChange(
									grants.filter(
										(candidate) => get_resource_key(candidate.resource) !== get_resource_key(grant.resource),
									),
								)
							}
						>
							Remove from install
						</MyButton>
					</li>
				))}
			</ul>
		</div>
	);
});

function RoutePluginsPlugin() {
	const { pluginName } = Route.useParams();
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const publishSessionManager = PluginsPublishSessionProvider.useContext();
	const plugins = useQuery(app_convex_api.plugins.list_published_plugins, { membershipId });
	// Private settings come only from installations this member may manage.
	const installations = useQuery(app_convex_api.plugins.list_installations, { membershipId });
	// Non-null only when the signed-in user owns this plugin's repository claim.
	const publisherPlugin = useQuery(app_convex_api.plugins.get_publisher_plugin, {
		pluginName,
	});
	const [consenting, setConsenting] = useState(false);
	const setupAccess = useQuery(app_convex_api.plugins_access.get_workspace_install_access, { membershipId });
	const owner = useQuery(
		app_convex_api.users.get_anagraphic,
		setupAccess ? { userId: setupAccess.organizationOwnerUserId } : "skip",
	);
	const payerName = owner?.displayName ?? "the workspace owner";
	const [installYaml, setInstallYaml] = useState("");
	const [installConsent, setInstallConsent] = useState<PluginsRunConsent_Value | null>(null);
	const [installConsentSession, setInstallConsentSession] = useState(0);
	const [installRunUser, setInstallRunUser] = useState<EligibleRunUser | null>(null);
	const [installRunUserValid, setInstallRunUserValid] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
	const [disabling, setDisabling] = useState(false);
	const [disableError, setDisableError] = useState<string | null>(null);
	const canManageAccounts = useQuery(app_convex_api.access_control.get_current_user_workspace_permission, {
		membershipId,
		permission: "workspace.service_accounts.manage",
	});
	const [installAccountId, setInstallAccountId] = useState<
		app_convex_Id<"access_control_service_accounts"> | undefined
	>();
	const [installGrants, setInstallGrants] = useState<PluginServiceAccountGrants>([]);
	const [rebindAccountId, setRebindAccountId] = useState<app_convex_Id<"access_control_service_accounts"> | null>(null);
	const [rebinding, setRebinding] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [uninstalling, setUninstalling] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [managingSecrets, setManagingSecrets] = useState(false);
	// Arm the install landing effect below when the reactive update removes its focused control.
	const [focusHeroAfterInstall, setFocusHeroAfterInstall] = useState(false);
	// A focus target for a finished uninstall: the Uninstall button unmounts with its row, and the
	// focus a removed element held falls to the page body. Send it to the plugin title instead.
	const heroTitleRef = useRef<HTMLHeadingElement | null>(null);
	// Keep a focus target if the plugin leaves both the catalog and publisher view.
	const missingPluginRef = useRef<HTMLDivElement | null>(null);
	const publishBusy = publishSessionManager.session !== null;
	const managementBusy = publishSessionManager.managementAction !== null || rebinding || disabling;

	// Computed before the early returns because the install landing effect below reads
	// `showInstall`; every input is null-safe while the queries are still loading.
	const plugin =
		plugins?.find((item) => item.name === pluginName) ??
		(publisherPlugin ? get_publisher_version(publisherPlugin) : null);
	const installedItem = installations?.find((item) => item.installation.pluginName === plugin?.name) ?? null;
	const installedVersion = installedItem?.version;
	const installationId = plugin?.installationId ?? installedItem?.installation._id ?? null;
	const hasSchedule = plugin?.events.some((event) => event.type === "schedule.interval.elapsed") ?? false;
	const installConfiguration = plugin?.configuration
		? plugins_parse_installation_configuration_yaml({
				configurationYaml: installYaml,
				events: plugin.events,
				mounts: plugin.mounts,
			})
		: null;
	// Removed folders use the accepted YAML, rather than the new draft's names.
	const installedConfiguration =
		installedItem?.installation.configurationYaml && installedVersion
			? plugins_parse_installation_configuration_yaml({
					configurationYaml: installedItem.installation.configurationYaml,
					events: installedVersion.events,
					mounts: installedVersion.mounts,
				})
			: null;
	// An organization policy change can disable the installation. Enable reinstalls the same version,
	// so `install_version` stays the only place that turns an installation on.
	const enablesInstalledVersion =
		installedItem?.installation.status === "disabled" && installedVersion?.version === plugin?.version;
	const mcpServerStatuses = useQuery(
		app_convex_api.plugins_mcp.get_installation_mcp_status,
		installedItem ? { membershipId, installationId: installedItem.installation._id } : "skip",
	);
	const currentAccount = useQuery(
		app_convex_api.access_control.get_service_account,
		installedItem?.installation.serviceAccountId
			? { membershipId, serviceAccountId: installedItem.installation.serviceAccountId }
			: "skip",
	);

	const handleInstallConsentChange = useFn((value: PluginsRunConsent_Value | null) => {
		setInstallConsent(value);
		setInstallError(null);
	});
	const handleRebind = useFn(() => {
		if (
			!installedItem ||
			!rebindAccountId ||
			rebinding ||
			canManageAccounts !== true ||
			publishBusy ||
			managementBusy
		) {
			return;
		}

		setRebinding(true);

		app_convex
			.mutation(app_convex_api.plugins.set_installation_service_account, {
				membershipId,
				installationId: installedItem.installation._id,
				serviceAccountId: rebindAccountId,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				} else {
					heroTitleRef.current?.focus();
					setRebindAccountId(null);
					toast.success("Plugin service account changed");
				}
			})
			.catch((error: unknown) => {
				console.error("[RoutePluginsPlugin.handleRebind] Failed to change service account", { error });
				toast.error("Could not change the service account");
			})
			.finally(() => setRebinding(false));
	});

	const showInstall =
		plugin !== null &&
		(installationId ? plugin.canManage : plugin.canInstall) &&
		(!installedVersion || installedVersion.version !== plugin.version || enablesInstalledVersion);

	const handleDisable = useFn(() => {
		if (
			!installedItem ||
			installedItem.installation.status !== "enabled" ||
			publishBusy ||
			managementBusy ||
			installing ||
			uninstalling ||
			removing
		)
			return;
		const actionVersion = publishSessionManager.beginManagementAction("disable");
		if (actionVersion === null) return;
		setDisabling(true);
		setDisableError(null);
		app_convex
			.mutation(app_convex_api.plugins.disable_installation, {
				membershipId,
				installationId: installedItem.installation._id,
			})
			.then((result) => {
				if (result._nay) setDisableError(result._nay.message);
				else {
					heroTitleRef.current?.focus();
					toast.success("Plugin disabled. Running work was stopped.");
				}
			})
			.catch((error: unknown) => {
				console.error("[RoutePluginsPlugin] Could not disable plugin", { error });
				setDisableError("Could not disable this plugin.");
			})
			.finally(() => {
				setDisabling(false);
				publishSessionManager.finishManagementAction(actionVersion);
			});
	});

	const handleUninstall = useFn(
		(installation: RoutePlugins_Installation["installation"], button: HTMLButtonElement) => {
			// Keep this guard because a mock or programmatic event can still call a disabled handler.
			// The button stays enabled during its own request so it can keep the focus.
			if (publishBusy || installing || uninstalling || removing || rebinding) {
				return;
			}
			const actionVersion = publishSessionManager.beginManagementAction("uninstall");
			if (actionVersion === null) {
				return;
			}

			setUninstalling(true);
			app_convex
				.mutation(app_convex_api.plugins.uninstall_version, { membershipId, installationId: installation._id })
				.then((result) => {
					if (result._nay) {
						toast.error(result._nay.message);
						return;
					}

					// No navigation: list_installations updates reactively, swapping the hero action back to Install.
					toast.success(`Uninstalled ${installation.pluginName}`);
					// The swap unmounts the pressed button and its focus would fall to the body. Send it
					// to the plugin title, but only when the button was still holding it or it already fell.
					if (document.activeElement === button || document.activeElement === document.body) {
						heroTitleRef.current?.focus();
					}
				})
				.catch((error) => {
					console.error("[RoutePluginsPlugin.handleUninstall] Failed to uninstall plugin:", {
						error,
						installationId: installation._id,
					});
					toast.error("Failed to uninstall plugin");
				})
				.finally(() => {
					setUninstalling(false);
					publishSessionManager.finishManagementAction(actionVersion);
				});
		},
	);

	const handleRemoveClaim = useFn(() => {
		// The menu item disables itself while work runs, but this guard, like on every other
		// handler on this route, is what stops a second activation from starting the work twice.
		if (!publisherPlugin || publishBusy || installing || uninstalling || removing || rebinding) {
			return;
		}
		const actionVersion = publishSessionManager.beginManagementAction("remove_repository");
		if (actionVersion === null) {
			return;
		}

		const repositoryId = publisherPlugin.repository._id;
		let removed = false;
		setRemoving(true);
		app_convex
			.mutation(app_convex_api.plugins.remove_repository, { repositoryId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				// No navigation: get_publisher_plugin goes null once the claim is gone, hiding the publisher UI.
				toast.success("Repository claim removed");
				removed = true;
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleRemoveClaim] Failed to remove repository claim:", {
					error,
					repositoryId,
				});
				toast.error("Failed to remove repository claim");
			})
			.finally(() => {
				setRemoving(false);
				// The provider outlives route remounts, so it can repair focus even when this
				// component was replaced while the removal was running.
				publishSessionManager.finishManagementAction(actionVersion, { repairFocusIfLost: removed });
			});
	});

	const handleMcpDisconnect = useFn<RoutePluginsPluginAccess_Props["onMcpDisconnect"]>((target) => {
		app_convex
			.mutation(app_convex_api.plugins_mcp_oauth.disconnect, { membershipId, target })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[RoutePluginsPlugin.handleMcpDisconnect] Failed to disconnect MCP server", {
					error,
					target,
				});
				toast.error("Could not disconnect. Try again.");
			});
	});

	const handleAcceptAndInstall = useFn((plugin: RoutePlugins_PublishedPlugin) => {
		// Keep this guard because a mock or programmatic event can still call a disabled handler.
		if (
			!showInstall ||
			publishBusy ||
			installing ||
			uninstalling ||
			removing ||
			rebinding ||
			plugin.reviewStatus === "rejected" ||
			plugin.reviewStatus === "flagged" ||
			plugin.organizationPolicy !== "allowed" ||
			(hasSchedule && !installRunUser && !installConsent) ||
			(hasSchedule && installRunUser && !installRunUserValid) ||
			installConfiguration?._nay ||
			(canManageAccounts !== true && (installAccountId !== undefined || installGrants.length > 0))
		) {
			return;
		}
		const actionVersion = publishSessionManager.beginManagementAction("install");
		if (actionVersion === null) {
			return;
		}

		setInstalling(true);
		setInstallError(null);
		app_convex
			.mutation(app_convex_api.plugins.install_version, {
				membershipId,
				pluginVersionId: plugin.pluginVersionId,
				acceptedCapabilities: plugin.capabilities,
				acceptedOutboundOrigins: plugin.outboundOrigins,
				acceptedUiOutboundOrigins: plugin.uiOutboundOrigins,
				acceptedMcpServersFingerprint: plugin.mcpServersFingerprint,
				acceptedSkillNames: plugin.skills.map((skill) => skill.name),
				...(plugin.configuration ? { configurationYaml: installYaml } : {}),
				...(hasSchedule
					? {
							scheduledRun: installRunUser
								? { kind: "user" as const, userId: installRunUser.userId, grantId: installRunUser.grantId }
								: { kind: "me" as const, ...installConsent! },
						}
					: {}),
				...(installAccountId ? { serviceAccountId: installAccountId } : {}),
				...(installGrants.length > 0 ? { serviceAccountGrants: installGrants } : {}),
			})
			.then((result) => {
				if (result._nay) {
					setInstallError(result._nay.message);
					toast.error(result._nay.message);
					return;
				}

				toast.success(`${enablesInstalledVersion ? "Enabled" : "Installed"} ${plugin.name} ${plugin.version}`);
				// Closing the modal makes Ariakit put the focus back on the Install button, and the
				// reactive list_installations update then unmounts that button. Arm the landing
				// effect below so the fallen focus does not stay on the page body.
				setFocusHeroAfterInstall(true);
				setConsenting(false);
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleAcceptAndInstall] Failed to install plugin:", {
					error,
					pluginVersionId: plugin.pluginVersionId,
				});
				toast.error("Failed to install plugin");
				setInstallError("Failed to install plugin");
			})
			.finally(() => {
				setInstalling(false);
				publishSessionManager.finishManagementAction(actionVersion);
			});
	});

	// A finished install closes the consent modal, and Ariakit puts the modal's focus back on the
	// Install button — which the reactive list_installations update then unmounts, dropping the
	// focus to the page body. Land it on the plugin title instead. The body check skips a member
	// who has already moved the focus elsewhere.
	useEffect(() => {
		if (!focusHeroAfterInstall || showInstall) {
			return;
		}
		setFocusHeroAfterInstall(false);
		if (document.activeElement === document.body) {
			heroTitleRef.current?.focus();
		}
	}, [focusHeroAfterInstall, showInstall]);

	useEffect(() => {
		// Let the stable publish owner repair focus after a route change removes A's trigger.
		const routeKey = `${workspaceId}/plugins/${pluginName}`;
		publishSessionManager.setRouteFocusTarget(heroTitleRef.current ?? missingPluginRef.current, routeKey);
		return () => publishSessionManager.setRouteFocusTarget(null, routeKey);
	});

	const breadcrumb = <PluginsHeaderBreadcrumb trail={["plugins"]} current={pluginName} />;

	if (plugins === undefined || installations === undefined || (plugin === null && publisherPlugin === undefined)) {
		return (
			<main
				className={cn(
					"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames,
					"app-scrollable" satisfies AppClassName,
				)}
				role="status"
				aria-live="polite"
			>
				<div className={"RoutePluginsPlugin-content" satisfies RoutePluginsPlugin_ClassNames}>
					{breadcrumb}
					<div className={"RoutePluginsPlugin-loading" satisfies RoutePluginsPlugin_ClassNames}>
						<Puzzle aria-hidden />
						Loading plugin...
					</div>
				</div>
			</main>
		);
	}

	if (plugin === null) {
		return (
			<main
				className={cn(
					"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames,
					"app-scrollable" satisfies AppClassName,
				)}
			>
				<div className={"RoutePluginsPlugin-content" satisfies RoutePluginsPlugin_ClassNames}>
					{breadcrumb}
					<div
						ref={missingPluginRef}
						tabIndex={-1}
						className={"RoutePluginsPlugin-missing" satisfies RoutePluginsPlugin_ClassNames}
						role="alert"
					>
						No published plugin is named "{pluginName}".
					</div>
				</div>
			</main>
		);
	}

	const consentDiff = plugins_consent_diff({
		current: installedVersion
			? {
					capabilities: installedVersion.capabilities,
					outboundOrigins: installedVersion.outboundOrigins,
					uiOutboundOrigins: installedVersion.uiOutboundOrigins,
					mcpServers: installedVersion.mcpServers,
					skills: installedVersion.skills,
					mounts: installedVersion.mounts,
					events: installedVersion.events,
				}
			: null,
		target: {
			capabilities: plugin.capabilities,
			outboundOrigins: plugin.outboundOrigins,
			uiOutboundOrigins: plugin.uiOutboundOrigins,
			mcpServers: plugin.mcpServers,
			skills: plugin.skills,
			mounts: plugin.mounts,
			events: plugin.events,
		},
	});
	// A current installation can be disabled or uninstalled. Enable asks for consent again.
	const installAction = enablesInstalledVersion ? "Enable" : installedVersion ? "Update" : "Install";
	const installProgress =
		installAction === "Enable" ? "Enabling..." : installAction === "Update" ? "Updating..." : "Installing...";
	const installationBlocked = plugin.reviewStatus === "rejected" || plugin.reviewStatus === "flagged";
	// The server refuses these installs too. Say why here instead of after the consent dialog.
	const policyNote =
		plugin.organizationPolicy === "blocked"
			? "Your organization does not allow this plugin. Ask your organization owner."
			: plugin.organizationPolicy === "needs_approval"
				? "Needs your organization owner's approval."
				: null;
	const handleOpenConsent = () => {
		// Keep this guard because a mock or programmatic event can still call a disabled handler.
		if (
			!showInstall ||
			publishBusy ||
			managementBusy ||
			installing ||
			uninstalling ||
			removing ||
			installationBlocked ||
			policyNote !== null
		) {
			return;
		}

		setInstallAccountId(undefined);
		setInstallGrants([]);
		setInstallYaml(installedItem?.installation.configurationYaml ?? plugin.configuration?.defaultYaml ?? "");
		setInstallConsent(null);
		setInstallConsentSession((session) => session + 1);
		setInstallRunUser(null);
		setInstallRunUserValid(false);
		setInstallError(null);
		setConsenting(true);
	};
	const handleConsentOpenChange = (open: boolean) => {
		// Keep the focused Accept button inside the modal until the install request settles.
		if (!open && installing) {
			return;
		}
		setConsenting(open);
	};
	// Upserts require plugin.secrets.read on the installed version, but listing and deleting deliberately
	// do not — leftover secrets must stay reachable after an upgrade drops the capability.
	const secretsInstallationId = installedItem ? installedItem.installation._id : null;
	const secretsCanAdd = installedVersion?.capabilities.includes("plugin.secrets.read") ?? false;
	const pluginConfiguration = installedVersion?.configuration ?? null;
	// Access describes what the installed version can do. The marketplace listing can be a newer
	// version the member has not accepted yet.
	const accessPlugin = installedVersion
		? {
				...plugin,
				capabilities: installedVersion.capabilities,
				outboundOrigins: installedVersion.outboundOrigins,
				uiOutboundOrigins: installedVersion.uiOutboundOrigins,
				pages: installedVersion.pages,
				fileViews: installedVersion.fileViews,
				mcpServers: installedVersion.mcpServers,
				skills: installedVersion.skills,
				mounts: installedVersion.mounts,
				events: installedVersion.events,
			}
		: plugin;

	return (
		<main
			className={cn(
				"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames,
				"app-scrollable" satisfies AppClassName,
			)}
		>
			<div className={"RoutePluginsPlugin-content" satisfies RoutePluginsPlugin_ClassNames}>
				{breadcrumb}

				<header
					className={"RoutePluginsPluginHero" satisfies RoutePluginsPlugin_ClassNames}
					{...({
						"data-organization-policy": plugin.organizationPolicy,
					} satisfies RoutePluginsPlugin_CustomAttributes)}
				>
					<Puzzle aria-hidden className={"RoutePluginsPluginHero-icon" satisfies RoutePluginsPlugin_ClassNames} />
					<div className={"RoutePluginsPluginHero-info" satisfies RoutePluginsPlugin_ClassNames}>
						<div className={"RoutePluginsPluginHero-titleRow" satisfies RoutePluginsPlugin_ClassNames}>
							<h1
								ref={heroTitleRef}
								tabIndex={-1}
								className={"RoutePluginsPluginHero-title" satisfies RoutePluginsPlugin_ClassNames}
							>
								{plugin.displayName}
							</h1>
							{plugin.reviewStatus !== "passed" || installationId ? (
								<div className={"RoutePluginsPluginHero-statuses" satisfies RoutePluginsPlugin_ClassNames}>
									{plugin.reviewStatus !== "passed" ? (
										<MyBadge variant={plugin.reviewStatus === "rejected" ? "destructive" : "outline"}>
											{plugin.reviewStatus}
										</MyBadge>
									) : null}
									{installedItem ? (
										<MyBadge variant={installedItem.installation.status === "enabled" ? "secondary" : "outline"}>
											{installedItem.installation.status === "enabled" ? "Installed" : "Disabled"}
										</MyBadge>
									) : null}
									{installationId && !installedItem ? <MyBadge variant="secondary">Installed</MyBadge> : null}
								</div>
							) : null}
						</div>
						<div className={"RoutePluginsPluginHero-meta" satisfies RoutePluginsPlugin_ClassNames}>
							<span>Version {plugin.version}</span>
							{installedVersion && installedVersion.version !== plugin.version ? (
								<span>Installed version {installedVersion.version}</span>
							) : null}
							<span>Published by {plugin.publisherDisplayName ?? "unknown publisher"}</span>
							{publisherPlugin ? (
								<a
									className={"RoutePluginsPluginHero-repoLink" satisfies RoutePluginsPlugin_ClassNames}
									href={publisherPlugin.repository.repositoryUrl}
									target="_blank"
									rel="noreferrer"
								>
									<GitBranch aria-hidden />
									{publisherPlugin.repository.owner}/{publisherPlugin.repository.repo}
								</a>
							) : null}
						</div>
						<p className={"RoutePluginsPluginHero-description" satisfies RoutePluginsPlugin_ClassNames}>
							{plugin.description.trim().length > 0 ? plugin.description : "No description provided."}
						</p>
					</div>
					<div className={"RoutePluginsPluginHero-actions" satisfies RoutePluginsPlugin_ClassNames}>
						<div className={"RoutePluginsPluginHero-actions-buttons" satisfies RoutePluginsPlugin_ClassNames}>
							{publisherPlugin ? (
								<PluginsPublishButton
									repositoryId={publisherPlugin.repository._id}
									repositoryLabel={`${publisherPlugin.repository.owner}/${publisherPlugin.repository.repo}`}
									buttonVariant={showInstall ? "outline" : "default"}
									disabled={installing || uninstalling || removing}
								/>
							) : null}
							{showInstall ? (
								// `installing` can only be true while the consent modal holds the focus, so
								// this disable never blurs a focused control; it only stops reopening the
								// modal mid-install.
								<MyButton
									disabled={
										publishBusy ||
										managementBusy ||
										installing ||
										uninstalling ||
										removing ||
										installationBlocked ||
										policyNote !== null
									}
									onClick={handleOpenConsent}
								>
									<Download aria-hidden />
									{installAction}
								</MyButton>
							) : null}
							{installedItem ? (
								installedItem.installation.status === "enabled" ? (
									<MyButton
										variant="outline"
										disabled={publishBusy || installing || removing || (managementBusy && !disabling)}
										aria-busy={disabling || undefined}
										onClick={handleDisable}
									>
										{disabling ? "Disabling…" : "Disable"}
									</MyButton>
								) : null
							) : null}
							{installedItem ? (
								<MyButton
									variant="ghost_destructive"
									disabled={publishBusy || installing || removing || (managementBusy && !uninstalling)}
									aria-busy={uninstalling}
									onClick={(event) => handleUninstall(installedItem.installation, event.currentTarget)}
								>
									<Trash2 aria-hidden />
									{uninstalling ? "Uninstalling..." : "Uninstall"}
								</MyButton>
							) : null}
							{publisherPlugin ? (
								<MyMenu placement="bottom-end">
									<MyMenuTrigger>
										{/* Never disable this trigger mid-flight: the menu closes on activation and
										    gives its focus back here, and a disabled control cannot take it, so the
										    focus would fall to the page body. The menu item's own disable and the
										    handler's guard already stop a second run. */}
										<MyIconButton variant="ghost" tooltip="More actions">
											<MyIconButtonIcon>
												<Ellipsis />
											</MyIconButtonIcon>
										</MyIconButton>
									</MyMenuTrigger>
									<MyMenuPopover>
										<MyMenuPopoverContent>
											<MyMenuItem
												variant="destructive"
												disabled={publishBusy || managementBusy || installing || uninstalling || removing}
												onClick={handleRemoveClaim}
											>
												<MyMenuItemContent>
													<MyMenuItemContentIcon>
														<Trash2 />
													</MyMenuItemContentIcon>
													<MyMenuItemContentPrimary>
														{removing ? "Removing claim..." : "Remove claim"}
													</MyMenuItemContentPrimary>
												</MyMenuItemContent>
											</MyMenuItem>
										</MyMenuPopoverContent>
									</MyMenuPopover>
								</MyMenu>
							) : null}
						</div>
						{installationBlocked && showInstall ? (
							<p className={"RoutePluginsPluginHero-action-note" satisfies RoutePluginsPlugin_ClassNames}>
								Installation is blocked by this release's review verdict.
							</p>
						) : null}
						{policyNote !== null && showInstall ? (
							<p className={"RoutePluginsPluginHero-action-note" satisfies RoutePluginsPlugin_ClassNames}>
								{policyNote}
							</p>
						) : null}
						{disableError ? <p role="alert">{disableError}</p> : null}
					</div>
				</header>

				{installedItem ? (
					<PluginsManagementAccess
						key={`management:${installedItem.installation._id}`}
						membershipId={membershipId}
						organizationId={organizationId}
						workspaceId={workspaceId}
						installationId={installedItem.installation._id}
						onSaved={() => heroTitleRef.current?.focus()}
					/>
				) : null}
				{installationId ? (
					<PluginsMyRunPermissions
						key={`permissions:${installationId}`}
						membershipId={membershipId}
						installationId={installationId}
						canManage={installedItem !== null}
					/>
				) : null}
				{installedItem ? (
					<RoutePluginsSchedule
						key={`schedule:${installedItem.installation._id}`}
						membershipId={membershipId}
						installationId={installedItem.installation._id}
						disabled={publishBusy || managementBusy || installing}
					/>
				) : null}
				{installedItem ? (
					<RoutePluginsMounts membershipId={membershipId} installationId={installedItem.installation._id} />
				) : null}
				{/* Health renders only for an installed plugin: the query returns null otherwise. */}
				{installedItem ? (
					<RoutePluginsPluginHealth
						membershipId={membershipId}
						pluginName={plugin.name}
						onOpenSecrets={() => setManagingSecrets(true)}
					/>
				) : null}
				{installedItem ? (
					<section className={"RoutePluginsPluginConsentModal-accountFields" satisfies RoutePluginsPlugin_ClassNames}>
						<h2>Service account</h2>
						<p>{currentAccount?.revokedAt === null ? currentAccount.name : "Service account unavailable"}</p>
						{canManageAccounts === true ? (
							<>
								<ServiceAccountSelect
									value={rebindAccountId}
									label="Replacement service account"
									disabled={rebinding}
									onChange={(value) => {
										if (!rebinding) {
											setRebindAccountId(value);
										}
									}}
								/>
								<p>
									Changing accounts stops work using the old account. It does not move grants or change existing file
									policies.
								</p>
								<MyButton
									variant="outline"
									disabled={!rebindAccountId || publishBusy || (managementBusy && !rebinding)}
									aria-busy={rebinding || undefined}
									onClick={handleRebind}
								>
									{rebinding ? "Changing…" : "Change service account"}
								</MyButton>
							</>
						) : (
							<p>You need permission to manage service accounts to change this binding.</p>
						)}
					</section>
				) : null}
				{secretsInstallationId || publisherPlugin ? (
					<RoutePluginsPluginSecrets
						membershipId={membershipId}
						installationId={secretsInstallationId}
						installationCanAdd={secretsCanAdd}
						publisherRepositoryId={publisherPlugin?.repository._id ?? null}
						managing={managingSecrets}
						onManagingChange={setManagingSecrets}
					/>
				) : null}
				{publisherPlugin ? <RoutePluginsPluginService pluginName={plugin.name} /> : null}
				{installedItem && pluginConfiguration && installedItem.installation.configurationYaml !== null ? (
					<RoutePluginsPluginConfiguration
						key={installedItem.installation._id}
						membershipId={membershipId}
						installationId={installedItem.installation._id}
						configurationYaml={installedItem.installation.configurationYaml}
						description={pluginConfiguration.description}
						events={installedItem.version.events}
						mounts={installedItem.version.mounts}
					/>
				) : null}
				<RoutePluginsPluginAccess
					plugin={accessPlugin}
					payerName={payerName}
					handlers={installedItem?.handlers ?? null}
					configurationYaml={installedItem?.installation.configurationYaml ?? null}
					events={installedItem?.version.events ?? null}
					mounts={installedItem?.version.mounts ?? plugin.mounts}
					mcpServerStatuses={mcpServerStatuses ?? null}
					installationId={installedItem?.installation._id ?? null}
					installationEnabled={installedItem?.installation.status === "enabled"}
					onMcpDisconnect={handleMcpDisconnect}
				/>

				{publisherPlugin ? (
					<RoutePluginsPluginPublisherReleases
						versions={publisherPlugin.versions}
						reviews={publisherPlugin.reviews}
						lastPublishAttempt={publisherPlugin.repository.lastPublishAttempt}
						historyIsTruncated={publisherPlugin.historyIsTruncated}
					/>
				) : null}
				{installedItem ? (
					<RoutePluginsInstalledRuns membershipId={membershipId} installationId={installedItem.installation._id} />
				) : null}

				<MyModal open={consenting} setOpen={handleConsentOpenChange}>
					<MyModalPopover className={"RoutePluginsPluginConsentModal" satisfies RoutePluginsPlugin_ClassNames}>
						<MyModalHeader>
							<MyModalHeading>
								{installAction} {plugin.displayName}
							</MyModalHeading>
							<MyModalDescription>
								{plugin.name}@{plugin.version} · {plugin.publisherDisplayName ?? "unknown publisher"}
							</MyModalDescription>
						</MyModalHeader>
						{plugin.configuration ? (
							<div className={"RoutePluginsPluginConsentModal-accountFields" satisfies RoutePluginsPlugin_ClassNames}>
								<MyInput displayValidationMessage={installConfiguration?._nay?.message}>
									<MyInputLabel>Configuration YAML</MyInputLabel>
									<MyInputArea>
										<MyInputBox />
										<MyInputTextAreaControl
											value={installYaml}
											rows={10}
											readOnly={installing}
											validationMessage={installConfiguration?._nay?.message}
											onChange={(event) => {
												setInstallYaml(event.currentTarget.value);
												setInstallError(null);
											}}
										/>
									</MyInputArea>
								</MyInput>
								{installConfiguration?._nay ? <p role="alert">{installConfiguration._nay.message}</p> : null}
								<p>{plugin.configuration.description}</p>
							</div>
						) : null}
						{plugin.mounts.length > 0 ? (
							<div className={"RoutePluginsPluginConsentModal-accountFields" satisfies RoutePluginsPlugin_ClassNames}>
								<h3>Mount folders</h3>
								<ul>
									{plugin.mounts.map((mount) => (
										<li key={mount.id}>
											<strong>{installConfiguration?._yay?.mountNames[mount.id] ?? mount.id}</strong> ·{" "}
											{mount.description}
											{installedVersion && consentDiff.newMounts.some((added) => added.id === mount.id) ? (
												<MyBadge variant="secondary">new</MyBadge>
											) : null}
										</li>
									))}
								</ul>
							</div>
						) : null}
						{consentDiff.droppedMounts.length > 0 ? (
							<p
								role="alert"
								className={"RoutePluginsPluginConsentModal-baseline" satisfies RoutePluginsPlugin_ClassNames}
							>
								This update removes mount folders and deletes all their stored files:{" "}
								{installedConfiguration?._yay
									? consentDiff.droppedMounts
											.map((mount) => `/.mounts/${installedConfiguration._yay.mountNames[mount.id]}`)
											.join(", ")
									: "Folder names are unavailable in the saved configuration"}
								.
							</p>
						) : null}
						{hasSchedule ? (
							<div className={"RoutePluginsPluginConsentModal-accountFields" satisfies RoutePluginsPlugin_ClassNames}>
								<h3>
									Schedule
									{installedVersion && consentDiff.scheduleAdded ? <MyBadge variant="secondary">new</MyBadge> : null}
								</h3>
								<p>
									{installConfiguration?._yay?.scheduleIntervalMinutes
										? `Runs every ${installConfiguration._yay.scheduleIntervalMinutes} minutes`
										: "Choose a valid schedule interval in the YAML above."}
								</p>
								{installedItem ? (
									<RoutePluginsScheduledUserSelect
										membershipId={membershipId}
										installationId={installedItem.installation._id}
										value={installRunUser?.grantId ?? "me"}
										includeMe
										disabled={installing}
										onChange={(user) => {
											setInstallRunUser(user);
											setInstallError(null);
										}}
										onSelectionValidChange={setInstallRunUserValid}
									/>
								) : (
									<p>Run as: Me. Other people can be selected after they grant access to this installation.</p>
								)}
								{installRunUser === null ? (
									<PluginsRunConsent
										key={installConsentSession}
										membershipId={membershipId}
										capabilities={plugin.capabilities}
										canManage
										disabled={installing}
										onChange={handleInstallConsentChange}
									/>
								) : (
									<p>{installRunUser.displayName}'s own grant will be checked before installation.</p>
								)}
								<p>
									Scheduled Mount writes are billed to {payerName}. The selected user's access is checked each time.
								</p>
							</div>
						) : null}

						{/* Platform baseline a run receives, so it is only true for a plugin that can get one. A
						    page-only plugin never starts a run, and its page token carries no write scope at
						    all, so telling an admin otherwise would overstate what they are granting. */}
						<div className={"RoutePluginsPluginConsentModal-accountFields" satisfies RoutePluginsPlugin_ClassNames}>
							<ServiceAccountSelect
								value={installAccountId ?? installedItem?.installation.serviceAccountId ?? null}
								emptyLabel={installedItem ? "Keep current account" : "Create an empty account"}
								disabled={installing || canManageAccounts !== true}
								onChange={(value) => {
									if (!installing && canManageAccounts === true) {
										setInstallAccountId(value ?? undefined);
										setInstallGrants([]);
									}
								}}
							/>
							<p>
								{installedItem
									? "Updates keep existing grants unless you add a reviewed grant below."
									: "New accounts start without file access. Choose an existing account to review its grants here."}
							</p>
							{!installedItem && canManageAccounts !== true ? (
								<p>
									You can install with a new empty account. Choosing an existing account or adding file grants needs
									permission to manage service accounts.
								</p>
							) : null}
							{canManageAccounts === true && (installAccountId ?? installedItem?.installation.serviceAccountId) ? (
								<RoutePluginsServiceAccountGrants
									key={installAccountId ?? installedItem?.installation.serviceAccountId}
									serviceAccountId={(installAccountId ?? installedItem?.installation.serviceAccountId)!}
									grants={installGrants}
									disabled={installing}
									onChange={setInstallGrants}
								/>
							) : null}
						</div>
						{plugin.canProcessFiles ? (
							<p className={"RoutePluginsPluginConsentModal-baseline" satisfies RoutePluginsPlugin_ClassNames}>
								This plugin can read the triggering upload and create Markdown files beside it when its account grants
								allow it.
							</p>
						) : null}

						<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
							This plugin can use these capabilities
						</div>
						<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
							{plugin.capabilities.map((capability) => (
								<li
									key={capability}
									className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
									// The label is prettified, so keep the raw manifest id reachable. This dialog is where
									// an admin grants elevated access, so it must map back to the id the manifest declares.
									title={capability}
								>
									{format_capability_label(capability, payerName)}
									{installedVersion && consentDiff.newCapabilities.includes(capability) ? (
										<MyBadge variant="secondary">new</MyBadge>
									) : null}
								</li>
							))}
						</ul>
						{/* Every other capability is used by code the app runs. This one hands a token to a
						    server outside the app, which then keeps working while no frame of this plugin is open.
						    A file view starts that exchange exactly as a page does: both mint their token from the
						    same session table, and the exchange only checks that the token is a UI token, never
						    which frame minted it. So name both surfaces, like the frame egress section below. */}
						{plugin.capabilities.includes("plugin.service.connect") ? (
							<p className={"RoutePluginsPluginConsentModal-baseline" satisfies RoutePluginsPlugin_ClassNames}>
								This plugin's pages and file views can pass their access to the publisher's own server. That server can
								keep using the capabilities above while nobody is using the plugin. Uninstalling stops it.
							</p>
						) : null}
						{plugin.pages.length > 0 ? (
							<>
								{/* One-line explanation doubles as the section title, like the other consent sections. */}
								<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
									This plugin includes these workspace pages
								</div>
								<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
									{plugin.pages.map((page) => (
										<li
											key={page.id}
											className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
										>
											{page.title}
											{page.navItem ? ` — sidebar item: ${page.navItem.label}` : ""}
										</li>
									))}
								</ul>
							</>
						) : null}
						{plugin.fileViews.length > 0 ? (
							<>
								<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
									This plugin adds these views when a member opens a file
								</div>
								<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
									{plugin.fileViews.map((fileView) => (
										<li
											key={fileView.id}
											className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
										>
											{fileView.title} — {fileView.contentTypes.join(", ")}
										</li>
									))}
								</ul>
							</>
						) : null}
						{/* Reviewed page code is trusted; the iframe is host isolation, not data containment. A file
						    view grants the same thing. It mints its session from the same table, and that session gets
						    the same workspace-wide file scopes a page gets. The file it was opened from narrows
						    nothing. So keep this warning outside both surface gates. Inside the pages gate, a plugin
						    that ships only file views would show no warning at all. */}
						{plugin.pages.length > 0 || plugin.fileViews.length > 0 ? (
							<p className={"RoutePluginsPluginConsentModal-baseline" satisfies RoutePluginsPlugin_ClassNames}>
								Plugin pages and file views are trusted with the data their capabilities expose. They can send that data
								away by navigating, even when no backend origin is listed.
							</p>
						) : null}
						{plugin.mcpServers.length > 0 ? (
							<>
								<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
									The chat agent can call these MCP servers
								</div>
								<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
									{plugin.mcpServers.map((server) => (
										<li
											key={server.id}
											className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
										>
											{server.title} — {new URL(server.url).host} — {format_mcp_server_auth(server)}
											{server.tools ? ` — tools: ${server.tools.join(", ")}` : ""}
											{installedVersion && consentDiff.newOrChangedMcpServerIds.includes(server.id) ? (
												<MyBadge variant="secondary">new</MyBadge>
											) : null}
										</li>
									))}
								</ul>
								<p className={"RoutePluginsPluginConsentModal-baseline" satisfies RoutePluginsPlugin_ClassNames}>
									MCP servers are outside services. When the agent calls a tool, the chat sends that call's data to the
									server without asking.
								</p>
							</>
						) : null}
						{plugin.skills.length > 0 ? (
							<>
								<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
									This plugin adds these skills to the chat agent
								</div>
								<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
									{plugin.skills.map((skill) => (
										<li
											key={skill.name}
											className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
										>
											{skill.name} — {skill.description}
											{installedVersion && consentDiff.newSkillNames.includes(skill.name) ? (
												<MyBadge variant="secondary">new</MyBadge>
											) : null}
										</li>
									))}
								</ul>
							</>
						) : null}
						<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
							Backend requests can go to these origins
						</div>
						{plugin.outboundOrigins.length === 0 ? (
							<div className={"RoutePluginsPluginConsentModal-empty" satisfies RoutePluginsPlugin_ClassNames}>
								No backend outbound origins requested.
							</div>
						) : (
							<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
								{plugin.outboundOrigins.map((origin) => (
									<li
										key={origin}
										className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
									>
										{origin}
										{installedVersion && consentDiff.newOutboundOrigins.includes(origin) ? (
											<MyBadge variant="secondary">new</MyBadge>
										) : null}
									</li>
								))}
							</ul>
						)}

						{/* Frame egress is consented separately from backend egress: the frame runs with a member's
						    session token, so whatever it may reach is reachable by anything running inside it. The
						    list is declared on the plugin version and applied to every asset response, so it widens
						    a file view's policy exactly as it widens a page's. */}
						{plugin.uiOutboundOrigins.length > 0 ? (
							<>
								<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
									This plugin's pages and file views can call these origins from your browser
								</div>
								<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
									{plugin.uiOutboundOrigins.map((origin) => (
										<li
											key={origin}
											className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
										>
											{origin}
											{installedVersion && consentDiff.newUiOutboundOrigins.includes(origin) ? (
												<MyBadge variant="secondary">new</MyBadge>
											) : null}
										</li>
									))}
								</ul>
							</>
						) : null}

						<div className={"RoutePluginsPluginConsentModal-actions" satisfies RoutePluginsPlugin_ClassNames}>
							{/* Cancel may keep its disable: when it flips, the focus sits on the pressed
							    Accept button (kept enabled below), so no focused control is blurred, and it
							    stops closing the modal while the install commits. */}
							<MyButton variant="ghost" disabled={installing} onClick={() => setConsenting(false)}>
								Cancel
							</MyButton>
							<MyButton
								disabled={
									publishBusy ||
									(managementBusy && !installing) ||
									(!showInstall && !installing) ||
									(!installing &&
										((hasSchedule && !installRunUser && !installConsent) ||
											(hasSchedule && !!installRunUser && !installRunUserValid) ||
											!!installConfiguration?._nay)) ||
									(canManageAccounts !== true && (installAccountId !== undefined || installGrants.length > 0))
								}
								aria-busy={installing}
								onClick={() => handleAcceptAndInstall(plugin)}
							>
								<Download aria-hidden />
								{installing ? installProgress : `Accept and ${installAction.toLowerCase()}`}
							</MyButton>
						</div>
						{installError ? <p role="alert">{installError}</p> : null}
						<MyModalCloseTrigger />
					</MyModalPopover>
				</MyModal>
			</div>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/$pluginName")({
	// Clear plugin-local dialogs and progress when this route moves to another tenant or plugin.
	// The root provider keeps the shared action lock alive until the old request settles.
	remountDeps: ({ params }) => ({
		organizationName: params.organizationName,
		workspaceName: params.workspaceName,
		pluginName: params.pluginName,
	}),
	component: RoutePluginsPlugin,
});

export { Route };
// #endregion root

// #region tests
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("format_capability_label", () => {
		test("names the read-only capability instead of spelling out its id", () => {
			// An admin reads this string to decide whether to grant the access, and the plain rule
			// turns the id into "Workspace Files Create Read Only", which reads as create-and-read
			// access. Nothing pinned this label before, which is how it was lost once already.
			expect(format_capability_label("workspace.files.create-read-only")).toBe("Create read-only workspace files");
		});

		test("names the frame outbound capability apart from the backend one", () => {
			// The plain rule writes "Ui", and it lands one word away from `outbound.fetch`. These are
			// two different consents, so an admin must be able to tell them apart at a glance. The label
			// names both frame kinds because the origins it grants reach a file view as well as a page.
			const frameLabel = format_capability_label("ui.outbound.fetch");
			expect(frameLabel).toBe("Call allowed outside origins from its pages and file views");
			expect(frameLabel).not.toContain("Ui");
			expect(frameLabel).not.toBe(format_capability_label("outbound.fetch"));
		});

		test("names the member write capability apart from the backend one", () => {
			// The plain rule writes "Plugin Data User Write", which reads as "the user's plugin data"
			// instead of naming who writes. It also lands one word away from `plugin.data.write`. These
			// are two different doors: that one writes as the installation from the plugin's backend or
			// service, this one writes as the member from a plugin frame. An admin must be able to tell
			// the two consents apart at a glance.
			const memberLabel = format_capability_label("plugin.data.user-write");
			expect(memberLabel).toBe("Write its plugin data as the acting member, from its pages and file views");
			expect(memberLabel).not.toBe(format_capability_label("plugin.data.write"));
		});

		test("says the roster capability lists members and stops short of their emails", () => {
			// This is the one capability an admin grants for its privacy step, so the label has to name
			// the step: the plugin reads the list itself, not just names for ids it already stored. The
			// plain rule writes "Workspace Members Read", which says neither half. The label also states
			// what a row does not carry, because the app's own member helper does return email and an
			// admin has no way to know this door does not use it.
			const rosterLabel = format_capability_label("workspace.members.read");
			expect(rosterLabel).toBe("List every member of this workspace, with their display names but not their emails");
			expect(rosterLabel).not.toBe(format_access_label("workspace.members.read"));
		});

		test("names the invoke capability instead of spelling out its id", () => {
			// The plain rule writes "Plugin Backend Invoke", three nouns with no actor. The label
			// must say a member's use of the plugin's frames is what runs the publisher's code.
			const invokeLabel = format_capability_label("plugin.backend.invoke");
			expect(invokeLabel).toBe("Run its backend when a member uses its pages and file views");
			expect(invokeLabel).not.toBe(format_access_label("plugin.backend.invoke"));
		});

		test("explains editable labels and member control for plugin file capabilities", () => {
			const ownWriteLabel = format_capability_label("workspace.files.own-write");
			expect(ownWriteLabel).toBe(
				"Create, update, and archive files and folders marked for this plugin. Members can edit their labels.",
			);
			const ownAccessLabel = format_capability_label("workspace.files.own-access");
			expect(ownAccessLabel).toBe(
				"Set locks and readers for its output. Members with manage permission can change them.",
			);
			expect(ownWriteLabel).not.toBe(format_capability_label("workspace.files.write"));
			expect(ownAccessLabel).not.toBe(ownWriteLabel);
		});

		test("spells out every other capability with the shared rule", () => {
			expect(format_capability_label("workspace.files.write")).toBe("Workspace Files Write");
		});

		test("leaves event types to the shared rule", () => {
			// `format_access_label` also renders `event.type`, so it must carry no capability spellings.
			// The hyphenated ids are the ones an override rewrites, so check the shared rule still spells
			// them plainly.
			expect(format_access_label("workspace.files.create-read-only")).toBe("Workspace Files Create Read Only");
			expect(format_access_label("plugin.data.user-write")).toBe("Plugin Data User Write");
		});
	});

	describe("RoutePluginsPluginPublisherReleases", () => {
		test("keeps the latest failed publish visible", async () => {
			const { renderToStaticMarkup } = await import("react-dom/server");
			const html = renderToStaticMarkup(
				<RoutePluginsPluginPublisherReleases
					versions={[]}
					reviews={[]}
					historyIsTruncated={false}
					lastPublishAttempt={{
						at: 1234,
						pluginName: "media",
						status: "failed",
						message: "Plugin review model step failed; try again",
						commitSha: null,
						artifactHash: null,
						reviewId: null,
					}}
				/>,
			);

			expect(html).toContain("Plugin review model step failed; try again");
			expect(html).toContain("failed");
		});

		test("shows when a retried version became ready as its publish time", async () => {
			const { renderToStaticMarkup } = await import("react-dom/server");
			const createdAt = new Date("2025-01-01T00:00:00.000Z").getTime();
			const readyAt = new Date("2026-02-02T00:00:00.000Z").getTime();
			const version = {
				_id: "version-id",
				_creationTime: createdAt,
				artifactHash: `sha256:${"1".repeat(64)}`,
				name: "media",
				version: "0.1.0",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				reviewId: null,
				reviewStatus: "passed",
				updatedAt: readyAt,
			} as RoutePlugins_PublisherPlugin["versions"][number];
			const html = renderToStaticMarkup(
				<RoutePluginsPluginPublisherReleases
					versions={[version]}
					reviews={[]}
					historyIsTruncated={false}
					lastPublishAttempt={undefined}
				/>,
			);

			expect(html).toContain(`published ${format_datetime(readyAt)}`);
			expect(html).not.toContain(`published ${format_datetime(createdAt)}`);
		});
	});

	describe("get_publisher_version", () => {
		test("sets canProcessFiles only for a backend with a file event", () => {
			// A publisher who cannot manage workspace plugins reads the consent copy from this object
			// instead of `list_published_plugins`, which uses the same backend and file-event rule.
			// This test pins this producer only. The route imports the generated API, never
			// `convex/plugins.ts`, so nothing in the `src` project can see the Convex copy of the rule.
			// Keeping the two in step is manual: change one and nothing here turns red.
			const version = {
				_id: "version-id",
				name: "media",
				displayName: "Media",
				description: "",
				version: "0.1.0",
				reviewStatus: "passed",
				capabilities: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				pages: [],
				fileViews: [],
				backendEntrypointFile: null,
				events: [],
				mounts: [],
			} as unknown as RoutePlugins_PublisherPlugin["versions"][number];
			const publisher_plugin = (versionOverrides: Partial<RoutePlugins_PublisherPlugin["versions"][number]>) =>
				({ versions: [{ ...version, ...versionOverrides }] }) as RoutePlugins_PublisherPlugin;
			const uploadEvents: RoutePlugins_PublisherPlugin["versions"][number]["events"] = [
				{ type: "files.upload.completed", contentTypes: ["image/png"], filters: [] },
			];
			const scheduleEvents: RoutePlugins_PublisherPlugin["versions"][number]["events"] = [
				{
					type: "schedule.interval.elapsed",
					contentTypes: [],
					filters: [],
					schedule: { configurationPath: ["schedule", "everyMinutes"] },
				},
			];
			const backendEntrypointFile = {
				entry: "dist/backend/worker.js",
				moduleName: "plugin.js",
				r2Key: "plugins/media/backend/worker.js",
				sha256: `sha256:${"b".repeat(64)}`,
				compatibilityDate: "2026-07-01",
				compatibilityFlags: [],
			};

			expect(get_publisher_version(publisher_plugin({ backendEntrypointFile, events: uploadEvents }))).toMatchObject({
				canProcessFiles: true,
			});
			expect(get_publisher_version(publisher_plugin({ events: uploadEvents }))).toMatchObject({
				canProcessFiles: false,
			});
			expect(get_publisher_version(publisher_plugin({ backendEntrypointFile }))).toMatchObject({
				canProcessFiles: false,
			});
			expect(get_publisher_version(publisher_plugin({}))).toMatchObject({ canProcessFiles: false });
			expect(get_publisher_version(publisher_plugin({ backendEntrypointFile, events: scheduleEvents }))).toMatchObject({
				canProcessFiles: false,
			});
			expect(
				get_publisher_version(
					publisher_plugin({ backendEntrypointFile, events: [...uploadEvents, ...scheduleEvents] }),
				),
			).toMatchObject({ canProcessFiles: true });
			expect(
				get_publisher_version(
					publisher_plugin({
						backendEntrypointFile,
						events: [{ type: "users.account.deleted", contentTypes: [], filters: [] }],
					}),
				),
			).toMatchObject({ canProcessFiles: false });
			const mounts = [{ id: "repos", description: "External repositories.", configurationPath: ["mount", "name"] }];
			expect(
				get_publisher_version(publisher_plugin({ backendEntrypointFile, mounts, events: scheduleEvents })),
			).toMatchObject({
				mounts,
				events: scheduleEvents,
				canInstall: false,
				canManage: false,
			});
		});
	});
}
// #endregion tests
