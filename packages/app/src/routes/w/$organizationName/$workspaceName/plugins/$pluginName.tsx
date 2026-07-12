import "./plugin.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
	ChevronRight,
	Clock3,
	Download,
	Ellipsis,
	GitBranch,
	History,
	KeyRound,
	Puzzle,
	Save,
	ShieldCheck,
	Trash2,
	UploadCloud,
} from "lucide-react";
import { memo, useState, type ClipboardEvent, type FormEvent } from "react";
import { toast } from "sonner";

import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
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
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_datetime } from "@/lib/date.ts";
import { cn } from "@/lib/utils.ts";
import {
	plugins_consent_diff,
	plugins_parse_env_text,
	plugins_validate_secret_name,
} from "../../../../../../shared/plugins.ts";

type RoutePlugins_Installation = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_installations
>[number];

type RoutePlugins_PublishedPlugin = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_published_plugins
>[number];

type RoutePlugins_PublisherPlugin = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.plugins.get_publisher_plugin>
>;

// #region secrets
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
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);

	const scopeLabel = target.scope === "workspace" ? "Workspace" : "Plugin";
	const canAdd = target.scope === "plugin" || target.canAdd;

	const handleSaveSecret = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (saving || deleting || !name.trim() || !value) {
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
		if (saving || deleting) {
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
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleEnvPaste] Failed to import secrets:", { error, scope: target.scope });
				toast.error("Failed to import secrets");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	const handleDeleteSecret = useFn((secretName: string) => {
		setDeleting(true);
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
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleDeleteSecret] Failed to delete secret:", {
					error,
					scope: target.scope,
				});
				toast.error("Failed to delete secret");
			})
			.finally(() => {
				setDeleting(false);
			});
	});

	return (
		<div className={"RoutePluginsPluginSecretsModalPanel" satisfies RoutePluginsPluginSecretsModalPanel_ClassNames}>
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
									disabled={saving || deleting}
									onClick={() => handleDeleteSecret(secret.name)}
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
						<MyInput>
							<MyInputLabel>Name</MyInputLabel>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
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
						<MyInput>
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
						<MyButton type="submit" disabled={saving || deleting || !name.trim() || !value}>
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
};

