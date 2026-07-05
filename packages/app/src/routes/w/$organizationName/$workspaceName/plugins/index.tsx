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
	const plugins = useQuery(app_convex_api.plugins.list_registered_plugins, { membershipId });
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
	| "RoutePlugins-loading"
	| "RoutePluginsHeader"
	| "RoutePluginsHeader-title"
	| "RoutePluginsHeader-description";

function RoutePlugins() {
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const installations = useQuery(app_convex_api.plugins.list_installations, { membershipId });

	const breadcrumb = <PluginsHeaderBreadcrumb current="Plugins" />;

	if (installations === undefined) {
		return (
			<main className={"RoutePlugins" satisfies RoutePlugins_ClassNames} role="status" aria-live="polite">
				{breadcrumb}
				<div className={"RoutePlugins-loading" satisfies RoutePlugins_ClassNames}>
					<Puzzle aria-hidden />
					Loading plugins...
				</div>
			</main>
		);
	}

	return (
		<main className={"RoutePlugins" satisfies RoutePlugins_ClassNames}>
			{breadcrumb}

			<header className={"RoutePluginsHeader" satisfies RoutePlugins_ClassNames}>
				<div>
					<h1 className={"RoutePluginsHeader-title" satisfies RoutePlugins_ClassNames}>Plugins</h1>
					<p className={"RoutePluginsHeader-description" satisfies RoutePlugins_ClassNames}>
						Browse published plugins and open a plugin page to install and manage it.
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
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/")({
	component: RoutePlugins,
});

export { Route };
// #endregion root
