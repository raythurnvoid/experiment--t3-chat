import { createFileRoute } from "@tanstack/react-router";

import { AiChat } from "@/components/ai-chat/ai-chat.tsx";

function RouteChat() {
	return <AiChat />;
}

const Route = createFileRoute("/w/$workspaceName/$projectName/chat/")({
	component: RouteChat,
});

export { Route };
