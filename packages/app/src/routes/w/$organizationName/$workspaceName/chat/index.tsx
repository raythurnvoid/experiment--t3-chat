import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";

import { AiChat, type AiChat_UrlQuery } from "@/components/ai-chat/ai-chat.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

type RouteChat_ClassNames = "RouteChat";

function RouteChat() {
	const navigate = Route.useNavigate();
	const urlQuery = Route.useSearch();
	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	const handleUrlQueryChange = useFn((urlQuery: AiChat_UrlQuery) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/chat",
			params: { organizationName, workspaceName },
			search: urlQuery,
		}).catch((error) => {
			console.error("[RouteChat.handleUrlQueryChange] Error navigating to chat URL query", { error, urlQuery });
		});
	});

	// The main landmark belongs to this route, not to AiChat: the same component also
	// renders inside the file-editor sidebar agent tab, where a main element would be wrong.
	return (
		<main className={"RouteChat" satisfies RouteChat_ClassNames}>
			<AiChat urlQuery={urlQuery} onUrlQueryChange={handleUrlQueryChange} />
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/chat/")({
	component: RouteChat,
	validateSearch: zodValidator(
		z.object({
			threadId: z.string().optional().catch(undefined),
		}),
	),
});

export { Route };
