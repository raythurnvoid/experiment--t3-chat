import "./index.css";

import { useClerk } from "@clerk/clerk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { GitBranch, LogIn, Plus, Store, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
} from "@/components/my-input.tsx";
import { PluginsGalleryCard } from "@/components/plugins-gallery-card.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import { RoutePluginsPublisherLastAttempt } from "./-publisher-last-attempt.tsx";
import { PluginPublishConfirmationModal } from "./-plugin-publish-confirmation-modal.tsx";
import { PluginPublishSessionProvider } from "./-plugin-publish-session.tsx";

type Repositories = app_convex_FunctionReturnType<typeof app_convex_api.plugins.list_user_published_repositories>;

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
	| "RoutePluginsPublisherPlugins-form"
	| "RoutePluginsPublisherPlugins-empty"
	| "RoutePluginsPublisherPlugins-grid"
	| "RoutePluginsPublisherRepositoryItem"
	| "RoutePluginsPublisherUnpublishedCard"
	| "RoutePluginsPublisherUnpublishedCard-header"
	| "RoutePluginsPublisherUnpublishedCard-icon"
	| "RoutePluginsPublisherUnpublishedCard-identity"
	| "RoutePluginsPublisherUnpublishedCard-name"
	| "RoutePluginsPublisherUnpublishedCard-subtitle"
	| "RoutePluginsPublisherUnpublishedCard-description"
	| "RoutePluginsPublisherUnpublishedCard-footer";

type RoutePluginsPublisherUnpublishedCard_Props = {
	repository: Repositories[number]["repository"];
	onPublished: () => void;
	onRemoved: () => void;
};

const RoutePluginsPublisherUnpublishedCard = memo(function RoutePluginsPublisherUnpublishedCard(
	props: RoutePluginsPublisherUnpublishedCard_Props,
) {
	const { repository, onPublished, onRemoved } = props;
	const publishSessionManager = PluginPublishSessionProvider.useContext();
	const publishBusy = publishSessionManager.session !== null;
	const managementBusy = publishSessionManager.managementAction !== null;
	const [removing, setRemoving] = useState(false);

	const handleRemove = useFn(() => {
		if (removing || publishBusy) {
			return;
		}
		const actionVersion = publishSessionManager.beginManagementAction("remove_repository");
		if (actionVersion === null) {
			return;
		}

		setRemoving(true);
		app_convex
			.mutation(app_convex_api.plugins.remove_repository, { repositoryId: repository._id })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success("Repository claim removed");
				onRemoved();
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisher.handleRemove] Failed to remove repository claim:", {
					error,
					repositoryId: repository._id,
				});
				toast.error("Failed to remove repository claim");
			})
			.finally(() => {
				setRemoving(false);
				publishSessionManager.finishManagementAction(actionVersion);
			});
	});

	return (
		<div className={"RoutePluginsPublisherUnpublishedCard" satisfies RoutePluginsPublisherPlugins_ClassNames}>
			<span className={"RoutePluginsPublisherUnpublishedCard-header" satisfies RoutePluginsPublisherPlugins_ClassNames}>
				<GitBranch
					className={"RoutePluginsPublisherUnpublishedCard-icon" satisfies RoutePluginsPublisherPlugins_ClassNames}
					aria-hidden
				/>
				<span
					className={"RoutePluginsPublisherUnpublishedCard-identity" satisfies RoutePluginsPublisherPlugins_ClassNames}
				>
					<span
						className={"RoutePluginsPublisherUnpublishedCard-name" satisfies RoutePluginsPublisherPlugins_ClassNames}
					>
						{repository.owner}/{repository.repo}
					</span>
					<span
						className={
							"RoutePluginsPublisherUnpublishedCard-subtitle" satisfies RoutePluginsPublisherPlugins_ClassNames
						}
					>
						{repository.repositoryUrl}
					</span>
				</span>
			</span>
			<span
				className={"RoutePluginsPublisherUnpublishedCard-description" satisfies RoutePluginsPublisherPlugins_ClassNames}
			>
				Never published. Publish builds and registers the first version from the default branch.
			</span>
			<span className={"RoutePluginsPublisherUnpublishedCard-footer" satisfies RoutePluginsPublisherPlugins_ClassNames}>
				<PluginPublishConfirmationModal
					repositoryId={repository._id}
					repositoryLabel={`${repository.owner}/${repository.repo}`}
					disabled={removing}
					onPublished={onPublished}
				/>
				<MyButton
					variant="ghost_destructive"
					aria-label={`${removing ? "Removing" : "Remove"} claim on ${repository.owner}/${repository.repo}`}
					aria-busy={removing}
					tooltip="Remove claim"
					disabled={publishBusy || (managementBusy && !removing)}
					onClick={handleRemove}
				>
					<Trash2 aria-hidden />
				</MyButton>
			</span>
		</div>
	);
});

