import "./publisher.css";

import { useClerk } from "@clerk/clerk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { GitBranch, KeyRound, LogIn, Plus, Save, ShieldCheck, Store, Trash2, UploadCloud } from "lucide-react";
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
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { plugins_origin_validate, plugins_parse_env_text } from "../../../../../../shared/plugins.ts";

type RoutePluginsPublisher_Publisher = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.plugins.get_my_publisher>
>;

// #region create form
type RoutePluginsPublisherCreate_ClassNames =
	| "RoutePluginsPublisherCreate"
	| "RoutePluginsPublisherCreate-description"
	| "RoutePluginsPublisherCreate-form"
	| "RoutePluginsPublisherCreate-actions";

const RoutePluginsPublisherCreate = memo(function RoutePluginsPublisherCreate() {
	const [slug, setSlug] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [creating, setCreating] = useState(false);

	const handleCreate = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!slug.trim() || !displayName.trim()) {
			return;
		}

		setCreating(true);
		app_convex
			.mutation(app_convex_api.plugins.create_publisher, { slug, displayName })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Publisher ${result._yay.slug} created`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleCreate] Failed to create publisher:", { error, slug });
				toast.error("Failed to create publisher");
			})
			.finally(() => {
				setCreating(false);
			});
	});

	return (
		<section className={"RoutePluginsPublisherCreate" satisfies RoutePluginsPublisherCreate_ClassNames}>
			<p className={"RoutePluginsPublisherCreate-description" satisfies RoutePluginsPublisherCreate_ClassNames}>
				A publisher identity is required to publish plugins. Your publisher slug is referenced by the `publisher` field
				of each plugin manifest you publish.
			</p>
			<form
				className={"RoutePluginsPublisherCreate-form" satisfies RoutePluginsPublisherCreate_ClassNames}
				onSubmit={handleCreate}
			>
				<MyInput>
					<MyInputLabel>Publisher slug</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							value={slug}
							placeholder="my-publisher"
							disabled={creating}
							required
							onChange={(event) => setSlug(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>

				<MyInput>
					<MyInputLabel>Display name</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							value={displayName}
							placeholder="My Publisher"
							disabled={creating}
							required
							onChange={(event) => setDisplayName(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>

				<div className={"RoutePluginsPublisherCreate-actions" satisfies RoutePluginsPublisherCreate_ClassNames}>
					<MyButton type="submit" disabled={creating || !slug.trim() || !displayName.trim()}>
						<Store aria-hidden />
						{creating ? "Creating..." : "Create publisher"}
					</MyButton>
				</div>
			</form>
		</section>
	);
});
// #endregion create form

// #region sign in
type RoutePluginsPublisherSignIn_ClassNames =
	| "RoutePluginsPublisherSignIn"
	| "RoutePluginsPublisherSignIn-description"
	| "RoutePluginsPublisherSignIn-actions";

const RoutePluginsPublisherSignIn = memo(function RoutePluginsPublisherSignIn() {
	const clerk = useClerk();

	const handleOpenSignIn = useFn(() => {
		void clerk.openSignIn();
	});

	return (
		<section className={"RoutePluginsPublisherSignIn" satisfies RoutePluginsPublisherSignIn_ClassNames}>
			<p className={"RoutePluginsPublisherSignIn-description" satisfies RoutePluginsPublisherSignIn_ClassNames}>
				Publishing plugins requires a signed-in account. Log in to create your publisher identity, claim repositories,
				and publish plugin versions.
			</p>
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

// #region repositories
type RoutePluginsPublisherRepositories_ClassNames =
	| "RoutePluginsPublisherRepositories"
	| "RoutePluginsPublisherRepositories-title"
	| "RoutePluginsPublisherRepositories-description"
	| "RoutePluginsPublisherRepositories-form"
	| "RoutePluginsPublisherRepositories-list"
	| "RoutePluginsPublisherRepositories-empty"
	| "RoutePluginsPublisherRepositoryItem"
	| "RoutePluginsPublisherRepositoryItem-url";

type RoutePluginsPublisherRepositories_Props = {
	publisher: RoutePluginsPublisher_Publisher["publisher"];
	repositories: RoutePluginsPublisher_Publisher["repositories"];
};

const RoutePluginsPublisherRepositories = memo(function RoutePluginsPublisherRepositories(
	props: RoutePluginsPublisherRepositories_Props,
) {
	const { publisher, repositories } = props;
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [claiming, setClaiming] = useState(false);
	const [publishingId, setPublishingId] = useState<
		RoutePluginsPublisher_Publisher["repositories"][number]["_id"] | null
	>(null);

	const handleClaim = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!repositoryUrl.trim()) {
			return;
		}

		setClaiming(true);
		app_convex
			.mutation(app_convex_api.plugins.claim_repository, { publisherId: publisher._id, repositoryUrl })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Claimed ${result._yay.repositoryUrl}`);
				setRepositoryUrl("");
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleClaim] Failed to claim repository:", {
					error,
					publisherId: publisher._id,
				});
				toast.error("Failed to claim repository");
			})
			.finally(() => {
				setClaiming(false);
			});
	});

	const handlePublish = useFn((repositoryId: RoutePluginsPublisher_Publisher["repositories"][number]["_id"]) => {
		setPublishingId(repositoryId);
		app_convex
			.action(app_convex_api.plugins.publish_version, { publisherId: publisher._id, repositoryId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Published commit ${result._yay.sourceCommitSha.slice(0, 8)}`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handlePublish] Failed to publish plugin:", {
					error,
					publisherId: publisher._id,
					repositoryId,
				});
				toast.error("Failed to publish plugin");
			})
			.finally(() => {
				setPublishingId(null);
			});
	});

	const handleRemove = useFn((repositoryId: RoutePluginsPublisher_Publisher["repositories"][number]["_id"]) => {
		app_convex
			.mutation(app_convex_api.plugins.remove_repository, { repositoryId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success("Repository claim removed");
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleRemove] Failed to remove repository claim:", {
					error,
					repositoryId,
				});
				toast.error("Failed to remove repository claim");
			});
	});

	return (
		<section className={"RoutePluginsPublisherRepositories" satisfies RoutePluginsPublisherRepositories_ClassNames}>
			<h2 className={"RoutePluginsPublisherRepositories-title" satisfies RoutePluginsPublisherRepositories_ClassNames}>
				<GitBranch aria-hidden />
				Claimed repositories
			</h2>
			<p
				className={
					"RoutePluginsPublisherRepositories-description" satisfies RoutePluginsPublisherRepositories_ClassNames
				}
			>
				A repository can be published only when it is claimed here and its manifest names your publisher slug.
			</p>

			<form
				className={"RoutePluginsPublisherRepositories-form" satisfies RoutePluginsPublisherRepositories_ClassNames}
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
				<div
					className={"RoutePluginsPublisherRepositories-empty" satisfies RoutePluginsPublisherRepositories_ClassNames}
				>
					No repositories claimed yet.
				</div>
			) : (
				<div
					className={"RoutePluginsPublisherRepositories-list" satisfies RoutePluginsPublisherRepositories_ClassNames}
				>
					{repositories.map((repository) => (
						<div
							key={repository._id}
							className={"RoutePluginsPublisherRepositoryItem" satisfies RoutePluginsPublisherRepositories_ClassNames}
						>
							<span
								className={
									"RoutePluginsPublisherRepositoryItem-url" satisfies RoutePluginsPublisherRepositories_ClassNames
								}
							>
								{repository.repositoryUrl}
							</span>
							<MyButton disabled={publishingId !== null} onClick={() => handlePublish(repository._id)}>
								<UploadCloud aria-hidden />
								{publishingId === repository._id ? "Publishing..." : "Publish"}
							</MyButton>
							<MyButton
								variant="ghost_destructive"
								aria-label={`Remove claim on ${repository.owner}/${repository.repo}`}
								onClick={() => handleRemove(repository._id)}
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
// #endregion repositories

// #region reviews
type RoutePluginsPublisherReviews_ClassNames =
	| "RoutePluginsPublisherReviews"
	| "RoutePluginsPublisherReviews-title"
	| "RoutePluginsPublisherReviews-description"
	| "RoutePluginsPublisherReviews-empty"
	| "RoutePluginsPublisherReviews-list"
	| "RoutePluginsPublisherReviewItem"
	| "RoutePluginsPublisherReviewItem-header"
	| "RoutePluginsPublisherReviewItem-name"
	| "RoutePluginsPublisherReviewItem-meta"
	| "RoutePluginsPublisherReviewItem-findings"
	| "RoutePluginsPublisherReviewItem-note";

function format_date(value: number) {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

type RoutePluginsPublisherReviews_Props = {
	publisher: RoutePluginsPublisher_Publisher["publisher"];
};

const RoutePluginsPublisherReviews = memo(function RoutePluginsPublisherReviews(
	props: RoutePluginsPublisherReviews_Props,
) {
	const { publisher } = props;
	const reviews = useQuery(app_convex_api.plugins.list_publisher_reviews, { publisherId: publisher._id });

	return (
		<section className={"RoutePluginsPublisherReviews" satisfies RoutePluginsPublisherReviews_ClassNames}>
			<h2 className={"RoutePluginsPublisherReviews-title" satisfies RoutePluginsPublisherReviews_ClassNames}>
				<ShieldCheck aria-hidden />
				Review verdicts
			</h2>
			<p className={"RoutePluginsPublisherReviews-description" satisfies RoutePluginsPublisherReviews_ClassNames}>
				Every published version is reviewed before it is registered. Rejected versions are not registered, and flagged
				versions are registered but cannot be installed.
			</p>

			{reviews === undefined ? (
				<div
					className={"RoutePluginsPublisherReviews-empty" satisfies RoutePluginsPublisherReviews_ClassNames}
					role="status"
				>
					Loading reviews...
				</div>
			) : reviews.length === 0 ? (
				<div className={"RoutePluginsPublisherReviews-empty" satisfies RoutePluginsPublisherReviews_ClassNames}>
					No versions reviewed yet.
				</div>
			) : (
				<div className={"RoutePluginsPublisherReviews-list" satisfies RoutePluginsPublisherReviews_ClassNames}>
					{reviews.map((review) => {
						const findings = [...review.mechanicalFindings, ...review.aiFindings];
						return (
							<div
								key={review._id}
								className={"RoutePluginsPublisherReviewItem" satisfies RoutePluginsPublisherReviews_ClassNames}
							>
								<div
									className={"RoutePluginsPublisherReviewItem-header" satisfies RoutePluginsPublisherReviews_ClassNames}
								>
									<span
										className={"RoutePluginsPublisherReviewItem-name" satisfies RoutePluginsPublisherReviews_ClassNames}
									>
										{review.pluginName}@{review.version}
									</span>
									<span
										className={"RoutePluginsPublisherReviewItem-meta" satisfies RoutePluginsPublisherReviews_ClassNames}
									>
										{review.model === "none" ? "mechanical checks" : review.model} · {format_date(review.createdAt)}
									</span>
									<MyBadge
										variant={
											review.status === "rejected"
												? "destructive"
												: review.status === "flagged"
													? "outline"
													: "secondary"
										}
									>
										{review.status}
									</MyBadge>
								</div>
								{findings.length === 0 ? null : (
									<ul
										className={
											"RoutePluginsPublisherReviewItem-findings" satisfies RoutePluginsPublisherReviews_ClassNames
										}
									>
										{findings.map((finding, index) => (
											<li key={index}>{finding}</li>
										))}
									</ul>
								)}
								{review.status === "flagged" ? (
									<div
										className={"RoutePluginsPublisherReviewItem-note" satisfies RoutePluginsPublisherReviews_ClassNames}
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
// #endregion reviews

// #region secrets
type RoutePluginsPublisherSecrets_ClassNames =
	| "RoutePluginsPublisherSecrets"
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
	publisherId: RoutePluginsPublisher_Publisher["publisher"]["_id"];
	secret: RoutePluginsPublisher_Secret;
};

const RoutePluginsPublisherSecretRow = memo(function RoutePluginsPublisherSecretRow(
	props: RoutePluginsPublisherSecretRow_Props,
) {
	const { publisherId, secret } = props;
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
				publisherId,
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
					publisherId,
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
			.mutation(app_convex_api.plugins.delete_publisher_secret, { publisherId, name: secret.name })
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
					publisherId,
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
			<MyButton disabled={saving} aria-label={`Save allowed origins for ${secret.name}`} onClick={handleSaveOrigins}>
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

type RoutePluginsPublisherSecrets_Props = {
	publisher: RoutePluginsPublisher_Publisher["publisher"];
};

const RoutePluginsPublisherSecrets = memo(function RoutePluginsPublisherSecrets(
	props: RoutePluginsPublisherSecrets_Props,
) {
	const { publisher } = props;
	const secrets = useQuery(app_convex_api.plugins.list_publisher_secrets, { publisherId: publisher._id });
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
				publisherId: publisher._id,
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
					publisherId: publisher._id,
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
				publisherId: publisher._id,
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
					publisherId: publisher._id,
				});
				toast.error("Failed to import secrets");
			})
			.finally(() => {
				setSaving(false);
			});
	});

	return (
		<section className={"RoutePluginsPublisherSecrets" satisfies RoutePluginsPublisherSecrets_ClassNames}>
			<h2 className={"RoutePluginsPublisherSecrets-title" satisfies RoutePluginsPublisherSecrets_ClassNames}>
				<KeyRound aria-hidden />
				Secrets
			</h2>
			<p className={"RoutePluginsPublisherSecrets-description" satisfies RoutePluginsPublisherSecrets_ClassNames}>
				Publisher secrets are available to your plugins in every workspace that installs them. A secret can only travel
				to the exact https origins you allow here.
			</p>

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
						<RoutePluginsPublisherSecretRow key={secret._id} publisherId={publisher._id} secret={secret} />
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
	| "RoutePluginsPublisherHeader-identity";

function RoutePluginsPublisher() {
	const auth = AppAuthProvider.useAuth();
	const myPublisher = useQuery(app_convex_api.plugins.get_my_publisher, auth.isAnonymous === false ? {} : "skip");

	if (!auth.isAnonymous && myPublisher === undefined) {
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
							: myPublisher
								? "Manage your publisher identity and the repositories you publish plugins from."
								: "Create a publisher identity to publish plugins."}
					</p>
				</div>
				{myPublisher ? (
					<div className={"RoutePluginsPublisherHeader-identity" satisfies RoutePluginsPublisher_ClassNames}>
						<span>{myPublisher.publisher.displayName}</span>
						<MyBadge variant="secondary">{myPublisher.publisher.slug}</MyBadge>
					</div>
				) : null}
			</header>

			{myPublisher ? (
				<>
					<RoutePluginsPublisherRepositories
						publisher={myPublisher.publisher}
						repositories={myPublisher.repositories}
					/>
					<RoutePluginsPublisherReviews publisher={myPublisher.publisher} />
					<RoutePluginsPublisherSecrets publisher={myPublisher.publisher} />
				</>
			) : auth.isAnonymous ? (
				<RoutePluginsPublisherSignIn />
			) : (
				<RoutePluginsPublisherCreate />
			)}
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/publisher")({
	component: RoutePluginsPublisher,
});

export { Route };
// #endregion root
