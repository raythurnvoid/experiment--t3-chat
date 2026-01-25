import { AiChat } from "@/components/ai-chat/ai-chat.tsx";

export const Route = createFileRoute({
	component: Chat,
});

function Chat() {
	return <AiChat />;
}
