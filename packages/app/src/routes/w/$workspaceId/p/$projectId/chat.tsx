import { AiChat } from "@/components/ai-chat/ai-chat.tsx";

const Route = createFileRoute({
	component: Chat,
});

export { Route };

function Chat() {
	return <AiChat />;
}
