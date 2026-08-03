import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Puzzle, Search, Store } from "lucide-react";
import { memo, useState } from "react";

import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputIcon,
} from "@/components/my-input.tsx";
import { MyLink, MyLinkIcon } from "@/components/my-link.tsx";
import { PluginsGalleryCard } from "@/components/plugins-gallery-card.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

type RoutePlugins_Installation = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins.list_installations
>[number];

// #region gallery
type RoutePluginsGallery_ClassNames =
	| "RoutePluginsGallery"
	| "RoutePluginsGallery-search"
	| "RoutePluginsGallery-empty"
	| "RoutePluginsGallery-grid";

type RoutePluginsGallery_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	installations: Array<RoutePlugins_Installation>;
};

const RoutePluginsGallery = memo(function RoutePluginsGallery(props: RoutePluginsGallery_Props) {
	const { membershipId, installations } = props;
	const plugins = useQuery(app_convex_api.plugins.list_published_plugins, { membershipId });
	const [search, setSearch] = useState("");

	const query = search.trim().toLowerCase();
	const filtered = plugins?.filter(
		(plugin) =>
			query.length === 0 ||
			[plugin.name, plugin.displayName, plugin.description, plugin.publisherDisplayName ?? ""].some((value) =>
				value.toLowerCase().includes(query),
			),
	);

	return (
		<section className={"RoutePluginsGallery" satisfies RoutePluginsGallery_ClassNames}>
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
							<PluginsGalleryCard
								key={plugin.pluginVersionId}
								pluginName={plugin.name}
								displayName={plugin.displayName}
								subtitle={plugin.publisherDisplayName ?? "unknown publisher"}
								description={plugin.description}
								version={plugin.version}
								reviewStatus={plugin.reviewStatus}
								installed={installedVersion !== undefined}
							/>
						);
					})}
				</div>
			)}
		</section>
	);
});
// #endregion gallery

// #region root
type RoutePlugins_ClassNames =
	| "RoutePlugins"
	| "RoutePlugins-content"
	| "RoutePlugins-loading"
	| "RoutePluginsHeader"
	| "RoutePluginsHeader-title"
	| "RoutePluginsHeader-description";

function RoutePlugins() {
	const { membershipId, organizationName, workspaceId, workspaceName } = AppTenantProvider.useContext();
	const organizationList = useQuery(app_convex_api.organizations.list);
	const workspacePermissions = organizationList?.workspaceIdsPermissionsDict[workspaceId];
	const canManagePlugins =
		organizationList === undefined
			? undefined
			: workspacePermissions === "all" || workspacePermissions?.includes("workspace.plugins.manage") === true;
	const installations = useQuery(
		app_convex_api.plugins.list_installations,
		canManagePlugins === true ? { membershipId } : "skip",
	);

	const breadcrumb = <PluginsHeaderBreadcrumb current="Plugins" />;

	if (canManagePlugins === undefined || (canManagePlugins && installations === undefined)) {
		return (
			<main
				className={cn("RoutePlugins" satisfies RoutePlugins_ClassNames, "app-scrollable" satisfies AppClassName)}
				role="status"
				aria-live="polite"
			>
				<div className={"RoutePlugins-content" satisfies RoutePlugins_ClassNames}>
					{breadcrumb}
					<div className={"RoutePlugins-loading" satisfies RoutePlugins_ClassNames}>
						<Puzzle aria-hidden />
						Loading plugins...
					</div>
				</div>
			</main>
		);
	}

	return (
		<main className={cn("RoutePlugins" satisfies RoutePlugins_ClassNames, "app-scrollable" satisfies AppClassName)}>
			<div className={"RoutePlugins-content" satisfies RoutePlugins_ClassNames}>
				{breadcrumb}

				<header className={"RoutePluginsHeader" satisfies RoutePlugins_ClassNames}>
					<div>
						<h1 className={"RoutePluginsHeader-title" satisfies RoutePlugins_ClassNames}>Plugins</h1>
						<p className={"RoutePluginsHeader-description" satisfies RoutePlugins_ClassNames}>
							{canManagePlugins
								? "Browse published plugins and open a plugin page to install and manage it."
								: "You don't have permission to manage plugins in this workspace."}
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

				{canManagePlugins && installations ? (
					<RoutePluginsGallery membershipId={membershipId} installations={installations} />
				) : (
					<div className={"RoutePlugins-loading" satisfies RoutePlugins_ClassNames} role="alert">
						<Puzzle aria-hidden />
						Plugin management is unavailable.
					</div>
				)}
			</div>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/")({
	component: RoutePlugins,
});

export { Route };
// #endregion root