type RoutePluginsPublisherPlugins_Props = {
	repositories: Repositories;
};

const RoutePluginsPublisherPlugins = memo(function RoutePluginsPublisherPlugins(
	props: RoutePluginsPublisherPlugins_Props,
) {
	const { repositories } = props;
	const publishSessionManager = PluginPublishSessionProvider.useContext();
	const repositoryInputRef = useRef<HTMLInputElement>(null);
	const claimButtonRef = useRef<HTMLButtonElement>(null);
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [claiming, setClaiming] = useState(false);
	const [focusAfterChange, setFocusAfterChange] = useState<{
		repositoryId: Repositories[number]["repository"]["_id"];
		change: "published" | "removed";
	} | null>(null);

	useEffect(() => {
		if (!focusAfterChange || claiming) {
			return;
		}
		const repository = repositories.find(({ repository }) => repository._id === focusAfterChange.repositoryId);
		const changeArrived =
			focusAfterChange.change === "removed" ? repository === undefined : Boolean(repository?.readyVersions.length);
		if (!changeArrived) {
			return;
		}

		// Repair focus only when the changed card left it on the document. Do not pull focus away if the
		// person moved to another control while the publish, removal, or claim was still running.
		if (document.activeElement === document.body) {
			repositoryInputRef.current?.focus();
		}
		setFocusAfterChange(null);
	}, [claiming, focusAfterChange, repositories]);

	const handleClaim = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!repositoryUrl.trim() || claiming || publishSessionManager.session) {
			return;
		}
		const actionVersion = publishSessionManager.beginManagementAction("claim_repository");
		if (actionVersion === null) {
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
				// Move submit focus to the cleared field, but keep any explicit focus move made during the request.
				if (document.activeElement === claimButtonRef.current || document.activeElement === document.body) {
					repositoryInputRef.current?.focus();
				}
				setRepositoryUrl("");
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
				publishSessionManager.finishManagementAction(actionVersion);
			});
	});
	const publishBusy = publishSessionManager.session !== null;
	const managementBusy = publishSessionManager.managementAction !== null;

	return (
		<section className={"RoutePluginsPublisherPlugins" satisfies RoutePluginsPublisherPlugins_ClassNames}>
			<form
				className={"RoutePluginsPublisherPlugins-form" satisfies RoutePluginsPublisherPlugins_ClassNames}
				onSubmit={handleClaim}
			>
				<MyInput layout="stacked">
					<MyInputLabel>GitHub repository URL</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							ref={repositoryInputRef}
							value={repositoryUrl}
							placeholder="https://github.com/owner/plugin-repo"
							inputMode="url"
							disabled={publishBusy || (managementBusy && !claiming)}
							readOnly={claiming}
							aria-busy={claiming}
							required
							onChange={(event) => setRepositoryUrl(event.currentTarget.value)}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				<MyButton
					ref={claimButtonRef}
					type="submit"
					disabled={publishBusy || (managementBusy && !claiming) || !repositoryUrl.trim()}
					aria-busy={claiming}
				>
					<Plus aria-hidden />
					{claiming ? "Claiming..." : "Claim"}
				</MyButton>
			</form>

			{repositories.length === 0 ? (
				<div className={"RoutePluginsPublisherPlugins-empty" satisfies RoutePluginsPublisherPlugins_ClassNames}>
					No repositories claimed yet. Claim one to start publishing.
				</div>
			) : (
				<div className={"RoutePluginsPublisherPlugins-grid" satisfies RoutePluginsPublisherPlugins_ClassNames}>
					{repositories.map(({ repository, readyVersions }) => (
						<div
							key={repository._id}
							className={"RoutePluginsPublisherRepositoryItem" satisfies RoutePluginsPublisherPlugins_ClassNames}
						>
							{readyVersions.length === 0 ? (
								<RoutePluginsPublisherUnpublishedCard
									repository={repository}
									onPublished={() => setFocusAfterChange({ repositoryId: repository._id, change: "published" })}
									onRemoved={() => setFocusAfterChange({ repositoryId: repository._id, change: "removed" })}
								/>
							) : (
								readyVersions.map((readyVersion) => (
									<PluginsGalleryCard
										key={readyVersion.name}
										pluginName={readyVersion.name}
										displayName={readyVersion.displayName}
										subtitle={`${repository.owner}/${repository.repo}`}
										description={readyVersion.description}
										version={readyVersion.version}
										reviewStatus={readyVersion.reviewStatus}
									/>
								))
							)}
							<RoutePluginsPublisherLastAttempt attempt={repository.lastPublishAttempt} />
						</div>
					))}
				</div>
			)}
		</section>
	);
});
// #endregion plugins

