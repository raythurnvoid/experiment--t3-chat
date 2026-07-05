import "./plugin.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ChevronRight, Clock3, Download, KeyRound, Puzzle, Save, Trash2, Zap } from "lucide-react";
import { memo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
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
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
} from "@/components/my-modal.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { plugins_consent_diff, plugins_parse_env_text } from "../../../../../../shared/plugins.ts";

type RoutePlugins_Installation = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_installations
>[number];

type RoutePlugins_RegisteredPlugin = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_registered_plugins
>[number];

function format_date(value: number) {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// #region installed secrets
type RoutePluginsInstalledSecrets_ClassNames =
	| "RoutePluginsInstalledSecrets"
	| "RoutePluginsInstalledSecrets-title"
	| "RoutePluginsInstalledSecrets-description"
	| "RoutePluginsInstalledSecrets-form"
	| "RoutePluginsInstalledSecrets-env"
	| "RoutePluginsInstalledSecrets-empty"
	| "RoutePluginsInstalledSecrets-list"
	| "RoutePluginsInstalledSecretItem"
	| "RoutePluginsInstalledSecretItem-identity"
	| "RoutePluginsInstalledSecretItem-name"
	| "RoutePluginsInstalledSecretItem-meta";

type RoutePluginsInstalledSecrets_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installationId: app_convex_Id<"plugins_workspace_installations">;
};

