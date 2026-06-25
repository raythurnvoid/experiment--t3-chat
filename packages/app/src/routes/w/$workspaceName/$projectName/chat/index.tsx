import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";

import { AiChat, type AiChat_UrlQuery } from "@/components/ai-chat/ai-chat.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

function RouteChat() {
	const navigate = Route.useNavigate();
	const urlQuery = Route.useSearch();
	const { workspaceName, projectName } = AppTenantProvider.useContext();

	const handleUrlQueryChange = useFn((urlQuery: AiChat_UrlQuery) => {
		navigate({
			to: "/w/$workspaceName/$projectName/chat",
			params: { workspaceName, projectName },
			search: urlQuery,
		}).catch((error) => {
			console.error("[RouteChat.handleUrlQueryChange] Error navigating to chat URL query", { error, urlQuery });
		});
	});

	return <AiChat urlQuery={urlQuery} onUrlQueryChange={handleUrlQueryChange} />;
}

const Route = createFileRoute("/w/$workspaceName/$projectName/chat/")({
	component: RouteChat,
	validateSearch: zodValidator(
		z.object({
			threadId: z.string().optional().catch(undefined),
		}),
	),
});

export { Route };
