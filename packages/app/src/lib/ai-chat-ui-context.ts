import { useEffect } from "react";
import { create } from "zustand";
import type { ai_chat_UiContext } from "../../shared/ai-chat-ui-context.ts";

/**
 * What the screen shows next to the chat panel. Each screen part writes its own fields while it is
 * mounted, and the chat reads all of them once when a message is sent.
 */
const useAiChatUiContextStore = create<
	ai_chat_UiContext & {
		/**
		 * The screen info the user removed from the composer. It stays off until the screen changes.
		 */
		removedKey: string | null;
	}
>(() => ({ node: null, view: null, plugin: null, removedKey: null }));

function get_key(context: ai_chat_UiContext) {
	return JSON.stringify(context);
}

function get_shown(state: ai_chat_UiContext & { removedKey: string | null }) {
	if (!state.node && !state.plugin) return null;
	const context: ai_chat_UiContext = { node: state.node, view: state.view, plugin: state.plugin };
	return get_key(context) === state.removedKey ? null : context;
}

/**
 * The screen info to send with a new message, or null when there is none or the user removed it.
 */
export function ai_chat_ui_context_get_shown() {
	return get_shown(useAiChatUiContextStore.getState());
}

export function useAiChatUiContextShown() {
	const node = useAiChatUiContextStore((state) => state.node);
	const view = useAiChatUiContextStore((state) => state.view);
	const plugin = useAiChatUiContextStore((state) => state.plugin);
	const removedKey = useAiChatUiContextStore((state) => state.removedKey);
	return get_shown({ node, view, plugin, removedKey });
}

export function ai_chat_ui_context_remove(context: ai_chat_UiContext) {
	useAiChatUiContextStore.setState({ removedKey: get_key(context) });
}

/**
 * Write these screen info fields while the caller is mounted, and clear them when it unmounts.
 */
export function useAiChatUiContextWrite(context: Partial<ai_chat_UiContext>) {
	// Compare by value: callers build new objects on each render.
	const contextKey = JSON.stringify(context);
	useEffect(() => {
		const nextContext = JSON.parse(contextKey) as Partial<ai_chat_UiContext>;
		// The screen changed, so show the chip again even if the user removed it on this screen before.
		useAiChatUiContextStore.setState({ ...nextContext, removedKey: null });
		return () => {
			useAiChatUiContextStore.setState(Object.fromEntries(Object.keys(nextContext).map((key) => [key, null])));
		};
	}, [contextKey]);
}

/**
 * A short line for the composer chip and the sent message.
 */
export function ai_chat_ui_context_get_label(context: ai_chat_UiContext) {
	return [
		context.node?.path,
		context.view,
		// A plugin file view already shows its title as the view.
		context.plugin?.kind === "page" ? `${context.plugin.title} (${context.plugin.pluginName})` : null,
	]
		.filter((item) => item)
		.join(" · ");
}
