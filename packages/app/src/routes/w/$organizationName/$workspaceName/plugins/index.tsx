import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Blocks, Check, Clock3, Download, KeyRound, Puzzle, Save, Search, Store, Trash2 } from "lucide-react";
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
	MyInputIcon,
	MyInputLabel,
	MyInputTextAreaControl,
} from "@/components/my-input.tsx";
import { MyLink, MyLinkIcon } from "@/components/my-link.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
} from "@/components/my-modal.tsx";
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

// #region gallery
type RoutePluginsGallery_ClassNames =
	| "RoutePluginsGallery"
	| "RoutePluginsGallery-header"
	| "RoutePluginsGallery-title"
	| "RoutePluginsGallery-description"
	| "RoutePluginsGallery-search"
	| "RoutePluginsGallery-empty"
	| "RoutePluginsGallery-grid"
	| "RoutePluginsGalleryCard"
	| "RoutePluginsGalleryCard-header"
	| "RoutePluginsGalleryCard-icon"
	| "RoutePluginsGalleryCard-identity"
	| "RoutePluginsGalleryCard-name"
	| "RoutePluginsGalleryCard-publisher"
	| "RoutePluginsGalleryCard-description"
	| "RoutePluginsGalleryCard-footer"
	| "RoutePluginsGalleryCard-version"
	| "RoutePluginsGalleryCard-installed"
	| "RoutePluginsGalleryConsentModal"
	| "RoutePluginsGalleryConsentModal-sectionTitle"
	| "RoutePluginsGalleryConsentModal-list"
	| "RoutePluginsGalleryConsentModal-item"
	| "RoutePluginsGalleryConsentModal-empty"
	| "RoutePluginsGalleryConsentModal-actions";

type RoutePluginsGallery_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installations: Array<RoutePlugins_Installation>;
};

