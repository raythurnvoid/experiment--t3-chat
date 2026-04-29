import { createFileRoute } from "@tanstack/react-router";

import { AiChat } from "@/components/ai-chat/ai-chat.tsx";

const Route = createFileRoute("/w/$workspaceName/$projectName/chat/")({
	component: RouteChat,
});

export { Route };

function RouteChat() {
	return <AiChat />;
}
