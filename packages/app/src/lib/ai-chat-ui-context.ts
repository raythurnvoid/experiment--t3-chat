import { useEffect, type RefObject } from "react";
import { create } from "zustand";
import type { PluginsUiFrame_Ref } from "../components/plugins-ui-frame.tsx";
import type { ai_chat_UiContext } from "../../shared/ai-chat-ui-context.ts";
import { file_quotes_MAX_TEXT_BYTES } from "../../shared/file-quotes.ts";

type State = ai_chat_UiContext & {
	/**
	 * The screen info the user removed from the composer. It stays off until the screen changes.
	 */
	removedKey: string | null;
	/**
	 * The editor that wrote `selection`. An editor that unmounts clears only its own selection.
	 */
	selectionOwner: object | null;
	/**
	 * True while the open plugin frame may share what it shows. The chip says so.
	 */
	pluginSharesView: boolean;
};

/**
 * What the screen shows next to the chat panel. Each screen part writes its own fields while it is
 * mounted, and the chat reads all of them once when a message is sent.
 */
const useAiChatUiContextStore = create<State>(() => ({
	node: null,
	view: null,
	plugin: null,
	channel: null,
	selection: null,
	browser: null,
	removedKey: null,
	selectionOwner: null,
	pluginSharesView: false,
}));

/**
 * Leave the selection out, so a removed chip stays removed while the user selects other text.
 */
function get_key(context: ai_chat_UiContext) {
	return JSON.stringify({ ...context, selection: null });
}

function get_shown(state: Omit<State, "selectionOwner" | "pluginSharesView">) {
	if (!state.node && !state.plugin && !state.channel && !state.browser) return null;
	const context: ai_chat_UiContext = {
		node: state.node,
		view: state.view,
		plugin: state.plugin,
		channel: state.channel,
		selection: state.node?.kind === "file" ? state.selection : null,
		browser: state.browser,
	};
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
	const channel = useAiChatUiContextStore((state) => state.channel);
	const selection = useAiChatUiContextStore((state) => state.selection);
	const browser = useAiChatUiContextStore((state) => state.browser);
	const removedKey = useAiChatUiContextStore((state) => state.removedKey);
	return get_shown({ node, view, plugin, channel, selection, browser, removedKey });
}

export function ai_chat_ui_context_remove(context: ai_chat_UiContext) {
	useAiChatUiContextStore.setState({ removedKey: get_key(context) });
}

/**
 * Write the selected text of the focused editor. `owner` is the editor instance.
 *
 * The server refuses more than 4,096 bytes, which would block the send. So cut the text here.
 * `encodeInto` never splits a character, so the cut text always passes the server check.
 */
export function ai_chat_ui_context_set_selection(
	owner: object,
	selection: { text: string; editor: NonNullable<ai_chat_UiContext["selection"]>["editor"] },
) {
	if (!selection.text.trim()) {
		useAiChatUiContextStore.setState({ selection: null, selectionOwner: owner });
		return;
	}
	const { read } = new TextEncoder().encodeInto(selection.text, new Uint8Array(file_quotes_MAX_TEXT_BYTES));
	useAiChatUiContextStore.setState({
		selection: { ...selection, text: selection.text.slice(0, read), truncated: read < selection.text.length },
		selectionOwner: owner,
	});
}

export function ai_chat_ui_context_clear_selection(owner: object) {
	if (useAiChatUiContextStore.getState().selectionOwner !== owner) return;
	useAiChatUiContextStore.setState({ selection: null, selectionOwner: null });
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
		// Clear the selection too: a hidden editor, such as one behind HTML Preview, must not send it.
		useAiChatUiContextStore.setState({ ...nextContext, removedKey: null, selection: null, selectionOwner: null });
		return () => {
			useAiChatUiContextStore.setState(Object.fromEntries(Object.keys(nextContext).map((key) => [key, null])));
		};
	}, [contextKey]);
}

export function useAiChatUiContextPluginSharesView() {
	return useAiChatUiContextStore((state) => state.pluginSharesView);
}

type PluginContextSource = {
	plugin: NonNullable<ai_chat_UiContext["plugin"]>;
	frameRef: RefObject<PluginsUiFrame_Ref | null>;
};

/**
 * The plugin frame that may share its view with the chat. Only one plugin frame is mounted at a time
 * (plugin-system skill), so one slot is enough. It is not in the store, because nothing renders from it.
 */
let pluginContextSource: PluginContextSource | null = null;

function is_same_plugin(a: ai_chat_UiContext["plugin"], b: ai_chat_UiContext["plugin"]) {
	return !!a && !!b && a.pluginName === b.pluginName && a.kind === b.kind && a.title === b.title;
}

/**
 * Register the open plugin frame as the source of plugin text while the caller is mounted. Pass null
 * when the installation did not accept `agent.view-context`.
 */
export function useAiChatUiContextPluginSource(
	plugin: ai_chat_UiContext["plugin"],
	frameRef: RefObject<PluginsUiFrame_Ref | null>,
) {
	// Compare by value: callers build a new object on each render.
	const pluginKey = plugin ? JSON.stringify(plugin) : null;
	useEffect(() => {
		if (!pluginKey) return;

		const source: PluginContextSource = {
			plugin: JSON.parse(pluginKey) as PluginContextSource["plugin"],
			frameRef,
		};
		pluginContextSource = source;
		useAiChatUiContextStore.setState({ pluginSharesView: true });
		return () => {
			if (pluginContextSource !== source) return;
			pluginContextSource = null;
			useAiChatUiContextStore.setState({ pluginSharesView: false });
		};
	}, [pluginKey, frameRef]);
}