const RoutePluginsGallery = memo(function RoutePluginsGallery(props: RoutePluginsGallery_Props) {
	const { membershipId, installations } = props;
	const plugins = useQuery(app_convex_api.plugins.list_registered_plugins, { membershipId });
	const [search, setSearch] = useState("");
	const [consentingId, setConsentingId] = useState<RoutePlugins_RegisteredPlugin["pluginVersionId"] | null>(null);
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
				setConsentingId(null);
			})
			.catch((error) => {
				console.error("[RoutePlugins.handleAcceptAndInstall] Failed to install plugin:", {
					error,
					pluginVersionId: plugin.pluginVersionId,
				});
				toast.error("Failed to install plugin");
			})
			.finally(() => {
				setInstalling(false);
			});
	});

	const query = search.trim().toLowerCase();
	const filtered = plugins?.filter(
		(plugin) =>
			query.length === 0 ||
			[plugin.name, plugin.displayName, plugin.description, plugin.publisherDisplayName ?? ""].some((value) =>
				value.toLowerCase().includes(query),
			),
	);

	const consentingPlugin = plugins?.find((plugin) => plugin.pluginVersionId === consentingId) ?? null;
	const consentingInstalledVersion = consentingPlugin
		? installations.find((item) => item.installation.pluginName === consentingPlugin.name)?.version
		: undefined;
	const consentingDiff = consentingPlugin
		? plugins_consent_diff({
				current: consentingInstalledVersion
					? {
							capabilities: consentingInstalledVersion.capabilities,
							outboundOrigins: consentingInstalledVersion.outboundOrigins,
						}
					: null,
				target: { capabilities: consentingPlugin.capabilities, outboundOrigins: consentingPlugin.outboundOrigins },
			})
		: null;

	return (
		<section className={"RoutePluginsGallery" satisfies RoutePluginsGallery_ClassNames}>
			<div className={"RoutePluginsGallery-header" satisfies RoutePluginsGallery_ClassNames}>
				<h2 className={"RoutePluginsGallery-title" satisfies RoutePluginsGallery_ClassNames}>
					<Blocks aria-hidden />
					Marketplace
					{plugins !== undefined ? <MyBadge variant="secondary">{plugins.length}</MyBadge> : null}
				</h2>
				<p className={"RoutePluginsGallery-description" satisfies RoutePluginsGallery_ClassNames}>
					The latest published version of each plugin. Installing asks you to accept the capabilities and outbound
					origins the plugin requests.
				</p>
			</div>

			<MyInput className={"RoutePluginsGallery-search" satisfies RoutePluginsGallery_ClassNames} role="search">
				<MyInputBackground />
				<MyInputArea>
					<MyInputIcon>
						<Search />
					</MyInputIcon>
					<MyInputControl
						type="search"
						placeholder="Search plugins"
						value={search}
						onChange={(event) => setSearch(event.currentTarget.value)}
					/>
				</MyInputArea>
				<MyInputBox />
			</MyInput>

			{filtered === undefined ? (
				<div className={"RoutePluginsGallery-empty" satisfies RoutePluginsGallery_ClassNames} role="status">
					Loading published plugins...
				</div>
			) : filtered.length === 0 ? (
				<div className={"RoutePluginsGallery-empty" satisfies RoutePluginsGallery_ClassNames}>
					{query.length === 0 ? "No plugins published yet." : `No plugins match "${search.trim()}".`}
				</div>
			) : (
				<div className={"RoutePluginsGallery-grid" satisfies RoutePluginsGallery_ClassNames}>
					{filtered.map((plugin) => {
						const installedVersion = installations.find(
							(item) => item.installation.pluginName === plugin.name,
						)?.version;
						return (
							<article
								key={plugin.pluginVersionId}
								className={"RoutePluginsGalleryCard" satisfies RoutePluginsGallery_ClassNames}
							>
								<div className={"RoutePluginsGalleryCard-header" satisfies RoutePluginsGallery_ClassNames}>
									<Puzzle className={"RoutePluginsGalleryCard-icon" satisfies RoutePluginsGallery_ClassNames} aria-hidden />
									<div className={"RoutePluginsGalleryCard-identity" satisfies RoutePluginsGallery_ClassNames}>
										<span className={"RoutePluginsGalleryCard-name" satisfies RoutePluginsGallery_ClassNames}>
											{plugin.displayName}
										</span>
										<span className={"RoutePluginsGalleryCard-publisher" satisfies RoutePluginsGallery_ClassNames}>
											{plugin.publisherDisplayName ?? "unknown publisher"}
										</span>
									</div>
									{plugin.reviewStatus !== "passed" ? (
										<MyBadge variant={plugin.reviewStatus === "rejected" ? "destructive" : "outline"}>
											{plugin.reviewStatus}
										</MyBadge>
									) : null}
								</div>
								<p className={"RoutePluginsGalleryCard-description" satisfies RoutePluginsGallery_ClassNames}>
									{plugin.description.trim().length > 0 ? plugin.description : "No description provided."}
								</p>
								<div className={"RoutePluginsGalleryCard-footer" satisfies RoutePluginsGallery_ClassNames}>
									<span className={"RoutePluginsGalleryCard-version" satisfies RoutePluginsGallery_ClassNames}>
										v{plugin.version}
									</span>
									{installedVersion ? (
										<span className={"RoutePluginsGalleryCard-installed" satisfies RoutePluginsGallery_ClassNames}>
											<Check aria-hidden />
											Installed
										</span>
									) : null}
									<MyButton
										variant={installedVersion?.version === plugin.version ? "outline" : "default"}
										disabled={installing || plugin.reviewStatus === "rejected" || plugin.reviewStatus === "flagged"}
										onClick={() => setConsentingId(plugin.pluginVersionId)}
									>
										<Download aria-hidden />
										{installedVersion?.version === plugin.version ? "Reinstall" : installedVersion ? "Update" : "Install"}
									</MyButton>
								</div>
							</article>
						);
					})}
				</div>
			)}

			<MyModal open={consentingPlugin !== null} setOpen={(open) => !open && setConsentingId(null)}>
				<MyModalPopover className={"RoutePluginsGalleryConsentModal" satisfies RoutePluginsGallery_ClassNames}>
					<MyModalHeader>
						<MyModalHeading>Install {consentingPlugin?.displayName ?? "plugin"}</MyModalHeading>
						<MyModalDescription>
							{consentingPlugin
								? `${consentingPlugin.name}@${consentingPlugin.version} · ${consentingPlugin.publisherDisplayName ?? "unknown publisher"}`
								: ""}
						</MyModalDescription>
					</MyModalHeader>

					{consentingPlugin && consentingDiff ? (
						<>
							<div className={"RoutePluginsGalleryConsentModal-sectionTitle" satisfies RoutePluginsGallery_ClassNames}>
								This plugin can use these capabilities
							</div>
							<ul className={"RoutePluginsGalleryConsentModal-list" satisfies RoutePluginsGallery_ClassNames}>
								{consentingPlugin.capabilities.map((capability) => (
									<li
										key={capability}
										className={"RoutePluginsGalleryConsentModal-item" satisfies RoutePluginsGallery_ClassNames}
									>
										{capability}
										{consentingInstalledVersion && consentingDiff.newCapabilities.includes(capability) ? (
											<MyBadge variant="secondary">new</MyBadge>
										) : null}
									</li>
								))}
							</ul>
							<div className={"RoutePluginsGalleryConsentModal-sectionTitle" satisfies RoutePluginsGallery_ClassNames}>
								And send requests to these origins
							</div>
							{consentingPlugin.outboundOrigins.length === 0 ? (
								<div className={"RoutePluginsGalleryConsentModal-empty" satisfies RoutePluginsGallery_ClassNames}>
									No outbound origins requested.
								</div>
							) : (
								<ul className={"RoutePluginsGalleryConsentModal-list" satisfies RoutePluginsGallery_ClassNames}>
									{consentingPlugin.outboundOrigins.map((origin) => (
										<li
											key={origin}
											className={"RoutePluginsGalleryConsentModal-item" satisfies RoutePluginsGallery_ClassNames}
										>
											{origin}
											{consentingInstalledVersion && consentingDiff.newOutboundOrigins.includes(origin) ? (
												<MyBadge variant="secondary">new</MyBadge>
											) : null}
										</li>
									))}
								</ul>
							)}
						</>
					) : null}

					<div className={"RoutePluginsGalleryConsentModal-actions" satisfies RoutePluginsGallery_ClassNames}>
						<MyButton variant="ghost" disabled={installing} onClick={() => setConsentingId(null)}>
							Cancel
						</MyButton>
						<MyButton
							disabled={installing || consentingPlugin === null}
							onClick={() => consentingPlugin && handleAcceptAndInstall(consentingPlugin)}
						>
							<Download aria-hidden />
							{installing ? "Installing..." : "Accept and install"}
						</MyButton>
					</div>
					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		</section>
	);
});
// #endregion gallery

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

