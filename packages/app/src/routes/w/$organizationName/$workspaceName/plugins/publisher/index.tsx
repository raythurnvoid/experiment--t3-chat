import "./index.css";

import { useClerk } from "@clerk/clerk-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ChevronRight, GitBranch, KeyRound, LogIn, Plus, Puzzle, Save, Store, Trash2 } from "lucide-react";
import { memo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
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
import { MyLink } from "@/components/my-link.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { plugins_origin_validate, plugins_parse_env_text } from "../../../../../../../shared/plugins.ts";

type RoutePluginsPublisher_Repositories = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_my_publisher_repositories
>;

// #region sign in
type RoutePluginsPublisherSignIn_ClassNames =
	| "RoutePluginsPublisherSignIn"
	| "RoutePluginsPublisherSignIn-header"
	| "RoutePluginsPublisherSignIn-title"
	| "RoutePluginsPublisherSignIn-description"
	| "RoutePluginsPublisherSignIn-actions";

const RoutePluginsPublisherSignIn = memo(function RoutePluginsPublisherSignIn() {
	const clerk = useClerk();

	const handleOpenSignIn = useFn(() => {
		void clerk.openSignIn();
	});

	return (
		<section className={"RoutePluginsPublisherSignIn" satisfies RoutePluginsPublisherSignIn_ClassNames}>
			<div className={"RoutePluginsPublisherSignIn-header" satisfies RoutePluginsPublisherSignIn_ClassNames}>
				<h2 className={"RoutePluginsPublisherSignIn-title" satisfies RoutePluginsPublisherSignIn_ClassNames}>
					<LogIn aria-hidden />
					Sign in to publish
				</h2>
				<p className={"RoutePluginsPublisherSignIn-description" satisfies RoutePluginsPublisherSignIn_ClassNames}>
					Publishing plugins requires a signed-in account. Log in to claim repositories and publish plugin versions
					under your account name.
				</p>
			</div>
			<div className={"RoutePluginsPublisherSignIn-actions" satisfies RoutePluginsPublisherSignIn_ClassNames}>
				<MyButton onClick={handleOpenSignIn}>
					<LogIn aria-hidden />
					Log in
				</MyButton>
			</div>
		</section>
	);
});
// #endregion sign in

// #region plugins
type RoutePluginsPublisherPlugins_ClassNames =
	| "RoutePluginsPublisherPlugins"
	| "RoutePluginsPublisherPlugins-header"
	| "RoutePluginsPublisherPlugins-title"
	| "RoutePluginsPublisherPlugins-description"
	| "RoutePluginsPublisherPlugins-form"
	| "RoutePluginsPublisherPlugins-empty"
	| "RoutePluginsPublisherPlugins-list"
	| "RoutePluginsPublisherPluginCard"
	| "RoutePluginsPublisherPluginCard-icon"
	| "RoutePluginsPublisherPluginCard-info"
	| "RoutePluginsPublisherPluginCard-name"
	| "RoutePluginsPublisherPluginCard-meta"
	| "RoutePluginsPublisherPluginCard-chevron";

type RoutePluginsPublisherPlugins_Props = {
	repositories: RoutePluginsPublisher_Repositories;
};

const RoutePluginsPublisherPlugins = memo(function RoutePluginsPublisherPlugins(
	props: RoutePluginsPublisherPlugins_Props,
) {
	const { repositories } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const navigate = useNavigate();
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [claiming, setClaiming] = useState(false);

	const handleClaim = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!repositoryUrl.trim()) {
			return;
		}

		setClaiming(true);
		app_convex
			.mutation(app_convex_api.plugins.claim_repository, { repositoryUrl })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Claimed ${result._yay.repositoryUrl}`);
				setRepositoryUrl("");
				void navigate({
					to: "/w/$organizationName/$workspaceName/plugins/publisher/$repositoryId",
					params: { organizationName, workspaceName, repositoryId: result._yay.repositoryId },
				});
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleClaim] Failed to claim repository:", {
					error,
					repositoryUrl,
				});
				toast.error("Failed to claim repository");
			})
			.finally(() => {
				setClaiming(false);
			});
	});

	return (
		<section className={"RoutePluginsPublisherPlugins" satisfies RoutePluginsPublisherPlugins_ClassNames}>
			<div className={"RoutePluginsPublisherPlugins-header" satisfies RoutePluginsPublisherPlugins_ClassNames}>
				<h2 className={"RoutePluginsPublisherPlugins-title" satisfies RoutePluginsPublisherPlugins_ClassNames}>
					<Puzzle aria-hidden />
					Your plugins
					{repositories.length === 0 ? null : <MyBadge variant="default">{repositories.length}</MyBadge>}
				</h2>
				<p className={"RoutePluginsPublisherPlugins-description" satisfies RoutePluginsPublisherPlugins_ClassNames}>
					Claim a GitHub repository to publish it as a plugin. Each claimed repository gets its own page where you
					publish versions and track review verdicts.
				</p>
			</div>

			<form
				className={"RoutePluginsPublisherPlugins-form" satisfies RoutePluginsPublisherPlugins_ClassNames}
				onSubmit={handleClaim}
			>
				<MyInput>
					<MyInputLabel>GitHub repository URL</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							value={repositoryUrl}
							placeholder="https://github.com/owner/plugin-repo"
							inputMode="url"
							disabled={claiming}
							required
							onChange={(event) => setRepositoryUrl(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				<MyButton type="submit" disabled={claiming || !repositoryUrl.trim()}>
					<Plus aria-hidden />
					{claiming ? "Claiming..." : "Claim"}
				</MyButton>
			</form>

			{repositories.length === 0 ? (
				<div className={"RoutePluginsPublisherPlugins-empty" satisfies RoutePluginsPublisherPlugins_ClassNames}>
					No repositories claimed yet. Claim one to start publishing.
				</div>
			) : (
				<div className={"RoutePluginsPublisherPlugins-list" satisfies RoutePluginsPublisherPlugins_ClassNames}>
					{repositories.map(({ repository, latestVersion }) => (
						<MyLink
							key={repository._id}
							to="/w/$organizationName/$workspaceName/plugins/publisher/$repositoryId"
							params={{ organizationName, workspaceName, repositoryId: repository._id }}
							aria-label={`Open plugin page for ${repository.owner}/${repository.repo}`}
							className={"RoutePluginsPublisherPluginCard" satisfies RoutePluginsPublisherPlugins_ClassNames}
						>
							{latestVersion ? (
								<Puzzle
									aria-hidden
									className={"RoutePluginsPublisherPluginCard-icon" satisfies RoutePluginsPublisherPlugins_ClassNames}
								/>
							) : (
								<GitBranch
									aria-hidden
									className={"RoutePluginsPublisherPluginCard-icon" satisfies RoutePluginsPublisherPlugins_ClassNames}
								/>
							)}
							<span
								className={"RoutePluginsPublisherPluginCard-info" satisfies RoutePluginsPublisherPlugins_ClassNames}
							>
								<span
									className={"RoutePluginsPublisherPluginCard-name" satisfies RoutePluginsPublisherPlugins_ClassNames}
								>
									{latestVersion?.displayName ?? `${repository.owner}/${repository.repo}`}
								</span>
								<span
									className={"RoutePluginsPublisherPluginCard-meta" satisfies RoutePluginsPublisherPlugins_ClassNames}
								>
									{latestVersion
										? `${latestVersion.name}@${latestVersion.version} · ${repository.owner}/${repository.repo}`
										: `${repository.repositoryUrl} · never published`}
								</span>
							</span>
							{latestVersion ? (
								<MyBadge
									variant={
										latestVersion.reviewStatus === "rejected"
											? "destructive"
											: latestVersion.reviewStatus === "flagged"
												? "outline"
												: "secondary"
									}
								>
									{latestVersion.reviewStatus}
								</MyBadge>
							) : null}
							<ChevronRight
								aria-hidden
								className={"RoutePluginsPublisherPluginCard-chevron" satisfies RoutePluginsPublisherPlugins_ClassNames}
							/>
						</MyLink>
					))}
				</div>
			)}
		</section>
	);
});
// #endregion plugins

// #region secrets
type RoutePluginsPublisherSecrets_ClassNames =
	| "RoutePluginsPublisherSecrets"
	| "RoutePluginsPublisherSecrets-header"
	| "RoutePluginsPublisherSecrets-title"
	| "RoutePluginsPublisherSecrets-description"
	| "RoutePluginsPublisherSecrets-form"
	| "RoutePluginsPublisherSecrets-error"
	| "RoutePluginsPublisherSecrets-env"
	| "RoutePluginsPublisherSecrets-empty"
	| "RoutePluginsPublisherSecrets-list"
	| "RoutePluginsPublisherSecretItem"
	| "RoutePluginsPublisherSecretItem-identity"
	| "RoutePluginsPublisherSecretItem-name"
	| "RoutePluginsPublisherSecretItem-meta"
	| "RoutePluginsPublisherSecretItem-origins";

function format_date(value: number) {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

type RoutePluginsPublisher_Secret = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_publisher_secrets
>[number];

function origins_from_text(text: string) {
	return text
		.split(/[\n,]/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function origins_validation_error(rawOrigins: string[]) {
	for (const raw of rawOrigins) {
		const origin = plugins_origin_validate(raw);
		if (origin._nay) {
			return `${raw}: ${origin._nay.message}`;
		}
	}
	return "";
}

type RoutePluginsPublisherSecretRow_Props = {
	secret: RoutePluginsPublisher_Secret;
};

const RoutePluginsPublisherSecretRow = memo(function RoutePluginsPublisherSecretRow(
	props: RoutePluginsPublisherSecretRow_Props,
) {
	const { secret } = props;
	const [originsText, setOriginsText] = useState(secret.allowedOrigins.join(", "));
	const [originsError, setOriginsError] = useState("");
	const [saving, setSaving] = useState(false);

	const handleSaveOrigins = useFn(() => {
		const rawOrigins = origins_from_text(originsText);
		const validationError = origins_validation_error(rawOrigins);
		if (validationError) {
			setOriginsError(validationError);
			return;
		}
		setOriginsError("");

		setSaving(true);
		app_convex
			.mutation(app_convex_api.plugins.update_publisher_secret_origins, {
				name: secret.name,
				allowedOrigins: rawOrigins,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Allowed origins for ${secret.name} updated`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleSaveOrigins] Failed to update allowed origins:", {
					error,
					name: secret.name,
				});
				toast.error("Failed to update allowed origins");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	const handleDelete = useFn(() => {
		setSaving(true);
		app_convex
			.mutation(app_convex_api.plugins.delete_publisher_secret, { name: secret.name })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Secret ${secret.name} deleted`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleDelete] Failed to delete secret:", {
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
		<div className={"RoutePluginsPublisherSecretItem" satisfies RoutePluginsPublisherSecrets_ClassNames}>
			<div className={"RoutePluginsPublisherSecretItem-identity" satisfies RoutePluginsPublisherSecrets_ClassNames}>
				<span className={"RoutePluginsPublisherSecretItem-name" satisfies RoutePluginsPublisherSecrets_ClassNames}>
					{secret.name}
				</span>
				<span className={"RoutePluginsPublisherSecretItem-meta" satisfies RoutePluginsPublisherSecrets_ClassNames}>
					{secret.valuePreview} · updated {format_date(secret.updatedAt)}
					{secret.lastUsedAt === null ? "" : ` · used ${format_date(secret.lastUsedAt)}`}
				</span>
			</div>
			<div className={"RoutePluginsPublisherSecretItem-origins" satisfies RoutePluginsPublisherSecrets_ClassNames}>
				<MyInput>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							value={originsText}
							placeholder="https://api.example.com"
							aria-label={`Allowed origins for ${secret.name}`}
							aria-describedby={originsError ? `RoutePluginsPublisherSecretItem-error-${secret._id}` : undefined}
							disabled={saving}
							onChange={(event) => setOriginsText(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				{originsError ? (
					<div
						className={"RoutePluginsPublisherSecrets-error" satisfies RoutePluginsPublisherSecrets_ClassNames}
						id={`RoutePluginsPublisherSecretItem-error-${secret._id}`}
						role="alert"
					>
						{originsError}
					</div>
				) : null}
			</div>
			<MyButton
				variant="secondary"
				disabled={saving}
				aria-label={`Save allowed origins for ${secret.name}`}
				onClick={handleSaveOrigins}
			>
				<Save aria-hidden />
				Save origins
			</MyButton>
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

const RoutePluginsPublisherSecrets = memo(function RoutePluginsPublisherSecrets() {
	const secrets = useQuery(app_convex_api.plugins.list_publisher_secrets, {});
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [originsText, setOriginsText] = useState("");
	const [originsError, setOriginsError] = useState("");
	const [envText, setEnvText] = useState("");
	const [saving, setSaving] = useState(false);

	const handleSaveSecret = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!name.trim() || !value) {
			return;
		}
		const rawOrigins = origins_from_text(originsText);
		const validationError = origins_validation_error(rawOrigins);
		if (validationError) {
			setOriginsError(validationError);
			return;
		}
		setOriginsError("");

		setSaving(true);
		app_convex
			.mutation(app_convex_api.plugins.upsert_publisher_secret, {
				name,
				value,
				allowedOrigins: rawOrigins,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Secret ${name.trim()} saved`);
				setName("");
				setValue("");
				setOriginsText("");
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleSaveSecret] Failed to save secret:", {
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
			.mutation(app_convex_api.plugins.upsert_publisher_secrets, {
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
				console.error("[RoutePluginsPublisher.handleImportEnv] Failed to import secrets:", {
					error,
				});
				toast.error("Failed to import secrets");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	return (
		<section className={"RoutePluginsPublisherSecrets" satisfies RoutePluginsPublisherSecrets_ClassNames}>
			<div className={"RoutePluginsPublisherSecrets-header" satisfies RoutePluginsPublisherSecrets_ClassNames}>
				<h2 className={"RoutePluginsPublisherSecrets-title" satisfies RoutePluginsPublisherSecrets_ClassNames}>
					<KeyRound aria-hidden />
					Secrets
					{secrets === undefined || secrets.length === 0 ? null : (
						<MyBadge variant="default">{secrets.length}</MyBadge>
					)}
				</h2>
				<p className={"RoutePluginsPublisherSecrets-description" satisfies RoutePluginsPublisherSecrets_ClassNames}>
					Publisher secrets are available to all your plugins in every workspace that installs them. A secret can only
					travel to the exact https origins you allow here.
				</p>
			</div>

			<form
				className={"RoutePluginsPublisherSecrets-form" satisfies RoutePluginsPublisherSecrets_ClassNames}
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
				<MyInput>
					<MyInputLabel>Allowed origins</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							value={originsText}
							placeholder="https://api.example.com, https://files.example.com"
							aria-describedby={originsError ? "RoutePluginsPublisherSecrets-error" : undefined}
							disabled={saving}
							onChange={(event) => setOriginsText(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				<MyButton type="submit" disabled={saving || !name.trim() || !value}>
					<Save aria-hidden />
					{saving ? "Saving..." : "Save"}
				</MyButton>
			</form>
			{originsError ? (
				<div
					className={"RoutePluginsPublisherSecrets-error" satisfies RoutePluginsPublisherSecrets_ClassNames}
					id="RoutePluginsPublisherSecrets-error"
					role="alert"
				>
					{originsError}
				</div>
			) : null}

			<div className={"RoutePluginsPublisherSecrets-env" satisfies RoutePluginsPublisherSecrets_ClassNames}>
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
					className={"RoutePluginsPublisherSecrets-empty" satisfies RoutePluginsPublisherSecrets_ClassNames}
					role="status"
				>
					Loading secrets...
				</div>
			) : secrets.length === 0 ? (
				<div className={"RoutePluginsPublisherSecrets-empty" satisfies RoutePluginsPublisherSecrets_ClassNames}>
					No secrets configured.
				</div>
			) : (
				<div className={"RoutePluginsPublisherSecrets-list" satisfies RoutePluginsPublisherSecrets_ClassNames}>
					{secrets.map((secret) => (
						<RoutePluginsPublisherSecretRow key={secret._id} secret={secret} />
					))}
				</div>
			)}
		</section>
	);
});
// #endregion secrets

