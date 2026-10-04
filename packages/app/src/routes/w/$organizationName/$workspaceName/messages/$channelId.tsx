import "./$channelId.css";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { Channels, type ChannelsSearch } from "@/components/channels/channels.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

type RouteChannel_ClassNames = "RouteChannel";

function RouteChannel() {
	const navigate = Route.useNavigate();
	const { organizationName, workspaceName, channelId } = Route.useParams();
	const search = Route.useSearch();
	const open = useFn((channelId: app_convex_Id<"channels">, search: ChannelsSearch = {}) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/messages/$channelId",
			params: { organizationName, workspaceName, channelId },
			search,
		}).catch((error: unknown) => {
			console.error("[RouteChannel.open] Failed to open channel", { error });
		});
	});
	return (
		<main className={"RouteChannel" satisfies RouteChannel_ClassNames}>
			<Channels channelId={channelId} search={search} onNavigate={open} />
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/messages/$channelId")({
	component: RouteChannel,
	validateSearch: zodValidator(
		z.object({ thread: z.string().optional().catch(undefined), message: z.string().optional().catch(undefined) }),
	),
});
export { Route };
