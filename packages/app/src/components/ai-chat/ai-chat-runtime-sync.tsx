import { useEffect } from "react";
import { useAssistantApi, useAssistantState } from "@assistant-ui/react";

import { useAiChatThreadStore } from "@/stores/ai-chat-thread-store.ts";

// #region AiChatRuntimeSync
type AiChatRuntimeSync_Props = {};

export function AiChatRuntimeSync(props: AiChatRuntimeSync_Props) {
	const {} = props;
	const api = useAssistantApi();
	const mainThreadId = useAssistantState(({ threads }) => threads.mainThreadId);
	const selectedThreadId = useAiChatThreadStore((state) => state.selectedThreadId);
	const setSelectedThreadId = useAiChatThreadStore((state) => state.setSelectedThreadId);

	useEffect(() => {
		if (!selectedThreadId) {
			return;
		}

		const currentRemoteId = api.threads().item({ id: mainThreadId }).getState().remoteId;
		if (currentRemoteId === selectedThreadId) {
			return;
		}

		api.threads().switchToThread(selectedThreadId);
	}, [api, mainThreadId, selectedThreadId]);

	useEffect(() => {
		if (selectedThreadId) {
			return;
		}

		const currentRemoteId = api.threads().item({ id: mainThreadId }).getState().remoteId;
		if (!currentRemoteId) {
			return;
		}

		setSelectedThreadId(currentRemoteId);
	}, [api, mainThreadId, selectedThreadId, setSelectedThreadId]);

	return null;
}
// #endregion AiChatRuntimeSync