// #region root
type RoutePluginsPublisher_ClassNames =
	| "RoutePluginsPublisher"
	| "RoutePluginsPublisher-loading"
	| "RoutePluginsPublisherHeader"
	| "RoutePluginsPublisherHeader-title"
	| "RoutePluginsPublisherHeader-description"
	| "RoutePluginsPublisherIdentity"
	| "RoutePluginsPublisherIdentity-text"
	| "RoutePluginsPublisherIdentity-name"
	| "RoutePluginsPublisherIdentity-email";

function RoutePluginsPublisher() {
	const auth = AppAuthProvider.useAuth();
	const repositories = useQuery(
		app_convex_api.plugins.list_my_publisher_repositories,
		auth.isAnonymous === false ? {} : "skip",
	);
	const anagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		auth.isAnonymous === false && auth.userId ? { userId: auth.userId } : "skip",
	);

	if (!auth.isAnonymous && repositories === undefined) {
		return (
			<main
				className={"RoutePluginsPublisher" satisfies RoutePluginsPublisher_ClassNames}
				role="status"
				aria-live="polite"
			>
				<div className={"RoutePluginsPublisher-loading" satisfies RoutePluginsPublisher_ClassNames}>
					<Store aria-hidden />
					Loading publisher...
				</div>
			</main>
		);
	}

	return (
		<main className={"RoutePluginsPublisher" satisfies RoutePluginsPublisher_ClassNames}>
			<header className={"RoutePluginsPublisherHeader" satisfies RoutePluginsPublisher_ClassNames}>
				<div>
					<h1 className={"RoutePluginsPublisherHeader-title" satisfies RoutePluginsPublisher_ClassNames}>Publisher</h1>
					<p className={"RoutePluginsPublisherHeader-description" satisfies RoutePluginsPublisher_ClassNames}>
						{auth.isAnonymous
							? "Sign in to publish plugins."
							: "Manage your plugins and the secrets they can use. Plugins you publish are shown under your account name."}
					</p>
				</div>
				{auth.isAnonymous === false && anagraphic ? (
					<div className={"RoutePluginsPublisherIdentity" satisfies RoutePluginsPublisher_ClassNames}>
						<Store aria-hidden />
						<div className={"RoutePluginsPublisherIdentity-text" satisfies RoutePluginsPublisher_ClassNames}>
							<span className={"RoutePluginsPublisherIdentity-name" satisfies RoutePluginsPublisher_ClassNames}>
								{anagraphic.displayName}
							</span>
							{anagraphic.email ? (
								<span className={"RoutePluginsPublisherIdentity-email" satisfies RoutePluginsPublisher_ClassNames}>
									{anagraphic.email}
								</span>
							) : null}
						</div>
					</div>
				) : null}
			</header>

			{auth.isAnonymous ? (
				<RoutePluginsPublisherSignIn />
			) : (
				<>
					<RoutePluginsPublisherPlugins repositories={repositories ?? []} />
					<RoutePluginsPublisherSecrets />
				</>
			)}
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/publisher/")({
	component: RoutePluginsPublisher,
});

export { Route };
// #endregion root
