import "./plugin.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
	ChevronRight,
	Clock3,
	Download,
	GitBranch,
	History,
	KeyRound,
	Puzzle,
	Save,
	ShieldCheck,
	Store,
	Trash2,
	UploadCloud,
	Zap,
} from "lucide-react";
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
import { format_datetime } from "@/lib/date.ts";
import { plugins_consent_diff, plugins_parse_env_text } from "../../../../../../shared/plugins.ts";

type RoutePlugins_Installation = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_installations
>[number];

type RoutePlugins_PublishedPlugin = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_published_plugins
>[number];

type RoutePlugins_PublisherPlugin = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.plugins.get_publisher_plugin>
>;

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
									{secret.valuePreview} · updated {format_datetime(secret.updatedAt)}
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
									{run.file?.path ?? run.event}
								</span>
							</div>
							<div className={"RoutePluginsInstalledRunItem-meta" satisfies RoutePluginsInstalledRuns_ClassNames}>
								{format_datetime(run.updatedAt)} · runner {run.runnerHttpStatus ?? "n/a"} · plugin{" "}
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
	| "RoutePluginsInstalled-titleRow"
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
	const [uninstalling, setUninstalling] = useState(false);

	const handleUninstall = useFn(() => {
		setUninstalling(true);
		app_convex
			.mutation(app_convex_api.plugins.uninstall_version, { membershipId, installationId: installation._id })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				// No navigation: list_installations updates reactively, unmounting this section.
				toast.success(`Uninstalled ${installation.pluginName}`);
			})
			.catch((error) => {
				console.error("[RoutePluginsInstalled.handleUninstall] Failed to uninstall plugin:", {
					error,
					installationId: installation._id,
				});
				toast.error("Failed to uninstall plugin");
			})
			.finally(() => {
				setUninstalling(false);
			});
	});

	return (
		<section className={"RoutePluginsInstalled" satisfies RoutePluginsInstalled_ClassNames}>
			<div className={"RoutePluginsInstalled-titleRow" satisfies RoutePluginsInstalled_ClassNames}>
				<h2 className={"RoutePluginsInstalled-title" satisfies RoutePluginsInstalled_ClassNames}>
					<span className={"RoutePluginsInstalled-name" satisfies RoutePluginsInstalled_ClassNames}>
						Installed in this workspace
					</span>
					<MyBadge variant={installation.status === "enabled" ? "secondary" : "outline"}>
						{installation.status === "enabled" ? "Enabled" : "Disabled"}
					</MyBadge>
				</h2>
				<MyButton
					variant="ghost_destructive"
					aria-label={`Uninstall ${installation.pluginName}`}
					tooltip="Uninstall"
					disabled={uninstalling}
					onClick={handleUninstall}
				>
					<Trash2 aria-hidden />
				</MyButton>
			</div>
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

// #region publisher versions
function review_badge_variant(status: "passed" | "rejected" | "flagged" | "pending") {
	return status === "rejected" ? "destructive" : status === "flagged" ? "outline" : "secondary";
}

type RoutePluginsPluginPublisherVersions_ClassNames =
	| "RoutePluginsPluginPublisherVersions"
	| "RoutePluginsPluginPublisherVersions-title"
	| "RoutePluginsPluginPublisherVersions-description"
	| "RoutePluginsPluginPublisherVersions-empty"
	| "RoutePluginsPluginPublisherVersions-list"
	| "RoutePluginsPluginPublisherVersionItem"
	| "RoutePluginsPluginPublisherVersionItem-version"
	| "RoutePluginsPluginPublisherVersionItem-meta";

type RoutePluginsPluginPublisherVersions_Props = {
	versions: RoutePlugins_PublisherPlugin["versions"];
};

const RoutePluginsPluginPublisherVersions = memo(function RoutePluginsPluginPublisherVersions(
	props: RoutePluginsPluginPublisherVersions_Props,
) {
	const { versions } = props;

	return (
		<section className={"RoutePluginsPluginPublisherVersions" satisfies RoutePluginsPluginPublisherVersions_ClassNames}>
			<h3
				className={"RoutePluginsPluginPublisherVersions-title" satisfies RoutePluginsPluginPublisherVersions_ClassNames}
			>
				<History aria-hidden />
				Published versions
				{versions.length === 0 ? null : <MyBadge variant="default">{versions.length}</MyBadge>}
			</h3>
			<p
				className={
					"RoutePluginsPluginPublisherVersions-description" satisfies RoutePluginsPluginPublisherVersions_ClassNames
				}
			>
				Every publish registers a new immutable version built from a commit of this repository.
			</p>

			{versions.length === 0 ? (
				<div
					className={
						"RoutePluginsPluginPublisherVersions-empty" satisfies RoutePluginsPluginPublisherVersions_ClassNames
					}
				>
					Nothing published yet. Use the Publish button above to build and register the first version.
				</div>
			) : (
				<div
					className={
						"RoutePluginsPluginPublisherVersions-list" satisfies RoutePluginsPluginPublisherVersions_ClassNames
					}
				>
					{versions.map((version) => (
						<div
							key={version._id}
							className={
								"RoutePluginsPluginPublisherVersionItem" satisfies RoutePluginsPluginPublisherVersions_ClassNames
							}
						>
							<span
								className={
									"RoutePluginsPluginPublisherVersionItem-version" satisfies RoutePluginsPluginPublisherVersions_ClassNames
								}
							>
								{version.name}@{version.version}
							</span>
							<span
								className={
									"RoutePluginsPluginPublisherVersionItem-meta" satisfies RoutePluginsPluginPublisherVersions_ClassNames
								}
							>
								{version.sourceCommitSha.slice(0, 8)} · {format_datetime(version._creationTime)}
							</span>
							<MyBadge variant={review_badge_variant(version.reviewStatus)}>{version.reviewStatus}</MyBadge>
						</div>
					))}
				</div>
			)}
		</section>
	);
});
// #endregion publisher versions

// #region publisher reviews
type RoutePluginsPluginPublisherReviews_ClassNames =
	| "RoutePluginsPluginPublisherReviews"
	| "RoutePluginsPluginPublisherReviews-title"
	| "RoutePluginsPluginPublisherReviews-description"
	| "RoutePluginsPluginPublisherReviews-empty"
	| "RoutePluginsPluginPublisherReviews-list"
	| "RoutePluginsPluginPublisherReviewItem"
	| "RoutePluginsPluginPublisherReviewItem-header"
	| "RoutePluginsPluginPublisherReviewItem-name"
	| "RoutePluginsPluginPublisherReviewItem-meta"
	| "RoutePluginsPluginPublisherReviewItem-findings"
	| "RoutePluginsPluginPublisherReviewItem-note";

type RoutePluginsPluginPublisherReviews_Props = {
	reviews: RoutePlugins_PublisherPlugin["reviews"];
};

const RoutePluginsPluginPublisherReviews = memo(function RoutePluginsPluginPublisherReviews(
	props: RoutePluginsPluginPublisherReviews_Props,
) {
	const { reviews } = props;

	return (
		<section className={"RoutePluginsPluginPublisherReviews" satisfies RoutePluginsPluginPublisherReviews_ClassNames}>
			<h3
				className={"RoutePluginsPluginPublisherReviews-title" satisfies RoutePluginsPluginPublisherReviews_ClassNames}
			>
				<ShieldCheck aria-hidden />
				Review verdicts
				{reviews.length === 0 ? null : <MyBadge variant="default">{reviews.length}</MyBadge>}
			</h3>
			<p
				className={
					"RoutePluginsPluginPublisherReviews-description" satisfies RoutePluginsPluginPublisherReviews_ClassNames
				}
			>
				Every published version is reviewed before it is registered. Rejected versions are not registered, and flagged
				versions are registered but cannot be installed.
			</p>

			{reviews.length === 0 ? (
				<div
					className={"RoutePluginsPluginPublisherReviews-empty" satisfies RoutePluginsPluginPublisherReviews_ClassNames}
				>
					No versions reviewed yet.
				</div>
			) : (
				<div
					className={"RoutePluginsPluginPublisherReviews-list" satisfies RoutePluginsPluginPublisherReviews_ClassNames}
				>
					{reviews.map((review) => {
						const findings = [...review.mechanicalFindings, ...review.aiFindings];
						return (
							<div
								key={review._id}
								className={
									"RoutePluginsPluginPublisherReviewItem" satisfies RoutePluginsPluginPublisherReviews_ClassNames
								}
							>
								<div
									className={
										"RoutePluginsPluginPublisherReviewItem-header" satisfies RoutePluginsPluginPublisherReviews_ClassNames
									}
								>
									<span
										className={
											"RoutePluginsPluginPublisherReviewItem-name" satisfies RoutePluginsPluginPublisherReviews_ClassNames
										}
									>
										{review.pluginName}@{review.version}
									</span>
									<span
										className={
											"RoutePluginsPluginPublisherReviewItem-meta" satisfies RoutePluginsPluginPublisherReviews_ClassNames
										}
									>
										{review.model === "none" ? "mechanical checks" : review.model} · {format_datetime(review.updatedAt)}
									</span>
									<MyBadge variant={review_badge_variant(review.status)}>{review.status}</MyBadge>
								</div>
								{findings.length === 0 ? null : (
									<ul
										className={
											"RoutePluginsPluginPublisherReviewItem-findings" satisfies RoutePluginsPluginPublisherReviews_ClassNames
										}
									>
										{findings.map((finding, index) => (
											<li key={index}>{finding}</li>
										))}
									</ul>
								)}
								{review.status === "flagged" ? (
									<div
										className={
											"RoutePluginsPluginPublisherReviewItem-note" satisfies RoutePluginsPluginPublisherReviews_ClassNames
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
// #endregion publisher reviews

// #region publisher secrets
type RoutePluginsPluginPublisherSecrets_ClassNames =
	| "RoutePluginsPluginPublisherSecrets"
	| "RoutePluginsPluginPublisherSecrets-title"
	| "RoutePluginsPluginPublisherSecrets-description"
	| "RoutePluginsPluginPublisherSecrets-form"
	| "RoutePluginsPluginPublisherSecrets-env"
	| "RoutePluginsPluginPublisherSecrets-empty"
	| "RoutePluginsPluginPublisherSecrets-list"
	| "RoutePluginsPluginPublisherSecretItem"
	| "RoutePluginsPluginPublisherSecretItem-identity"
	| "RoutePluginsPluginPublisherSecretItem-name"
	| "RoutePluginsPluginPublisherSecretItem-meta";

type RoutePluginsPluginPublisher_Secret = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_publisher_repository_secrets
>[number];

type RoutePluginsPluginPublisherSecretRow_Props = {
	repositoryId: app_convex_Id<"plugins_publisher_repositories">;
	secret: RoutePluginsPluginPublisher_Secret;
};

const RoutePluginsPluginPublisherSecretRow = memo(function RoutePluginsPluginPublisherSecretRow(
	props: RoutePluginsPluginPublisherSecretRow_Props,
) {
	const { repositoryId, secret } = props;
	const [saving, setSaving] = useState(false);

	const handleDelete = useFn(() => {
		setSaving(true);
		app_convex
			.mutation(app_convex_api.plugins.delete_publisher_repository_secret, { repositoryId, name: secret.name })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Secret ${secret.name} deleted`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPluginPublisher.handleDelete] Failed to delete secret:", {
					error,
					name: secret.name,
				});
				toast.error("Failed to delete secret");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	return (
		<div className={"RoutePluginsPluginPublisherSecretItem" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}>
			<div
				className={
					"RoutePluginsPluginPublisherSecretItem-identity" satisfies RoutePluginsPluginPublisherSecrets_ClassNames
				}
			>
				<span
					className={
						"RoutePluginsPluginPublisherSecretItem-name" satisfies RoutePluginsPluginPublisherSecrets_ClassNames
					}
				>
					{secret.name}
				</span>
				<span
					className={
						"RoutePluginsPluginPublisherSecretItem-meta" satisfies RoutePluginsPluginPublisherSecrets_ClassNames
					}
				>
					{secret.valuePreview} · updated {format_datetime(secret.updatedAt)}
					{secret.lastUsedAt === null ? "" : ` · used ${format_datetime(secret.lastUsedAt)}`}
				</span>
			</div>
			<MyButton
				variant="ghost_destructive"
				aria-label={`Delete secret ${secret.name}`}
				disabled={saving}
				onClick={handleDelete}
			>
				<Trash2 aria-hidden />
			</MyButton>
		</div>
	);
});

type RoutePluginsPluginPublisherSecrets_Props = {
	repositoryId: app_convex_Id<"plugins_publisher_repositories">;
};

const RoutePluginsPluginPublisherSecrets = memo(function RoutePluginsPluginPublisherSecrets(
	props: RoutePluginsPluginPublisherSecrets_Props,
) {
	const { repositoryId } = props;
	const secrets = useQuery(app_convex_api.plugins.list_publisher_repository_secrets, { repositoryId });
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
			.mutation(app_convex_api.plugins.upsert_publisher_repository_secret, {
				repositoryId,
				name,
				value,
			})
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
				console.error("[RoutePluginsPluginPublisher.handleSaveSecret] Failed to save secret:", {
					error,
					name,
				});
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
			.mutation(app_convex_api.plugins.upsert_publisher_repository_secrets, {
				repositoryId,
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
				console.error("[RoutePluginsPluginPublisher.handleImportEnv] Failed to import secrets:", {
					error,
				});
				toast.error("Failed to import secrets");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	return (
		<section className={"RoutePluginsPluginPublisherSecrets" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}>
			<h3
				className={"RoutePluginsPluginPublisherSecrets-title" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}
			>
				<KeyRound aria-hidden />
				Secrets
				{secrets === undefined || secrets.length === 0 ? null : <MyBadge variant="default">{secrets.length}</MyBadge>}
			</h3>
			<p
				className={
					"RoutePluginsPluginPublisherSecrets-description" satisfies RoutePluginsPluginPublisherSecrets_ClassNames
				}
			>
				These secrets belong to this plugin's repository and are available to it in every workspace that installs it.
				The plugin can only send requests to the outbound origins its manifest declares, which every workspace
				consents to at install.
			</p>

			<form
				className={"RoutePluginsPluginPublisherSecrets-form" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}
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

			<div className={"RoutePluginsPluginPublisherSecrets-env" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}>
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
					className={"RoutePluginsPluginPublisherSecrets-empty" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}
					role="status"
				>
					Loading secrets...
				</div>
			) : secrets.length === 0 ? (
				<div
					className={"RoutePluginsPluginPublisherSecrets-empty" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}
				>
					No secrets configured.
				</div>
			) : (
				<div
					className={"RoutePluginsPluginPublisherSecrets-list" satisfies RoutePluginsPluginPublisherSecrets_ClassNames}
				>
					{secrets.map((secret) => (
						<RoutePluginsPluginPublisherSecretRow key={secret._id} repositoryId={repositoryId} secret={secret} />
					))}
				</div>
			)}
		</section>
	);
});
// #endregion publisher secrets

// #region publisher
type RoutePluginsPluginPublisher_ClassNames =
	| "RoutePluginsPluginPublisher"
	| "RoutePluginsPluginPublisher-titleRow"
	| "RoutePluginsPluginPublisher-title"
	| "RoutePluginsPluginPublisher-actions"
	| "RoutePluginsPluginPublisher-meta"
	| "RoutePluginsPluginPublisher-repoLink"
	| "RoutePluginsPluginPublisher-lastAttempt"
	| "RoutePluginsPluginPublisher-lastAttemptMessage";

type RoutePluginsPluginPublisher_Props = {
	details: RoutePlugins_PublisherPlugin;
};

const RoutePluginsPluginPublisher = memo(function RoutePluginsPluginPublisher(
	props: RoutePluginsPluginPublisher_Props,
) {
	const { details } = props;
	const [publishing, setPublishing] = useState(false);
	const [removing, setRemoving] = useState(false);

	const handlePublish = useFn(() => {
		setPublishing(true);
		app_convex
			.action(app_convex_api.plugins.publish_version, { repositoryId: details.repository._id })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Published commit ${result._yay.sourceCommitSha.slice(0, 8)}`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPluginPublisher.handlePublish] Failed to publish plugin:", {
					error,
					repositoryId: details.repository._id,
				});
				toast.error("Failed to publish plugin");
			})
			.finally(() => {
				setPublishing(false);
			});
	});

	const handleRemove = useFn(() => {
		setRemoving(true);
		app_convex
			.mutation(app_convex_api.plugins.remove_repository, { repositoryId: details.repository._id })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				// No navigation: get_publisher_plugin goes null once the claim is gone, hiding this panel.
				toast.success("Repository claim removed");
			})
			.catch((error) => {
				console.error("[RoutePluginsPluginPublisher.handleRemove] Failed to remove repository claim:", {
					error,
					repositoryId: details.repository._id,
				});
				toast.error("Failed to remove repository claim");
			})
			.finally(() => {
				setRemoving(false);
			});
	});

	return (
		<section className={"RoutePluginsPluginPublisher" satisfies RoutePluginsPluginPublisher_ClassNames}>
			<div className={"RoutePluginsPluginPublisher-titleRow" satisfies RoutePluginsPluginPublisher_ClassNames}>
				<h2 className={"RoutePluginsPluginPublisher-title" satisfies RoutePluginsPluginPublisher_ClassNames}>
					<Store aria-hidden />
					Publisher
				</h2>
				<div className={"RoutePluginsPluginPublisher-actions" satisfies RoutePluginsPluginPublisher_ClassNames}>
					<MyButton disabled={publishing || removing} onClick={handlePublish}>
						<UploadCloud aria-hidden />
						{publishing ? "Publishing..." : "Publish"}
					</MyButton>
					<MyButton
						variant="ghost_destructive"
						aria-label={`Remove claim on ${details.repository.owner}/${details.repository.repo}`}
						tooltip="Remove claim"
						disabled={publishing || removing}
						onClick={handleRemove}
					>
						<Trash2 aria-hidden />
					</MyButton>
				</div>
			</div>
			<div className={"RoutePluginsPluginPublisher-meta" satisfies RoutePluginsPluginPublisher_ClassNames}>
				<a
					className={"RoutePluginsPluginPublisher-repoLink" satisfies RoutePluginsPluginPublisher_ClassNames}
					href={details.repository.repositoryUrl}
					target="_blank"
					rel="noreferrer"
				>
					<GitBranch aria-hidden />
					{details.repository.owner}/{details.repository.repo}
				</a>
				<span>Publish builds and registers the default-branch HEAD.</span>
			</div>
			{details.repository.lastPublishAttempt ? (
				<div className={"RoutePluginsPluginPublisher-lastAttempt" satisfies RoutePluginsPluginPublisher_ClassNames}>
					<MyBadge variant={details.repository.lastPublishAttempt.status === "succeeded" ? "secondary" : "destructive"}>
						{details.repository.lastPublishAttempt.status}
					</MyBadge>
					<span
						className={
							"RoutePluginsPluginPublisher-lastAttemptMessage" satisfies RoutePluginsPluginPublisher_ClassNames
						}
					>
						Last publish {format_datetime(details.repository.lastPublishAttempt.at)} ·{" "}
						{details.repository.lastPublishAttempt.message}
					</span>
				</div>
			) : null}

			<RoutePluginsPluginPublisherVersions versions={details.versions} />
			<RoutePluginsPluginPublisherReviews reviews={details.reviews} />
			<RoutePluginsPluginPublisherSecrets repositoryId={details.repository._id} />
		</section>
	);
});
// #endregion publisher

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
	const plugins = useQuery(app_convex_api.plugins.list_published_plugins, { membershipId });
	const installations = useQuery(app_convex_api.plugins.list_installations, { membershipId });
	// Non-null only when the signed-in user owns this plugin's repository claim.
	const publisherPlugin = useQuery(app_convex_api.plugins.get_publisher_plugin, { pluginName });
	const [consenting, setConsenting] = useState(false);
	const [installing, setInstalling] = useState(false);

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

			{publisherPlugin ? <RoutePluginsPluginPublisher details={publisherPlugin} /> : null}

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
