import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Canvas } from "../components/canvas";

export const Route = createFileRoute({
	component: Chat,
});

function Chat() {
	const runtime = useChatRuntime({
		api: "http://localhost:3001/api/chat",
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<Canvas />
		</AssistantRuntimeProvider>
	);
}
