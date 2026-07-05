import "./repository.css";

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { GitBranch, History, Puzzle, ShieldCheck, Trash2, UploadCloud } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";

type RoutePluginsPublisherRepository_Details = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.plugins.get_publisher_repository>
>;

function format_date(value: number) {
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function review_badge_variant(status: "passed" | "rejected" | "flagged" | "pending") {
	return status === "rejected" ? "destructive" : status === "flagged" ? "outline" : "secondary";
}

// #region versions
type RoutePluginsPublisherRepositoryVersions_ClassNames =
	| "RoutePluginsPublisherRepositoryVersions"
	| "RoutePluginsPublisherRepositoryVersions-header"
	| "RoutePluginsPublisherRepositoryVersions-title"
	| "RoutePluginsPublisherRepositoryVersions-description"
	| "RoutePluginsPublisherRepositoryVersions-empty"
	| "RoutePluginsPublisherRepositoryVersions-list"
	| "RoutePluginsPublisherRepositoryVersionItem"
	| "RoutePluginsPublisherRepositoryVersionItem-version"
	| "RoutePluginsPublisherRepositoryVersionItem-meta";

type RoutePluginsPublisherRepositoryVersions_Props = {
	versions: RoutePluginsPublisherRepository_Details["versions"];
};

const RoutePluginsPublisherRepositoryVersions = memo(function RoutePluginsPublisherRepositoryVersions(
	props: RoutePluginsPublisherRepositoryVersions_Props,
) {
	const { versions } = props;

	return (
		<section
			className={"RoutePluginsPublisherRepositoryVersions" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames}
		>
			<div
				className={
					"RoutePluginsPublisherRepositoryVersions-header" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
				}
			>
				<h2
					className={
						"RoutePluginsPublisherRepositoryVersions-title" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
					}
				>
					<History aria-hidden />
					Published versions
					{versions.length === 0 ? null : <MyBadge variant="default">{versions.length}</MyBadge>}
				</h2>
				<p
					className={
						"RoutePluginsPublisherRepositoryVersions-description" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
					}
				>
					Every publish registers a new immutable version built from a commit of this repository.
				</p>
			</div>

			{versions.length === 0 ? (
				<div
					className={
						"RoutePluginsPublisherRepositoryVersions-empty" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
					}
				>
					Nothing published yet. Use the Publish button above to build and register the first version.
				</div>
			) : (
				<div
					className={
						"RoutePluginsPublisherRepositoryVersions-list" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
					}
				>
					{versions.map((version) => (
						<div
							key={version._id}
							className={
								"RoutePluginsPublisherRepositoryVersionItem" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
							}
						>
							<span
								className={
									"RoutePluginsPublisherRepositoryVersionItem-version" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
								}
							>
								{version.name}@{version.version}
							</span>
							<span
								className={
									"RoutePluginsPublisherRepositoryVersionItem-meta" satisfies RoutePluginsPublisherRepositoryVersions_ClassNames
								}
							>
								{version.sourceCommitSha.slice(0, 8)} · {format_date(version.createdAt)}
							</span>
							<MyBadge variant={review_badge_variant(version.reviewStatus)}>{version.reviewStatus}</MyBadge>
						</div>
					))}
				</div>
			)}
		</section>
	);
});
// #endregion versions

// #region reviews
type RoutePluginsPublisherRepositoryReviews_ClassNames =
	| "RoutePluginsPublisherRepositoryReviews"
	| "RoutePluginsPublisherRepositoryReviews-header"
	| "RoutePluginsPublisherRepositoryReviews-title"
	| "RoutePluginsPublisherRepositoryReviews-description"
	| "RoutePluginsPublisherRepositoryReviews-empty"
	| "RoutePluginsPublisherRepositoryReviews-list"
	| "RoutePluginsPublisherRepositoryReviewItem"
	| "RoutePluginsPublisherRepositoryReviewItem-header"
	| "RoutePluginsPublisherRepositoryReviewItem-name"
	| "RoutePluginsPublisherRepositoryReviewItem-meta"
	| "RoutePluginsPublisherRepositoryReviewItem-findings"
	| "RoutePluginsPublisherRepositoryReviewItem-note";

type RoutePluginsPublisherRepositoryReviews_Props = {
	reviews: RoutePluginsPublisherRepository_Details["reviews"];
};

const RoutePluginsPublisherRepositoryReviews = memo(function RoutePluginsPublisherRepositoryReviews(
	props: RoutePluginsPublisherRepositoryReviews_Props,
) {
	const { reviews } = props;

	return (
		<section
			className={"RoutePluginsPublisherRepositoryReviews" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames}
		>
			<div
				className={
					"RoutePluginsPublisherRepositoryReviews-header" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
				}
			>
				<h2
					className={
						"RoutePluginsPublisherRepositoryReviews-title" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
					}
				>
					<ShieldCheck aria-hidden />
					Review verdicts
					{reviews.length === 0 ? null : <MyBadge variant="default">{reviews.length}</MyBadge>}
				</h2>
				<p
					className={
						"RoutePluginsPublisherRepositoryReviews-description" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
					}
				>
					Every published version is reviewed before it is registered. Rejected versions are not registered, and
					flagged versions are registered but cannot be installed.
				</p>
			</div>

			{reviews.length === 0 ? (
				<div
					className={
						"RoutePluginsPublisherRepositoryReviews-empty" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
					}
				>
					No versions reviewed yet.
				</div>
			) : (
				<div
					className={
						"RoutePluginsPublisherRepositoryReviews-list" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
					}
				>
					{reviews.map((review) => {
						const findings = [...review.mechanicalFindings, ...review.aiFindings];
						return (
							<div
								key={review._id}
								className={
									"RoutePluginsPublisherRepositoryReviewItem" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
								}
							>
								<div
									className={
										"RoutePluginsPublisherRepositoryReviewItem-header" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
									}
								>
									<span
										className={
											"RoutePluginsPublisherRepositoryReviewItem-name" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
										}
									>
										{review.pluginName}@{review.version}
									</span>
									<span
										className={
											"RoutePluginsPublisherRepositoryReviewItem-meta" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
										}
									>
										{review.model === "none" ? "mechanical checks" : review.model} · {format_date(review.createdAt)}
									</span>
									<MyBadge variant={review_badge_variant(review.status)}>{review.status}</MyBadge>
								</div>
								{findings.length === 0 ? null : (
									<ul
										className={
											"RoutePluginsPublisherRepositoryReviewItem-findings" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
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
											"RoutePluginsPublisherRepositoryReviewItem-note" satisfies RoutePluginsPublisherRepositoryReviews_ClassNames
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
// #endregion reviews

// #region root
type RoutePluginsPublisherRepository_ClassNames =
	| "RoutePluginsPublisherRepository"
	| "RoutePluginsPublisherRepository-loading"
	| "RoutePluginsPublisherRepository-missing"
	| "RoutePluginsPublisherRepositoryHero"
	| "RoutePluginsPublisherRepositoryHero-icon"
	| "RoutePluginsPublisherRepositoryHero-info"
	| "RoutePluginsPublisherRepositoryHero-titleRow"
	| "RoutePluginsPublisherRepositoryHero-title"
	| "RoutePluginsPublisherRepositoryHero-meta"
	| "RoutePluginsPublisherRepositoryHero-repoLink"
	| "RoutePluginsPublisherRepositoryHero-description"
	| "RoutePluginsPublisherRepositoryHero-actions";

function RoutePluginsPublisherRepository() {
	const { organizationName, workspaceName, repositoryId } = Route.useParams();
	const navigate = useNavigate();
	const details = useQuery(app_convex_api.plugins.get_publisher_repository, {
		repositoryId: repositoryId as RoutePluginsPublisherRepository_Details["repository"]["_id"],
	});
	const [publishing, setPublishing] = useState(false);
	const [removing, setRemoving] = useState(false);

	const handlePublish = useFn(() => {
		if (!details) {
			return;
		}
		setPublishing(true);
		app_convex
			.action(app_convex_api.plugins.publish_version, {
				repositoryId: details.repository._id,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success(`Published commit ${result._yay.sourceCommitSha.slice(0, 8)}`);
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisherRepository.handlePublish] Failed to publish plugin:", {
					error,
					repositoryId,
				});
				toast.error("Failed to publish plugin");
			})
			.finally(() => {
				setPublishing(false);
			});
	});

	const handleRemove = useFn(() => {
		if (!details) {
			return;
		}
		setRemoving(true);
		app_convex
			.mutation(app_convex_api.plugins.remove_repository, { repositoryId: details.repository._id })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}

				toast.success("Repository claim removed");
				void navigate({
					to: "/w/$organizationName/$workspaceName/plugins/publisher",
					params: { organizationName, workspaceName },
				});
			})
			.catch((error) => {
				console.error("[RoutePluginsPublisherRepository.handleRemove] Failed to remove repository claim:", {
					error,
					repositoryId,
				});
				toast.error("Failed to remove repository claim");
			})
			.finally(() => {
				setRemoving(false);
			});
	});

	const currentCrumb = details
		? (details.versions[0]?.displayName ?? `${details.repository.owner}/${details.repository.repo}`)
		: null;

	const breadcrumb = <PluginsHeaderBreadcrumb trail={["plugins", "publisher"]} current={currentCrumb} />;

	if (details === undefined) {
		return (
			<main
				className={"RoutePluginsPublisherRepository" satisfies RoutePluginsPublisherRepository_ClassNames}
				role="status"
				aria-live="polite"
			>
				{breadcrumb}
				<div
					className={"RoutePluginsPublisherRepository-loading" satisfies RoutePluginsPublisherRepository_ClassNames}
				>
					<Puzzle aria-hidden />
					Loading plugin...
				</div>
			</main>
		);
	}

	if (details === null) {
		return (
			<main className={"RoutePluginsPublisherRepository" satisfies RoutePluginsPublisherRepository_ClassNames}>
				{breadcrumb}
				<div
					className={"RoutePluginsPublisherRepository-missing" satisfies RoutePluginsPublisherRepository_ClassNames}
				>
					This repository claim does not exist or belongs to another publisher.
				</div>
			</main>
		);
	}

	const latest = details.versions[0] ?? null;

	return (
		<main className={"RoutePluginsPublisherRepository" satisfies RoutePluginsPublisherRepository_ClassNames}>
			{breadcrumb}

			<header className={"RoutePluginsPublisherRepositoryHero" satisfies RoutePluginsPublisherRepository_ClassNames}>
				<Puzzle
					aria-hidden
					className={"RoutePluginsPublisherRepositoryHero-icon" satisfies RoutePluginsPublisherRepository_ClassNames}
				/>
				<div
					className={"RoutePluginsPublisherRepositoryHero-info" satisfies RoutePluginsPublisherRepository_ClassNames}
				>
					<div
						className={
							"RoutePluginsPublisherRepositoryHero-titleRow" satisfies RoutePluginsPublisherRepository_ClassNames
						}
					>
						<h1
							className={
								"RoutePluginsPublisherRepositoryHero-title" satisfies RoutePluginsPublisherRepository_ClassNames
							}
						>
							{latest?.displayName ?? `${details.repository.owner}/${details.repository.repo}`}
						</h1>
						{latest ? <MyBadge variant={review_badge_variant(latest.reviewStatus)}>{latest.reviewStatus}</MyBadge> : null}
					</div>
					<div
						className={"RoutePluginsPublisherRepositoryHero-meta" satisfies RoutePluginsPublisherRepository_ClassNames}
					>
						{latest ? <span>{`${latest.name}@${latest.version}`}</span> : <span>never published</span>}
						<a
							className={
								"RoutePluginsPublisherRepositoryHero-repoLink" satisfies RoutePluginsPublisherRepository_ClassNames
							}
							href={details.repository.repositoryUrl}
							target="_blank"
							rel="noreferrer"
						>
							<GitBranch aria-hidden />
							{details.repository.owner}/{details.repository.repo}
						</a>
					</div>
					{latest?.description ? (
						<p
							className={
								"RoutePluginsPublisherRepositoryHero-description" satisfies RoutePluginsPublisherRepository_ClassNames
							}
						>
							{latest.description}
						</p>
					) : null}
				</div>
				<div
					className={"RoutePluginsPublisherRepositoryHero-actions" satisfies RoutePluginsPublisherRepository_ClassNames}
				>
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
			</header>

			<RoutePluginsPublisherRepositoryVersions versions={details.versions} />
			<RoutePluginsPublisherRepositoryReviews reviews={details.reviews} />
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/publisher/$repositoryId")({
	component: RoutePluginsPublisherRepository,
});

export { Route };
// #endregion root
