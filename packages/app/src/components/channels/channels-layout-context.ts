import { createContext, type RefObject } from "react";
import type { ChannelsMessage_CustomAttributes } from "./channels-message.tsx";

/**
 * Focus the button that opened the panel or the thread, after the close renders.
 *
 * A thread opened from a link or a reload has no opener. Then focus its root message in `scope`, or the
 * channel message box when that message is not loaded, so the keyboard does not start again from the top.
 * Forget the opener after use, so a later thread from a link does not focus an old button.
 */
export function channels_focus_opener(
	opener: RefObject<HTMLElement | null>,
	scope: ParentNode | null,
	rootMessageId: string | null,
) {
	requestAnimationFrame(() => {
		const target = opener.current?.isConnected
			? opener.current
			: (rootMessageId &&
					scope?.querySelector<HTMLElement>(
						`article[${"data-message-id" satisfies keyof ChannelsMessage_CustomAttributes}="${rootMessageId}"]`,
					)) ||
				scope?.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]');
		opener.current = null;
		target?.focus({ preventScroll: true });
	});
}

export const ChannelsLayoutContext = createContext<{
	sidebarVisible: boolean;
	drawerOpen: boolean;
	openSidebar: () => void;
	/**
	 * True below 820px. The right panel then shows in place of the conversation.
	 */
	narrow: boolean;
	/**
	 * The Thread tab element. `ChannelsConversation` renders the open thread into it.
	 */
	threadHost: HTMLElement | null;
	/**
	 * Open the right panel on its Agent tab. Null when the panel is already a column.
	 */
	openPanel: ((opener: HTMLElement) => void) | null;
	/**
	 * The button to focus when the panel or the thread closes: the Agent button or Reply in thread. Empty
	 * after a link or a reload opened the thread; see `channels_focus_opener`.
	 */
	panelOpener: RefObject<HTMLElement | null>;
	/**
	 * Select the Thread tab. Opening the thread that is already open changes no URL, so the tab changes here.
	 */
	showThread: () => void;
} | null>(null);