function format_date(value: number) {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

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
				console.error("[RoutePlugins.handleSaveSecret] Failed to save secret:", { error, installationId });
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
				console.error("[RoutePlugins.handleImportEnv] Failed to import secrets:", { error, installationId });
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
				console.error("[RoutePlugins.handleDeleteSecret] Failed to delete secret:", { error, installationId });
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
		<section className={"RoutePluginsInstalledRuns" satisfies RoutePluginsInstalledRuns_ClassNames}>
			<h3 className={"RoutePluginsInstalledRuns-title" satisfies RoutePluginsInstalledRuns_ClassNames}>
				<Clock3 aria-hidden />
				Recent runs
			</h3>

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
		</section>
	);
});
// #endregion installed runs

// #region installed
type RoutePluginsInstalled_ClassNames =
	| "RoutePluginsInstalled"
	| "RoutePluginsInstalled-title"
	| "RoutePluginsInstalled-name"
	| "RoutePluginsInstalled-meta"
	| "RoutePluginsInstalled-events"
	| "RoutePluginsInstalled-mount";

type RoutePluginsInstalled_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	item: RoutePlugins_Installation;
};

const RoutePluginsInstalled = memo(function RoutePluginsInstalled(props: RoutePluginsInstalled_Props) {
	const { membershipId, item } = props;
	const { installation, version, handlers, sourceMount } = item;

	return (
		<section className={"RoutePluginsInstalled" satisfies RoutePluginsInstalled_ClassNames}>
			<h2 className={"RoutePluginsInstalled-title" satisfies RoutePluginsInstalled_ClassNames}>
				<span className={"RoutePluginsInstalled-name" satisfies RoutePluginsInstalled_ClassNames}>
					{version.displayName}
				</span>
				<MyBadge variant={installation.status === "enabled" ? "secondary" : "outline"}>
					{installation.status === "enabled" ? "Enabled" : "Disabled"}
				</MyBadge>
			</h2>
			<div className={"RoutePluginsInstalled-meta" satisfies RoutePluginsInstalled_ClassNames}>
				{installation.pluginName}@{version.version} · {version.sourceOwner}/{version.sourceRepo}@
				{version.sourceCommitSha.slice(0, 8)}
			</div>
			<div className={"RoutePluginsInstalled-events" satisfies RoutePluginsInstalled_ClassNames}>
				{handlers.length === 0
					? "No active handlers"
					: handlers.map((handler) => `${handler.event}:${handler.contentType}`).join(", ")}
			</div>
			{sourceMount ? (
				<code className={"RoutePluginsInstalled-mount" satisfies RoutePluginsInstalled_ClassNames}>
					{sourceMount.mountPath}
				</code>
			) : null}

			<RoutePluginsInstalledSecrets membershipId={membershipId} installationId={installation._id} />
			<RoutePluginsInstalledRuns membershipId={membershipId} installationId={installation._id} />
		</section>
	);
});
// #endregion installed

