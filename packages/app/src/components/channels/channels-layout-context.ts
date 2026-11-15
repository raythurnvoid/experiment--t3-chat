import { createContext } from "react";

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
} | null>(null);
