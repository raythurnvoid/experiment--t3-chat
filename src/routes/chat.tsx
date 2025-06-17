import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Thread } from "../components/assistant-ui/thread";

export const Route = createFileRoute({
	component: Chat,
});

function Chat() {
	const runtime = useChatRuntime({
		api: "http://localhost:3001/api/chat",
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<div className="flex flex-col flex-1">
				<div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
					<h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
						AI Chat Assistant
					</h1>
				</div>
				<div className="flex flex-col flex-1 overflow-hidden">
					<Thread />
				</div>
			</div>
		</AssistantRuntimeProvider>
	);
}