// #region root
type RoutePluginsPublisher_ClassNames =
	| "RoutePluginsPublisher"
	| "RoutePluginsPublisher-content"
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
		app_convex_api.plugins.list_user_published_repositories,
		auth.isAnonymous === false ? {} : "skip",
	);
	const anagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		auth.isAnonymous === false && auth.userId ? { userId: auth.userId } : "skip",
	);

	const breadcrumb = <PluginsHeaderBreadcrumb trail={["plugins"]} current="Publisher" />;

	if (!auth.isAnonymous && repositories === undefined) {
		return (
			<main
				className={cn(
					"RoutePluginsPublisher" satisfies RoutePluginsPublisher_ClassNames,
					"app-scrollable" satisfies AppClassName,
				)}
				role="status"
				aria-live="polite"
			>
				<div className={"RoutePluginsPublisher-content" satisfies RoutePluginsPublisher_ClassNames}>
					{breadcrumb}
					<div className={"RoutePluginsPublisher-loading" satisfies RoutePluginsPublisher_ClassNames}>
						<Store aria-hidden />
						Loading publisher...
					</div>
				</div>
			</main>
		);
	}

	return (
		<main
			className={cn(
				"RoutePluginsPublisher" satisfies RoutePluginsPublisher_ClassNames,
				"app-scrollable" satisfies AppClassName,
			)}
		>
			<div className={"RoutePluginsPublisher-content" satisfies RoutePluginsPublisher_ClassNames}>
				{breadcrumb}

				<header className={"RoutePluginsPublisherHeader" satisfies RoutePluginsPublisher_ClassNames}>
					<div>
						<h1 className={"RoutePluginsPublisherHeader-title" satisfies RoutePluginsPublisher_ClassNames}>
							Publisher
						</h1>
						<p className={"RoutePluginsPublisherHeader-description" satisfies RoutePluginsPublisher_ClassNames}>
							{auth.isAnonymous
								? "Sign in to publish plugins."
								: "Claim a GitHub repository to publish it as a plugin. Published plugins open their plugin page, where you manage versions, review verdicts, and secrets."}
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
					<RoutePluginsPublisherPlugins repositories={repositories ?? []} />
				)}
			</div>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/publisher/")({
	component: RoutePluginsPublisher,
});

export { Route };
// #endregion root
