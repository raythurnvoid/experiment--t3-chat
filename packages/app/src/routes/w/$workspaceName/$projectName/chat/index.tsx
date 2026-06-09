import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";

import { AiChat, type AiChat_SearchParams } from "@/components/ai-chat/ai-chat.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

function RouteChat() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();
	const { workspaceName, projectName } = AppTenantProvider.useContext();

	const handleNavigateSearch = useFn((search: AiChat_SearchParams) => {
		navigate({
			to: "/w/$workspaceName/$projectName/chat",
			params: { workspaceName, projectName },
			search,
		}).catch((error) => {
			console.error("[RouteChat.handleNavigateSearch] Error navigating to chat search", { error, search });
		});
	});

	return <AiChat searchParams={searchParams} onNavigateSearch={handleNavigateSearch} />;
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
