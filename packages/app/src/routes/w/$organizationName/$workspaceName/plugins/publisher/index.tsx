import "./index.css";

import { useClerk } from "@clerk/clerk-react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { GitBranch, LogIn, Plus, Store, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent, type Ref } from "react";
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
} from "@/components/my-input.tsx";
import { PluginsGalleryCard } from "@/components/plugins-gallery-card.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { PluginsPublishButton } from "@/components/plugins-publish-button.tsx";
import { PluginsPublishSessionProvider } from "@/components/plugins-publish-session.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_datetime } from "@/lib/date.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

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

// #region last attempt
type PublisherLastAttempt = {
	at: number;
	pluginName: string | null;
	status: "succeeded" | "rejected" | "flagged" | "failed";
	message: string;
};

/**
 * Show a publish attempt only when it still needs the publisher's attention.
 *
 * A succeeded attempt is hidden because the card already shows the version it produced. Everything
 * else stays on the card, including on a repository that has published before, because the toast
 * that reported the failure is long gone by the time the publisher looks again.
 */
function plugins_publisher_get_visible_last_attempt(lastPublishAttempt: PublisherLastAttempt | undefined) {
	if (!lastPublishAttempt || lastPublishAttempt.status === "succeeded") {
		return undefined;
	}

	return lastPublishAttempt;
}

type RoutePluginsPublisherLastAttempt_ClassNames =
	| "RoutePluginsPublisherLastAttempt"
	| "RoutePluginsPublisherLastAttempt-message";

type RoutePluginsPublisherLastAttempt_Props = {
	attempt: PublisherLastAttempt | undefined;
};

const RoutePluginsPublisherLastAttempt = memo(function RoutePluginsPublisherLastAttempt(
	props: RoutePluginsPublisherLastAttempt_Props,
) {
	const attempt = plugins_publisher_get_visible_last_attempt(props.attempt);
	if (!attempt) {
		return null;
	}

	// A publish that failed before the manifest was read has no plugin name. Say "this repository" so
	// the line does not read as a failure of whichever plugin the card above happens to show.
	const pluginOrRepository = attempt.pluginName ?? "this repository";

	return (
		<span className={"RoutePluginsPublisherLastAttempt" satisfies RoutePluginsPublisherLastAttempt_ClassNames}>
			<MyBadge variant={attempt.status === "flagged" ? "outline" : "destructive"}>{attempt.status}</MyBadge>
			<span
				className={"RoutePluginsPublisherLastAttempt-message" satisfies RoutePluginsPublisherLastAttempt_ClassNames}
			>
				Last publish for {pluginOrRepository} {format_datetime(attempt.at)} · {attempt.message}
			</span>
		</span>
	);
});
// #endregion last attempt

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
	ref: Ref<HTMLDivElement>;
	repository: Repositories[number]["repository"];
};

const RoutePluginsPublisherUnpublishedCard = memo(function RoutePluginsPublisherUnpublishedCard(
	props: RoutePluginsPublisherUnpublishedCard_Props,
) {
	const { ref, repository } = props;
	const publishSessionManager = PluginsPublishSessionProvider.useContext();
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
		<div ref={ref} className={"RoutePluginsPublisherUnpublishedCard" satisfies RoutePluginsPublisherPlugins_ClassNames}>
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
				<PluginsPublishButton
					repositoryId={repository._id}
					repositoryLabel={`${repository.owner}/${repository.repo}`}
					disabled={removing}
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
	const publishSessionManager = PluginsPublishSessionProvider.useContext();
	const { workspaceId } = AppTenantProvider.useContext();
	const repositoryInputRef = useRef<HTMLInputElement>(null);
	const claimButtonRef = useRef<HTMLButtonElement>(null);
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [claiming, setClaiming] = useState(false);

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

	// React runs this cleanup right before it removes the card from the DOM, so a focused Publish
	// or Remove button inside the card is still the active element here. Move the focus to the
	// claim field then, instead of letting the browser drop it on the body. Keep one stable
	// function: React re-runs a ref cleanup whenever the callback identity changes.
	const handleUnpublishedCardRef = useFn((card: HTMLDivElement | null) => {
		if (!card) {
			return;
		}

		return () => {
			if (card.contains(document.activeElement)) {
				repositoryInputRef.current?.focus();
			}
		};
	});

	const publishBusy = publishSessionManager.session !== null;
	const managementBusy = publishSessionManager.managementAction !== null;

	useEffect(() => {
		// A publish can replace the card while the publish dialog is still open. The dialog then
		// closes onto a Publish button that no longer exists. Register the claim field so the
		// stable publish owner has a place on this route to put that fallen focus.
		const routeKey = `${workspaceId}/plugins/publisher`;
		publishSessionManager.setRouteFocusTarget(repositoryInputRef.current, routeKey);
		return () => publishSessionManager.setRouteFocusTarget(null, routeKey);
	});

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
								<RoutePluginsPublisherUnpublishedCard ref={handleUnpublishedCardRef} repository={repository} />
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