const RoutePluginsInstalledSecrets = memo(function RoutePluginsInstalledSecrets(
	props: RoutePluginsInstalledSecrets_Props,
) {
	const { membershipId, installationId } = props;
	const secrets = useQuery(app_convex_api.plugins.list_installation_secrets, { membershipId, installationId });
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [envText, setEnvText] = useState("");
	const [saving, setSaving] = useState(false);

	const handleSaveSecret = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!name.trim() || !value) {
			return;
		}

		setSaving(true);
		app_convex
			.mutation(app_convex_api.plugins.upsert_installation_secret, { membershipId, installationId, name, value })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Secret ${name.trim()} saved`);
				setName("");
				setValue("");
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleSaveSecret] Failed to save secret:", { error, installationId });
				toast.error("Failed to save secret");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	const handleImportEnv = useFn(() => {
		const parsed = plugins_parse_env_text(envText);
		if (parsed._nay) {
			toast.error(parsed._nay.message);
			return;
		}

		setSaving(true);
		app_convex
			.mutation(app_convex_api.plugins.upsert_installation_secrets, {
				membershipId,
				installationId,
				secrets: parsed._yay,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Saved ${result._yay.count} secrets`);
				setEnvText("");
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleImportEnv] Failed to import secrets:", { error, installationId });
				toast.error("Failed to import secrets");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	const handleDeleteSecret = useFn((secretName: string) => {
		setSaving(true);
		app_convex
			.mutation(app_convex_api.plugins.delete_installation_secret, { membershipId, installationId, name: secretName })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Secret ${secretName} deleted`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPlugin.handleDeleteSecret] Failed to delete secret:", { error, installationId });
				toast.error("Failed to delete secret");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	return (
		<section className={"RoutePluginsInstalledSecrets" satisfies RoutePluginsInstalledSecrets_ClassNames}>
			<h3 className={"RoutePluginsInstalledSecrets-title" satisfies RoutePluginsInstalledSecrets_ClassNames}>
				<KeyRound aria-hidden />
				Secrets
			</h3>
			<p className={"RoutePluginsInstalledSecrets-description" satisfies RoutePluginsInstalledSecrets_ClassNames}>
				These values are provided to this plugin when it runs in this workspace.
			</p>

			<form
				className={"RoutePluginsInstalledSecrets-form" satisfies RoutePluginsInstalledSecrets_ClassNames}
				onSubmit={handleSaveSecret}
			>
				<MyInput>
					<MyInputLabel>Name</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							value={name}
							placeholder="OPENAI_API_KEY"
							disabled={saving}
							required
							onChange={(event) => setName(event.currentTarget.value)}
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
							disabled={saving}
							required
							onChange={(event) => setValue(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				<MyButton type="submit" disabled={saving || !name.trim() || !value}>
					<Save aria-hidden />
					{saving ? "Saving..." : "Save"}
				</MyButton>
			</form>

			<div className={"RoutePluginsInstalledSecrets-env" satisfies RoutePluginsInstalledSecrets_ClassNames}>
				<MyInput>
					<MyInputLabel>Paste .env</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputTextAreaControl
							value={envText}
							placeholder={"MODAL_TOKEN=...\nOPENAI_API_KEY=..."}
							rows={3}
							disabled={saving}
							onChange={(event) => setEnvText(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				<MyButton disabled={saving || envText.trim().length === 0} onClick={handleImportEnv}>
					{saving ? "Importing..." : "Import .env"}
				</MyButton>
			</div>

			{secrets === undefined ? (
				<div
					className={"RoutePluginsInstalledSecrets-empty" satisfies RoutePluginsInstalledSecrets_ClassNames}
					role="status"
				>
					Loading secrets...
				</div>
			) : secrets.length === 0 ? (
				<div className={"RoutePluginsInstalledSecrets-empty" satisfies RoutePluginsInstalledSecrets_ClassNames}>
					No secrets configured.
				</div>
			) : (
				<div className={"RoutePluginsInstalledSecrets-list" satisfies RoutePluginsInstalledSecrets_ClassNames}>
					{secrets.map((secret) => (
						<div
							key={secret._id}
							className={"RoutePluginsInstalledSecretItem" satisfies RoutePluginsInstalledSecrets_ClassNames}
						>
							<div
								className={"RoutePluginsInstalledSecretItem-identity" satisfies RoutePluginsInstalledSecrets_ClassNames}
							>
								<span
									className={"RoutePluginsInstalledSecretItem-name" satisfies RoutePluginsInstalledSecrets_ClassNames}
								>
									{secret.name}
								</span>
								<span
									className={"RoutePluginsInstalledSecretItem-meta" satisfies RoutePluginsInstalledSecrets_ClassNames}
								>
									{secret.valuePreview} · updated {format_date(secret.updatedAt)}
								</span>
							</div>
							<MyButton
								variant="ghost_destructive"
								aria-label={`Delete secret ${secret.name}`}
								disabled={saving}
								onClick={() => handleDeleteSecret(secret.name)}
							>
								<Trash2 aria-hidden />
							</MyButton>
						</div>
					))}
				</div>
			)}
		</section>
	);
});
// #endregion installed secrets

// #region installed runs
type RoutePluginsInstalledRuns_ClassNames =
	| "RoutePluginsInstalledRuns"
	| "RoutePluginsInstalledRuns-summary"
	| "RoutePluginsInstalledRuns-chevron"
	| "RoutePluginsInstalledRuns-title"
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
				<h3 className={"RoutePluginsInstalledRuns-title" satisfies RoutePluginsInstalledRuns_ClassNames}>
					<Clock3 aria-hidden />
					Recent runs
				</h3>
			</summary>

			{runs === undefined ? (
				<div className={"RoutePluginsInstalledRuns-empty" satisfies RoutePluginsInstalledRuns_ClassNames} role="status">
					Loading runs...
				</div>
			) : runs.length === 0 ? (
				<div className={"RoutePluginsInstalledRuns-empty" satisfies RoutePluginsInstalledRuns_ClassNames}>
					No runs recorded.
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
									{run.source?.path ?? run.event}
								</span>
							</div>
							<div className={"RoutePluginsInstalledRunItem-meta" satisfies RoutePluginsInstalledRuns_ClassNames}>
								{format_date(run.updatedAt)} · runner {run.runnerHttpStatus ?? "n/a"} · plugin{" "}
								{run.pluginStatus ?? "n/a"} · {format_run_duration(run.runnerElapsedMs)} · calls {run.hostCallCount},
								writes {run.hostWriteCount}
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

// #region installed
type RoutePluginsInstalled_ClassNames =
	| "RoutePluginsInstalled"
	| "RoutePluginsInstalled-title"
	| "RoutePluginsInstalled-name"
	| "RoutePluginsInstalled-meta"
	| "RoutePluginsInstalledEvents"
	| "RoutePluginsInstalledEvents-summary"
	| "RoutePluginsInstalledEvents-chevron"
	| "RoutePluginsInstalledEvents-title"
	| "RoutePluginsInstalledEvents-count"
	| "RoutePluginsInstalledEvents-description"
	| "RoutePluginsInstalledEvents-empty"
	| "RoutePluginsInstalledEvents-list"
	| "RoutePluginsInstalledEvents-item";

type RoutePluginsInstalled_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	item: RoutePlugins_Installation;
};

const RoutePluginsInstalled = memo(function RoutePluginsInstalled(props: RoutePluginsInstalled_Props) {
	const { membershipId, item } = props;
	const { installation, version, handlers } = item;

	return (
		<section className={"RoutePluginsInstalled" satisfies RoutePluginsInstalled_ClassNames}>
			<h2 className={"RoutePluginsInstalled-title" satisfies RoutePluginsInstalled_ClassNames}>
				<span className={"RoutePluginsInstalled-name" satisfies RoutePluginsInstalled_ClassNames}>
					Installed in this workspace
				</span>
				<MyBadge variant={installation.status === "enabled" ? "secondary" : "outline"}>
					{installation.status === "enabled" ? "Enabled" : "Disabled"}
				</MyBadge>
			</h2>
			<div className={"RoutePluginsInstalled-meta" satisfies RoutePluginsInstalled_ClassNames}>
				{installation.pluginName}@{version.version} · {version.sourceOwner}/{version.sourceRepo}@
				{version.sourceCommitSha.slice(0, 8)}
			</div>
			<RoutePluginsInstalledSecrets membershipId={membershipId} installationId={installation._id} />

			<details className={"RoutePluginsInstalledEvents" satisfies RoutePluginsInstalled_ClassNames}>
				<summary className={"RoutePluginsInstalledEvents-summary" satisfies RoutePluginsInstalled_ClassNames}>
					<ChevronRight
						className={"RoutePluginsInstalledEvents-chevron" satisfies RoutePluginsInstalled_ClassNames}
						aria-hidden
					/>
					<h3 className={"RoutePluginsInstalledEvents-title" satisfies RoutePluginsInstalled_ClassNames}>
						<Zap aria-hidden />
						Events
					</h3>
					<span className={"RoutePluginsInstalledEvents-count" satisfies RoutePluginsInstalled_ClassNames}>
						{handlers.length}
					</span>
				</summary>
				{handlers.length === 0 ? (
					<div className={"RoutePluginsInstalledEvents-empty" satisfies RoutePluginsInstalled_ClassNames}>
						No active events.
					</div>
				) : (
					<>
						<p className={"RoutePluginsInstalledEvents-description" satisfies RoutePluginsInstalled_ClassNames}>
							This plugin runs when any of these events happen in this workspace.
						</p>
						<ul className={"RoutePluginsInstalledEvents-list" satisfies RoutePluginsInstalled_ClassNames}>
							{handlers.map((handler) => (
								<li
									key={`${handler.event}:${handler.contentType}`}
									className={"RoutePluginsInstalledEvents-item" satisfies RoutePluginsInstalled_ClassNames}
								>
									{handler.event}:{handler.contentType}
								</li>
							))}
						</ul>
					</>
				)}
			</details>

			<RoutePluginsInstalledRuns membershipId={membershipId} installationId={installation._id} />
		</section>
	);
});
// #endregion installed

// #region root
type RoutePluginsPlugin_ClassNames =
	| "RoutePluginsPlugin"
	| "RoutePluginsPlugin-loading"
	| "RoutePluginsPlugin-missing"
	| "RoutePluginsPluginHero"
	| "RoutePluginsPluginHero-icon"
	| "RoutePluginsPluginHero-info"
	| "RoutePluginsPluginHero-titleRow"
	| "RoutePluginsPluginHero-title"
	| "RoutePluginsPluginHero-meta"
	| "RoutePluginsPluginHero-description"
	| "RoutePluginsPluginHero-actions"
	| "RoutePluginsPluginConsentModal"
	| "RoutePluginsPluginConsentModal-sectionTitle"
	| "RoutePluginsPluginConsentModal-list"
	| "RoutePluginsPluginConsentModal-item"
	| "RoutePluginsPluginConsentModal-empty"
	| "RoutePluginsPluginConsentModal-actions";

function RoutePluginsPlugin() {
	const { pluginName } = Route.useParams();
	const { membershipId } = AppTenantProvider.useContext();
	const plugins = useQuery(app_convex_api.plugins.list_registered_plugins, { membershipId });
	const installations = useQuery(app_convex_api.plugins.list_installations, { membershipId });
	const [consenting, setConsenting] = useState(false);
	const [installing, setInstalling] = useState(false);

	const handleAcceptAndInstall = useFn((plugin: RoutePlugins_RegisteredPlugin) => {
		setInstalling(true);
		app_convex
			.action(app_convex_api.plugins.install_version, {
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
			<main
				className={"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames}
				role="status"
				aria-live="polite"
			>
				{breadcrumb}
				<div className={"RoutePluginsPlugin-loading" satisfies RoutePluginsPlugin_ClassNames}>
					<Puzzle aria-hidden />
					Loading plugin...
				</div>
			</main>
		);
	}

	const plugin = plugins.find((item) => item.name === pluginName) ?? null;
	if (plugin === null) {
		return (
			<main className={"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames}>
				{breadcrumb}
				<div className={"RoutePluginsPlugin-missing" satisfies RoutePluginsPlugin_ClassNames}>
					No published plugin is named "{pluginName}".
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

	return (
		<main className={"RoutePluginsPlugin" satisfies RoutePluginsPlugin_ClassNames}>
			{breadcrumb}

			<header className={"RoutePluginsPluginHero" satisfies RoutePluginsPlugin_ClassNames}>
				<Puzzle aria-hidden className={"RoutePluginsPluginHero-icon" satisfies RoutePluginsPlugin_ClassNames} />
				<div className={"RoutePluginsPluginHero-info" satisfies RoutePluginsPlugin_ClassNames}>
					<div className={"RoutePluginsPluginHero-titleRow" satisfies RoutePluginsPlugin_ClassNames}>
						<h1 className={"RoutePluginsPluginHero-title" satisfies RoutePluginsPlugin_ClassNames}>
							{plugin.displayName}
						</h1>
						{plugin.reviewStatus !== "passed" ? (
							<MyBadge variant={plugin.reviewStatus === "rejected" ? "destructive" : "outline"}>
								{plugin.reviewStatus}
							</MyBadge>
						) : null}
					</div>
					<div className={"RoutePluginsPluginHero-meta" satisfies RoutePluginsPlugin_ClassNames}>
						<span>
							{plugin.name}@{plugin.version}
						</span>
						<span>{plugin.publisherDisplayName ?? "unknown publisher"}</span>
					</div>
					<p className={"RoutePluginsPluginHero-description" satisfies RoutePluginsPlugin_ClassNames}>
						{plugin.description.trim().length > 0 ? plugin.description : "No description provided."}
					</p>
				</div>
				<div className={"RoutePluginsPluginHero-actions" satisfies RoutePluginsPlugin_ClassNames}>
					<MyButton
						variant={installedVersion?.version === plugin.version ? "outline" : "default"}
						disabled={installing || plugin.reviewStatus === "rejected" || plugin.reviewStatus === "flagged"}
						onClick={() => setConsenting(true)}
					>
						<Download aria-hidden />
						{installedVersion?.version === plugin.version ? "Reinstall" : installedVersion ? "Update" : "Install"}
					</MyButton>
				</div>
			</header>

			{installedItem ? <RoutePluginsInstalled membershipId={membershipId} item={installedItem} /> : null}

			<MyModal open={consenting} setOpen={setConsenting}>
				<MyModalPopover className={"RoutePluginsPluginConsentModal" satisfies RoutePluginsPlugin_ClassNames}>
					<MyModalHeader>
						<MyModalHeading>Install {plugin.displayName}</MyModalHeading>
						<MyModalDescription>
							{plugin.name}@{plugin.version} · {plugin.publisherDisplayName ?? "unknown publisher"}
						</MyModalDescription>
					</MyModalHeader>

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
							{installing ? "Installing..." : "Accept and install"}
						</MyButton>
					</div>
					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/$pluginName")({
	component: RoutePluginsPlugin,
});

export { Route };
// #endregion root
