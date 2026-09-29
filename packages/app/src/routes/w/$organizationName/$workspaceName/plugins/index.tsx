import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Search, Server, Store } from "lucide-react";
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
import { PluginsManagementAccess } from "@/components/plugins-management-access.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

// #region gallery
type RoutePluginsGallery_ClassNames =
	| "RoutePluginsGallery"
	| "RoutePluginsGallery-search"
	| "RoutePluginsGallery-empty"
	| "RoutePluginsGallery-grid";

type RoutePluginsGallery_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
};

const RoutePluginsGallery = memo(function RoutePluginsGallery(props: RoutePluginsGallery_Props) {
	const { membershipId } = props;
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
						aria-label="Search plugins"
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
						const installed = plugin.installationId !== null;
						return (
							<PluginsGalleryCard
								key={plugin.pluginVersionId}
								pluginName={plugin.name}
								displayName={plugin.displayName}
								subtitle={plugin.publisherDisplayName ?? "unknown publisher"}
								description={plugin.description}
								version={plugin.version}
								reviewStatus={plugin.reviewStatus}
								installed={installed}
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
	| "RoutePluginsHeader-description"
	| "RoutePluginsHeader-actions";

function RoutePlugins() {
	const { membershipId, organizationId, workspaceId, organizationName, workspaceName } = AppTenantProvider.useContext();

	const breadcrumb = <PluginsHeaderBreadcrumb current="Plugins" />;

	return (
		<main className={cn("RoutePlugins" satisfies RoutePlugins_ClassNames, "app-scrollable" satisfies AppClassName)}>
			<div className={"RoutePlugins-content" satisfies RoutePlugins_ClassNames}>
				{breadcrumb}

				<header className={"RoutePluginsHeader" satisfies RoutePlugins_ClassNames}>
					<div>
						<h1 className={"RoutePluginsHeader-title" satisfies RoutePlugins_ClassNames}>Plugins</h1>
						<p className={"RoutePluginsHeader-description" satisfies RoutePlugins_ClassNames}>
							Browse published plugins. Your permissions control installation and settings.
						</p>
					</div>
					<div className={"RoutePluginsHeader-actions" satisfies RoutePlugins_ClassNames}>
						<MyLink
							variant="button-outline"
							to="/w/$organizationName/$workspaceName/mcp-servers"
							params={{ organizationName, workspaceName }}
						>
							<MyLinkIcon aria-hidden>
								<Server />
							</MyLinkIcon>
							MCP servers
						</MyLink>
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
					</div>
				</header>

				<PluginsManagementAccess
					key={membershipId}
					membershipId={membershipId}
					organizationId={organizationId}
					workspaceId={workspaceId}
				/>

				<RoutePluginsGallery membershipId={membershipId} />
			</div>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/")({
	component: RoutePlugins,
});

export { Route };
// #endregion root