const RoutePluginsPluginSecrets = memo(function RoutePluginsPluginSecrets(props: RoutePluginsPluginSecrets_Props) {
	const { membershipId, installationId, installationCanAdd, publisherRepositoryId } = props;
	const [managing, setManaging] = useState(false);
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
			<MyButton variant="outline" onClick={() => setManaging(true)}>
				Manage secrets
			</MyButton>
			{/* Mounted per open so form state resets and the secret queries only subscribe while managing. */}
			{managing ? (
				<RoutePluginsPluginSecretsModal
					membershipId={membershipId}
					installationId={installationId}
					installationCanAdd={installationCanAdd}
					publisherRepositoryId={publisherRepositoryId}
					onClose={() => setManaging(false)}
				/>
			) : null}
		</section>
	);
});
// #endregion secrets

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
	const runs = useQuery(app_convex_api.plugins.list_recent_runs, { membershipId, installationId });

	return (
		<details className={"RoutePluginsInstalledRuns" satisfies RoutePluginsInstalledRuns_ClassNames}>
			<summary className={"RoutePluginsInstalledRuns-summary" satisfies RoutePluginsInstalledRuns_ClassNames}>
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
				Latest executions in this workspace.
			</p>

			{runs === undefined ? (
				<div className={"RoutePluginsInstalledRuns-empty" satisfies RoutePluginsInstalledRuns_ClassNames} role="status">
					Loading runs...
				</div>
			) : runs.length === 0 ? (
				<div className={"RoutePluginsInstalledRuns-empty" satisfies RoutePluginsInstalledRuns_ClassNames}>
					No activity yet.
				</div>
			) : (
				<div className={"RoutePluginsInstalledRuns-list" satisfies RoutePluginsInstalledRuns_ClassNames}>
					{runs.map((run) => (
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
								{format_datetime(run.updatedAt)} · {format_run_duration(run.runnerElapsedMs)} · {run.apiCallCount} API
								call{run.apiCallCount === 1 ? "" : "s"} · {run.outputWriteCount} file
								{run.outputWriteCount === 1 ? "" : "s"} written
							</div>
							{run.errorMessage ? (
								<div className={"RoutePluginsInstalledRunItem-error" satisfies RoutePluginsInstalledRuns_ClassNames}>
									{run.errorMessage}
								</div>
							) : null}
						</div>
					))}
				</div>
			)}
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
	| "RoutePluginsPluginAccess-empty"
	| "RoutePluginsPluginAccess-trigger"
	| "RoutePluginsPluginAccess-trigger-name"
	| "RoutePluginsPluginAccess-trigger-types";

type RoutePluginsPluginAccess_Props = {
	plugin: RoutePlugins_PublishedPlugin;
	handlers: RoutePlugins_Installation["handlers"] | null;
};

function format_access_label(value: string) {
	return value
		.split(/[._]/)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

const RoutePluginsPluginAccess = memo(function RoutePluginsPluginAccess(props: RoutePluginsPluginAccess_Props) {
	const { plugin, handlers } = props;
	const handlersByEvent = handlers?.reduce<Record<string, string[]>>((groups, handler) => {
		const contentTypes = groups[handler.event] ?? [];
		contentTypes.push(handler.contentType);
		groups[handler.event] = contentTypes;
		return groups;
	}, {});

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
								{format_access_label(capability)}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
				<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
					Network access
				</h3>
				{plugin.outboundOrigins.length === 0 ? (
					<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
						No external network access.
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

			{handlersByEvent ? (
				<section className={"RoutePluginsPluginAccess-group" satisfies RoutePluginsPluginAccess_ClassNames}>
					<h3 className={"RoutePluginsPluginAccess-group-title" satisfies RoutePluginsPluginAccess_ClassNames}>
						Triggers
					</h3>
					{Object.keys(handlersByEvent).length === 0 ? (
						<div className={"RoutePluginsPluginAccess-empty" satisfies RoutePluginsPluginAccess_ClassNames}>
							No active triggers.
						</div>
					) : (
						<ul className={"RoutePluginsPluginAccess-list" satisfies RoutePluginsPluginAccess_ClassNames}>
							{Object.entries(handlersByEvent).map(([event, contentTypes]) => (
								<li
									key={event}
									className={"RoutePluginsPluginAccess-trigger" satisfies RoutePluginsPluginAccess_ClassNames}
								>
									<span
										className={"RoutePluginsPluginAccess-trigger-name" satisfies RoutePluginsPluginAccess_ClassNames}
									>
										{format_access_label(event)}
									</span>
									<span
										className={"RoutePluginsPluginAccess-trigger-types" satisfies RoutePluginsPluginAccess_ClassNames}
									>
										{contentTypes.join(", ")}
									</span>
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
	| "RoutePluginsPluginPublisherReleases-empty"
	| "RoutePluginsPluginPublisherReleases-list"
	| "RoutePluginsPluginPublisherReleaseItem"
	| "RoutePluginsPluginPublisherReleaseItem-header"
	| "RoutePluginsPluginPublisherReleaseItem-name"
	| "RoutePluginsPluginPublisherReleaseItem-meta"
	| "RoutePluginsPluginPublisherReleaseItem-findings"
	| "RoutePluginsPluginPublisherReleaseItem-note";

type RoutePluginsPluginPublisherReleases_Props = {
	versions: RoutePlugins_PublisherPlugin["versions"];
	reviews: RoutePlugins_PublisherPlugin["reviews"];
};

const RoutePluginsPluginPublisherReleases = memo(function RoutePluginsPluginPublisherReleases(
	props: RoutePluginsPluginPublisherReleases_Props,
) {
	const { versions, reviews } = props;
	const reviewsByArtifactHash = new Map(reviews.map((review) => [review.artifactHash, review]));
	const releases: Array<{
		artifactHash: string;
		name: string;
		version: string;
		sourceCommitSha: string | null;
		publishedAt: number | null;
		reviewStatus: "passed" | "rejected" | "flagged" | "pending";
		review: RoutePlugins_PublisherPlugin["reviews"][number] | null;
	}> = versions.map((version) => {
		const review = reviewsByArtifactHash.get(version.artifactHash) ?? null;
		return {
			artifactHash: version.artifactHash,
			name: version.name,
			version: version.version,
			sourceCommitSha: version.sourceCommitSha,
			publishedAt: version._creationTime,
			reviewStatus: review?.status ?? version.reviewStatus,
			review,
		};
	});
	const publishedArtifactHashes = new Set(versions.map((version) => version.artifactHash));
	for (const review of reviews) {
		if (!publishedArtifactHashes.has(review.artifactHash)) {
			releases.push({
				artifactHash: review.artifactHash,
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
				Release history
			</h2>
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
						const findings = release.review ? [...release.review.mechanicalFindings, ...release.review.aiFindings] : [];
						return (
							<div
								key={release.artifactHash}
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
								{release.reviewStatus === "flagged" ? (
									<div
										className={
											"RoutePluginsPluginPublisherReleaseItem-note" satisfies RoutePluginsPluginPublisherReleases_ClassNames
										}
									>
										Installs of this version are blocked until the verdict is cleared.
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
	| "RoutePluginsPluginConsentModal-actions";

function RoutePluginsPlugin() {
	const { pluginName } = Route.useParams();
	const { membershipId } = AppTenantProvider.useContext();
	const plugins = useQuery(app_convex_api.plugins.list_published_plugins, { membershipId });
	const installations = useQuery(app_convex_api.plugins.list_installations, { membershipId });
	// Non-null only when the signed-in user owns this plugin's repository claim.
	const publisherPlugin = useQuery(app_convex_api.plugins.get_publisher_plugin, { pluginName });
	const [consenting, setConsenting] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [uninstalling, setUninstalling] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const [removing, setRemoving] = useState(false);

	const handleUninstall = useFn((installation: RoutePlugins_Installation["installation"]) => {
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
			});
	});

	const handlePublish = useFn(() => {
		if (!publisherPlugin) {
			return;
		}

		const repositoryId = publisherPlugin.repository._id;
		setPublishing(true);
		app_convex
			.action(app_convex_api.plugins.publish_version, { repositoryId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Published commit ${result._yay.sourceCommitSha.slice(0, 8)}`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handlePublish] Failed to publish plugin:", { error, repositoryId });
				toast.error("Failed to publish plugin");
			})
			.finally(() => {
				setPublishing(false);
			});
	});

	const handleRemoveClaim = useFn(() => {
		if (!publisherPlugin) {
			return;
		}

		const repositoryId = publisherPlugin.repository._id;
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
			});
	});

	const handleAcceptAndInstall = useFn((plugin: RoutePlugins_PublishedPlugin) => {
		setInstalling(true);
		app_convex
			.mutation(app_convex_api.plugins.install_version, {
				membershipId,
				pluginVersionId: plugin.pluginVersionId,
				acceptedCapabilities: plugin.capabilities,
				acceptedOutboundOrigins: plugin.outboundOrigins,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Installed ${plugin.name} ${plugin.version}`);
				setConsenting(false);
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleAcceptAndInstall] Failed to install plugin:", {
					error,
					pluginVersionId: plugin.pluginVersionId,
				});
				toast.error("Failed to install plugin");
			})
			.finally(() => {
				setInstalling(false);
			});
	});

	const breadcrumb = <PluginsHeaderBreadcrumb trail={["plugins"]} current={pluginName} />;

	if (plugins === undefined || installations === undefined) {
		return (
			<main className={"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames} role="status" aria-live="polite">
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

	const plugin = plugins.find((item) => item.name === pluginName) ?? null;
	if (plugin === null) {
		return (
			<main className={"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames}>
				<div className={"RoutePluginsPlugin-content" satisfies RoutePluginsPlugin_ClassNames}>
					{breadcrumb}
					<div className={"RoutePluginsPlugin-missing" satisfies RoutePluginsPlugin_ClassNames}>
						No published plugin is named "{pluginName}".
					</div>
				</div>
			</main>
		);
	}

	const installedItem = installations.find((item) => item.installation.pluginName === plugin.name) ?? null;
	const installedVersion = installedItem?.version;
	const consentDiff = plugins_consent_diff({
		current: installedVersion
			? { capabilities: installedVersion.capabilities, outboundOrigins: installedVersion.outboundOrigins }
			: null,
		target: { capabilities: plugin.capabilities, outboundOrigins: plugin.outboundOrigins },
	});
	// Installed-and-current shows only Uninstall; reinstalling means uninstalling and installing again.
	const installAction = installedVersion ? "Update" : "Install";
	const installProgress = installAction === "Update" ? "Updating..." : "Installing...";
	const showInstall = !installedVersion || installedVersion.version !== plugin.version;
	const installationBlocked = plugin.reviewStatus === "rejected" || plugin.reviewStatus === "flagged";
	// Upserts require plugin.secrets.read on the installed version, but listing and deleting deliberately
	// do not — leftover secrets must stay reachable after an upgrade drops the capability.
	const secretsInstallationId = installedItem ? installedItem.installation._id : null;
	const secretsCanAdd = installedVersion?.capabilities.includes("plugin.secrets.read") ?? false;

	return (
		<main className={"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames}>
			<div className={"RoutePluginsPlugin-content" satisfies RoutePluginsPlugin_ClassNames}>
				{breadcrumb}

				<header className={"RoutePluginsPluginHero" satisfies RoutePluginsPlugin_ClassNames}>
					<Puzzle aria-hidden className={"RoutePluginsPluginHero-icon" satisfies RoutePluginsPlugin_ClassNames} />
					<div className={"RoutePluginsPluginHero-info" satisfies RoutePluginsPlugin_ClassNames}>
						<div className={"RoutePluginsPluginHero-titleRow" satisfies RoutePluginsPlugin_ClassNames}>
							<h1 className={"RoutePluginsPluginHero-title" satisfies RoutePluginsPlugin_ClassNames}>
								{plugin.displayName}
							</h1>
							{plugin.reviewStatus !== "passed" || installedItem ? (
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
								<MyButton
									variant={showInstall ? "outline" : "default"}
									disabled={publishing || removing}
									onClick={handlePublish}
								>
									<UploadCloud aria-hidden />
									{publishing ? "Publishing..." : "Publish"}
								</MyButton>
							) : null}
							{showInstall ? (
								<MyButton disabled={installing || installationBlocked} onClick={() => setConsenting(true)}>
									<Download aria-hidden />
									{installAction}
								</MyButton>
							) : null}
							{installedItem ? (
								<MyButton
									variant="ghost_destructive"
									disabled={uninstalling}
									onClick={() => handleUninstall(installedItem.installation)}
								>
									<Trash2 aria-hidden />
									{uninstalling ? "Uninstalling..." : "Uninstall"}
								</MyButton>
							) : null}
							{publisherPlugin ? (
								<MyMenu placement="bottom-end">
									<MyMenuTrigger>
										<MyIconButton variant="ghost" tooltip="More actions" disabled={removing}>
											<MyIconButtonIcon>
												<Ellipsis />
											</MyIconButtonIcon>
										</MyIconButton>
									</MyMenuTrigger>
									<MyMenuPopover>
										<MyMenuPopoverContent>
											<MyMenuItem variant="destructive" disabled={publishing || removing} onClick={handleRemoveClaim}>
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
					</div>
				</header>

				{secretsInstallationId || publisherPlugin ? (
					<RoutePluginsPluginSecrets
						membershipId={membershipId}
						installationId={secretsInstallationId}
						installationCanAdd={secretsCanAdd}
						publisherRepositoryId={publisherPlugin?.repository._id ?? null}
					/>
				) : null}
				<RoutePluginsPluginAccess plugin={plugin} handlers={installedItem?.handlers ?? null} />

				{publisherPlugin ? (
					<RoutePluginsPluginPublisherReleases versions={publisherPlugin.versions} reviews={publisherPlugin.reviews} />
				) : null}
				{installedItem ? (
					<RoutePluginsInstalledRuns membershipId={membershipId} installationId={installedItem.installation._id} />
				) : null}

				<MyModal open={consenting} setOpen={setConsenting}>
					<MyModalPopover className={"RoutePluginsPluginConsentModal" satisfies RoutePluginsPlugin_ClassNames}>
						<MyModalHeader>
							<MyModalHeading>
								{installAction} {plugin.displayName}
							</MyModalHeading>
							<MyModalDescription>
								{plugin.name}@{plugin.version} · {plugin.publisherDisplayName ?? "unknown publisher"}
							</MyModalDescription>
						</MyModalHeader>

						{/* Platform baseline every plugin receives: static copy, not a manifest capability or consent set. */}
						<p className={"RoutePluginsPluginConsentModal-baseline" satisfies RoutePluginsPlugin_ClassNames}>
							Every plugin can read the triggering upload and create Markdown files beside it.
						</p>

						<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
							This plugin can use these capabilities
						</div>
						<ul className={"RoutePluginsPluginConsentModal-list" satisfies RoutePluginsPlugin_ClassNames}>
							{plugin.capabilities.map((capability) => (
								<li
									key={capability}
									className={"RoutePluginsPluginConsentModal-item" satisfies RoutePluginsPlugin_ClassNames}
								>
									{capability}
									{installedVersion && consentDiff.newCapabilities.includes(capability) ? (
										<MyBadge variant="secondary">new</MyBadge>
									) : null}
								</li>
							))}
						</ul>
						<div className={"RoutePluginsPluginConsentModal-sectionTitle" satisfies RoutePluginsPlugin_ClassNames}>
							And send requests to these origins
						</div>
						{plugin.outboundOrigins.length === 0 ? (
							<div className={"RoutePluginsPluginConsentModal-empty" satisfies RoutePluginsPlugin_ClassNames}>
								No outbound origins requested.
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

						<div className={"RoutePluginsPluginConsentModal-actions" satisfies RoutePluginsPlugin_ClassNames}>
							<MyButton variant="ghost" disabled={installing} onClick={() => setConsenting(false)}>
								Cancel
							</MyButton>
							<MyButton disabled={installing} onClick={() => handleAcceptAndInstall(plugin)}>
								<Download aria-hidden />
								{installing ? installProgress : `Accept and ${installAction.toLowerCase()}`}
							</MyButton>
						</div>
						<MyModalCloseTrigger />
					</MyModalPopover>
				</MyModal>
			</div>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/$pluginName")({
	component: RoutePluginsPlugin,
});

export { Route };
// #endregion root
