import "./activity.css";
import { createFileRoute } from "@tanstack/react-router";
import { Channels, type ChannelsSearch } from "@/components/channels/channels.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

type RouteChannelsActivity_ClassNames = "RouteChannelsActivity";

function RouteChannelsActivity() {
	const navigate = Route.useNavigate();
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const open = useFn((channelId: app_convex_Id<"channels">, search: ChannelsSearch = {}) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/messages/$channelId",
			params: { organizationName, workspaceName, channelId },
			search,
		}).catch((error: unknown) => {
			console.error("[RouteChannelsActivity.open] Failed to open channel", { error });
		});
	});
	return (
		<main className={"RouteChannelsActivity" satisfies RouteChannelsActivity_ClassNames}>
			<Channels view="activity" search={{}} onNavigate={open} />
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/messages/activity")({
	component: RouteChannelsActivity,
});
export { Route };
