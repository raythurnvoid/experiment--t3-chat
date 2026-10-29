import "./browse.css";
import { createFileRoute } from "@tanstack/react-router";
import { Channels, type ChannelsSearch } from "@/components/channels/channels.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { channels_navigation_state, type ChannelsNavigationMode } from "@/lib/app-channels-context.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

type RouteBrowseChannels_ClassNames = "RouteBrowseChannels";

function RouteBrowseChannels() {
	const navigate = Route.useNavigate();
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const open = useFn((channelId: app_convex_Id<"channels">, search: ChannelsSearch = {}, mode: ChannelsNavigationMode = "open") => {
		navigate({
			to: "/w/$organizationName/$workspaceName/messages/$channelId",
			params: { organizationName, workspaceName, channelId },
			search,
			state: channels_navigation_state(mode),
		}).catch((error: unknown) => {
			console.error("[RouteBrowseChannels.open] Failed to open channel", { error });
		});
	});
	return (
		<main className={"RouteBrowseChannels" satisfies RouteBrowseChannels_ClassNames}>
			<Channels view="browse" search={{}} onNavigate={open} />
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/messages/browse")({
	component: RouteBrowseChannels,
});
export { Route };