/**
 * Does the screen still show the plugin view of `context`, with its chip? A file view keeps its
 * title when the user opens another file in it, so compare the file too.
 */
function is_plugin_view_shown(context: ai_chat_UiContext) {
	const shown = ai_chat_ui_context_get_shown();
	return (
		!!shown &&
		is_same_plugin(shown.plugin, context.plugin) &&
		shown.node?.fileNodeId === context.node?.fileNodeId &&
		shown.node?.pendingNodeId === context.node?.pendingNodeId
	);
}

/**
 * The plugin text to send with a message whose screen info is `context`, or null.
 *
 * Send it only when that plugin view is still open and the user did not remove the chip. A removed
 * chip means nothing about the screen is sent, plugin text included.
 */
export async function ai_chat_ui_context_read_plugin_context(context: ai_chat_UiContext | null) {
	const source = pluginContextSource;
	if (!context || !source || !is_same_plugin(source.plugin, context.plugin) || !is_plugin_view_shown(context)) {
		return null;
	}

	const viewContext = (await source.frameRef.current?.readAgentViewContext()) ?? null;

	// The page can take up to 2 seconds to answer. Check again, because meanwhile the user may have
	// removed the chip or opened another file.
	return pluginContextSource === source && is_plugin_view_shown(context) ? viewContext : null;
}

function get_channel_label(channel: NonNullable<ai_chat_UiContext["channel"]>) {
	const name =
		channel.kind === "file"
			? `Comments on ${channel.name}`
			: channel.kind === "direct"
				? `Direct message with ${channel.name}`
				: channel.kind === "private"
					? `${channel.name} (private)`
					: channel.name;
	// History clears the thread id when access is lost, but keeps the title.
	return channel.threadRootId || channel.threadTitle
		? `${name} · Thread${channel.threadTitle ? `: ${channel.threadTitle}` : ""}`
		: name;
}

/**
 * A short line for the composer chip and the sent message.
 */
export function ai_chat_ui_context_get_label(context: ai_chat_UiContext) {
	// A selection that ends at a line start ends with "\n". Do not count that empty last line.
	const lineCount = context.selection ? context.selection.text.replace(/\n$/u, "").split("\n").length : 0;
	return [
		context.node ? `${context.node.path}${context.node.pendingNodeId ? " (draft)" : ""}` : null,
		context.view,
		context.selection
			? `${lineCount} ${lineCount === 1 ? "line" : "lines"} selected${context.selection.truncated ? " (first 4 KB)" : ""}`
			: null,
		// A plugin file view already shows its title as the view.
		context.plugin?.kind === "page" ? `${context.plugin.title} (${context.plugin.pluginName})` : null,
		context.channel ? get_channel_label(context.channel) : null,
		context.browser
			? `${context.browser.title ? `${context.browser.title} ` : ""}(${new URL(context.browser.origin).host})`
			: null,
	]
		.filter((item) => item)
		.join(" · ");
}

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;
	const { ai_chat_ui_context_validate_parts } = await import("../../shared/ai-chat-ui-context.ts");

	describe("ai_chat_ui_context_set_selection", () => {
		test("cuts a big multi-byte selection so the server still takes the message", () => {
			const owner = {};
			useAiChatUiContextStore.setState({
				node: { fileNodeId: "file_1", pendingNodeId: null, path: "/notes.md", kind: "file" },
			});
			ai_chat_ui_context_set_selection(owner, { text: "€".repeat(4_000), editor: "plain_text" });

			const shown = ai_chat_ui_context_get_shown();
			expect(shown?.selection?.truncated).toBe(true);
			const parts = [{ type: "data-ui-context", data: shown }];
			expect(
				ai_chat_ui_context_validate_parts(parts)._nay,
				"a cut selection must pass the server check",
			).toBeUndefined();
			ai_chat_ui_context_clear_selection(owner);
		});
	});

	describe("ai_chat_ui_context_read_plugin_context", () => {
		test("sends no plugin text after the user opened another file or removed the chip", async () => {
			const { renderHook } = await import("@testing-library/react");
			const plugin = { pluginName: "video-player", title: "Player", kind: "file_view" as const };
			const node = { fileNodeId: "node_a", pendingNodeId: null, path: "/a.mp4", kind: "file" as const };
			const uiContext = { node, view: null, plugin, channel: null, selection: null, browser: null };
			const viewContext = { content: [{ type: "text" as const, text: "Paused at 0:12" }], structuredContent: null };
			const frameRef = {
				current: { postAgentToolCall: () => true, readAgentViewContext: () => Promise.resolve(viewContext) },
			};
			useAiChatUiContextStore.setState({ node, plugin, removedKey: null });
			const hook = renderHook(() => useAiChatUiContextPluginSource(plugin, frameRef));

			expect(await ai_chat_ui_context_read_plugin_context(uiContext)).toEqual(viewContext);
			useAiChatUiContextStore.setState({ node: { ...node, fileNodeId: "node_b", path: "/b.mp4" } });
			expect(
				await ai_chat_ui_context_read_plugin_context(uiContext),
				"text about another file must not join this message",
			).toBeNull();
			useAiChatUiContextStore.setState({ node });
			frameRef.current.readAgentViewContext = () => {
				ai_chat_ui_context_remove(ai_chat_ui_context_get_shown()!);
				return Promise.resolve(viewContext);
			};
			expect(
				await ai_chat_ui_context_read_plugin_context(uiContext),
				"a chip removed while the page answers sends nothing",
			).toBeNull();
			hook.unmount();
			useAiChatUiContextStore.setState({ node: null, plugin: null, removedKey: null });
		});
	});
}
