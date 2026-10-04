import "./search.css";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Channels, type ChannelsSearch } from "@/components/channels/channels.tsx";
import { ChannelsSearchView, type ChannelsSearchFilters } from "@/components/channels/channels-search.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

type RouteChannelsSearch_ClassNames = "RouteChannelsSearch";

function RouteChannelsSearch() {
	const navigate = Route.useNavigate();
	const filters = Route.useSearch();
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const open = useFn((channelId: app_convex_Id<"channels">, search: ChannelsSearch = {}) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/messages/$channelId",
			params: { organizationName, workspaceName, channelId },
			search,
		}).catch((error: unknown) => {
			console.error("[RouteChannelsSearch.open] Failed to open channel", { error });
		});
	});
	const search = useFn((filters: ChannelsSearchFilters) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/messages/search",
			params: { organizationName, workspaceName },
			search: filters,
		}).catch((error: unknown) => {
			console.error("[RouteChannelsSearch.search] Failed to update filters", { error });
		});
	});
	return (
		<main className={"RouteChannelsSearch" satisfies RouteChannelsSearch_ClassNames}>
			<Channels view="search" search={{}} onNavigate={open}>
				<ChannelsSearchView key={JSON.stringify(filters)} filters={filters} onSearch={search} />
			</Channels>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/messages/search")({
	component: RouteChannelsSearch,
	validateSearch: z.object({
		q: z.string().optional().catch(undefined),
		channel: z.string().optional().catch(undefined),
		from: z.string().optional().catch(undefined),
		attachments: z.enum(["true", "false"]).optional().catch(undefined),
		since: z.string().optional().catch(undefined),
		until: z.string().optional().catch(undefined),
	}),
});
export { Route };