// #region root
type RoutePlugins_ClassNames =
	| "RoutePlugins"
	| "RoutePlugins-loading"
	| "RoutePlugins-empty"
	| "RoutePluginsHeader"
	| "RoutePluginsHeader-title"
	| "RoutePluginsHeader-description";

function RoutePlugins() {
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const installations = useQuery(app_convex_api.plugins.list_installations, { membershipId });

	if (installations === undefined) {
		return (
			<main className={"RoutePlugins" satisfies RoutePlugins_ClassNames} role="status" aria-live="polite">
				<div className={"RoutePlugins-loading" satisfies RoutePlugins_ClassNames}>
					<Puzzle aria-hidden />
					Loading plugins...
				</div>
			</main>
		);
	}

	return (
		<main className={"RoutePlugins" satisfies RoutePlugins_ClassNames}>
			<header className={"RoutePluginsHeader" satisfies RoutePlugins_ClassNames}>
				<div>
					<h1 className={"RoutePluginsHeader-title" satisfies RoutePlugins_ClassNames}>Plugins</h1>
					<p className={"RoutePluginsHeader-description" satisfies RoutePlugins_ClassNames}>
						Install published plugins, configure their secrets, and inspect recent upload runs.
					</p>
				</div>
				<MyLink
					variant="button-outline"
					to="/w/$organizationName/$workspaceName/plugins/publisher"
					params={{ organizationName, workspaceName }}
				>
					<MyLinkIcon aria-hidden>
						<Store />
					</MyLinkIcon>
					Publisher
				</MyLink>
			</header>

			<RoutePluginsGallery membershipId={membershipId} installations={installations} />

			{installations.length === 0 ? (
				<div className={"RoutePlugins-empty" satisfies RoutePlugins_ClassNames}>
					<Puzzle aria-hidden />
					No plugins installed.
				</div>
			) : (
				installations.map((item) => (
					<RoutePluginsInstalled key={item.installation._id} membershipId={membershipId} item={item} />
				))
			)}
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/")({
	component: RoutePlugins,
});

export { Route };
// #endregion root
