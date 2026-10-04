import "./threads.css";
import { createFileRoute } from "@tanstack/react-router";
import { Channels, type ChannelsSearch } from "@/components/channels/channels.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

type RouteChannelsThreads_ClassNames = "RouteChannelsThreads";

function RouteChannelsThreads() {
	const navigate = Route.useNavigate();
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const open = useFn((channelId: app_convex_Id<"channels">, search: ChannelsSearch = {}) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/messages/$channelId",
			params: { organizationName, workspaceName, channelId },
			search,
		}).catch((error: unknown) => {
			console.error("[RouteChannelsThreads.open] Failed to open channel", { error });
		});
	});
	return (
		<main className={"RouteChannelsThreads" satisfies RouteChannelsThreads_ClassNames}>
			<Channels view="threads" search={{}} onNavigate={open} />
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/messages/threads")({
	component: RouteChannelsThreads,
});
export { Route };
